import React, { useEffect, useState } from 'react'
import { Activity, CheckCircle2, Copy, Loader2, RefreshCw } from 'lucide-react'
import { Badge, Button, Card } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig } from '@/hooks'
import { trackingService } from '@/services/trackingService'
import styles from './HighLevelIntegration.module.css'
import trackStyles from './WebTracking.module.css'

export const WebTracking: React.FC = () => {
  const { showToast } = useNotification()
  const [showAnalytics, setShowAnalytics] = useAppConfig('show_analytics', false)
  const [visitorSource, setVisitorSource] = useAppConfig<'platform' | 'tracking'>('visitor_source', 'platform')

  const [domainInput, setDomainInput] = useState('')
  const [trackingDomain, setTrackingDomain] = useState('')
  const [trackingDomainVerified, setTrackingDomainVerified] = useState(false)
  const [trackingDomainError, setTrackingDomainError] = useState('')
  const [serviceDomain, setServiceDomain] = useState('')
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [verifyingDomain, setVerifyingDomain] = useState(false)
  const [configuringTracking, setConfiguringTracking] = useState(false)
  const [isConfigured, setIsConfigured] = useState(false)
  const [hasHighLevel, setHasHighLevel] = useState(false)
  const [trackingSnippet, setTrackingSnippet] = useState('')

  useEffect(() => {
    void loadTrackingConfig()
  }, [])

  const activateTrackingPreferences = async () => {
    if (!showAnalytics) {
      await setShowAnalytics(true)
      window.dispatchEvent(new CustomEvent('analytics-preference-changed', {
        detail: { showAnalytics: true }
      }))
    }

    if (visitorSource !== 'tracking') {
      await setVisitorSource('tracking')
      window.dispatchEvent(new CustomEvent('visitor-source-changed', {
        detail: { visitorSource: 'tracking' }
      }))
    }
  }

  const loadTrackingConfig = async () => {
    setLoadingConfig(true)
    try {
      const config = await trackingService.getTrackingConfig({ forceRefresh: true })
      const configuredDomain = config.trackingDomain || ''
      const isVerified = Boolean(config.trackingDomainVerified && configuredDomain)

      setDomainInput(configuredDomain)
      setTrackingDomain(configuredDomain)
      setTrackingDomainVerified(isVerified)
      setTrackingDomainError(config.trackingDomainError || '')
      setServiceDomain(config.serviceDomain || '')
      setIsConfigured(config.isConfigured)
      setHasHighLevel(config.hasHighLevel)
      setTrackingSnippet(isVerified ? config.trackingSnippet || '' : '')

      if (isVerified) {
        await activateTrackingPreferences()
      }
    } catch {
      showToast('error', 'Error', 'No se pudo cargar la configuración del rastreo')
    } finally {
      setLoadingConfig(false)
    }
  }

  const handleVerifyDomain = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const candidate = domainInput.trim()
    if (!candidate) {
      showToast('warning', 'Dominio requerido', 'Escribe el dominio que agregaste en Render')
      return
    }

    setVerifyingDomain(true)
    setTrackingDomainError('')
    try {
      const response = await trackingService.verifyTrackingDomain(candidate)
      setTrackingDomain(response.trackingDomain || '')
      setTrackingDomainVerified(response.trackingDomainVerified)

      if (!response.trackingDomainVerified) {
        setTrackingSnippet('')
        setIsConfigured(false)
      }

      if (response.verification.verified) {
        showToast('success', 'Dominio verificado', `${response.candidate.trackingDomain} ya sirve el rastreo de esta app`)
        await loadTrackingConfig()
      } else {
        const message = response.candidate.trackingDomainError || 'El dominio todavía no responde con esta app'
        setTrackingDomainError(message)
        showToast('warning', 'Dominio pendiente', message)
      }
    } catch {
      showToast('error', 'Error al validar', 'No se pudo comprobar el dominio de rastreo')
    } finally {
      setVerifyingDomain(false)
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
    } catch {
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
    } catch {
      showToast('error', 'Error', 'No se pudo copiar el código del pixel')
    }
  }

  const hasVerifiedTrackingDomain = Boolean(trackingDomainVerified && trackingDomain)
  const cnameTargetLabel = serviceDomain.trim() || window.location.hostname || 'el dominio .onrender.com de esta instalación'
  const isRevalidatingCurrentDomain = hasVerifiedTrackingDomain && domainInput.trim().toLowerCase() === trackingDomain

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <div className={styles.logoContainer}>
                <Activity size={22} />
              </div>
              <div>
                <div className={trackStyles.titleRow}>
                  <h2 className={styles.pageTitle}>Rastreo Web</h2>
                  {!loadingConfig && (
                    <Badge variant={hasVerifiedTrackingDomain ? 'success' : 'warning'}>
                      {hasVerifiedTrackingDomain ? 'Dominio verificado' : 'Dominio requerido'}
                    </Badge>
                  )}
                </div>
                <p className={styles.pageSubtitle}>
                  {hasVerifiedTrackingDomain
                    ? 'Captura visitas, UTMs y atribución de campañas'
                    : 'Valida un dominio personalizado para generar el pixel'}
                </p>
              </div>
            </div>
            <div className={styles.headerRight}>
              {loadingConfig && (
                <div className={styles.statusConnected}>
                  <Loader2 size={16} className={styles.spinIcon} />
                  <span>Verificando...</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h3 className={styles.sectionTitle}>Dominio del pixel</h3>
              <p className={styles.sectionSubtitle}>
                Escríbelo y valídalo aquí. Ya no necesitas abrir Ristak desde ese dominio.
              </p>
            </div>
          </div>

          <form className={trackStyles.domainForm} onSubmit={handleVerifyDomain}>
            <div className={trackStyles.domainFieldRow}>
              <label className={trackStyles.domainField}>
                <span>Dominio personalizado</span>
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={domainInput}
                  placeholder="track.tudominio.com"
                  onChange={(event) => {
                    setDomainInput(event.target.value)
                    setTrackingDomainError('')
                  }}
                />
              </label>
              <Button type="submit" loading={verifyingDomain} disabled={!domainInput.trim()}>
                <CheckCircle2 size={16} />
                {isRevalidatingCurrentDomain ? 'Revalidar dominio' : 'Validar y guardar'}
              </Button>
            </div>
            <p className={trackStyles.domainHelp}>
              Primero crea el CNAME hacia <code>{cnameTargetLabel}</code> y agrega el mismo dominio
              como Custom Domain del servicio en Render. Ristak comprobará que responde esta instalación.
            </p>
            {trackingDomainError && (
              <p className={trackStyles.domainError}>{trackingDomainError}</p>
            )}
            {hasVerifiedTrackingDomain && (
              <p className={trackStyles.domainRow}>
                Dominio activo: <code>{trackingDomain}</code>
              </p>
            )}
          </form>

          {!hasVerifiedTrackingDomain && (
            <ol className={trackStyles.stepList}>
              <li className={trackStyles.stepItem}>
                <div className={trackStyles.stepBody}>
                  <strong>Crea un CNAME en tu DNS</strong>
                  <p>
                    En Cloudflare, GoDaddy, Namecheap o tu proveedor: tipo <code>CNAME</code>,
                    nombre <code>track</code> y destino <code>{cnameTargetLabel}</code>.
                  </p>
                </div>
              </li>
              <li className={trackStyles.stepItem}>
                <div className={trackStyles.stepBody}>
                  <strong>Agrega el dominio en Render</strong>
                  <p>
                    En el web service: Settings → Custom Domains → Add Custom Domain. Espera a que
                    Render termine de emitir el certificado.
                  </p>
                </div>
              </li>
              <li className={trackStyles.stepItem}>
                <div className={trackStyles.stepBody}>
                  <strong>Valídalo aquí mismo</strong>
                  <p>
                    Escribe el dominio arriba y presiona <strong>Validar y guardar</strong>. En cuanto
                    responda esta instalación, el código del pixel aparecerá abajo.
                  </p>
                </div>
              </li>
            </ol>
          )}
        </div>

        {hasVerifiedTrackingDomain && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <h3 className={styles.sectionTitle}>Instalación del pixel</h3>
                <p className={styles.sectionSubtitle}>
                  Instala el código de rastreo en tus páginas para capturar visitas y atribución.
                </p>
              </div>
            </div>

            {hasHighLevel && (
              <>
                <div className={trackStyles.syncRow}>
                  <div className={trackStyles.syncRowInfo}>
                    <strong>Sincronizar con HighLevel</strong>
                    <p>
                      {isConfigured
                        ? 'Ya está sincronizado: rstktrack apunta al dominio activo.'
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
                  <label className={styles.formLabel}>Código de píxel web</label>
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
              <pre className={styles.manualSnippetCode}><code>{trackingSnippet}</code></pre>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
