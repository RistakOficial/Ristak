import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../Button/Button'
import { CustomSelect } from '../CustomSelect/CustomSelect'
import { RefreshCw, Maximize2, Minimize2, Search, Edit, Trash2, X, Check } from 'lucide-react'
import {
  trackingService,
  TrackingSession,
  TrackingSessionsFilters
} from '@/services/trackingService'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './SessionsTable.module.css'

export interface SessionsTableRange {
  start: string
  end: string
}

export interface SessionsTableProps {
  className?: string
  range: SessionsTableRange
  filters?: TrackingSessionsFilters
  onSessionsChanged?: () => void
}

const PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300

const isAbortError = (error: unknown) => (
  error instanceof Error && error.name === 'AbortError'
)

interface ResizableHeaderProps {
  columnKey: string
  label: string
  width: number
  onResize: (key: string, width: number) => void
}

const ResizableHeader = React.memo<ResizableHeaderProps>(({ columnKey, label, width, onResize }) => {
  const [isResizing, setIsResizing] = useState(false)
  const [currentWidth, setCurrentWidth] = useState(width)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const handleMouseDown = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsResizing(true)
    startXRef.current = event.clientX
    startWidthRef.current = width
    setCurrentWidth(width)
  }

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (event: MouseEvent) => {
      event.preventDefault()
      setCurrentWidth(Math.max(80, startWidthRef.current + event.clientX - startXRef.current))
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      onResize(columnKey, currentWidth)
    }

    document.addEventListener('mousemove', handleMouseMove, { passive: false })
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [columnKey, currentWidth, isResizing, onResize])

  const displayWidth = isResizing ? currentWidth : width
  return (
    <th
      style={{
        padding: '12px 8px',
        textAlign: 'left',
        fontWeight: 600,
        borderBottom: '1px solid var(--design-table-border, var(--color-border))',
        width: `${displayWidth}px`,
        minWidth: `${displayWidth}px`,
        maxWidth: `${displayWidth}px`,
        position: 'relative',
        userSelect: 'none',
        backgroundColor: 'var(--design-table-head-bg, var(--color-surface))'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <div
          onMouseDown={handleMouseDown}
          style={{
            width: '8px',
            height: '100%',
            position: 'absolute',
            right: '-4px',
            top: 0,
            cursor: 'col-resize',
            backgroundColor: isResizing ? 'var(--color-primary)' : 'transparent',
            transition: isResizing ? 'none' : 'background-color 0.2s',
            zIndex: 10
          }}
          onMouseEnter={(event) => {
            if (!isResizing) {
              event.currentTarget.style.backgroundColor = 'var(--design-table-border, var(--color-border))'
            }
          }}
          onMouseLeave={(event) => {
            if (!isResizing) event.currentTarget.style.backgroundColor = 'transparent'
          }}
        />
      </div>
    </th>
  )
})

ResizableHeader.displayName = 'ResizableHeader'

export const SessionsTable: React.FC<SessionsTableProps> = ({
  className,
  range,
  filters = {},
  onSessionsChanged
}) => {
  const { formatLocalDateTime } = useTimezone()
  const { showToast, showConfirm } = useNotification()

  const [sessions, setSessions] = useState<TrackingSession[]>([])
  const [compactSessions, setCompactSessions] = useState<TrackingSession[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [pageCursor, setPageCursor] = useState<string | null>(null)
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([])

  // Estados para selección
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [editingSession, setEditingSession] = useState<TrackingSession | null>(null)

  // Estados para vista expandida
  const [isExpanded, setIsExpanded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [searchColumn, setSearchColumn] = useState<string>('all')
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const DEFAULT_COLUMN_WIDTH = 150

  const activeRequestRef = useRef<AbortController | null>(null)
  const requestSequenceRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const filtersKey = JSON.stringify(filters)

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim())
    }, SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(timeoutId)
  }, [searchQuery])

  const loadInitialSessions = useCallback(async (silent = false) => {
    const requestId = ++requestSequenceRef.current
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller
    loadingMoreRef.current = false
    setLoadingMore(false)
    if (!silent) setLoadingSessions(true)

    try {
      const response = await trackingService.searchSessions({
        start: range.start,
        end: range.end,
        filters,
        q: debouncedSearchQuery,
        column: searchColumn,
        cursor: null,
        limit: PAGE_SIZE
      }, { signal: controller.signal })

      if (requestId !== requestSequenceRef.current) return
      const firstPage = response.items.slice(0, PAGE_SIZE)
      setSessions(firstPage)
      if (!debouncedSearchQuery && searchColumn === 'all') {
        setCompactSessions(firstPage)
      }
      setHasMore(response.hasMore)
      setNextCursor(response.nextCursor)
      setPageCursor(null)
      setCursorHistory([])
      setSelectedIds(new Set())
    } catch (error) {
      if (!isAbortError(error) && requestId === requestSequenceRef.current) {
        showToast('error', 'Error', 'No se pudieron cargar las sesiones')
      }
    } finally {
      if (requestId === requestSequenceRef.current) {
        setLoadingSessions(false)
      }
    }
  }, [
    debouncedSearchQuery,
    filtersKey,
    range.end,
    range.start,
    searchColumn,
    showToast
  ])

  useEffect(() => {
    void loadInitialSessions()
  }, [loadInitialSessions])

  useEffect(() => () => {
    requestSequenceRef.current += 1
    activeRequestRef.current?.abort()
  }, [])

  const loadSessionsPage = useCallback(async (
    cursor: string | null,
    history: Array<string | null>
  ) => {
    if (loadingMoreRef.current) return

    loadingMoreRef.current = true
    setLoadingMore(true)
    const requestId = ++requestSequenceRef.current
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller

    try {
      const response = await trackingService.searchSessions({
        start: range.start,
        end: range.end,
        filters,
        q: debouncedSearchQuery,
        column: searchColumn,
        cursor,
        limit: PAGE_SIZE
      }, { signal: controller.signal })

      if (requestId !== requestSequenceRef.current) return
      setSessions(response.items.slice(0, PAGE_SIZE))
      setSelectedIds(new Set())
      setHasMore(response.hasMore)
      setNextCursor(response.nextCursor)
      setPageCursor(cursor)
      setCursorHistory(history)
    } catch (error) {
      if (!isAbortError(error) && requestId === requestSequenceRef.current) {
        showToast('error', 'Error', 'No se pudo cargar esta página de sesiones')
      }
    } finally {
      if (requestId === requestSequenceRef.current) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }, [
    debouncedSearchQuery,
    filtersKey,
    range.end,
    range.start,
    searchColumn,
    showToast
  ])

  const loadNextPage = useCallback(() => {
    if (!hasMore || !nextCursor || loadingMoreRef.current) return
    void loadSessionsPage(nextCursor, [...cursorHistory, pageCursor])
  }, [cursorHistory, hasMore, loadSessionsPage, nextCursor, pageCursor])

  const loadPreviousPage = useCallback(() => {
    if (!cursorHistory.length || loadingMoreRef.current) return
    const previousCursor = cursorHistory[cursorHistory.length - 1] ?? null
    void loadSessionsPage(previousCursor, cursorHistory.slice(0, -1))
  }, [cursorHistory, loadSessionsPage])

  const handleToggleExpanded = () => {
    setIsExpanded(prev => !prev)
    if (isExpanded) {
      const queryWillReset = Boolean(searchQuery || debouncedSearchQuery || searchColumn !== 'all')
      setSearchQuery('')
      setDebouncedSearchQuery('')
      setSearchColumn('all')
      if (!queryWillReset && (pageCursor || cursorHistory.length)) {
        void loadInitialSessions(true)
      }
    } else {
      setSelectedIds(new Set())
    }
  }

  const handleColumnResize = useCallback((columnKey: string, newWidth: number) => {
    setColumnWidths(prev => ({
      ...prev,
      [columnKey]: Math.max(80, newWidth)
    }))
  }, [])

  const getColumnWidth = (columnKey: string) => {
    return columnWidths[columnKey] || DEFAULT_COLUMN_WIDTH
  }

  // Manejo de selección
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(sessions.map(session => session.id)))
    } else {
      setSelectedIds(new Set())
    }
  }

  const handleSelectRow = (id: string, checked: boolean) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev)
      if (checked) {
        newSet.add(id)
      } else {
        newSet.delete(id)
      }
      return newSet
    })
  }

  const handleEditSelected = async () => {
    if (selectedIds.size !== 1) {
      showToast('warning', 'Atención', 'Selecciona exactamente una sesión para editar')
      return
    }

    const sessionId = Array.from(selectedIds)[0]
    try {
      const fullSession = await trackingService.getSessionById(sessionId)
      setEditingSession(fullSession)
      setIsEditModalOpen(true)
    } catch {
      showToast('error', 'Error', 'No se pudo cargar la sesión para editar')
    }
  }

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) {
      showToast('warning', 'Atención', 'Selecciona al menos una sesión para eliminar')
      return
    }

    const idsToDelete = Array.from(selectedIds)
    showConfirm(
      'Eliminar sesiones',
      `Se eliminarán ${selectedIds.size} sesión(es) de tracking de forma permanente. Esta acción no se puede deshacer.`,
      async () => {
        try {
          await trackingService.deleteSessions(idsToDelete)
          showToast('success', 'Éxito', `${idsToDelete.length} sesión(es) eliminadas correctamente`)
          setSelectedIds(new Set())
          await loadInitialSessions(true)
          onSessionsChanged?.()
        } catch (error) {
          showToast('error', 'Error', 'No se pudieron eliminar las sesiones')
        }
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const handleSaveEdit = async (updates: Partial<TrackingSession>) => {
    if (!editingSession) return

    try {
      await trackingService.updateSession(editingSession.id, updates)
      onSessionsChanged?.()

      showToast('success', 'Éxito', 'Sesión actualizada correctamente')
      setIsEditModalOpen(false)
      setEditingSession(null)
      setSelectedIds(new Set())
      await loadInitialSessions(true)
    } catch (error) {
      showToast('error', 'Error', 'No se pudo actualizar la sesión')
    }
  }

  // Definir las columnas
  const columns = [
    { key: 'session_id', label: 'Session ID' },
    { key: 'visitor_id', label: 'Visitor ID' },
    { key: 'contact_id', label: 'Contact ID' },
    { key: 'full_name', label: 'Full Name' },
    { key: 'email', label: 'Email' },
    { key: 'event_name', label: 'Event Name' },
    { key: 'started_at', label: 'Started At' },
    { key: 'tracking_source', label: 'Tracking Source' },
    { key: 'site_name', label: 'Site' },
    { key: 'site_type', label: 'Site Type' },
    { key: 'form_site_name', label: 'Form' },
    { key: 'conversion_type', label: 'Conversion Type' },
    { key: 'page_url', label: 'Page URL' },
    { key: 'referrer_url', label: 'Referrer URL' },
    { key: 'utm_source', label: 'UTM Source' },
    { key: 'utm_medium', label: 'UTM Medium' },
    { key: 'utm_campaign', label: 'UTM Campaign' },
    { key: 'utm_content', label: 'UTM Content' },
    { key: 'channel', label: 'Channel' },
    { key: 'source_platform', label: 'Source Platform' },
    { key: 'campaign_id', label: 'Campaign ID' },
    { key: 'adset_id', label: 'Adset ID' },
    { key: 'ad_group_id', label: 'Ad Group ID' },
    { key: 'ad_id', label: 'Ad ID' },
    { key: 'placement', label: 'Placement' },
    { key: 'device_type', label: 'Device Type' },
    { key: 'os', label: 'OS' },
    { key: 'browser', label: 'Browser' },
    { key: 'geo_country', label: 'Country' },
    { key: 'geo_city', label: 'City' }
  ]

  const allSelected = sessions.length > 0 && sessions.every(session => selectedIds.has(session.id))
  const someSelected = selectedIds.size > 0 && !allSelected

  return (
    <>
      {/* Vista normal (compacta) */}
      <div className={`${styles.section}${className ? ` ${className}` : ''}`} data-ristak-table>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>
            Eventos de Tracking
          </h3>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Button
              variant="ghost"
              size="small"
              onClick={handleToggleExpanded}
              title="Vista expandida"
            >
              <Maximize2 size={16} />
              Expandir
            </Button>
            <Button
              variant="ghost"
              size="small"
              onClick={() => void loadInitialSessions(false)}
              disabled={loadingSessions}
              aria-label={loadingSessions ? 'Cargando sesiones' : 'Actualizar sesiones'}
            >
              <RefreshCw size={16} className={loadingSessions ? styles.spinIcon : ''} />
              {!loadingSessions && 'Actualizar'}
            </Button>
          </div>
        </div>

        {compactSessions.length > 0 ? (
          <div className={styles.tableContainer} style={{ overflowX: 'auto' }}>
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
              Mostrando hasta {Math.min(10, compactSessions.length)} eventos cargados del rango. Haz clic en "Expandir" para buscar, editar y eliminar.
            </p>
            <table className={styles.table} data-ristak-table-element>
              <thead>
                <tr>
                  <th style={{ padding: '12px 8px', textAlign: 'left' }}>Fecha</th>
                  <th style={{ padding: '12px 8px', textAlign: 'left' }}>Evento</th>
                  <th style={{ padding: '12px 8px', textAlign: 'left' }}>Contacto</th>
                  <th style={{ padding: '12px 8px', textAlign: 'left' }}>UTM Source</th>
                  <th style={{ padding: '12px 8px', textAlign: 'left' }}>UTM Campaign</th>
                  <th style={{ padding: '12px 8px', textAlign: 'left' }}>Dispositivo</th>
                </tr>
              </thead>
              <tbody>
                {compactSessions.slice(0, 10).map((session) => (
                  <tr key={session.id}>
                    <td style={{ padding: '12px 8px', fontSize: '0.875rem' }}>
                      {session.started_at ? formatLocalDateTime(new Date(session.started_at)) : '-'}
                    </td>
                    <td style={{ padding: '12px 8px', fontSize: '0.875rem' }}>
                      {session.event_name || '-'}
                    </td>
                    <td style={{ padding: '12px 8px', fontSize: '0.875rem' }}>
                      {session.full_name || session.email || '-'}
                    </td>
                    <td style={{ padding: '12px 8px', fontSize: '0.875rem' }}>
                      {session.utm_source || '-'}
                    </td>
                    <td style={{ padding: '12px 8px', fontSize: '0.875rem' }}>
                      {session.utm_campaign || '-'}
                    </td>
                    <td style={{ padding: '12px 8px', fontSize: '0.875rem' }}>
                      {session.device_type || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : loadingSessions ? (
          <div className={styles.emptyState} aria-live="polite">
            <RefreshCw size={18} className={styles.spinIcon} aria-hidden="true" />
            <p>Cargando eventos…</p>
          </div>
        ) : (
          <div className={styles.emptyState}>
            <p>No hay eventos capturados</p>
            <p className={styles.emptyStateHint}>
              Instala el pixel para empezar a capturar datos
            </p>
          </div>
        )}
      </div>

      {/* Modal de vista expandida */}
      {isExpanded && createPortal(
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
	          bottom: 0,
	          backgroundColor: 'var(--color-background)',
	          zIndex: 'var(--z-index-modal)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          {/* Header del modal expandido */}
          <div style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--design-table-border, var(--color-border))',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: 'var(--design-table-toolbar-bg, var(--color-surface))'
          }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
              Eventos de Tracking - Vista Completa
              <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)', marginLeft: '12px' }}>
                ({sessions.length} cargadas)
              </span>
            </h2>
            <Button
              variant="ghost"
              size="small"
              onClick={handleToggleExpanded}
              title="Cerrar vista expandida"
            >
              <Minimize2 size={20} />
            </Button>
          </div>

          {/* Barra de herramientas */}
          <div style={{
            padding: '16px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--design-table-border, var(--color-border))',
            backgroundColor: 'var(--design-table-toolbar-bg, var(--color-surface))',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', gap: '12px', flex: 1, maxWidth: '700px' }}>
              {/* Dropdown de columnas */}
              <CustomSelect
                value={searchColumn}
                onChange={(e) => setSearchColumn(e.target.value)}
                style={{
                  minWidth: '180px'
                }}
              >
                <option value="all">Todas las columnas</option>
                <optgroup label="IDs y Timestamps">
                  <option value="session_id">Session ID</option>
                  <option value="visitor_id">Visitor ID</option>
                  <option value="contact_id">Contact ID</option>
                  <option value="full_name">Full Name</option>
                  <option value="email">Email</option>
                  <option value="event_name">Event Name</option>
                </optgroup>
                <optgroup label="URLs">
                  <option value="page_url">Page URL</option>
                  <option value="referrer_url">Referrer URL</option>
                </optgroup>
                <optgroup label="UTMs">
                  <option value="utm_source">UTM Source</option>
                  <option value="utm_medium">UTM Medium</option>
                  <option value="utm_campaign">UTM Campaign</option>
                  <option value="utm_content">UTM Content</option>
                </optgroup>
                <optgroup label="Campaña">
                  <option value="source_platform">Source Platform</option>
                  <option value="campaign_id">Campaign ID</option>
                  <option value="adset_id">Adset ID</option>
                  <option value="ad_id">Ad ID</option>
                  <option value="channel">Channel</option>
                </optgroup>
                <optgroup label="Device & Browser">
                  <option value="device_type">Device Type</option>
                  <option value="os">OS</option>
                  <option value="browser">Browser</option>
                </optgroup>
                <optgroup label="Sites">
                  <option value="site_name">Site</option>
                </optgroup>
                <optgroup label="Geo">
                  <option value="geo_country">Country</option>
                  <option value="geo_city">City</option>
                </optgroup>
              </CustomSelect>

              {/* Input de búsqueda */}
              <div style={{ position: 'relative', flex: 1 }}>
                <Search
                  size={18}
                  style={{
                    position: 'absolute',
                    left: '12px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--color-text-secondary)'
                  }}
                />
                <input
                  type="text"
                  placeholder={searchColumn === 'all' ? 'Buscar en todas las columnas...' : `Buscar en ${columns.find(c => c.key === searchColumn)?.label || searchColumn}...`}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 12px 8px 40px',
                    border: '1px solid var(--design-table-border, var(--color-border))',
                    borderRadius: 'var(--design-control-radius, 6px)',
                    fontSize: '0.875rem',
                    backgroundColor: 'var(--design-table-control-bg, var(--color-background))',
                    color: 'var(--color-text)',
                    outline: 'none'
                  }}
                />
              </div>
            </div>
            <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
              {sessions.length} {sessions.length === 1 ? 'sesión cargada' : 'sesiones cargadas'}
              {searchQuery.trim() && ' para esta búsqueda'}
            </span>
          </div>

          {/* Tabla expandida con ventana acotada */}
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '0 40px 20px 40px'
            }}
          >
            <div style={{
              height: '100%',
              overflowX: 'auto',
              overflowY: 'auto'
            }}>
              <table style={{
                borderCollapse: 'collapse',
                fontSize: '0.875rem',
                backgroundColor: 'var(--design-table-bg, var(--color-surface))',
                width: '100%'
              }} data-ristak-table-element>
                <thead style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 10
                }}>
                  <tr>
                    {/* Checkbox para seleccionar todo */}
                    <th style={{
                      width: '50px',
                      padding: '12px 8px',
                      backgroundColor: 'var(--design-table-head-bg, var(--color-surface))',
                      borderBottom: '1px solid var(--design-table-border, var(--color-border))',
                      position: 'sticky',
                      top: 0,
                      zIndex: 11
                    }}>
                      <input
                        className={styles.selectionCheckbox}
                        type="checkbox"
                        checked={allSelected}
                        ref={input => {
                          if (input) {
                            input.indeterminate = someSelected
                          }
                        }}
                        onChange={(e) => handleSelectAll(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                    </th>
                    {columns.map(col => (
                      <ResizableHeader
                        key={col.key}
                        columnKey={col.key}
                        label={col.label}
                        width={getColumnWidth(col.key)}
                        onResize={handleColumnResize}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session: any, rowIndex: number) => {
                    const isSelected = selectedIds.has(session.id)

                    const getCellValue = (key: string) => {
                      const value = session[key]
                      if (!value) return '-'

                      // Formatear fechas
                      if (key === 'started_at') {
                        return formatLocalDateTime(value)
                      }

                      // Formato de código para IDs y click IDs
                      if (['session_id', 'visitor_id', 'contact_id', 'gclid', 'fbclid'].includes(key)) {
                        return (
                          <code style={{ fontSize: '0.75rem', backgroundColor: 'var(--color-gray-50)', padding: '2px 6px', borderRadius: '4px' }}>
                            {value}
                          </code>
                        )
                      }

                      // Link para page_url
                      if (key === 'page_url') {
                        return (
                          <a href={value} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>
                            {value}
                          </a>
                        )
                      }

                      return value
                    }

                    return (
                      <tr
                        key={session.id || `${session.session_id}-${rowIndex}`}
                        style={{
                          borderBottom: '1px solid var(--design-table-border, var(--color-border))',
                          backgroundColor: isSelected ? 'var(--color-primary-50)' : 'transparent'
                        }}
                      >
                        <td style={{ padding: '8px' }}>
                          <input
                            className={styles.selectionCheckbox}
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => handleSelectRow(session.id, e.target.checked)}
                            style={{ cursor: 'pointer' }}
                          />
                        </td>
                        {columns.map(col => {
                          const width = getColumnWidth(col.key)
                          return (
                            <td
                              key={col.key}
                              style={{
                                padding: '8px',
                                width: `${width}px`,
                                minWidth: `${width}px`,
                                maxWidth: `${width}px`,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                textTransform: col.key === 'device_type' ? 'capitalize' : 'none',
                                fontSize: ['user_agent', 'ip', 'referrer_url'].includes(col.key) ? '0.75rem' : '0.875rem'
                              }}
                              title={String(session[col.key] || '-')}
                            >
                              {getCellValue(col.key)}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {(cursorHistory.length > 0 || hasMore) && (
                <div
                  style={{
                    minHeight: '88px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.875rem',
                    color: 'var(--color-text-secondary)'
                  }}
                >
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={loadPreviousPage}
                    disabled={loadingMore || cursorHistory.length === 0}
                    aria-label="Cargar página anterior de sesiones"
                  >
                    Anterior
                  </Button>
                  <span>Página {cursorHistory.length + 1}</span>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={loadNextPage}
                    disabled={loadingMore || !hasMore || !nextCursor}
                    aria-label={loadingMore ? 'Cargando página de sesiones' : 'Cargar página siguiente de sesiones'}
                  >
                    {loadingMore && <RefreshCw size={16} className={styles.spinIcon} aria-hidden="true" />}
                    {loadingMore ? 'Cargando…' : 'Siguiente'}
                  </Button>
                </div>
              )}

              {!hasMore && cursorHistory.length === 0 && sessions.length > 0 && (
                <div style={{
                  padding: '20px',
                  textAlign: 'center',
                  fontSize: '0.875rem',
                  color: 'var(--color-text-secondary)'
                }}>
                  No hay más sesiones para mostrar
                </div>
              )}
            </div>
          </div>

          {/* Barra de acciones flotante */}
          {selectedIds.size > 0 && createPortal(
            <div style={{
              position: 'fixed',
              bottom: '32px',
              left: '50%',
              transform: 'translateX(-50%)',
              backgroundColor: 'var(--design-table-bg, var(--color-surface))',
              border: '1px solid var(--design-table-border, var(--color-border))',
              borderRadius: 'var(--design-card-radius, 12px)',
              padding: '16px 24px',
              display: 'flex',
              gap: '12px',
	              alignItems: 'center',
	              boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
	              zIndex: 'var(--z-index-modal-popover)'
	            }}>
              <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>
                {selectedIds.size} {selectedIds.size === 1 ? 'sesión seleccionada' : 'sesiones seleccionadas'}
              </span>
              <div style={{ width: '1px', height: '24px', backgroundColor: 'var(--design-table-border, var(--color-border))' }} />
              <Button
                variant="ghost"
                size="small"
                onClick={handleEditSelected}
                disabled={selectedIds.size !== 1}
                title={selectedIds.size !== 1 ? 'Selecciona exactamente una sesión para editar' : 'Editar sesión'}
              >
                <Edit size={16} />
                Editar
              </Button>
              <Button
                variant="ghost"
                size="small"
                onClick={handleDeleteSelected}
              >
                <Trash2 size={16} />
                Eliminar
              </Button>
              <Button
                variant="ghost"
                size="small"
                onClick={() => setSelectedIds(new Set())}
                title="Deseleccionar todo"
              >
                <X size={16} />
              </Button>
            </div>,
            document.body
          )}
        </div>,
        document.body
      )}

      {/* Modal de edición */}
      {isEditModalOpen && editingSession && (
        <EditSessionModal
          session={editingSession}
          onClose={() => {
            setIsEditModalOpen(false)
            setEditingSession(null)
          }}
          onSave={handleSaveEdit}
        />
      )}
    </>
  )
}

// Modal de edición de sesión
interface EditSessionModalProps {
  session: TrackingSession
  onClose: () => void
  onSave: (updates: Partial<TrackingSession>) => void
}

const EditSessionModal: React.FC<EditSessionModalProps> = ({ session, onClose, onSave }) => {
  const [formData, setFormData] = useState<Partial<TrackingSession>>({
    full_name: session.full_name || '',
    email: session.email || '',
    utm_source: session.utm_source || '',
    utm_medium: session.utm_medium || '',
    utm_campaign: session.utm_campaign || '',
    utm_term: session.utm_term || '',
    utm_content: session.utm_content || '',
    page_url: session.page_url || '',
    referrer_url: session.referrer_url || '',
    device_type: session.device_type || '',
    browser: session.browser || '',
    os: session.os || '',
    geo_country: session.geo_country || '',
    geo_city: session.geo_city || ''
  })

  const handleChange = (field: keyof TrackingSession, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(formData)
  }

  return createPortal(
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
	      display: 'flex',
	      alignItems: 'center',
	      justifyContent: 'center',
	      zIndex: 'var(--z-index-modal-popover)',
	      padding: '20px'
	    }}>
      <div style={{
        backgroundColor: 'var(--color-surface)',
        borderRadius: '12px',
        width: '100%',
        maxWidth: '700px',
        maxHeight: '90vh',
        overflow: 'auto',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)'
      }}>
        {/* Header */}
        <div style={{
          padding: '24px',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          position: 'sticky',
          top: 0,
          backgroundColor: 'var(--color-surface)',
          zIndex: 1
        }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
            Editar Sesión
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              padding: '8px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              color: 'var(--color-text-secondary)'
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit}>
          <div style={{ padding: '24px' }}>
            <div style={{ display: 'grid', gap: '16px' }}>
              {/* Contacto */}
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '6px' }}>
                  Nombre Completo
                </label>
                <input
                  type="text"
                  value={formData.full_name || ''}
                  onChange={(e) => handleChange('full_name', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: '1px solid var(--color-border)',
                    borderRadius: '6px',
                    fontSize: '0.875rem',
                    backgroundColor: 'var(--color-background)',
                    color: 'var(--color-text)'
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '6px' }}>
                  Email
                </label>
                <input
                  type="email"
                  value={formData.email || ''}
                  onChange={(e) => handleChange('email', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: '1px solid var(--color-border)',
                    borderRadius: '6px',
                    fontSize: '0.875rem',
                    backgroundColor: 'var(--color-background)',
                    color: 'var(--color-text)'
                  }}
                />
              </div>

              {/* UTMs */}
              <div style={{ marginTop: '12px' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>UTM Parameters</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].map((field) => (
                    <div key={field}>
                      <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '6px' }}>
                        {field.replace('utm_', 'UTM ').replace(/^./, str => str.toUpperCase())}
                      </label>
                      <input
                        type="text"
                        value={(formData as any)[field] || ''}
                        onChange={(e) => handleChange(field as keyof TrackingSession, e.target.value)}
                        style={{
                          width: '100%',
                          padding: '8px 10px',
                          border: '1px solid var(--color-border)',
                          borderRadius: '6px',
                          fontSize: '0.875rem',
                          backgroundColor: 'var(--color-background)',
                          color: 'var(--color-text)'
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* URLs */}
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '6px' }}>
                  Page URL
                </label>
                <input
                  type="text"
                  value={formData.page_url || ''}
                  onChange={(e) => handleChange('page_url', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: '1px solid var(--color-border)',
                    borderRadius: '6px',
                    fontSize: '0.875rem',
                    backgroundColor: 'var(--color-background)',
                    color: 'var(--color-text)'
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '6px' }}>
                  Referrer URL
                </label>
                <input
                  type="text"
                  value={formData.referrer_url || ''}
                  onChange={(e) => handleChange('referrer_url', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: '1px solid var(--color-border)',
                    borderRadius: '6px',
                    fontSize: '0.875rem',
                    backgroundColor: 'var(--color-background)',
                    color: 'var(--color-text)'
                  }}
                />
              </div>

              {/* Device info */}
              <div style={{ marginTop: '12px' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>Device & Browser</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {['device_type', 'browser', 'os'].map((field) => (
                    <div key={field}>
                      <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '6px', textTransform: 'capitalize' }}>
                        {field.replace('_', ' ')}
                      </label>
                      <input
                        type="text"
                        value={(formData as any)[field] || ''}
                        onChange={(e) => handleChange(field as keyof TrackingSession, e.target.value)}
                        style={{
                          width: '100%',
                          padding: '8px 10px',
                          border: '1px solid var(--color-border)',
                          borderRadius: '6px',
                          fontSize: '0.875rem',
                          backgroundColor: 'var(--color-background)',
                          color: 'var(--color-text)'
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Geo */}
              <div style={{ marginTop: '12px' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>Geolocation</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {['geo_country', 'geo_city'].map((field) => (
                    <div key={field}>
                      <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '6px', textTransform: 'capitalize' }}>
                        {field.replace('geo_', '')}
                      </label>
                      <input
                        type="text"
                        value={(formData as any)[field] || ''}
                        onChange={(e) => handleChange(field as keyof TrackingSession, e.target.value)}
                        style={{
                          width: '100%',
                          padding: '8px 10px',
                          border: '1px solid var(--color-border)',
                          borderRadius: '6px',
                          fontSize: '0.875rem',
                          backgroundColor: 'var(--color-background)',
                          color: 'var(--color-text)'
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--color-border)',
            display: 'flex',
            gap: '12px',
            justifyContent: 'flex-end',
            position: 'sticky',
            bottom: 0,
            backgroundColor: 'var(--color-surface)'
          }}>
            <Button variant="ghost" size="medium" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" size="medium" type="submit">
              <Check size={16} />
              Guardar Cambios
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
