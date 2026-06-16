import { Capacitor } from '@capacitor/core'

export const RUNTIME_API_BASE_URL_KEY = 'ristak.mobile.apiBaseUrl.v1'
export const RUNTIME_TENANT_KEY = 'ristak.mobile.tenant.v1'
export const RUNTIME_API_BASE_URL_CHANGED_EVENT = 'ristak:runtime-api-base-url-changed'
const DEFAULT_INSTALLER_API_BASE_URL = 'https://www.ristak.com'

export type RuntimeTenant = {
  clientId: string
  installationId: string
  name: string
  email: string
  appUrl: string
}

function cleanBaseUrl(value?: string | null) {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  if (!raw) return ''

  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
    return parsed.origin
  } catch {
    return ''
  }
}

function readStorageValue(key: string) {
  if (typeof window === 'undefined') return ''

  try {
    return window.localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function writeStorageValue(key: string, value: string) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function removeStorageValue(key: string) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(key)
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function removeSessionStorageValue(key: string) {
  if (typeof window === 'undefined') return

  try {
    window.sessionStorage.removeItem(key)
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function removeLocalStoragePrefixes(prefixes: string[]) {
  if (typeof window === 'undefined') return

  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index)
      if (key && prefixes.some(prefix => key.startsWith(prefix))) {
        window.localStorage.removeItem(key)
      }
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function clearTenantScopedStorage() {
  removeStorageValue('auth_token')
  removeSessionStorageValue('ristak_latest_api_token')
  removeLocalStoragePrefixes([
    'rstk_config_',
    'ristak_phone_'
  ])
}

function getBuildApiBaseUrl() {
  return cleanBaseUrl(import.meta.env.VITE_API_URL)
}

export function isNativeAppRuntime() {
  return Capacitor.isNativePlatform()
}

export function getRuntimeApiBaseUrl() {
  return cleanBaseUrl(readStorageValue(RUNTIME_API_BASE_URL_KEY))
}

export function hasRuntimeApiBaseUrl() {
  return Boolean(getRuntimeApiBaseUrl())
}

export function requiresRuntimeApiBaseUrl() {
  return isNativeAppRuntime() && !hasRuntimeApiBaseUrl()
}

export function getApiBaseUrl() {
  const runtimeBaseUrl = getRuntimeApiBaseUrl()
  if (runtimeBaseUrl) return runtimeBaseUrl
  if (isNativeAppRuntime()) return ''
  return getBuildApiBaseUrl()
}

export function apiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${getApiBaseUrl()}${normalizedPath}`
}

export function getInstallerApiBaseUrl() {
  return cleanBaseUrl(import.meta.env.VITE_INSTALLER_API_URL || DEFAULT_INSTALLER_API_BASE_URL)
}

export function installerApiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const installerBaseUrl = getInstallerApiBaseUrl()
  return `${installerBaseUrl}${normalizedPath}`
}

export function setRuntimeApiBaseUrl(value: string, tenant?: RuntimeTenant | null) {
  const baseUrl = cleanBaseUrl(value)
  if (!baseUrl) {
    throw new Error('La URL de la app no es válida.')
  }

  const previousBaseUrl = getRuntimeApiBaseUrl()
  writeStorageValue(RUNTIME_API_BASE_URL_KEY, baseUrl)

  if (tenant) {
    writeStorageValue(RUNTIME_TENANT_KEY, JSON.stringify({ ...tenant, appUrl: baseUrl }))
  }

  if (previousBaseUrl !== baseUrl) {
    clearTenantScopedStorage()
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RUNTIME_API_BASE_URL_CHANGED_EVENT, { detail: { baseUrl } }))
  }
  return baseUrl
}

export function getRuntimeTenant(): RuntimeTenant | null {
  const raw = readStorageValue(RUNTIME_TENANT_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeTenant>
    const appUrl = cleanBaseUrl(parsed.appUrl)
    if (!appUrl) return null

    return {
      clientId: String(parsed.clientId || ''),
      installationId: String(parsed.installationId || ''),
      name: String(parsed.name || ''),
      email: String(parsed.email || ''),
      appUrl
    }
  } catch {
    return null
  }
}

export function clearRuntimeApiBaseUrl() {
  clearTenantScopedStorage()
  removeStorageValue(RUNTIME_API_BASE_URL_KEY)
  removeStorageValue(RUNTIME_TENANT_KEY)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RUNTIME_API_BASE_URL_CHANGED_EVENT, { detail: { baseUrl: '' } }))
  }
}
