import React, { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../Button/Button'
import { CustomSelect } from '../CustomSelect/CustomSelect'
import { RefreshCw, Maximize2, Minimize2, Search, Edit, Trash2, X, Check } from 'lucide-react'
import { trackingService, TrackingSession, SessionsResponse } from '@/services/trackingService'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useNotification } from '@/contexts/NotificationContext'
import { buildSearchIndex, prepareSearchQuery, searchIndexIncludes } from '@/utils/searchText'
import styles from './SessionsTable.module.css'

interface SessionsTableProps {
  className?: string
  filteredSessions?: TrackingSession[] // Sesiones ya filtradas desde parent (Analytics)
  useExternalData?: boolean // Si true, usa filteredSessions en vez de cargar propias
}

const SESSION_SEARCH_KEYS = [
  'session_id',
  'visitor_id',
  'contact_id',
  'full_name',
  'email',
  'event_name',
  'started_at',
  'page_url',
  'referrer_url',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'fbc',
  'fbp',
  'wbraid',
  'gbraid',
  'msclkid',
  'ttclid',
  'channel',
  'source_platform',
  'campaign_id',
  'adset_id',
  'ad_group_id',
  'ad_id',
  'campaign_name',
  'adset_name',
  'ad_group_name',
  'ad_name',
  'placement',
  'site_source_name',
  'network',
  'match_type',
  'keyword',
  'search_query',
  'creative_id',
  'ad_position',
  'ip',
  'user_agent',
  'device_type',
  'os',
  'browser',
  'browser_version',
  'language',
  'timezone',
  'geo_country',
  'geo_region',
  'geo_city'
] as const

export const SessionsTable: React.FC<SessionsTableProps> = ({
  className,
  filteredSessions = [],
  useExternalData = false
}) => {
  const { formatLocalDateTime } = useTimezone()
  const { showToast, showConfirm } = useNotification()

  const [sessions, setSessions] = useState<TrackingSession[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(true)

  // Estados para selección
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [editingSession, setEditingSession] = useState<TrackingSession | null>(null)

  // Estados para vista expandida
  const [isExpanded, setIsExpanded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchColumn, setSearchColumn] = useState<string>('all')
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const DEFAULT_COLUMN_WIDTH = 150

  // Ref para detectar scroll infinito
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null)

  // Si usa datos externos, actualizar sessions cuando cambien filteredSessions
  useEffect(() => {
    if (useExternalData) {
      setSessions(filteredSessions)
      setTotal(filteredSessions.length)
      setHasMore(false) // No hay paginación con datos externos
    }
  }, [useExternalData, filteredSessions])

  useEffect(() => {
    if (!useExternalData) {
      loadInitialSessions()
    }
  }, [useExternalData])

  // Configurar Intersection Observer para scroll infinito
  useEffect(() => {
    if (!isExpanded || useExternalData) return // Solo en vista expandida y sin datos externos

    const options = {
      root: scrollContainerRef.current,
      rootMargin: '200px', // Cargar cuando esté a 200px del final
      threshold: 0.1
    }

    observerRef.current = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && hasMore && !loadingMore) {
        loadMoreSessions()
      }
    }, options)

    if (loadMoreTriggerRef.current) {
      observerRef.current.observe(loadMoreTriggerRef.current)
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect()
      }
    }
  }, [isExpanded, hasMore, loadingMore, sessions.length])

  const loadInitialSessions = async () => {
    setLoadingSessions(true)
    try {
      const response: SessionsResponse = await trackingService.getSessionsPaginated(0, 50)
      setSessions(response.sessions)
      setTotal(response.total)
      setHasMore(response.hasMore)
    } catch (error) {
      showToast('error', 'Error', 'No se pudieron cargar las sesiones')
    } finally {
      setLoadingSessions(false)
    }
  }

  const loadMoreSessions = async () => {
    if (loadingMore || !hasMore) return

    setLoadingMore(true)
    try {
      const offset = sessions.length
      const response: SessionsResponse = await trackingService.getSessionsPaginated(offset, 50)

      setSessions(prev => [...prev, ...response.sessions])
      setHasMore(response.hasMore)
    } catch (error) {
      showToast('error', 'Error', 'No se pudieron cargar más sesiones')
    } finally {
      setLoadingMore(false)
    }
  }

  const preparedSessionSearch = useMemo(() => prepareSearchQuery(searchQuery), [searchQuery])
  const sessionSearchIndexes = useMemo(() => {
    return sessions.map((session: any) => ({
      all: buildSearchIndex(SESSION_SEARCH_KEYS.map(key => session[key])),
      columns: SESSION_SEARCH_KEYS.reduce<Record<string, ReturnType<typeof buildSearchIndex>>>((acc, key) => {
        acc[key] = buildSearchIndex(session[key])
        return acc
      }, {})
    }))
  }, [sessions])

  // Filtrar sesiones por búsqueda
  const searchFilteredSessions = useMemo(() => {
    if (!preparedSessionSearch.normalized) return sessions

    return sessions.filter((session: any, index) => {
      const searchIndexes = sessionSearchIndexes[index]
      if (!searchIndexes) return false

      // Si busca en columna específica
      if (searchColumn !== 'all') {
        return searchIndexIncludes(
          searchIndexes.columns[searchColumn] ?? buildSearchIndex(session[searchColumn]),
          preparedSessionSearch
        )
      }

      // Si busca en todas las columnas
      return searchIndexIncludes(searchIndexes.all, preparedSessionSearch)
    })
  }, [sessions, preparedSessionSearch, searchColumn, sessionSearchIndexes])

  const handleToggleExpanded = () => {
    setIsExpanded(prev => !prev)
    if (!isExpanded) {
      setSearchQuery('')
      setSearchColumn('all')
      setSelectedIds(new Set())
    }
  }

  const handleColumnResize = (columnKey: string, newWidth: number) => {
    setColumnWidths(prev => ({
      ...prev,
      [columnKey]: Math.max(80, newWidth)
    }))
  }

  const getColumnWidth = (columnKey: string) => {
    return columnWidths[columnKey] || DEFAULT_COLUMN_WIDTH
  }

  // Manejo de selección
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(searchFilteredSessions.map(s => s.id)))
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

  const handleEditSelected = () => {
    if (selectedIds.size !== 1) {
      showToast('warning', 'Atención', 'Selecciona exactamente una sesión para editar')
      return
    }

    const sessionId = Array.from(selectedIds)[0]
    const session = sessions.find(s => s.id === sessionId)

    if (session) {
      setEditingSession(session)
      setIsEditModalOpen(true)
    }
  }

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) {
      showToast('warning', 'Atención', 'Selecciona al menos una sesión para eliminar')
      return
    }

    showConfirm(
      'Eliminar sesiones',
      `Se eliminarán ${selectedIds.size} sesión(es) de tracking de forma permanente. Esta acción no se puede deshacer.`,
      async () => {
        try {
          await trackingService.deleteSessions(Array.from(selectedIds))
          showToast('success', 'Éxito', `${selectedIds.size} sesión(es) eliminadas correctamente`)

          // Actualizar lista
          setSessions(prev => prev.filter(s => !selectedIds.has(s.id)))
          setSelectedIds(new Set())
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
      const updatedSession = await trackingService.updateSession(editingSession.id, updates)

      // Actualizar en la lista
      setSessions(prev => prev.map(s => s.id === updatedSession.id ? updatedSession : s))

      showToast('success', 'Éxito', 'Sesión actualizada correctamente')
      setIsEditModalOpen(false)
      setEditingSession(null)
      setSelectedIds(new Set())
    } catch (error) {
      showToast('error', 'Error', 'No se pudo actualizar la sesión')
    }
  }

  // Componente para header resizable
  const ResizableHeader: React.FC<{
    columnKey: string
    label: string
    width: number
    onResize: (key: string, width: number) => void
  }> = ({ columnKey, label, width, onResize }) => {
    const [isResizing, setIsResizing] = useState(false)
    const [currentWidth, setCurrentWidth] = useState(width)
    const startXRef = React.useRef(0)
    const startWidthRef = React.useRef(0)

    const handleMouseDown = (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsResizing(true)
      startXRef.current = e.clientX
      startWidthRef.current = width
      setCurrentWidth(width)
    }

    useEffect(() => {
      if (!isResizing) return

      const handleMouseMove = (e: MouseEvent) => {
        e.preventDefault()
        const diff = e.clientX - startXRef.current
        const newWidth = Math.max(80, startWidthRef.current + diff)
        setCurrentWidth(newWidth)
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
    }, [isResizing, columnKey, onResize, currentWidth])

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
            onMouseEnter={(e) => {
              if (!isResizing) {
                e.currentTarget.style.backgroundColor = 'var(--design-table-border, var(--color-border))'
              }
            }}
            onMouseLeave={(e) => {
              if (!isResizing) {
                e.currentTarget.style.backgroundColor = 'transparent'
              }
            }}
          />
        </div>
      </th>
    )
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
    { key: 'public_page_title', label: 'Public Page' },
    { key: 'conversion_type', label: 'Conversion Type' },
    { key: 'submission_id', label: 'Submission ID' },
    { key: 'page_url', label: 'Page URL' },
    { key: 'referrer_url', label: 'Referrer URL' },
    { key: 'utm_source', label: 'UTM Source' },
    { key: 'utm_medium', label: 'UTM Medium' },
    { key: 'utm_campaign', label: 'UTM Campaign' },
    { key: 'utm_term', label: 'UTM Term' },
    { key: 'utm_content', label: 'UTM Content' },
    { key: 'gclid', label: 'GCLID' },
    { key: 'fbclid', label: 'FBCLID' },
    { key: 'fbc', label: 'FBC' },
    { key: 'fbp', label: 'FBP' },
    { key: 'wbraid', label: 'WBRAID' },
    { key: 'gbraid', label: 'GBRAID' },
    { key: 'msclkid', label: 'MSCLKID' },
    { key: 'ttclid', label: 'TTCLID' },
    { key: 'channel', label: 'Channel' },
    { key: 'source_platform', label: 'Source Platform' },
    { key: 'campaign_id', label: 'Campaign ID' },
    { key: 'adset_id', label: 'Adset ID' },
    { key: 'ad_group_id', label: 'Ad Group ID' },
    { key: 'ad_id', label: 'Ad ID' },
    { key: 'campaign_name', label: 'Campaign Name' },
    { key: 'adset_name', label: 'Adset Name' },
    { key: 'ad_group_name', label: 'Ad Group Name' },
    { key: 'ad_name', label: 'Ad Name' },
    { key: 'placement', label: 'Placement' },
    { key: 'site_source_name', label: 'Site Source Name' },
    { key: 'network', label: 'Network' },
    { key: 'match_type', label: 'Match Type' },
    { key: 'keyword', label: 'Keyword' },
    { key: 'search_query', label: 'Search Query' },
    { key: 'creative_id', label: 'Creative ID' },
    { key: 'ad_position', label: 'Ad Position' },
    { key: 'ip', label: 'IP' },
    { key: 'user_agent', label: 'User Agent' },
    { key: 'device_type', label: 'Device Type' },
    { key: 'os', label: 'OS' },
    { key: 'browser', label: 'Browser' },
    { key: 'browser_version', label: 'Browser Version' },
    { key: 'language', label: 'Language' },
    { key: 'timezone', label: 'Timezone' },
    { key: 'geo_country', label: 'Country' },
    { key: 'geo_region', label: 'Region' },
    { key: 'geo_city', label: 'City' }
  ]

  const allSelected = searchFilteredSessions.length > 0 && searchFilteredSessions.every(s => selectedIds.has(s.id))
  const someSelected = selectedIds.size > 0 && !allSelected

  return (
    <>
      {/* Vista normal (compacta) */}
      <div className={`${styles.section}${className ? ` ${className}` : ''}`} data-ristak-table>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>
            Eventos de Tracking
            {total > 0 && <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)', marginLeft: '8px' }}>({total} total)</span>}
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
            {!useExternalData && (
              <Button
                variant="ghost"
                size="small"
                onClick={loadInitialSessions}
                disabled={loadingSessions}
                aria-label={loadingSessions ? 'Cargando sesiones' : 'Actualizar sesiones'}
              >
                <RefreshCw size={16} className={loadingSessions ? styles.spinIcon : ''} />
                {!loadingSessions && 'Actualizar'}
              </Button>
            )}
          </div>
        </div>

        {sessions.length > 0 ? (
          <div className={styles.tableContainer} style={{ overflowX: 'auto' }}>
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
              {useExternalData
                ? `Mostrando ${sessions.length} ${sessions.length === 1 ? 'sesión filtrada' : 'sesiones filtradas'}. Haz clic en "Expandir" para ver todas.`
                : `Mostrando las primeras ${sessions.length} sesiones. Haz clic en "Expandir" para ver todas, editar y eliminar.`
              }
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
                {sessions.slice(0, 10).map((session) => (
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
                ({total} total)
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
                  <option value="utm_term">UTM Term</option>
                  <option value="utm_content">UTM Content</option>
                </optgroup>
                <optgroup label="Click IDs">
                  <option value="gclid">GCLID</option>
                  <option value="fbclid">FBCLID</option>
                  <option value="fbc">FBC</option>
                  <option value="fbp">FBP</option>
                </optgroup>
                <optgroup label="Campaña">
                  <option value="source_platform">Source Platform</option>
                  <option value="campaign_name">Campaign Name</option>
                  <option value="ad_name">Ad Name</option>
                  <option value="channel">Channel</option>
                </optgroup>
                <optgroup label="Device & Browser">
                  <option value="ip">IP</option>
                  <option value="device_type">Device Type</option>
                  <option value="os">OS</option>
                  <option value="browser">Browser</option>
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
              {searchFilteredSessions.length} {searchFilteredSessions.length === 1 ? 'sesión' : 'sesiones'} {searchQuery.trim() && `(filtradas de ${sessions.length})`}
            </span>
          </div>

          {/* Tabla expandida con scroll infinito */}
          <div
            ref={scrollContainerRef}
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
                  {searchFilteredSessions.map((session: any, rowIndex: number) => {
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
                        key={`${session.session_id}-${rowIndex}`}
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

              {/* Trigger para scroll infinito (solo si NO usa datos externos) */}
              {!useExternalData && hasMore && (
                <div
                  ref={loadMoreTriggerRef}
                  style={{
                    height: '100px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.875rem',
                    color: 'var(--color-text-secondary)'
                  }}
                >
                  {loadingMore ? (
                    <RefreshCw size={16} className={styles.spinIcon} aria-hidden="true" />
                  ) : (
                    'Desplázate hacia abajo para cargar más'
                  )}
                </div>
              )}

              {!useExternalData && !hasMore && sessions.length > 0 && (
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
