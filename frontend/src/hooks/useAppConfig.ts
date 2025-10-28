import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Sistema HÍBRIDO de configuración:
 * - LocalStorage como CACHE (lectura instantánea)
 * - PostgreSQL como SOURCE OF TRUTH (persistencia confiable)
 * - Sincronización automática entre ambos
 */

const CONFIG_PREFIX = 'rstk_config_'
const SYNC_EVENT = 'config-sync'

interface ConfigOptions {
  syncOnMount?: boolean // Sincronizar con DB al montar (default: true)
  cacheFirst?: boolean // Leer cache primero (default: true)
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

  // Sincronizar con la DB al montar
  useEffect(() => {
    mountedRef.current = true

    if (!syncOnMount) return

    const syncFromDB = async () => {
      try {
        const response = await fetch(`/api/config?keys=${key}`)
        if (!response.ok) throw new Error('Failed to fetch config')

        const data = await response.json()
        const dbValue = data.config?.[key]

        if (dbValue !== undefined && dbValue !== null && mountedRef.current) {
          const parsed = typeof defaultValue === 'string' ? dbValue : JSON.parse(dbValue)

          // Solo actualizar si es diferente del cache
          setValue((current) => {
            if (JSON.stringify(current) !== JSON.stringify(parsed)) {
              // Sincronizar cache con DB
              localStorage.setItem(`${CONFIG_PREFIX}${key}`, JSON.stringify(parsed))
              return parsed
            }
            return current
          })
        }
      } catch {
        // Keep cached value when DB sync fails
      }
    }

    syncFromDB()

    return () => {
      mountedRef.current = false
    }
  }, [key, syncOnMount]) // Removido defaultValue de deps

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
    setSyncing(true)

    try {
      // 1. Guardar en DB (source of truth)
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          value: typeof newValue === 'string' ? newValue : JSON.stringify(newValue)
        })
      })

      if (!response.ok) {
        throw new Error('Failed to save config')
      }

      // 2. Actualizar cache local
      localStorage.setItem(`${CONFIG_PREFIX}${key}`, JSON.stringify(newValue))

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
      if (mountedRef.current) {
        setSyncing(false)
      }
    }
  }, [key])

  return [value, updateValue, syncing]
}

/**
 * Hook para manejar múltiples configuraciones a la vez
 *
 * @param keys - Array de claves a cargar
 * @returns Objeto con todas las configuraciones
 *
 * @example
 * const { config, updateConfig, syncing } = useAppConfigs(['visitor_source', 'show_analytics'])
 */
export function useAppConfigs(keys: string[]) {
  const [config, setConfig] = useState<Record<string, any>>(() => {
    const cached: Record<string, any> = {}
    keys.forEach(key => {
      try {
        const value = localStorage.getItem(`${CONFIG_PREFIX}${key}`)
        if (value !== null) {
          cached[key] = JSON.parse(value)
        }
      } catch {
        // Ignore cache read errors for individual keys
      }
    })
    return cached
  })

  const [syncing, setSyncing] = useState(false)
  const mountedRef = useRef(true)

  // Sincronizar con DB al montar
  useEffect(() => {
    mountedRef.current = true

    const syncFromDB = async () => {
      try {
        const keysParam = keys.join(',')
        const response = await fetch(`/api/config?keys=${keysParam}`)
        if (!response.ok) throw new Error('Failed to fetch config')

        const data = await response.json()
        const dbConfig = data.config || {}

        if (mountedRef.current) {
          setConfig(current => {
            const updated = { ...current }
            let hasChanges = false

            Object.entries(dbConfig).forEach(([key, value]) => {
              if (value !== null && value !== undefined) {
                try {
                  const parsed = typeof value === 'string' && value.startsWith('{') ? JSON.parse(value) : value
                  if (JSON.stringify(current[key]) !== JSON.stringify(parsed)) {
                    updated[key] = parsed
                    localStorage.setItem(`${CONFIG_PREFIX}${key}`, JSON.stringify(parsed))
                    hasChanges = true
                  }
                } catch {
                  updated[key] = value
                  localStorage.setItem(`${CONFIG_PREFIX}${key}`, JSON.stringify(value))
                  hasChanges = true
                }
              }
            })

            return hasChanges ? updated : current
          })
        }
      } catch {
        // Leave current cache untouched if sync fails
      }
    }

    syncFromDB()

    return () => {
      mountedRef.current = false
    }
  }, [keys.join(',')])

  // Función para actualizar configuración
  const updateConfig = useCallback(async (updates: Record<string, any>) => {
    setSyncing(true)

    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: updates })
      })

      if (!response.ok) {
        throw new Error('Failed to save config')
      }

      // Actualizar cache y estado local
      if (mountedRef.current) {
        setConfig(current => {
          const updated = { ...current, ...updates }
          Object.entries(updates).forEach(([key, value]) => {
            localStorage.setItem(`${CONFIG_PREFIX}${key}`, JSON.stringify(value))
            window.dispatchEvent(new CustomEvent(SYNC_EVENT, {
              detail: { key, value }
            }))
          })
          return updated
        })
      }
    } catch (error) {
      throw error
    } finally {
      if (mountedRef.current) {
        setSyncing(false)
      }
    }
  }, [])

  return { config, updateConfig, syncing }
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
