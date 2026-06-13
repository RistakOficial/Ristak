export type RedirectLocation = {
  pathname?: string
  search?: string
  hash?: string
}

export const PHONE_APP_HOME_PATH = '/phone/chat'
export const PHONE_APP_LOGIN_PATH = '/phone/login'
export const DESKTOP_LOGIN_PATH = '/login'
export const SETUP_PATH = '/setup'
export const TABLET_VIEW_PREFERENCE_KEY = 'ristak.tabletViewPreference.v1'
export const TABLET_VIEW_PREFERENCE_EVENT = 'ristak:tablet-view-preference'

export type PortableDeviceMode = 'phone' | 'tablet' | 'desktop'
export type TabletViewPreference = 'web' | 'tablet'

const PHONE_USER_AGENT_PATTERN = /Android.+Mobile|iPhone|iPod|IEMobile|Opera Mini|Windows Phone|Mobile/i
const TABLET_USER_AGENT_PATTERN = /iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i
const COARSE_POINTER_QUERY = '(pointer: coarse)'
const PHONE_SHORT_SIDE_LIMIT = 768
const IPAD_DESKTOP_SHORT_SIDE_LIMIT = 700
const TABLET_SHORT_SIDE_LIMIT = 1366
const LOCAL_PHONE_PREVIEW_HOSTNAMES = new Set(['localhost', '0.0.0.0', '::1', '[::1]'])

export function isPhoneAppPath(pathname = '') {
  return pathname === '/phone' || pathname.startsWith('/phone/')
}

export function getLoginPathForRoute(pathname = '') {
  return isPhoneAppPath(pathname) ? PHONE_APP_LOGIN_PATH : DESKTOP_LOGIN_PATH
}

export function getPostAuthRedirectPath(from?: RedirectLocation, fallbackPath = '/dashboard') {
  const pathname = from?.pathname

  if (!pathname?.startsWith('/') || pathname === DESKTOP_LOGIN_PATH || pathname === SETUP_PATH) {
    return fallbackPath
  }

  if (pathname === PHONE_APP_LOGIN_PATH) {
    return PHONE_APP_HOME_PATH
  }

  return `${pathname}${from?.search || ''}${from?.hash || ''}`
}

function getScreenShortSide() {
  if (typeof window === 'undefined' || !window.screen) return 0

  const width = Number(window.screen.width) || 0
  const height = Number(window.screen.height) || 0

  if (!width || !height) return 0

  return Math.min(width, height)
}

function getViewportShortSide() {
  if (typeof window === 'undefined') return 0

  const viewportWidth = window.visualViewport?.width || window.innerWidth || 0
  const viewportHeight = window.visualViewport?.height || window.innerHeight || 0

  if (!viewportWidth || !viewportHeight) return 0

  return Math.min(viewportWidth, viewportHeight)
}

function getViewportLongSide() {
  if (typeof window === 'undefined') return 0

  const viewportWidth = window.visualViewport?.width || window.innerWidth || 0
  const viewportHeight = window.visualViewport?.height || window.innerHeight || 0

  if (!viewportWidth || !viewportHeight) return 0

  return Math.max(viewportWidth, viewportHeight)
}

function isPrivateIPv4Address(hostname: string) {
  const parts = hostname.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false

  const [first, second] = parts
  if (first === 10) return true
  if (first === 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true

  return false
}

export function isLocalPhonePreviewHost(hostname = typeof window !== 'undefined' ? window.location.hostname : '') {
  const normalizedHostname = hostname.trim().toLowerCase()
  if (!normalizedHostname) return false
  if (LOCAL_PHONE_PREVIEW_HOSTNAMES.has(normalizedHostname)) return true
  if (normalizedHostname.endsWith('.localhost') || normalizedHostname.endsWith('.local')) return true
  if (!normalizedHostname.includes('.') && !normalizedHostname.includes(':')) return true
  if (isPrivateIPv4Address(normalizedHostname)) return true

  return false
}

export function getLocalPhonePreviewDeviceMode(): PortableDeviceMode | null {
  if (!isLocalPhonePreviewHost()) return null

  const shortSide = getViewportShortSide()
  const longSide = getViewportLongSide()
  if (shortSide > 0 && shortSide < PHONE_SHORT_SIDE_LIMIT) return 'phone'
  if (longSide > 0 && longSide <= TABLET_SHORT_SIDE_LIMIT) return 'tablet'

  return 'tablet'
}

export function isCellphoneDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false

  const userAgent = navigator.userAgent || ''
  const maxTouchPoints = navigator.maxTouchPoints || 0
  const screenShortSide = getScreenShortSide()
  const iPadDesktopMode = /Macintosh/i.test(userAgent)
    && maxTouchPoints > 1
    && screenShortSide >= IPAD_DESKTOP_SHORT_SIDE_LIMIT
  const tabletUserAgent = TABLET_USER_AGENT_PATTERN.test(userAgent) || iPadDesktopMode

  if (tabletUserAgent) return false

  const mobileUserAgent = PHONE_USER_AGENT_PATTERN.test(userAgent)
  const coarsePointer = window.matchMedia?.(COARSE_POINTER_QUERY).matches ?? false
  const hasTouch = maxTouchPoints > 0 || coarsePointer
  const viewportShortSide = getViewportShortSide()
  const phoneSizedScreen = screenShortSide > 0
    ? screenShortSide < PHONE_SHORT_SIDE_LIMIT
    : viewportShortSide > 0 && viewportShortSide < PHONE_SHORT_SIDE_LIMIT

  return phoneSizedScreen && (mobileUserAgent || hasTouch)
}

export function isTabletDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if (isCellphoneDevice()) return false

  const userAgent = navigator.userAgent || ''
  const maxTouchPoints = navigator.maxTouchPoints || 0
  const screenShortSide = getScreenShortSide()
  const viewportShortSide = getViewportShortSide()
  const coarsePointer = window.matchMedia?.(COARSE_POINTER_QUERY).matches ?? false
  const iPadDesktopMode = /Macintosh/i.test(userAgent)
    && maxTouchPoints > 1
    && screenShortSide >= IPAD_DESKTOP_SHORT_SIDE_LIMIT
  const tabletUserAgent = TABLET_USER_AGENT_PATTERN.test(userAgent) || iPadDesktopMode
  const tabletSizedScreen = screenShortSide >= IPAD_DESKTOP_SHORT_SIDE_LIMIT
    && screenShortSide <= TABLET_SHORT_SIDE_LIMIT
    && viewportShortSide >= IPAD_DESKTOP_SHORT_SIDE_LIMIT

  return tabletUserAgent || (tabletSizedScreen && maxTouchPoints > 0 && coarsePointer)
}

export function getPortableDeviceMode(): PortableDeviceMode {
  if (isCellphoneDevice()) return 'phone'
  if (isTabletDevice()) return 'tablet'
  return 'desktop'
}

function isTabletViewPreference(value: string | null): value is TabletViewPreference {
  return value === 'web' || value === 'tablet'
}

export function readTabletViewPreference(): TabletViewPreference | null {
  if (typeof window === 'undefined') return null

  try {
    const preference = window.localStorage.getItem(TABLET_VIEW_PREFERENCE_KEY)
    return isTabletViewPreference(preference) ? preference : null
  } catch {
    return null
  }
}

export function writeTabletViewPreference(preference: TabletViewPreference) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(TABLET_VIEW_PREFERENCE_KEY, preference)
  } catch {
    // Storage can be blocked in private or embedded contexts.
  }

  window.dispatchEvent(new CustomEvent(TABLET_VIEW_PREFERENCE_EVENT, { detail: preference }))
}
