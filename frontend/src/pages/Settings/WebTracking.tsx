import React, { useState, useEffect } from 'react'
import { Card, Button } from '@/components/common'
import {
  Activity,
  Copy,
  Check,
  ExternalLink,
  Info,
  Code,
  Globe,
  TrendingUp,
  MousePointer,
  Eye
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
  const [stats, setStats] = useState({
    total: 0,
    withUtm: 0,
    withGclid: 0,
    withFbclid: 0
  })

  useEffect(() => {
    loadRecentSessions()
  }, [])

  const loadRecentSessions = async () => {
    setLoadingSessions(true)
    try {
      const sessions = await trackingService.getSessions(10)
      setRecentSessions(sessions)

      // Calcular stats básicas
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

  const handleCopySnippet = async () => {
    if (!trackingDomain.trim()) {
      showToast('error', 'Error', 'Por favor ingresa tu dominio de tracking')
      return
    }

    const snippet = trackingService.generateSnippet(trackingDomain)
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      showToast('success', 'Copiado', 'Snippet copiado al portapapeles')
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      showToast('error', 'Error', 'No se pudo copiar al portapapeles')
    }
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
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
              <div className={styles.logoContainer} style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
                <Activity size={32} color="white" />
              </div>
              <p className={styles.pageSubtitle}>
                Captura visitas, UTMs y atribución de campañas publicitarias
              </p>
            </div>
          </div>
        </div>

        {/* ¿Qué es esto? */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>¿Qué es el Pixel de Tracking?</h3>
          </div>
          <div className={styles.infoBox}>
            <div className={styles.infoBoxTitle}>
              <Info size={16} />
              <span>Tracking de Primera Parte (First-Party)</span>
            </div>
            <p style={{ fontSize: '14px', color: 'var(--color-text-secondary)', margin: '8px 0' }}>
              Un pixel de tracking que captura automáticamente:
            </p>
            <ul style={{ fontSize: '14px', color: 'var(--color-text-secondary)', paddingLeft: '20px', margin: '8px 0' }}>
              <li><strong>UTMs</strong>: utm_source, utm_medium, utm_campaign, utm_term, utm_content</li>
              <li><strong>Click IDs</strong>: gclid (Google), fbclid (Facebook), msclkid (Bing), ttclid (TikTok)</li>
              <li><strong>Referrer</strong>: De dónde viene el visitante</li>
              <li><strong>Device info</strong>: Tipo de dispositivo, navegador, idioma, timezone</li>
              <li><strong>Comportamiento</strong>: Páginas vistas, duración, bounce rate</li>
            </ul>
            <p style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginTop: '12px' }}>
              💡 <strong>Ventaja clave:</strong> No depende de Google Analytics ni Facebook Pixel. Tú controlas los datos al 100%.
            </p>
          </div>
        </div>

        {/* Configuración CNAME */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Paso 1: Configura tu CNAME</h3>
          </div>
          <p className={styles.sectionDescription}>
            Crea un subdominio en tu DNS que apunte a tu servidor de Ristak
          </p>

          <div className={styles.setupSteps}>
            <div className={styles.step}>
              <div className={styles.stepNumber}>1</div>
              <div className={styles.stepContent}>
                <h4 className={styles.stepTitle}>En tu proveedor de DNS</h4>
                <p className={styles.stepDescription}>
                  (Cloudflare, GoDaddy, Squarespace, etc.)
                </p>
                <div className={styles.stepBody}>
                  <div style={{ background: 'var(--color-bg-tertiary)', padding: '16px', borderRadius: '8px', fontFamily: 'monospace', fontSize: '13px' }}>
                    <div style={{ marginBottom: '8px' }}>
                      <span style={{ color: 'var(--color-text-muted)' }}>Tipo:</span> <strong>CNAME</strong>
                    </div>
                    <div style={{ marginBottom: '8px' }}>
                      <span style={{ color: 'var(--color-text-muted)' }}>Nombre:</span> <strong>collect</strong>
                    </div>
                    <div>
                      <span style={{ color: 'var(--color-text-muted)' }}>Destino:</span> <strong>tu-app.onrender.com</strong> <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>(tu servidor)</span>
                    </div>
                  </div>
                  <div className={styles.formHint}>
                    Esto creará: <code>collect.tu-dominio.com</code>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Snippet de Instalación */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Paso 2: Instala el Pixel</h3>
          </div>
          <p className={styles.sectionDescription}>
            Copia este código y pégalo antes de {`</body>`} en todas las páginas de tu sitio
          </p>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Tu dominio de tracking</label>
            <div className={styles.inputGroup}>
              <Globe size={16} style={{ position: 'absolute', left: '12px', color: 'var(--color-text-muted)' }} />
              <input
                type="text"
                className={styles.formInput}
                placeholder="collect.tu-dominio.com"
                value={trackingDomain}
                onChange={(e) => setTrackingDomain(e.target.value)}
                style={{ paddingLeft: '36px' }}
              />
            </div>
            <div className={styles.formHint}>
              Ejemplo: collect.mitienda.com
            </div>
          </div>

          {trackingDomain && (
            <div style={{ marginTop: '16px' }}>
              <div style={{
                background: 'var(--color-bg-tertiary)',
                padding: '16px',
                borderRadius: '8px',
                fontFamily: 'monospace',
                fontSize: '13px',
                position: 'relative',
                border: '1px solid var(--color-border)'
              }}>
                <Code size={16} style={{ position: 'absolute', top: '12px', right: '12px', color: 'var(--color-text-muted)' }} />
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {trackingService.generateSnippet(trackingDomain)}
                </pre>
              </div>
              <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
                <Button
                  variant="primary"
                  size="small"
                  onClick={handleCopySnippet}
                >
                  {copied ? (
                    <>
                      <Check size={16} />
                      Copiado
                    </>
                  ) : (
                    <>
                      <Copy size={16} />
                      Copiar snippet
                    </>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => window.open('/TRACKING_PIXEL.md', '_blank')}
                >
                  <ExternalLink size={16} />
                  Ver documentación completa
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Estadísticas Rápidas */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Sesiones Capturadas</h3>
            <Button
              variant="ghost"
              size="small"
              onClick={loadRecentSessions}
              disabled={loadingSessions}
            >
              <Activity size={16} />
              {loadingSessions ? 'Cargando...' : 'Actualizar'}
            </Button>
          </div>

          {stats.total > 0 && (
            <div className={styles.infoGrid} style={{ marginBottom: '24px' }}>
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Total de sesiones</label>
                <div className={styles.infoValue} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Eye size={18} color="var(--color-primary)" />
                  <strong>{stats.total}</strong>
                </div>
              </div>
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Con UTMs</label>
                <div className={styles.infoValue} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <TrendingUp size={18} color="var(--color-success)" />
                  <strong>{stats.withUtm}</strong>
                </div>
              </div>
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Google Ads (gclid)</label>
                <div className={styles.infoValue} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <MousePointer size={18} color="#4285F4" />
                  <strong>{stats.withGclid}</strong>
                </div>
              </div>
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Facebook Ads (fbclid)</label>
                <div className={styles.infoValue} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <MousePointer size={18} color="#1877F2" />
                  <strong>{stats.withFbclid}</strong>
                </div>
              </div>
            </div>
          )}

          {recentSessions.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)', textAlign: 'left' }}>
                    <th style={{ padding: '12px 8px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>Fecha</th>
                    <th style={{ padding: '12px 8px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>Landing Page</th>
                    <th style={{ padding: '12px 8px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>Fuente</th>
                    <th style={{ padding: '12px 8px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>Campaña</th>
                    <th style={{ padding: '12px 8px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>Device</th>
                    <th style={{ padding: '12px 8px', color: 'var(--color-text-secondary)', fontWeight: 500, textAlign: 'center' }}>Páginas</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.map((session) => (
                    <tr key={session.session_id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '12px 8px', color: 'var(--color-text-secondary)', fontSize: '12px' }}>
                        {formatDate(session.started_at)}
                      </td>
                      <td style={{ padding: '12px 8px', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <a href={session.landing_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>
                          {session.landing_url}
                        </a>
                      </td>
                      <td style={{ padding: '12px 8px' }}>
                        {session.utm_source || (session.gclid ? 'Google Ads' : session.fbclid ? 'Facebook Ads' : '-')}
                      </td>
                      <td style={{ padding: '12px 8px' }}>
                        {session.utm_campaign || '-'}
                      </td>
                      <td style={{ padding: '12px 8px', textTransform: 'capitalize' }}>
                        {session.device_type || '-'}
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'center', fontWeight: 500 }}>
                        {session.pageviews_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--color-text-muted)' }}>
              <Activity size={48} style={{ opacity: 0.3, marginBottom: '16px' }} />
              <p>No hay sesiones capturadas todavía</p>
              <p style={{ fontSize: '13px', marginTop: '8px' }}>
                Instala el pixel en tu sitio para empezar a capturar datos
              </p>
            </div>
          )}
        </div>

        {/* Próximos Pasos */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Recursos Útiles</h3>
          </div>
          <div style={{ display: 'grid', gap: '12px' }}>
            <a
              href="/TRACKING_PIXEL.md"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '16px',
                background: 'var(--color-bg-tertiary)',
                borderRadius: '8px',
                textDecoration: 'none',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-primary)'
                e.currentTarget.style.background = 'var(--color-bg-secondary)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border)'
                e.currentTarget.style.background = 'var(--color-bg-tertiary)'
              }}
            >
              <Code size={20} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, marginBottom: '4px' }}>Documentación Técnica</div>
                <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                  Guía completa de implementación y troubleshooting
                </div>
              </div>
              <ExternalLink size={16} />
            </a>

            <a
              href="/PIXEL_SETUP.md"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '16px',
                background: 'var(--color-bg-tertiary)',
                borderRadius: '8px',
                textDecoration: 'none',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-primary)'
                e.currentTarget.style.background = 'var(--color-bg-secondary)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border)'
                e.currentTarget.style.background = 'var(--color-bg-tertiary)'
              }}
            >
              <Info size={20} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, marginBottom: '4px' }}>Guía Rápida</div>
                <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                  Instrucciones simples y queries SQL útiles
                </div>
              </div>
              <ExternalLink size={16} />
            </a>
          </div>
        </div>
      </Card>
    </div>
  )
}
