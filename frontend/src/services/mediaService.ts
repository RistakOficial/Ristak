import apiClient from './apiClient'

export interface MediaAsset {
  id: string
  businessId?: string
  userId?: string | null
  originalFilename?: string
  storedFilename?: string
  bunnyPath?: string
  publicUrl: string
  privateUrl?: string
  mimeType: string
  mediaType: string
  extension?: string
  status: 'uploading' | 'processing' | 'ready' | 'failed' | 'deleted' | string
  sizeOriginal: number
  sizeProcessed: number
  quotaSize: number
  width?: number | null
  height?: number | null
  duration?: number | null
  storageProvider?: string
  storageZone?: string
  cdnBaseUrl?: string
  module?: string
  moduleEntityId?: string | null
  isPublic?: boolean
  metadata?: Record<string, unknown>
  createdAt?: string | null
  updatedAt?: string | null
  deletedAt?: string | null
}

export interface StorageUsage {
  business_id?: string
  business_name?: string
  storage_provider?: string
  storage_status?: string
  quota_gb?: number
  quota_bytes?: number
  included_quota_bytes?: number
  extra_quota_gb?: number
  used_bytes?: number
  available_bytes?: number
  usage_percent?: number
  files_count?: number
  by_media_type?: Record<string, number>
  by_module?: Record<string, number>
  storage_enabled?: boolean
  last_calculated_at?: string
}

export interface ListMediaAssetsInput {
  businessId?: string
  module?: string
  mediaType?: string
  status?: string
  limit?: number
  offset?: number
}

export const mediaService = {
  uploadFile(input: {
    file: File
    module?: string
    moduleEntityId?: string
    isPublic?: boolean
  }): Promise<MediaAsset> {
    const formData = new FormData()
    formData.append('file', input.file)
    formData.append('module', input.module || 'other')
    formData.append('isPublic', String(input.isPublic ?? true))
    if (input.moduleEntityId) formData.append('moduleEntityId', input.moduleEntityId)
    return apiClient.postForm<MediaAsset>('/media/upload', formData)
  },

  uploadDataUrl(input: {
    fileBase64: string
    filename: string
    module?: string
    moduleEntityId?: string
    isPublic?: boolean
  }): Promise<MediaAsset> {
    return apiClient.post<MediaAsset>('/media/upload', {
      fileBase64: input.fileBase64,
      filename: input.filename,
      module: input.module || 'other',
      moduleEntityId: input.moduleEntityId,
      isPublic: input.isPublic ?? true
    })
  },

  listAssets(input: ListMediaAssetsInput = {}) {
    const params: Record<string, string> = {}
    if (input.businessId) params.businessId = input.businessId
    if (input.module) params.module = input.module
    if (input.mediaType) params.mediaType = input.mediaType
    if (input.status) params.status = input.status
    if (input.limit) params.limit = String(input.limit)
    if (input.offset) params.offset = String(input.offset)

    return apiClient.get<MediaAsset[]>('/media/assets', { params })
  },

  async listAllAssets(input: Omit<ListMediaAssetsInput, 'limit' | 'offset'> = {}) {
    const pageSize = 250
    const assets: MediaAsset[] = []
    let offset = 0

    while (true) {
      const page = await this.listAssets({ ...input, limit: pageSize, offset })
      assets.push(...page)
      if (page.length < pageSize) break
      offset += pageSize
    }

    return assets
  },

  deleteAsset(assetId: string) {
    return apiClient.delete<{ id: string; deleted: boolean }>(`/media/assets/${encodeURIComponent(assetId)}`)
  },

  getStorageUsage() {
    return apiClient.get<StorageUsage>('/media/storage/usage')
  }
}

export default mediaService
