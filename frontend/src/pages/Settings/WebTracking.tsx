import React, { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Card, Button } from '@/components/common'
import { Activity, Copy, Check, Info, Loader2, RefreshCw, Maximize2, Minimize2, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { trackingService, TrackingSession } from '@/services/trackingService'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig } from '@/hooks'
import styles from './HighLevelIntegration.module.css'

export const WebTracking: React.FC = () => {
  const { showToast } = useNotification()
  const { formatLocalDateTime } = useTimezone()

  // Detectar si estamos en dominio .onrender.com
  const isOnRenderDomain = useMemo(() => {
    return window.location.hostname.includes('.onrender.com')
  }, [])

  // Sistema híbrido de configuración (cache + DB)
  // Defaults: false y 'platform' hasta que se configure dominio personalizado
  const [showAnalytics, setShowAnalytics, savingAnalyticsPref] = useAppConfig('show_analytics', false)
  const [visitorSource, setVisitorSource, savingVisitorPref] = useAppConfig<'platform' | 'tracking'>('visitor_source', 'platform')

  const [trackingDomain, setTrackingDomain] = useState('')
  const [copied, setCopied] = useState(false)
  const [recentSessions, setRecentSessions] = useState<TrackingSession[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [configuringTracking, setConfiguringTracking] = useState(false)
  const [isConfigured, setIsConfigured] = useState(false)
  const [hasHighLevel, setHasHighLevel] = useState(false)
  const [hasAutoActivated, setHasAutoActivated] = useState(false)

  // Estados para paginación y vista expandida
  const [currentPage, setCurrentPage] = useState(1)
  const [isExpanded, setIsExpanded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const ITEMS_PER_PAGE = 10
  const DEFAULT_COLUMN_WIDTH = 150 // Ancho uniforme inicial

  useEffect(() => {
    loadTrackingConfig()
    loadRecentSessions()
  }, [])

  const loadTrackingConfig = async () => {
    setLoadingConfig(true)
    try {
      const config = await trackingService.getTrackingConfig()
      setTrackingDomain(config.trackingDomain || '')
      setIsConfigured(config.isConfigured)
      setHasHighLevel(config.hasHighLevel)

      // Si es .onrender.com → FORZAR analytics OFF y visitor source a 'platform'
      if (isOnRenderDomain) {
        if (showAnalytics !== false) {
          await setShowAnalytics(false)
        }
        if (visitorSource !== 'platform') {
          await setVisitorSource('platform')
        }

        // Disparar eventos para actualizar el sidebar
        window.dispatchEvent(new CustomEvent('analytics-preference-changed', {
          detail: { showAnalytics: false }
        }))
        window.dispatchEvent(new CustomEvent('visitor-source-changed', {
          detail: { visitorSource: 'platform' }
        }))
      }
      // Si NO es .onrender.com → Activación automática
      else if (config.trackingDomain && !hasAutoActivated) {
        // Activar analytics y visitor tracking automáticamente
        if (!showAnalytics) {
          await setShowAnalytics(true)
        }
        if (visitorSource !== 'tracking') {
          await setVisitorSource('tracking')
        }
        setHasAutoActivated(true)

        // Disparar eventos para actualizar el sidebar
        window.dispatchEvent(new CustomEvent('analytics-preference-changed', {
          detail: { showAnalytics: true }
        }))
        window.dispatchEvent(new CustomEvent('visitor-source-changed', {
          detail: { visitorSource: 'tracking' }
        }))
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudo cargar la configuración del tracking')
    } finally {
      setLoadingConfig(false)
    }
  }

  const loadRecentSessions = async () => {
    setLoadingSessions(true)
    try {
      const sessions = await trackingService.getSessions(50) // Aumentamos a 50 para ver más datos
      setRecentSessions(sessions)
    } catch (error) {
      // Silent error
    } finally {
      setLoadingSessions(false)
    }
  }

  const handleConfigureTracking = async () => {
    if (!hasHighLevel) {
      showToast('error', 'Error', 'Primero configura HighLevel en Settings')
      return
    }

    // Validar que el dominio sea válido (formato básico)
    if (!trackingDomain.trim() || !trackingDomain.includes('.')) {
      showToast(
        'error',
        'Dominio inválido',
        'Ingresa un dominio válido (ej: track.tudominio.com). Configura el CNAME en tu DNS primero.'
      )
      return
    }

    setConfiguringTracking(true)
    try {
      const result = await trackingService.configureTracking()

      if (result.success) {
        showToast('success', '¡Listo!', 'Custom value actualizado en HighLevel')
        setIsConfigured(true)
        // Recargar config para actualizar estado
        await loadTrackingConfig()
      } else {
        showToast('error', 'Error', result.error || 'No se pudo configurar')
      }
    } catch (error: any) {
      showToast('error', 'Error', error.message || 'Error configurando')
    } finally {
      setConfiguringTracking(false)
    }
  }

  const handleCopySnippet = async () => {
    if (!trackingDomain.trim()) {
      showToast('error', 'Error', 'Ingresa tu dominio primero')
      return
    }

    const snippet = trackingService.generateSnippet(trackingDomain)
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      showToast('success', 'Copiado', 'Código copiado al portapapeles')
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      showToast('error', 'Error', 'No se pudo copiar')
    }
  }

  const handleToggleAnalytics = async () => {
    try {
      const newValue = !showAnalytics
      await setShowAnalytics(newValue)

      showToast(
        'success',
        'Guardado',
        newValue
          ? 'La página de Analíticas ahora está visible en el menú'
          : 'La página de Analíticas se ha ocultado del menú'
      )

      // Disparar evento personalizado para que el Sidebar se actualice
      window.dispatchEvent(new CustomEvent('analytics-preference-changed', {
        detail: { showAnalytics: newValue }
      }))
    } catch (error) {
      showToast('error', 'Error', 'No se pudo guardar la preferencia')
    }
  }

  const handleToggleVisitorSource = async () => {
    try {
      const newValue = visitorSource === 'platform' ? 'tracking' : 'platform'
      await setVisitorSource(newValue)

      showToast(
        'success',
        'Guardado',
        newValue === 'tracking'
          ? 'Ahora se usan los visitantes del tracking interno'
          : 'Ahora se usan los visitantes de las plataformas de anuncios'
      )

      // Disparar evento personalizado para que las páginas se actualicen
      window.dispatchEvent(new CustomEvent('visitor-source-changed', {
        detail: { visitorSource: newValue }
      }))
    } catch (error) {
      showToast('error', 'Error', 'No se pudo guardar la preferencia')
    }
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString('es-MX', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // Filtrar sesiones por búsqueda
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return recentSessions

    const query = searchQuery.toLowerCase()
    return recentSessions.filter((session: any) => {
      return (
        session.session_id?.toLowerCase().includes(query) ||
        session.visitor_id?.toLowerCase().includes(query) ||
        session.contact_id?.toLowerCase().includes(query) ||
        session.full_name?.toLowerCase().includes(query) ||
        session.email?.toLowerCase().includes(query) ||
        session.utm_source?.toLowerCase().includes(query) ||
        session.utm_medium?.toLowerCase().includes(query) ||
        session.utm_campaign?.toLowerCase().includes(query) ||
        session.landing_url?.toLowerCase().includes(query) ||
        session.referrer_url?.toLowerCase().includes(query) ||
        session.ip?.toLowerCase().includes(query) ||
        session.device_type?.toLowerCase().includes(query) ||
        session.browser?.toLowerCase().includes(query) ||
        session.os?.toLowerCase().includes(query) ||
        session.geo_country?.toLowerCase().includes(query) ||
        session.geo_city?.toLowerCase().includes(query)
      )
    })
  }, [recentSessions, searchQuery])

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
      // Al abrir, resetear búsqueda
      setSearchQuery('')
    }
  }

  const handleColumnResize = (columnKey: string, newWidth: number) => {
    setColumnWidths(prev => ({
      ...prev,
      [columnKey]: Math.max(80, newWidth) // Mínimo 80px
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
          userSelect: 'none'
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

  // Definir las columnas una sola vez
  const columns = [
    { key: 'session_id', label: 'Session ID' },
    { key: 'visitor_id', label: 'Visitor ID' },
    { key: 'contact_id', label: 'Contact ID' },
    { key: 'full_name', label: 'Full Name' },
    { key: 'event_name', label: 'Event Name' },
    { key: 'started_at', label: 'Started At' },
    { key: 'last_event_at', label: 'Last Event At' },
    { key: 'created_at', label: 'Created At' },
    { key: 'landing_url', label: 'Landing URL' },
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
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        {/* Header */}
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <div className={styles.logoContainer}>
                <Activity size={40} color="var(--color-primary)" strokeWidth={2.5} />
              </div>
              <div>
                <h1 className={styles.pageTitle}>Web Tracking</h1>
                <p className={styles.pageSubtitle}>
                  {isOnRenderDomain
                    ? 'Configura un dominio personalizado para activar el tracking'
                    : 'Captura visitas, UTMs y atribución de campañas'}
                </p>
              </div>
            </div>
            <div className={styles.headerRight}>
              {loadingConfig ? (
                <div className={styles.statusConnected}>
                  <Loader2 size={16} className={styles.spinIcon} />
                  <span>Verificando...</span>
                </div>
              ) : !isOnRenderDomain && isConfigured ? (
                <div className={styles.statusConnected}>
                  <Check size={16} />
                  <span>Configurado</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Mostrar instrucciones si es dominio .onrender.com */}
        {isOnRenderDomain ? (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>🚫 NO tienes acceso a esta vista</h3>
              <p className={styles.sectionSubtitle} style={{ marginTop: '12px', fontSize: '1rem', color: 'var(--color-text-secondary)', lineHeight: '1.6' }}>
                Para obtener acceso al Web Tracking, simplemente configura un dominio personalizado siguiendo los pasos a continuación.
              </p>
            </div>

            <div style={{ marginTop: '32px' }}>
              <h4 className={styles.sectionTitle} style={{ fontSize: '1.1rem', marginBottom: '16px' }}>
                📋 Instrucciones de configuración
              </h4>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* Paso 1 */}
                <div style={{ padding: '20px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                    <div style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      background: 'var(--color-primary)',
                      color: 'white',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 'bold',
                      fontSize: '1.1rem'
                    }}>1</div>
                    <h5 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                      Configurar CNAME en tu DNS
                    </h5>
                  </div>
                  <p style={{ margin: '0 0 12px 44px', color: 'var(--color-text-secondary)', fontSize: '0.95rem' }}>
                    Ve a tu proveedor de DNS (Cloudflare, GoDaddy, Namecheap, etc.) y crea un registro CNAME:
                  </p>
                  <div className={styles.codeBlock} style={{ marginLeft: '44px', padding: '16px', fontSize: '0.9rem' }}>
                    <div style={{ marginBottom: '8px' }}><strong>Tipo:</strong> <code>CNAME</code></div>
                    <div style={{ marginBottom: '8px' }}><strong>Nombre/Host:</strong> <code>track</code> (o el subdominio que prefieras)</div>
                    <div><strong>Apunta a:</strong> <code>ristak-app.onrender.com</code></div>
                  </div>
                  <p style={{ margin: '12px 0 0 44px', color: 'var(--color-text-secondary)', fontSize: '0.85rem', fontStyle: 'italic' }}>
                    Ejemplo: Si tu dominio es <strong>miempresa.com</strong>, el CNAME creará <strong>track.miempresa.com</strong>
                  </p>
                </div>

                {/* Paso 2 */}
                <div style={{ padding: '20px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                    <div style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      background: 'var(--color-primary)',
                      color: 'white',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 'bold',
                      fontSize: '1.1rem'
                    }}>2</div>
                    <h5 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                      Configurar dominio personalizado en Render
                    </h5>
                  </div>
                  <p style={{ margin: '0 0 12px 44px', color: 'var(--color-text-secondary)', fontSize: '0.95rem' }}>
                    Ve a tu app en Render Dashboard:
                  </p>
                  <ol style={{ margin: '0 0 0 60px', padding: 0, color: 'var(--color-text-secondary)', fontSize: '0.9rem', lineHeight: '1.8' }}>
                    <li>Abre tu servicio <strong>ristak-app</strong></li>
                    <li>Ve a la pestaña <strong>Settings</strong></li>
                    <li>Busca la sección <strong>Custom Domains</strong></li>
                    <li>Click en <strong>Add Custom Domain</strong></li>
                    <li>Ingresa el dominio: <code>track.tudominio.com</code></li>
                    <li>Espera a que el estado cambie a <strong>Verified</strong> (puede tardar 5-10 minutos)</li>
                  </ol>
                </div>

                {/* Paso 3 */}
                <div style={{ padding: '20px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                    <div style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      background: 'var(--color-primary)',
                      color: 'white',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 'bold',
                      fontSize: '1.1rem'
                    }}>3</div>
                    <h5 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                      Acceder usando tu dominio personalizado
                    </h5>
                  </div>
                  <p style={{ margin: '0 0 12px 44px', color: 'var(--color-text-secondary)', fontSize: '0.95rem' }}>
                    Una vez que Render haya verificado el dominio:
                  </p>
                  <div style={{ marginLeft: '44px', padding: '16px', background: 'var(--color-success-bg)', border: '1px solid var(--color-success)', borderRadius: '6px' }}>
                    <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--color-success-dark)' }}>
                      ✅ Abre tu navegador y ve a <strong>track.tudominio.com</strong>
                    </p>
                    <p style={{ margin: '8px 0 0 0', fontSize: '0.85rem', color: 'var(--color-success-dark)', fontStyle: 'italic' }}>
                      Esta página se recargará automáticamente y el Web Tracking se activará
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.infoBox} style={{ marginTop: '32px' }}>
              <div className={styles.infoBoxTitle}>
                <Info size={16} />
                <span>¿Necesitas ayuda?</span>
              </div>
              <div className={styles.infoBoxContent} style={{ marginTop: '8px' }}>
                Si tienes problemas con la configuración, contacta a soporte técnico
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Configuración normal (dominio personalizado detectado) */}
            <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Configuración Rápida</h3>
            <p className={styles.sectionSubtitle} style={{ marginTop: '4px', fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
              Sigue 3 pasos simples para activar el tracking
            </p>
          </div>

          {!hasHighLevel ? (
            <div className={styles.infoBox}>
              <div className={styles.infoBoxTitle}>
                <Info size={16} />
                <span>Primero configura HighLevel</span>
              </div>
              <div className={styles.infoBoxContent}>
                Ve a la sección de HighLevel en Settings y conéctalo primero
              </div>
            </div>
          ) : !trackingDomain.trim() ? (
            <div className={styles.warningBox}>
              <div className={styles.infoBoxTitle}>
                <Info size={16} />
                <span>Paso 1: Configurar CNAME</span>
              </div>
              <div className={styles.infoBoxContent}>
                Ve a tu proveedor de DNS (Cloudflare, GoDaddy, etc.) y crea un CNAME:
              </div>
              <div className={styles.codeBlock} style={{ marginTop: '12px', padding: '12px', fontSize: '0.875rem' }}>
                <div><strong>Tipo:</strong> CNAME</div>
                <div><strong>Nombre:</strong> collect</div>
                <div><strong>Apunta a:</strong> ristak-app.onrender.com</div>
              </div>
              <div className={styles.infoBoxContent} style={{ marginTop: '12px' }}>
                Luego accede a esta página usando <code className={styles.codeInline}>collect.tudominio.com</code>
              </div>
            </div>
          ) : (
            <>
              {/* Paso 1: Dominio detectado */}
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>
                  ✅ Paso 1: Dominio configurado
                </label>
                <div className={styles.formInput} style={{ background: 'var(--color-success-bg)', border: '1px solid var(--color-success)', cursor: 'default', color: 'var(--color-success)', fontWeight: 600 }}>
                  {trackingDomain}
                </div>
              </div>

              {/* Paso 2: Sincronizar */}
              <div className={styles.formGroup} style={{ marginTop: '24px' }}>
                <label className={styles.formLabel}>
                  {isConfigured ? '✅' : '2️⃣'} Paso 2: Sincronizar con HighLevel
                </label>
                <p className={styles.formHint} style={{ marginBottom: '12px' }}>
                  Esto guarda el código del pixel en HighLevel automáticamente
                </p>
                <Button
                  variant="primary"
                  onClick={handleConfigureTracking}
                  disabled={configuringTracking}
                >
                  {configuringTracking ? (
                    <>
                      <Loader2 size={16} className={styles.spinIcon} />
                      Sincronizando...
                    </>
                  ) : (
                    <>
                      <RefreshCw size={16} />
                      {isConfigured ? 'Volver a sincronizar' : 'Sincronizar ahora'}
                    </>
                  )}
                </Button>
                {isConfigured && (
                  <div style={{ marginTop: '12px', padding: '12px', background: 'var(--color-success-bg)', border: '1px solid var(--color-success)', borderRadius: '6px', fontSize: '0.875rem', color: 'var(--color-success)' }}>
                    ✅ Ya está sincronizado. El código está guardado como <code className={styles.codeInline}>rstktrack</code> en HighLevel
                  </div>
                )}
              </div>

              {/* Paso 3: Código del pixel */}
              <div className={styles.formGroup} style={{ marginTop: '24px' }}>
                <label className={styles.formLabel}>
                  3️⃣ Paso 3: Instalar en tu sitio
                </label>
                <p className={styles.formHint} style={{ marginBottom: '12px' }}>
                  Copia este código y pégalo en tu sitio web (ver tutorial abajo)
                </p>
                <div className={styles.codeBlockWrapper}>
                  <button
                    onClick={handleCopySnippet}
                    className={styles.copyIconButton}
                    title={copied ? 'Copiado!' : 'Copiar código'}
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                  <div className={styles.codeBlock}>
                    <pre className={styles.codeContent}>
                      {trackingService.generateSnippet(trackingDomain)}
                    </pre>
                  </div>
                </div>
                <div style={{ marginTop: '12px', padding: '12px', background: 'var(--color-gray-50)', borderRadius: '6px', fontSize: '0.875rem' }}>
                  <strong>¿Dónde lo pego?</strong>
                  <ul style={{ marginTop: '8px', marginLeft: '20px', lineHeight: '1.8' }}>
                    <li><strong>WordPress:</strong> Apariencia → Editor de temas → footer.php (antes de &lt;/body&gt;)</li>
                    <li><strong>HighLevel:</strong> En tu landing page → Settings → Footer Scripts</li>
                    <li><strong>Shopify:</strong> Configuración → Checkout → Scripts adicionales</li>
                  </ul>
                </div>
              </div>

              {/* Switch para mostrar/ocultar Analytics */}
              <div className={styles.formGroup} style={{ marginTop: '32px', paddingTop: '24px', borderTop: '1px solid var(--color-border)' }}>
                <label className={styles.formLabel} style={{ marginBottom: '8px' }}>
                  Página de Analíticas
                </label>
                <p className={styles.formHint} style={{ marginBottom: '16px' }}>
                  Controla si la página de Analíticas aparece en el menú lateral
                </p>
                <div className={styles.toggleContainer}>
                  <span className={`${styles.toggleLabel} ${!showAnalytics ? styles.toggleLabelActive : ''}`}>
                    Oculta
                  </span>
                  <button
                    onClick={handleToggleAnalytics}
                    className={`${styles.toggle} ${showAnalytics ? styles.toggleActive : ''}`}
                    disabled={savingAnalyticsPref}
                  >
                    <span className={styles.toggleThumb} />
                  </button>
                  <span className={`${styles.toggleLabel} ${showAnalytics ? styles.toggleLabelActive : ''}`}>
                    Visible
                  </span>
                </div>
              </div>

              {/* Switch para fuente de visitantes */}
              <div className={styles.formGroup} style={{ marginTop: '32px', paddingTop: '24px', borderTop: '1px solid var(--color-border)' }}>
                <label className={styles.formLabel} style={{ marginBottom: '8px' }}>
                  Fuente de Visitantes
                </label>
                <p className={styles.formHint} style={{ marginBottom: '16px' }}>
                  Elige de dónde obtener los datos de visitantes para las páginas de Campañas y Reportes
                </p>
                <div className={styles.toggleContainer}>
                  <span className={`${styles.toggleLabel} ${visitorSource === 'platform' ? styles.toggleLabelActive : ''}`}>
                    Plataforma de Anuncios
                  </span>
                  <button
                    onClick={handleToggleVisitorSource}
                    className={`${styles.toggle} ${visitorSource === 'tracking' ? styles.toggleActive : ''}`}
                    disabled={savingVisitorPref}
                  >
                    <span className={styles.toggleThumb} />
                  </button>
                  <span className={`${styles.toggleLabel} ${visitorSource === 'tracking' ? styles.toggleLabelActive : ''}`}>
                    Tracking Interno
                  </span>
                </div>
                <p className={styles.formHint} style={{ marginTop: '12px', fontSize: '0.85rem' }}>
                  {visitorSource === 'platform'
                    ? '✓ Usando métricas reportadas por Meta Ads, Google Ads, etc.'
                    : '✓ Usando visitantes capturados por nuestro pixel de tracking'}
                </p>
              </div>
            </>
          )}
          </div>
        </>
        )}

        {/* Tabla de eventos de tracking (solo visible si NO es onrender.com) */}
        {!isOnRenderDomain && (
          <div className={styles.section}>
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
                    {/* IDs y Timestamps */}
                    <th style={{ width: '100px' }}>Session ID</th>
                    <th style={{ width: '100px' }}>Visitor ID</th>
                    <th style={{ width: '100px' }}>Contact ID</th>
                    <th style={{ width: '120px' }}>Full Name</th>
                    <th style={{ width: '100px' }}>Event Name</th>
                    <th style={{ width: '120px' }}>Started At</th>
                    <th style={{ width: '120px' }}>Last Event At</th>
                    <th style={{ width: '120px' }}>Created At</th>

                    {/* URLs */}
                    <th style={{ width: '200px' }}>Landing URL</th>
                    <th style={{ width: '150px' }}>Referrer URL</th>

                    {/* UTMs */}
                    <th style={{ width: '120px' }}>UTM Source</th>
                    <th style={{ width: '120px' }}>UTM Medium</th>
                    <th style={{ width: '150px' }}>UTM Campaign</th>
                    <th style={{ width: '120px' }}>UTM Term</th>
                    <th style={{ width: '120px' }}>UTM Content</th>

                    {/* Click IDs */}
                    <th style={{ width: '120px' }}>GCLID</th>
                    <th style={{ width: '120px' }}>FBCLID</th>
                    <th style={{ width: '120px' }}>FBC</th>
                    <th style={{ width: '120px' }}>FBP</th>
                    <th style={{ width: '100px' }}>WBRAID</th>
                    <th style={{ width: '100px' }}>GBRAID</th>
                    <th style={{ width: '100px' }}>MSCLKID</th>
                    <th style={{ width: '100px' }}>TTCLID</th>

                    {/* Campaign Details */}
                    <th style={{ width: '100px' }}>Channel</th>
                    <th style={{ width: '120px' }}>Source Platform</th>
                    <th style={{ width: '120px' }}>Campaign ID</th>
                    <th style={{ width: '120px' }}>Adset ID</th>
                    <th style={{ width: '120px' }}>Ad Group ID</th>
                    <th style={{ width: '120px' }}>Ad ID</th>
                    <th style={{ width: '150px' }}>Campaign Name</th>
                    <th style={{ width: '150px' }}>Adset Name</th>
                    <th style={{ width: '150px' }}>Ad Group Name</th>
                    <th style={{ width: '150px' }}>Ad Name</th>
                    <th style={{ width: '120px' }}>Placement</th>
                    <th style={{ width: '120px' }}>Site Source Name</th>
                    <th style={{ width: '100px' }}>Network</th>
                    <th style={{ width: '100px' }}>Match Type</th>
                    <th style={{ width: '120px' }}>Keyword</th>
                    <th style={{ width: '150px' }}>Search Query</th>
                    <th style={{ width: '120px' }}>Creative ID</th>
                    <th style={{ width: '100px' }}>Ad Position</th>

                    {/* Device & Browser */}
                    <th style={{ width: '120px' }}>IP</th>
                    <th style={{ width: '200px' }}>User Agent</th>
                    <th style={{ width: '100px' }}>Device Type</th>
                    <th style={{ width: '100px' }}>OS</th>
                    <th style={{ width: '100px' }}>Browser</th>
                    <th style={{ width: '100px' }}>Browser Version</th>
                    <th style={{ width: '80px' }}>Language</th>
                    <th style={{ width: '120px' }}>Timezone</th>

                    {/* Geo */}
                    <th style={{ width: '100px' }}>Country</th>
                    <th style={{ width: '120px' }}>Region</th>
                    <th style={{ width: '120px' }}>City</th>
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
                        {/* IDs y Timestamps */}
                        <td style={cellStyle} title={session.session_id}>
                          <code style={{ fontSize: '0.7rem' }}>{session.session_id || '-'}</code>
                        </td>
                        <td style={cellStyle} title={session.visitor_id}>
                          <code style={{ fontSize: '0.7rem' }}>{session.visitor_id || '-'}</code>
                        </td>
                        <td style={cellStyle} title={session.contact_id}>
                          {session.contact_id ? <code style={{ fontSize: '0.7rem' }}>{session.contact_id}</code> : '-'}
                        </td>
                        <td style={cellStyle} title={session.full_name}>{session.full_name || '-'}</td>
                        <td style={cellStyle} title={session.event_name}>{session.event_name || '-'}</td>
                        <td style={cellStyle}>{formatLocalDateTime(session.started_at)}</td>
                        <td style={cellStyle}>{session.last_event_at ? formatLocalDateTime(session.last_event_at) : '-'}</td>
                        <td style={cellStyle}>{session.created_at ? formatLocalDateTime(session.created_at) : '-'}</td>

                        {/* URLs */}
                        <td style={cellStyle} title={session.landing_url}>
                          <a href={session.landing_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>
                            {session.landing_url || '-'}
                          </a>
                        </td>
                        <td style={{...cellStyle, fontSize: '0.75rem'}} title={session.referrer_url}>
                          {session.referrer_url || '-'}
                        </td>

                        {/* UTMs */}
                        <td style={cellStyle} title={session.utm_source}>{session.utm_source || '-'}</td>
                        <td style={cellStyle} title={session.utm_medium}>{session.utm_medium || '-'}</td>
                        <td style={cellStyle} title={session.utm_campaign}>{session.utm_campaign || '-'}</td>
                        <td style={cellStyle} title={session.utm_term}>{session.utm_term || '-'}</td>
                        <td style={cellStyle} title={session.utm_content}>{session.utm_content || '-'}</td>

                        {/* Click IDs */}
                        <td style={cellStyle} title={session.gclid}>
                          {session.gclid ? <code style={{ fontSize: '0.7rem' }}>{session.gclid}</code> : '-'}
                        </td>
                        <td style={cellStyle} title={session.fbclid}>
                          {session.fbclid ? <code style={{ fontSize: '0.7rem' }}>{session.fbclid}</code> : '-'}
                        </td>
                        <td style={cellStyle} title={session.fbc}>{session.fbc || '-'}</td>
                        <td style={cellStyle} title={session.fbp}>{session.fbp || '-'}</td>
                        <td style={cellStyle} title={session.wbraid}>{session.wbraid || '-'}</td>
                        <td style={cellStyle} title={session.gbraid}>{session.gbraid || '-'}</td>
                        <td style={cellStyle} title={session.msclkid}>{session.msclkid || '-'}</td>
                        <td style={cellStyle} title={session.ttclid}>{session.ttclid || '-'}</td>

                        {/* Campaign Details */}
                        <td style={cellStyle} title={session.channel}>{session.channel || '-'}</td>
                        <td style={cellStyle} title={session.source_platform}>{session.source_platform || '-'}</td>
                        <td style={cellStyle} title={session.campaign_id}>{session.campaign_id || '-'}</td>
                        <td style={cellStyle} title={session.adset_id}>{session.adset_id || '-'}</td>
                        <td style={cellStyle} title={session.ad_group_id}>{session.ad_group_id || '-'}</td>
                        <td style={cellStyle} title={session.ad_id}>{session.ad_id || '-'}</td>
                        <td style={cellStyle} title={session.campaign_name}>{session.campaign_name || '-'}</td>
                        <td style={cellStyle} title={session.adset_name}>{session.adset_name || '-'}</td>
                        <td style={cellStyle} title={session.ad_group_name}>{session.ad_group_name || '-'}</td>
                        <td style={cellStyle} title={session.ad_name}>{session.ad_name || '-'}</td>
                        <td style={cellStyle} title={session.placement}>{session.placement || '-'}</td>
                        <td style={cellStyle} title={session.site_source_name}>{session.site_source_name || '-'}</td>
                        <td style={cellStyle} title={session.network}>{session.network || '-'}</td>
                        <td style={cellStyle} title={session.match_type}>{session.match_type || '-'}</td>
                        <td style={cellStyle} title={session.keyword}>{session.keyword || '-'}</td>
                        <td style={cellStyle} title={session.search_query}>{session.search_query || '-'}</td>
                        <td style={cellStyle} title={session.creative_id}>{session.creative_id || '-'}</td>
                        <td style={cellStyle} title={session.ad_position}>{session.ad_position || '-'}</td>

                        {/* Device & Browser */}
                        <td style={{...cellStyle, fontSize: '0.75rem'}} title={session.ip}>{session.ip || '-'}</td>
                        <td style={{...cellStyle, fontSize: '0.7rem'}} title={session.user_agent}>{session.user_agent || '-'}</td>
                        <td style={{...cellStyle, textTransform: 'capitalize'}} title={session.device_type}>{session.device_type || '-'}</td>
                        <td style={cellStyle} title={session.os}>{session.os || '-'}</td>
                        <td style={cellStyle} title={session.browser}>{session.browser || '-'}</td>
                        <td style={cellStyle} title={session.browser_version}>{session.browser_version || '-'}</td>
                        <td style={cellStyle} title={session.language}>{session.language || '-'}</td>
                        <td style={cellStyle} title={session.timezone}>{session.timezone || '-'}</td>

                        {/* Geo */}
                        <td style={cellStyle} title={session.geo_country}>{session.geo_country || '-'}</td>
                        <td style={cellStyle} title={session.geo_region}>{session.geo_region || '-'}</td>
                        <td style={cellStyle} title={session.geo_city}>{session.geo_city || '-'}</td>
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
        )}
      </Card>

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

          {/* Buscador */}
          <div style={{
            padding: '16px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface)',
            gap: '16px'
          }}>
            <div style={{ position: 'relative', flex: 1, maxWidth: '400px' }}>
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
                placeholder="Buscar en todas las columnas..."
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
            <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
              {filteredSessions.length} {filteredSessions.length === 1 ? 'sesión' : 'sesiones'} {searchQuery.trim() && `(filtradas de ${recentSessions.length})`}
            </span>
          </div>

          {/* Tabla expandida con scroll */}
          <div style={{
            flex: 1,
            overflow: 'auto',
            padding: '0'
          }}>
            <div style={{
              height: '100%',
              overflowX: 'auto',
              overflowY: 'auto'
            }}>
              <table style={{
                borderCollapse: 'collapse',
                fontSize: '0.875rem',
                backgroundColor: 'var(--color-surface)'
              }}>
                <thead style={{
                  backgroundColor: 'var(--color-gray-50)',
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
                      if (key === 'started_at' || key === 'last_event_at' || key === 'created_at') {
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

                      // Link para landing_url
                      if (key === 'landing_url') {
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
    </div>
  )
}
