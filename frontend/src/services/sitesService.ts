import apiClient from './apiClient'
import { apiUrl, getApiBaseUrl } from './apiBaseUrl'
import type { FirstPartyVideoTracking, MediaAsset, MediaAssetPage, MediaStreamAnalytics, MediaStreamAnalyticsInput, StreamChartPoint } from './mediaService'
import { withRequestTimeout } from './requestTimeout'

const SITES_VIEW_REQUEST_TIMEOUT_MS = 20_000

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth_token')
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

export type SiteType = 'standard_form' | 'interactive_form' | 'landing_page'
export type SiteStatus = 'draft' | 'published' | 'archived'
export type SiteMetaTrigger = 'page_view' | 'form_submit' | 'calendar_schedule'
export type SiteMetaSubmitCondition = 'always' | 'qualified_only'
export type PaymentGateGateway = 'stripe' | 'conekta' | 'mercadopago' | 'clip'
export interface PaymentGateConfig {
  enabled: boolean
  gateway: PaymentGateGateway
  amount: number
  currency: string
  productName: string
  description: string
  buttonText: string
  pendingMessage: string
  paidMessage: string
}
export type SiteFormCompletionAction = 'form_default' | 'next_page' | 'next_page_if_qualified' | 'specific_page' | 'specific_page_if_qualified' | 'redirect' | 'redirect_qualified'
export type SiteFormDisqualifiedCompletionAction = 'disqualified_page' | 'redirect_url'
export type SiteBlockType =
  | 'headline'
  | 'subheading'
  | 'title'
  | 'subtitle'
  | 'description'
  | 'text'
  | 'countdown'
  | 'embed'
  | 'calendar_embed'
  | 'payment'
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
  | 'site_page'
  | 'tag'
  | 'category'

export interface SiteBlockOption {
  id?: string
  label: string
  value?: string
  action?: SiteOptionAction
  targetBlockId?: string
  targetPageId?: string
  message?: string
  redirectUrl?: string
  submitBeforeAction?: boolean
  tag?: string
  category?: string
  // Aviso previo a la descalificación: cuando la opción descalifica, muestra una
  // nota debajo al seleccionarla (la descalificación real ocurre al enviar/avanzar).
  warnBeforeDisqualify?: boolean
  disqualifyNoticeMessage?: string
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
  buttonText?: string
  buttonSubtitle?: string
  importedAssetPath?: string
  importedOriginalTitle?: string
  headerTrackingCode?: string
  metaCapiEnabled?: boolean
  metaEventName?: string
  metaTrigger?: SiteMetaTrigger
  metaEventParameters?: SiteMetaEventParameters
  // Evento Meta "al agendar" del calendario embebido en esta pagina (el sitio es master).
  // La UI lo expone como otro trigger del mismo control "Cuando".
  metaCalendarEnabled?: boolean
  metaCalendarEventName?: string
  metaCalendarEventParameters?: SiteMetaEventParameters
}

export interface SiteMetaCustomParameter {
  id?: string
  key: string
  value: string
}

export interface SiteMetaEventParameters {
  value?: string
  predictedLtv?: string
  currency?: string
  contentName?: string
  contentCategory?: string
  contentIds?: string
  contentType?: string
  numItems?: string
  orderId?: string
  status?: string
  searchString?: string
  custom?: SiteMetaCustomParameter[]
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
  importedHtmlSource?: boolean
  importId?: string
  pages?: SitePage[]
  pageMode?: 'funnel' | 'website'
  pagePadding?: number
  pageRadius?: number
  pageBorderWidth?: number
  pageBorderColor?: string
  pageMaxWidth?: number
  metaConversionTarget?: 'same_page' | 'next_page'
  metaEventParameters?: SiteMetaEventParameters
  metaCalendarEvents?: Record<string, {
    enabled?: boolean
    eventName?: string
    eventParameters?: SiteMetaEventParameters
    parameters?: SiteMetaEventParameters
  }>
  metaSubmitCondition?: SiteMetaSubmitCondition
  paymentGate?: PaymentGateConfig
  formCompletionAction?: SiteFormCompletionAction
  formQualifiedRedirectUrl?: string
  formDisqualifiedCompletionAction?: SiteFormDisqualifiedCompletionAction
  formDisqualifiedRedirectUrl?: string
  submitIncompleteOnExit?: boolean
  brandName?: string
  brandSubtitle?: string
  brandAvatar?: string
  followers?: string
  socialProfileScale?: number
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
  importedPopupHtml?: string
  submitText?: string
  submitSubtitle?: string
  continueText?: string
  nextText?: string
  backText?: string
  submitBg?: string
  submitTextColor?: string
  submitBorderColor?: string
  submitRadius?: number
  submitHeight?: number
  submitPaddingX?: number
  submitPaddingY?: number
  submitFontSize?: number
  submitBorderWidth?: number
  submitWidth?: number
  submitAlign?: 'left' | 'center' | 'right' | 'full'
  formFontFamily?: string
  siteHeadingFontFamily?: string
  siteSubheadingFontFamily?: string
  siteBodyFontFamily?: string
  formLabelSize?: number
  formInputSize?: number
  formHelpSize?: number
  formFontWeight?: 'normal' | 'bold'
  formFontStyle?: 'normal' | 'italic'
  formTextDecoration?: 'none' | 'underline'
  formLabelColor?: string
  formHelpColor?: string
  formSurfaceColor?: string
  formFieldBg?: string
  formFieldText?: string
  formFieldBorder?: string
  formPlaceholderColor?: string
  formFieldRadius?: number
  formFieldBorderWidth?: number
  formFieldHeight?: number
  formFieldPaddingX?: number
  formFieldPaddingY?: number
  formFieldWidth?: number
  formContentAlign?: 'left' | 'center' | 'right'
  formChoiceStyle?: 'native' | 'cards' | 'pills' | 'minimal' | 'grid' | 'button' | 'check' | 'segmented'
  formChoiceSelectedBg?: string
  formChoiceSelectedBorder?: string
  formSelectStyle?: 'classic' | 'filled' | 'underline' | 'soft'
  formInputStyle?: 'box' | 'underline' | 'filled' | 'soft'
  finalMessages?: {
    success?: string
    disqualified?: string
  }
  libraryFolderId?: string
  librarySource?: string
}

export interface SitesTrackingStats {
  siteId?: string
  views: number
  visitors: number
  sessions: number
  conversions: number
  conversionRate: number
}

export interface SitesTrackingAggregate extends SitesTrackingStats {
  entityCount: number
}

export interface SitesFormFunnelField {
  blockId: string
  label: string
  blockType: SiteBlockType
  required: boolean
  stepIndex: number
  reachedCount: number
  answeredCount: number
  missedCount: number
  answerRate: number
  stepCompletionRate: number
  missedRate: number
}

export interface SitesFormFunnelAnalytics {
  siteId: string
  starts: number
  views: number
  visitors: number
  submissions: number
  conversionRate: number
  fields: SitesFormFunnelField[]
}

export type SitesVideoAnalyticsSummary = FirstPartyVideoTracking['summary']

export interface SitesVideoAnalyticsAggregateItem extends SitesVideoAnalyticsSummary {
  assetId?: string
  siteId?: string
}

export interface SitesVideoAnalyticsAggregate {
  dateFrom?: string
  dateTo?: string
  summary: SitesVideoAnalyticsSummary
  viewsChart: StreamChartPoint[]
  watchTimeChart: StreamChartPoint[]
  byAssetId: Record<string, SitesVideoAnalyticsAggregateItem>
  bySiteId: Record<string, SitesVideoAnalyticsAggregateItem>
}

export interface SitesAnalyticsSummary {
  dateFrom?: string
  dateTo?: string
  aggregate: SitesTrackingAggregate
  sites: Record<string, SitesTrackingStats>
  formFunnels?: Record<string, SitesFormFunnelAnalytics>
  videos: SitesVideoAnalyticsAggregate
}

export interface SitesAnalyticsSiteScope {
  siteType: 'sites' | 'forms'
  landingMode?: 'website' | 'funnel' | 'all'
  status: 'published'
  siteId?: string
}

export interface SitesAnalyticsSummaryInput {
  siteIds?: string[]
  siteScope?: SitesAnalyticsSiteScope
  breakdownSiteIds?: string[]
  formFunnelSiteId?: string
  videoAssetIds?: string[]
  videoBreakdownAssetIds?: string[]
  videoSiteIds?: string[]
  videoScope?: {
    siteType: 'sites' | 'forms' | 'videos'
    landingMode?: 'website' | 'funnel' | 'all'
  }
  dateFrom?: string
  dateTo?: string
  hourly?: boolean
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
  {
    id: 'ristak',
    label: 'Base comercial',
    description: 'Embudo completo con propuesta clara, prueba, captura, agenda y cierre.',
    group: 'landing',
    category: 'full_page',
    accent: '#0f172a',
    swatchBg: '#eef2f7',
    swatchInk: '#0f172a',
    badge: 'Web',
    defaultTheme: {
      backgroundImage: templateImageUrls.workspace,
      backgroundColor: 'linear-gradient(115deg, rgba(248,250,252,.98), rgba(226,232,240,.68))',
      backgroundFit: 'cover',
      backgroundPosition: 'center center',
      accentColor: '#0f172a'
    }
  },
  {
    id: 'executive',
    label: 'Consultoria premium',
    description: 'Sitio sobrio para servicios, diagnosticos, agenda y seguimiento profesional.',
    group: 'landing',
    category: 'full_page',
    accent: '#0f766e',
    swatchBg: '#eff6ff',
    swatchInk: '#0f172a',
    badge: 'Web',
    defaultTheme: {
      backgroundImage: templateImageUrls.team,
      backgroundColor: 'linear-gradient(120deg, rgba(248,250,252,.98), rgba(204,251,241,.72))',
      backgroundFit: 'cover',
      backgroundPosition: 'center center',
      accentColor: '#0f766e'
    }
  },
  {
    id: 'launch',
    label: 'Lanzamiento',
    description: 'Embudo intenso para preventas, registros, bonos, urgencia y confirmacion.',
    group: 'landing',
    category: 'full_page',
    accent: '#ea580c',
    swatchBg: '#fff7ed',
    swatchInk: '#1f2937',
    badge: 'Promo',
    defaultTheme: {
      backgroundImage: templateImageUrls.planning,
      backgroundColor: 'linear-gradient(135deg, rgba(255,247,237,.98), rgba(251,146,60,.42))',
      backgroundFit: 'cover',
      backgroundPosition: 'center center',
      accentColor: '#ea580c'
    }
  },
  {
    id: 'premium',
    label: 'Alto valor',
    description: 'Experiencia oscura y elegante para propuestas selectas, aplicacion y agenda privada.',
    group: 'landing',
    category: 'full_page',
    accent: '#d4af37',
    swatchBg: '#0f0f10',
    swatchInk: '#f8fafc',
    badge: 'Premium',
    defaultTheme: {
      backgroundImage: templateImageUrls.premium,
      backgroundColor: 'linear-gradient(125deg, rgba(15,15,16,.97), rgba(39,39,42,.76))',
      backgroundFit: 'cover',
      backgroundPosition: 'center center',
      accentColor: '#d4af37',
      textColor: '#f8fafc'
    }
  },
  {
    id: 'local',
    label: 'Negocio local',
    description: 'Pagina cercana para servicios locales, confianza rapida, contacto y confirmacion.',
    group: 'landing',
    category: 'full_page',
    accent: '#15803d',
    swatchBg: '#f0fdf4',
    swatchInk: '#14532d',
    badge: 'Local',
    defaultTheme: {
      backgroundImage: templateImageUrls.local,
      backgroundColor: 'linear-gradient(115deg, rgba(240,253,244,.98), rgba(187,247,208,.7))',
      backgroundFit: 'cover',
      backgroundPosition: 'center center',
      accentColor: '#15803d'
    }
  },
  {
    id: 'vsl',
    label: 'Carta de ventas',
    description: 'Pagina de venta editorial con historia, objeciones, prueba y llamada a agenda.',
    group: 'landing',
    category: 'full_page',
    accent: '#f8fafc',
    swatchBg: '#0a0b0d',
    swatchInk: '#ffffff',
    badge: 'Venta',
    defaultTheme: {
      backgroundImage: templateImageUrls.handshake,
      backgroundColor: 'linear-gradient(140deg, rgba(10,11,13,.97), rgba(30,41,59,.76))',
      backgroundFit: 'cover',
      backgroundPosition: 'center center',
      accentColor: '#f8fafc',
      textColor: '#f8fafc'
    }
  },
  {
    id: 'facebook',
    label: 'Facebook Lead',
    description: 'Captura corta con contexto social, perfil visible y confirmacion rapida.',
    group: 'form',
    category: 'social',
    accent: '#1877f2',
    swatchBg: '#f0f2f5',
    swatchInk: '#1c1e21',
    badge: 'Redes',
    defaultTheme: { backgroundColor: '#f0f2f5', accentColor: '#1877f2', pageMaxWidth: 520, pagePadding: 18, pageRadius: 16, submitRadius: 10 }
  },
  {
    id: 'instagram',
    label: 'Instagram Lead',
    description: 'Formulario visual para trafico de publicaciones, reels o anuncios.',
    group: 'form',
    category: 'social',
    accent: '#0095f6',
    swatchBg: '#ffffff',
    swatchInk: '#262626',
    badge: 'Redes',
    defaultTheme: { backgroundColor: '#fafafa', accentColor: '#0095f6', pageMaxWidth: 520, pagePadding: 18, pageRadius: 18, submitRadius: 12 }
  },
  {
    id: 'tiktok',
    label: 'TikTok Lead',
    description: 'Captura oscura, directa y compacta para visitantes que vienen de TikTok.',
    group: 'form',
    category: 'social',
    accent: '#fe2c55',
    swatchBg: '#000000',
    swatchInk: '#ffffff',
    badge: 'Redes',
    defaultTheme: { backgroundColor: '#000000', accentColor: '#fe2c55', textColor: '#ffffff', pageMaxWidth: 520, pagePadding: 18, pageRadius: 18, submitRadius: 12 }
  },
  {
    id: 'compact',
    label: 'Captura limpia',
    description: 'Formulario corto, moderno y sin ruido para pedir datos esenciales.',
    group: 'form',
    category: 'compact',
    accent: '#2563eb',
    swatchBg: '#eff6ff',
    swatchInk: '#0f172a',
    badge: 'Corto',
    defaultTheme: {
      backgroundColor: 'linear-gradient(150deg, rgba(248,250,252,.98), rgba(219,234,254,.82))',
      accentColor: '#2563eb',
      pageMaxWidth: 500,
      pagePadding: 22,
      pageRadius: 24,
      formFieldBg: '#ffffff',
      formFieldBorder: '#bfdbfe',
      formChoiceStyle: 'cards',
      submitText: 'Enviar datos',
      submitRadius: 14,
      submitHeight: 52
    }
  },
  {
    id: 'event',
    label: 'Registro pro',
    description: 'Formulario para eventos, clases o llamadas con fecha, interes y contacto.',
    group: 'form',
    category: 'event',
    accent: '#be123c',
    swatchBg: '#fdf2f8',
    swatchInk: '#500724',
    badge: 'Registro',
    defaultTheme: {
      backgroundImage: templateImageUrls.planning,
      backgroundColor: 'linear-gradient(140deg, rgba(253,242,248,.98), rgba(251,207,232,.78))',
      backgroundFit: 'cover',
      backgroundPosition: 'center center',
      accentColor: '#be123c',
      pageMaxWidth: 560,
      pagePadding: 26,
      pageRadius: 26,
      formFieldBg: '#fff7fb',
      formFieldBorder: '#f9a8d4',
      formChoiceStyle: 'pills',
      submitText: 'Reservar mi lugar',
      submitRadius: 999,
      submitHeight: 54
    }
  },
  {
    id: 'quote',
    label: 'Cotizacion visual',
    description: 'Formulario con contexto, presupuesto y detalles para responder mejor.',
    group: 'form',
    category: 'compact',
    accent: '#5b21b6',
    swatchBg: '#f5f3ff',
    swatchInk: '#2e1065',
    badge: 'Cotiza',
    defaultTheme: {
      backgroundImage: templateImageUrls.quote,
      backgroundColor: 'linear-gradient(145deg, rgba(245,243,255,.98), rgba(221,214,254,.76))',
      backgroundFit: 'cover',
      backgroundPosition: 'center center',
      accentColor: '#5b21b6',
      pageMaxWidth: 580,
      pagePadding: 26,
      pageRadius: 24,
      formFieldBg: '#ffffff',
      formFieldBorder: '#c4b5fd',
      formChoiceStyle: 'cards',
      submitText: 'Pedir cotizacion',
      submitRadius: 16,
      submitHeight: 54
    }
  },
  {
    id: 'callback',
    label: 'Llamada consultiva',
    description: 'Formulario serio para calificar urgencia y preparar una conversacion util.',
    group: 'form',
    category: 'compact',
    accent: '#0e7490',
    swatchBg: '#ecfeff',
    swatchInk: '#164e63',
    badge: 'Llamada',
    defaultTheme: {
      backgroundImage: templateImageUrls.consult,
      backgroundColor: 'linear-gradient(140deg, rgba(236,254,255,.98), rgba(207,250,254,.74))',
      backgroundFit: 'cover',
      backgroundPosition: 'center center',
      accentColor: '#0e7490',
      pageMaxWidth: 620,
      pagePadding: 28,
      pageRadius: 20,
      formFieldBg: '#ffffff',
      formFieldBorder: '#67e8f9',
      formChoiceStyle: 'cards',
      submitText: 'Solicitar llamada',
      submitRadius: 12,
      submitHeight: 54
    }
  },
  {
    id: 'waitlist',
    label: 'Lista de espera',
    description: 'Registro ligero para cupos, preventas, fechas nuevas o acceso anticipado.',
    group: 'form',
    category: 'event',
    accent: '#c2410c',
    swatchBg: '#fff7ed',
    swatchInk: '#7c2d12',
    badge: 'Lista',
    defaultTheme: {
      backgroundImage: templateImageUrls.handshake,
      backgroundColor: 'linear-gradient(145deg, rgba(255,247,237,.98), rgba(254,215,170,.78))',
      backgroundFit: 'cover',
      backgroundPosition: 'center center',
      accentColor: '#c2410c',
      pageMaxWidth: 540,
      pagePadding: 24,
      pageRadius: 30,
      formFieldBg: '#fffaf5',
      formFieldBorder: '#fdba74',
      formChoiceStyle: 'pills',
      submitText: 'Entrar a la lista',
      submitRadius: 999,
      submitHeight: 54
    }
  },
  {
    id: 'interactive',
    label: 'Quiz guiado',
    description: 'Una pregunta por pantalla para calificar prospectos con ritmo y claridad.',
    group: 'interactive',
    category: 'guided',
    accent: '#f8fafc',
    swatchBg: '#0a0b0d',
    swatchInk: '#ffffff',
    badge: 'Quiz',
    defaultTheme: {
      backgroundColor: 'linear-gradient(140deg, rgba(10,11,13,.98), rgba(30,41,59,.78))',
      accentColor: '#f8fafc',
      textColor: '#ffffff',
      pageMaxWidth: 620,
      pagePadding: 28,
      pageRadius: 28,
      formChoiceStyle: 'cards',
      submitText: 'Enviar respuestas',
      nextText: 'Siguiente paso',
      backText: 'Regresar'
    }
  }
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
  antiTrackingEnabled?: boolean
  metaCapiEnabled: boolean
  metaEventName: string
  renderDomainVerified: boolean
  renderDomainCheckedAt: string | null
  renderDomainError: string | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  submissionsCount: number
  /** Summary ligero devuelto por el catálogo; el editor solicita el detalle al abrir. */
  summary?: boolean
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

export interface SitesListPage {
  items: PublicSite[]
  hasMore: boolean
  nextCursor: string
  limit: number
  facets?: SitesLibraryFacets | null
}

export interface SitesSelectorPage extends SitesListPage {
  selectedItems: PublicSite[]
}

export interface SitesLibraryFacets {
  total: number
  folderCounts: Record<string, number>
}

export interface SitesSelectorCollection {
  items: PublicSite[]
  truncated: boolean
  nextCursor: string
}

export type SiteLibraryFolderSection = 'landings' | 'forms'

export interface SiteLibraryFolder {
  id: string
  name: string
  section: SiteLibraryFolderSection
  sortOrder: number
  archived?: boolean
  createdAt: string
  updatedAt: string
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
  appDomain: string
  appDomainVerified: boolean
  appDomainCheckedAt: string | null
  appDomainError: string | null
  appVerification?: {
    verified: boolean
    error: string | null
  }
  defaultRoute: {
    siteId: string
    pageId?: string
    pageTitle?: string
    pagePath?: string
    name: string
    slug: string
    siteType: SiteType
    status: SiteStatus
    path: string
  } | null
  publicDomains?: PublicSiteDomain[]
}

export interface PublicSiteDomain {
  id: string
  domain: string
  renderDomainVerified: boolean
  renderDomainCheckedAt: string | null
  renderDomainError: string | null
  defaultRoute: SitesDomainConfig['defaultRoute']
  createdAt: string | null
  updatedAt: string | null
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
  present?: boolean
  options?: Array<{ label: string; value: string }>
}

export interface ImportedSiteFormMapping {
  formId: string
  formSiteId?: string
  formTitle: string
  pagePath?: string
  purpose?: string
  submitText?: string
  present?: boolean
  fields: ImportedSiteFieldMapping[]
}

export interface ImportedSiteFieldMappingPatch {
  formId: string
  fieldId: string
  pagePath?: string
  destinationType: 'standard' | 'custom' | 'new_custom' | 'ignored'
  destinationKey?: string
  customFieldDefinitionId?: string
}

export interface ImportedSiteCodeFile {
  path: string
  label: string
  pageId?: string
  pageTitle?: string
  contentType: string
  language: 'html' | 'css' | 'javascript' | 'json' | 'svg' | 'xml' | 'text'
  content: string
  sizeBytes?: number
  updatedAt?: string
  role?: 'main_html' | 'page_asset' | 'asset' | 'popup'
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
  codeFiles?: ImportedSiteCodeFile[]
  securityReport: string[]
  status: string
  createdAt: string
  updatedAt: string
}

export interface ImportedSiteCreateResult {
  site: PublicSite
  import: ImportedSiteImport
}

export interface SiteContentAsset {
  id: string
  siteId: string
  assetKey: string
  label: string
  kind: string
  mediaAssetId: string
  publicPath: string
  mediaAsset: MediaAsset | null
  createdAt?: string | null
  updatedAt?: string | null
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
  | 'disqualify_after_submit'
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
  disqualifyOutcome?: 'message' | 'specific_page' | 'url'
  automationName?: string
  // Aviso previo a la descalificación (opción de formulario importado).
  warnBeforeDisqualify?: boolean
  disqualifyNoticeMessage?: string
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
  fieldOptions?: Array<{ label: string; value: string; actions?: ImportedButtonActionStep[] }>
  fieldName?: string
  fieldHtmlId?: string
  fieldTag?: string
  fieldInputType?: string
  fontSizePx?: number
  videoSettings?: Record<string, unknown>
}

export type SitesAICreationKind = 'landing' | 'form' | 'interactive_form'

export interface SitesAIAttachmentInput {
  id?: string
  name: string
  size?: number
  mimeType?: string
  kind?: 'image' | 'text' | 'pdf' | 'file'
  text?: string
  dataUrl?: string
}

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
  progressSteps?: Array<{
    id?: string
    label?: string
    detail?: string
    status?: 'pending' | 'active' | 'done' | 'error'
  }>
  steps?: string[]
}

export interface SitesAICreationResult {
  status: 'needs_more_info' | 'created' | 'updated'
  reply: string
  site?: PublicSite
  import?: ImportedSiteImport
  draftHtml?: string
  draftPages?: Array<{ id?: string; title?: string; filename?: string; html: string }>
  reason?: 'selection_target_missing'
  debug?: SitesAIEditDebug
}

export const blockLabels: Record<SiteBlockType, string> = {
  headline: 'Titular',
  subheading: 'Subtítulo',
  title: 'Título',
  subtitle: 'Subtítulo',
  description: 'Texto descriptivo',
  text: 'Texto',
  countdown: 'Cuenta regresiva',
  embed: 'Código',
  calendar_embed: 'Calendario',
  payment: 'Pago',
  section: 'Franja',
  header_panel: 'Panel superior',
  footer_panel: 'Panel inferior',
  hero: 'Principal',
  image: 'Imagen',
  video: 'Video',
  button: 'Botón',
  benefits: 'Beneficios',
  testimonials: 'Testimonios',
  services: 'Servicios',
  form_embed: 'Formulario',
  social_profile: 'Perfil de red social',
  faq: 'Preguntas frecuentes',
  cta: 'Llamado final',
  short_text: 'Respuesta corta',
  paragraph: 'Párrafo largo',
  currency: 'Moneda',
  number: 'Número',
  dropdown: 'Lista desplegable',
  radio: 'Opción única',
  checkboxes: 'Varias opciones',
  phone: 'Teléfono',
  email: 'Correo electrónico',
  date: 'Fecha'
}

export const landingBlockTypes: SiteBlockType[] = [
  'header_panel',
  'section',
  'title',
  'subtitle',
  'text',
  'countdown',
  'image',
  'video',
  'button',
  'benefits',
  'testimonials',
  'services',
  'embed',
  'calendar_embed',
  'payment',
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
  'countdown',
  'image',
  'video',
  'embed',
  'calendar_embed',
  'payment',
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

  listSitesPage(options: {
    limit?: number
    cursor?: string
    kind?: 'landings' | 'forms'
    search?: string
    folderId?: string | null
    includeFacets?: boolean
    signal?: AbortSignal
  } = {}) {
    const params = new URLSearchParams({ paginated: '1' })
    if (options.limit) params.set('limit', String(options.limit))
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.kind) params.set('view', options.kind === 'landings' ? 'landing_library' : 'form_library')
    if (options.search?.trim()) {
      params.set('search', options.search.trim())
    } else if (options.folderId !== undefined && options.folderId !== null) {
      params.set('folderId', options.folderId || '__root__')
    }
    if (options.includeFacets !== undefined) params.set('includeFacets', options.includeFacets ? '1' : '0')
    return withRequestTimeout({
      timeoutMs: SITES_VIEW_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'La biblioteca de sitios tardó demasiado. Reintenta la carga.',
      signal: options.signal,
      request: requestSignal => apiClient.get<SitesListPage>(`/sites?${params.toString()}`, {
        signal: requestSignal
      })
    })
  },

  listSiteSelectorsPage(options: {
    kind: 'domain' | 'forms' | 'landings'
    limit?: number
    cursor?: string
    search?: string
    selectedIds?: string[]
    signal?: AbortSignal
  }) {
    const params = new URLSearchParams({
      kind: options.kind,
      limit: String(Math.min(50, Math.max(1, Math.trunc(options.limit || 30))))
    })
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.search?.trim()) params.set('search', options.search.trim())
    if (options.selectedIds?.length) params.set('selectedIds', options.selectedIds.slice(0, 50).join(','))
    return withRequestTimeout({
      timeoutMs: SITES_VIEW_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'El selector de sitios tardó demasiado. Reintenta la carga.',
      signal: options.signal,
      request: requestSignal => apiClient.get<SitesSelectorPage>(`/sites/selectors?${params.toString()}`, {
        signal: requestSignal
      })
    })
  },

  listAnalyticsSiteOptionsPage(options: {
    limit?: number
    cursor?: string
    search?: string
    siteType: 'sites' | 'forms' | 'videos'
    landingMode?: 'website' | 'funnel' | 'all'
  }) {
    const params = new URLSearchParams({
      paginated: '1',
      view: 'analytics_selector',
      limit: String(Math.min(200, Math.max(1, Math.trunc(options.limit || 100)))),
      siteType: options.siteType
    })
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.search?.trim()) params.set('search', options.search.trim())
    if (options.landingMode) params.set('landingMode', options.landingMode)
    return apiClient.get<SitesListPage>(`/sites?${params.toString()}`)
  },

  async listAllSiteSelectors(options: {
    kind: 'domain' | 'forms'
    pageSize?: number
    maxItems?: number
  }): Promise<SitesSelectorCollection> {
    const pageSize = Math.min(200, Math.max(1, Math.trunc(options.pageSize || 200)))
    const maxItems = Math.min(5000, Math.max(pageSize, Math.trunc(options.maxItems || 2000)))
    const items: PublicSite[] = []
    const seenCursors = new Set<string>()
    let cursor = ''
    let hasMore = true

    while (hasMore && items.length < maxItems) {
      const page = await this.listSiteSelectorsPage({
        kind: options.kind,
        limit: Math.min(pageSize, maxItems - items.length),
        cursor
      })
      items.push(...page.items)
      hasMore = page.hasMore
      const nextCursor = page.nextCursor || ''

      if (!hasMore || !nextCursor || seenCursors.has(nextCursor)) {
        cursor = nextCursor
        break
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }

    return {
      items,
      truncated: hasMore && items.length >= maxItems,
      nextCursor: cursor
    }
  },

  listFolders(signal?: AbortSignal) {
    return withRequestTimeout({
      timeoutMs: SITES_VIEW_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'Las carpetas de sitios tardaron demasiado. Reintenta la carga.',
      signal,
      request: requestSignal => apiClient.get<SiteLibraryFolder[]>('/sites/folders', {
        signal: requestSignal
      })
    })
  },

  createFolder(payload: { name: string; section: SiteLibraryFolderSection }) {
    return apiClient.post<SiteLibraryFolder>('/sites/folders', payload)
  },

  updateFolder(folderId: string, payload: Partial<Pick<SiteLibraryFolder, 'name' | 'section' | 'sortOrder'>>) {
    return apiClient.put<SiteLibraryFolder>(`/sites/folders/${folderId}`, payload)
  },

  createSite(payload: Partial<PublicSite> & { siteType?: SiteType }) {
    return apiClient.post<PublicSite>('/sites', payload)
  },

  createWithAIHtml(payload: { siteKind: SitesAICreationKind; messages: SitesAICreationMessage[]; metaCapiEnabled?: boolean; model?: string }) {
    return apiClient.post<SitesAICreationResult>('/sites/ai-create-html', payload)
  },

  editImportedHtmlWithAI(siteId: string, payload: { siteKind: SitesAICreationKind; messages: SitesAICreationMessage[]; model?: string; visualContext?: SitesAIPreviewVisualContext | null; pageId?: string; aiRegionRequest?: string; draftOnly?: boolean; currentHtml?: string; currentFilePath?: string; attachments?: SitesAIAttachmentInput[] }) {
    return apiClient.post<SitesAICreationResult>(`/sites/${siteId}/ai-edit-html`, payload)
  },

  updateImportedContent(siteId: string, payload: ImportedEditableContentUpdate) {
    return apiClient.patch<ImportedSiteCreateResult>(`/sites/${siteId}/import-content`, payload)
  },

  updateImportedCodeFiles(siteId: string, payload: { files: Array<{ path: string; content: string }> }) {
    return apiClient.patch<ImportedSiteCreateResult>(`/sites/${siteId}/import-code`, payload)
  },

  importHtmlSite(payload: {
    siteType: SiteType
    filename: string
    fileBase64: string
    metaCapiEnabled?: boolean
  }) {
    return apiClient.post<ImportedSiteCreateResult>('/sites/import-html', payload)
  },

  updateImportFieldMapping(siteId: string, patch: ImportedSiteFieldMappingPatch) {
    return apiClient.patch<ImportedSiteImport>(`/sites/${siteId}/import-mapping`, patch)
  },

  getImportMapping(siteId: string) {
    return apiClient.get<ImportedSiteImport>(`/sites/${siteId}/import-mapping`)
  },

  listContentAssets(siteId: string) {
    return apiClient.get<SiteContentAsset[]>(`/sites/${siteId}/content-assets`)
  },

  saveContentAsset(siteId: string, payload: { id?: string; mediaAssetId: string; assetKey?: string; label?: string; kind?: string }) {
    return payload.id
      ? apiClient.put<SiteContentAsset>(`/sites/${siteId}/content-assets/${payload.id}`, payload)
      : apiClient.post<SiteContentAsset>(`/sites/${siteId}/content-assets`, payload)
  },

  deleteContentAsset(siteId: string, bindingId: string) {
    return apiClient.delete<{ id: string; deleted: boolean }>(`/sites/${siteId}/content-assets/${bindingId}`)
  },

  getSite(siteId: string, options: {
    includeSubmissions?: boolean
    includeTrackingStats?: boolean
    submissionLimit?: number
    signal?: AbortSignal
  } = {}) {
    const params = new URLSearchParams()
    if (options.includeSubmissions) params.set('includeSubmissions', '1')
    // Biblioteca/editor/respuestas necesitan el documento, no un agregado de
    // todo el historial. Analytics tiene su propio summary por rango.
    params.set('includeTrackingStats', options.includeTrackingStats ? '1' : '0')
    if (options.submissionLimit) params.set('submissionLimit', String(options.submissionLimit))
    const query = params.toString()
    return withRequestTimeout({
      timeoutMs: SITES_VIEW_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'El sitio tardó demasiado. Reintenta la carga.',
      signal: options.signal,
      request: requestSignal => apiClient.get<PublicSite>(`/sites/${siteId}${query ? `?${query}` : ''}`, {
        signal: requestSignal
      })
    })
  },

  async getPreviewHtml(siteId: string, pageId?: string, options: {
    test?: boolean
    draftSite?: PublicSite
    draftImportedCodeFiles?: Array<{ path: string; content: string }>
    signal?: AbortSignal
  } = {}) {
    const searchParams = new URLSearchParams()
    if (pageId) searchParams.set('page', pageId)
    if (options.test) searchParams.set('test', '1')
    const params = searchParams.toString() ? `?${searchParams.toString()}` : ''
    const draftSite = options.draftSite
    const draftImportedCodeFiles = options.draftImportedCodeFiles?.length ? options.draftImportedCodeFiles : undefined
    const response = await fetch(apiUrl(`/api/sites/${siteId}/preview${params}`), {
      method: draftSite || draftImportedCodeFiles ? 'POST' : 'GET',
      headers: {
        ...getAuthHeaders(),
        ...(draftSite || draftImportedCodeFiles ? { 'Content-Type': 'application/json' } : {})
      },
      body: draftSite || draftImportedCodeFiles ? JSON.stringify({
        draftSite,
        draftImportedCodeFiles,
        importedNativePreviewMock: true
      }) : undefined,
      cache: 'no-store',
      signal: options.signal
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

  createPreviewSession(siteId: string, pageId?: string, draftSite?: PublicSite) {
    return apiClient.post<{ url: string; expiresAt: string }>(`/sites/${siteId}/preview-session`, {
      pageId,
      draftSite
    })
  },

  getCalendarPreviewUrl(calendarSlug: string, params: Record<string, string | number | undefined> = {}) {
    const searchParams = new URLSearchParams({
      test: '1',
      no_track: '1',
      embed: '1',
      editor_preview: '1'
    })
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === '') return
      searchParams.set(key, String(value))
    })
    return `${getApiBaseUrl()}/api/sites/public/calendar-preview/${encodeURIComponent(calendarSlug)}?${searchParams.toString()}`
  },

  updateSite(siteId: string, payload: Partial<PublicSite>) {
    return apiClient.put<PublicSite>(`/sites/${siteId}`, payload)
  },

  deleteSite(siteId: string) {
    return apiClient.delete(`/sites/${siteId}`)
  },

  getDomain(signal?: AbortSignal) {
    return withRequestTimeout({
      timeoutMs: SITES_VIEW_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'La configuración del dominio tardó demasiado. Reintenta la carga.',
      signal,
      request: requestSignal => apiClient.get<SitesDomainConfig>('/sites/domain', {
        signal: requestSignal
      })
    })
  },

  listVideoAssets(input: {
    limit?: number
    cursor?: string | null
    siteType?: 'sites' | 'forms' | 'videos'
    landingMode?: 'website' | 'funnel' | 'all'
    siteId?: string
  } = {}) {
    return apiClient.get<MediaAssetPage>('/sites/video-assets', {
      params: {
        limit: String(input.limit || 50),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.siteType ? { siteType: input.siteType } : {}),
        ...(input.landingMode ? { landingMode: input.landingMode } : {}),
        ...(input.siteId ? { siteId: input.siteId } : {})
      }
    })
  },

  getVideoAssetByStreamId(streamVideoId: string) {
    return apiClient.get<MediaAsset>('/sites/video-assets', {
      params: { streamVideoId }
    })
  },

  getVideoAssetById(assetId: string, options?: {
    analyticsScope?: boolean
    siteType?: 'sites' | 'forms' | 'videos'
    landingMode?: 'website' | 'funnel' | 'all'
    siteId?: string
  }) {
    return apiClient.get<MediaAsset>('/sites/video-assets', {
      params: {
        assetId,
        ...(options?.analyticsScope ? { analyticsScope: '1' } : {}),
        ...(options?.siteType ? { siteType: options.siteType } : {}),
        ...(options?.landingMode ? { landingMode: options.landingMode } : {}),
        ...(options?.siteId ? { siteId: options.siteId } : {})
      }
    })
  },

  getAnalyticsSummary(input: SitesAnalyticsSummaryInput, options: { signal?: AbortSignal } = {}) {
    return apiClient.post<SitesAnalyticsSummary>('/sites/analytics/summary', input, {
      signal: options.signal
    })
  },

  getVideoAnalytics(assetId: string, input: MediaStreamAnalyticsInput = {}) {
    const params: Record<string, string> = {}
    if (input.dateFrom) params.dateFrom = input.dateFrom
    if (input.dateTo) params.dateTo = input.dateTo
    if (input.hourly !== undefined) params.hourly = String(input.hourly)
    if (input.viewerLimit) params.viewerLimit = String(input.viewerLimit)
    return apiClient.get<MediaStreamAnalytics>(`/sites/video-analytics/${encodeURIComponent(assetId)}`, { params })
  },

  verifyDomain(domain: string) {
    return apiClient.post<SitesDomainConfig>('/sites/domain/verify', { domain })
  },

  createPublicDomain(input: { domain: string; siteId?: string | null; pageId?: string | null }) {
    return apiClient.post<SitesDomainConfig>('/sites/domains/public', {
      domain: input.domain,
      siteId: input.siteId || '',
      pageId: input.pageId || ''
    })
  },

  verifyPublicDomain(domainId: string) {
    return apiClient.post<SitesDomainConfig>(`/sites/domains/public/${encodeURIComponent(domainId)}/verify`)
  },

  setPublicDomainDefaultRoute(domainId: string, siteId?: string | null, pageId?: string | null) {
    return apiClient.post<SitesDomainConfig>(`/sites/domains/public/${encodeURIComponent(domainId)}/default-route`, {
      siteId: siteId || '',
      pageId: pageId || ''
    })
  },

  removePublicDomain(domainId: string) {
    return apiClient.delete<SitesDomainConfig>(`/sites/domains/public/${encodeURIComponent(domainId)}`)
  },

  removeDomain() {
    return apiClient.delete<SitesDomainConfig>('/sites/domain')
  },

  setDefaultDomainRoute(siteId?: string | null, pageId?: string | null) {
    return apiClient.post<SitesDomainConfig>('/sites/domain/default-route', {
      siteId: siteId || '',
      pageId: pageId || ''
    })
  },

  verifyAppDomain(domain: string) {
    return apiClient.post<SitesDomainConfig>('/sites/domain/app/verify', { domain })
  },

  removeAppDomain() {
    return apiClient.delete<SitesDomainConfig>('/sites/domain/app')
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
