const DYNAMIC_IMPORT_ERROR_FRAGMENTS = [
  'failed to fetch dynamically imported module',
  'importing a module script failed',
  'error loading dynamically imported module',
  'expected a javascript-or-wasm module script',
  'failed to load module script',
  'unable to preload css for',
  'chunkloaderror',
  'loading chunk',
  'css_chunk_load_failed'
]

export const ROUTE_LOAD_RECOVERY_STORAGE_KEY = 'ristak.route-load-recovery.v1'
export const ROUTE_LOAD_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000

const ROUTE_LOAD_RECOVERY_LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000
let recoveryTokenSequence = 0

type RecoveryLedgerEntry = {
  buildFingerprint: string
  attemptedAt: number
  token: string
}

type RecoveryLedger = {
  attempts: Record<string, RecoveryLedgerEntry>
}

export type RouteLoadRecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type RouteLoadRecoveryClaim = RecoveryLedgerEntry & {
  recoveryKey: string
}

export interface ClaimRouteLoadRecoveryOptions {
  storage: RouteLoadRecoveryStorage
  recoveryKey: string
  buildFingerprint: string
  now?: number
}

function toErrorText(error: unknown) {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.trim().toLowerCase()
  }

  if (error && typeof error === 'object') {
    const candidate = error as { name?: unknown; message?: unknown }
    return `${String(candidate.name || '')} ${String(candidate.message || '')}`.trim().toLowerCase()
  }

  return String(error || '').trim().toLowerCase()
}

/**
 * Sólo reconoce fallos al descargar chunks JS/CSS. Un bug normal de render no
 * debe provocar una recarga automática que esconda el error real.
 */
export function isDynamicImportFailure(error: unknown) {
  const errorText = toErrorText(error)

  if (DYNAMIC_IMPORT_ERROR_FRAGMENTS.some((fragment) => errorText.includes(fragment))) {
    return true
  }

  // Safari usa este mensaje corto para imports dinámicos fallidos. Exigimos el
  // nombre TypeError y la coincidencia completa para no atrapar errores de app.
  return /^typeerror load failed\.?$/.test(errorText)
}

function readRecoveryLedger(storage: RouteLoadRecoveryStorage): RecoveryLedger {
  const rawLedger = storage.getItem(ROUTE_LOAD_RECOVERY_STORAGE_KEY)
  if (!rawLedger) return { attempts: {} }

  const parsed = JSON.parse(rawLedger) as Partial<RecoveryLedger> | null
  if (!parsed || typeof parsed !== 'object' || !parsed.attempts || typeof parsed.attempts !== 'object') {
    return { attempts: {} }
  }

  return { attempts: { ...parsed.attempts } }
}

function pruneRecoveryLedger(ledger: RecoveryLedger, now: number) {
  Object.entries(ledger.attempts).forEach(([key, entry]) => {
    const attemptedAt = Number(entry?.attemptedAt)
    if (
      !entry ||
      !Number.isFinite(attemptedAt) ||
      attemptedAt > now + ROUTE_LOAD_RECOVERY_COOLDOWN_MS ||
      now - attemptedAt > ROUTE_LOAD_RECOVERY_LEDGER_RETENTION_MS
    ) {
      delete ledger.attempts[key]
    }
  })
}

function getRecoveryLedgerEntryKey(recoveryKey: string, buildFingerprint: string) {
  return JSON.stringify([recoveryKey, buildFingerprint])
}

/**
 * Reserva una sola recarga por módulo y build. La marca se escribe antes de
 * recargar para que un asset persistentemente roto no cree un ciclo infinito.
 */
export function claimRouteLoadRecovery({
  storage,
  recoveryKey,
  buildFingerprint,
  now = Date.now()
}: ClaimRouteLoadRecoveryOptions): RouteLoadRecoveryClaim | null {
  const normalizedRecoveryKey = recoveryKey.trim()
  const normalizedBuildFingerprint = buildFingerprint.trim() || 'unversioned'
  if (!normalizedRecoveryKey) return null

  try {
    const ledger = readRecoveryLedger(storage)
    pruneRecoveryLedger(ledger, now)

    const ledgerEntryKey = getRecoveryLedgerEntryKey(
      normalizedRecoveryKey,
      normalizedBuildFingerprint
    )
    const previousAttempt = ledger.attempts[ledgerEntryKey]
    if (
      previousAttempt &&
      now - previousAttempt.attemptedAt < ROUTE_LOAD_RECOVERY_COOLDOWN_MS
    ) {
      return null
    }

    recoveryTokenSequence += 1
    const claim: RouteLoadRecoveryClaim = {
      recoveryKey: normalizedRecoveryKey,
      buildFingerprint: normalizedBuildFingerprint,
      attemptedAt: now,
      token: `${now}:${recoveryTokenSequence}`
    }

    ledger.attempts[ledgerEntryKey] = {
      buildFingerprint: claim.buildFingerprint,
      attemptedAt: claim.attemptedAt,
      token: claim.token
    }
    storage.setItem(ROUTE_LOAD_RECOVERY_STORAGE_KEY, JSON.stringify(ledger))
    return claim
  } catch {
    // Sin almacenamiento durable no hay forma segura de impedir un reload loop.
    return null
  }
}

/**
 * Libera una reserva si el usuario salió de la página antes de que comenzara la
 * recarga. Nunca borra el intento de otra instancia o de otro build.
 */
export function releaseRouteLoadRecovery(
  storage: RouteLoadRecoveryStorage,
  claim: RouteLoadRecoveryClaim
) {
  try {
    const ledger = readRecoveryLedger(storage)
    const ledgerEntryKey = getRecoveryLedgerEntryKey(
      claim.recoveryKey,
      claim.buildFingerprint
    )
    const currentAttempt = ledger.attempts[ledgerEntryKey]

    if (
      currentAttempt?.token !== claim.token ||
      currentAttempt.buildFingerprint !== claim.buildFingerprint
    ) {
      return
    }

    delete ledger.attempts[ledgerEntryKey]

    if (Object.keys(ledger.attempts).length === 0) {
      storage.removeItem(ROUTE_LOAD_RECOVERY_STORAGE_KEY)
      return
    }

    storage.setItem(ROUTE_LOAD_RECOVERY_STORAGE_KEY, JSON.stringify(ledger))
  } catch {
    // La liberación es best-effort; jamás debe romper la navegación.
  }
}
