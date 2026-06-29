import { App } from '@capacitor/app'
import { Camera, CameraDirection, EncodingType, MediaTypeSelection, type MediaResult } from '@capacitor/camera'
import { Capacitor } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { Filesystem } from '@capacitor/filesystem'
import { Keyboard, KeyboardResize } from '@capacitor/keyboard'
import { PushNotifications, type ActionPerformed, type Token } from '@capacitor/push-notifications'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import { hasRuntimeApiBaseUrl } from './apiBaseUrl'
import apiClient from './apiClient'
import type { PushSubscriptionResult } from './pushNotificationsService'
import { isPublicPaymentPath } from '@/utils/phoneAccess'

type NativePlatform = 'ios' | 'android' | 'web'
type PhotoSource = 'camera' | 'photos'
type DocumentSource = 'documents'
type MobileShellTheme = 'light' | 'dark'

export const MOBILE_APP_NOTIFICATION_EVENT = 'ristak:mobile-notification'
const IOS_MOBILE_APP_PREFIX = '/movil'
const IOS_MOBILE_HOME_PATH = IOS_MOBILE_APP_PREFIX
const IOS_MOBILE_LOGIN_PATH = `${IOS_MOBILE_APP_PREFIX}/login`
const IOS_MOBILE_TENANT_PATH = `${IOS_MOBILE_APP_PREFIX}/tenant`
const LEGACY_IOS_PHONE_APP_PREFIX = '/phone'
const LEGACY_IOS_PHONE_CHAT_PATH = `${LEGACY_IOS_PHONE_APP_PREFIX}/chat`
const IOS_MOBILE_APP_ALLOWED_PATHS = new Set([
  IOS_MOBILE_APP_PREFIX,
  `${IOS_MOBILE_APP_PREFIX}/app`,
  IOS_MOBILE_HOME_PATH,
  IOS_MOBILE_LOGIN_PATH,
  IOS_MOBILE_TENANT_PATH,
  `${IOS_MOBILE_APP_PREFIX}/payments`,
  `${IOS_MOBILE_APP_PREFIX}/analytics`,
  `${IOS_MOBILE_APP_PREFIX}/settings`,
  `${IOS_MOBILE_APP_PREFIX}/calendar`,
  `${IOS_MOBILE_APP_PREFIX}/appointments`,
  '/setup',
  '/sso',
  '/license-blocked'
])
const IOS_MOBILE_APP_ALLOWED_PATH_PREFIXES = [
  `${IOS_MOBILE_APP_PREFIX}/agent-chat`,
  `${IOS_MOBILE_APP_PREFIX}/agent-ai`,
  `${IOS_MOBILE_APP_PREFIX}/ai-agent`
]

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

function getPlatform(): NativePlatform {
  return Capacitor.getPlatform() as NativePlatform
}

function isIosMobileShell() {
  return Capacitor.isNativePlatform() && getPlatform() === 'ios'
}

function isIosMobileAppPath(pathname: string) {
  return pathname === IOS_MOBILE_APP_PREFIX ||
    pathname.startsWith(`${IOS_MOBILE_APP_PREFIX}/`) ||
    pathname === LEGACY_IOS_PHONE_APP_PREFIX ||
    pathname.startsWith(`${LEGACY_IOS_PHONE_APP_PREFIX}/`)
}

function toCanonicalIosMobilePathname(pathname: string) {
  if (pathname === LEGACY_IOS_PHONE_APP_PREFIX || pathname === LEGACY_IOS_PHONE_CHAT_PATH || pathname === `${LEGACY_IOS_PHONE_APP_PREFIX}/app`) {
    return IOS_MOBILE_HOME_PATH
  }

  if (pathname.startsWith(`${LEGACY_IOS_PHONE_CHAT_PATH}/`)) {
    return `${IOS_MOBILE_HOME_PATH}${pathname.slice(LEGACY_IOS_PHONE_CHAT_PATH.length)}`
  }

  if (pathname.startsWith(`${LEGACY_IOS_PHONE_APP_PREFIX}/`)) {
    return `${IOS_MOBILE_APP_PREFIX}${pathname.slice(LEGACY_IOS_PHONE_APP_PREFIX.length)}`
  }

  return pathname
}

function parseInternalPath(value: string) {
  try {
    const parsed = new URL(value, window.location.origin)
    return {
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash
    }
  } catch {
    const [pathWithSearch, hash = ''] = value.split('#')
    const [pathname = '/', search = ''] = pathWithSearch.split('?')
    return {
      pathname: pathname || '/',
      search: search ? `?${search}` : '',
      hash: hash ? `#${hash}` : ''
    }
  }
}

function isIosMobileAppAllowedPath(pathname: string) {
  return IOS_MOBILE_APP_ALLOWED_PATHS.has(pathname) ||
    IOS_MOBILE_APP_ALLOWED_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function getIosMobileRedirectPath(value = typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}${window.location.hash}` : '') {
  if (!isIosMobileShell()) return ''
  const { pathname, search, hash } = parseInternalPath(value)
  const normalizedPathname = toCanonicalIosMobilePathname(pathname)
  if (normalizedPathname !== pathname) {
    return `${normalizedPathname}${search}${hash}`
  }
  if (!hasRuntimeApiBaseUrl()) {
    return normalizedPathname === IOS_MOBILE_TENANT_PATH ? '' : IOS_MOBILE_TENANT_PATH
  }
  if (isPublicPaymentPath(normalizedPathname)) return ''
  if (isIosMobileAppAllowedPath(normalizedPathname)) return ''
  if (normalizedPathname === '/login') return IOS_MOBILE_LOGIN_PATH
  return IOS_MOBILE_HOME_PATH
}

function replaceInternalPath(value: string) {
  if (typeof window === 'undefined') return

  window.history.replaceState({}, '', value)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function ensureIosMobileRoute() {
  if (typeof window === 'undefined') return

  const redirectPath = getIosMobileRedirectPath(`${window.location.pathname}${window.location.search}${window.location.hash}`)
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
    nextPath = value.startsWith('/') ? value : IOS_MOBILE_HOME_PATH
  }

  nextPath = getIosMobileRedirectPath(nextPath) || nextPath
  window.history.pushState({}, '', nextPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function getNotificationPath(notification: ActionPerformed['notification'] | { data?: Record<string, unknown> }) {
  const data = notification?.data || {}
  const directUrl = typeof data.url === 'string' ? data.url : ''
  const route = typeof data.route === 'string' ? data.route : ''
  return directUrl || route || IOS_MOBILE_HOME_PATH
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

// MOB-005: APNs/FCM registration can take a while on slow networks or cold
// starts. 16s was too aggressive and produced false "denied" results even when
// the OS delivered the token shortly after. Give registration a realistic
// window before bailing so we don't mark a failure prematurely.
const NATIVE_PUSH_REGISTRATION_TIMEOUT_MS = 60000

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

    // MOB-005: only treat the timeout as a genuine failure; do not race the
    // real registration/registrationError events (finish() is idempotent).
    const timeout = window.setTimeout(() => {
      finish({
        status: 'denied',
        reason: 'This phone did not return the alert key. Close and reopen Ristak, then try again.'
      })
    }, NATIVE_PUSH_REGISTRATION_TIMEOUT_MS)

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

  isIosMobileShell,

  getIosMobileRedirectPath,

  async configureShell() {
    if (shellConfigured || !Capacitor.isNativePlatform()) return
    shellConfigured = true

    ensureIosMobileRoute()
    await SplashScreen.hide().catch(() => undefined)
    await applyShellTheme('light')
    await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined)

    if (getPlatform() === 'ios') {
      await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined)
      await Keyboard.setResizeMode({ mode: KeyboardResize.Native }).catch(() => undefined)
    }

    await App.addListener('appUrlOpen', (event) => {
      openInternalPath(event.url)
    }).catch(() => undefined)

    await App.addListener('backButton', ({ canGoBack }) => {
      if (isIosMobileAppPath(window.location.pathname) && canGoBack) {
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

    return readMediaAsDataUrl(result, source)
  }
}
