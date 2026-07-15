import { useState, useEffect, useCallback, useRef } from 'react'
import { apiUrl } from '@/services/apiBaseUrl'
import {
  clearAppConfigReadCache,
  getAppConfigValues
} from '@/services/appConfigService'

/**
 * Sistema HÍBRIDO de configuración:
 * - LocalStorage como CACHE (lectura instantánea)
 * - PostgreSQL como SOURCE OF TRUTH (persistencia confiable)
 * - Sincronización automática entre ambos
 */

const CONFIG_PREFIX = 'rstk_config_'
const SYNC_EVENT = 'config-sync'

const serializeConfigValue = (value: unknown) => (
  value === null || value === undefined
    ? null
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)
)

const parseStoredConfigValue = <T,>(storedValue: unknown, defaultValue: T): T => {
  if (storedValue === null || storedValue === undefined) return defaultValue

  const rawValue = typeof storedValue === 'string'
    ? storedValue
    : JSON.stringify(storedValue)

  if (typeof defaultValue === 'string') {
    return rawValue as T
  }

  if (typeof defaultValue === 'boolean') {
    const normalized = rawValue.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true as T
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false as T
  }

  if (typeof defaultValue === 'number') {
    const numericValue = Number(rawValue)
    return (Number.isFinite(numericValue) ? numericValue : defaultValue) as T
  }

  try {
    return JSON.parse(rawValue) as T
  } catch {
    return rawValue as T
  }
}

const getConfigHeaders = () => {
  let token: string | null = null

  try {
    token = localStorage.getItem('auth_token')
  } catch {
    token = null
  }

  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

const buildConfigUrl = (params?: URLSearchParams) => (
  apiUrl(`/api/config${params ? `?${params.toString()}` : ''}`)
)

interface ConfigOptions {
  syncOnMount?: boolean // Sincronizar con DB al montar (default: true)
  cacheFirst?: boolean // Usar localStorage como cache (default: true)
}

/**
 * Hook para manejar configuración individual de la app
 *
 * @param key - Clave de configuración (ej: 'visitor_source', 'show_analytics')
 * @param defaultValue - Valor por default si no existe
 * @param options - Opciones de comportamiento
 *
 * @example
 * const [visitorSource, setVisitorSource] = useAppConfig('visitor_source', 'platform')
 */
export function useAppConfig<T = string>(
  key: string,
  defaultValue: T,
  options: ConfigOptions = {}
): [T, (value: T) => Promise<void>, boolean] {
  const { syncOnMount = true, cacheFirst = true } = options

  // Estado local
  const [value, setValue] = useState<T>(() => {
    if (!cacheFirst) return defaultValue

    // Leer del cache inmediatamente (rápido)
    try {
      const cached = localStorage.getItem(`${CONFIG_PREFIX}${key}`)
      if (cached !== null) {
        return JSON.parse(cached) as T
      }
    } catch {
      // Ignore cache read errors and fall back to default value
    }
    return defaultValue
  })

  const [syncing, setSyncing] = useState(false)
  const mountedRef = useRef(true)
  const defaultValueRef = useRef(defaultValue)
  const valueVersionRef = useRef(0)
  const pendingOperationsRef = useRef(0)

  useEffect(() => {
    defaultValueRef.current = defaultValue
  }, [defaultValue])

  const beginSync = useCallback(() => {
    pendingOperationsRef.current += 1
    if (mountedRef.current) {
      setSyncing(true)
    }
  }, [])

  const finishSync = useCallback(() => {
    pendingOperationsRef.current = Math.max(0, pendingOperationsRef.current - 1)
    if (mountedRef.current && pendingOperationsRef.current === 0) {
      setSyncing(false)
    }
  }, [])

  // Sincronizar con la DB al montar
  useEffect(() => {
    mountedRef.current = true

    if (!syncOnMount) {
      return () => {
        mountedRef.current = false
      }
    }

    let cancelled = false

    const syncFromDB = async () => {
      const requestVersion = valueVersionRef.current
      beginSync()

      try {
        const config = await getAppConfigValues([key])
        const dbValue = config[key]

        if (
          dbValue !== undefined &&
          dbValue !== null &&
          !cancelled &&
          mountedRef.current &&
          valueVersionRef.current === requestVersion
        ) {
          const parsed = parseStoredConfigValue(dbValue, defaultValueRef.current)

          // Solo actualizar si es diferente del cache
          setValue((current) => {
            if (JSON.stringify(current) !== JSON.stringify(parsed)) {
              if (cacheFirst) {
                try {
                  localStorage.setItem(`${CONFIG_PREFIX}${key}`, JSON.stringify(parsed))
                } catch {
                  // La DB sigue siendo la fuente de verdad si localStorage falla.
                }
              }
              return parsed
            }
            return current
          })
        }
      } catch {
        // Keep cached value when DB sync fails
      } finally {
        finishSync()
      }
    }

    syncFromDB()

    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [key, syncOnMount, cacheFirst, beginSync, finishSync])

  // Escuchar cambios desde otros componentes
  useEffect(() => {
    const handleSync = (event: CustomEvent) => {
      const { key: changedKey, value: newValue } = event.detail
      if (changedKey === key && mountedRef.current) {
        setValue(newValue)
      }
    }

    window.addEventListener(SYNC_EVENT, handleSync as EventListener)
    return () => window.removeEventListener(SYNC_EVENT, handleSync as EventListener)
  }, [key])

  // Función para actualizar el valor
  const updateValue = useCallback(async (newValue: T) => {
    valueVersionRef.current += 1
    beginSync()

    try {
      // 1. Guardar en DB (source of truth)
      const response = await fetch(buildConfigUrl(), {
        method: 'POST',
        headers: getConfigHeaders(),
        body: JSON.stringify({
          key,
          value: serializeConfigValue(newValue)
        })
      })

      if (!response.ok) {
        throw new Error('Failed to save config')
      }

      // El POST usa fetch directo; invalida explícitamente el snapshot JSON
      // para que un consumidor que monte después no reciba el valor anterior.
      clearAppConfigReadCache()

      // 2. Actualizar cache local si esta config lo permite
      if (cacheFirst) {
        try {
          localStorage.setItem(`${CONFIG_PREFIX}${key}`, JSON.stringify(newValue))
        } catch {
          // La DB ya fue actualizada; el cache local es opcional.
        }
      }

      // 3. Actualizar estado local
      if (mountedRef.current) {
        setValue(newValue)
      }

      // 4. Notificar a otros componentes
      window.dispatchEvent(new CustomEvent(SYNC_EVENT, {
        detail: { key, value: newValue }
      }))
    } catch (error) {
      throw error
    } finally {
      finishSync()
    }
  }, [key, cacheFirst, beginSync, finishSync])

  return [value, updateValue, syncing]
}

/**
 * Hook para manejar configuración de tablas (columnas visibles, orden, etc)
 *
 * @param tableId - ID de la tabla (ej: 'contacts', 'campaigns')
 * @returns Configuración de la tabla y función para actualizarla
 *
 * @example
 * const [tableConfig, setTableConfig] = useTableConfig('contacts')
 */
export function useTableConfig<T = any>(tableId: string) {
  const key = `table_${tableId}`
  const [config, updateConfig, syncing] = useAppConfig<T | null>(key, null, {
    syncOnMount: true,
    cacheFirst: true
  })

  return [config, updateConfig, syncing] as const
}
