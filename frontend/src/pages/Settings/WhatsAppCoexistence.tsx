import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  RefreshCw,
  ShieldCheck,
  XCircle
} from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import {
  whatsappService,
  type WhatsAppConfig,
  type WhatsAppStorageSummary
} from '@/services/whatsappService'
import styles from './WhatsAppCoexistence.module.css'

type EmbeddedSignupPayload = {
  type?: string
  event?: string
  version?: number
  data?: Record<string, unknown>
}

type FacebookLoginResponse = {
  authResponse?: {
    code?: string
    accessToken?: string
    userID?: string
    expiresIn?: string
    signedRequest?: string
  }
  status?: string
}

const DEFAULT_GRAPH_VERSION = 'v23.0'
const COEXISTENCE_FEATURE_TYPE = 'whatsapp_business_app_onboarding'
const COEXISTENCE_FINISH_EVENT = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
const META_DEVELOPERS_URL = 'https://developers.facebook.com/apps/'
const EMBEDDED_SIGNUP_DOCS_URL = 'https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation'
const COEXISTENCE_DOCS_URL = 'https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users'

const emptyConfig: WhatsAppConfig = {
  configured: false,
  appId: '',
  appSecret: '',
  appSecretConfigured: false,
  embeddedSignupConfigId: '',
  graphApiVersion: DEFAULT_GRAPH_VERSION,
  webhookVerifyToken: '',
  webhookVerifyTokenConfigured: false,
  callbackUrl: '',
  businessToken: '',
  businessTokenConfigured: false,
  wabaId: '',
  phoneNumberId: '',
  displayPhoneNumber: '',
  verifiedName: '',
  qualityRating: '',
  platformType: '',
  isOnBizApp: false,
  connectionStatus: 'not_configured',
  onboardingEvent: '',
  connectedAt: null,
  lastExchangeAt: null,
  lastVerifiedAt: null,
  coexistenceFeatureType: COEXISTENCE_FEATURE_TYPE,
  finishEvent: COEXISTENCE_FINISH_EVENT
}

const emptyStorage: WhatsAppStorageSummary = {
  phoneNumbers: 0,
  contacts: 0,
  chats: 0,
  messages: 0,
  webhookEvents: 0
}

function buildDefaultCallbackUrl() {
  if (typeof window === 'undefined') return '/webhook/whatsapp'
  return `${window.location.origin}/webhook/whatsapp`
}

function getStatusLabel(status: string) {
  switch (status) {
    case 'connected':
      return 'Conectado'
    case 'ready_to_connect':
      return 'Listo para conectar'
    case 'token_exchanged':
      return 'Token intercambiado'
    case 'signup_event_received':
      return 'Evento recibido'
    default:
      return 'No configurado'
  }
}

function getStatusClassName(status: string) {
  if (status === 'connected') return styles.statusConnected
  if (status === 'ready_to_connect' || status === 'token_exchanged' || status === 'signup_event_received') {
    return styles.statusWarning
  }
  return styles.statusDisconnected
}

function hasFinishEvent(payload: EmbeddedSignupPayload | null) {
  return payload?.event === COEXISTENCE_FINISH_EVENT || payload?.event === 'FINISH'
}

function loadFacebookSdk(appId: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!appId) {
      reject(new Error('App ID requerido'))
      return
    }

    const initialize = () => {
      if (!window.FB) {
        reject(new Error('Facebook SDK no disponible'))
        return
      }

      window.FB.init({
        appId,
        autoLogAppEvents: true,
        xfbml: false,
        version
      })
      resolve()
    }

    if (window.FB) {
      initialize()
      return
    }

    window.fbAsyncInit = initialize

    if (document.getElementById('facebook-jssdk')) {
      const startedAt = Date.now()
      const interval = window.setInterval(() => {
        if (window.FB) {
          window.clearInterval(interval)
          initialize()
        } else if (Date.now() - startedAt > 8000) {
          window.clearInterval(interval)
          reject(new Error('Facebook SDK no respondió'))
        }
      }, 100)
      return
    }

    const script = document.createElement('script')
    script.id = 'facebook-jssdk'
    script.src = 'https://connect.facebook.net/en_US/sdk.js'
    script.async = true
    script.defer = true
    script.onerror = () => reject(new Error('No se pudo cargar Facebook SDK'))
    document.body.appendChild(script)
  })
}

export const WhatsAppCoexistence: React.FC = () => {
  const { showToast } = useNotification()
  const [config, setConfig] = useState<WhatsAppConfig>(emptyConfig)
  const [storage, setStorage] = useState<WhatsAppStorageSummary>(emptyStorage)
  const [form, setForm] = useState({
    appId: '',
    appSecret: '',
    embeddedSignupConfigId: '',
    graphApiVersion: DEFAULT_GRAPH_VERSION,
    webhookVerifyToken: '',
    callbackUrl: buildDefaultCallbackUrl()
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isLaunching, setIsLaunching] = useState(false)
  const [isCompleting, setIsCompleting] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sessionPayload, setSessionPayload] = useState<EmbeddedSignupPayload | null>(null)
  const [activeStep, setActiveStep] = useState(0)
  const pendingCodeRef = useRef<string>('')
  const sessionPayloadRef = useRef<EmbeddedSignupPayload | null>(null)
  const completedCodeRef = useRef<string>('')

  const hasAppCredentials = Boolean(form.appId && (form.appSecret || config.appSecretConfigured))
  const hasConfigId = Boolean(form.embeddedSignupConfigId)
  const hasWebhookToken = Boolean(form.webhookVerifyToken || config.webhookVerifyTokenConfigured)
  const isReadyToSave = Boolean(hasAppCredentials && hasConfigId && hasWebhookToken)

  const setupSteps = useMemo(() => ([
    {
      title: 'Meta App',
      description: 'App ID y App Secret',
      done: hasAppCredentials
    },
    {
      title: 'Configuration ID',
      description: 'Facebook Login for Business',
      done: hasConfigId
    },
    {
      title: 'Webhook',
      description: 'URL y verify token',
      done: hasWebhookToken
    },
    {
      title: 'Guardar',
      description: 'Persistir datos seguros',
      done: config.configured
    },
    {
      title: 'Conectar',
      description: 'Abrir Coexistence',
      done: config.connectionStatus === 'connected'
    }
  ]), [config.configured, config.connectionStatus, hasAppCredentials, hasConfigId, hasWebhookToken])

  const completedSteps = setupSteps.filter(step => step.done).length
  const canLaunchSignup = Boolean(
    config.configured &&
    form.appId &&
    form.embeddedSignupConfigId &&
    (form.appSecret || config.appSecretConfigured)
  )
  const activeStepDone = setupSteps[activeStep]?.done === true

  useEffect(() => {
    loadConfig()
  }, [])

  useEffect(() => {
    const handleEmbeddedSignupMessage = (event: MessageEvent) => {
      if (!event.origin.endsWith('facebook.com')) return

      let payload: EmbeddedSignupPayload | null = null
      try {
        payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      } catch {
        payload = null
      }

      if (!payload || payload.type !== 'WA_EMBEDDED_SIGNUP') return

      setSessionPayload(payload)
      sessionPayloadRef.current = payload

      if (payload.event === 'CANCEL') {
        whatsappService.completeEmbeddedSignup({
          code: '',
          sessionPayload: payload as Record<string, unknown>,
          responsePayload: {}
        }).catch(() => undefined)

        const errorMessage = typeof payload.data?.error_message === 'string'
          ? payload.data.error_message
          : 'El flujo de Meta se canceló antes de terminar'
        showToast('warning', 'Flujo cancelado', errorMessage)
        return
      }

      if (hasFinishEvent(payload) && pendingCodeRef.current) {
        finalizeSignup(pendingCodeRef.current, payload, { source: 'message_event' })
      }
    }

    window.addEventListener('message', handleEmbeddedSignupMessage)
    return () => window.removeEventListener('message', handleEmbeddedSignupMessage)
  }, [])

  const loadConfig = async () => {
    setIsLoading(true)
    try {
      const response = await whatsappService.getConfig()
      applyConfigResponse(response.config, response.storage)
    } catch (error) {
      showToast('error', 'Error', 'No se pudo cargar WhatsApp API')
    } finally {
      setIsLoading(false)
    }
  }

  const applyConfigResponse = (nextConfig: WhatsAppConfig, nextStorage?: WhatsAppStorageSummary) => {
    setConfig(nextConfig)
    if (nextStorage) setStorage(nextStorage)
    setForm({
      appId: nextConfig.appId || '',
      appSecret: nextConfig.appSecret || '',
      embeddedSignupConfigId: nextConfig.embeddedSignupConfigId || '',
      graphApiVersion: nextConfig.graphApiVersion || DEFAULT_GRAPH_VERSION,
      webhookVerifyToken: nextConfig.webhookVerifyToken || '',
      callbackUrl: nextConfig.callbackUrl || buildDefaultCallbackUrl()
    })
  }

  const handleInputChange = (field: keyof typeof form, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const handleSave = async () => {
    if (!form.appId || !form.embeddedSignupConfigId) {
      showToast('error', 'Datos incompletos', 'App ID y Configuration ID son requeridos')
      return false
    }

    if (!form.appSecret && !config.appSecretConfigured) {
      showToast('error', 'App Secret requerido', 'Guarda el App Secret de Meta Developers')
      return false
    }

    if (!form.webhookVerifyToken && !config.webhookVerifyTokenConfigured) {
      showToast('error', 'Verify token requerido', 'Define el token que usarás en el webhook de Meta')
      return false
    }

    setIsSaving(true)
    try {
      const saved = await whatsappService.saveConfig(form)
      setConfig(saved)
      setForm(prev => ({
        ...prev,
        appSecret: saved.appSecret || prev.appSecret,
        webhookVerifyToken: saved.webhookVerifyToken || prev.webhookVerifyToken,
        graphApiVersion: saved.graphApiVersion || prev.graphApiVersion
      }))
      showToast('success', 'WhatsApp guardado', 'Configuración lista para Embedded Signup')
      return true
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar')
      return false
    } finally {
      setIsSaving(false)
    }
  }

  const finalizeSignup = async (
    code: string,
    payload: EmbeddedSignupPayload | null,
    responsePayload: Record<string, unknown>
  ) => {
    if (!code || completedCodeRef.current === code) return
    completedCodeRef.current = code
    setIsCompleting(true)

    try {
      const result = await whatsappService.completeEmbeddedSignup({
        code,
        sessionPayload: (payload || {}) as Record<string, unknown>,
        responsePayload
      })
      applyConfigResponse(result.config, result.storage)
      pendingCodeRef.current = ''

      if (result.config.connectionStatus === 'connected') {
        setActiveStep(4)
        showToast('success', 'Número conectado', 'WhatsApp quedó conectado en modo Coexistence')
      } else {
        showToast('warning', 'Revisa Meta', 'El token se guardó, pero falta confirmar WABA o Phone Number ID')
      }
    } catch (error) {
      completedCodeRef.current = ''
      showToast('error', 'Error de conexión', error instanceof Error ? error.message : 'Meta no completó la conexión')
    } finally {
      setIsCompleting(false)
      setIsLaunching(false)
    }
  }

  const handleLaunchSignup = async () => {
    if (!canLaunchSignup) {
      showToast('error', 'Guarda primero', 'Completa y guarda la configuración de Meta Developers')
      return
    }

    setIsLaunching(true)
    pendingCodeRef.current = ''
    completedCodeRef.current = ''
    sessionPayloadRef.current = null
    setSessionPayload(null)

    try {
      await loadFacebookSdk(form.appId, form.graphApiVersion)
      window.FB.login((response: FacebookLoginResponse) => {
        const code = response.authResponse?.code
        if (!code) {
          setIsLaunching(false)
          showToast('warning', 'Sin código', 'Meta no regresó el code de Embedded Signup')
          return
        }

        pendingCodeRef.current = code
        const latestSession = sessionPayloadRef.current
        if (hasFinishEvent(latestSession)) {
          finalizeSignup(code, latestSession, response as Record<string, unknown>)
          return
        }

        window.setTimeout(() => {
          if (pendingCodeRef.current === code && completedCodeRef.current !== code) {
            finalizeSignup(code, sessionPayloadRef.current, response as Record<string, unknown>)
          }
        }, 2500)
      }, {
        config_id: form.embeddedSignupConfigId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: COEXISTENCE_FEATURE_TYPE
        }
      })
    } catch (error) {
      setIsLaunching(false)
      showToast('error', 'Facebook SDK', error instanceof Error ? error.message : 'No se pudo abrir Meta')
    }
  }

  const handleRefreshStatus = async () => {
    setIsRefreshing(true)
    try {
      const result = await whatsappService.refreshStatus()
      applyConfigResponse(result.config, result.storage)
      showToast('success', 'Estado actualizado', 'Se consultó el número en Meta')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo consultar Meta')
    } finally {
      setIsRefreshing(false)
    }
  }

  const getStepBlockMessage = (stepIndex = activeStep) => {
    if (stepIndex === 0 && !hasAppCredentials) {
      return 'Primero pega el App ID y App Secret de tu Meta Developer App'
    }

    if (stepIndex === 1 && !hasConfigId) {
      return 'Pega el Configuration ID de Facebook Login for Business'
    }

    if (stepIndex === 2 && !hasWebhookToken) {
      return 'Define el verify token del webhook'
    }

    if (stepIndex === 3 && !config.configured) {
      return 'Guarda la configuración antes de conectar WhatsApp'
    }

    return ''
  }

  const handleNextStep = () => {
    if (activeStep < 3 && !activeStepDone) {
      showToast('warning', 'Falta un dato', getStepBlockMessage())
      return
    }

    if (activeStep === 3 && !config.configured) {
      showToast('warning', 'Guarda primero', getStepBlockMessage())
      return
    }

    setActiveStep(step => Math.min(step + 1, setupSteps.length - 1))
  }

  const handlePreviousStep = () => {
    setActiveStep(step => Math.max(step - 1, 0))
  }

  const handleSelectStep = (stepIndex: number) => {
    const firstIncompleteStepIndex = setupSteps.findIndex((step, index) => index < stepIndex && !step.done)

    if (firstIncompleteStepIndex >= 0) {
      showToast('warning', 'Completa este paso', getStepBlockMessage(firstIncompleteStepIndex))
      return
    }

    setActiveStep(stepIndex)
  }

  const handleSaveAndContinue = async () => {
    const saved = await handleSave()
    if (saved) {
      setActiveStep(4)
    }
  }

  const handleCopy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast('success', 'Copiado', label)
    } catch {
      showToast('error', 'Error', 'No se pudo copiar')
    }
  }

  const renderStepContent = () => {
    if (activeStep === 0) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 1</span>
            <h3 className={styles.stepTitle}>Usa la misma Meta Developer App</h3>
            <p className={styles.stepText}>
              Abre tu app en Meta Developers. Si la app que usas para Meta Ads ya existe, puedes usar esa misma; lo importante es que tenga WhatsApp y Facebook Login for Business configurados.
            </p>
            <a className={styles.inlineDocLink} href={META_DEVELOPERS_URL} target="_blank" rel="noopener noreferrer">
              Abrir Meta Developers
              <ExternalLink size={14} />
            </a>
          </div>

          <div className={styles.formGrid}>
            <label className={styles.formGroup}>
              <span className={styles.formLabel}>Meta App ID</span>
              <input
                className={styles.formInput}
                value={form.appId}
                onChange={(event) => handleInputChange('appId', event.target.value)}
                placeholder="123456789012345"
              />
            </label>

            <label className={styles.formGroup}>
              <span className={styles.formLabel}>App Secret</span>
              <input
                className={styles.formInput}
                value={form.appSecret}
                onChange={(event) => handleInputChange('appSecret', event.target.value)}
                placeholder={config.appSecretConfigured ? 'Ya guardado; pega uno nuevo sólo si quieres rotarlo' : 'Pega el App Secret'}
                type="password"
              />
            </label>

            <label className={styles.formGroup}>
              <span className={styles.formLabel}>Graph API Version</span>
              <input
                className={styles.formInput}
                value={form.graphApiVersion}
                onChange={(event) => handleInputChange('graphApiVersion', event.target.value)}
                placeholder="v23.0"
              />
            </label>
          </div>
        </>
      )
    }

    if (activeStep === 1) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 2</span>
            <h3 className={styles.stepTitle}>Saca el Configuration ID</h3>
            <p className={styles.stepText}>
              En Meta Developers ve a Facebook Login for Business, entra a Configurations y crea una configuración con la plantilla de WhatsApp Embedded Signup. El ID que aparece ahí va aquí.
            </p>
          </div>

          <ol className={styles.guideList}>
            <li>Meta Developers → tu App.</li>
            <li>Facebook Login for Business → Configurations.</li>
            <li>Create from template → WhatsApp Embedded Signup.</li>
            <li>Copia el Configuration ID.</li>
          </ol>

          <label className={`${styles.formGroup} ${styles.formGroupWide}`}>
            <span className={styles.formLabel}>Configuration ID</span>
            <input
              className={styles.formInput}
              value={form.embeddedSignupConfigId}
              onChange={(event) => handleInputChange('embeddedSignupConfigId', event.target.value)}
              placeholder="ID de la configuración de Facebook Login for Business"
            />
          </label>

          <div className={styles.notThisBox}>
            No pegues aquí WABA ID, Phone Number ID, Pixel ID ni Business Manager ID. Este campo es sólo el Configuration ID.
          </div>
        </>
      )
    }

    if (activeStep === 2) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 3</span>
            <h3 className={styles.stepTitle}>Configura el webhook de WhatsApp</h3>
            <p className={styles.stepText}>
              En WhatsApp → Configuration pega esta callback URL y usa el mismo verify token que pongas aquí.
            </p>
          </div>

          <label className={`${styles.formGroup} ${styles.formGroupWide}`}>
            <span className={styles.formLabel}>Webhook callback URL</span>
            <div className={styles.inputActionRow}>
              <input
                className={styles.formInput}
                value={form.callbackUrl}
                onChange={(event) => handleInputChange('callbackUrl', event.target.value)}
              />
              <Button type="button" variant="secondary" onClick={() => handleCopy(form.callbackUrl, 'Webhook URL copiado')}>
                <Copy size={16} />
                Copiar
              </Button>
            </div>
          </label>

          <label className={`${styles.formGroup} ${styles.formGroupWide}`}>
            <span className={styles.formLabel}>Webhook verify token</span>
            <input
              className={styles.formInput}
              value={form.webhookVerifyToken}
              onChange={(event) => handleInputChange('webhookVerifyToken', event.target.value)}
              placeholder={config.webhookVerifyTokenConfigured ? 'Ya guardado; pega uno nuevo sólo si quieres rotarlo' : 'Token privado para verificar el webhook'}
            />
          </label>

          <div className={styles.fieldPills}>
            <span>messages</span>
            <span>message_template_status_update</span>
            <span>account_update</span>
            <span>history</span>
            <span>smb_app_state_sync</span>
            <span>smb_message_echoes</span>
          </div>
        </>
      )
    }

    if (activeStep === 3) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 4</span>
            <h3 className={styles.stepTitle}>Guarda la configuración</h3>
            <p className={styles.stepText}>
              Esto guarda App ID, App Secret, Configuration ID, versión de Graph API y webhook en la estructura dedicada de WhatsApp.
            </p>
          </div>

          <div className={styles.reviewGrid}>
            <div>
              <span>Meta App</span>
              <strong>{hasAppCredentials ? 'Lista' : 'Pendiente'}</strong>
            </div>
            <div>
              <span>Configuration ID</span>
              <strong>{hasConfigId ? 'Listo' : 'Pendiente'}</strong>
            </div>
            <div>
              <span>Webhook</span>
              <strong>{hasWebhookToken ? 'Listo' : 'Pendiente'}</strong>
            </div>
            <div>
              <span>Estado guardado</span>
              <strong>{config.configured ? 'Guardado' : 'Sin guardar'}</strong>
            </div>
          </div>

          <Button type="button" variant="primary" onClick={handleSaveAndContinue} disabled={!isReadyToSave || isSaving || isLoading}>
            <KeyRound size={16} className={isSaving ? styles.spinning : ''} />
            {isSaving ? 'Guardando...' : config.configured ? 'Actualizar y continuar' : 'Guardar y continuar'}
          </Button>
        </>
      )
    }

    return (
      <>
        <div className={styles.stepIntro}>
          <span className={styles.stepEyebrow}>Paso 5</span>
          <h3 className={styles.stepTitle}>Conecta el número en modo Coexistence</h3>
          <p className={styles.stepText}>
            Ahora sí, abre el flujo oficial de Meta. Ristak lo lanza con el modo Coexistence para conectar un número que ya vive en WhatsApp Business App.
          </p>
        </div>

        <div className={styles.connectionPanel}>
          <div>
            <span className={styles.connectionLabel}>Feature type</span>
            <strong>{COEXISTENCE_FEATURE_TYPE}</strong>
          </div>
          <div>
            <span className={styles.connectionLabel}>Evento esperado</span>
            <strong>{COEXISTENCE_FINISH_EVENT}</strong>
          </div>
        </div>

        <Button type="button" variant="primary" onClick={handleLaunchSignup} disabled={!canLaunchSignup || isLaunching || isCompleting}>
          <Link2 size={16} className={isLaunching || isCompleting ? styles.spinning : ''} />
          {isCompleting ? 'Conectando...' : 'Conectar WhatsApp Coexistence'}
        </Button>
      </>
    )
  }

  return (
    <div className={styles.container}>
      <Card className={styles.mainCard}>
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <span className={styles.logoMark} aria-hidden="true">
                <SiWhatsapp size={26} />
              </span>
              <div>
                <h2 className={styles.pageTitle}>WhatsApp API Coexistence</h2>
                <p className={styles.pageSubtitle}>
                  Sigue el wizard para preparar Meta Developers y conectar WhatsApp sin mezclar datos con CRM.
                </p>
              </div>
            </div>
            <div className={styles.headerRight}>
              <div className={getStatusClassName(config.connectionStatus)}>
                {config.connectionStatus === 'connected' ? <CheckCircle size={16} /> : <XCircle size={16} />}
                <span>{getStatusLabel(config.connectionStatus)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.workspace}>
          <div className={styles.primaryColumn}>
            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                <div>
                  <h3 className={styles.sectionTitle}>Wizard de conexión</h3>
                  <p className={styles.sectionDescription}>
                    Completa cada paso y al final conecta el número desde Meta.
                  </p>
                </div>
                <span className={styles.stepCount}>{completedSteps}/5 listo</span>
              </div>

              <div className={styles.wizardShell}>
                <div className={styles.progressList}>
                  {setupSteps.map((step, index) => (
                    <button
                      key={step.title}
                      type="button"
                      className={[
                        styles.progressItem,
                        step.done ? styles.progressDone : '',
                        index === activeStep ? styles.progressActive : ''
                      ].filter(Boolean).join(' ')}
                      onClick={() => handleSelectStep(index)}
                    >
                    <span className={styles.progressDot}>{step.done ? <CheckCircle size={13} /> : index + 1}</span>
                    <span className={styles.progressCopy}>
                      <span className={styles.progressLabel}>{step.title}</span>
                      <span className={styles.progressDescription}>{step.description}</span>
                    </span>
                    </button>
                  ))}
                </div>

                <div className={styles.stepPanel}>
                  {isLoading ? (
                    <div className={styles.loadingState}>Cargando WhatsApp API...</div>
                  ) : (
                    <>
                      {renderStepContent()}

                      <div className={styles.stepActions}>
                        <Button type="button" variant="secondary" onClick={handlePreviousStep} disabled={activeStep === 0}>
                          <ArrowLeft size={16} />
                          Atrás
                        </Button>
                        {activeStep < setupSteps.length - 1 && (
                          <Button type="button" variant="secondary" onClick={handleNextStep}>
                            Siguiente
                            <ArrowRight size={16} />
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className={styles.docsListInline}>
                <a href={EMBEDDED_SIGNUP_DOCS_URL} target="_blank" rel="noopener noreferrer">
                  Embedded Signup
                  <ExternalLink size={14} />
                </a>
                <a href={COEXISTENCE_DOCS_URL} target="_blank" rel="noopener noreferrer">
                  Coexistence
                  <ExternalLink size={14} />
                </a>
              </div>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                <div>
                  <h3 className={styles.sectionTitle}>Estructura WhatsApp separada</h3>
                  <p className={styles.sectionDescription}>
                    Almacenamiento dedicado para preparar chats, mensajes, contactos, números y webhooks.
                  </p>
                </div>
              </div>

              <div className={styles.storageGrid}>
                <div className={styles.storageItem}>
                  <span className={styles.storageValue}>{storage.phoneNumbers}</span>
                  <span className={styles.storageLabel}>Números</span>
                </div>
                <div className={styles.storageItem}>
                  <span className={styles.storageValue}>{storage.contacts}</span>
                  <span className={styles.storageLabel}>Contactos WA</span>
                </div>
                <div className={styles.storageItem}>
                  <span className={styles.storageValue}>{storage.chats}</span>
                  <span className={styles.storageLabel}>Chats</span>
                </div>
                <div className={styles.storageItem}>
                  <span className={styles.storageValue}>{storage.messages}</span>
                  <span className={styles.storageLabel}>Mensajes</span>
                </div>
                <div className={styles.storageItem}>
                  <span className={styles.storageValue}>{storage.webhookEvents}</span>
                  <span className={styles.storageLabel}>Webhooks</span>
                </div>
              </div>
            </section>
          </div>

          <div className={styles.sideColumn}>
            <section className={styles.section}>
              <div className={styles.numberHeader}>
                <span className={styles.numberIcon} aria-hidden="true">
                  <ShieldCheck size={22} />
                </span>
                <div>
                  <h3 className={styles.sectionTitle}>Número conectado</h3>
                  <p className={styles.sectionDescription}>Estado leído desde WhatsApp Business Platform.</p>
                </div>
              </div>

              <div className={styles.infoList}>
                <div className={styles.infoRow}>
                  <span>WABA ID</span>
                  <strong>{config.wabaId || 'Pendiente'}</strong>
                </div>
                <div className={styles.infoRow}>
                  <span>Phone Number ID</span>
                  <strong>{config.phoneNumberId || 'Pendiente'}</strong>
                </div>
                <div className={styles.infoRow}>
                  <span>Número</span>
                  <strong>{config.displayPhoneNumber || 'Pendiente'}</strong>
                </div>
                <div className={styles.infoRow}>
                  <span>Nombre</span>
                  <strong>{config.verifiedName || 'Pendiente'}</strong>
                </div>
                <div className={styles.infoRow}>
                  <span>Coexistence</span>
                  <strong>{config.isOnBizApp ? 'Activo' : 'Sin confirmar'}</strong>
                </div>
                <div className={styles.infoRow}>
                  <span>Platform</span>
                  <strong>{config.platformType || 'Pendiente'}</strong>
                </div>
              </div>

              <Button type="button" variant="secondary" onClick={handleRefreshStatus} disabled={!config.businessTokenConfigured || isRefreshing} fullWidth>
                <RefreshCw size={16} className={isRefreshing ? styles.spinning : ''} />
                {isRefreshing ? 'Consultando...' : 'Actualizar estado'}
              </Button>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                <div>
                  <h3 className={styles.sectionTitle}>Qué dato es cuál</h3>
                  <p className={styles.sectionDescription}>Mapa rápido para no confundir IDs.</p>
                </div>
              </div>

              <div className={styles.definitionList}>
                <div>
                  <span>App ID / Secret</span>
                  <p>Vienen de la app en Meta Developers.</p>
                </div>
                <div>
                  <span>Configuration ID</span>
                  <p>Viene de Facebook Login for Business → Configurations.</p>
                </div>
                <div>
                  <span>WABA / Phone Number ID</span>
                  <p>Los devuelve Meta después de conectar el número.</p>
                </div>
              </div>
            </section>

            {sessionPayload && (
              <section className={styles.section}>
                <div className={styles.infoRow}>
                  <span>Último evento</span>
                  <strong>{sessionPayload.event || 'WA_EMBEDDED_SIGNUP'}</strong>
                </div>
              </section>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}
