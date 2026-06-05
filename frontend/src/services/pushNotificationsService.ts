import apiClient from './apiClient'

export interface WebPushPublicConfig {
  configured: boolean
  publicKey: string
}

export type CalendarPushResult =
  | { status: 'subscribed' }
  | { status: 'not_supported'; reason: string }
  | { status: 'not_configured'; reason: string }
  | { status: 'denied'; reason: string }

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

export const pushNotificationsService = {
  async getPublicConfig(): Promise<WebPushPublicConfig> {
    return apiClient.get<WebPushPublicConfig>('/push/public-key')
  },

  async subscribeToCalendarNotifications(calendarIds: string[]): Promise<CalendarPushResult> {
    if (!isPushAvailable()) {
      return {
        status: 'not_supported',
        reason: 'Este navegador no permite avisos de la app. En iPhone, abre Ristak desde el icono agregado al inicio.'
      }
    }

    const config = await this.getPublicConfig()
    if (!config.configured || !config.publicKey) {
      return {
        status: 'not_configured',
        reason: 'Falta guardar la llave de avisos en el servidor para poder enviar notificaciones a este celular.'
      }
    }

    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission()

    if (permission !== 'granted') {
      return {
        status: 'denied',
        reason: 'El celular no dio permiso para recibir avisos de Ristak.'
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
  }
}
