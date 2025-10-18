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

    // Validar que el dominio contenga "collect"
    if (!trackingDomain.includes('collect')) {
      showToast(
        'error',
        'Dominio inválido',
        'El dominio debe contener "collect" (ej: collect.tudominio.com). Configura el CNAME en tu DNS primero.'
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
          ) : !trackingDomain.includes('collect') ? (
            <div className={styles.warningBox}>
              <div className={styles.infoBoxTitle}>
                <Info size={16} />
                <span>Configuración requerida</span>
              </div>
              <div className={styles.infoBoxContent}>
                Para configurar el tracking, accede usando el subdominio <code className={styles.codeInline}>collect.tudominio.com</code>
              </div>
              <div className={styles.infoBoxContent} style={{ marginTop: '8px' }}>
                Configura un CNAME en tu DNS: <code className={styles.codeInline}>collect</code> → <code className={styles.codeInline}>ristak-app.onrender.com</code>
              </div>
            </div>
          ) : (
            <>
              {/* Dominio detectado */}
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>
                  <Globe size={16} />
                  Dominio de tracking
                </label>
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
              <div style={{ marginTop: '24px' }}>
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
              <table className={styles.table} style={{ minWidth: '3000px' }}>
                <thead>
                  <tr>
                    {/* IDs y Timestamps */}
                    <th>Session ID</th>
                    <th>Visitor ID</th>
                    <th>Contact ID</th>
                    <th>Event Name</th>
                    <th>Started At</th>
                    <th>Last Event At</th>
                    <th>Created At</th>

                    {/* URLs */}
                    <th>Landing URL</th>
                    <th>Referrer URL</th>

                    {/* UTMs */}
                    <th>UTM Source</th>
                    <th>UTM Medium</th>
                    <th>UTM Campaign</th>
                    <th>UTM Term</th>
                    <th>UTM Content</th>

                    {/* Click IDs */}
                    <th>GCLID</th>
                    <th>FBCLID</th>
                    <th>FBC</th>
                    <th>FBP</th>
                    <th>WBRAID</th>
                    <th>GBRAID</th>
                    <th>MSCLKID</th>
                    <th>TTCLID</th>

                    {/* Campaign Details */}
                    <th>Channel</th>
                    <th>Source Platform</th>
                    <th>Campaign ID</th>
                    <th>Adset ID</th>
                    <th>Ad Group ID</th>
                    <th>Ad ID</th>
                    <th>Campaign Name</th>
                    <th>Adset Name</th>
                    <th>Ad Group Name</th>
                    <th>Ad Name</th>
                    <th>Placement</th>
                    <th>Site Source Name</th>
                    <th>Network</th>
                    <th>Match Type</th>
                    <th>Keyword</th>
                    <th>Search Query</th>
                    <th>Creative ID</th>
                    <th>Ad Position</th>

                    {/* Device & Browser */}
                    <th>IP</th>
                    <th>User Agent</th>
                    <th>Device Type</th>
                    <th>OS</th>
                    <th>Browser</th>
                    <th>Browser Version</th>
                    <th>Language</th>
                    <th>Timezone</th>

                    {/* Geo */}
                    <th>Country</th>
                    <th>Region</th>
                    <th>City</th>

                    {/* Metrics */}
                    <th>Pageviews</th>
                    <th>Events</th>
                    <th>Bounce</th>
                    <th>Orders</th>
                    <th>Revenue</th>
                    <th>Currency</th>
                    <th>Last Order ID</th>

                    {/* Contact Info */}
                    <th>Email</th>
                    <th>Phone</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.map((session: any) => (
                    <tr key={session.session_id}>
                      {/* IDs y Timestamps */}
                      <td><code style={{ fontSize: '0.7rem' }}>{session.session_id?.substring(0, 8)}...</code></td>
                      <td><code style={{ fontSize: '0.7rem' }}>{session.visitor_id?.substring(0, 8)}...</code></td>
                      <td>{session.contact_id ? <code style={{ fontSize: '0.7rem' }}>{session.contact_id.substring(0, 8)}...</code> : '-'}</td>
                      <td>{session.event_name || '-'}</td>
                      <td className={styles.tableDateCell}>{formatDate(session.started_at)}</td>
                      <td>{session.last_event_at ? formatDate(session.last_event_at) : '-'}</td>
                      <td>{session.created_at ? formatDate(session.created_at) : '-'}</td>

                      {/* URLs */}
                      <td style={{ maxWidth: '200px' }}><a href={session.landing_url} target="_blank" rel="noopener noreferrer">{session.landing_url}</a></td>
                      <td style={{ maxWidth: '150px', fontSize: '0.75rem' }}>{session.referrer_url || '-'}</td>

                      {/* UTMs */}
                      <td>{session.utm_source || '-'}</td>
                      <td>{session.utm_medium || '-'}</td>
                      <td>{session.utm_campaign || '-'}</td>
                      <td>{session.utm_term || '-'}</td>
                      <td>{session.utm_content || '-'}</td>

                      {/* Click IDs */}
                      <td>{session.gclid ? <code style={{ fontSize: '0.7rem' }}>{session.gclid.substring(0, 10)}...</code> : '-'}</td>
                      <td>{session.fbclid ? <code style={{ fontSize: '0.7rem' }}>{session.fbclid.substring(0, 10)}...</code> : '-'}</td>
                      <td>{session.fbc || '-'}</td>
                      <td>{session.fbp || '-'}</td>
                      <td>{session.wbraid || '-'}</td>
                      <td>{session.gbraid || '-'}</td>
                      <td>{session.msclkid || '-'}</td>
                      <td>{session.ttclid || '-'}</td>

                      {/* Campaign Details */}
                      <td>{session.channel || '-'}</td>
                      <td>{session.source_platform || '-'}</td>
                      <td>{session.campaign_id || '-'}</td>
                      <td>{session.adset_id || '-'}</td>
                      <td>{session.ad_group_id || '-'}</td>
                      <td>{session.ad_id || '-'}</td>
                      <td>{session.campaign_name || '-'}</td>
                      <td>{session.adset_name || '-'}</td>
                      <td>{session.ad_group_name || '-'}</td>
                      <td>{session.ad_name || '-'}</td>
                      <td>{session.placement || '-'}</td>
                      <td>{session.site_source_name || '-'}</td>
                      <td>{session.network || '-'}</td>
                      <td>{session.match_type || '-'}</td>
                      <td>{session.keyword || '-'}</td>
                      <td>{session.search_query || '-'}</td>
                      <td>{session.creative_id || '-'}</td>
                      <td>{session.ad_position || '-'}</td>

                      {/* Device & Browser */}
                      <td style={{ fontSize: '0.75rem' }}>{session.ip || '-'}</td>
                      <td style={{ fontSize: '0.7rem', maxWidth: '200px' }}>{session.user_agent || '-'}</td>
                      <td style={{ textTransform: 'capitalize' }}>{session.device_type || '-'}</td>
                      <td>{session.os || '-'}</td>
                      <td>{session.browser || '-'}</td>
                      <td>{session.browser_version || '-'}</td>
                      <td>{session.language || '-'}</td>
                      <td>{session.timezone || '-'}</td>

                      {/* Geo */}
                      <td>{session.geo_country || '-'}</td>
                      <td>{session.geo_region || '-'}</td>
                      <td>{session.geo_city || '-'}</td>

                      {/* Metrics */}
                      <td style={{ textAlign: 'center', fontWeight: 500 }}>{session.pageviews_count || 0}</td>
                      <td style={{ textAlign: 'center', fontWeight: 500 }}>{session.events_count || 0}</td>
                      <td style={{ textAlign: 'center' }}>{session.is_bounce ? 'Sí' : 'No'}</td>
                      <td style={{ textAlign: 'center' }}>{session.orders_count || 0}</td>
                      <td style={{ textAlign: 'right' }}>${session.revenue_value || 0}</td>
                      <td>{session.currency || 'MXN'}</td>
                      <td>{session.last_order_id || '-'}</td>

                      {/* Contact Info */}
                      <td>{session.email || '-'}</td>
                      <td>{session.phone_e164 || '-'}</td>
                    </tr>
                  ))}
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
