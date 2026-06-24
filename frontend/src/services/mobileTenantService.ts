import {
  apiUrl,
  installerApiUrl,
  setRuntimeApiBaseUrl,
  type RuntimeTenant
} from './apiBaseUrl'

type InstallerTenantResponse = {
  success?: boolean
  tenant?: {
    client_id?: string
    installation_id?: string
    name?: string
    email?: string
    app_url?: string
  }
  message?: string
}

type MobileLoginResponse = {
  success?: boolean
  app_url?: string
  sso_token?: string
  name?: string
  message?: string
}

type SsoExchangeResponse = {
  success?: boolean
  token?: string
  apiToken?: string
  code?: string
  message?: string
}

export async function resolveAndStoreMobileTenant(identifier: string): Promise<RuntimeTenant> {
  const cleanIdentifier = identifier.trim()
  if (cleanIdentifier.length < 3) {
    throw new Error('Escribe tu correo o el nombre de tu empresa.')
  }

  const response = await fetch(installerApiUrl('/api/mobile/resolve'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: cleanIdentifier })
  })
  const data = await response.json().catch(() => ({})) as InstallerTenantResponse

  if (!response.ok || !data.success || !data.tenant?.app_url) {
    throw new Error(data.message || 'No encontré una app activa para esos datos.')
  }

  const tenant: RuntimeTenant = {
    clientId: data.tenant.client_id || '',
    installationId: data.tenant.installation_id || '',
    name: data.tenant.name || '',
    email: data.tenant.email || '',
    appUrl: data.tenant.app_url
  }

  const appUrl = setRuntimeApiBaseUrl(tenant.appUrl, tenant)
  return { ...tenant, appUrl }
}

/**
 * Login único de la app móvil (mismo flujo que www.ristak.com/login):
 * 1. Verifica correo+contraseña del dueño contra el portal central.
 * 2. El portal devuelve la URL del backend de Render del cliente + un token
 *    de un solo uso. Apuntamos la app a ese backend.
 * 3. Canjeamos el token en {backend}/api/auth/sso por una sesión local.
 * Al terminar, el `auth_token` queda guardado y la app entra sin segunda
 * pantalla. Lanza un Error (con `code` cuando aplica) si algo falla.
 */
export async function loginWithPortal(email: string, password: string): Promise<void> {
  const cleanEmail = email.trim()
  if (!cleanEmail || !password) {
    throw new Error('Escribe tu correo y contraseña.')
  }

  const response = await fetch(installerApiUrl('/api/mobile/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cleanEmail, password })
  })
  const data = await response.json().catch(() => ({})) as MobileLoginResponse

  if (!response.ok || !data.success || !data.app_url || !data.sso_token) {
    throw new Error(data.message || 'Correo o contraseña incorrectos.')
  }

  // Apuntar la app al backend del cliente (limpia sesión previa si cambió).
  const tenant: RuntimeTenant = {
    clientId: '',
    installationId: '',
    name: data.name || '',
    email: cleanEmail,
    appUrl: data.app_url
  }
  setRuntimeApiBaseUrl(data.app_url, tenant)

  // Canjear el token de un solo uso por una sesión en el backend del cliente.
  const ssoResponse = await fetch(apiUrl('/api/auth/sso'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: data.sso_token })
  })
  const ssoData = await ssoResponse.json().catch(() => ({})) as SsoExchangeResponse

  if (ssoResponse.ok && ssoData.success && ssoData.token) {
    localStorage.setItem('auth_token', ssoData.token)
    if (ssoData.apiToken) {
      sessionStorage.setItem('ristak_latest_api_token', ssoData.apiToken)
    }
    return
  }

  if (ssoData.code === 'license_blocked') {
    const err = new Error(ssoData.message || 'Tu licencia de Ristak no está activa.') as Error & { code?: string }
    err.code = 'license_blocked'
    throw err
  }

  if (ssoData.code === 'needs_setup') {
    const err = new Error('Tu app todavía no tiene usuarios configurados.') as Error & { code?: string }
    err.code = 'needs_setup'
    throw err
  }

  throw new Error(ssoData.message || 'No se pudo entrar a tu app.')
}
