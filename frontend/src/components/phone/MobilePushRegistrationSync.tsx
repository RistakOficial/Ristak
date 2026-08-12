import { useCallback, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { mobileAppService } from '@/services/mobileAppService'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import { getPortableDeviceMode, isPhoneAppPath } from '@/utils/phoneAccess'

const REGISTRATION_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000
const STORAGE_PREFIX = 'ristak_mobile_push_registration_sync_v2'

function readLastSync(storageKey: string) {
  try {
    return Number(window.localStorage.getItem(storageKey) || 0)
  } catch {
    return 0
  }
}

function saveLastSync(storageKey: string) {
  try {
    window.localStorage.setItem(storageKey, String(Date.now()))
  } catch {
    // El registro en backend ya quedó hecho; la caché local sólo evita trabajo repetido.
  }
}

async function alreadyHasSystemPermission() {
  if (mobileAppService.isNative()) {
    return await mobileAppService.getPushPermissionStatus() === 'granted'
  }

  return typeof window !== 'undefined' &&
    'Notification' in window &&
    window.Notification.permission === 'granted'
}

/**
 * Mantiene vigente el token push cuando el sistema ya concedió permiso.
 * Nunca solicita autorización: el prompt nativo sólo puede salir desde el
 * switch explícito de Ajustes.
 */
export function MobilePushRegistrationSync() {
  const location = useLocation()
  const { isAuthenticated, isLoading, locationId, user } = useAuth()
  const storageKey = useMemo(
    () => `${STORAGE_PREFIX}:${locationId || 'account'}:${user?.id || 'anonymous'}`,
    [locationId, user?.id]
  )

  const syncGrantedRegistration = useCallback(async () => {
    if (
      isLoading ||
      !isAuthenticated ||
      !isPhoneAppPath(location.pathname) ||
      (!mobileAppService.isNative() && getPortableDeviceMode() === 'desktop')
    ) {
      return
    }

    const lastSync = readLastSync(storageKey)
    if (Number.isFinite(lastSync) && lastSync > 0 && Date.now() - lastSync < REGISTRATION_SYNC_INTERVAL_MS) return
    try {
      if (!await alreadyHasSystemPermission()) return
      const result = await pushNotificationsService.subscribeToAppNotifications()
      if (result.status === 'subscribed') saveLastSync(storageKey)
    } catch {
      // Se reintentará al volver a primer plano; jamás abrimos un modal automático.
    }
  }, [isAuthenticated, isLoading, location.pathname, storageKey])

  useEffect(() => {
    void syncGrantedRegistration()
    if (typeof window === 'undefined') return undefined

    const syncWhenVisible = () => {
      if (document.visibilityState === 'visible') void syncGrantedRegistration()
    }

    window.addEventListener('focus', syncWhenVisible)
    document.addEventListener('visibilitychange', syncWhenVisible)
    return () => {
      window.removeEventListener('focus', syncWhenVisible)
      document.removeEventListener('visibilitychange', syncWhenVisible)
    }
  }, [syncGrantedRegistration])

  return null
}
