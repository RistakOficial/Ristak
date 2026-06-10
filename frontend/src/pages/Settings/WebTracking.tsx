import React, { useState, useEffect } from 'react'
import { Card, Button, Badge } from '@/components/common'
import { Check, Copy, Loader2, RefreshCw, Activity } from 'lucide-react'
import { trackingService } from '@/services/trackingService'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig, useIsRenderDomain } from '@/hooks'
import styles from './HighLevelIntegration.module.css'
import trackStyles from './WebTracking.module.css'

export const WebTracking: React.FC = () => {
  const { showToast } = useNotification()

  // Detectar si estamos en dominio .onrender.com
  const isOnRenderDomain = useIsRenderDomain()

  // Sistema híbrido de configuración (cache + DB)
  // Defaults: false y 'platform' hasta que se configure dominio personalizado
  const [showAnalytics, setShowAnalytics] = useAppConfig('show_analytics', false)
  const [visitorSource, setVisitorSource] = useAppConfig<'platform' | 'tracking'>('visitor_source', 'platform')

  const [trackingDomain, setTrackingDomain] = useState('')
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [configuringTracking, setConfiguringTracking] = useState(false)
  const [isConfigured, setIsConfigured] = useState(false)
  const [hasHighLevel, setHasHighLevel] = useState(false)
  const [hasAutoActivated, setHasAutoActivated] = useState(false)
  const [trackingSnippet, setTrackingSnippet] = useState('')

  useEffect(() => {
    loadTrackingConfig()
  }, [])

  const loadTrackingConfig = async () => {
    setLoadingConfig(true)
    try {
      const config = await trackingService.getTrackingConfig({ forceRefresh: true })
      setTrackingDomain(config.trackingDomain || '')
      setIsConfigured(config.isConfigured)
      setHasHighLevel(config.hasHighLevel)
      setTrackingSnippet(config.trackingSnippet || '')

      if (!showAnalytics) {
        await setShowAnalytics(true)
        window.dispatchEvent(new CustomEvent('analytics-preference-changed', {
          detail: { showAnalytics: true }
        }))
      }

      // En dominio personalizado, activar la fuente de rastreo automáticamente.
      if (!isOnRenderDomain && config.trackingDomain && !hasAutoActivated) {
        if (visitorSource !== 'tracking') {
          await setVisitorSource('tracking')
        }
        setHasAutoActivated(true)

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

  const handleConfigureTracking = async () => {
    setConfiguringTracking(true)
    try {
      const response = await trackingService.configureTracking()
      if (response.snippet) {
        setTrackingSnippet(response.snippet)
      }
      setIsConfigured(true)
      showToast('success', 'Sincronización exitosa', 'El código del pixel se guardó en HighLevel como "rstktrack"')
    } catch (error) {
      showToast('error', 'Error al sincronizar', 'No se pudo guardar el código en HighLevel')
    } finally {
      setConfiguringTracking(false)
    }
  }

  const handleCopyTrackingSnippet = async () => {
    if (!trackingSnippet) return

    try {
      await navigator.clipboard.writeText(trackingSnippet)
      showToast('success', 'Código copiado', 'Pégalo en los headers del sitio correspondiente')
    } catch (error) {
      showToast('error', 'Error', 'No se pudo copiar el código del pixel')
    }
  }

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        {/* Header */}
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <div className={styles.logoContainer}>
                <Activity size={22} />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <h2 className={styles.pageTitle}>Rastreo Web</h2>
                  {isOnRenderDomain && (
                    <Badge variant="neutral">Dominio requerido</Badge>
                  )}
                </div>
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
              <div>
                <h3 className={styles.sectionTitle}>Activa el rastreo con tu dominio</h3>
                <p className={styles.sectionSubtitle}>
                  El tracking necesita servirse desde un dominio propio. Son 3 pasos:
                </p>
              </div>
            </div>

            <ol className={trackStyles.stepList}>
              <li className={trackStyles.stepItem}>
                <div className={trackStyles.stepBody}>
                  <strong>Crea un CNAME en tu DNS</strong>
                  <p>
                    En tu proveedor (Cloudflare, GoDaddy, Namecheap...): tipo <code>CNAME</code>,
                    nombre <code>track</code> (o el subdominio que prefieras), apuntando a{' '}
                    <code>ristak-app.onrender.com</code>. Ejemplo: con miempresa.com queda
                    track.miempresa.com.
                  </p>
                </div>
              </li>
              <li className={trackStyles.stepItem}>
                <div className={trackStyles.stepBody}>
                  <strong>Agrega el dominio en Render</strong>
                  <p>
                    En tu servicio <code>ristak-app</code>: Settings → Custom Domains → Add Custom
                    Domain → <code>track.tudominio.com</code>. Espera el estado Verified (5–10 min).
                  </p>
                </div>
              </li>
              <li className={trackStyles.stepItem}>
                <div className={trackStyles.stepBody}>
                  <strong>Entra desde el dominio nuevo</strong>
                  <p>
                    Abre track.tudominio.com en el navegador: esta página se recarga y el rastreo
                    queda activo automáticamente.
                  </p>
                </div>
              </li>
            </ol>

            <p className={trackStyles.stepFootnote}>
              ¿Problemas con la configuración? Contacta a soporte técnico.
            </p>
          </div>
        ) : (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <h3 className={styles.sectionTitle}>Instalación del pixel</h3>
                <p className={styles.sectionSubtitle}>
                  Instala el código de rastreo en tus páginas para capturar visitas y atribución.
                </p>
              </div>
            </div>

            {!trackingDomain.trim() ? (
              <div className={styles.warningBox}>
                <div className={styles.infoBoxTitle}>
                  <span>Falta el CNAME de rastreo</span>
                </div>
                <div className={styles.infoBoxContent}>
                  En tu proveedor de DNS crea un registro tipo <code className={styles.codeInline}>CNAME</code> con
                  nombre <code className={styles.codeInline}>collect</code> apuntando a{' '}
                  <code className={styles.codeInline}>ristak-app.onrender.com</code>, y vuelve a abrir esta página
                  desde <code className={styles.codeInline}>collect.tudominio.com</code>.
                </div>
              </div>
            ) : (
              <>
                <p className={trackStyles.domainRow}>
                  Dominio de rastreo: <code>{trackingDomain}</code>
                </p>

                {hasHighLevel && (
                  <>
                    <div className={trackStyles.syncRow}>
                      <div className={trackStyles.syncRowInfo}>
                        <strong>Sincronizar con HighLevel</strong>
                        <p>
                          {isConfigured
                            ? 'Ya está sincronizado: el código vive en HighLevel como rstktrack.'
                            : 'Guarda el código del pixel en HighLevel automáticamente.'}
                        </p>
                      </div>
                      <Button
                        variant={isConfigured ? 'secondary' : 'primary'}
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
                    </div>

                    <div className={styles.manualInstallDivider} aria-hidden="true">
                      <span>O</span>
                    </div>
                  </>
                )}

                <div className={styles.manualSnippetBox}>
                  <div className={styles.manualSnippetHeader}>
                    <div>
                      <label className={styles.formLabel}>
                        Código de píxel web
                      </label>
                      <p className={styles.formHint}>
                        Copia este código y pégalo en los headers de la página correspondiente.
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleCopyTrackingSnippet}
                      disabled={!trackingSnippet}
                    >
                      <Copy size={16} />
                      Copiar código
                    </Button>
                  </div>
                  <pre className={styles.manualSnippetCode}><code>{trackingSnippet || 'Cargando código del pixel...'}</code></pre>
                </div>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
