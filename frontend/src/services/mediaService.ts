import apiClient from './apiClient'
import { getApiBaseUrl } from './apiBaseUrl'
import * as tus from 'tus-js-client'

export interface MediaAsset {
  id: string
  businessId?: string
  userId?: string | null
  originalFilename?: string
  storedFilename?: string
  bunnyPath?: string
  folderPath?: string
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
  search?: string
  folderPath?: string | null
  recursive?: boolean
  limit?: number
  cursor?: string | null
  includeMeta?: boolean
  includeFolders?: boolean
}

export interface MediaPageInfo {
  limit: number
  hasMore: boolean
  nextCursor: string | null
}

export interface MediaFolderSummary {
  path: string
  name: string
  filesCount: number
  sizeBytes: number
}

export interface MediaLibrarySummary {
  totalItems: number
  totalBytes: number
}

export interface MediaLibraryFacet {
  mediaType: string
  itemsCount: number
  sizeBytes: number
}

export interface MediaAssetPage {
  items: MediaAsset[]
  pageInfo: MediaPageInfo
  summary: MediaLibrarySummary | null
  facets: MediaLibraryFacet[]
  folders: MediaFolderSummary[]
  folderPageInfo: MediaPageInfo
}

export interface ListMediaFoldersInput {
  businessId?: string
  parentPath?: string
  module?: string
  mediaType?: string
  status?: string
  limit?: number
  cursor?: string | null
}

export interface MediaFolderPage {
  items: MediaFolderSummary[]
  pageInfo: MediaPageInfo
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

export const MEDIA_UPLOAD_CANCELLED_MESSAGE = 'La subida se canceló.'
const MEDIA_UPLOAD_RETRY_DELAYS_MS = [1500, 4500]
const MEDIA_UPLOAD_RETRY_STATUS_CODES = new Set([502, 503, 504])

export function isMediaUploadCancelledError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const payload = error as { name?: unknown; message?: unknown }
  return (
    payload.name === 'AbortError' ||
    payload.message === MEDIA_UPLOAD_CANCELLED_MESSAGE
  )
}

export interface UploadMediaFileInput {
  file: File
  module?: string
  moduleEntityId?: string
  folderPath?: string
  isPublic?: boolean
  deferStreamSync?: boolean
  clientUploadId?: string
  onProgress?: (progress: MediaUploadProgress) => void
  signal?: AbortSignal
}

interface ResumableVideoUploadPreparation {
  completed: boolean
  asset: MediaAsset
  upload: null | {
    endpoint: string
    videoId: string
    libraryId: string
    expirationTime: number
    signature: string
    headers: Record<string, string>
    metadata: Record<string, string>
  }
}

export interface MediaMoveEntry {
  id: string
  targetFolderPath?: string
}

export interface MediaSelectionInput {
  assetIds?: string[]
  folderPaths?: string[]
  mediaType?: string
  status?: string
}

export interface MediaSelectionOperationResult {
  operation: string
  attempted: number
  affected: number
  failed: number
  foldersAffected?: number
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
  viewsChart: StreamChartPoint[]
  watchTimeChart: StreamChartPoint[]
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

function buildCompletedUploadProgress(lastProgress: MediaUploadProgress | null): MediaUploadProgress {
  const total = lastProgress?.total && lastProgress.total > 0
    ? lastProgress.total
    : lastProgress?.loaded || 0
  return {
    loaded: total,
    total,
    percent: 100
  }
}

function createMediaUploadClientId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `media_upload_${crypto.randomUUID()}`
  }
  return `media_upload_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

const RESUMABLE_VIDEO_MODULES = new Set(['sites', 'forms', 'landing'])
const RESUMABLE_VIDEO_EXTENSION_PATTERN = /\.(?:mp4|mov|webm|3gp)$/i
const RESUMABLE_VIDEO_CHUNK_BYTES = 10 * 1024 * 1024

function mediaUploadEndpoint(path: string, module = '') {
  const normalizedModule = String(module || '').trim().toLowerCase()
  if (!normalizedModule) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}module=${encodeURIComponent(normalizedModule)}`
}

function shouldUseResumableVideoUpload(input: UploadMediaFileInput) {
  const module = String(input.module || '').trim().toLowerCase()
  return RESUMABLE_VIDEO_MODULES.has(module) && (
    input.file.type.toLowerCase().startsWith('video/') ||
    RESUMABLE_VIDEO_EXTENSION_PATTERN.test(input.file.name)
  )
}

async function createResumableVideoUploadClientId(input: UploadMediaFileInput) {
  const fingerprint = [
    input.file.name,
    input.file.size,
    input.file.type,
    input.file.lastModified,
    String(input.module || '').toLowerCase(),
    String(input.folderPath ?? '')
  ].join('\0')

  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint))
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    return `tus_${hex}`
  }

  let hash = 2166136261
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `tus_fallback_${(hash >>> 0).toString(16)}_${input.file.size}`
}

function uploadErrorStatus(error: unknown) {
  return typeof error === 'object' && error ? Number((error as { status?: unknown }).status) : NaN
}

function uploadErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return ''
  const body = (error as { body?: unknown }).body
  if (!body || typeof body !== 'object') return ''
  return String((body as { code?: unknown }).code || '')
}

function shouldFallbackToMultipartUpload(error: unknown) {
  const status = uploadErrorStatus(error)
  const code = uploadErrorCode(error)
  return status === 404 || code === 'bunny_stream_resumable_unavailable'
}

async function finalizeResumableVideoUpload(
  assetId: string,
  module: string,
  uploadUrl: string,
  signal?: AbortSignal
) {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await apiClient.post<MediaAsset>(
        mediaUploadEndpoint(`/media/video-upload/${encodeURIComponent(assetId)}/finalize`, module),
        { module, uploadUrl },
        { signal }
      )
    } catch (error) {
      lastError = error
      const status = uploadErrorStatus(error)
      const code = uploadErrorCode(error)
      const retryable = !Number.isFinite(status) || status >= 500 || code === 'bunny_stream_upload_not_complete'
      if (!retryable || attempt === 3) throw error
      await sleep(1000 * (attempt + 1), signal)
    }
  }
  throw lastError
}

async function cancelResumableVideoUpload(assetId: string, module: string) {
  await apiClient.delete(
    mediaUploadEndpoint(`/media/video-upload/${encodeURIComponent(assetId)}`, module),
    { module }
  )
}

async function uploadVideoWithTus(
  input: UploadMediaFileInput,
  preparation: ResumableVideoUploadPreparation
): Promise<MediaAsset> {
  if (preparation.completed) return preparation.asset
  if (!preparation.upload) throw new Error('Bunny no regresó una sesión de subida resumible.')

  const credentials = preparation.upload
  const module = input.module || 'sites'
  const cancelPreparedUpload = () => cancelResumableVideoUpload(preparation.asset.id, module)
    .catch(() => undefined)
  const completedUpload = await new Promise<{ upload: tus.Upload; uploadUrl: string }>((resolve, reject) => {
    let settled = false
    let upload: tus.Upload | null = null
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      input.signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = () => {
      const abortUpload = upload?.abort()
      if (abortUpload) void abortUpload.finally(cancelPreparedUpload)
      else void cancelPreparedUpload()
      finish(() => reject(createMediaUploadCancelledError()))
    }

    if (input.signal?.aborted) {
      void cancelPreparedUpload()
      reject(createMediaUploadCancelledError())
      return
    }

    upload = new tus.Upload(input.file, {
      endpoint: credentials.endpoint,
      chunkSize: RESUMABLE_VIDEO_CHUNK_BYTES,
      retryDelays: [0, 1500, 4500, 10_000, 20_000, 60_000],
      // Conserva la sesión hasta que nuestro backend la verifique. Si la página
      // o Render caen justo después del último chunk, el siguiente intento hace
      // HEAD sobre la misma sesión en lugar de volver a mandar todo el video.
      removeFingerprintOnSuccess: false,
      headers: credentials.headers,
      metadata: {
        filetype: input.file.type || credentials.metadata.filetype || 'video/mp4',
        title: credentials.metadata.title || input.file.name,
        ...(credentials.metadata.collection ? { collection: credentials.metadata.collection } : {})
      },
      onShouldRetry: (error) => {
        const status = 'originalResponse' in error
          ? error.originalResponse?.getStatus() ?? null
          : null
        return status === null || status === 0 || status === 409 || status === 423 ||
          status === 429 || status >= 500
      },
      onProgress: (loaded, total) => {
        input.onProgress?.({
          loaded,
          total,
          percent: total > 0 ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100))) : 0
        })
      },
      onError: (error) => {
        const status = 'originalResponse' in error
          ? error.originalResponse?.getStatus()
          : null
        finish(() => reject(new Error(
          status
            ? `Bunny rechazó la subida resumible (HTTP ${status}). Intenta de nuevo.`
            : 'La conexión se interrumpió mientras se subía el video. Ristak conservará el avance para reanudarlo.'
        )))
      },
      onSuccess: () => finish(() => {
        if (upload?.url) {
          resolve({ upload, uploadUrl: upload.url })
          return
        }
        reject(new Error('Bunny terminó la subida, pero no regresó la URL TUS para verificarla.'))
      })
    })

    input.signal?.addEventListener('abort', abort, { once: true })
    void upload.findPreviousUploads()
      .then(previousUploads => {
        const previous = previousUploads[previousUploads.length - 1]
        if (previous) upload?.resumeFromPreviousUpload(previous)
        upload?.start()
      })
      .catch(error => finish(() => reject(error)))
  })

  let asset: MediaAsset
  try {
    asset = await finalizeResumableVideoUpload(
      preparation.asset.id,
      module,
      completedUpload.uploadUrl,
      input.signal
    )
  } catch (error) {
    if (input.signal?.aborted) {
      await cancelPreparedUpload()
      throw createMediaUploadCancelledError()
    }
    throw error
  }

  const storedUploads = await completedUpload.upload.findPreviousUploads().catch(() => [])
  const completedEntry = storedUploads.find(entry => entry.uploadUrl === completedUpload.uploadUrl)
  if (completedEntry) {
    const storage = completedUpload.upload.options.urlStorage || tus.defaultOptions.urlStorage
    await storage.removeUpload(completedEntry.urlStorageKey).catch(() => undefined)
  }
  return asset
}

async function prepareResumableVideoUpload(input: UploadMediaFileInput, clientUploadId: string) {
  const module = input.module || 'sites'
  return apiClient.post<ResumableVideoUploadPreparation>(
    mediaUploadEndpoint('/media/video-upload/prepare', module),
    {
      filename: input.file.name,
      mimeType: input.file.type,
      size: input.file.size,
      lastModified: input.file.lastModified,
      module,
      moduleEntityId: input.moduleEntityId,
      folderPath: input.folderPath,
      isPublic: input.isPublic ?? true,
      clientUploadId
    },
    { signal: input.signal }
  )
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createMediaUploadCancelledError())
      return
    }

    let timeout = 0
    const abort = () => {
      window.clearTimeout(timeout)
      cleanup()
      reject(createMediaUploadCancelledError())
    }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    timeout = window.setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function createMediaUploadHttpError(payload: unknown, status: number, statusText: string) {
  const error = new Error(extractApiErrorMessage(payload, status, statusText)) as Error & { status?: number }
  error.status = status
  return error
}

function createMediaUploadNetworkError() {
  const error = new Error('No se pudo conectar con el servidor.') as Error & { status?: number }
  error.status = 0
  return error
}

function isRetryableMediaUploadError(error: unknown) {
  if (isMediaUploadCancelledError(error)) return false
  const status = typeof error === 'object' && error ? Number((error as { status?: unknown }).status) : NaN
  return status === 0 || MEDIA_UPLOAD_RETRY_STATUS_CODES.has(status)
}

function buildUploadFormData(input: UploadMediaFileInput, clientUploadId: string) {
  const formData = new FormData()
  formData.append('file', input.file)
  formData.append('module', input.module || 'other')
  formData.append('isPublic', String(input.isPublic ?? true))
  formData.append('deferStreamSync', String(input.deferStreamSync ?? true))
  formData.append('clientUploadId', clientUploadId)
  if (input.moduleEntityId) formData.append('moduleEntityId', input.moduleEntityId)
  if (input.folderPath !== undefined) formData.append('folderPath', input.folderPath)
  return formData
}

function postFormWithProgress<T>(
  endpoint: string,
  body: FormData,
  onProgress?: (progress: MediaUploadProgress) => void,
  signal?: AbortSignal
): Promise<T> {
  if (!onProgress || typeof XMLHttpRequest === 'undefined') {
    return apiClient.postForm<T>(endpoint, body, { signal })
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createMediaUploadCancelledError())
      return
    }

    const xhr = new XMLHttpRequest()
    const abortRequest = () => xhr.abort()
    const cleanup = () => signal?.removeEventListener('abort', abortRequest)

    xhr.open('POST', buildApiUrl(endpoint))
    signal?.addEventListener('abort', abortRequest, { once: true })

    Object.entries(getAuthHeaders()).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value)
    })

    let lastProgress: MediaUploadProgress | null = null
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return
      lastProgress = {
        loaded: event.loaded,
        total: event.total,
        percent: Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)))
      }
      onProgress(lastProgress)
    }

    xhr.upload.onload = () => {
      lastProgress = buildCompletedUploadProgress(lastProgress)
      onProgress(lastProgress)
    }

    xhr.onload = () => {
      cleanup()
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

      reject(createMediaUploadHttpError(payload, xhr.status, xhr.statusText))
    }

    xhr.onerror = () => {
      cleanup()
      reject(createMediaUploadNetworkError())
    }
    xhr.onabort = () => {
      cleanup()
      reject(createMediaUploadCancelledError())
    }
    xhr.send(body)
  })
}

function createMediaUploadCancelledError() {
  const error = new Error(MEDIA_UPLOAD_CANCELLED_MESSAGE)
  error.name = 'AbortError'
  return error
}

export const mediaService = {
  async uploadFile(input: UploadMediaFileInput): Promise<MediaAsset> {
    const useResumableVideo = shouldUseResumableVideoUpload(input)
    const clientUploadId = input.clientUploadId || (
      useResumableVideo
        ? await createResumableVideoUploadClientId(input)
        : createMediaUploadClientId()
    )
    if (useResumableVideo) {
      let preparation: ResumableVideoUploadPreparation | null = null
      try {
        preparation = await prepareResumableVideoUpload(input, clientUploadId)
      } catch (error) {
        if (!shouldFallbackToMultipartUpload(error)) throw error
      }
      if (preparation) return uploadVideoWithTus(input, preparation)
    }

    let lastError: unknown

    for (let attempt = 0; attempt <= MEDIA_UPLOAD_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const formData = buildUploadFormData(input, clientUploadId)
        return await postFormWithProgress<MediaAsset>(mediaUploadEndpoint('/media/upload', input.module), formData, input.onProgress, input.signal)
      } catch (error) {
        lastError = error
        const retryDelay = MEDIA_UPLOAD_RETRY_DELAYS_MS[attempt]
        if (retryDelay === undefined || !isRetryableMediaUploadError(error)) {
          throw error
        }

        input.onProgress?.({
          loaded: 0,
          total: input.file.size,
          percent: 0
        })
        await sleep(retryDelay, input.signal)
      }
    }

    throw lastError
  },

  uploadDataUrl(input: {
    fileBase64: string
    filename: string
    module?: string
    moduleEntityId?: string
    folderPath?: string
    isPublic?: boolean
  }): Promise<MediaAsset> {
    return apiClient.post<MediaAsset>(mediaUploadEndpoint('/media/upload', input.module), {
      fileBase64: input.fileBase64,
      filename: input.filename,
      module: input.module || 'other',
      moduleEntityId: input.moduleEntityId,
      folderPath: input.folderPath,
      isPublic: input.isPublic ?? true
    })
  },

  listAssets(input: ListMediaAssetsInput = {}) {
    const params: Record<string, string> = {}
    if (input.businessId) params.businessId = input.businessId
    if (input.module) params.module = input.module
    if (input.mediaType) params.mediaType = input.mediaType
    if (input.status) params.status = input.status
    if (input.search) params.search = input.search
    if (input.folderPath !== null && input.folderPath !== undefined) params.path = input.folderPath
    if (input.recursive !== undefined) params.recursive = input.recursive ? 'true' : 'false'
    if (input.limit) params.limit = String(input.limit)
    if (input.cursor) params.cursor = input.cursor
    if (input.includeMeta !== undefined) params.includeMeta = input.includeMeta ? 'true' : 'false'
    if (input.includeFolders !== undefined) params.includeFolders = input.includeFolders ? 'true' : 'false'

    return apiClient.get<MediaAssetPage>('/media/assets', { params })
  },

  listFolders(input: ListMediaFoldersInput = {}) {
    const params: Record<string, string> = {}
    if (input.businessId) params.businessId = input.businessId
    if (input.parentPath !== undefined) params.parentPath = input.parentPath
    if (input.module) params.module = input.module
    if (input.mediaType) params.mediaType = input.mediaType
    if (input.status) params.status = input.status
    if (input.limit) params.limit = String(input.limit)
    if (input.cursor) params.cursor = input.cursor
    return apiClient.get<MediaFolderPage>('/media/folders', { params })
  },

  createFolder(input: { parentPath?: string; name: string }) {
    return apiClient.post<MediaFolderSummary>('/media/folders', input)
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

  downloadAssetsArchive(
    selection: MediaDownloadEntry[] | (MediaSelectionInput & { entries?: MediaDownloadEntry[] }),
    filename = 'media.zip'
  ) {
    const body = Array.isArray(selection)
      ? { entries: selection, filename }
      : { ...selection, filename }
    return downloadFromApi(
      '/media/assets/download',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
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

  moveSelection(selection: MediaSelectionInput, targetFolderPath = '') {
    return apiClient.post<MediaSelectionOperationResult>('/media/assets/move-selection', {
      ...selection,
      targetFolderPath
    })
  },

  deleteSelection(selection: MediaSelectionInput) {
    return apiClient.delete<MediaSelectionOperationResult>('/media/assets/selection', selection)
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
