import React, { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../Button/Button'
import { RefreshCw, Maximize2, Minimize2, Search, ChevronLeft, ChevronRight, Activity } from 'lucide-react'
import { trackingService, TrackingSession } from '@/services/trackingService'
import { useTimezone } from '@/contexts/TimezoneContext'
import styles from './SessionsTable.module.css'

interface SessionsTableProps {
  className?: string
}

export const SessionsTable: React.FC<SessionsTableProps> = ({ className }) => {
  const { formatLocalDateTime } = useTimezone()

  const [recentSessions, setRecentSessions] = useState<TrackingSession[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)

  // Estados para paginación y vista expandida
  const [currentPage, setCurrentPage] = useState(1)
  const [isExpanded, setIsExpanded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchColumn, setSearchColumn] = useState<string>('all')
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const ITEMS_PER_PAGE = 10
  const DEFAULT_COLUMN_WIDTH = 150

  useEffect(() => {
    loadRecentSessions()
  }, [])

  const loadRecentSessions = async () => {
    setLoadingSessions(true)
    try {
      const sessions = await trackingService.getSessions(50)
      setRecentSessions(sessions)
    } catch (error) {
      // Silent error
    } finally {
      setLoadingSessions(false)
    }
  }

  // Filtrar sesiones por búsqueda
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return recentSessions

    const query = searchQuery.toLowerCase()

    return recentSessions.filter((session: any) => {
      // Si busca en columna específica
      if (searchColumn !== 'all') {
        const value = session[searchColumn]
        return value ? String(value).toLowerCase().includes(query) : false
      }

      // Si busca en todas las columnas
      return (
        session.session_id?.toLowerCase().includes(query) ||
        session.visitor_id?.toLowerCase().includes(query) ||
        session.contact_id?.toLowerCase().includes(query) ||
        session.full_name?.toLowerCase().includes(query) ||
        session.email?.toLowerCase().includes(query) ||
        session.utm_source?.toLowerCase().includes(query) ||
        session.utm_medium?.toLowerCase().includes(query) ||
        session.utm_campaign?.toLowerCase().includes(query) ||
        session.page_url?.toLowerCase().includes(query) ||
        session.referrer_url?.toLowerCase().includes(query) ||
        session.ip?.toLowerCase().includes(query) ||
        session.device_type?.toLowerCase().includes(query) ||
        session.browser?.toLowerCase().includes(query) ||
        session.os?.toLowerCase().includes(query) ||
        session.geo_country?.toLowerCase().includes(query) ||
        session.geo_city?.toLowerCase().includes(query)
      )
    })
  }, [recentSessions, searchQuery, searchColumn])

  // Calcular sesiones paginadas (solo para vista normal)
  const paginatedSessions = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE
    const endIndex = startIndex + ITEMS_PER_PAGE
    return recentSessions.slice(startIndex, endIndex)
  }, [recentSessions, currentPage, ITEMS_PER_PAGE])

  const totalPages = Math.ceil(recentSessions.length / ITEMS_PER_PAGE)

  const handlePreviousPage = () => {
    setCurrentPage(prev => Math.max(1, prev - 1))
  }

  const handleNextPage = () => {
    setCurrentPage(prev => Math.min(totalPages, prev + 1))
  }

  const handleToggleExpanded = () => {
    setIsExpanded(prev => !prev)
    if (!isExpanded) {
      setSearchQuery('')
      setSearchColumn('all')
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
          borderBottom: '2px solid var(--color-border)',
          width: `${displayWidth}px`,
          minWidth: `${displayWidth}px`,
          maxWidth: `${displayWidth}px`,
          position: 'relative',
          userSelect: 'none',
          backgroundColor: 'var(--color-surface)',
          backgroundImage: 'linear-gradient(to bottom, var(--color-gray-50), var(--color-surface))'
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
                e.currentTarget.style.backgroundColor = 'var(--color-border)'
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

  return (
    <>
      {/* Tabla de eventos de tracking */}
      <div className={`${styles.section} ${className}`}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Eventos de Tracking</h3>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Button
              variant="ghost"
              size="small"
              onClick={handleToggleExpanded}
              title="Vista expandida"
            >
              <Maximize2 size={16} />
            </Button>
            <Button
              variant="ghost"
              size="small"
              onClick={loadRecentSessions}
              disabled={loadingSessions}
            >
              <RefreshCw size={16} className={loadingSessions ? styles.spinIcon : ''} />
              {loadingSessions ? 'Cargando...' : 'Actualizar'}
            </Button>
          </div>
        </div>

        {recentSessions.length > 0 ? (
          <>
            {/* Información de paginación */}
            <div style={{
              padding: '12px 0',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '0.875rem',
              color: 'var(--color-text-secondary)'
            }}>
              <span>
                Mostrando {((currentPage - 1) * ITEMS_PER_PAGE) + 1} - {Math.min(currentPage * ITEMS_PER_PAGE, recentSessions.length)} de {recentSessions.length} sesiones
              </span>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={handlePreviousPage}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft size={16} />
                  Anterior
                </Button>
                <span style={{ padding: '0 8px' }}>
                  Página {currentPage} de {totalPages}
                </span>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={handleNextPage}
                  disabled={currentPage === totalPages}
                >
                  Siguiente
                  <ChevronRight size={16} />
                </Button>
              </div>
            </div>

            <div className={styles.tableContainer} style={{ overflowX: 'auto' }}>
              <table className={styles.table} style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    {/* Mostrar solo las columnas más importantes en vista normal */}
                    <th style={{ width: '100px' }}>Session ID</th>
                    <th style={{ width: '100px' }}>Visitor ID</th>
                    <th style={{ width: '120px' }}>Full Name</th>
                    <th style={{ width: '120px' }}>Started At</th>
                    <th style={{ width: '200px' }}>Page URL</th>
                    <th style={{ width: '120px' }}>UTM Source</th>
                    <th style={{ width: '150px' }}>UTM Campaign</th>
                    <th style={{ width: '100px' }}>Device Type</th>
                    <th style={{ width: '100px' }}>Country</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedSessions.map((session: any) => {
                    const cellStyle = {
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap' as const
                    }

                    return (
                      <tr key={session.session_id}>
                        <td style={cellStyle} title={session.session_id}>
                          <code style={{ fontSize: '0.7rem' }}>{session.session_id || '-'}</code>
                        </td>
                        <td style={cellStyle} title={session.visitor_id}>
                          <code style={{ fontSize: '0.7rem' }}>{session.visitor_id || '-'}</code>
                        </td>
                        <td style={cellStyle} title={session.full_name}>{session.full_name || '-'}</td>
                        <td style={cellStyle}>{formatLocalDateTime(session.started_at)}</td>
                        <td style={cellStyle} title={session.page_url}>
                          <a href={session.page_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>
                            {session.page_url || '-'}
                          </a>
                        </td>
                        <td style={cellStyle} title={session.utm_source}>{session.utm_source || '-'}</td>
                        <td style={cellStyle} title={session.utm_campaign}>{session.utm_campaign || '-'}</td>
                        <td style={{...cellStyle, textTransform: 'capitalize'}} title={session.device_type}>{session.device_type || '-'}</td>
                        <td style={cellStyle} title={session.geo_country}>{session.geo_country || '-'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className={styles.emptyState}>
            <Activity size={48} style={{ opacity: 0.3, marginBottom: '16px' }} />
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
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          {/* Header del modal expandido */}
          <div style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--color-border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: 'var(--color-surface)'
          }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
              Eventos de Tracking - Vista Completa
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

          {/* Buscador con filtros */}
          <div style={{
            padding: '16px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface)',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', gap: '12px', flex: 1, maxWidth: '700px' }}>
              {/* Dropdown de columnas */}
              <select
                value={searchColumn}
                onChange={(e) => setSearchColumn(e.target.value)}
                style={{
                  padding: '8px 12px',
                  border: '1px solid var(--color-border)',
                  borderRadius: '6px',
                  fontSize: '0.875rem',
                  backgroundColor: 'var(--color-background)',
                  color: 'var(--color-text)',
                  outline: 'none',
                  cursor: 'pointer',
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
              </select>

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
                    border: '1px solid var(--color-border)',
                    borderRadius: '6px',
                    fontSize: '0.875rem',
                    backgroundColor: 'var(--color-background)',
                    color: 'var(--color-text)',
                    outline: 'none'
                  }}
                />
              </div>
            </div>
            <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
              {filteredSessions.length} {filteredSessions.length === 1 ? 'sesión' : 'sesiones'} {searchQuery.trim() && `(filtradas de ${recentSessions.length})`}
            </span>
          </div>

          {/* Tabla expandida con scroll y padding */}
          <div style={{
            flex: 1,
            overflow: 'auto',
            padding: '0 40px 20px 40px'
          }}>
            <div style={{
              height: '100%',
              overflowX: 'auto',
              overflowY: 'auto'
            }}>
              <table style={{
                borderCollapse: 'collapse',
                fontSize: '0.875rem',
                backgroundColor: 'var(--color-surface)',
                width: '100%'
              }}>
                <thead style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 10
                }}>
                  <tr>
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
                  {filteredSessions.map((session: any, rowIndex: number) => {
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
                      <tr key={`${session.session_id}-${rowIndex}`} style={{ borderBottom: '1px solid var(--color-border)' }}>
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
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
