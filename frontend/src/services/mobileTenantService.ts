import {
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
