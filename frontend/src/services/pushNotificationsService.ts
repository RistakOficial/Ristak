import apiClient from './apiClient'
import { mobileAppService } from './mobileAppService'
import { getPortableDeviceMode } from '@/utils/phoneAccess'

export interface WebPushPublicConfig {
  configured: boolean
  publicKey: string
}

export type PushSubscriptionResult =
  | { status: 'subscribed' }
  | { status: 'not_supported'; reason: string }
  | { status: 'not_configured'; reason: string }
  | { status: 'denied'; reason: string }

export type CalendarPushResult = PushSubscriptionResult

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = `${base64String}${padding}`.replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i)
  }

  return outputArray
}

function isPushAvailable() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext
  )
}

function getBrowserNotificationTarget() {
  return getPortableDeviceMode() === 'desktop' ? 'esta computadora' : 'este celular'
}

export const pushNotificationsService = {
  async getPublicConfig(): Promise<WebPushPublicConfig> {
    return apiClient.get<WebPushPublicConfig>('/push/public-key')
  },

  async subscribeToAppNotifications({ calendarIds = [] }: { calendarIds?: string[] } = {}): Promise<PushSubscriptionResult> {
    if (mobileAppService.isNative()) {
      return mobileAppService.subscribeToPushNotifications({ calendarIds })
    }

    if (!isPushAvailable()) {
      const target = getBrowserNotificationTarget()
      return {
        status: 'not_supported',
        reason: `El navegador en ${target} no permite notificaciones de la app. Revisa que estés en HTTPS o localhost; en iPhone, abre Ristak desde el icono agregado al inicio.`
      }
    }

    const config = await this.getPublicConfig()
    if (!config.configured || !config.publicKey) {
      return {
        status: 'not_configured',
        reason: `El servidor todavía no pudo preparar las notificaciones para ${getBrowserNotificationTarget()}. Cierra y vuelve a abrir Ristak; si sigue igual, revisa la configuración de notificaciones del servidor.`
      }
    }

    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission()

    if (permission !== 'granted') {
      return {
        status: 'denied',
        reason: `El navegador en ${getBrowserNotificationTarget()} no dio permiso para recibir notificaciones de Ristak.`
      }
    }

    const registration = await navigator.serviceWorker.register('/sw.js')
    const existingSubscription = await registration.pushManager.getSubscription()
    const subscription = existingSubscription || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey)
    })

    await apiClient.post('/push/subscriptions', {
      subscription,
      calendarIds
    })

    return { status: 'subscribed' }
  },

  async subscribeToCalendarNotifications(calendarIds: string[]): Promise<CalendarPushResult> {
    return this.subscribeToAppNotifications({ calendarIds })
  }
}
