import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
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
  LayoutTemplate,
  ListChecks,
  Maximize2,
  Monitor,
  MoreVertical,
  MousePointerClick,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings2,
  Sparkles,
  Smartphone,
  Trash2,
  Type,
  Video
} from 'lucide-react'
import { Button, Loading } from '@/components/common'
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
  type SiteOptionAction,
  type SitePage,
  type SiteSubmission,
  type SiteTemplateId,
  type SiteTheme,
  type SiteType
} from '@/services/sitesService'
import { calendarsService, type Calendar as CalendarType } from '@/services/calendarsService'
import { requestAIAgentOpen, type AIAgentSitesCreationKind } from '@/utils/aiAgentEvents'
import styles from './Sites.module.css'

type SitesSection = 'landings' | 'forms' | 'leads' | 'domains'
type DeviceMode = 'desktop' | 'mobile'
type CreateFlow = 'closed' | 'landing-start' | 'landing-template' | 'form-kind' | 'form-template'

interface LeadRow extends SiteSubmission {
  siteName: string
}

const sectionItems: Array<{ id: SitesSection; label: string; icon: React.ReactNode }> = [
  { id: 'landings', label: 'Landing pages ("sitio web")', icon: <LayoutTemplate size={17} /> },
  { id: 'forms', label: 'Formularios', icon: <FormInput size={17} /> },
  { id: 'leads', label: 'Respuestas / Leads', icon: <ListChecks size={17} /> },
  { id: 'domains', label: 'Dominios', icon: <Globe2 size={17} /> }
]

const emptySitesDomainConfig: SitesDomainConfig = {
  domain: '',
  renderDomainVerified: false,
  renderDomainCheckedAt: null,
  renderDomainError: null
}

const metaEventOptions = [
  { value: 'Lead', label: 'Lead' },
  { value: 'Schedule', label: 'Schedule' },
  { value: 'Purchase', label: 'Purchase' },
  { value: 'FormSubmitted', label: 'FormSubmitted' }
]

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
const DEFAULT_FUNNEL_PAGE_ID = 'page-1'
const SOCIAL_PROFILE_SELECTED_ID = '__social_profile__'

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

const getTrackingStats = (site?: PublicSite | null) => ({
  views: site?.trackingStats?.views || 0,
  visitors: site?.trackingStats?.visitors || 0,
  conversions: site?.trackingStats?.conversions || site?.submissionsCount || 0,
  conversionRate: site?.trackingStats?.conversionRate || 0
})

const normalizeRouteInput = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/^\/+/, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

const getRoutePath = (site?: PublicSite | null) => `/${normalizeRouteInput(site?.slug || '')}`

const buildPublicUrl = (site: PublicSite, domainConfig: SitesDomainConfig) =>
  domainConfig.domain ? `https://${domainConfig.domain}${getRoutePath(site)}` : ''

const getPublicRouteLabel = (site: PublicSite, domainConfig: SitesDomainConfig) =>
  domainConfig.domain ? `${domainConfig.domain}${getRoutePath(site)}` : getRoutePath(site)

const getNextRouteSlug = (siteType: SiteType, existingSites: PublicSite[]) => {
  const prefix = siteType === 'landing_page' ? 'site' : 'form'
  const used = new Set(existingSites.map(site => normalizeRouteInput(site.slug)))
  let index = 1
  let slug = `${prefix}-${String(index).padStart(2, '0')}`

  while (used.has(slug)) {
    index += 1
    slug = `${prefix}-${String(index).padStart(2, '0')}`
  }

  return slug
}

const templateMetaById = (id?: string) => siteTemplates.find(template => template.id === id)

const resolveTemplateId = (site?: PublicSite | null): SiteTemplateId => {
  const explicit = site?.theme?.template
  if (explicit && templateMetaById(explicit)) return explicit
  if (site?.siteType === 'interactive_form') return 'interactive'
  if (site?.siteType === 'landing_page') return 'ristak'
  return 'ristak'
}

const isDarkTemplate = (id: SiteTemplateId) => id === 'tiktok' || id === 'vsl' || id === 'interactive'

const isHex6 = (value?: string): value is string => !!value && /^#[0-9a-f]{6}$/i.test(value)

const relLum = (hex: string): number => {
  const h = hex.replace('#', '')
  const lin = (c: number) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16))
}

// Mirrors the backend palette resolution so the editor canvas matches the published site.
const userBgColor = (site: PublicSite): string | null => {
  const v = site.theme?.backgroundColor
  return isHex6(v) && v.toLowerCase() !== '#ffffff' ? v : null
}
const userAccentColor = (site: PublicSite): string | null => {
  const v = site.theme?.accentColor
  return isHex6(v) && v.toLowerCase() !== '#111827' ? v : null
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

const getCanvasThemeStyle = (site: PublicSite): React.CSSProperties => {
  const id = resolveTemplateId(site)
  const meta = templateMetaById(id)
  const platform = id === 'facebook' || id === 'instagram' || id === 'tiktok'
  const dark = isSiteDark(site)
  const theme = site.theme || {}
  const pageVars = {
    '--site-page-padding': `${getThemeNumber(theme, 'pagePadding', site.siteType === 'landing_page' ? 18 : 22, 0, 80)}px`,
    '--site-page-radius': `${getThemeNumber(theme, 'pageRadius', site.siteType === 'landing_page' ? 0 : 24, 0, 40)}px`,
    '--site-page-border': getThemeHex(theme, 'pageBorderColor', 'transparent'),
    '--site-page-max': `${getThemeNumber(theme, 'pageMaxWidth', site.siteType === 'landing_page' ? 1160 : 520, 360, 1440)}px`
  }
  if (platform) {
    return {
      ...pageVars,
      '--site-accent': meta?.accent || '#111827',
      '--site-background': id === 'tiktok' ? '#161616' : '#ffffff',
      '--site-surface': id === 'tiktok' ? '#161616' : '#ffffff',
      '--site-frame': id === 'tiktok' ? '#000000' : '#f0f2f5',
      '--site-text': id === 'tiktok' ? '#ffffff' : '#0f172a',
      '--site-muted': id === 'tiktok' ? '#a1a1aa' : '#64748b',
      '--site-border': id === 'tiktok' ? 'rgba(255,255,255,0.14)' : '#e6e8ec'
    } as React.CSSProperties
  }
  const bg = resolvedPageBg(site)
  const accent = userAccentColor(site) || (dark ? '#ffffff' : '#111827')
  const surface = dark ? `color-mix(in srgb, #ffffff 4%, ${bg})` : '#ffffff'
  return {
    ...pageVars,
    '--site-accent': accent,
    '--site-background': surface,
    '--site-surface': surface,
    '--site-frame': bg,
    '--site-text': dark ? '#f4f4f6' : '#0f172a',
    '--site-muted': dark ? '#a1a1aa' : '#64748b',
    '--site-border': dark ? 'rgba(255,255,255,0.12)' : '#e6e8ec'
  } as React.CSSProperties
}

const platformChromeFor = (id: SiteTemplateId): 'facebook' | 'instagram' | 'tiktok' | null => {
  if (id === 'facebook' || id === 'instagram' || id === 'tiktok') return id
  return null
}

const getCreateButtonLabel = (section: SitesSection) => {
  if (section === 'landings') return 'Crear landing page ("sitio web")'
  if (section === 'forms') return 'Crear formulario'
  return 'Nuevo sitio'
}

const getLibraryTitle = (section: SitesSection) => {
  if (section === 'landings') return 'Landing pages ("sitio web")'
  if (section === 'forms') return 'Formularios'
  return 'Sitios'
}

const getLibraryDescription = (section: SitesSection) => {
  if (section === 'landings') return 'Biblioteca de paginas publicas, embudos y sitios listos para editar.'
  if (section === 'forms') return 'Biblioteca de formularios publicos para capturar prospectos y respuestas.'
  return 'Biblioteca de sitios publicos.'
}

const getLibraryEmptyMessage = (section: SitesSection) => {
  if (section === 'landings') return 'Crea una landing page para verla aqui como tarjeta editable.'
  if (section === 'forms') return 'Crea un formulario para verlo aqui como tarjeta editable.'
  return getEmptyEditorMessage(section)
}

const getSiteTypeLabel = (site: PublicSite) => {
  if (site.siteType === 'landing_page') return 'Landing page'
  if (site.siteType === 'interactive_form') return 'Formulario interactivo'
  return 'Formulario'
}

const getCreateFlowForSection = (section: SitesSection): CreateFlow => {
  if (section === 'forms') return 'form-kind'
  return 'landing-start'
}

const getEmptyEditorMessage = (section: SitesSection) => {
  if (section === 'landings') return 'Crea una landing page para entrar al editor visual.'
  if (section === 'forms') return 'Crea un formulario para entrar al editor visual.'
  return 'Crea una landing o formulario para entrar al editor visual.'
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
  return isHex6(value) ? value : fallback
}

const getThemeHex = (theme: SiteTheme | undefined, key: keyof SiteTheme, fallback: string) => {
  const value = theme?.[key]
  return typeof value === 'string' && isHex6(value) ? value : fallback
}

const getBlockCanvasStyle = (block: SiteBlock): React.CSSProperties => {
  const settings = block.settings || {}
  const style: Record<string, string> = {}
  const bg = getSettingString(settings, 'blockBg')
  const text = getSettingString(settings, 'blockText')
  const fontFamily = getSettingString(settings, 'fontFamily')
  const fieldBg = getSettingString(settings, 'fieldBg')
  const fieldBorder = getSettingString(settings, 'fieldBorder')

  if (isHex6(bg)) style['--block-bg'] = bg
  if (isHex6(text)) style['--block-text'] = text
  if (fontFamily) style['--block-font'] = fontFamily
  if (isHex6(fieldBg)) style['--block-field-bg'] = fieldBg
  if (isHex6(fieldBorder)) style['--block-field-border'] = fieldBorder
  if (settings.fontWeight === 'bold') style['--block-font-weight'] = '850'

  if (settings.blockPadding !== undefined) style['--block-pad'] = `${getSettingNumber(settings, 'blockPadding', 16, 8, 64)}px`
  if (settings.blockRadius !== undefined) style['--block-radius'] = `${getSettingNumber(settings, 'blockRadius', 8, 0, 36)}px`
  if (settings.fontSize !== undefined) style['--block-font-size'] = `${getSettingNumber(settings, 'fontSize', 18, 12, 72)}px`
  if (settings.buttonRadius !== undefined) style['--block-button-radius'] = `${getSettingNumber(settings, 'buttonRadius', 8, 0, 40)}px`
  if (settings.mediaWidth !== undefined) style['--block-media-width'] = `${getSettingNumber(settings, 'mediaWidth', 100, 30, 100)}%`

  return style as React.CSSProperties
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
      sortOrder: Number.isFinite(Number(page?.sortOrder)) ? Number(page.sortOrder) : index
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
  sortOrder: index
})

const normalizePagesForSave = (pages: SitePage[]) =>
  pages.map((page, index) => ({
    id: page.id,
    title: page.title || `Pagina ${index + 1}`,
    sortOrder: index
  }))

const getBlockPageId = (block: SiteBlock, pages: SitePage[]) => {
  const pageId = getSettingString(block.settings || {}, 'pageId')
  return pages.some(page => page.id === pageId) ? pageId : pages[0]?.id || DEFAULT_FUNNEL_PAGE_ID
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

const defaultBlockPayload = (blockType: SiteBlockType, siteId: string) => {
  const isField = fieldBlockTypes.has(blockType)
  const label = blockLabels[blockType]
  const baseSettings: Record<string, unknown> = isField
    ? { internalName: slugifyName(label), validation: blockType === 'email' ? 'email' : blockType === 'phone' ? 'phone' : '' }
    : {}

  if (blockType === 'hero') {
    return {
      blockType,
      label,
      content: 'Titular principal',
      settings: { kicker: 'Nuevo', subtitle: 'Subtitulo de la landing', buttonText: 'Comenzar', buttonUrl: '#form' }
    }
  }

  if (blockType === 'cta') {
    return {
      blockType,
      label,
      content: 'Listo para empezar?',
      settings: { subtitle: 'Deja tus datos y te contactamos.', buttonText: 'Enviar solicitud', buttonUrl: '#form' }
    }
  }

  if (blockType === 'button') {
    return {
      blockType,
      label,
      content: 'Boton',
      settings: { buttonText: 'Continuar', buttonUrl: '#form' }
    }
  }

  if (['benefits', 'testimonials', 'services', 'faq'].includes(blockType)) {
    return {
      blockType,
      label,
      content: label,
      settings: { items: [{ title: 'Elemento 1', text: 'Descripcion breve.' }, { title: 'Elemento 2', text: 'Descripcion breve.' }] }
    }
  }

  if (blockType === 'form_embed') {
    return {
      blockType,
      label,
      content: 'Formulario',
      settings: { description: 'Completa tus datos.', embeddedBlocks: createEmbeddedBlocks(siteId) }
    }
  }

  if (blockType === 'embed') {
    return {
      blockType,
      label,
      content: '',
      settings: {}
    }
  }

  if (blockType === 'calendar_embed') {
    return {
      blockType,
      label,
      content: '',
      settings: { calendarId: '', calendarSlug: '', calendarName: '' }
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
    settings: baseSettings
  }
}

export const Sites: React.FC = () => {
  const { showToast } = useNotification()
  const navigate = useNavigate()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [section, setSection] = useState<SitesSection>('landings')
  const [sites, setSites] = useState<PublicSite[]>([])
  const [domainConfig, setDomainConfig] = useState<SitesDomainConfig>(emptySitesDomainConfig)
  const [domainInput, setDomainInput] = useState('')
  const [calendars, setCalendars] = useState<CalendarType[]>([])
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
  const [leadRows, setLeadRows] = useState<LeadRow[]>([])
  const [loadingLeads, setLoadingLeads] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [showLeaveModal, setShowLeaveModal] = useState(false)
  const [pendingLeaveAction, setPendingLeaveAction] = useState<(() => void) | null>(null)
  const guardHistoryArmedRef = useRef(false)
  const allowNavigationRef = useRef(false)

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
  const isFocusedSitesMode = createFlow !== 'closed' || Boolean(editorSite)
  const publicUrl = editorSite ? buildPublicUrl(editorSite, domainConfig) : ''
  const hasNextFunnelPage = Boolean(
    editorSite && isLanding(editorSite) && pages.length > 1 && activePage && pages.some(page => page.sortOrder > activePage.sortOrder)
  )
  const editorTrackingStats = getTrackingStats(editorSite)

  const performUrlNavigation = useCallback((href: string) => {
    const target = new URL(href, window.location.href)

    if (target.origin === window.location.origin) {
      navigate(`${target.pathname}${target.search}${target.hash}`)
      return
    }

    window.location.href = target.href
  }, [navigate])

  const requestLeaveEditor = useCallback((action: () => void) => {
    if (!hasUnsavedChanges) {
      action()
      return
    }

    setPendingLeaveAction(() => action)
    setShowLeaveModal(true)
  }, [hasUnsavedChanges])

  const markEditorDirty = useCallback(() => {
    if (editorSite) {
      setHasUnsavedChanges(true)
    }
  }, [editorSite])

  const handleCancelLeaveEditor = useCallback(() => {
    setShowLeaveModal(false)
    setPendingLeaveAction(null)

    if (hasUnsavedChanges && !guardHistoryArmedRef.current) {
      window.history.pushState({ ristakSitesUnsavedGuard: true }, '', window.location.href)
      guardHistoryArmedRef.current = true
    }
  }, [hasUnsavedChanges])

  const handleConfirmLeaveEditor = useCallback(() => {
    const action = pendingLeaveAction

    allowNavigationRef.current = true
    guardHistoryArmedRef.current = false
    setHasUnsavedChanges(false)
    setShowLeaveModal(false)
    setPendingLeaveAction(null)

    action?.()

    window.setTimeout(() => {
      allowNavigationRef.current = false
    }, 500)
  }, [pendingLeaveAction])

  useEffect(() => {
    const initialEditorId = new URLSearchParams(window.location.search).get('siteEditor') || undefined
    loadSites(initialEditorId)
    loadCalendarsForBuilder()
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
      if (selectedBlockId && selectedBlockId !== SOCIAL_PROFILE_SELECTED_ID) setSelectedBlockId('')
      return
    }
    if (selectedBlockId === SOCIAL_PROFILE_SELECTED_ID) return
    if (selectedBlockId && !canvasBlocks.some(block => block.id === selectedBlockId)) {
      setSelectedBlockId('')
    }
  }, [canvasBlocks, selectedBlockId])

  useEffect(() => {
    const handleAIDraftCreated = (event: Event) => {
      const site = (event as CustomEvent<PublicSite>).detail
      if (!site?.id) return

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

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowNavigationRef.current) return

      event.preventDefault()
      event.returnValue = ''
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
      setPendingLeaveAction(() => () => performUrlNavigation(targetUrl.href))
      setShowLeaveModal(true)
    }

    const handlePopState = () => {
      if (allowNavigationRef.current) return

      guardHistoryArmedRef.current = false
      setPendingLeaveAction(() => () => window.history.back())
      setShowLeaveModal(true)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('click', handleDocumentClick, true)
    window.addEventListener('popstate', handlePopState)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      document.removeEventListener('click', handleDocumentClick, true)
      window.removeEventListener('popstate', handlePopState)
    }
  }, [hasUnsavedChanges, performUrlNavigation])

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
        const site = await sitesService.getSite(nextId)
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
      const site = await sitesService.getSite(siteId)
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

  const syncSelectedSite = (site: PublicSite) => {
    setSelectedSite(site)
    setSelectedBlockId(current => site.blocks?.some(block => block.id === current) ? current : '')
    setSites(current => current.map(item => item.id === site.id ? { ...item, ...site } : item))
  }

  const updateSelectedSite = (patch: Partial<PublicSite>) => {
    markEditorDirty()
    setSelectedSite(current => current ? { ...current, ...patch } : current)
  }

  const patchSiteTheme = (patch: Partial<SiteTheme>) => {
    markEditorDirty()
    setSelectedSite(current => current ? { ...current, theme: { ...(current.theme || {}), ...patch } } : current)
  }

  const saveSiteTheme = async (site: PublicSite, theme: SiteTheme) => {
    return sitesService.updateSite(site.id, {
      name: site.name,
      slug: site.slug,
      siteType: site.siteType,
      status: site.status,
      title: site.title,
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

    const confirmed = window.confirm('Eliminar esta pagina y todos sus bloques?')
    if (!confirmed) return

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

  const handleReorderPages = (sourcePageId: string, targetPageId: string) => {
    if (!sourcePageId || sourcePageId === targetPageId) return
    const oldIndex = pages.findIndex(page => page.id === sourcePageId)
    const newIndex = pages.findIndex(page => page.id === targetPageId)
    if (oldIndex < 0 || newIndex < 0) return
    void persistFunnelPages(arrayMove(pages, oldIndex, newIndex), activePageId)
  }

  const handleCreateSite = async (siteType: SiteType, mode: 'blank' | 'template' = 'template', templateId?: SiteTemplateId) => {
    setCreating(true)
    try {
      const template: SiteTemplateId = templateId
        || (siteType === 'interactive_form' ? 'interactive' : siteType === 'landing_page' ? 'ristak' : 'ristak')
      let site = await sitesService.createSite({
        name: siteType === 'landing_page' ? 'Nueva landing' : siteType === 'interactive_form' ? 'Nuevo formulario interactivo' : 'Nuevo formulario',
        siteType,
        slug: getNextRouteSlug(siteType, sites),
        title: siteType === 'landing_page' ? 'Nueva landing' : 'Nuevo formulario',
        theme: {
          template,
          ...(siteType === 'landing_page' ? { pages: normalizePagesForSave([{ id: DEFAULT_FUNNEL_PAGE_ID, title: 'Pagina 1', sortOrder: 0 }]) } : {})
        }
      })

      if (siteType === 'landing_page' && mode === 'blank') {
        for (const block of site.blocks || []) {
          site = await sitesService.deleteBlock(site.id, block.id)
        }
      }

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

  const handleSaveSite = async (statusOverride?: PublicSite['status']) => {
    if (!selectedSite) return
    setSaving(true)
    try {
      const site = await sitesService.updateSite(selectedSite.id, {
        name: selectedSite.name,
        slug: selectedSite.slug,
        siteType: selectedSite.siteType,
        status: statusOverride || selectedSite.status,
        title: selectedSite.title,
        description: selectedSite.description,
        theme: selectedSite.theme,
        metaCapiEnabled: selectedSite.metaCapiEnabled,
        metaEventName: selectedSite.metaEventName
      })
      syncSelectedSite(site)
      setHasUnsavedChanges(false)
      showToast('success', statusOverride === 'published' ? 'Publicado' : 'Guardado', 'Sitio actualizado')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar')
    } finally {
      setSaving(false)
    }
  }

  const handlePreviewSite = async () => {
    if (!editorSite) return
    const previewWindow = window.open('', '_blank')
    if (!previewWindow) {
      showToast('error', 'Preview bloqueado', 'Permite popups para abrir la previsualizacion.')
      return
    }

    previewWindow.document.write('<!doctype html><title>Previsualizando...</title><body style="font-family: system-ui; padding: 24px;">Cargando previsualizacion...</body>')
    try {
      const html = await sitesService.getPreviewHtml(editorSite.id, isLanding(editorSite) ? activePage?.id : undefined)
      previewWindow.document.open()
      previewWindow.document.write(html)
      previewWindow.document.close()
    } catch (error) {
      previewWindow.close()
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo previsualizar')
    }
  }

  const handleOpenFullEditor = () => {
    if (!editorSite) return
    const url = new URL(window.location.href)
    url.searchParams.set('siteEditor', editorSite.id)
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
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

  const handleConfigureSiteDomain = (siteId: string) => {
    requestLeaveEditor(() => {
      const site = sites.find(item => item.id === siteId)
      if (site) {
        setSection(site.siteType === 'landing_page' ? 'landings' : 'forms')
        void openSite(site.id)
      }
      setCreateFlow('closed')
      setHasUnsavedChanges(false)
    })
  }

  const handleDeleteSite = async (siteToDelete = selectedSite) => {
    if (!siteToDelete) return
    const confirmed = window.confirm(`Eliminar "${siteToDelete.name}" y sus respuestas?`)
    if (!confirmed) return

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

  const handleAddBlock = async (blockType: SiteBlockType) => {
    if (!selectedSite) return
    try {
      const payload = defaultBlockPayload(blockType, selectedSite.id)
      if (isLanding(selectedSite) && activePage) {
        payload.settings = {
          ...(payload.settings || {}),
          pageId: activePage.id
        }
      }
      const site = await sitesService.createBlock(selectedSite.id, payload)
      syncSelectedSite(site)
      const added = [...(site.blocks || [])]
        .filter(block => !isLanding(site) || getBlockPageId(block, normalizeFunnelPages(site)) === (activePage?.id || DEFAULT_FUNNEL_PAGE_ID))
        .sort((a, b) => b.sortOrder - a.sortOrder)[0]
      if (added) setSelectedBlockId(added.id)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo agregar el bloque')
    }
  }

  const patchBlockLocal = (blockId: string, patch: Partial<SiteBlock>) => {
    markEditorDirty()
    setSelectedSite(current => {
      if (!current?.blocks) return current
      return {
        ...current,
        blocks: current.blocks.map(block => block.id === blockId ? { ...block, ...patch } : block)
      }
    })
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
    patchBlockLocal(block.id, {
      settings: {
        ...(block.settings || {}),
        ...patch
      }
    })
  }

  const patchBlockCategorySettingsLocal = (sourceBlock: SiteBlock, patch: Record<string, unknown>) => {
    markEditorDirty()
    const sourcePageId = isLanding(selectedSite) ? getBlockPageId(sourceBlock, pages) : ''
    setSelectedSite(current => {
      if (!current?.blocks) return current
      return {
        ...current,
        blocks: current.blocks.map(block => {
          const sameType = block.blockType === sourceBlock.blockType
          const samePage = !isLanding(current) || getBlockPageId(block, pages) === sourcePageId
          return sameType && samePage
            ? { ...block, settings: { ...(block.settings || {}), ...patch } }
            : block
        })
      }
    })
  }

  const handleSaveBlockCategory = async (sourceBlock = selectedBlock) => {
    if (!selectedSite?.blocks || !sourceBlock) return
    const sourcePageId = isLanding(selectedSite) ? getBlockPageId(sourceBlock, pages) : ''
    const targets = selectedSite.blocks.filter(block => {
      const sameType = block.blockType === sourceBlock.blockType
      const samePage = !isLanding(selectedSite) || getBlockPageId(block, pages) === sourcePageId
      return sameType && samePage
    })
    if (!targets.length) return

    try {
      let site = selectedSite
      for (const block of targets) {
        site = await sitesService.updateBlock(selectedSite.id, block.id, block)
      }
      syncSelectedSite(site)
      setHasUnsavedChanges(false)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar el estilo')
    }
  }

  const handleSaveBlock = async (blockId = selectedBlock?.id) => {
    if (!selectedSite?.blocks || !blockId) return
    const block = selectedSite.blocks.find(item => item.id === blockId)
    if (!block) return

    try {
      const site = await sitesService.updateBlock(selectedSite.id, block.id, block)
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

  const handleCanvasDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setPaletteDragging(false)
    const blockType = event.dataTransfer.getData('application/ristak-block') as SiteBlockType
    if (blockType) await handleAddBlock(blockType)
  }

  const handleCanvasDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('application/ristak-block')) {
      event.preventDefault()
      if (!paletteDragging) setPaletteDragging(true)
    }
  }

  if (loading) {
    return <Loading page="dashboard" />
  }

  return (
    <>
      <div className={`${styles.container} ${isFocusedSitesMode ? styles.containerFocused : ''}`}>
        <header className={`${styles.header} ${editorSite ? styles.editorHeader : ''}`}>
          {editorSite ? (
            <>
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
                    onChange={(event) => updateSelectedSite({ name: event.target.value })}
                    onBlur={() => handleSaveSite()}
                  />
                  <Pencil size={15} />
                </label>
                <label className={styles.publicTitleEditorField}>
                  <input
                    value={editorSite.title}
                    aria-label="Titulo publico"
                    placeholder="Titulo publico"
                    onChange={(event) => updateSelectedSite({ title: event.target.value })}
                    onBlur={() => handleSaveSite()}
                  />
                  <Pencil size={14} />
                </label>
                <div className={styles.trackingSummary} aria-label="Metricas de tracking nativo">
                  <span className={styles.trackingMetric}><span>{editorTrackingStats.views} vistas</span></span>
                  <span className={styles.trackingMetric}><span>{editorTrackingStats.visitors} visitantes</span></span>
                  <span className={styles.trackingMetric}><span>{editorTrackingStats.conversions} conversiones</span></span>
                  <span className={styles.trackingMetric}><span>{editorTrackingStats.conversionRate}% conversion</span></span>
                </div>
              </div>
              <div className={styles.editorTopControls}>
                <label className={styles.compactField}>
                  <span>Ruta publica</span>
                  <input
                    value={getRoutePath(editorSite)}
                    placeholder={editorSite.siteType === 'landing_page' ? '/site-01' : '/form-01'}
                    onChange={(event) => updateSelectedSite({ slug: normalizeRouteInput(event.target.value) })}
                    onBlur={() => handleSaveSite()}
                  />
                </label>
                <label className={`${styles.metaToggle} ${editorSite.metaCapiEnabled ? styles.metaToggleActive : ''}`}>
                  <input
                    type="checkbox"
                    checked={editorSite.metaCapiEnabled}
                    onChange={(event) => updateSelectedSite({ metaCapiEnabled: event.target.checked })}
                  />
                  <span className={styles.metaMark} aria-hidden="true">∞</span>
                  <span>
                    <strong>Meta Pixel + CAPI</strong>
                    <small>{editorSite.metaCapiEnabled ? 'Activo' : 'Apagado'}</small>
                  </span>
                </label>
                <label className={styles.compactField}>
                  <span>Evento</span>
                  <select
                    value={editorSite.metaEventName || 'Lead'}
                    disabled={!editorSite.metaCapiEnabled}
                    onChange={(event) => updateSelectedSite({ metaEventName: event.target.value })}
                    onBlur={() => handleSaveSite()}
                  >
                    {metaEventOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {hasNextFunnelPage && (
                  <label className={styles.compactField}>
                    <span>Conversion</span>
                    <select
                      value={editorSite.theme?.metaConversionTarget || 'same_page'}
                      disabled={!editorSite.metaCapiEnabled}
                      onChange={(event) => patchSiteTheme({ metaConversionTarget: event.target.value as SiteTheme['metaConversionTarget'] })}
                      onBlur={() => handleSaveSite()}
                    >
                      <option value="same_page">Esta pagina</option>
                      <option value="next_page">Pagina siguiente</option>
                    </select>
                  </label>
                )}
                <div className={styles.editorActions}>
                  {publicUrl && (
                    <a className={styles.iconLink} href={publicUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={16} />
                      Abrir
                    </a>
                  )}
                  <div className={styles.deviceToggle}>
                    <button type="button" className={device === 'desktop' ? styles.deviceActive : ''} onClick={() => setDevice('desktop')} title="Desktop">
                      <Monitor size={16} />
                    </button>
                    <button type="button" className={device === 'mobile' ? styles.deviceActive : ''} onClick={() => setDevice('mobile')} title="Movil">
                      <Smartphone size={16} />
                    </button>
                  </div>
                  <Button variant="secondary" onClick={handleOpenFullEditor}>
                    <Maximize2 size={16} />
                    Pantalla grande
                  </Button>
                  <Button variant="secondary" onClick={handlePreviewSite}>
                    <Eye size={16} />
                    Previsualizar
                  </Button>
                  <Button variant="secondary" onClick={() => handleSaveSite()} loading={saving}>
                    <Save size={16} />
                    Guardar
                  </Button>
                  <Button onClick={() => handleSaveSite('published')} loading={saving}>
                    <Send size={16} />
                    Publicar
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div>
              <div className={styles.titleRow}>
                {isFocusedSitesMode && (
                  <button type="button" className={styles.backButton} onClick={handleBackToLibrary}>
                    <ArrowLeft size={16} />
                    Volver
                  </button>
                )}
                <h1 className={styles.title}>Sitios</h1>
              </div>
              <p className={styles.subtitle}>Constructor visual controlado para landings, formularios, leads y publicacion por dominio verificado.</p>
            </div>
          )}
        </header>

        <div className={`${styles.sitesShell} ${isFocusedSitesMode ? styles.sitesShellFocused : ''}`}>
          {!isFocusedSitesMode && (
            <aside className={styles.internalSidebar}>
              <nav className={styles.sectionNav}>
                {sectionItems.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`${styles.sectionButton} ${section === item.id ? styles.sectionButtonActive : ''}`}
                    onClick={() => handleSectionChange(item.id)}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ))}
              </nav>
            </aside>
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
                creating={creating}
                selectedSiteId={selectedSite?.id || ''}
                onCreate={handleStartCreateFlow}
                onEdit={selectSite}
                onConfigureDomain={handleConfigureSiteDomain}
                onDelete={(site) => void handleDeleteSite(site)}
                domainConfig={domainConfig}
              />
            ) : editorSite ? (
              <section className={styles.builder}>
              <div className={`${styles.builderGrid} ${isLanding(editorSite) ? styles.builderGridLanding : styles.builderGridForm}`}>
                {isLanding(editorSite) && (
                  <div className={styles.pagesRail}>
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
                    />
                  </div>
                )}

                <div className={styles.blocksRail}>
                  <Palette
                    blockTypes={isLanding(editorSite) ? landingBlockTypes : formBlockTypes}
                    onAdd={handleAddBlock}
                  />
                </div>

                <section className={styles.canvasColumn}>
                  <div className={styles.canvasToolbar}>
                    <div>
                      <strong>{isLanding(editorSite) ? activePage?.title || 'Pagina 1' : 'Canvas'}</strong>
                      <span>{canvasBlocks.length} {canvasBlocks.length === 1 ? 'bloque' : 'bloques'}</span>
                    </div>
                  </div>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragCancel={() => setActiveDragId(null)}
                  >
                    <SortableContext items={canvasBlocks.map(block => block.id)} strategy={verticalListSortingStrategy}>
                      <div
                        className={`${styles.canvasWrap} ${device === 'mobile' ? styles.canvasWrapMobile : ''} ${paletteDragging ? styles.canvasWrapActive : ''} ${isSiteDark(editorSite) ? styles.canvasWrapDark : ''}`}
                        style={getCanvasThemeStyle(editorSite)}
                        onDragOver={handleCanvasDragOver}
                        onDragLeave={() => setPaletteDragging(false)}
                        onDrop={handleCanvasDrop}
                      >
                        <div
                          className={`${styles.pageCanvas} ${editorSite.siteType === 'interactive_form' ? styles.interactiveCanvas : ''} ${isSiteDark(editorSite) ? styles.darkCanvas : ''}`}
                          onClick={() => setSelectedBlockId('')}
                        >
                          {!isLanding(editorSite) && platformChromeFor(resolveTemplateId(editorSite)) && (
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
                                onSave={() => handleSaveSite()}
                              />
                            </div>
                          )}
                          {canvasBlocks.length === 0 ? (
                            <div className={styles.dropEmpty}>
                              <Plus size={22} />
                              <p>Arrastra bloques desde la barra de la izquierda o haz click para agregarlos.</p>
                            </div>
                          ) : canvasBlocks.map((block, index) => (
                            <SortableCanvasBlock
                              key={block.id}
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
                          ))}
                          {isFormSite(editorSite) && canvasBlocks.some(block => fieldBlockTypes.has(block.blockType)) && (
                            <div className={styles.editorSubmitPreview}>
                              <button type="button">{editorSite.theme?.submitText || 'Enviar'}</button>
                            </div>
                          )}
                        </div>
                      </div>
                    </SortableContext>
                    <DragOverlay dropAnimation={null}>
                      {activeDragBlock ? (
                        <div className={styles.dragOverlayCard} style={getCanvasThemeStyle(editorSite)}>
                          <CanvasPreviewBlock block={activeDragBlock} forms={forms} calendars={calendars} />
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
                  onPatchTheme={patchSiteTheme}
                  onSaveSite={() => handleSaveSite()}
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
    {showLeaveModal && (
      <UnsavedChangesModal
        onStay={handleCancelLeaveEditor}
        onLeave={handleConfirmLeaveEditor}
      />
    )}
    </>
  )
}

interface UnsavedChangesModalProps {
  onStay: () => void
  onLeave: () => void
}

const UnsavedChangesModal: React.FC<UnsavedChangesModalProps> = ({ onStay, onLeave }) => (
  <div className={styles.unsavedModalBackdrop}>
    <section className={styles.unsavedModal} role="dialog" aria-modal="true" aria-labelledby="unsaved-sites-title">
      <div className={styles.unsavedModalIcon}>
        <AlertTriangle size={22} />
      </div>
      <h2 id="unsaved-sites-title">Cambios sin guardar</h2>
      <p>
        Hay cambios en el editor que todavia no se han guardado o publicado. Si sales ahora, esos ajustes se van a perder.
      </p>
      <div className={styles.unsavedModalActions}>
        <Button variant="secondary" onClick={onStay}>
          Seguir editando
        </Button>
        <Button variant="danger" onClick={onLeave}>
          Salir sin guardar
        </Button>
      </div>
    </section>
  </div>
)

interface SitesLibraryPanelProps {
  section: SitesSection
  sites: PublicSite[]
  creating: boolean
  selectedSiteId: string
  domainConfig: SitesDomainConfig
  onCreate: () => void
  onEdit: (siteId: string) => void
  onConfigureDomain: (siteId: string) => void
  onDelete: (site: PublicSite) => void
}

const SitesLibraryPanel: React.FC<SitesLibraryPanelProps> = ({
  section,
  sites,
  creating,
  selectedSiteId,
  domainConfig,
  onCreate,
  onEdit,
  onConfigureDomain,
  onDelete
}) => {
  const isLandingLibrary = section === 'landings'

  return (
    <section className={styles.libraryPanel}>
      <div className={styles.libraryHeader}>
        <div>
          <span>{isLandingLibrary ? 'Sitios y embudos' : 'Captura de prospectos'}</span>
          <h2>{getLibraryTitle(section)}</h2>
          <p>{getLibraryDescription(section)}</p>
        </div>
        <Button onClick={onCreate} loading={creating}>
          <Plus size={16} />
          {getCreateButtonLabel(section)}
        </Button>
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
          const stats = getTrackingStats(site)
          const publicUrl = buildPublicUrl(site, domainConfig)
          const pagesCount = isLanding(site) ? normalizeFunnelPages(site).length : 1

          return (
            <article
              key={site.id}
              className={`${styles.libraryCard} ${selectedSiteId === site.id ? styles.libraryCardActive : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onEdit(site.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onEdit(site.id)
                }
              }}
            >
              <div className={styles.libraryCardPreview}>
                <div className={styles.libraryBrowserDots} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className={styles.libraryPreviewBody}>
                  {isLanding(site) ? <LayoutTemplate size={30} /> : <FormInput size={30} />}
                  <span>{getSiteTypeLabel(site)}</span>
                </div>
              </div>

              <div className={styles.libraryCardBody}>
                <div className={styles.libraryCardTitleRow}>
                  <strong>{site.name}</strong>
                  <span className={`${styles.statusPill} ${getStatusClass(site, domainConfig)}`}>{getStatusLabel(site, domainConfig)}</span>
                </div>
                <span className={styles.siteDomain}>{getPublicRouteLabel(site, domainConfig)}</span>
                <div className={styles.libraryMetaGrid}>
                  <span>{pagesCount} {pagesCount === 1 ? 'pagina' : 'paginas'}</span>
                  <span>{stats.visitors} visitantes</span>
                  <span>{stats.conversions} conv.</span>
                  <span>{stats.conversionRate}%</span>
                </div>
              </div>

              <div className={styles.libraryCardActions} aria-label={`Acciones para ${site.name}`}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onEdit(site.id)
                  }}
                >
                  <Pencil size={15} />
                  Editar
                </button>
                {publicUrl ? (
                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <ExternalLink size={15} />
                    Abrir
                  </a>
                ) : null}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onConfigureDomain(site.id)
                  }}
                >
                  <Settings2 size={15} />
                  Ruta
                </button>
                <button
                  type="button"
                  className={styles.libraryDangerAction}
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(site)
                  }}
                >
                  <Trash2 size={15} />
                  Eliminar
                </button>
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

const FORM_TEMPLATE_IDS: SiteTemplateId[] = ['facebook', 'instagram', 'tiktok', 'ristak']
const LANDING_TEMPLATE_IDS: SiteTemplateId[] = ['ristak', 'vsl']

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

const CreateFlowPanel: React.FC<CreateFlowPanelProps> = ({ step, creating, onCreate, onCreateWithAI, onAdvance }) => {
  const isLandingFlow = step === 'landing-start' || step === 'landing-template'
  const heading = step === 'landing-template'
    ? 'Elige el estilo de tu landing'
    : step === 'form-template'
      ? 'Donde se va a abrir tu formulario?'
      : isLandingFlow
        ? 'Como quieres iniciar la landing?'
        : 'Que tipo de formulario quieres?'

  return (
    <section className={styles.createPanel}>
      <div className={styles.createHeader}>
        {(step === 'form-template' || step === 'landing-template') && (
          <button type="button" className={styles.backLink} onClick={() => onAdvance(step === 'form-template' ? 'form-kind' : 'landing-start')}>
            <ChevronRight size={15} /> Volver
          </button>
        )}
        <span>{isLandingFlow ? 'Nueva landing ("sitio web")' : 'Nuevo formulario'}</span>
        <h2>{heading}</h2>
      </div>

      {step === 'landing-start' && (
        <div className={styles.choiceGrid}>
          <button type="button" disabled={creating} onClick={() => onAdvance('landing-template')}>
            <LayoutTemplate size={22} />
            <strong>Desde plantilla</strong>
            <p>Elige un estilo listo (minimal o carta de ventas) y empieza a editar.</p>
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
        <div className={styles.templateGallery}>
          {LANDING_TEMPLATE_IDS.map(id => (
            <TemplateCard key={id} id={id} disabled={creating} onPick={() => onCreate('landing_page', 'template', id)} />
          ))}
        </div>
      )}

      {step === 'form-kind' && (
        <div className={styles.choiceGrid}>
          <button type="button" disabled={creating} onClick={() => onAdvance('form-template')}>
            <FormInput size={22} />
            <strong>Una sola pagina</strong>
            <p>Todos los campos en una pagina. Se adapta al estilo de Facebook, Instagram o TikTok.</p>
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={creating} onClick={() => onCreate('interactive_form', 'template', 'interactive')}>
            <MousePointerClick size={22} />
            <strong>Interactivo</strong>
            <p>Una pregunta por pantalla, estilo quiz, con saltos y descalificacion.</p>
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

      {step === 'form-template' && (
        <>
          <p className={styles.galleryHint}>El formulario se vera como un anuncio nativo de la plataforma para que el lead sienta que nunca salio de ahi.</p>
          <div className={styles.templateGallery}>
            {FORM_TEMPLATE_IDS.map(id => (
              <TemplateCard key={id} id={id} disabled={creating} onPick={() => onCreate('standard_form', 'template', id)} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

interface DesignControlsProps {
  site: PublicSite
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSave: () => void
}

const CanvasStyleControls: React.FC<DesignControlsProps> = ({ site, onPatchTheme, onSave }) => {
  const currentId = resolveTemplateId(site)
  const platform = platformChromeFor(currentId)
  if (platform) return null

  const isForm = site.siteType !== 'landing_page'
  const pageColorValue = userBgColor(site) || (isForm ? '#ffffff' : '#08080a')
  const accentColorValue = userAccentColor(site) || (isForm ? '#111827' : '#ffffff')

  return (
    <div className={styles.canvasStyleControls} aria-label="Estilo de pagina">
      <label>
        <span>Fondo</span>
        <input
          type="color"
          value={pageColorValue}
          onChange={(event) => onPatchTheme({ backgroundColor: event.target.value })}
          onBlur={onSave}
        />
      </label>
      <label>
        <span>Acento</span>
        <input
          type="color"
          value={accentColorValue}
          onChange={(event) => onPatchTheme({ accentColor: event.target.value })}
          onBlur={onSave}
        />
      </label>
    </div>
  )
}

const DesignControls: React.FC<DesignControlsProps> = ({ site, onPatchTheme, onSave }) => {
  const currentId = resolveTemplateId(site)
  const isFormSite = site.siteType !== 'landing_page'
  const platform = platformChromeFor(currentId)
  const theme = site.theme || {}

  const pageColorValue = userBgColor(site) || (isFormSite ? '#ffffff' : '#08080a')
  const accentColorValue = userAccentColor(site) || (isFormSite ? '#111827' : '#ffffff')
  const pagePresets = isFormSite
    ? ['#ffffff', '#f6f7f9', '#0a0b0d', '#0b1020']
    : ['#08080a', '#0b1020', '#0f172a', '#f6f7f9']
  const accentPresets = ['#ffffff', '#2563eb', '#6366f1', '#10b981', '#111827']

  return (
    <div className={styles.designBar}>
      {!platform && (
        <div className={styles.designRow}>
          <div className={styles.colorField}>
            <span>Color de página</span>
            <div className={styles.colorPickRow}>
              <input
                type="color"
                className={styles.colorInput}
                value={pageColorValue}
                onChange={(event) => onPatchTheme({ backgroundColor: event.target.value })}
                onBlur={onSave}
                aria-label="Color de página"
              />
              {pagePresets.map(color => (
                <button
                  key={color}
                  type="button"
                  className={`${styles.swatchBtn} ${pageColorValue.toLowerCase() === color ? styles.swatchBtnActive : ''}`}
                  style={{ background: color }}
                  onClick={() => { onPatchTheme({ backgroundColor: color }); window.setTimeout(onSave, 0) }}
                  aria-label={color}
                />
              ))}
            </div>
          </div>
          <div className={styles.colorField}>
            <span>Color de acento</span>
            <div className={styles.colorPickRow}>
              <input
                type="color"
                className={styles.colorInput}
                value={accentColorValue}
                onChange={(event) => onPatchTheme({ accentColor: event.target.value })}
                onBlur={onSave}
                aria-label="Color de acento"
              />
              {accentPresets.map(color => (
                <button
                  key={color}
                  type="button"
                  className={`${styles.swatchBtn} ${accentColorValue.toLowerCase() === color ? styles.swatchBtnActive : ''}`}
                  style={{ background: color }}
                  onClick={() => { onPatchTheme({ accentColor: color }); window.setTimeout(onSave, 0) }}
                  aria-label={color}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      {(isFormSite || platform) && (
        <div className={styles.designRow}>
          {isFormSite && (
            <label className={styles.inlineField}>
              <span>Texto del boton</span>
              <input value={theme.submitText || ''} placeholder="Enviar" onChange={(event) => onPatchTheme({ submitText: event.target.value })} onBlur={onSave} />
            </label>
          )}
          {platform && (
            <>
              <label className={styles.inlineField}>
                <span>Nombre de la marca</span>
                <input value={theme.brandName || ''} placeholder={site.title || 'Tu marca'} onChange={(event) => onPatchTheme({ brandName: event.target.value })} onBlur={onSave} />
              </label>
              <label className={styles.inlineField}>
                <span>Etiqueta</span>
                <input value={theme.brandSubtitle || ''} placeholder={platform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado'} onChange={(event) => onPatchTheme({ brandSubtitle: event.target.value })} onBlur={onSave} />
              </label>
              <label className={styles.inlineField}>
                <span>Avatar (URL)</span>
                <input value={theme.brandAvatar || ''} placeholder="https://..." onChange={(event) => onPatchTheme({ brandAvatar: event.target.value })} onBlur={onSave} />
              </label>
              {platform === 'facebook' && (
                <label className={styles.brandCheckbox}>
                  <input type="checkbox" checked={theme.brandVerified !== false} onChange={(event) => { onPatchTheme({ brandVerified: event.target.checked }); window.setTimeout(onSave, 0) }} />
                  <span>Verificado</span>
                </label>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const CanvasAvatar: React.FC<{ name: string; avatar?: string }> = ({ name, avatar }) => (
  <span className={styles.chromeAvatar}>
    {avatar ? <img src={avatar} alt={name} /> : (name.trim()[0] || 'R').toUpperCase()}
  </span>
)

const CanvasChrome: React.FC<{
  platform: 'facebook' | 'instagram' | 'tiktok'
  site: PublicSite
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSave: () => void
}> = ({ platform, site, onPatchTheme, onSave }) => {
  const theme = site.theme || {}
  const name = theme.brandName || site.title || site.name || 'Tu marca'
  const subtitle = theme.brandSubtitle || (platform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado')
  const handle = name.normalize('NFD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'marca'
  const followers = String(theme.followers || '')
  const avatar = String(theme.brandAvatar || '')
  const patchAndSave = (patch: Partial<SiteTheme>) => {
    onPatchTheme(patch)
    window.setTimeout(onSave, 0)
  }

  const controls = null

  if (platform === 'facebook') {
    return (
      <div className={`${styles.canvasChrome} ${styles.chromeFacebook}`}>
        {controls}
        <CanvasAvatar name={name} avatar={theme.brandAvatar} />
        <div className={styles.chromeMeta}>
          <div className={styles.chromeName}>
            {name}
            {theme.brandVerified !== false && (
              <svg viewBox="0 0 24 24" width="14" height="14" className={styles.chromeVerified}><path fill="#1877f2" d="M12 2.2l2.3 1.7 2.85.05.95 2.7 2.25 1.8-.95 2.75.95 2.75-2.25 1.8-.95 2.7L14.3 18.6 12 20.3l-2.3-1.7-2.85-.05-.95-2.7L3.95 14.3l.95-2.75-.95-2.75 2.25-1.8.95-2.7L9.7 3.9z"/><path d="M8.4 12.3l2.4 2.4 4.8-4.9" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            )}
          </div>
          <div className={styles.chromeSub}>{subtitle}{followers ? ` · ${followers} seguidores` : ''} · <Globe2 size={11} /></div>
        </div>
        <span className={styles.chromeMark}>f</span>
      </div>
    )
  }

  if (platform === 'instagram') {
    return (
      <div className={`${styles.canvasChrome} ${styles.chromeInstagram}`}>
        {controls}
        <span className={styles.chromeRing}><CanvasAvatar name={name} avatar={theme.brandAvatar} /></span>
        <div className={styles.chromeMeta}>
          <div className={styles.chromeName}>{handle}</div>
          <div className={styles.chromeSub}>{subtitle}{followers ? ` · ${followers} seguidores` : ''}</div>
        </div>
        <span className={styles.chromeDots}>···</span>
      </div>
    )
  }

  return (
    <div className={`${styles.canvasChrome} ${styles.chromeTiktok}`}>
      {controls}
      <CanvasAvatar name={name} avatar={theme.brandAvatar} />
      <div className={styles.chromeMeta}>
        <div className={styles.chromeName}>@{handle}</div>
        <div className={styles.chromeSub}>{subtitle}{followers ? ` · ${followers} seguidores` : ''}</div>
      </div>
      <span className={styles.chromeMark}>♪</span>
    </div>
  )
}

const paletteGroups: Array<{ label: string; types: SiteBlockType[] }> = [
  { label: 'Contenido', types: ['hero', 'title', 'subtitle', 'text', 'image', 'video', 'button', 'benefits', 'testimonials', 'services', 'faq', 'cta', 'embed', 'calendar_embed', 'form_embed'] },
  { label: 'Campos', types: ['short_text', 'paragraph', 'email', 'phone', 'number', 'currency', 'date', 'dropdown', 'radio', 'checkboxes', 'description'] }
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
  onReorderPages
}) => {
  const [menuPageId, setMenuPageId] = useState<string | null>(null)

  return (
    <aside className={styles.pagesPanel}>
      <div className={styles.panelHeader}>
        <strong>Paginas</strong>
        <span>{pages.length}</span>
      </div>
      <div className={styles.pageList}>
        {pages.map((page, index) => (
          <div
            key={page.id}
            className={`${styles.pageItemWrap} ${draggingPageId === page.id ? styles.pageItemDragging : ''}`}
            draggable
            onDragStart={(event) => {
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
            <button
              type="button"
              className={`${styles.pageItem} ${activePageId === page.id ? styles.pageItemActive : ''}`}
              onClick={() => onSelectPage(page.id)}
            >
              <GripVertical size={14} />
              <span>{page.title || `Pagina ${index + 1}`}</span>
            </button>
            <div className={styles.pageMenuWrap}>
              <button
                type="button"
                className={styles.pageMenuButton}
                onClick={() => setMenuPageId(current => current === page.id ? null : page.id)}
                aria-label="Opciones de pagina"
              >
                <MoreVertical size={15} />
              </button>
              {menuPageId === page.id && (
                <div className={styles.pageMenu}>
                  <button type="button" onClick={() => { setMenuPageId(null); onDuplicatePage(page.id) }}>
                    <Copy size={14} />
                    Duplicar pagina
                  </button>
                  <button type="button" disabled={pages.length <= 1} onClick={() => { setMenuPageId(null); onDeletePage(page.id) }}>
                    <Trash2 size={14} />
                    Eliminar pagina
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <button type="button" className={styles.addPageButton} onClick={onAddPage}>
        <Plus size={15} />
        Agregar pagina
      </button>
    </aside>
  )
}

const Palette: React.FC<{ blockTypes: SiteBlockType[]; onAdd: (blockType: SiteBlockType) => void }> = ({ blockTypes, onAdd }) => {
  const allowed = new Set(blockTypes)
  const groups = paletteGroups
    .map(group => ({ label: group.label, types: group.types.filter(type => allowed.has(type)) }))
    .filter(group => group.types.length > 0)

  return (
    <aside className={styles.palette}>
      <div className={styles.panelHeader}>
        <strong>Bloques</strong>
        <span>Arrastra o da click</span>
      </div>
      <div className={styles.paletteGroups}>
        {groups.map(group => (
          <div key={group.label} className={styles.paletteGroup}>
            <span className={styles.paletteGroupLabel}>{group.label}</span>
            <div className={styles.paletteItems}>
              {group.types.map(blockType => (
                <button
                  key={blockType}
                  type="button"
                  className={styles.paletteItem}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('application/ristak-block', blockType)}
                  onClick={() => onAdd(blockType)}
                >
                  <span className={styles.paletteIcon}>{blockIcons[blockType]}</span>
                  <span>{blockLabels[blockType]}</span>
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id })

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, ...getBlockCanvasStyle(block) }}
      className={`${styles.canvasBlock} ${selected ? styles.canvasBlockSelected : ''} ${isDragging ? styles.canvasBlockDragging : ''}`}
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
    >
      <button type="button" className={styles.dragHandle} {...attributes} {...listeners} aria-label="Reordenar bloque">
        <GripVertical size={16} />
      </button>
      {site.siteType === 'interactive_form' && fieldBlockTypes.has(block.blockType) && (
        <span className={styles.stepBadge}>Pantalla {index + 1}</span>
      )}
      <button type="button" className={styles.blockDelete} onClick={(event) => { event.stopPropagation(); onDelete() }} aria-label="Eliminar bloque">
        <Trash2 size={15} />
      </button>
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
    </article>
  )
}

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
  block: SiteBlock
  onPatchSettings: (patch: Record<string, unknown>) => void
  onSave: () => void
}> = ({ block, onPatchSettings, onSave }) => {
  const settings = block.settings || {}
  const supportsButton = block.blockType === 'hero' || block.blockType === 'button' || block.blockType === 'cta'
  const supportsField = fieldBlockTypes.has(block.blockType)
  const supportsMedia = block.blockType === 'image'

  return (
    <div className={styles.inlineBlockTools} onClick={(event) => event.stopPropagation()}>
      <label>
        <span>Fondo</span>
        <input type="color" value={getSettingHex(settings, 'blockBg', '#ffffff')} onChange={(event) => onPatchSettings({ blockBg: event.target.value })} onBlur={onSave} />
      </label>
      <label>
        <span>Texto</span>
        <input type="color" value={getSettingHex(settings, 'blockText', '#111827')} onChange={(event) => onPatchSettings({ blockText: event.target.value })} onBlur={onSave} />
      </label>
      <label>
        <span>Padding</span>
        <input type="range" min="8" max="64" value={getSettingNumber(settings, 'blockPadding', 16, 8, 64)} onChange={(event) => onPatchSettings({ blockPadding: Number(event.target.value) })} onBlur={onSave} />
      </label>
      <label>
        <span>Radio</span>
        <input type="range" min="0" max="36" value={getSettingNumber(settings, 'blockRadius', 8, 0, 36)} onChange={(event) => onPatchSettings({ blockRadius: Number(event.target.value) })} onBlur={onSave} />
      </label>
      <label>
        <span>Tamano</span>
        <input type="range" min="12" max="72" value={getSettingNumber(settings, 'fontSize', 18, 12, 72)} onChange={(event) => onPatchSettings({ fontSize: Number(event.target.value) })} onBlur={onSave} />
      </label>
      <label>
        <span>Fuente</span>
        <select value={getSettingString(settings, 'fontFamily')} onChange={(event) => onPatchSettings({ fontFamily: event.target.value })} onBlur={onSave}>
          <option value="">Sistema</option>
          <option value="Inter, system-ui, sans-serif">Inter</option>
          <option value="'Inter Tight', Inter, system-ui, sans-serif">Inter Tight</option>
          <option value="Georgia, 'Times New Roman', serif">Serif</option>
        </select>
      </label>
      <label className={styles.inlineCheck}>
        <input
          type="checkbox"
          checked={settings.fontWeight === 'bold'}
          onChange={(event) => {
            onPatchSettings({ fontWeight: event.target.checked ? 'bold' : '' })
            window.setTimeout(onSave, 0)
          }}
        />
        <span>Bold</span>
      </label>
      {supportsButton && (
        <label>
          <span>Botones</span>
          <input type="range" min="0" max="40" value={getSettingNumber(settings, 'buttonRadius', 8, 0, 40)} onChange={(event) => onPatchSettings({ buttonRadius: Number(event.target.value) })} onBlur={onSave} />
        </label>
      )}
      {supportsField && (
        <>
          <label>
            <span>Caja</span>
            <input type="color" value={getSettingHex(settings, 'fieldBg', '#ffffff')} onChange={(event) => onPatchSettings({ fieldBg: event.target.value })} onBlur={onSave} />
          </label>
          <label>
            <span>Borde</span>
            <input type="color" value={getSettingHex(settings, 'fieldBorder', '#dbe3ef')} onChange={(event) => onPatchSettings({ fieldBorder: event.target.value })} onBlur={onSave} />
          </label>
        </>
      )}
      {supportsMedia && (
        <label>
          <span>Imagen</span>
          <input type="range" min="30" max="100" value={getSettingNumber(settings, 'mediaWidth', 100, 30, 100)} onChange={(event) => onPatchSettings({ mediaWidth: Number(event.target.value) })} onBlur={onSave} />
        </label>
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
  const styleTools = null

  if (block.blockType === 'hero') {
    return (
      <section className={styles.previewHero}>
        <input
          className={styles.inlineKicker}
          value={getSettingString(settings, 'kicker')}
          placeholder="Kicker"
          disabled={!editable}
          onChange={(event) => patchSettings({ kicker: event.target.value })}
          onBlur={save}
        />
        <textarea
          className={styles.inlineHeroTitle}
          rows={2}
          value={block.content}
          placeholder={block.label || 'Titular principal'}
          disabled={!editable}
          onChange={(event) => patchBlock({ content: event.target.value })}
          onBlur={save}
        />
        <textarea
          className={styles.inlineTextArea}
          rows={2}
          value={getSettingString(settings, 'subtitle')}
          placeholder="Subtitulo"
          disabled={!editable}
          onChange={(event) => patchSettings({ subtitle: event.target.value })}
          onBlur={save}
        />
        <input
          className={styles.inlineButtonInput}
          value={getSettingString(settings, 'buttonText')}
          placeholder="Texto del boton"
          disabled={!editable}
          onChange={(event) => patchSettings({ buttonText: event.target.value })}
          onBlur={save}
        />
        {selected && pages.length > 0 && (
          <InlineButtonRouting settings={settings} pages={pages} activePageId={activePageId} onPatchSettings={patchSettings} onSave={save} />
        )}
        {styleTools}
      </section>
    )
  }

  if (['headline', 'title'].includes(block.blockType)) {
    return (
      <>
        <textarea
          className={`${styles.previewHeadline} ${styles.inlineHeadingInput}`}
          rows={2}
          value={block.content}
          placeholder={block.label || 'Titulo'}
          disabled={!editable}
          onChange={(event) => patchBlock({ content: event.target.value })}
          onBlur={save}
        />
        {styleTools}
      </>
    )
  }

  if (['subheading', 'subtitle', 'description'].includes(block.blockType)) {
    return (
      <>
        <textarea
          className={`${styles.previewSubheading} ${styles.inlineTextArea}`}
          rows={2}
          value={block.content}
          placeholder={block.label || 'Subtitulo'}
          disabled={!editable}
          onChange={(event) => patchBlock({ content: event.target.value })}
          onBlur={save}
        />
        {styleTools}
      </>
    )
  }

  if (block.blockType === 'text') {
    return (
      <>
        <textarea
          className={`${styles.previewText} ${styles.inlineTextArea}`}
          rows={4}
          value={block.content || ''}
          placeholder="Texto de contenido"
          disabled={!editable}
          onChange={(event) => patchBlock({ content: event.target.value })}
          onBlur={save}
        />
        {styleTools}
      </>
    )
  }

  if (block.blockType === 'image') {
    const mediaUrl = getSettingString(settings, 'mediaUrl') || block.content
    return (
      <div className={styles.previewMediaEditor}>
        {mediaUrl ? <img src={mediaUrl} alt={block.label || 'Imagen'} /> : <div className={styles.previewMedia}>Imagen</div>}
        {selected && (
          <div className={styles.inlineControls}>
            <input value={mediaUrl} placeholder="URL de imagen" onChange={(event) => patchSettings({ mediaUrl: event.target.value })} onBlur={save} />
            <label>
              <span>Tamaño</span>
              <input
                type="range"
                min="30"
                max="100"
                value={Number(settings.mediaWidth || 100)}
                onChange={(event) => patchSettings({ mediaWidth: Number(event.target.value) })}
                onBlur={save}
              />
            </label>
          </div>
        )}
        {styleTools}
      </div>
    )
  }

  if (block.blockType === 'video') {
    return (
      <div className={styles.previewMediaEditor}>
        <div className={styles.previewMedia}>{getSettingString(settings, 'mediaUrl') || block.content || 'Video'}</div>
        {selected && (
          <div className={styles.inlineControls}>
            <input value={getSettingString(settings, 'mediaUrl')} placeholder="URL de video" onChange={(event) => patchSettings({ mediaUrl: event.target.value })} onBlur={save} />
          </div>
        )}
        {styleTools}
      </div>
    )
  }

  if (block.blockType === 'button') {
    return (
      <div className={styles.previewButtonEditor}>
        <input
          className={styles.previewButton}
          value={getSettingString(settings, 'buttonText') || block.content || ''}
          placeholder="Boton"
          disabled={!editable}
          onChange={(event) => patchSettings({ buttonText: event.target.value })}
          onBlur={save}
        />
        {selected && <InlineButtonRouting settings={settings} pages={pages} activePageId={activePageId} onPatchSettings={patchSettings} onSave={save} />}
        {styleTools}
      </div>
    )
  }

  if (['benefits', 'testimonials', 'services', 'faq'].includes(block.blockType)) {
    const items = Array.isArray(settings.items) ? settings.items : []
    return (
      <section className={styles.previewList}>
        <textarea
          className={`${styles.previewListTitle} ${styles.inlineTextArea}`}
          rows={1}
          value={block.content}
          placeholder={block.label || 'Titulo de seccion'}
          disabled={!editable}
          onChange={(event) => patchBlock({ content: event.target.value })}
          onBlur={save}
        />
        <div>
          {items.slice(0, 3).map((item, index) => {
            const record = item && typeof item === 'object' ? item as Record<string, unknown> : { title: item }
            return (
              <article key={index}>
                <strong>{String(record.title || `Elemento ${index + 1}`)}</strong>
                {record.text && <p>{String(record.text)}</p>}
              </article>
            )
          })}
        </div>
        {selected && (
          <div className={styles.inlineControls} onClick={(event) => event.stopPropagation()}>
            <label>
              <span>Items</span>
              <textarea
                rows={5}
                value={stringifyItems(settings)}
                placeholder="Titulo | texto | autor"
                onChange={(event) => patchSettings({ items: parseItems(event.target.value) })}
                onBlur={save}
              />
            </label>
          </div>
        )}
        {styleTools}
      </section>
    )
  }

  if (block.blockType === 'form_embed') {
    const formSiteId = getSettingString(settings, 'formSiteId')
    const form = forms.find(item => item.id === formSiteId)
    const embeddedBlocks = Array.isArray(settings.embeddedBlocks) ? settings.embeddedBlocks as SiteBlock[] : []
    return (
      <section className={styles.previewEmbeddedForm}>
        <textarea
          className={`${styles.previewListTitle} ${styles.inlineTextArea}`}
          rows={1}
          value={block.content}
          placeholder="Formulario"
          disabled={!editable}
          onChange={(event) => patchBlock({ content: event.target.value })}
          onBlur={save}
        />
        <textarea
          className={`${styles.previewSubheading} ${styles.inlineTextArea}`}
          rows={2}
          value={form ? `Usando: ${form.name}` : getSettingString(settings, 'description') || ''}
          placeholder="Descripcion del formulario"
          disabled={!editable || Boolean(form)}
          onChange={(event) => patchSettings({ description: event.target.value })}
          onBlur={save}
        />
        {(embeddedBlocks.length ? embeddedBlocks : [{ id: 'placeholder', blockType: 'short_text', label: 'Campo', required: true } as SiteBlock]).slice(0, 3).map(field => (
          <div key={field.id} className={styles.previewField}>
            <label>{field.label}{field.required ? ' *' : ''}</label>
            <input disabled placeholder={field.placeholder || 'Respuesta'} />
          </div>
        ))}
        {selected && (
          <div className={styles.inlineControls} onClick={(event) => event.stopPropagation()}>
            <label>
              <span>Formulario existente</span>
              <select value={formSiteId} onChange={(event) => patchSettings({ formSiteId: event.target.value, embeddedBlocks: undefined })} onBlur={save}>
                <option value="">Formulario inline dentro de esta landing</option>
                {forms.map(formOption => (
                  <option key={formOption.id} value={formOption.id}>{formOption.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Al terminar</span>
              <select value={getFormCompletionAction(settings)} onChange={(event) => patchSettings({ completionAction: event.target.value })} onBlur={save}>
                <option value="next_page">Ir a la siguiente pagina al terminar</option>
                <option value="next_page_if_qualified">Ir a la siguiente pagina solo si califica</option>
                <option value="form_default">Mantener configuracion actual del formulario</option>
              </select>
            </label>
            <button
              type="button"
              className={styles.inlineMiniButton}
              onClick={() => {
                patchSettings({ formSiteId: '', embeddedBlocks: createEmbeddedBlocks(block.siteId) })
                window.setTimeout(save, 0)
              }}
            >
              <Plus size={14} />
              Crear formulario inline
            </button>
          </div>
        )}
        {styleTools}
      </section>
    )
  }

  if (block.blockType === 'cta') {
    return (
      <section className={styles.previewCta}>
        <textarea
          className={`${styles.previewListTitle} ${styles.inlineTextArea}`}
          rows={1}
          value={block.content}
          placeholder={block.label || 'CTA final'}
          disabled={!editable}
          onChange={(event) => patchBlock({ content: event.target.value })}
          onBlur={save}
        />
        <textarea
          className={`${styles.previewSubheading} ${styles.inlineTextArea}`}
          rows={2}
          value={getSettingString(settings, 'subtitle')}
          placeholder="Subtitulo"
          disabled={!editable}
          onChange={(event) => patchSettings({ subtitle: event.target.value })}
          onBlur={save}
        />
        <input
          className={styles.previewButton}
          value={getSettingString(settings, 'buttonText')}
          placeholder="Texto del boton"
          disabled={!editable}
          onChange={(event) => patchSettings({ buttonText: event.target.value })}
          onBlur={save}
        />
        {selected && pages.length > 0 && (
          <InlineButtonRouting settings={settings} pages={pages} activePageId={activePageId} onPatchSettings={patchSettings} onSave={save} />
        )}
        {styleTools}
      </section>
    )
  }

  if (block.blockType === 'calendar_embed') {
    const calendarId = getSettingString(settings, 'calendarId')
    const calendarName = getSettingString(settings, 'calendarName')
    const calendar = calendars.find(item => item.id === calendarId)
    return (
      <div className={styles.previewEmbed}>
        <div className={styles.previewEmbedEmpty}>
          <CalendarDays size={18} />
          <span>{calendar?.name || calendarName || 'Selecciona un calendario'}</span>
        </div>
        {selected && (
          <div className={styles.inlineControls} onClick={(event) => event.stopPropagation()}>
            <label>
              <span>Calendario</span>
              <select
                value={calendarId}
                onChange={(event) => {
                  const next = calendars.find(item => item.id === event.target.value)
                  patchSettings({
                    calendarId: next?.id || '',
                    calendarSlug: next?.slug || next?.widgetSlug || '',
                    calendarName: next?.name || ''
                  })
                }}
                onBlur={save}
              >
                <option value="">Selecciona un calendario</option>
                {calendars.map(calendarOption => (
                  <option key={calendarOption.id} value={calendarOption.id}>{calendarOption.name}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        {styleTools}
      </div>
    )
  }

  if (block.blockType === 'embed') {
    return (
      <div className={styles.previewEmbedEditor}>
        <EmbedPreview rawCode={block.content} />
        {selected && (
          <div className={styles.inlineControls} onClick={(event) => event.stopPropagation()}>
            <label>
              <span>Embed / URL</span>
              <textarea rows={4} value={block.content} onChange={(event) => patchBlock({ content: event.target.value })} onBlur={save} />
            </label>
          </div>
        )}
        {styleTools}
      </div>
    )
  }

  return (
    <FieldPreview
      block={block}
      blocks={blocks}
      selected={selected}
      editable={editable}
      onPatchBlock={patchBlock}
      onPatchSettings={patchSettings}
      onSave={save}
      styleTools={styleTools}
    />
  )
}

const EmbedPreview: React.FC<{ rawCode: string }> = ({ rawCode }) => {
  const embed = resolveEmbedPreview(rawCode)

  if (embed.kind === 'empty') {
    return (
      <div className={`${styles.previewEmbed} ${styles.previewEmbedEmpty}`}>
        Pega una URL, iframe o codigo embed/html
      </div>
    )
  }

  const frameStyle = {
    height: `${embed.height || EMBED_DEFAULT_HEIGHT}px`
  } as React.CSSProperties

  return (
    <div className={styles.previewEmbed}>
      <iframe
        className={styles.previewEmbedFrame}
        title={embed.title}
        src={embed.kind === 'url' ? embed.src : undefined}
        srcDoc={embed.kind === 'html' ? embed.srcDoc : undefined}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        sandbox={embed.kind === 'url' ? EMBED_SANDBOX_URL : EMBED_SANDBOX_HTML}
        allow={embed.kind === 'url' ? embed.allow || DEFAULT_EMBED_ALLOW : DEFAULT_EMBED_ALLOW}
        allowFullScreen
        style={frameStyle}
      />
    </div>
  )
}

const FieldPreview: React.FC<{
  block: SiteBlock
  blocks: SiteBlock[]
  selected: boolean
  editable: boolean
  onPatchBlock: (patch: Partial<SiteBlock>) => void
  onPatchSettings: (patch: Record<string, unknown>) => void
  onSave: () => void
  styleTools: React.ReactNode
}> = ({ block, blocks, selected, editable, onPatchBlock, onPatchSettings, onSave, styleTools }) => {
  const settings = block.settings || {}

  return (
    <div className={styles.previewField}>
      <input
        className={styles.inlineFieldLabel}
        value={block.label}
        disabled={!editable}
        onChange={(event) => onPatchBlock({ label: event.target.value })}
        onBlur={onSave}
      />
      <textarea
        className={styles.inlineFieldHelp}
        rows={2}
        value={block.content}
        placeholder="Texto de ayuda"
        disabled={!editable}
        onChange={(event) => onPatchBlock({ content: event.target.value })}
        onBlur={onSave}
      />
      {block.blockType === 'paragraph' ? (
        <textarea rows={3} placeholder={block.placeholder || 'Respuesta'} disabled />
      ) : isChoiceBlock(block.blockType) ? (
        <div className={styles.previewOptions}>
          {getOptions(block).map(option => <span key={option.id || option.label}>{option.label}</span>)}
        </div>
      ) : (
        <input
          type={block.blockType === 'email' ? 'email' : block.blockType === 'phone' ? 'tel' : block.blockType === 'date' ? 'date' : 'text'}
          placeholder={block.placeholder || 'Respuesta'}
          disabled
        />
      )}
      {selected && editable && (
        <div className={styles.inlineControls} onClick={(event) => event.stopPropagation()}>
          <label>
            <span>Placeholder</span>
            <input value={block.placeholder} onChange={(event) => onPatchBlock({ placeholder: event.target.value })} onBlur={onSave} />
          </label>
          <label>
            <span>Nombre interno</span>
            <input value={getSettingString(settings, 'internalName')} onChange={(event) => onPatchSettings({ internalName: event.target.value })} onBlur={onSave} />
          </label>
          <label>
            <span>Validacion</span>
            <select value={getSettingString(settings, 'validation')} onChange={(event) => onPatchSettings({ validation: event.target.value })} onBlur={onSave}>
              <option value="">Ninguna</option>
              <option value="email">Email</option>
              <option value="phone">Telefono</option>
              <option value="number">Numero</option>
              <option value="currency">Moneda</option>
              <option value="date">Fecha</option>
            </select>
          </label>
          <label className={styles.inlineCheck}>
            <input
              type="checkbox"
              checked={block.required}
              onChange={(event) => {
                onPatchBlock({ required: event.target.checked })
                window.setTimeout(onSave, 0)
              }}
            />
            <span>Requerido</span>
          </label>
          {isChoiceBlock(block.blockType) && (
            <OptionsRulesEditor block={block} blocks={blocks} onPatchBlock={onPatchBlock} onSave={onSave} />
          )}
        </div>
      )}
      {styleTools}
    </div>
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
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSaveSite: () => void
}> = ({ site, pages, activePageId, showSocialProfile, onPatchTheme, onSaveSite }) => {
  const theme = site.theme || {}
  const currentId = resolveTemplateId(site)
  const platform = platformChromeFor(currentId)
  const hasNextPage = isLanding(site) && pages.length > 1 && pages.some(page => page.sortOrder > (pages.find(item => item.id === activePageId)?.sortOrder || 0))

  return (
    <aside className={styles.propertiesPanel}>
      <div className={styles.panelHeader}>
        <strong>{platform && showSocialProfile ? 'Social Media Profile' : 'Pagina'}</strong>
        <span>{isLanding(site) ? 'Landing' : 'Formulario'}</span>
      </div>
      <div className={styles.propertiesBody}>
        <div className={styles.settingsGroup}>
          <div className={styles.twoColumn}>
            <label className={styles.field}>
              <span>Fondo de pagina</span>
              <input type="color" value={userBgColor(site) || getThemeHex(theme, 'backgroundColor', '#ffffff')} onChange={(event) => onPatchTheme({ backgroundColor: event.target.value })} onBlur={onSaveSite} />
            </label>
            <label className={styles.field}>
              <span>Acento</span>
              <input type="color" value={userAccentColor(site) || getThemeHex(theme, 'accentColor', '#111827')} onChange={(event) => onPatchTheme({ accentColor: event.target.value })} onBlur={onSaveSite} />
            </label>
          </div>
          <div className={styles.twoColumn}>
            <label className={styles.field}>
              <span>Padding pagina</span>
              <input type="range" min="0" max="80" value={getThemeNumber(theme, 'pagePadding', isLanding(site) ? 18 : 22, 0, 80)} onChange={(event) => onPatchTheme({ pagePadding: Number(event.target.value) })} onBlur={onSaveSite} />
            </label>
            <label className={styles.field}>
              <span>Ancho maximo</span>
              <input type="range" min="360" max="1440" value={getThemeNumber(theme, 'pageMaxWidth', isLanding(site) ? 1160 : 520, 360, 1440)} onChange={(event) => onPatchTheme({ pageMaxWidth: Number(event.target.value) })} onBlur={onSaveSite} />
            </label>
          </div>
          <div className={styles.twoColumn}>
            <label className={styles.field}>
              <span>Borde pagina</span>
              <input type="color" value={getThemeHex(theme, 'pageBorderColor', '#111827')} onChange={(event) => onPatchTheme({ pageBorderColor: event.target.value })} onBlur={onSaveSite} />
            </label>
            <label className={styles.field}>
              <span>Radio pagina</span>
              <input type="range" min="0" max="40" value={getThemeNumber(theme, 'pageRadius', isLanding(site) ? 0 : 24, 0, 40)} onChange={(event) => onPatchTheme({ pageRadius: Number(event.target.value) })} onBlur={onSaveSite} />
            </label>
          </div>
          {hasNextPage && site.metaCapiEnabled && (
            <label className={styles.field}>
              <span>Meta Pixel + CAPI sucede en</span>
              <select value={theme.metaConversionTarget || 'same_page'} onChange={(event) => onPatchTheme({ metaConversionTarget: event.target.value as SiteTheme['metaConversionTarget'] })} onBlur={onSaveSite}>
                <option value="same_page">Esta pagina</option>
                <option value="next_page">Pagina siguiente</option>
              </select>
            </label>
          )}
          {isFormSite(site) && (
            <label className={styles.field}>
              <span>Texto del boton de envio</span>
              <input value={theme.submitText || ''} placeholder="Enviar" onChange={(event) => onPatchTheme({ submitText: event.target.value })} onBlur={onSaveSite} />
            </label>
          )}
        </div>

        {platform && showSocialProfile && (
          <div className={styles.settingsGroup}>
            <div className={styles.panelSubheader}>Social Media Profile</div>
            <label className={styles.field}>
              <span>Red social</span>
              <select value={platform} onChange={(event) => onPatchTheme({ template: event.target.value as SiteTemplateId })} onBlur={onSaveSite}>
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
                <option value="tiktok">TikTok</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Nombre de pagina</span>
              <input value={theme.brandName || ''} placeholder={site.title || site.name} onChange={(event) => onPatchTheme({ brandName: event.target.value })} onBlur={onSaveSite} />
            </label>
            <label className={styles.field}>
              <span>Subtitulo</span>
              <input value={theme.brandSubtitle || ''} placeholder={platform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado'} onChange={(event) => onPatchTheme({ brandSubtitle: event.target.value })} onBlur={onSaveSite} />
            </label>
            <label className={styles.field}>
              <span>Avatar URL</span>
              <input value={theme.brandAvatar || ''} placeholder="https://..." onChange={(event) => onPatchTheme({ brandAvatar: event.target.value })} onBlur={onSaveSite} />
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
  onPatchTheme,
  onSaveSite,
  onPatchBlock,
  onPatchSettings,
  onPatchCategorySettings,
  onSaveCategory,
  onSave
}) => {
  if (!block) {
    return <PageInspector site={site} pages={pages} activePageId={activePageId} showSocialProfile={showSocialProfile} onPatchTheme={onPatchTheme} onSaveSite={onSaveSite} />
  }

  const isField = fieldBlockTypes.has(block.blockType)
  const settings = block.settings || {}
  const contentLabel = isField
    ? 'Texto de ayuda'
    : block.blockType === 'embed'
      ? 'Codigo embed, iframe o URL'
      : 'Contenido'
  const contentRows = block.blockType === 'embed' ? 7 : isField ? 2 : 3

  return (
    <aside className={styles.propertiesPanel}>
      <div className={styles.panelHeader}>
        <strong>Propiedades</strong>
        <span>{blockLabels[block.blockType]}</span>
      </div>

      <div className={styles.propertiesBody}>
        <label className={styles.field}>
          <span>{isField ? 'Label / pregunta' : 'Nombre del bloque'}</span>
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

        <InlineBlockStyleControls
          block={block}
          onPatchSettings={(patch) => onPatchCategorySettings(block, patch)}
          onSave={() => onSaveCategory(block)}
        />

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
            <option value="">Formulario inline dentro de esta landing</option>
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
        <h2>Respuestas / Leads</h2>
        <p>Submissions recibidos desde landings y formularios publicos.</p>
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
          <p>Conecta un solo dominio general para enrutar todos los formularios, sitios y landing pages.</p>
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
