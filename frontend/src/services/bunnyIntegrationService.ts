import apiClient from './apiClient'
import { refreshIntegrationsStatusAfter } from './integrationsService'

export type BunnyMigrationStatus = 'pending' | 'running' | 'needs_attention' | 'completed'

export interface BunnyMigration {
  direction: 'to_customer' | 'to_managed'
  status: BunnyMigrationStatus
  phase?: 'storage' | 'stream' | 'completed'
  totalAssets: number
  migratedAssets: number
  failedAssets: number
  totalVideos: number
  migratedVideos: number
  failedVideos: number
  warnings?: Array<{ assetId?: string | null; code?: string; message: string }>
  lastError?: string | null
  startedAt?: string | null
  completedAt?: string | null
  updatedAt?: string | null
}

export interface BunnyAccountStatus {
  configured: boolean
  connected: boolean
  state: 'not_connected' | 'disconnecting' | BunnyMigrationStatus
  storageOwnedByCustomer: boolean
  sameAsManagedStorage?: boolean
  sameAsManagedStream?: boolean
  storageZone?: string | null
  storageRegion?: string | null
  cdnHostname?: string | null
  streamLibraryName?: string | null
  apiKeyPreview?: string | null
  connectedAt?: string | null
  updatedAt?: string | null
  migration: BunnyMigration | null
}

interface DisconnectResult {
  disconnected: boolean
  migrationRequired: boolean
  status: BunnyAccountStatus
}

const bunnyIntegrationService = {
  getStatus: () => apiClient.get<BunnyAccountStatus>('/integrations/bunny'),

  connect: (apiKey: string) => refreshIntegrationsStatusAfter(
    apiClient.post<BunnyAccountStatus>('/integrations/bunny/connect', { apiKey })
  ),

  retryMigration: () => apiClient.post<BunnyAccountStatus>('/integrations/bunny/migration/retry'),

  disconnect: () => refreshIntegrationsStatusAfter(
    apiClient.delete<DisconnectResult>('/integrations/bunny')
  )
}

export default bunnyIntegrationService
