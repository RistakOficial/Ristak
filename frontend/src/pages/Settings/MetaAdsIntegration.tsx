import React, { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button, Icon, Modal, CustomSelect, PageHeader, SegmentTabs, Switch } from '@/components/common'
import { Badge, type BadgeVariant } from '@/components/common/Badge'
import { Activity, ArrowLeft, ArrowRight, CheckCircle, Copy, ExternalLink, FlaskConical, Link2, MessageCircle, Pencil, Plus, Power, RefreshCw, Save, Send, Settings2, Trash2, XCircle } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig } from '@/hooks'
import {
  campaignsService,
  type ConnectedSocialProfile,
  type MetaTestCustomParameter,
  type MetaTestEventParameters,
  type MetaTestEventResponse
} from '@/services/campaignsService'
import styles from './MetaAdsIntegration.module.css'

interface MetaCredentials {
  adAccountId: string
  accessToken: string
  pixelId: string
  pageId: string
  instagramAccountId: string
}

interface AdAccount {
  id: string
  account_id: string
  name: string
  currency: string
  timezone_name: string
  account_status: number
}

interface Pixel {
  id: string
  name: string
  creation_time: string
  last_fired_time: string
}

interface MetaPage {
  id: string
  name: string
  category: string | null
  pictureUrl: string | null
}

interface FetchCollectionResult {
  success: boolean
  count: number
}

type MetaTestParameterFieldKey =
  | 'value'
  | 'predictedLtv'
  | 'currency'
  | 'contentName'
  | 'contentCategory'
  | 'contentIds'
  | 'contentType'
  | 'numItems'
  | 'orderId'
  | 'status'
  | 'searchString'
  | 'ctwaClid'

type SecretTokenField = 'accessToken'
type MetaMessagingPlatform = 'messenger' | 'instagram'
type MetaConnectedTab = 'cuenta' | 'mensajes' | 'rastreo' | 'pruebas'

interface MetaWebhookInfo {
  webhookUrl: string
  verifyToken: string
  fields: string[]
}

const metaConnectedTabs: Array<{ id: MetaConnectedTab; label: string; icon: React.ReactNode }> = [
  { id: 'cuenta', label: 'Cuenta', icon: <Link2 size={16} /> },
  { id: 'mensajes', label: 'Mensajes', icon: <MessageCircle size={16} /> },
  { id: 'rastreo', label: 'Rastreo', icon: <Activity size={16} /> },
  { id: 'pruebas', label: 'Dataset Test', icon: <FlaskConical size={16} /> }
]

const MASKED_SECRET_PREFIX = '***'
const SECRET_MASK_FILL = '*'.repeat(180)
const metaStepSlugs = ['token', 'ad-account', 'pixel', 'pages'] as const
const parseMetaStep = (pathname: string) => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const metaIndex = segments.indexOf('meta-ads')
  const step = metaIndex >= 0 ? segments[metaIndex + 1] : ''
  const index = metaStepSlugs.indexOf(step as typeof metaStepSlugs[number])
  return index >= 0 ? index : 0
}
const buildMetaAdsSettingsPath = (stepIndex: number) => `/settings/meta-ads/${metaStepSlugs[Math.max(0, Math.min(stepIndex, metaStepSlugs.length - 1))]}`

const isMaskedSecretValue = (value = '') => value.trim().startsWith(MASKED_SECRET_PREFIX)

const getMaskedSecretTail = (value = '') => (
  isMaskedSecretValue(value)
    ? value.trim().slice(MASKED_SECRET_PREFIX.length)
    : value.trim()
)

const tokenSetupGuideSteps = [
  {
    title: 'Entra al portafolio comercial',
    body: 'Abre Configuración del negocio en Meta, entra al portafolio comercial correcto y ve a Apps. Desde ahí crea una aplicación nueva.'
  },
  {
    title: 'Crea la app en Meta Developers',
    body: 'Cuando Meta te mande a Developers, elige la opción de Marketing API. Además, activa los productos de mensajes: Messenger, Instagram y WhatsApp. Llena el formulario básico y deja la app asociada al mismo portafolio comercial.'
  },
  {
    title: 'Crea el usuario del sistema',
    body: 'Regresa a Configuración del negocio, entra a Usuarios del sistema y crea uno llamado Ristak. Déjalo sin rol si Meta muestra esa opción; los accesos reales se dan en activos.'
  },
  {
    title: 'Asigna activos',
    body: 'En Añadir activos agrega la Página que hará publicidad, la cuenta publicitaria, la app recién creada, el Dataset, Instagram si aplica, y concede acceso de administración donde Meta lo pida.'
  },
  {
    title: 'Genera el token',
    body: 'En Generar token elige la app nueva, selecciona expiración Nunca y marca los permisos necesarios. Copia el token completo y pégalo abajo.'
  }
]

const tokenSetupScopes = [
  'ads_management',
  'ads_read',
  'business_management',
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging',
  'pages_read_engagement',
  'pages_manage_engagement',
  'instagram_basic',
  'instagram_manage_messages',
  'instagram_manage_comments'
]

const metaTestEventOptions = [
  { value: 'Lead', label: 'Lead' },
  { value: 'Schedule', label: 'Schedule' },
  { value: 'Purchase', label: 'Purchase' },
  { value: 'FormSubmitted', label: 'FormSubmitted' },
  { value: 'CompleteRegistration', label: 'CompleteRegistration' },
  { value: 'ViewContent', label: 'ViewContent' },
  { value: 'Contact', label: 'Contact' },
  { value: 'AddPaymentInfo', label: 'AddPaymentInfo (Pago)' },
  { value: 'LeadSubmitted', label: 'LeadSubmitted (WhatsApp)' }
]

const defaultMetaTestEventName = 'Lead'
const serverOnlyMetaTestEvents = new Set(['LeadSubmitted'])
const META_AD_UTM_PARAMETERS = [
  'utm_source=fb_ad',
  'utm_medium={{adset.name}}',
  'utm_campaign={{campaign.name}}',
  'utm_content={{ad.name}}',
  'campaign_id={{campaign.id}}',
  'adset_id={{adset.id}}',
  'ad_id={{ad.id}}',
  'placement={{placement}}',
  'site_source_name={{site_source_name}}',
  'rkvi_id={{ad.id}}'
].join('&')

const metaTestParameterFieldLabels: Record<MetaTestParameterFieldKey, string> = {
  value: 'Valor',
  predictedLtv: 'LTV estimado',
  currency: 'Moneda',
  contentName: 'Contenido',
  contentCategory: 'Categoría',
  contentIds: 'IDs de contenido',
  contentType: 'Tipo de contenido',
  numItems: 'Cantidad',
  orderId: 'Orden',
  status: 'Estado',
  searchString: 'Búsqueda',
  ctwaClid: 'ctwa_clid'
}

const metaTestParameterFieldPlaceholders: Record<MetaTestParameterFieldKey, string> = {
  value: '2500',
  predictedLtv: '12000',
  currency: 'MXN',
  contentName: 'Plan premium',
  contentCategory: 'Consultoría',
  contentIds: 'sku-1, sku-2',
  contentType: 'product',
  numItems: '1',
  orderId: 'ORD-123',
  status: 'nuevos',
  searchString: 'buscar servicio',
  ctwaClid: 'AfghPKzHPYknB7A...'
}

const metaTestEventParameterFields: Record<string, MetaTestParameterFieldKey[]> = {
  Lead: ['value', 'predictedLtv', 'currency', 'status'],
  Schedule: ['value', 'predictedLtv', 'currency', 'status'],
  Purchase: ['value', 'currency', 'orderId', 'contentIds', 'contentName', 'contentType', 'numItems'],
  FormSubmitted: ['value', 'predictedLtv', 'currency', 'status'],
  CompleteRegistration: ['value', 'predictedLtv', 'currency', 'status'],
  Contact: ['value', 'predictedLtv', 'currency', 'status'],
  ViewContent: ['value', 'currency', 'contentName', 'contentCategory', 'contentIds', 'contentType'],
  AddPaymentInfo: ['value', 'predictedLtv', 'currency', 'status'],
  LeadSubmitted: ['value', 'predictedLtv', 'currency', 'status', 'ctwaClid']
}

const getMetaTestEventFieldsForEvent = (eventName?: string): MetaTestParameterFieldKey[] => {
  return metaTestEventParameterFields[eventName || defaultMetaTestEventName] || []
}

const isWhatsappBusinessMetaTestEvent = (eventName?: string) => {
  return String(eventName || '').trim() === 'LeadSubmitted'
}

const createDefaultMetaTestCustomParameter = (): MetaTestCustomParameter => ({
  id: `meta-test-custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  key: '',
  value: ''
})

const cleanMetaTestParameterString = (value: unknown) => String(value ?? '').trim()

const normalizeMetaTestCustomParameter = (parameter?: Partial<MetaTestCustomParameter> | null): MetaTestCustomParameter => ({
  ...(cleanMetaTestParameterString(parameter?.id) ? { id: cleanMetaTestParameterString(parameter?.id) } : {}),
  key: cleanMetaTestParameterString(parameter?.key),
  value: cleanMetaTestParameterString(parameter?.value)
})

const normalizeMetaTestEventParameters = (parameters?: MetaTestEventParameters | null): MetaTestEventParameters => {
  const source = parameters && typeof parameters === 'object' ? parameters : {}
  const normalized: MetaTestEventParameters = {}

  ;([
    'value',
    'predictedLtv',
    'currency',
    'contentName',
    'contentCategory',
    'contentIds',
    'contentType',
    'numItems',
    'orderId',
    'status',
    'searchString',
    'ctwaClid'
  ] as MetaTestParameterFieldKey[]).forEach((field) => {
    const value = cleanMetaTestParameterString(source[field])
    if (value) {
      normalized[field] = value
    }
  })

  const custom = Array.isArray(source.custom)
    ? source.custom
      .map(parameter => normalizeMetaTestCustomParameter(parameter))
      .filter(parameter => parameter.key || parameter.value)
      .slice(0, 12)
    : []

  if (custom.length) {
    normalized.custom = custom
  }

  return normalized
}

const pruneMetaTestEventParametersForEvent = (
  parameters: MetaTestEventParameters | null | undefined,
  eventName?: string
) => {
  const normalized = normalizeMetaTestEventParameters(parameters)
  const fields = getMetaTestEventFieldsForEvent(eventName)
  if (!fields.length) {
    return {
      ...normalized.custom ? { custom: normalized.custom } : {}
    }
  }

  const next: MetaTestEventParameters = {}
  fields.forEach((field) => {
    const value = cleanMetaTestParameterString(normalized[field])
    if (value) next[field] = value
  })

  if (normalized.custom?.length) next.custom = normalized.custom
  return next
}

export const MetaAdsIntegration: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const routeStep = parseMetaStep(location.pathname)
  const [isLoading, setIsLoading] = useState(true)
  const [credentials, setCredentials] = useState<MetaCredentials>({
    adAccountId: '',
    accessToken: '',
    pixelId: '',
    pageId: '',
    instagramAccountId: ''
  })
  const [adAccounts, setAdAccounts] = useState<AdAccount[]>([])
  const [pixels, setPixels] = useState<Pixel[]>([])
  // (META-003) Estado y expiración del token de Meta, para que el usuario sepa si su
  // conexión sigue válida o está por caducar (antes no había forma de saberlo en la UI).
  const [metaTokenStatus, setMetaTokenStatus] = useState<{ valid: boolean; message: string; daysUntilExpiry?: number; expiresAt?: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    campaignsService.verifyToken()
      .then((res) => { if (!cancelled) setMetaTokenStatus(res?.configured && res.tokenStatus ? res.tokenStatus : null) })
      .catch(() => { if (!cancelled) setMetaTokenStatus(null) })
    return () => { cancelled = true }
  }, [])
  const [pages, setPages] = useState<MetaPage[]>([])
  const [instagramAccounts, setInstagramAccounts] = useState<ConnectedSocialProfile[]>([])
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false)
  const [isLoadingPixels, setIsLoadingPixels] = useState(false)
  const [isLoadingPages, setIsLoadingPages] = useState(false)
  const [isLoadingInstagramAccounts, setIsLoadingInstagramAccounts] = useState(false)
  const [realAccessToken, setRealAccessToken] = useState('')
  const [isSavingToken, setIsSavingToken] = useState(false)
  const [isRevealingAccessToken, setIsRevealingAccessToken] = useState(false)
  const [isSavingPageId, setIsSavingPageId] = useState(false)
  const [isSavingInstagramAccountId, setIsSavingInstagramAccountId] = useState(false)
  const [savedPageId, setSavedPageId] = useState('')
  const [savedInstagramAccountId, setSavedInstagramAccountId] = useState('')
  const [isSyncingSnippet, setIsSyncingSnippet] = useState(false)
  const [isSyncingMetaAds, setIsSyncingMetaAds] = useState(false)
  const [isEditingMetaConfig, setIsEditingMetaConfig] = useState(false)
  const [isDisconnectModalOpen, setIsDisconnectModalOpen] = useState(false)
  const [isDisconnectingMeta, setIsDisconnectingMeta] = useState(false)
  const [metaTestDraftCode, setMetaTestDraftCode] = useState('')
  const [metaTestEventName, setMetaTestEventName] = useState(defaultMetaTestEventName)
  const [metaTestEventParameters, setMetaTestEventParameters] = useState<MetaTestEventParameters>({})
  const [isMetaTestParametersOpen, setIsMetaTestParametersOpen] = useState(false)
  const [isSendingMetaTestEvent, setIsSendingMetaTestEvent] = useState(false)
  const [isOpeningMetaPixelTest, setIsOpeningMetaPixelTest] = useState(false)
  const [metaTestResult, setMetaTestResult] = useState<MetaTestEventResponse | null>(null)
  const [activeStep, setActiveStep] = useState(routeStep)
  const [activeMetaTab, setActiveMetaTab] = useState<MetaConnectedTab>('cuenta')
  const [metaWebhookInfo, setMetaWebhookInfo] = useState<MetaWebhookInfo | null>(null)
  const accessTokenInputRef = useRef<HTMLInputElement>(null)

  const { showToast } = useNotification()
  const [includeMetaPixel, setIncludeMetaPixel, savingPixelPref] = useAppConfig('include_meta_pixel', true)
  const [messengerMessagingEnabled, setMessengerMessagingEnabled, savingMessengerMessaging] = useAppConfig('meta_messenger_messaging_enabled', false)
  const [instagramMessagingEnabled, setInstagramMessagingEnabled, savingInstagramMessaging] = useAppConfig('meta_instagram_messaging_enabled', false)
  const [facebookCommentsEnabled, setFacebookCommentsEnabled, savingFacebookComments] = useAppConfig('meta_facebook_comments_enabled', false)
  const [instagramCommentsEnabled, setInstagramCommentsEnabled, savingInstagramComments] = useAppConfig('meta_instagram_comments_enabled', false)
  const [metaTestEventCode, setMetaTestEventCode, savingMetaTestEventCode] = useAppConfig('meta_test_event_code', '')
  const [metaTestEventCodeSetAt, setMetaTestEventCodeSetAt] = useAppConfig('meta_test_event_code_set_at', '')

  const handleCopyMetaAdUtmParameters = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable')
      }

      await navigator.clipboard.writeText(META_AD_UTM_PARAMETERS)
      showToast('success', 'UTM copiado', 'Pégalo en Parámetros de URL del anuncio en Meta.')
    } catch {
      showToast('error', 'No se pudo copiar', 'Selecciona el texto y cópialo manualmente.')
    }
  }

  const handleCopyValue = async (value: string, label: string) => {
    try {
      if (!value || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable')
      }
      await navigator.clipboard.writeText(value)
      showToast('success', `${label} copiado`, 'Pégalo en Meta Developers.')
    } catch {
      showToast('error', 'No se pudo copiar', 'Selecciona el texto y cópialo manualmente.')
    }
  }

  // El código de Test Events se auto-desactiva 30 min después de ponerse, para que
  // al lanzar publicidad no queden conversiones reales atrapadas en modo prueba.
  const META_TEST_CODE_TTL_MS = 30 * 60 * 1000
  const metaTestCodeSetAtMs = Number(metaTestEventCodeSetAt) || 0
  const metaTestCodeRemainingMs = metaTestCodeSetAtMs
    ? Math.max(0, META_TEST_CODE_TTL_MS - (Date.now() - metaTestCodeSetAtMs))
    : 0
  const metaTestCodeRemainingMin = Math.ceil(metaTestCodeRemainingMs / 60000)
  const metaTestCodeActive = Boolean(metaTestEventCode) && (!metaTestCodeSetAtMs || metaTestCodeRemainingMs > 0)
  const metaTestCodeExpiresAtLabel = metaTestCodeSetAtMs
    ? new Date(metaTestCodeSetAtMs + META_TEST_CODE_TTL_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  useEffect(() => {
    loadCredentials()
  }, [])

  useEffect(() => {
    setActiveStep(current => current === routeStep ? current : routeStep)
  }, [routeStep])

  // El código de prueba vive inline (sin modal): siembra el borrador con el
  // código guardado en la carga inicial y cada vez que cambie el guardado.
  useEffect(() => {
    setMetaTestDraftCode(metaTestEventCode || '')
  }, [metaTestEventCode])

  // Datos del webhook de Meta para el mini-tutorial de Mensajes (URL a pegar en
  // Meta Developers, token de verificación y campos a suscribir).
  useEffect(() => {
    let cancelled = false
    const loadWebhookInfo = async () => {
      try {
        const response = await fetch('/api/meta/webhook-info')
        const data = await response.json()
        if (!cancelled && data?.success && data.data) {
          setMetaWebhookInfo({
            webhookUrl: data.data.webhookUrl || '',
            verifyToken: data.data.verifyToken || '',
            fields: Array.isArray(data.data.fields) ? data.data.fields : []
          })
        }
      } catch {
        // El tutorial simplemente no muestra los valores si el endpoint falla.
      }
    }
    void loadWebhookInfo()
    return () => { cancelled = true }
  }, [])

  const goToMetaStep = (stepIndex: number, options?: { replace?: boolean }) => {
    const nextStep = Math.max(0, Math.min(stepIndex, metaStepSlugs.length - 1))
    setActiveStep(nextStep)
    navigate(buildMetaAdsSettingsPath(nextStep), { replace: options?.replace })
  }

  const loadCredentials = async () => {
    setIsLoading(true)
    try {
      const response = await fetch('/api/meta/custom-values')
      const data = await response.json()

      if (data.success && data.data) {
        setCredentials(data.data)
        setSavedPageId(data.data.pageId || '')
        setSavedInstagramAccountId(data.data.instagramAccountId || '')

        if (data.data.accessToken) {
          let tokenToUse = data.data.accessToken

          if (isMaskedSecretValue(data.data.accessToken)) {
            try {
              const revealResponse = await fetch('/api/meta/config/reveal/access_token')
              const revealData = await revealResponse.json()

              if (revealData.success && revealData.accessToken) {
                tokenToUse = revealData.accessToken
              }
            } catch {
              setIsLoading(false)
              return
            }
          }

          setRealAccessToken(tokenToUse)
          await fetchAdAccounts(tokenToUse, data.data.adAccountId, { silent: true })
          await fetchPages(tokenToUse, data.data.pageId, { silent: true })
          await fetchInstagramAccounts(tokenToUse, data.data.instagramAccountId, { silent: true })

          if (data.data.adAccountId) {
            const accountIdWithPrefix = data.data.adAccountId.startsWith('act_')
              ? data.data.adAccountId
              : `act_${data.data.adAccountId}`
            await fetchPixels(accountIdWithPrefix, tokenToUse, data.data.pixelId, { silent: true })
          }
        }
      }
    } catch {
    } finally {
      setIsLoading(false)
    }
  }

  const fetchAdAccounts = async (
    token: string,
    savedAdAccountId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
    if (!token) {
      if (!options.silent) {
        showToast('error', 'Token requerido', 'Primero ingresa tu Access Token')
      }
      return { success: false, count: 0 }
    }

    setIsLoadingAccounts(true)
    try {
      const result = await campaignsService.fetchAdAccounts(token)
      if (result.success && result.adAccounts.length > 0) {
        setAdAccounts(result.adAccounts)

        if (savedAdAccountId) {
          const normalizedSavedId = savedAdAccountId.replace(/^act_/, '')
          const matchingAccount = result.adAccounts.find(acc =>
            acc.id.replace(/^act_/, '') === normalizedSavedId
          )

          if (matchingAccount) {
            setCredentials(prev => ({
              ...prev,
              adAccountId: matchingAccount.id.replace(/^act_/, '')
            }))
          }
        }

        if (!options.silent) {
          showToast('success', 'Cuentas cargadas', `Se encontraron ${result.adAccounts.length} cuentas de anuncios`)
        }

        return { success: true, count: result.adAccounts.length }
      }

      if (result.success) {
        if (!options.silent) {
          showToast('warning', 'Sin cuentas', 'No se encontraron cuentas de anuncios')
        }
        setAdAccounts([])
        return { success: true, count: 0 }
      } else {
        if (!options.silent) {
          showToast('error', 'Error', 'No se pudieron cargar las cuentas')
        }
        setAdAccounts([])
        return { success: false, count: 0 }
      }
    } catch {
      if (!options.silent) {
        showToast('error', 'Error', 'No se pudieron cargar las cuentas')
      }
      setAdAccounts([])
      return { success: false, count: 0 }
    } finally {
      setIsLoadingAccounts(false)
    }
  }

  const fetchPixels = async (
    adAccountId: string,
    token: string,
    savedPixelId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
    if (!adAccountId || !token) {
      if (!options.silent) {
        showToast('error', 'Datos requeridos', 'Primero selecciona una cuenta de anuncios')
      }
      return { success: false, count: 0 }
    }

    setIsLoadingPixels(true)
    try {
      const result = await campaignsService.fetchPixels(adAccountId, token)

      if (result.success && result.pixels.length > 0) {
        setPixels(result.pixels)

        if (savedPixelId) {
          const matchingPixel = result.pixels.find(p => p.id === savedPixelId)
          if (matchingPixel) {
            setCredentials(prev => ({
              ...prev,
              pixelId: matchingPixel.id
            }))
          }
        }

        if (!options.silent) {
          showToast('success', 'Datasets cargados', `Se encontraron ${result.pixels.length} datasets`)
        }

        return { success: true, count: result.pixels.length }
      }

      if (result.success) {
        if (!options.silent) {
          showToast('info', 'Sin datasets', 'No se encontraron datasets para esta cuenta')
        }
        setPixels([])
        return { success: true, count: 0 }
      } else {
        if (!options.silent) {
          showToast('error', 'Error', 'No se pudieron cargar los datasets')
        }
        setPixels([])
        return { success: false, count: 0 }
      }
    } catch {
      if (!options.silent) {
        showToast('error', 'Error', 'No se pudieron cargar los datasets')
      }
      setPixels([])
      return { success: false, count: 0 }
    } finally {
      setIsLoadingPixels(false)
    }
  }

  const fetchPages = async (
    token: string,
    savedPageId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
    if (!token) {
      if (!options.silent) {
        showToast('error', 'Token requerido', 'Primero ingresa tu Access Token')
      }
      return { success: false, count: 0 }
    }

    setIsLoadingPages(true)
    try {
      const result = await campaignsService.fetchPages(token)

      if (result.success && result.pages.length > 0) {
        setPages(result.pages)

        if (savedPageId) {
          const matchingPage = result.pages.find(page => page.id === savedPageId)
          if (matchingPage) {
            setCredentials(prev => ({
              ...prev,
              pageId: matchingPage.id
            }))
          }
        }

        if (!options.silent) {
          showToast('success', 'Páginas cargadas', `Se encontraron ${result.pages.length} páginas`)
        }

        return { success: true, count: result.pages.length }
      }

      setPages([])
      if (!options.silent) {
        showToast('warning', 'Sin páginas', 'Revisa que el token tenga pages_show_list y la Página asignada al usuario del sistema')
      }
      return { success: result.success, count: 0 }
    } catch {
      setPages([])
      if (!options.silent) {
        showToast('error', 'Error', 'No se pudieron cargar las páginas')
      }
      return { success: false, count: 0 }
    } finally {
      setIsLoadingPages(false)
    }
  }

  const fetchInstagramAccounts = async (
    token: string,
    savedInstagramAccountId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
    if (!token) {
      if (!options.silent) {
        showToast('error', 'Token requerido', 'Primero ingresa tu Access Token')
      }
      return { success: false, count: 0 }
    }

    setIsLoadingInstagramAccounts(true)
    try {
      const result = await campaignsService.getConnectedSocialProfiles({
        accessToken: token,
        pageId: credentials.pageId || savedPageId,
        instagramAccountId: savedInstagramAccountId
      })
      const accounts = result.profiles.filter(profile => profile.platform === 'instagram')

      if (result.success && accounts.length > 0) {
        setInstagramAccounts(accounts)

        if (savedInstagramAccountId) {
          const matchingAccount = accounts.find(account => account.sourceId === savedInstagramAccountId)
          if (matchingAccount) {
            setCredentials(prev => ({
              ...prev,
              instagramAccountId: matchingAccount.sourceId
            }))
          }
        }

        if (!options.silent) {
          showToast('success', 'Instagram cargado', `Se encontraron ${accounts.length} cuentas de Instagram`)
        }

        return { success: true, count: accounts.length }
      }

      setInstagramAccounts([])
      if (!options.silent) {
        showToast('info', 'Sin Instagram', 'No encontramos cuentas de Instagram conectadas a tus páginas de Meta')
      }
      return { success: result.success, count: 0 }
    } catch {
      setInstagramAccounts([])
      if (!options.silent) {
        showToast('error', 'Error', 'No se pudieron cargar las cuentas de Instagram')
      }
      return { success: false, count: 0 }
    } finally {
      setIsLoadingInstagramAccounts(false)
    }
  }

  const handleSelectAdAccount = (account: AdAccount) => {
    handleSelectAndSaveAccount(account)
  }

  const handleSelectPixel = (pixel: Pixel) => {
    handleSelectAndSavePixel(pixel)
  }

  const handleSelectInstagramAccount = (account: ConnectedSocialProfile) => {
    void saveInstagramAccountId(account.sourceId)
  }

  const handleRemoveCredential = (field: keyof MetaCredentials) => {
    if (field === 'accessToken') {
      setCredentials({
        adAccountId: '',
        accessToken: '',
        pixelId: '',
        pageId: '',
        instagramAccountId: ''
      })
      setRealAccessToken('')
      setAdAccounts([])
      setPixels([])
      setPages([])
      setInstagramAccounts([])
      setSavedPageId('')
      setSavedInstagramAccountId('')
      goToMetaStep(0, { replace: true })
    } else if (field === 'adAccountId') {
      setCredentials(prev => ({
        ...prev,
        adAccountId: '',
        pixelId: ''
      }))
      setPixels([])
      goToMetaStep(1, { replace: true })
    } else if (field === 'pixelId') {
      setCredentials(prev => ({
        ...prev,
        pixelId: ''
      }))
      goToMetaStep(2, { replace: true })
    } else if (field === 'pageId') {
      setCredentials(prev => ({ ...prev, pageId: '' }))
      setSavedPageId('')
      void setMessengerMessagingEnabled(false)
      void setInstagramMessagingEnabled(false)
    } else if (field === 'instagramAccountId') {
      setCredentials(prev => ({ ...prev, instagramAccountId: '' }))
      setSavedInstagramAccountId('')
      void setInstagramMessagingEnabled(false)
    } else {
      setCredentials(prev => ({ ...prev, [field]: '' }))
    }
  }

  const handleInputChange = (field: keyof MetaCredentials, value: string) => {
    setCredentials(prev => ({ ...prev, [field]: value }))
  }

  const focusSecretInput = () => {
    const focusAndSelect = () => {
      const input = accessTokenInputRef.current

      input?.focus()
      input?.select()
    }

    window.setTimeout(focusAndSelect, 0)
    window.setTimeout(focusAndSelect, 80)
  }

  const handleEditStoredSecret = async (field: SecretTokenField) => {
    let revealedToken = realAccessToken

    if (!revealedToken) {
      setIsRevealingAccessToken(true)

      try {
        const response = await fetch('/api/meta/config/reveal/access_token')
        const data = await response.json()

        revealedToken = data.accessToken

        if (!data.success || !revealedToken) {
          throw new Error(data.error || 'Token no disponible')
        }
      } catch {
        showToast(
          'error',
          'No se pudo revelar',
          'No se pudo cargar el Access Token original'
        )
        return
      } finally {
        setIsRevealingAccessToken(false)
      }
    }

    setRealAccessToken(revealedToken)

    setCredentials(prev => ({ ...prev, [field]: revealedToken }))
    focusSecretInput()
  }

  const handleSecretChipKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    field: SecretTokenField
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') return

    event.preventDefault()
    handleEditStoredSecret(field)
  }

  const renderMaskedSecretValue = (value: string, isRevealing: boolean) => (
    <span className={styles.secretTokenText}>
      {isRevealing ? (
        <span className={styles.secretRevealStatus} role="status" aria-live="polite" aria-label="Cargando token">
          <RefreshCw size={13} className={styles.spinning} aria-hidden="true" />
        </span>
      ) : (
        <>
          <span className={styles.secretMaskFill} aria-hidden="true">
            {SECRET_MASK_FILL}
          </span>
          <span className={styles.secretTokenTail}>{getMaskedSecretTail(value)}</span>
        </>
      )}
    </span>
  )

  const resetLocalMetaState = () => {
    setCredentials({
      adAccountId: '',
      accessToken: '',
      pixelId: '',
      pageId: '',
      instagramAccountId: ''
    })
    setAdAccounts([])
    setPixels([])
    setPages([])
    setInstagramAccounts([])
    setRealAccessToken('')
    setSavedPageId('')
    setSavedInstagramAccountId('')
    goToMetaStep(0, { replace: true })
    setIsEditingMetaConfig(false)
  }

  const handleContinueWithToken = async () => {
    if (!credentials.accessToken || credentials.accessToken.length < 50) {
      showToast('error', 'Token inválido', 'El Access Token parece estar incompleto')
      return
    }

    setIsSavingToken(true)

    try {
      showToast('info', 'Validando token...', 'Revisando tus cuentas de anuncios')
      setRealAccessToken(credentials.accessToken)
      const accountsResult = await fetchAdAccounts(credentials.accessToken)

      if (!accountsResult.success) {
        setRealAccessToken('')
        return
      }

      await fetchPages(credentials.accessToken, credentials.pageId, { silent: true })
      await fetchInstagramAccounts(credentials.accessToken, credentials.instagramAccountId, { silent: true })

      if (accountsResult.count > 0) {
        showToast('success', 'Token válido', 'Selecciona tu cuenta de anuncios')
      }

      goToMetaStep(1)
    } catch {
      showToast('error', 'Error', 'No se pudo validar el token o cargar las cuentas')
      setRealAccessToken('')
    } finally {
      setIsSavingToken(false)
    }
  }

  const handleSelectAndSaveAccount = async (account: AdAccount) => {
    const accountIdWithoutPrefix = account.id.replace(/^act_/, '')
    setCredentials(prev => ({ ...prev, adAccountId: accountIdWithoutPrefix }))

    try {
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: accountIdWithoutPrefix,
          accessToken: realAccessToken || credentials.accessToken,
          pixelId: credentials.pixelId,
          pageId: credentials.pageId,
          instagramAccountId: credentials.instagramAccountId
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Cuenta guardada', `${account.name} configurada`)
        // El backend auto-asocia el pixel de la cuenta cuando no se eligió uno;
        // reflejarlo de inmediato para que el Dataset visible y el snippet ya lo tengan.
        const autoPixelId = String(data.data?.pixelId || '').trim()
        if (autoPixelId) {
          setCredentials(prev => ({ ...prev, pixelId: autoPixelId }))
        }
        goToMetaStep(2)
        const token = realAccessToken || credentials.accessToken
        if (token) {
          fetchPixels(account.id, token, autoPixelId || credentials.pixelId, { silent: true })
          fetchPages(token, credentials.pageId, { silent: true })
          fetchInstagramAccounts(token, credentials.instagramAccountId, { silent: true })
        }
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar la cuenta')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar la cuenta')
    }
  }

  const handleSelectAndSavePixel = async (pixel: Pixel) => {
    setCredentials(prev => ({ ...prev, pixelId: pixel.id }))

    try {
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: credentials.adAccountId,
          accessToken: realAccessToken || credentials.accessToken,
          pixelId: pixel.id,
          pageId: credentials.pageId,
          instagramAccountId: credentials.instagramAccountId
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Dataset guardado', `${pixel.name} configurado`)
        await loadCredentials()
        goToMetaStep(3)
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el dataset')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar el dataset')
    }
  }

  const savePageId = async (pageId: string) => {
    if (!pageId) {
      showToast('error', 'Facebook Page requerida', 'Selecciona una Página primero')
      return
    }

    if (!credentials.adAccountId) {
      showToast('warning', 'Configura primero', 'Primero debes conectar tu cuenta de anuncios')
      return
    }

    setIsSavingPageId(true)

    try {
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: credentials.adAccountId,
          accessToken: realAccessToken || credentials.accessToken,
          pixelId: credentials.pixelId || '',
          pageId,
          instagramAccountId: credentials.instagramAccountId || ''
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Meta conectado', 'La configuración quedó guardada')
        setSavedPageId(pageId)
        setCredentials(prev => ({ ...prev, pageId }))
        await loadCredentials()
        setIsEditingMetaConfig(false)
        void syncMetaAds({ automatic: true })
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el Page ID')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar el Page ID')
    } finally {
      setIsSavingPageId(false)
    }
  }

  const handleSelectAndSavePage = async (page: MetaPage) => {
    setCredentials(prev => ({ ...prev, pageId: page.id }))
    await savePageId(page.id)
  }

  const saveInstagramAccountId = async (instagramAccountId: string) => {
    if (!instagramAccountId) {
      showToast('error', 'Instagram requerido', 'Selecciona una cuenta de Instagram primero')
      return
    }

    if (!credentials.adAccountId) {
      showToast('warning', 'Configura primero', 'Primero debes conectar tu cuenta de anuncios')
      return
    }

    setIsSavingInstagramAccountId(true)

    try {
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: credentials.adAccountId,
          accessToken: realAccessToken || credentials.accessToken,
          pixelId: credentials.pixelId || '',
          pageId: credentials.pageId || savedPageId || '',
          instagramAccountId
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Instagram conectado', 'La cuenta quedó guardada para recibir DMs')
        setSavedInstagramAccountId(instagramAccountId)
        setCredentials(prev => ({ ...prev, instagramAccountId }))
        await loadCredentials()
        void syncMetaAds({ automatic: true })
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar Instagram')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar Instagram')
    } finally {
      setIsSavingInstagramAccountId(false)
    }
  }

  const handleFinishWizard = () => {
    if (!hasAdAccount) {
      showToast('warning', 'Falta cuenta de anuncios', 'Selecciona y guarda una cuenta de anuncios para terminar')
      return
    }

    setIsEditingMetaConfig(false)
    goToMetaStep(0, { replace: true })
  }

  const handleEditMetaConfig = () => {
    setIsEditingMetaConfig(true)
    goToMetaStep(0, { replace: true })
  }

  const handleDisconnectMetaConfig = async () => {
    setIsDisconnectingMeta(true)

    try {
      const response = await fetch('/api/meta/config', {
        method: 'DELETE'
      })
      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No se pudo eliminar la configuración')
      }

      await Promise.all([
        setMessengerMessagingEnabled(false),
        setInstagramMessagingEnabled(false)
      ])

      resetLocalMetaState()
      setIsDisconnectModalOpen(false)
      showToast('success', 'Meta desconectado', 'La configuración actual fue eliminada')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo desconectar Meta')
    } finally {
      setIsDisconnectingMeta(false)
    }
  }

  const handleToggleMetaPixel = async (newValue: boolean) => {
    try {
      await setIncludeMetaPixel(newValue)

      setIsSyncingSnippet(true)
      const response = await fetch('/api/tracking/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      const data = await response.json()

      if (data.success) {
        showToast(
          'success',
          'Snippet actualizado',
          newValue
            ? 'El snippet ahora incluye el Dataset'
            : 'El snippet ahora NO incluye el Dataset'
        )
      } else {
        showToast('error', 'Error', data.error || 'No se pudo sincronizar el snippet')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo actualizar el snippet')
    } finally {
      setIsSyncingSnippet(false)
    }
  }

  const normalizeMetaTestCode = (value = '') => value.trim().replace(/\s+/g, '')
  const normalizeMetaTestEventName = (value = '') => {
    const normalizedValue = String(value || '').trim()
    return metaTestEventOptions.some(option => option.value === normalizedValue)
      ? normalizedValue
      : defaultMetaTestEventName
  }
  const hasMetaTestEventParameters = (parameters?: MetaTestEventParameters | null) => {
    const normalized = pruneMetaTestEventParametersForEvent(parameters, normalizeMetaTestEventName(metaTestEventName))
    return Object.keys(normalized).some(key => key !== 'custom' && Boolean((normalized as Record<string, string>)[key]))
      || Boolean(normalized.custom?.length)
  }

  const addMetaTestCustomParameter = () => {
    setMetaTestEventParameters(current => {
      const normalized = normalizeMetaTestEventParameters(current)
      const nextCustom = [...(normalized.custom || [])]

      if (nextCustom.length >= 12) return normalized
      nextCustom.push(createDefaultMetaTestCustomParameter())
      return { ...normalized, custom: nextCustom }
    })
  }

  const patchMetaTestCustomParameter = (
    index: number,
    patch: Partial<MetaTestCustomParameter>
  ) => {
    setMetaTestEventParameters(current => {
      const normalized = normalizeMetaTestEventParameters(current)
      const rows = [...(normalized.custom || [])]

      if (index === rows.length) {
        rows.push(normalizeMetaTestCustomParameter(patch))
      } else if (rows[index]) {
        rows[index] = { ...rows[index], ...patch }
      }

      return {
        ...normalized,
        custom: rows
          .filter(row => row.key || row.value)
          .slice(0, 12)
      }
    })
  }

  const removeMetaTestCustomParameter = (index: number) => {
    setMetaTestEventParameters(current => {
      const normalized = normalizeMetaTestEventParameters(current)
      const rows = [...(normalized.custom || [])]
      if (index < 0 || index >= rows.length) return normalized
      rows.splice(index, 1)

      const next = {
        ...normalized,
        ...(rows.length ? { custom: rows } : {})
      } as MetaTestEventParameters
      return next
    })
  }

  const setMetaTestEventNameAndResetParameters = (value: string) => {
    const normalizedEventName = normalizeMetaTestEventName(value)
    setMetaTestEventName(normalizedEventName)

    setMetaTestEventParameters(current => pruneMetaTestEventParametersForEvent(current, normalizedEventName))
  }

  const setMetaTestEventParameterField = (field: MetaTestParameterFieldKey, value: string) => {
    setMetaTestEventParameters(current => ({
      ...normalizeMetaTestEventParameters(current),
      [field]: String(value ?? '').trim()
    }))
  }


  const handleSaveMetaTestEventCode = async () => {
    const nextCode = normalizeMetaTestCode(metaTestDraftCode)

    if (!nextCode) {
      showToast('warning', 'Código requerido', 'Pega el código TEST de Events Manager')
      return false
    }

    try {
      await setMetaTestEventCode(nextCode)
      // Reflejar el inicio del temporizador de 30 min de inmediato (el backend
      // también lo estampa al guardar).
      void setMetaTestEventCodeSetAt(String(Date.now()))
      setMetaTestDraftCode(nextCode)
      showToast('success', 'Código guardado', 'Los eventos CAPI usarán este código de prueba')
      return true
    } catch {
      showToast('error', 'Error', 'No se pudo guardar el código de prueba')
      return false
    }
  }

  const handleClearMetaTestEventCode = async () => {
    try {
      await setMetaTestEventCode('')
      void setMetaTestEventCodeSetAt('')
      setMetaTestDraftCode('')
      setMetaTestResult(null)
      showToast('success', 'Código limpiado', 'Los eventos CAPI vuelven a tráfico real')
    } catch {
      showToast('error', 'Error', 'No se pudo limpiar el código de prueba')
    }
  }

  const handleSendMetaTestEvent = async () => {
    if (!hasPixel) {
      showToast('warning', 'Dataset requerido', 'Configura un Dataset antes de enviar una prueba')
      return
    }

    const testEventCode = normalizeMetaTestCode(metaTestDraftCode)
    const eventName = normalizeMetaTestEventName(metaTestEventName)
    const eventParameters = pruneMetaTestEventParametersForEvent(metaTestEventParameters, eventName)

    if (!testEventCode) {
      showToast('warning', 'Código requerido', 'Pega el código TEST de Events Manager')
      return
    }

    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(eventName)) {
      showToast('warning', 'Evento inválido', 'Usa letras, números y guion bajo; por ejemplo LeadSubmitted')
      return
    }

    if (isWhatsappBusinessMetaTestEvent(eventName)) {
      if (!hasPageId) {
        showToast('warning', 'Facebook Page requerida', 'Selecciona una Facebook Page antes de probar LeadSubmitted de WhatsApp')
        return
      }

      if (!cleanMetaTestParameterString(eventParameters.ctwaClid)) {
        setIsMetaTestParametersOpen(true)
        showToast('warning', 'ctwa_clid requerido', 'Pega un ctwa_clid real en los parámetros del evento para probar WhatsApp')
        return
      }
    }

    setIsSendingMetaTestEvent(true)
    setMetaTestResult(null)

    try {
      if (testEventCode !== normalizeMetaTestCode(metaTestEventCode)) {
        await setMetaTestEventCode(testEventCode)
      }

      const result = await campaignsService.sendMetaTestEvent({
        testEventCode,
        eventName,
        eventParameters
      })

      setMetaTestDraftCode(testEventCode)
      setMetaTestResult(result)
      showToast(
        'success',
        'Prueba enviada',
        result.eventId ? `Busca ${result.eventId} en Test Events` : 'Meta recibió el evento de prueba'
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo enviar la prueba'
      setMetaTestResult({ success: false, error: message })
      showToast('error', 'Error al probar', message)
    } finally {
      setIsSendingMetaTestEvent(false)
    }
  }

  const handleOpenMetaPixelTest = async () => {
    if (!hasPixel) {
      showToast('warning', 'Dataset requerido', 'Configura un Dataset antes de probarlo')
      return
    }

    const testEventCode = normalizeMetaTestCode(metaTestDraftCode)
    const eventName = normalizeMetaTestEventName(metaTestEventName)
    const eventParameters = pruneMetaTestEventParametersForEvent(metaTestEventParameters, eventName)

    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(eventName)) {
      showToast('warning', 'Evento inválido', 'Usa letras, números y guion bajo; por ejemplo LeadSubmitted')
      return
    }

    // Abrimos la pestaña de forma síncrona en el click para evitar el bloqueo de
    // pop-ups; luego la redirigimos al enlace firmado que devuelve el backend.
    const testWindow = window.open('', '_blank')
    setIsOpeningMetaPixelTest(true)

    try {
      if (testEventCode && testEventCode !== normalizeMetaTestCode(metaTestEventCode)) {
        await setMetaTestEventCode(testEventCode)
      }

      const result = await campaignsService.createMetaPixelTestLink({
        testEventCode,
        eventName,
        eventParameters
      })

      if (!result?.url) {
        throw new Error('No se pudo generar el enlace de prueba')
      }

      if (testWindow) {
        testWindow.location.href = result.url
      } else {
        window.open(result.url, '_blank')
      }
    } catch (error) {
      if (testWindow) testWindow.close()
      const message = error instanceof Error ? error.message : 'No se pudo abrir la prueba del dataset'
      showToast('error', 'Error al abrir la prueba', message)
    } finally {
      setIsOpeningMetaPixelTest(false)
    }
  }

  const handleToggleMetaComments = async (platform: 'facebook' | 'instagram', newValue: boolean) => {
    const label = platform === 'instagram' ? 'Comentarios de Instagram' : 'Comentarios de Facebook'
    try {
      if (platform === 'instagram') {
        await setInstagramCommentsEnabled(newValue)
      } else {
        await setFacebookCommentsEnabled(newValue)
      }
      showToast(
        'success',
        `${label} ${newValue ? 'activados' : 'apagados'}`,
        newValue
          ? 'Ristak guardará los comentarios nuevos en la bandeja de chats.'
          : 'Ristak dejará de guardar comentarios nuevos.'
      )
    } catch {
      showToast('error', 'Error', 'No se pudo actualizar la preferencia de comentarios')
    }
  }

  const handleToggleMetaMessaging = async (platform: MetaMessagingPlatform, newValue: boolean) => {
    const isInstagram = platform === 'instagram'
    const platformLabel = isInstagram ? 'Instagram DM' : 'Messenger'

    if (newValue && !hasPageId) {
      showToast(
        'warning',
        'Facebook Page requerida',
        'Primero selecciona una Facebook Page para recibir y mandar mensajes de Meta'
      )
      return
    }

    if (newValue && isInstagram && !hasInstagramAccount) {
      showToast(
        'warning',
        'Instagram requerido',
        'Primero selecciona la cuenta de Instagram al final del wizard'
      )
      return
    }

    try {
      if (isInstagram) {
        await setInstagramMessagingEnabled(newValue)
      } else {
        await setMessengerMessagingEnabled(newValue)
      }

      if (!newValue) {
        showToast('success', `${platformLabel} actualizado`, `${platformLabel} quedó apagado`)
        return
      }

      // Prender la bandera no basta: hay que suscribir la Página en Meta para que
      // Meta entregue los mensajes entrantes al webhook. Lo hacemos aquí y damos
      // feedback real de si Meta aceptó la suscripción.
      let subscribed = false
      let subscribeError = ''
      try {
        const response = await fetch('/api/meta/social/messaging/subscribe', { method: 'POST' })
        const data = await response.json().catch(() => ({})) as { subscribed?: boolean; error?: string }
        subscribed = data.subscribed === true
        subscribeError = data.error || ''
      } catch {
        subscribeError = 'No se pudo contactar al servidor'
      }

      if (subscribed) {
        showToast(
          'success',
          `${platformLabel} activado`,
          `Listo: la Página quedó suscrita en Meta y los mensajes entrantes llegarán al chat.`
        )
      } else {
        showToast(
          'warning',
          `${platformLabel} activado, falta un paso`,
          subscribeError
            ? `Ristak quedó listo, pero Meta no aceptó la suscripción de la Página: ${subscribeError}`
            : `Ristak quedó listo, pero no se pudo suscribir la Página en Meta. Revisa el webhook de tu app de Meta.`
        )
      }
    } catch {
      showToast('error', 'Error', `No se pudo actualizar ${platformLabel}`)
    }
  }

  const syncMetaAds = async (options: { automatic?: boolean } = {}) => {
    if (isSyncingMetaAds) return

    setIsSyncingMetaAds(true)
    showToast(
      'info',
      options.automatic ? 'Sincronizando Meta' : 'Sincronizando...',
      options.automatic
        ? 'Ya quedó conectado; estamos trayendo los datos de Meta automáticamente'
        : 'Iniciando sincronización de anuncios de Meta (últimos 35 meses)'
    )

    try {
      const result = await campaignsService.syncMetaAds()

      if (result.success) {
        showToast(
          'success',
          options.automatic ? 'Sincronización automática iniciada' : 'Sincronización iniciada',
          result.message || 'La sincronización de anuncios de Meta fue iniciada en segundo plano'
        )
      } else {
        showToast(
          'error',
          options.automatic ? 'Meta conectado, pero falta sincronizar' : 'Error al sincronizar',
          result.error || 'No se pudo completar la sincronización'
        )
      }
    } catch {
      showToast('error', 'Error', 'No se pudo conectar con el servidor')
    } finally {
      setIsSyncingMetaAds(false)
    }
  }

  const handleSyncMetaAds = () => {
    void syncMetaAds()
  }

  const hasAccessToken = Boolean(realAccessToken || isMaskedSecretValue(credentials.accessToken))
  const hasAdAccount = Boolean(credentials.adAccountId)
  const hasPixel = Boolean(credentials.pixelId)
  const hasPageId = Boolean(savedPageId)
  const hasInstagramAccount = Boolean(savedInstagramAccountId || credentials.instagramAccountId)
  const isMetaConfigured = Boolean(hasAccessToken && hasAdAccount)
  const normalizedMetaTestEventName = normalizeMetaTestEventName(metaTestEventName)
  const normalizedMetaTestEventParameters = normalizeMetaTestEventParameters(metaTestEventParameters)
  const metaTestEventFieldKeys = getMetaTestEventFieldsForEvent(normalizedMetaTestEventName)
  const normalizedMetaTestDraftCode = normalizeMetaTestCode(metaTestDraftCode)
  const normalizedSavedMetaTestCode = normalizeMetaTestCode(metaTestEventCode)
  const isServerOnlyMetaTestEvent = serverOnlyMetaTestEvents.has(normalizedMetaTestEventName)
  const shouldShowClearMetaTestCode = Boolean(normalizedSavedMetaTestCode)
  const shouldShowSaveMetaTestCode = !isServerOnlyMetaTestEvent
    && Boolean(normalizedMetaTestDraftCode)
    && normalizedMetaTestDraftCode !== normalizedSavedMetaTestCode
  const visibleMetaTestCustomRows = [
    ...(normalizedMetaTestEventParameters.custom || []),
    ...(normalizedMetaTestEventParameters.custom?.length && normalizedMetaTestEventParameters.custom.length >= 12
      ? []
      : [createDefaultMetaTestCustomParameter()])
  ]
  const shouldShowWizard = !isMetaConfigured || isEditingMetaConfig || activeStep > 0
  const shouldShowAccessTokenAction = Boolean(
    credentials.accessToken &&
    !isMaskedSecretValue(credentials.accessToken) &&
    (!realAccessToken || credentials.accessToken !== realAccessToken)
  )
  const metaSetupSteps = [
    {
      title: 'Token',
      description: 'App y System User',
      done: hasAccessToken,
      required: true,
      unlocked: true
    },
    {
      title: 'Cuenta de anuncios',
      description: 'Campañas y reportes',
      done: hasAdAccount,
      required: true,
      unlocked: hasAccessToken
    },
    {
      title: 'Dataset',
      description: 'Medición web opcional',
      done: hasPixel,
      required: false,
      unlocked: hasAdAccount
    },
    {
      title: 'Páginas de Meta',
      description: 'Facebook e Instagram',
      done: hasPageId || hasInstagramAccount,
      required: false,
      unlocked: hasAdAccount
    }
  ]
  const completedMetaSetupSteps = metaSetupSteps.filter(step => step.done).length
  const shouldShowStepActions = activeStep > 0 || (
    activeStep === 0 &&
    hasAccessToken &&
    !shouldShowAccessTokenAction &&
    !isSavingToken &&
    !isLoadingAccounts
  )

  const getSelectedAdAccountLabel = () => {
    if (!credentials.adAccountId) return 'Pendiente'
    const normalizedId = credentials.adAccountId.replace(/^act_/, '')
    const matchingAccount = adAccounts.find(acc =>
      acc.id.replace(/^act_/, '') === normalizedId
    )

    return matchingAccount
      ? `${matchingAccount.name} (${normalizedId})`
      : normalizedId
  }

  const getSelectedPixelLabel = () => {
    if (!credentials.pixelId) return 'Opcional'
    const matchingPixel = pixels.find(p => p.id === credentials.pixelId)
    return matchingPixel ? `${matchingPixel.name} (${credentials.pixelId})` : credentials.pixelId
  }

  const getSelectedPageLabel = () => {
    if (!credentials.pageId && !savedPageId) return 'Opcional'
    const pageId = credentials.pageId || savedPageId
    const matchingPage = pages.find(page => page.id === pageId)
    return matchingPage ? `${matchingPage.name} (${pageId})` : pageId
  }

  const getSelectedInstagramLabel = () => {
    if (!credentials.instagramAccountId && !savedInstagramAccountId) return 'Opcional'
    const instagramAccountId = credentials.instagramAccountId || savedInstagramAccountId
    const matchingAccount = instagramAccounts.find(account => account.sourceId === instagramAccountId)
    if (!matchingAccount) return instagramAccountId
    const username = matchingAccount.username ? `@${matchingAccount.username}` : matchingAccount.name
    return `${username} (${instagramAccountId})`
  }

  const getMetaMessagingStatus = (enabled: boolean, available: boolean) => {
    if (!available) return 'Pendiente'
    return enabled ? 'Activo' : 'Apagado'
  }

  const getMetaMessagingStatusVariant = (enabled: boolean, available: boolean): BadgeVariant => {
    if (!available) return 'warning'
    return enabled ? 'success' : 'neutral'
  }

  const getStepBlockMessage = (stepIndex = activeStep) => {
    if (stepIndex === 1 && !hasAccessToken) {
      return 'Primero valida el Access Token para cargar tus cuentas de anuncios'
    }

    if ((stepIndex === 2 || stepIndex === 3) && !hasAdAccount) {
      return 'Primero selecciona y guarda una cuenta de anuncios'
    }

    return 'Completa el paso anterior para continuar'
  }

  const handleNextStep = () => {
    const currentStep = metaSetupSteps[activeStep]

    if (!currentStep?.unlocked) {
      showToast('warning', 'Paso bloqueado', getStepBlockMessage(activeStep))
      return
    }

    if (currentStep.required && !currentStep.done) {
      showToast('warning', 'Falta un dato', getStepBlockMessage(activeStep + 1))
      return
    }

    if (activeStep === 2 && !hasPixel) {
      goToMetaStep(3)
      return
    }

    goToMetaStep(Math.min(activeStep + 1, metaSetupSteps.length - 1))
  }

  const handlePreviousStep = () => {
    goToMetaStep(activeStep === 3 && !hasPixel ? 2 : Math.max(activeStep - 1, 0))
  }

  const handleSelectStep = (stepIndex: number) => {
    const selectedStep = metaSetupSteps[stepIndex]

    if (!selectedStep?.unlocked) {
      showToast('warning', 'Paso bloqueado', getStepBlockMessage(stepIndex))
      return
    }

    goToMetaStep(stepIndex)
  }

  const renderStepContent = () => {
    if (activeStep === 0) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 1</span>
            <h3 className={styles.stepTitle}>Crea la app y pega el token</h3>
            <p className={styles.stepText}>
              El token debe salir de un usuario del sistema dentro del mismo portafolio comercial. Si ese usuario tiene la cuenta publicitaria, la Página y el dataset asignados, este único token sirve para reportes y Conversions API.
            </p>
          </div>

          <div className={styles.setupGuide}>
            <div className={styles.guideLinks}>
              <a href="https://business.facebook.com/settings/apps" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
                Apps del portafolio
                <ExternalLink size={14} />
              </a>
              <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
                Usuarios del sistema
                <ExternalLink size={14} />
              </a>
            </div>

            <ol className={styles.guideList}>
              {tokenSetupGuideSteps.map((step, index) => (
                <li key={step.title} className={styles.guideItem}>
                  <span className={styles.guideNumber}>{index + 1}</span>
                  <div className={styles.guideCopy}>
                    <strong>{step.title}</strong>
                    <span>{step.body}</span>
                  </div>
                </li>
              ))}
            </ol>

            <div className={styles.scopeBlock}>
              <span className={styles.scopeBlockLabel}>Permisos del token</span>
              <div className={styles.scopeList}>
                {tokenSetupScopes.map(scope => (
                  <code key={scope} className={styles.scopeChip}>{scope}</code>
                ))}
              </div>
            </div>
          </div>

          <div className={`${styles.formGroup} ${styles.formGroupWide}`}>
            <span id="metaAccessTokenLabel" className={styles.formLabel}>System User Access Token</span>
            {credentials.accessToken && isMaskedSecretValue(credentials.accessToken) ? (
              <div
                className={`${styles.filterChip} ${styles.secretTokenChip}`}
                onClick={() => handleEditStoredSecret('accessToken')}
                onKeyDown={(event) => handleSecretChipKeyDown(event, 'accessToken')}
                role="button"
                tabIndex={0}
                aria-label="Mostrar y editar Access Token"
                title="Mostrar y editar Access Token"
              >
                {renderMaskedSecretValue(credentials.accessToken, isRevealingAccessToken)}
                <button
                  onClick={(event) => {
                    event.stopPropagation()
                    handleRemoveCredential('accessToken')
                  }}
                  className={styles.chipDeleteButton}
                  type="button"
                  aria-label="Eliminar Access Token"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ) : (
              <div className={styles.inputActionRow}>
                <input
                  id="metaAccessToken"
                  ref={accessTokenInputRef}
                  type="text"
                  value={credentials.accessToken}
                  onChange={(event) => handleInputChange('accessToken', event.target.value)}
                  placeholder="EAAabcdef..."
                  className={`${styles.formInput} ${styles.secretTokenInput}`}
                  aria-labelledby="metaAccessTokenLabel"
                  autoComplete="off"
                  spellCheck={false}
                />
                {shouldShowAccessTokenAction && !isLoadingAccounts && (
                  <Button
                    type="button"
                    variant="primary"
                    onClick={handleContinueWithToken}
                    disabled={isSavingToken || !credentials.accessToken || credentials.accessToken.length < 50}
                  >
                    {isSavingToken ? 'Guardando...' : realAccessToken ? 'Actualizar' : 'Continuar'}
                  </Button>
                )}
              </div>
            )}
          </div>

          {isLoadingAccounts && (
            <div className={styles.inlineStatus} role="status" aria-live="polite" aria-label="Cargando cuentas de anuncios">
              <RefreshCw size={14} className={styles.spinning} aria-hidden="true" />
            </div>
          )}
        </>
      )
    }

    if (activeStep === 1) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 2</span>
            <h3 className={styles.stepTitle}>Selecciona la cuenta de anuncios</h3>
            <p className={styles.stepText}>
              Esta cuenta alimenta campañas, costos y reportes. Al seleccionarla se guarda automáticamente y se cargan los datasets disponibles.
            </p>
          </div>

          {!hasAccessToken ? (
            <p className={styles.stepHint}>{getStepBlockMessage(1)}</p>
          ) : (
            <label className={`${styles.formGroup} ${styles.formGroupWide}`}>
              <span className={styles.formLabel}>Cuenta de anuncios</span>
              {credentials.adAccountId ? (
                <div className={styles.filterChip}>
                  <span className={styles.chipText}>{getSelectedAdAccountLabel()}</span>
                  <button
                    onClick={() => {
                      handleRemoveCredential('adAccountId')
                      setPixels([])
                    }}
                    className={styles.chipDeleteButton}
                    type="button"
                    aria-label="Eliminar cuenta de anuncios"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ) : adAccounts.length > 0 ? (
                <CustomSelect
                  onChange={(event) => {
                    const account = adAccounts.find(a => a.id === event.target.value)
                    if (account) handleSelectAdAccount(account)
                  }}
                  value={credentials.adAccountId || ''}
                >
                  <option value="">-- Selecciona una cuenta --</option>
                  {adAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ({account.id}) - {account.currency}
                    </option>
                  ))}
                </CustomSelect>
              ) : (
                <input
                  type="text"
                  value={credentials.adAccountId}
                  onChange={(event) => handleInputChange('adAccountId', event.target.value)}
                  placeholder="act_123456789012345"
                  className={styles.formInput}
                />
              )}
            </label>
          )}
        </>
      )
    }

    if (activeStep === 2) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 3</span>
            <h3 className={styles.stepTitle}>Elige el Dataset</h3>
            <p className={styles.stepText}>
              Es opcional para reportes de anuncios, pero necesario si quieres activar medición web en el snippet o usar Conversions API.
            </p>
          </div>

          {!hasAdAccount ? (
            <p className={styles.stepHint}>{getStepBlockMessage(2)}</p>
          ) : (
            <>
              <label className={`${styles.formGroup} ${styles.formGroupWide}`}>
                <span className={styles.formLabel}>Dataset</span>
                {credentials.pixelId ? (
                  <div className={styles.filterChip}>
                    <span className={styles.chipText}>{getSelectedPixelLabel()}</span>
                    <button
                      onClick={() => handleRemoveCredential('pixelId')}
                      className={styles.chipDeleteButton}
                      type="button"
                      aria-label="Eliminar Dataset"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ) : isLoadingPixels ? (
                  <div className={styles.inlineStatus} role="status" aria-live="polite" aria-label="Cargando datasets">
                    <RefreshCw size={14} className={styles.spinning} aria-hidden="true" />
                  </div>
                ) : pixels.length > 0 ? (
                  <CustomSelect
                    onChange={(event) => {
                      const pixel = pixels.find(p => p.id === event.target.value)
                      if (pixel) handleSelectPixel(pixel)
                    }}
                    value={credentials.pixelId || ''}
                  >
                    <option value="">-- Sin Dataset (opcional) --</option>
                    {pixels.map((pixel) => (
                      <option key={pixel.id} value={pixel.id}>
                        {pixel.name} ({pixel.id})
                      </option>
                    ))}
                  </CustomSelect>
                ) : (
                  <input
                    type="text"
                    value={credentials.pixelId}
                    onChange={(event) => handleInputChange('pixelId', event.target.value)}
                    placeholder="1234567890123456"
                    className={styles.formInput}
                  />
                )}
              </label>
              <p className={styles.stepHint}>
                Si no necesitas Dataset por ahora, puedes saltar directo a las páginas de Meta.
              </p>
            </>
          )}
        </>
      )
    }

    if (activeStep === 3) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 4</span>
            <h3 className={styles.stepTitle}>Selecciona tus páginas de Meta</h3>
            <p className={styles.stepText}>
              Elige la Facebook Page para Messenger y la cuenta de Instagram para DMs. Las dos son opcionales; puedes terminar y volver a conectarlas después.
            </p>
            <div className={styles.guideLinks}>
              <a href="https://business.facebook.com/latest/settings/pages" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
                Abrir páginas en Meta Business
                <ExternalLink size={14} />
              </a>
              <a href="https://business.facebook.com/latest/settings/instagram-account" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
                Abrir Instagram en Meta Business
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          {!hasAdAccount ? (
            <p className={styles.stepHint}>{getStepBlockMessage(3)}</p>
          ) : (
            <>
              <div className={`${styles.formGroup} ${styles.formGroupWide}`}>
                <span className={styles.formLabel}>Facebook Page opcional</span>
                {savedPageId && credentials.pageId === savedPageId ? (
                  <div className={styles.filterChip}>
                    <span className={styles.chipText}>{getSelectedPageLabel()}</span>
                    <button
                      onClick={() => handleRemoveCredential('pageId')}
                      className={styles.chipDeleteButton}
                      type="button"
                      aria-label="Eliminar Page ID"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ) : isLoadingPages ? (
                  <div className={styles.inlineStatus} role="status" aria-live="polite" aria-label="Cargando páginas">
                    <RefreshCw size={14} className={styles.spinning} aria-hidden="true" />
                  </div>
                ) : pages.length > 0 ? (
                  <CustomSelect
                    onChange={(event) => {
                      const page = pages.find(item => item.id === event.target.value)
                      if (page) handleSelectAndSavePage(page)
                    }}
                    value={credentials.pageId || ''}
                    disabled={isSavingPageId}
                  >
                    <option value="">-- Sin Facebook Page por ahora --</option>
                    {pages.map((page) => (
                      <option key={page.id} value={page.id}>
                        {page.name} ({page.id}){page.category ? ` - ${page.category}` : ''}
                      </option>
                    ))}
                  </CustomSelect>
                ) : (
                  <div className={styles.emptyPagesState}>
                    <p>
                      No encontramos páginas para este token. Puedes terminar y volver cuando la Página esté asignada al usuario del sistema.
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => fetchPages(realAccessToken || credentials.accessToken)}
                      disabled={isLoadingPages || !(realAccessToken || credentials.accessToken)}
                    >
                      <RefreshCw size={16} className={isLoadingPages ? styles.spinning : ''} />
                      Volver a cargar
                    </Button>
                  </div>
                )}
                {isSavingPageId && (
                  <div className={styles.inlineStatus}>
                    <RefreshCw size={14} className={styles.spinning} />
                    Guardando página...
                  </div>
                )}
              </div>

              <div className={`${styles.formGroup} ${styles.formGroupWide}`}>
                <span className={styles.formLabel}>Cuenta de Instagram opcional</span>
                {savedInstagramAccountId && credentials.instagramAccountId === savedInstagramAccountId ? (
                  <div className={styles.filterChip}>
                    <span className={styles.chipText}>{getSelectedInstagramLabel()}</span>
                    <button
                      onClick={() => handleRemoveCredential('instagramAccountId')}
                      className={styles.chipDeleteButton}
                      type="button"
                      aria-label="Eliminar Instagram"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ) : isLoadingInstagramAccounts ? (
                  <div className={styles.inlineStatus} role="status" aria-live="polite" aria-label="Cargando Instagram">
                    <RefreshCw size={14} className={styles.spinning} aria-hidden="true" />
                  </div>
                ) : instagramAccounts.length > 0 ? (
                  <CustomSelect
                    onChange={(event) => {
                      const account = instagramAccounts.find(item => item.sourceId === event.target.value)
                      if (account) handleSelectInstagramAccount(account)
                    }}
                    value={credentials.instagramAccountId || ''}
                    disabled={isSavingInstagramAccountId}
                  >
                    <option value="">-- Sin Instagram por ahora --</option>
                    {instagramAccounts.map((account) => (
                      <option key={account.sourceId} value={account.sourceId}>
                        {account.username ? `@${account.username}` : account.name} ({account.sourceId})
                      </option>
                    ))}
                  </CustomSelect>
                ) : (
                  <div className={styles.emptyPagesState}>
                    <p>
                      No encontramos Instagram conectado. Puedes terminar y volver cuando la cuenta esté ligada en Meta Business.
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => fetchInstagramAccounts(realAccessToken || credentials.accessToken, credentials.instagramAccountId)}
                      disabled={isLoadingInstagramAccounts || !(realAccessToken || credentials.accessToken)}
                    >
                      <RefreshCw size={16} className={isLoadingInstagramAccounts ? styles.spinning : ''} />
                      Volver a cargar
                    </Button>
                  </div>
                )}
                {isSavingInstagramAccountId && (
                  <div className={styles.inlineStatus}>
                    <RefreshCw size={14} className={styles.spinning} />
                    Guardando Instagram...
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )
    }

    return null
  }

  return (
    <div className={styles.container}>
      <PageHeader
        className={styles.metaHeader}
        eyebrow="Integración"
        title="Meta"
        subtitle="Conecta anuncios, Página, Messenger e Instagram DM desde un solo lugar."
        actions={isMetaConfigured ? (
          <Badge variant="success">
            <CheckCircle size={16} />
            <span>Configurado</span>
          </Badge>
        ) : (
          <Badge variant="error">
            <XCircle size={16} />
            <span>No configurado</span>
          </Badge>
        )}
      />

      <div className={styles.sections}>
            {!shouldShowWizard && (
              <SegmentTabs
                aria-label="Secciones de configuración de Meta"
                className={styles.metaTabs}
                tabs={metaConnectedTabs}
                value={activeMetaTab}
                onChange={(id) => setActiveMetaTab(id as MetaConnectedTab)}
              />
            )}
            {!shouldShowWizard && activeMetaTab === 'cuenta' && (
              <section className={styles.tabPanel}>
                <div className={styles.connectedHeader}>
                  <span className={styles.connectedIcon} aria-hidden="true">
                    <CheckCircle size={20} />
                  </span>
                  <div className={styles.connectedCopy}>
                    <h3 className={styles.connectedTitle}>Configuración activa</h3>
                    <p className={styles.connectedText}>
                      La cuenta está lista para reportes, eventos y mensajes nuevos de Meta.
                    </p>
                  </div>
                  <div className={styles.connectedActions}>
                    <Button type="button" variant="secondary" onClick={handleSyncMetaAds} disabled={isSyncingMetaAds}>
                      <RefreshCw size={16} className={isSyncingMetaAds ? styles.spinning : ''} />
                      {isSyncingMetaAds ? 'Sincronizando' : 'Sincronizar'}
                    </Button>
                    <Button type="button" variant="secondary" onClick={handleEditMetaConfig}>
                      <Pencil size={16} />
                      Editar
                    </Button>
                    <Button type="button" variant="danger" onClick={() => setIsDisconnectModalOpen(true)}>
                      <Power size={16} />
                      Desconectar
                    </Button>
                  </div>
                </div>

                <div className={styles.connectedList}>
                  <div className={styles.connectedListRow}>
                    <span className={styles.connectedListLabel}>Cuenta publicitaria</span>
                    <span className={styles.connectedListValue}>{getSelectedAdAccountLabel()}</span>
                  </div>
                  <div className={styles.connectedListRow}>
                    <span className={styles.connectedListLabel}>Facebook Page</span>
                    <span className={styles.connectedListValue}>{getSelectedPageLabel()}</span>
                  </div>
                  <div className={styles.connectedListRow}>
                    <span className={styles.connectedListLabel}>Dataset</span>
                    <span className={styles.connectedListValue}>{hasPixel ? getSelectedPixelLabel() : 'Sin Dataset'}</span>
                  </div>
                  <div className={styles.connectedListRow}>
                    <span className={styles.connectedListLabel}>Instagram</span>
                    <span className={styles.connectedListValue}>{hasInstagramAccount ? getSelectedInstagramLabel() : 'Sin Instagram'}</span>
                  </div>
                  <div className={styles.connectedListRow}>
                    <span className={styles.connectedListLabel}>Token de Meta</span>
                    {metaTokenStatus ? (
                      <span className={styles.connectedListValue}>
                        <Badge
                          variant={
                            !metaTokenStatus.valid
                              ? 'error'
                              : (typeof metaTokenStatus.daysUntilExpiry === 'number' && metaTokenStatus.daysUntilExpiry <= 7 ? 'warning' : 'success')
                          }
                        >
                          {metaTokenStatus.valid ? 'Válido' : 'Inválido'}
                        </Badge>
                        {metaTokenStatus.valid && typeof metaTokenStatus.daysUntilExpiry === 'number' && (
                          <span className={styles.tokenExpiry}>
                            expira en {metaTokenStatus.daysUntilExpiry} día{metaTokenStatus.daysUntilExpiry === 1 ? '' : 's'}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className={styles.connectedListValue}>—</span>
                    )}
                  </div>
                </div>
              </section>
            )}

            {!shouldShowWizard && activeMetaTab === 'mensajes' && (
              <section className={styles.tabPanel}>
                <div className={styles.connectedPagesHeader}>
                  <h4 className={styles.connectedPagesTitle}>Páginas conectadas</h4>
                  <p className={styles.connectedPagesDescription}>
                    Activa cada canal solo cuando quieras que Ristak reciba y mande mensajes desde esa cuenta.
                  </p>
                </div>

                <div className={styles.connectedPagesList}>
                    <div className={[
                      styles.connectedPageCard,
                      !hasPageId ? styles.connectedPageCardLocked : ''
                    ].filter(Boolean).join(' ')}>
                      <span className={`${styles.connectedPageIcon} ${styles.connectedPageIconFacebook}`} aria-hidden="true">
                        <Icon name="facebook" size={19} />
                      </span>
                      <div className={styles.connectedPageMain}>
                        <strong>Messenger</strong>
                        <span>{hasPageId ? getSelectedPageLabel() : 'Selecciona una Facebook Page'}</span>
                      </div>
                      <div className={styles.connectedPageControl}>
                        <Badge variant={getMetaMessagingStatusVariant(messengerMessagingEnabled, hasPageId)}>
                          {getMetaMessagingStatus(messengerMessagingEnabled, hasPageId)}
                        </Badge>
                        <Switch
                          aria-label="Activar mensajes de Messenger"
                          checked={messengerMessagingEnabled === true}
                          onChange={(next) => handleToggleMetaMessaging('messenger', next)}
                          disabled={!hasPageId || savingMessengerMessaging}
                        />
                      </div>
                    </div>

                    <div className={[
                      styles.connectedPageCard,
                      !hasInstagramAccount ? styles.connectedPageCardLocked : ''
                    ].filter(Boolean).join(' ')}>
                      <span className={`${styles.connectedPageIcon} ${styles.connectedPageIconInstagram}`} aria-hidden="true">
                        <Icon name="instagram" size={19} />
                      </span>
                      <div className={styles.connectedPageMain}>
                        <strong>Instagram DM</strong>
                        <span>{hasInstagramAccount ? getSelectedInstagramLabel() : 'Selecciona una cuenta de Instagram'}</span>
                      </div>
                      <div className={styles.connectedPageControl}>
                        <Badge variant={getMetaMessagingStatusVariant(instagramMessagingEnabled, hasInstagramAccount)}>
                          {getMetaMessagingStatus(instagramMessagingEnabled, hasInstagramAccount)}
                        </Badge>
                        <Switch
                          aria-label="Activar mensajes de Instagram DM"
                          checked={instagramMessagingEnabled === true}
                          onChange={(next) => handleToggleMetaMessaging('instagram', next)}
                          disabled={!hasInstagramAccount || savingInstagramMessaging}
                        />
                      </div>
                    </div>
                  </div>

                <div className={styles.commentsBlock}>
                  <div className={styles.connectedPagesHeader}>
                    <h4 className={styles.connectedPagesTitle}>Comentarios</h4>
                    <p className={styles.connectedPagesDescription}>
                      Recibe en la bandeja los comentarios de tus publicaciones y anuncios. Llegan aparte de los mensajes, en el filtro "Comentarios" del chat.
                    </p>
                  </div>

                  <div className={styles.connectedPagesList}>
                    <div className={[
                      styles.connectedPageCard,
                      !hasPageId ? styles.connectedPageCardLocked : ''
                    ].filter(Boolean).join(' ')}>
                      <span className={`${styles.connectedPageIcon} ${styles.connectedPageIconFacebook}`} aria-hidden="true">
                        <Icon name="facebook" size={19} />
                      </span>
                      <div className={styles.connectedPageMain}>
                        <strong>Comentarios de Facebook</strong>
                        <span>{hasPageId ? getSelectedPageLabel() : 'Selecciona una Facebook Page'}</span>
                      </div>
                      <div className={styles.connectedPageControl}>
                        <Badge variant={facebookCommentsEnabled ? 'success' : 'neutral'}>
                          {facebookCommentsEnabled ? 'Activo' : 'Apagado'}
                        </Badge>
                        <Switch
                          aria-label="Activar comentarios de Facebook"
                          checked={facebookCommentsEnabled === true}
                          onChange={(next) => handleToggleMetaComments('facebook', next)}
                          disabled={!hasPageId || savingFacebookComments}
                        />
                      </div>
                    </div>

                    <div className={[
                      styles.connectedPageCard,
                      !hasInstagramAccount ? styles.connectedPageCardLocked : ''
                    ].filter(Boolean).join(' ')}>
                      <span className={`${styles.connectedPageIcon} ${styles.connectedPageIconInstagram}`} aria-hidden="true">
                        <Icon name="instagram" size={19} />
                      </span>
                      <div className={styles.connectedPageMain}>
                        <strong>Comentarios de Instagram</strong>
                        <span>{hasInstagramAccount ? getSelectedInstagramLabel() : 'Selecciona una cuenta de Instagram'}</span>
                      </div>
                      <div className={styles.connectedPageControl}>
                        <Badge variant={instagramCommentsEnabled ? 'success' : 'neutral'}>
                          {instagramCommentsEnabled ? 'Activo' : 'Apagado'}
                        </Badge>
                        <Switch
                          aria-label="Activar comentarios de Instagram"
                          checked={instagramCommentsEnabled === true}
                          onChange={(next) => handleToggleMetaComments('instagram', next)}
                          disabled={!hasInstagramAccount || savingInstagramComments}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className={styles.webhookGuide}>
                  <div className={styles.connectedPagesHeader}>
                    <h4 className={styles.connectedPagesTitle}>Conectar los mensajes en Meta Developers</h4>
                    <p className={styles.connectedPagesDescription}>
                      Para que Ristak reciba Messenger e Instagram DM, pega estos valores en los Webhooks de tu app de Meta. Facebook e Instagram se configuran por separado (mira los pasos de abajo).
                    </p>
                  </div>

                  <div className={styles.webhookFields}>
                    <div className={styles.webhookField}>
                      <span className={styles.webhookFieldLabel}>URL de devolución de llamada</span>
                      <div className={styles.webhookFieldRow}>
                        <code className={styles.webhookFieldValue}>{metaWebhookInfo?.webhookUrl || 'Cargando…'}</code>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => handleCopyValue(metaWebhookInfo?.webhookUrl || '', 'URL')}
                          disabled={!metaWebhookInfo?.webhookUrl}
                        >
                          <Copy size={16} />
                          Copiar
                        </Button>
                      </div>
                    </div>

                    <div className={styles.webhookField}>
                      <span className={styles.webhookFieldLabel}>Token de verificación</span>
                      <div className={styles.webhookFieldRow}>
                        <code className={styles.webhookFieldValue}>{metaWebhookInfo?.verifyToken || 'Cargando…'}</code>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => handleCopyValue(metaWebhookInfo?.verifyToken || '', 'Token')}
                          disabled={!metaWebhookInfo?.verifyToken}
                        >
                          <Copy size={16} />
                          Copiar
                        </Button>
                      </div>
                    </div>

                    <div className={styles.webhookField}>
                      <span className={styles.webhookFieldLabel}>Campos del webhook a suscribir</span>
                      <div className={styles.webhookFieldRow}>
                        <code className={styles.webhookFieldValue}>{(metaWebhookInfo?.fields?.length ? metaWebhookInfo.fields : ['messages', 'messaging_postbacks', 'message_reactions', 'messaging_referrals']).join(', ')}</code>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => handleCopyValue((metaWebhookInfo?.fields?.length ? metaWebhookInfo.fields : ['messages', 'messaging_postbacks', 'message_reactions', 'messaging_referrals']).join(','), 'Campos')}
                        >
                          <Copy size={16} />
                          Copiar
                        </Button>
                      </div>
                    </div>
                  </div>

                  <ol className={styles.webhookSteps}>
                    <li><strong>Facebook / Messenger:</strong> en Meta Developers entra a <strong>Configuración de la API con Facebook</strong> → <strong>Webhooks</strong>, pega la <strong>URL de devolución de llamada</strong> y el <strong>token de verificación</strong> de arriba, da <strong>Verificar y guardar</strong> y suscríbete a los campos.</li>
                    <li><strong>Instagram va en otro lugar:</strong> entra a <strong>Configuración de la API con inicio de sesión de empresa de Instagram</strong>.</li>
                    <li>Ahí primero, en <strong>Generar tokens de acceso</strong>, agrega tu cuenta de Instagram: te pedirá <strong>iniciar sesión</strong> para generar el token de acceso.</li>
                    <li>Ya con el token, en <strong>Configurar webhooks</strong> pega la <strong>misma URL</strong> y el <strong>mismo token de verificación</strong> de arriba, y suscríbete a los campos.</li>
                    <li>Si iniciaste sesión con Facebook, la suscripción de la Página suele quedar automática; en Instagram hazla manual si no aparece.</li>
                  </ol>

                  <div className={styles.webhookComments}>
                    <span className={styles.webhookFieldLabel}>Comentarios de Facebook e Instagram — opcional</span>
                    <p className={styles.connectedPagesDescription}>
                      Si además quieres recibir comentarios (de publicaciones y anuncios), suscribe también estos campos. En Facebook van en el webhook de la Página; en Instagram, en el objeto Instagram del panel.
                    </p>
                    <div className={styles.webhookFields}>
                      <div className={styles.webhookField}>
                        <span className={styles.webhookFieldLabel}>Facebook — campo a suscribir</span>
                        <div className={styles.webhookFieldRow}>
                          <code className={styles.webhookFieldValue}>feed</code>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => handleCopyValue('feed', 'Campo')}
                          >
                            <Copy size={16} />
                            Copiar
                          </Button>
                        </div>
                      </div>
                      <div className={styles.webhookField}>
                        <span className={styles.webhookFieldLabel}>Instagram — campos a suscribir</span>
                        <div className={styles.webhookFieldRow}>
                          <code className={styles.webhookFieldValue}>comments, mentions</code>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => handleCopyValue('comments,mentions', 'Campos')}
                          >
                            <Copy size={16} />
                            Copiar
                          </Button>
                        </div>
                      </div>
                    </div>
                    <p className={styles.connectedPagesDescription}>
                      Para leerlos y responderlos, el token también necesita <strong>pages_read_engagement</strong> y <strong>pages_manage_engagement</strong> (Facebook) e <strong>instagram_manage_comments</strong> (Instagram). Ya vienen incluidos en el asistente del token de arriba.
                    </p>
                  </div>
                </div>
              </section>
            )}
            {shouldShowWizard && (
            <section className={`${styles.section} ${styles.wizardSection}`}>
              <div className={styles.sectionHeader}>
                <div>
                  <h3 className={styles.sectionTitle}>Wizard de configuración</h3>
                  <p className={styles.sectionDescription}>
                    Crea el token correcto y después selecciona los activos que Meta devuelve.
                  </p>
                </div>
                <span className={styles.stepCount}>{completedMetaSetupSteps}/{metaSetupSteps.length} listo</span>
              </div>

              <div className={styles.wizardShell}>
                <div className={styles.progressList} aria-label="Progreso de configuración de Meta">
                  {metaSetupSteps.map((step, index) => (
                    <button
                      key={step.title}
                      type="button"
                      className={[
                        styles.progressItem,
                        step.done ? styles.progressDone : '',
                        index === activeStep ? styles.progressActive : '',
                        !step.unlocked ? styles.progressLocked : ''
                      ].filter(Boolean).join(' ')}
                      onClick={() => handleSelectStep(index)}
                      disabled={!step.unlocked}
                    >
                      <span className={styles.progressDot}>
                        {step.done ? <CheckCircle size={13} /> : index + 1}
                      </span>
                      <span className={styles.progressCopy}>
                        <span className={styles.progressLabel}>{step.title}</span>
                        <span className={styles.progressDescription}>{step.description}</span>
                      </span>
                    </button>
                  ))}
                </div>

                <div className={styles.stepPanel}>
                  {isLoading ? (
                    <div className={styles.loadingState} role="status" aria-live="polite" aria-label="Cargando credenciales">
                      <RefreshCw size={18} className={styles.spinning} aria-hidden="true" />
                    </div>
                  ) : (
                    <>
                      {renderStepContent()}

                      {shouldShowStepActions && (
                        <div className={[
                          styles.stepActions,
                          activeStep === 0 ? styles.stepActionsEnd : ''
                        ].filter(Boolean).join(' ')}>
                          {activeStep > 0 && (
                            <Button type="button" variant="secondary" onClick={handlePreviousStep}>
                              <ArrowLeft size={16} />
                              Atrás
                            </Button>
                          )}
                          {activeStep < metaSetupSteps.length - 1 && (
                            <Button type="button" variant="secondary" onClick={handleNextStep}>
                              {activeStep === 2 && !hasPixel ? 'Saltar a Page' : 'Siguiente'}
                              <ArrowRight size={16} />
                            </Button>
                          )}
                          {activeStep === metaSetupSteps.length - 1 && (
                            <Button
                              type="button"
                              variant="primary"
                              onClick={handleFinishWizard}
                              disabled={!hasAdAccount || isSavingPageId || isSavingInstagramAccountId}
                            >
                              Terminar
                              <CheckCircle size={16} />
                            </Button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </section>
            )}

            {!shouldShowWizard && activeMetaTab === 'rastreo' && (
              <section className={styles.tabPanel}>
                <div className={styles.utmBlock}>
                  <div className={styles.sectionHeader}>
                    <div>
                      <h3 className={styles.sectionTitle}>Parámetros UTM</h3>
                      <p className={styles.sectionDescription}>
                        Copia esta cadena completa y pégala en Parámetros de URL dentro del anuncio de Meta.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={handleCopyMetaAdUtmParameters}
                    >
                      <Copy size={16} />
                      Copiar UTM
                    </Button>
                  </div>

                  <div className={styles.utmCopyBox} aria-label="Parámetros UTM para anuncios de Meta">
                    <code className={styles.utmCode}>{META_AD_UTM_PARAMETERS}</code>
                  </div>
                </div>

                <div className={styles.connectedExtrasRows}>
                  {hasPixel ? (
                    <div className={styles.connectedExtraRow}>
                      <div>
                        <span className={styles.railSwitchLabel}>Incluir Dataset en snippet</span>
                        <span className={styles.railSecondaryValue}>Agrega el Dataset ({getSelectedPixelLabel()}) al snippet de Web Tracking de tus sitios.</span>
                      </div>
                      <Switch
                        checked={includeMetaPixel === true}
                        onChange={(next) => handleToggleMetaPixel(next)}
                        disabled={isSyncingSnippet || savingPixelPref}
                      />
                    </div>
                  ) : (
                    <div className={styles.connectedExtraRow}>
                      <div>
                        <span className={styles.railSwitchLabel}>Dataset en snippet</span>
                        <span className={styles.railSecondaryValue}>Aún no hay un Dataset asociado a la cuenta. Se toma automáticamente al conectar; si no aparece, elígelo en el wizard.</span>
                      </div>
                    </div>
                  )}

                  {isSyncingSnippet && (
                    <div className={styles.inlineStatus}>
                      <RefreshCw size={16} className={styles.spinning} />
                      Sincronizando snippet...
                    </div>
                  )}
                </div>
              </section>
            )}

            {!shouldShowWizard && activeMetaTab === 'pruebas' && (
              <section className={styles.tabPanel}>
                <div className={styles.sectionHeader}>
                  <div>
                    <h3 className={styles.sectionTitle}>Dataset Test</h3>
                    <p className={styles.sectionDescription}>
                      Guarda el código TEST de Events Manager y manda un evento de prueba (navegador + servidor) antes de lanzar campañas de verdad.
                    </p>
                  </div>
                  <Badge variant={metaTestEventCode ? 'warning' : 'neutral'}>
                    {metaTestEventCode ? 'Test activo' : 'Sin código'}
                  </Badge>
                </div>

                {!hasPixel ? (
                  <div className={styles.connectedExtraRow}>
                    <div>
                      <span className={styles.railSwitchLabel}>Dataset requerido</span>
                      <span className={styles.railSecondaryValue}>Elige un Dataset en el wizard para poder mandar pruebas de eventos CAPI.</span>
                    </div>
                  </div>
                ) : (
                  <div className={styles.metaTestPanel}>
                    <p className={styles.metaTestHelp}>
                      Pega el código de la pestaña Test Events. Mientras esté activo, los eventos de tus páginas (navegador + servidor) se mandan como prueba, incluso si la página está en anti-tracking. Se <strong>desactiva solo a los 30 minutos</strong> para que, al lanzar publicidad, no queden conversiones reales atrapadas en modo prueba.
                    </p>
                    {metaTestCodeActive && (
                      <p className={styles.metaTestHelp}>
                        <Badge variant="warning">Modo prueba activo</Badge>{' '}
                        {metaTestCodeSetAtMs
                          ? `Se desactiva solo en ~${metaTestCodeRemainingMin} min${metaTestCodeExpiresAtLabel ? ` (a las ${metaTestCodeExpiresAtLabel})` : ''}. Quítalo con "Limpiar" cuando termines de probar.`
                          : 'Recuerda quitarlo con "Limpiar" cuando termines de probar para no perder conversiones reales.'}
                      </p>
                    )}

                    <div className={styles.metaTestGrid}>
                      <label className={styles.formGroup}>
                        <span className={styles.formLabel}>Código de test</span>
                        <input
                          className={styles.formInput}
                          value={metaTestDraftCode}
                          onChange={(event) => setMetaTestDraftCode(event.target.value)}
                          placeholder="TEST12345"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </label>
                      <label className={styles.formGroup}>
                        <span className={styles.formLabel}>Evento</span>
                        <CustomSelect
                          value={normalizedMetaTestEventName}
                          onChange={(event) => setMetaTestEventNameAndResetParameters(event.target.value)}
                        >
                          {metaTestEventOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </CustomSelect>
                      </label>
                    </div>

                    <button
                      type="button"
                      className={[
                        styles.metaTestParametersToggle,
                        isMetaTestParametersOpen ? styles.metaTestParametersToggleActive : '',
                        hasMetaTestEventParameters(normalizedMetaTestEventParameters) ? styles.metaTestParametersToggleFilled : ''
                      ].filter(Boolean).join(' ')}
                      onClick={() => setIsMetaTestParametersOpen(current => !current)}
                    >
                      <Settings2 size={15} />
                      Parámetros del evento
                    </button>

                    {isMetaTestParametersOpen && (
                      <div className={styles.metaTestParametersForm}>
                        {metaTestEventFieldKeys.length > 0 && (
                          <div className={styles.metaTestParametersGrid}>
                            {metaTestEventFieldKeys.map((field) => (
                              <label key={field} className={styles.metaTestParameterField}>
                                <span>{metaTestParameterFieldLabels[field]}</span>
                                <input
                                  value={normalizedMetaTestEventParameters[field] || ''}
                                  placeholder={metaTestParameterFieldPlaceholders[field]}
                                  onChange={(event) => setMetaTestEventParameterField(
                                    field,
                                    event.target.value
                                  )}
                                />
                              </label>
                            ))}
                          </div>
                        )}

                        <div className={styles.metaTestCustomParameters}>
                          <span>Parámetros custom</span>
                          {visibleMetaTestCustomRows.map((parameter, index) => {
                            const isDefaultRow = index >= (normalizedMetaTestEventParameters.custom?.length || 0)

                            return (
                              <div key={parameter.id || `meta-test-parameter-${index}`} className={styles.metaTestCustomParameterRow}>
                                <input
                                  value={parameter.key}
                                  placeholder="parametro_meta"
                                  onChange={(event) => patchMetaTestCustomParameter(index, { key: event.target.value })}
                                />
                                <input
                                  value={parameter.value}
                                  placeholder="valor"
                                  onChange={(event) => patchMetaTestCustomParameter(index, { value: event.target.value })}
                                />
                                <button
                                  type="button"
                                  className={styles.metaTestCustomParameterDelete}
                                  disabled={isDefaultRow}
                                  title="Eliminar parámetro"
                                  onClick={() => removeMetaTestCustomParameter(index)}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            )
                          })}

                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => void addMetaTestCustomParameter()}
                            disabled={(normalizedMetaTestEventParameters.custom || []).length >= 12}
                          >
                            <Plus size={14} />
                            Añadir parámetro
                          </Button>
                        </div>
                      </div>
                    )}

                    {metaTestResult && (
                      <div
                        className={styles.metaTestResult}
                        data-status={metaTestResult.success ? 'success' : 'error'}
                        role="status"
                      >
                        <strong>{metaTestResult.success ? 'Evento enviado' : 'No se pudo enviar'}</strong>
                        {metaTestResult.eventId && (
                          <span className={styles.metaTestResultCode}>{metaTestResult.eventId}</span>
                        )}
                        {metaTestResult.error && (
                          <span>{metaTestResult.error}</span>
                        )}
                      </div>
                    )}

                    <div className={styles.metaTestActions}>
                      <div className={styles.metaTestSecondaryActions}>
                        {shouldShowClearMetaTestCode && (
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => void handleClearMetaTestEventCode()}
                            disabled={savingMetaTestEventCode || isSendingMetaTestEvent || isOpeningMetaPixelTest}
                          >
                            <Trash2 size={16} />
                            Limpiar
                          </Button>
                        )}
                      </div>
                      <div className={styles.metaTestPrimaryActions}>
                        {shouldShowSaveMetaTestCode && (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => void handleSaveMetaTestEventCode()}
                            disabled={savingMetaTestEventCode || isSendingMetaTestEvent || isOpeningMetaPixelTest}
                          >
                            <Save size={16} />
                            {savingMetaTestEventCode ? 'Guardando' : 'Guardar código'}
                          </Button>
                        )}
                        {isServerOnlyMetaTestEvent ? (
                          <Button
                            type="button"
                            variant="primary"
                            onClick={() => void handleSendMetaTestEvent()}
                            disabled={savingMetaTestEventCode || isSendingMetaTestEvent || isOpeningMetaPixelTest}
                          >
                            {isSendingMetaTestEvent ? (
                              <RefreshCw size={16} className={styles.spinning} />
                            ) : (
                              <Send size={16} />
                            )}
                            {isSendingMetaTestEvent ? 'Enviando' : 'Solo servidor'}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="primary"
                            onClick={() => void handleOpenMetaPixelTest()}
                            disabled={savingMetaTestEventCode || isOpeningMetaPixelTest || isSendingMetaTestEvent}
                          >
                            {isOpeningMetaPixelTest ? (
                              <RefreshCw size={16} className={styles.spinning} />
                            ) : (
                              <ExternalLink size={16} />
                            )}
                            {isOpeningMetaPixelTest ? 'Abriendo' : 'Abrir prueba completa'}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </section>
            )}


      </div>

      <Modal
        isOpen={isDisconnectModalOpen}
        onClose={() => {
          if (!isDisconnectingMeta) {
            setIsDisconnectModalOpen(false)
          }
        }}
        title="Eliminar configuración de Meta"
        message="Se eliminará el token, la cuenta de anuncios, el Dataset, la Página e Instagram, y se apagarán Messenger e Instagram DM. Esta acción no se puede deshacer."
        type="confirm"
        typeToConfirm="ELIMINAR"
        confirmText={isDisconnectingMeta ? 'Eliminando...' : 'Eliminar'}
        cancelText="Cancelar"
        onConfirm={() => {
          void handleDisconnectMetaConfig()
        }}
      />
    </div>
  )
}
