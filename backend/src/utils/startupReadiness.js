export function isDatabaseStorageOutageOffer(offer = {}) {
  return offer?.storage_full === true ||
    String(offer?.postgres_status || '').toLowerCase() === 'suspended' ||
    Number(offer?.usage_percent || 0) >= 99
}

export function isRuntimeReadyForTraffic({
  ready = false,
  error = null,
  recoveryMode = null,
  shuttingDown = false
} = {}) {
  const servingDatabaseStorageRecovery = recoveryMode === 'database_storage'
  return (ready === true || servingDatabaseStorageRecovery) &&
    (!error || servingDatabaseStorageRecovery) &&
    shuttingDown !== true
}

export function runtimeHealthStatusCode(state = {}) {
  return isRuntimeReadyForTraffic(state) ? 200 : 503
}

export const DATABASE_STORAGE_RECOVERY_CHECK_INTERVAL_MS = 15_000
export const DATABASE_STORAGE_RECOVERY_REQUIRED_HEALTHY_CHECKS = 2

function requiredFunction(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} debe ser una función.`)
  }
  return value
}

/**
 * Vigila un arranque detenido exclusivamente por almacenamiento de PostgreSQL.
 * Exige confirmaciones consecutivas tanto de conexión local como del Installer
 * antes de pedir un restart, para no entrar en un crash loop mientras Render
 * apenas está reanudando o ampliando la base.
 */
export function createDatabaseStorageRecoveryWatchdog({
  isRecoveryActive,
  probeDatabase,
  fetchStorageOffer,
  isStorageOutageOffer,
  onRecoveryStable,
  onHealthyCheck = () => {},
  onCheckError = () => {},
  intervalMs = DATABASE_STORAGE_RECOVERY_CHECK_INTERVAL_MS,
  requiredHealthyChecks = DATABASE_STORAGE_RECOVERY_REQUIRED_HEALTHY_CHECKS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  const recoveryActive = requiredFunction('isRecoveryActive', isRecoveryActive)
  const databaseProbe = requiredFunction('probeDatabase', probeDatabase)
  const storageOffer = requiredFunction('fetchStorageOffer', fetchStorageOffer)
  const storageOutage = requiredFunction('isStorageOutageOffer', isStorageOutageOffer)
  const recoveryStable = requiredFunction('onRecoveryStable', onRecoveryStable)
  const healthyCheck = requiredFunction('onHealthyCheck', onHealthyCheck)
  const checkError = requiredFunction('onCheckError', onCheckError)
  const scheduleInterval = requiredFunction('setIntervalFn', setIntervalFn)
  const cancelInterval = requiredFunction('clearIntervalFn', clearIntervalFn)
  const safeIntervalMs = Math.max(1000, Number(intervalMs) || DATABASE_STORAGE_RECOVERY_CHECK_INTERVAL_MS)
  const safeRequiredChecks = Math.max(1, Math.floor(
    Number(requiredHealthyChecks) || DATABASE_STORAGE_RECOVERY_REQUIRED_HEALTHY_CHECKS
  ))

  let timer = null
  let stopped = false
  let checkInFlight = false
  let restartRequested = false
  let consecutiveHealthyChecks = 0

  function clearTimer() {
    if (!timer) return
    cancelInterval(timer)
    timer = null
  }

  function resetHealthyChecks() {
    consecutiveHealthyChecks = 0
  }

  async function check() {
    if (stopped || restartRequested) {
      return { state: stopped ? 'stopped' : 'restart_requested', consecutiveHealthyChecks }
    }
    if (checkInFlight) return { state: 'busy', consecutiveHealthyChecks }

    checkInFlight = true
    try {
      if (!recoveryActive()) {
        resetHealthyChecks()
        return { state: 'inactive', consecutiveHealthyChecks }
      }

      const databaseReachable = await databaseProbe()
      if (databaseReachable !== true) {
        resetHealthyChecks()
        return { state: 'database_unavailable', consecutiveHealthyChecks }
      }

      const offer = await storageOffer()
      if (storageOutage(offer)) {
        resetHealthyChecks()
        return { state: 'storage_outage', consecutiveHealthyChecks, offer }
      }

      consecutiveHealthyChecks += 1
      await Promise.resolve(healthyCheck({
        consecutiveHealthyChecks,
        requiredHealthyChecks: safeRequiredChecks,
        offer
      })).catch(() => {})

      if (consecutiveHealthyChecks < safeRequiredChecks) {
        return { state: 'confirming', consecutiveHealthyChecks, offer }
      }

      restartRequested = true
      try {
        await recoveryStable({
          consecutiveHealthyChecks,
          requiredHealthyChecks: safeRequiredChecks,
          offer
        })
        clearTimer()
        return { state: 'restart_requested', consecutiveHealthyChecks, offer }
      } catch (error) {
        restartRequested = false
        resetHealthyChecks()
        throw error
      }
    } catch (error) {
      resetHealthyChecks()
      await Promise.resolve(checkError(error)).catch(() => {})
      return { state: 'check_failed', consecutiveHealthyChecks, error }
    } finally {
      checkInFlight = false
    }
  }

  function start() {
    if (stopped || restartRequested || timer) return false
    timer = scheduleInterval(() => {
      void check()
    }, safeIntervalMs)
    timer?.unref?.()
    void check()
    return true
  }

  function stop() {
    stopped = true
    clearTimer()
    resetHealthyChecks()
  }

  function getState() {
    return {
      running: Boolean(timer) && !stopped,
      stopped,
      checkInFlight,
      restartRequested,
      consecutiveHealthyChecks,
      requiredHealthyChecks: safeRequiredChecks,
      intervalMs: safeIntervalMs
    }
  }

  return { start, stop, check, getState }
}
