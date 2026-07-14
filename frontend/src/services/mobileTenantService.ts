import {
  apiUrl,
  installerApiUrl,
  setRuntimeApiBaseUrl,
  type RuntimeTenant
} from './apiBaseUrl'
import { syncAuthScopedCachePrincipal } from './authPrincipalCache'

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

type BackendLoginResponse = {
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
 * Login único de la app móvil. Una sola pantalla de correo + contraseña que
 * sirve para cualquier usuario:
 * 1. El portal resuelve a qué backend pertenece el correo (dueño vía clients,
 *    o empleado vía el directorio de usuarios) y apuntamos la app ahí.
 * 2. Validamos correo+contraseña directo contra ese backend, que ya maneja a
 *    cada usuario con sus permisos (dueño o empleado).
 * Al terminar, el `auth_token` queda guardado y la app entra. Lanza un Error
 * (con `code` cuando aplica) si algo falla.
 */
export async function loginWithPortal(email: string, password: string): Promise<void> {
  const cleanEmail = email.trim()
  if (!cleanEmail || !password) {
    throw new Error('Escribe tu correo y contraseña.')
  }

  // 1. Resolver el backend del cliente a partir del correo y apuntar la app.
  await resolveAndStoreMobileTenant(cleanEmail)

  // 2. Autenticar contra ese backend (dueño o empleado, con sus permisos).
  const response = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cleanEmail, password })
  })
  const data = await response.json().catch(() => ({})) as BackendLoginResponse

  if (response.ok && data.token) {
    localStorage.setItem('auth_token', data.token)
    syncAuthScopedCachePrincipal(data.token)
    if (data.apiToken) {
      sessionStorage.setItem('ristak_latest_api_token', data.apiToken)
    }
    return
  }

  if (data.code === 'license_blocked') {
    const err = new Error(data.message || 'Tu licencia de Ristak no está activa.') as Error & { code?: string }
    err.code = 'license_blocked'
    throw err
  }

  throw new Error(data.message || 'Correo o contraseña incorrectos.')
}
