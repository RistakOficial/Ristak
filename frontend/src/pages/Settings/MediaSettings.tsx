import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type MediaDownloadEntry,
  type MediaMoveEntry,
  type MediaStreamAnalytics,
  type StorageUsage,
  type StreamChartPoint
} from '@/services/mediaService'
import { formatDateToISO, parseLocalDateString } from '@/utils/format'
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

interface ExplorerFile {
  asset: MediaAsset
  fileName: string
  folderPath: string
  folderSegments: string[]
  searchText: string
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
  files: ExplorerFile[]
  sourceFolderPath?: string
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
  if (!value) return 'Sin fecha'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Sin fecha'
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
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
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('es-MX', compact
    ? { day: '2-digit', month: 'short' }
    : { day: '2-digit', month: 'short', hour: '2-digit' }
  ).format(date)
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

function normalizeAssetPath(asset: MediaAsset) {
  const rawParts = (asset.bunnyPath || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)

  let parts = rawParts
  if (rawParts[0] === 'businesses') {
    parts = rawParts.slice(rawParts.length > 2 ? 2 : 1)
  }

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
  const searchText = [
    fileName,
    folderPath,
    asset.mimeType,
    asset.mediaType,
    asset.module,
    asset.storageProvider,
    asset.bunnyPath
  ].filter(Boolean).join(' ').toLowerCase()

  return {
    asset,
    fileName,
    folderPath,
    folderSegments,
    searchText
  }
}

function pathSegments(path: string) {
  return path.split('/').filter(Boolean)
}

function fileMatchesPath(file: ExplorerFile, currentPath: string) {
  return file.folderPath === currentPath
}

function fileStartsWithPath(file: ExplorerFile, currentPath: string) {
  const current = pathSegments(currentPath)
  return current.every((segment, index) => file.folderSegments[index] === segment)
}

function buildFolderSummaries(files: ExplorerFile[], currentPath: string): FolderSummary[] {
  const current = pathSegments(currentPath)
  const folders = new Map<string, FolderSummary>()

  files.forEach((file) => {
    if (!fileStartsWithPath(file, currentPath)) return
    const nextSegment = file.folderSegments[current.length]
    if (!nextSegment) return
    const nextPath = [...current, nextSegment].join('/')
    const existing = folders.get(nextPath) || {
      path: nextPath,
      name: formatFolderSegment(nextSegment),
      filesCount: 0,
      sizeBytes: 0
    }
    existing.filesCount += 1
    existing.sizeBytes += Number(file.asset.quotaSize || file.asset.sizeProcessed || file.asset.sizeOriginal || 0)
    folders.set(nextPath, existing)
  })

  return Array.from(folders.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'))
}

function buildAllFolderSummaries(files: ExplorerFile[]): FolderSummary[] {
  const folders = new Map<string, FolderSummary>()

  files.forEach((file) => {
    file.folderSegments.forEach((_, index) => {
      const path = file.folderSegments.slice(0, index + 1).join('/')
      const existing = folders.get(path) || {
        path,
        name: file.folderSegments.slice(0, index + 1).map(formatFolderSegment).join(' / '),
        filesCount: 0,
        sizeBytes: 0
      }
      existing.filesCount += 1
      existing.sizeBytes += Number(file.asset.quotaSize || file.asset.sizeProcessed || file.asset.sizeOriginal || 0)
      folders.set(path, existing)
    })
  })

  return Array.from(folders.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'))
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

function relativeFolderPath(filePath: string, sourceFolderPath: string) {
  if (!sourceFolderPath) return filePath
  if (filePath === sourceFolderPath) return ''
  return filePath.startsWith(`${sourceFolderPath}/`)
    ? filePath.slice(sourceFolderPath.length + 1)
    : filePath
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
  const uploadQueue = useMediaUploadQueue()
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const filePaneRef = useRef<HTMLElement>(null)
  const [assets, setAssets] = useState<MediaAsset[]>([])
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
  const [activeFilter, setActiveFilter] = useUrlStringState<MediaFilter>('type', 'all', isMediaFilter)
  const [storedViewMode, saveStoredViewMode] = useAppConfig<string>(
    MEDIA_VIEW_MODE_CONFIG_KEY,
    MEDIA_DEFAULT_VIEW_MODE
  )
  const savedViewMode = isViewMode(storedViewMode) ? storedViewMode : MEDIA_DEFAULT_VIEW_MODE
  const [viewMode, setViewModeState] = useState<ViewMode>(savedViewMode)
  const viewModeRef = useRef(viewMode)
  const viewModeSaveVersionRef = useRef(0)
  const [currentPath, setCurrentPath] = useUrlStringState<string>('path', '', isQueryParam)
  const [selectedAssetParam, setSelectedAssetParam] = useUrlStringState<string>('asset', '', isQueryParam)
  const selectedAssetId = selectedAssetParam || null
  const setSelectedAssetId = useCallback((value: string | null) => {
    setSelectedAssetParam(value || '')
  }, [setSelectedAssetParam])
  const [selectedItemKeys, setSelectedItemKeys] = useState<Set<string>>(() => new Set())
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null)
  const [moveTargetPath, setMoveTargetPath] = useState('')
  const [draggingFileIds, setDraggingFileIds] = useState<string[]>([])
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null)
  const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelectionState | null>(null)
  const [videoAnalytics, setVideoAnalytics] = useState<MediaStreamAnalytics | null>(null)
  const [videoAnalyticsLoading, setVideoAnalyticsLoading] = useState(false)
  const [videoAnalyticsError, setVideoAnalyticsError] = useState('')

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

  const loadMedia = useCallback(async (mode: 'initial' | 'refresh' = 'refresh') => {
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    setError('')

    try {
      const [nextAssets, nextUsage] = await Promise.all([
        mediaService.listAllAssets(),
        mediaService.getStorageUsage()
      ])
      setAssets(nextAssets)
      setUsage(nextUsage)
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'No se pudo cargar Media.'
      setError(message)
      showToast('error', 'No se cargó Media', message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [showToast])

  useEffect(() => {
    void loadMedia('initial')
  }, [loadMedia])

  const files = useMemo(() => assets.map(toExplorerFile), [assets])
  const filesById = useMemo(() => new Map(files.map((file) => [file.asset.id, file])), [files])
  const allFolderPaths = useMemo(() => {
    const folders = new Set<string>()
    files.forEach((file) => {
      file.folderSegments.forEach((_, index) => {
        folders.add(file.folderSegments.slice(0, index + 1).join('/'))
      })
    })
    return folders
  }, [files])
  const typeFilteredFiles = useMemo(() => (
    activeFilter === 'all'
      ? files
      : files.filter((file) => file.asset.mediaType === activeFilter)
  ), [activeFilter, files])
  const normalizedQuery = query.trim().toLowerCase()
  const visibleFiles = useMemo(() => {
    const scopedFiles = normalizedQuery
      ? typeFilteredFiles.filter((file) => file.searchText.includes(normalizedQuery))
      : typeFilteredFiles.filter((file) => fileMatchesPath(file, currentPath))

    return [...scopedFiles].sort((a, b) => {
      const aDate = new Date(a.asset.updatedAt || a.asset.createdAt || 0).getTime()
      const bDate = new Date(b.asset.updatedAt || b.asset.createdAt || 0).getTime()
      return bDate - aDate
    })
  }, [currentPath, normalizedQuery, typeFilteredFiles])
  const folderSummaries = useMemo(() => (
    normalizedQuery ? [] : buildFolderSummaries(typeFilteredFiles, currentPath)
  ), [currentPath, normalizedQuery, typeFilteredFiles])
  const rootFolders = useMemo(() => buildFolderSummaries(typeFilteredFiles, ''), [typeFilteredFiles])
  const allFolderOptions = useMemo(() => buildAllFolderSummaries(files), [files])
  const visibleSelectionKeys = useMemo(() => [
    ...folderSummaries.map((folder) => folderSelectionKey(folder.path)),
    ...visibleFiles.map((file) => fileSelectionKey(file.asset.id))
  ], [folderSummaries, visibleFiles])
  const selectedFiles = useMemo(() => {
    const selected = new Map<string, ExplorerFile>()

    selectedItemKeys.forEach((key) => {
      const assetId = selectedFileIdFromKey(key)
      if (assetId) {
        const file = filesById.get(assetId)
        if (file) selected.set(assetId, file)
        return
      }

      const folderPath = selectedFolderPathFromKey(key)
      if (folderPath) {
        files
          .filter((file) => fileStartsWithPath(file, folderPath))
          .forEach((file) => selected.set(file.asset.id, file))
      }
    })

    return Array.from(selected.values())
  }, [files, filesById, selectedItemKeys])
  const selectedFile = useMemo(() => (
    files.find((file) => file.asset.id === selectedAssetId) || visibleFiles[0] || null
  ), [files, selectedAssetId, visibleFiles])
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
  const folderPathParts = pathSegments(currentPath)
  const selectedFileCount = selectedFiles.length
  const selectedElementCount = selectedItemKeys.size
  const allVisibleSelected = visibleSelectionKeys.length > 0 && visibleSelectionKeys.every((key) => selectedItemKeys.has(key))
  const partiallySelected = !allVisibleSelected && visibleSelectionKeys.some((key) => selectedItemKeys.has(key))
  const actionBusy = Boolean(bulkAction) || moving
  const moveDestinationOptions = useMemo<FolderSummary[]>(() => [
    {
      path: '',
      name: 'Mi unidad',
      filesCount: files.length,
      sizeBytes: files.reduce((total, file) => total + Number(file.asset.quotaSize || file.asset.sizeProcessed || file.asset.sizeOriginal || 0), 0)
    },
    ...allFolderOptions
  ], [allFolderOptions, files])
  const marqueeBox = marqueeSelection && marqueeSelection.moved
    ? {
        left: Math.min(marqueeSelection.startX, marqueeSelection.currentX),
        top: Math.min(marqueeSelection.startY, marqueeSelection.currentY),
        width: Math.abs(marqueeSelection.currentX - marqueeSelection.startX),
        height: Math.abs(marqueeSelection.currentY - marqueeSelection.startY)
      }
    : null

  useEffect(() => {
    setSelectedItemKeys((current) => {
      let changed = false
      const next = new Set<string>()

      current.forEach((key) => {
        const assetId = selectedFileIdFromKey(key)
        if (assetId) {
          if (filesById.has(assetId)) next.add(key)
          else changed = true
          return
        }

        const folderPath = selectedFolderPathFromKey(key)
        if (folderPath && allFolderPaths.has(folderPath)) {
          next.add(key)
        } else {
          changed = true
        }
      })

      return changed ? next : current
    })
  }, [allFolderPaths, filesById])

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
    setCurrentPath(path)
    setSelectedAssetId(null)
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

  const filesInsideFolder = (folderPath: string) => (
    files.filter((file) => fileStartsWithPath(file, folderPath))
  )

  const filesByIds = (assetIds: string[]) => {
    const uniqueIds = new Set(assetIds)
    return files.filter((file) => uniqueIds.has(file.asset.id))
  }

  const isMoveTargetDisabled = (dialog: MoveDialogState | null, targetPath: string) => {
    if (!dialog || dialog.files.length === 0) return true
    if (dialog.kind === 'folder' && dialog.sourceFolderPath) {
      const sourceParentPath = pathSegments(dialog.sourceFolderPath).slice(0, -1).join('/')
      if (targetPath === sourceParentPath) return true
      if (targetPath === dialog.sourceFolderPath) return true
      if (targetPath.startsWith(`${dialog.sourceFolderPath}/`)) return true
    }
    return dialog.files.every((file) => file.folderPath === targetPath)
  }

  const openMoveDialog = (dialog: MoveDialogState) => {
    const firstValidTarget = ['', ...allFolderOptions.map((folder) => folder.path)]
      .find((path) => !isMoveTargetDisabled(dialog, path)) || ''
    setMoveDialog(dialog)
    setMoveTargetPath(firstValidTarget)
  }

  const closeMoveDialog = () => {
    if (moving) return
    setMoveDialog(null)
    setMoveTargetPath('')
  }

  const buildMoveEntries = (dialog: MoveDialogState, targetFolderPath: string): MediaMoveEntry[] => {
    if (dialog.kind === 'folder' && dialog.sourceFolderPath) {
      const sourceFolderPath = dialog.sourceFolderPath
      const folderName = pathSegments(sourceFolderPath).slice(-1)[0] || getCurrentFolderLabel(sourceFolderPath)
      return dialog.files.map((file) => ({
        id: file.asset.id,
        targetFolderPath: joinFolderPath(
          targetFolderPath,
          folderName,
          relativeFolderPath(file.folderPath, sourceFolderPath)
        )
      }))
    }

    if (dialog.kind === 'selection') {
      const entriesById = new Map<string, MediaMoveEntry>()

      selectedItemKeys.forEach((key) => {
        const folderPath = selectedFolderPathFromKey(key)
        if (!folderPath) return
        const folderName = pathSegments(folderPath).slice(-1)[0] || getCurrentFolderLabel(folderPath)
        filesInsideFolder(folderPath).forEach((file) => {
          entriesById.set(file.asset.id, {
            id: file.asset.id,
            targetFolderPath: joinFolderPath(
              targetFolderPath,
              folderName,
              relativeFolderPath(file.folderPath, folderPath)
            )
          })
        })
      })

      selectedItemKeys.forEach((key) => {
        const assetId = selectedFileIdFromKey(key)
        if (!assetId || entriesById.has(assetId)) return
        entriesById.set(assetId, { id: assetId, targetFolderPath })
      })

      return Array.from(entriesById.values())
    }

    return dialog.files.map((file) => ({
      id: file.asset.id,
      targetFolderPath
    }))
  }

  const moveFiles = async (dialog: MoveDialogState, targetFolderPath: string) => {
    if (isMoveTargetDisabled(dialog, targetFolderPath)) {
      showToast('warning', 'Elige otra carpeta', 'Selecciona una carpeta distinta para mover los archivos.')
      return
    }

    const entries = buildMoveEntries(dialog, targetFolderPath)
    if (!entries.length) {
      showToast('warning', 'No hay archivos', 'Selecciona al menos un archivo para mover.')
      return
    }

    setMoving(true)
    try {
      const movedAssets = await mediaService.moveAssets(entries, targetFolderPath)
      const movedById = new Map(movedAssets.map((asset) => [asset.id, asset]))
      setAssets((current) => current.map((asset) => movedById.get(asset.id) || asset))
      setSelectedItemKeys(new Set())
      if (movedAssets[0]) {
        const movedFile = toExplorerFile(movedAssets[0])
        setCurrentPath(movedFile.folderPath)
        setSelectedAssetId(movedAssets[0].id)
      }
      await loadMedia('refresh')
      showToast('success', 'Archivos movidos', `${movedAssets.length} archivo${movedAssets.length === 1 ? '' : 's'} quedaron en la carpeta elegida.`)
      setMoveDialog(null)
      setMoveTargetPath('')
    } catch (moveError) {
      await loadMedia('refresh')
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
      title: `Mover ${selectedFileCount} archivo${selectedFileCount === 1 ? '' : 's'}`,
      files: selectedFiles
    })
  }

  const handleMoveFile = (file: ExplorerFile) => {
    openMoveDialog({
      kind: 'files',
      title: `Mover ${file.fileName}`,
      files: [file]
    })
  }

  const handleMoveFolder = (folder: FolderSummary) => {
    openMoveDialog({
      kind: 'folder',
      title: `Mover carpeta ${folder.name}`,
      files: filesInsideFolder(folder.path),
      sourceFolderPath: folder.path
    })
  }

  const moveDraggedFilesToFolder = (targetFolderPath: string, assetIds = draggingFileIds) => {
    const draggedFiles = filesByIds(assetIds)
    if (!draggedFiles.length) return
    void moveFiles({
      kind: 'files',
      title: 'Mover archivos',
      files: draggedFiles
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
        await loadMedia('refresh')
        if (lastUploaded) {
          const uploadedFile = toExplorerFile(lastUploaded)
          setCurrentPath(uploadedFile.folderPath)
          setSelectedAssetId(lastUploaded.id)
        }
        showToast(
          'success',
          successCount === 1 ? 'Archivo subido' : 'Archivos subidos',
          successCount === 1 ? 'Ya aparece en Media.' : `${successCount} archivos ya aparecen en Media.`
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
    void downloadFiles(filesInsideFolder(folder.path), buildArchiveFilename(folder.name))
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
    void downloadFiles(selectedFiles, filename)
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
      await loadMedia('refresh')
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

  const deleteFiles = async (filesToDelete: ExplorerFile[], successTitle: string, successMessage: string) => {
    if (!filesToDelete.length) {
      showToast('warning', 'No hay archivos', 'Selecciona al menos un archivo para eliminar.')
      return
    }

    setBulkAction('delete')
    const deletedIds = new Set<string>()
    try {
      for (const file of filesToDelete) {
        await mediaService.deleteAsset(file.asset.id)
        deletedIds.add(file.asset.id)
      }
      setAssets((current) => current.filter((item) => !deletedIds.has(item.id)))
      setSelectedItemKeys(new Set())
      if (selectedAssetId && deletedIds.has(selectedAssetId)) setSelectedAssetId(null)
      await loadMedia('refresh')
      showToast('success', successTitle, successMessage)
    } catch (deleteError) {
      await loadMedia('refresh')
      showToast('error', 'No se pudo eliminar', deleteError instanceof Error ? deleteError.message : 'Intenta otra vez.')
    } finally {
      setBulkAction(null)
    }
  }

  const handleDeleteFolder = (folder: FolderSummary) => {
    const filesToDelete = filesInsideFolder(folder.path)
    showConfirm(
      'Eliminar carpeta',
      `Se quitarán ${filesToDelete.length} archivo${filesToDelete.length === 1 ? '' : 's'} dentro de ${folder.name} de Media y del storage conectado. Esta acción no se puede deshacer.`,
      () => {
        void deleteFiles(filesToDelete, 'Carpeta eliminada', `${folder.name} ya no aparecerá en Media.`)
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
      `Se quitarán ${selectedFileCount} archivo${selectedFileCount === 1 ? '' : 's'} de Media y del storage conectado. Esta acción no se puede deshacer.`,
      () => {
        void deleteFiles(selectedFiles, 'Selección eliminada', 'Los archivos seleccionados ya no aparecerán en Media.')
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
        subtitle="Explora los archivos multimedia guardados en el storage de esta cuenta."
        actions={(
          <>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={refreshing ? <Loader2 size={16} className={styles.spin} /> : <RefreshCw size={16} />}
              onClick={() => void loadMedia('refresh')}
              disabled={refreshing || uploading}
            >
              Actualizar
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={uploading ? <Loader2 size={16} className={styles.spin} /> : <Upload size={16} />}
              onClick={handleUploadClick}
              disabled={uploading || loading}
            >
              Subir archivo
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
            onTabChange={(value) => setActiveFilter(value as MediaFilter)}
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
          <span>{folderSummaries.length + visibleFiles.length} elemento{folderSummaries.length + visibleFiles.length === 1 ? '' : 's'}</span>
        </div>

        {error ? (
          <div className={styles.errorState}>
            <File size={26} />
            <strong>No se pudo abrir Media</strong>
            <p>{error}</p>
            <Button variant="secondary" size="sm" onClick={() => void loadMedia('refresh')}>
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
                <small>{typeFilteredFiles.length}</small>
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
                  <h2>{normalizedQuery ? 'Resultados' : getCurrentFolderLabel(currentPath)}</h2>
                  <p>{folderSummaries.length} carpeta{folderSummaries.length === 1 ? '' : 's'} · {visibleFiles.length} archivo{visibleFiles.length === 1 ? '' : 's'}</p>
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
                      disabled={actionBusy || selectedFileCount === 0}
                    >
                      Mover
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.deleteButton}
                      leftIcon={bulkAction === 'delete' ? <Loader2 size={15} className={styles.spin} /> : <Trash2 size={15} />}
                      onClick={handleDeleteSelected}
                      disabled={Boolean(bulkAction) || selectedFileCount === 0}
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
                  <p>{normalizedQuery ? 'Prueba con otro nombre, tipo o módulo.' : 'Sube archivos o abre otra carpeta.'}</p>
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
        isOpen={Boolean(moveDialog)}
        onClose={closeMoveDialog}
        title={moveDialog?.title || 'Mover archivos'}
        size="md"
        contentClassName={styles.moveModalContent}
      >
        {moveDialog ? (
          <div className={styles.moveModal}>
            <p className={styles.moveIntro}>
              {moveDialog.files.length} archivo{moveDialog.files.length === 1 ? '' : 's'} se moverán a:
            </p>
            <div className={styles.moveFolderList} role="radiogroup" aria-label="Carpeta destino">
              {moveDestinationOptions.map((folder) => {
                const disabled = isMoveTargetDisabled(moveDialog, folder.path)
                const active = moveTargetPath === folder.path
                return (
                  <button
                    key={folder.path || 'root'}
                    type="button"
                    className={cx(
                      styles.moveFolderOption,
                      active && styles.moveFolderOptionActive,
                      disabled && styles.moveFolderOptionDisabled
                    )}
                    disabled={disabled || moving}
                    onClick={() => setMoveTargetPath(folder.path)}
                    role="radio"
                    aria-checked={active}
                  >
                    <span className={styles.rowIcon}>
                      {folder.path ? <Folder size={18} /> : <HardDrive size={18} />}
                    </span>
                    <span className={styles.moveFolderMeta}>
                      <strong>{folder.name}</strong>
                      <small>{folder.path ? folder.path.split('/').map(formatFolderSegment).join(' / ') : 'Raíz de Media'}</small>
                    </span>
                    <small>{folder.filesCount}</small>
                  </button>
                )
              })}
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
