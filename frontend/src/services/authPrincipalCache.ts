type AuthScopedCacheInvalidator = () => void

const authScopedCacheInvalidators = new Set<AuthScopedCacheInvalidator>()
const AUTH_PRINCIPAL_UNINITIALIZED = Symbol('auth-principal-uninitialized')
let currentAuthPrincipal: string | null | typeof AUTH_PRINCIPAL_UNINITIALIZED = AUTH_PRINCIPAL_UNINITIALIZED
let authScopedCacheRevision = 0

function readStoredAuthPrincipal() {
  try {
    return window.localStorage.getItem('auth_token')
  } catch {
    return null
  }
}

/**
 * Identificador opaco para persistir caches sin guardar ni filtrar el token.
 * Cambia con el principal autenticado y es estable durante su sesión.
 */
export function getAuthScopedCachePrincipalFingerprint(token: string | null = readStoredAuthPrincipal()) {
  const principal = token || ''
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < principal.length; index += 1) {
    hash ^= BigInt(principal.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `${principal.length}:${hash.toString(16)}`
}

/** Registra un cache que nunca debe sobrevivir a un cambio de cuenta. */
export function registerAuthScopedCacheInvalidator(invalidator: AuthScopedCacheInvalidator) {
  authScopedCacheInvalidators.add(invalidator)
  return () => authScopedCacheInvalidators.delete(invalidator)
}

/**
 * Sincroniza el dueño de todos los caches de servicio. La revisión permite que
 * una promesa iniciada por la cuenta anterior descarte su escritura tardía.
 */
export function syncAuthScopedCachePrincipal(token: string | null = readStoredAuthPrincipal()) {
  // La primera observación sólo establece el dueño del runtime. Invalidar aquí
  // borraba snapshots persistentes válidos durante cada arranque en frío.
  if (currentAuthPrincipal === AUTH_PRINCIPAL_UNINITIALIZED) {
    currentAuthPrincipal = token
    return false
  }
  if (token === currentAuthPrincipal) return false

  currentAuthPrincipal = token
  authScopedCacheRevision += 1
  authScopedCacheInvalidators.forEach((invalidate) => {
    try {
      invalidate()
    } catch (error) {
      console.error('No se pudo limpiar un cache al cambiar de cuenta:', error)
    }
  })
  return true
}

export function getAuthScopedCacheRevision() {
  return authScopedCacheRevision
}
