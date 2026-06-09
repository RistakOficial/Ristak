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
export type SiteBlockType =
  | 'headline'
  | 'subheading'
  | 'title'
  | 'subtitle'
  | 'description'
  | 'text'
  | 'embed'
  | 'calendar_embed'
  | 'hero'
  | 'image'
  | 'video'
  | 'button'
  | 'benefits'
  | 'testimonials'
  | 'services'
  | 'form_embed'
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
  | 'show_message'
  | 'end_form'
  | 'jump'
  | 'tag'
  | 'category'

export interface SiteBlockOption {
  id?: string
  label: string
  value?: string
  action?: SiteOptionAction
  targetBlockId?: string
  message?: string
  tag?: string
  category?: string
}

export type SiteTemplateId = 'ristak' | 'facebook' | 'instagram' | 'tiktok' | 'vsl' | 'interactive'

export interface SitePage {
  id: string
  title: string
  sortOrder: number
  metaCapiEnabled?: boolean
  metaEventName?: string
  metaTrigger?: SiteMetaTrigger
}

export interface SiteTheme {
  accentColor?: string
  backgroundColor?: string
  backgroundImage?: string
  textColor?: string
  template?: SiteTemplateId
  pages?: SitePage[]
  pagePadding?: number
  pageRadius?: number
  pageBorderWidth?: number
  pageBorderColor?: string
  pageMaxWidth?: number
  metaConversionTarget?: 'same_page' | 'next_page'
  brandName?: string
  brandSubtitle?: string
  brandAvatar?: string
  followers?: string
  brandVerified?: boolean
  submitText?: string
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
  accent: string
  swatchBg: string
  swatchInk: string
  badge: string
}

export const siteTemplates: SiteTemplateMeta[] = [
  { id: 'ristak', label: 'Ristak', description: 'Limpio, minimalista y neutro. El look de marca por defecto.', group: 'landing', accent: '#111827', swatchBg: '#f5f6f8', swatchInk: '#0f172a', badge: 'Minimal' },
  { id: 'vsl', label: 'Carta de ventas', description: 'Video, checklist y un CTA fuerte. Ideal para VSL.', group: 'landing', accent: '#111827', swatchBg: '#0a0b0d', swatchInk: '#ffffff', badge: 'VSL' },
  { id: 'facebook', label: 'Facebook', description: 'Se siente como un anuncio patrocinado de Facebook.', group: 'form', accent: '#1877f2', swatchBg: '#f0f2f5', swatchInk: '#1c1e21', badge: 'Ads' },
  { id: 'instagram', label: 'Instagram', description: 'Encabezado con el degradado y azul de Instagram.', group: 'form', accent: '#0095f6', swatchBg: '#ffffff', swatchInk: '#262626', badge: 'Ads' },
  { id: 'tiktok', label: 'TikTok', description: 'Oscuro, con el rojo y cian neon de TikTok.', group: 'form', accent: '#fe2c55', swatchBg: '#000000', swatchInk: '#ffffff', badge: 'Ads' },
  { id: 'interactive', label: 'Interactivo', description: 'Una pregunta por pantalla, estilo quiz.', group: 'interactive', accent: '#111827', swatchBg: '#0a0b0d', swatchInk: '#ffffff', badge: 'Quiz' }
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

export type SitesAICreationKind = 'landing' | 'form'

export interface SitesAICreationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SitesAICreationResult {
  status: 'needs_more_info' | 'created'
  reply: string
  site?: PublicSite
}

export const blockLabels: Record<SiteBlockType, string> = {
  headline: 'Titular',
  subheading: 'Subtitulo',
  title: 'Titulo',
  subtitle: 'Subtitulo',
  description: 'Texto descriptivo',
  text: 'Texto',
  embed: 'Embed',
  calendar_embed: 'Calendario',
  hero: 'Hero',
  image: 'Imagen',
  video: 'Video',
  button: 'Boton',
  benefits: 'Beneficios',
  testimonials: 'Testimonios',
  services: 'Servicios',
  form_embed: 'Formulario embebido',
  faq: 'Preguntas frecuentes',
  cta: 'CTA final',
  short_text: 'Respuesta corta',
  paragraph: 'Parrafo',
  currency: 'Moneda',
  number: 'Numero',
  dropdown: 'Dropdown',
  radio: 'Radio buttons',
  checkboxes: 'Checkboxes',
  phone: 'Telefono',
  email: 'Email',
  date: 'Fecha'
}

export const landingBlockTypes: SiteBlockType[] = [
  'hero',
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
  'form_embed',
  'faq',
  'cta'
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
  'video',
  'embed',
  'calendar_embed'
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

  createWithAI(payload: { siteKind: SitesAICreationKind; messages: SitesAICreationMessage[] }) {
    return apiClient.post<SitesAICreationResult>('/sites/ai-create', payload)
  },

  getSite(siteId: string) {
    return apiClient.get<PublicSite>(`/sites/${siteId}`)
  },

  async getPreviewHtml(siteId: string, pageId?: string) {
    const params = pageId ? `?page=${encodeURIComponent(pageId)}` : ''
    const response = await fetch(`${API_BASE_URL}/api/sites/${siteId}/preview${params}`, {
      headers: getAuthHeaders()
    })

    if (!response.ok) {
      let message = 'No se pudo generar la previsualizacion'
      const errorResponse = response.clone()
      try {
        const payload = await response.json()
        message = payload?.error || message
      } catch {
        message = await errorResponse.text().catch(() => message)
      }
      throw new Error(message)
    }

    return response.text()
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

  reorderBlocks(siteId: string, blockIds: string[], pageId?: string) {
    return apiClient.put<PublicSite>(`/sites/${siteId}/blocks/reorder`, { blockIds, pageId })
  }
}
