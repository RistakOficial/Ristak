import apiClient from './apiClient'

const API_BASE_URL = import.meta.env.VITE_API_URL || ''

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth_token')
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

export type SiteType = 'standard_form' | 'interactive_form' | 'landing_page'
export type SiteStatus = 'draft' | 'published' | 'archived'
export type SiteMetaTrigger = 'page_view' | 'form_submit'
export type SiteFormCompletionAction = 'form_default' | 'next_page' | 'next_page_if_qualified'
export type SiteBlockType =
  | 'headline'
  | 'subheading'
  | 'title'
  | 'subtitle'
  | 'description'
  | 'text'
  | 'embed'
  | 'calendar_embed'
  | 'section'
  | 'header_panel'
  | 'footer_panel'
  | 'hero'
  | 'image'
  | 'video'
  | 'button'
  | 'benefits'
  | 'testimonials'
  | 'services'
  | 'form_embed'
  | 'social_profile'
  | 'faq'
  | 'cta'
  | 'short_text'
  | 'paragraph'
  | 'currency'
  | 'number'
  | 'dropdown'
  | 'radio'
  | 'checkboxes'
  | 'phone'
  | 'email'
  | 'date'

export type SiteOptionAction =
  | 'continue'
  | 'cold_lead'
  | 'warm_lead'
  | 'hot_lead'
  | 'disqualify'
  | 'disqualify_after_submit'
  | 'show_message'
  | 'end_form'
  | 'jump'
  | 'redirect'
  | 'tag'
  | 'category'

export interface SiteBlockOption {
  id?: string
  label: string
  value?: string
  action?: SiteOptionAction
  targetBlockId?: string
  message?: string
  redirectUrl?: string
  tag?: string
  category?: string
}

export type SiteTemplateId =
  | 'ristak'
  | 'executive'
  | 'launch'
  | 'premium'
  | 'local'
  | 'compact'
  | 'event'
  | 'quote'
  | 'callback'
  | 'waitlist'
  | 'facebook'
  | 'instagram'
  | 'tiktok'
  | 'vsl'
  | 'interactive'
  | 'imported_html'

export interface SitePage {
  id: string
  title: string
  sortOrder: number
  parentPageId?: string
  slug?: string
  importedAssetPath?: string
  importedOriginalTitle?: string
  headerTrackingCode?: string
  metaCapiEnabled?: boolean
  metaEventName?: string
  metaTrigger?: SiteMetaTrigger
}

export interface SiteTheme {
  accentColor?: string
  backgroundColor?: string
  backgroundImage?: string
  blankCanvas?: boolean
  backgroundMediaType?: 'image' | 'video'
  backgroundFit?: 'cover' | 'contain' | 'full_width' | 'auto'
  backgroundRepeat?: 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y'
  backgroundPosition?: string
  backgroundAttachment?: 'scroll' | 'fixed'
  textColor?: string
  textColorCustom?: boolean
  template?: SiteTemplateId
  importedHtml?: boolean
  importId?: string
  pages?: SitePage[]
  pageMode?: 'funnel' | 'website'
  pagePadding?: number
  pageRadius?: number
  pageBorderWidth?: number
  pageBorderColor?: string
  pageMaxWidth?: number
  metaConversionTarget?: 'same_page' | 'next_page'
  formCompletionAction?: SiteFormCompletionAction
  brandName?: string
  brandSubtitle?: string
  brandAvatar?: string
  followers?: string
  brandVerified?: boolean
  socialAutoSync?: boolean
  socialSourceProfileId?: string
  socialSourcePlatform?: string
  socialSourceId?: string
  socialSourcePageId?: string
  socialSourceName?: string
  socialSyncedAt?: string
  seoKeywords?: string
  seoAuthor?: string
  seoImage?: string
  seoMetaTags?: string
  seoCanonicalLinks?: string
  seoLanguage?: string
  headerTrackingCode?: string
  popupEnabled?: boolean
  popupTitle?: string
  popupBody?: string
  popupButtonText?: string
  popupButtonUrl?: string
  popupDelaySeconds?: number
  popupTrigger?: 'never' | 'delay' | 'exit_intent'
  popupBackdropColor?: string
  popupBackgroundColor?: string
  popupTextColor?: string
  popupBorderColor?: string
  popupBorderWidth?: number
  popupMaxWidth?: number
  popupRadius?: number
  popupPadding?: number
  popupCloseDisplay?: 'icon' | 'text' | 'both'
  popupCloseIcon?: 'x' | 'arrow' | 'chevron' | 'none'
  popupCloseText?: string
  submitText?: string
  submitSubtitle?: string
  submitBg?: string
  submitTextColor?: string
  submitBorderColor?: string
  submitRadius?: number
  submitHeight?: number
  submitPaddingX?: number
  submitFontSize?: number
  submitBorderWidth?: number
  formFontFamily?: string
  formLabelSize?: number
  formInputSize?: number
  formHelpSize?: number
  formFontWeight?: 'normal' | 'bold'
  formFontStyle?: 'normal' | 'italic'
  formTextDecoration?: 'none' | 'underline'
  formLabelColor?: string
  formHelpColor?: string
  formFieldBg?: string
  formFieldText?: string
  formFieldBorder?: string
  formPlaceholderColor?: string
  formFieldRadius?: number
  formFieldBorderWidth?: number
  formFieldHeight?: number
  formFieldPaddingX?: number
  formFieldPaddingY?: number
  formChoiceStyle?: 'native' | 'cards' | 'pills' | 'minimal'
  formChoiceSelectedBg?: string
  formChoiceSelectedBorder?: string
  formSelectStyle?: 'classic' | 'filled' | 'underline'
  finalMessages?: {
    success?: string
    disqualified?: string
  }
}

export interface SiteTemplateMeta {
  id: SiteTemplateId
  label: string
  description: string
  group: 'form' | 'landing' | 'interactive'
  category: 'full_page' | 'social' | 'compact' | 'guided' | 'event'
  accent: string
  swatchBg: string
  swatchInk: string
  badge: string
  defaultTheme?: Partial<SiteTheme>
}

const templateImageUrls = {
  workspace: 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1800&q=80',
  planning: 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1800&q=80',
  premium: 'https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=1800&q=80',
  local: 'https://images.unsplash.com/photo-1556745757-8d76bdb6984b?auto=format&fit=crop&w=1800&q=80',
  team: 'https://images.unsplash.com/photo-1551434678-e076c223a692?auto=format&fit=crop&w=1800&q=80',
  quote: 'https://images.unsplash.com/photo-1553877522-43269d4ea984?auto=format&fit=crop&w=1800&q=80',
  consult: 'https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=1800&q=80',
  handshake: 'https://images.unsplash.com/photo-1521791136064-7986c2920216?auto=format&fit=crop&w=1800&q=80'
}

export const siteTemplates: SiteTemplateMeta[] = [
  { id: 'ristak', label: 'Base de negocio', description: 'Embudo con opt-in, agenda y pagina de gracias para una oferta generica.', group: 'landing', category: 'full_page', accent: '#111827', swatchBg: '#f5f6f8', swatchInk: '#0f172a', badge: 'Web', defaultTheme: { backgroundImage: templateImageUrls.workspace, backgroundColor: 'linear-gradient(90deg, rgba(248,250,252,.95), rgba(248,250,252,.72))', backgroundFit: 'cover', backgroundPosition: 'center center' } },
  { id: 'executive', label: 'Corporativo claro', description: 'Embudo serio con diagnostico, agenda y confirmacion para servicios.', group: 'landing', category: 'full_page', accent: '#0f766e', swatchBg: '#f8fafc', swatchInk: '#0f172a', badge: 'Web', defaultTheme: { backgroundImage: templateImageUrls.team, backgroundColor: 'linear-gradient(110deg, rgba(248,250,252,.96), rgba(236,254,255,.68))', backgroundFit: 'cover', backgroundPosition: 'center center', accentColor: '#0f766e' } },
  { id: 'launch', label: 'Lanzamiento', description: 'Embudo de registro con pagina de detalles y cierre de gracias.', group: 'landing', category: 'full_page', accent: '#ea580c', swatchBg: '#fff7ed', swatchInk: '#1f2937', badge: 'Promo', defaultTheme: { backgroundImage: templateImageUrls.planning, backgroundColor: 'linear-gradient(135deg, rgba(255,247,237,.95), rgba(251,146,60,.36))', backgroundFit: 'cover', backgroundPosition: 'center center', accentColor: '#ea580c' } },
  { id: 'premium', label: 'Premium sobrio', description: 'Embudo elegante con aplicacion, agenda privada y confirmacion.', group: 'landing', category: 'full_page', accent: '#d4af37', swatchBg: '#101010', swatchInk: '#f8fafc', badge: 'Premium', defaultTheme: { backgroundImage: templateImageUrls.premium, backgroundColor: 'linear-gradient(120deg, rgba(16,16,16,.95), rgba(16,16,16,.72))', backgroundFit: 'cover', backgroundPosition: 'center center', accentColor: '#d4af37', textColor: '#f8fafc' } },
  { id: 'local', label: 'Negocio local', description: 'Embudo local con oferta, contacto y pagina de gracias para seguimiento.', group: 'landing', category: 'full_page', accent: '#15803d', swatchBg: '#f0fdf4', swatchInk: '#14532d', badge: 'Local', defaultTheme: { backgroundImage: templateImageUrls.local, backgroundColor: 'linear-gradient(110deg, rgba(240,253,244,.95), rgba(220,252,231,.72))', backgroundFit: 'cover', backgroundPosition: 'center center', accentColor: '#15803d' } },
  { id: 'vsl', label: 'Carta de ventas', description: 'Embudo de venta con carta, agenda y pagina final de confirmacion.', group: 'landing', category: 'full_page', accent: '#111827', swatchBg: '#0a0b0d', swatchInk: '#ffffff', badge: 'Venta', defaultTheme: { backgroundImage: templateImageUrls.handshake, backgroundColor: 'linear-gradient(140deg, rgba(10,11,13,.96), rgba(17,24,39,.72))', backgroundFit: 'cover', backgroundPosition: 'center center', accentColor: '#111827' } },
  { id: 'facebook', label: 'Facebook', description: 'Formato corto con apariencia de anuncio o perfil de Facebook.', group: 'form', category: 'social', accent: '#1877f2', swatchBg: '#f0f2f5', swatchInk: '#1c1e21', badge: 'Redes' },
  { id: 'instagram', label: 'Instagram', description: 'Formato corto con apariencia de publicacion o anuncio de Instagram.', group: 'form', category: 'social', accent: '#0095f6', swatchBg: '#ffffff', swatchInk: '#262626', badge: 'Redes' },
  { id: 'tiktok', label: 'TikTok', description: 'Formato oscuro y directo para trafico que viene de TikTok.', group: 'form', category: 'social', accent: '#fe2c55', swatchBg: '#000000', swatchInk: '#ffffff', badge: 'Redes' },
  { id: 'compact', label: 'Formulario compacto', description: 'Captura rapida de datos, ideal para formularios pequenos y directos.', group: 'form', category: 'compact', accent: '#2563eb', swatchBg: '#f8fafc', swatchInk: '#0f172a', badge: 'Corto', defaultTheme: { backgroundColor: '#f8fafc', accentColor: '#2563eb', pageMaxWidth: 480, pagePadding: 18, pageRadius: 18 } },
  { id: 'event', label: 'Registro simple', description: 'Para pedir datos antes de una llamada, evento, clase o cotizacion.', group: 'form', category: 'event', accent: '#be123c', swatchBg: '#fdf2f8', swatchInk: '#500724', badge: 'Registro', defaultTheme: { backgroundImage: templateImageUrls.planning, backgroundColor: 'linear-gradient(140deg, rgba(253,242,248,.96), rgba(251,207,232,.76))', backgroundFit: 'cover', backgroundPosition: 'center center', accentColor: '#be123c', pageMaxWidth: 540, pagePadding: 24, pageRadius: 24 } },
  { id: 'quote', label: 'Cotizacion rapida', description: 'Formulario visual para entender necesidad, presupuesto y datos de contacto.', group: 'form', category: 'compact', accent: '#7c3aed', swatchBg: '#f5f3ff', swatchInk: '#2e1065', badge: 'Cotiza', defaultTheme: { backgroundImage: templateImageUrls.quote, backgroundColor: 'linear-gradient(145deg, rgba(245,243,255,.96), rgba(237,233,254,.74))', backgroundFit: 'cover', backgroundPosition: 'center center', accentColor: '#7c3aed', pageMaxWidth: 560, pagePadding: 24, pageRadius: 22 } },
  { id: 'callback', label: 'Llamada consultiva', description: 'Formulario sobrio para filtrar interesados antes de hablar con tu equipo.', group: 'form', category: 'compact', accent: '#0e7490', swatchBg: '#ecfeff', swatchInk: '#164e63', badge: 'Llamada', defaultTheme: { backgroundImage: templateImageUrls.consult, backgroundColor: 'linear-gradient(140deg, rgba(236,254,255,.96), rgba(207,250,254,.72))', backgroundFit: 'cover', backgroundPosition: 'center center', accentColor: '#0e7490', pageMaxWidth: 620, pagePadding: 26, pageRadius: 18 } },
  { id: 'waitlist', label: 'Lista de espera', description: 'Registro ligero para cupos, preventas, clases o acceso anticipado.', group: 'form', category: 'event', accent: '#c2410c', swatchBg: '#fff7ed', swatchInk: '#7c2d12', badge: 'Lista', defaultTheme: { backgroundImage: templateImageUrls.handshake, backgroundColor: 'linear-gradient(145deg, rgba(255,247,237,.96), rgba(254,215,170,.74))', backgroundFit: 'cover', backgroundPosition: 'center center', accentColor: '#c2410c', pageMaxWidth: 520, pagePadding: 22, pageRadius: 28 } },
  { id: 'interactive', label: 'Quiz guiado', description: 'Una pregunta por pantalla para calificar prospectos paso a paso.', group: 'interactive', category: 'guided', accent: '#111827', swatchBg: '#0a0b0d', swatchInk: '#ffffff', badge: 'Quiz' }
]

export interface SiteBlock {
  id: string
  siteId: string
  blockType: SiteBlockType
  label: string
  content: string
  placeholder: string
  required: boolean
  options: Array<string | SiteBlockOption>
  settings: Record<string, unknown>
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface SiteSubmission {
  id: string
  siteId: string
  contactId: string | null
  domain: string
  responses: Record<string, string | string[]>
  rawFields?: Record<string, string | string[]>
  mappedFields?: Record<string, unknown>
  derivedFields?: Record<string, unknown>
  meta: Record<string, unknown>
  status: string
  createdAt: string
  contactName: string
  contactEmail: string
  contactPhone: string
}

export interface PublicSite {
  id: string
  name: string
  slug: string
  siteType: SiteType
  status: SiteStatus
  domain: string
  title: string
  description: string
  theme: SiteTheme
  metaCapiEnabled: boolean
  metaEventName: string
  renderDomainVerified: boolean
  renderDomainCheckedAt: string | null
  renderDomainError: string | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  submissionsCount: number
  trackingStats?: {
    views: number
    visitors: number
    sessions: number
    conversions: number
    conversionRate: number
  }
  blocks?: SiteBlock[]
  submissions?: SiteSubmission[]
}

export interface SitesDomainConfig {
  domain: string
  renderDomainVerified: boolean
  renderDomainCheckedAt: string | null
  renderDomainError: string | null
  verification?: {
    verified: boolean
    error: string | null
  }
}

export type ImportedFieldDestinationType = 'standard' | 'custom' | 'new_custom' | 'ignored'

export interface ImportedSiteFieldMapping {
  fieldId: string
  sourceName: string
  label: string
  type: string
  destinationType: ImportedFieldDestinationType
  destinationKey: string
  saveMode?: string
  customFieldDefinitionId?: string
  customFieldKey?: string
  customFieldLabel?: string
  customFieldDataType?: string
  customFieldSyncTarget?: string
  confidence?: number
  ignored?: boolean
  options?: Array<{ label: string; value: string }>
}

export interface ImportedSiteFormMapping {
  formId: string
  formTitle: string
  purpose?: string
  submitText?: string
  fields: ImportedSiteFieldMapping[]
}

export interface ImportedSiteImport {
  id: string
  siteId: string
  originalFilename: string
  importType: string
  htmlOriginal?: string
  htmlSanitized?: string
  detectedForms: Array<Record<string, unknown>>
  formMappings: ImportedSiteFormMapping[]
  securityReport: string[]
  status: string
  createdAt: string
  updatedAt: string
}

export interface ImportedSiteCreateResult {
  site: PublicSite
  import: ImportedSiteImport
}

export type ImportedEditableContentType =
  | 'heading'
  | 'text'
  | 'button'
  | 'form_label'
  | 'placeholder'
  | 'form_field'
  | 'image'
  | 'background_image'
  | 'video'
  | 'choice_option'

export type ImportedButtonAction =
  | 'none'
  | 'url'
  | 'next_page'
  | 'specific_page'
  | 'open_popup'
  | 'close_popup'
  | 'submit'
  | 'disqualify'
  | 'automation'
  | 'notify_team'
  | 'add_tag'
  | 'send_whatsapp'
  | 'create_payment'

export interface ImportedButtonActionStep {
  id?: string
  action: ImportedButtonAction
  buttonUrl?: string
  buttonPageId?: string
  buttonMessage?: string
  automationName?: string
}

export interface ImportedEditableContentUpdate {
  editId: string
  editType: ImportedEditableContentType
  value: string
  pageId?: string
  fileBase64?: string
  filename?: string
  buttonActions?: ImportedButtonActionStep[]
  buttonAction?: ImportedButtonAction
  buttonUrl?: string
  buttonPageId?: string
  buttonMessage?: string
  choiceActions?: ImportedButtonActionStep[]
  choiceName?: string
  choiceValue?: string
  choiceInputType?: 'radio' | 'checkbox'
  choiceIndex?: number
  fieldLabel?: string
  fieldPlaceholder?: string
  fieldRequired?: boolean
  fieldOptions?: Array<{ label: string; value: string }>
  fieldName?: string
  fieldHtmlId?: string
  fieldTag?: string
  fieldInputType?: string
}

export type SitesAICreationKind = 'landing' | 'form' | 'interactive_form'

export interface SitesAICreationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SitesAIPreviewVisualElement {
  type: string
  label: string
  text: string
  x: number
  y: number
  width: number
  height: number
}

export interface SitesAIPreviewVisualContext {
  siteId: string
  pageId: string
  pageTitle: string
  summary: string
  screenshotDataUrl?: string
  screenshotFormat?: 'internal-preview-png'
  capturedAt: string
  elements: SitesAIPreviewVisualElement[]
}

export interface SitesAIEditDebug {
  traceId?: string
  siteId?: string
  activePageId?: string
  model?: string
  pageCount?: number
  visualContext?: boolean
  selectedElements?: number
  requestPreview?: string
  agentAttempted?: boolean
  agentApplied?: boolean
  agentOperation?: string
  agentReason?: string
  agentOperations?: string[]
  aiStatus?: string
  aiReply?: string
  changedByAI?: boolean
  fallbackAttempted?: boolean
  fallbackApplied?: boolean
  fallbackType?: string
  fallbackReason?: string
  finalStatus?: string
  steps?: string[]
}

export interface SitesAICreationResult {
  status: 'needs_more_info' | 'created' | 'updated'
  reply: string
  site?: PublicSite
  import?: ImportedSiteImport
  reason?: 'selection_target_missing'
  debug?: SitesAIEditDebug
}

export const blockLabels: Record<SiteBlockType, string> = {
  headline: 'Titular',
  subheading: 'Subtitulo',
  title: 'Titulo',
  subtitle: 'Subtitulo',
  description: 'Texto descriptivo',
  text: 'Texto',
  embed: 'Contenido externo',
  calendar_embed: 'Calendario',
  section: 'Franja',
  header_panel: 'Panel superior',
  footer_panel: 'Panel inferior',
  hero: 'Principal',
  image: 'Imagen',
  video: 'Video',
  button: 'Boton',
  benefits: 'Beneficios',
  testimonials: 'Testimonios',
  services: 'Servicios',
  form_embed: 'Formulario embebido',
  social_profile: 'Perfil de red social',
  faq: 'Preguntas frecuentes',
  cta: 'Llamado final',
  short_text: 'Respuesta corta',
  paragraph: 'Parrafo largo',
  currency: 'Moneda',
  number: 'Numero',
  dropdown: 'Lista desplegable',
  radio: 'Opcion unica',
  checkboxes: 'Varias opciones',
  phone: 'Telefono',
  email: 'Correo electronico',
  date: 'Fecha'
}

export const landingBlockTypes: SiteBlockType[] = [
  'header_panel',
  'section',
  'title',
  'subtitle',
  'text',
  'image',
  'video',
  'button',
  'benefits',
  'testimonials',
  'services',
  'embed',
  'calendar_embed',
  'social_profile',
  'form_embed',
  'faq',
  'cta',
  'footer_panel'
]

export const formBlockTypes: SiteBlockType[] = [
  'short_text',
  'paragraph',
  'number',
  'currency',
  'dropdown',
  'radio',
  'checkboxes',
  'phone',
  'email',
  'date',
  'title',
  'subtitle',
  'description',
  'image',
  'video',
  'embed',
  'calendar_embed',
  'social_profile'
]

export const blockTypes: SiteBlockType[] = [
  ...landingBlockTypes,
  'short_text',
  'paragraph',
  'currency',
  'number',
  'dropdown',
  'radio',
  'checkboxes',
  'phone',
  'email',
  'date'
]

export const fieldBlockTypes = new Set<SiteBlockType>([
  'short_text',
  'paragraph',
  'currency',
  'number',
  'dropdown',
  'radio',
  'checkboxes',
  'phone',
  'email',
  'date'
])

export const sitesService = {
  listSites() {
    return apiClient.get<PublicSite[]>('/sites')
  },

  createSite(payload: Partial<PublicSite> & { siteType?: SiteType }) {
    return apiClient.post<PublicSite>('/sites', payload)
  },

  createWithAIHtml(payload: { siteKind: SitesAICreationKind; messages: SitesAICreationMessage[]; metaCapiEnabled?: boolean; model?: string }) {
    return apiClient.post<SitesAICreationResult>('/sites/ai-create-html', payload)
  },

  editImportedHtmlWithAI(siteId: string, payload: { siteKind: SitesAICreationKind; messages: SitesAICreationMessage[]; model?: string; visualContext?: SitesAIPreviewVisualContext | null; pageId?: string; aiRegionRequest?: string }) {
    return apiClient.post<SitesAICreationResult>(`/sites/${siteId}/ai-edit-html`, payload)
  },

  updateImportedContent(siteId: string, payload: ImportedEditableContentUpdate) {
    return apiClient.patch<ImportedSiteCreateResult>(`/sites/${siteId}/import-content`, payload)
  },

  importHtmlSite(payload: {
    siteType: SiteType
    filename: string
    fileBase64: string
    metaCapiEnabled?: boolean
  }) {
    return apiClient.post<ImportedSiteCreateResult>('/sites/import-html', payload)
  },

  updateImportMapping(siteId: string, formMappings: ImportedSiteFormMapping[]) {
    return apiClient.put<ImportedSiteImport>(`/sites/${siteId}/import-mapping`, { formMappings })
  },

  getImportMapping(siteId: string) {
    return apiClient.get<ImportedSiteImport>(`/sites/${siteId}/import-mapping`)
  },

  getSite(siteId: string) {
    return apiClient.get<PublicSite>(`/sites/${siteId}`)
  },

  async getPreviewHtml(siteId: string, pageId?: string, options: { test?: boolean } = {}) {
    const searchParams = new URLSearchParams()
    if (pageId) searchParams.set('page', pageId)
    if (options.test) searchParams.set('test', '1')
    const params = searchParams.toString() ? `?${searchParams.toString()}` : ''
    const response = await fetch(`${API_BASE_URL}/api/sites/${siteId}/preview${params}`, {
      headers: getAuthHeaders(),
      cache: 'no-store'
    })

    if (!response.ok) {
      let message = 'No se pudo generar la previsualización'
      const errorResponse = response.clone()
      try {
        const payload = await response.json()
        message = payload?.error || message
      } catch {
        message = await errorResponse.text().catch(() => message)
      }
      if (/token/i.test(message)) {
        message = 'No se pudo abrir la previsualización. Actualiza la página e inténtalo otra vez.'
      }
      throw new Error(message)
    }

    return response.text()
  },

  getCalendarPreviewUrl(calendarSlug: string) {
    return `${API_BASE_URL}/api/sites/public/calendar-preview/${encodeURIComponent(calendarSlug)}?test=1`
  },

  updateSite(siteId: string, payload: Partial<PublicSite>) {
    return apiClient.put<PublicSite>(`/sites/${siteId}`, payload)
  },

  deleteSite(siteId: string) {
    return apiClient.delete(`/sites/${siteId}`)
  },

  getDomain() {
    return apiClient.get<SitesDomainConfig>('/sites/domain')
  },

  verifyDomain(domain: string) {
    return apiClient.post<SitesDomainConfig>('/sites/domain/verify', { domain })
  },

  verifySiteDomain(siteId: string, domain?: string) {
    return apiClient.post<SitesDomainConfig>(`/sites/${siteId}/verify-domain`, domain === undefined ? undefined : { domain })
  },

  createBlock(siteId: string, payload: Partial<SiteBlock> & { blockType: SiteBlockType }) {
    return apiClient.post<PublicSite>(`/sites/${siteId}/blocks`, payload)
  },

  updateBlock(siteId: string, blockId: string, payload: Partial<SiteBlock>) {
    return apiClient.put<PublicSite>(`/sites/${siteId}/blocks/${blockId}`, payload)
  },

  deleteBlock(siteId: string, blockId: string) {
    return apiClient.delete<PublicSite>(`/sites/${siteId}/blocks/${blockId}`)
  },

  restoreBlocks(siteId: string, blocks: SiteBlock[]) {
    return apiClient.post<PublicSite>(`/sites/${siteId}/blocks/restore`, { blocks })
  },

  reorderBlocks(siteId: string, blockIds: string[], pageId?: string) {
    return apiClient.put<PublicSite>(`/sites/${siteId}/blocks/reorder`, { blockIds, pageId })
  }
}
