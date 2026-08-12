import { useCallback, useEffect, useState } from 'react'
import { mobileAppService } from '@/services/mobileAppService'
import { pushNotificationsService, type PushSubscriptionResult } from '@/services/pushNotificationsService'
import { getPortableDeviceMode } from '@/utils/phoneAccess'

export type MobilePushPermission = 'checking' | 'granted' | 'denied' | 'prompt' | 'unsupported'

function getBrowserPermission(): MobilePushPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  if (window.Notification.permission === 'granted') return 'granted'
  if (window.Notification.permission === 'denied') return 'denied'
  return 'prompt'
}

export function useMobilePushPermission() {
  const isDesktop = !mobileAppService.isNative() && getPortableDeviceMode() === 'desktop'
  const [permission, setPermission] = useState<MobilePushPermission>(() => (
    isDesktop ? 'unsupported' : mobileAppService.isNative() ? 'checking' : getBrowserPermission()
  ))

  const refresh = useCallback(async () => {
    if (isDesktop) {
      setPermission('unsupported')
      return 'unsupported' as const
    }

    if (!mobileAppService.isNative()) {
      const nextPermission = getBrowserPermission()
      setPermission(nextPermission)
      return nextPermission
    }

    setPermission((current) => current === 'checking' ? current : 'checking')
    try {
      const nextPermission = await mobileAppService.getPushPermissionStatus()
      setPermission(nextPermission)
      return nextPermission
    } catch {
      setPermission('unsupported')
      return 'unsupported' as const
    }
  }, [isDesktop])

  useEffect(() => {
    void refresh()
    if (typeof window === 'undefined') return undefined

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }

    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refresh])

  const activate = useCallback(async (calendarIds: string[] = []): Promise<PushSubscriptionResult> => {
    if (isDesktop) {
      return {
        status: 'not_supported',
        reason: 'Las notificaciones push se activan únicamente desde la app móvil de Ristak.'
      }
    }

    const result = await pushNotificationsService.subscribeToAppNotifications({ calendarIds })
    await refresh()
    return result
  }, [isDesktop, refresh])

  return {
    activate,
    isDesktop,
    isGranted: permission === 'granted',
    isChecking: permission === 'checking',
    permission,
    refresh,
    showActivation: !isDesktop && permission !== 'checking' && permission !== 'granted'
  }
}
