import React, { useState, useEffect } from 'react'
import { Card, Button } from '@/components/common'
import {
  Activity,
  Copy,
  Check,
  Info,
  Globe,
  Loader2,
  RefreshCw
} from 'lucide-react'
import { trackingService, TrackingSession } from '@/services/trackingService'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './HighLevelIntegration.module.css'

const SHOW_ANALYTICS_STORAGE_KEY = 'showAnalyticsPreference'
const VISITOR_SOURCE_KEY = 'visitorSourcePreference'

const persistAnalyticsPreference = (value: boolean) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SHOW_ANALYTICS_STORAGE_KEY, String(value))
}

const persistVisitorSourcePreference = (value: 'platform' | 'tracking') => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(VISITOR_SOURCE_KEY, value)
}

export const WebTracking: React.FC = () => {
  const { showToast } = useNotification()
  const [trackingDomain, setTrackingDomain] = useState('')
  const [copied, setCopied] = useState(false)
  const [recentSessions, setRecentSessions] = useState<TrackingSession[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [configuringTracking, setConfiguringTracking] = useState(false)
  const [isConfigured, setIsConfigured] = useState(false)
  const [hasHighLevel, setHasHighLevel] = useState(false)
  const [showAnalytics, setShowAnalytics] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(SHOW_ANALYTICS_STORAGE_KEY)
      if (stored === 'true') return true
      if (stored === 'false') return false
    }
    return true // visible por defecto
  })
  const [savingAnalyticsPref, setSavingAnalyticsPref] = useState(false)
  const [visitorSource, setVisitorSource] = useState<'platform' | 'tracking'>(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(VISITOR_SOURCE_KEY) as 'platform' | 'tracking' | null
      return stored || 'platform' // por defecto usa plataforma de anuncios
    }
    return 'platform'
  })
  const [savingVisitorPref, setSavingVisitorPref] = useState(false)

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
      const analyticsEnabled = !!config.showAnalytics
      setShowAnalytics(analyticsEnabled)
      persistAnalyticsPreference(analyticsEnabled)

      // Cargar preferencia de fuente de visitantes
      const visitorSourceValue = config.visitorSource || 'platform'
      setVisitorSource(visitorSourceValue)
      persistVisitorSourcePreference(visitorSourceValue)
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

    // Validar que el dominio contenga "ristak"
    if (!trackingDomain.includes('ristak')) {
      showToast(
        'error',
        'Dominio inválido',
        'El dominio debe contener "ristak" (ej: ristak.tudominio.com). Configura el CNAME en tu DNS primero.'
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
    setSavingAnalyticsPref(true)
    try {
      const newValue = !showAnalytics
      const response = await fetch('/api/tracking/analytics-preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showAnalytics: newValue })
      })

      if (!response.ok) {
        throw new Error('Error al guardar preferencia')
      }

      setShowAnalytics(newValue)
      persistAnalyticsPreference(newValue)
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
    } finally {
      setSavingAnalyticsPref(false)
    }
  }

  const handleToggleVisitorSource = async () => {
    setSavingVisitorPref(true)
    try {
      const newValue = visitorSource === 'platform' ? 'tracking' : 'platform'
      const response = await fetch('/api/tracking/visitor-source-preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorSource: newValue })
      })

      if (!response.ok) {
        throw new Error('Error al guardar preferencia')
      }

      setVisitorSource(newValue)
      persistVisitorSourcePreference(newValue)
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
    } finally {
      setSavingVisitorPref(false)
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
                  Captura visitas, UTMs y atribución de campañas
                </p>
              </div>
            </div>
            <div className={styles.headerRight}>
              {loadingConfig ? (
                <div className={styles.statusConnected}>
                  <Loader2 size={16} className={styles.spinIcon} />
                  <span>Verificando...</span>
                </div>
              ) : isConfigured ? (
                <div className={styles.statusConnected}>
                  <Check size={16} />
                  <span>Configurado</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Configuración */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Configuración</h3>
          </div>

          {!hasHighLevel ? (
            <div className={styles.infoBox}>
              <div className={styles.infoBoxTitle}>
                <Info size={16} />
                <span>HighLevel requerido</span>
              </div>
              <div className={styles.infoBoxContent}>
                Primero debes configurar tu integración con HighLevel
              </div>
            </div>
          ) : !trackingDomain.includes('ristak') ? (
            <div className={styles.warningBox}>
              <div className={styles.infoBoxTitle}>
                <Info size={16} />
                <span>Configuración requerida</span>
              </div>
              <div className={styles.infoBoxContent}>
                Para configurar el tracking, accede usando el subdominio <code className={styles.codeInline}>ristak.tudominio.com</code>
              </div>
              <div className={styles.infoBoxContent} style={{ marginTop: '8px' }}>
                Configura un CNAME en tu DNS: <code className={styles.codeInline}>ristak</code> → <code className={styles.codeInline}>ristak-app.onrender.com</code>
              </div>
            </div>
          ) : (
            <>
              {/* Dominio detectado */}
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Dominio de tracking</label>
                <div className={styles.formInput} style={{ background: 'var(--color-gray-50)', cursor: 'default' }}>
                  {trackingDomain}
                </div>
              </div>

              {/* Botón de sincronización */}
              <div style={{ marginTop: '16px' }}>
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
                      {isConfigured ? 'Volver a sincronizar' : 'Sincronizar con HighLevel'}
                    </>
                  )}
                </Button>
                {isConfigured && (
                  <p className={styles.formHint} style={{ marginTop: '8px' }}>
                    El custom value <code className={styles.codeInline}>rstktrack</code> está configurado en HighLevel
                  </p>
                )}
              </div>

              {/* Código del pixel */}
              <div className={styles.formGroup} style={{ marginTop: '24px' }}>
                <label className={styles.formLabel}>Código del pixel</label>
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

        {/* Tabla de eventos de tracking */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Eventos de Tracking</h3>
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

          {recentSessions.length > 0 ? (
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
                  {recentSessions.map((session: any) => {
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
                        <td style={cellStyle}>{formatDate(session.started_at)}</td>
                        <td style={cellStyle}>{session.last_event_at ? formatDate(session.last_event_at) : '-'}</td>
                        <td style={cellStyle}>{session.created_at ? formatDate(session.created_at) : '-'}</td>

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
      </Card>
    </div>
  )
}
