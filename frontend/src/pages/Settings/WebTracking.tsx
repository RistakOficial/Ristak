import React, { useState, useEffect } from 'react'
import { Card, Button } from '@/components/common'
import {
  Activity,
  Copy,
  Check,
  Info,
  Globe,
  Eye,
  TrendingUp,
  MousePointer,
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
  const [stats, setStats] = useState({
    total: 0,
    withUtm: 0,
    withGclid: 0,
    withFbclid: 0
  })

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
      const sessions = await trackingService.getSessions(10)
      setRecentSessions(sessions)

      const total = sessions.length
      const withUtm = sessions.filter(s => s.utm_source).length
      const withGclid = sessions.filter(s => s.gclid).length
      const withFbclid = sessions.filter(s => s.fbclid).length

      setStats({ total, withUtm, withGclid, withFbclid })
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
          </div>
        </div>

        {/* Configuración */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Configuración</h3>
          </div>

          {loadingConfig ? (
            <div className={styles.loadingState}>
              <Loader2 size={24} className={styles.spinIcon} />
              <p>Cargando configuración...</p>
            </div>
          ) : (
            <>
              {/* Instrucción importante: Usar subdominio collect */}
              {!trackingDomain.includes('collect') && (
                <p className={styles.formHint} style={{ marginBottom: '20px' }}>
                  ⚠️ Para configurar el tracking, accede usando el subdominio <code className={styles.codeInline}>collect.tudominio.com</code> (configura CNAME: collect → ristak-app.onrender.com)
                </p>
              )}

              {/* Dominio detectado */}
              {trackingDomain && (
                <div className={styles.infoBox} style={{ marginBottom: '16px' }}>
                  <div className={styles.infoBoxTitle}>
                    <Globe size={16} />
                    <span>Dominio detectado</span>
                  </div>
                  <p className={styles.infoBoxText}>
                    <code className={styles.codeInline}>{trackingDomain}</code>
                  </p>
                </div>
              )}

              {/* Estado */}
              {isConfigured ? (
                <div className={styles.successBox} style={{ marginBottom: '16px' }}>
                  <div className={styles.infoBoxTitle}>
                    <Check size={16} />
                    <span>Tracking configurado</span>
                  </div>
                  <p className={styles.infoBoxText}>
                    Usa <code className={styles.codeInline}>{'{{ custom_values.rstktrack }}'}</code> en el <code className={styles.codeInline}>&lt;head&gt;</code> de tu sitio
                  </p>
                </div>
              ) : (
                <div className={styles.infoBox} style={{ marginBottom: '16px' }}>
                  <div className={styles.infoBoxTitle}>
                    <Info size={16} />
                    <span>Configuración pendiente</span>
                  </div>
                  <p className={styles.infoBoxText}>
                    Sincroniza para crear/actualizar el custom value <code className={styles.codeInline}>rstktrack</code> en HighLevel
                  </p>
                </div>
              )}

              {/* Botón de sincronización - SIEMPRE visible */}
              <Button
                variant="primary"
                onClick={handleConfigureTracking}
                disabled={configuringTracking || !hasHighLevel || !trackingDomain.includes('collect')}
              >
                {configuringTracking ? (
                  <>
                    <Loader2 size={16} className={styles.spinIcon} />
                    Sincronizando...
                  </>
                ) : (
                  <>
                    <Check size={16} />
                    {isConfigured ? 'Volver a sincronizar' : 'Sincronizar con HighLevel'}
                  </>
                )}
              </Button>

              {/* Mensajes de ayuda */}
              {!hasHighLevel && (
                <p className={styles.formHint} style={{ marginTop: '8px', color: 'var(--color-warning)' }}>
                  ⚠️ Primero configura HighLevel en Settings
                </p>
              )}
              {hasHighLevel && !trackingDomain.includes('collect') && (
                <p className={styles.formHint} style={{ marginTop: '8px', color: 'var(--color-warning)' }}>
                  ⚠️ El dominio debe contener "collect" (ej: collect.tudominio.com)
                </p>
              )}

              {/* Código del pixel */}
              {trackingDomain && (
                <div style={{ marginTop: '24px' }}>
                  <label className={styles.formLabel}>Código del pixel</label>
                  <div className={styles.codeBlock}>
                    <pre className={styles.codeContent}>
                      {trackingService.generateSnippet(trackingDomain)}
                    </pre>
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={handleCopySnippet}
                      style={{ marginTop: '12px' }}
                    >
                      {copied ? (
                        <>
                          <Check size={16} />
                          Copiado
                      </>
                    ) : (
                      <>
                        <Copy size={16} />
                        Copiar código
                      </>
                    )}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Estadísticas */}
        {stats.total > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>Estadísticas</h3>
            </div>

            <div className={styles.statsGrid}>
              <div className={styles.statCard}>
                <Eye size={20} className={styles.statIcon} style={{ color: 'var(--color-primary)' }} />
                <div className={styles.statValue}>{stats.total}</div>
                <div className={styles.statLabel}>Total sesiones</div>
              </div>
              <div className={styles.statCard}>
                <TrendingUp size={20} className={styles.statIcon} style={{ color: 'var(--color-success)' }} />
                <div className={styles.statValue}>{stats.withUtm}</div>
                <div className={styles.statLabel}>Con UTMs</div>
              </div>
              <div className={styles.statCard}>
                <MousePointer size={20} className={styles.statIcon} style={{ color: '#4285F4' }} />
                <div className={styles.statValue}>{stats.withGclid}</div>
                <div className={styles.statLabel}>Google Ads</div>
              </div>
              <div className={styles.statCard}>
                <MousePointer size={20} className={styles.statIcon} style={{ color: '#1877F2' }} />
                <div className={styles.statValue}>{stats.withFbclid}</div>
                <div className={styles.statLabel}>Facebook Ads</div>
              </div>
            </div>
          </div>
        )}

        {/* Sesiones recientes */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Sesiones recientes</h3>
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
            <div className={styles.tableContainer}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Landing Page</th>
                    <th>Fuente</th>
                    <th>Campaña</th>
                    <th>Device</th>
                    <th style={{ textAlign: 'center' }}>Páginas</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.map((session) => (
                    <tr key={session.session_id}>
                      <td className={styles.tableDateCell}>
                        {formatDate(session.started_at)}
                      </td>
                      <td className={styles.tableLinkCell}>
                        <a href={session.landing_url} target="_blank" rel="noopener noreferrer">
                          {session.landing_url}
                        </a>
                      </td>
                      <td>
                        {session.utm_source || (session.gclid ? 'Google Ads' : session.fbclid ? 'Facebook Ads' : '-')}
                      </td>
                      <td>
                        {session.utm_campaign || '-'}
                      </td>
                      <td style={{ textTransform: 'capitalize' }}>
                        {session.device_type || '-'}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 500 }}>
                        {session.pageviews_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.emptyState}>
              <Activity size={48} style={{ opacity: 0.3, marginBottom: '16px' }} />
              <p>No hay sesiones capturadas</p>
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
