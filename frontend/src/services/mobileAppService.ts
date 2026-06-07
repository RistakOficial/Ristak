import { App } from '@capacitor/app'
import { Camera, CameraDirection, EncodingType, MediaTypeSelection, type MediaResult } from '@capacitor/camera'
import { Capacitor } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { Filesystem } from '@capacitor/filesystem'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Keyboard, KeyboardResize } from '@capacitor/keyboard'
import { PushNotifications, type ActionPerformed, type Token } from '@capacitor/push-notifications'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import apiClient from './apiClient'
import type { PushSubscriptionResult } from './pushNotificationsService'

type NativePlatform = 'ios' | 'android' | 'web'
type PhotoSource = 'camera' | 'photos'
type DocumentSource = 'documents'
type MobileShellTheme = 'light' | 'dark'

export interface MobilePhotoAttachment {
  id: string
  name: string
  type: string
  dataUrl: string
  attachmentType: 'image'
  source: PhotoSource
  size?: number
}

export interface MobileDocumentAttachment {
  id: string
  name: string
  type: string
  dataUrl: string
  attachmentType: 'document'
  source: DocumentSource
  size: number
}

export type MobileChatAttachment = MobilePhotoAttachment | MobileDocumentAttachment

let shellConfigured = false
let notificationListenersConfigured = false

function getPlatform(): NativePlatform {
  return Capacitor.getPlatform() as NativePlatform
}

async function applyShellTheme(theme: MobileShellTheme) {
  if (!Capacitor.isNativePlatform()) return

  await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light }).catch(() => undefined)
  await StatusBar.setBackgroundColor({ color: theme === 'dark' ? '#0b0f14' : '#ffffff' }).catch(() => undefined)
}

function openInternalPath(value?: string | null) {
  if (!value || typeof window === 'undefined') return

  let nextPath = value
  try {
    const parsed = new URL(value, window.location.origin)
    if (parsed.origin !== window.location.origin) {
      window.open(parsed.href, '_blank', 'noopener,noreferrer')
      return
    }
    nextPath = `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    nextPath = value.startsWith('/') ? value : '/phone/chat'
  }

  window.history.pushState({}, '', nextPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function getNotificationPath(notification: ActionPerformed['notification'] | { data?: Record<string, unknown> }) {
  const data = notification?.data || {}
  const directUrl = typeof data.url === 'string' ? data.url : ''
  const route = typeof data.route === 'string' ? data.route : ''
  return directUrl || route || '/phone/chat'
}

function normalizeImageFormat(format = '') {
  const clean = String(format || '').toLowerCase()
  if (clean === 'jpg' || clean === 'jpeg') return 'jpeg'
  if (clean === 'png') return 'png'
  if (clean === 'webp') return 'webp'
  return 'jpeg'
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : ''
      resolve(value.includes(',') ? value.split(',').pop() || '' : value)
    }
    reader.onerror = () => reject(reader.error || new Error('The photo could not be read'))
    reader.readAsDataURL(blob)
  })
}

async function readMediaAsDataUrl(result: MediaResult, source: PhotoSource): Promise<MobilePhotoAttachment | null> {
  const format = normalizeImageFormat(result.metadata?.format)
  let base64 = ''

  if (result.uri && Capacitor.isNativePlatform()) {
    const file = await Filesystem.readFile({ path: result.uri })
    base64 = typeof file.data === 'string' ? file.data : await blobToBase64(file.data)
  } else if (result.thumbnail) {
    base64 = result.thumbnail
  }

  if (!base64) return null

  return {
    id: `photo-${Date.now()}`,
    name: source === 'camera' ? `foto-${Date.now()}.${format}` : `imagen-${Date.now()}.${format}`,
    type: `image/${format}`,
    dataUrl: `data:image/${format};base64,${base64}`,
    attachmentType: 'image',
    source
  }
}

async function getNativeDevicePayload(token: string, calendarIds: string[] = []) {
  const [device, appInfo] = await Promise.all([
    Device.getInfo().catch(() => null),
    App.getInfo().catch(() => null)
  ])

  return {
    token,
    platform: getPlatform(),
    calendarIds,
    appVersion: appInfo?.version || '',
    appBuild: appInfo?.build || '',
    deviceModel: device?.model || '',
    osVersion: device?.osVersion || ''
  }
}

async function configureNativeNotificationListeners() {
  if (notificationListenersConfigured || !Capacitor.isNativePlatform()) return
  notificationListenersConfigured = true

  await PushNotifications.addListener('pushNotificationActionPerformed', (event) => {
    openInternalPath(getNotificationPath(event.notification))
  }).catch(() => undefined)
}

async function createAndroidNotificationChannel() {
  if (getPlatform() !== 'android') return

  await PushNotifications.createChannel({
    id: 'ristak_alerts',
    name: 'Mensajes de WhatsApp',
    description: 'Notificaciones de mensajes, citas y pagos',
    importance: 5,
    visibility: 1,
    sound: 'default',
    lights: true,
    vibration: true
  }).catch(() => undefined)
}

function waitForNativePushToken(calendarIds: string[] = []): Promise<PushSubscriptionResult> {
  return new Promise((resolve) => {
    let settled = false
    const cleanupHandles: Array<{ remove: () => Promise<void> }> = []

    const finish = async (result: PushSubscriptionResult) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      await Promise.all(cleanupHandles.map((handle) => handle.remove().catch(() => undefined)))
      resolve(result)
    }

    const timeout = window.setTimeout(() => {
      finish({
        status: 'denied',
        reason: 'This phone did not return the alert key. Close and reopen Ristak, then try again.'
      })
    }, 16000)

    const startRegistration = async () => {
      try {
        cleanupHandles.push(await PushNotifications.addListener('registration', async (token: Token) => {
          try {
            const payload = await getNativeDevicePayload(token.value, calendarIds)
            await apiClient.post('/push/mobile-devices', payload)
            await finish({ status: 'subscribed' })
          } catch (error) {
            await finish({
              status: 'denied',
              reason: error instanceof Error ? error.message : 'This phone could not be saved for alerts.'
            })
          }
        }))

        cleanupHandles.push(await PushNotifications.addListener('registrationError', (error) => {
          finish({
            status: 'denied',
            reason: error?.error || 'This phone rejected alert registration.'
          })
        }))

        await PushNotifications.register()
      } catch (error) {
        await finish({
          status: 'denied',
          reason: error instanceof Error ? error.message : 'Alert registration could not be requested.'
        })
      }
    }

    startRegistration()
  })
}

export const mobileAppService = {
  isNative() {
    return Capacitor.isNativePlatform()
  },

  getPlatform,

  async configureShell() {
    if (shellConfigured || !Capacitor.isNativePlatform()) return
    shellConfigured = true

    await applyShellTheme('light')
    await StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined)
    await SplashScreen.hide().catch(() => undefined)

    if (getPlatform() === 'ios') {
      await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined)
      await Keyboard.setResizeMode({ mode: KeyboardResize.Native }).catch(() => undefined)
    }

    await App.addListener('appUrlOpen', (event) => {
      openInternalPath(event.url)
    }).catch(() => undefined)

    await App.addListener('backButton', ({ canGoBack }) => {
      if (window.location.pathname.startsWith('/phone') && canGoBack) {
        window.history.back()
      }
    }).catch(() => undefined)

    await configureNativeNotificationListeners()
  },

  async setShellTheme(theme: MobileShellTheme) {
    await applyShellTheme(theme)
  },

  async getPushPermissionStatus(): Promise<'granted' | 'denied' | 'prompt' | 'unsupported'> {
    if (!Capacitor.isNativePlatform()) return 'unsupported'

    const permission = await PushNotifications.checkPermissions().catch(() => null)
    if (permission?.receive === 'granted' || permission?.receive === 'denied' || permission?.receive === 'prompt') {
      return permission.receive
    }
    if (permission?.receive === 'prompt-with-rationale') return 'prompt'
    return 'unsupported'
  },

  async subscribeToPushNotifications({ calendarIds = [] }: { calendarIds?: string[] } = {}): Promise<PushSubscriptionResult> {
    if (!Capacitor.isNativePlatform()) {
      return {
        status: 'not_supported',
        reason: 'Esta instalación no es la app nativa. Usa el botón desde el navegador o agrega Ristak al inicio.'
      }
    }

    await configureNativeNotificationListeners()
    await createAndroidNotificationChannel()

    let permission = await PushNotifications.checkPermissions()
    if (permission.receive === 'prompt') {
      permission = await PushNotifications.requestPermissions()
    }

    if (permission.receive !== 'granted') {
      return {
        status: 'denied',
        reason: 'This phone did not allow Ristak alerts.'
      }
    }

    return waitForNativePushToken(calendarIds)
  },

  async pickPhoto(source: PhotoSource): Promise<MobilePhotoAttachment | null> {
    if (!Capacitor.isNativePlatform()) return null

    const result = source === 'camera'
      ? await Camera.takePhoto({
          quality: 78,
          cameraDirection: CameraDirection.Rear,
          encodingType: EncodingType.JPEG,
          correctOrientation: true,
          saveToGallery: false,
          editable: 'no',
          includeMetadata: true
        })
      : (await Camera.chooseFromGallery({
          mediaType: MediaTypeSelection.Photo,
          allowMultipleSelection: false,
          quality: 78,
          editable: 'no',
          includeMetadata: true
        })).results[0]

    if (!result) return null

    await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined)
    return readMediaAsDataUrl(result, source)
  }
}
