import apiClient from './apiClient'

export type SiteType = 'standard_form' | 'interactive_form' | 'landing_page'
export type SiteStatus = 'draft' | 'published' | 'archived'
export type SiteBlockType =
  | 'headline'
  | 'subheading'
  | 'title'
  | 'subtitle'
  | 'description'
  | 'text'
  | 'embed'
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

export interface SiteTheme {
  accentColor?: string
  backgroundColor?: string
  textColor?: string
  finalMessages?: {
    success?: string
    disqualified?: string
  }
}

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
  blocks?: SiteBlock[]
  submissions?: SiteSubmission[]
}

export interface RenderVerificationResult {
  site: PublicSite
  verification: {
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
  'embed'
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

  updateSite(siteId: string, payload: Partial<PublicSite>) {
    return apiClient.put<PublicSite>(`/sites/${siteId}`, payload)
  },

  deleteSite(siteId: string) {
    return apiClient.delete(`/sites/${siteId}`)
  },

  verifyDomain(siteId: string) {
    return apiClient.post<RenderVerificationResult>(`/sites/${siteId}/verify-domain`)
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

  reorderBlocks(siteId: string, blockIds: string[]) {
    return apiClient.put<PublicSite>(`/sites/${siteId}/blocks/reorder`, { blockIds })
  }
}
