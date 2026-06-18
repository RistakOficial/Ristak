import apiClient from './apiClient'
import { getApiBaseUrl } from './apiBaseUrl'

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

export interface MediaDownloadEntry {
  id: string
  path?: string
}

export interface MediaUploadProgress {
  loaded: number
  total: number
  percent: number
}

export interface UploadMediaFileInput {
  file: File
  module?: string
  moduleEntityId?: string
  isPublic?: boolean
  onProgress?: (progress: MediaUploadProgress) => void
}

export interface MediaMoveEntry {
  id: string
  targetFolderPath?: string
}

export interface StreamChartPoint {
  label: string
  value: number
  periodStart?: string
  periodEnd?: string
  periodKey?: string
}

export interface StreamHeatmapPoint {
  segment: number
  intensity: number
  label: string
}

export interface StreamCountryMetric {
  country: string
  views: number
  watchTime: number
}

export interface FirstPartyVideoRetentionSegment {
  segment: number
  startPercent: number
  endPercent: number
  startSeconds: number
  endSeconds: number
  label: string
  retainedSessions: number
  skippedSessions: number
  replayedSessions: number
  retentionPercent: number
  replayRatePercent: number
  intensity: number
}

export interface FirstPartyVideoBreakdownItem {
  key: string
  label: string
  playbackSessions: number
  plays: number
  watchedSeconds: number
  maxProgressTotal?: number
  avgProgressPercent: number
}

export interface FirstPartyVideoViewer {
  key: string
  contactId?: string | null
  visitorId?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  matchMethod?: string
  playbackCount: number
  playCount: number
  watchedSeconds: number
  maxProgressPercent: number
  maxPositionSeconds: number
  durationSeconds: number
  completed: boolean
  firstEventAt?: string | null
  lastEventAt?: string | null
  pageUrl?: string | null
  publicPageTitle?: string | null
  blockLabel?: string | null
}

export interface FirstPartyVideoTracking {
  summary: {
    playbackSessions: number
    playedSessions: number
    identifiedContacts: number
    anonymousVisitors: number
    totalViewers: number
    plays: number
    watchedSeconds: number
    avgProgressPercent: number
    averageWatchSeconds: number
    playRatePercent: number
    completions: number
    completionRatePercent: number
    dropOffPercent: number
  }
  retentionSegments: FirstPartyVideoRetentionSegment[]
  pages: FirstPartyVideoBreakdownItem[]
  blocks: FirstPartyVideoBreakdownItem[]
  viewers: FirstPartyVideoViewer[]
  limit: number
  offset: number
}

export interface MediaStreamAnalytics {
  assetId: string
  configured: boolean
  status: 'ready' | 'disabled' | 'not_configured' | 'not_synced' | string
  dateFrom?: string
  dateTo?: string
  hourly?: boolean
  stream?: Record<string, unknown> | null
  video?: Record<string, unknown> | null
  summary: {
    views: number
    watchTime: number
    averageWatchTime: number
    engagementScore: number | null
    topCountry?: string
  }
  viewsChart: StreamChartPoint[]
  watchTimeChart: StreamChartPoint[]
  countries: StreamCountryMetric[]
  heatmap: StreamHeatmapPoint[]
  firstPartyTracking?: FirstPartyVideoTracking | null
  raw?: Record<string, unknown> | null
}

export interface MediaStreamAnalyticsInput {
  dateFrom?: string
  dateTo?: string
  hourly?: boolean
  viewerLimit?: number
}

function getAuthHeaders() {
  try {
    const token = localStorage.getItem('auth_token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

function buildApiUrl(endpoint: string) {
  const apiEndpoint = endpoint.startsWith('/api') ? endpoint : `/api${endpoint.startsWith('/') ? '' : '/'}${endpoint}`
  return `${getApiBaseUrl()}${apiEndpoint}`
}

function filenameFromContentDisposition(value: string | null) {
  if (!value) return ''

  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1].trim())
    } catch {
      return encodedMatch[1].trim()
    }
  }

  const quotedMatch = value.match(/filename="([^"]+)"/i)
  if (quotedMatch?.[1]) return quotedMatch[1].trim()

  const plainMatch = value.match(/filename=([^;]+)/i)
  return plainMatch?.[1]?.trim() || ''
}

function saveBlob(blob: Blob, filename: string) {
  const objectUrl = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = filename || 'media'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000)
}

async function readDownloadError(response: Response) {
  try {
    const contentType = response.headers.get('Content-Type') || ''
    if (contentType.includes('application/json')) {
      const payload = await response.json()
      if (payload && typeof payload === 'object' && 'error' in payload) {
        return String((payload as { error?: unknown }).error)
      }
    }
    const text = await response.text()
    if (text) return text
  } catch {
    // Keep the generic message below.
  }
  return `API Error: ${response.status} ${response.statusText}`
}

async function downloadFromApi(endpoint: string, options: RequestInit, fallbackFilename: string) {
  const headers = new Headers(options.headers)
  Object.entries(getAuthHeaders()).forEach(([key, value]) => {
    headers.set(key, value)
  })

  const response = await fetch(buildApiUrl(endpoint), {
    ...options,
    headers
  })

  if (!response.ok) {
    throw new Error(await readDownloadError(response))
  }

  const blob = await response.blob()
  const filename = filenameFromContentDisposition(response.headers.get('Content-Disposition')) || fallbackFilename
  saveBlob(blob, filename)
}

function extractApiPayload<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in payload && 'success' in payload && (payload as { data?: unknown }).data !== undefined) {
    return (payload as { data: unknown }).data as T
  }

  return payload as T
}

function extractApiErrorMessage(payload: unknown, status: number, statusText: string) {
  if (payload && typeof payload === 'object') {
    const body = payload as { error?: unknown; message?: unknown }
    if (body.error) return String(body.error)
    if (body.message) return String(body.message)
  }

  return `API Error: ${status} ${statusText}`
}

function postFormWithProgress<T>(
  endpoint: string,
  body: FormData,
  onProgress?: (progress: MediaUploadProgress) => void
): Promise<T> {
  if (!onProgress || typeof XMLHttpRequest === 'undefined') {
    return apiClient.postForm<T>(endpoint, body)
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', buildApiUrl(endpoint))

    Object.entries(getAuthHeaders()).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value)
    })

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return
      onProgress({
        loaded: event.loaded,
        total: event.total,
        percent: Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)))
      })
    }

    xhr.onload = () => {
      let payload: unknown = null
      if (xhr.responseText) {
        try {
          payload = JSON.parse(xhr.responseText)
        } catch {
          payload = xhr.responseText
        }
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(extractApiPayload<T>(payload))
        return
      }

      reject(new Error(extractApiErrorMessage(payload, xhr.status, xhr.statusText)))
    }

    xhr.onerror = () => reject(new Error('No se pudo conectar con el servidor.'))
    xhr.onabort = () => reject(new Error('La subida se canceló.'))
    xhr.send(body)
  })
}

export const mediaService = {
  uploadFile(input: UploadMediaFileInput): Promise<MediaAsset> {
    const formData = new FormData()
    formData.append('file', input.file)
    formData.append('module', input.module || 'other')
    formData.append('isPublic', String(input.isPublic ?? true))
    if (input.moduleEntityId) formData.append('moduleEntityId', input.moduleEntityId)
    return postFormWithProgress<MediaAsset>('/media/upload', formData, input.onProgress)
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

  downloadAsset(assetId: string, filename = 'archivo') {
    return downloadFromApi(
      `/media/assets/${encodeURIComponent(assetId)}/download`,
      { method: 'GET' },
      filename
    )
  },

  downloadAssetsArchive(entries: MediaDownloadEntry[], filename = 'media.zip') {
    return downloadFromApi(
      '/media/assets/download',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries, filename })
      },
      filename
    )
  },

  moveAssets(entries: MediaMoveEntry[], targetFolderPath = '') {
    return apiClient.post<MediaAsset[]>('/media/assets/move', {
      entries,
      targetFolderPath
    })
  },

  syncAssetStream(assetId: string, input: {
    module?: string
    moduleEntityId?: string
  } = {}) {
    return apiClient.post<MediaAsset>(`/media/assets/${encodeURIComponent(assetId)}/stream/sync`, input)
  },

  getAssetStreamAnalytics(assetId: string, input: MediaStreamAnalyticsInput = {}) {
    const params: Record<string, string> = {}
    if (input.dateFrom) params.dateFrom = input.dateFrom
    if (input.dateTo) params.dateTo = input.dateTo
    if (input.hourly !== undefined) params.hourly = String(input.hourly)
    if (input.viewerLimit) params.viewerLimit = String(input.viewerLimit)
    return apiClient.get<MediaStreamAnalytics>(`/media/assets/${encodeURIComponent(assetId)}/stream/analytics`, { params })
  },

  getStorageUsage() {
    return apiClient.get<StorageUsage>('/media/storage/usage')
  }
}

export default mediaService
