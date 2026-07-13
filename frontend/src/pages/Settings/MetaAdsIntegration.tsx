import React, { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button, Icon, MetaBrandMark, Modal, CustomSelect, PageHeader, SegmentTabs, Switch } from '@/components/common'
import { Badge, type BadgeVariant } from '@/components/common/Badge'
import { Activity, ArrowLeft, ArrowRight, CheckCircle, Copy, ExternalLink, FlaskConical, Link2, MessageCircle, Pencil, Plus, Power, RefreshCw, Save, Send, Settings2, Trash2, XCircle } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useAccountCurrency, useAppConfig } from '@/hooks'
import {
  campaignsService,
  type ConnectedSocialProfile,
  type MetaTestCustomParameter,
  type MetaTestEventParameters,
  type MetaTestEventResponse
} from '@/services/campaignsService'
import {
  metaOAuthService,
  type MetaOAuthConnectionMode,
  type MetaOAuthFinalizeSelection,
  type MetaOAuthSession,
  type MetaOAuthStatus
} from '@/services/metaOAuthService'
import { invalidateIntegrationsStatus } from '@/services/integrationsService'
import styles from './MetaAdsIntegration.module.css'

interface MetaCredentials {
  adAccountId: string
  accessToken: string
  pixelId: string
  pageId: string
  instagramAccountId: string
  adsConnectionMode: MetaOAuthConnectionMode
  socialConnectionMode: MetaOAuthConnectionMode
  hasSplitAds: boolean
  hasSplitSocial: boolean
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
  adAccountId?: string
}

interface MetaPage {
  id: string
  name: string
  category: string | null
  pictureUrl: string | null
  businessId?: string
}

interface FetchCollectionResult {
  success: boolean
  count: number
}

interface MetaWizardRefreshOptions {
  silent?: boolean
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
const metaConnectedTabIds = ['cuenta', 'social', 'rastreo', 'pruebas'] as const
type MetaConnectedTab = typeof metaConnectedTabIds[number]
type MetaTestMessagingChannel = 'whatsapp' | 'messenger' | 'instagram'
type MetaTestIdentityParameterKey =
  | 'ctwaClid'
  | 'messagingChannel'
  | 'pageId'
  | 'pageScopedUserId'
  | 'igSid'
  | 'instagramAccountId'
type MetaTestStringParameterKey = Exclude<keyof MetaTestEventParameters, 'custom'>

interface MetaWebhookInfo {
  webhookUrl: string
  verifyToken: string
  fields: string[]
}

interface MetaDeveloperSetup {
  appId: string
  businessId: string
  messengerUrl: string
  instagramUrl: string
  messengerUserTokenConfigured: boolean
}

const metaConnectedTabs: Array<{ id: MetaConnectedTab; label: string; icon: React.ReactNode }> = [
  { id: 'cuenta', label: 'Cuenta Meta', icon: <Link2 size={16} /> },
  { id: 'social', label: 'Redes sociales', icon: <MessageCircle size={16} /> },
  { id: 'rastreo', label: 'Rastreo web', icon: <Activity size={16} /> },
  { id: 'pruebas', label: 'Dataset Test', icon: <FlaskConical size={16} /> }
]

const MASKED_SECRET_PREFIX = '***'
const SECRET_MASK_FILL = '*'.repeat(180)
const metaStepSlugs = ['token', 'ad-account', 'pixel', 'pages'] as const
const getMetaAdsRouteSegment = (pathname: string) => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const metaIndex = segments.indexOf('meta-ads')
  return metaIndex >= 0 ? segments[metaIndex + 1] : ''
}
const parseMetaStep = (pathname: string) => {
  const step = getMetaAdsRouteSegment(pathname)
  const index = metaStepSlugs.indexOf(step as typeof metaStepSlugs[number])
  return index >= 0 ? index : 0
}
const parseMetaConnectedTab = (pathname: string): MetaConnectedTab | null => {
  const tab = getMetaAdsRouteSegment(pathname)
  if (['social', 'redes-sociales', 'mensajes'].includes(tab)) return 'social'
  if (['ads', 'cuenta'].includes(tab)) return 'cuenta'
  if (tab === 'rastreo' || tab === 'pruebas') return tab
  if (metaStepSlugs.includes(tab as typeof metaStepSlugs[number])) return 'cuenta'
  return null
}
const buildMetaAdsSettingsPath = (stepIndex: number) => `/settings/meta-ads/${metaStepSlugs[Math.max(0, Math.min(stepIndex, metaStepSlugs.length - 1))]}`
const buildMetaAdsConnectedTabPath = (tab: MetaConnectedTab) => (
  `/settings/meta-ads/${tab === 'social' ? 'redes-sociales' : tab}`
)

const isMaskedSecretValue = (value = '') => value.trim().startsWith(MASKED_SECRET_PREFIX)

const parseMetaBooleanConfig = (value: unknown) => (
  value === true || ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value ?? '').trim().toLowerCase())
)

const getMaskedSecretTail = (value = '') => (
  isMaskedSecretValue(value)
    ? value.trim().slice(MASKED_SECRET_PREFIX.length)
    : value.trim()
)

const normalizeMetaAdAccountIdForLookup = (adAccountId = '') => {
  const cleanAdAccountId = adAccountId.trim()
  if (!cleanAdAccountId) return ''
  return cleanAdAccountId.startsWith('act_') ? cleanAdAccountId : `act_${cleanAdAccountId}`
}

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
  'pages_read_user_content',
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
  { value: 'LeadSubmitted', label: 'LeadSubmitted (Messaging)' },
  { value: 'WhatsAppPurchase', label: 'Purchase (Messaging)' }
]

const defaultMetaTestEventName = 'Lead'
const serverOnlyMetaTestEvents = new Set(['LeadSubmitted', 'WhatsAppPurchase'])
const defaultMetaTestMessagingChannel: MetaTestMessagingChannel = 'whatsapp'
const metaTestIdentityParameterKeys = new Set<string>([
  'ctwaClid',
  'messagingChannel',
  'pageId',
  'pageScopedUserId',
  'igSid',
  'instagramAccountId'
])
const metaTestMessagingChannelOptions: Array<{ value: MetaTestMessagingChannel; label: string; helper: string }> = [
  { value: 'whatsapp', label: 'WhatsApp', helper: 'Usa ctwa_clid + Page ID.' },
  { value: 'messenger', label: 'Messenger', helper: 'Usa PSID + Page ID.' },
  { value: 'instagram', label: 'Instagram DM', helper: 'Usa IGSID + Instagram ID.' }
]
const metaTestIdentityCustomParameterAliases: Record<string, MetaTestIdentityParameterKey> = {
  ctwa: 'ctwaClid',
  ctwaclid: 'ctwaClid',
  ctwa_clid: 'ctwaClid',
  referral_ctwa_clid: 'ctwaClid',
  page: 'pageId',
  pageid: 'pageId',
  page_id: 'pageId',
  psid: 'pageScopedUserId',
  page_scoped_user_id: 'pageScopedUserId',
  pagescopeduserid: 'pageScopedUserId',
  igsid: 'igSid',
  ig_sid: 'igSid',
  ig_scoped_user_id: 'igSid',
  igscopeduserid: 'igSid',
  instagram_account_id: 'instagramAccountId',
  instagramaccountid: 'instagramAccountId',
  ig_account_id: 'instagramAccountId',
  messaging_channel: 'messagingChannel',
  messagingchannel: 'messagingChannel',
  channel: 'messagingChannel'
}
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
  currency: '',
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
  WhatsAppPurchase: ['value', 'currency', 'orderId', 'contentIds', 'contentName', 'contentType', 'numItems'],
  FormSubmitted: ['value', 'predictedLtv', 'currency', 'status'],
  CompleteRegistration: ['value', 'predictedLtv', 'currency', 'status'],
  Contact: ['value', 'predictedLtv', 'currency', 'status'],
  ViewContent: ['value', 'currency', 'contentName', 'contentCategory', 'contentIds', 'contentType'],
  AddPaymentInfo: ['value', 'predictedLtv', 'currency', 'status'],
  LeadSubmitted: ['value', 'predictedLtv', 'currency', 'status']
}

const getMetaTestEventFieldsForEvent = (eventName?: string): MetaTestParameterFieldKey[] => {
  return metaTestEventParameterFields[eventName || defaultMetaTestEventName] || []
}

const isWhatsappBusinessMetaTestEvent = (eventName?: string) => {
  return ['LeadSubmitted', 'WhatsAppPurchase'].includes(String(eventName || '').trim())
}

const isWhatsappPurchaseMetaTestEvent = (eventName?: string) => {
  return String(eventName || '').trim() === 'WhatsAppPurchase'
}

const createDefaultMetaTestCustomParameter = (): MetaTestCustomParameter => ({
  id: `meta-test-custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  key: '',
  value: ''
})

const cleanMetaTestParameterString = (value: unknown) => String(value ?? '').trim()

const normalizeMetaTestMessagingChannel = (value?: unknown): MetaTestMessagingChannel => {
  const channel = cleanMetaTestParameterString(value).toLowerCase().replace(/[^a-z]/g, '')
  if (channel === 'messenger' || channel === 'facebookmessenger' || channel === 'fbmessenger' || channel === 'facebook') {
    return 'messenger'
  }
  if (channel === 'instagram' || channel === 'instagramdm' || channel === 'ig') {
    return 'instagram'
  }
  return defaultMetaTestMessagingChannel
}

const normalizeMetaTestIdentityAliasKey = (key: unknown) => (
  cleanMetaTestParameterString(key).toLowerCase().replace(/[^a-z0-9_]/g, '')
)

const applyMetaTestIdentityAlias = (
  parameters: MetaTestEventParameters,
  key: unknown,
  value: unknown
) => {
  const normalizedKey = normalizeMetaTestIdentityAliasKey(key)
  const field = metaTestIdentityCustomParameterAliases[normalizedKey]
  const cleanValue = cleanMetaTestParameterString(value)
  if (!field || !cleanValue) return false

  if (field === 'messagingChannel') {
    parameters.messagingChannel = normalizeMetaTestMessagingChannel(cleanValue)
    return true
  }

  if (!cleanMetaTestParameterString(parameters[field])) {
    parameters[field] = cleanValue
  }
  return true
}

const normalizeMetaTestCustomParameter = (parameter?: Partial<MetaTestCustomParameter> | null): MetaTestCustomParameter => ({
  ...(cleanMetaTestParameterString(parameter?.id) ? { id: cleanMetaTestParameterString(parameter?.id) } : {}),
  key: cleanMetaTestParameterString(parameter?.key),
  value: cleanMetaTestParameterString(parameter?.value)
})

const normalizeMetaTestEventParameters = (parameters?: MetaTestEventParameters | null): MetaTestEventParameters => {
  const source = parameters && typeof parameters === 'object' ? parameters : {}
  const sourceRecord = source as Record<string, unknown>
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
    'ctwaClid',
    'messagingChannel',
    'pageId',
    'pageScopedUserId',
    'igSid',
    'instagramAccountId'
  ] as MetaTestStringParameterKey[]).forEach((field) => {
    const value = cleanMetaTestParameterString(source[field])
    if (value) {
      normalized[field] = field === 'messagingChannel' ? normalizeMetaTestMessagingChannel(value) : value
    }
  })

  ;[
    ['ctwa_clid', 'ctwaClid'],
    ['referral_ctwa_clid', 'ctwaClid'],
    ['page_id', 'pageId'],
    ['page_scoped_user_id', 'pageScopedUserId'],
    ['psid', 'pageScopedUserId'],
    ['ig_sid', 'igSid'],
    ['ig_scoped_user_id', 'igSid'],
    ['igsid', 'igSid'],
    ['instagram_account_id', 'instagramAccountId'],
    ['ig_account_id', 'instagramAccountId'],
    ['messaging_channel', 'messagingChannel'],
    ['channel', 'messagingChannel']
  ].forEach(([sourceKey, targetKey]) => {
    applyMetaTestIdentityAlias(normalized, targetKey, sourceRecord[sourceKey])
  })

  const custom = Array.isArray(source.custom)
    ? source.custom
      .map(parameter => normalizeMetaTestCustomParameter(parameter))
      .filter((parameter) => !applyMetaTestIdentityAlias(normalized, parameter.key, parameter.value))
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

  if (isWhatsappBusinessMetaTestEvent(eventName)) {
    next.messagingChannel = normalizeMetaTestMessagingChannel(normalized.messagingChannel)
    ;(['ctwaClid', 'pageId', 'pageScopedUserId', 'igSid', 'instagramAccountId'] as MetaTestIdentityParameterKey[]).forEach((field) => {
      const value = cleanMetaTestParameterString(normalized[field])
      if (value) next[field] = value
    })
  }

  if (normalized.custom?.length) next.custom = normalized.custom
  return next
}

export const MetaAdsIntegration: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const routeStep = parseMetaStep(location.pathname)
  const routeConnectedTab = parseMetaConnectedTab(location.pathname)
  const [isLoading, setIsLoading] = useState(true)
  const [credentials, setCredentials] = useState<MetaCredentials>({
    adAccountId: '',
    accessToken: '',
    pixelId: '',
    pageId: '',
    instagramAccountId: '',
    adsConnectionMode: null,
    socialConnectionMode: null,
    hasSplitAds: false,
    hasSplitSocial: false
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
  const [metaConnectionMode, setMetaConnectionMode] = useState<MetaOAuthConnectionMode>(null)
  const [metaOAuthStatus, setMetaOAuthStatus] = useState<MetaOAuthStatus | null>(null)
  const [metaOAuthSession, setMetaOAuthSession] = useState<MetaOAuthSession | null>(null)
  const [metaOAuthSelection, setMetaOAuthSelection] = useState<MetaOAuthFinalizeSelection>({ sessionId: '' })
  const [isConnectingMetaOAuth, setIsConnectingMetaOAuth] = useState(false)
  const [isLoadingAuthorizedMetaAssets, setIsLoadingAuthorizedMetaAssets] = useState(false)
  const [showManualConnection, setShowManualConnection] = useState(false)
  const [isSavingToken, setIsSavingToken] = useState(false)
  const [isRevealingAccessToken, setIsRevealingAccessToken] = useState(false)
  const [isSavingWizardConfig, setIsSavingWizardConfig] = useState(false)
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
  const [wizardRefreshNonce, setWizardRefreshNonce] = useState(0)
  const [activeMetaTab, setActiveMetaTab] = useState<MetaConnectedTab>(routeConnectedTab || 'cuenta')
  const [metaWebhookInfo, setMetaWebhookInfo] = useState<MetaWebhookInfo | null>(null)
  const [metaDeveloperSetup, setMetaDeveloperSetup] = useState<MetaDeveloperSetup | null>(null)
  const [messengerUserToken, setMessengerUserToken] = useState('')
  const [isSavingMessengerUserToken, setIsSavingMessengerUserToken] = useState(false)
  const accessTokenInputRef = useRef<HTMLInputElement>(null)
  const handledMetaOAuthHandoffs = useRef(new Set<string>())
  const credentialsLoadVersion = useRef(0)
  const metaStatusLoadVersion = useRef(0)
  const loadedMetaOAuthAssetsForConnection = useRef('')
  const loadedManualMetaHelp = useRef(false)

  const { showToast } = useNotification()
  const [includeMetaPixel, setIncludeMetaPixel, savingPixelPref] = useAppConfig('include_meta_pixel', true)
  const [messengerMessagingEnabled, setMessengerMessagingEnabled, savingMessengerMessaging] = useAppConfig('meta_messenger_messaging_enabled', false)
  const [instagramMessagingEnabled, setInstagramMessagingEnabled, savingInstagramMessaging] = useAppConfig('meta_instagram_messaging_enabled', false)
  const [facebookCommentsEnabled, setFacebookCommentsEnabled, savingFacebookComments] = useAppConfig('meta_facebook_comments_enabled', false)
  const [instagramCommentsEnabled, setInstagramCommentsEnabled, savingInstagramComments] = useAppConfig('meta_instagram_comments_enabled', false)
  const [metaTestEventCode, setMetaTestEventCode, savingMetaTestEventCode] = useAppConfig('meta_test_event_code', '')
  const [metaTestEventCodeSetAt, setMetaTestEventCodeSetAt] = useAppConfig('meta_test_event_code_set_at', '')
  const [accountCurrency] = useAccountCurrency()

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

  const syncConnectedMetaChannelDefaults = async ({
    previousPageId = '',
    nextPageId = '',
    previousInstagramAccountId = '',
    nextInstagramAccountId = ''
  }: {
    previousPageId?: string
    nextPageId?: string
    previousInstagramAccountId?: string
    nextInstagramAccountId?: string
  }) => {
    const oldPageId = previousPageId.trim()
    const newPageId = nextPageId.trim()
    const oldInstagramAccountId = previousInstagramAccountId.trim()
    const newInstagramAccountId = nextInstagramAccountId.trim()
    const updates: Array<Promise<void>> = []

    if (newPageId && newPageId !== oldPageId) {
      updates.push(setMessengerMessagingEnabled(true), setFacebookCommentsEnabled(true))
    } else if (!newPageId && oldPageId) {
      updates.push(setMessengerMessagingEnabled(false), setFacebookCommentsEnabled(false))
    }

    if (newPageId && newInstagramAccountId && (
      newInstagramAccountId !== oldInstagramAccountId ||
      newPageId !== oldPageId
    )) {
      updates.push(setInstagramMessagingEnabled(true), setInstagramCommentsEnabled(true))
    } else if (!newInstagramAccountId && oldInstagramAccountId) {
      updates.push(setInstagramMessagingEnabled(false), setInstagramCommentsEnabled(false))
    }

    if (updates.length > 0) {
      await Promise.all(updates)
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

  useEffect(() => {
    const routeSegment = getMetaAdsRouteSegment(location.pathname)
    if (routeSegment === 'ads') {
      navigate(buildMetaAdsConnectedTabPath('cuenta'), { replace: true })
      return
    }
    if (['social', 'mensajes'].includes(routeSegment)) {
      navigate(buildMetaAdsConnectedTabPath('social'), { replace: true })
      return
    }

    if (routeConnectedTab) {
      setActiveMetaTab(current => current === routeConnectedTab ? current : routeConnectedTab)
    }
  }, [location.pathname, navigate, routeConnectedTab])

  // El código de prueba vive inline (sin modal): siembra el borrador con el
  // código guardado en la carga inicial y cada vez que cambie el guardado.
  useEffect(() => {
    setMetaTestDraftCode(metaTestEventCode || '')
  }, [metaTestEventCode])

  const loadMetaDeveloperSetup = async () => {
    try {
      const response = await fetch('/api/meta/social/messaging/setup')
      const data = await response.json()
      if (data?.success) {
        setMetaDeveloperSetup({
          appId: data.appId || '',
          businessId: data.businessId || '',
          messengerUrl: data.messengerUrl || '',
          instagramUrl: data.instagramUrl || '',
          messengerUserTokenConfigured: data.messengerUserTokenConfigured === true
        })
      }
    } catch {
      setMetaDeveloperSetup(null)
    }
  }

  // La ayuda de Developers sólo existe para la conexión manual. Cargarla desde
  // Cuenta Meta o durante OAuth era ruido y, en configuraciones heredadas sin
  // IDs guardados, podía provocar validaciones de Graph que el usuario no pidió.
  useEffect(() => {
    const usingOAuthSocial = metaOAuthStatus?.oauth.connected === true
      || credentials.hasSplitSocial
      || (
        metaOAuthStatus === null
        && !credentials.hasSplitAds
        && !credentials.hasSplitSocial
        && (metaConnectionMode === 'oauth_user' || metaConnectionMode === 'oauth_bisu')
      )
    if (activeMetaTab !== 'social' || isLoading || usingOAuthSocial || loadedManualMetaHelp.current) return

    loadedManualMetaHelp.current = true
    let cancelled = false
    const loadManualMetaHelp = async () => {
      try {
        const [webhookResponse] = await Promise.all([
          fetch('/api/meta/webhook-info'),
          loadMetaDeveloperSetup()
        ])
        const data = await webhookResponse.json()
        if (!cancelled && data?.success && data.data) {
          setMetaWebhookInfo({
            webhookUrl: data.data.webhookUrl || '',
            verifyToken: data.data.verifyToken || '',
            fields: Array.isArray(data.data.fields) ? data.data.fields : []
          })
        }
      } catch {
        // La ayuda manual simplemente queda oculta si sus datos no cargan.
      }
    }
    void loadManualMetaHelp()
    return () => { cancelled = true }
  }, [
    activeMetaTab,
    credentials.hasSplitAds,
    credentials.hasSplitSocial,
    isLoading,
    metaConnectionMode,
    metaOAuthStatus
  ])

  const goToMetaStep = (stepIndex: number, options?: { replace?: boolean }) => {
    const nextStep = Math.max(0, Math.min(stepIndex, metaStepSlugs.length - 1))
    setActiveStep(nextStep)
    navigate(buildMetaAdsSettingsPath(nextStep), { replace: options?.replace })
  }

  const requestWizardRefresh = () => {
    setWizardRefreshNonce(current => current + 1)
  }

  const handleSelectMetaTab = (tab: MetaConnectedTab) => {
    if (tab !== 'cuenta') {
      setShowManualConnection(false)
      setIsEditingMetaConfig(false)
      setActiveStep(0)
    }
    setActiveMetaTab(tab)
    navigate(buildMetaAdsConnectedTabPath(tab))
  }

  const hasSplitAdsConnection = credentials.hasSplitAds
  const hasSplitSocialConnection = credentials.hasSplitSocial
  const isLegacyOAuthConnection = metaOAuthStatus?.oauth.connected === true
    || (metaOAuthStatus === null
      && !hasSplitAdsConnection
      && !hasSplitSocialConnection
      && (metaConnectionMode === 'oauth_bisu' || metaConnectionMode === 'oauth_user'))
  const isOAuthConnection = isLegacyOAuthConnection || hasSplitAdsConnection || hasSplitSocialConnection
  const isSocialOAuthConnection = isLegacyOAuthConnection || hasSplitSocialConnection

  const buildUnavailableMetaOAuthStatus = (error: unknown): MetaOAuthStatus => ({
    available: false,
    mode: 'redirect',
    connectUrl: '',
    appId: '',
    configId: '',
    reviewPending: true,
    connectionMode: null,
    manualConfigured: Boolean(credentials.accessToken),
    oauth: {
      connected: false,
      validated: false,
      userId: '',
      userName: '',
      appId: '',
      businessId: '',
      grantedScopes: [],
      missingScopes: [],
      granularScopes: [],
      tokenExpiresAt: null,
      dataAccessExpiresAt: null,
      relayStatus: 'inactive'
    },
    error: error instanceof Error ? error.message : 'El Installer no está disponible.'
  })

  const loadMetaOAuthStatus = async () => {
    const loadVersion = ++metaStatusLoadVersion.current
    try {
      const status = await metaOAuthService.getStatus()
      if (loadVersion !== metaStatusLoadVersion.current) return null
      setMetaOAuthStatus(status)
      if (status.connectionMode) setMetaConnectionMode(status.connectionMode)
      return status
    } catch (error) {
      const status = buildUnavailableMetaOAuthStatus(error)
      if (loadVersion === metaStatusLoadVersion.current) setMetaOAuthStatus(status)
      return null
    }
  }

  const selectionFromMetaOAuthSession = (session: MetaOAuthSession): MetaOAuthFinalizeSelection => {
    const defaultAdAccount = session.adAccounts.find(account => (
      account.id.replace(/^act_/, '') === String(session.defaults.adAccountId || '').replace(/^act_/, '')
    ))
    const selectedAdAccount = defaultAdAccount || null
    const selectedPixel = session.datasets.find(pixel => pixel.id === session.defaults.pixelId) || null

    const businessId = selectedPixel?.businessId || selectedAdAccount?.businessId || session.defaults.businessId || ''
    const selectedPage = session.pages.find(page => page.id === session.defaults.pageId) || null
    const selectedInstagramAccounts = selectedPage?.instagramAccounts || []
    const selectedInstagram = selectedInstagramAccounts.find(account => account.id === session.defaults.instagramAccountId) || null

    return {
      sessionId: session.sessionId,
      businessId: businessId || selectedPage?.businessId || undefined,
      adAccountId: selectedAdAccount?.id.replace(/^act_/, '') || '',
      pixelId: selectedPixel?.id || '',
      pageId: selectedPage?.id || '',
      instagramAccountId: selectedInstagram?.id || ''
    }
  }

  const applyMetaOAuthSession = (session: MetaOAuthSession) => {
    const selection = selectionFromMetaOAuthSession(session)
    setMetaOAuthSession(session)
    setMetaOAuthSelection(selection)
    setShowManualConnection(false)
    return selection
  }

  const buildMetaOAuthSelection = (
    session: MetaOAuthSession,
    current: MetaOAuthFinalizeSelection,
    patch: Partial<MetaOAuthFinalizeSelection>
  ): MetaOAuthFinalizeSelection => {
    const next = { ...current, ...patch, sessionId: session.sessionId }
    const selectedAdAccount = session.adAccounts.find(account => (
      account.id.replace(/^act_/, '') === String(next.adAccountId || '').replace(/^act_/, '')
    ))
    const selectedDataset = session.datasets.find(dataset => dataset.id === next.pixelId)
    const selectedPage = session.pages.find(page => page.id === next.pageId)
    const instagramIsLinked = selectedPage?.instagramAccounts.some(account => account.id === next.instagramAccountId)

    return {
      sessionId: session.sessionId,
      businessId: selectedDataset?.businessId || selectedAdAccount?.businessId || selectedPage?.businessId || undefined,
      adAccountId: selectedAdAccount?.id.replace(/^act_/, '') || '',
      pixelId: selectedDataset?.id || '',
      pageId: selectedPage?.id || '',
      instagramAccountId: instagramIsLinked ? next.instagramAccountId || '' : ''
    }
  }

  const saveMetaOAuthAssetSelection = async (patch: Partial<MetaOAuthFinalizeSelection>) => {
    const session = metaOAuthSession
    if (!session || isSavingWizardConfig) return

    const previousSelection = metaOAuthSelection
    const nextSelection = buildMetaOAuthSelection(session, previousSelection, patch)
    if (
      nextSelection.adAccountId === previousSelection.adAccountId &&
      nextSelection.pixelId === previousSelection.pixelId &&
      nextSelection.pageId === previousSelection.pageId &&
      nextSelection.instagramAccountId === previousSelection.instagramAccountId
    ) return

    setMetaOAuthSelection(nextSelection)
    setIsSavingWizardConfig(true)
    try {
      const result = await metaOAuthService.finalize(nextSelection)
      const nextPageId = result.selected.pageId || ''
      const nextInstagramAccountId = result.selected.instagramAccountId || ''
      const selectedAdAccount = session.adAccounts.find(account => (
        account.id.replace(/^act_/, '') === String(result.selected.adAccountId || '').replace(/^act_/, '')
      )) || null
      const selectedDataset = session.datasets.find(dataset => dataset.id === result.selected.pixelId) || null
      const selectedPage = session.pages.find(page => page.id === nextPageId) || null
      const selectedInstagram = selectedPage?.instagramAccounts.find(account => account.id === nextInstagramAccountId) || null

      setCredentials(current => ({
        ...current,
        adAccountId: result.selected.adAccountId || '',
        pixelId: result.selected.pixelId || '',
        pageId: nextPageId,
        instagramAccountId: nextInstagramAccountId,
        adsConnectionMode: result.connectionMode,
        socialConnectionMode: result.connectionMode
      }))
      setSavedPageId(nextPageId)
      setSavedInstagramAccountId(nextInstagramAccountId)
      setMetaConnectionMode(result.connectionMode)
      setMetaOAuthStatus(current => current ? {
        ...current,
        connectionMode: result.connectionMode,
        selected: result.selected,
        selectedAssets: {
          adAccount: selectedAdAccount ? { id: selectedAdAccount.id.replace(/^act_/, ''), name: selectedAdAccount.name } : null,
          dataset: selectedDataset ? { id: selectedDataset.id, name: selectedDataset.name } : null,
          page: selectedPage ? { id: selectedPage.id, name: selectedPage.name } : null,
          instagram: selectedInstagram ? {
            id: selectedInstagram.id,
            name: selectedInstagram.username ? `@${selectedInstagram.username}` : selectedInstagram.name,
            ...(selectedInstagram.username ? { username: selectedInstagram.username } : {})
          } : null
        },
        oauth: {
          ...current.oauth,
          connected: true,
          validated: true,
          relayStatus: result.relay.status as MetaOAuthStatus['oauth']['relayStatus']
        }
      } : current)
      if (result.session) {
        applyMetaOAuthSession(result.session)
      } else {
        const refreshedSession = await metaOAuthService.reconfigure()
        applyMetaOAuthSession(refreshedSession)
      }
    } catch (error) {
      setMetaOAuthSelection(previousSelection)
      showToast('error', 'No se pudo guardar el activo', error instanceof Error ? error.message : 'Inténtalo de nuevo.')
    } finally {
      setIsSavingWizardConfig(false)
    }
  }

  const completeMetaOAuthHandoff = async (handoffToken: string) => {
    setIsConnectingMetaOAuth(true)
    try {
      const result = await metaOAuthService.complete({ handoffToken })
      const nextPageId = result.selected.pageId || ''
      const nextInstagramAccountId = result.selected.instagramAccountId || ''
      setSavedPageId(nextPageId)
      setSavedInstagramAccountId(nextInstagramAccountId)
      setCredentials(current => ({
        ...current,
        adAccountId: result.selected.adAccountId || '',
        pixelId: result.selected.pixelId || '',
        pageId: nextPageId,
        instagramAccountId: nextInstagramAccountId,
        adsConnectionMode: result.connectionMode,
        socialConnectionMode: result.connectionMode
      }))
      setMetaConnectionMode(result.connectionMode)
      await loadMetaOAuthStatus()
      if (result.session) {
        applyMetaOAuthSession(result.session)
      } else {
        applyMetaOAuthSession(await metaOAuthService.reconfigure())
      }
      setActiveMetaTab('cuenta')
      navigate(buildMetaAdsConnectedTabPath('cuenta'), { replace: true })
      showToast('success', 'Meta autorizado', 'Elige los activos en la tabla. Cada cambio se guarda automáticamente.')
    } catch (error) {
      // Si la respuesta se perdió después del commit, el estado local es la
      // fuente de verdad. Consultarlo evita pedir al usuario que recargue o que
      // repita un handoff de un solo uso que ya terminó correctamente.
      const status = await loadMetaOAuthStatus().catch(() => null)
      await Promise.allSettled([loadCredentials(), loadMetaDeveloperSetup()])
      if (status?.oauth.connected) {
        try {
          applyMetaOAuthSession(await metaOAuthService.reconfigure())
        } catch {
          setMetaOAuthSession(null)
          setMetaOAuthSelection({ sessionId: '' })
        }
        invalidateIntegrationsStatus()
        showToast('success', 'Meta conectado', 'La conexión terminó correctamente.')
      } else {
        showToast('error', 'No se pudo conectar Meta', error instanceof Error ? error.message : 'La autorización no se pudo completar.')
      }
    } finally {
      setIsConnectingMetaOAuth(false)
    }
  }

  const startMetaAuthorization = async () => {
    setIsConnectingMetaOAuth(true)
    try {
      const status = metaOAuthStatus || await loadMetaOAuthStatus()
      if (!status?.available || status.mode !== 'redirect') {
        throw new Error(status?.error || 'El flujo OAuth todavía no está disponible en el Installer.')
      }
      const connect = await metaOAuthService.createConnectUrl()
      if (!connect.connectUrl) throw new Error('El Installer no devolvió la URL segura de Meta.')
      window.location.assign(connect.connectUrl)
    } catch (error) {
      setIsConnectingMetaOAuth(false)
      showToast('error', 'No se pudo abrir Meta', error instanceof Error ? error.message : 'Usa la conexión manual mientras revisamos el Installer.')
    }
  }

  const loadAuthorizedMetaAssets = async ({ silent = true } = {}) => {
    setIsLoadingAuthorizedMetaAssets(true)
    try {
      const session = await metaOAuthService.reconfigure()
      applyMetaOAuthSession(session)
    } catch (error) {
      if (!silent) {
        showToast(
          'warning',
          'Autoriza Meta una vez más',
          error instanceof Error ? error.message : 'Meta no devolvió el inventario autorizado.'
        )
      }
    } finally {
      setIsLoadingAuthorizedMetaAssets(false)
    }
  }

  useEffect(() => {
    void loadMetaOAuthStatus()
  }, [])

  useEffect(() => {
    if (activeMetaTab !== 'cuenta' || !isLegacyOAuthConnection || metaOAuthSession || isLoadingAuthorizedMetaAssets) return
    const connectionKey = metaOAuthStatus?.oauth.connectionId || metaOAuthStatus?.oauth.userId || 'meta-connected'
    if (loadedMetaOAuthAssetsForConnection.current === connectionKey) return
    loadedMetaOAuthAssetsForConnection.current = connectionKey
    void loadAuthorizedMetaAssets({ silent: true })
  }, [
    activeMetaTab,
    isLegacyOAuthConnection,
    isLoadingAuthorizedMetaAssets,
    metaOAuthSession,
    metaOAuthStatus?.oauth.connectionId,
    metaOAuthStatus?.oauth.userId
  ])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const fragmentParams = new URLSearchParams(location.hash.replace(/^#/, ''))
    const readOAuthValue = (key: string) => fragmentParams.get(key) || params.get(key) || ''
    const oauthResult = readOAuthValue('meta_oauth')
    const handoffToken = readOAuthValue('meta_oauth_handoff_token') || readOAuthValue('meta_oauth_handoff')
    const integrationKindValue = readOAuthValue('meta_oauth_kind')
      || readOAuthValue('meta_oauth_integration_kind')
      || readOAuthValue('integration_kind')
    const message = readOAuthValue('meta_oauth_message')
    const errorCode = readOAuthValue('meta_oauth_error_code')
    if (!oauthResult && !handoffToken) return

    const oauthKeys = [
      'meta_oauth',
      'meta_oauth_handoff_token',
      'meta_oauth_handoff',
      'meta_oauth_kind',
      'meta_oauth_integration_kind',
      'integration_kind',
      'meta_oauth_message',
      'meta_oauth_error_code'
    ]
    oauthKeys.forEach(key => {
      params.delete(key)
      fragmentParams.delete(key)
    })
    navigate({
      pathname: location.pathname,
      search: params.toString() ? `?${params.toString()}` : '',
      hash: fragmentParams.toString() ? `#${fragmentParams.toString()}` : ''
    }, { replace: true })

    if (oauthResult === 'error' || !handoffToken || (integrationKindValue && integrationKindValue !== 'legacy')) {
      showToast(
        'error',
        'Meta no se conectó',
        message || (errorCode === 'meta_scopes_missing'
          ? 'Meta no concedió todos los permisos. En Editar configuración activa todos los accesos y vuelve a conectar.'
          : 'La autorización fue cancelada o Meta no devolvió acceso.')
      )
      return
    }

    if (handledMetaOAuthHandoffs.current.has(handoffToken)) return
    handledMetaOAuthHandoffs.current.add(handoffToken)
    void completeMetaOAuthHandoff(handoffToken)
  }, [location.hash, location.pathname, location.search, navigate])

  const loadCredentials = async () => {
    const loadVersion = ++credentialsLoadVersion.current
    setIsLoading(true)
    try {
      const response = await fetch('/api/meta/custom-values')
      const data = await response.json()
      if (loadVersion !== credentialsLoadVersion.current) return

      if (data.success && data.data) {
        const connectionMode = data.data.connectionMode || data.data.connection_mode || data.connectionMode || null
        setMetaConnectionMode(connectionMode)
        setCredentials({
          adAccountId: data.data.adAccountId || '',
          accessToken: data.data.accessToken || '',
          pixelId: data.data.pixelId || '',
          pageId: data.data.pageId || '',
          instagramAccountId: data.data.instagramAccountId || '',
          adsConnectionMode: data.data.adsConnectionMode || null,
          socialConnectionMode: data.data.socialConnectionMode || null,
          hasSplitAds: data.data.hasSplitAds === true,
          hasSplitSocial: data.data.hasSplitSocial === true
        })
        setSavedPageId(data.data.pageId || '')
        setSavedInstagramAccountId(data.data.instagramAccountId || '')

        const isOAuthConnection = connectionMode === 'oauth_user' || connectionMode === 'oauth_bisu'
        if (data.data.accessToken && !isOAuthConnection) {
          // Una conexión guardada se consulta server-side. El secreto no vuelve
          // al navegador sólo para poblar selectores de activos. OAuth conserva
          // su inventario autorizado localmente para alimentar los selectores
          // de la tabla sin volver a consultar Graph.
          const tokenToUse = isMaskedSecretValue(data.data.accessToken) ? '' : data.data.accessToken
          setRealAccessToken(tokenToUse)
          await fetchAdAccounts(tokenToUse, data.data.adAccountId, { silent: true })
          await fetchPages(tokenToUse, data.data.pageId, { silent: true })
          await fetchInstagramAccounts(tokenToUse, data.data.instagramAccountId, {
            silent: true,
            pageId: data.data.pageId || ''
          })

          if (data.data.adAccountId) {
            const accountIdWithPrefix = normalizeMetaAdAccountIdForLookup(data.data.adAccountId)
            await fetchPixels(accountIdWithPrefix, tokenToUse, data.data.pixelId, { silent: true })
          }
        }
      }
    } catch {
    } finally {
      if (loadVersion === credentialsLoadVersion.current) setIsLoading(false)
    }
  }

  const fetchAdAccounts = async (
    token = '',
    savedAdAccountId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
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
    token = '',
    savedPixelId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
    if (!adAccountId) {
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
    token = '',
    savedPageId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
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
    token = '',
    savedInstagramAccountId?: string,
    options: MetaWizardRefreshOptions & { pageId?: string } = {}
  ): Promise<FetchCollectionResult> => {
    setIsLoadingInstagramAccounts(true)
    try {
      const result = await campaignsService.getConnectedSocialProfiles({
        accessToken: token,
        pageId: options.pageId ?? credentials.pageId,
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

  const getUsableAccessToken = async (_options: MetaWizardRefreshOptions = {}) => {
    const typedToken = !isMaskedSecretValue(credentials.accessToken)
      ? credentials.accessToken.trim()
      : ''

    if (typedToken && typedToken !== realAccessToken) return typedToken
    if (realAccessToken) return realAccessToken
    if (typedToken) return typedToken
    return isMaskedSecretValue(credentials.accessToken) ? credentials.accessToken : ''
  }

  const refreshMetaWizardStep = async (
    stepIndex = activeStep,
    options: MetaWizardRefreshOptions = {}
  ) => {
    if (metaOAuthSession) return
    const token = await getUsableAccessToken(options)
    if (!token && !hasManualAccessToken) return
    const assetToken = isMaskedSecretValue(token) ? '' : token

    const step = Math.max(0, Math.min(stepIndex, metaStepSlugs.length - 1))
    const currentAdAccountId = credentials.adAccountId
    const currentPixelId = credentials.pixelId
    const currentPageId = credentials.pageId
    const currentInstagramAccountId = credentials.instagramAccountId
    const adAccountIdForLookup = normalizeMetaAdAccountIdForLookup(currentAdAccountId)

    if (step === 0) {
      await Promise.all([
        fetchAdAccounts(assetToken, currentAdAccountId, options),
        fetchPages(assetToken, currentPageId, options),
        fetchInstagramAccounts(assetToken, currentInstagramAccountId, { ...options, pageId: currentPageId }),
        adAccountIdForLookup
          ? fetchPixels(adAccountIdForLookup, assetToken, currentPixelId, options)
          : Promise.resolve({ success: false, count: 0 })
      ])
      return
    }

    if (step === 1) {
      await fetchAdAccounts(assetToken, currentAdAccountId, options)
      return
    }

    if (step === 2) {
      if (!adAccountIdForLookup) return
      await fetchPixels(adAccountIdForLookup, assetToken, currentPixelId, options)
      return
    }

    if (step === 3) {
      await Promise.all([
        fetchPages(assetToken, currentPageId, options),
        fetchInstagramAccounts(assetToken, currentInstagramAccountId, { ...options, pageId: currentPageId })
      ])
    }
  }

  const handleSelectAdAccount = (account: AdAccount) => {
    const accountIdWithoutPrefix = account.id.replace(/^act_/, '')
    const oauthAccount = metaOAuthSession?.adAccounts.find(item => (
      item.id.replace(/^act_/, '') === accountIdWithoutPrefix
    ))
    const onlyOAuthPixelId = oauthAccount?.pixels.length === 1 ? oauthAccount.pixels[0].id : ''
    setCredentials(prev => ({
      ...prev,
      adAccountId: accountIdWithoutPrefix,
      pixelId: prev.adAccountId && prev.adAccountId !== accountIdWithoutPrefix
        ? onlyOAuthPixelId
        : prev.pixelId || onlyOAuthPixelId
    }))
    if (credentials.adAccountId && credentials.adAccountId !== accountIdWithoutPrefix) {
      setPixels([])
    }
    if (metaOAuthSession) {
      setPixels((oauthAccount?.pixels || []).map(pixel => ({
        id: pixel.id,
        name: pixel.name,
        creation_time: '',
        last_fired_time: '',
        adAccountId: accountIdWithoutPrefix
      })))
    }
  }

  const handleSelectPixel = (pixel: Pixel) => {
    setCredentials(prev => ({ ...prev, pixelId: pixel.id }))
  }

  const handleSelectInstagramAccount = (account: ConnectedSocialProfile) => {
    setCredentials(prev => ({ ...prev, instagramAccountId: account.sourceId }))
  }

  const handleRemoveCredential = (field: keyof MetaCredentials) => {
    if (field === 'accessToken') {
      setCredentials({
        adAccountId: '',
        accessToken: '',
        pixelId: '',
        pageId: '',
        instagramAccountId: '',
        adsConnectionMode: null,
        socialConnectionMode: null,
        hasSplitAds: false,
        hasSplitSocial: false
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
      requestWizardRefresh()
    } else if (field === 'pixelId') {
      setCredentials(prev => ({
        ...prev,
        pixelId: ''
      }))
      goToMetaStep(2, { replace: true })
      requestWizardRefresh()
    } else if (field === 'pageId') {
      setCredentials(prev => ({ ...prev, pageId: '' }))
      requestWizardRefresh()
    } else if (field === 'instagramAccountId') {
      setCredentials(prev => ({ ...prev, instagramAccountId: '' }))
      requestWizardRefresh()
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
    if (isOAuthConnection) {
      showToast('warning', 'Token protegido por OAuth', 'Para usar el método manual pega un System User Token nuevo; Ristak nunca revela el acceso OAuth.')
      return
    }
    const revealedToken = await getUsableAccessToken({ silent: false })
    if (!revealedToken) return

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
    invalidateIntegrationsStatus()
    setCredentials({
      adAccountId: '',
      accessToken: '',
      pixelId: '',
      pageId: '',
      instagramAccountId: '',
      adsConnectionMode: null,
      socialConnectionMode: null,
      hasSplitAds: false,
      hasSplitSocial: false
    })
    setAdAccounts([])
    setPixels([])
    setPages([])
    setInstagramAccounts([])
    setRealAccessToken('')
    setMetaConnectionMode(null)
    setMetaOAuthSession(null)
    setMetaOAuthSelection({ sessionId: '' })
    loadedMetaOAuthAssetsForConnection.current = ''
    setShowManualConnection(false)
    setMetaDeveloperSetup(null)
    setMessengerUserToken('')
    setSavedPageId('')
    setSavedInstagramAccountId('')
    setActiveStep(0)
    setActiveMetaTab('cuenta')
    navigate(buildMetaAdsConnectedTabPath('cuenta'), { replace: true })
    setIsEditingMetaConfig(false)
    void loadMetaOAuthStatus()
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
      await fetchInstagramAccounts(credentials.accessToken, credentials.instagramAccountId, {
        silent: true,
        pageId: credentials.pageId
      })

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

  const saveMetaWizardConfig = async () => {
    if (!credentials.adAccountId) {
      showToast('warning', 'Falta cuenta de anuncios', 'Selecciona una cuenta de anuncios para guardar Meta')
      return { saved: false, syncStarted: false }
    }

    if (isLegacyOAuthConnection && !showManualConnection) {
      showToast('warning', 'Reconecta Meta para cambiar activos', 'Usa “Reconectar con Meta” o abre el método manual y pega un token nuevo.')
      return { saved: false, syncStarted: false }
    }

    if (isLegacyOAuthConnection && isMaskedSecretValue(credentials.accessToken)) {
      showToast('warning', 'Pega un token manual nuevo', 'El token OAuth no se puede revelar ni convertir en una conexión manual.')
      return { saved: false, syncStarted: false }
    }

    const accessToken = await getUsableAccessToken({ silent: false })
    if (!accessToken) return { saved: false, syncStarted: false }

    setIsSavingWizardConfig(true)

    try {
      const previousPageId = savedPageId
      const previousInstagramAccountId = savedInstagramAccountId
      const nextPageId = credentials.pageId || ''
      const nextInstagramAccountId = credentials.instagramAccountId || ''
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: credentials.adAccountId,
          accessToken,
          pixelId: credentials.pixelId || '',
          pageId: credentials.pageId || '',
          instagramAccountId: credentials.instagramAccountId || ''
        })
      })

      const data = await response.json()

      if (data.success) {
        invalidateIntegrationsStatus()
        const autoPixelId = String(data.data?.pixelId || '').trim()
        const nextPixelId = credentials.pixelId || autoPixelId

        await syncConnectedMetaChannelDefaults({
          previousPageId,
          nextPageId,
          previousInstagramAccountId,
          nextInstagramAccountId
        }).catch(() => {
          showToast(
            'warning',
            'Meta conectado, revisa switches',
            'No se pudieron actualizar automáticamente todos los switches de mensajes y comentarios.'
          )
        })

        setSavedPageId(nextPageId)
        setSavedInstagramAccountId(nextInstagramAccountId)
        if (nextPixelId && nextPixelId !== credentials.pixelId) {
          setCredentials(prev => ({ ...prev, pixelId: nextPixelId }))
        }
        await loadCredentials()
        await loadMetaDeveloperSetup()
        return { saved: true, syncStarted: data.data?.syncStarted === true }
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar Meta')
        return { saved: false, syncStarted: false }
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar Meta')
      return { saved: false, syncStarted: false }
    } finally {
      setIsSavingWizardConfig(false)
    }
  }

  const handleFinishWizard = async () => {
    if (!hasAdAccount) {
      showToast('warning', 'Falta cuenta de anuncios', 'Selecciona una cuenta de anuncios para terminar')
      return
    }

    const result = await saveMetaWizardConfig()
    if (!result.saved) return

    setIsEditingMetaConfig(false)
    setShowManualConnection(false)
    setActiveMetaTab('cuenta')
    navigate(buildMetaAdsConnectedTabPath('cuenta'), { replace: true })
    const missingPermissions = 'missingPermissions' in result && Array.isArray(result.missingPermissions)
      ? result.missingPermissions
      : []
    const relayStatus = 'relayStatus' in result ? result.relayStatus : 'registered'
    const hasOAuthWarning = missingPermissions.length > 0 || relayStatus === 'error'
    showToast(
      hasOAuthWarning ? 'warning' : 'success',
      hasOAuthWarning ? 'Meta conectado con pendientes' : 'Meta conectado',
      missingPermissions.length
        ? `La cuenta quedó guardada, pero Meta todavía no concedió: ${missingPermissions.join(', ')}.`
        : relayStatus === 'error'
          ? 'Publicidad quedó conectada, pero Messenger, Instagram y comentarios necesitan reintentar el relay.'
          : result.syncStarted
            ? 'Los anuncios ya se están sincronizando y las redes sociales quedaron enlazadas.'
            : 'La cuenta y sus activos quedaron listos.'
    )
  }

  const handleEditMetaConfig = () => {
    if (isLegacyOAuthConnection) {
      setCredentials(previous => ({
        ...previous,
        accessToken: '',
        adAccountId: '',
        pixelId: '',
        pageId: '',
        instagramAccountId: ''
      }))
      setRealAccessToken('')
    }
    setShowManualConnection(true)
    setIsEditingMetaConfig(true)
    goToMetaStep(0, { replace: true })
    requestWizardRefresh()
  }

  const handleDisconnectMetaConfig = async () => {
    setIsDisconnectingMeta(true)

    try {
      if (hasSplitAdsConnection || hasSplitSocialConnection) {
        const previousResults = []
        if (hasSplitSocialConnection) {
          previousResults.push(await metaOAuthService.disconnectPreviousIntegration('social'))
        }
        if (hasSplitAdsConnection) {
          previousResults.push(await metaOAuthService.disconnectPreviousIntegration('ads'))
        }

        const restoredLegacy = previousResults.some(result => result.restoredLegacy === true)
        const runtimeWarning = previousResults
          .flatMap(result => result.runtimeWarnings || (result.runtimeWarning ? [result.runtimeWarning] : []))
          .find(Boolean) || ''
        const configKeys = [
          'meta_messenger_messaging_enabled',
          'meta_instagram_messaging_enabled',
          'meta_facebook_comments_enabled',
          'meta_instagram_comments_enabled'
        ]
        const restoredConfigResponse = await fetch(`/api/config?keys=${encodeURIComponent(configKeys.join(','))}`)
        const restoredConfigData = await restoredConfigResponse.json().catch(() => ({}))
        const restoredConfig = restoredConfigData?.config || {}
        if (restoredConfigResponse.ok) {
          await Promise.all([
            setMessengerMessagingEnabled(parseMetaBooleanConfig(restoredConfig.meta_messenger_messaging_enabled)),
            setInstagramMessagingEnabled(parseMetaBooleanConfig(restoredConfig.meta_instagram_messaging_enabled)),
            setFacebookCommentsEnabled(parseMetaBooleanConfig(restoredConfig.meta_facebook_comments_enabled)),
            setInstagramCommentsEnabled(parseMetaBooleanConfig(restoredConfig.meta_instagram_comments_enabled))
          ])
        }
        setIsDisconnectModalOpen(false)
        await Promise.all([loadCredentials(), loadMetaDeveloperSetup(), loadMetaOAuthStatus()])
        showToast(
          runtimeWarning ? 'warning' : 'success',
          runtimeWarning ? 'Conexión anterior desconectada con una tarea pendiente' : 'Conexión anterior desconectada',
          restoredLegacy
            ? 'Ristak volvió al método manual que ya tenías guardado.'
            : runtimeWarning || 'La conexión OAuth anterior se eliminó sin tocar el nuevo login unificado.'
        )
        return
      }

      const response = await fetch('/api/meta/config', {
        method: 'DELETE'
      })
      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No se pudo eliminar la configuración')
      }

      const restoredFallback = data.data?.restoredManual === true || data.data?.restoredSplitSocial === true
      if (restoredFallback) {
        const configKeys = [
          'meta_messenger_messaging_enabled',
          'meta_instagram_messaging_enabled',
          'meta_facebook_comments_enabled',
          'meta_instagram_comments_enabled'
        ]
        const restoredConfigResponse = await fetch(`/api/config?keys=${encodeURIComponent(configKeys.join(','))}`)
        const restoredConfigData = await restoredConfigResponse.json().catch(() => ({}))
        const restoredConfig = restoredConfigData?.config || {}

        if (restoredConfigResponse.ok) {
          await Promise.all([
            setMessengerMessagingEnabled(parseMetaBooleanConfig(restoredConfig.meta_messenger_messaging_enabled)),
            setInstagramMessagingEnabled(parseMetaBooleanConfig(restoredConfig.meta_instagram_messaging_enabled)),
            setFacebookCommentsEnabled(parseMetaBooleanConfig(restoredConfig.meta_facebook_comments_enabled)),
            setInstagramCommentsEnabled(parseMetaBooleanConfig(restoredConfig.meta_instagram_comments_enabled))
          ])
        }

        setMetaOAuthSession(null)
        setMetaOAuthSelection({ sessionId: '' })
        setShowManualConnection(false)
        setIsEditingMetaConfig(false)
        setIsDisconnectModalOpen(false)
        await Promise.all([
          loadCredentials(),
          loadMetaDeveloperSetup(),
          loadMetaOAuthStatus()
        ])
        const runtimeWarning = data.data?.runtimeWarning || data.data?.runtimeWarnings?.[0] || ''
        showToast(
          runtimeWarning ? 'warning' : 'success',
          runtimeWarning ? 'Conexión anterior restaurada con una tarea pendiente' : 'Conexión anterior restaurada',
          runtimeWarning
            ? `El login unificado se quitó, pero falta terminar una limpieza automática: ${runtimeWarning}`
            : data.data?.restoredManual
              ? 'Ristak volvió a tu método manual anterior y las funciones de Meta siguen disponibles.'
              : 'Ristak volvió temporalmente a la conexión anterior de Facebook e Instagram.'
        )
        return
      }

      await Promise.all([
        setMessengerMessagingEnabled(false),
        setInstagramMessagingEnabled(false),
        setFacebookCommentsEnabled(false),
        setInstagramCommentsEnabled(false)
      ])

      resetLocalMetaState()
      setIsDisconnectModalOpen(false)
      showToast('success', 'Meta desconectado', 'La configuración actual fue eliminada')
    } catch (error) {
      await Promise.all([
        loadCredentials().catch(() => undefined),
        loadMetaDeveloperSetup().catch(() => undefined),
        loadMetaOAuthStatus().catch(() => undefined)
      ])
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
    return Object.keys(normalized).some(key => (
      key !== 'custom'
      && !metaTestIdentityParameterKeys.has(key)
      && Boolean((normalized as Record<string, string>)[key])
    ))
      || Boolean(normalized.custom?.length)
  }

  const withMetaTestDefaultsForEvent = (
    parameters: MetaTestEventParameters | null | undefined,
    eventName: string
  ): MetaTestEventParameters => {
    const normalizedEventName = normalizeMetaTestEventName(eventName)
    const next = pruneMetaTestEventParametersForEvent(parameters, normalizedEventName)
    const fields = getMetaTestEventFieldsForEvent(normalizedEventName)

    if (fields.includes('currency') && !cleanMetaTestParameterString(next.currency)) {
      next.currency = accountCurrency
    }

    if (isWhatsappBusinessMetaTestEvent(normalizedEventName)) {
      next.messagingChannel = normalizeMetaTestMessagingChannel(next.messagingChannel)

      const detectedPageId = cleanMetaTestParameterString(
        metaOAuthStatus?.selected?.pageId || credentials.pageId || savedPageId
      )
      const detectedInstagramAccountId = cleanMetaTestParameterString(
        metaOAuthStatus?.selected?.instagramAccountId
          || credentials.instagramAccountId
          || savedInstagramAccountId
      )
      if (detectedPageId) next.pageId = detectedPageId
      if (detectedInstagramAccountId) next.instagramAccountId = detectedInstagramAccountId
    }

    return next
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
    setMetaTestEventParameters(current => withMetaTestDefaultsForEvent(current, normalizedEventName))
  }

  const setMetaTestEventParameterField = (field: MetaTestParameterFieldKey, value: string) => {
    setMetaTestEventParameters(current => ({
      ...normalizeMetaTestEventParameters(current),
      [field]: String(value ?? '').trim()
    }))
  }

  const setMetaTestIdentityParameterField = (field: MetaTestIdentityParameterKey, value: string) => {
    setMetaTestEventParameters(current => ({
      ...withMetaTestDefaultsForEvent(current, normalizeMetaTestEventName(metaTestEventName)),
      [field]: field === 'messagingChannel'
        ? normalizeMetaTestMessagingChannel(value)
        : String(value ?? '').trim()
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
    const eventParameters = withMetaTestDefaultsForEvent(metaTestEventParameters, eventName)

    if (!testEventCode) {
      showToast('warning', 'Código requerido', 'Pega el código TEST de Events Manager')
      return
    }

    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(eventName)) {
      showToast('warning', 'Evento inválido', 'Usa letras, números y guion bajo; por ejemplo LeadSubmitted')
      return
    }

    if (isWhatsappBusinessMetaTestEvent(eventName)) {
      const messagingChannel = normalizeMetaTestMessagingChannel(eventParameters.messagingChannel)
      const channelLabel = metaTestMessagingChannelOptions.find(option => option.value === messagingChannel)?.label || 'Messaging'
      const messagingEventLabel = isWhatsappPurchaseMetaTestEvent(eventName) ? `Purchase de ${channelLabel}` : `LeadSubmitted de ${channelLabel}`
      if (messagingChannel !== 'instagram' && !hasPageId) {
        showToast('warning', 'Facebook Page requerida', `Selecciona una Facebook Page antes de probar ${messagingEventLabel}`)
        return
      }
      if (messagingChannel === 'instagram' && !cleanMetaTestParameterString(eventParameters.instagramAccountId)) {
        showToast('warning', 'Instagram requerido', `Selecciona una cuenta de Instagram antes de probar ${messagingEventLabel}`)
        return
      }

      if (isWhatsappPurchaseMetaTestEvent(eventName) && !cleanMetaTestParameterString(eventParameters.value)) {
        setIsMetaTestParametersOpen(true)
        showToast('warning', 'Valor requerido', `Agrega el valor de compra para probar ${messagingEventLabel}`)
        return
      }

      const missingIdentity = (
        messagingChannel === 'whatsapp'
          ? !cleanMetaTestParameterString(eventParameters.ctwaClid)
          : messagingChannel === 'messenger'
            ? !cleanMetaTestParameterString(eventParameters.pageScopedUserId)
            : !cleanMetaTestParameterString(eventParameters.igSid)
      )
      if (missingIdentity) {
        const fieldLabel = messagingChannel === 'whatsapp' ? 'ctwa_clid' : messagingChannel === 'messenger' ? 'PSID' : 'IGSID'
        showToast('warning', `${fieldLabel} requerido`, `Pega un ${fieldLabel} real para probar ${messagingEventLabel}`)
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
    const eventParameters = withMetaTestDefaultsForEvent(metaTestEventParameters, eventName)

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
    if (newValue && !hasSocialAccess) {
      showToast('warning', 'Sesión de Meta requerida', 'Inicia sesión en Meta Developers antes de activar comentarios.')
      return
    }
    if (newValue && platform === 'instagram' && !hasInstagramAccount) {
      showToast('warning', 'Instagram requerido', 'Primero selecciona la cuenta de Instagram en el wizard')
      return
    }
    if (newValue && platform === 'facebook' && !hasPageId) {
      showToast('warning', 'Facebook Page requerida', 'Primero selecciona una Facebook Page para recibir comentarios.')
      return
    }

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
    if (newValue && !hasSocialAccess) {
      showToast('warning', 'Sesión de Meta requerida', 'Inicia sesión en Meta Developers antes de activar mensajes.')
      return
    }

    if (newValue && !isInstagram && !hasPageId) {
      showToast(
        'warning',
        'Facebook Page requerida',
        'Primero selecciona una Facebook Page para recibir y mandar mensajes de Messenger'
      )
      return
    }

    if (newValue && !isInstagram && !isSocialOAuthConnection && !metaDeveloperSetup?.messengerUserTokenConfigured) {
      showToast(
        'warning',
        'Falta el User Token de Messenger',
        'Guárdalo en esta misma sección antes de activar Messenger para poder responder a personas externas.'
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

      if (isInstagram) {
        showToast(
          'success',
          `${platformLabel} activado`,
          'Ristak usará el System User token y la Página enlazada para recibir nombres, fotos y responder DMs.'
        )
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

  const handleSaveMessengerUserToken = async () => {
    const userToken = messengerUserToken.trim()
    if (userToken.length < 40) {
      showToast('warning', 'Token incompleto', 'Pega el User Token completo que generaste en Meta Developers.')
      return
    }

    setIsSavingMessengerUserToken(true)
    try {
      const response = await fetch('/api/meta/social/messaging/user-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userToken })
      })
      const data = await response.json()
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Meta no aceptó el User Token para esta Página.')
      }

      const socialChannels = data.socialChannels || {}
      const socialUpdates: Array<Promise<void>> = []
      if (socialChannels.messengerMessaging) socialUpdates.push(setMessengerMessagingEnabled(true))
      if (socialChannels.facebookComments) socialUpdates.push(setFacebookCommentsEnabled(true))
      if (socialChannels.instagramMessaging) socialUpdates.push(setInstagramMessagingEnabled(true))
      if (socialChannels.instagramComments) socialUpdates.push(setInstagramCommentsEnabled(true))
      await Promise.all(socialUpdates)

      setMessengerUserToken('')
      const setup = data.setup || {}
      setMetaDeveloperSetup({
        appId: setup.appId || '',
        businessId: setup.businessId || '',
        messengerUrl: setup.messengerUrl || '',
        instagramUrl: setup.instagramUrl || '',
        messengerUserTokenConfigured: true
      })
      showToast('success', 'Messenger listo', 'El User Token quedó validado, cifrado y la Página se suscribió a los eventos de Messenger.')
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : 'Revisa el User Token de Messenger.')
    } finally {
      setIsSavingMessengerUserToken(false)
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

  const isUnifiedOAuthConnected = isLegacyOAuthConnection
  const connectedAdAccountId = metaOAuthStatus?.selected?.adAccountId || credentials.adAccountId
  const connectedPixelId = metaOAuthStatus?.selected?.pixelId || credentials.pixelId
  const connectedPageId = metaOAuthStatus?.selected?.pageId || credentials.pageId
  const connectedInstagramAccountId = metaOAuthStatus?.selected?.instagramAccountId || credentials.instagramAccountId
  const hasManualAccessToken = Boolean(
    realAccessToken
    || (!isUnifiedOAuthConnected && credentials.accessToken)
    || (credentials.accessToken && !isMaskedSecretValue(credentials.accessToken))
  )
  const hasAdAccount = Boolean(connectedAdAccountId)
  const hasPixel = Boolean(connectedPixelId)
  const hasPageId = Boolean(connectedPageId)
  const hasInstagramAccount = Boolean(connectedInstagramAccountId)
  const hasSocialAccess = Boolean(
    isSocialOAuthConnection || (credentials.accessToken && connectedPageId)
  )
  const selectableInstagramAccounts = credentials.pageId
    ? instagramAccounts.filter(account => !account.pageId || account.pageId === credentials.pageId)
    : []
  const canEnableMessengerMessaging = hasPageId && (
    isSocialOAuthConnection || metaDeveloperSetup?.messengerUserTokenConfigured === true
  )
  const canEnableMessengerComments = hasPageId && (isSocialOAuthConnection || Boolean(credentials.accessToken))
  const canEnableInstagramMessaging = hasPageId && hasInstagramAccount && (isSocialOAuthConnection || Boolean(credentials.accessToken))
  const canEnableInstagramComments = hasPageId && hasInstagramAccount && (isSocialOAuthConnection || Boolean(credentials.accessToken))
  const isMetaConfigured = isUnifiedOAuthConnected
    || hasSplitAdsConnection
    || hasSplitSocialConnection
    || Boolean(credentials.accessToken && (credentials.adAccountId || credentials.pageId))
  const normalizedMetaTestEventName = normalizeMetaTestEventName(metaTestEventName)
  const normalizedMetaTestEventParameters = withMetaTestDefaultsForEvent(metaTestEventParameters, normalizedMetaTestEventName)
  const metaTestEventFieldKeys = getMetaTestEventFieldsForEvent(normalizedMetaTestEventName)
  const isBusinessMessagingMetaTestEvent = isWhatsappBusinessMetaTestEvent(normalizedMetaTestEventName)
  const normalizedMetaTestMessagingChannel = normalizeMetaTestMessagingChannel(normalizedMetaTestEventParameters.messagingChannel)
  const selectedMetaTestMessagingChannelOption = metaTestMessagingChannelOptions.find(option => option.value === normalizedMetaTestMessagingChannel) || metaTestMessagingChannelOptions[0]
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
  const isManualWizardRoute = metaStepSlugs.includes(
    getMetaAdsRouteSegment(location.pathname) as typeof metaStepSlugs[number]
  )
  const shouldShowWizard = activeMetaTab === 'cuenta' && (
    showManualConnection
    || isEditingMetaConfig
    || isManualWizardRoute
  )
  const shouldShowAccessTokenAction = Boolean(
    credentials.accessToken &&
    !isMaskedSecretValue(credentials.accessToken) &&
    (!realAccessToken || credentials.accessToken !== realAccessToken)
  )
  const canEditMetaAssets = showManualConnection || !isLegacyOAuthConnection
  const metaSetupSteps = [
    {
      title: 'Conexión',
      description: 'System User Token manual',
      done: hasManualAccessToken,
      required: true,
      unlocked: true
    },
    {
      title: 'Cuenta de anuncios',
      description: 'Selecciona la cuenta',
      done: hasAdAccount,
      required: true,
      unlocked: hasManualAccessToken && canEditMetaAssets
    },
    {
      title: 'Dataset',
      description: 'Medición web opcional',
      done: hasPixel,
      required: false,
      unlocked: hasAdAccount && canEditMetaAssets
    },
    {
      title: 'Páginas de Meta',
      description: 'Facebook e Instagram',
      done: hasPageId || hasInstagramAccount,
      required: false,
      unlocked: hasAdAccount && canEditMetaAssets
    }
  ]
  const completedMetaSetupSteps = metaSetupSteps.filter(step => step.done).length
  const shouldShowStepActions = activeStep > 0 || (
    activeStep === 0 &&
    canEditMetaAssets &&
    hasManualAccessToken &&
    !shouldShowAccessTokenAction &&
    !isSavingToken &&
    !isLoadingAccounts
  )

  useEffect(() => {
    if (!shouldShowWizard || isLoading) return
    void refreshMetaWizardStep(activeStep, { silent: true })
  }, [activeStep, isEditingMetaConfig, showManualConnection, wizardRefreshNonce, shouldShowWizard, isLoading])

  const getSelectedAdAccountAsset = () => {
    if (!connectedAdAccountId) return null
    const normalizedId = connectedAdAccountId.replace(/^act_/, '')
    const matchingAccount = adAccounts.find(acc =>
      acc.id.replace(/^act_/, '') === normalizedId
    )
    const savedAsset = metaOAuthStatus?.selectedAssets?.adAccount
    return {
      id: normalizedId,
      name: matchingAccount?.name || (savedAsset?.id.replace(/^act_/, '') === normalizedId ? savedAsset.name : '') || normalizedId
    }
  }

  const getSelectedPixelAsset = () => {
    if (!connectedPixelId) return null
    const matchingPixel = pixels.find(p => p.id === connectedPixelId)
    const savedAsset = metaOAuthStatus?.selectedAssets?.dataset
    return {
      id: connectedPixelId,
      name: matchingPixel?.name || (savedAsset?.id === connectedPixelId ? savedAsset.name : '') || connectedPixelId
    }
  }

  const getSelectedPageAsset = () => {
    if (!connectedPageId) return null
    const pageId = connectedPageId
    const matchingPage = pages.find(page => page.id === pageId)
    const savedAsset = metaOAuthStatus?.selectedAssets?.page
    return {
      id: pageId,
      name: matchingPage?.name || (savedAsset?.id === pageId ? savedAsset.name : '') || pageId
    }
  }

  const getSelectedInstagramAsset = () => {
    if (!connectedInstagramAccountId) return null
    const instagramAccountId = connectedInstagramAccountId
    const matchingAccount = instagramAccounts.find(account => account.sourceId === instagramAccountId)
    const savedAsset = metaOAuthStatus?.selectedAssets?.instagram
    const name = matchingAccount
      ? (matchingAccount.username ? `@${matchingAccount.username}` : matchingAccount.name)
      : (savedAsset?.id === instagramAccountId ? savedAsset.name : '')
    return { id: instagramAccountId, name: name || instagramAccountId }
  }

  const formatSelectedAsset = (asset: { id: string; name: string } | null, fallback: string) => (
    asset ? `${asset.name} (${asset.id})` : fallback
  )

  const getSelectedAdAccountLabel = () => formatSelectedAsset(getSelectedAdAccountAsset(), 'Pendiente')
  const getSelectedPixelLabel = () => formatSelectedAsset(getSelectedPixelAsset(), 'Opcional')
  const getSelectedPageLabel = () => formatSelectedAsset(getSelectedPageAsset(), 'Opcional')
  const getSelectedInstagramLabel = () => formatSelectedAsset(getSelectedInstagramAsset(), 'Opcional')

  const renderConnectedAsset = (asset: { id: string; name: string } | null, fallback: string) => (
    <span className={styles.connectedListValue}>
      {asset ? (
        <span className={styles.connectedAssetIdentity}>
          <span className={styles.connectedAssetName}>{asset.name}</span>
          <small className={styles.connectedAssetId}>(ID: {asset.id})</small>
        </span>
      ) : fallback}
    </span>
  )

  const selectedOAuthAdAccount = metaOAuthSession?.adAccounts.find(account => (
    account.id.replace(/^act_/, '') === String(metaOAuthSelection.adAccountId || '').replace(/^act_/, '')
  )) || null
  const selectedOAuthDataset = metaOAuthSession?.datasets.find(dataset => dataset.id === metaOAuthSelection.pixelId) || null
  const selectedOAuthPage = metaOAuthSession?.pages.find(page => page.id === metaOAuthSelection.pageId) || null
  const availableOAuthInstagramAccounts = selectedOAuthPage?.instagramAccounts || []
  const selectedOAuthInstagram = availableOAuthInstagramAccounts.find(account => (
    account.id === metaOAuthSelection.instagramAccountId
  )) || null

  const renderOAuthSelectValue = (
    asset: { id: string; name: string } | null,
    fallback: string
  ) => (
    <span className={styles.assetSelectValue}>
      <span>{asset?.name || fallback}</span>
      {asset ? <small>(ID: {asset.id})</small> : null}
    </span>
  )

  const getMetaMessagingStatus = (enabled: boolean, available: boolean) => {
    if (!available) return 'Pendiente'
    return enabled ? 'Activo' : 'Apagado'
  }

  const getMetaMessagingStatusVariant = (enabled: boolean, available: boolean): BadgeVariant => {
    if (!available) return 'warning'
    return enabled ? 'success' : 'neutral'
  }

  const getStepBlockMessage = (stepIndex = activeStep) => {
    if (stepIndex === 1 && !hasManualAccessToken) {
      return 'Primero valida el Access Token para cargar tus cuentas de anuncios'
    }

    if ((stepIndex === 2 || stepIndex === 3) && !hasAdAccount) {
      return 'Primero selecciona una cuenta de anuncios'
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
            <span className={styles.stepEyebrow}>Configuración manual</span>
            <h3 className={styles.stepTitle}>Conectar con System User Token</h3>
            <p className={styles.stepText}>
              Genera el token en tu portafolio comercial, pégalo aquí y después selecciona los activos que utilizará Ristak.
            </p>
          </div>

          <div className={styles.manualConnectionBlock}>
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
                <div className={`${styles.inlineStatus} ${styles.inlineStatusCentered}`} role="status" aria-live="polite" aria-label="Cargando cuentas de anuncios">
                  <RefreshCw size={14} className={styles.spinning} aria-hidden="true" />
                </div>
              )}
          </div>
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
              Esta cuenta alimenta campañas, costos y reportes. Al avanzar se cargan los datasets disponibles; nada se guarda hasta terminar el wizard.
            </p>
          </div>

          {!hasManualAccessToken ? (
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
                  <div className={`${styles.inlineStatus} ${styles.inlineStatusCentered}`} role="status" aria-live="polite" aria-label="Cargando datasets">
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
                {credentials.pageId ? (
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
                  <div className={`${styles.inlineStatus} ${styles.inlineStatusCentered}`} role="status" aria-live="polite" aria-label="Cargando páginas">
                    <RefreshCw size={14} className={styles.spinning} aria-hidden="true" />
                  </div>
                ) : pages.length > 0 ? (
                  <CustomSelect
                    onChange={(event) => {
                      const page = pages.find(item => item.id === event.target.value)
                      setCredentials(prev => {
                        const nextPageId = page?.id || ''
                        const currentInstagram = instagramAccounts.find(item => item.sourceId === prev.instagramAccountId)
                        const oauthPage = metaOAuthSession?.pages.find(item => item.id === nextPageId)
                        const onlyLinkedInstagram = oauthPage?.instagramAccounts.length === 1
                          ? oauthPage.instagramAccounts[0].id
                          : ''
                        return {
                          ...prev,
                          pageId: nextPageId,
                          instagramAccountId: currentInstagram?.pageId && currentInstagram.pageId !== nextPageId
                            ? onlyLinkedInstagram
                            : prev.instagramAccountId || onlyLinkedInstagram
                        }
                      })
                    }}
                    value={credentials.pageId || ''}
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
                      onClick={() => void refreshMetaWizardStep(3, { silent: false })}
                      disabled={Boolean(metaOAuthSession) || isLoadingPages || !(realAccessToken || credentials.accessToken)}
                    >
                      <RefreshCw size={16} className={isLoadingPages ? styles.spinning : ''} />
                      Volver a cargar
                    </Button>
                  </div>
                )}
              </div>

              <div className={`${styles.formGroup} ${styles.formGroupWide}`}>
                <span className={styles.formLabel}>Cuenta de Instagram opcional</span>
                {credentials.instagramAccountId ? (
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
                  <div className={`${styles.inlineStatus} ${styles.inlineStatusCentered}`} role="status" aria-live="polite" aria-label="Cargando Instagram">
                    <RefreshCw size={14} className={styles.spinning} aria-hidden="true" />
                  </div>
                ) : selectableInstagramAccounts.length > 0 ? (
                  <CustomSelect
                    onChange={(event) => {
                      const account = selectableInstagramAccounts.find(item => item.sourceId === event.target.value)
                      if (account) handleSelectInstagramAccount(account)
                    }}
                    value={credentials.instagramAccountId || ''}
                  >
                    <option value="">-- Sin Instagram por ahora --</option>
                    {selectableInstagramAccounts.map((account) => (
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
                      onClick={() => void refreshMetaWizardStep(3, { silent: false })}
                      disabled={Boolean(metaOAuthSession) || isLoadingInstagramAccounts || !(realAccessToken || credentials.accessToken)}
                    >
                      <RefreshCw size={16} className={isLoadingInstagramAccounts ? styles.spinning : ''} />
                      Volver a cargar
                    </Button>
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
        subtitle="Configura la cuenta, redes sociales, rastreo web y pruebas de Dataset desde un solo lugar."
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
            <SegmentTabs
              aria-label="Secciones de configuración de Meta"
              className={styles.metaTabs}
              tabs={metaConnectedTabs}
              value={activeMetaTab}
              onChange={(id) => handleSelectMetaTab(id as MetaConnectedTab)}
            />

            {!shouldShowWizard && activeMetaTab === 'cuenta' && isMetaConfigured && (
              <section className={styles.tabPanel}>
                <div className={styles.connectedHeader}>
                  <span className={styles.connectedIcon} aria-hidden="true">
                    <CheckCircle size={20} />
                  </span>
                  <div className={styles.connectedCopy}>
                    <h3 className={styles.connectedTitle}>Meta conectado</h3>
                    <p className={styles.connectedText}>
                      {isUnifiedOAuthConnected
                        ? 'Elige los activos que usará Ristak. Cada cambio se guarda automáticamente.'
                        : hasSplitAdsConnection || hasSplitSocialConnection
                          ? 'La cuenta sigue usando una conexión OAuth anterior mientras completas la migración.'
                          : 'Revisa los activos seleccionados para esta cuenta.'}
                    </p>
                    {isUnifiedOAuthConnected ? (
                      <span className={styles.assetSaveStatus} role="status" aria-live="polite">
                        {isSavingWizardConfig ? (
                          <><RefreshCw size={13} className={styles.spinning} /> Guardando cambio…</>
                        ) : isLoadingAuthorizedMetaAssets && !metaOAuthSession ? (
                          <><RefreshCw size={13} className={styles.spinning} /> Cargando activos…</>
                        ) : metaOAuthSession ? 'Guardado automático' : 'Autoriza Meta para volver a cargar los activos disponibles'}
                      </span>
                    ) : null}
                  </div>
                  <div className={styles.connectedActions}>
                    {hasAdAccount && <Button type="button" variant="secondary" onClick={handleSyncMetaAds} disabled={isSyncingMetaAds}>
                      <RefreshCw size={16} className={isSyncingMetaAds ? styles.spinning : ''} />
                      {isSyncingMetaAds ? 'Sincronizando' : 'Sincronizar'}
                    </Button>}
                    {isUnifiedOAuthConnected && <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void startMetaAuthorization()}
                      disabled={isConnectingMetaOAuth || metaOAuthStatus?.available === false}
                    >
                      {isConnectingMetaOAuth ? <RefreshCw size={16} className={styles.spinning} /> : <MetaBrandMark size={17} />}
                      {isConnectingMetaOAuth ? 'Abriendo Meta' : 'Autorizar nuevos activos'}
                    </Button>}
                    {!isUnifiedOAuthConnected && !hasSplitAdsConnection && !hasSplitSocialConnection && <Button type="button" variant="secondary" onClick={handleEditMetaConfig}>
                      <Pencil size={16} />
                      Editar
                    </Button>}
                    <Button type="button" variant="danger" onClick={() => setIsDisconnectModalOpen(true)}>
                      <Power size={16} />
                      Desconectar Meta
                    </Button>
                  </div>
                </div>

                {metaOAuthSession?.permissions.missing.length ? (
                  <p className={styles.oauthWarning} role="status">
                    Faltan permisos de Meta: {metaOAuthSession.permissions.missing.join(', ')}. Autoriza nuevamente antes de cambiar activos.
                  </p>
                ) : null}

                <div className={styles.connectedList}>
                  <div className={styles.connectedListRow}>
                    <span className={styles.connectedListLabel}>Cuenta publicitaria (Opcional)</span>
                    {isUnifiedOAuthConnected && metaOAuthSession ? (
                      <CustomSelect
                        className={styles.connectedAssetSelect}
                        value={metaOAuthSelection.adAccountId || ''}
                        searchable
                        searchPlaceholder="Buscar cuenta publicitaria…"
                        selectedContent={renderOAuthSelectValue(
                          selectedOAuthAdAccount ? {
                            id: selectedOAuthAdAccount.id.replace(/^act_/, ''),
                            name: selectedOAuthAdAccount.name
                          } : null,
                          'Sin cuenta publicitaria'
                        )}
                        onChange={(event) => void saveMetaOAuthAssetSelection({ adAccountId: event.target.value })}
                        disabled={isSavingWizardConfig || Boolean(metaOAuthSession.permissions.missing.length)}
                        aria-label="Cuenta publicitaria"
                      >
                        <option value="">Sin cuenta publicitaria</option>
                        {metaOAuthSession.adAccounts.map(account => (
                          <option key={account.id} value={account.id.replace(/^act_/, '')}>
                            {account.name} ({account.id.replace(/^act_/, '')})
                          </option>
                        ))}
                      </CustomSelect>
                    ) : renderConnectedAsset(getSelectedAdAccountAsset(), 'Sin cuenta publicitaria')}
                  </div>
                  <div className={styles.connectedListRow}>
                    <span className={styles.connectedListLabel}>Dataset para Conversiones API (Opcional)</span>
                    {isUnifiedOAuthConnected && metaOAuthSession ? (
                      <CustomSelect
                        className={styles.connectedAssetSelect}
                        value={metaOAuthSelection.pixelId || ''}
                        searchable
                        searchPlaceholder="Buscar Dataset…"
                        selectedContent={renderOAuthSelectValue(
                          selectedOAuthDataset ? { id: selectedOAuthDataset.id, name: selectedOAuthDataset.name } : null,
                          'Sin Dataset'
                        )}
                        onChange={(event) => void saveMetaOAuthAssetSelection({ pixelId: event.target.value })}
                        disabled={isSavingWizardConfig || Boolean(metaOAuthSession.permissions.missing.length)}
                        aria-label="Dataset para Conversiones API"
                      >
                        <option value="">Sin Dataset</option>
                        {metaOAuthSession.datasets.map(dataset => (
                          <option key={dataset.id} value={dataset.id}>{dataset.name} ({dataset.id})</option>
                        ))}
                      </CustomSelect>
                    ) : renderConnectedAsset(getSelectedPixelAsset(), 'Sin Dataset')}
                  </div>
                  <div className={styles.connectedListRow}>
                    <span className={styles.connectedListLabel}>Facebook Page (Opcional)</span>
                    {isUnifiedOAuthConnected && metaOAuthSession ? (
                      <CustomSelect
                        className={styles.connectedAssetSelect}
                        value={metaOAuthSelection.pageId || ''}
                        searchable
                        searchPlaceholder="Buscar Facebook Page…"
                        selectedContent={renderOAuthSelectValue(
                          selectedOAuthPage ? { id: selectedOAuthPage.id, name: selectedOAuthPage.name } : null,
                          'Sin Facebook Page'
                        )}
                        onChange={(event) => void saveMetaOAuthAssetSelection({ pageId: event.target.value })}
                        disabled={isSavingWizardConfig || Boolean(metaOAuthSession.permissions.missing.length)}
                        aria-label="Facebook Page"
                      >
                        <option value="">Sin Facebook Page</option>
                        {metaOAuthSession.pages.map(page => (
                          <option key={page.id} value={page.id}>{page.name} ({page.id})</option>
                        ))}
                      </CustomSelect>
                    ) : renderConnectedAsset(getSelectedPageAsset(), 'Sin Facebook Page')}
                  </div>
                  <div className={styles.connectedListRow}>
                    <span className={styles.connectedListLabel}>Instagram profesional (Opcional)</span>
                    {isUnifiedOAuthConnected && metaOAuthSession ? (
                      <CustomSelect
                        className={styles.connectedAssetSelect}
                        value={metaOAuthSelection.instagramAccountId || ''}
                        searchable
                        searchPlaceholder="Buscar cuenta de Instagram…"
                        selectedContent={renderOAuthSelectValue(
                          selectedOAuthInstagram ? {
                            id: selectedOAuthInstagram.id,
                            name: selectedOAuthInstagram.username ? `@${selectedOAuthInstagram.username}` : selectedOAuthInstagram.name
                          } : null,
                          metaOAuthSelection.pageId ? 'Sin Instagram' : 'Elige primero una Facebook Page'
                        )}
                        onChange={(event) => void saveMetaOAuthAssetSelection({ instagramAccountId: event.target.value })}
                        disabled={isSavingWizardConfig || !metaOAuthSelection.pageId || Boolean(metaOAuthSession.permissions.missing.length)}
                        aria-label="Instagram profesional"
                      >
                        <option value="">Sin Instagram</option>
                        {availableOAuthInstagramAccounts.map(account => (
                          <option key={account.id} value={account.id}>
                            {account.username ? `@${account.username}` : account.name} ({account.id})
                          </option>
                        ))}
                      </CustomSelect>
                    ) : renderConnectedAsset(getSelectedInstagramAsset(), 'Sin Instagram')}
                  </div>
                  <div className={styles.connectedListRow}>
                    <span className={styles.connectedListLabel}>Acceso de Meta</span>
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

            {activeMetaTab === 'social' && !isMetaConfigured && (
              <section className={styles.tabPanel}>
                <div className={styles.connectedPagesHeader}>
                  <h3 className={styles.sectionTitle}>Conecta primero tu cuenta Meta</h3>
                  <p className={styles.connectedPagesDescription}>
                    Guarda la configuración manual en Cuenta Meta para elegir la Facebook Page y la cuenta profesional de Instagram.
                  </p>
                </div>
                <div className={styles.connectedActions}>
                  <Button type="button" variant="primary" onClick={() => handleSelectMetaTab('cuenta')}>
                    Ir a Cuenta Meta
                  </Button>
                </div>
              </section>
            )}

            {activeMetaTab === 'social' && isMetaConfigured && (
              <section className={styles.tabPanel}>
                <div className={styles.connectedPagesHeader}>
                  <h4 className={styles.connectedPagesTitle}>Redes sociales</h4>
                  <p className={styles.connectedPagesDescription}>
                    Activa los canales que usará Ristak para recibir y responder mensajes y comentarios.
                  </p>
                </div>

                <div className={styles.socialChannelGrid}>
                  <div className={styles.socialChannelPanel}>
                    <div className={styles.socialChannelHeader}>
                      <span className={`${styles.connectedPageIcon} ${styles.connectedPageIconFacebook}`} aria-hidden="true">
                        <Icon name="facebook" size={19} />
                      </span>
                      <div className={styles.socialChannelTitleBlock}>
                        <h4 className={styles.connectedPagesTitle}>Messenger</h4>
                        <p className={styles.connectedPagesDescription}>
                          Mensajes y comentarios de tu Facebook Page.
                        </p>
                      </div>
                    </div>

                    <div className={styles.socialAssetLine}>
                      <span className={styles.webhookFieldLabel}>Facebook Page</span>
                      <strong>{hasPageId ? getSelectedPageLabel() : 'Selecciona una Facebook Page'}</strong>
                    </div>

                    {!isSocialOAuthConnection ? (
                    <div className={styles.webhookField}>
                      <span className={styles.webhookFieldLabel}>User Token de Messenger</span>
                      <div className={styles.webhookFieldRow}>
                        <input
                          className={styles.secretTokenInput}
                          type="password"
                          autoComplete="off"
                          value={messengerUserToken}
                          onChange={(event) => setMessengerUserToken(event.target.value)}
                          placeholder={metaDeveloperSetup?.messengerUserTokenConfigured ? '•••••••• conectado' : 'Pega el User Token que generaste en Meta'}
                          aria-label="User Token de Messenger"
                          disabled={!hasPageId || isSavingMessengerUserToken}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={handleSaveMessengerUserToken}
                          disabled={!hasPageId || !messengerUserToken.trim() || isSavingMessengerUserToken}
                        >
                          <Save size={16} />
                          {isSavingMessengerUserToken ? 'Validando' : metaDeveloperSetup?.messengerUserTokenConfigured ? 'Cambiar' : 'Guardar'}
                        </Button>
                      </div>
                      <p className={styles.connectedPagesDescription}>
                        {metaDeveloperSetup?.messengerUserTokenConfigured
                          ? 'Está guardado cifrado. Sólo se usa para derivar el token de Página de Messenger.'
                          : 'Ristak no lo muestra después de guardarlo y valida que tenga acceso a la Página seleccionada.'}
                      </p>
                    </div>
                    ) : null}

                    {!isSocialOAuthConnection && <Button
                      type="button"
                      variant="secondary"
                      onClick={() => window.open(metaDeveloperSetup?.messengerUrl, '_blank', 'noopener,noreferrer')}
                      disabled={!metaDeveloperSetup?.messengerUrl}
                    >
                      <ExternalLink size={16} />
                      Configurar Messenger y Webhooks en Meta
                    </Button>}

                    <div className={styles.socialSettingRows}>
                      <div className={styles.socialSettingRow}>
                        <div className={styles.socialSettingCopy}>
                          <strong>Mensajes de Messenger</strong>
                        </div>
                        <div className={styles.socialSettingControl}>
                          <Badge variant={getMetaMessagingStatusVariant(messengerMessagingEnabled, canEnableMessengerMessaging)}>
                            {getMetaMessagingStatus(messengerMessagingEnabled, canEnableMessengerMessaging)}
                          </Badge>
                          <Switch
                            aria-label="Activar mensajes de Messenger"
                            checked={messengerMessagingEnabled === true}
                            onChange={(next) => handleToggleMetaMessaging('messenger', next)}
                            disabled={!canEnableMessengerMessaging || savingMessengerMessaging}
                          />
                        </div>
                      </div>

                      <div className={styles.socialSettingRow}>
                        <div className={styles.socialSettingCopy}>
                          <strong>Comentarios de Facebook</strong>
                        </div>
                        <div className={styles.socialSettingControl}>
                          <Badge variant={getMetaMessagingStatusVariant(facebookCommentsEnabled, canEnableMessengerComments)}>
                            {getMetaMessagingStatus(facebookCommentsEnabled, canEnableMessengerComments)}
                          </Badge>
                          <Switch
                            aria-label="Activar comentarios de Facebook"
                            checked={facebookCommentsEnabled === true}
                            onChange={(next) => handleToggleMetaComments('facebook', next)}
                            disabled={!canEnableMessengerComments || savingFacebookComments}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className={styles.socialChannelPanel}>
                    <div className={styles.socialChannelHeader}>
                      <span className={`${styles.connectedPageIcon} ${styles.connectedPageIconInstagram}`} aria-hidden="true">
                        <Icon name="instagram" size={19} />
                      </span>
                      <div className={styles.socialChannelTitleBlock}>
                        <h4 className={styles.connectedPagesTitle}>Instagram</h4>
                        <p className={styles.connectedPagesDescription}>
                          DMs y comentarios de tu cuenta profesional.
                        </p>
                      </div>
                    </div>

                    <div className={styles.socialAssetLine}>
                      <span className={styles.webhookFieldLabel}>Cuenta de Instagram</span>
                      <strong>{hasInstagramAccount ? getSelectedInstagramLabel() : 'Selecciona una cuenta de Instagram'}</strong>
                    </div>

                    {!isSocialOAuthConnection && <Button
                      type="button"
                      variant="secondary"
                      onClick={() => window.open(metaDeveloperSetup?.instagramUrl, '_blank', 'noopener,noreferrer')}
                      disabled={!metaDeveloperSetup?.instagramUrl}
                    >
                      <ExternalLink size={16} />
                      Configurar Instagram y Webhooks en Meta
                    </Button>}

                    <div className={styles.socialSettingRows}>
                      <div className={styles.socialSettingRow}>
                        <div className={styles.socialSettingCopy}>
                          <strong>Instagram DM</strong>
                        </div>
                        <div className={styles.socialSettingControl}>
                          <Badge
                            variant={getMetaMessagingStatusVariant(instagramMessagingEnabled, canEnableInstagramMessaging)}
                          >
                            {getMetaMessagingStatus(instagramMessagingEnabled, canEnableInstagramMessaging)}
                          </Badge>
                          <Switch
                            aria-label="Activar mensajes de Instagram DM"
                            checked={instagramMessagingEnabled === true}
                            onChange={(next) => handleToggleMetaMessaging('instagram', next)}
                            disabled={!canEnableInstagramMessaging || savingInstagramMessaging}
                          />
                        </div>
                      </div>

                      <div className={styles.socialSettingRow}>
                        <div className={styles.socialSettingCopy}>
                          <strong>Comentarios de Instagram</strong>
                        </div>
                        <div className={styles.socialSettingControl}>
                          <Badge variant={getMetaMessagingStatusVariant(instagramCommentsEnabled, canEnableInstagramComments)}>
                            {getMetaMessagingStatus(instagramCommentsEnabled, canEnableInstagramComments)}
                          </Badge>
                          <Switch
                            aria-label="Activar comentarios de Instagram"
                            checked={instagramCommentsEnabled === true}
                            onChange={(next) => handleToggleMetaComments('instagram', next)}
                            disabled={!canEnableInstagramComments || savingInstagramComments}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {!isSocialOAuthConnection && <div className={styles.webhookGuide}>
                  <div className={styles.connectedPagesHeader}>
                    <h4 className={styles.connectedPagesTitle}>Webhooks en Meta Developers</h4>
                    <p className={styles.connectedPagesDescription}>
                      Usa estos valores en cada caso de uso de Meta que actives. La misma URL y el mismo token sirven para Pages, Messenger, Instagram y WhatsApp; Meta separa la configuración por producto.
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
                  </div>

                  <figure className={styles.webhookTutorialItem}>
                    <p className={styles.webhookTutorialTitle}>Casos de uso en Meta</p>
                    <p className={styles.webhookTutorialDescription}>
                      En cada caso de uso entra a <strong>Personalizar</strong> → <strong>Webhooks</strong>, selecciona el producto correspondiente y pega la URL y el token de arriba.
                    </p>
                    <img
                      src="/meta-use-cases-pages.png"
                      alt="Pantalla de casos de uso de Meta para administrar páginas, Messenger, Instagram y WhatsApp"
                      className={styles.webhookTutorialImage}
                      loading="lazy"
                    />
                  </figure>

                  <ol className={styles.webhookSteps}>
                    <li><strong>Administrar páginas:</strong> configura el producto <strong>Page</strong> para comentarios y eventos de la página.</li>
                    <li><strong>Messenger e Instagram:</strong> configura los productos que correspondan a los casos de uso activos. Usa la misma URL y el mismo token.</li>
                    <li><strong>WhatsApp:</strong> configura el producto <strong>WhatsApp Business Account</strong> si vas a recibir mensajes de WhatsApp Cloud API.</li>
                    <li><strong>Ristak:</strong> después guarda el System User token actualizado y selecciona la Page/Instagram desde este wizard.</li>
                  </ol>
                </div>}
              </section>
            )}
            {shouldShowWizard && (
            <section className={`${styles.section} ${styles.wizardSection}`}>
              <div className={styles.sectionHeader}>
                <div>
                  <h3 className={styles.sectionTitle}>Configuración manual de Meta</h3>
                  <p className={styles.sectionDescription}>
                    Usa tu System User Token y selecciona la cuenta publicitaria, Dataset, Facebook Page e Instagram que utilizará Ristak.
                  </p>
                </div>
                <div className={styles.connectedActions}>
                  <span className={styles.stepCount}>{completedMetaSetupSteps}/{metaSetupSteps.length} listo</span>
                  {isMetaConfigured && <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setShowManualConnection(false)
                      setIsEditingMetaConfig(false)
                      setActiveStep(0)
                      navigate(buildMetaAdsConnectedTabPath('cuenta'), { replace: true })
                    }}
                  >
                    Volver a Cuenta Meta
                  </Button>}
                </div>
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
                              disabled={!hasAdAccount || isSavingWizardConfig || Boolean(metaOAuthSession?.permissions.missing.length)}
                            >
                              {isSavingWizardConfig ? (
                                <>
                                  Guardando
                                  <RefreshCw size={16} className={styles.spinning} />
                                </>
                              ) : (
                                <>
                                  Terminar
                                  <CheckCircle size={16} />
                                </>
                              )}
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

            {!shouldShowWizard && activeMetaTab === 'cuenta' && !isMetaConfigured && (
              <section className={styles.tabPanel}>
                <div className={`${styles.oauthConnectBlock} ${styles.oauthPreviewRow}`}>
                  <div className={styles.oauthConnectMain}>
                    <span className={styles.oauthBrandMark} aria-hidden="true">
                      <MetaBrandMark size={24} />
                    </span>
                    <div className={styles.oauthConnectCopy}>
                      <div className={styles.oauthConnectTitleRow}>
                        <h4>Conectar Meta</h4>
                      </div>
                      <p>Autoriza tu cuenta y después elige aquí qué activos usará Ristak.</p>
                    </div>
                  </div>
                  <div className={styles.oauthActions}>
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => void startMetaAuthorization()}
                      disabled={isConnectingMetaOAuth || metaOAuthStatus === null || metaOAuthStatus?.available === false}
                    >
                      {isConnectingMetaOAuth ? <RefreshCw size={16} className={styles.spinning} /> : <MetaBrandMark size={17} />}
                      {isConnectingMetaOAuth ? 'Abriendo Meta' : 'Conectar con Meta'}
                    </Button>
                  </div>
                  {metaOAuthStatus?.error ? <p className={styles.oauthWarning}>{metaOAuthStatus.error}</p> : null}
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
                        <span className={styles.railSecondaryValue}>Aún no hay un Dataset asociado. Reconecta Meta y elígelo si quieres enviar eventos por Conversions API.</span>
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
                      <span className={styles.railSecondaryValue}>Elige un Dataset dentro de la conexión unificada de Meta para poder mandar pruebas de eventos CAPI.</span>
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

                    {isBusinessMessagingMetaTestEvent && (
                      <div className={styles.metaTestMessagingParameters}>
                        <div className={styles.metaTestMessagingHeader}>
                          <span>Parámetros de messaging</span>
                          <small>{selectedMetaTestMessagingChannelOption.helper}</small>
                        </div>
                        <div className={styles.metaTestParametersGrid}>
                          <label className={styles.metaTestParameterField}>
                            <span>Canal</span>
                            <CustomSelect
                              value={normalizedMetaTestMessagingChannel}
                              onChange={(event) => setMetaTestIdentityParameterField('messagingChannel', event.target.value)}
                            >
                              {metaTestMessagingChannelOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </CustomSelect>
                          </label>

                          {normalizedMetaTestMessagingChannel === 'whatsapp' && (
                            <>
                              <label className={styles.metaTestParameterField}>
                                <span>ctwa_clid</span>
                                <input
                                  value={normalizedMetaTestEventParameters.ctwaClid || ''}
                                  placeholder="AfghPKzHPYknB7A..."
                                  onChange={(event) => setMetaTestIdentityParameterField('ctwaClid', event.target.value)}
                                />
                              </label>
                              <label className={styles.metaTestParameterField}>
                                <span>Page ID detectada</span>
                                <input
                                  value={normalizedMetaTestEventParameters.pageId || ''}
                                  placeholder="Sin Page del wizard"
                                  readOnly
                                  disabled
                                />
                              </label>
                            </>
                          )}

                          {normalizedMetaTestMessagingChannel === 'messenger' && (
                            <>
                              <label className={styles.metaTestParameterField}>
                                <span>PSID</span>
                                <input
                                  value={normalizedMetaTestEventParameters.pageScopedUserId || ''}
                                  placeholder="page_scoped_user_id"
                                  onChange={(event) => setMetaTestIdentityParameterField('pageScopedUserId', event.target.value)}
                                />
                              </label>
                              <label className={styles.metaTestParameterField}>
                                <span>Page ID detectada</span>
                                <input
                                  value={normalizedMetaTestEventParameters.pageId || ''}
                                  placeholder="Sin Page del wizard"
                                  readOnly
                                  disabled
                                />
                              </label>
                            </>
                          )}

                          {normalizedMetaTestMessagingChannel === 'instagram' && (
                            <>
                              <label className={styles.metaTestParameterField}>
                                <span>IGSID</span>
                                <input
                                  value={normalizedMetaTestEventParameters.igSid || ''}
                                  placeholder="ig_sid"
                                  onChange={(event) => setMetaTestIdentityParameterField('igSid', event.target.value)}
                                />
                              </label>
                              <label className={styles.metaTestParameterField}>
                                <span>Instagram ID detectado</span>
                                <input
                                  value={normalizedMetaTestEventParameters.instagramAccountId || ''}
                                  placeholder="Sin Instagram del wizard"
                                  readOnly
                                  disabled
                                />
                              </label>
                            </>
                          )}
                        </div>
                      </div>
                    )}

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
                                  placeholder={field === 'currency' ? accountCurrency : metaTestParameterFieldPlaceholders[field]}
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
        title="Desconectar Meta"
        message={hasSplitAdsConnection || hasSplitSocialConnection
          ? 'Se desconectarán las conexiones anteriores que todavía estén activas. La conexión principal permanecerá disponible.'
          : isOAuthConnection && metaOAuthStatus?.manualBackupAvailable
          ? 'Se desconectará Meta y Ristak restaurará la conexión anterior que ya tenías guardada.'
          : isOAuthConnection
            ? 'Se desconectarán anuncios, Dataset, Facebook e Instagram de esta cuenta. Esta acción no se puede deshacer.'
            : 'Se eliminará el token, la cuenta de anuncios, el Dataset, la Página e Instagram, y se apagarán Messenger, Instagram DM y comentarios. Esta acción no se puede deshacer.'}
        type="confirm"
        typeToConfirm={isOAuthConnection ? 'DESCONECTAR' : 'ELIMINAR'}
        confirmText={isDisconnectingMeta
          ? 'Procesando...'
          : 'Desconectar Meta'}
        cancelText="Cancelar"
        onConfirm={() => {
          void handleDisconnectMetaConfig()
        }}
      />
    </div>
  )
}
