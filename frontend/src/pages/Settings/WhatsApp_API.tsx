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
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import {
  whatsappService,
  type SaveWhatsAppConfigPayload,
  type WhatsAppConfig,
  type WhatsAppStorageSummary
} from '@/services/whatsappService'
import styles from './WhatsApp_API.module.css'

const DEFAULT_GRAPH_VERSION = 'v23.0'
const META_DEVELOPERS_URL = 'https://developers.facebook.com/apps/'
const CLOUD_API_DOCS_URL = 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started'
const WEBHOOK_DOCS_URL = 'https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks'
const SYSTEM_USER_DOCS_URL = 'https://developers.facebook.com/docs/whatsapp/business-management-api/get-started'

const WEBHOOK_FIELD_GROUPS = [
  {
    title: 'Obligatorio para tracking',
    description: 'Este campo trae mensajes entrantes y estados de mensajes salientes. No busques statuses como campo separado; Meta los manda dentro de messages.',
    fields: ['messages']
  },
  {
    title: 'Recomendado para plantillas',
    description: 'Deja estos listos para saber aprobaciones, rechazos, calidad y cambios de categoría cuando activemos plantillas.',
    fields: [
      'message_template_status_update',
      'message_template_quality_update',
      'message_template_components_update',
      'template_category_update',
      'template_correct_category_detection'
    ]
  },
  {
    title: 'Recomendado para salud del número',
    description: 'Sirven para detectar alertas del WABA, cambios de nombre, calidad del número y estado de la cuenta.',
    fields: [
      'phone_number_quality_update',
      'phone_number_name_update',
      'account_update',
      'account_alerts',
      'account_review_update',
      'business_status_update'
    ]
  },
  {
    title: 'Opcional si Meta lo muestra',
    description: 'Suscríbelos solo si vas a usar tracking extra, llamadas o flows. Ristak los guardará crudos aunque todavía no los explote en pantalla.',
    fields: ['tracking_events', 'calls', 'flows']
  }
]

const emptyConfig: WhatsAppConfig = {
  configured: false,
  appId: '',
  appSecret: '',
  appSecretConfigured: false,
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
  lastVerifiedAt: null
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

function getUrlParts(value: string) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isLocalHostname(hostname = '') {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname) || hostname.endsWith('.localhost')
}

function getStatusLabel(status: string) {
  switch (status) {
    case 'connected':
      return 'Conectado'
    case 'ready_to_connect':
      return 'Listo para validar'
    default:
      return 'No configurado'
  }
}

function getStatusClassName(status: string) {
  if (status === 'connected') return styles.statusConnected
  if (status === 'ready_to_connect') return styles.statusWarning
  return styles.statusDisconnected
}

export const WhatsApp_API: React.FC = () => {
  const { showToast } = useNotification()
  const [config, setConfig] = useState<WhatsAppConfig>(emptyConfig)
  const [storage, setStorage] = useState<WhatsAppStorageSummary>(emptyStorage)
  const [form, setForm] = useState({
    appId: '',
    appSecret: '',
    businessToken: '',
    wabaId: '',
    phoneNumberId: '',
    webhookVerifyToken: '',
    callbackUrl: buildDefaultCallbackUrl()
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [activeStep, setActiveStep] = useState(0)
  const autoSavedWebhookSignatureRef = useRef<string>('')

  const hasAppCredentials = Boolean(form.appId && (form.appSecret || config.appSecretConfigured))
  const hasAccessToken = Boolean(form.businessToken || config.businessTokenConfigured)
  const hasPhoneApiData = Boolean(hasAccessToken && form.wabaId && form.phoneNumberId)
  const hasWebhookToken = Boolean(form.webhookVerifyToken || config.webhookVerifyTokenConfigured)
  const isConnected = config.connectionStatus === 'connected'
  const isReadyToSave = Boolean(hasAppCredentials && hasPhoneApiData && hasWebhookToken)

  const setupSteps = useMemo(() => ([
    {
      title: 'Meta App',
      description: 'App propia del usuario',
      done: hasAppCredentials
    },
    {
      title: 'Cloud API',
      description: 'Token, Phone ID y WABA',
      done: hasPhoneApiData
    },
    {
      title: 'Webhook',
      description: 'URL y verify token',
      done: hasWebhookToken
    },
    {
      title: 'Guardar',
      description: 'Persistir configuración',
      done: config.configured
    },
    {
      title: 'Validar',
      description: 'Conectar con Meta',
      done: isConnected
    }
  ]), [config.configured, hasAppCredentials, hasPhoneApiData, hasWebhookToken, isConnected])

  const completedSteps = setupSteps.filter(step => step.done).length
  const activeStepDone = setupSteps[activeStep]?.done === true

  const webhookEnvironmentMismatch = useMemo(() => {
    if (typeof window === 'undefined') return false

    const callbackUrl = getUrlParts(form.callbackUrl)
    if (!callbackUrl) return false

    return isLocalHostname(window.location.hostname) && !isLocalHostname(callbackUrl.hostname)
  }, [form.callbackUrl])

  useEffect(() => {
    loadConfig()
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
      businessToken: nextConfig.businessToken || '',
      wabaId: nextConfig.wabaId || '',
      phoneNumberId: nextConfig.phoneNumberId || '',
      webhookVerifyToken: nextConfig.webhookVerifyToken || '',
      callbackUrl: nextConfig.callbackUrl || buildDefaultCallbackUrl()
    })
  }

  const handleInputChange = (field: keyof typeof form, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const buildSavePayload = (): SaveWhatsAppConfigPayload => ({
    appId: form.appId,
    appSecret: form.appSecret || undefined,
    businessToken: form.businessToken || undefined,
    wabaId: form.wabaId,
    phoneNumberId: form.phoneNumberId,
    webhookVerifyToken: form.webhookVerifyToken || undefined,
    callbackUrl: form.callbackUrl
  })

  const validateConfigForSave = (requireComplete: boolean) => {
    if (!form.appId) {
      showToast('error', 'App ID requerido', 'Pega el App ID de Meta Developers')
      return false
    }

    if (!form.appSecret && !config.appSecretConfigured) {
      showToast('error', 'App Secret requerido', 'Pega el App Secret de Meta Developers')
      return false
    }

    if (!requireComplete) return true

    if (!form.businessToken && !config.businessTokenConfigured) {
      showToast('error', 'Access Token requerido', 'Pega el Access Token compartido de Meta')
      return false
    }

    if (!form.wabaId || !form.phoneNumberId) {
      showToast('error', 'IDs requeridos', 'Pega Phone Number ID y WABA ID desde WhatsApp API Setup')
      return false
    }

    if (!form.webhookVerifyToken && !config.webhookVerifyTokenConfigured) {
      showToast('error', 'Verify token requerido', 'Llega al paso de webhook para que Ristak genere el token')
      return false
    }

    return true
  }

  const handleSave = async (options: { silent?: boolean; requireComplete?: boolean; generateWebhookToken?: boolean } = {}) => {
    const silent = options.silent === true
    const requireComplete = options.requireComplete !== false

    if (!validateConfigForSave(requireComplete)) return false

    setIsSaving(true)
    try {
      const saved = await whatsappService.saveConfig({
        ...buildSavePayload(),
        webhookVerifyToken: options.generateWebhookToken ? undefined : form.webhookVerifyToken || undefined
      })
      setConfig(saved)
      setForm(prev => ({
        ...prev,
        appSecret: saved.appSecret || prev.appSecret,
        businessToken: saved.businessToken || prev.businessToken,
        webhookVerifyToken: saved.webhookVerifyToken || prev.webhookVerifyToken || ''
      }))
      if (!silent) {
        showToast('success', 'WhatsApp guardado', 'Configuración lista para validar con Meta')
      }
      return saved
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar')
      return false
    } finally {
      setIsSaving(false)
    }
  }

  useEffect(() => {
    if (
      activeStep !== 2 ||
      isLoading ||
      isSaving ||
      config.webhookVerifyTokenConfigured ||
      form.webhookVerifyToken ||
      !hasAppCredentials
    ) return

    const signature = [
      form.appId,
      form.appSecret || (config.appSecretConfigured ? 'stored-secret' : ''),
      form.callbackUrl
    ].join('|')

    if (autoSavedWebhookSignatureRef.current === signature) return
    autoSavedWebhookSignatureRef.current = signature

    handleSave({ silent: true, requireComplete: false, generateWebhookToken: true }).then(saved => {
      if (!saved) {
        autoSavedWebhookSignatureRef.current = ''
      }
    })
  }, [
    activeStep,
    config.appSecretConfigured,
    config.webhookVerifyTokenConfigured,
    form.appId,
    form.appSecret,
    form.callbackUrl,
    form.webhookVerifyToken,
    hasAppCredentials,
    isLoading,
    isSaving
  ])

  const handleSaveAndContinue = async () => {
    const saved = await handleSave({ requireComplete: true })
    if (saved) setActiveStep(4)
  }

  const handleConnect = async () => {
    if (!config.configured) {
      const saved = await handleSave({ requireComplete: true })
      if (!saved) return
    }

    setIsConnecting(true)
    try {
      const result = await whatsappService.connectCloudApi()
      applyConfigResponse(result.config, result.storage)
      if (result.config.connectionStatus === 'connected') {
        showToast('success', 'WhatsApp conectado', 'Meta validó el número y Ristak quedó suscrito a webhooks')
      } else {
        showToast('warning', 'Revisa Meta', 'Se guardó la configuración, pero falta confirmar el número en Meta')
      }
    } catch (error) {
      showToast('error', 'Error de conexión', error instanceof Error ? error.message : 'Meta no validó la conexión')
    } finally {
      setIsConnecting(false)
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
      return 'Primero pega App ID y App Secret de tu Meta Developer App'
    }

    if (stepIndex === 1 && !hasPhoneApiData) {
      return 'Pega Access Token, Phone Number ID y WABA ID desde WhatsApp API Setup'
    }

    if (stepIndex === 2 && !hasWebhookToken) {
      return 'Llega al paso de webhook y copia el verify token generado por Ristak'
    }

    if (stepIndex === 3 && !config.configured) {
      return 'Guarda la configuración antes de validarla con Meta'
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

  const handleCopy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast('success', 'Copiado', label)
    } catch {
      showToast('error', 'Error', 'No se pudo copiar')
    }
  }

  const handleCopyWebhookToken = async () => {
    if (!form.webhookVerifyToken && hasAppCredentials) {
      const saved = await handleSave({ silent: true, requireComplete: false, generateWebhookToken: true })
      if (!saved) return
      await handleCopy(saved.webhookVerifyToken, 'Verify token copiado')
      return
    }

    await handleCopy(form.webhookVerifyToken, 'Verify token copiado')
  }

  const renderStepContent = () => {
    if (activeStep === 0) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 1</span>
            <h3 className={styles.stepTitle}>Prepara tu Meta Developer App</h3>
            <p className={styles.stepText}>
              Usa tu propia app de Meta Developers. Como esta instalación es single-user en tu propio Render, la app accede a tus propios activos y se conecta por Cloud API directa.
            </p>
            <a className={styles.inlineDocLink} href={META_DEVELOPERS_URL} target="_blank" rel="noopener noreferrer">
              Abrir Meta Developers
              <ExternalLink size={14} />
            </a>
          </div>

          <div className={styles.warningCallout}>
            <strong>Importante</strong>
            <p>
              Este modo no conserva el número abierto en WhatsApp Business App del celular. Para evitar broncas, usa un número dedicado a Cloud API o migra el número siguiendo el flujo normal de Meta.
            </p>
          </div>

          <ol className={styles.guideDetailList}>
            <li>
              <strong>Crea o abre tu app</strong>
              <span>En Meta Developers crea una app tipo Business o usa la app que ya tengas para Meta Ads.</span>
            </li>
            <li>
              <strong>Agrega WhatsApp</strong>
              <span>Dentro de la app, agrega el producto WhatsApp y entra a WhatsApp API Setup.</span>
            </li>
            <li>
              <strong>Copia App ID y App Secret</strong>
              <span>El App ID aparece arriba en el dashboard de la app. El App Secret está en App settings → Basic.</span>
            </li>
          </ol>

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
                placeholder={config.appSecretConfigured ? 'Ya guardado; pega uno nuevo solo si quieres rotarlo' : 'Pega el App Secret'}
                type="password"
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
            <h3 className={styles.stepTitle}>Copia los datos de WhatsApp API Setup</h3>
            <p className={styles.stepText}>
              En Meta Developers entra a tu app → WhatsApp → API Setup. Desde ahí agregas/verificas el número y copias el Phone Number ID y el WABA ID. Ristak usa el mismo Access Token de Meta para Ads y WhatsApp.
            </p>
            <a className={styles.inlineDocLink} href={CLOUD_API_DOCS_URL} target="_blank" rel="noopener noreferrer">
              Ver guía oficial Cloud API
              <ExternalLink size={14} />
            </a>
          </div>

          <ol className={styles.guideDetailList}>
            <li>
              <strong>Agrega el número</strong>
              <span>En WhatsApp API Setup registra el número que usará Cloud API. Meta puede pedir verificación por SMS o llamada.</span>
            </li>
            <li>
              <strong>Copia Phone Number ID y WABA ID</strong>
              <span>El Phone Number ID identifica el número específico desde el que se enviarán y recibirán mensajes. El WABA ID identifica la cuenta de WhatsApp Business.</span>
            </li>
            <li>
              <strong>Usa el token compartido</strong>
              <span>Si Meta Ads ya está configurado, Ristak usa ese mismo token. Si todavía no existe, pega aquí un System User token con permisos de WhatsApp; después Meta Ads reutilizará el mismo.</span>
              <div className={styles.permissionPills}>
                <span>whatsapp_business_messaging</span>
                <span>whatsapp_business_management</span>
              </div>
            </li>
          </ol>

          <div className={styles.setupCallout}>
            <strong>Token de producción</strong>
            <p>
              El token temporal de API Setup caduca. Para que Render siga funcionando, crea un System User en Business settings, asígnale el WABA y genera un token permanente o de larga duración.
            </p>
            <a className={styles.inlineDocLink} href={SYSTEM_USER_DOCS_URL} target="_blank" rel="noopener noreferrer">
              Ver tokens de sistema
              <ExternalLink size={14} />
            </a>
          </div>

          <div className={styles.formGrid}>
            {config.businessTokenConfigured ? (
              <div className={`${styles.sharedTokenBox} ${styles.formGroupWide}`}>
                <CheckCircle size={18} />
                <div>
                  <strong>Access Token de Meta listo</strong>
                  <span>Es el mismo token compartido para Meta Ads y WhatsApp API. Aquí ya no necesitas pegarlo otra vez.</span>
                </div>
              </div>
            ) : (
              <label className={`${styles.formGroup} ${styles.formGroupWide}`}>
                <span className={styles.formLabel}>Access Token de Meta</span>
                <input
                  className={styles.formInput}
                  value={form.businessToken}
                  onChange={(event) => handleInputChange('businessToken', event.target.value)}
                  placeholder="EAAabcdef..."
                  type="password"
                />
                <p className={styles.fieldHint}>
                  Usa el mismo System User Token que usarías para Meta Ads, pero asegúrate de incluir permisos de WhatsApp.
                </p>
              </label>
            )}

            <label className={styles.formGroup}>
              <span className={styles.formLabel}>Phone Number ID</span>
              <input
                className={styles.formInput}
                value={form.phoneNumberId}
                onChange={(event) => handleInputChange('phoneNumberId', event.target.value)}
                placeholder="ID del número en Cloud API"
              />
            </label>

            <label className={styles.formGroup}>
              <span className={styles.formLabel}>WABA ID</span>
              <input
                className={styles.formInput}
                value={form.wabaId}
                onChange={(event) => handleInputChange('wabaId', event.target.value)}
                placeholder="WhatsApp Business Account ID"
              />
            </label>
          </div>
        </>
      )
    }

    if (activeStep === 2) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 3</span>
            <h3 className={styles.stepTitle}>Configura el webhook</h3>
            <p className={styles.stepText}>
              Ristak genera el verify token automáticamente al llegar aquí. En Meta Developers entra a Webhooks, selecciona WhatsApp Business Account y verifica esta URL con este token.
            </p>
            <a className={styles.inlineDocLink} href={WEBHOOK_DOCS_URL} target="_blank" rel="noopener noreferrer">
              Ver guía oficial de webhooks
              <ExternalLink size={14} />
            </a>
          </div>

          {webhookEnvironmentMismatch && (
            <div className={styles.warningCallout}>
              <strong>Dominio mezclado</strong>
              <p>
                Estás viendo la app en localhost, pero la callback apunta a un dominio público. Para que Meta valide bien, guarda esta configuración desde el mismo Render público que usará la callback.
              </p>
            </div>
          )}

          <ol className={styles.guideDetailList}>
            <li>
              <strong>Selecciona el producto correcto</strong>
              <span>En Webhooks, en Seleccionar producto, elige exactamente WhatsApp Business Account.</span>
            </li>
            <li>
              <strong>Pega URL y token</strong>
              <span>Usa la URL de devolución de llamada y el verify token de abajo. El token no se inventa; Ristak lo crea y lo guarda cifrado.</span>
            </li>
            <li>
              <strong>Suscribe los campos correctos</strong>
              <span>Después de verificar y guardar, baja a Campos del webhook y suscribe primero messages. Ese es el campo crítico para recibir mensajes y trackear estados.</span>
            </li>
            <li>
              <strong>Prueba el tracking base</strong>
              <span>Usa Probar en messages y luego manda un WhatsApp real al número. Ristak guardará el evento crudo y separará mensajes de estados cuando lleguen.</span>
            </li>
          </ol>

          <div className={styles.webhookFieldsPanel}>
            <div className={styles.webhookFieldsHeader}>
              <strong>Campos del webhook a suscribir</strong>
              <span>
                Producto: WhatsApp Business Account. Usa la misma versión que Meta muestre para todos los campos de este objeto y evita suscribirte a campos innecesarios.
              </span>
            </div>

            <div className={styles.webhookFieldGroups}>
              {WEBHOOK_FIELD_GROUPS.map((group) => (
                <div key={group.title} className={styles.webhookFieldGroup}>
                  <strong>{group.title}</strong>
                  <p>{group.description}</p>
                  <div className={styles.webhookFieldPills}>
                    {group.fields.map((field) => (
                      <code key={field}>{field}</code>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.warningCallout}>
            <strong>OJO: no actives el certificado de cliente</strong>
            <p>
              Deja apagado el switch de certificado de cliente. Esta integración inicial valida con callback URL + verify token; si prendes certificado, Meta puede fallar la verificación.
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
            <span className={styles.formLabel}>Verify token generado por Ristak</span>
            <div className={styles.inputActionRow}>
              <input
                className={styles.formInput}
                value={form.webhookVerifyToken}
                readOnly
                placeholder={config.webhookVerifyTokenConfigured ? 'Token ya guardado' : 'Generando token...'}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={handleCopyWebhookToken}
                disabled={!form.webhookVerifyToken || isSaving}
              >
                {isSaving ? <KeyRound size={16} className={styles.spinning} /> : <Copy size={16} />}
                {isSaving ? 'Guardando' : 'Copiar'}
              </Button>
            </div>
          </label>

          <p className={styles.stepHint}>
            Si Meta dice que no pudo validar, casi siempre es porque la URL pública no llega a este backend o porque el token pegado en Meta no es exactamente el mismo.
          </p>
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
              Ristak guardará los datos en tablas exclusivas de WhatsApp y mantendrá tokens/secretos cifrados. Todavía no se mezcla con contactos, atribución ni CRM.
            </p>
          </div>

          <div className={styles.reviewGrid}>
            <div>
              <span>Meta App</span>
              <strong>{hasAppCredentials ? 'Lista' : 'Pendiente'}</strong>
            </div>
            <div>
              <span>Cloud API</span>
              <strong>{hasPhoneApiData ? 'Lista' : 'Pendiente'}</strong>
            </div>
            <div>
              <span>Webhook</span>
              <strong>{hasWebhookToken ? 'Listo' : 'Pendiente'}</strong>
            </div>
            <div>
              <span>Estado</span>
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
          <h3 className={styles.stepTitle}>Valida WhatsApp con Meta</h3>
          <p className={styles.stepText}>
            Ristak usará el token para leer el Phone Number ID, consultar el WABA y suscribir la app a webhooks. Si Meta responde bien, el número queda conectado.
          </p>
        </div>

        <div className={styles.setupCallout}>
          <strong>Qué hace este botón</strong>
          <p>
            No abre otra pantalla de Meta. Hace llamadas directas a Graph API con tus datos: suscribe el WABA a la app, lee la información del número y marca la conexión como activa.
          </p>
        </div>

        <Button type="button" variant="primary" onClick={handleConnect} disabled={!config.configured || isConnecting}>
          <Link2 size={16} className={isConnecting ? styles.spinning : ''} />
          {isConnecting ? 'Validando...' : 'Validar conexión'}
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
                <h2 className={styles.pageTitle}>WhatsApp API</h2>
                <p className={styles.pageSubtitle}>
                  Conecta WhatsApp Cloud API directa con tu propia Meta App, sin mezclar datos con CRM.
                </p>
              </div>
            </div>
            {isConnected && (
              <div className={styles.headerRight}>
                <div className={getStatusClassName(config.connectionStatus)}>
                  <CheckCircle size={16} />
                  <span>{getStatusLabel(config.connectionStatus)}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={[styles.workspace, !isConnected ? styles.workspaceSetupOnly : ''].filter(Boolean).join(' ')}>
          <div className={styles.primaryColumn}>
            <section className={`${styles.section} ${styles.wizardSection}`}>
              <div className={styles.sectionHeader}>
                <div>
                  <h3 className={styles.sectionTitle}>Wizard de conexión</h3>
                  <p className={styles.sectionDescription}>
                    Completa cada paso y valida el número con Meta Cloud API.
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
            </section>

            {isConnected && (
              <section className={styles.section}>
                <div className={styles.sectionHeader}>
                  <div>
                    <h3 className={styles.sectionTitle}>Estructura WhatsApp separada</h3>
                    <p className={styles.sectionDescription}>
                      Almacenamiento dedicado para chats, mensajes, contactos, números y webhooks.
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
            )}
          </div>

          {isConnected && (
            <aside className={styles.statusRail}>
              <div className={styles.railBlock}>
                <div className={styles.railHeader}>
                  <ShieldCheck size={18} />
                  <span>Número</span>
                </div>
                <strong className={styles.railPrimaryValue}>{config.displayPhoneNumber || 'Pendiente'}</strong>
                <span className={styles.railSecondaryValue}>{config.verifiedName || getStatusLabel(config.connectionStatus)}</span>
                <div className={styles.railMeta}>
                  <span>Phone ID</span>
                  <strong>{config.phoneNumberId || '-'}</strong>
                  <span>WABA</span>
                  <strong>{config.wabaId || '-'}</strong>
                </div>
                <button
                  type="button"
                  className={styles.railButton}
                  onClick={handleRefreshStatus}
                  disabled={!config.businessTokenConfigured || isRefreshing}
                >
                  <RefreshCw size={16} className={isRefreshing ? styles.spinning : ''} />
                  {isRefreshing ? 'Actualizando' : 'Actualizar'}
                </button>
              </div>

              <div className={styles.railBlock}>
                <div className={styles.railHeader}>
                  <MessageSquareText size={18} />
                  <span>Plantillas</span>
                </div>
                <span className={styles.railSecondaryValue}>Próximamente</span>
              </div>
            </aside>
          )}
        </div>
      </Card>
    </div>
  )
}
