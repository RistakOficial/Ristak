// (MOB-006) Hook de configuración POR USUARIO (espejo de useAppConfig).
//
// Misma firma y semántica que useAppConfig ([value, setValue, syncing]), pero apunta
// a /api/user-config en vez de /api/config. El backend resuelve cada clave con FALLBACK
// al valor global de app_config cuando el usuario no tiene override propio, así que un
// empleado sin preferencias personales hereda exactamente lo que el dueño dejó global.
//
// CACHE localStorage NAMESPACEADO POR USUARIO (`rstk_uconfig_<userId>_<key>`): si dos
// empleados usan el mismo navegador/dispositivo, NO se mezclan sus preferencias (RIESGO 5).
import { useState, useEffect, useCallback, useRef } from 'react'
import { apiUrl } from '@/services/apiBaseUrl'
import { useAuth } from '@/contexts/AuthContext'

const USER_CONFIG_PREFIX = 'rstk_uconfig_'
const USER_SYNC_EVENT = 'user-config-sync'

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

const buildUserConfigUrl = (params?: URLSearchParams) => (
  apiUrl(`/api/user-config${params ? `?${params.toString()}` : ''}`)
)

interface ConfigOptions {
  syncOnMount?: boolean // Sincronizar con DB al montar (default: true)
  cacheFirst?: boolean // Usar localStorage como cache (default: true)
}

/**
 * Hook para manejar UNA preferencia por-usuario de la app (las 7 de notificaciones
 * del celular). Espejo exacto de useAppConfig en firma y comportamiento.
 *
 * @param key - Clave de configuración (ej: 'chat_push_notifications_enabled')
 * @param defaultValue - Valor por default si no existe ni override ni global
 * @param options - Opciones de comportamiento
 *
 * @example
 * const [chatPush, setChatPush] = useUserConfig('chat_push_notifications_enabled', true)
 */
export function useUserConfig<T = string>(
  key: string,
  defaultValue: T,
  options: ConfigOptions = {}
): [T, (value: T) => Promise<void>, boolean] {
  const { syncOnMount = true, cacheFirst = true } = options
  const { user } = useAuth()
  // userId namespacea el cache local. Si aún no hay usuario, usamos 'anon' (se
  // re-sincroniza al montar de todos modos contra la DB, fuente de verdad).
  const userId = user?.id || 'anon'
  const cacheKey = `${USER_CONFIG_PREFIX}${userId}_${key}`
  const cacheKeyRef = useRef(cacheKey)

  useEffect(() => {
    cacheKeyRef.current = cacheKey
  }, [cacheKey])

  // Estado local
  const [value, setValue] = useState<T>(() => {
    if (!cacheFirst) return defaultValue

    try {
      const cached = localStorage.getItem(`${USER_CONFIG_PREFIX}${userId}_${key}`)
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

  // Si cambia el usuario (mismo navegador, otra sesión), re-hidratar del cache propio.
  useEffect(() => {
    if (!cacheFirst) return
    try {
      const cached = localStorage.getItem(cacheKey)
      if (cached !== null) {
        setValue(JSON.parse(cached) as T)
      } else {
        setValue(defaultValueRef.current)
      }
    } catch {
      // Si falla la lectura del cache, la DB sigue siendo la fuente de verdad.
    }
  }, [cacheKey, cacheFirst])

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
        const params = new URLSearchParams({ keys: key })
        const response = await fetch(buildUserConfigUrl(params), {
          headers: getConfigHeaders()
        })
        if (!response.ok) throw new Error('Failed to fetch user config')

        const data = await response.json()
        const dbValue = data.config?.[key]

        if (
          dbValue !== undefined &&
          dbValue !== null &&
          !cancelled &&
          mountedRef.current &&
          valueVersionRef.current === requestVersion
        ) {
          const parsed = parseStoredConfigValue(dbValue, defaultValueRef.current)

          setValue((current) => {
            if (JSON.stringify(current) !== JSON.stringify(parsed)) {
              if (cacheFirst) {
                try {
                  localStorage.setItem(cacheKeyRef.current, JSON.stringify(parsed))
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
  }, [key, cacheKey, syncOnMount, cacheFirst, beginSync, finishSync])

  // Escuchar cambios desde otros componentes (solo del MISMO usuario+clave)
  useEffect(() => {
    const handleSync = (event: CustomEvent) => {
      const { key: changedKey, value: newValue, userId: changedUserId } = event.detail
      if (changedKey === key && changedUserId === userId && mountedRef.current) {
        setValue(newValue)
      }
    }

    window.addEventListener(USER_SYNC_EVENT, handleSync as EventListener)
    return () => window.removeEventListener(USER_SYNC_EVENT, handleSync as EventListener)
  }, [key, userId])

  // Función para actualizar el valor
  const updateValue = useCallback(async (newValue: T) => {
    valueVersionRef.current += 1
    beginSync()

    try {
      // 1. Guardar en DB (source of truth)
      const response = await fetch(buildUserConfigUrl(), {
        method: 'POST',
        headers: getConfigHeaders(),
        body: JSON.stringify({
          key,
          value: serializeConfigValue(newValue)
        })
      })

      if (!response.ok) {
        throw new Error('Failed to save user config')
      }

      // 2. Actualizar cache local namespaceado por usuario
      if (cacheFirst) {
        try {
          localStorage.setItem(cacheKeyRef.current, JSON.stringify(newValue))
        } catch {
          // La DB ya fue actualizada; el cache local es opcional.
        }
      }

      // 3. Actualizar estado local
      if (mountedRef.current) {
        setValue(newValue)
      }

      // 4. Notificar a otros componentes del mismo usuario
      window.dispatchEvent(new CustomEvent(USER_SYNC_EVENT, {
        detail: { key, value: newValue, userId }
      }))
    } catch (error) {
      throw error
    } finally {
      finishSync()
    }
  }, [key, userId, cacheFirst, beginSync, finishSync])

  return [value, updateValue, syncing]
}
