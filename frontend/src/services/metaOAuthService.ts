import { refreshIntegrationsStatusAfter } from './integrationsService'

export type MetaOAuthConnectionMode = 'manual_system_user' | 'oauth_bisu' | 'oauth_user' | null

export interface MetaOAuthStatus {
  available: boolean
  mode: 'redirect' | 'js_sdk'
  connectUrl: string
  appId: string
  configId: string
  reviewPending?: boolean
  connectionMode: MetaOAuthConnectionMode
  manualConfigured: boolean
  legacyCombinedConnected?: boolean
  manualBackupAvailable?: boolean
  selected?: {
    businessId?: string
    adAccountId?: string
    pixelId?: string
    pageId?: string
    instagramAccountId?: string
  }
  oauth: {
    connected: boolean
    validated: boolean
    userId: string
    userName: string
    appId: string
    businessId: string
    grantedScopes: string[]
    missingScopes: string[]
    granularScopes: unknown[]
    tokenExpiresAt: string | null
    dataAccessExpiresAt: string | null
    reauthorizationRequired?: boolean
    reauthorizationRecommended?: boolean
    relayStatus: 'inactive' | 'pending' | 'registered' | 'repair_pending' | 'error'
  }
  error: string | null
}

export interface MetaOAuthPixel {
  id: string
  name: string
}

export interface MetaOAuthInstagramAccount {
  id: string
  username: string
  name: string
}

export interface MetaOAuthAdAccount {
  id: string
  name: string
  businessId: string
  accountId?: string
  currency?: string
  timezoneName?: string
  accountStatus?: number
  pixels: MetaOAuthPixel[]
}

export interface MetaOAuthPage {
  id: string
  name: string
  businessId: string
  category?: string | null
  pictureUrl?: string | null
  instagramAccounts: MetaOAuthInstagramAccount[]
}

export interface MetaOAuthSession {
  sessionId: string
  expiresAt: string
  connectionMode: 'oauth_bisu' | 'oauth_user'
  user: { id: string; name: string }
  permissions: {
    granted: string[]
    missing: string[]
    granular: unknown[]
  }
  businesses: Array<{ id: string; name: string }>
  adAccounts: MetaOAuthAdAccount[]
  pages: MetaOAuthPage[]
  defaults: {
    businessId: string
    adAccountId: string
    pixelId: string
    pageId: string
    instagramAccountId: string
  }
}

export interface MetaOAuthFinalizeSelection {
  sessionId: string
  businessId?: string
  adAccountId?: string
  pixelId?: string
  pageId?: string
  instagramAccountId?: string
}

export interface MetaOAuthFinalizeResult {
  connectionMode: 'oauth_bisu' | 'oauth_user'
  connected: boolean
  validated: boolean
  selected: {
    businessId?: string
    adAccountId?: string
    pixelId?: string
    pageId?: string
    instagramAccountId?: string
  }
  permissions: {
    granted: string[]
    missing: string[]
    granular: unknown[]
  }
  relay: { status: string; subscribed?: boolean; error?: string }
  subscription?: unknown
  socialHistoryBackfill?: unknown
  adsSync?: { syncStarted?: boolean }
  conversionEvents?: { enabled?: boolean; reason?: string }
}

export type MetaOAuthPreviousIntegrationKind = 'social' | 'ads'

async function requestMetaOAuth<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {})
    }
  })
  const payload = await response.json().catch(() => ({})) as {
    success?: boolean
    data?: T
    error?: string
    message?: string
  }

  if (!response.ok || payload.success === false || !payload.data) {
    throw new Error(payload.error || payload.message || 'No se pudo completar la conexión con Meta.')
  }

  return payload.data
}

export const metaOAuthService = {
  getStatus: () => requestMetaOAuth<MetaOAuthStatus>('/api/meta/oauth/status'),

  createConnectUrl: () => requestMetaOAuth<{ connectUrl: string; redirectUri?: string; expiresAt?: string }>(
    '/api/meta/oauth/connect-url',
    {
      method: 'POST',
      body: JSON.stringify({
        returnPath: '/settings/meta-ads/cuenta'
      })
    }
  ),

  complete: (input: { handoffToken?: string; code?: string; configId?: string }) => (
    requestMetaOAuth<MetaOAuthSession>('/api/meta/oauth/complete', {
      method: 'POST',
      body: JSON.stringify({
        handoffToken: input.handoffToken || undefined,
        code: input.code || undefined,
        configId: input.configId || undefined
      })
    })
  ),

  reconfigure: () => (
    requestMetaOAuth<MetaOAuthSession>('/api/meta/oauth/reconfigure', {
      method: 'POST',
      body: JSON.stringify({})
    })
  ),

  finalize: (selection: MetaOAuthFinalizeSelection) => (
    refreshIntegrationsStatusAfter(requestMetaOAuth<MetaOAuthFinalizeResult>('/api/meta/oauth/finalize', {
      method: 'POST',
      body: JSON.stringify(selection)
    }))
  ),

  disconnect: () => (
    refreshIntegrationsStatusAfter(requestMetaOAuth<{
      disconnected: boolean
      restoredManual?: boolean
      restoredSplitSocial?: boolean
      runtimeWarning?: string | null
      runtimeWarnings?: string[]
    }>('/api/meta/oauth/disconnect', {
      method: 'POST',
      body: JSON.stringify({})
    }))
  ),

  disconnectPreviousIntegration: (integrationKind: MetaOAuthPreviousIntegrationKind) => (
    refreshIntegrationsStatusAfter(requestMetaOAuth<{
      disconnected: boolean
      restoredLegacy?: boolean
      runtimeWarning?: string | null
      runtimeWarnings?: string[]
    }>(`/api/meta/oauth/${integrationKind}/disconnect`, {
      method: 'POST',
      body: JSON.stringify({})
    }))
  )
}
