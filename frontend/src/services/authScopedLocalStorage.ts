import {
  getAuthScopedCachePrincipalFingerprint,
  registerAuthScopedCacheInvalidator
} from './authPrincipalCache'

const AUTH_SCOPED_STORAGE_VERSION = 'p2'

function getStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function getStorageKeys(storage: Storage) {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key))
}

/**
 * Crea un namespace persistente cuyo contenido sólo pertenece al principal
 * autenticado actual. Las llaves legacy carecen de dueño verificable y se
 * descartan; nunca se migran a ciegas a otra cuenta.
 */
export function createAuthScopedLocalStorageNamespace(prefixes: readonly string[]) {
  const ownedPrefixes = [...new Set(prefixes.filter(Boolean))]
  let preparedPrincipal: string | null = null

  const ownsKey = (key: string) => ownedPrefixes.some(
    (prefix) => key === prefix || key.startsWith(`${prefix}:`)
  )

  const clear = () => {
    preparedPrincipal = null
    const storage = getStorage()
    if (!storage) return

    try {
      getStorageKeys(storage).filter(ownsKey).forEach((key) => storage.removeItem(key))
    } catch {
      // Best-effort: un storage bloqueado no debe impedir que la app arranque.
    }
  }

  const ensurePrincipal = () => {
    const principal = getAuthScopedCachePrincipalFingerprint()
    if (preparedPrincipal === principal) return principal

    const storage = getStorage()
    if (storage) {
      try {
        const scopedRoots = new Map(ownedPrefixes.map((prefix) => [
          prefix,
          `${prefix}:${AUTH_SCOPED_STORAGE_VERSION}:${principal}`
        ]))

        getStorageKeys(storage).forEach((key) => {
          const prefix = ownedPrefixes.find(
            (candidate) => key === candidate || key.startsWith(`${candidate}:`)
          )
          if (!prefix) return
          const scopedRoot = scopedRoots.get(prefix)
          if (!scopedRoot || (key !== scopedRoot && !key.startsWith(`${scopedRoot}:`))) {
            storage.removeItem(key)
          }
        })
      } catch {
        // La red sigue siendo la fuente de verdad si storage falla.
      }
    }

    preparedPrincipal = principal
    return principal
  }

  const getKey = (prefix: string) => {
    if (!ownedPrefixes.includes(prefix)) {
      throw new Error(`El prefijo "${prefix}" no pertenece a este namespace de storage`)
    }
    return `${prefix}:${AUTH_SCOPED_STORAGE_VERSION}:${ensurePrincipal()}`
  }

  registerAuthScopedCacheInvalidator(clear)
  return { clear, getKey }
}
