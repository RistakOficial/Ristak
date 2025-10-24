import React, { useState, useEffect } from 'react'
import { Card, Button } from '@/components/common'
import { Copy, Check, Info, Loader2, RefreshCw, Activity } from 'lucide-react'
import { trackingService } from '@/services/trackingService'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig, useIsRenderDomain } from '@/hooks'
import styles from './HighLevelIntegration.module.css'

export const WebTracking: React.FC = () => {
  const { showToast} = useNotification()

  // Detectar si estamos en dominio .onrender.com
  const isOnRenderDomain = useIsRenderDomain()

  // Sistema híbrido de configuración (cache + DB)
  // Defaults: false y 'platform' hasta que se configure dominio personalizado
  const [showAnalytics, setShowAnalytics] = useAppConfig('show_analytics', false)
  const [visitorSource, setVisitorSource] = useAppConfig<'platform' | 'tracking'>('visitor_source', 'platform')

  const [trackingDomain, setTrackingDomain] = useState('')
  const [copied, setCopied] = useState(false)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [configuringTracking, setConfiguringTracking] = useState(false)
  const [isConfigured, setIsConfigured] = useState(false)
  const [hasHighLevel, setHasHighLevel] = useState(false)
  const [hasAutoActivated, setHasAutoActivated] = useState(false)

  useEffect(() => {
    loadTrackingConfig()
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

  const handleConfigureTracking = async () => {
    setConfiguringTracking(true)
    try {
      await trackingService.configureTracking()
      setIsConfigured(true)
      showToast('success', 'Sincronización exitosa', 'El código del pixel se guardó en HighLevel como "rstktrack"')
    } catch (error) {
      showToast('error', 'Error al sincronizar', 'No se pudo guardar el código en HighLevel')
    } finally {
      setConfiguringTracking(false)
    }
  }

  const handleCopySnippet = async () => {
    try {
      const snippet = trackingService.generateSnippet(trackingDomain)
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      showToast('success', 'Copiado', 'El código se copió al portapapeles')
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      showToast('error', 'Error', 'No se pudo copiar el código')
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
                  Paso 1: Dominio configurado
                </label>
                <div className={styles.formInput} style={{ cursor: 'default' }}>
                  {trackingDomain}
                </div>
              </div>

              {/* Paso 2: Sincronizar */}
              <div className={styles.formGroup} style={{ marginTop: '24px' }}>
                <label className={styles.formLabel}>
                  Paso 2: Sincronizar con HighLevel
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
                  <p className={styles.formHint} style={{ marginTop: '12px' }}>
                    Ya está sincronizado. El código está guardado como rstktrack en HighLevel
                  </p>
                )}
              </div>
            </>
          )}
          </div>
        </>
        )}
      </Card>
    </div>
  )
}
