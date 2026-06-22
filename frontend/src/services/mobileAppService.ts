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
import { hasRuntimeApiBaseUrl } from './apiBaseUrl'
import apiClient from './apiClient'
import type { PushSubscriptionResult } from './pushNotificationsService'

type NativePlatform = 'ios' | 'android' | 'web'
type PhotoSource = 'camera' | 'photos'
type DocumentSource = 'documents'
type MobileShellTheme = 'light' | 'dark'

export const MOBILE_APP_NOTIFICATION_EVENT = 'ristak:mobile-notification'
const IOS_PHONE_CHAT_HOME_PATH = '/phone/chat'
const IOS_PHONE_CHAT_LOGIN_PATH = '/phone/login'
const IOS_PHONE_TENANT_PATH = '/phone/tenant'
const MOBILE_HAPTICS_ENABLED_STORAGE_KEY = 'ristak_mobile_haptics_enabled'
const MOBILE_KEYBOARD_FEEDBACK_STORAGE_KEY = 'ristak_mobile_keyboard_feedback_enabled'
const MOBILE_KEYBOARD_FEEDBACK_INTERVAL_MS = 55
const IOS_PHONE_CHAT_ALLOWED_PATHS = new Set([
  IOS_PHONE_CHAT_HOME_PATH,
  IOS_PHONE_CHAT_LOGIN_PATH,
  IOS_PHONE_TENANT_PATH,
  '/setup',
  '/sso',
  '/license-blocked'
])

export interface MobileAppNotificationDetail {
  category: string
  contactId: string
  messageId: string
  source: 'received' | 'action'
  url: string
}

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
let lastKeyboardFeedbackAt = 0
let keyboardClickAudioContext: AudioContext | null = null

function getPlatform(): NativePlatform {
  return Capacitor.getPlatform() as NativePlatform
}

function getAudioContextConstructor() {
  if (typeof window === 'undefined') return null

  const audioWindow = window as Window & typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
  }
  return audioWindow.AudioContext || audioWindow.webkitAudioContext || null
}

function isIosPhoneChatShell() {
  return Capacitor.isNativePlatform() && getPlatform() === 'ios'
}

function getPathname(value: string) {
  try {
    return new URL(value, window.location.origin).pathname
  } catch {
    return value.split(/[?#]/)[0] || '/'
  }
}

function getIosPhoneChatRedirectPath(pathname = typeof window !== 'undefined' ? window.location.pathname : '') {
  if (!isIosPhoneChatShell()) return ''
  if (!hasRuntimeApiBaseUrl()) {
    return pathname === IOS_PHONE_TENANT_PATH ? '' : IOS_PHONE_TENANT_PATH
  }
  if (IOS_PHONE_CHAT_ALLOWED_PATHS.has(pathname)) return ''
  if (pathname === '/login') return IOS_PHONE_CHAT_LOGIN_PATH
  return IOS_PHONE_CHAT_HOME_PATH
}

function replaceInternalPath(value: string) {
  if (typeof window === 'undefined') return

  window.history.replaceState({}, '', value)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function ensureIosPhoneChatRoute() {
  if (typeof window === 'undefined') return

  const redirectPath = getIosPhoneChatRedirectPath(window.location.pathname)
  if (redirectPath) replaceInternalPath(redirectPath)
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
    nextPath = value.startsWith('/') ? value : IOS_PHONE_CHAT_HOME_PATH
  }

  nextPath = getIosPhoneChatRedirectPath(getPathname(nextPath)) || nextPath
  window.history.pushState({}, '', nextPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function getNotificationPath(notification: ActionPerformed['notification'] | { data?: Record<string, unknown> }) {
  const data = notification?.data || {}
  const directUrl = typeof data.url === 'string' ? data.url : ''
  const route = typeof data.route === 'string' ? data.route : ''
  return directUrl || route || IOS_PHONE_CHAT_HOME_PATH
}

function getNotificationContactId(data: Record<string, unknown>, url: string) {
  const directContactId = typeof data.contactId === 'string' ? data.contactId : ''
  if (directContactId) return directContactId

  try {
    const parsed = new URL(url, window.location.origin)
    return parsed.searchParams.get('contact') || ''
  } catch {
    return ''
  }
}

function dispatchMobileNotificationEvent(
  notification: ActionPerformed['notification'] | { data?: Record<string, unknown> },
  source: MobileAppNotificationDetail['source']
) {
  if (typeof window === 'undefined') return

  const data = notification?.data || {}
  const url = getNotificationPath(notification)
  const detail: MobileAppNotificationDetail = {
    category: typeof data.category === 'string' ? data.category : '',
    contactId: getNotificationContactId(data, url),
    messageId: typeof data.messageId === 'string' ? data.messageId : '',
    source,
    url
  }

  window.dispatchEvent(new CustomEvent<MobileAppNotificationDetail>(MOBILE_APP_NOTIFICATION_EVENT, { detail }))
}

function normalizeImageFormat(format = '') {
  const clean = String(format || '').toLowerCase()
  if (clean === 'jpg' || clean === 'jpeg') return 'jpeg'
  if (clean === 'png') return 'png'
  if (clean === 'webp') return 'webp'
  return 'jpeg'
}

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return raw === '1' || raw === 'true'
  } catch {
    return fallback
  }
}

function writeStoredBoolean(key: string, value: boolean) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // local settings are best-effort only
  }
}

function mobileHapticsEnabled() {
  return readStoredBoolean(MOBILE_HAPTICS_ENABLED_STORAGE_KEY, true)
}

function mobileKeyboardFeedbackEnabled() {
  return readStoredBoolean(MOBILE_KEYBOARD_FEEDBACK_STORAGE_KEY, true)
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

  await PushNotifications.addListener('pushNotificationReceived', (notification) => {
    void triggerLightHapticFeedback()
    dispatchMobileNotificationEvent(notification, 'received')
  }).catch(() => undefined)

  await PushNotifications.addListener('pushNotificationActionPerformed', (event) => {
    dispatchMobileNotificationEvent(event.notification, 'action')
    openInternalPath(getNotificationPath(event.notification))
  }).catch(() => undefined)
}

async function createAndroidNotificationChannels() {
  if (getPlatform() !== 'android') return

  await Promise.all([
    PushNotifications.createChannel({
      id: 'ristak_alerts',
      name: 'Alertas con sonido y vibración',
      description: 'Mensajes, citas, pagos y avisos importantes',
      importance: 5,
      visibility: 1,
      sound: 'default',
      lights: true,
      vibration: true
    }),
    PushNotifications.createChannel({
      id: 'ristak_sound',
      name: 'Alertas con sonido',
      description: 'Notificaciones de Ristak con sonido y sin vibración',
      importance: 5,
      visibility: 1,
      sound: 'default',
      lights: true,
      vibration: false
    }),
    PushNotifications.createChannel({
      id: 'ristak_vibrate',
      name: 'Alertas con vibración',
      description: 'Notificaciones de Ristak con vibración y sin sonido',
      importance: 5,
      visibility: 1,
      lights: true,
      vibration: true
    }),
    PushNotifications.createChannel({
      id: 'ristak_silent',
      name: 'Alertas silenciosas',
      description: 'Notificaciones de Ristak sin sonido ni vibración',
      importance: 3,
      visibility: 1,
      lights: false,
      vibration: false
    })
  ].map((task) => task.catch(() => undefined)))
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

/**
 * Vibración ligera para gestos (long-press, confirmaciones).
 * En la app nativa usa el motor háptico real (Capacitor); en web cae a
 * navigator.vibrate (Android); en iOS web no hay soporte y no hace nada.
 */
export async function triggerLightHapticFeedback() {
  if (!mobileHapticsEnabled()) return

  if (Capacitor.isNativePlatform()) {
    try {
      await Haptics.impact({ style: ImpactStyle.Light })
      return
    } catch {
      // sin soporte háptico nativo, probar vibración web
    }
  }

  try {
    navigator.vibrate?.(14)
  } catch {
    // intentionally ignore
  }
}

export async function triggerKeyboardClickFeedback() {
  if (!mobileHapticsEnabled() || !mobileKeyboardFeedbackEnabled()) return

  const now = Date.now()
  if (now - lastKeyboardFeedbackAt < MOBILE_KEYBOARD_FEEDBACK_INTERVAL_MS) return
  lastKeyboardFeedbackAt = now

  await Promise.all([
    triggerLightHapticFeedback(),
    playKeyboardClickSound()
  ])
}

async function playKeyboardClickSound() {
  if (!Capacitor.isNativePlatform()) return

  const AudioContextConstructor = getAudioContextConstructor()
  if (!AudioContextConstructor) return

  try {
    const context = keyboardClickAudioContext && keyboardClickAudioContext.state !== 'closed'
      ? keyboardClickAudioContext
      : new AudioContextConstructor()
    keyboardClickAudioContext = context

    if (context.state === 'suspended') {
      await context.resume()
    }

    const startAt = context.currentTime
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(1700, startAt)
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(0.018, startAt + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.026)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(startAt)
    oscillator.stop(startAt + 0.03)
    oscillator.onended = () => {
      oscillator.disconnect()
      gain.disconnect()
    }
  } catch {
    // Audio feedback is best-effort; haptics still cover the interaction.
  }
}

export function setMobileFeedbackPreferences({
  hapticsEnabled,
  keyboardFeedbackEnabled
}: {
  hapticsEnabled?: boolean
  keyboardFeedbackEnabled?: boolean
}) {
  if (typeof hapticsEnabled === 'boolean') {
    writeStoredBoolean(MOBILE_HAPTICS_ENABLED_STORAGE_KEY, hapticsEnabled)
  }
  if (typeof keyboardFeedbackEnabled === 'boolean') {
    writeStoredBoolean(MOBILE_KEYBOARD_FEEDBACK_STORAGE_KEY, keyboardFeedbackEnabled)
  }
}

export const mobileAppService = {
  isNative() {
    return Capacitor.isNativePlatform()
  },

  getPlatform,

  isIosPhoneChatShell,

  getIosPhoneChatRedirectPath,

  setFeedbackPreferences: setMobileFeedbackPreferences,

  async configureShell() {
    if (shellConfigured || !Capacitor.isNativePlatform()) return
    shellConfigured = true

    ensureIosPhoneChatRoute()
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
    await createAndroidNotificationChannels()
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
    await createAndroidNotificationChannels()

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
