import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  defaultAnimateLayoutChanges,
  type AnimateLayoutChanges,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  DollarSign,
  Eye,
  ExternalLink,
  FileText,
  FormInput,
  Globe2,
  GripVertical,
  Image,
  Instagram,
  LayoutTemplate,
  Link2,
  ListChecks,
  Maximize2,
  Monitor,
  MoreVertical,
  Music2,
  MousePointerClick,
  PanelBottom,
  PanelTop,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings2,
  Sparkles,
  Smartphone,
  Trash2,
  Type,
  Unlink2,
  Video,
  X
} from 'lucide-react'
import {
  Button,
  Loading,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  blockLabels,
  fieldBlockTypes,
  formBlockTypes,
  landingBlockTypes,
  siteTemplates,
  sitesService,
  type PublicSite,
  type SitesDomainConfig,
  type SiteBlock,
  type SiteBlockOption,
  type SiteBlockType,
  type SiteMetaTrigger,
  type SiteOptionAction,
  type SitePage,
  type SiteSubmission,
  type SiteTemplateId,
  type SiteTheme,
  type SiteType
} from '@/services/sitesService'
import { campaignsService } from '@/services/campaignsService'
import { calendarsService, type Calendar as CalendarType } from '@/services/calendarsService'
import { requestAIAgentOpen, type AIAgentSitesCreationKind } from '@/utils/aiAgentEvents'
import styles from './Sites.module.css'
import './sitesCanvas.css'
import { buildCanvasTheme } from './sitesCanvasTheme'

type SitesSection = 'landings' | 'forms' | 'leads' | 'domains'
type DeviceMode = 'desktop' | 'mobile'
type CreateFlow = 'closed' | 'landing-start' | 'landing-template' | 'form-kind' | 'form-template' | 'interactive-template'

interface LeadRow extends SiteSubmission {
  siteName: string
}

const sectionItems: Array<{ id: SitesSection; label: string; icon: React.ReactNode }> = [
  { id: 'landings', label: 'Sitios embudo', icon: <LayoutTemplate size={17} /> },
  { id: 'forms', label: 'Formularios', icon: <FormInput size={17} /> },
  { id: 'leads', label: 'Respuestas', icon: <ListChecks size={17} /> },
  { id: 'domains', label: 'Dominios', icon: <Globe2 size={17} /> }
]

const emptySitesDomainConfig: SitesDomainConfig = {
  domain: '',
  renderDomainVerified: false,
  renderDomainCheckedAt: null,
  renderDomainError: null
}

const metaEventOptions = [
  { value: 'none', label: 'Sin evento (solo PageView)' },
  { value: 'Lead', label: 'Lead' },
  { value: 'Schedule', label: 'Schedule' },
  { value: 'Purchase', label: 'Purchase' },
  { value: 'FormSubmitted', label: 'FormSubmitted' },
  { value: 'ViewContent', label: 'ViewContent' },
  { value: 'CompleteRegistration', label: 'CompleteRegistration' },
  { value: 'Contact', label: 'Contact' }
]

const metaTriggerOptions: Array<{ value: SiteMetaTrigger; label: string }> = [
  { value: 'page_view', label: 'Al aterrizar' },
  { value: 'form_submit', label: 'Al enviar formulario' }
]

const normalizeMetaEventName = (value?: string, fallback = 'Lead') =>
  metaEventOptions.some(option => option.value === value) ? value || fallback : fallback

const normalizeMetaTrigger = (value?: string): SiteMetaTrigger =>
  value === 'form_submit' ? 'form_submit' : 'page_view'

const ruleActions: Array<{ value: SiteOptionAction; label: string }> = [
  { value: 'continue', label: 'Continuar normalmente' },
  { value: 'cold_lead', label: 'Marcar lead frio' },
  { value: 'warm_lead', label: 'Marcar lead tibio' },
  { value: 'hot_lead', label: 'Marcar lead caliente' },
  { value: 'disqualify', label: 'Descalificar contacto' },
  { value: 'show_message', label: 'Mostrar mensaje de no calificado' },
  { value: 'end_form', label: 'Terminar formulario' },
  { value: 'jump', label: 'Saltar a otra pregunta' },
  { value: 'tag', label: 'Asignar etiqueta interna' },
  { value: 'category', label: 'Marcar lead con categoria' }
]

const SITES_AI_DRAFT_CREATED_EVENT = 'ristak-sites-ai-draft-created'
const SITES_EDITOR_ACTIVE_EVENT = 'ristak-sites-editor-active'
const DEFAULT_FUNNEL_PAGE_ID = 'page-1'
const SOCIAL_PROFILE_SELECTED_ID = '__social_profile__'
const PAGE_SELECTED_ID = '__page__'
const isEditorSurfaceSelection = (id: string) => id === SOCIAL_PROFILE_SELECTED_ID || id === PAGE_SELECTED_ID
const LANDING_DEFAULT_PAGE_PADDING = 36
const HEADER_PANEL_BLOCK_TYPE: SiteBlockType = 'header_panel'
const FOOTER_PANEL_BLOCK_TYPE: SiteBlockType = 'footer_panel'
const PANEL_BLOCK_TYPES = new Set<SiteBlockType>([HEADER_PANEL_BLOCK_TYPE, FOOTER_PANEL_BLOCK_TYPE])
const makeLandingSpacing = (top: number, bottom: number, right = 0, left = 0) => ({
  blockMarginLinked: false,
  blockMarginTop: top,
  blockMarginRight: right,
  blockMarginBottom: bottom,
  blockMarginLeft: left,
  blockPaddingLinked: true,
  blockPadding: 0,
  blockPaddingTop: 0,
  blockPaddingRight: 0,
  blockPaddingBottom: 0,
  blockPaddingLeft: 0
})
const LANDING_DEFAULT_BLOCK_SPACING: Partial<Record<SiteBlockType, ReturnType<typeof makeLandingSpacing>>> = {
  headline: makeLandingSpacing(0, 10),
  title: makeLandingSpacing(0, 10),
  subheading: makeLandingSpacing(6, 14),
  subtitle: makeLandingSpacing(6, 14),
  description: makeLandingSpacing(6, 16),
  text: makeLandingSpacing(8, 16),
  image: makeLandingSpacing(16, 18),
  video: makeLandingSpacing(16, 18),
  embed: makeLandingSpacing(16, 18),
  calendar_embed: makeLandingSpacing(16, 18),
  button: makeLandingSpacing(18, 18),
  hero: makeLandingSpacing(0, 0),
  benefits: makeLandingSpacing(0, 0),
  testimonials: makeLandingSpacing(0, 0),
  services: makeLandingSpacing(0, 0),
  faq: makeLandingSpacing(0, 0),
  form_embed: makeLandingSpacing(18, 0),
  cta: makeLandingSpacing(0, 0),
  header_panel: makeLandingSpacing(0, 0),
  footer_panel: makeLandingSpacing(0, 0)
}
const getLandingDefaultBlockSpacing = (blockType: SiteBlockType) =>
  LANDING_DEFAULT_BLOCK_SPACING[blockType] || makeLandingSpacing(10, 14)
const isZeroSpacingValue = (value: unknown) => {
  if (value === undefined || value === null || value === '') return true
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue === 0
}
const hasLegacyLandingBlockSpacing = (block: SiteBlock) => {
  if (fieldBlockTypes.has(block.blockType) || block.blockType === SECTION_BLOCK_TYPE || PANEL_BLOCK_TYPES.has(block.blockType)) return false
  const settings = block.settings || {}
  const top = Number(settings.blockMarginTop)
  const bottom = Number(settings.blockMarginBottom)
  const hasOldVerticalMargin = top === 50 || bottom === 50
  if (!hasOldVerticalMargin) return false
  if (!isZeroSpacingValue(settings.blockMarginRight) || !isZeroSpacingValue(settings.blockMarginLeft)) return false
  return ['blockPadding', 'blockPaddingTop', 'blockPaddingRight', 'blockPaddingBottom', 'blockPaddingLeft']
    .every(key => isZeroSpacingValue(settings[key]))
}
const normalizeLegacyLandingBlockSpacing = (block: SiteBlock): SiteBlock => {
  if (!hasLegacyLandingBlockSpacing(block)) return block
  return {
    ...block,
    settings: {
      ...(block.settings || {}),
      ...getLandingDefaultBlockSpacing(block.blockType)
    }
  }
}
const normalizeSiteForEditor = (site: PublicSite): PublicSite => ({
  ...site,
  blocks: site.blocks?.map(normalizeLegacyLandingBlockSpacing)
})
const DEFAULT_BUTTON_SETTINGS = {
  buttonAlign: 'center',
  buttonRadius: 28,
  buttonHeight: 54,
  buttonPaddingX: 28
}
const SECTION_BLOCK_TYPE: SiteBlockType = 'section'
const DEFAULT_SECTION_GAP = 24
const isTopLevelLandingBlockType = (blockType?: SiteBlockType) =>
  blockType === SECTION_BLOCK_TYPE || Boolean(blockType && PANEL_BLOCK_TYPES.has(blockType))

type PaletteDragPayload = {
  blockType: SiteBlockType
  initialSettings?: Record<string, unknown>
}

type PaletteSectionTarget = {
  sectionId: string
  sectionColumn: number
}

type AddBlockOptions = {
  insertIndex?: number
  initialSettings?: Record<string, unknown>
  sectionId?: string
  sectionColumn?: number
}

type PaletteItem = {
  id: string
  label: string
  blockType: SiteBlockType
  initialSettings?: Record<string, unknown>
}

interface LandingSectionLane {
  id: string
  section: SiteBlock | null
  columns: number
  columnBlocks: SiteBlock[][]
  sortOrder: number
}

type ButtonAction = 'url' | 'next_page' | 'specific_page'
type FormCompletionAction = 'form_default' | 'next_page' | 'next_page_if_qualified'

const blockIcons: Partial<Record<SiteBlockType, React.ReactNode>> = {
  headline: <Type size={15} />,
  subheading: <Type size={15} />,
  title: <Type size={15} />,
  subtitle: <Type size={15} />,
  description: <FileText size={15} />,
  text: <FileText size={15} />,
  embed: <Globe2 size={15} />,
  calendar_embed: <CalendarDays size={15} />,
  section: <LayoutTemplate size={15} />,
  header_panel: <PanelTop size={15} />,
  footer_panel: <PanelBottom size={15} />,
  hero: <LayoutTemplate size={15} />,
  image: <Image size={15} />,
  video: <Video size={15} />,
  button: <MousePointerClick size={15} />,
  benefits: <ListChecks size={15} />,
  testimonials: <FileText size={15} />,
  services: <LayoutTemplate size={15} />,
  form_embed: <FormInput size={15} />,
  faq: <ListChecks size={15} />,
  cta: <Send size={15} />,
  short_text: <FormInput size={15} />,
  paragraph: <FileText size={15} />,
  currency: <DollarSign size={15} />,
  number: <FormInput size={15} />,
  dropdown: <ListChecks size={15} />,
  radio: <ListChecks size={15} />,
  checkboxes: <ListChecks size={15} />,
  phone: <FormInput size={15} />,
  email: <FormInput size={15} />,
  date: <FormInput size={15} />
}

const isChoiceBlock = (blockType: SiteBlockType) =>
  blockType === 'dropdown' || blockType === 'radio' || blockType === 'checkboxes'

const nativeBorderBlockTypes = new Set<SiteBlockType>(['hero', 'section', 'cta', 'benefits', 'testimonials', 'services', 'faq', 'form_embed', 'image', 'video', 'embed', 'calendar_embed'])

const isLanding = (site?: PublicSite | null) => site?.siteType === 'landing_page'
const isFormSite = (site?: PublicSite | null) => site?.siteType === 'standard_form' || site?.siteType === 'interactive_form'

const formatDate = (value?: string | null) => {
  if (!value) return 'Sin fecha'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

const slugifyName = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '') || 'field'

const getStatusLabel = (site: PublicSite, domainConfig: SitesDomainConfig) => {
  if (site.status !== 'published') return site.status === 'draft' ? 'Borrador' : 'Archivado'
  if (!domainConfig.domain) return 'Sin dominio'
  return domainConfig.renderDomainVerified ? 'Publicado' : 'Dominio pendiente'
}

const getStatusClass = (site: PublicSite, domainConfig: SitesDomainConfig) => {
  if (site.status !== 'published') return styles.statusMuted
  if (!domainConfig.domain || !domainConfig.renderDomainVerified) return styles.statusWarning
  return styles.statusSuccess
}

const normalizeRouteInput = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/^\/+/, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

const getRoutePath = (site?: PublicSite | null) => `/${normalizeRouteInput(site?.slug || '')}`
const getTrackingSafeRoutePath = (site: PublicSite) => `${getRoutePath(site).replace(/\/$/, '')}/test`

const buildPublicUrl = (site: PublicSite, domainConfig: SitesDomainConfig) =>
  domainConfig.domain ? `https://${domainConfig.domain}${getTrackingSafeRoutePath(site)}` : ''

const getPublicRouteLabel = (site: PublicSite, domainConfig: SitesDomainConfig) =>
  domainConfig.domain ? `${domainConfig.domain}${getRoutePath(site)}` : getRoutePath(site)

const getPublicDomainPreview = (domainConfig: SitesDomainConfig) => {
  const domain = domainConfig.domain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return domain || 'www.ejemplo-de-tu-dominio.com'
}

const getDefaultSiteNamePrefix = (siteType: SiteType) =>
  siteType === 'landing_page' ? 'Embudo' : 'Formulario'

const getDefaultRoutePrefix = (siteType: SiteType) =>
  normalizeRouteInput(getDefaultSiteNamePrefix(siteType))

const getRouteEditorValue = (site?: PublicSite | null) => normalizeRouteInput(site?.slug || '')

const normalizeRouteEditorInput = (value: string, domainConfig: SitesDomainConfig) => {
  const raw = value.trim()
  if (/^https?:\/\//i.test(raw)) {
    try {
      return normalizeRouteInput(new URL(raw).pathname)
    } catch {
      return normalizeRouteInput(raw)
    }
  }

  const withoutProtocol = raw.replace(/^https?:\/\//i, '')
  const domain = getPublicDomainPreview(domainConfig).replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  const withoutDomain = withoutProtocol.toLowerCase().startsWith(`${domain.toLowerCase()}/`)
    ? withoutProtocol.slice(domain.length)
    : raw

  return normalizeRouteInput(withoutDomain)
}

const getNextSiteIdentity = (siteType: SiteType, existingSites: PublicSite[]) => {
  const namePrefix = getDefaultSiteNamePrefix(siteType)
  const routePrefix = getDefaultRoutePrefix(siteType)
  const used = new Set(existingSites.map(site => normalizeRouteInput(site.slug)))
  let index = 1
  let suffix = String(index).padStart(2, '0')
  let slug = `${routePrefix}-${suffix}`

  while (used.has(slug)) {
    index += 1
    suffix = String(index).padStart(2, '0')
    slug = `${routePrefix}-${suffix}`
  }

  return {
    name: `${namePrefix} ${suffix}`,
    slug
  }
}

const legacyPublicTitleDefaults = new Set([
  'nuevo sitio embudo',
  'nuevo sitio de embudo',
  'nuevo formulario',
  'nuevo formulario interactivo'
])

const isLegacyPublicTitleDefault = (site?: PublicSite | null) =>
  Boolean(site?.title && legacyPublicTitleDefaults.has(site.title.trim().toLowerCase()))

const getPublicTitleEditorValue = (site?: PublicSite | null) =>
  isLegacyPublicTitleDefault(site) ? '' : site?.title || ''

const getPublicTitleForSave = (site: PublicSite) =>
  isLegacyPublicTitleDefault(site) ? '' : site.title

const templateMetaById = (id?: string) => siteTemplates.find(template => template.id === id)

const getTemplateThemeDefaults = (id: SiteTemplateId, siteType: SiteType): Partial<SiteTheme> => {
  const defaults = { ...(templateMetaById(id)?.defaultTheme || {}) }
  if (siteType !== 'landing_page') return defaults

  return {
    ...defaults,
    pageMaxWidth: defaults.pageMaxWidth ?? 1440,
    pagePadding: defaults.pagePadding ?? LANDING_DEFAULT_PAGE_PADDING
  }
}

const resolveTemplateId = (site?: PublicSite | null): SiteTemplateId => {
  const explicit = site?.theme?.template
  if (explicit && templateMetaById(explicit)) return explicit
  if (site?.siteType === 'interactive_form') return 'interactive'
  if (site?.siteType === 'landing_page') return 'ristak'
  return 'ristak'
}

const isDarkTemplate = (id: SiteTemplateId) => id === 'tiktok' || id === 'vsl' || id === 'interactive' || id === 'premium'

const isHex6 = (value?: string): value is string => !!value && /^#[0-9a-f]{6}$/i.test(value)

const isCssColor = (value?: string): value is string => {
  const raw = String(value || '').trim()
  if (!raw) return false
  if (raw === 'transparent') return true
  if (isHex6(raw)) return true
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return false
  const channels = match.slice(1, 4).map(Number)
  const alpha = match[4] === undefined ? 1 : Number(match[4])
  return channels.every(channel => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1
}

const isCssGradient = (value?: string): value is string => {
  const raw = String(value || '').trim()
  return /^(linear|radial|conic)-gradient\(/i.test(raw) && !/[;{}<>]/.test(raw)
}

const isCssPaint = (value?: string): value is string => isCssColor(value) || isCssGradient(value)

const normalizeCssColor = (value: string, fallback: string) => {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'transparent') return 'rgba(0, 0, 0, 0)'
  if (isHex6(raw)) return raw
  if (!isCssColor(raw)) return fallback
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return fallback
  const [r, g, b] = match.slice(1, 4).map(valuePart => Math.round(Number(valuePart)))
  const alpha = match[4] === undefined ? 1 : Math.round(Number(match[4]) * 100) / 100
  return alpha >= 1 ? rgbToHex(r, g, b) : `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const normalizeCssPaint = (value: string, fallback: string) => {
  const raw = String(value || '').trim()
  if (isCssGradient(raw)) return raw
  return normalizeCssColor(raw, fallback)
}

const parseCssColor = (value: string, fallback = '#000000') => {
  const raw = normalizeCssColor(value, fallback)
  if (raw.startsWith('#')) {
    const h = raw.replace('#', '')
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1
    }
  }
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return parseCssColor(fallback, '#000000')
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4])
  }
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`
}

const cssColorToHex = (value: string, fallback = '#000000') => {
  const { r, g, b } = parseCssColor(value, fallback)
  return rgbToHex(r, g, b)
}

const relLum = (hex: string): number => {
  const h = cssColorToHex(hex).replace('#', '')
  const lin = (c: number) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16))
}

// Readable foreground for a solid accent/button background. Mirrors the backend
// onAccent resolution so the editor never renders white text on a white button.
const onAccentFor = (hex: string): string => (isCssColor(hex) && relLum(hex) > 0.6 ? '#08080a' : '#ffffff')

// Mirrors the backend palette resolution so the editor canvas matches the published site.
const userBgColor = (site: PublicSite): string | null => {
  const v = site.theme?.backgroundColor
  return typeof v === 'string' && isCssColor(v) && normalizeCssColor(v, '').toLowerCase() !== '#ffffff' ? normalizeCssColor(v, '#ffffff') : null
}
const userAccentColor = (site: PublicSite): string | null => {
  const v = site.theme?.accentColor
  return typeof v === 'string' && isCssColor(v) && normalizeCssColor(v, '').toLowerCase() !== '#111827' ? normalizeCssColor(v, '#111827') : null
}
const resolvedPageBg = (site: PublicSite): string => {
  const id = resolveTemplateId(site)
  if (id === 'facebook') return '#f0f2f5'
  if (id === 'instagram') return '#ffffff'
  if (id === 'tiktok') return '#000000'
  return userBgColor(site) || (site.siteType === 'landing_page' ? '#08080a' : '#ffffff')
}
const isSiteDark = (site: PublicSite): boolean => {
  const id = resolveTemplateId(site)
  if (id === 'tiktok') return true
  if (id === 'facebook' || id === 'instagram') return false
  return relLum(resolvedPageBg(site)) < 0.5
}

const defaultAccentForSite = (site: PublicSite): string =>
  userAccentColor(site) || templateMetaById(resolveTemplateId(site))?.accent || (isSiteDark(site) ? '#ffffff' : '#111827')

const platformChromeFor = (id: SiteTemplateId): 'facebook' | 'instagram' | 'tiktok' | null => {
  if (id === 'facebook' || id === 'instagram' || id === 'tiktok') return id
  return null
}

const getCreateButtonLabel = (section: SitesSection) => {
  if (section === 'landings') return 'Crear sitio embudo'
  if (section === 'forms') return 'Crear formulario'
  return 'Nuevo sitio'
}

const getLibraryTitle = (section: SitesSection) => {
  if (section === 'landings') return 'Sitios embudo'
  if (section === 'forms') return 'Formularios'
  return 'Sitios'
}

const getLibraryDescription = (section: SitesSection) => {
  if (section === 'landings') return 'Biblioteca de paginas publicas, embudos y sitios listos para editar.'
  if (section === 'forms') return 'Biblioteca de formularios publicos para capturar prospectos y respuestas.'
  return 'Biblioteca de sitios publicos.'
}

const getLibraryEmptyMessage = (section: SitesSection) => {
  if (section === 'landings') return 'Crea un sitio embudo para verlo aqui como tarjeta editable.'
  if (section === 'forms') return 'Crea un formulario para verlo aqui como tarjeta editable.'
  return getEmptyEditorMessage(section)
}

const getSiteTypeLabel = (site: PublicSite) => {
  if (site.siteType === 'landing_page') return 'Sitio embudo'
  if (site.siteType === 'interactive_form') return 'Formulario interactivo'
  return 'Formulario'
}

const getCreateFlowForSection = (section: SitesSection): CreateFlow => {
  if (section === 'forms') return 'form-kind'
  return 'landing-start'
}

const getCreateFlowHeaderCopy = (step: CreateFlow) => {
  if (step === 'landing-start') {
    return {
      title: 'Nuevo sitio embudo',
      subtitle: 'Como quieres iniciar tu sitio embudo?'
    }
  }

  if (step === 'landing-template') {
    return {
      title: 'Nuevo sitio embudo',
      subtitle: 'Elige el estilo de tu sitio embudo'
    }
  }

  if (step === 'form-kind') {
    return {
      title: 'Nuevo formulario',
      subtitle: 'Que tipo de formulario quieres?'
    }
  }

  if (step === 'form-template') {
    return {
      title: 'Nuevo formulario',
      subtitle: 'Elige el estilo de tu formulario'
    }
  }

  if (step === 'interactive-template') {
    return {
      title: 'Nuevo formulario interactivo',
      subtitle: 'Elige el estilo de tu formulario interactivo'
    }
  }

  return {
    title: 'Sitios',
    subtitle: 'Constructor visual controlado para sitios embudo, formularios, leads y publicacion por dominio verificado.'
  }
}

const getPreviousCreateFlowStep = (step: CreateFlow): CreateFlow => {
  if (step === 'landing-template') return 'landing-start'
  if (step === 'form-template' || step === 'interactive-template') return 'form-kind'
  return 'closed'
}

const getEmptyEditorMessage = (section: SitesSection) => {
  if (section === 'landings') return 'Crea un sitio embudo para entrar al editor visual.'
  if (section === 'forms') return 'Crea un formulario para entrar al editor visual.'
  return 'Crea un sitio embudo o formulario para entrar al editor visual.'
}

const getLibraryPreviewBlocks = (site: PublicSite) => {
  const blocks = [...(site.blocks || [])].sort((a, b) => a.sortOrder - b.sortOrder)
  if (!isLanding(site)) return blocks.slice(0, 4)

  const pages = normalizeFunnelPages(site)
  const firstPageId = pages[0]?.id || DEFAULT_FUNNEL_PAGE_ID
  return blocks
    .filter(block => getBlockPageId(block, pages) === firstPageId)
    .slice(0, 4)
}

const getSettingString = (settings: Record<string, unknown>, key: string) => {
  const value = settings?.[key]
  return typeof value === 'string' ? value : ''
}

const getSettingNumber = (settings: Record<string, unknown>, key: string, fallback: number, min: number, max: number) => {
  const value = Number(settings?.[key])
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

const getThemeNumber = (theme: SiteTheme | undefined, key: keyof SiteTheme, fallback: number, min: number, max: number) => {
  const value = Number(theme?.[key])
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

const getSettingHex = (settings: Record<string, unknown>, key: string, fallback: string) => {
  const value = getSettingString(settings, key)
  return isCssColor(value) ? normalizeCssColor(value, fallback) : fallback
}

const getSettingPaint = (settings: Record<string, unknown>, key: string, fallback: string) => {
  const value = getSettingString(settings, key)
  return isCssPaint(value) ? normalizeCssPaint(value, fallback) : fallback
}

const getThemeHex = (theme: SiteTheme | undefined, key: keyof SiteTheme, fallback: string) => {
  const value = theme?.[key]
  return typeof value === 'string' && isCssColor(value) ? normalizeCssColor(value, fallback) : fallback
}

const getThemePaint = (theme: SiteTheme | undefined, key: keyof SiteTheme, fallback: string) => {
  const value = theme?.[key]
  return typeof value === 'string' && isCssPaint(value) ? normalizeCssPaint(value, fallback) : fallback
}

const getThemeString = (theme: SiteTheme | undefined, key: keyof SiteTheme) => {
  const value = theme?.[key]
  return typeof value === 'string' ? value : ''
}

const getThemeBackgroundVideo = (theme: SiteTheme | undefined) => {
  const mediaType = getThemeString(theme, 'backgroundMediaType')
  const url = getThemeString(theme, 'backgroundImage').trim()
  if (mediaType !== 'video' || !url) return ''
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/') && !/^data:video\//i.test(url)) return ''
  return url.replace(/["\\\n\r]/g, '')
}

const spacingSides = [
  { id: 'Top', label: 'Arriba' },
  { id: 'Right', label: 'Derecha' },
  { id: 'Bottom', label: 'Abajo' },
  { id: 'Left', label: 'Izquierda' }
] as const

type SpacingBase = 'blockPadding' | 'blockMargin'
type HorizontalAlign = 'left' | 'center' | 'right'
type ButtonAlign = HorizontalAlign | 'full'

const horizontalAlignOptions: Array<{ value: HorizontalAlign; label: string; icon: React.ReactNode }> = [
  { value: 'left', label: 'Izquierda', icon: <AlignLeft size={14} /> },
  { value: 'center', label: 'Centro', icon: <AlignCenter size={14} /> },
  { value: 'right', label: 'Derecha', icon: <AlignRight size={14} /> }
]

const buttonAlignOptions: Array<{ value: ButtonAlign; label: string; icon: React.ReactNode }> = [
  ...horizontalAlignOptions,
  { value: 'full', label: 'Completo', icon: <Maximize2 size={14} /> }
]

const backgroundMediaTypeOptions = [
  { value: 'image', label: 'Imagen' },
  { value: 'video', label: 'Video' }
] as const

const backgroundVisualOptions = [
  { value: 'cover', label: 'Centro completo' },
  { value: 'full_width', label: 'Rellenar 100% ancho' },
  { value: 'no-repeat', label: 'No repetir' },
  { value: 'repeat', label: 'Repetir' },
  { value: 'repeat-x', label: 'Repetir horizontal' },
  { value: 'repeat-y', label: 'Repetir vertical' },
  { value: 'repeat-x-fixed-top', label: 'Repetir horizontal fijo arriba' }
] as const

const getBackgroundVisualValue = (theme: SiteTheme | undefined) => {
  if (theme?.backgroundAttachment === 'fixed' && theme.backgroundRepeat === 'repeat-x' && theme.backgroundPosition === 'center top') return 'repeat-x-fixed-top'
  if (theme?.backgroundRepeat === 'repeat') return 'repeat'
  if (theme?.backgroundRepeat === 'repeat-x') return 'repeat-x'
  if (theme?.backgroundRepeat === 'repeat-y') return 'repeat-y'
  if (theme?.backgroundRepeat === 'no-repeat' && theme.backgroundFit === 'full_width') return 'full_width'
  if (theme?.backgroundRepeat === 'no-repeat' && theme.backgroundFit === 'contain') return 'no-repeat'
  return 'cover'
}

const backgroundVisualPatch = (value: string): Partial<SiteTheme> => {
  if (value === 'full_width') return { backgroundFit: 'full_width', backgroundRepeat: 'no-repeat', backgroundPosition: 'center top', backgroundAttachment: 'scroll' }
  if (value === 'no-repeat') return { backgroundFit: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center center', backgroundAttachment: 'scroll' }
  if (value === 'repeat') return { backgroundFit: 'auto', backgroundRepeat: 'repeat', backgroundPosition: 'center top', backgroundAttachment: 'scroll' }
  if (value === 'repeat-x') return { backgroundFit: 'auto', backgroundRepeat: 'repeat-x', backgroundPosition: 'center top', backgroundAttachment: 'scroll' }
  if (value === 'repeat-y') return { backgroundFit: 'auto', backgroundRepeat: 'repeat-y', backgroundPosition: 'left top', backgroundAttachment: 'scroll' }
  if (value === 'repeat-x-fixed-top') return { backgroundFit: 'auto', backgroundRepeat: 'repeat-x', backgroundPosition: 'center top', backgroundAttachment: 'fixed' }
  return { backgroundFit: 'cover', backgroundRepeat: 'no-repeat', backgroundPosition: 'center center', backgroundAttachment: 'scroll' }
}

const isHorizontalAlign = (value: unknown): value is HorizontalAlign =>
  value === 'left' || value === 'center' || value === 'right'

const isButtonAlign = (value: unknown): value is ButtonAlign =>
  isHorizontalAlign(value) || value === 'full'

const getHorizontalAlign = (settings: Record<string, unknown>, key: string, fallback: HorizontalAlign = 'left'): HorizontalAlign => {
  const value = settings[key]
  return isHorizontalAlign(value) ? value : fallback
}

const getButtonAlign = (settings: Record<string, unknown>, fallback: ButtonAlign = 'center'): ButtonAlign => {
  const value = settings.buttonAlign
  return isButtonAlign(value) ? value : fallback
}

const justifyForAlign = (align: HorizontalAlign | ButtonAlign) => {
  if (align === 'center') return 'center'
  if (align === 'right') return 'end'
  if (align === 'full') return 'stretch'
  return 'start'
}

const marginVarsForAlign = (align: HorizontalAlign | ButtonAlign) => {
  if (align === 'center') return { left: 'auto', right: 'auto' }
  if (align === 'right') return { left: 'auto', right: '0' }
  return { left: '0', right: align === 'full' ? '0' : 'auto' }
}

const hasSpacingSideValue = (settings: Record<string, unknown>, base: SpacingBase) =>
  spacingSides.some(side => settings[`${base}${side.id}`] !== undefined)

const getSpacingValue = (
  settings: Record<string, unknown>,
  base: SpacingBase,
  side: typeof spacingSides[number]['id'],
  fallback: number,
  min: number,
  max: number
) => {
  const sideKey = `${base}${side}`
  if (settings[sideKey] !== undefined) return getSettingNumber(settings, sideKey, fallback, min, max)
  if (settings[base] !== undefined) return getSettingNumber(settings, base, fallback, min, max)
  return fallback
}

const getSpacingShorthand = (
  settings: Record<string, unknown>,
  base: SpacingBase,
  fallback: number,
  min: number,
  max: number
) => spacingSides
  .map(side => `${getSpacingValue(settings, base, side.id, fallback, min, max)}px`)
  .join(' ')

// Mirrors backend renderBlockStyleVars so per-block overrides resolve to the same
// CSS variables the published .rstk-block-style wrapper consumes.
const getBlockCanvasStyle = (block: SiteBlock): React.CSSProperties => {
  const normalizedBlock = normalizeLegacyLandingBlockSpacing(block)
  const settings = normalizedBlock.settings || {}
  const style: Record<string, string> = {}
  const bg = getSettingString(settings, 'blockBg')
  const text = getSettingString(settings, 'blockText')
  const buttonBg = getSettingString(settings, 'buttonBg')
  const buttonText = getSettingString(settings, 'buttonTextColor')
  const buttonBorder = getSettingString(settings, 'buttonBorderColor')
  const cardBg = getSettingString(settings, 'cardBg')
  const cardBorder = getSettingString(settings, 'cardBorderColor')
  const fontFamily = getSettingString(settings, 'fontFamily')
  const textStrokeColor = getSettingString(settings, 'textStrokeColor')
  const fieldBg = getSettingString(settings, 'fieldBg')
  const fieldBorder = getSettingString(settings, 'fieldBorder')
  const blockBorder = getSettingString(settings, 'blockBorderColor')
  const blockHasNativeBorder = nativeBorderBlockTypes.has(block.blockType)
  const supportsButton = block.blockType === 'hero' || block.blockType === 'button' || block.blockType === 'cta'

  if (isCssPaint(bg)) style['--rstk-block-bg'] = normalizeCssPaint(bg, '#ffffff')
  if (isCssColor(text)) style['--rstk-block-text'] = normalizeCssColor(text, '#111827')
  if (isCssPaint(buttonBg)) {
    const normalized = normalizeCssPaint(buttonBg, '#111827')
    style['--rstk-button-bg'] = normalized
    style['--rstk-button-hover-bg'] = normalized
  }
  if (isCssColor(buttonText)) style['--rstk-button-text'] = normalizeCssColor(buttonText, '#ffffff')
  if (isCssColor(buttonBorder)) style['--rstk-button-border'] = normalizeCssColor(buttonBorder, '#111827')
  if (isCssPaint(cardBg)) style['--rstk-card-bg'] = normalizeCssPaint(cardBg, '#ffffff')
  if (isCssColor(cardBorder)) style['--rstk-card-border'] = normalizeCssColor(cardBorder, '#dbe3ef')
  if (fontFamily) style['--rstk-block-font'] = fontFamily.replace(/[;"{}<>]/g, '')
  if (settings.fontStyle === 'italic') style['--rstk-block-font-style'] = 'italic'
  if (settings.textDecoration === 'underline') style['--rstk-block-text-decoration'] = 'underline'
  if (settings.textStrokeWidth !== undefined) style['--rstk-text-stroke-width'] = `${getSettingNumber(settings, 'textStrokeWidth', 0, 0, 12)}px`
  if (isCssColor(textStrokeColor)) style['--rstk-text-stroke-color'] = normalizeCssColor(textStrokeColor, '#111827')
  if (isCssPaint(fieldBg)) style['--rstk-field-bg'] = normalizeCssPaint(fieldBg, '#ffffff')
  if (isCssColor(fieldBorder)) style['--rstk-field-border'] = normalizeCssColor(fieldBorder, '#dbe3ef')
  if (isCssColor(blockBorder)) style['--rstk-block-border'] = normalizeCssColor(blockBorder, '#dbe3ef')
  if (settings.fontWeight === 'bold') style['--rstk-block-weight'] = '850'

  if (settings.textAlign !== undefined) {
    const align = getHorizontalAlign(settings, 'textAlign', 'left')
    const margins = marginVarsForAlign(align)
    style['--rstk-block-align'] = align
    style['--rstk-block-justify'] = justifyForAlign(align)
    style['--rstk-content-margin-left'] = margins.left
    style['--rstk-content-margin-right'] = margins.right
  }
  if (settings.contentMaxWidth !== undefined) style['--rstk-content-max'] = `${getSettingNumber(settings, 'contentMaxWidth', 66, 10, 120)}ch`
  if (settings.fontSize !== undefined) style['--rstk-block-size'] = `${getSettingNumber(settings, 'fontSize', 18, 12, 72)}px`
  if (settings.blockPadding !== undefined || hasSpacingSideValue(settings, 'blockPadding')) {
    style['--rstk-block-pad'] = getSpacingShorthand(settings, 'blockPadding', 0, 0, 160)
  }
  if (settings.blockMargin !== undefined || hasSpacingSideValue(settings, 'blockMargin')) {
    style['--rstk-block-margin'] = getSpacingShorthand(settings, 'blockMargin', 0, -80, 200)
  }
  if (settings.blockRadius !== undefined) style['--rstk-block-radius'] = `${getSettingNumber(settings, 'blockRadius', 8, 0, 48)}px`
  if (settings.blockBorderWidth !== undefined) {
    const width = `${getSettingNumber(settings, 'blockBorderWidth', 0, 0, 12)}px`
    style['--rstk-block-border-width'] = width
    if (!blockHasNativeBorder) style['--rstk-block-shell-border-width'] = width
  }
  if (supportsButton) {
    const align = getButtonAlign(settings, 'center')
    const margins = marginVarsForAlign(align)
    style['--rstk-button-justify'] = justifyForAlign(align)
    style['--rstk-button-margin-left'] = margins.left
    style['--rstk-button-margin-right'] = margins.right
    style['--rstk-button-width'] = align === 'full' ? '100%' : 'fit-content'
  }
  if (settings.buttonRadius !== undefined) style['--rstk-block-button-radius'] = `${getSettingNumber(settings, 'buttonRadius', 28, 0, 80)}px`
  if (settings.buttonHeight !== undefined) style['--rstk-button-height'] = `${getSettingNumber(settings, 'buttonHeight', 54, 34, 88)}px`
  if (settings.buttonPaddingX !== undefined) style['--rstk-button-pad-x'] = `${getSettingNumber(settings, 'buttonPaddingX', 28, 8, 72)}px`
  if (settings.buttonFontSize !== undefined) style['--rstk-button-size'] = `${getSettingNumber(settings, 'buttonFontSize', 16, 11, 32)}px`
  if (settings.buttonBorderWidth !== undefined) style['--rstk-button-border-width'] = `${getSettingNumber(settings, 'buttonBorderWidth', 1, 0, 8)}px`
  if (settings.mediaWidth !== undefined) style['--rstk-media-width'] = `${getSettingNumber(settings, 'mediaWidth', 100, 30, 100)}%`
  if (settings.mediaAlign !== undefined) {
    const align = getHorizontalAlign(settings, 'mediaAlign', 'center')
    const margins = marginVarsForAlign(align)
    style['--rstk-media-justify'] = justifyForAlign(align)
    style['--rstk-media-margin-left'] = margins.left
    style['--rstk-media-margin-right'] = margins.right
  }
  if (settings.mediaRadius !== undefined) style['--rstk-media-radius'] = `${getSettingNumber(settings, 'mediaRadius', 18, 0, 48)}px`
  if (settings.embedHeight !== undefined) style['--rstk-embed-height'] = `${getSettingNumber(settings, 'embedHeight', EMBED_DEFAULT_HEIGHT, EMBED_MIN_HEIGHT, EMBED_MAX_HEIGHT)}px`
  if (settings.cardRadius !== undefined) style['--rstk-card-radius'] = `${getSettingNumber(settings, 'cardRadius', 18, 0, 48)}px`
  if (settings.cardBorderWidth !== undefined) style['--rstk-card-border-width'] = `${getSettingNumber(settings, 'cardBorderWidth', 1, 0, 8)}px`
  if (settings.listColumns !== undefined) style['--rstk-list-columns'] = `repeat(${getSettingNumber(settings, 'listColumns', 3, 1, 4)}, minmax(0, 1fr))`
  if (settings.cardAlign !== undefined) style['--rstk-card-align'] = getHorizontalAlign(settings, 'cardAlign', 'left')
  if (settings.fieldRadius !== undefined) style['--rstk-field-radius'] = `${getSettingNumber(settings, 'fieldRadius', 12, 0, 32)}px`
  if (block.blockType === SECTION_BLOCK_TYPE) {
    style['--rstk-section-columns'] = `${getSectionColumns(block)}`
    style['--rstk-section-gap'] = `${getSettingNumber(settings, 'sectionGap', DEFAULT_SECTION_GAP, 0, 80)}px`
  }

  return style as React.CSSProperties
}

const getBlockStyleClassName = (block: SiteBlock, extra = '') => {
  const settings = block.settings || {}
  return [
    'rstk-block-style',
    settings.fontFamily ? 'rstkFontOverride' : '',
    settings.fontSize !== undefined ? 'rstkSizeOverride' : '',
    settings.fontWeight === 'bold' ? 'rstkWeightOverride' : '',
    settings.fontStyle === 'italic' ? 'rstkItalicOverride' : '',
    settings.textDecoration === 'underline' ? 'rstkUnderlineOverride' : '',
    settings.textStrokeWidth !== undefined ? 'rstkStrokeOverride' : '',
    extra
  ].filter(Boolean).join(' ')
}

const cloneJson = <T,>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

const normalizeFunnelPages = (site?: PublicSite | null): SitePage[] => {
  const pages = Array.isArray(site?.theme?.pages) ? site.theme.pages : []
  const seen = new Set<string>()
  const normalized = pages
    .map((page, index) => ({
      id: page?.id || `${DEFAULT_FUNNEL_PAGE_ID}-${index + 1}`,
      title: page?.title || `Pagina ${index + 1}`,
      sortOrder: Number.isFinite(Number(page?.sortOrder)) ? Number(page.sortOrder) : index,
      metaCapiEnabled: Boolean(page?.metaCapiEnabled),
      metaEventName: normalizeMetaEventName(page?.metaEventName, 'none'),
      metaTrigger: normalizeMetaTrigger(page?.metaTrigger)
    }))
    .filter(page => {
      if (!page.id || seen.has(page.id)) return false
      seen.add(page.id)
      return true
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((page, index) => ({ ...page, sortOrder: index }))

  return normalized.length ? normalized : [{ id: DEFAULT_FUNNEL_PAGE_ID, title: 'Pagina 1', sortOrder: 0 }]
}

const makeFunnelPage = (index: number): SitePage => ({
  id: `page-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  title: `Pagina ${index + 1}`,
  sortOrder: index,
  metaCapiEnabled: false,
  metaEventName: 'none',
  metaTrigger: 'page_view'
})

const normalizePagesForSave = (pages: SitePage[]) =>
  pages.map((page, index) => ({
    id: page.id,
    title: page.title || `Pagina ${index + 1}`,
    sortOrder: index,
    metaCapiEnabled: Boolean(page.metaCapiEnabled),
    metaEventName: normalizeMetaEventName(page.metaEventName, 'none'),
    metaTrigger: normalizeMetaTrigger(page.metaTrigger)
  }))

const getBlockPageId = (block: SiteBlock, pages: SitePage[]) => {
  const pageId = getSettingString(block.settings || {}, 'pageId')
  return pages.some(page => page.id === pageId) ? pageId : pages[0]?.id || DEFAULT_FUNNEL_PAGE_ID
}

const isSectionBlock = (block?: SiteBlock | null) => block?.blockType === SECTION_BLOCK_TYPE
const isPanelBlock = (block?: SiteBlock | null) => Boolean(block && PANEL_BLOCK_TYPES.has(block.blockType))

const getSectionColumns = (block?: SiteBlock | null) => {
  const value = Number(block?.settings?.sectionColumns ?? block?.settings?.columns)
  if (!Number.isFinite(value)) return 1
  return Math.min(3, Math.max(1, Math.round(value)))
}

const getBlockSectionId = (block: SiteBlock) => getSettingString(block.settings || {}, 'sectionId')

const getBlockSectionColumn = (block: SiteBlock) => {
  const value = Number(block.settings?.sectionColumn)
  if (!Number.isFinite(value)) return 0
  return Math.min(2, Math.max(0, Math.round(value)))
}

const getSectionColumnLabel = (columns: number) =>
  columns === 1 ? 'Franja 1 columna' : `Franja ${columns} columnas`

const getTextForPaint = (paint: string, fallback = '#111827') => {
  if (!isCssColor(paint)) return fallback
  return relLum(paint) > 0.58 ? '#111827' : '#ffffff'
}

const getNextSectionContrast = (site: PublicSite, pageBlocks: SiteBlock[]) => {
  const sectionCount = pageBlocks.filter(isSectionBlock).length
  const darkPage = isSiteDark(site)
  const blockBg = sectionCount % 2 === 0
    ? (darkPage ? '#ffffff' : '#111827')
    : (darkPage ? '#111827' : '#ffffff')

  return {
    blockBg,
    blockText: getTextForPaint(blockBg, darkPage ? '#111827' : '#ffffff')
  }
}

const makeLandingLane = (section: SiteBlock | null, sortOrder: number): LandingSectionLane => {
  const columns = section ? getSectionColumns(section) : 1
  return {
    id: section?.id || '__legacy-section__',
    section,
    columns,
    columnBlocks: Array.from({ length: columns }, () => []),
    sortOrder
  }
}

const buildLandingSectionLanes = (pageBlocks: SiteBlock[]): LandingSectionLane[] => {
  const sortedBlocks = [...pageBlocks].sort((a, b) => a.sortOrder - b.sortOrder)
  const sectionLanes = sortedBlocks
    .filter(isSectionBlock)
    .map(block => makeLandingLane(block, block.sortOrder))
  const sectionById = new Map(sectionLanes.map(lane => [lane.id, lane]))
  let legacyLane: LandingSectionLane | null = null

  const ensureLegacyLane = () => {
    if (!legacyLane) {
      legacyLane = makeLandingLane(null, -1)
      sectionLanes.unshift(legacyLane)
    }
    return legacyLane
  }

  sortedBlocks.forEach(block => {
    if (isSectionBlock(block)) return
    if (isPanelBlock(block)) return

    const explicitSectionId = getBlockSectionId(block)
    const explicitLane = explicitSectionId ? sectionById.get(explicitSectionId) : null
    const previousLane = explicitLane || [...sectionLanes]
      .filter(lane => lane.section && lane.sortOrder <= block.sortOrder)
      .sort((a, b) => b.sortOrder - a.sortOrder)[0]
    const lane = previousLane || ensureLegacyLane()
    const columnIndex = Math.min(lane.columns - 1, getBlockSectionColumn(block))
    lane.columnBlocks[columnIndex].push(block)
  })

  return sectionLanes
    .filter(lane => lane.section || lane.columnBlocks.some(column => column.length > 0))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(lane => ({
      ...lane,
      columnBlocks: lane.columnBlocks.map(column => [...column].sort((a, b) => a.sortOrder - b.sortOrder))
    }))
}

const getButtonAction = (settings: Record<string, unknown>): ButtonAction => {
  const action = getSettingString(settings, 'buttonAction') as ButtonAction
  return ['url', 'next_page', 'specific_page'].includes(action) ? action : 'url'
}

const getFormCompletionAction = (settings: Record<string, unknown>): FormCompletionAction => {
  const action = getSettingString(settings, 'completionAction') as FormCompletionAction
  return ['form_default', 'next_page', 'next_page_if_qualified'].includes(action) ? action : 'form_default'
}

const normalizeOption = (option: string | SiteBlockOption, index: number): SiteBlockOption => {
  if (typeof option === 'string') {
    return {
      id: `option-${index}`,
      label: option,
      value: option,
      action: 'continue'
    }
  }

  const label = option.label || option.value || `Opcion ${index + 1}`
  return {
    id: option.id || `option-${index}`,
    label,
    value: option.value || label,
    action: option.action || 'continue',
    targetBlockId: option.targetBlockId || '',
    message: option.message || '',
    tag: option.tag || '',
    category: option.category || ''
  }
}

const getOptions = (block: SiteBlock): SiteBlockOption[] =>
  (block.options || []).map(normalizeOption)

const stringifyItems = (settings: Record<string, unknown>) => {
  const items = Array.isArray(settings.items) ? settings.items : []
  return items.map(item => {
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      return [record.title, record.text, record.author].filter(Boolean).join(' | ')
    }
    return String(item || '')
  }).join('\n')
}

const parseItems = (value: string) => value
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  .map(line => {
    const [title, text, author] = line.split('|').map(part => part.trim())
    return { title, text: text || '', author: author || '' }
  })

const getPanelLinks = (settings: Record<string, unknown>) => {
  const links = Array.isArray(settings.panelLinks) ? settings.panelLinks : []
  return links
    .map(item => {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        return {
          label: String(record.label || record.title || record.name || '').trim(),
          url: String(record.url || record.href || '#').trim() || '#'
        }
      }
      const [label, url] = String(item || '').split('|').map(part => part.trim())
      return { label, url: url || '#' }
    })
    .filter(item => item.label)
}

const stringifyPanelLinks = (settings: Record<string, unknown>) =>
  getPanelLinks(settings).map(item => `${item.label} | ${item.url}`).join('\n')

const parsePanelLinks = (value: string) => value
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  .map(line => {
    const [label, url] = line.split('|').map(part => part.trim())
    return { label, url: url || '#' }
  })

interface CanvasItem { title: string; text: string; author: string }

// Mirrors backend getItems/getItemTone/stripToneMarker so canvas lists render
// identically to the published page (incl. +/- pro/con markers).
const getCanvasItems = (settings: Record<string, unknown>): CanvasItem[] => {
  const items = Array.isArray(settings.items) ? settings.items : []
  return items
    .map((item) => {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        return {
          title: String(record.title || record.label || record.name || ''),
          text: String(record.text || record.content || record.description || ''),
          author: String(record.author || record.role || '')
        }
      }
      return { title: String(item || ''), text: '', author: '' }
    })
    .filter(item => item.title || item.text)
}

const getItemTone = (item: CanvasItem): 'pro' | 'con' | 'neutral' => {
  const raw = String(item.title || item.text || '').trim()
  if (/^[+✓✔]/.test(raw)) return 'pro'
  if (/^[-–—✗✘x×]/i.test(raw)) return 'con'
  return 'neutral'
}

const stripToneMarker = (value: string) => String(value || '').replace(/^\s*[+\-–—✓✔✗✘x×]\s*/i, '').trim()

type EmbedPreviewConfig =
  | { kind: 'empty' }
  | { kind: 'url'; src: string; title: string; allow?: string; height?: number }
  | { kind: 'html'; srcDoc: string; title: string; height?: number }

const DEFAULT_EMBED_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
const EMBED_SANDBOX_URL = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const EMBED_SANDBOX_HTML = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
const EMBED_DEFAULT_HEIGHT = 360
const EMBED_MIN_HEIGHT = 180
const EMBED_MAX_HEIGHT = 760

const decodeHtmlEntities = (value: string) => value
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#039;/g, "'")
  .replace(/&#39;/g, "'")
  .replace(/&#x27;/gi, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')

const safeEmbedUrl = (value: string) => {
  const raw = decodeHtmlEntities(value).trim()
  if (!raw) return ''
  const candidate = raw.startsWith('//')
    ? `https:${raw}`
    : /^www\./i.test(raw)
      ? `https://${raw}`
      : raw

  try {
    const parsed = new URL(candidate)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

const normalizeEmbedHeight = (value: string | null | undefined) => {
  const match = String(value || '').match(/(\d{2,4})/)
  if (!match) return undefined
  const height = Number(match[1])
  if (!Number.isFinite(height)) return undefined
  return Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, height))
}

const buildEmbedSrcDoc = (html: string) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <base target="_blank">
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: transparent; color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { padding: 0; overflow-wrap: anywhere; }
      iframe, img, video { max-width: 100%; }
      iframe { border: 0; }
    </style>
  </head>
  <body>${html}</body>
</html>`

const resolveEmbedPreview = (rawValue: string): EmbedPreviewConfig => {
  const raw = rawValue.trim()
  if (!raw || raw.toLowerCase() === 'embed') return { kind: 'empty' }

  const directUrl = safeEmbedUrl(raw)
  if (directUrl) {
    return { kind: 'url', src: directUrl, title: 'Embed', height: EMBED_DEFAULT_HEIGHT }
  }

  if (/<iframe\b/i.test(raw) && typeof DOMParser !== 'undefined') {
    try {
      const document = new DOMParser().parseFromString(raw, 'text/html')
      const iframe = document.querySelector('iframe')
      const iframeUrl = safeEmbedUrl(iframe?.getAttribute('src') || '')
      if (iframeUrl) {
        return {
          kind: 'url',
          src: iframeUrl,
          title: iframe?.getAttribute('title') || 'Embed',
          allow: iframe?.getAttribute('allow') || undefined,
          height: normalizeEmbedHeight(iframe?.getAttribute('height') || iframe?.style.height)
        }
      }
    } catch {
      // Fall through to srcDoc rendering.
    }
  }

  if (/<[a-z][\s\S]*>/i.test(raw)) {
    return { kind: 'html', srcDoc: buildEmbedSrcDoc(raw), title: 'Codigo embed', height: EMBED_DEFAULT_HEIGHT }
  }

  return { kind: 'empty' }
}

const createEmbeddedBlocks = (siteId: string): SiteBlock[] => [
  {
    id: `embedded_${crypto.randomUUID()}`,
    siteId,
    blockType: 'short_text',
    label: 'Nombre completo',
    content: '',
    placeholder: 'Tu nombre',
    required: true,
    options: [],
    settings: { internalName: 'full_name' },
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: `embedded_${crypto.randomUUID()}`,
    siteId,
    blockType: 'email',
    label: 'Correo electronico',
    content: '',
    placeholder: 'tu@email.com',
    required: true,
    options: [],
    settings: { internalName: 'email', validation: 'email' },
    sortOrder: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
]

const defaultBlockPayload = (blockType: SiteBlockType, siteId: string, siteType?: SiteType) => {
  const isField = fieldBlockTypes.has(blockType)
  const label = blockLabels[blockType]
  const baseSettings: Record<string, unknown> = isField
    ? { internalName: slugifyName(label), validation: blockType === 'email' ? 'email' : blockType === 'phone' ? 'phone' : '' }
    : {}
  const landingSettings = siteType === 'landing_page' && !isField ? getLandingDefaultBlockSpacing(blockType) : {}
  const blockSettings = (settings: Record<string, unknown> = {}) => ({
    ...landingSettings,
    ...settings
  })

  if (blockType === 'hero') {
    return {
      blockType,
      label,
      content: 'Titular principal',
      settings: blockSettings({
        textAlign: 'center',
        kicker: 'Nuevo',
        subtitle: 'Subtitulo del sitio embudo',
        buttonText: 'Comenzar',
        buttonUrl: '#form',
        ...DEFAULT_BUTTON_SETTINGS
      })
    }
  }

  if (blockType === 'section') {
    return {
      blockType,
      label,
      content: '',
      settings: blockSettings({
        subtitle: '',
        sectionColumns: 1,
        sectionGap: DEFAULT_SECTION_GAP,
        blockBg: 'transparent',
        blockText: siteType === 'landing_page' ? '#f4f4f6' : '#111827',
        blockPaddingTop: 48,
        blockPaddingRight: 42,
        blockPaddingBottom: 48,
        blockPaddingLeft: 42,
        blockMarginTop: 0,
        blockMarginRight: 0,
        blockMarginBottom: 0,
        blockMarginLeft: 0,
        textAlign: 'center',
        blockRadius: 0,
        blockBorderWidth: 0
      })
    }
  }

  if (blockType === HEADER_PANEL_BLOCK_TYPE) {
    return {
      blockType,
      label,
      content: 'Tu marca',
      settings: blockSettings({
        panelLinks: [
          { label: 'Inicio', url: '#' },
          { label: 'Contacto', url: '#form' }
        ],
        blockPaddingTop: 18,
        blockPaddingRight: 42,
        blockPaddingBottom: 18,
        blockPaddingLeft: 42,
        blockBg: 'transparent',
        textAlign: 'left',
        blockRadius: 0,
        blockBorderWidth: 0
      })
    }
  }

  if (blockType === FOOTER_PANEL_BLOCK_TYPE) {
    return {
      blockType,
      label,
      content: 'Tu informacion esta protegida.',
      settings: blockSettings({
        panelLinks: [
          { label: 'API docs', url: '/docs' },
          { label: 'Instagram', url: '#' },
          { label: 'Facebook', url: '#' }
        ],
        blockPaddingTop: 24,
        blockPaddingRight: 42,
        blockPaddingBottom: 28,
        blockPaddingLeft: 42,
        blockBg: 'transparent',
        textAlign: 'center',
        blockRadius: 0,
        blockBorderWidth: 0
      })
    }
  }

  if (blockType === 'cta') {
    return {
      blockType,
      label,
      content: 'Listo para empezar?',
      settings: blockSettings({
        textAlign: 'center',
        subtitle: 'Deja tus datos y te contactamos.',
        buttonText: 'Enviar solicitud',
        buttonUrl: '#form',
        ...DEFAULT_BUTTON_SETTINGS
      })
    }
  }

  if (blockType === 'button') {
    return {
      blockType,
      label,
      content: 'Boton',
      settings: blockSettings({ buttonText: 'Continuar', buttonUrl: '#form', ...DEFAULT_BUTTON_SETTINGS })
    }
  }

  if (['benefits', 'testimonials', 'services', 'faq'].includes(blockType)) {
    return {
      blockType,
      label,
      content: label,
      settings: blockSettings({ items: [{ title: 'Elemento 1', text: 'Descripcion breve.' }, { title: 'Elemento 2', text: 'Descripcion breve.' }] })
    }
  }

  if (blockType === 'form_embed') {
    return {
      blockType,
      label,
      content: 'Formulario',
      settings: blockSettings({ description: 'Completa tus datos.', embeddedBlocks: createEmbeddedBlocks(siteId) })
    }
  }

  if (blockType === 'embed') {
    return {
      blockType,
      label,
      content: '',
      settings: blockSettings()
    }
  }

  if (blockType === 'calendar_embed') {
    return {
      blockType,
      label,
      content: '',
      settings: blockSettings({ calendarId: '', calendarSlug: '', calendarName: '' })
    }
  }

  return {
    blockType,
    label,
    content: isField ? '' : label,
    placeholder: isField ? 'Escribe aqui' : '',
    required: false,
    options: isChoiceBlock(blockType)
      ? [
          { label: 'Opcion 1', value: 'Opcion 1', action: 'continue' as SiteOptionAction },
          { label: 'Opcion 2', value: 'Opcion 2', action: 'continue' as SiteOptionAction }
        ]
      : [],
    settings: blockSettings(baseSettings)
  }
}

const makePreviewBlock = (blockType: SiteBlockType, site: PublicSite, pageId?: string, initialSettings: Record<string, unknown> = {}): SiteBlock => {
  const payload = defaultBlockPayload(blockType, site.id, site.siteType)
  return {
    id: '__palette-preview__',
    siteId: site.id,
    blockType,
    label: payload.label || blockLabels[blockType],
    content: payload.content || '',
    placeholder: payload.placeholder || '',
    required: Boolean(payload.required),
    options: payload.options || [],
    settings: {
      ...(payload.settings || {}),
      ...initialSettings,
      ...(pageId ? { pageId } : {})
    },
    sortOrder: -1,
    createdAt: '',
    updatedAt: ''
  }
}

export const Sites: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const navigate = useNavigate()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [section, setSection] = useState<SitesSection>('landings')
  const [sites, setSites] = useState<PublicSite[]>([])
  const [domainConfig, setDomainConfig] = useState<SitesDomainConfig>(emptySitesDomainConfig)
  const [domainInput, setDomainInput] = useState('')
  const [calendars, setCalendars] = useState<CalendarType[]>([])
  const [metaPixelConnected, setMetaPixelConnected] = useState(false)
  const [selectedSite, setSelectedSite] = useState<PublicSite | null>(null)
  const [selectedBlockId, setSelectedBlockId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [device, setDevice] = useState<DeviceMode>('desktop')
  const [createFlow, setCreateFlow] = useState<CreateFlow>('closed')
  const [activePageId, setActivePageId] = useState<string>(DEFAULT_FUNNEL_PAGE_ID)
  const [draggingPageId, setDraggingPageId] = useState<string | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [paletteDragging, setPaletteDragging] = useState(false)
  const [paletteDragPayload, setPaletteDragPayload] = useState<PaletteDragPayload | null>(null)
  const [paletteInsertIndex, setPaletteInsertIndex] = useState<number | null>(null)
  const [paletteSectionTarget, setPaletteSectionTarget] = useState<PaletteSectionTarget | null>(null)
  const [leadRows, setLeadRows] = useState<LeadRow[]>([])
  const [loadingLeads, setLoadingLeads] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const selectedSiteRef = useRef<PublicSite | null>(null)
  const guardHistoryArmedRef = useRef(false)
  const allowNavigationRef = useRef(false)

  useEffect(() => {
    selectedSiteRef.current = selectedSite
  }, [selectedSite])

  const landings = useMemo(
    () => sites.filter(site => site.siteType === 'landing_page'),
    [sites]
  )
  const forms = useMemo(
    () => sites.filter(site => site.siteType === 'standard_form' || site.siteType === 'interactive_form'),
    [sites]
  )
  const blocks = useMemo(
    () => [...(selectedSite?.blocks || [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [selectedSite?.blocks]
  )
  const pages = useMemo(
    () => isLanding(selectedSite) ? normalizeFunnelPages(selectedSite) : [],
    [selectedSite]
  )
  const activePage = pages.find(page => page.id === activePageId) || pages[0] || null
  const canvasBlocks = useMemo(
    () => isLanding(selectedSite) && activePage
      ? blocks.filter(block => getBlockPageId(block, pages) === activePage.id)
      : blocks,
    [activePage, blocks, pages, selectedSite]
  )
  const selectedBlock = canvasBlocks.find(block => block.id === selectedBlockId) || null
  const activeDragBlock = canvasBlocks.find(block => block.id === activeDragId) || null
  const editorSite = section === 'landings'
    ? (isLanding(selectedSite) ? selectedSite : null)
    : section === 'forms'
      ? (isFormSite(selectedSite) ? selectedSite : null)
      : null
  const metaPixelActive = Boolean(editorSite?.metaCapiEnabled || metaPixelConnected)
  const editorActive = Boolean(editorSite)
  const isFocusedSitesMode = createFlow !== 'closed' || Boolean(editorSite)
  const createFlowHeaderCopy = getCreateFlowHeaderCopy(createFlow)
  const canvasTheme = editorSite ? buildCanvasTheme(editorSite, device) : null
  const landingSectionLanes = useMemo(
    () => editorSite && isLanding(editorSite) ? buildLandingSectionLanes(canvasBlocks) : [],
    [canvasBlocks, editorSite]
  )
  const hasLandingCanvasContent = landingSectionLanes.length > 0 || canvasBlocks.some(isPanelBlock)
  const palettePreviewBlock = editorSite && paletteDragPayload
    ? makePreviewBlock(
      paletteDragPayload.blockType,
      editorSite,
      isLanding(editorSite) ? activePage?.id : undefined,
      paletteDragPayload.initialSettings
    )
    : null

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(SITES_EDITOR_ACTIVE_EVENT, {
      detail: { active: editorActive }
    }))

    return () => {
      window.dispatchEvent(new CustomEvent(SITES_EDITOR_ACTIVE_EVENT, {
        detail: { active: false }
      }))
    }
  }, [editorActive])

  const performUrlNavigation = useCallback((href: string) => {
    const target = new URL(href, window.location.href)

    if (target.origin === window.location.origin) {
      navigate(`${target.pathname}${target.search}${target.hash}`)
      return
    }

    window.location.href = target.href
  }, [navigate])

  const handleCancelLeaveEditor = useCallback(() => {
    if (hasUnsavedChanges && !guardHistoryArmedRef.current) {
      window.history.pushState({ ristakSitesUnsavedGuard: true }, '', window.location.href)
      guardHistoryArmedRef.current = true
    }
  }, [hasUnsavedChanges])

  const handleConfirmLeaveEditor = useCallback((action?: () => void) => {
    allowNavigationRef.current = true
    guardHistoryArmedRef.current = false
    setHasUnsavedChanges(false)

    action?.()

    window.setTimeout(() => {
      allowNavigationRef.current = false
    }, 500)
  }, [])

  const requestLeaveEditor = useCallback((action: () => void) => {
    if (!hasUnsavedChanges) {
      action()
      return
    }

    showConfirm(
      'Cambios sin guardar',
      'Hay cambios en el editor que todavia no se han guardado o publicado. Si sales ahora, esos ajustes se van a perder.',
      () => handleConfirmLeaveEditor(action),
      'Salir sin guardar',
      'Seguir editando',
      handleCancelLeaveEditor
    )
  }, [handleCancelLeaveEditor, handleConfirmLeaveEditor, hasUnsavedChanges, showConfirm])

  const markEditorDirty = useCallback(() => {
    if (editorSite) {
      setHasUnsavedChanges(true)
    }
  }, [editorSite])

  useEffect(() => {
    const initialEditorId = new URLSearchParams(window.location.search).get('siteEditor') || undefined
    loadSites(initialEditorId)
    loadCalendarsForBuilder()
  }, [])

  useEffect(() => {
    let mounted = true

    campaignsService.getMetaConfig()
      .then(response => {
        if (!mounted) return
        setMetaPixelConnected(Boolean(response.config?.pixelId))
      })
      .catch(() => {
        if (mounted) setMetaPixelConnected(false)
      })

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!isLanding(selectedSite)) return
    const firstPage = pages[0]
    if (!firstPage) return
    if (!pages.some(page => page.id === activePageId)) {
      setActivePageId(firstPage.id)
    }
  }, [activePageId, pages, selectedSite])

  useEffect(() => {
    if (!canvasBlocks.length) {
      if (selectedBlockId && !isEditorSurfaceSelection(selectedBlockId)) setSelectedBlockId('')
      return
    }
    if (isEditorSurfaceSelection(selectedBlockId)) return
    if (selectedBlockId && !canvasBlocks.some(block => block.id === selectedBlockId)) {
      setSelectedBlockId('')
    }
  }, [canvasBlocks, selectedBlockId])

  useEffect(() => {
    const handleAIDraftCreated = (event: Event) => {
      const rawSite = (event as CustomEvent<PublicSite>).detail
      if (!rawSite?.id) return
      const site = normalizeSiteForEditor(rawSite)

      setSites(current => [site, ...current.filter(item => item.id !== site.id)])
      setSelectedSite(site)
      setActivePageId(normalizeFunnelPages(site)[0]?.id || DEFAULT_FUNNEL_PAGE_ID)
      setSelectedBlockId('')
      setSection(site.siteType === 'landing_page' ? 'landings' : 'forms')
      setCreateFlow('closed')
      setHasUnsavedChanges(false)
    }

    window.addEventListener(SITES_AI_DRAFT_CREATED_EVENT, handleAIDraftCreated)
    return () => {
      window.removeEventListener(SITES_AI_DRAFT_CREATED_EVENT, handleAIDraftCreated)
    }
  }, [])

  useEffect(() => {
    if (section === 'leads') {
      loadLeads()
    }
  }, [section, sites.length])

  useEffect(() => {
    if (!hasUnsavedChanges) {
      guardHistoryArmedRef.current = false
      return
    }

    if (!guardHistoryArmedRef.current) {
      window.history.pushState({ ristakSitesUnsavedGuard: true }, '', window.location.href)
      guardHistoryArmedRef.current = true
    }

    const handleDocumentClick = (event: MouseEvent) => {
      if (
        allowNavigationRef.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey
      ) {
        return
      }

      const target = event.target instanceof Element ? event.target : null
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return

      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return

      const targetUrl = new URL(anchor.href, window.location.href)
      if (targetUrl.href === window.location.href) return

      event.preventDefault()
      event.stopPropagation()
      requestLeaveEditor(() => performUrlNavigation(targetUrl.href))
    }

    const handlePopState = () => {
      if (allowNavigationRef.current) return

      guardHistoryArmedRef.current = false
      requestLeaveEditor(() => window.history.back())
    }

    document.addEventListener('click', handleDocumentClick, true)
    window.addEventListener('popstate', handlePopState)

    return () => {
      document.removeEventListener('click', handleDocumentClick, true)
      window.removeEventListener('popstate', handlePopState)
    }
  }, [hasUnsavedChanges, performUrlNavigation, requestLeaveEditor])

  const loadSites = async (selectId?: string) => {
    setLoading(true)
    try {
      const [list, nextDomainConfig] = await Promise.all([
        sitesService.listSites(),
        sitesService.getDomain()
      ])
      setSites(list)
      setDomainConfig(nextDomainConfig)
      setDomainInput(nextDomainConfig.domain)
      const nextId = selectId || (selectedSite?.id && list.some(site => site.id === selectedSite.id) ? selectedSite.id : '')
      if (nextId) {
        const site = normalizeSiteForEditor(await sitesService.getSite(nextId))
        setSelectedSite(site)
        setSection(site.siteType === 'landing_page' ? 'landings' : 'forms')
        setActivePageId(normalizeFunnelPages(site)[0]?.id || DEFAULT_FUNNEL_PAGE_ID)
        setSelectedBlockId('')
      } else {
        setSelectedSite(null)
        setSelectedBlockId('')
      }
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudieron cargar los sites')
    } finally {
      setLoading(false)
    }
  }

  const loadCalendarsForBuilder = async () => {
    try {
      setCalendars(await calendarsService.getCalendars())
    } catch {
      setCalendars([])
    }
  }

  const loadLeads = async () => {
    if (!sites.length) {
      setLeadRows([])
      return
    }

    setLoadingLeads(true)
    try {
      const details = await Promise.all(sites.map(site => sitesService.getSite(site.id)))
      const rows = details.flatMap(site =>
        (site.submissions || []).map(submission => ({
          ...submission,
          siteName: site.name
        }))
      )
      rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      setLeadRows(rows)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudieron cargar los leads')
    } finally {
      setLoadingLeads(false)
    }
  }

  const openSite = async (siteId: string) => {
    try {
      const site = normalizeSiteForEditor(await sitesService.getSite(siteId))
      setSelectedSite(site)
      setActivePageId(normalizeFunnelPages(site)[0]?.id || DEFAULT_FUNNEL_PAGE_ID)
      setSelectedBlockId('')
      setCreateFlow('closed')
      setHasUnsavedChanges(false)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo abrir el site')
    }
  }

  const selectSite = (siteId: string) => {
    requestLeaveEditor(() => {
      void openSite(siteId)
    })
  }

  const changeSection = async (nextSection: SitesSection) => {
    setSection(nextSection)
    setCreateFlow('closed')
    setHasUnsavedChanges(false)

    if (nextSection === 'landings' || nextSection === 'forms') {
      setSelectedSite(null)
      setSelectedBlockId('')
    }
  }

  const handleSectionChange = (nextSection: SitesSection) => {
    if (nextSection === 'domains') {
      requestLeaveEditor(() => {
        performUrlNavigation('/settings/domains')
      })
      return
    }

    if (nextSection === section) {
      if ((section === 'landings' || section === 'forms') && (editorSite || createFlow !== 'closed')) {
        requestLeaveEditor(() => {
          setSelectedSite(null)
          setSelectedBlockId('')
          setCreateFlow('closed')
          setHasUnsavedChanges(false)
        })
      }
      return
    }

    requestLeaveEditor(() => {
      void changeSection(nextSection)
    })
  }

  const handleStartCreateFlow = () => {
    requestLeaveEditor(() => {
      setSelectedSite(null)
      setSelectedBlockId('')
      setCreateFlow(getCreateFlowForSection(section))
      setHasUnsavedChanges(false)
    })
  }

  const handleBackToLibrary = () => {
    requestLeaveEditor(() => {
      setSelectedSite(null)
      setSelectedBlockId('')
      setCreateFlow('closed')
      setHasUnsavedChanges(false)
    })
  }

  const handleFocusedBack = () => {
    if (!editorSite && createFlow !== 'closed') {
      const previousStep = getPreviousCreateFlowStep(createFlow)

      if (previousStep !== 'closed') {
        setCreateFlow(previousStep)
        return
      }
    }

    handleBackToLibrary()
  }

  const syncSelectedSite = (site: PublicSite) => {
    const normalizedSite = normalizeSiteForEditor(site)
    selectedSiteRef.current = normalizedSite
    setSelectedSite(normalizedSite)
    setSelectedBlockId(current => normalizedSite.blocks?.some(block => block.id === current) ? current : '')
    setSites(current => current.map(item => item.id === normalizedSite.id ? { ...item, ...normalizedSite } : item))
  }

  const updateSelectedSite = (patch: Partial<PublicSite>) => {
    markEditorDirty()
    const current = selectedSiteRef.current
    if (!current) return
    const next = { ...current, ...patch }
    selectedSiteRef.current = next
    setSelectedSite(next)
  }

  const patchSiteTheme = (patch: Partial<SiteTheme>) => {
    markEditorDirty()
    const current = selectedSiteRef.current
    if (!current) return
    const next = { ...current, theme: { ...(current.theme || {}), ...patch } }
    selectedSiteRef.current = next
    setSelectedSite(next)
  }

  const saveSiteTheme = async (site: PublicSite, theme: SiteTheme) => {
    return sitesService.updateSite(site.id, {
      name: site.name,
      slug: normalizeRouteInput(site.slug) || normalizeRouteInput(site.name) || getDefaultRoutePrefix(site.siteType),
      siteType: site.siteType,
      status: site.status,
      title: getPublicTitleForSave(site),
      description: site.description,
      theme,
      metaCapiEnabled: site.metaCapiEnabled,
      metaEventName: site.metaEventName
    })
  }

  const persistFunnelPages = async (nextPages: SitePage[], nextActivePageId?: string) => {
    if (!selectedSite || !isLanding(selectedSite)) return

    setSaving(true)
    try {
      const theme = {
        ...(selectedSite.theme || {}),
        pages: normalizePagesForSave(nextPages)
      }
      const site = await saveSiteTheme(selectedSite, theme)
      syncSelectedSite(site)
      setActivePageId(nextActivePageId || activePageId)
      setHasUnsavedChanges(false)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudieron guardar las paginas')
    } finally {
      setSaving(false)
    }
  }

  const handleAddPage = () => {
    if (!selectedSite || !isLanding(selectedSite)) return
    const nextPage = makeFunnelPage(pages.length)
    void persistFunnelPages([...pages, nextPage], nextPage.id)
  }

  const cloneBlockForPage = (block: SiteBlock, pageId: string): Partial<SiteBlock> & { blockType: SiteBlockType } => ({
    blockType: block.blockType,
    label: block.label,
    content: block.content,
    placeholder: block.placeholder,
    required: block.required,
    options: cloneJson(block.options),
    settings: {
      ...cloneJson(block.settings || {}),
      pageId
    }
  })

  const handleDuplicatePage = async (pageId: string) => {
    if (!selectedSite || !isLanding(selectedSite)) return

    const sourceIndex = pages.findIndex(page => page.id === pageId)
    if (sourceIndex < 0) return

    const nextPage = makeFunnelPage(pages.length)
    nextPage.title = `${pages[sourceIndex].title} copia`
    const nextPages = [
      ...pages.slice(0, sourceIndex + 1),
      nextPage,
      ...pages.slice(sourceIndex + 1)
    ]

    setSaving(true)
    try {
      let site = await saveSiteTheme(selectedSite, {
        ...(selectedSite.theme || {}),
        pages: normalizePagesForSave(nextPages)
      })
      const sourceBlocks = blocks.filter(block => getBlockPageId(block, pages) === pageId)
      for (const block of sourceBlocks) {
        site = await sitesService.createBlock(selectedSite.id, cloneBlockForPage(block, nextPage.id))
      }
      syncSelectedSite(site)
      setActivePageId(nextPage.id)
      setHasUnsavedChanges(false)
      showToast('success', 'Pagina duplicada', 'Ya esta lista para editar.')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo duplicar la pagina')
    } finally {
      setSaving(false)
    }
  }

  const handleDeletePage = async (pageId: string) => {
    if (!selectedSite || !isLanding(selectedSite)) return
    if (pages.length <= 1) {
      showToast('warning', 'No se puede eliminar', 'El embudo debe tener al menos una pagina.')
      return
    }

    showConfirm(
      'Eliminar pagina',
      'Se eliminara esta pagina y todos sus bloques. Esta accion no se puede deshacer.',
      () => {
        const deletePage = async () => {
          const pageIndex = pages.findIndex(page => page.id === pageId)
          const nextPages = pages.filter(page => page.id !== pageId)
          const nextActive = activePageId === pageId
            ? nextPages[Math.max(0, pageIndex - 1)]?.id || nextPages[0]?.id
            : activePageId

          setSaving(true)
          try {
            let site = selectedSite
            const pageBlockIds = blocks
              .filter(block => getBlockPageId(block, pages) === pageId)
              .map(block => block.id)
            for (const blockId of pageBlockIds) {
              site = await sitesService.deleteBlock(selectedSite.id, blockId)
            }
            site = await saveSiteTheme(site, {
              ...(site.theme || {}),
              pages: normalizePagesForSave(nextPages)
            })
            syncSelectedSite(site)
            setActivePageId(nextActive || DEFAULT_FUNNEL_PAGE_ID)
            setHasUnsavedChanges(false)
            showToast('success', 'Pagina eliminada', 'El embudo se actualizo.')
          } catch (error) {
            showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo eliminar la pagina')
          } finally {
            setSaving(false)
          }
        }

        void deletePage()
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const handleReorderPages = (sourcePageId: string, targetPageId: string) => {
    if (!sourcePageId || sourcePageId === targetPageId) return
    const oldIndex = pages.findIndex(page => page.id === sourcePageId)
    const newIndex = pages.findIndex(page => page.id === targetPageId)
    if (oldIndex < 0 || newIndex < 0) return
    void persistFunnelPages(arrayMove(pages, oldIndex, newIndex), activePageId)
  }

  const handleRenamePage = (pageId: string, title: string) => {
    const cleanTitle = title.trim()
    if (!cleanTitle) return
    const nextPages = pages.map((page, index) => page.id === pageId
      ? { ...page, title: cleanTitle || `Pagina ${index + 1}` }
      : page
    )
    void persistFunnelPages(nextPages, activePageId)
  }

  const handleCreateSite = async (siteType: SiteType, mode: 'blank' | 'template' = 'template', templateId?: SiteTemplateId) => {
    setCreating(true)
    try {
      const template: SiteTemplateId = templateId
        || (siteType === 'interactive_form' ? 'interactive' : siteType === 'landing_page' ? 'ristak' : 'ristak')
      const siteIdentity = getNextSiteIdentity(siteType, sites)
      const templateDefaults = getTemplateThemeDefaults(template, siteType)
      let site = await sitesService.createSite({
        name: siteIdentity.name,
        siteType,
        slug: siteIdentity.slug,
        title: '',
        theme: {
          ...templateDefaults,
          template,
          ...(siteType === 'landing_page'
            ? {
                pageMaxWidth: templateDefaults.pageMaxWidth ?? 1440,
                pages: normalizePagesForSave([{ id: DEFAULT_FUNNEL_PAGE_ID, title: 'Pagina 1', sortOrder: 0 }])
              }
            : {})
        },
        metaEventName: 'none'
      })

      if (siteType === 'landing_page' && mode === 'blank') {
        for (const block of site.blocks || []) {
          site = await sitesService.deleteBlock(site.id, block.id)
        }
      }

      site = normalizeSiteForEditor(site)
      setSites(current => [site, ...current])
      setSelectedSite(site)
      setActivePageId(normalizeFunnelPages(site)[0]?.id || DEFAULT_FUNNEL_PAGE_ID)
      setSelectedBlockId('')
      setSection(siteType === 'landing_page' ? 'landings' : 'forms')
      setCreateFlow('closed')
      setHasUnsavedChanges(false)
      showToast('success', 'Sitio creado', 'Ya estas en el editor visual')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo crear el sitio')
    } finally {
      setCreating(false)
    }
  }

  const handleCreateSiteWithAI = (siteKind: AIAgentSitesCreationKind) => {
    requestAIAgentOpen({
      sitesCreation: {
        siteKind
      }
    })
    showToast('info', 'IA abierta', 'Responde las preguntas y se va a crear un borrador editable en Sites.')
  }

  const handleSaveSite = async (statusOverride?: PublicSite['status'], options: { silent?: boolean } = {}) => {
    const siteToSave = selectedSiteRef.current || selectedSite
    if (!siteToSave) return

    if (statusOverride === 'published' && (!domainConfig.domain || !domainConfig.renderDomainVerified)) {
      showToast('error', 'Dominio requerido', 'Configura y verifica un dominio antes de publicar este sitio.')
      return
    }

    setSaving(true)
    try {
      const site = await sitesService.updateSite(siteToSave.id, {
        name: siteToSave.name,
        slug: normalizeRouteInput(siteToSave.slug) || normalizeRouteInput(siteToSave.name) || getDefaultRoutePrefix(siteToSave.siteType),
        siteType: siteToSave.siteType,
        status: statusOverride || siteToSave.status,
        title: getPublicTitleForSave(siteToSave),
        description: siteToSave.description,
        theme: siteToSave.theme,
        metaCapiEnabled: siteToSave.metaCapiEnabled,
        metaEventName: siteToSave.metaEventName
      })
      syncSelectedSite(site)
      setHasUnsavedChanges(false)
      if (!options.silent) {
        showToast('success', statusOverride === 'published' ? 'Publicado' : 'Guardado', 'Sitio actualizado')
      }
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!metaPixelConnected || !editorSite || editorSite.metaCapiEnabled) return

    updateSelectedSite({ metaCapiEnabled: true })
    window.setTimeout(() => handleSaveSite(undefined, { silent: true }), 0)
  }, [editorSite?.id, editorSite?.metaCapiEnabled, metaPixelConnected])

  const handlePreviewSite = async () => {
    if (!editorSite) return
    const previewWindow = window.open('', '_blank')
    if (!previewWindow) {
      showToast('error', 'Preview bloqueado', 'Permite popups para abrir la previsualizacion.')
      return
    }

    previewWindow.document.write('<!doctype html><title>Previsualizando...</title><body style="font-family: system-ui; padding: 24px;">Cargando previsualizacion...</body>')
    try {
      const html = await sitesService.getPreviewHtml(editorSite.id, isLanding(editorSite) ? activePage?.id : undefined, { test: true })
      previewWindow.document.open()
      previewWindow.document.write(html)
      previewWindow.document.close()
    } catch (error) {
      previewWindow.close()
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo previsualizar')
    }
  }

  const handleVerifyDomain = async () => {
    setVerifying(true)
    try {
      const result = await sitesService.verifyDomain(domainInput)
      setDomainConfig(result)
      setDomainInput(result.domain)
      if (result.verification?.verified) {
        showToast('success', 'Dominio verificado y guardado', 'El dominio ya responde con esta app')
      } else {
        showToast('warning', 'Dominio pendiente', result.verification?.error || result.renderDomainError || 'El dominio todavia no responde con esta app')
      }
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo verificar el dominio')
    } finally {
      setVerifying(false)
    }
  }

  const handleUpdateLibraryRoute = async (siteToUpdate: PublicSite, nextRoute: string) => {
    const nextSlug = normalizeRouteInput(nextRoute) || getDefaultRoutePrefix(siteToUpdate.siteType)

    try {
      const site = await sitesService.updateSite(siteToUpdate.id, {
        name: siteToUpdate.name,
        slug: nextSlug,
        siteType: siteToUpdate.siteType,
        status: siteToUpdate.status,
        title: getPublicTitleForSave(siteToUpdate),
        description: siteToUpdate.description,
        theme: siteToUpdate.theme,
        metaCapiEnabled: siteToUpdate.metaCapiEnabled,
        metaEventName: siteToUpdate.metaEventName
      })
      const normalizedSite = normalizeSiteForEditor(site)

      setSites(current => current.map(item => item.id === normalizedSite.id ? { ...item, ...normalizedSite } : item))
      if (selectedSiteRef.current?.id === normalizedSite.id) {
        selectedSiteRef.current = normalizedSite
        setSelectedSite(normalizedSite)
      }
      showToast('success', 'Ruta actualizada', `Ahora se abre en /${getRouteEditorValue(normalizedSite)}`)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar la ruta')
      throw error
    }
  }

  const handleDeleteSite = async (siteToDelete = selectedSite) => {
    if (!siteToDelete) return
    showConfirm(
      'Eliminar sitio',
      `Se eliminara "${siteToDelete.name}" y sus respuestas. Esta accion no se puede deshacer.`,
      () => {
        const deleteSite = async () => {
          try {
            await sitesService.deleteSite(siteToDelete.id)
            const nextSites = sites.filter(site => site.id !== siteToDelete.id)
            setSites(nextSites)
            if (selectedSite?.id === siteToDelete.id) {
              setSelectedSite(null)
              setSelectedBlockId('')
            }
            setHasUnsavedChanges(false)
            showToast('success', 'Eliminado', 'Sitio eliminado')
          } catch (error) {
            showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo eliminar')
          }
        }

        void deleteSite()
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const handleAddBlock = async (blockType: SiteBlockType, addOptions: AddBlockOptions | number = {}) => {
    if (!selectedSite) return
    try {
      const options = typeof addOptions === 'number' ? { insertIndex: addOptions } : addOptions
      const payload = defaultBlockPayload(blockType, selectedSite.id, selectedSite.siteType)
      const initialSettings = options.initialSettings || {}
      if (isLanding(selectedSite) && activePage) {
        const pageSectionIds = new Set(canvasBlocks.filter(isSectionBlock).map(block => block.id))
        const isSection = blockType === SECTION_BLOCK_TYPE
        const isPanel = PANEL_BLOCK_TYPES.has(blockType)
        const selectedTarget = selectedBlock
          ? isSectionBlock(selectedBlock)
            ? { sectionId: selectedBlock.id, sectionColumn: 0 }
            : getBlockSectionId(selectedBlock) && pageSectionIds.has(getBlockSectionId(selectedBlock))
              ? { sectionId: getBlockSectionId(selectedBlock), sectionColumn: getBlockSectionColumn(selectedBlock) }
              : null
          : null
        const singleSectionTarget = pageSectionIds.size === 1
          ? { sectionId: [...pageSectionIds][0], sectionColumn: 0 }
          : null
        const targetSectionId = options.sectionId && pageSectionIds.has(options.sectionId)
          ? options.sectionId
          : selectedTarget?.sectionId || singleSectionTarget?.sectionId || ''
        const targetColumn = Number.isFinite(Number(options.sectionColumn))
          ? Math.min(2, Math.max(0, Math.round(Number(options.sectionColumn))))
          : selectedTarget?.sectionColumn || singleSectionTarget?.sectionColumn || 0

        if (!isSection && !isPanel && !targetSectionId) {
          showToast('warning', 'Primero agrega una franja', 'Arrastra una franja de 1, 2 o 3 columnas y luego mete el contenido dentro.')
          return
        }

        if (isSection) {
          const columns = getSettingNumber(initialSettings, 'sectionColumns', 1, 1, 3)
          const contrast = getNextSectionContrast(selectedSite, canvasBlocks)
          payload.label = getSectionColumnLabel(columns)
          payload.content = ''
          payload.settings = {
            ...(payload.settings || {}),
            ...contrast,
            ...initialSettings,
            sectionColumns: columns,
            sectionGap: getSettingNumber(initialSettings, 'sectionGap', DEFAULT_SECTION_GAP, 0, 80)
          }
        } else if (!isPanel) {
          payload.settings = {
            ...(payload.settings || {}),
            ...initialSettings,
            sectionId: targetSectionId,
            sectionColumn: targetColumn
          }
        } else {
          payload.settings = {
            ...(payload.settings || {}),
            ...initialSettings
          }
        }

        payload.settings = {
          ...(payload.settings || {}),
          pageId: activePage.id
        }
      } else if (Object.keys(initialSettings).length > 0) {
        payload.settings = {
          ...(payload.settings || {}),
          ...initialSettings
        }
      }
      let site = await sitesService.createBlock(selectedSite.id, payload)
      const sitePages = normalizeFunnelPages(site)
      syncSelectedSite(site)
      const added = [...(site.blocks || [])]
        .filter(block => !isLanding(site) || getBlockPageId(block, sitePages) === (activePage?.id || DEFAULT_FUNNEL_PAGE_ID))
        .sort((a, b) => b.sortOrder - a.sortOrder)[0]
      if (added && Number.isFinite(options.insertIndex)) {
        const pageBlocks = [...(site.blocks || [])]
          .filter(block => !isLanding(site) || getBlockPageId(block, sitePages) === (activePage?.id || DEFAULT_FUNNEL_PAGE_ID))
          .sort((a, b) => a.sortOrder - b.sortOrder)
        const withoutAdded = pageBlocks.filter(block => block.id !== added.id)
        const boundedIndex = Math.max(0, Math.min(Number(options.insertIndex), withoutAdded.length))
        const orderedBlocks = [
          ...withoutAdded.slice(0, boundedIndex),
          added,
          ...withoutAdded.slice(boundedIndex)
        ]
        site = await sitesService.reorderBlocks(
          selectedSite.id,
          orderedBlocks.map(block => block.id),
          isLanding(site) ? activePage?.id : undefined
        )
        syncSelectedSite(site)
      }
      if (added) setSelectedBlockId(added.id)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo agregar el bloque')
    }
  }

  const patchBlockLocal = (blockId: string, patch: Partial<SiteBlock>) => {
    markEditorDirty()
    const current = selectedSiteRef.current
    if (!current?.blocks) return
    const next = {
      ...current,
      blocks: current.blocks.map(block => block.id === blockId ? { ...block, ...patch } : block)
    }
    selectedSiteRef.current = next
    setSelectedSite(next)
  }

  const patchSelectedBlock = (patch: Partial<SiteBlock>) => {
    if (!selectedBlock) return
    patchBlockLocal(selectedBlock.id, patch)
  }

  const patchSelectedBlockSettings = (patch: Record<string, unknown>) => {
    if (!selectedBlock) return
    patchSelectedBlock({
      settings: {
        ...(selectedBlock.settings || {}),
        ...patch
      }
    })
  }

  const patchBlockSettingsLocal = (block: SiteBlock, patch: Record<string, unknown>) => {
    const currentBlock = (selectedSiteRef.current?.blocks || []).find(item => item.id === block.id) || block
    patchBlockLocal(block.id, {
      settings: {
        ...(currentBlock.settings || {}),
        ...patch
      }
    })
  }

  const patchBlockCategorySettingsLocal = (sourceBlock: SiteBlock, patch: Record<string, unknown>) => {
    markEditorDirty()
    const current = selectedSiteRef.current
    if (!current?.blocks) return
    const sourcePageId = isLanding(current) ? getBlockPageId(sourceBlock, pages) : ''
    const next = {
      ...current,
      blocks: current.blocks.map(block => {
        const sameType = block.blockType === sourceBlock.blockType
        const samePage = !isLanding(current) || getBlockPageId(block, pages) === sourcePageId
        return sameType && samePage
          ? { ...block, settings: { ...(block.settings || {}), ...patch } }
          : block
      })
    }
    selectedSiteRef.current = next
    setSelectedSite(next)
  }

  const handleSaveBlockCategory = async (sourceBlock = selectedBlock) => {
    const siteToSave = selectedSiteRef.current || selectedSite
    if (!siteToSave?.blocks || !sourceBlock) return
    const sourcePageId = isLanding(siteToSave) ? getBlockPageId(sourceBlock, pages) : ''
    const targets = siteToSave.blocks.filter(block => {
      const sameType = block.blockType === sourceBlock.blockType
      const samePage = !isLanding(siteToSave) || getBlockPageId(block, pages) === sourcePageId
      return sameType && samePage
    })
    if (!targets.length) return

    try {
      let site = siteToSave
      for (const block of targets) {
        site = await sitesService.updateBlock(siteToSave.id, block.id, block)
      }
      syncSelectedSite(site)
      setHasUnsavedChanges(false)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar el estilo')
    }
  }

  const handleSaveBlock = async (blockId = selectedBlock?.id) => {
    const siteToSave = selectedSiteRef.current || selectedSite
    if (!siteToSave?.blocks || !blockId) return
    const block = siteToSave.blocks.find(item => item.id === blockId)
    if (!block) return

    try {
      const site = await sitesService.updateBlock(siteToSave.id, block.id, block)
      syncSelectedSite(site)
      setHasUnsavedChanges(false)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar el bloque')
    }
  }

  const handleDeleteBlock = async (blockId: string) => {
    if (!selectedSite) return
    try {
      const site = await sitesService.deleteBlock(selectedSite.id, blockId)
      syncSelectedSite(site)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo eliminar el bloque')
    }
  }

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id))
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null)
    if (!selectedSite || !event.over || event.active.id === event.over.id) return

    const oldIndex = canvasBlocks.findIndex(block => block.id === event.active.id)
    const newIndex = canvasBlocks.findIndex(block => block.id === event.over?.id)
    if (oldIndex < 0 || newIndex < 0) return

    const wasAlreadyDirty = hasUnsavedChanges
    const nextPageBlocks = arrayMove(canvasBlocks, oldIndex, newIndex).map((block, index) => ({ ...block, sortOrder: index }))
    const nextBlocks = blocks.map(block => nextPageBlocks.find(item => item.id === block.id) || block)
    setHasUnsavedChanges(true)
    setSelectedSite(current => current ? { ...current, blocks: nextBlocks } : current)

    try {
      const site = await sitesService.reorderBlocks(
        selectedSite.id,
        nextPageBlocks.map(block => block.id),
        isLanding(selectedSite) ? activePage?.id : undefined
      )
      syncSelectedSite(site)
      if (!wasAlreadyDirty) {
        setHasUnsavedChanges(false)
      }
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo reordenar')
    }
  }

  const getInsertIndexFromNodes = (nodes: HTMLElement[], y: number, fallbackIndex: number) => {
    const targetNode = nodes.find(node => {
      const rect = node.getBoundingClientRect()
      return y < rect.top + rect.height / 2
    })
    if (!targetNode) return fallbackIndex

    const index = Number(targetNode.dataset.rstkBlockIndex)
    return Number.isFinite(index) ? index : fallbackIndex
  }

  const getPaletteInsertIndex = (event: React.DragEvent<HTMLDivElement>, payload?: PaletteDragPayload | null) => {
    const shell = (event.currentTarget as HTMLElement).querySelector('.rstk-shell')
    if (!shell) return canvasBlocks.length

    const selector = editorSite && isLanding(editorSite) && isTopLevelLandingBlockType(payload?.blockType)
      ? '[data-rstk-page-block="true"]'
      : '[data-rstk-block-index]'
    const blockNodes = Array.from(shell.querySelectorAll<HTMLElement>(selector))
    return getInsertIndexFromNodes(blockNodes, event.clientY, canvasBlocks.length)
  }

  const getPalettePayload = (dataTransfer: DataTransfer): PaletteDragPayload | null => {
    const blockType = dataTransfer.getData('application/ristak-block') as SiteBlockType
    if (!blockType) return null

    const rawSettings = dataTransfer.getData('application/ristak-block-settings')
    let initialSettings: Record<string, unknown> | undefined
    if (rawSettings) {
      try {
        const parsed = JSON.parse(rawSettings)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          initialSettings = parsed as Record<string, unknown>
        }
      } catch {
        initialSettings = undefined
      }
    }

    return { blockType, initialSettings }
  }

  const getDropSectionTarget = (event: React.DragEvent<HTMLDivElement>): PaletteSectionTarget | null => {
    const target = event.target as HTMLElement | null
    const column = target?.closest<HTMLElement>('[data-rstk-section-column]')
    const sectionId = column?.dataset.rstkSectionId || target?.closest<HTMLElement>('[data-rstk-section-id]')?.dataset.rstkSectionId || ''
    const columnIndex = Number(column?.dataset.rstkSectionColumn)
    return sectionId
      ? {
          sectionId,
          sectionColumn: Number.isFinite(columnIndex) ? columnIndex : 0
	        }
      : null
  }

  const getSectionColumnInsertIndex = (event: React.DragEvent<HTMLDivElement>, target: PaletteSectionTarget) => {
    const eventTarget = event.target as HTMLElement | null
    const column = eventTarget?.closest<HTMLElement>('[data-rstk-section-column]')
    const columnMatchesTarget = column
      && column.dataset.rstkSectionId === target.sectionId
      && Number(column.dataset.rstkSectionColumn) === target.sectionColumn

    if (columnMatchesTarget) {
      const blockNodes = Array.from(column.querySelectorAll<HTMLElement>('[data-rstk-block-id]'))
        .filter(node => node.parentElement === column)
      const blockIndexes = blockNodes
        .map(node => Number(node.dataset.rstkBlockIndex))
        .filter(index => Number.isFinite(index))
      const lastIndex = blockIndexes.length ? Math.max(...blockIndexes) : null

      return getInsertIndexFromNodes(
        blockNodes,
        event.clientY,
        lastIndex === null ? getSectionFallbackInsertIndex(target.sectionId) : lastIndex + 1
      )
    }

    return getSectionFallbackInsertIndex(target.sectionId)
  }

  const getSectionFallbackInsertIndex = (sectionId: string) => {
    const sectionIndex = canvasBlocks.findIndex(block => block.id === sectionId)
    return sectionIndex >= 0 ? sectionIndex + 1 : canvasBlocks.length
  }

  const getPaletteDropPlacement = (event: React.DragEvent<HTMLDivElement>, payload: PaletteDragPayload) => {
    if (editorSite && isLanding(editorSite) && !isTopLevelLandingBlockType(payload.blockType)) {
      const target = getDropSectionTarget(event)
      return {
        insertIndex: target ? getSectionColumnInsertIndex(event, target) : canvasBlocks.length,
        target
      }
    }

    return {
      insertIndex: getPaletteInsertIndex(event, payload),
      target: null
    }
  }

  const resetPaletteDrag = () => {
    setPaletteDragging(false)
    setPaletteDragPayload(null)
    setPaletteInsertIndex(null)
    setPaletteSectionTarget(null)
  }

  const handleCanvasDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const payload = getPalettePayload(event.dataTransfer)
    const placement = payload ? getPaletteDropPlacement(event, payload) : null
    const insertIndex = placement?.insertIndex ?? paletteInsertIndex ?? canvasBlocks.length
    const target = placement?.target || paletteSectionTarget
    resetPaletteDrag()
    if (!payload) return
    if (editorSite && isLanding(editorSite) && !isTopLevelLandingBlockType(payload.blockType) && !target) {
      showToast('warning', 'Suelta dentro de una franja', 'El contenido necesita una franja para poder vivir ahi.')
      return
    }
    await handleAddBlock(payload.blockType, {
      insertIndex,
      initialSettings: payload.initialSettings,
      sectionId: target?.sectionId,
      sectionColumn: target?.sectionColumn
    })
  }

  const handleCanvasDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('application/ristak-block')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const payload = getPalettePayload(event.dataTransfer)
      if (!paletteDragging) setPaletteDragging(true)
      if (payload && (
        payload.blockType !== paletteDragPayload?.blockType ||
        JSON.stringify(payload.initialSettings || {}) !== JSON.stringify(paletteDragPayload?.initialSettings || {})
      )) {
        setPaletteDragPayload(payload)
      }
      if (payload) {
        const placement = getPaletteDropPlacement(event, payload)
        setPaletteInsertIndex(placement.insertIndex)
        setPaletteSectionTarget(placement.target)
      }
    }
  }

  const handleCanvasDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      resetPaletteDrag()
    }
  }

  if (loading) {
    return <Loading page="dashboard" />
  }

  return (
    <div className={styles.pageFrame}>
      <div className={`${styles.container} ${isFocusedSitesMode ? styles.containerFocused : ''}`}>
        <header className={`${styles.header} ${editorSite ? styles.editorHeader : ''}`}>
          {editorSite ? (
            <>
              <div className={styles.editorHeaderMain}>
                <div className={styles.editorHeaderIdentity}>
                  <div className={styles.titleRow}>
                    <button type="button" className={styles.backButton} onClick={handleBackToLibrary}>
                      <ArrowLeft size={16} />
                      Volver
                    </button>
                    <span className={`${styles.statusPill} ${getStatusClass(editorSite, domainConfig)}`}>{getStatusLabel(editorSite, domainConfig)}</span>
                  </div>
                  <label className={styles.editorNameField}>
                    <input
                      value={editorSite.name}
                      aria-label="Nombre interno del site"
                      style={{ width: `calc(${Math.max((editorSite.name || '').length, 6)}ch + 16px)` }}
                      onChange={(event) => updateSelectedSite({ name: event.target.value })}
                      onBlur={() => handleSaveSite(undefined, { silent: true })}
                    />
                    <Pencil size={15} />
                  </label>
                  <label className={styles.publicTitleEditorField}>
                    <input
                      value={getPublicTitleEditorValue(editorSite)}
                      aria-label="Nombre público"
                      placeholder="Nombre público"
                      style={{ width: `calc(${Math.max(getPublicTitleEditorValue(editorSite).length, 'Nombre público'.length)}ch + 16px)` }}
                      onChange={(event) => updateSelectedSite({ title: event.target.value })}
                      onBlur={() => handleSaveSite(undefined, { silent: true })}
                    />
                    <Pencil size={14} />
                  </label>
                </div>
                <div className={styles.editorTopControls}>
                  <div className={styles.editorPublishControls}>
                    <label className={styles.routeField}>
                      <span className={`${styles.publicRouteBox} ${domainConfig.domain ? '' : styles.publicRouteBoxStandalone}`}>
                        <span className={styles.publicRouteDomain} title={getPublicDomainPreview(domainConfig)}>
                          {getPublicDomainPreview(domainConfig)}
                        </span>
                        <span className={styles.publicRouteSlash} aria-hidden="true">/</span>
                        <input
                          value={getRouteEditorValue(editorSite)}
                          aria-label="Ruta pública"
                          placeholder={editorSite.siteType === 'landing_page' ? 'embudo-01' : 'formulario-01'}
                          onChange={(event) => updateSelectedSite({ slug: normalizeRouteEditorInput(event.target.value, domainConfig) })}
                          onBlur={() => handleSaveSite(undefined, { silent: true })}
                        />
                      </span>
                    </label>
                    <div className={`${styles.metaCard} ${metaPixelActive ? styles.metaCardActive : ''}`}>
                      <button
                        type="button"
                        className={styles.metaPixelButton}
                        aria-pressed={metaPixelActive}
                        onClick={() => {
                          if (!editorSite.metaCapiEnabled) {
                            updateSelectedSite({ metaCapiEnabled: true })
                            window.setTimeout(() => handleSaveSite(undefined, { silent: true }), 0)
                          }
                        }}
                      >
                        <span className={styles.metaMark} aria-hidden="true">∞</span>
                        <span>Meta Pixel</span>
                        <small>{metaPixelActive ? 'Encendido' : 'Activar'}</small>
                      </button>
                      <label className={styles.metaCardField}>
                        <span>Evento</span>
                        <select
                          value={normalizeMetaEventName(editorSite.metaEventName, 'none')}
                          onChange={(event) => {
                            updateSelectedSite({ metaCapiEnabled: true, metaEventName: event.target.value })
                            window.setTimeout(() => handleSaveSite(undefined, { silent: true }), 0)
                          }}
                          onBlur={() => handleSaveSite(undefined, { silent: true })}
                        >
                          {metaEventOptions.map(option => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className={styles.editorActions}>
                    <div className={styles.deviceToggle} role="group" aria-label="Vista previa del dispositivo">
                      <button type="button" className={device === 'desktop' ? styles.deviceActive : ''} onClick={() => setDevice('desktop')} title="Escritorio">
                        <Monitor size={15} />
                      </button>
                      <button type="button" className={device === 'mobile' ? styles.deviceActive : ''} onClick={() => setDevice('mobile')} title="Movil">
                        <Smartphone size={15} />
                      </button>
                    </div>
                    <Button variant="secondary" size="lg" onClick={handlePreviewSite}>
                      <Eye size={16} />
                      Previsualizar
                    </Button>
                    <Button variant="secondary" size="lg" onClick={() => handleSaveSite()} loading={saving}>
                      <Save size={16} />
                      Guardar
                    </Button>
                    <Button size="lg" onClick={() => handleSaveSite('published')} loading={saving}>
                      <Send size={16} />
                      Publicar
                    </Button>
                  </div>
                </div>
              </div>
              {isLanding(editorSite) && (
                <div className={styles.editorHeaderPages}>
                  <FunnelPagesPanel
                    pages={pages}
                    activePageId={activePage?.id || DEFAULT_FUNNEL_PAGE_ID}
                    draggingPageId={draggingPageId}
                    onSelectPage={setActivePageId}
                    onAddPage={handleAddPage}
                    onDuplicatePage={handleDuplicatePage}
                    onDeletePage={handleDeletePage}
                    onDragPage={setDraggingPageId}
                    onReorderPages={handleReorderPages}
                    onRenamePage={handleRenamePage}
                  />
                </div>
              )}
            </>
          ) : (
            <div>
              <div className={styles.titleRow}>
                {isFocusedSitesMode && (
                  <button type="button" className={styles.backButton} onClick={handleFocusedBack}>
                    <ArrowLeft size={16} />
                    Volver
                  </button>
                )}
                <h1 className={styles.title}>{createFlowHeaderCopy.title}</h1>
              </div>
              <p className={styles.subtitle}>{createFlowHeaderCopy.subtitle}</p>
            </div>
          )}
        </header>

        <div className={`${styles.sitesShell} ${isFocusedSitesMode ? styles.sitesShellFocused : ''}`}>
          {!isFocusedSitesMode && (
            <nav className={styles.sectionTabs} role="tablist" aria-label="Secciones de sitios">
              {sectionItems.map(item => {
                const isActive = section === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`${styles.sectionTab} ${isActive ? styles.sectionTabActive : ''}`}
                    onClick={() => handleSectionChange(item.id)}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                    {item.id === 'domains' && <ExternalLink size={14} aria-hidden="true" />}
                  </button>
                )
              })}
            </nav>
          )}

          <main className={styles.mainSurface}>
            {createFlow !== 'closed' ? (
              <CreateFlowPanel
                step={createFlow}
                creating={creating}
                onCreate={handleCreateSite}
                onCreateWithAI={handleCreateSiteWithAI}
                onAdvance={setCreateFlow}
              />
            ) : section === 'leads' ? (
              <LeadsPanel rows={leadRows} loading={loadingLeads} onRefresh={loadLeads} />
            ) : section === 'domains' ? (
              <DomainsPanel
                domainConfig={domainConfig}
                domainInput={domainInput}
                verifying={verifying}
                onDomainChange={(value) => {
                  setDomainInput(value)
                  setDomainConfig(current => ({
                    ...current,
                    domain: value,
                    renderDomainVerified: false,
                    renderDomainError: null
                  }))
                }}
                onVerifyDomain={handleVerifyDomain}
              />
            ) : (section === 'landings' || section === 'forms') && !editorSite ? (
              <SitesLibraryPanel
                section={section}
                sites={section === 'landings' ? landings : forms}
                forms={forms}
                calendars={calendars}
                selectedSiteId={selectedSite?.id || ''}
                onCreate={handleStartCreateFlow}
                onEdit={selectSite}
                onUpdateRoute={handleUpdateLibraryRoute}
                onDelete={(site) => void handleDeleteSite(site)}
                domainConfig={domainConfig}
              />
            ) : editorSite ? (
              <section className={styles.builder}>
              <div className={`${styles.builderGrid} ${isLanding(editorSite) ? styles.builderGridLanding : styles.builderGridForm}`}>
                <div className={styles.blocksRail}>
                  <Palette
	                    blockTypes={isLanding(editorSite) ? landingBlockTypes : formBlockTypes}
	                    existingBlocks={canvasBlocks}
	                    onAdd={handleAddBlock}
	                    onPaletteDragStart={(payload) => {
	                      setPaletteDragPayload(payload)
	                      setPaletteDragging(true)
	                      setPaletteInsertIndex(canvasBlocks.length)
	                      setPaletteSectionTarget(null)
	                    }}
                    onPaletteDragEnd={resetPaletteDrag}
                  />
                </div>

                <section className={styles.canvasColumn}>
                  {!isLanding(editorSite) && (
                    <div className={styles.canvasToolbar}>
                      <div className={styles.canvasToolbarTitle}>
                        <strong>Canvas</strong>
                      </div>
                    </div>
                  )}
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragCancel={() => setActiveDragId(null)}
                  >
                    <SortableContext items={canvasBlocks.map(block => block.id)} strategy={verticalListSortingStrategy}>
                      <CanvasStage
                        designWidth={canvasTheme!.designWidth}
                        canvasClassName={`rstkCanvas ${canvasTheme!.bodyClass}`}
                        canvasStyle={canvasTheme!.vars}
                        active={paletteDragging}
                        pageSelected={selectedBlockId === PAGE_SELECTED_ID}
                        onClear={() => {
                          setSelectedBlockId(PAGE_SELECTED_ID)
                          setPaletteInsertIndex(null)
                        }}
                        onDragOver={handleCanvasDragOver}
                        onDragLeave={handleCanvasDragLeave}
                        onDrop={handleCanvasDrop}
                      >
                        <div className="rstk-frame">
                          <CanvasBackgroundVideo theme={editorSite.theme} />
                          <main className="rstk-page">
                            <div className="rstk-shell">
                              {platformChromeFor(resolveTemplateId(editorSite)) && (
                                <div
                                  className={`${styles.socialProfileSelectable} ${selectedBlockId === SOCIAL_PROFILE_SELECTED_ID ? styles.socialProfileSelected : ''}`}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    setSelectedBlockId(SOCIAL_PROFILE_SELECTED_ID)
                                  }}
                                >
                                  <CanvasChrome
                                    platform={platformChromeFor(resolveTemplateId(editorSite))!}
                                    site={editorSite}
                                    onPatchTheme={patchSiteTheme}
                                    onSave={() => handleSaveSite(undefined, { silent: true })}
                                  />
                                </div>
                              )}
	                              {isLanding(editorSite) ? (
	                                !hasLandingCanvasContent ? (
	                                  palettePreviewBlock && isTopLevelLandingBlockType(paletteDragPayload?.blockType) ? (
	                                    <PaletteInsertPreview block={palettePreviewBlock} forms={forms} calendars={calendars} />
	                                  ) : (
	                                    <div className="rstkDropEmpty">
	                                      <Plus size={22} />
	                                      <p>Arrastra primero una franja de 1, 2 o 3 columnas.</p>
	                                    </div>
	                                  )
	                                ) : (
	                                  <>
	                                    <LandingCanvasSections
	                                      lanes={landingSectionLanes}
	                                      blocks={canvasBlocks}
	                                      selectedBlockId={selectedBlock?.id || ''}
	                                      site={editorSite}
	                                      forms={forms}
	                                      calendars={calendars}
	                                      pages={pages}
	                                      activePageId={activePage?.id || DEFAULT_FUNNEL_PAGE_ID}
	                                      palettePreviewBlock={palettePreviewBlock}
	                                      paletteInsertIndex={paletteInsertIndex}
	                                      paletteSectionTarget={paletteSectionTarget}
	                                      paletteDragging={paletteDragging}
	                                      onSelectBlock={setSelectedBlockId}
                                      onDeleteBlock={handleDeleteBlock}
                                      onPatchBlock={patchBlockLocal}
                                      onPatchBlockSettings={patchBlockSettingsLocal}
                                      onSaveBlock={handleSaveBlock}
                                    />
                                  </>
                                )
                              ) : canvasBlocks.length === 0 ? (
                                palettePreviewBlock ? (
                                  <PaletteInsertPreview block={palettePreviewBlock} forms={forms} calendars={calendars} />
                                ) : (
                                  <div className="rstkDropEmpty">
                                    <Plus size={22} />
                                    <p>Arrastra bloques desde la barra de la izquierda o haz click para agregarlos.</p>
                                  </div>
                                )
                              ) : (
                                <>
                                  {palettePreviewBlock && paletteInsertIndex === 0 && (
                                    <PaletteInsertPreview block={palettePreviewBlock} forms={forms} calendars={calendars} />
                                  )}
                                  {canvasBlocks.map((block, index) => (
                                    <React.Fragment key={block.id}>
                                      <SortableCanvasBlock
                                        block={block}
                                        blocks={canvasBlocks}
                                        index={index}
                                        selected={selectedBlock?.id === block.id}
                                        site={editorSite}
                                        forms={forms}
                                        calendars={calendars}
                                        pages={pages}
                                        activePageId={activePage?.id || DEFAULT_FUNNEL_PAGE_ID}
                                        onSelect={() => setSelectedBlockId(block.id)}
                                        onDelete={() => handleDeleteBlock(block.id)}
                                        onPatchBlock={(patch) => patchBlockLocal(block.id, patch)}
                                        onPatchSettings={(patch) => patchBlockSettingsLocal(block, patch)}
                                        onSave={() => handleSaveBlock(block.id)}
                                      />
                                      {palettePreviewBlock && paletteInsertIndex === index + 1 && (
                                        <PaletteInsertPreview block={palettePreviewBlock} forms={forms} calendars={calendars} />
                                      )}
                                    </React.Fragment>
                                  ))}
                                </>
                              )}
                              {isFormSite(editorSite) && canvasBlocks.some(block => fieldBlockTypes.has(block.blockType)) && (
                                <div className="rstk-actions">
                                  <button type="button" data-submit>{editorSite.theme?.submitText || 'Enviar'}</button>
                                </div>
                              )}
                            </div>
                          </main>
                        </div>
                      </CanvasStage>
                    </SortableContext>
	                    <DragOverlay dropAnimation={{ duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
                      {activeDragBlock ? (
                        <div className={`rstkCanvas ${canvasTheme!.bodyClass}`} style={{ ...canvasTheme!.vars, width: 460, ['--rstk-scale' as string]: 1 } as React.CSSProperties}>
                          <div className={getBlockStyleClassName(activeDragBlock)} style={getBlockCanvasStyle(activeDragBlock)}>
                            <CanvasPreviewBlock block={activeDragBlock} forms={forms} calendars={calendars} />
                          </div>
                        </div>
                      ) : null}
                    </DragOverlay>
                  </DndContext>
                </section>

                <PropertiesPanel
                  site={editorSite}
                  block={selectedBlock}
                  blocks={canvasBlocks}
                  forms={forms}
                  calendars={calendars}
                  pages={pages}
                  activePageId={activePage?.id || DEFAULT_FUNNEL_PAGE_ID}
                  showSocialProfile={selectedBlockId === SOCIAL_PROFILE_SELECTED_ID}
                  onPatchSite={updateSelectedSite}
                  onPatchTheme={patchSiteTheme}
                  onSaveSite={() => handleSaveSite(undefined, { silent: true })}
                  onPatchBlock={(patch) => patchSelectedBlock(patch)}
                  onPatchSettings={(patch) => patchSelectedBlockSettings(patch)}
                  onPatchCategorySettings={(block, patch) => patchBlockCategorySettingsLocal(block, patch)}
                  onSaveCategory={(block) => handleSaveBlockCategory(block)}
                  onSave={() => handleSaveBlock()}
                />

              </div>
            </section>
          ) : (
            <div className={styles.emptyEditor}>
              <LayoutTemplate size={34} />
              <p>{getEmptyEditorMessage(section)}</p>
              <Button onClick={handleStartCreateFlow}>
                <Plus size={16} />
                {getCreateButtonLabel(section)}
              </Button>
            </div>
          )}
        </main>
      </div>
    </div>
  </div>
  )
}

interface SitesLibraryPanelProps {
  section: SitesSection
  sites: PublicSite[]
  forms: PublicSite[]
  calendars: CalendarType[]
  selectedSiteId: string
  domainConfig: SitesDomainConfig
  onCreate: () => void
  onEdit: (siteId: string) => void
  onUpdateRoute: (site: PublicSite, slug: string) => Promise<void>
  onDelete: (site: PublicSite) => void
}

const isLibraryCardActionTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest('[data-library-card-action="true"]'))

const LibrarySitePreview: React.FC<{
  site: PublicSite
  forms: PublicSite[]
  calendars: CalendarType[]
}> = ({ site, forms, calendars }) => {
  const pages = isLanding(site) ? normalizeFunnelPages(site) : []
  const activePageId = pages[0]?.id || DEFAULT_FUNNEL_PAGE_ID
  const blocks = getLibraryPreviewBlocks(site)
  const canvasTheme = buildCanvasTheme(site, 'desktop')
  const platform = platformChromeFor(resolveTemplateId(site))
  const hasFields = isFormSite(site) && blocks.some(block => fieldBlockTypes.has(block.blockType))
  const isLandingPreview = isLanding(site)
  const previewDesignWidth = canvasTheme.designWidth
  const previewHeight = isLandingPreview ? 680 : 540
  const previewScale = Math.min(
    isLandingPreview ? 0.205 : 0.52,
    (isLandingPreview ? 304 : 286) / previewDesignWidth
  )
  const previewFrameStyle = {
    minHeight: previewHeight,
    padding: isLandingPreview ? '28px 24px 56px' : '20px 16px 42px'
  } as React.CSSProperties
  const previewScalerStyle = {
    width: Math.round(previewDesignWidth * previewScale),
    height: Math.round(previewHeight * previewScale)
  } as React.CSSProperties
  const previewCanvasStyle = {
    ...canvasTheme.vars,
    width: previewDesignWidth,
    minHeight: previewHeight,
    transform: `scale(${previewScale})`,
    ['--rstk-scale' as string]: previewScale
  } as React.CSSProperties

  return (
    <div className={styles.libraryPreviewViewport} aria-hidden="true" inert>
      <div className={styles.libraryPreviewScaler} style={previewScalerStyle}>
        <div
          className={`rstkCanvas ${canvasTheme.bodyClass} ${styles.libraryPreviewCanvas}`}
          style={previewCanvasStyle}
        >
          <div className="rstk-frame" style={previewFrameStyle}>
            <CanvasBackgroundVideo theme={site.theme} />
            <main className="rstk-page">
              <div className="rstk-shell">
                {platform && (
                  <CanvasChrome
                    platform={platform}
                    site={site}
                    onPatchTheme={() => {}}
                    onSave={() => {}}
                  />
                )}
                {blocks.length ? (
                  blocks.map(block => (
                    <div key={block.id} className={getBlockStyleClassName(block)} style={getBlockCanvasStyle(block)}>
                      <CanvasPreviewBlock
                        block={block}
                        blocks={blocks}
                        forms={forms}
                        calendars={calendars}
                        pages={pages}
                        activePageId={activePageId}
                      />
                    </div>
                  ))
                ) : (
                  <div className="rstkDropEmpty">
                    {isLandingPreview ? <LayoutTemplate size={22} /> : <FormInput size={22} />}
                    <p>Sin bloques todavia</p>
                  </div>
                )}
                {hasFields && (
                  <div className="rstk-actions">
                    <button type="button" data-submit>{site.theme?.submitText || 'Enviar'}</button>
                  </div>
                )}
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  )
}

const SitesLibraryPanel: React.FC<SitesLibraryPanelProps> = ({
  section,
  sites,
  forms,
  calendars,
  selectedSiteId,
  domainConfig,
  onCreate,
  onEdit,
  onUpdateRoute,
  onDelete
}) => {
  const isLandingLibrary = section === 'landings'
  const [routeEditingId, setRouteEditingId] = useState<string | null>(null)
  const [routeDraft, setRouteDraft] = useState('')
  const [routeSavingId, setRouteSavingId] = useState<string | null>(null)
  const stopCardAction = (event: React.SyntheticEvent) => event.stopPropagation()
  const startRouteEdit = (site: PublicSite) => {
    setRouteEditingId(site.id)
    setRouteDraft(getRouteEditorValue(site))
  }
  const cancelRouteEdit = () => {
    setRouteEditingId(null)
    setRouteDraft('')
  }
  const saveRouteEdit = async (site: PublicSite) => {
    const nextSlug = normalizeRouteEditorInput(routeDraft, domainConfig) || getDefaultRoutePrefix(site.siteType)
    if (nextSlug === getRouteEditorValue(site)) {
      cancelRouteEdit()
      return
    }

    setRouteSavingId(site.id)
    try {
      await onUpdateRoute(site, nextSlug)
      cancelRouteEdit()
    } catch {
      // The parent already shows the error; keep the input open so the route can be fixed.
    } finally {
      setRouteSavingId(null)
    }
  }

  return (
    <section className={styles.libraryPanel}>
      <div className={styles.libraryHeader}>
        <div>
          <span>{isLandingLibrary ? 'Sitios y embudos' : 'Captura de prospectos'}</span>
          <h2>{getLibraryTitle(section)}</h2>
          <p>{getLibraryDescription(section)}</p>
        </div>
      </div>

      <div className={styles.libraryGrid}>
        <button type="button" className={styles.createLibraryCard} onClick={onCreate}>
          <span className={styles.createLibraryIcon}>
            <Plus size={22} />
          </span>
          <strong>{getCreateButtonLabel(section)}</strong>
          <small>
            {sites.length === 0
              ? getLibraryEmptyMessage(section)
              : isLandingLibrary
                ? 'Agrega otra pagina o embudo a tu biblioteca.'
                : 'Agrega otro formulario publico a tu biblioteca.'}
          </small>
        </button>

        {sites.map(site => {
          const siteKindLabel = isLanding(site) ? 'embudo' : 'formulario'

          return (
            <article
              key={site.id}
              className={`${styles.libraryCard} ${selectedSiteId === site.id ? styles.libraryCardActive : ''}`}
              role="button"
              tabIndex={0}
              onClick={(event) => {
                if (isLibraryCardActionTarget(event.target)) return
                onEdit(site.id)
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || isLibraryCardActionTarget(event.target)) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onEdit(site.id)
                }
              }}
            >
              <div className={styles.libraryCardPreview}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={styles.libraryCardMenuButton}
                      aria-label={`Acciones para ${site.name}`}
                      data-library-card-action="true"
                      onPointerDown={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onMouseUp={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <MoreVertical size={17} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={6}
                    className={styles.pageMenu}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <DropdownMenuItem onSelect={(event) => { event.stopPropagation(); onEdit(site.id) }}>
                      <Pencil size={15} />
                      Editar {siteKindLabel}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={(event) => { event.stopPropagation(); startRouteEdit(site) }}>
                      <Settings2 size={15} />
                      Cambiar ruta
                    </DropdownMenuItem>
                    <DropdownMenuItem className={styles.pageMenuDanger} onSelect={(event) => { event.stopPropagation(); onDelete(site) }}>
                      <Trash2 size={15} />
                      Eliminar {siteKindLabel}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <LibrarySitePreview site={site} forms={forms} calendars={calendars} />
                <span className={styles.libraryPreviewType}>{getSiteTypeLabel(site)}</span>
              </div>

              <div className={styles.libraryCardBody}>
                <div className={styles.libraryCardTitleRow}>
                  <strong>{site.name}</strong>
                  <span className={`${styles.statusPill} ${getStatusClass(site, domainConfig)}`}>{getStatusLabel(site, domainConfig)}</span>
                </div>
                {routeEditingId === site.id ? (
                  <form
                    className={styles.libraryRouteEditor}
                    data-library-card-action="true"
                    onPointerDown={stopCardAction}
                    onClick={stopCardAction}
                    onSubmit={(event) => {
                      event.preventDefault()
                      void saveRouteEdit(site)
                    }}
                  >
                    <span className={styles.libraryRouteDomain} title={getPublicDomainPreview(domainConfig)}>
                      {getPublicDomainPreview(domainConfig)}
                    </span>
                    <span className={styles.libraryRouteSlash} aria-hidden="true">/</span>
                    <input
                      value={routeDraft}
                      aria-label={`Ruta de ${site.name}`}
                      autoFocus
                      disabled={routeSavingId === site.id}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setRouteDraft(normalizeRouteEditorInput(event.target.value, domainConfig))}
                      onKeyDown={(event) => {
                        event.stopPropagation()
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelRouteEdit()
                        }
                      }}
                    />
                    <button type="submit" disabled={routeSavingId === site.id} aria-label="Guardar ruta">
                      <Check size={14} />
                    </button>
                    <button type="button" disabled={routeSavingId === site.id} onClick={cancelRouteEdit} aria-label="Cancelar cambio de ruta">
                      <X size={14} />
                    </button>
                  </form>
                ) : (
                  <span className={styles.siteDomain}>{getPublicRouteLabel(site, domainConfig)}</span>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

interface CreateFlowPanelProps {
  step: CreateFlow
  creating: boolean
  onCreate: (siteType: SiteType, mode?: 'blank' | 'template', templateId?: SiteTemplateId) => void
  onCreateWithAI: (siteKind: AIAgentSitesCreationKind) => void
  onAdvance: (step: CreateFlow) => void
}

type TemplateGalleryCategory = {
  id: string
  title: string
  description: string
  ids: SiteTemplateId[]
}

const LANDING_TEMPLATE_CATEGORIES: TemplateGalleryCategory[] = [
  {
    id: 'full-page',
    title: 'Paginas completas',
    description: 'Sitios grandes para explicar tu oferta, mostrar beneficios y llevar a una accion clara.',
    ids: ['ristak', 'executive', 'launch', 'premium', 'local', 'vsl']
  },
  {
    id: 'social',
    title: 'Redes sociales',
    description: 'Apariencias cortas para trafico que viene desde anuncios o perfiles sociales.',
    ids: ['facebook', 'instagram', 'tiktok']
  },
  {
    id: 'capture',
    title: 'Captura y registros',
    description: 'Paginas directas para pedir datos, registrar interesados o mover rapido a una llamada.',
    ids: ['compact', 'event']
  }
]

const FORM_TEMPLATE_CATEGORIES: TemplateGalleryCategory[] = [
  {
    id: 'business-forms',
    title: 'Formularios de negocio',
    description: 'Formularios compactos y genericos para capturar datos sin verse como anuncio.',
    ids: ['compact', 'event', 'executive', 'local', 'premium', 'ristak']
  },
  {
    id: 'social-forms',
    title: 'Redes sociales',
    description: 'Formularios pequenos con apariencia nativa de Facebook, Instagram o TikTok.',
    ids: ['facebook', 'instagram', 'tiktok']
  }
]

const INTERACTIVE_TEMPLATE_CATEGORIES: TemplateGalleryCategory[] = [
  {
    id: 'guided',
    title: 'Quiz y formularios guiados',
    description: 'Una pregunta por pantalla para calificar prospectos paso a paso.',
    ids: ['interactive', 'compact', 'event']
  },
  {
    id: 'social-guided',
    title: 'Redes sociales',
    description: 'Quiz con apariencia de plataforma social para mantener el mismo contexto visual.',
    ids: ['facebook', 'instagram', 'tiktok']
  }
]

const TemplateCard: React.FC<{ id: SiteTemplateId; disabled: boolean; onPick: () => void }> = ({ id, disabled, onPick }) => {
  const meta = templateMetaById(id)
  if (!meta) return null
  return (
    <button type="button" className={styles.templateCard} disabled={disabled} onClick={onPick}>
      <span className={styles.templatePreview} style={{ background: meta.swatchBg, color: meta.swatchInk } as React.CSSProperties}>
        <span className={styles.templatePreviewBar}>
          <span className={styles.templateDot} style={{ background: meta.accent }} />
          <span className={styles.templatePreviewName}>{meta.label}</span>
          <span className={styles.templateBadge}>{meta.badge}</span>
        </span>
        <span className={styles.templatePreviewLines}><span /><span /></span>
        <span className={styles.templatePreviewBtn} style={{ background: meta.accent }} />
      </span>
      <span className={styles.templateCardBody}>
        <strong>{meta.label}</strong>
        <p>{meta.description}</p>
      </span>
    </button>
  )
}

const TemplateCategoryGallery: React.FC<{
  categories: TemplateGalleryCategory[]
  disabled: boolean
  onPick: (id: SiteTemplateId) => void
}> = ({ categories, disabled, onPick }) => (
  <div className={styles.templateCategoryStack}>
    {categories.map(category => (
      <section key={category.id} className={styles.templateCategory}>
        <div className={styles.templateCategoryHeader}>
          <strong>{category.title}</strong>
          <p>{category.description}</p>
        </div>
        <div className={styles.templateGallery}>
          {category.ids.map(id => (
            <TemplateCard key={`${category.id}-${id}`} id={id} disabled={disabled} onPick={() => onPick(id)} />
          ))}
        </div>
      </section>
    ))}
  </div>
)

const CreateFlowPanel: React.FC<CreateFlowPanelProps> = ({ step, creating, onCreate, onCreateWithAI, onAdvance }) => {
  return (
    <section className={styles.createPanel}>
      {step === 'landing-start' && (
        <div className={styles.choiceGrid}>
          <button type="button" disabled={creating} onClick={() => onAdvance('landing-template')}>
            <LayoutTemplate size={22} />
            <strong>Desde plantilla</strong>
            <p>Elige entre paginas completas, redes sociales y registros rapidos.</p>
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={creating} onClick={() => onCreate('landing_page', 'blank', 'ristak')}>
            <FileText size={22} />
            <strong>En blanco</strong>
            <p>Canvas limpio para agregar solo los bloques que necesitas.</p>
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={creating} onClick={() => onCreateWithAI('landing')}>
            <Sparkles size={22} />
            <strong>Usando IA</strong>
            <p>El asistente pregunta lo necesario y crea un borrador con bloques editables.</p>
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {step === 'landing-template' && (
        <TemplateCategoryGallery
          categories={LANDING_TEMPLATE_CATEGORIES}
          disabled={creating}
          onPick={(id) => onCreate('landing_page', 'template', id)}
        />
      )}

      {step === 'form-kind' && (
        <div className={styles.choiceGrid}>
          <button type="button" disabled={creating} onClick={() => onAdvance('form-template')}>
            <FormInput size={22} />
            <strong>Una sola pagina</strong>
            <p>Todos los campos en una pagina. Puedes usar estilos de negocio o redes sociales.</p>
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={creating} onClick={() => onCreate('interactive_form', 'template', 'interactive')}>
            <MousePointerClick size={22} />
            <strong>Interactivo</strong>
            <p>Una pregunta por pantalla, estilo quiz, con saltos y descalificacion.</p>
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={creating} onClick={() => onAdvance('interactive-template')}>
            <MousePointerClick size={22} />
            <strong>Interactivo con plantilla social</strong>
            <p>Usa el mismo look de Facebook, Instagram o TikTok para hacerlo ver nativo.</p>
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={creating} onClick={() => onCreateWithAI('form')}>
            <Sparkles size={22} />
            <strong>Usando IA</strong>
            <p>El asistente arma preguntas, campos y reglas de calificacion como borrador.</p>
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {step === 'interactive-template' && (
        <>
          <p className={styles.galleryHint}>Elige si quieres un quiz limpio de negocio o una apariencia de red social.</p>
          <TemplateCategoryGallery
            categories={INTERACTIVE_TEMPLATE_CATEGORIES}
            disabled={creating}
            onPick={(id) => onCreate('interactive_form', 'template', id)}
          />
        </>
      )}

      {step === 'form-template' && (
        <>
          <p className={styles.galleryHint}>Elige un formulario compacto de negocio o uno con apariencia de red social.</p>
          <TemplateCategoryGallery
            categories={FORM_TEMPLATE_CATEGORIES}
            disabled={creating}
            onPick={(id) => onCreate('standard_form', 'template', id)}
          />
        </>
      )}

    </section>
  )
}

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))

interface DimensionFieldProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (value: number) => void
  onCommit: () => void
}

// Numeric box only: spacing/size edits should feel exact, not like a fader.
const DimensionField: React.FC<DimensionFieldProps> = ({ label, value, min, max, step = 1, unit = 'px', onChange, onCommit }) => {
  const set = (raw: number) => onChange(clampNumber(raw, min, max))
  return (
    <label className={styles.dimensionField}>
      <span>{label}</span>
      <div className={styles.dimensionTextRow}>
        <div className={styles.dimensionBox}>
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => set(Number(event.target.value))}
            onBlur={onCommit}
          />
          <small>{unit}</small>
        </div>
      </div>
    </label>
  )
}

const AlignmentControl: React.FC<{
  label: string
  value: string
  options: Array<{ value: string; label: string; icon: React.ReactNode }>
  onChange: (value: string) => void
  onCommit: () => void
}> = ({ label, value, options, onChange, onCommit }) => (
  <div className={styles.alignmentControl}>
    <span>{label}</span>
    <div role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? styles.alignmentActive : ''}
          onClick={() => {
            onChange(option.value)
            window.setTimeout(onCommit, 0)
          }}
          title={option.label}
          aria-label={option.label}
        >
          {option.icon}
          <small>{option.label}</small>
        </button>
      ))}
    </div>
  </div>
)

interface LinkedSpacingFieldProps {
  label: string
  base: SpacingBase
  settings: Record<string, unknown>
  min?: number
  max?: number
  fallback?: number
  unit?: string
  onChange: (patch: Record<string, unknown>) => void
  onCommit: () => void
}

const LinkedSpacingField: React.FC<LinkedSpacingFieldProps> = ({
  label,
  base,
  settings,
  min = 0,
  max = 160,
  fallback = 0,
  unit = 'px',
  onChange,
  onCommit
}) => {
  const linkKey = `${base}Linked`
  const linked = settings[linkKey] !== false
  const values = spacingSides.reduce<Record<typeof spacingSides[number]['id'], number>>((acc, side) => {
    acc[side.id] = getSpacingValue(settings, base, side.id, fallback, min, max)
    return acc
  }, { Top: fallback, Right: fallback, Bottom: fallback, Left: fallback })

  const patchAllSides = (next: number, nextLinked = linked) => {
    const value = clampNumber(next, min, max)
    onChange({
      [linkKey]: nextLinked,
      [base]: value,
      [`${base}Top`]: value,
      [`${base}Right`]: value,
      [`${base}Bottom`]: value,
      [`${base}Left`]: value
    })
  }

  const patchSide = (side: typeof spacingSides[number]['id'], next: number) => {
    const value = clampNumber(next, min, max)
    if (linked) {
      patchAllSides(value, true)
      return
    }
    onChange({
      [linkKey]: false,
      [`${base}${side}`]: value
    })
  }

  const toggleLinked = () => {
    if (linked) {
      onChange({ [linkKey]: false })
      window.setTimeout(onCommit, 0)
      return
    }
    patchAllSides(values.Top, true)
    window.setTimeout(onCommit, 0)
  }

  return (
    <div className={styles.spacingControl}>
      <div className={styles.spacingHeader}>
        <span>{label}</span>
        <button
          type="button"
          className={`${styles.spacingLinkButton} ${linked ? styles.spacingLinkButtonActive : ''}`}
          onClick={toggleLinked}
          title={linked ? 'Desvincular lados' : 'Vincular lados'}
          aria-label={linked ? 'Desvincular lados' : 'Vincular lados'}
        >
          {linked ? <Link2 size={15} /> : <Unlink2 size={15} />}
        </button>
      </div>
      <div className={styles.spacingGrid}>
        {spacingSides.map(side => (
          <label key={side.id} className={styles.spacingBox}>
            <span>{side.label}</span>
            <div>
              <input
                type="number"
                min={min}
                max={max}
                step={1}
                value={values[side.id]}
                onChange={(event) => patchSide(side.id, Number(event.target.value))}
                onBlur={onCommit}
              />
              <small>{unit}</small>
            </div>
          </label>
        ))}
      </div>
    </div>
  )
}

interface ColorFieldProps {
  label: string
  value: string
  allowGradient?: boolean
  onChange: (color: string) => void
  onCommit: () => void
}

const rgbToHsv = ({ r, g, b }: { r: number; g: number; b: number }) => {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min
  let h = 0

  if (delta) {
    if (max === rn) h = ((gn - bn) / delta) % 6
    else if (max === gn) h = (bn - rn) / delta + 2
    else h = (rn - gn) / delta + 4
    h *= 60
  }

  return {
    h: h < 0 ? h + 360 : h,
    s: max === 0 ? 0 : delta / max,
    v: max
  }
}

const hsvToRgb = (h: number, s: number, v: number) => {
  const c = v * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = v - c
  const ranges = h < 60
    ? [c, x, 0]
    : h < 120
      ? [x, c, 0]
      : h < 180
        ? [0, c, x]
        : h < 240
          ? [0, x, c]
          : h < 300
            ? [x, 0, c]
            : [c, 0, x]

  return {
    r: Math.round((ranges[0] + m) * 255),
    g: Math.round((ranges[1] + m) * 255),
    b: Math.round((ranges[2] + m) * 255)
  }
}

const formatCssColor = ({ r, g, b, a }: { r: number; g: number; b: number; a: number }) => {
  const alpha = Math.max(0, Math.min(1, Math.round(a * 100) / 100))
  return alpha >= 1 ? rgbToHex(r, g, b) : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`
}

const swatchBackground = (color: string) => isCssGradient(color)
  ? ({ backgroundImage: color } as React.CSSProperties)
  : ({
      backgroundColor: color,
      backgroundImage: 'linear-gradient(45deg, rgba(148, 163, 184, 0.28) 25%, transparent 25%), linear-gradient(-45deg, rgba(148, 163, 184, 0.28) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148, 163, 184, 0.28) 75%), linear-gradient(-45deg, transparent 75%, rgba(148, 163, 184, 0.28) 75%)',
      backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
      backgroundSize: '12px 12px'
    } as React.CSSProperties)

// Ristak color control: no native OS picker, with hue, intensity and alpha.
const ColorField: React.FC<ColorFieldProps> = ({ label, value, allowGradient = false, onChange, onCommit }) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const color = allowGradient ? normalizeCssPaint(value, '#000000') : normalizeCssColor(value, '#000000')
  const colorForPicker = isCssGradient(color) ? '#000000' : color
  const rgba = parseCssColor(colorForPicker, '#000000')
  const hsv = rgbToHsv(rgba)
  const hueRgb = hsvToRgb(hsv.h, 1, 1)
  const hueColor = rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b)
  const alphaColor = formatCssColor({ r: rgba.r, g: rgba.g, b: rgba.b, a: 1 })
  const [text, setText] = useState(color)
  const [open, setOpen] = useState(false)

  useEffect(() => { setText(allowGradient ? normalizeCssPaint(value, '#000000') : normalizeCssColor(value, '#000000')) }, [allowGradient, value])

  useEffect(() => {
    if (!open) return undefined
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        onCommit()
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [onCommit, open])

  const patchColor = (next: { h?: number; s?: number; v?: number; a?: number }) => {
    const nextH = next.h ?? hsv.h
    const nextS = next.s ?? hsv.s
    const nextV = next.v ?? hsv.v
    const nextA = next.a ?? rgba.a
    const rgb = hsvToRgb(nextH, nextS, nextV)
    const formatted = formatCssColor({ ...rgb, a: nextA })
    setText(formatted)
    onChange(formatted)
  }

  const commitText = () => {
    const raw = text.trim()
    if (allowGradient && isCssGradient(raw)) {
      onChange(raw)
      onCommit()
      return
    }
    const normalized = normalizeCssColor(raw.startsWith('#') || raw.startsWith('rgb') || raw === 'transparent' ? raw : `#${raw}`, '')
    if (normalized) {
      onChange(normalized)
      onCommit()
    } else {
      setText(color)
    }
  }

  const handlePlanePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left))
    const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top))
    patchColor({ s: x / rect.width, v: 1 - y / rect.height })
  }

  return (
    <div ref={rootRef} className={styles.colorField}>
      <span>{label}</span>
      <div className={styles.colorRow} data-open={open ? 'true' : 'false'}>
        <button
          type="button"
          className={styles.colorSwatchButton}
          style={swatchBackground(color)}
          onClick={() => setOpen(current => !current)}
          aria-label={`Elegir ${label}`}
        />
        <input
          className={styles.colorHex}
          value={text}
          spellCheck={false}
          maxLength={allowGradient ? 180 : 28}
          onChange={(event) => setText(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitText() } }}
        />
      </div>
      {open && (
        <div className={styles.colorPopover}>
          <div
            className={styles.colorPlane}
            style={{ backgroundColor: hueColor }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              handlePlanePointer(event)
            }}
            onPointerMove={(event) => { if (event.buttons) handlePlanePointer(event) }}
          >
            <span
              className={styles.colorPlaneHandle}
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
            />
          </div>
          <label className={styles.colorSlider}>
            <span>Tono</span>
            <input
              type="range"
              min={0}
              max={360}
              value={Math.round(hsv.h)}
              onChange={(event) => patchColor({ h: Number(event.target.value) })}
              onBlur={onCommit}
            />
          </label>
          <label className={styles.alphaSlider}>
            <span>Transparencia</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(rgba.a * 100)}
              style={{ ['--alpha-color' as string]: alphaColor } as React.CSSProperties}
              onChange={(event) => patchColor({ a: Number(event.target.value) / 100 })}
              onBlur={onCommit}
            />
          </label>
          <div className={styles.colorPopoverActions}>
            <button type="button" onClick={() => patchColor({ a: 0 })}>Transparente</button>
            <button type="button" onClick={() => { setOpen(false); onCommit() }}>Listo</button>
          </div>
        </div>
      )}
    </div>
  )
}

const CanvasBackgroundVideo: React.FC<{ theme?: SiteTheme }> = ({ theme }) => {
  const src = getThemeBackgroundVideo(theme)
  if (!src) return null

  return (
    <video className="rstk-bg-video" src={src} autoPlay muted loop playsInline aria-hidden="true" />
  )
}

const CanvasAvatar: React.FC<{ name: string; avatar?: string }> = ({ name, avatar }) => (
  <span className={styles.chromeAvatar}>
    {avatar ? <img src={avatar} alt={name} /> : (name.trim()[0] || 'R').toUpperCase()}
  </span>
)

const SocialPlatformBadge: React.FC<{ platform: 'facebook' | 'instagram' | 'tiktok' }> = ({ platform }) => {
  const platformClass = platform === 'facebook'
    ? styles.socialPlatformFacebook
    : platform === 'instagram'
      ? styles.socialPlatformInstagram
      : styles.socialPlatformTiktok

  return (
    <span className={`${styles.socialPlatformBadge} ${platformClass}`} aria-hidden="true">
      {platform === 'instagram' && <Instagram size={16} strokeWidth={2.2} />}
      {platform === 'tiktok' && <Music2 size={16} strokeWidth={2.2} />}
    </span>
  )
}

const CanvasChrome: React.FC<{
  platform: 'facebook' | 'instagram' | 'tiktok'
  site: PublicSite
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSave: () => void
}> = ({ platform, site }) => {
  const theme = site.theme || {}
  const name = theme.brandName || site.title || site.name || 'Tu marca'
  const subtitle = theme.brandSubtitle || (platform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado')
  const followers = String(theme.followers || '')
  const secondary = followers ? `${followers} seguidores` : subtitle
  const platformClass = platform === 'facebook'
    ? styles.chromeFacebook
    : platform === 'instagram'
      ? styles.chromeInstagram
      : styles.chromeTiktok

  return (
    <div className={`${styles.canvasChrome} ${platformClass}`} aria-label={`Perfil de ${platform}`}>
      <div className={styles.socialImageWrap}>
        <CanvasAvatar name={name} avatar={theme.brandAvatar} />
        <SocialPlatformBadge platform={platform} />
      </div>
      <div className={styles.chromeMeta}>
        <div className={styles.chromeName}>
          {name}
          {theme.brandVerified !== false && (
            <svg viewBox="0 0 24 24" width="14" height="14" className={styles.chromeVerified}><path fill="#1877f2" d="M12 2.2l2.3 1.7 2.85.05.95 2.7 2.25 1.8-.95 2.75.95 2.75-2.25 1.8-.95 2.7L14.3 18.6 12 20.3l-2.3-1.7-2.85-.05-.95-2.7L3.95 14.3l.95-2.75-.95-2.75 2.25-1.8.95-2.7L9.7 3.9z"/><path d="M8.4 12.3l2.4 2.4 4.8-4.9" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          )}
        </div>
        <div className={styles.chromeSub}>{secondary}</div>
      </div>
    </div>
  )
}

const paletteGroups: Array<{ label: string; items: PaletteItem[] }> = [
  {
    label: 'Paneles',
    items: [
      { id: HEADER_PANEL_BLOCK_TYPE, label: blockLabels[HEADER_PANEL_BLOCK_TYPE], blockType: HEADER_PANEL_BLOCK_TYPE },
      { id: FOOTER_PANEL_BLOCK_TYPE, label: blockLabels[FOOTER_PANEL_BLOCK_TYPE], blockType: FOOTER_PANEL_BLOCK_TYPE }
    ]
  },
  {
    label: 'Franjas',
    items: [1, 2, 3].map(columns => ({
      id: `section-${columns}`,
      label: getSectionColumnLabel(columns),
      blockType: SECTION_BLOCK_TYPE,
      initialSettings: { sectionColumns: columns }
    }))
  },
  {
    label: 'Contenido',
    items: ['title', 'subtitle', 'text', 'image', 'video', 'button', 'benefits', 'testimonials', 'services', 'faq', 'cta', 'embed', 'calendar_embed', 'form_embed']
      .map(blockType => ({ id: blockType, label: blockLabels[blockType as SiteBlockType], blockType: blockType as SiteBlockType }))
  },
  {
    label: 'Campos',
    items: ['short_text', 'paragraph', 'email', 'phone', 'number', 'currency', 'date', 'dropdown', 'radio', 'checkboxes', 'description']
      .map(blockType => ({ id: blockType, label: blockLabels[blockType as SiteBlockType], blockType: blockType as SiteBlockType }))
  }
]

interface FunnelPagesPanelProps {
  pages: SitePage[]
  activePageId: string
  draggingPageId: string | null
  onSelectPage: (pageId: string) => void
  onAddPage: () => void
  onDuplicatePage: (pageId: string) => void
  onDeletePage: (pageId: string) => void
  onDragPage: (pageId: string | null) => void
  onReorderPages: (sourcePageId: string, targetPageId: string) => void
  onRenamePage: (pageId: string, title: string) => void
}

const FunnelPagesPanel: React.FC<FunnelPagesPanelProps> = ({
  pages,
  activePageId,
  draggingPageId,
  onSelectPage,
  onAddPage,
  onDuplicatePage,
  onDeletePage,
  onDragPage,
  onReorderPages,
  onRenamePage
}) => {
  return (
    <aside className={styles.pagesPanel}>
      <div className={styles.pageTabsLead} aria-hidden="true">
        <span>Paginas</span>
        <ChevronRight size={15} />
      </div>
      <div className={styles.pageList}>
        {pages.map((page, index) => (
          <React.Fragment key={page.id}>
            <div
              className={`${styles.pageItemWrap} ${draggingPageId === page.id ? styles.pageItemDragging : ''}`}
              draggable
              onDragStart={(event) => {
                if ((event.target as HTMLElement).closest('input,button')) {
                  event.preventDefault()
                  return
                }
                event.dataTransfer.setData('application/ristak-page', page.id)
                onDragPage(page.id)
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('application/ristak-page')) {
                  event.preventDefault()
                }
              }}
              onDrop={(event) => {
                event.preventDefault()
                const sourcePageId = event.dataTransfer.getData('application/ristak-page')
                onDragPage(null)
                onReorderPages(sourcePageId, page.id)
              }}
              onDragEnd={() => onDragPage(null)}
            >
              <div
                role="button"
                tabIndex={0}
                className={`${styles.pageItem} ${activePageId === page.id ? styles.pageItemActive : ''}`}
                onClick={() => onSelectPage(page.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelectPage(page.id)
                }}
              >
                <GripVertical size={14} />
                <EditablePageTitle
                  pageId={page.id}
                  title={page.title || `Pagina ${index + 1}`}
                  onFocus={() => onSelectPage(page.id)}
                  onRename={onRenamePage}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={styles.pageMenuButton}
                      aria-label="Opciones de pagina"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <MoreVertical size={15} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={6} className={styles.pageMenu}>
                    <DropdownMenuItem onSelect={() => onDuplicatePage(page.id)}>
                      <Copy size={14} />
                      Duplicar pagina
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={pages.length <= 1}
                      className={styles.pageMenuDanger}
                      onSelect={() => onDeletePage(page.id)}
                    >
                      <Trash2 size={14} />
                      Eliminar pagina
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            {index < pages.length - 1 && (
              <span className={styles.pageFlowArrow} aria-hidden="true">
                <ChevronRight size={14} />
              </span>
            )}
          </React.Fragment>
        ))}
        <button type="button" className={styles.addPageButton} onClick={onAddPage}>
          <Plus size={15} />
          Agregar pagina
        </button>
      </div>
    </aside>
  )
}

const EditablePageTitle: React.FC<{
  pageId: string
  title: string
  onFocus: () => void
  onRename: (pageId: string, title: string) => void
}> = ({ pageId, title, onFocus, onRename }) => {
  const [draft, setDraft] = useState(title)

  useEffect(() => setDraft(title), [title])

  const commit = () => {
    const next = draft.trim() || title
    setDraft(next)
    if (next !== title) onRename(pageId, next)
  }

  return (
    <input
      className={styles.pageTitleInput}
      value={draft}
      draggable={false}
      aria-label="Nombre de pagina"
      onFocus={onFocus}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          setDraft(title)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

const Palette: React.FC<{
  blockTypes: SiteBlockType[]
  existingBlocks?: SiteBlock[]
  onAdd: (blockType: SiteBlockType, options?: AddBlockOptions) => void
  onPaletteDragStart: (payload: PaletteDragPayload) => void
  onPaletteDragEnd: () => void
}> = ({ blockTypes, existingBlocks = [], onAdd, onPaletteDragStart, onPaletteDragEnd }) => {
  const allowed = new Set(blockTypes)
  const existingPanelTypes = new Set(existingBlocks.filter(isPanelBlock).map(block => block.blockType))
  const groups = paletteGroups
    .map(group => ({
      label: group.label,
      items: group.items.filter(item => allowed.has(item.blockType) && (!PANEL_BLOCK_TYPES.has(item.blockType) || !existingPanelTypes.has(item.blockType)))
    }))
    .filter(group => group.items.length > 0)

  return (
    <aside className={styles.palette}>
      <div className={styles.panelHeader}>
        <strong>Bloques</strong>
      </div>
      <div className={styles.paletteGroups}>
        {groups.map(group => (
          <div key={group.label} className={styles.paletteGroup}>
            <span className={styles.paletteGroupLabel}>
              <span>{group.label}</span>
              <span className={styles.paletteGroupHint}>(Arrastra)</span>
            </span>
            <div className={styles.paletteItems}>
              {group.items.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.paletteItem}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.dropEffect = 'move'
                    event.dataTransfer.setData('application/ristak-block', item.blockType)
                    if (item.initialSettings) {
                      event.dataTransfer.setData('application/ristak-block-settings', JSON.stringify(item.initialSettings))
                    }
                    onPaletteDragStart({ blockType: item.blockType, initialSettings: item.initialSettings })
                  }}
                  onDragEnd={onPaletteDragEnd}
                  onClick={() => onAdd(item.blockType, { initialSettings: item.initialSettings })}
                >
                  <span className={styles.paletteIcon}>
                    {item.blockType === SECTION_BLOCK_TYPE ? (
                      <span
                        className={styles.sectionPalettePreview}
                        style={{ gridTemplateColumns: `repeat(${getSettingNumber(item.initialSettings || {}, 'sectionColumns', 1, 1, 3)}, minmax(0, 1fr))` }}
                        aria-hidden="true"
                      >
                        {Array.from({ length: getSettingNumber(item.initialSettings || {}, 'sectionColumns', 1, 1, 3) }).map((_, index) => (
                          <span key={index} />
                        ))}
                      </span>
                    ) : blockIcons[item.blockType]}
                  </span>
                  <span>{item.label}</span>
                  <GripVertical className={styles.paletteGrip} size={14} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

// Inline, in-place text editing that renders as the real rstk element, so the
// typography/gradients/spacing match the published page exactly. Content is set
// imperatively to avoid React rewriting the DOM mid-edit (which jumps the caret).
interface InlineEditableProps {
  as?: 'h1' | 'h2' | 'p' | 'span' | 'div' | 'a' | 'strong'
  className?: string
  value: string
  placeholder?: string
  disabled?: boolean
  multiline?: boolean
  onChange: (value: string) => void
  onCommit?: () => void
}

const InlineEditable: React.FC<InlineEditableProps> = ({
  as = 'div', className, value, placeholder, disabled, multiline, onChange, onCommit
}) => {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el && el.textContent !== value) el.textContent = value
  }, [value])

  const Tag = as as React.ElementType
  return (
    <Tag
      ref={ref}
      className={className}
      contentEditable={!disabled}
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      data-rstk-edit=""
      data-empty={value ? 'false' : 'true'}
      data-placeholder={placeholder || ''}
      onInput={(event: React.FormEvent<HTMLElement>) => {
        const text = event.currentTarget.textContent || ''
        event.currentTarget.setAttribute('data-empty', text ? 'false' : 'true')
        onChange(text)
      }}
      onBlur={() => onCommit?.()}
      onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => {
        if (!multiline && event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
      }}
    />
  )
}

// Renders the canvas page at its true desktop width and transform-scales it to
// fit the column — a faithful "monitor comprimido" of the published page.
interface CanvasStageProps {
  designWidth: number
  canvasClassName: string
  canvasStyle: React.CSSProperties
  active?: boolean
  pageSelected?: boolean
  onClear?: () => void
  onDragOver?: React.DragEventHandler<HTMLDivElement>
  onDragLeave?: React.DragEventHandler<HTMLDivElement>
  onDrop?: React.DragEventHandler<HTMLDivElement>
  children: React.ReactNode
}

const CanvasStage: React.FC<CanvasStageProps> = ({
  designWidth, canvasClassName, canvasStyle, active, pageSelected, onClear, onDragOver, onDragLeave, onDrop, children
}) => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [stageHeight, setStageHeight] = useState(0)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const stage = stageRef.current
    if (!viewport || !stage) return
    const recompute = () => {
      const avail = viewport.clientWidth - 8
      const next = Math.max(0.2, Math.min(1, avail / designWidth))
      setScale(next)
      setStageHeight(stage.offsetHeight * next)
    }
    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(viewport)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [designWidth])

  return (
    <div
      ref={viewportRef}
      className={`canvasViewport ${active ? 'canvasViewportActive' : ''}`}
      style={canvasStyle}
      onClick={onClear}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className="canvasScaler"
        style={{ ...canvasStyle, width: Math.round(designWidth * scale), height: Math.round(stageHeight) } as React.CSSProperties}
      >
        <div
          ref={stageRef}
          className={`canvasStage ${canvasClassName} ${pageSelected ? 'canvasPageSelected' : ''}`}
          style={{ ...canvasStyle, width: designWidth, transform: `scale(${scale})`, ['--rstk-scale' as string]: scale } as React.CSSProperties}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

interface SortableCanvasBlockProps {
  block: SiteBlock
  blocks: SiteBlock[]
  index: number
  selected: boolean
  site: PublicSite
  forms: PublicSite[]
  calendars: CalendarType[]
  pages: SitePage[]
  activePageId: string
  onSelect: () => void
  onDelete: () => void
  onPatchBlock: (patch: Partial<SiteBlock>) => void
  onPatchSettings: (patch: Record<string, unknown>) => void
  onSave: () => void
}

const sortableTransition = {
  duration: 320,
  easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
}

const sortableAnimateLayoutChanges: AnimateLayoutChanges = (args) => {
  if (args.isSorting || args.wasDragging) {
    return defaultAnimateLayoutChanges(args)
  }

  return false
}

const SortableCanvasBlock: React.FC<SortableCanvasBlockProps> = ({
  block,
  blocks,
  index,
  selected,
  site,
  forms,
  calendars,
  pages,
  activePageId,
  onSelect,
  onDelete,
  onPatchBlock,
  onPatchSettings,
  onSave
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    animateLayoutChanges: sortableAnimateLayoutChanges,
    transition: sortableTransition
  })

  return (
	    <div
	      ref={setNodeRef}
	      data-rstk-block-id={block.id}
	      data-rstk-block-index={index}
	      data-rstk-page-block={isPanelBlock(block) ? 'true' : undefined}
	      style={{
        transform: CSS.Transform.toString(transform),
	        transition: transition || 'transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        opacity: isDragging ? 0.34 : undefined,
        zIndex: isDragging ? 8 : undefined,
        ...getBlockCanvasStyle(block)
      }}
      className={getBlockStyleClassName(block, `rstkSel ${selected ? 'rstkSelActive' : ''} ${isDragging ? 'rstkSelDragging' : ''}`)}
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
    >
      {site.siteType === 'interactive_form' && fieldBlockTypes.has(block.blockType) && (
        <span className="rstkStepBadge">Pantalla {index + 1}</span>
      )}
      <div className="rstkBlockTools">
        <button type="button" className="rstkBlockTool rstkBlockToolDrag" {...attributes} {...listeners} aria-label="Reordenar bloque">
          <GripVertical size={15} />
        </button>
        <button type="button" className="rstkBlockTool rstkBlockToolDelete" onClick={(event) => { event.stopPropagation(); onDelete() }} aria-label="Eliminar bloque">
          <Trash2 size={14} />
        </button>
      </div>
      <CanvasPreviewBlock
        block={block}
        blocks={blocks}
        forms={forms}
        calendars={calendars}
        pages={pages}
        activePageId={activePageId}
        selected={selected}
        onPatchBlock={onPatchBlock}
        onPatchSettings={onPatchSettings}
        onSave={onSave}
      />
    </div>
  )
}

interface LandingCanvasSectionsProps {
  lanes: LandingSectionLane[]
  blocks: SiteBlock[]
  selectedBlockId: string
  site: PublicSite
  forms: PublicSite[]
  calendars: CalendarType[]
  pages: SitePage[]
  activePageId: string
  palettePreviewBlock: SiteBlock | null
  paletteInsertIndex: number | null
  paletteSectionTarget: PaletteSectionTarget | null
  paletteDragging: boolean
  onSelectBlock: (blockId: string) => void
  onDeleteBlock: (blockId: string) => void
  onPatchBlock: (blockId: string, patch: Partial<SiteBlock>) => void
  onPatchBlockSettings: (block: SiteBlock, patch: Record<string, unknown>) => void
  onSaveBlock: (blockId: string) => void
}

const LandingCanvasSections: React.FC<LandingCanvasSectionsProps> = ({
  lanes,
  blocks,
  selectedBlockId,
  site,
  forms,
  calendars,
  pages,
  activePageId,
  palettePreviewBlock,
  paletteInsertIndex,
  paletteSectionTarget,
  paletteDragging,
  onSelectBlock,
  onDeleteBlock,
  onPatchBlock,
  onPatchBlockSettings,
  onSaveBlock
}) => {
  const blockIndexById = new Map(blocks.map((block, index) => [block.id, index]))
  const laneBySectionId = new Map(lanes.filter(lane => lane.section).map(lane => [lane.section!.id, lane]))
  const legacyLane = lanes.find(lane => !lane.section)
  const showTopLevelPreview = Boolean(palettePreviewBlock && isTopLevelLandingBlockType(palettePreviewBlock.blockType))
  let legacyRendered = false

  return (
    <>
      {blocks.map((block) => {
        const blockInsertIndex = blockIndexById.get(block.id) ?? 0
        const topLevelPreviewBefore = showTopLevelPreview && paletteInsertIndex === blockInsertIndex

        if (isPanelBlock(block)) {
          return (
            <React.Fragment key={block.id}>
              {topLevelPreviewBefore && palettePreviewBlock && (
                <PaletteInsertPreview block={palettePreviewBlock} forms={forms} calendars={calendars} />
              )}
              <SortableCanvasBlock
                block={block}
                blocks={blocks}
                index={blockInsertIndex}
                selected={selectedBlockId === block.id}
                site={site}
                forms={forms}
                calendars={calendars}
                pages={pages}
                activePageId={activePageId}
                onSelect={() => onSelectBlock(block.id)}
                onDelete={() => onDeleteBlock(block.id)}
                onPatchBlock={(patch) => onPatchBlock(block.id, patch)}
                onPatchSettings={(patch) => onPatchBlockSettings(block, patch)}
                onSave={() => onSaveBlock(block.id)}
              />
            </React.Fragment>
          )
        }

        if (!isSectionBlock(block)) {
          if (!legacyLane || legacyRendered || getBlockSectionId(block)) return null
          legacyRendered = true
          return (
            <LegacyLandingSection
              key={legacyLane.id}
              lane={legacyLane}
              blocks={blocks}
              blockIndexById={blockIndexById}
              selectedBlockId={selectedBlockId}
              site={site}
              forms={forms}
              calendars={calendars}
	              pages={pages}
	              activePageId={activePageId}
	              palettePreviewBlock={palettePreviewBlock}
	              paletteInsertIndex={paletteInsertIndex}
	              paletteSectionTarget={paletteSectionTarget}
	              onSelectBlock={onSelectBlock}
              onDeleteBlock={onDeleteBlock}
              onPatchBlock={onPatchBlock}
              onPatchBlockSettings={onPatchBlockSettings}
              onSaveBlock={onSaveBlock}
            />
          )
        }

	        const lane = laneBySectionId.get(block.id)
	        if (!lane) return null
	        return (
	          <React.Fragment key={lane.id}>
	            {topLevelPreviewBefore && palettePreviewBlock && (
	              <PaletteInsertPreview block={palettePreviewBlock} forms={forms} calendars={calendars} />
	            )}
	            <SortableLandingSection
	              lane={lane}
              blocks={blocks}
              blockIndexById={blockIndexById}
              selectedBlockId={selectedBlockId}
              site={site}
              forms={forms}
              calendars={calendars}
              pages={pages}
	              activePageId={activePageId}
	              paletteDragging={paletteDragging}
	              palettePreviewBlock={palettePreviewBlock}
	              paletteInsertIndex={paletteInsertIndex}
	              paletteSectionTarget={paletteSectionTarget}
	              onSelectBlock={onSelectBlock}
              onDeleteBlock={onDeleteBlock}
              onPatchBlock={onPatchBlock}
              onPatchBlockSettings={onPatchBlockSettings}
              onSaveBlock={onSaveBlock}
            />
	          </React.Fragment>
	        )
	      })}
	      {showTopLevelPreview && palettePreviewBlock && paletteInsertIndex !== null && paletteInsertIndex >= blocks.length && (
	        <PaletteInsertPreview block={palettePreviewBlock} forms={forms} calendars={calendars} />
	      )}
	      {legacyLane && !legacyRendered && (
	        <LegacyLandingSection
          lane={legacyLane}
          blocks={blocks}
          blockIndexById={blockIndexById}
          selectedBlockId={selectedBlockId}
          site={site}
          forms={forms}
          calendars={calendars}
	          pages={pages}
	          activePageId={activePageId}
	          palettePreviewBlock={palettePreviewBlock}
	          paletteInsertIndex={paletteInsertIndex}
	          paletteSectionTarget={paletteSectionTarget}
	          onSelectBlock={onSelectBlock}
          onDeleteBlock={onDeleteBlock}
          onPatchBlock={onPatchBlock}
          onPatchBlockSettings={onPatchBlockSettings}
          onSaveBlock={onSaveBlock}
        />
      )}
    </>
  )
}

interface LandingSectionRenderProps {
  lane: LandingSectionLane
  blocks: SiteBlock[]
  blockIndexById: Map<string, number>
  selectedBlockId: string
  site: PublicSite
  forms: PublicSite[]
  calendars: CalendarType[]
  pages: SitePage[]
  activePageId: string
  paletteDragging?: boolean
  palettePreviewBlock?: SiteBlock | null
  paletteInsertIndex?: number | null
  paletteSectionTarget?: PaletteSectionTarget | null
  onSelectBlock: (blockId: string) => void
  onDeleteBlock: (blockId: string) => void
  onPatchBlock: (blockId: string, patch: Partial<SiteBlock>) => void
  onPatchBlockSettings: (block: SiteBlock, patch: Record<string, unknown>) => void
  onSaveBlock: (blockId: string) => void
}

const LandingSectionColumns: React.FC<LandingSectionRenderProps> = ({
  lane,
  blocks,
  blockIndexById,
  selectedBlockId,
  site,
  forms,
  calendars,
  pages,
  activePageId,
  paletteDragging,
  palettePreviewBlock,
  paletteInsertIndex,
  paletteSectionTarget,
  onSelectBlock,
  onDeleteBlock,
  onPatchBlock,
  onPatchBlockSettings,
  onSaveBlock
}) => {
  const showContentPreview = Boolean(
    palettePreviewBlock
    && !isTopLevelLandingBlockType(palettePreviewBlock.blockType)
    && typeof paletteInsertIndex === 'number'
    && paletteSectionTarget
    && lane.section
    && paletteSectionTarget.sectionId === lane.section.id
  )

  return (
    <div className="rstk-section-columns">
      {lane.columnBlocks.map((columnBlocks, columnIndex) => {
        const isTargetColumn = showContentPreview && paletteSectionTarget?.sectionColumn === columnIndex
        const previewBeforeBlockId = isTargetColumn
          ? columnBlocks.find(block => paletteInsertIndex! <= (blockIndexById.get(block.id) ?? 0))?.id || ''
          : ''
        const showPreviewAfterColumn = isTargetColumn && columnBlocks.length > 0 && !previewBeforeBlockId

        return (
          <div
            key={`${lane.id}-${columnIndex}`}
            className={`rstk-section-column ${paletteDragging && lane.section ? 'rstk-section-column-active' : ''} ${isTargetColumn ? 'rstk-section-column-target' : ''}`}
            data-rstk-section-id={lane.section?.id || undefined}
            data-rstk-section-column={lane.section ? columnIndex : undefined}
          >
            {isTargetColumn && columnBlocks.length === 0 && palettePreviewBlock && (
              <PaletteInsertPreview block={palettePreviewBlock} forms={forms} calendars={calendars} />
            )}
            {columnBlocks.map(block => (
              <React.Fragment key={block.id}>
                {isTargetColumn && previewBeforeBlockId === block.id && palettePreviewBlock && (
                  <PaletteInsertPreview block={palettePreviewBlock} forms={forms} calendars={calendars} />
                )}
                <SortableCanvasBlock
                  block={block}
                  blocks={blocks}
                  index={blockIndexById.get(block.id) ?? 0}
                  selected={selectedBlockId === block.id}
                  site={site}
                  forms={forms}
                  calendars={calendars}
                  pages={pages}
                  activePageId={activePageId}
                  onSelect={() => onSelectBlock(block.id)}
                  onDelete={() => onDeleteBlock(block.id)}
                  onPatchBlock={(patch) => onPatchBlock(block.id, patch)}
                  onPatchSettings={(patch) => onPatchBlockSettings(block, patch)}
                  onSave={() => onSaveBlock(block.id)}
                />
              </React.Fragment>
            ))}
            {showPreviewAfterColumn && palettePreviewBlock && (
              <PaletteInsertPreview block={palettePreviewBlock} forms={forms} calendars={calendars} />
            )}
            {lane.section && columnBlocks.length === 0 && !isTargetColumn && (
              <div className="rstkColumnDropZone">Suelta contenido aqui</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const SortableLandingSection: React.FC<LandingSectionRenderProps> = ({
  lane,
  blocks,
  blockIndexById,
  selectedBlockId,
  site,
  forms,
  calendars,
  pages,
  activePageId,
  paletteDragging,
  palettePreviewBlock,
  paletteInsertIndex,
  paletteSectionTarget,
  onSelectBlock,
  onDeleteBlock,
  onPatchBlock,
  onPatchBlockSettings,
  onSaveBlock
}) => {
  const section = lane.section!
  const settings = section.settings || {}
  const selected = selectedBlockId === section.id
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
    animateLayoutChanges: sortableAnimateLayoutChanges,
    transition: sortableTransition
  })
  const hasHeading = Boolean(section.content || getSettingString(settings, 'subtitle'))

  return (
	    <section
	      ref={setNodeRef}
	      data-rstk-block-id={section.id}
	      data-rstk-block-index={blockIndexById.get(section.id) ?? 0}
	      data-rstk-page-block="true"
	      data-rstk-section-index={blockIndexById.get(section.id) ?? 0}
      data-rstk-section-id={section.id}
      className={getBlockStyleClassName(section, `rstk-section-lane rstkSel ${selected ? 'rstkSelActive' : ''} ${isDragging ? 'rstkSelDragging' : ''}`)}
      style={{
        transform: CSS.Transform.toString(transform),
	        transition: transition || 'transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        opacity: isDragging ? 0.34 : undefined,
        zIndex: isDragging ? 8 : undefined,
        ...getBlockCanvasStyle(section)
      }}
      onClick={(event) => {
        event.stopPropagation()
        onSelectBlock(section.id)
      }}
    >
      <div className="rstkBlockTools">
        <button type="button" className="rstkBlockTool rstkBlockToolDrag" {...attributes} {...listeners} aria-label="Reordenar franja">
          <GripVertical size={15} />
        </button>
        <button type="button" className="rstkBlockTool rstkBlockToolDelete" onClick={(event) => { event.stopPropagation(); onDeleteBlock(section.id) }} aria-label="Eliminar franja">
          <Trash2 size={14} />
        </button>
      </div>
      <div className="rstk-section-inner">
        {hasHeading && (
          <div className="rstk-section-heading">
            <InlineEditable as="h2" value={section.content} placeholder="Titulo opcional" onChange={(value) => onPatchBlock(section.id, { content: value })} onCommit={() => onSaveBlock(section.id)} />
            <InlineEditable as="p" multiline value={getSettingString(settings, 'subtitle')} placeholder="Texto breve opcional" onChange={(value) => onPatchBlockSettings(section, { subtitle: value })} onCommit={() => onSaveBlock(section.id)} />
          </div>
        )}
        <LandingSectionColumns
          lane={lane}
          blocks={blocks}
          blockIndexById={blockIndexById}
          selectedBlockId={selectedBlockId}
          site={site}
          forms={forms}
          calendars={calendars}
          pages={pages}
	          activePageId={activePageId}
	          paletteDragging={paletteDragging}
	          palettePreviewBlock={palettePreviewBlock}
	          paletteInsertIndex={paletteInsertIndex}
	          paletteSectionTarget={paletteSectionTarget}
	          onSelectBlock={onSelectBlock}
          onDeleteBlock={onDeleteBlock}
          onPatchBlock={onPatchBlock}
          onPatchBlockSettings={onPatchBlockSettings}
          onSaveBlock={onSaveBlock}
        />
      </div>
    </section>
  )
}

const LegacyLandingSection: React.FC<Omit<LandingSectionRenderProps, 'paletteDragging'>> = (props) => (
  <section className="rstk-section-lane rstk-section-lane-legacy">
    <div className="rstk-section-inner">
      <LandingSectionColumns {...props} />
    </div>
  </section>
)

const PaletteInsertPreview: React.FC<{
  block: SiteBlock
  forms: PublicSite[]
  calendars: CalendarType[]
}> = ({ block, forms, calendars }) => (
  <div className={getBlockStyleClassName(block, 'rstkPalettePreview')} style={getBlockCanvasStyle(block)}>
    <CanvasPreviewBlock block={block} forms={forms} calendars={calendars} />
  </div>
)

const InlineButtonRouting: React.FC<{
  settings: Record<string, unknown>
  pages: SitePage[]
  activePageId: string
  onPatchSettings: (patch: Record<string, unknown>) => void
  onSave: () => void
}> = ({ settings, pages, activePageId, onPatchSettings, onSave }) => (
  <div className={styles.inlineBlockTools} onClick={(event) => event.stopPropagation()}>
    <ButtonActionFields settings={settings} pages={pages} activePageId={activePageId} onPatchSettings={onPatchSettings} onSave={onSave} />
  </div>
)

const InlineBlockStyleControls: React.FC<{
  site: PublicSite
  block: SiteBlock
  onPatchSettings: (patch: Record<string, unknown>) => void
  onSave: () => void
}> = ({ site, block, onPatchSettings, onSave }) => {
  const settings = block.settings || {}
  const defaultAccent = defaultAccentForSite(site)
  const isSection = block.blockType === SECTION_BLOCK_TYPE
  const isLandingContent = isLanding(site) && !isSection
  const supportsButton = block.blockType === 'hero' || block.blockType === 'button' || block.blockType === 'cta'
  const supportsField = fieldBlockTypes.has(block.blockType)
  const isHardEmbed = block.blockType === 'embed' || block.blockType === 'calendar_embed'
  const supportsTextStyle = isSection || ['headline', 'title', 'subheading', 'subtitle', 'description', 'text', 'hero', 'cta', 'benefits', 'testimonials', 'services', 'faq', 'form_embed'].includes(block.blockType)
  const supportsMedia = block.blockType === 'image' || block.blockType === 'video'
  const supportsCards = ['benefits', 'testimonials', 'services', 'faq'].includes(block.blockType)
  const defaultBorderWidth = nativeBorderBlockTypes.has(block.blockType) ? 1 : 0

  return (
    <div className={styles.blockStyleControls} onClick={(event) => event.stopPropagation()}>
      {supportsTextStyle && (
        <>
          <div className={styles.panelSubheader}>Personalizacion del texto</div>
          <AlignmentControl
            label="Alineacion"
            value={getHorizontalAlign(settings, 'textAlign', block.blockType === 'hero' || block.blockType === 'cta' ? 'center' : 'left')}
            options={horizontalAlignOptions}
            onChange={(value) => onPatchSettings({ textAlign: value })}
            onCommit={onSave}
          />
          <div className={styles.twoColumn}>
            <DimensionField
              label="Tamano de letra"
              value={getSettingNumber(settings, 'fontSize', 18, 12, 72)}
              min={12}
              max={72}
              unit="px"
              onChange={(value) => onPatchSettings({ fontSize: value })}
              onCommit={onSave}
            />
            <DimensionField
              label="Ancho texto"
              value={getSettingNumber(settings, 'contentMaxWidth', 66, 10, 120)}
              min={10}
              max={120}
              unit="ch"
              onChange={(value) => onPatchSettings({ contentMaxWidth: value })}
              onCommit={onSave}
            />
          </div>
          <div className={styles.twoColumn}>
            <ColorField
              label="Color"
              value={getSettingHex(settings, 'blockText', '#111827')}
              onChange={(value) => onPatchSettings({ blockText: value })}
              onCommit={onSave}
            />
            <ColorField
              label="Color contorno"
              value={getSettingHex(settings, 'textStrokeColor', getSettingHex(settings, 'blockText', '#111827'))}
              onChange={(value) => onPatchSettings({ textStrokeColor: value })}
              onCommit={onSave}
            />
          </div>
          <div className={styles.twoColumn}>
            <DimensionField
              label="Contorno"
              value={getSettingNumber(settings, 'textStrokeWidth', 0, 0, 12)}
              min={0}
              max={12}
              unit="px"
              onChange={(value) => onPatchSettings({ textStrokeWidth: value })}
              onCommit={onSave}
            />
            <label className={styles.field}>
              <span>Fuente</span>
              <select value={getSettingString(settings, 'fontFamily')} onChange={(event) => onPatchSettings({ fontFamily: event.target.value })} onBlur={onSave}>
                <option value="">Sistema</option>
                <option value="Inter, system-ui, sans-serif">Inter</option>
                <option value="'Inter Tight', Inter, system-ui, sans-serif">Inter Tight</option>
                <option value="Georgia, 'Times New Roman', serif">Serif</option>
              </select>
            </label>
          </div>
          <div className={styles.inlineBlockTools}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={settings.fontWeight === 'bold'}
                onChange={(event) => {
                  onPatchSettings({ fontWeight: event.target.checked ? 'bold' : '' })
                  window.setTimeout(onSave, 0)
                }}
              />
              <span>Negrita</span>
            </label>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={settings.fontStyle === 'italic'}
                onChange={(event) => {
                  onPatchSettings({ fontStyle: event.target.checked ? 'italic' : '' })
                  window.setTimeout(onSave, 0)
                }}
              />
              <span>Italica</span>
            </label>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={settings.textDecoration === 'underline'}
                onChange={(event) => {
                  onPatchSettings({ textDecoration: event.target.checked ? 'underline' : '' })
                  window.setTimeout(onSave, 0)
                }}
              />
              <span>Subrayado</span>
            </label>
          </div>
        </>
      )}

      {supportsButton && (
        <>
          <div className={styles.panelSubheader}>Personalizacion del boton</div>
          <AlignmentControl
            label="Alineacion"
            value={getButtonAlign(settings, 'center')}
            options={buttonAlignOptions}
            onChange={(value) => onPatchSettings({ buttonAlign: value })}
            onCommit={onSave}
          />
          <div className={styles.twoColumn}>
            <ColorField
              label="Fondo del boton"
              value={getSettingPaint(settings, 'buttonBg', defaultAccent)}
              allowGradient
              onChange={(value) => onPatchSettings({ buttonBg: value })}
              onCommit={onSave}
            />
            <ColorField
              label="Texto del boton"
              value={getSettingHex(settings, 'buttonTextColor', onAccentFor(defaultAccent))}
              onChange={(value) => onPatchSettings({ buttonTextColor: value })}
              onCommit={onSave}
            />
          </div>
          <div className={styles.twoColumn}>
            <DimensionField
              label="Radio boton"
              value={getSettingNumber(settings, 'buttonRadius', 28, 0, 80)}
              min={0}
              max={80}
              onChange={(value) => onPatchSettings({ buttonRadius: value })}
              onCommit={onSave}
            />
            <DimensionField
              label="Alto boton"
              value={getSettingNumber(settings, 'buttonHeight', 54, 34, 88)}
              min={34}
              max={88}
              onChange={(value) => onPatchSettings({ buttonHeight: value })}
              onCommit={onSave}
            />
          </div>
          <div className={styles.twoColumn}>
            <DimensionField
              label="Relleno lados"
              value={getSettingNumber(settings, 'buttonPaddingX', 28, 8, 72)}
              min={8}
              max={72}
              onChange={(value) => onPatchSettings({ buttonPaddingX: value })}
              onCommit={onSave}
            />
            <DimensionField
              label="Texto boton"
              value={getSettingNumber(settings, 'buttonFontSize', 16, 11, 32)}
              min={11}
              max={32}
              onChange={(value) => onPatchSettings({ buttonFontSize: value })}
              onCommit={onSave}
            />
          </div>
          <div className={styles.twoColumn}>
            <DimensionField
              label="Borde boton"
              value={getSettingNumber(settings, 'buttonBorderWidth', 1, 0, 8)}
              min={0}
              max={8}
              onChange={(value) => onPatchSettings({ buttonBorderWidth: value })}
              onCommit={onSave}
            />
            <ColorField
              label="Color borde"
              value={getSettingHex(settings, 'buttonBorderColor', getSettingHex(settings, 'buttonBg', defaultAccent))}
              onChange={(value) => onPatchSettings({ buttonBorderColor: value })}
              onCommit={onSave}
            />
          </div>
        </>
      )}

      {supportsField && (
        <>
          <div className={styles.panelSubheader}>Personalizacion del campo</div>
          <div className={styles.twoColumn}>
            <ColorField
              label="Caja del campo"
              value={getSettingPaint(settings, 'fieldBg', '#ffffff')}
              allowGradient
              onChange={(value) => onPatchSettings({ fieldBg: value })}
              onCommit={onSave}
            />
            <ColorField
              label="Borde del campo"
              value={getSettingHex(settings, 'fieldBorder', '#dbe3ef')}
              onChange={(value) => onPatchSettings({ fieldBorder: value })}
              onCommit={onSave}
            />
          </div>
          <DimensionField
            label="Radio campo"
            value={getSettingNumber(settings, 'fieldRadius', 12, 0, 32)}
            min={0}
            max={32}
            onChange={(value) => onPatchSettings({ fieldRadius: value })}
            onCommit={onSave}
          />
        </>
      )}

      {supportsMedia && (
        <>
          <div className={styles.panelSubheader}>{block.blockType === 'image' ? 'Personalizacion de imagen' : 'Personalizacion de video'}</div>
          <AlignmentControl
            label="Alineacion"
            value={getHorizontalAlign(settings, 'mediaAlign', 'center')}
            options={horizontalAlignOptions}
            onChange={(value) => onPatchSettings({ mediaAlign: value })}
            onCommit={onSave}
          />
          <div className={styles.twoColumn}>
            <DimensionField
              label={block.blockType === 'image' ? 'Ancho imagen' : 'Ancho video'}
              value={getSettingNumber(settings, 'mediaWidth', 100, 30, 100)}
              min={30}
              max={100}
              unit="%"
              onChange={(value) => onPatchSettings({ mediaWidth: value })}
              onCommit={onSave}
            />
            <DimensionField
              label="Radio media"
              value={getSettingNumber(settings, 'mediaRadius', 18, 0, 48)}
              min={0}
              max={48}
              onChange={(value) => onPatchSettings({ mediaRadius: value })}
              onCommit={onSave}
            />
          </div>
        </>
      )}

      {supportsCards && (
        <>
          <div className={styles.panelSubheader}>Personalizacion de tarjetas</div>
          <AlignmentControl
            label="Texto tarjeta"
            value={getHorizontalAlign(settings, 'cardAlign', 'left')}
            options={horizontalAlignOptions}
            onChange={(value) => onPatchSettings({ cardAlign: value })}
            onCommit={onSave}
          />
          <div className={styles.twoColumn}>
            <DimensionField
              label="Columnas"
              value={getSettingNumber(settings, 'listColumns', 3, 1, 4)}
              min={1}
              max={4}
              unit=""
              onChange={(value) => onPatchSettings({ listColumns: value })}
              onCommit={onSave}
            />
            <DimensionField
              label="Radio tarjeta"
              value={getSettingNumber(settings, 'cardRadius', 18, 0, 48)}
              min={0}
              max={48}
              onChange={(value) => onPatchSettings({ cardRadius: value })}
              onCommit={onSave}
            />
          </div>
          <div className={styles.twoColumn}>
            <ColorField
              label="Fondo tarjeta"
              value={getSettingPaint(settings, 'cardBg', 'transparent')}
              allowGradient
              onChange={(value) => onPatchSettings({ cardBg: value })}
              onCommit={onSave}
            />
            <ColorField
              label="Borde tarjeta"
              value={getSettingHex(settings, 'cardBorderColor', '#dbe3ef')}
              onChange={(value) => onPatchSettings({ cardBorderColor: value })}
              onCommit={onSave}
            />
          </div>
          <DimensionField
            label="Grosor tarjeta"
            value={getSettingNumber(settings, 'cardBorderWidth', 1, 0, 8)}
            min={0}
            max={8}
            onChange={(value) => onPatchSettings({ cardBorderWidth: value })}
            onCommit={onSave}
          />
        </>
      )}

      <div className={styles.panelSubheader}>{isSection ? 'Estilo de franja' : isLandingContent ? 'Estilo del contenedor' : 'Estilo del bloque'}</div>
      <LinkedSpacingField
        label={isSection ? 'Relleno de franja' : 'Padding'}
        base="blockPadding"
        settings={settings}
        min={0}
        max={160}
        fallback={getSettingNumber(settings, 'blockPadding', 0, 0, 160)}
        onChange={onPatchSettings}
        onCommit={onSave}
      />
      <LinkedSpacingField
        label={isSection ? 'Separacion de franja' : 'Margen'}
        base="blockMargin"
        settings={settings}
        min={-80}
        max={200}
        fallback={getSettingNumber(settings, 'blockMargin', 0, -80, 200)}
        onChange={onPatchSettings}
        onCommit={onSave}
      />
      {!isHardEmbed && (
        <>
          <ColorField
            label={isSection ? 'Fondo de franja' : 'Fondo del contenedor'}
            value={getSettingPaint(settings, 'blockBg', 'transparent')}
            allowGradient
            onChange={(value) => onPatchSettings({ blockBg: value })}
            onCommit={onSave}
          />
          <div className={styles.twoColumn}>
            <DimensionField
              label="Radio"
              value={getSettingNumber(settings, 'blockRadius', 8, 0, 48)}
              min={0}
              max={48}
              onChange={(value) => onPatchSettings({ blockRadius: value })}
              onCommit={onSave}
            />
            <DimensionField
              label="Grosor borde"
              value={getSettingNumber(settings, 'blockBorderWidth', defaultBorderWidth, 0, 12)}
              min={0}
              max={12}
              onChange={(value) => onPatchSettings({ blockBorderWidth: value })}
              onCommit={onSave}
            />
          </div>
          <ColorField
            label="Color borde"
            value={getSettingHex(settings, 'blockBorderColor', '#dbe3ef')}
            onChange={(value) => onPatchSettings({ blockBorderColor: value })}
            onCommit={onSave}
          />
        </>
      )}
    </div>
  )
}

interface CanvasPreviewBlockProps {
  block: SiteBlock
  blocks?: SiteBlock[]
  forms: PublicSite[]
  calendars: CalendarType[]
  pages?: SitePage[]
  activePageId?: string
  selected?: boolean
  onPatchBlock?: (patch: Partial<SiteBlock>) => void
  onPatchSettings?: (patch: Record<string, unknown>) => void
  onSave?: () => void
}

const CanvasPreviewBlock: React.FC<CanvasPreviewBlockProps> = ({
  block,
  blocks = [],
  forms,
  calendars,
  pages = [],
  activePageId = DEFAULT_FUNNEL_PAGE_ID,
  selected = false,
  onPatchBlock,
  onPatchSettings,
  onSave
}) => {
  const settings = block.settings || {}
  const editable = Boolean(onPatchBlock && onSave)
  const patchBlock = onPatchBlock || (() => {})
  const patchSettings = onPatchSettings || (() => {})
  const save = onSave || (() => {})

  if (block.blockType === HEADER_PANEL_BLOCK_TYPE || block.blockType === FOOTER_PANEL_BLOCK_TYPE) {
    const links = getPanelLinks(settings)
    const isHeader = block.blockType === HEADER_PANEL_BLOCK_TYPE
    return (
      <div className={`rstk-site-panel ${isHeader ? 'rstk-site-panel-header' : 'rstk-site-panel-footer'}`}>
        <InlineEditable
          as={isHeader ? 'strong' : 'p'}
          className="rstk-site-panel-copy"
          multiline={!isHeader}
          value={block.content}
          placeholder={isHeader ? 'Nombre de marca' : 'Texto del pie de pagina'}
          disabled={!editable}
          onChange={(value) => patchBlock({ content: value })}
          onCommit={save}
        />
        {links.length > 0 && (
          <nav className="rstk-site-panel-links" aria-label={isHeader ? 'Enlaces superiores' : 'Enlaces inferiores'}>
            {links.map((link, index) => (
              <a key={`${link.label}-${index}`} href={link.url}>{link.label}</a>
            ))}
          </nav>
        )}
      </div>
    )
  }

  if (block.blockType === 'hero') {
    return (
      <section className="rstk-hero">
        <InlineEditable as="p" className="rstk-kicker" value={getSettingString(settings, 'kicker')} placeholder="Kicker (opcional)" disabled={!editable} onChange={(value) => patchSettings({ kicker: value })} onCommit={save} />
        <InlineEditable as="h1" className="rstk-headline" multiline value={block.content} placeholder={block.label || 'Titular principal'} disabled={!editable} onChange={(value) => patchBlock({ content: value })} onCommit={save} />
        <InlineEditable as="p" className="rstk-subheading" multiline value={getSettingString(settings, 'subtitle')} placeholder="Subtitulo" disabled={!editable} onChange={(value) => patchSettings({ subtitle: value })} onCommit={save} />
        <InlineEditable as="a" className="rstk-button-link" value={getSettingString(settings, 'buttonText')} placeholder="Texto del boton" disabled={!editable} onChange={(value) => patchSettings({ buttonText: value })} onCommit={save} />
      </section>
    )
  }

  if (['headline', 'title'].includes(block.blockType)) {
    return (
      <InlineEditable as="h1" className="rstk-headline" multiline value={block.content} placeholder={block.label || 'Titulo'} disabled={!editable} onChange={(value) => patchBlock({ content: value })} onCommit={save} />
    )
  }

  if (['subheading', 'subtitle', 'description'].includes(block.blockType)) {
    return (
      <InlineEditable as="p" className="rstk-subheading" multiline value={block.content} placeholder={block.label || 'Subtitulo'} disabled={!editable} onChange={(value) => patchBlock({ content: value })} onCommit={save} />
    )
  }

  if (block.blockType === 'text') {
    return (
      <InlineEditable as="div" className="rstk-text" multiline value={block.content || ''} placeholder="Texto de contenido" disabled={!editable} onChange={(value) => patchBlock({ content: value })} onCommit={save} />
    )
  }

  if (block.blockType === 'section') {
    const columns = getSectionColumns(block)
    return (
      <section className="rstk-section-break">
        <h2>{getSectionColumnLabel(columns)}</h2>
        <p>Franja para agregar contenido en {columns} {columns === 1 ? 'columna' : 'columnas'}.</p>
      </section>
    )
  }

  if (block.blockType === 'image') {
    const mediaUrl = getSettingString(settings, 'mediaUrl') || block.content
    return mediaUrl
      ? <figure className="rstk-media"><img src={mediaUrl} alt={block.label || 'Imagen'} loading="lazy" /></figure>
      : <div className="rstk-media rstk-media-empty">Imagen sin URL</div>
  }

  if (block.blockType === 'video') {
    const videoUrl = getSettingString(settings, 'mediaUrl') || block.content
    return videoUrl
      ? <div className="rstk-video"><iframe src={videoUrl} title={block.label || 'Video'} loading="lazy" allowFullScreen /></div>
      : <div className="rstk-media rstk-media-empty"><span className="rstk-play"><Play size={22} /></span>Agrega la URL del video</div>
  }

  if (block.blockType === 'button') {
    return (
      <InlineEditable as="a" className="rstk-button-link" value={getSettingString(settings, 'buttonText') || block.content || ''} placeholder="Boton" disabled={!editable} onChange={(value) => patchSettings({ buttonText: value })} onCommit={save} />
    )
  }

  if (block.blockType === 'benefits') {
    const items = getCanvasItems(settings)
    return (
      <section className="rstk-section-list rstk-checklist">
        <InlineEditable as="h2" value={block.content} placeholder={block.label || 'Titulo de seccion'} disabled={!editable} onChange={(value) => patchBlock({ content: value })} onCommit={save} />
        <ul className="rstk-check-list">
          {(items.length ? items : [{ title: 'Agrega elementos en el panel', text: '', author: '' }]).map((item, index) => {
            const tone = getItemTone(item)
            const title = stripToneMarker(item.title)
            const text = stripToneMarker(item.text)
            return (
              <li key={index} className={`rstk-check rstk-check-${tone}`}>
                <span className="rstk-check-icon" aria-hidden="true">{tone === 'con' ? <X size={15} /> : <Check size={15} />}</span>
                <span className="rstk-check-body">
                  {title && <strong>{title}</strong>}
                  {text && <span>{text}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      </section>
    )
  }

  if (['testimonials', 'services', 'faq'].includes(block.blockType)) {
    const items = getCanvasItems(settings)
    return (
      <section className="rstk-section-list">
        <InlineEditable as="h2" value={block.content} placeholder={block.label || 'Titulo de seccion'} disabled={!editable} onChange={(value) => patchBlock({ content: value })} onCommit={save} />
        <div className="rstk-list-grid">
          {(items.length ? items : [{ title: 'Elemento', text: 'Agrega elementos en el panel', author: '' }]).map((item, index) => (
            <article key={index}>
              {item.title && <strong>{item.title}</strong>}
              {item.text && <p>{item.text}</p>}
              {item.author && <small>{item.author}</small>}
            </article>
          ))}
        </div>
      </section>
    )
  }

  if (block.blockType === 'form_embed') {
    const formSiteId = getSettingString(settings, 'formSiteId')
    const form = forms.find(item => item.id === formSiteId)
    const embeddedBlocks = Array.isArray(settings.embeddedBlocks) ? settings.embeddedBlocks as SiteBlock[] : []
    const description = form ? `Usando formulario: ${form.name}` : getSettingString(settings, 'description')
    const fields = embeddedBlocks.length ? embeddedBlocks : [{ id: 'placeholder', blockType: 'short_text', label: 'Campo', required: true, placeholder: 'Respuesta' } as SiteBlock]
    return (
      <section className="rstk-embedded-form">
        <InlineEditable as="h2" value={block.content} placeholder="Formulario" disabled={!editable} onChange={(value) => patchBlock({ content: value })} onCommit={save} />
        {description && <p className="rstk-help">{description}</p>}
        {fields.map(field => <FieldStaticPreview key={field.id} block={field} />)}
      </section>
    )
  }

  if (block.blockType === 'cta') {
    return (
      <section className="rstk-cta">
        <InlineEditable as="h2" value={block.content} placeholder={block.label || 'CTA final'} disabled={!editable} onChange={(value) => patchBlock({ content: value })} onCommit={save} />
        <InlineEditable as="p" multiline value={getSettingString(settings, 'subtitle')} placeholder="Subtitulo" disabled={!editable} onChange={(value) => patchSettings({ subtitle: value })} onCommit={save} />
        <InlineEditable as="a" className="rstk-button-link" value={getSettingString(settings, 'buttonText')} placeholder="Texto del boton" disabled={!editable} onChange={(value) => patchSettings({ buttonText: value })} onCommit={save} />
      </section>
    )
  }

  if (block.blockType === 'calendar_embed') {
    const calendarName = getSettingString(settings, 'calendarName')
    const calendarSlug = getSettingString(settings, 'calendarSlug')
    if (calendarSlug) {
      return (
        <iframe
          className="rstk-embed rstk-calendar-embed"
          src={sitesService.getCalendarPreviewUrl(calendarSlug)}
          title={calendarName || `Calendario /${calendarSlug}`}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      )
    }

    return (
      <div className="rstk-embed rstk-embed-empty">
        <CalendarDays size={20} />
        <span style={{ marginTop: 6 }}>{calendarName || (calendarSlug ? `Calendario /${calendarSlug}` : 'Selecciona un calendario para embeber')}</span>
      </div>
    )
  }

  if (block.blockType === 'embed') {
    return <EmbedPreview rawCode={block.content} />
  }

  return <FieldPreview block={block} editable={editable} onPatchBlock={patchBlock} onSave={save} />
}

// Read-only field preview (rstk markup) for embedded form fields on the canvas.
const FieldStaticPreview: React.FC<{ block: SiteBlock }> = ({ block }) => (
  <section className="rstk-field">
    <label>{block.label || 'Pregunta'}{block.required ? <span className="rstk-required">*</span> : null}</label>
    {block.content ? <p className="rstk-help">{block.content}</p> : null}
    {block.blockType === 'paragraph'
      ? <textarea readOnly rows={4} placeholder={block.placeholder || ''} />
      : <input readOnly placeholder={block.placeholder || 'Respuesta'} />}
  </section>
)

const EmbedPreview: React.FC<{ rawCode: string }> = ({ rawCode }) => {
  const embed = resolveEmbedPreview(rawCode)

  if (embed.kind === 'empty') {
    return <div className="rstk-embed rstk-embed-empty">Pega una URL, iframe o codigo embed/html</div>
  }

  return (
    <iframe
      className={`rstk-embed ${embed.kind === 'html' ? 'rstk-embed-code' : ''}`}
      title={embed.title}
      src={embed.kind === 'url' ? embed.src : undefined}
      srcDoc={embed.kind === 'html' ? embed.srcDoc : undefined}
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
      sandbox={embed.kind === 'url' ? EMBED_SANDBOX_URL : EMBED_SANDBOX_HTML}
      allow={embed.kind === 'url' ? embed.allow || DEFAULT_EMBED_ALLOW : DEFAULT_EMBED_ALLOW}
      allowFullScreen
      style={{ minHeight: `${embed.height || EMBED_DEFAULT_HEIGHT}px` }}
    />
  )
}

// Field blocks: rstk-field markup with inline-editable label/help. The input is
// a non-interactive preview; placeholder/validation/options are edited in the panel.
const FieldPreview: React.FC<{
  block: SiteBlock
  editable: boolean
  onPatchBlock: (patch: Partial<SiteBlock>) => void
  onSave: () => void
}> = ({ block, editable, onPatchBlock, onSave }) => {
  const inputType = block.blockType === 'email' ? 'email' : block.blockType === 'phone' ? 'tel' : block.blockType === 'date' ? 'date' : block.blockType === 'number' || block.blockType === 'currency' ? 'number' : 'text'

  return (
    <section className="rstk-field">
      <label>
        <InlineEditable as="span" value={block.label} placeholder="Pregunta" disabled={!editable} onChange={(value) => onPatchBlock({ label: value })} onCommit={onSave} />
        {block.required ? <span className="rstk-required">*</span> : null}
      </label>
      {(editable || block.content) && (
        <InlineEditable as="p" className="rstk-help" multiline value={block.content} placeholder="Texto de ayuda (opcional)" disabled={!editable} onChange={(value) => onPatchBlock({ content: value })} onCommit={onSave} />
      )}
      {block.blockType === 'paragraph' ? (
        <textarea readOnly rows={4} placeholder={block.placeholder || ''} />
      ) : isChoiceBlock(block.blockType) ? (
        <div className="rstk-options">
          {getOptions(block).map(option => (
            <label key={option.id || option.label} className="rstk-option">
              <input type={block.blockType === 'checkboxes' ? 'checkbox' : 'radio'} readOnly />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : (
        <input type={inputType} readOnly placeholder={block.placeholder || ''} />
      )}
    </section>
  )
}

interface PropertiesPanelProps {
  site: PublicSite
  block: SiteBlock | null
  blocks: SiteBlock[]
  forms: PublicSite[]
  calendars: CalendarType[]
  pages: SitePage[]
  activePageId: string
  showSocialProfile: boolean
  onPatchSite: (patch: Partial<PublicSite>) => void
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSaveSite: () => void
  onPatchBlock: (patch: Partial<SiteBlock>) => void
  onPatchSettings: (patch: Record<string, unknown>) => void
  onPatchCategorySettings: (block: SiteBlock, patch: Record<string, unknown>) => void
  onSaveCategory: (block: SiteBlock) => void
  onSave: () => void
}

const PageInspector: React.FC<{
  site: PublicSite
  pages: SitePage[]
  activePageId: string
  showSocialProfile: boolean
  onPatchSite: (patch: Partial<PublicSite>) => void
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSaveSite: () => void
}> = ({ site, pages, activePageId, showSocialProfile, onPatchSite, onPatchTheme, onSaveSite }) => {
  const theme = site.theme || {}
  const currentId = resolveTemplateId(site)
  const platform = platformChromeFor(currentId)
  const activePage = pages.find(page => page.id === activePageId) || pages[0] || null
  const activePageEventName = activePage?.metaCapiEnabled
    ? normalizeMetaEventName(activePage.metaEventName, 'none')
    : 'none'
  const activePageHasConversion = activePageEventName !== 'none'
  const formEventName = normalizeMetaEventName(site.metaEventName, 'none')
  const formHasConversion = formEventName !== 'none'
  const patchActivePage = (patch: Partial<SitePage>) => {
    if (!activePage) return

    onPatchTheme({
      pages: normalizePagesForSave(pages.map(page => (
        page.id === activePage.id ? { ...page, ...patch } : page
      )))
    })
  }

  return (
    <aside className={styles.propertiesPanel}>
      <div className={styles.panelHeader}>
        <strong>{platform && showSocialProfile ? 'Social Media Profile' : 'Pagina'}</strong>
        <span>{isLanding(site) ? 'Sitio embudo' : 'Formulario'}</span>
      </div>
      <div className={styles.propertiesBody}>
        {!(platform && showSocialProfile) && (
        <div className={styles.settingsGroup}>
          <div className={styles.panelSubheader}>Colores</div>
          <div className={styles.twoColumn}>
            <ColorField
              label="Fondo de pagina"
              value={getThemePaint(theme, 'backgroundColor', userBgColor(site) || resolvedPageBg(site))}
              allowGradient
              onChange={(value) => onPatchTheme({ backgroundColor: value })}
              onCommit={onSaveSite}
            />
            <ColorField
              label="Acento"
              value={userAccentColor(site) || (isSiteDark(site) ? '#ffffff' : '#111827')}
              onChange={(value) => onPatchTheme({ accentColor: value })}
              onCommit={onSaveSite}
            />
          </div>
          <label className={styles.field}>
            <span>URL de fondo</span>
            <input
              value={getThemeString(theme, 'backgroundImage')}
              placeholder={theme.backgroundMediaType === 'video' ? 'https://.../video.mp4' : 'https://...'}
              onChange={(event) => onPatchTheme({ backgroundImage: event.target.value })}
              onBlur={onSaveSite}
            />
          </label>
          <div className={styles.twoColumn}>
            <label className={styles.field}>
              <span>Tipo</span>
              <select
                value={getThemeString(theme, 'backgroundMediaType') || 'image'}
                onChange={(event) => onPatchTheme({ backgroundMediaType: event.target.value as SiteTheme['backgroundMediaType'] })}
                onBlur={onSaveSite}
              >
                {backgroundMediaTypeOptions.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>Visualizacion</span>
              <select
                value={getBackgroundVisualValue(theme)}
                onChange={(event) => onPatchTheme(backgroundVisualPatch(event.target.value))}
                onBlur={onSaveSite}
              >
                {backgroundVisualOptions.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className={styles.panelSubheader}>Dimensiones</div>
          <DimensionField
            label="Ancho maximo"
            value={isLanding(site) && Number(theme.pageMaxWidth) === 1160 ? 1440 : getThemeNumber(theme, 'pageMaxWidth', isLanding(site) ? 1440 : 520, 360, 1440)}
            min={360}
            max={1440}
            step={10}
            onChange={(value) => onPatchTheme({ pageMaxWidth: value })}
            onCommit={onSaveSite}
          />
          <div className={styles.twoColumn}>
            <DimensionField
              label="Padding"
              value={getThemeNumber(theme, 'pagePadding', isLanding(site) ? LANDING_DEFAULT_PAGE_PADDING : 22, 0, 120)}
              min={0}
              max={120}
              onChange={(value) => onPatchTheme({ pagePadding: value })}
              onCommit={onSaveSite}
            />
            <DimensionField
              label="Radio"
              value={getThemeNumber(theme, 'pageRadius', isLanding(site) ? 0 : 24, 0, 40)}
              min={0}
              max={40}
              onChange={(value) => onPatchTheme({ pageRadius: value })}
              onCommit={onSaveSite}
            />
          </div>
          <div className={styles.panelSubheader}>Borde de pagina</div>
          <div className={styles.twoColumn}>
            <DimensionField
              label="Grosor"
              value={getThemeNumber(theme, 'pageBorderWidth', 0, 0, 12)}
              min={0}
              max={12}
              onChange={(value) => onPatchTheme({ pageBorderWidth: value })}
              onCommit={onSaveSite}
            />
            <ColorField
              label="Color"
              value={getThemeHex(theme, 'pageBorderColor', '#dbe3ef')}
              onChange={(value) => onPatchTheme({ pageBorderColor: value })}
              onCommit={onSaveSite}
            />
          </div>
          {isLanding(site) && activePage && (
            <>
              <div className={styles.panelSubheader}>Conversion de esta pagina</div>
              <div className={`${styles.metaCard} ${activePageHasConversion && site.metaCapiEnabled ? styles.metaCardActive : ''}`}>
                <span className={styles.metaMark} aria-hidden="true">∞</span>
                <div className={styles.metaCardInfo}>
                  <strong>{activePageHasConversion ? 'Evento configurado' : 'Sin evento'}</strong>
                  <small>{!site.metaCapiEnabled ? 'Requiere Meta del sitio' : activePageHasConversion ? 'Se envia desde esta pagina' : 'Solo PageView global'}</small>
                </div>
              </div>
              <div className={styles.twoColumn}>
                <label className={styles.field}>
                  <span>Cuando</span>
                  <select
                    value={normalizeMetaTrigger(activePage.metaTrigger)}
                    disabled={!site.metaCapiEnabled || !activePageHasConversion}
                    onChange={(event) => patchActivePage({ metaTrigger: event.target.value as SiteMetaTrigger })}
                    onBlur={onSaveSite}
                  >
                    {metaTriggerOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Evento</span>
                  <select
                    value={activePageEventName}
                    disabled={!site.metaCapiEnabled}
                    onChange={(event) => {
                      const metaEventName = event.target.value
                      patchActivePage({
                        metaEventName,
                        metaCapiEnabled: metaEventName !== 'none'
                      })
                    }}
                    onBlur={onSaveSite}
                  >
                    {metaEventOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}
          {isFormSite(site) && (
            <>
              <div className={styles.panelSubheader}>Conversion del formulario</div>
              <div className={`${styles.metaCard} ${formHasConversion && site.metaCapiEnabled ? styles.metaCardActive : ''}`}>
                <span className={styles.metaMark} aria-hidden="true">∞</span>
                <div className={styles.metaCardInfo}>
                  <strong>{formHasConversion ? 'Evento de submit' : 'Sin evento'}</strong>
                  <small>{!site.metaCapiEnabled ? 'Requiere Meta del sitio' : formHasConversion ? 'Se envia al enviar formulario' : 'Solo PageView global'}</small>
                </div>
              </div>
              <label className={styles.field}>
                <span>Evento de submit</span>
                <select
                  value={formEventName}
                  disabled={!site.metaCapiEnabled}
                  onChange={(event) => onPatchSite({ metaEventName: event.target.value })}
                  onBlur={onSaveSite}
                >
                  {metaEventOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span>Texto del boton de envio</span>
                <input value={theme.submitText || ''} placeholder="Enviar" onChange={(event) => onPatchTheme({ submitText: event.target.value })} onBlur={onSaveSite} />
              </label>
            </>
          )}
        </div>
        )}

        {platform && showSocialProfile && (
          <div className={styles.settingsGroup}>
            <div className={styles.panelSubheader}>Perfil de red social</div>
            <label className={styles.field}>
              <span>Red social</span>
              <select value={platform} onChange={(event) => onPatchTheme({ template: event.target.value as SiteTemplateId })} onBlur={onSaveSite}>
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
                <option value="tiktok">TikTok</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Nombre que se vera</span>
              <input value={theme.brandName || ''} placeholder={site.title || site.name} onChange={(event) => onPatchTheme({ brandName: event.target.value })} onBlur={onSaveSite} />
            </label>
            <label className={styles.field}>
              <span>Texto secundario</span>
              <input value={theme.brandSubtitle || ''} placeholder={platform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado'} onChange={(event) => onPatchTheme({ brandSubtitle: event.target.value })} onBlur={onSaveSite} />
            </label>
            <label className={styles.field}>
              <span>Foto de perfil (URL)</span>
              <input value={theme.brandAvatar || ''} placeholder="Pega la liga de la imagen" onChange={(event) => onPatchTheme({ brandAvatar: event.target.value })} onBlur={onSaveSite} />
            </label>
            <label className={styles.field}>
              <span>Seguidores</span>
              <input value={theme.followers || ''} placeholder="12 mil" onChange={(event) => onPatchTheme({ followers: event.target.value })} onBlur={onSaveSite} />
            </label>
          </div>
        )}
      </div>
    </aside>
  )
}

const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  site,
  block,
  blocks,
  forms,
  calendars,
  pages,
  activePageId,
  showSocialProfile,
  onPatchSite,
  onPatchTheme,
  onSaveSite,
  onPatchBlock,
  onPatchSettings,
  onPatchCategorySettings,
  onSaveCategory,
  onSave
}) => {
  if (!block) {
    return <PageInspector site={site} pages={pages} activePageId={activePageId} showSocialProfile={showSocialProfile} onPatchSite={onPatchSite} onPatchTheme={onPatchTheme} onSaveSite={onSaveSite} />
  }

  const isField = fieldBlockTypes.has(block.blockType)
  const settings = block.settings || {}
  const contentLabel = isField
    ? 'Texto de ayuda'
    : block.blockType === SECTION_BLOCK_TYPE
      ? 'Titulo visible opcional'
      : block.blockType === 'embed'
      ? 'Codigo embed, iframe o URL'
      : 'Contenido'
  const contentRows = block.blockType === 'embed' ? 7 : isField || block.blockType === SECTION_BLOCK_TYPE ? 2 : 3

  return (
    <aside className={styles.propertiesPanel}>
      <div className={styles.panelHeader}>
        <strong>Propiedades</strong>
        <span>{blockLabels[block.blockType]}</span>
      </div>

      <div className={styles.propertiesBody}>
        <label className={styles.field}>
          <span>{isField ? 'Label / pregunta' : block.blockType === SECTION_BLOCK_TYPE ? 'Nombre de la franja' : 'Nombre del bloque'}</span>
          <input value={block.label} onChange={(event) => onPatchBlock({ label: event.target.value })} onBlur={onSave} />
        </label>

        {block.blockType !== 'calendar_embed' && (
          <label className={styles.field}>
            <span>{contentLabel}</span>
            <textarea
              rows={contentRows}
              value={block.content}
              placeholder={block.blockType === 'embed' ? '<iframe src="https://..."></iframe> o codigo HTML del widget' : undefined}
              onChange={(event) => onPatchBlock({ content: event.target.value })}
              onBlur={onSave}
            />
          </label>
        )}

        {isField && (
          <>
            <div className={styles.twoColumn}>
              <label className={styles.field}>
                <span>Placeholder</span>
                <input value={block.placeholder} onChange={(event) => onPatchBlock({ placeholder: event.target.value })} onBlur={onSave} />
              </label>
              <label className={styles.field}>
                <span>Nombre interno</span>
                <input
                  value={getSettingString(settings, 'internalName')}
                  onChange={(event) => onPatchSettings({ internalName: event.target.value })}
                  onBlur={onSave}
                />
              </label>
            </div>

            <div className={styles.twoColumn}>
              <label className={styles.field}>
                <span>Validacion basica</span>
                <select
                  value={getSettingString(settings, 'validation')}
                  onChange={(event) => onPatchSettings({ validation: event.target.value })}
                  onBlur={onSave}
                >
                  <option value="">Ninguna</option>
                  <option value="email">Email</option>
                  <option value="phone">Telefono</option>
                  <option value="number">Numero</option>
                  <option value="currency">Moneda</option>
                  <option value="date">Fecha</option>
                </select>
              </label>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={block.required}
                  onChange={(event) => {
                    onPatchBlock({ required: event.target.checked })
                    window.setTimeout(onSave, 0)
                  }}
                />
                <span>Campo requerido</span>
              </label>
            </div>
          </>
        )}

        {isChoiceBlock(block.blockType) && (
          <OptionsRulesEditor block={block} blocks={blocks} onPatchBlock={onPatchBlock} onSave={onSave} />
        )}

        {!isField && (
          <LandingBlockSettings
            site={site}
            block={block}
            forms={forms}
            calendars={calendars}
            pages={pages}
            activePageId={activePageId}
            onPatchSettings={onPatchSettings}
            onSave={onSave}
          />
        )}

        <InlineBlockStyleControls
          site={site}
          block={block}
          onPatchSettings={onPatchSettings}
          onSave={onSave}
        />

        <div className={styles.propertiesActions}>
          <Button variant="secondary" onClick={onSave}>
            <Save size={16} />
            Guardar bloque
          </Button>
        </div>
      </div>
    </aside>
  )
}

interface OptionsRulesEditorProps {
  block: SiteBlock
  blocks: SiteBlock[]
  onPatchBlock: (patch: Partial<SiteBlock>) => void
  onSave: () => void
}

const OptionsRulesEditor: React.FC<OptionsRulesEditorProps> = ({ block, blocks, onPatchBlock, onSave }) => {
  const options = getOptions(block)
  const fieldTargets = blocks.filter(item => fieldBlockTypes.has(item.blockType) && item.id !== block.id)

  const patchOption = (index: number, patch: Partial<SiteBlockOption>) => {
    const next = options.map((option, optionIndex) => optionIndex === index ? { ...option, ...patch } : option)
    onPatchBlock({ options: next })
  }

  const addOption = () => {
    onPatchBlock({
      options: [
        ...options,
        {
          id: `option-${Date.now()}`,
          label: `Opcion ${options.length + 1}`,
          value: `Opcion ${options.length + 1}`,
          action: 'continue'
        }
      ]
    })
  }

  const removeOption = (index: number) => {
    onPatchBlock({ options: options.filter((_, optionIndex) => optionIndex !== index) })
  }

  return (
    <div className={styles.optionRules}>
      <div className={styles.optionRulesHeader}>
        <strong>Opciones y reglas</strong>
        <button type="button" onClick={addOption}>
          <Plus size={14} />
          Agregar
        </button>
      </div>
      {options.map((option, index) => (
        <div key={option.id || index} className={styles.optionRuleCard}>
          <div className={styles.twoColumn}>
            <label className={styles.field}>
              <span>Opcion</span>
              <input
                value={option.label}
                onChange={(event) => patchOption(index, { label: event.target.value, value: event.target.value })}
                onBlur={onSave}
              />
            </label>
            <label className={styles.field}>
              <span>Regla</span>
              <select
                value={option.action || 'continue'}
                onChange={(event) => {
                  const action = event.target.value as SiteOptionAction
                  const defaultCategory = action === 'cold_lead'
                    ? 'frio'
                    : action === 'warm_lead'
                      ? 'tibio'
                      : action === 'hot_lead'
                        ? 'caliente'
                        : option.category
                  patchOption(index, { action, category: defaultCategory })
                }}
                onBlur={onSave}
              >
                {ruleActions.map(action => <option key={action.value} value={action.value}>{action.label}</option>)}
              </select>
            </label>
          </div>

          {option.action === 'jump' && (
            <label className={styles.field}>
              <span>Saltar a pregunta</span>
              <select value={option.targetBlockId || ''} onChange={(event) => patchOption(index, { targetBlockId: event.target.value })} onBlur={onSave}>
                <option value="">Selecciona una pregunta</option>
                {fieldTargets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
              </select>
            </label>
          )}

          {(option.action === 'disqualify' || option.action === 'show_message' || option.action === 'end_form') && (
            <label className={styles.field}>
              <span>{option.action === 'end_form' ? 'Mensaje final' : 'Mensaje de no calificado'}</span>
              <textarea rows={2} value={option.message || ''} onChange={(event) => patchOption(index, { message: event.target.value })} onBlur={onSave} />
            </label>
          )}

          {(option.action === 'tag' || option.tag) && (
            <label className={styles.field}>
              <span>Etiqueta interna</span>
              <input value={option.tag || ''} onChange={(event) => patchOption(index, { tag: event.target.value })} onBlur={onSave} />
            </label>
          )}

          {(option.action === 'category' || option.action === 'cold_lead' || option.action === 'warm_lead' || option.action === 'hot_lead' || option.category) && (
            <label className={styles.field}>
              <span>Categoria del lead</span>
              <input value={option.category || ''} onChange={(event) => patchOption(index, { category: event.target.value })} onBlur={onSave} />
            </label>
          )}

          <button type="button" className={styles.removeOption} onClick={() => removeOption(index)}>
            <Trash2 size={14} />
            Quitar opcion
          </button>
        </div>
      ))}
    </div>
  )
}

interface LandingBlockSettingsProps {
  site: PublicSite
  block: SiteBlock
  forms: PublicSite[]
  calendars: CalendarType[]
  pages: SitePage[]
  activePageId: string
  onPatchSettings: (patch: Record<string, unknown>) => void
  onSave: () => void
}

const ButtonActionFields: React.FC<{
  settings: Record<string, unknown>
  pages: SitePage[]
  activePageId: string
  onPatchSettings: (patch: Record<string, unknown>) => void
  onSave: () => void
}> = ({ settings, pages, activePageId, onPatchSettings, onSave }) => {
  const action = getButtonAction(settings)
  const targetPages = pages.filter(page => page.id !== activePageId)

  return (
    <>
      <label className={styles.field}>
        <span>Accion del boton</span>
        <select value={action} onChange={(event) => onPatchSettings({ buttonAction: event.target.value })} onBlur={onSave}>
          <option value="url">Enviar a una URL</option>
          <option value="next_page">Ir a la siguiente pagina del embudo</option>
          <option value="specific_page">Ir a una pagina especifica del embudo</option>
        </select>
      </label>

      {action === 'url' && (
        <label className={styles.field}>
          <span>URL</span>
          <input value={getSettingString(settings, 'buttonUrl')} onChange={(event) => onPatchSettings({ buttonUrl: event.target.value })} onBlur={onSave} />
        </label>
      )}

      {action === 'specific_page' && (
        <label className={styles.field}>
          <span>Pagina destino</span>
          <select value={getSettingString(settings, 'buttonPageId')} onChange={(event) => onPatchSettings({ buttonPageId: event.target.value })} onBlur={onSave}>
            <option value="">Selecciona una pagina</option>
            {targetPages.map(page => <option key={page.id} value={page.id}>{page.title}</option>)}
          </select>
        </label>
      )}
    </>
  )
}

const LandingBlockSettings: React.FC<LandingBlockSettingsProps> = ({ site, block, forms, calendars, pages, activePageId, onPatchSettings, onSave }) => {
  const settings = block.settings || {}

  if (isPanelBlock(block)) {
    return (
      <div className={styles.settingsGroup}>
        <div className={styles.panelSubheader}>{block.blockType === HEADER_PANEL_BLOCK_TYPE ? 'Panel superior' : 'Panel inferior'}</div>
        <label className={styles.field}>
          <span>Enlaces del panel</span>
          <textarea
            rows={4}
            value={stringifyPanelLinks(settings)}
            placeholder="Nombre del enlace | https://..."
            onChange={(event) => onPatchSettings({ panelLinks: parsePanelLinks(event.target.value) })}
            onBlur={onSave}
          />
        </label>
        <p className={styles.muted}>Escribe un enlace por linea. Si no quieres enlaces, deja esta caja vacia.</p>
      </div>
    )
  }

  if (block.blockType === SECTION_BLOCK_TYPE) {
    return (
      <div className={styles.settingsGroup}>
        <div className={styles.panelSubheader}>Tipo de franja</div>
        <label className={styles.field}>
          <span>Columnas</span>
          <select
            value={String(getSectionColumns(block))}
            onChange={(event) => onPatchSettings({ sectionColumns: Number(event.target.value) })}
            onBlur={onSave}
          >
            <option value="1">Una columna</option>
            <option value="2">Dos columnas</option>
            <option value="3">Tres columnas</option>
          </select>
        </label>
        <DimensionField
          label="Espacio entre columnas"
          value={getSettingNumber(settings, 'sectionGap', DEFAULT_SECTION_GAP, 0, 80)}
          min={0}
          max={80}
          onChange={(value) => onPatchSettings({ sectionGap: value })}
          onCommit={onSave}
        />
      </div>
    )
  }

  if (['hero', 'cta'].includes(block.blockType)) {
    return (
      <div className={styles.settingsGroup}>
        {block.blockType === 'hero' && (
          <label className={styles.field}>
            <span>Kicker</span>
            <input value={getSettingString(settings, 'kicker')} onChange={(event) => onPatchSettings({ kicker: event.target.value })} onBlur={onSave} />
          </label>
        )}
        <label className={styles.field}>
          <span>Subtitulo</span>
          <textarea rows={2} value={getSettingString(settings, 'subtitle')} onChange={(event) => onPatchSettings({ subtitle: event.target.value })} onBlur={onSave} />
        </label>
        <div className={styles.twoColumn}>
          <label className={styles.field}>
            <span>Texto del boton</span>
            <input value={getSettingString(settings, 'buttonText')} onChange={(event) => onPatchSettings({ buttonText: event.target.value })} onBlur={onSave} />
          </label>
          <ButtonActionFields settings={settings} pages={pages} activePageId={activePageId} onPatchSettings={onPatchSettings} onSave={onSave} />
        </div>
      </div>
    )
  }

  if (block.blockType === 'button') {
    return (
      <div className={styles.twoColumn}>
        <label className={styles.field}>
          <span>Texto del boton</span>
          <input value={getSettingString(settings, 'buttonText')} onChange={(event) => onPatchSettings({ buttonText: event.target.value })} onBlur={onSave} />
        </label>
        <ButtonActionFields settings={settings} pages={pages} activePageId={activePageId} onPatchSettings={onPatchSettings} onSave={onSave} />
      </div>
    )
  }

  if (block.blockType === 'image' || block.blockType === 'video') {
    return (
      <label className={styles.field}>
        <span>{block.blockType === 'image' ? 'URL de imagen' : 'URL de video'}</span>
        <input value={getSettingString(settings, 'mediaUrl')} onChange={(event) => onPatchSettings({ mediaUrl: event.target.value })} onBlur={onSave} />
      </label>
    )
  }

  if (['benefits', 'testimonials', 'services', 'faq'].includes(block.blockType)) {
    return (
      <label className={styles.field}>
        <span>Items (uno por linea: titulo | texto | autor)</span>
        <textarea
          rows={5}
          value={stringifyItems(settings)}
          onChange={(event) => onPatchSettings({ items: parseItems(event.target.value) })}
          onBlur={onSave}
        />
      </label>
    )
  }

  if (block.blockType === 'calendar_embed') {
    const selectedCalendarId = getSettingString(settings, 'calendarId')
    const selectedCalendar = calendars.find(calendar => calendar.id === selectedCalendarId)

    return (
      <div className={styles.settingsGroup}>
        <label className={styles.field}>
          <span>Calendario a embeber</span>
          <select
            value={selectedCalendarId}
            onChange={(event) => {
              const calendar = calendars.find(item => item.id === event.target.value)
              onPatchSettings({
                calendarId: calendar?.id || '',
                calendarSlug: calendar?.slug || calendar?.widgetSlug || '',
                calendarName: calendar?.name || ''
              })
            }}
            onBlur={onSave}
          >
            <option value="">Selecciona un calendario</option>
            {calendars.map(calendar => (
              <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
            ))}
          </select>
        </label>
        {selectedCalendar ? (
          <p className={styles.muted}>
            {selectedCalendar.publicUrlEnabled
              ? `Se mostrara como iframe usando ${selectedCalendar.publicBookingPath || '/calendar/...'}`
              : selectedCalendar.publicUrlUnavailableReason || 'Conecta el dominio publico general para que funcione publicamente.'}
          </p>
        ) : (
          <p className={styles.muted}>Este bloque usa la URL publica del calendario en el mismo dominio del site.</p>
        )}
      </div>
    )
  }

  if (block.blockType === 'form_embed') {
    const embeddedBlocks = Array.isArray(settings.embeddedBlocks) ? settings.embeddedBlocks as SiteBlock[] : []

    return (
      <div className={styles.settingsGroup}>
        <label className={styles.field}>
          <span>Formulario existente</span>
          <select value={getSettingString(settings, 'formSiteId')} onChange={(event) => onPatchSettings({ formSiteId: event.target.value, embeddedBlocks: undefined })} onBlur={onSave}>
            <option value="">Formulario inline dentro de este sitio embudo</option>
            {forms.filter(form => form.id !== site.id).map(form => (
              <option key={form.id} value={form.id}>{form.name}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Descripcion del form</span>
          <textarea rows={2} value={getSettingString(settings, 'description')} onChange={(event) => onPatchSettings({ description: event.target.value })} onBlur={onSave} />
        </label>
        <label className={styles.field}>
          <span>Al terminar el formulario</span>
          <select value={getFormCompletionAction(settings)} onChange={(event) => onPatchSettings({ completionAction: event.target.value })} onBlur={onSave}>
            <option value="next_page">Ir a la siguiente pagina al terminar</option>
            <option value="next_page_if_qualified">Ir a la siguiente pagina solo si califica</option>
            <option value="form_default">Mantener la configuracion actual del formulario</option>
          </select>
        </label>
        <button
          type="button"
          className={styles.inlineCreateButton}
          onClick={() => {
            onPatchSettings({ formSiteId: '', embeddedBlocks: createEmbeddedBlocks(site.id) })
            window.setTimeout(onSave, 0)
          }}
        >
          <Plus size={15} />
          Crear formulario inline basico
        </button>
        {embeddedBlocks.length > 0 && (
          <p className={styles.muted}>{embeddedBlocks.length} campos inline guardados en este bloque.</p>
        )}
      </div>
    )
  }

  return null
}

const LeadsPanel: React.FC<{ rows: LeadRow[]; loading: boolean; onRefresh: () => void }> = ({ rows, loading, onRefresh }) => (
  <section className={styles.dataPanel}>
    <div className={styles.builderHeader}>
      <div>
        <h2>Respuestas</h2>
        <p>Respuestas recibidas desde sitios embudo y formularios publicos.</p>
      </div>
      <Button variant="secondary" onClick={onRefresh} loading={loading}>
        <RefreshCw size={16} />
        Refrescar
      </Button>
    </div>

    <div className={styles.leadsTable}>
      <div className={styles.leadsHeader}>
        <span>Lead</span>
        <span>Sitio</span>
        <span>Estado</span>
        <span>Reglas</span>
        <span>Fecha</span>
      </div>
      {rows.length === 0 ? (
        <div className={styles.emptyState}>
          <ListChecks size={24} />
          <p>No hay respuestas todavia.</p>
        </div>
      ) : rows.map(row => {
        const rules = row.meta?.rules && typeof row.meta.rules === 'object' ? row.meta.rules as Record<string, unknown> : {}
        const tags = Array.isArray(rules.tags) ? rules.tags.join(', ') : ''
        const categories = Array.isArray(rules.categories) ? rules.categories.join(', ') : ''
        return (
          <article key={row.id} className={styles.leadRow}>
            <span>{row.contactName || row.contactEmail || row.contactPhone || 'Lead sin nombre'}</span>
            <span>{row.siteName}</span>
            <span className={`${styles.statusPill} ${row.status === 'disqualified' ? styles.statusWarning : styles.statusSuccess}`}>
              {row.status === 'disqualified' ? 'Descalificado' : 'Recibido'}
            </span>
            <span>{[tags, categories].filter(Boolean).join(' / ') || 'Sin reglas'}</span>
            <span>{formatDate(row.createdAt)}</span>
          </article>
        )
      })}
    </div>
  </section>
)

interface DomainsPanelProps {
  domainConfig: SitesDomainConfig
  domainInput: string
  verifying: boolean
  onDomainChange: (value: string) => void
  onVerifyDomain: () => void
}

const DomainsPanel: React.FC<DomainsPanelProps> = ({
  domainConfig,
  domainInput,
  verifying,
  onDomainChange,
  onVerifyDomain
}) => {
  const domainStatus = !domainConfig.domain
    ? { label: 'Sin dominio', className: styles.statusMuted }
    : domainConfig.renderDomainVerified
      ? { label: 'Verificado', className: styles.statusSuccess }
      : { label: 'Pendiente', className: styles.statusWarning }

  return (
    <section className={styles.dataPanel}>
      <div className={styles.builderHeader}>
        <div>
          <h2>Dominios</h2>
          <p>Conecta un solo dominio general para enrutar todos los formularios y sitios embudo.</p>
        </div>
        <span className={`${styles.statusPill} ${domainStatus.className}`}>{domainStatus.label}</span>
      </div>

      <div className={styles.domainEditor}>
        <label className={styles.field}>
          <span>Dominio publico general</span>
          <input
            value={domainInput}
            placeholder="www.doctorramirez.com"
            onChange={(event) => onDomainChange(event.target.value)}
          />
        </label>
        {domainConfig.renderDomainError && <p className={styles.domainError}>{domainConfig.renderDomainError}</p>}
        <div className={styles.editorActions}>
          <Button onClick={onVerifyDomain} loading={verifying} disabled={!domainInput.trim()}>
            <CheckCircle2 size={16} />
            Verificar dominio
          </Button>
        </div>
      </div>
    </section>
  )
}
