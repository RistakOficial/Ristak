import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Activity,
  AudioLines,
  BarChart3,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  Eye,
  ExternalLink,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Flame,
  Folder,
  FolderInput,
  FolderPlus,
  Grid3X3,
  Globe2,
  HardDrive,
  List,
  Loader2,
  MoreHorizontal,
  PlayCircle,
  RefreshCw,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import {
  AreaChart,
  Button,
  Card,
  DateRangePicker,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MediaUploadTray,
  Modal,
  PageHeader,
  SearchField,
  TabList
} from '@/components/common'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useAppConfig, useUrlDateRangeSync, useUrlStringState } from '@/hooks'
import { useMediaUploadQueue } from '@/hooks/useMediaUploadQueue'
import { useNotification } from '@/contexts/NotificationContext'
import { getApiBaseUrl } from '@/services/apiBaseUrl'
import mediaService, {
  isMediaUploadCancelledError,
  type MediaAsset,
  type MediaFolderPage,
  type MediaDownloadEntry,
  type MediaPageInfo,
  type MediaSelectionInput,
  type MediaStreamAnalytics,
  type StorageUsage,
  type StreamChartPoint
} from '@/services/mediaService'
import { formatDateTime as formatBusinessDateTime, formatDateToISO, parseLocalDateString } from '@/utils/format'
import { getDateOnlyFromCalendarLikeString } from '@/utils/timezone'
import styles from './MediaSettings.module.css'

type MediaFilter = 'all' | 'image' | 'video' | 'audio' | 'document' | 'other'
type ViewMode = 'grid' | 'list'
const MEDIA_VIEW_MODE_CONFIG_KEY = 'media_settings_view_mode'
const MEDIA_DEFAULT_VIEW_MODE: ViewMode = 'list'
const mediaFilters: MediaFilter[] = ['all', 'image', 'video', 'audio', 'document', 'other']
const viewModes: ViewMode[] = ['grid', 'list']
const isMediaFilter = (value?: string | null): value is MediaFilter => mediaFilters.includes(value as MediaFilter)
const isViewMode = (value?: string | null): value is ViewMode => viewModes.includes(value as ViewMode)
const isQueryParam = (value?: string | null): value is string => typeof value === 'string'
const DEFAULT_MEDIA_FILTER: MediaFilter = 'all'

interface ExplorerFile {
  asset: MediaAsset
  fileName: string
  folderPath: string
  folderSegments: string[]
}

interface FolderSummary {
  path: string
  name: string
  filesCount: number
  sizeBytes: number
}

interface MoveDialogState {
  kind: 'files' | 'folder' | 'selection'
  title: string
  assetIds: string[]
  folderPaths: string[]
  filesCount: number
  sourceFolderPath?: string
  mediaType?: string
  status?: string
}

interface MarqueeSelectionState {
  active: boolean
  moved: boolean
  additive: boolean
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
}

const STORAGE_GB = 1024 * 1024 * 1024
const FILE_SELECTION_PREFIX = 'file:'
const FOLDER_SELECTION_PREFIX = 'folder:'
const MEDIA_DRAG_MIME = 'application/x-ristak-media-assets'
const MEDIA_LIBRARY_PAGE_SIZE = 50
const MEDIA_SEARCH_DEBOUNCE_MS = 300
const EMPTY_MEDIA_PAGE_INFO: MediaPageInfo = { limit: MEDIA_LIBRARY_PAGE_SIZE, hasMore: false, nextCursor: null }
const EMPTY_FOLDER_PAGE_INFO: MediaPageInfo = { limit: 100, hasMore: false, nextCursor: null }

const mediaTabs: Array<{ value: MediaFilter; label: string; icon: React.ReactNode }> = [
  { value: 'all', label: 'Todo', icon: <HardDrive size={14} /> },
  { value: 'image', label: 'Fotos', icon: <FileImage size={14} /> },
  { value: 'video', label: 'Videos', icon: <FileVideo size={14} /> },
  { value: 'audio', label: 'Audio', icon: <FileAudio size={14} /> },
  { value: 'document', label: 'Docs', icon: <FileText size={14} /> },
  { value: 'other', label: 'Otros', icon: <File size={14} /> }
]

const folderLabelMap: Record<string, string> = {
  audio: 'Audio',
  business_settings: 'Cuenta',
  chat: 'Chats',
  documents: 'Documentos',
  images: 'Imágenes',
  media: 'Media',
  other: 'Otros',
  sites: 'Sitios',
  videos: 'Videos',
  whatsapp: 'WhatsApp'
}

const moduleLabelMap: Record<string, string> = {
  business_settings: 'Cuenta',
  chat: 'Chats',
  media: 'Media',
  other: 'Otros',
  sites: 'Sitios',
  whatsapp: 'WhatsApp'
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

function fileSelectionKey(assetId: string) {
  return `${FILE_SELECTION_PREFIX}${assetId}`
}

function folderSelectionKey(path: string) {
  return `${FOLDER_SELECTION_PREFIX}${path}`
}

function selectedFileIdFromKey(key: string) {
  return key.startsWith(FILE_SELECTION_PREFIX) ? key.slice(FILE_SELECTION_PREFIX.length) : ''
}

function selectedFolderPathFromKey(key: string) {
  return key.startsWith(FOLDER_SELECTION_PREFIX) ? key.slice(FOLDER_SELECTION_PREFIX.length) : ''
}

function formatBytes(bytes?: number | null) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return '0 MB'
  if (value >= STORAGE_GB) {
    const gb = value / STORAGE_GB
    return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  }
  const mb = value / 1024 / 1024
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
  const kb = value / 1024
  if (kb >= 1) return `${Math.max(1, Math.round(kb))} KB`
  return `${Math.max(1, Math.round(value))} B`
}

function formatDate(value?: string | null) {
  return formatBusinessDateTime(value, {
    fallback: 'Sin fecha',
    intlOptions: {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }
  })
}

function formatCompactNumber(value?: number | null) {
  const parsed = Number(value || 0)
  if (!Number.isFinite(parsed)) return '0'
  return new Intl.NumberFormat('es-MX', { notation: parsed >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(parsed)
}

function formatSeconds(value?: number | null) {
  const total = Math.max(0, Math.round(Number(value || 0)))
  if (!Number.isFinite(total) || total <= 0) return '0s'
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`
}

function getVideoAnalyticsRange(startValue: Date, endValue: Date) {
  const start = startValue instanceof Date ? startValue : new Date(startValue)
  const end = endValue instanceof Date ? endValue : new Date(endValue)
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  const days = Math.max(1, Math.round((endDay.getTime() - startDay.getTime()) / 86400000) + 1)

  return {
    dateFrom: formatDateToISO(start),
    dateTo: formatDateToISO(end),
    hourly: days <= 7
  }
}

function getMetadataRecord(asset?: MediaAsset | null) {
  const metadata = asset?.metadata
  return metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {}
}

function getStreamRecord(asset?: MediaAsset | null) {
  const stream = getMetadataRecord(asset).stream
  return stream && typeof stream === 'object' ? stream as Record<string, unknown> : {}
}

function getStreamVideoRecord(asset?: MediaAsset | null) {
  const video = getStreamRecord(asset).video
  return video && typeof video === 'object' ? video as Record<string, unknown> : {}
}

function readNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function formatChartLabel(value: string, compact = false) {
  const calendarDate = getDateOnlyFromCalendarLikeString(value)
  return formatBusinessDateTime(value, {
    fallback: value,
    intlOptions: compact || calendarDate
      ? { day: '2-digit', month: 'short' }
      : { day: '2-digit', month: 'short', hour: '2-digit' }
  })
}

function chartPoints(points: StreamChartPoint[] = [], mode: 'count' | 'seconds' = 'count') {
  return points.map((point) => ({
    ...point,
    label: formatChartLabel(point.label || point.periodKey || '', mode === 'count'),
    value: mode === 'seconds' ? Math.round((Number(point.value || 0) / 60) * 10) / 10 : Number(point.value || 0)
  }))
}

function formatFolderSegment(segment: string) {
  if (!segment) return ''
  if (/^\d{4}$/.test(segment)) return segment
  if (/^\d{2}$/.test(segment)) return segment
  const normalized = segment.trim().toLowerCase()
  if (folderLabelMap[normalized]) return folderLabelMap[normalized]
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function presentFolderSummary(folder: FolderSummary): FolderSummary {
  return { ...folder, name: formatFolderSegment(folder.name) }
}

function formatModuleLabel(module?: string) {
  const normalized = (module || 'other').toLowerCase()
  return moduleLabelMap[normalized] || formatFolderSegment(normalized)
}

function formatStorageStatus(usage: StorageUsage | null) {
  if (!usage) return 'Leyendo storage'
  if (usage.storage_enabled === false) return 'Storage apagado'
  const provider = usage.storage_provider === 'bunny' ? 'Bunny.net' : (usage.storage_provider || 'Storage')
  if (usage.storage_status === 'configured') return `${provider} conectado`
  if (usage.storage_status === 'local_fallback') return 'Fallback local'
  if (usage.storage_status === 'not_configured') return `${provider} incompleto`
  if (usage.storage_status === 'disabled') return 'Storage apagado'
  return provider
}

function stripTechnicalStorageRoot(parts: string[], asset: MediaAsset) {
  if (parts[0] === 'businesses') return parts.slice(parts.length > 2 ? 2 : 1)
  if (parts[0] === 'accounts') return parts.slice(parts.length > 2 ? 2 : 1)

  const metadata = getMetadataRecord(asset)
  const account = metadata.clientAccount || metadata.client_account
  if (!account || typeof account !== 'object') return parts

  const accountRecord = account as Record<string, unknown>
  const rootPath = readString(accountRecord.rootPath || accountRecord.root_path)
  const rootParts = pathSegments(rootPath)
  if (!rootParts.length) return parts

  return rootParts.every((segment, index) => parts[index] === segment)
    ? parts.slice(rootParts.length)
    : parts
}

function normalizeAssetPath(asset: MediaAsset) {
  if (asset.folderPath !== undefined) {
    return [...pathSegments(asset.folderPath), getAssetDisplayName(asset)].filter(Boolean)
  }
  const rawParts = (asset.bunnyPath || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)

  const parts = stripTechnicalStorageRoot(rawParts, asset)
  const displayName = getAssetDisplayName(asset, rawParts[rawParts.length - 1])
  if (!parts.length) {
    return [asset.module || asset.mediaType || 'other', displayName].filter(Boolean)
  }

  return [...parts.slice(0, -1), displayName].filter(Boolean)
}

function getAssetDisplayName(asset: MediaAsset, pathName = '') {
  return asset.originalFilename || asset.storedFilename || pathName || asset.id
}

function toExplorerFile(asset: MediaAsset): ExplorerFile {
  const parts = normalizeAssetPath(asset)
  const fileName = parts[parts.length - 1] || getAssetDisplayName(asset)
  const folderSegments = parts.slice(0, -1)
  const folderPath = folderSegments.join('/')
  return {
    asset,
    fileName,
    folderPath,
    folderSegments
  }
}

function pathSegments(path: string) {
  return path.split('/').filter(Boolean)
}

function buildFileUrl(asset: MediaAsset, variant: 'file' | 'thumbnail' = 'file') {
  const path = `/api/media/assets/${encodeURIComponent(asset.id)}/${variant}`
  const apiBaseUrl = getApiBaseUrl()
  if (apiBaseUrl) return `${apiBaseUrl}${path}`
  return path
}

function getOpenUrl(asset: MediaAsset) {
  return asset.publicUrl || buildFileUrl(asset)
}

function getMediaIcon(mediaType?: string, size = 18) {
  if (mediaType === 'image') return <FileImage size={size} />
  if (mediaType === 'video') return <FileVideo size={size} />
  if (mediaType === 'audio') return <FileAudio size={size} />
  if (mediaType === 'document') return <FileText size={size} />
  return <File size={size} />
}

function getCurrentFolderLabel(currentPath: string) {
  const parts = pathSegments(currentPath)
  if (!parts.length) return 'Mi unidad'
  return formatFolderSegment(parts[parts.length - 1])
}

function getMediaFilterLabel(filter: MediaFilter) {
  return mediaTabs.find((tab) => tab.value === filter)?.label || 'Media'
}

function getArchiveEntryPath(file: ExplorerFile) {
  const folders = file.folderSegments.map(formatFolderSegment)
  return [...folders, file.fileName].filter(Boolean).join('/') || file.fileName
}

function sanitizeDownloadName(value: string, fallback = 'media') {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
  return cleaned || fallback
}

function buildArchiveFilename(label: string) {
  return `${sanitizeDownloadName(label, 'media')}.zip`
}

function joinFolderPath(...parts: string[]) {
  return parts.flatMap(pathSegments).filter(Boolean).join('/')
}

function rectsOverlap(a: DOMRect | { left: number; right: number; top: number; bottom: number }, b: DOMRect | { left: number; right: number; top: number; bottom: number }) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top
}

function dataTransferHasMediaPayload(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types || []).includes(MEDIA_DRAG_MIME)
}

function readDraggedMediaIds(dataTransfer: DataTransfer) {
  try {
    const parsed = JSON.parse(dataTransfer.getData(MEDIA_DRAG_MIME) || '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && Boolean(id)) : []
  } catch {
    return []
  }
}

export const MediaSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const { dateRange, setDateRange } = useDateRange()
  const [searchParams, setSearchParams] = useSearchParams()
  const uploadQueue = useMediaUploadQueue()
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const filePaneRef = useRef<HTMLElement>(null)
  const mediaRequestVersionRef = useRef(0)
  const folderRequestVersionRef = useRef(0)
  const rootFolderRequestVersionRef = useRef(0)
  const moveFolderRequestVersionRef = useRef(0)
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [folderSummaries, setFolderSummaries] = useState<FolderSummary[]>([])
  const [rootFolders, setRootFolders] = useState<FolderSummary[]>([])
  const [assetPageInfo, setAssetPageInfo] = useState<MediaPageInfo>(EMPTY_MEDIA_PAGE_INFO)
  const [folderPageInfo, setFolderPageInfo] = useState<MediaPageInfo>(EMPTY_FOLDER_PAGE_INFO)
  const [rootFolderPageInfo, setRootFolderPageInfo] = useState<MediaPageInfo>(EMPTY_FOLDER_PAGE_INFO)
  const [libraryItemsCount, setLibraryItemsCount] = useState(0)
  const [libraryItemsCountIsLowerBound, setLibraryItemsCountIsLowerBound] = useState(false)
  const [pageCursor, setPageCursor] = useState('')
  const [cursorHistory, setCursorHistory] = useState<string[]>([])
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [bulkAction, setBulkAction] = useState<'download' | 'delete' | null>(null)
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useUrlStringState<string>('q', '', isQueryParam)
  const [debouncedQuery, setDebouncedQuery] = useState(query.trim())
  const [activeFilter] = useUrlStringState<MediaFilter>('type', DEFAULT_MEDIA_FILTER, isMediaFilter)
  const [storedViewMode, saveStoredViewMode] = useAppConfig<string>(
    MEDIA_VIEW_MODE_CONFIG_KEY,
    MEDIA_DEFAULT_VIEW_MODE
  )
  const savedViewMode = isViewMode(storedViewMode) ? storedViewMode : MEDIA_DEFAULT_VIEW_MODE
  const [viewMode, setViewModeState] = useState<ViewMode>(savedViewMode)
  const viewModeRef = useRef(viewMode)
  const viewModeSaveVersionRef = useRef(0)
  const [currentPath] = useUrlStringState<string>('path', '', isQueryParam)
  const [selectedAssetParam, setSelectedAssetParam] = useUrlStringState<string>('asset', '', isQueryParam)
  const selectedAssetId = selectedAssetParam || null
  const setSelectedAssetId = useCallback((value: string | null) => {
    setSelectedAssetParam(value || '')
  }, [setSelectedAssetParam])
  const [selectedItemKeys, setSelectedItemKeys] = useState<Set<string>>(() => new Set())
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null)
  const [moveTargetPath, setMoveTargetPath] = useState('')
  const [moveFolders, setMoveFolders] = useState<FolderSummary[]>([])
  const [moveFolderPageInfo, setMoveFolderPageInfo] = useState<MediaPageInfo>(EMPTY_FOLDER_PAGE_INFO)
  const [moveFoldersLoading, setMoveFoldersLoading] = useState(false)
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [draggingFileIds, setDraggingFileIds] = useState<string[]>([])
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null)
  const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelectionState | null>(null)
  const [videoAnalytics, setVideoAnalytics] = useState<MediaStreamAnalytics | null>(null)
  const [videoAnalyticsLoading, setVideoAnalyticsLoading] = useState(false)
  const [videoAnalyticsError, setVideoAnalyticsError] = useState('')

  const updateExplorerUrl = useCallback((next: {
    type?: MediaFilter
    path?: string
    asset?: string | null
  }) => {
    const nextParams = new URLSearchParams(searchParams)
    if (next.type !== undefined) {
      if (next.type === DEFAULT_MEDIA_FILTER) nextParams.delete('type')
      else nextParams.set('type', next.type)
    }
    if (next.path !== undefined) {
      if (next.path) nextParams.set('path', next.path)
      else nextParams.delete('path')
    }
    if (next.asset !== undefined) {
      if (next.asset) nextParams.set('asset', next.asset)
      else nextParams.delete('asset')
    }
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    setViewModeState(current => current === savedViewMode ? current : savedViewMode)
  }, [savedViewMode])

  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])

  const setViewMode = useCallback((nextViewMode: ViewMode) => {
    const normalizedViewMode = isViewMode(nextViewMode) ? nextViewMode : MEDIA_DEFAULT_VIEW_MODE
    const previousViewMode = viewModeRef.current
    const saveVersion = viewModeSaveVersionRef.current + 1
    viewModeSaveVersionRef.current = saveVersion
    setViewModeState(normalizedViewMode)

    void saveStoredViewMode(normalizedViewMode).catch(() => {
      if (viewModeSaveVersionRef.current !== saveVersion) return
      setViewModeState(previousViewMode)
      showToast('error', 'No se guardó la vista', 'Ristak no pudo guardar tu preferencia de Media. Inténtalo otra vez.')
    })
  }, [saveStoredViewMode, showToast])

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), MEDIA_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [query])

  const normalizedQuery = debouncedQuery.trim()
  const browsingGlobalType = activeFilter !== 'all' && !currentPath && !normalizedQuery
  const mediaTypeFilter = activeFilter === 'all' ? undefined : activeFilter
  const requestedFolderPath = normalizedQuery || browsingGlobalType ? null : currentPath

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await mediaService.getStorageUsage())
    } catch (usageError) {
      showToast('error', 'No se cargó el uso de Media', usageError instanceof Error ? usageError.message : 'Intenta otra vez.')
    }
  }, [showToast])

  const loadRootFolders = useCallback(async () => {
    const requestVersion = rootFolderRequestVersionRef.current + 1
    rootFolderRequestVersionRef.current = requestVersion
    try {
      const page = await mediaService.listFolders({
        parentPath: '',
        mediaType: mediaTypeFilter,
        limit: 100
      })
      if (requestVersion !== rootFolderRequestVersionRef.current) return
      setRootFolders(page.items.map(presentFolderSummary))
      setRootFolderPageInfo(page.pageInfo)
    } catch (folderError) {
      if (requestVersion !== rootFolderRequestVersionRef.current) return
      showToast('error', 'No se cargaron las carpetas', folderError instanceof Error ? folderError.message : 'Intenta otra vez.')
    }
  }, [mediaTypeFilter, showToast])

  const loadCurrentFolders = useCallback(async () => {
    const requestVersion = folderRequestVersionRef.current + 1
    folderRequestVersionRef.current = requestVersion
    if (requestedFolderPath === null) {
      setFolderSummaries([])
      setFolderPageInfo(EMPTY_FOLDER_PAGE_INFO)
      return
    }
    try {
      const page = await mediaService.listFolders({
        parentPath: requestedFolderPath,
        mediaType: mediaTypeFilter,
        limit: 100
      })
      if (requestVersion !== folderRequestVersionRef.current) return
      const nextFolders = page.items.map(presentFolderSummary)
      setFolderSummaries(nextFolders)
      setFolderPageInfo(page.pageInfo)
      if (requestedFolderPath === '') {
        setRootFolders(nextFolders)
        setRootFolderPageInfo(page.pageInfo)
      }
    } catch (folderError) {
      if (requestVersion !== folderRequestVersionRef.current) return
      showToast('error', 'No se cargaron las carpetas', folderError instanceof Error ? folderError.message : 'Intenta otra vez.')
    }
  }, [mediaTypeFilter, requestedFolderPath, showToast])

  const loadMedia = useCallback(async (
    mode: 'initial' | 'refresh' = 'refresh',
    options: { cursor?: string; history?: string[] } = {}
  ) => {
    const requestVersion = mediaRequestVersionRef.current + 1
    mediaRequestVersionRef.current = requestVersion
    const requestedCursor = options.cursor || ''
    const includeMeta = !requestedCursor
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    setError('')

    try {
      const page = await mediaService.listAssets({
        mediaType: mediaTypeFilter,
        search: normalizedQuery || undefined,
        folderPath: requestedFolderPath,
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        cursor: requestedCursor || null,
        includeMeta,
        includeFolders: false
      })
      if (requestVersion !== mediaRequestVersionRef.current) return

      setAssets(page.items)
      setAssetPageInfo(page.pageInfo)
      if (!requestedCursor) {
        setLibraryItemsCount(page.summary?.totalItems ?? page.items.length)
        setLibraryItemsCountIsLowerBound(page.summary === null && page.pageInfo.hasMore)
      }
      setPageCursor(requestedCursor)
      setCursorHistory(options.history || [])
      setSelectedItemKeys(new Set())
    } catch (loadError) {
      if (requestVersion !== mediaRequestVersionRef.current) return
      const message = loadError instanceof Error ? loadError.message : 'No se pudo cargar Media.'
      setError(message)
      showToast('error', 'No se cargó Media', message)
    } finally {
      if (requestVersion === mediaRequestVersionRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [mediaTypeFilter, normalizedQuery, requestedFolderPath, showToast])

  useEffect(() => {
    void loadMedia('initial')
  }, [loadMedia])

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  useEffect(() => {
    void loadCurrentFolders()
  }, [loadCurrentFolders])

  useEffect(() => {
    if (requestedFolderPath !== '') void loadRootFolders()
    else rootFolderRequestVersionRef.current += 1
    return () => {
      rootFolderRequestVersionRef.current += 1
    }
  }, [loadRootFolders, requestedFolderPath])

  const refreshLibrary = useCallback(async () => {
    const tasks: Promise<unknown>[] = [
      loadMedia('refresh'),
      loadUsage(),
      loadCurrentFolders()
    ]
    if (requestedFolderPath !== '') tasks.push(loadRootFolders())
    await Promise.all(tasks)
  }, [loadCurrentFolders, loadMedia, loadRootFolders, loadUsage, requestedFolderPath])

  const files = useMemo(() => assets.map(toExplorerFile), [assets])
  const filesById = useMemo(() => new Map(files.map((file) => [file.asset.id, file])), [files])
  const visibleFiles = files
  const visibleSelectionKeys = useMemo(() => [
    ...folderSummaries.map((folder) => folderSelectionKey(folder.path)),
    ...visibleFiles.map((file) => fileSelectionKey(file.asset.id))
  ], [folderSummaries, visibleFiles])
  const selectedFiles = useMemo(() => Array.from(selectedItemKeys)
    .map(selectedFileIdFromKey)
    .filter(Boolean)
    .map((assetId) => filesById.get(assetId))
    .filter((file): file is ExplorerFile => Boolean(file)), [filesById, selectedItemKeys])
  const selectedFolderPaths = useMemo(() => Array.from(selectedItemKeys)
    .map(selectedFolderPathFromKey)
    .filter(Boolean), [selectedItemKeys])
  const selectedFolderCounts = useMemo(() => new Map(
    folderSummaries.map((folder) => [folder.path, folder.filesCount])
  ), [folderSummaries])
  const selectedFileCount = selectedFiles.length + selectedFolderPaths.reduce(
    (total, folderPath) => total + (selectedFolderCounts.get(folderPath) || 0),
    0
  )
  const selectedScope = useMemo<MediaSelectionInput>(() => ({
    assetIds: selectedFiles.map((file) => file.asset.id),
    folderPaths: selectedFolderPaths,
    mediaType: mediaTypeFilter
  }), [mediaTypeFilter, selectedFiles, selectedFolderPaths])
  const selectedFile = useMemo(() => (
    visibleFiles.find((file) => file.asset.id === selectedAssetId) || visibleFiles[0] || null
  ), [selectedAssetId, visibleFiles])
  const selectedVideoFile = useMemo(() => {
    if (selectedFile?.asset.mediaType === 'video') return selectedFile
    if (activeFilter === 'video') return visibleFiles.find((file) => file.asset.mediaType === 'video') || null
    return null
  }, [activeFilter, selectedFile, visibleFiles])
  const showVideoAnalytics = activeFilter === 'video' || selectedFile?.asset.mediaType === 'video'
  useUrlDateRangeSync({
    dateRange,
    setDateRange,
    enabled: showVideoAnalytics
  })
  const usagePercent = Math.max(0, Math.min(100, Number(usage?.usage_percent || 0)))
  const filesCount = usage?.files_count ?? assets.length
  const libraryItemsCountLabel = `${libraryItemsCount}${libraryItemsCountIsLowerBound ? '+' : ''}`
  const visibleItemsCount = folderSummaries.length + libraryItemsCount
  const visibleItemsCountLabel = `${visibleItemsCount}${libraryItemsCountIsLowerBound ? '+' : ''}`
  const folderPathParts = pathSegments(currentPath)
  const selectedElementCount = selectedItemKeys.size
  const allVisibleSelected = visibleSelectionKeys.length > 0 && visibleSelectionKeys.every((key) => selectedItemKeys.has(key))
  const partiallySelected = !allVisibleSelected && visibleSelectionKeys.some((key) => selectedItemKeys.has(key))
  const actionBusy = Boolean(bulkAction) || moving
  const marqueeBox = marqueeSelection && marqueeSelection.moved
    ? {
        left: Math.min(marqueeSelection.startX, marqueeSelection.currentX),
        top: Math.min(marqueeSelection.startY, marqueeSelection.currentY),
        width: Math.abs(marqueeSelection.currentX - marqueeSelection.startX),
        height: Math.abs(marqueeSelection.currentY - marqueeSelection.startY)
      }
    : null

  useEffect(() => {
    const asset = showVideoAnalytics ? selectedVideoFile?.asset : null
    const streamVideoId = readString(getStreamRecord(asset).videoId)
    if (!asset || !streamVideoId) {
      setVideoAnalytics(null)
      setVideoAnalyticsError('')
      setVideoAnalyticsLoading(false)
      return
    }

    let cancelled = false
    setVideoAnalyticsLoading(true)
    setVideoAnalyticsError('')

    mediaService.getAssetStreamAnalytics(asset.id, getVideoAnalyticsRange(dateRange.start, dateRange.end))
      .then((analytics) => {
        if (!cancelled) setVideoAnalytics(analytics)
      })
      .catch((analyticsError) => {
        if (!cancelled) {
          setVideoAnalytics(null)
          setVideoAnalyticsError(analyticsError instanceof Error ? analyticsError.message : 'No se pudieron cargar las analíticas del video.')
        }
      })
      .finally(() => {
        if (!cancelled) setVideoAnalyticsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [dateRange.end, dateRange.start, selectedVideoFile?.asset, showVideoAnalytics])

  const handleFolderOpen = (path: string) => {
    updateExplorerUrl({ path, asset: null })
    setSelectedItemKeys(new Set())
  }

  const openCreateFolderDialog = () => {
    setFolderName('')
    setCreateFolderOpen(true)
  }

  const closeCreateFolderDialog = () => {
    if (creatingFolder) return
    setCreateFolderOpen(false)
    setFolderName('')
  }

  const handleCreateFolder = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = folderName.trim()
    if (!name) {
      showToast('warning', 'Falta el nombre', 'Escribe cómo se llamará la carpeta.')
      return
    }

    setCreatingFolder(true)
    try {
      const folder = await mediaService.createFolder({ parentPath: currentPath, name })
      setCreateFolderOpen(false)
      setFolderName('')
      await refreshLibrary()
      updateExplorerUrl({ type: 'all', path: folder.path, asset: null })
      showToast('success', 'Carpeta creada', `Ya estás dentro de ${folder.name}. Todo lo que subas aquí se guardará en esta carpeta.`)
    } catch (folderError) {
      showToast('error', 'No se pudo crear la carpeta', folderError instanceof Error ? folderError.message : 'Intenta otra vez.')
    } finally {
      setCreatingFolder(false)
    }
  }

  const handleMediaFilterChange = (value: string) => {
    const nextFilter = isMediaFilter(value) ? value : 'all'
    updateExplorerUrl({
      type: nextFilter,
      path: '',
      asset: null
    })
    setSelectedItemKeys(new Set())
  }

  const toggleSelection = (key: string) => {
    setSelectedItemKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const clearSelection = () => {
    setSelectedItemKeys(new Set())
  }

  const toggleVisibleSelection = () => {
    setSelectedItemKeys((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        visibleSelectionKeys.forEach((key) => next.delete(key))
      } else {
        visibleSelectionKeys.forEach((key) => next.add(key))
      }
      return next
    })
  }

  const filesByIds = (assetIds: string[]) => {
    const uniqueIds = new Set(assetIds)
    return files.filter((file) => uniqueIds.has(file.asset.id))
  }

  const handleNextPage = () => {
    if (!assetPageInfo.nextCursor || refreshing) return
    void loadMedia('refresh', {
      cursor: assetPageInfo.nextCursor,
      history: [...cursorHistory, pageCursor]
    })
  }

  const handlePreviousPage = () => {
    if (!cursorHistory.length || refreshing) return
    const previousCursor = cursorHistory[cursorHistory.length - 1] || ''
    void loadMedia('refresh', {
      cursor: previousCursor,
      history: cursorHistory.slice(0, -1)
    })
  }

  const appendFolderPage = (current: FolderSummary[], page: MediaFolderPage) => {
    const byPath = new Map(current.map((folder) => [folder.path, folder]))
    page.items.map(presentFolderSummary).forEach((folder) => byPath.set(folder.path, folder))
    return Array.from(byPath.values())
  }

  const loadMoreCurrentFolders = async () => {
    if (!folderPageInfo.nextCursor || requestedFolderPath === null) return
    const requestVersion = folderRequestVersionRef.current + 1
    folderRequestVersionRef.current = requestVersion
    try {
      const page = await mediaService.listFolders({
        parentPath: requestedFolderPath,
        mediaType: mediaTypeFilter,
        cursor: folderPageInfo.nextCursor,
        limit: 100
      })
      if (requestVersion !== folderRequestVersionRef.current) return
      setFolderSummaries((current) => appendFolderPage(current, page))
      setFolderPageInfo(page.pageInfo)
    } catch (folderError) {
      if (requestVersion !== folderRequestVersionRef.current) return
      showToast('error', 'No se cargaron más carpetas', folderError instanceof Error ? folderError.message : 'Intenta otra vez.')
    }
  }

  const loadMoreRootFolders = async () => {
    if (!rootFolderPageInfo.nextCursor) return
    const requestVersion = rootFolderRequestVersionRef.current + 1
    rootFolderRequestVersionRef.current = requestVersion
    try {
      const page = await mediaService.listFolders({
        parentPath: '',
        mediaType: mediaTypeFilter,
        cursor: rootFolderPageInfo.nextCursor,
        limit: 100
      })
      if (requestVersion !== rootFolderRequestVersionRef.current) return
      setRootFolders((current) => appendFolderPage(current, page))
      setRootFolderPageInfo(page.pageInfo)
    } catch (folderError) {
      if (requestVersion !== rootFolderRequestVersionRef.current) return
      showToast('error', 'No se cargaron más carpetas', folderError instanceof Error ? folderError.message : 'Intenta otra vez.')
    }
  }

  const isMoveTargetDisabled = (dialog: MoveDialogState | null, targetPath: string) => {
    if (!dialog) return true
    for (const sourceFolderPath of dialog.folderPaths) {
      const sourceParentPath = pathSegments(sourceFolderPath).slice(0, -1).join('/')
      if (targetPath === sourceParentPath) return true
      if (targetPath === sourceFolderPath) return true
      if (targetPath.startsWith(`${sourceFolderPath}/`)) return true
    }
    if (dialog.folderPaths.length) return false
    const selectedDialogFiles = filesByIds(dialog.assetIds)
    return selectedDialogFiles.length > 0 && selectedDialogFiles.every((file) => file.folderPath === targetPath)
  }

  const loadMoveFolders = async (parentPath: string, cursor = '', append = false) => {
    const requestVersion = moveFolderRequestVersionRef.current + 1
    moveFolderRequestVersionRef.current = requestVersion
    setMoveFoldersLoading(true)
    try {
      const page = await mediaService.listFolders({ parentPath, cursor: cursor || null, limit: 100 })
      if (requestVersion !== moveFolderRequestVersionRef.current) return
      setMoveFolders((current) => append ? appendFolderPage(current, page) : page.items.map(presentFolderSummary))
      setMoveFolderPageInfo(page.pageInfo)
    } catch (folderError) {
      if (requestVersion !== moveFolderRequestVersionRef.current) return
      showToast('error', 'No se cargaron las carpetas', folderError instanceof Error ? folderError.message : 'Intenta otra vez.')
    } finally {
      if (requestVersion === moveFolderRequestVersionRef.current) {
        setMoveFoldersLoading(false)
      }
    }
  }

  const openMoveDialog = (dialog: MoveDialogState) => {
    setMoveDialog(dialog)
    setMoveTargetPath('')
    setMoveFolders([])
    setMoveFolderPageInfo(EMPTY_FOLDER_PAGE_INFO)
    void loadMoveFolders('')
  }

  const closeMoveDialog = () => {
    if (moving) return
    moveFolderRequestVersionRef.current += 1
    setMoveDialog(null)
    setMoveTargetPath('')
    setMoveFolders([])
    setMoveFolderPageInfo(EMPTY_FOLDER_PAGE_INFO)
    setMoveFoldersLoading(false)
  }

  const openMoveFolderPath = (folderPath: string) => {
    setMoveTargetPath(folderPath)
    setMoveFolders([])
    setMoveFolderPageInfo(EMPTY_FOLDER_PAGE_INFO)
    void loadMoveFolders(folderPath)
  }

  const moveFiles = async (dialog: MoveDialogState, targetFolderPath: string) => {
    if (isMoveTargetDisabled(dialog, targetFolderPath)) {
      showToast('warning', 'Elige otra carpeta', 'Selecciona una carpeta distinta para mover los archivos.')
      return
    }

    if (!dialog.assetIds.length && !dialog.folderPaths.length) {
      showToast('warning', 'No hay archivos', 'Selecciona al menos un archivo para mover.')
      return
    }

    setMoving(true)
    try {
      const affected = (await mediaService.moveSelection({
        assetIds: dialog.assetIds,
        folderPaths: dialog.folderPaths,
        mediaType: dialog.mediaType,
        status: dialog.status
      }, targetFolderPath)).affected
      setSelectedItemKeys(new Set())
      await refreshLibrary()
      const destinationPath = dialog.kind === 'folder' && dialog.sourceFolderPath
        ? joinFolderPath(targetFolderPath, pathSegments(dialog.sourceFolderPath).slice(-1)[0] || '')
        : targetFolderPath
      updateExplorerUrl({ path: destinationPath, asset: null })
      showToast(
        'success',
        dialog.folderPaths.length ? 'Carpeta movida' : 'Archivos movidos',
        dialog.folderPaths.length
          ? 'La carpeta y su contenido quedaron en la ubicación elegida.'
          : `${affected} archivo${affected === 1 ? '' : 's'} quedaron en la carpeta elegida.`
      )
      moveFolderRequestVersionRef.current += 1
      setMoveDialog(null)
      setMoveTargetPath('')
      setMoveFolders([])
      setMoveFolderPageInfo(EMPTY_FOLDER_PAGE_INFO)
      setMoveFoldersLoading(false)
    } catch (moveError) {
      await refreshLibrary()
      showToast('error', 'No se pudo mover', moveError instanceof Error ? moveError.message : 'Intenta otra vez.')
    } finally {
      setMoving(false)
      setDraggingFileIds([])
      setDragOverFolderPath(null)
    }
  }

  const handleMoveSelected = () => {
    openMoveDialog({
      kind: 'selection',
      title: `Mover ${selectedElementCount} elemento${selectedElementCount === 1 ? '' : 's'}`,
      assetIds: selectedScope.assetIds || [],
      folderPaths: selectedScope.folderPaths || [],
      filesCount: selectedFileCount,
      mediaType: selectedScope.mediaType,
      status: selectedScope.status
    })
  }

  const handleMoveFile = (file: ExplorerFile) => {
    openMoveDialog({
      kind: 'files',
      title: `Mover ${file.fileName}`,
      assetIds: [file.asset.id],
      folderPaths: [],
      filesCount: 1,
      mediaType: mediaTypeFilter
    })
  }

  const handleMoveFolder = (folder: FolderSummary) => {
    openMoveDialog({
      kind: 'folder',
      title: `Mover carpeta ${folder.name}`,
      assetIds: [],
      folderPaths: [folder.path],
      filesCount: folder.filesCount,
      sourceFolderPath: folder.path,
      mediaType: mediaTypeFilter
    })
  }

  const moveDraggedFilesToFolder = (targetFolderPath: string, assetIds = draggingFileIds) => {
    const draggedFiles = filesByIds(assetIds)
    if (!draggedFiles.length) return
    void moveFiles({
      kind: 'files',
      title: 'Mover archivos',
      assetIds: draggedFiles.map((file) => file.asset.id),
      folderPaths: [],
      filesCount: draggedFiles.length,
      mediaType: mediaTypeFilter
    }, targetFolderPath)
  }

  const handleFileDragStart = (event: React.DragEvent<HTMLElement>, file: ExplorerFile) => {
    if (actionBusy) {
      event.preventDefault()
      return
    }

    const selectedIds = new Set(selectedFiles.map((selected) => selected.asset.id))
    const ids = selectedIds.has(file.asset.id) ? Array.from(selectedIds) : [file.asset.id]
    if (!selectedIds.has(file.asset.id)) {
      setSelectedItemKeys(new Set([fileSelectionKey(file.asset.id)]))
    }
    setDraggingFileIds(ids)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(MEDIA_DRAG_MIME, JSON.stringify(ids))
    event.dataTransfer.setData('text/plain', ids.join(','))
  }

  const handleFileDragEnd = () => {
    setDraggingFileIds([])
    setDragOverFolderPath(null)
  }

  const handleFolderDragOver = (event: React.DragEvent<HTMLElement>, folderPath: string) => {
    if (actionBusy || (!draggingFileIds.length && !dataTransferHasMediaPayload(event.dataTransfer))) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverFolderPath(folderPath)
  }

  const handleFolderDragLeave = (event: React.DragEvent<HTMLElement>, folderPath: string) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragOverFolderPath((current) => current === folderPath ? null : current)
  }

  const handleFolderDrop = (event: React.DragEvent<HTMLElement>, folderPath: string) => {
    if (actionBusy) return
    const droppedIds = readDraggedMediaIds(event.dataTransfer)
    const assetIds = droppedIds.length ? droppedIds : draggingFileIds
    if (!assetIds.length) return
    event.preventDefault()
    event.stopPropagation()
    setDragOverFolderPath(null)
    moveDraggedFilesToFolder(folderPath, assetIds)
  }

  const handleMarqueePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || actionBusy) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, a, [role="menuitem"], [data-media-item="true"]')) return
    const pane = filePaneRef.current
    if (!pane) return
    const rect = pane.getBoundingClientRect()
    const startX = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
    const startY = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setMarqueeSelection({
      active: true,
      moved: false,
      additive: event.metaKey || event.ctrlKey || event.shiftKey,
      pointerId: event.pointerId,
      startX,
      startY,
      currentX: startX,
      currentY: startY
    })
  }

  const handleMarqueePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!marqueeSelection?.active || marqueeSelection.pointerId !== event.pointerId) return
    const pane = filePaneRef.current
    if (!pane) return
    const rect = pane.getBoundingClientRect()
    const currentX = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
    const currentY = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    const moved = marqueeSelection.moved ||
      Math.abs(currentX - marqueeSelection.startX) > 5 ||
      Math.abs(currentY - marqueeSelection.startY) > 5
    setMarqueeSelection((current) => current
      ? { ...current, currentX, currentY, moved }
      : current)
  }

  const handleMarqueePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (!marqueeSelection?.active || marqueeSelection.pointerId !== event.pointerId) return
    const pane = filePaneRef.current
    event.currentTarget.releasePointerCapture?.(event.pointerId)

    if (pane && marqueeSelection.moved) {
      const paneRect = pane.getBoundingClientRect()
      const selectionRect = {
        left: paneRect.left + Math.min(marqueeSelection.startX, marqueeSelection.currentX),
        right: paneRect.left + Math.max(marqueeSelection.startX, marqueeSelection.currentX),
        top: paneRect.top + Math.min(marqueeSelection.startY, marqueeSelection.currentY),
        bottom: paneRect.top + Math.max(marqueeSelection.startY, marqueeSelection.currentY)
      }
      const selectedKeys = Array.from(pane.querySelectorAll<HTMLElement>('[data-media-selection-key]'))
        .filter((node) => rectsOverlap(selectionRect, node.getBoundingClientRect()))
        .map((node) => node.dataset.mediaSelectionKey || '')
        .filter(Boolean)

      setSelectedItemKeys((current) => {
        const next = marqueeSelection.additive ? new Set(current) : new Set<string>()
        selectedKeys.forEach((key) => next.add(key))
        return next
      })
    }

    setMarqueeSelection(null)
  }

  const handleUploadClick = () => {
    uploadInputRef.current?.click()
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return

    setUploading(true)
    let lastUploaded: MediaAsset | null = null
    let successCount = 0
    let failedCount = 0
    try {
      for (const file of files) {
        const { id: taskId, signal } = uploadQueue.addTask(file)
        try {
          const uploaded = await mediaService.uploadFile({
            file,
            module: 'media',
            folderPath: currentPath,
            isPublic: true,
            signal,
            onProgress: ({ percent }) => uploadQueue.setTaskProgress(taskId, percent)
          })
          uploadQueue.finishTask(taskId, 'complete', 'Subida completa')
          lastUploaded = uploaded
          successCount += 1
        } catch (uploadError) {
          if (isMediaUploadCancelledError(uploadError)) {
            uploadQueue.finishTask(taskId, 'error', 'Subida cancelada')
            continue
          }

          failedCount += 1
          uploadQueue.finishTask(
            taskId,
            'error',
            uploadError instanceof Error ? uploadError.message : 'No se pudo subir'
          )
        }
      }

      if (successCount > 0) {
        await refreshLibrary()
        if (lastUploaded) {
          const uploadedFile = toExplorerFile(lastUploaded)
          updateExplorerUrl({ path: uploadedFile.folderPath, asset: lastUploaded.id })
        }
        showToast(
          'success',
          successCount === 1 ? 'Archivo subido' : 'Archivos subidos',
          `${successCount === 1 ? 'Ya quedó' : `${successCount} archivos quedaron`} en ${currentPath ? currentPath.split('/').map(formatFolderSegment).join(' / ') : 'Mi unidad'}.`
        )
      }

      if (failedCount > 0) {
        showToast('error', 'Algunas subidas fallaron', `${failedCount} archivo${failedCount === 1 ? '' : 's'} no se pudo subir.`)
      }
    } finally {
      setUploading(false)
    }
  }

  const handleCopyLink = async (asset: MediaAsset) => {
    const url = getOpenUrl(asset)
    try {
      await navigator.clipboard.writeText(url)
      showToast('success', 'Link copiado', 'Ya puedes pegarlo donde lo necesites.')
    } catch {
      showToast('error', 'No se pudo copiar', 'Abre el archivo y copia la liga manualmente.')
    }
  }

  const handleOpenAsset = (asset: MediaAsset) => {
    window.open(getOpenUrl(asset), '_blank', 'noopener,noreferrer')
  }

  const downloadFiles = async (filesToDownload: ExplorerFile[], archiveFilename: string) => {
    if (!filesToDownload.length) {
      showToast('warning', 'No hay archivos', 'Selecciona al menos un archivo para descargar.')
      return
    }

    if (filesToDownload.length === 1) {
      const [file] = filesToDownload
      setDownloadingId(file.asset.id)
      try {
        await mediaService.downloadAsset(file.asset.id, file.fileName)
        showToast('success', 'Descarga iniciada', `${file.fileName} está en proceso.`)
      } catch (downloadError) {
        showToast('error', 'No se pudo descargar', downloadError instanceof Error ? downloadError.message : 'Intenta otra vez.')
      } finally {
        setDownloadingId(null)
      }
      return
    }

    setBulkAction('download')
    try {
      const entries: MediaDownloadEntry[] = filesToDownload.map((file) => ({
        id: file.asset.id,
        path: getArchiveEntryPath(file)
      }))
      await mediaService.downloadAssetsArchive(entries, archiveFilename)
      showToast('success', 'Descarga iniciada', `${filesToDownload.length} archivos van en un ZIP.`)
    } catch (downloadError) {
      showToast('error', 'No se pudo descargar', downloadError instanceof Error ? downloadError.message : 'Intenta otra vez.')
    } finally {
      setBulkAction(null)
    }
  }

  const handleDownloadAsset = (file: ExplorerFile) => {
    void downloadFiles([file], file.fileName)
  }

  const handleDownloadFolder = (folder: FolderSummary) => {
    setBulkAction('download')
    void mediaService.downloadAssetsArchive(
      { folderPaths: [folder.path], mediaType: mediaTypeFilter },
      buildArchiveFilename(folder.name)
    ).then(() => {
      showToast('success', 'Descarga iniciada', `${folder.filesCount} archivos van en un ZIP.`)
    }).catch((downloadError) => {
      showToast('error', 'No se pudo descargar', downloadError instanceof Error ? downloadError.message : 'Intenta otra vez.')
    }).finally(() => setBulkAction(null))
  }

  const handleDownloadSelected = () => {
    const selectedFolderNames = Array.from(selectedItemKeys)
      .map(selectedFolderPathFromKey)
      .filter(Boolean)
      .map((path) => getCurrentFolderLabel(path))
    const currentFolderName = selectedElementCount === 1 && selectedFolderNames[0]
      ? selectedFolderNames[0]
      : getCurrentFolderLabel(currentPath)
    const filename = selectedElementCount === 1
      ? buildArchiveFilename(currentFolderName)
      : buildArchiveFilename(`Media ${selectedFileCount} archivos`)
    if (selectedFolderPaths.length === 0 && selectedFiles.length === 1) {
      void downloadFiles(selectedFiles, selectedFiles[0].fileName)
      return
    }

    setBulkAction('download')
    void mediaService.downloadAssetsArchive(selectedScope, filename)
      .then(() => showToast('success', 'Descarga iniciada', `${selectedFileCount} archivos van en un ZIP.`))
      .catch((downloadError) => {
        showToast('error', 'No se pudo descargar', downloadError instanceof Error ? downloadError.message : 'Intenta otra vez.')
      })
      .finally(() => setBulkAction(null))
  }

  const deleteAsset = async (asset: MediaAsset) => {
    setDeletingId(asset.id)
    try {
      await mediaService.deleteAsset(asset.id)
      setAssets((current) => current.filter((item) => item.id !== asset.id))
      if (selectedAssetId === asset.id) setSelectedAssetId(null)
      setSelectedItemKeys((current) => {
        const next = new Set(current)
        next.delete(fileSelectionKey(asset.id))
        return next
      })
      await refreshLibrary()
      showToast('success', 'Archivo eliminado', 'Ya no aparecerá en Media.')
    } catch (deleteError) {
      showToast('error', 'No se pudo eliminar', deleteError instanceof Error ? deleteError.message : 'Intenta otra vez.')
    } finally {
      setDeletingId(null)
    }
  }

  const handleDeleteAsset = (asset: MediaAsset) => {
    showConfirm(
      'Eliminar archivo',
      `Se quitará ${getAssetDisplayName(asset)} de Media y del storage conectado. Esta acción no se puede deshacer.`,
      () => {
        void deleteAsset(asset)
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const deleteSelection = async (
    selection: MediaSelectionInput,
    filesToDelete: number,
    successTitle: string,
    successMessage: string
  ) => {
    if (!filesToDelete && !selection.folderPaths?.length) {
      showToast('warning', 'No hay elementos', 'Selecciona al menos un archivo o carpeta para eliminar.')
      return
    }

    setBulkAction('delete')
    try {
      await mediaService.deleteSelection(selection)
      setSelectedItemKeys(new Set())
      setSelectedAssetId(null)
      await refreshLibrary()
      showToast('success', successTitle, successMessage)
    } catch (deleteError) {
      await refreshLibrary()
      showToast('error', 'No se pudo eliminar', deleteError instanceof Error ? deleteError.message : 'Intenta otra vez.')
    } finally {
      setBulkAction(null)
    }
  }

  const handleDeleteFolder = (folder: FolderSummary) => {
    showConfirm(
      'Eliminar carpeta',
      folder.filesCount > 0
        ? `Se quitarán ${folder.filesCount} archivo${folder.filesCount === 1 ? '' : 's'} dentro de ${folder.name} de Media y del storage conectado. Esta acción no se puede deshacer.`
        : `Se eliminará la carpeta vacía ${folder.name}. Esta acción no se puede deshacer.`,
      () => {
        void deleteSelection(
          { folderPaths: [folder.path], mediaType: mediaTypeFilter },
          folder.filesCount,
          'Carpeta eliminada',
          `${folder.name} ya no aparecerá en Media.`
        )
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const handleDeleteSelected = () => {
    showConfirm(
      'Eliminar selección',
      selectedFileCount > 0
        ? `Se quitarán ${selectedFileCount} archivo${selectedFileCount === 1 ? '' : 's'} de Media y del storage conectado. Esta acción no se puede deshacer.`
        : `Se eliminarán ${selectedFolderPaths.length} carpeta${selectedFolderPaths.length === 1 ? '' : 's'} vacía${selectedFolderPaths.length === 1 ? '' : 's'}. Esta acción no se puede deshacer.`,
      () => {
        void deleteSelection(selectedScope, selectedFileCount, 'Selección eliminada', 'Los archivos seleccionados ya no aparecerán en Media.')
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const renderPreview = (file: ExplorerFile) => {
    const asset = file.asset
    if (asset.mediaType === 'image') {
      return <img src={buildFileUrl(asset, 'thumbnail')} alt={file.fileName} />
    }
    if (asset.mediaType === 'video') {
      return <video src={buildFileUrl(asset)} controls preload="metadata" />
    }
    if (asset.mediaType === 'audio') {
      return (
        <div className={styles.audioPreview}>
          <AudioLines size={42} />
          <audio src={buildFileUrl(asset)} controls />
        </div>
      )
    }
    return (
      <div className={styles.filePreviewIcon}>
        {getMediaIcon(asset.mediaType, 46)}
      </div>
    )
  }

  const stopItemEvent = (event: React.SyntheticEvent) => {
    event.stopPropagation()
  }

  const handleItemKeyDown = (event: React.KeyboardEvent<HTMLElement>, action: () => void) => {
    if (event.currentTarget !== event.target) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    action()
  }

  const renderSelectionCheckbox = (key: string, label: string) => (
    <input
      type="checkbox"
      className={styles.selectionCheckbox}
      checked={selectedItemKeys.has(key)}
      onClick={stopItemEvent}
      onChange={() => toggleSelection(key)}
      aria-label={label}
    />
  )

  const renderFolderActions = (folder: FolderSummary) => (
    <span className={styles.actionCell} onClick={stopItemEvent}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={styles.rowActionButton}
            aria-label={`Acciones para ${folder.name}`}
            disabled={Boolean(bulkAction)}
          >
            <MoreHorizontal size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => handleDownloadFolder(folder)}>
            <Download size={15} className={styles.menuItemIcon} />
            Descargar carpeta
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => handleMoveFolder(folder)}>
            <FolderInput size={15} className={styles.menuItemIcon} />
            Mover carpeta
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={styles.dangerMenuItem} onSelect={() => handleDeleteFolder(folder)}>
            <Trash2 size={15} className={styles.menuItemIcon} />
            Eliminar carpeta
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )

  const renderFileActions = (file: ExplorerFile) => {
    const asset = file.asset
    return (
      <span className={styles.actionCell} onClick={stopItemEvent}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={styles.rowActionButton}
              aria-label={`Acciones para ${file.fileName}`}
              disabled={Boolean(deletingId) || Boolean(bulkAction) || downloadingId === asset.id}
            >
              {downloadingId === asset.id ? <Loader2 size={16} className={styles.spin} /> : <MoreHorizontal size={16} />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void handleCopyLink(asset)}>
              <Copy size={15} className={styles.menuItemIcon} />
              Copiar enlace
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleDownloadAsset(file)}>
              <Download size={15} className={styles.menuItemIcon} />
              Descargar archivo
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleMoveFile(file)}>
              <FolderInput size={15} className={styles.menuItemIcon} />
              Mover a
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className={styles.dangerMenuItem} onSelect={() => handleDeleteAsset(asset)}>
              <Trash2 size={15} className={styles.menuItemIcon} />
              Eliminar archivo
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    )
  }

  const renderFolderButton = (folder: FolderSummary, variant: 'tile' | 'row') => {
    const selectionKey = folderSelectionKey(folder.path)
    const isChecked = selectedItemKeys.has(selectionKey)

    return (
      <div
        key={folder.path}
        role="button"
        tabIndex={0}
        className={cx(
          variant === 'tile' ? styles.folderTile : styles.listRow,
          isChecked && styles.itemChecked,
          dragOverFolderPath === folder.path && styles.folderDropActive
        )}
        data-media-item="true"
        data-media-selection-key={selectionKey}
        onClick={() => handleFolderOpen(folder.path)}
        onKeyDown={(event) => handleItemKeyDown(event, () => handleFolderOpen(folder.path))}
        onDragOver={(event) => handleFolderDragOver(event, folder.path)}
        onDragLeave={(event) => handleFolderDragLeave(event, folder.path)}
        onDrop={(event) => handleFolderDrop(event, folder.path)}
      >
        {variant === 'tile' ? (
          <>
            <span className={styles.tileControls}>
              {renderSelectionCheckbox(selectionKey, `Seleccionar carpeta ${folder.name}`)}
              {renderFolderActions(folder)}
            </span>
            <span className={styles.folderTileIcon}><Folder size={28} /></span>
            <span className={styles.folderTileText}>
              <strong>{folder.name}</strong>
              <small>{folder.filesCount} archivo{folder.filesCount === 1 ? '' : 's'}</small>
            </span>
          </>
        ) : (
          <>
            <span className={styles.selectionCell}>
              {renderSelectionCheckbox(selectionKey, `Seleccionar carpeta ${folder.name}`)}
            </span>
            <span className={styles.nameCell}>
              <span className={styles.rowIcon}><Folder size={18} /></span>
              <span>
                <strong>{folder.name}</strong>
                <small>Carpeta</small>
              </span>
            </span>
            <span>{folder.filesCount} archivo{folder.filesCount === 1 ? '' : 's'}</span>
            <span>{formatBytes(folder.sizeBytes)}</span>
            <span>Carpeta</span>
            {renderFolderActions(folder)}
          </>
        )}
      </div>
    )
  }

  const renderFileButton = (file: ExplorerFile, variant: 'tile' | 'row') => {
    const asset = file.asset
    const selected = selectedFile?.asset.id === asset.id
    const selectionKey = fileSelectionKey(asset.id)
    const isChecked = selectedItemKeys.has(selectionKey)
    const size = asset.quotaSize || asset.sizeProcessed || asset.sizeOriginal

    if (variant === 'tile') {
      return (
        <div
          key={asset.id}
          role="button"
          tabIndex={0}
          draggable={!actionBusy}
          data-media-item="true"
          data-media-selection-key={selectionKey}
          className={cx(styles.fileTile, selected && styles.itemSelected, isChecked && styles.itemChecked)}
          onClick={() => setSelectedAssetId(asset.id)}
          onDoubleClick={() => handleOpenAsset(asset)}
          onKeyDown={(event) => handleItemKeyDown(event, () => setSelectedAssetId(asset.id))}
          onDragStart={(event) => handleFileDragStart(event, file)}
          onDragEnd={handleFileDragEnd}
        >
          <span className={styles.tileControls}>
            {renderSelectionCheckbox(selectionKey, `Seleccionar archivo ${file.fileName}`)}
            {renderFileActions(file)}
          </span>
          <span className={styles.fileThumb}>
            {asset.mediaType === 'image'
              ? <img src={buildFileUrl(asset, 'thumbnail')} alt="" />
              : getMediaIcon(asset.mediaType, 28)}
          </span>
          <span className={styles.fileTileText}>
            <strong>{file.fileName}</strong>
            <small>{formatBytes(size)} · {formatModuleLabel(asset.module)}</small>
          </span>
        </div>
      )
    }

    return (
      <div
        key={asset.id}
        role="button"
        tabIndex={0}
        draggable={!actionBusy}
        data-media-item="true"
        data-media-selection-key={selectionKey}
        className={cx(styles.listRow, selected && styles.itemSelected, isChecked && styles.itemChecked)}
        onClick={() => setSelectedAssetId(asset.id)}
        onDoubleClick={() => handleOpenAsset(asset)}
        onKeyDown={(event) => handleItemKeyDown(event, () => setSelectedAssetId(asset.id))}
        onDragStart={(event) => handleFileDragStart(event, file)}
        onDragEnd={handleFileDragEnd}
      >
        <span className={styles.selectionCell}>
          {renderSelectionCheckbox(selectionKey, `Seleccionar archivo ${file.fileName}`)}
        </span>
        <span className={styles.nameCell}>
          <span className={styles.rowIcon}>{getMediaIcon(asset.mediaType, 18)}</span>
          <span>
            <strong>{file.fileName}</strong>
            <small>{file.folderPath ? file.folderPath.split('/').map(formatFolderSegment).join(' / ') : 'Mi unidad'}</small>
          </span>
        </span>
        <span>{formatDate(asset.createdAt)}</span>
        <span>{formatBytes(size)}</span>
        <span>{asset.mimeType || asset.mediaType || 'Archivo'}</span>
        {renderFileActions(file)}
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Configuración"
        title="Media"
        subtitle={`Explora el storage privado de esta cuenta. Las nuevas subidas se guardan en ${currentPath ? currentPath.split('/').map(formatFolderSegment).join(' / ') : 'Mi unidad'}.`}
        actions={(
          <>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={refreshing ? <Loader2 size={16} className={styles.spin} /> : <RefreshCw size={16} />}
              onClick={() => void refreshLibrary()}
              disabled={refreshing || uploading}
            >
              Actualizar
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<FolderPlus size={16} />}
              onClick={openCreateFolderDialog}
              disabled={loading || refreshing || creatingFolder || Boolean(normalizedQuery) || browsingGlobalType}
              title={normalizedQuery || browsingGlobalType ? 'Abre una carpeta desde Todo para crear otra dentro.' : 'Crear una carpeta en la ubicación actual'}
            >
              Nueva carpeta
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={uploading ? <Loader2 size={16} className={styles.spin} /> : <Upload size={16} />}
              onClick={handleUploadClick}
              disabled={uploading || loading}
              title={`Se guardará en ${currentPath ? currentPath.split('/').map(formatFolderSegment).join(' / ') : 'Mi unidad'}`}
            >
              Subir aquí
            </Button>
          </>
        )}
      />

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        onChange={handleFileUpload}
      />

      <MediaUploadTray
        tasks={uploadQueue.tasks}
        scope="page"
        onCancelTask={uploadQueue.cancelTask}
        onDismissTask={uploadQueue.dismissTask}
        onClearFinished={uploadQueue.clearFinished}
      />

      <section className={styles.usageStrip} aria-label="Uso de almacenamiento multimedia">
        <div className={styles.usageSummary}>
          <span>{formatStorageStatus(usage)}</span>
          <strong>{formatBytes(usage?.used_bytes)} usados</strong>
          <small>{formatBytes(usage?.available_bytes)} libres de {formatBytes(usage?.quota_bytes)}</small>
        </div>
        <div className={styles.usageMeter}>
          <span style={{ width: `${usagePercent}%` }} data-warning={usagePercent >= 80 ? 'true' : undefined} />
        </div>
        <div className={styles.usageNumbers}>
          <strong>{usagePercent}%</strong>
          <span>{filesCount} archivo{filesCount === 1 ? '' : 's'}</span>
        </div>
      </section>

      {showVideoAnalytics ? (
        <VideoAnalyticsPanel
          file={selectedVideoFile}
          analytics={videoAnalytics}
          loading={videoAnalyticsLoading}
          error={videoAnalyticsError}
          startDate={formatDateToISO(dateRange.start)}
          endDate={formatDateToISO(dateRange.end)}
          onDateRangeChange={(start, end) => setDateRange({
            start: parseLocalDateString(start),
            end: parseLocalDateString(end),
            preset: 'custom'
          })}
        />
      ) : null}

      <Card padding="none" className={styles.explorerCard}>
        <div className={styles.toolbar}>
          <SearchField
            className={styles.toolbarSearch}
            value={query}
            placeholder="Buscar archivos, carpetas o tipos"
            aria-label="Buscar archivos de Media"
            onChange={(nextQuery) => setQuery(nextQuery)}
            onClear={() => setQuery('')}
          />

          <TabList
            tabs={mediaTabs}
            activeTab={activeFilter}
            onTabChange={handleMediaFilterChange}
            variant="compact"
            className={styles.typeTabs}
          />

          <div className={styles.viewToggle} role="group" aria-label="Vista de archivos">
            <button
              type="button"
              className={viewMode === 'list' ? styles.viewToggleActive : ''}
              onClick={() => setViewMode('list')}
              aria-pressed={viewMode === 'list'}
              title="Vista de lista"
            >
              <List size={16} />
            </button>
            <button
              type="button"
              className={viewMode === 'grid' ? styles.viewToggleActive : ''}
              onClick={() => setViewMode('grid')}
              aria-pressed={viewMode === 'grid'}
              title="Vista de cuadrícula"
            >
              <Grid3X3 size={16} />
            </button>
          </div>
        </div>

        <div className={styles.breadcrumbBar}>
          {normalizedQuery ? (
            <span className={styles.searchResultLabel}>Resultados para "{query.trim()}"</span>
          ) : browsingGlobalType ? (
            <span className={styles.searchResultLabel}>{getMediaFilterLabel(activeFilter)} en toda la unidad</span>
          ) : (
            <nav className={styles.breadcrumbs} aria-label="Ruta actual">
              <button type="button" onClick={() => handleFolderOpen('')}>Mi unidad</button>
              {folderPathParts.map((segment, index) => {
                const path = folderPathParts.slice(0, index + 1).join('/')
                return (
                  <React.Fragment key={path}>
                    <ChevronRight size={14} />
                    <button type="button" onClick={() => handleFolderOpen(path)}>
                      {formatFolderSegment(segment)}
                    </button>
                  </React.Fragment>
                )
              })}
            </nav>
          )}
          <span>{visibleItemsCountLabel} elemento{visibleItemsCount === 1 ? '' : 's'}</span>
        </div>

        {error ? (
          <div className={styles.errorState}>
            <File size={26} />
            <strong>No se pudo abrir Media</strong>
            <p>{error}</p>
            <Button variant="secondary" size="sm" onClick={() => void refreshLibrary()}>
              Reintentar
            </Button>
          </div>
        ) : (
          <div className={styles.explorerLayout}>
            <aside className={styles.folderRail} aria-label="Carpetas principales">
              <button
                type="button"
                className={cx(
                  styles.folderNavItem,
                  !currentPath && styles.folderNavItemActive,
                  dragOverFolderPath === '' && styles.folderNavItemDropActive
                )}
                onClick={() => handleFolderOpen('')}
                onDragOver={(event) => handleFolderDragOver(event, '')}
                onDragLeave={(event) => handleFolderDragLeave(event, '')}
                onDrop={(event) => handleFolderDrop(event, '')}
              >
                <HardDrive size={17} />
                <span>Mi unidad</span>
                <small>{activeFilter === 'all' ? filesCount : libraryItemsCountLabel}</small>
              </button>
              {rootFolders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  className={cx(
                    styles.folderNavItem,
                    currentPath === folder.path && styles.folderNavItemActive,
                    dragOverFolderPath === folder.path && styles.folderNavItemDropActive
                  )}
                  onClick={() => handleFolderOpen(folder.path)}
                  onDragOver={(event) => handleFolderDragOver(event, folder.path)}
                  onDragLeave={(event) => handleFolderDragLeave(event, folder.path)}
                  onDrop={(event) => handleFolderDrop(event, folder.path)}
                >
                  <Folder size={17} />
                  <span>{folder.name}</span>
                  <small>{folder.filesCount}</small>
                </button>
              ))}
              {rootFolderPageInfo.hasMore ? (
                <Button variant="ghost" size="sm" onClick={() => void loadMoreRootFolders()}>
                  Más carpetas
                </Button>
              ) : null}
            </aside>

            <main
              ref={filePaneRef}
              className={styles.filePane}
              onPointerDown={handleMarqueePointerDown}
              onPointerMove={handleMarqueePointerMove}
              onPointerUp={handleMarqueePointerUp}
              onPointerCancel={handleMarqueePointerUp}
            >
              {marqueeBox ? (
                <span
                  className={styles.marqueeBox}
                  style={{
                    left: marqueeBox.left,
                    top: marqueeBox.top,
                    width: marqueeBox.width,
                    height: marqueeBox.height
                  }}
                  aria-hidden="true"
                />
              ) : null}
              <div className={styles.paneHeader}>
                <div>
                  <h2>{normalizedQuery ? 'Resultados' : browsingGlobalType ? getMediaFilterLabel(activeFilter) : getCurrentFolderLabel(currentPath)}</h2>
                  <p>{folderSummaries.length} carpeta{folderSummaries.length === 1 ? '' : 's'} · {libraryItemsCountLabel} archivo{libraryItemsCount === 1 ? '' : 's'}</p>
                </div>
                {selectedElementCount > 0 ? (
                  <div className={styles.selectionBar}>
                    <span>
                      {selectedElementCount} seleccionado{selectedElementCount === 1 ? '' : 's'} · {selectedFileCount} archivo{selectedFileCount === 1 ? '' : 's'}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      leftIcon={bulkAction === 'download' ? <Loader2 size={15} className={styles.spin} /> : <Download size={15} />}
                      onClick={handleDownloadSelected}
                      disabled={Boolean(bulkAction) || selectedFileCount === 0}
                    >
                      Descargar
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      leftIcon={moving ? <Loader2 size={15} className={styles.spin} /> : <FolderInput size={15} />}
                      onClick={handleMoveSelected}
                      disabled={actionBusy || selectedElementCount === 0}
                    >
                      Mover
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.deleteButton}
                      leftIcon={bulkAction === 'delete' ? <Loader2 size={15} className={styles.spin} /> : <Trash2 size={15} />}
                      onClick={handleDeleteSelected}
                      disabled={Boolean(bulkAction) || selectedElementCount === 0}
                    >
                      Eliminar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={clearSelection} disabled={Boolean(bulkAction)}>
                      Limpiar
                    </Button>
                  </div>
                ) : null}
              </div>

              {loading ? (
                <div className={styles.loadingRows} aria-label="Cargando archivos">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <span key={index} />
                  ))}
                </div>
              ) : folderSummaries.length === 0 && visibleFiles.length === 0 ? (
                <div className={styles.emptyState}>
                  <Folder size={34} />
                  <strong>{normalizedQuery ? 'No hay resultados' : 'Esta carpeta está vacía'}</strong>
                  <p>{normalizedQuery ? 'Prueba con otro nombre, tipo o módulo.' : 'Crea una subcarpeta o usa “Subir aquí” para guardar archivos en esta ubicación.'}</p>
                </div>
              ) : viewMode === 'grid' ? (
                <div className={styles.gridView}>
                  {folderSummaries.map((folder) => renderFolderButton(folder, 'tile'))}
                  {visibleFiles.map((file) => renderFileButton(file, 'tile'))}
                </div>
              ) : (
                <div className={styles.listView}>
                  <div className={styles.listHeader}>
                    <span className={styles.selectionCell}>
                      <input
                        type="checkbox"
                        className={styles.selectionCheckbox}
                        checked={allVisibleSelected}
                        ref={(node) => {
                          if (node) node.indeterminate = partiallySelected
                        }}
                        onChange={toggleVisibleSelection}
                        aria-label="Seleccionar elementos visibles"
                      />
                    </span>
                    <span>Nombre</span>
                    <span>Fecha</span>
                    <span>Tamaño</span>
                    <span>Tipo</span>
                    <span>Acciones</span>
                  </div>
                  {folderSummaries.map((folder) => renderFolderButton(folder, 'row'))}
                  {visibleFiles.map((file) => renderFileButton(file, 'row'))}
                </div>
              )}
              {folderPageInfo.hasMore ? (
                <div className={styles.paginationBar}>
                  <Button variant="ghost" size="sm" onClick={() => void loadMoreCurrentFolders()}>
                    Cargar más carpetas
                  </Button>
                </div>
              ) : null}
              {cursorHistory.length > 0 || assetPageInfo.hasMore ? (
                <div className={styles.paginationBar} aria-label="Paginación de archivos">
                  <span>Página {cursorHistory.length + 1}</span>
                  <div>
                    <Button variant="secondary" size="sm" onClick={handlePreviousPage} disabled={!cursorHistory.length || refreshing}>
                      Anterior
                    </Button>
                    <Button variant="secondary" size="sm" onClick={handleNextPage} disabled={!assetPageInfo.hasMore || refreshing}>
                      Siguiente
                    </Button>
                  </div>
                </div>
              ) : null}
            </main>

            <aside className={styles.previewPane} aria-label="Detalle del archivo seleccionado">
              {selectedFile ? (
                <>
                  <div className={styles.previewVisual}>
                    {renderPreview(selectedFile)}
                  </div>
                  <div className={styles.previewInfo}>
                    <h3>{selectedFile.fileName}</h3>
                    <p>{selectedFile.folderPath ? selectedFile.folderPath.split('/').map(formatFolderSegment).join(' / ') : 'Mi unidad'}</p>
                  </div>
                  <div className={styles.previewActions}>
                    <Button variant="secondary" size="sm" leftIcon={<ExternalLink size={15} />} onClick={() => handleOpenAsset(selectedFile.asset)}>
                      Abrir
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      leftIcon={downloadingId === selectedFile.asset.id ? <Loader2 size={15} className={styles.spin} /> : <Download size={15} />}
                      onClick={() => handleDownloadAsset(selectedFile)}
                      disabled={downloadingId === selectedFile.asset.id}
                    >
                      Descargar
                    </Button>
                    <Button variant="outline" size="sm" leftIcon={<Copy size={15} />} onClick={() => void handleCopyLink(selectedFile.asset)}>
                      Copiar link
                    </Button>
                  </div>
                  <dl className={styles.fileMeta}>
                    <div>
                      <dt>Tamaño</dt>
                      <dd>{formatBytes(selectedFile.asset.quotaSize || selectedFile.asset.sizeProcessed || selectedFile.asset.sizeOriginal)}</dd>
                    </div>
                    <div>
                      <dt>Tipo</dt>
                      <dd>{selectedFile.asset.mimeType || selectedFile.asset.mediaType || 'Archivo'}</dd>
                    </div>
                    <div>
                      <dt>Módulo</dt>
                      <dd>{formatModuleLabel(selectedFile.asset.module)}</dd>
                    </div>
                    <div>
                      <dt>Storage</dt>
                      <dd>{selectedFile.asset.storageProvider === 'bunny' ? 'Bunny.net' : (selectedFile.asset.storageProvider || 'Local')}</dd>
                    </div>
                    <div>
                      <dt>Creado</dt>
                      <dd>{formatDate(selectedFile.asset.createdAt)}</dd>
                    </div>
                  </dl>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.deleteButton}
                    leftIcon={deletingId === selectedFile.asset.id ? <Loader2 size={15} className={styles.spin} /> : <Trash2 size={15} />}
                    onClick={() => handleDeleteAsset(selectedFile.asset)}
                    disabled={Boolean(deletingId) || Boolean(bulkAction)}
                  >
                    Eliminar archivo
                  </Button>
                </>
              ) : (
                <div className={styles.previewEmpty}>
                  <File size={32} />
                  <strong>Selecciona un archivo</strong>
                  <p>Aquí verás vista previa, tamaño, tipo y acciones rápidas.</p>
                </div>
              )}
            </aside>
          </div>
        )}
      </Card>

      <Modal
        isOpen={createFolderOpen}
        onClose={closeCreateFolderDialog}
        title="Nueva carpeta"
        subtitle={`Dentro de ${currentPath ? currentPath.split('/').map(formatFolderSegment).join(' / ') : 'Mi unidad'}`}
        size="sm"
      >
        <form className={styles.createFolderForm} onSubmit={handleCreateFolder}>
          <label className={styles.createFolderField} htmlFor="media-folder-name">
            <span>Nombre de la carpeta</span>
            <input
              id="media-folder-name"
              type="text"
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              placeholder="Ej. Lanzamiento de agosto"
              maxLength={120}
              autoFocus
              autoComplete="off"
              disabled={creatingFolder}
            />
          </label>
          <p>Esta ruta siempre quedará dentro del espacio privado de este negocio.</p>
          <div className={styles.createFolderActions}>
            <Button variant="secondary" size="sm" type="button" onClick={closeCreateFolderDialog} disabled={creatingFolder}>
              Cancelar
            </Button>
            <Button variant="primary" size="sm" type="submit" loading={creatingFolder} disabled={!folderName.trim()}>
              Crear carpeta
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(moveDialog)}
        onClose={closeMoveDialog}
        title={moveDialog?.title || 'Mover archivos'}
        size="md"
        contentClassName={styles.moveModalContent}
      >
        {moveDialog ? (
          <div className={styles.moveModal}>
            <p className={styles.moveIntro}>
              {moveDialog.kind === 'folder'
                ? `La carpeta completa se moverá a ${moveTargetPath ? moveTargetPath.split('/').map(formatFolderSegment).join(' / ') : 'Mi unidad'}.`
                : `${moveDialog.filesCount} archivo${moveDialog.filesCount === 1 ? '' : 's'} se moverán a ${moveTargetPath ? moveTargetPath.split('/').map(formatFolderSegment).join(' / ') : 'Mi unidad'}.`}
            </p>
            <div className={styles.moveFolderList} aria-label="Carpeta destino">
              {moveTargetPath ? (
                <button
                  type="button"
                  className={styles.moveFolderOption}
                  disabled={moving || moveFoldersLoading}
                  onClick={() => openMoveFolderPath(pathSegments(moveTargetPath).slice(0, -1).join('/'))}
                >
                  <span className={styles.rowIcon}><ChevronRight size={18} /></span>
                  <span className={styles.moveFolderMeta}>
                    <strong>Subir un nivel</strong>
                    <small>{pathSegments(moveTargetPath).slice(0, -1).map(formatFolderSegment).join(' / ') || 'Mi unidad'}</small>
                  </span>
                </button>
              ) : null}
              {moveFoldersLoading && moveFolders.length === 0 ? (
                <div className={styles.moveFoldersLoading}><Loader2 size={18} className={styles.spin} /></div>
              ) : moveFolders.map((folder) => {
                const createsCycle = moveDialog.folderPaths.some((sourcePath) => (
                  folder.path === sourcePath || folder.path.startsWith(`${sourcePath}/`)
                ))
                return (
                  <button
                    key={folder.path}
                    type="button"
                    className={cx(styles.moveFolderOption, createsCycle && styles.moveFolderOptionDisabled)}
                    disabled={createsCycle || moving || moveFoldersLoading}
                    onClick={() => openMoveFolderPath(folder.path)}
                  >
                    <span className={styles.rowIcon}><Folder size={18} /></span>
                    <span className={styles.moveFolderMeta}>
                      <strong>{formatFolderSegment(folder.name)}</strong>
                      <small>{folder.filesCount} archivo{folder.filesCount === 1 ? '' : 's'}</small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                )
              })}
              {moveFolderPageInfo.hasMore ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={moveFoldersLoading || !moveFolderPageInfo.nextCursor}
                  onClick={() => void loadMoveFolders(moveTargetPath, moveFolderPageInfo.nextCursor || '', true)}
                >
                  Cargar más carpetas
                </Button>
              ) : null}
            </div>
            <div className={styles.moveModalFooter}>
              <Button variant="secondary" size="sm" onClick={closeMoveDialog} disabled={moving}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={moving ? <Loader2 size={15} className={styles.spin} /> : <FolderInput size={15} />}
                onClick={() => void moveFiles(moveDialog, moveTargetPath)}
                disabled={moving || isMoveTargetDisabled(moveDialog, moveTargetPath)}
              >
                Mover
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

interface VideoAnalyticsPanelProps {
  file: ExplorerFile | null
  analytics: MediaStreamAnalytics | null
  loading: boolean
  error: string
  startDate: string
  endDate: string
  onDateRangeChange: (start: string, end: string) => void
}

const VideoAnalyticsPanel: React.FC<VideoAnalyticsPanelProps> = ({
  file,
  analytics,
  loading,
  error,
  startDate,
  endDate,
  onDateRangeChange
}) => {
  const asset = file?.asset || null
  const stream = getStreamRecord(asset)
  const video = getStreamVideoRecord(asset)
  const streamVideoId = readString(stream.videoId)
  const fallbackViews = readNumber(video.views)
  const fallbackWatchTime = readNumber(video.totalWatchTime)
  const fallbackAverageWatchTime = readNumber(video.averageWatchTime)
  const views = analytics?.summary.views ?? fallbackViews
  const watchTime = analytics?.summary.watchTime ?? fallbackWatchTime
  const averageWatchTime = analytics?.summary.averageWatchTime ?? fallbackAverageWatchTime
  const engagementScore = analytics?.summary.engagementScore ?? null
  const viewsChart = chartPoints(analytics?.viewsChart || [], 'count')
  const watchTimeChart = chartPoints(analytics?.watchTimeChart || [], 'seconds')
  const heatmap = analytics?.heatmap || []
  const countries = analytics?.countries || []
  const title = file?.fileName || 'Sin video seleccionado'

  return (
    <section className={styles.videoAnalyticsPanel} aria-label="Analíticas de video" aria-busy={loading}>
      <div className={styles.videoAnalyticsHeader}>
        <div>
          <span className={styles.videoAnalyticsEyebrow}>
            <BarChart3 size={14} />
            Bunny Stream
          </span>
          <h2>{title}</h2>
          <p>{streamVideoId ? `Video listo para métricas · ${streamVideoId}` : 'Selecciona un video sincronizado para ver reproducción, países y retención.'}</p>
        </div>
        <div className={styles.videoAnalyticsActions}>
          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onChange={onDateRangeChange}
          />
        </div>
      </div>

      <div className={styles.videoAnalyticsKpis}>
        <div>
          <Eye size={16} />
          <span>Reproducciones</span>
          <strong>{formatCompactNumber(views)}</strong>
        </div>
        <div>
          <Clock3 size={16} />
          <span>Tiempo visto</span>
          <strong>{formatSeconds(watchTime)}</strong>
        </div>
        <div>
          <PlayCircle size={16} />
          <span>Promedio</span>
          <strong>{formatSeconds(averageWatchTime)}</strong>
        </div>
        <div>
          <Flame size={16} />
          <span>Engagement</span>
          <strong>{engagementScore === null ? 'Sin dato' : `${Math.round(engagementScore)}%`}</strong>
        </div>
      </div>

      {!file ? (
        <div className={styles.videoAnalyticsEmpty}>
          <FileVideo size={24} />
          <strong>No hay video seleccionado</strong>
          <p>Abre Videos o selecciona un archivo de video para ver sus métricas.</p>
        </div>
      ) : !streamVideoId ? (
        <div className={styles.videoAnalyticsEmpty}>
          <Activity size={24} />
          <strong>Sin Stream todavía</strong>
          <p>Este video está en storage, pero todavía no tiene métricas de reproducción disponibles.</p>
        </div>
      ) : error ? (
        <div className={styles.videoAnalyticsEmpty}>
          <AlertTriangleIcon />
          <strong>No se cargaron las analíticas</strong>
          <p>{error}</p>
        </div>
      ) : (
        <div className={styles.videoAnalyticsGrid}>
          <div className={styles.videoChartBlock}>
            <div className={styles.videoChartTitle}>
              <span>Reproducciones</span>
              <strong>{formatCompactNumber(views)}</strong>
            </div>
            {viewsChart.length ? (
              <AreaChart
                data={viewsChart}
                height={220}
                showLegend={false}
                formatValue={(value) => formatCompactNumber(value)}
                formatTooltipValue={(value) => `${formatCompactNumber(value)} reproducciones`}
              />
            ) : (
              <div className={styles.videoChartEmpty}>Sin reproducciones en este periodo.</div>
            )}
          </div>

          <div className={styles.videoChartBlock}>
            <div className={styles.videoChartTitle}>
              <span>Tiempo visto</span>
              <strong>{formatSeconds(watchTime)}</strong>
            </div>
            {watchTimeChart.length ? (
              <AreaChart
                data={watchTimeChart}
                height={220}
                color="var(--pos)"
                showLegend={false}
                formatValue={(value) => `${formatCompactNumber(value)}m`}
                formatTooltipValue={(value) => `${formatCompactNumber(value)} min vistos`}
              />
            ) : (
              <div className={styles.videoChartEmpty}>Sin tiempo visto en este periodo.</div>
            )}
          </div>

          <div className={styles.videoChartBlock}>
            <div className={styles.videoChartTitle}>
              <span>Retención</span>
              <strong>{heatmap.length ? `${heatmap.length} puntos` : 'Sin dato'}</strong>
            </div>
            {heatmap.length ? (
              <div className={styles.videoHeatmapBars} aria-label="Mapa de retención del video">
                {heatmap.map((point, index) => (
                  <span
                    key={`${point.segment}-${index}`}
                    title={`${point.label || point.segment}: ${Math.round(point.intensity)}%`}
                    style={{ height: `${Math.max(6, point.intensity)}%` }}
                  />
                ))}
              </div>
            ) : (
              <div className={styles.videoChartEmpty}>Sin heatmap disponible todavía.</div>
            )}
          </div>

          <div className={styles.videoChartBlock}>
            <div className={styles.videoChartTitle}>
              <span>Países</span>
              <strong>{analytics?.summary.topCountry || 'Sin dato'}</strong>
            </div>
            {countries.length ? (
              <div className={styles.videoCountryList}>
                {countries.slice(0, 5).map((country) => (
                  <div key={country.country}>
                    <Globe2 size={15} />
                    <span>{country.country}</span>
                    <strong>{formatCompactNumber(country.views)}</strong>
                    <small>{formatSeconds(country.watchTime)}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.videoChartEmpty}>Sin países registrados.</div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

const AlertTriangleIcon = () => (
  <span className={styles.videoAnalyticsErrorIcon}>
    <X size={16} />
  </span>
)
