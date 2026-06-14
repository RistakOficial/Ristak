import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Grid3X3,
  HardDrive,
  List,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { Button, Card, PageHeader, TabList } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import mediaService, { type MediaAsset, type StorageUsage } from '@/services/mediaService'
import styles from './MediaSettings.module.css'

type MediaFilter = 'all' | 'image' | 'video' | 'audio' | 'document' | 'other'
type ViewMode = 'grid' | 'list'

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

const API_BASE_URL = import.meta.env.VITE_API_URL || ''
const STORAGE_GB = 1024 * 1024 * 1024

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

function buildFileUrl(asset: MediaAsset, variant: 'file' | 'thumbnail' = 'file') {
  const path = `/api/media/assets/${encodeURIComponent(asset.id)}/${variant}`
  if (API_BASE_URL) return `${API_BASE_URL}${path}`
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

export const MediaSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState<MediaFilter>('all')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [currentPath, setCurrentPath] = useState('')
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)

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
  const selectedFile = useMemo(() => (
    files.find((file) => file.asset.id === selectedAssetId) || visibleFiles[0] || null
  ), [files, selectedAssetId, visibleFiles])
  const usagePercent = Math.max(0, Math.min(100, Number(usage?.usage_percent || 0)))
  const filesCount = usage?.files_count ?? assets.length
  const folderPathParts = pathSegments(currentPath)

  const handleFolderOpen = (path: string) => {
    setCurrentPath(path)
    setSelectedAssetId(null)
  }

  const handleUploadClick = () => {
    uploadInputRef.current?.click()
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setUploading(true)
    try {
      const uploaded = await mediaService.uploadFile({
        file,
        module: 'media',
        isPublic: true
      })
      const uploadedFile = toExplorerFile(uploaded)
      await loadMedia('refresh')
      setCurrentPath(uploadedFile.folderPath)
      setSelectedAssetId(uploaded.id)
      showToast('success', 'Archivo subido', `${uploadedFile.fileName} ya aparece en Media.`)
    } catch (uploadError) {
      showToast('error', 'No se pudo subir', uploadError instanceof Error ? uploadError.message : 'Intenta subir el archivo otra vez.')
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

  const deleteAsset = async (asset: MediaAsset) => {
    setDeletingId(asset.id)
    try {
      await mediaService.deleteAsset(asset.id)
      setAssets((current) => current.filter((item) => item.id !== asset.id))
      if (selectedAssetId === asset.id) setSelectedAssetId(null)
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
      `Se quitará ${getAssetDisplayName(asset)} de Media y del storage conectado.`,
      () => {
        void deleteAsset(asset)
      },
      'Eliminar',
      'Cancelar'
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

  const renderFolderButton = (folder: FolderSummary, variant: 'tile' | 'row') => (
    <button
      key={folder.path}
      type="button"
      className={variant === 'tile' ? styles.folderTile : styles.listRow}
      onClick={() => handleFolderOpen(folder.path)}
    >
      {variant === 'tile' ? (
        <>
          <span className={styles.folderTileIcon}><Folder size={28} /></span>
          <span className={styles.folderTileText}>
            <strong>{folder.name}</strong>
            <small>{folder.filesCount} archivo{folder.filesCount === 1 ? '' : 's'}</small>
          </span>
        </>
      ) : (
        <>
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
        </>
      )}
    </button>
  )

  const renderFileButton = (file: ExplorerFile, variant: 'tile' | 'row') => {
    const asset = file.asset
    const selected = selectedFile?.asset.id === asset.id
    const size = asset.quotaSize || asset.sizeProcessed || asset.sizeOriginal

    if (variant === 'tile') {
      return (
        <button
          key={asset.id}
          type="button"
          className={cx(styles.fileTile, selected && styles.itemSelected)}
          onClick={() => setSelectedAssetId(asset.id)}
          onDoubleClick={() => handleOpenAsset(asset)}
        >
          <span className={styles.fileThumb}>
            {asset.mediaType === 'image'
              ? <img src={buildFileUrl(asset, 'thumbnail')} alt="" />
              : getMediaIcon(asset.mediaType, 28)}
          </span>
          <span className={styles.fileTileText}>
            <strong>{file.fileName}</strong>
            <small>{formatBytes(size)} · {formatModuleLabel(asset.module)}</small>
          </span>
        </button>
      )
    }

    return (
      <button
        key={asset.id}
        type="button"
        className={cx(styles.listRow, selected && styles.itemSelected)}
        onClick={() => setSelectedAssetId(asset.id)}
        onDoubleClick={() => handleOpenAsset(asset)}
      >
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
      </button>
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
        className={styles.hiddenInput}
        onChange={handleFileUpload}
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

      <Card padding="none" className={styles.explorerCard}>
        <div className={styles.toolbar}>
          <div className={styles.searchBox}>
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar archivos, carpetas o tipos"
              aria-label="Buscar archivos de Media"
            />
            {query ? (
              <button type="button" onClick={() => setQuery('')} aria-label="Limpiar búsqueda">
                <X size={15} />
              </button>
            ) : null}
          </div>

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
                className={cx(styles.folderNavItem, !currentPath && styles.folderNavItemActive)}
                onClick={() => handleFolderOpen('')}
              >
                <HardDrive size={17} />
                <span>Mi unidad</span>
                <small>{typeFilteredFiles.length}</small>
              </button>
              {rootFolders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  className={cx(styles.folderNavItem, currentPath === folder.path && styles.folderNavItemActive)}
                  onClick={() => handleFolderOpen(folder.path)}
                >
                  <Folder size={17} />
                  <span>{folder.name}</span>
                  <small>{folder.filesCount}</small>
                </button>
              ))}
            </aside>

            <main className={styles.filePane}>
              <div className={styles.paneHeader}>
                <div>
                  <h2>{normalizedQuery ? 'Resultados' : getCurrentFolderLabel(currentPath)}</h2>
                  <p>{folderSummaries.length} carpeta{folderSummaries.length === 1 ? '' : 's'} · {visibleFiles.length} archivo{visibleFiles.length === 1 ? '' : 's'}</p>
                </div>
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
                  <div className={styles.listHeader} aria-hidden="true">
                    <span>Nombre</span>
                    <span>Fecha</span>
                    <span>Tamaño</span>
                    <span>Tipo</span>
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
                    disabled={Boolean(deletingId)}
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
    </div>
  )
}
