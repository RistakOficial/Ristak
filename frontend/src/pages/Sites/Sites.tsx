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
  AlertTriangle,
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bold,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
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
  Italic,
  LayoutTemplate,
  Link2,
  ListChecks,
  Maximize2,
  Mic,
  Monitor,
  MoreVertical,
  Music2,
  MousePointerClick,
  PanelBottom,
  PanelTop,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  Sparkles,
  Smartphone,
  Trash2,
  Type,
  Underline,
  Unlink2,
  Upload,
  Video,
  X
} from 'lucide-react'
import {
  Button,
  Loading,
  NumberInput,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useAIAgentAvailability } from '@/hooks'
import {
  blockLabels,
  fieldBlockTypes,
  formBlockTypes,
  type ImportedButtonAction,
  type ImportedEditableContentType,
  type ImportedSiteCreateResult,
  type ImportedSiteFieldMapping,
  type ImportedSiteFormMapping,
  type ImportedSiteImport,
  landingBlockTypes,
  siteTemplates,
  sitesService,
  type PublicSite,
  type SitesAICreationKind,
  type SitesAICreationMessage,
  type SitesDomainConfig,
  type SiteBlock,
  type SiteBlockOption,
  type SiteBlockType,
  type SiteMetaTrigger,
  type SiteOptionAction,
  type SitePage,
  type SiteSubmission,
  type SiteTemplateMeta,
  type SiteTemplateId,
  type SiteTheme,
  type SiteType
} from '@/services/sitesService'
import { aiAgentService } from '@/services/aiAgentService'
import { campaignsService, type ConnectedSocialProfile } from '@/services/campaignsService'
import { calendarsService, type Calendar as CalendarType } from '@/services/calendarsService'
import { customFieldsService, type CustomFieldDefinition } from '@/services/customFieldsService'
import { COUNTRY_OPTIONS, getCountryDefaults, getCountryFlagEmoji, getDetectedAccountLocaleDefaults } from '@/utils/accountLocale'
import styles from './Sites.module.css'
import './sitesCanvas.css'
import { buildCanvasTheme } from './sitesCanvasTheme'

type SitesSection = 'landings' | 'forms' | 'leads' | 'domains'
type DeviceMode = 'desktop' | 'mobile'
type CreateFlow =
  | 'closed'
  | 'landing-start'
  | 'landing-template'
  | 'form-kind'
  | 'form-start'
  | 'form-template'
  | 'interactive-start'
  | 'interactive-template'

interface LeadRow extends SiteSubmission {
  siteName: string
}

interface ImportReviewState {
  site: PublicSite
  importData: ImportedSiteImport
}

type SitesAICreationModalState = {
  siteKind: SitesAICreationKind
  editSite?: PublicSite | null
} | null

type SitesAICreationModalSubmit = {
  siteKind: SitesAICreationKind
  prompt: string
  attachmentNotes: string[]
  editSite?: PublicSite | null
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
  { value: 'continue', label: 'Continuar' },
  { value: 'jump', label: 'Saltar a otra pregunta' },
  { value: 'disqualify', label: 'Descalificar inmediatamente' },
  { value: 'disqualify_after_submit', label: 'Descalificar al finalizar formulario' },
  { value: 'redirect', label: 'Dirigir a sitio' }
]
const visibleRuleActionValues = new Set<SiteOptionAction>(ruleActions.map(action => action.value))
const normalizeVisibleRuleAction = (action?: SiteOptionAction): SiteOptionAction => (
  action && visibleRuleActionValues.has(action) ? action : 'continue'
)

const SITES_AI_DRAFT_CREATED_EVENT = 'ristak-sites-ai-draft-created'
const SITES_EDITOR_ACTIVE_EVENT = 'ristak-sites-editor-active'
const DEFAULT_FUNNEL_PAGE_ID = 'page-1'
const FORM_THANK_YOU_PAGE_ID = 'page-2'
const FORM_DISQUALIFIED_PAGE_ID = 'page-3'
const FORM_FINAL_PAGE_IDS = new Set([FORM_THANK_YOU_PAGE_ID, FORM_DISQUALIFIED_PAGE_ID])
const PREVIEW_LOADING_HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Previsualizando...</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f7f9fc;
        color: #162033;
      }

      * {
        box-sizing: border-box;
      }

      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(38, 99, 235, 0.11), transparent 34rem),
          linear-gradient(180deg, #ffffff 0%, #f3f6fb 100%);
      }

      main {
        width: min(92vw, 34rem);
        display: grid;
        justify-items: center;
        gap: 1.35rem;
        padding: 2rem;
        text-align: center;
      }

      .preview-wheel {
        position: relative;
        width: clamp(4.5rem, 18vw, 6rem);
        aspect-ratio: 1;
        border-radius: 50%;
        background: conic-gradient(from 0deg, #2563eb, #16a34a, #f59e0b, #ef4444, #7c3aed, #2563eb);
        box-shadow: 0 1.35rem 3rem rgba(37, 99, 235, 0.18);
        animation: preview-spin 1.05s linear infinite;
      }

      .preview-wheel::before {
        content: "";
        position: absolute;
        inset: 0.55rem;
        border-radius: inherit;
        background: #f7f9fc;
        box-shadow: inset 0 0 0 1px rgba(22, 32, 51, 0.08);
      }

      .preview-wheel::after {
        content: "";
        position: absolute;
        top: 0.28rem;
        left: 50%;
        width: 0.85rem;
        aspect-ratio: 1;
        border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 0.35rem 0.9rem rgba(22, 32, 51, 0.16);
        transform: translateX(-50%);
      }

      h1 {
        margin: 0;
        font-size: clamp(1.45rem, 5vw, 2rem);
        font-weight: 750;
        line-height: 1.12;
        letter-spacing: 0;
      }

      p {
        max-width: 25rem;
        margin: 0.55rem auto 0;
        color: #596579;
        font-size: 1rem;
        line-height: 1.55;
      }

      @keyframes preview-spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .preview-wheel {
          animation: none;
        }
      }
    </style>
  </head>
  <body>
    <main aria-live="polite" aria-busy="true">
      <div class="preview-wheel" role="img" aria-label="Cargando"></div>
      <section>
        <h1>Cargando previsualizacion</h1>
        <p>Estamos preparando tu pagina para verla completa.</p>
      </section>
    </main>
  </body>
</html>`

const writePreviewLoadingPage = (previewWindow: Window) => {
  previewWindow.document.open()
  previewWindow.document.write(PREVIEW_LOADING_HTML)
  previewWindow.document.close()
}

const PAGE_SELECTED_ID = '__page__'
const isEditorSurfaceSelection = (id: string) => id === PAGE_SELECTED_ID
const LANDING_DEFAULT_PAGE_PADDING = 36
const HEADER_PANEL_BLOCK_TYPE: SiteBlockType = 'header_panel'
const FOOTER_PANEL_BLOCK_TYPE: SiteBlockType = 'footer_panel'
const PANEL_BLOCK_TYPES = new Set<SiteBlockType>([HEADER_PANEL_BLOCK_TYPE, FOOTER_PANEL_BLOCK_TYPE])
const SPACING_OVERLAP_MIN = -80
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
const isImportedHtmlSite = (site?: PublicSite | null) =>
  Boolean(site?.theme?.importedHtml || site?.theme?.template === 'imported_html')
const getAIAgentSiteKindForSite = (site: PublicSite): SitesAICreationKind => {
  if (site.siteType === 'interactive_form') return 'interactive_form'
  if (site.siteType === 'standard_form') return 'form'
  return 'landing'
}
const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result || ''))
  reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo'))
  reader.readAsDataURL(file)
})
const DEFAULT_BUTTON_SETTINGS = {
  buttonAlign: 'center',
  buttonRadius: 28,
  buttonHeight: 54,
  buttonPaddingX: 28
}
const GOOGLE_FONT_OPTIONS = [
  { label: 'Sistema', value: '' },
  { label: 'Inter', value: "'Inter', system-ui, sans-serif" },
  { label: 'Inter Tight', value: "'Inter Tight', 'Inter', system-ui, sans-serif" },
  { label: 'Roboto', value: "'Roboto', Arial, sans-serif" },
  { label: 'Open Sans', value: "'Open Sans', Arial, sans-serif" },
  { label: 'Lato', value: "'Lato', Arial, sans-serif" },
  { label: 'Montserrat', value: "'Montserrat', Arial, sans-serif" },
  { label: 'Poppins', value: "'Poppins', Arial, sans-serif" },
  { label: 'Oswald', value: "'Oswald', Arial, sans-serif" },
  { label: 'Raleway', value: "'Raleway', Arial, sans-serif" },
  { label: 'Nunito', value: "'Nunito', Arial, sans-serif" },
  { label: 'Work Sans', value: "'Work Sans', Arial, sans-serif" },
  { label: 'Manrope', value: "'Manrope', Arial, sans-serif" },
  { label: 'Barlow', value: "'Barlow', Arial, sans-serif" },
  { label: 'Archivo', value: "'Archivo', Arial, sans-serif" },
  { label: 'Bebas Neue', value: "'Bebas Neue', Impact, sans-serif" },
  { label: 'Playfair Display', value: "'Playfair Display', Georgia, serif" },
  { label: 'Merriweather', value: "'Merriweather', Georgia, serif" },
  { label: 'Libre Baskerville', value: "'Libre Baskerville', Georgia, serif" },
  { label: 'Georgia', value: "Georgia, 'Times New Roman', serif" }
]
const SECTION_BLOCK_TYPE: SiteBlockType = 'section'
const DEFAULT_SECTION_GAP = 24
const isTopLevelLandingBlockType = (blockType?: SiteBlockType) =>
  blockType === SECTION_BLOCK_TYPE || Boolean(blockType && PANEL_BLOCK_TYPES.has(blockType))
const hasDataTransferType = (dataTransfer: DataTransfer, type: string) =>
  Array.from(dataTransfer.types || []).includes(type)
const MAX_SITES_EDITOR_HISTORY = 40
const isNativeUndoTarget = (target: EventTarget | null) => {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"], [data-rstk-edit]'))
}

type PaletteDragPayload = {
  blockType: SiteBlockType
  initialSettings?: Record<string, unknown>
}

type PaletteSectionTarget = {
  sectionId: string
  sectionColumn: number
}

type PaletteDragPosition = {
  x: number
  y: number
}

type BlockMoveDirection = 'up' | 'down'
type BlockMoveState = {
  canMoveUp: boolean
  canMoveDown: boolean
}

type EditorHistoryEntry = {
  action: 'reorder' | 'delete'
  siteId: string
  pageId?: string
  selectedBefore: string
  selectedAfter: string
  beforeBlockIds: string[]
  afterBlockIds: string[]
  deletedRootBlockId?: string
  deletedBlocks?: SiteBlock[]
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

type LandingBlockOrderGroup = {
  id: string
  sortOrder: number
  blocks: SiteBlock[]
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
  social_profile: <Instagram size={15} />,
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

const nativeBorderBlockTypes = new Set<SiteBlockType>(['hero', 'section', 'cta', 'benefits', 'testimonials', 'services', 'faq', 'form_embed', 'social_profile', 'image', 'video', 'embed', 'calendar_embed'])

const isLanding = (site?: PublicSite | null) => site?.siteType === 'landing_page'
const isStandardForm = (site?: PublicSite | null) => site?.siteType === 'standard_form'
const isInteractiveForm = (site?: PublicSite | null) => site?.siteType === 'interactive_form'
const isFormSite = (site?: PublicSite | null) => site?.siteType === 'standard_form' || site?.siteType === 'interactive_form'
const hasEditablePages = (site?: PublicSite | null) => isLanding(site) || isInteractiveForm(site) || isStandardForm(site)
const canManagePages = (site?: PublicSite | null) => hasEditablePages(site)
const isFormFinalPageId = (pageId?: string) => Boolean(pageId && FORM_FINAL_PAGE_IDS.has(pageId))
const isFormFinalPage = (page?: SitePage | null) => isFormFinalPageId(page?.id)

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

const isPublicSiteLive = (site: PublicSite, domainConfig: SitesDomainConfig) =>
  site.status === 'published' && Boolean(domainConfig.domain && domainConfig.renderDomainVerified)

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

const buildLivePublicUrl = (site: PublicSite, domainConfig: SitesDomainConfig) =>
  domainConfig.domain ? `https://${domainConfig.domain}${getRoutePath(site)}` : ''

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

const makeTemplateFunnelPage = (id: string, title: string, sortOrder: number): SitePage => ({
  id,
  title,
  sortOrder,
  metaCapiEnabled: false,
  metaEventName: 'none',
  metaTrigger: 'page_view'
})

const getTemplateFunnelPages = (id: SiteTemplateId): SitePage[] => {
  if (id === 'launch') {
    return [
      makeTemplateFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Registro', 0),
      makeTemplateFunnelPage('page-2', 'Detalles', 1),
      makeTemplateFunnelPage('page-3', 'Gracias', 2)
    ]
  }

  if (id === 'local') {
    return [
      makeTemplateFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Oferta local', 0),
      makeTemplateFunnelPage('page-2', 'Contacto', 1),
      makeTemplateFunnelPage('page-3', 'Gracias', 2)
    ]
  }

  if (id === 'facebook' || id === 'instagram' || id === 'tiktok') {
    return [
      makeTemplateFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Anuncio', 0),
      makeTemplateFunnelPage('page-2', 'Gracias', 1)
    ]
  }

  if (id === 'executive') {
    return [
      makeTemplateFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Diagnostico', 0),
      makeTemplateFunnelPage('page-2', 'Agenda', 1),
      makeTemplateFunnelPage('page-3', 'Gracias', 2)
    ]
  }

  if (id === 'vsl') {
    return [
      makeTemplateFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Carta de ventas', 0),
      makeTemplateFunnelPage('page-2', 'Agenda', 1),
      makeTemplateFunnelPage('page-3', 'Gracias', 2)
    ]
  }

  if (id === 'premium') {
    return [
      makeTemplateFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Presentacion', 0),
      makeTemplateFunnelPage('page-2', 'Agenda privada', 1),
      makeTemplateFunnelPage('page-3', 'Gracias', 2)
    ]
  }

  return [
    makeTemplateFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Opt-in', 0),
    makeTemplateFunnelPage('page-2', 'Agenda', 1),
    makeTemplateFunnelPage('page-3', 'Gracias', 2)
  ]
}

const getDefaultFormPages = (): SitePage[] => [
  makeTemplateFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Formulario', 0),
  makeTemplateFunnelPage(FORM_THANK_YOU_PAGE_ID, 'Agradecimiento', 1),
  makeTemplateFunnelPage(FORM_DISQUALIFIED_PAGE_ID, 'Descalificacion', 2)
]

const resolveTemplateId = (site?: PublicSite | null): SiteTemplateId => {
  const explicit = site?.theme?.template
  if (explicit && templateMetaById(explicit)) return explicit
  if (site?.siteType === 'interactive_form') return 'interactive'
  if (site?.siteType === 'landing_page') return 'ristak'
  return 'ristak'
}

const isDarkTemplate = (id: SiteTemplateId) => id === 'tiktok' || id === 'vsl' || id === 'interactive' || id === 'premium'

const isHex6 = (value?: string) => !!value && /^#[0-9a-f]{6}$/i.test(value)

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

const splitCssArgs = (value: string) => {
  const parts: string[] = []
  let current = ''
  let depth = 0

  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }

  if (current.trim()) parts.push(current.trim())
  return parts
}

const extractCssColor = (value: string, fallback = '#111827') => {
  const raw = String(value || '').trim()
  const match = raw.match(/(#[0-9a-f]{6}|rgba?\([^)]*\)|transparent)/i)
  return match ? normalizeCssColor(match[1], fallback) : fallback
}

const paintFallbackColor = (paint: string, fallback = '#111827') =>
  isCssGradient(paint) ? extractCssColor(paint, fallback) : normalizeCssColor(paint, fallback)

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
  if (typeof v !== 'string' || !isCssPaint(v)) return null
  const paint = normalizeCssPaint(v, '#ffffff')
  const color = paintFallbackColor(paint, '#ffffff')
  return color.toLowerCase() !== '#ffffff' ? color : null
}
const userAccentColor = (site: PublicSite): string | null => {
  const v = site.theme?.accentColor
  if (typeof v !== 'string' || !isCssPaint(v)) return null
  const paint = normalizeCssPaint(v, '#111827')
  const color = paintFallbackColor(paint, '#111827')
  return color.toLowerCase() !== '#111827' ? color : null
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

const platformChromeFor = (id: SiteTemplateId): SocialPlatform | null => {
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
  if (section === 'forms') return 'form-start'
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
      subtitle: 'Elige como quieres que la persona responda tu formulario.'
    }
  }

  if (step === 'form-start') {
    return {
      title: 'Nuevo formulario',
      subtitle: 'Elige si quieres empezar en blanco, con plantilla o con IA.'
    }
  }

  if (step === 'form-template') {
    return {
      title: 'Nuevo formulario',
      subtitle: 'Elige el estilo de tu formulario'
    }
  }

  if (step === 'interactive-start') {
    return {
      title: 'Formulario interactivo multipagina',
      subtitle: 'Ahora elige si quieres empezar en blanco, con plantilla o con IA.'
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
  if (step === 'form-start') return 'closed'
  if (step === 'interactive-start') return 'form-start'
  if (step === 'form-template') return 'form-start'
  if (step === 'interactive-template') return 'interactive-start'
  return 'closed'
}

const getEmptyEditorMessage = (section: SitesSection) => {
  if (section === 'landings') return 'Crea un sitio embudo para entrar al editor visual.'
  if (section === 'forms') return 'Crea un formulario para entrar al editor visual.'
  return 'Crea un sitio embudo o formulario para entrar al editor visual.'
}

const getLibraryPreviewBlocks = (site: PublicSite) => {
  const blocks = [...(site.blocks || [])].sort((a, b) => a.sortOrder - b.sortOrder)
  if (!hasEditablePages(site)) return blocks.slice(0, 4)

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

const isPhoneCountrySelectorEnabled = (block: SiteBlock) => {
  const settings = block.settings || {}
  return settings.phoneCountrySelectorEnabled !== false &&
    settings.countrySelectorEnabled !== false &&
    settings.phoneCountrySelector !== false
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
type SocialPlatform = 'facebook' | 'instagram' | 'tiktok' | 'threads'
type FormChoiceStyle = NonNullable<SiteTheme['formChoiceStyle']>
type FormSelectStyle = NonNullable<SiteTheme['formSelectStyle']>

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

const formChoiceStyleOptions: Array<{ value: FormChoiceStyle; label: string }> = [
  { value: 'native', label: 'Clasico con circulo' },
  { value: 'cards', label: 'Fila seleccionada' },
  { value: 'pills', label: 'Pildoras' },
  { value: 'minimal', label: 'Linea simple' }
]

const formSelectStyleOptions: Array<{ value: FormSelectStyle; label: string }> = [
  { value: 'classic', label: 'Clasico' },
  { value: 'filled', label: 'Relleno moderno' },
  { value: 'underline', label: 'Linea inferior' }
]

const socialPlatformOptions: Array<{ value: SocialPlatform; label: string }> = [
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'threads', label: 'Threads' }
]

const normalizeFormChoiceStyle = (value: unknown): FormChoiceStyle => {
  const raw = String(value || '').trim()
  return formChoiceStyleOptions.some(option => option.value === raw) ? raw as FormChoiceStyle : 'native'
}

const normalizeFormSelectStyle = (value: unknown): FormSelectStyle => {
  const raw = String(value || '').trim()
  return formSelectStyleOptions.some(option => option.value === raw) ? raw as FormSelectStyle : 'classic'
}

const normalizeSocialPlatform = (value: unknown): SocialPlatform => {
  const raw = String(value || '').trim()
  return socialPlatformOptions.some(option => option.value === raw) ? raw as SocialPlatform : 'facebook'
}

const socialProfileOptionLabel = (profile: ConnectedSocialProfile) => {
  const platform = socialPlatformOptions.find(option => option.value === profile.platform)?.label || profile.platform
  const followers = profile.followersLabel ? ` - ${profile.followersLabel} seguidores` : ''
  const owner = profile.pageName && profile.pageName !== profile.name ? ` (${profile.pageName})` : ''
  return `${platform}: ${profile.name}${owner}${followers}`
}

const connectedSocialProfileBlockPatch = (profile: ConnectedSocialProfile): Record<string, unknown> => ({
  platform: profile.platform,
  brandName: profile.name,
  brandSubtitle: profile.platform === 'instagram'
    ? 'Perfil de Instagram conectado'
    : profile.platform === 'facebook'
      ? 'Pagina de Facebook conectada'
      : 'Perfil conectado',
  brandAvatar: profile.avatarUrl || '',
  followers: profile.followersLabel || '',
  brandVerified: true,
  socialAutoSync: true,
  socialSourceProfileId: profile.id,
  socialSourcePlatform: profile.platform,
  socialSourceId: profile.sourceId,
  socialSourcePageId: profile.pageId || '',
  socialSourceName: profile.name,
  socialSyncedAt: profile.updatedAt || new Date().toISOString()
})

const socialProfileDefaultsForSite = (site?: PublicSite | null): Record<string, unknown> => {
  const theme = site?.theme || {}
  const templatePlatform = platformChromeFor(resolveTemplateId(site))
  const sourcePlatform = normalizeSocialPlatform(theme.socialSourcePlatform)
  const platform = templatePlatform || sourcePlatform || 'facebook'

  return {
    platform,
    brandName: theme.brandName || getPublicTitleEditorValue(site) || site?.name || 'Tu marca',
    brandSubtitle: theme.brandSubtitle || (platform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado'),
    brandAvatar: theme.brandAvatar || '',
    followers: theme.followers || '',
    brandVerified: theme.brandVerified === undefined ? true : theme.brandVerified !== false,
    socialAutoSync: theme.socialAutoSync,
    socialSourceProfileId: theme.socialSourceProfileId || '',
    socialSourcePlatform: theme.socialSourcePlatform || '',
    socialSourceId: theme.socialSourceId || '',
    socialSourcePageId: theme.socialSourcePageId || '',
    socialSourceName: theme.socialSourceName || '',
    socialSyncedAt: theme.socialSyncedAt || ''
  }
}

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

const textBoldDefaultBlockTypes = new Set<SiteBlockType>([
  'headline',
  'title',
  'hero',
  'section',
  'benefits',
  'testimonials',
  'services',
  'faq',
  'form_embed',
  'cta'
])

const getParentSectionBlock = (block: SiteBlock, blocks: SiteBlock[]) => {
  const sectionId = getBlockSectionId(block)
  if (!sectionId) return null
  return blocks.find(item => item.id === sectionId && isSectionBlock(item)) || null
}

const getPageTextPaint = (site: PublicSite) =>
  getThemePaint(site.theme, 'textColor', isSiteDark(site) ? '#ffffff' : '#111827')

const getBlockTextAlignFallback = (site: PublicSite, block: SiteBlock, blocks: SiteBlock[] = []): HorizontalAlign => {
  const parent = isLanding(site) && !isTopLevelLandingBlock(block) ? getParentSectionBlock(block, blocks) : null
  if (parent) {
    return getHorizontalAlign(parent.settings || {}, 'textAlign', 'center')
  }

  if (block.blockType === HEADER_PANEL_BLOCK_TYPE) return 'left'
  if (block.blockType === FOOTER_PANEL_BLOCK_TYPE) return 'center'
  if (block.blockType === SECTION_BLOCK_TYPE || block.blockType === 'hero' || block.blockType === 'cta') return 'center'
  if (['benefits', 'testimonials', 'services', 'faq'].includes(block.blockType)) return 'center'
  if (!fieldBlockTypes.has(block.blockType) && ['interactive', 'vsl'].includes(resolveTemplateId(site))) return 'center'
  return 'left'
}

const getBlockFontSizeFallback = (site: PublicSite, block: SiteBlock) => {
  if (isLanding(site)) {
    if (block.blockType === 'hero') return 58
    if (block.blockType === 'headline' || block.blockType === 'title') return 52
    if (block.blockType === 'cta') return 42
    if (block.blockType === SECTION_BLOCK_TYPE || ['benefits', 'testimonials', 'services', 'faq', 'form_embed'].includes(block.blockType)) return 32
    if (block.blockType === 'subheading' || block.blockType === 'subtitle' || block.blockType === 'description') return 20
    if (block.blockType === 'text') return 17
  }

  if (block.blockType === 'headline' || block.blockType === 'title') return 38
  if (block.blockType === 'subheading' || block.blockType === 'subtitle' || block.blockType === 'description') return 18
  return 18
}

const getBlockContentMaxWidthFallback = (site: PublicSite, block: SiteBlock) => {
  if (isLanding(site)) {
    if (block.blockType === 'hero') return 16
    if (['benefits', 'testimonials', 'services', 'faq'].includes(block.blockType)) return 20
    if (block.blockType === 'cta') return 52
    if (block.blockType === 'subheading' || block.blockType === 'subtitle') return 60
    if (block.blockType === 'description') return 58
  }

  if (block.blockType === 'subheading' || block.blockType === 'subtitle' || block.blockType === 'description') return 60
  return 66
}

const getBlockRadiusFallback = (_site: PublicSite, _block: SiteBlock) => 0

const getBlockBorderWidthFallback = (site: PublicSite, block: SiteBlock) => {
  if (block.blockType === 'social_profile') return 0
  if (block.blockType === 'image' || block.blockType === 'video' || block.blockType === 'embed' || block.blockType === 'calendar_embed') return 1
  if (isLanding(site) && ['hero', 'section', 'cta', 'benefits', 'testimonials', 'services', 'faq', 'form_embed', 'social_profile'].includes(block.blockType)) return 0
  return nativeBorderBlockTypes.has(block.blockType) ? 1 : 0
}

const getCardRadiusFallback = (site: PublicSite) => isLanding(site) ? 0 : 8
const getCardBorderWidthFallback = (site: PublicSite) => isLanding(site) ? 0 : 1

const getInheritedBlockStyleSettings = (site: PublicSite, block: SiteBlock, blocks: SiteBlock[]) => {
  const parent = isLanding(site) && !isTopLevelLandingBlock(block) ? getParentSectionBlock(block, blocks) : null
  if (!parent) return {}
  const settings = parent.settings || {}
  const inheritedKeys = [
    'blockBg',
    'blockText',
    'contentMaxWidth',
    'fontFamily',
    'fontWeight',
    'fontStyle',
    'textDecoration',
    'textStrokeColor',
    'textStrokeWidth',
    'textAlign'
  ]

  return inheritedKeys.reduce<Record<string, unknown>>((acc, key) => {
    if (settings[key] !== undefined && settings[key] !== '') acc[key] = settings[key]
    return acc
  }, {})
}

const getPanelStyleSettings = (site: PublicSite, block: SiteBlock, blocks: SiteBlock[]) => {
  const inherited = getInheritedBlockStyleSettings(site, block, blocks)
  const defaults: Record<string, unknown> = {
    textAlign: getBlockTextAlignFallback(site, block, blocks),
    buttonAlign: 'center',
    fontSize: getBlockFontSizeFallback(site, block),
    contentMaxWidth: getBlockContentMaxWidthFallback(site, block),
    blockText: getPageTextPaint(site),
    blockBg: 'transparent',
    blockRadius: getBlockRadiusFallback(site, block),
    blockBorderWidth: getBlockBorderWidthFallback(site, block),
    cardAlign: 'left',
    cardRadius: getCardRadiusFallback(site),
    cardBorderWidth: getCardBorderWidthFallback(site),
    listColumns: 3,
    mediaAlign: 'center',
    mediaWidth: 100,
    mediaRadius: 18,
    fieldBg: '#ffffff',
    fieldBorder: '#dbe3ef',
    fieldRadius: 12,
    buttonRadius: 28,
    buttonHeight: 54,
    buttonPaddingX: 28,
    buttonFontSize: 16,
    buttonBorderWidth: 1
  }

  if (textBoldDefaultBlockTypes.has(block.blockType)) defaults.fontWeight = 'bold'

  return {
    ...defaults,
    ...inherited,
    ...(block.settings || {})
  }
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
  values: Record<typeof spacingSides[number]['id'], number>
) => spacingSides
  .map(side => `${values[side.id]}px`)
  .join(' ')

const getSpacingValues = (
  settings: Record<string, unknown>,
  base: SpacingBase,
  fallback: number,
  min: number,
  max: number
) => spacingSides
  .reduce<Record<typeof spacingSides[number]['id'], number>>((acc, side) => {
    acc[side.id] = getSpacingValue(settings, base, side.id, fallback, min, max)
    return acc
  }, { Top: fallback, Right: fallback, Bottom: fallback, Left: fallback })

const hasNegativeSpacing = (values: Record<typeof spacingSides[number]['id'], number>) =>
  spacingSides.some(side => values[side.id] < 0)

const getPositiveSpacing = (values: Record<typeof spacingSides[number]['id'], number>) =>
  spacingSides.reduce<Record<typeof spacingSides[number]['id'], number>>((acc, side) => {
    acc[side.id] = Math.max(0, values[side.id])
    return acc
  }, { Top: 0, Right: 0, Bottom: 0, Left: 0 })

const getNegativeSpacing = (values: Record<typeof spacingSides[number]['id'], number>) =>
  spacingSides.reduce<Record<typeof spacingSides[number]['id'], number>>((acc, side) => {
    acc[side.id] = Math.min(0, values[side.id])
    return acc
  }, { Top: 0, Right: 0, Bottom: 0, Left: 0 })

const combineSpacingValues = (
  first: Record<typeof spacingSides[number]['id'], number>,
  second: Record<typeof spacingSides[number]['id'], number>
) => spacingSides.reduce<Record<typeof spacingSides[number]['id'], number>>((acc, side) => {
  acc[side.id] = first[side.id] + second[side.id]
  return acc
}, { Top: 0, Right: 0, Bottom: 0, Left: 0 })

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
  if (isCssPaint(text)) {
    const normalized = normalizeCssPaint(text, '#111827')
    style['--rstk-block-text'] = paintFallbackColor(normalized, '#111827')
    if (isCssGradient(normalized)) style['--rstk-block-text-paint'] = normalized
  }
  if (isCssPaint(buttonBg)) {
    const normalized = normalizeCssPaint(buttonBg, '#111827')
    style['--rstk-button-bg'] = normalized
    style['--rstk-button-hover-bg'] = normalized
  }
  if (isCssPaint(buttonText)) {
    const normalized = normalizeCssPaint(buttonText, '#ffffff')
    style['--rstk-button-text'] = paintFallbackColor(normalized, '#ffffff')
    if (isCssGradient(normalized)) style['--rstk-button-text-paint'] = normalized
  }
  if (isCssPaint(buttonBorder)) style['--rstk-button-border'] = paintFallbackColor(normalizeCssPaint(buttonBorder, '#111827'), '#111827')
  if (isCssPaint(cardBg)) style['--rstk-card-bg'] = normalizeCssPaint(cardBg, '#ffffff')
  if (isCssPaint(cardBorder)) style['--rstk-card-border'] = paintFallbackColor(normalizeCssPaint(cardBorder, '#dbe3ef'), '#dbe3ef')
  if (fontFamily) style['--rstk-block-font'] = fontFamily.replace(/[;"{}<>]/g, '')
  if (settings.fontStyle === 'italic') style['--rstk-block-font-style'] = 'italic'
  if (settings.textDecoration === 'underline') style['--rstk-block-text-decoration'] = 'underline'
  if (settings.textStrokeWidth !== undefined) style['--rstk-text-stroke-width'] = `${getSettingNumber(settings, 'textStrokeWidth', 0, 0, 12)}px`
  if (isCssPaint(textStrokeColor)) style['--rstk-text-stroke-color'] = paintFallbackColor(normalizeCssPaint(textStrokeColor, '#111827'), '#111827')
  if (isCssPaint(fieldBg)) style['--rstk-field-bg'] = normalizeCssPaint(fieldBg, '#ffffff')
  if (isCssPaint(fieldBorder)) style['--rstk-field-border'] = paintFallbackColor(normalizeCssPaint(fieldBorder, '#dbe3ef'), '#dbe3ef')
  if (isCssPaint(blockBorder)) style['--rstk-block-border'] = paintFallbackColor(normalizeCssPaint(blockBorder, '#dbe3ef'), '#dbe3ef')
  if (settings.fontWeight === 'bold') style['--rstk-block-weight'] = '850'
  if (settings.fontWeight === 'normal') style['--rstk-block-weight'] = '400'

  if (settings.textAlign !== undefined) {
    const align = getHorizontalAlign(settings, 'textAlign', 'left')
    const margins = marginVarsForAlign(align)
    style['--rstk-block-align'] = align
    style['--rstk-block-justify'] = justifyForAlign(align)
    style['--rstk-content-margin-left'] = margins.left
    style['--rstk-content-margin-right'] = margins.right
  }
  if (settings.contentMaxWidth !== undefined) style['--rstk-content-max'] = `${getSettingNumber(settings, 'contentMaxWidth', 66, 10, 120)}ch`
  if (settings.fontSize !== undefined) style['--rstk-block-size'] = `${getSettingNumber(settings, 'fontSize', 18, 12, 96)}px`
  const hasBlockPadding = settings.blockPadding !== undefined || hasSpacingSideValue(settings, 'blockPadding')
  const hasBlockMargin = settings.blockMargin !== undefined || hasSpacingSideValue(settings, 'blockMargin')
  const paddingValues = hasBlockPadding
    ? getSpacingValues(settings, 'blockPadding', 0, SPACING_OVERLAP_MIN, 160)
    : null
  const marginValues = hasBlockMargin
    ? getSpacingValues(settings, 'blockMargin', 0, SPACING_OVERLAP_MIN, 200)
    : null

  if (paddingValues) {
    style['--rstk-block-pad'] = getSpacingShorthand(getPositiveSpacing(paddingValues))
  }

  if (marginValues || paddingValues && hasNegativeSpacing(paddingValues)) {
    const safeMargin = marginValues || { Top: 0, Right: 0, Bottom: 0, Left: 0 }
    const paddingOverlap = paddingValues ? getNegativeSpacing(paddingValues) : { Top: 0, Right: 0, Bottom: 0, Left: 0 }
    style['--rstk-block-margin'] = getSpacingShorthand(combineSpacingValues(safeMargin, paddingOverlap))
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
    block.blockType === HEADER_PANEL_BLOCK_TYPE ? 'rstkHeaderPanelBlock' : '',
    block.blockType === FOOTER_PANEL_BLOCK_TYPE ? 'rstkFooterPanelBlock' : '',
    getSettingString(settings, 'blockText') ? 'rstkBlockTextOverride' : '',
    isCssGradient(getSettingString(settings, 'blockText')) ? 'rstkTextGradient' : '',
    isCssGradient(getSettingString(settings, 'buttonTextColor')) ? 'rstkButtonTextGradient' : '',
    settings.fontFamily ? 'rstkFontOverride' : '',
    settings.fontSize !== undefined ? 'rstkSizeOverride' : '',
    settings.fontWeight === 'bold' || settings.fontWeight === 'normal' ? 'rstkWeightOverride' : '',
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

const normalizePageList = (rawPages: SitePage[] = []): SitePage[] => {
  const seen = new Set<string>()
  const normalized = rawPages
    .map((page, index) => ({
      id: page?.id || `${DEFAULT_FUNNEL_PAGE_ID}-${index + 1}`,
      title: page?.title || `Pagina ${index + 1}`,
      sortOrder: Number.isFinite(Number(page?.sortOrder)) ? Number(page.sortOrder) : index,
      ...(page?.importedAssetPath ? { importedAssetPath: page.importedAssetPath } : {}),
      ...(page?.importedOriginalTitle ? { importedOriginalTitle: page.importedOriginalTitle } : {}),
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

  return normalized
}

const normalizeFormPages = (site?: PublicSite | null): SitePage[] => {
  const normalized = normalizePageList(Array.isArray(site?.theme?.pages) ? site.theme.pages : [])
  const byId = new Map(normalized.map(page => [page.id, page]))
  const defaults = getDefaultFormPages()
  const contentPages = normalized.filter(page => !isFormFinalPage(page))
  const inputPages = contentPages.length ? contentPages : [byId.get(DEFAULT_FUNNEL_PAGE_ID) || defaults[0]]
  const mergeFinalPage = (page: SitePage): SitePage => {
    const existing = byId.get(page.id)
    return {
      ...page,
      title: existing?.title || page.title,
      metaCapiEnabled: Boolean(existing?.metaCapiEnabled),
      metaEventName: normalizeMetaEventName(existing?.metaEventName, 'none'),
      metaTrigger: normalizeMetaTrigger(existing?.metaTrigger)
    }
  }

  return [
    ...inputPages,
    mergeFinalPage(defaults[1]),
    mergeFinalPage(defaults[2])
  ].map((page, index) => ({ ...page, sortOrder: index }))
}

const normalizeFunnelPages = (site?: PublicSite | null): SitePage[] => {
  if (isImportedHtmlSite(site)) {
    const normalized = normalizePageList(Array.isArray(site?.theme?.pages) ? site.theme.pages : [])
    return normalized.length ? normalized : [{ id: DEFAULT_FUNNEL_PAGE_ID, title: 'Pagina 1', sortOrder: 0 }]
  }

  if (isStandardForm(site)) return normalizeFormPages(site)

  const normalized = normalizePageList(Array.isArray(site?.theme?.pages) ? site.theme.pages : [])
  return normalized.length ? normalized : [{ id: DEFAULT_FUNNEL_PAGE_ID, title: 'Pagina 1', sortOrder: 0 }]
}

const getFormContentPages = (pages: SitePage[]) => pages.filter(page => !isFormFinalPage(page))

const getOrderedPagesForSite = (site: PublicSite, nextPages: SitePage[]) => (
  isStandardForm(site)
    ? normalizeFormPages({ ...site, theme: { ...(site.theme || {}), pages: nextPages } })
    : nextPages
)

const getFormAddPageIndex = (site: PublicSite, pages: SitePage[]) => (
  isStandardForm(site)
    ? pages.findIndex(isFormFinalPage) >= 0
      ? pages.findIndex(isFormFinalPage)
      : pages.length
    : pages.length
)

const isLastFormContentPage = (site: PublicSite, pages: SitePage[], pageId?: string) => {
  if (!isStandardForm(site) || !pageId || isFormFinalPageId(pageId)) return true
  const contentPages = getFormContentPages(pages)
  return contentPages[contentPages.length - 1]?.id === pageId
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
    ...(page.importedAssetPath ? { importedAssetPath: page.importedAssetPath } : {}),
    ...(page.importedOriginalTitle ? { importedOriginalTitle: page.importedOriginalTitle } : {}),
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
const isTopLevelLandingBlock = (block?: SiteBlock | null) => isSectionBlock(block) || isPanelBlock(block)

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

const buildLandingBlockOrderGroups = (
  pageBlocks: SiteBlock[],
  lanes: LandingSectionLane[] = buildLandingSectionLanes(pageBlocks)
): LandingBlockOrderGroup[] => {
  const sortedBlocks = [...pageBlocks].sort((a, b) => a.sortOrder - b.sortOrder)
  const laneBySectionId = new Map(lanes.filter(lane => lane.section).map(lane => [lane.section!.id, lane]))
  const groupedIds = new Set<string>()
  const groups = sortedBlocks
    .filter(isTopLevelLandingBlock)
    .map(anchor => {
      const groupBlocks = [anchor]
      groupedIds.add(anchor.id)

      if (isSectionBlock(anchor)) {
        const lane = laneBySectionId.get(anchor.id)
        const laneChildIds = new Set((lane?.columnBlocks || []).flat().map(block => block.id))
        const sectionChildren = sortedBlocks.filter(block => laneChildIds.has(block.id))
        sectionChildren.forEach(block => groupedIds.add(block.id))
        groupBlocks.push(...sectionChildren)
      }

      return {
        id: anchor.id,
        sortOrder: anchor.sortOrder,
        blocks: groupBlocks
      }
    })

  sortedBlocks
    .filter(block => !groupedIds.has(block.id))
    .forEach(block => {
      groupedIds.add(block.id)
      groups.push({
        id: block.id,
        sortOrder: block.sortOrder,
        blocks: [block]
      })
    })

  return groups.sort((a, b) => a.sortOrder - b.sortOrder)
}

const getButtonAction = (settings: Record<string, unknown>): ButtonAction => {
  const action = getSettingString(settings, 'buttonAction') as ButtonAction
  return ['url', 'next_page', 'specific_page'].includes(action) ? action : 'url'
}

const getFormCompletionAction = (settings: Record<string, unknown>): FormCompletionAction => {
  const action = getSettingString(settings, 'completionAction') as FormCompletionAction
  return ['form_default', 'next_page', 'next_page_if_qualified'].includes(action) ? action : 'form_default'
}

const getThemeFormCompletionAction = (theme?: SiteTheme): FormCompletionAction => {
  const action = theme?.formCompletionAction
  return action === 'form_default' || action === 'next_page' || action === 'next_page_if_qualified' ? action : 'next_page_if_qualified'
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
    action: normalizeVisibleRuleAction(option.action),
    targetBlockId: option.targetBlockId || '',
    message: option.message || '',
    redirectUrl: option.redirectUrl || '',
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
    blockType: 'phone',
    label: 'Telefono / WhatsApp',
    content: '',
    placeholder: '10 digitos',
    required: true,
    options: [],
    settings: { internalName: 'phone', validation: 'phone', phoneCountrySelectorEnabled: true },
    sortOrder: 1,
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
    sortOrder: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
]

const defaultBlockPayload = (blockType: SiteBlockType, siteOrId: PublicSite | string, siteType?: SiteType) => {
  const site = typeof siteOrId === 'string' ? null : siteOrId
  const siteId = typeof siteOrId === 'string' ? siteOrId : siteOrId.id
  const resolvedSiteType = site?.siteType || siteType
  const isField = fieldBlockTypes.has(blockType)
  const label = blockLabels[blockType]
  const baseSettings: Record<string, unknown> = isField
    ? {
        internalName: slugifyName(label),
        validation: blockType === 'email' ? 'email' : blockType === 'phone' ? 'phone' : '',
        ...(blockType === 'phone' ? { phoneCountrySelectorEnabled: true } : {})
      }
    : {}
  const landingSettings = resolvedSiteType === 'landing_page' && !isField ? getLandingDefaultBlockSpacing(blockType) : {}
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
        blockText: resolvedSiteType === 'landing_page' ? '#f4f4f6' : '#111827',
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

  if (blockType === 'social_profile') {
    return {
      blockType,
      label,
      content: 'Perfil de red social',
      settings: blockSettings(socialProfileDefaultsForSite(site))
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
    placeholder: isField ? (blockType === 'dropdown' ? 'Selecciona una opcion' : 'Escribe aqui') : '',
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
  const payload = defaultBlockPayload(blockType, site)
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

const hydrateFormSitesForBuilder = async (list: PublicSite[]) => {
  const formSites = list.filter(site => isFormSite(site))
  if (!formSites.length) return list

  const hydratedForms = await Promise.all(formSites.map(async (site) => {
    try {
      return normalizeSiteForEditor(await sitesService.getSite(site.id))
    } catch {
      return site
    }
  }))
  const hydratedById = new Map(hydratedForms.map(site => [site.id, site]))

  return list.map(site => hydratedById.get(site.id) || site)
}

export const Sites: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const navigate = useNavigate()
  const { configured: aiAgentConfigured } = useAIAgentAvailability()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [section, setSection] = useState<SitesSection>('landings')
  const [sites, setSites] = useState<PublicSite[]>([])
  const [domainConfig, setDomainConfig] = useState<SitesDomainConfig>(emptySitesDomainConfig)
  const [domainInput, setDomainInput] = useState('')
  const [calendars, setCalendars] = useState<CalendarType[]>([])
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([])
  const [metaPixelConnected, setMetaPixelConnected] = useState(false)
  const [connectedSocialProfiles, setConnectedSocialProfiles] = useState<ConnectedSocialProfile[]>([])
  const [loadingSocialProfiles, setLoadingSocialProfiles] = useState(false)
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
  const [paletteDragPosition, setPaletteDragPosition] = useState<PaletteDragPosition | null>(null)
  const [leadRows, setLeadRows] = useState<LeadRow[]>([])
  const [loadingLeads, setLoadingLeads] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [editorFocusMode, setEditorFocusMode] = useState(false)
  const [seoModalOpen, setSeoModalOpen] = useState(false)
  const [pendingImportSiteType, setPendingImportSiteType] = useState<SiteType>('landing_page')
  const [importReview, setImportReview] = useState<ImportReviewState | null>(null)
  const [selectedImportData, setSelectedImportData] = useState<ImportedSiteImport | null>(null)
  const [aiCreationModal, setAiCreationModal] = useState<SitesAICreationModalState>(null)
  const [loadingImportData, setLoadingImportData] = useState(false)
  const [savingImportMapping, setSavingImportMapping] = useState(false)
  const selectedSiteRef = useRef<PublicSite | null>(null)
  const importFileInputRef = useRef<HTMLInputElement | null>(null)
  const pendingImportSiteTypeRef = useRef<SiteType>('landing_page')
  const paletteDragPayloadRef = useRef<PaletteDragPayload | null>(null)
  const undoStackRef = useRef<EditorHistoryEntry[]>([])
  const redoStackRef = useRef<EditorHistoryEntry[]>([])
  const historyBusyRef = useRef(false)
  const guardHistoryArmedRef = useRef(false)
  const allowNavigationRef = useRef(false)

  useEffect(() => {
    selectedSiteRef.current = selectedSite
  }, [selectedSite])

  useEffect(() => {
    let cancelled = false
    const site = selectedSite

    if (!site || !isImportedHtmlSite(site)) {
      setSelectedImportData(null)
      setLoadingImportData(false)
      return
    }

    setLoadingImportData(true)
    sitesService.getImportMapping(site.id)
      .then((importData) => {
        if (!cancelled) setSelectedImportData(importData)
      })
      .catch(() => {
        if (!cancelled) setSelectedImportData(null)
      })
      .finally(() => {
        if (!cancelled) setLoadingImportData(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedSite?.id])

  useEffect(() => {
    undoStackRef.current = []
    redoStackRef.current = []
  }, [selectedSite?.id])

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
    () => hasEditablePages(selectedSite) ? normalizeFunnelPages(selectedSite) : [],
    [selectedSite]
  )
  const activePage = pages.find(page => page.id === activePageId) || pages[0] || null
  const canvasBlocks = useMemo(
    () => hasEditablePages(selectedSite) && activePage
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
  const formCanvasHasFields = Boolean(editorSite && isFormSite(editorSite) && canvasBlocks.some(block => fieldBlockTypes.has(block.blockType)))
  const formCanvasActionLabel = editorSite && activePage && isStandardForm(editorSite) && !isLastFormContentPage(editorSite, pages, activePage.id)
    ? 'Continuar'
    : undefined
  const seoValidation = editorSite ? getSeoValidationState(editorSite) : null
  const editorActive = Boolean(editorSite)
  const isCanvasFocusMode = editorFocusMode && Boolean(editorSite)
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
      hasEditablePages(editorSite) ? activePage?.id : undefined,
      paletteDragPayload.initialSettings
    )
    : null
  const canvasPalettePreviewBlock = paletteDragging ? palettePreviewBlock : null

  useEffect(() => {
    setEditorFocusMode(false)
    setSeoModalOpen(false)
  }, [editorSite?.id])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(SITES_EDITOR_ACTIVE_EVENT, {
      detail: { active: editorActive, focusMode: isCanvasFocusMode }
    }))
  }, [editorActive, isCanvasFocusMode])

  useEffect(() => {
    return () => {
      window.dispatchEvent(new CustomEvent(SITES_EDITOR_ACTIVE_EVENT, {
        detail: { active: false, focusMode: false }
      }))
    }
  }, [])

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
    loadCustomFieldsForBuilder()
  }, [])

  useEffect(() => {
    let mounted = true

    setLoadingSocialProfiles(true)
    campaignsService.getMetaConfig()
      .then(response => {
        if (!mounted) return
        setMetaPixelConnected(Boolean(
          response.configured &&
          response.config?.adAccountId &&
          response.config?.accessToken &&
          response.config?.pixelId
        ))
      })
      .catch(() => {
        if (mounted) setMetaPixelConnected(false)
      })

    campaignsService.getConnectedSocialProfiles()
      .then(response => {
        if (!mounted) return
        setConnectedSocialProfiles(response.profiles)
      })
      .catch(() => {
        if (mounted) setConnectedSocialProfiles([])
      })
      .finally(() => {
        if (mounted) setLoadingSocialProfiles(false)
      })

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!hasEditablePages(selectedSite)) return
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
      const detail = (event as CustomEvent<PublicSite | { site?: PublicSite; import?: ImportedSiteImport; reviewMapping?: boolean }>).detail
      const wrappedDetail = Boolean(detail && typeof detail === 'object' && 'site' in detail)
      const rawSite = wrappedDetail ? (detail as { site?: PublicSite }).site : detail as PublicSite | undefined
      if (!rawSite?.id) return
      const site = normalizeSiteForEditor(rawSite)
      const importData = wrappedDetail ? (detail as { import?: ImportedSiteImport }).import : null

      setSites(current => [site, ...current.filter(item => item.id !== site.id)])
      setSelectedSite(site)
      setActivePageId(normalizeFunnelPages(site)[0]?.id || DEFAULT_FUNNEL_PAGE_ID)
      setSelectedBlockId('')
      setSection(site.siteType === 'landing_page' ? 'landings' : 'forms')
      setCreateFlow('closed')
      setHasUnsavedChanges(false)
      if (importData?.siteId) {
        setSelectedImportData(importData)
        if (wrappedDetail && (detail as { reviewMapping?: boolean }).reviewMapping) {
          setImportReview({ site, importData })
        }
      }
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
      const builderSites = await hydrateFormSitesForBuilder(list)
      setSites(builderSites)
      setDomainConfig(nextDomainConfig)
      setDomainInput(nextDomainConfig.domain)
      const nextId = selectId || (selectedSite?.id && builderSites.some(site => site.id === selectedSite.id) ? selectedSite.id : '')
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

  const loadCustomFieldsForBuilder = async () => {
    try {
      const catalog = await customFieldsService.listCatalog()
      setCustomFields(catalog.fields || [])
    } catch {
      setCustomFields([])
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
      selectedSiteRef.current = null
      setSelectedSite(null)
      setSelectedBlockId('')
      setActivePageId(DEFAULT_FUNNEL_PAGE_ID)
      setDraggingPageId(null)
      setActiveDragId(null)
      setPaletteDragging(false)
      setPaletteDragPayload(null)
      setPaletteInsertIndex(null)
      setPaletteSectionTarget(null)
      setCreateFlow(getCreateFlowForSection(section))
      setHasUnsavedChanges(false)
    })
  }

  const clearSiteEditorUrlParam = () => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('siteEditor')) return

    url.searchParams.delete('siteEditor')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }

  const handleBackToLibrary = () => {
    requestLeaveEditor(() => {
      selectedSiteRef.current = null
      setSelectedSite(null)
      setSelectedBlockId('')
      setActivePageId(DEFAULT_FUNNEL_PAGE_ID)
      setDraggingPageId(null)
      setActiveDragId(null)
      setPaletteDragging(false)
      setPaletteDragPayload(null)
      setPaletteInsertIndex(null)
      setPaletteSectionTarget(null)
      setCreateFlow('closed')
      setEditorFocusMode(false)
      setSeoModalOpen(false)
      clearSiteEditorUrlParam()
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

  const pushEditorHistory = (entry: EditorHistoryEntry) => {
    if (historyBusyRef.current) return
    undoStackRef.current = [...undoStackRef.current, cloneJson(entry)].slice(-MAX_SITES_EDITOR_HISTORY)
    redoStackRef.current = []
  }

  const applyEditorHistoryEntry = async (entry: EditorHistoryEntry, direction: 'undo' | 'redo') => {
    if (historyBusyRef.current) return false

    historyBusyRef.current = true
    setSaving(true)
    try {
      let site: PublicSite | null = null

      if (entry.action === 'reorder') {
        site = await sitesService.reorderBlocks(
          entry.siteId,
          direction === 'undo' ? entry.beforeBlockIds : entry.afterBlockIds,
          entry.pageId
        )
      } else if (entry.action === 'delete') {
        if (direction === 'undo') {
          if (!entry.deletedBlocks?.length) return false
          site = await sitesService.restoreBlocks(entry.siteId, entry.deletedBlocks)
          if (entry.beforeBlockIds.length) {
            site = await sitesService.reorderBlocks(entry.siteId, entry.beforeBlockIds, entry.pageId)
          }
        } else if (entry.deletedRootBlockId) {
          site = await sitesService.deleteBlock(entry.siteId, entry.deletedRootBlockId)
        }
      }

      if (!site) return false

      syncSelectedSite(site)
      if (entry.pageId) setActivePageId(entry.pageId)
      setSelectedBlockId(direction === 'undo' ? entry.selectedBefore : entry.selectedAfter)
      setHasUnsavedChanges(false)
      showToast(
        'info',
        direction === 'undo' ? 'Cambio deshecho' : 'Cambio rehecho',
        direction === 'undo' ? 'El editor regreso al paso anterior.' : 'El editor aplico otra vez el cambio.'
      )
      return true
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo actualizar el historial')
      return false
    } finally {
      historyBusyRef.current = false
      setSaving(false)
    }
  }

  const handleEditorUndo = async () => {
    const entry = undoStackRef.current.pop()
    if (!entry) return

    const applied = await applyEditorHistoryEntry(entry, 'undo')
    if (applied) {
      redoStackRef.current = [...redoStackRef.current, entry].slice(-MAX_SITES_EDITOR_HISTORY)
    } else {
      undoStackRef.current = [...undoStackRef.current, entry].slice(-MAX_SITES_EDITOR_HISTORY)
    }
  }

  const handleEditorRedo = async () => {
    const entry = redoStackRef.current.pop()
    if (!entry) return

    const applied = await applyEditorHistoryEntry(entry, 'redo')
    if (applied) {
      undoStackRef.current = [...undoStackRef.current, entry].slice(-MAX_SITES_EDITOR_HISTORY)
    } else {
      redoStackRef.current = [...redoStackRef.current, entry].slice(-MAX_SITES_EDITOR_HISTORY)
    }
  }

  useEffect(() => {
    if (!editorSite) return

    const handleEditorKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || isNativeUndoTarget(event.target)) return

      const key = event.key.toLowerCase()
      const wantsUndo = key === 'z' && !event.shiftKey
      const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey)
      if (!wantsUndo && !wantsRedo) return

      event.preventDefault()
      if (historyBusyRef.current) return
      void (wantsUndo ? handleEditorUndo() : handleEditorRedo())
    }

    window.addEventListener('keydown', handleEditorKeyDown)
    return () => window.removeEventListener('keydown', handleEditorKeyDown)
  }, [editorSite])

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
    if (!selectedSite || !hasEditablePages(selectedSite)) return
    const orderedPages = getOrderedPagesForSite(selectedSite, nextPages)

    setSaving(true)
    try {
      const theme = {
        ...(selectedSite.theme || {}),
        pages: normalizePagesForSave(orderedPages)
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
    if (!selectedSite || !hasEditablePages(selectedSite) || !canManagePages(selectedSite)) return
    const nextPage = makeFunnelPage(isStandardForm(selectedSite) ? getFormContentPages(pages).length : pages.length)
    const insertIndex = getFormAddPageIndex(selectedSite, pages)
    const nextPages = [
      ...pages.slice(0, insertIndex),
      nextPage,
      ...pages.slice(insertIndex)
    ]
    void persistFunnelPages(nextPages, nextPage.id)
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
    if (!selectedSite || !hasEditablePages(selectedSite) || !canManagePages(selectedSite)) return
    if (isStandardForm(selectedSite) && isFormFinalPageId(pageId)) return

    const sourceIndex = pages.findIndex(page => page.id === pageId)
    if (sourceIndex < 0) return

    const nextPage = makeFunnelPage(isStandardForm(selectedSite) ? getFormContentPages(pages).length : pages.length)
    nextPage.title = `${pages[sourceIndex].title} copia`
    const nextPages = [
      ...pages.slice(0, sourceIndex + 1),
      nextPage,
      ...pages.slice(sourceIndex + 1)
    ]
    const orderedPages = getOrderedPagesForSite(selectedSite, nextPages)

    setSaving(true)
    try {
      let site = await saveSiteTheme(selectedSite, {
        ...(selectedSite.theme || {}),
        pages: normalizePagesForSave(orderedPages)
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
    if (!selectedSite || !hasEditablePages(selectedSite) || !canManagePages(selectedSite)) return
    if (isStandardForm(selectedSite) && isFormFinalPageId(pageId)) {
      showToast('warning', 'Pagina fija', 'Esta pagina se usa para cerrar el formulario y no se puede eliminar.')
      return
    }
    const deletablePageCount = isStandardForm(selectedSite) ? getFormContentPages(pages).length : pages.length
    if (deletablePageCount <= 1) {
      showToast('warning', 'No se puede eliminar', `${getSiteTypeLabel(selectedSite)} debe tener al menos una pagina.`)
      return
    }

    showConfirm(
      'Eliminar pagina',
      'Se eliminara esta pagina y todos sus bloques. Esta accion no se puede deshacer.',
      () => {
        const deletePage = async () => {
          const pageIndex = pages.findIndex(page => page.id === pageId)
          const nextPages = pages.filter(page => page.id !== pageId)
          const orderedPages = getOrderedPagesForSite(selectedSite, nextPages)
          const nextActive = activePageId === pageId
            ? orderedPages[Math.max(0, pageIndex - 1)]?.id || orderedPages[0]?.id
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
              pages: normalizePagesForSave(orderedPages)
            })
            syncSelectedSite(site)
            setActivePageId(nextActive || DEFAULT_FUNNEL_PAGE_ID)
            setHasUnsavedChanges(false)
            showToast('success', 'Pagina eliminada', `${getSiteTypeLabel(selectedSite)} se actualizo.`)
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
    if (!selectedSite || !canManagePages(selectedSite)) return
    if (!sourcePageId || sourcePageId === targetPageId) return
    if (isStandardForm(selectedSite)) {
      if (isFormFinalPageId(sourcePageId) || isFormFinalPageId(targetPageId)) return
      const contentPages = getFormContentPages(pages)
      const oldIndex = contentPages.findIndex(page => page.id === sourcePageId)
      const newIndex = contentPages.findIndex(page => page.id === targetPageId)
      if (oldIndex < 0 || newIndex < 0) return
      void persistFunnelPages([
        ...arrayMove(contentPages, oldIndex, newIndex),
        ...pages.filter(isFormFinalPage)
      ], activePageId)
      return
    }
    const oldIndex = pages.findIndex(page => page.id === sourcePageId)
    const newIndex = pages.findIndex(page => page.id === targetPageId)
    if (oldIndex < 0 || newIndex < 0) return
    void persistFunnelPages(arrayMove(pages, oldIndex, newIndex), activePageId)
  }

  const handleRenamePage = (pageId: string, title: string) => {
    if (!selectedSite || !canManagePages(selectedSite)) return
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
      const isBlank = mode === 'blank'
      const template: SiteTemplateId = templateId
        || (siteType === 'interactive_form' ? 'interactive' : siteType === 'landing_page' ? 'ristak' : 'ristak')
      const siteIdentity = getNextSiteIdentity(siteType, sites)
      const templateDefaults = isBlank ? {} : getTemplateThemeDefaults(template, siteType)
      let site = await sitesService.createSite({
        name: siteIdentity.name,
        siteType,
        slug: siteIdentity.slug,
        title: '',
        theme: {
          ...templateDefaults,
          template,
          ...(isBlank
            ? {
                blankCanvas: true,
                backgroundColor: siteType === 'landing_page' ? '#ffffff' : '#f8fafc',
                backgroundImage: ''
              }
            : {}),
          ...(siteType === 'landing_page'
            ? {
                pageMaxWidth: templateDefaults.pageMaxWidth ?? 1440,
                pages: normalizePagesForSave(
                  isBlank
                    ? [makeTemplateFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Pagina 1', 0)]
                    : getTemplateFunnelPages(template)
                )
              }
            : siteType === 'interactive_form'
              ? {
                  pages: normalizePagesForSave([makeTemplateFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Pagina 1', 0)])
                }
            : siteType === 'standard_form'
              ? {
                  pages: normalizePagesForSave(getDefaultFormPages()),
                  formCompletionAction: 'next_page_if_qualified'
                }
            : {})
        },
        metaCapiEnabled: metaPixelConnected,
        metaEventName: 'none'
      })

      if (isBlank && site.blocks?.length) {
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

  const handleCreateSiteWithAI = (siteKind: SitesAICreationKind, editSite?: PublicSite) => {
    if (!aiAgentConfigured) return

    setAiCreationModal({ siteKind, editSite: editSite || null })
  }

  const handleSubmitAICreationModal = async ({
    siteKind,
    prompt,
    attachmentNotes,
    editSite
  }: SitesAICreationModalSubmit): Promise<string | null> => {
    const promptParts = [
      editSite
        ? `Modifica esta pagina importada con IA segun la peticion del usuario. Manten formularios, campos, tracking y acciones de botones funcionando.`
        : `Crea una pagina completa con IA libre en HTML/CSS para importarla en Ristak.`,
      `Peticion del usuario:\n${prompt.trim()}`,
      attachmentNotes.length ? `Archivos de referencia:\n${attachmentNotes.join('\n\n')}` : '',
      [
        'Reglas de experiencia:',
        '- Usa textos cortos, titulares compactos y parrafos faciles de escanear.',
        '- Si algun texto necesita ser largo, ajusta font-size, line-height y ancho para que no rompa el diseno.',
        '- Usa fotos HTTPS visibles cuando ayuden al objetivo.',
        '- Marca textos e imagenes editables con los atributos internos de Ristak.',
        '- Prepara formularios con campos claros para que Ristak detecte y mapee datos automaticamente.'
      ].join('\n')
    ].filter(Boolean)
    const messages: SitesAICreationMessage[] = [{ role: 'user', content: promptParts.join('\n\n') }]

    setCreating(true)
    try {
      const result = editSite
        ? await sitesService.editImportedHtmlWithAI(editSite.id, { siteKind, messages })
        : await sitesService.createWithAIHtml({ siteKind, messages, metaCapiEnabled: metaPixelConnected })

      if (result.status === 'needs_more_info' || !result.site || !result.import) {
        return result.reply || 'Dame un poco mas de contexto para crear una pagina bien armada.'
      }

      const normalizedSite = normalizeSiteForEditor(result.site)
      setSites(current => {
        const exists = current.some(item => item.id === normalizedSite.id)
        if (exists) return current.map(item => item.id === normalizedSite.id ? { ...item, ...normalizedSite } : item)
        return [normalizedSite, ...current]
      })
      setSelectedSite(normalizedSite)
      selectedSiteRef.current = normalizedSite
      setSelectedBlockId('')
      setActivePageId(DEFAULT_FUNNEL_PAGE_ID)
      setSection(normalizedSite.siteType === 'landing_page' ? 'landings' : 'forms')
      setCreateFlow('closed')
      setHasUnsavedChanges(false)
      setSelectedImportData(result.import)
      setImportReview({ site: normalizedSite, importData: result.import })
      setAiCreationModal(null)
      showToast(
        'success',
        editSite ? 'Pagina actualizada con IA' : 'Pagina creada con IA',
        'Ristak ya reviso el HTML. Confirma la ruta de datos antes de publicar.'
      )
      return null
    } catch (error) {
      return error instanceof Error ? error.message : 'No se pudo generar la pagina con IA'
    } finally {
      setCreating(false)
    }
  }

  const handleOpenImportHtml = (siteType: SiteType) => {
    pendingImportSiteTypeRef.current = siteType
    setPendingImportSiteType(siteType)
    if (importFileInputRef.current) {
      importFileInputRef.current.value = ''
      importFileInputRef.current.click()
    }
  }

  const handleImportHtmlFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    if (!/\.(html?|zip)$/i.test(file.name)) {
      showToast('error', 'Archivo no valido', 'Sube un archivo .html o un .zip con tu sitio.')
      return
    }

    setCreating(true)
    try {
      const siteType = pendingImportSiteTypeRef.current || pendingImportSiteType
      const fileBase64 = await fileToBase64(file)
      const result = await sitesService.importHtmlSite({
        siteType,
        filename: file.name,
        fileBase64,
        metaCapiEnabled: metaPixelConnected
      })
      const site = normalizeSiteForEditor(result.site)
      setSites(current => [site, ...current])
      setSelectedSite(site)
      selectedSiteRef.current = site
      setSelectedBlockId('')
      setActivePageId(DEFAULT_FUNNEL_PAGE_ID)
      setSection(siteType === 'landing_page' ? 'landings' : 'forms')
      setCreateFlow('closed')
      setHasUnsavedChanges(false)
      setSelectedImportData(result.import)
      setImportReview({ site, importData: result.import })
      showToast('success', 'HTML importado', 'Revisa los campos detectados antes de publicar.')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo importar el HTML')
    } finally {
      setCreating(false)
    }
  }

  const handleConfirmImportMapping = async (formMappings: ImportedSiteFormMapping[]) => {
    if (!importReview) return
    setSavingImportMapping(true)
    try {
      const importData = await sitesService.updateImportMapping(importReview.site.id, formMappings)
      setSelectedImportData(importData)
      setImportReview(null)
      showToast('success', 'Ruta de datos guardada', 'Ristak ya sabe donde guardar cada dato de este HTML.')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar el mapeo')
    } finally {
      setSavingImportMapping(false)
    }
  }

  const handleOpenImportMappingEditor = async (site: PublicSite) => {
    if (!isImportedHtmlSite(site)) return

    setLoadingImportData(true)
    try {
      const importData = selectedImportData?.siteId === site.id
        ? selectedImportData
        : await sitesService.getImportMapping(site.id)
      setSelectedImportData(importData)
      setImportReview({ site, importData })
    } catch (error) {
      showToast('error', 'No se pudo abrir la ruta de datos', error instanceof Error ? error.message : 'Intentalo otra vez.')
    } finally {
      setLoadingImportData(false)
    }
  }

  const handleEditImportedHtmlWithAI = (site: PublicSite) => {
    if (!isImportedHtmlSite(site)) return
    handleCreateSiteWithAI(getAIAgentSiteKindForSite(site), site)
  }

  const handleImportedContentUpdated = (result: ImportedSiteCreateResult) => {
    const normalizedSite = normalizeSiteForEditor(result.site)
    setSites(current => current.map(item => item.id === normalizedSite.id ? { ...item, ...normalizedSite } : item))
    selectedSiteRef.current = normalizedSite
    setSelectedSite(normalizedSite)
    setSelectedImportData(result.import)
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

  const handlePreviewSite = async () => {
    if (!editorSite) return
    const previewWindow = window.open('', '_blank')
    if (!previewWindow) {
      showToast('error', 'Preview bloqueado', 'Permite popups para abrir la previsualizacion.')
      return
    }

    writePreviewLoadingPage(previewWindow)
    try {
      const html = await sitesService.getPreviewHtml(editorSite.id, hasEditablePages(editorSite) ? activePage?.id : undefined, { test: true })
      previewWindow.document.open()
      previewWindow.document.write(html)
      previewWindow.document.close()
    } catch (error) {
      previewWindow.close()
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo previsualizar')
    }
  }

  const handlePreviewLibrarySite = async (site: PublicSite) => {
    if (isPublicSiteLive(site, domainConfig)) {
      const liveWindow = window.open(buildLivePublicUrl(site, domainConfig), '_blank')
      if (!liveWindow) {
        showToast('error', 'Ventana bloqueada', 'Permite popups para abrir el sitio en vivo.')
      } else {
        liveWindow.opener = null
      }
      return
    }

    const previewWindow = window.open('', '_blank')
    if (!previewWindow) {
      showToast('error', 'Preview bloqueado', 'Permite popups para abrir la previsualizacion.')
      return
    }

    writePreviewLoadingPage(previewWindow)
    try {
      const pageId = hasEditablePages(site) ? normalizeFunnelPages(site)[0]?.id : undefined
      const html = await sitesService.getPreviewHtml(site.id, pageId, { test: true })
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
      const previousBlockIds = new Set((selectedSite.blocks || []).map(block => block.id))
      const payload = defaultBlockPayload(blockType, selectedSite)
      const initialSettings = options.initialSettings || {}
      let blockIdsBeforeContent = previousBlockIds
      let autoCreatedSection: SiteBlock | null = null
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
        let targetSectionId = options.sectionId && pageSectionIds.has(options.sectionId)
          ? options.sectionId
          : selectedTarget?.sectionId || singleSectionTarget?.sectionId || ''
        let targetColumn = Number.isFinite(Number(options.sectionColumn))
          ? Math.min(2, Math.max(0, Math.round(Number(options.sectionColumn))))
          : selectedTarget?.sectionColumn || singleSectionTarget?.sectionColumn || 0
        if (isSection) {
          const columns = getSettingNumber(initialSettings, 'sectionColumns', 1, 1, 3)
          payload.label = getSectionColumnLabel(columns)
          payload.content = ''
          payload.settings = {
            ...(payload.settings || {}),
            ...initialSettings,
            sectionColumns: columns,
            sectionGap: getSettingNumber(initialSettings, 'sectionGap', DEFAULT_SECTION_GAP, 0, 80)
          }
        } else if (!isPanel) {
          if (!targetSectionId) {
            const sectionPayload = defaultBlockPayload(SECTION_BLOCK_TYPE, selectedSite)
            const columns = 1
            sectionPayload.label = getSectionColumnLabel(columns)
            sectionPayload.content = ''
            sectionPayload.settings = {
              ...(sectionPayload.settings || {}),
              sectionColumns: columns,
              sectionGap: DEFAULT_SECTION_GAP,
              pageId: activePage.id
            }

            const siteWithSection = await sitesService.createBlock(selectedSite.id, sectionPayload)
            const sectionPages = normalizeFunnelPages(siteWithSection)
            autoCreatedSection = [...(siteWithSection.blocks || [])]
              .filter(block => !previousBlockIds.has(block.id))
              .find(block => isSectionBlock(block) && getBlockPageId(block, sectionPages) === activePage.id) || null

            if (!autoCreatedSection) {
              throw new Error('No se pudo crear la franja para este contenido')
            }

            targetSectionId = autoCreatedSection.id
            targetColumn = 0
            blockIdsBeforeContent = new Set((siteWithSection.blocks || []).map(block => block.id))
            syncSelectedSite(siteWithSection)
          }

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
      } else if (hasEditablePages(selectedSite) && activePage) {
        payload.settings = {
          ...(payload.settings || {}),
          ...initialSettings,
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
      const activePageForAdd = activePage?.id || DEFAULT_FUNNEL_PAGE_ID
      syncSelectedSite(site)
      const added = [...(site.blocks || [])]
        .filter(block => !blockIdsBeforeContent.has(block.id))
        .find(block => !hasEditablePages(site) || getBlockPageId(block, sitePages) === activePageForAdd)
      if (added && Number.isFinite(options.insertIndex)) {
        const pageBlocks = [...(site.blocks || [])]
          .filter(block => !hasEditablePages(site) || getBlockPageId(block, sitePages) === activePageForAdd)
          .sort((a, b) => a.sortOrder - b.sortOrder)
        const insertedBlocks = autoCreatedSection ? [autoCreatedSection, added] : [added]
        const insertedIds = new Set(insertedBlocks.map(block => block.id))
        const withoutInserted = pageBlocks.filter(block => !insertedIds.has(block.id))
        const boundedIndex = Math.max(0, Math.min(Number(options.insertIndex), withoutInserted.length))
        const orderedBlocks = [
          ...withoutInserted.slice(0, boundedIndex),
          ...insertedBlocks,
          ...withoutInserted.slice(boundedIndex)
        ]
        site = await sitesService.reorderBlocks(
          selectedSite.id,
          orderedBlocks.map(block => block.id),
          hasEditablePages(site) ? activePage?.id : undefined
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

  const getDeletedBlockIds = (blockId: string) => {
    const block = canvasBlocks.find(item => item.id === blockId) || blocks.find(item => item.id === blockId)
    if (!editorSite || !isLanding(editorSite) || !isSectionBlock(block)) return [blockId]

    const lane = landingSectionLanes.find(item => item.section?.id === blockId)
    const laneBlockIds = (lane?.columnBlocks || []).flat().map(item => item.id)
    const explicitChildIds = canvasBlocks
      .filter(item => item.id !== blockId && getBlockSectionId(item) === blockId)
      .map(item => item.id)

    return [...new Set([...laneBlockIds, ...explicitChildIds, blockId])]
  }

  const getDeletedBlocks = (blockId: string) => {
    const deletedIds = new Set(getDeletedBlockIds(blockId))
    return blocks.filter(block => deletedIds.has(block.id)).map(block => cloneJson(block))
  }

  const handleDeleteBlock = async (blockId: string) => {
    if (!selectedSite) return
    try {
      const beforeBlockIds = canvasBlocks.map(block => block.id)
      const deletedBlockIds = getDeletedBlockIds(blockId)
      const deletedBlocks = getDeletedBlocks(blockId)
      const selectedBefore = selectedBlockId
      const site = await sitesService.deleteBlock(selectedSite.id, blockId)
      syncSelectedSite(site)
      const normalizedSite = normalizeSiteForEditor(site)
      const normalizedPages = normalizeFunnelPages(normalizedSite)
      const pageId = hasEditablePages(selectedSite) ? activePage?.id : undefined
      const afterBlockIds = (normalizedSite.blocks || [])
        .filter(block => !pageId || getBlockPageId(block, normalizedPages) === pageId)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(block => block.id)
      if (deletedBlockIds.includes(selectedBlockId)) {
        setSelectedBlockId('')
      }
      pushEditorHistory({
        action: 'delete',
        siteId: selectedSite.id,
        pageId,
        selectedBefore,
        selectedAfter: deletedBlockIds.includes(selectedBlockId) ? '' : selectedBlockId,
        beforeBlockIds,
        afterBlockIds,
        deletedRootBlockId: blockId,
        deletedBlocks
      })
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo eliminar el bloque')
    }
  }

  const persistCanvasBlockOrder = async (orderedBlocks: SiteBlock[]) => {
    if (!selectedSite) return false

    const wasAlreadyDirty = hasUnsavedChanges
    const beforeBlockIds = canvasBlocks.map(block => block.id)
    const afterBlockIds = orderedBlocks.map(block => block.id)
    if (beforeBlockIds.join('|') === afterBlockIds.join('|')) return true
    const selectedBefore = selectedBlockId
    const pageId = hasEditablePages(selectedSite) ? activePage?.id : undefined
    const nextPageBlocks = orderedBlocks.map((block, index) => ({ ...block, sortOrder: index }))
    const nextPageBlocksById = new Map(nextPageBlocks.map(block => [block.id, block]))
    const nextBlocks = blocks.map(block => nextPageBlocksById.get(block.id) || block)
    const optimisticSite = { ...selectedSite, blocks: nextBlocks }

    setHasUnsavedChanges(true)
    selectedSiteRef.current = optimisticSite
    setSelectedSite(optimisticSite)

    try {
      const site = await sitesService.reorderBlocks(
        selectedSite.id,
        nextPageBlocks.map(block => block.id),
        hasEditablePages(selectedSite) ? activePage?.id : undefined
      )
      syncSelectedSite(site)
      pushEditorHistory({
        action: 'reorder',
        siteId: selectedSite.id,
        pageId,
        selectedBefore,
        selectedAfter: selectedBefore,
        beforeBlockIds,
        afterBlockIds
      })
      if (!wasAlreadyDirty) {
        setHasUnsavedChanges(false)
      }
      return true
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo reordenar')
      return false
    }
  }

  const getLandingColumnBlocksForMove = (block: SiteBlock) => {
    for (const lane of landingSectionLanes) {
      const column = lane.columnBlocks.find(columnBlocks => columnBlocks.some(item => item.id === block.id))
      if (column) return column
    }
    return []
  }

  const getBlockMoveState = (block: SiteBlock): BlockMoveState => {
    if (!editorSite) return { canMoveUp: false, canMoveDown: false }

    if (isLanding(editorSite)) {
      if (isTopLevelLandingBlock(block)) {
        const groups = buildLandingBlockOrderGroups(canvasBlocks, landingSectionLanes)
        const groupIndex = groups.findIndex(group => group.id === block.id)
        return {
          canMoveUp: groupIndex > 0,
          canMoveDown: groupIndex >= 0 && groupIndex < groups.length - 1
        }
      }

      const columnBlocks = getLandingColumnBlocksForMove(block)
      const columnIndex = columnBlocks.findIndex(item => item.id === block.id)
      return {
        canMoveUp: columnIndex > 0,
        canMoveDown: columnIndex >= 0 && columnIndex < columnBlocks.length - 1
      }
    }

    const index = canvasBlocks.findIndex(item => item.id === block.id)
    return {
      canMoveUp: index > 0,
      canMoveDown: index >= 0 && index < canvasBlocks.length - 1
    }
  }

  const handleMoveBlock = async (blockId: string, direction: BlockMoveDirection) => {
    if (!selectedSite) return
    const block = canvasBlocks.find(item => item.id === blockId)
    if (!block) return

    const offset = direction === 'up' ? -1 : 1
    let nextPageBlocks: SiteBlock[] | null = null

    if (isLanding(selectedSite)) {
      if (isTopLevelLandingBlock(block)) {
        const groups = buildLandingBlockOrderGroups(canvasBlocks, landingSectionLanes)
        const groupIndex = groups.findIndex(group => group.id === block.id)
        const nextGroupIndex = groupIndex + offset
        if (groupIndex < 0 || nextGroupIndex < 0 || nextGroupIndex >= groups.length) return
        nextPageBlocks = arrayMove(groups, groupIndex, nextGroupIndex).flatMap(group => group.blocks)
      } else {
        const columnBlocks = getLandingColumnBlocksForMove(block)
        const columnIndex = columnBlocks.findIndex(item => item.id === block.id)
        const nextColumnIndex = columnIndex + offset
        const targetBlock = columnBlocks[nextColumnIndex]
        if (columnIndex < 0 || !targetBlock) return
        const oldIndex = canvasBlocks.findIndex(item => item.id === block.id)
        const newIndex = canvasBlocks.findIndex(item => item.id === targetBlock.id)
        if (oldIndex < 0 || newIndex < 0) return
        nextPageBlocks = arrayMove(canvasBlocks, oldIndex, newIndex)
      }
    } else {
      const oldIndex = canvasBlocks.findIndex(item => item.id === block.id)
      const newIndex = oldIndex + offset
      if (oldIndex < 0 || newIndex < 0 || newIndex >= canvasBlocks.length) return
      nextPageBlocks = arrayMove(canvasBlocks, oldIndex, newIndex)
    }

    if (nextPageBlocks) {
      await persistCanvasBlockOrder(nextPageBlocks)
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

    await persistCanvasBlockOrder(arrayMove(canvasBlocks, oldIndex, newIndex))
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

  const setActivePaletteDragPayload = (payload: PaletteDragPayload | null) => {
    paletteDragPayloadRef.current = payload
    setPaletteDragPayload(payload)
  }

  const getPalettePayloadForDrag = (dataTransfer: DataTransfer) =>
    getPalettePayload(dataTransfer) || paletteDragPayloadRef.current

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
    setActivePaletteDragPayload(null)
    setPaletteInsertIndex(null)
    setPaletteSectionTarget(null)
    setPaletteDragPosition(null)
  }

  const setPaletteDragEventPosition = (event: React.DragEvent<HTMLElement>) => {
    if (event.clientX || event.clientY) {
      setPaletteDragPosition({ x: event.clientX, y: event.clientY })
    }
  }

  const isPaletteDragEvent = (event: React.DragEvent<HTMLElement>) =>
    hasDataTransferType(event.dataTransfer, 'application/ristak-block') || Boolean(paletteDragPayloadRef.current)

  const leaveCanvasPaletteDrag = () => {
    setPaletteDragging(false)
    setPaletteInsertIndex(null)
    setPaletteSectionTarget(null)
  }

  const handleCanvasDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setPaletteDragEventPosition(event)
    const payload = getPalettePayloadForDrag(event.dataTransfer)
    const placement = payload ? getPaletteDropPlacement(event, payload) : null
    const insertIndex = placement?.insertIndex ?? paletteInsertIndex ?? canvasBlocks.length
    const target = placement?.target || paletteSectionTarget
    resetPaletteDrag()
    if (!payload) return
    await handleAddBlock(payload.blockType, {
      insertIndex,
      initialSettings: payload.initialSettings,
      sectionId: target?.sectionId,
      sectionColumn: target?.sectionColumn
    })
  }

  const handleCanvasDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (isPaletteDragEvent(event)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setPaletteDragEventPosition(event)
      const payload = getPalettePayloadForDrag(event.dataTransfer)
      if (!paletteDragging) setPaletteDragging(true)
      if (payload && (
        payload.blockType !== paletteDragPayload?.blockType ||
        JSON.stringify(payload.initialSettings || {}) !== JSON.stringify(paletteDragPayload?.initialSettings || {})
      )) {
        setActivePaletteDragPayload(payload)
      }
      if (payload) {
        const placement = getPaletteDropPlacement(event, payload)
        setPaletteInsertIndex(placement.insertIndex)
        setPaletteSectionTarget(placement.target)
      }
    }
  }

  const handleCanvasDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isPaletteDragEvent(event)) return
    setPaletteDragEventPosition(event)
    const nextTarget = event.relatedTarget as Node | null
    if (nextTarget && event.currentTarget.contains(nextTarget)) return
    if (!event.clientX && !event.clientY) return

    const rect = event.currentTarget.getBoundingClientRect()
    const stillInside = event.clientX >= rect.left
      && event.clientX <= rect.right
      && event.clientY >= rect.top
      && event.clientY <= rect.bottom
    if (!stillInside) {
      leaveCanvasPaletteDrag()
    }
  }

  if (loading) {
    return <Loading page="dashboard" />
  }

  return (
    <div className={styles.pageFrame}>
      <input
        ref={importFileInputRef}
        type="file"
        accept=".html,.htm,.zip,text/html,application/zip,application/x-zip-compressed"
        className={styles.hiddenFileInput}
        onChange={handleImportHtmlFile}
      />
      <div className={`${styles.container} ${isFocusedSitesMode ? styles.containerFocused : ''} ${isCanvasFocusMode ? styles.containerEditorFocus : ''}`}>
        <header className={`${styles.header} ${editorSite ? styles.editorHeader : ''}`}>
          {editorSite ? (
            <>
              <div className={styles.editorUnifiedToolbar}>
                <div className={styles.editorToolbarTop}>
                  <div className={styles.editorToolbarLeft}>
                    <button type="button" className={styles.backButton} onClick={handleBackToLibrary}>
                      <ArrowLeft size={15} />
                      <span>Volver</span>
                    </button>
                    {editorSite.status !== 'draft' && (
                      <span className={`${styles.statusPill} ${getStatusClass(editorSite, domainConfig)}`}>{getStatusLabel(editorSite, domainConfig)}</span>
                    )}
                    <label className={`${styles.editorNameField} ${styles.editorToolbarNameField}`}>
                      <input
                        value={editorSite.name}
                        aria-label="Nombre interno del site"
                        onChange={(event) => updateSelectedSite({ name: event.target.value })}
                        onBlur={() => handleSaveSite(undefined, { silent: true })}
                      />
                    </label>
                    <button
                      type="button"
                      className={`${styles.seoToolbarButton} ${seoValidation?.totalIssues ? styles.seoToolbarButtonWarning : ''}`}
                      onClick={() => setSeoModalOpen(true)}
                      title={seoValidation?.totalIssues ? `SEO tiene ${seoValidation.totalIssues} pendientes` : 'SEO completo'}
                    >
                      <Search size={15} />
                      <span>SEO & optimizacion de busqueda</span>
                      {Boolean(seoValidation?.totalIssues) && (
                        <span className={styles.seoToolbarAlert} aria-label={`${seoValidation?.totalIssues} pendientes de SEO`}>
                          <AlertTriangle size={13} />
                          <strong>{seoValidation?.totalIssues}</strong>
                        </span>
                      )}
                    </button>
                  </div>
                  <div className={styles.editorActions}>
                    <div className={styles.editorRouteControls}>
                      {hasEditablePages(editorSite) && (
                        <FunnelPagesPanel
                          pages={pages}
                          activePageId={activePage?.id || DEFAULT_FUNNEL_PAGE_ID}
                          locked={!canManagePages(editorSite)}
                          draggingPageId={draggingPageId}
                          colorFinalPages={isStandardForm(editorSite)}
                          isFixedPage={isStandardForm(editorSite) ? isFormFinalPage : undefined}
                          canDeletePage={(page) => isStandardForm(editorSite)
                            ? !isFormFinalPage(page) && getFormContentPages(pages).length > 1
                            : pages.length > 1}
                          canDuplicatePage={(page) => !isStandardForm(editorSite) || !isFormFinalPage(page)}
                          onSelectPage={setActivePageId}
                          onAddPage={handleAddPage}
                          onDuplicatePage={handleDuplicatePage}
                          onDeletePage={handleDeletePage}
                          onDragPage={setDraggingPageId}
                          onReorderPages={handleReorderPages}
                          onRenamePage={handleRenamePage}
                        />
                      )}
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
                    </div>
                    <div className={styles.deviceToggle} role="group" aria-label="Vista previa del dispositivo">
                      <button type="button" className={device === 'desktop' ? styles.deviceActive : ''} onClick={() => setDevice('desktop')} title="Escritorio">
                        <Monitor size={15} />
                      </button>
                      <button type="button" className={device === 'mobile' ? styles.deviceActive : ''} onClick={() => setDevice('mobile')} title="Movil">
                        <Smartphone size={15} />
                      </button>
                    </div>
                    <button type="button" className={styles.editorIconAction} onClick={() => setEditorFocusMode(true)} title="Modo enfoque" aria-label="Modo enfoque">
                      <Maximize2 size={14} />
                    </button>
                    <Button variant="secondary" size="lg" onClick={handlePreviewSite}>
                      <Eye size={15} />
                      Previsualizar
                    </Button>
                    <Button variant="secondary" size="lg" onClick={() => handleSaveSite()} loading={saving}>
                      <Save size={15} />
                      Guardar
                    </Button>
                    <Button size="lg" onClick={() => handleSaveSite('published')} loading={saving}>
                      <Send size={15} />
                      Publicar
                    </Button>
                  </div>
                </div>
              </div>
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

        {editorSite && seoModalOpen && (
          <SeoOptimizationModal
            site={editorSite}
            onClose={() => setSeoModalOpen(false)}
            onPatchSite={updateSelectedSite}
            onPatchTheme={patchSiteTheme}
            onSave={() => handleSaveSite(undefined, { silent: true })}
          />
        )}

        {aiCreationModal && (
          <SitesAICreationModal
            state={aiCreationModal}
            creating={creating}
            onClose={() => {
              if (!creating) setAiCreationModal(null)
            }}
            onSubmit={handleSubmitAICreationModal}
          />
        )}

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
                aiAgentAvailable={aiAgentConfigured}
                onCreate={handleCreateSite}
                onCreateWithAI={handleCreateSiteWithAI}
                onImportHtml={handleOpenImportHtml}
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
                onPreview={(site) => void handlePreviewLibrarySite(site)}
                onUpdateRoute={handleUpdateLibraryRoute}
                onDelete={(site) => void handleDeleteSite(site)}
                domainConfig={domainConfig}
              />
            ) : editorSite ? (
              <section className={styles.builder}>
              {isCanvasFocusMode && (
                <div className={styles.focusModeBar} role="toolbar" aria-label="Controles de enfoque">
                  <button type="button" className={styles.focusExitButton} onClick={() => setEditorFocusMode(false)}>
                    <X size={16} />
                    <span>Salir de enfoque</span>
                  </button>
                  <div className={styles.deviceToggle} role="group" aria-label="Vista previa del dispositivo">
                    <button type="button" className={device === 'desktop' ? styles.deviceActive : ''} onClick={() => setDevice('desktop')} title="Escritorio" aria-label="Escritorio">
                      <Monitor size={15} />
                    </button>
                    <button type="button" className={device === 'mobile' ? styles.deviceActive : ''} onClick={() => setDevice('mobile')} title="Movil" aria-label="Movil">
                      <Smartphone size={15} />
                    </button>
                  </div>
                  <button type="button" className={styles.focusActionButton} onClick={handlePreviewSite}>
                    <Eye size={15} />
                    <span>Vista</span>
                  </button>
                  <button type="button" className={styles.focusActionButton} onClick={() => handleSaveSite()} disabled={saving}>
                    <Save size={15} />
                    <span>Guardar</span>
                  </button>
                  <button type="button" className={styles.focusPrimaryButton} onClick={() => handleSaveSite('published')} disabled={saving}>
                    <Send size={15} />
                    <span>Publicar</span>
                  </button>
                </div>
              )}
              {isImportedHtmlSite(editorSite) ? (
                <ImportedHtmlEditorPanel
                  site={editorSite}
                  pages={pages}
                  activePageId={activePage?.id || DEFAULT_FUNNEL_PAGE_ID}
                  domainConfig={domainConfig}
                  device={device}
                  saving={saving}
                  aiAgentAvailable={aiAgentConfigured}
                  importData={selectedImportData}
                  loadingImportData={loadingImportData}
                  onSelectPage={setActivePageId}
                  onPreview={handlePreviewSite}
                  onPublish={() => handleSaveSite('published')}
                  onEditWithAI={() => handleEditImportedHtmlWithAI(editorSite)}
                  onEditFields={() => void handleOpenImportMappingEditor(editorSite)}
                  onContentUpdated={handleImportedContentUpdated}
                  onUpdateRoute={handleUpdateLibraryRoute}
                  onDelete={() => void handleDeleteSite(editorSite)}
                />
              ) : (
              <div className={`${styles.builderGrid} ${isLanding(editorSite) ? styles.builderGridLanding : styles.builderGridForm}`}>
                <div className={styles.blocksRail}>
                  <Palette
	                    blockTypes={isLanding(editorSite) ? landingBlockTypes : formBlockTypes}
	                    existingBlocks={canvasBlocks}
	                    onAdd={handleAddBlock}
	                    onPaletteDragStart={(payload, position) => {
	                      setActivePaletteDragPayload(payload)
	                      setPaletteDragPosition(position)
	                      setPaletteDragging(false)
	                      setPaletteInsertIndex(null)
	                      setPaletteSectionTarget(null)
	                    }}
                    onPaletteDragMove={setPaletteDragPosition}
                    onPaletteDragEnd={resetPaletteDrag}
                  />
                </div>

                <section className={styles.canvasColumn}>
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
                        fluidAboveDesign={isLanding(editorSite) && device === 'desktop'}
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
                              <div className="rstk-form">
                                {isLanding(editorSite) ? (
                                  !hasLandingCanvasContent ? (
                                    canvasPalettePreviewBlock && isTopLevelLandingBlockType(paletteDragPayload?.blockType) ? (
                                      <PaletteInsertPreview block={canvasPalettePreviewBlock} site={editorSite} forms={forms} calendars={calendars} />
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
                                        palettePreviewBlock={canvasPalettePreviewBlock}
                                        paletteInsertIndex={paletteInsertIndex}
                                        paletteSectionTarget={paletteSectionTarget}
                                        paletteDragging={paletteDragging}
                                        onSelectBlock={setSelectedBlockId}
                                        onDeleteBlock={handleDeleteBlock}
                                        onMoveBlock={handleMoveBlock}
                                        getBlockMoveState={getBlockMoveState}
                                        onPatchBlock={patchBlockLocal}
                                        onPatchBlockSettings={patchBlockSettingsLocal}
                                        onSaveBlock={handleSaveBlock}
                                      />
                                    </>
                                  )
                                ) : canvasBlocks.length === 0 ? (
                                canvasPalettePreviewBlock ? (
                                  <PaletteInsertPreview block={canvasPalettePreviewBlock} site={editorSite} forms={forms} calendars={calendars} />
                                ) : (
                                  <div className="rstkDropEmpty">
                                    <Plus size={22} />
                                    <p>Arrastra bloques desde la barra de la izquierda o haz click para agregarlos.</p>
                                  </div>
                                )
                              ) : (
                                <>
                                  {canvasPalettePreviewBlock && paletteInsertIndex === 0 && (
                                    <PaletteInsertPreview block={canvasPalettePreviewBlock} site={editorSite} forms={forms} calendars={calendars} />
                                  )}
                                  {canvasBlocks.map((block, index) => {
                                    const moveState = getBlockMoveState(block)
                                    return (
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
                                          canMoveUp={moveState.canMoveUp}
                                          canMoveDown={moveState.canMoveDown}
                                          onSelect={() => setSelectedBlockId(block.id)}
                                          onDelete={() => handleDeleteBlock(block.id)}
                                          onMoveUp={() => handleMoveBlock(block.id, 'up')}
                                          onMoveDown={() => handleMoveBlock(block.id, 'down')}
                                          onPatchBlock={(patch) => patchBlockLocal(block.id, patch)}
                                          onPatchSettings={(patch) => patchBlockSettingsLocal(block, patch)}
                                          onSave={() => handleSaveBlock(block.id)}
                                        />
                                        {canvasPalettePreviewBlock && paletteInsertIndex === index + 1 && (
                                          <PaletteInsertPreview block={canvasPalettePreviewBlock} site={editorSite} forms={forms} calendars={calendars} />
                                        )}
                                      </React.Fragment>
                                    )
                                  })}
                                </>
                              )}
                              {formCanvasHasFields && (
                                <div className="rstk-actions">
                                  <button type="button" data-submit><SubmitButtonContent theme={editorSite.theme} label={formCanvasActionLabel} /></button>
                                </div>
                              )}
                              </div>
                            </div>
                          </main>
                        </div>
                      </CanvasStage>
                    </SortableContext>
	                    <DragOverlay dropAnimation={{ duration: 340, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
                      {activeDragBlock ? (
                        <div className={`rstkCanvas ${canvasTheme!.bodyClass}`} style={{ ...canvasTheme!.vars, width: 460, ['--rstk-scale' as string]: 1 } as React.CSSProperties}>
                          <div className={getBlockStyleClassName(activeDragBlock)} style={getBlockCanvasStyle(activeDragBlock)}>
                            <CanvasPreviewBlock block={activeDragBlock} site={editorSite} forms={forms} calendars={calendars} />
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
                  allBlocks={blocks}
                  forms={forms}
                  calendars={calendars}
                  customFields={customFields}
                  pages={pages}
                  activePageId={activePage?.id || DEFAULT_FUNNEL_PAGE_ID}
                  metaPixelConnected={metaPixelConnected}
                  connectedSocialProfiles={connectedSocialProfiles}
                  loadingSocialProfiles={loadingSocialProfiles}
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
              )}
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
        {palettePreviewBlock && paletteDragPosition && (
          <div
            className={`rstkPaletteFloatingPreview ${paletteDragging ? 'rstkPaletteFloatingPreviewCanvas' : ''}`}
            style={{ left: paletteDragPosition.x, top: paletteDragPosition.y }}
            aria-hidden="true"
          >
            <span className="rstkPaletteFloatingPreviewIcon">{blockIcons[palettePreviewBlock.blockType]}</span>
            <span>{blockLabels[palettePreviewBlock.blockType] || palettePreviewBlock.label}</span>
          </div>
        )}
        {importReview && (
          <ImportedHtmlReviewModal
            review={importReview}
            saving={savingImportMapping}
            onClose={() => setImportReview(null)}
            onConfirm={handleConfirmImportMapping}
          />
        )}
      </div>
    </div>
    </div>
  )
}

type SitesAICreationAttachment = {
  id: string
  name: string
  size: number
  text: string
}

const AI_CREATION_TEXT_ATTACHMENT_MAX_CHARS = 8000
const aiCreationTextFilePattern = /\.(txt|md|markdown|html?|css|json|csv|xml)$/i
const aiCreationAudioMimeTypes = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav'
]

const getSitesAICreationKindLabel = (siteKind: SitesAICreationKind) => {
  if (siteKind === 'interactive_form') return 'formulario interactivo'
  if (siteKind === 'form') return 'formulario'
  return 'pagina o embudo'
}

const getSitesAICreationPlaceholder = (siteKind: SitesAICreationKind, editMode: boolean) => {
  if (editMode) return 'Dime que quieres cambiar: titulo, foto principal, orden de secciones, campos, estilo, colores...'
  if (siteKind === 'form') return 'Ejemplo: formulario para agendar valoracion dental, pedir nombre, telefono, correo, tratamiento y fecha preferida...'
  if (siteKind === 'interactive_form') return 'Ejemplo: quiz de 4 pasos para calificar prospectos, con captura final de nombre y telefono...'
  return 'Ejemplo: embudo para clinica estetica con foto principal, beneficios, testimonios y formulario para agendar...'
}

const formatAICreationFileSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const makeAICreationId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const readAICreationAttachment = async (file: File): Promise<SitesAICreationAttachment> => {
  let text = ''
  if (file.type.startsWith('text/') || aiCreationTextFilePattern.test(file.name)) {
    text = (await file.text()).slice(0, AI_CREATION_TEXT_ATTACHMENT_MAX_CHARS)
  }

  return {
    id: makeAICreationId(),
    name: file.name,
    size: file.size,
    text
  }
}

const getAICreationAudioMimeType = () => {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return aiCreationAudioMimeTypes.find(mimeType => MediaRecorder.isTypeSupported(mimeType)) || ''
}

const SitesAICreationModal: React.FC<{
  state: NonNullable<SitesAICreationModalState>
  creating: boolean
  onClose: () => void
  onSubmit: (payload: SitesAICreationModalSubmit) => Promise<string | null>
}> = ({ state, creating, onClose, onSubmit }) => {
  const editMode = Boolean(state.editSite)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<SitesAICreationAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [voiceError, setVoiceError] = useState('')
  const [assistantReply, setAssistantReply] = useState('')
  const [submitError, setSubmitError] = useState('')
  const canWritePrompt = true

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          // Best effort cleanup for browser recorder state.
        }
      }
      mediaStreamRef.current?.getTracks().forEach(track => track.stop())
    }
  }, [])

  const stopVoiceStream = () => {
    mediaStreamRef.current?.getTracks().forEach(track => track.stop())
    mediaStreamRef.current = null
  }

  const appendPromptText = (text: string) => {
    const cleanText = text.trim()
    if (!cleanText) return
    setPrompt(current => current.trim() ? `${current.trim()}\n\n${cleanText}` : cleanText)
  }

  const handlePickFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return

    setAttachmentError('')
    try {
      const nextAttachments = await Promise.all(files.slice(0, 5).map(readAICreationAttachment))
      setAttachments(current => [...current, ...nextAttachments].slice(0, 5))
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'No se pudo leer el archivo.')
    }
  }

  const startVoice = async () => {
    setVoiceError('')
    setAssistantReply('')
    setSubmitError('')
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceError('Este navegador no permite grabar audio aqui.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = getAICreationAudioMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder
      voiceChunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data?.size) voiceChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const chunks = voiceChunksRef.current
        const audioBlob = new Blob(chunks, { type: mimeType || chunks[0]?.type || 'audio/webm' })
        stopVoiceStream()
        if (!audioBlob.size) {
          setVoiceState('idle')
          return
        }
        setVoiceState('transcribing')
        void aiAgentService.transcribeVoice(audioBlob)
          .then(result => {
            appendPromptText(result.text)
            setVoiceState('idle')
          })
          .catch(error => {
            setVoiceError(error instanceof Error ? error.message : 'No se pudo transcribir el audio.')
            setVoiceState('idle')
          })
      }

      recorder.start()
      setVoiceState('recording')
    } catch (error) {
      stopVoiceStream()
      setVoiceError(error instanceof Error ? error.message : 'No se pudo activar el microfono.')
      setVoiceState('idle')
    }
  }

  const stopVoice = () => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }

  const removeAttachment = (id: string) => {
    setAttachments(current => current.filter(attachment => attachment.id !== id))
  }

  const buildAttachmentNotes = () => attachments.map(attachment => [
    `Archivo: ${attachment.name} (${formatAICreationFileSize(attachment.size)})`,
    attachment.text
      ? `Contenido:\n${attachment.text}`
      : 'Usalo solo como referencia de nombre/tipo; si es imagen o PDF sin texto, crea la pagina con la descripcion del usuario.'
  ].join('\n'))

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt) {
      setSubmitError('Escribe que quieres construir primero.')
      return
    }
    setSubmitError('')
    setAssistantReply('')
    const reply = await onSubmit({
      siteKind: state.siteKind,
      prompt: cleanPrompt,
      attachmentNotes: buildAttachmentNotes(),
      editSite: state.editSite || null
    })
    if (reply) {
      setAssistantReply(reply)
      setSubmitError(editMode ? 'La IA necesita una instruccion mas clara para editar.' : 'La IA necesita un poco mas de contexto.')
    }
  }

  return (
    <div className={styles.aiCreationOverlay} role="dialog" aria-modal="true" aria-labelledby="ai-creation-title">
      <div className={`${styles.aiCreationDialog} ${creating ? styles.aiCreationDialogBusy : ''}`}>
        {creating ? (
          <div className={styles.aiCreationThinking}>
            <div className={styles.aiCreationThinkingHeader}>
              <Sparkles size={24} />
              <span>{editMode ? 'La IA esta ajustando tu pagina' : 'La IA esta creando tu pagina'}</span>
            </div>
            <div className={styles.aiCreationScan} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className={styles.aiCreationSteps}>
              <span>Armando estructura</span>
              <span>Eligiendo imagenes</span>
              <span>Preparando formularios</span>
              <span>Revisando campos</span>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <header className={styles.aiCreationHeader}>
              <div>
                <span>{editMode ? 'Editar con IA' : 'Generar con inteligencia artificial'}</span>
                <h2 id="ai-creation-title">{editMode ? 'Dime que cambio quieres' : `Crear ${getSitesAICreationKindLabel(state.siteKind)}`}</h2>
                <p>
                  {editMode
                    ? 'Ristak modifica esta pagina y vuelve a revisar sus formularios.'
                    : 'Describe la pagina y Ristak la crea como codigo propio listo para revisar.'}
                </p>
              </div>
              <button type="button" className={styles.aiCreationClose} onClick={onClose} aria-label="Cerrar">
                <X size={18} />
              </button>
            </header>

            <div className={styles.aiCreationBody}>
              <label className={styles.aiCreationPrompt}>
                <span>{editMode ? 'Cambio que quieres hacer' : 'Que quieres construir'}</span>
                <textarea
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value)
                    setAssistantReply('')
                    setSubmitError('')
                  }}
                  placeholder={getSitesAICreationPlaceholder(state.siteKind, editMode)}
                  rows={7}
                  autoFocus
                />
              </label>

              {attachments.length > 0 && (
                <div className={styles.aiCreationAttachments}>
                  {attachments.map(attachment => (
                    <span key={attachment.id}>
                      <FileText size={14} />
                      <strong>{attachment.name}</strong>
                      <small>{formatAICreationFileSize(attachment.size)}</small>
                      <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Quitar ${attachment.name}`}>
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {(assistantReply || submitError || voiceError || attachmentError) && (
                <div className={styles.aiCreationNotice}>
                  <AlertTriangle size={16} />
                  <span>{assistantReply || submitError || voiceError || attachmentError}</span>
                </div>
              )}

              <input
                ref={fileInputRef}
                className={styles.hiddenFileInput}
                type="file"
                multiple
                accept=".txt,.md,.html,.htm,.css,.json,.csv,.xml,image/*,.pdf"
                onChange={(event) => void handlePickFiles(event)}
              />
            </div>

            <footer className={styles.aiCreationFooter}>
              {canWritePrompt ? (
                <div className={styles.aiCreationToolRow}>
                  <button type="button" onClick={() => fileInputRef.current?.click()} title="Subir archivo">
                    <Paperclip size={16} />
                    <span>Archivo</span>
                  </button>
                  <button
                    type="button"
                    className={voiceState === 'recording' ? styles.aiCreationMicActive : ''}
                    onClick={() => voiceState === 'recording' ? stopVoice() : void startVoice()}
                    disabled={voiceState === 'transcribing'}
                    title={voiceState === 'recording' ? 'Detener audio' : 'Dictar con microfono'}
                  >
                    <Mic size={16} />
                    <span>{voiceState === 'recording' ? 'Grabando' : voiceState === 'transcribing' ? 'Transcribiendo' : 'Microfono'}</span>
                  </button>
                </div>
              ) : (
                <span className={styles.aiCreationFooterHint}>Primero elige una estructura.</span>
              )}
              <div className={styles.aiCreationActions}>
                <Button type="button" variant="secondary" onClick={onClose}>
                  Cancelar
                </Button>
                {canWritePrompt && (
                  <Button type="submit">
                    <Sparkles size={15} />
                    {editMode ? 'Actualizar pagina' : 'Crear pagina'}
                  </Button>
                )}
              </div>
            </footer>
          </form>
        )}
      </div>
    </div>
  )
}

type ImportedEditableSelection = {
  editId: string
  editType: ImportedEditableContentType | 'section'
  label: string
  value: string
  tagName: string
  buttonAction?: ImportedButtonAction
  buttonUrl?: string
  buttonPageId?: string
  buttonMessage?: string
}

type ImportedInlineEditorState = {
  selection: ImportedEditableSelection
  mode: 'text' | 'image'
  value: string
  top: number
  left: number
}

type ImportedButtonEditorState = {
  selection: ImportedEditableSelection
  value: string
  buttonAction: ImportedButtonAction
  buttonUrl: string
  buttonPageId: string
  buttonMessage: string
}

const importedEditableSelector = [
  '[data-rstk-edit-id]',
  '[data-ristak-edit-id]',
  '[data-ristack-edit-id]',
  '[data-rstk-editable="true"]',
  '[data-ristak-editable="true"]',
  '[data-ristack-editable="true"]'
].join(', ')

const importedSectionSelector = [
  '[data-rstk-section]',
  '[data-ristak-section]',
  '[data-ristack-section]'
].join(', ')

const editableTypeLabels: Record<ImportedEditableSelection['editType'], string> = {
  heading: 'Titulo',
  text: 'Texto',
  button: 'Boton',
  form_label: 'Texto de campo',
  placeholder: 'Texto dentro del campo',
  image: 'Imagen',
  background_image: 'Imagen de fondo',
  section: 'Seccion'
}

const importedEditableAttributeAliases = {
  id: ['data-rstk-edit-id', 'data-ristak-edit-id', 'data-ristack-edit-id'],
  type: ['data-rstk-edit-type', 'data-ristak-edit-type', 'data-ristack-edit-type'],
  label: ['data-rstk-label', 'data-ristak-label', 'data-ristack-label'],
  section: ['data-rstk-section', 'data-ristak-section', 'data-ristack-section']
}

const getImportedEditableAttribute = (element: Element, key: keyof typeof importedEditableAttributeAliases) => {
  for (const alias of importedEditableAttributeAliases[key]) {
    const value = element.getAttribute(alias)
    if (value) return value.trim()
  }
  return ''
}

const inferImportedEditableType = (element: HTMLElement): ImportedEditableContentType => {
  const tagName = element.tagName.toLowerCase()
  if (tagName === 'img') return 'image'
  if (element.getAttribute('style')?.match(/background(?:-image)?\s*:/i)) return 'background_image'
  if (tagName === 'input' || tagName === 'textarea') {
    const type = element.getAttribute('type')?.toLowerCase() || ''
    return ['button', 'submit'].includes(type) ? 'button' : 'placeholder'
  }
  if (/^h[1-6]$/.test(tagName)) return 'heading'
  if (tagName === 'label') return 'form_label'
  if (tagName === 'button') return 'button'
  return 'text'
}

const normalizeImportedEditableType = (value: string, element: HTMLElement): ImportedEditableContentType => {
  const type = value.trim().toLowerCase().replace(/[-\s]+/g, '_')
  if (['heading', 'text', 'button', 'form_label', 'placeholder', 'image', 'background_image'].includes(type)) {
    return type as ImportedEditableContentType
  }
  return inferImportedEditableType(element)
}

const extractCssBackgroundImageUrl = (styleValue: string) => {
  const match = styleValue.match(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/i)
  return (match?.[1] || match?.[2] || match?.[3] || '').trim()
}

const getEditableElementValue = (element: HTMLElement, editType: ImportedEditableSelection['editType']) => {
  const tagName = element.tagName.toLowerCase()
  if (editType === 'image' && tagName === 'img') return element.getAttribute('src') || ''
  if (editType === 'background_image') return extractCssBackgroundImageUrl(element.getAttribute('style') || '')
  if (editType === 'placeholder') return element.getAttribute('placeholder') || ''
  if (editType === 'button' && tagName === 'input') return element.getAttribute('value') || ''
  return (element.textContent || '').replace(/\s+/g, ' ').trim()
}

const importedButtonActions = new Set<ImportedButtonAction>(['none', 'url', 'next_page', 'specific_page', 'submit', 'disqualify'])

const normalizeImportedButtonAction = (value: string): ImportedButtonAction => {
  const action = value.trim().toLowerCase().replace(/[-\s]+/g, '_') as ImportedButtonAction
  return importedButtonActions.has(action) ? action : 'none'
}

const getImportedButtonAttribute = (element: HTMLElement, names: string[]) => {
  for (const name of names) {
    const value = element.getAttribute(name)
    if (value) return value.trim()
  }
  return ''
}

const readImportedButtonSettings = (element: HTMLElement, editType: ImportedEditableSelection['editType']) => {
  if (editType !== 'button') return {}

  const tagName = element.tagName.toLowerCase()
  const explicitAction = getImportedButtonAttribute(element, [
    'data-rstk-button-action',
    'data-ristak-button-action',
    'data-ristack-button-action',
    'data-rstk-action',
    'data-ristak-action',
    'data-ristack-action'
  ])
  const href = tagName === 'a' ? (element.getAttribute('href') || '').trim() : ''
  const type = (element.getAttribute('type') || '').trim().toLowerCase()
  const inferredAction = explicitAction
    ? normalizeImportedButtonAction(explicitAction)
    : tagName === 'a' && href && !href.startsWith('#')
      ? 'url'
      : ['submit', 'image'].includes(type)
        ? 'submit'
        : 'none'

  return {
    buttonAction: inferredAction,
    buttonUrl: getImportedButtonAttribute(element, ['data-rstk-button-url', 'data-ristak-button-url', 'data-ristack-button-url']) || (inferredAction === 'url' ? href : ''),
    buttonPageId: getImportedButtonAttribute(element, ['data-rstk-button-page-id', 'data-ristak-button-page-id', 'data-ristack-button-page-id']),
    buttonMessage: getImportedButtonAttribute(element, ['data-rstk-button-message', 'data-ristak-button-message', 'data-ristack-button-message'])
  }
}

const readImportedEditableSelection = (element: HTMLElement): ImportedEditableSelection | null => {
  const editId = getImportedEditableAttribute(element, 'id')
  if (!editId) return null
  const editType = normalizeImportedEditableType(getImportedEditableAttribute(element, 'type'), element)
  const label = getImportedEditableAttribute(element, 'label') || editableTypeLabels[editType]
  return {
    editId,
    editType,
    label,
    value: getEditableElementValue(element, editType),
    tagName: element.tagName.toLowerCase(),
    ...readImportedButtonSettings(element, editType)
  }
}

const ImportedHtmlEditorPanel: React.FC<{
  site: PublicSite
  pages: SitePage[]
  activePageId: string
  domainConfig: SitesDomainConfig
  device: DeviceMode
  saving: boolean
  aiAgentAvailable: boolean
  importData: ImportedSiteImport | null
  loadingImportData: boolean
  onSelectPage: (pageId: string) => void
  onPreview: () => void
  onPublish: () => void
  onEditWithAI: () => void
  onEditFields: () => void
  onContentUpdated: (result: ImportedSiteCreateResult) => void
  onUpdateRoute: (site: PublicSite, route: string) => Promise<void>
  onDelete: () => void
}> = ({
  site,
  pages,
  activePageId,
  domainConfig,
  device,
  saving,
  aiAgentAvailable,
  importData,
  loadingImportData,
  onSelectPage,
  onPreview,
  onPublish,
  onEditWithAI,
  onEditFields,
  onContentUpdated,
  onUpdateRoute,
  onDelete
}) => {
  const { showToast } = useNotification()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const selectedIframeElementRef = useRef<HTMLElement | null>(null)
  const inlineImageFileInputRef = useRef<HTMLInputElement | null>(null)
  const [routeEditing, setRouteEditing] = useState(false)
  const [routeDraft, setRouteDraft] = useState(getRouteEditorValue(site))
  const [routeSaving, setRouteSaving] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [previewLoading, setPreviewLoading] = useState(true)
  const [previewError, setPreviewError] = useState('')
  const [previewVersion, setPreviewVersion] = useState(0)
  const [inlineEditor, setInlineEditor] = useState<ImportedInlineEditorState | null>(null)
  const [buttonEditor, setButtonEditor] = useState<ImportedButtonEditorState | null>(null)
  const [contentSaving, setContentSaving] = useState(false)
  const [contentError, setContentError] = useState('')
  const importedPages = pages.length ? pages : [{ id: DEFAULT_FUNNEL_PAGE_ID, title: 'Pagina 1', sortOrder: 0 }]
  const activeImportedPage = importedPages.find(page => page.id === activePageId) || importedPages[0]
  const mappingStats = useMemo(() => {
    const formMappings = Array.isArray(importData?.formMappings) ? importData.formMappings : []
    const fields = formMappings.flatMap(form => Array.isArray(form.fields) ? form.fields : [])
    return {
      forms: formMappings.length,
      fields: fields.length,
      routed: fields.filter(field => !field.ignored && field.destinationType !== 'ignored').length,
      standard: fields.filter(field => !field.ignored && field.destinationType === 'standard').length,
      custom: fields.filter(field => !field.ignored && field.destinationType === 'custom').length,
      ignored: fields.filter(field => field.ignored || field.destinationType === 'ignored').length
    }
  }, [importData])

  useEffect(() => {
    if (!routeEditing) setRouteDraft(getRouteEditorValue(site))
  }, [routeEditing, site.id, site.slug])

  const loadInlinePreview = useCallback(async () => {
    setPreviewLoading(true)
    setPreviewError('')
    try {
      const html = await sitesService.getPreviewHtml(site.id, activeImportedPage?.id, { test: true })
      setPreviewHtml(html)
      setPreviewVersion(current => current + 1)
    } catch (error) {
      setPreviewHtml('')
      setPreviewError(error instanceof Error ? error.message : 'No se pudo cargar la vista previa')
    } finally {
      setPreviewLoading(false)
    }
  }, [activeImportedPage?.id, site.id, site.updatedAt])

  useEffect(() => {
    void loadInlinePreview()
  }, [loadInlinePreview])

  useEffect(() => {
    selectedIframeElementRef.current?.classList.remove('rstk-imported-selected')
    selectedIframeElementRef.current = null
    setInlineEditor(null)
    setButtonEditor(null)
    setContentError('')
  }, [activeImportedPage?.id, site.id, previewVersion])

  const getInlineEditorPosition = useCallback((element: HTMLElement) => {
    const iframe = iframeRef.current
    const iframeRect = iframe?.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    const rawLeft = (iframeRect?.left || 0) + elementRect.left + 10
    const rawTop = (iframeRect?.top || 0) + elementRect.top + 10
    return {
      left: Math.min(Math.max(rawLeft, 16), Math.max(16, window.innerWidth - 360)),
      top: Math.min(Math.max(rawTop, 16), Math.max(16, window.innerHeight - 220))
    }
  }, [])

  const openInlineEditorForElement = useCallback((element: HTMLElement, selection: ImportedEditableSelection, mode: 'text' | 'image') => {
    const position = getInlineEditorPosition(element)
    setInlineEditor({
      selection,
      mode,
      value: selection.value,
      ...position
    })
    setContentError('')
  }, [getInlineEditorPosition])

  const openButtonEditorForSelection = useCallback((selection: ImportedEditableSelection) => {
    setInlineEditor(null)
    setButtonEditor({
      selection,
      value: selection.value,
      buttonAction: selection.buttonAction || 'none',
      buttonUrl: selection.buttonUrl || '',
      buttonPageId: selection.buttonPageId || '',
      buttonMessage: selection.buttonMessage || ''
    })
    setContentError('')
  }, [])

  const clearInlineSelection = useCallback(() => {
    selectedIframeElementRef.current?.classList.remove('rstk-imported-selected')
    selectedIframeElementRef.current = null
    setInlineEditor(null)
    setButtonEditor(null)
  }, [])

  const saveEditableContent = useCallback(async (
    selection: ImportedEditableSelection,
    value: string,
    fileUpload?: { fileBase64: string; filename: string },
    buttonPatch?: {
      buttonAction?: ImportedButtonAction
      buttonUrl?: string
      buttonPageId?: string
      buttonMessage?: string
    }
  ) => {
    if (selection.editType === 'section') return false
    const cleanValue = value.trim()
    if (!cleanValue && !fileUpload) {
      setContentError('Escribe el nuevo contenido antes de guardar.')
      return false
    }

    setContentSaving(true)
    setContentError('')
    try {
      const result = await sitesService.updateImportedContent(site.id, {
        editId: selection.editId,
        editType: selection.editType,
        value: cleanValue || selection.value,
        ...(fileUpload || {}),
        ...(buttonPatch || {})
      })
      onContentUpdated(result)
      clearInlineSelection()
      await loadInlinePreview()
      showToast('success', 'Cambio guardado', 'La pagina conserva formularios, campos y tracking.')
      return true
    } catch (error) {
      setContentError(error instanceof Error ? error.message : 'No se pudo guardar el cambio')
      return false
    } finally {
      setContentSaving(false)
    }
  }, [clearInlineSelection, loadInlinePreview, onContentUpdated, showToast, site.id])

  useEffect(() => {
    if (previewLoading || !previewHtml) return
    const iframe = iframeRef.current
    if (!iframe) return

    let cleanupDocument = () => {}
    let cancelled = false
    const installEditorHooks = () => {
      if (cancelled) return
      cleanupDocument()
      const doc = iframe.contentDocument
      if (!doc) return

      const style = doc.createElement('style')
      style.setAttribute('data-rstk-imported-editor-overlay', 'true')
      style.textContent = `
        ${importedEditableSelector} {
          cursor: pointer !important;
          outline: 1px dashed rgba(100, 116, 139, 0.34) !important;
          outline-offset: 4px !important;
          border-radius: 4px !important;
          box-shadow: none !important;
          transition: outline-color 140ms ease, box-shadow 140ms ease !important;
        }
        ${importedEditableSelector}:hover {
          outline: 1px solid rgba(71, 85, 105, 0.72) !important;
          border-radius: 4px !important;
          box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.12) !important;
        }
        ${importedSectionSelector} {
          scroll-margin: 40px !important;
        }
        .rstk-imported-selected {
          outline: 2px solid #16a34a !important;
          border-radius: 6px !important;
          box-shadow: 0 0 0 5px rgba(22, 163, 74, 0.16) !important;
        }
        .rstk-imported-editing {
          cursor: text !important;
          outline: 2px solid #16a34a !important;
          border-radius: 6px !important;
          background: rgba(34, 197, 94, 0.08) !important;
          box-shadow: 0 0 0 5px rgba(34, 197, 94, 0.16) !important;
        }
        .rstk-imported-image-action {
          position: fixed !important;
          z-index: 2147483647 !important;
          display: inline-flex !important;
          align-items: center !important;
          gap: 7px !important;
          min-height: 34px !important;
          border: 1px solid rgba(21, 128, 61, 0.22) !important;
          border-radius: 8px !important;
          background: #ffffff !important;
          color: #166534 !important;
          padding: 0 11px !important;
          font: 800 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
          box-shadow: 0 14px 36px rgba(15, 23, 42, 0.22) !important;
          cursor: pointer !important;
        }
      `
      doc.head?.appendChild(style)

      let imageActionButton: HTMLButtonElement | null = null

      const removeImageActionButton = () => {
        imageActionButton?.remove()
        imageActionButton = null
      }

      const selectElement = (element: HTMLElement) => {
        selectedIframeElementRef.current?.classList.remove('rstk-imported-selected')
        selectedIframeElementRef.current = element
        element.classList.add('rstk-imported-selected')
      }

      const beginTextEdit = (element: HTMLElement, selection: ImportedEditableSelection) => {
        const originalValue = selection.value
        setInlineEditor(null)
        setContentError('')
        element.classList.add('rstk-imported-editing')
        element.setAttribute('contenteditable', 'plaintext-only')
        element.setAttribute('spellcheck', 'true')
        element.focus({ preventScroll: true })

        const frameSelection = doc.defaultView?.getSelection()
        if (frameSelection) {
          const range = doc.createRange()
          range.selectNodeContents(element)
          frameSelection.removeAllRanges()
          frameSelection.addRange(range)
        }

        let done = false
        const cleanupTextEdit = (save: boolean) => {
          if (done) return
          done = true
          element.removeEventListener('blur', handleBlur)
          element.removeEventListener('keydown', handleKeydown)
          element.removeAttribute('contenteditable')
          element.removeAttribute('spellcheck')
          element.classList.remove('rstk-imported-editing')
          const nextValue = (element.textContent || '').replace(/\s+/g, ' ').trim()
          if (!save) {
            element.textContent = originalValue
            return
          }
          if (nextValue && nextValue !== originalValue.trim()) {
            void saveEditableContent(selection, nextValue)
          }
        }

        const handleBlur = () => cleanupTextEdit(true)
        const handleKeydown = (keyboardEvent: KeyboardEvent) => {
          if (keyboardEvent.key === 'Escape') {
            keyboardEvent.preventDefault()
            cleanupTextEdit(false)
            return
          }
          if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey) {
            keyboardEvent.preventDefault()
            element.blur()
          }
        }

        element.addEventListener('blur', handleBlur)
        element.addEventListener('keydown', handleKeydown)
      }

      const showImageActionButton = (element: HTMLElement, selection: ImportedEditableSelection) => {
        removeImageActionButton()
        const rect = element.getBoundingClientRect()
        imageActionButton = doc.createElement('button')
        imageActionButton.type = 'button'
        imageActionButton.className = 'rstk-imported-image-action'
        imageActionButton.textContent = 'Cambiar imagen'
        imageActionButton.style.left = `${Math.max(8, rect.left + 8)}px`
        imageActionButton.style.top = `${Math.max(8, rect.top + 8)}px`
        imageActionButton.addEventListener('click', (buttonEvent) => {
          buttonEvent.preventDefault()
          buttonEvent.stopPropagation()
          selectElement(element)
          openInlineEditorForElement(element, selection, 'image')
        })
        doc.body.appendChild(imageActionButton)
      }

      const handleFrameMouseOver = (event: MouseEvent) => {
        const target = event.target as Element | null
        if (!target || typeof target.closest !== 'function') return
        const editableElement = target.closest(importedEditableSelector) as HTMLElement | null
        if (!editableElement) return
        const selection = readImportedEditableSelection(editableElement)
        if (!selection) return
        if (selection.editType === 'image' || selection.editType === 'background_image') {
          showImageActionButton(editableElement, selection)
        }
      }

      const handleFrameClick = (event: MouseEvent) => {
        const target = event.target as Element | null
        if (!target || typeof target.closest !== 'function') return

        const editableElement = target.closest(importedEditableSelector) as HTMLElement | null
        if (editableElement) {
          const selection = readImportedEditableSelection(editableElement)
          if (!selection) return
          event.preventDefault()
          event.stopPropagation()
          selectElement(editableElement)
          removeImageActionButton()
          if (selection.editType === 'image' || selection.editType === 'background_image') {
            setButtonEditor(null)
            openInlineEditorForElement(editableElement, selection, 'image')
          } else if (selection.editType === 'button') {
            openButtonEditorForSelection(selection)
          } else if (selection.editType === 'placeholder') {
            setButtonEditor(null)
            openInlineEditorForElement(editableElement, selection, 'text')
          } else {
            setButtonEditor(null)
            beginTextEdit(editableElement, selection)
          }
          return
        }

        const sectionElement = target.closest(importedSectionSelector) as HTMLElement | null
        if (sectionElement) {
          event.preventDefault()
          event.stopPropagation()
          selectElement(sectionElement)
          setInlineEditor(null)
          setButtonEditor(null)
          setContentError('')
          removeImageActionButton()
          return
        }

        clearInlineSelection()
        removeImageActionButton()
      }

      doc.addEventListener('mouseover', handleFrameMouseOver, true)
      doc.addEventListener('click', handleFrameClick, true)
      cleanupDocument = () => {
        doc.removeEventListener('mouseover', handleFrameMouseOver, true)
        doc.removeEventListener('click', handleFrameClick, true)
        removeImageActionButton()
        style.remove()
      }
    }

    iframe.addEventListener('load', installEditorHooks)
    const installTimeout = window.setTimeout(installEditorHooks, 0)

    return () => {
      cancelled = true
      window.clearTimeout(installTimeout)
      iframe.removeEventListener('load', installEditorHooks)
      cleanupDocument()
    }
  }, [clearInlineSelection, openButtonEditorForSelection, openInlineEditorForElement, previewHtml, previewLoading, previewVersion, saveEditableContent])

  const routeValue = getRouteEditorValue(site)
  const saveRoute = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextRoute = normalizeRouteEditorInput(routeDraft, domainConfig) || getDefaultRoutePrefix(site.siteType)
    if (nextRoute === routeValue) {
      setRouteDraft(routeValue)
      setRouteEditing(false)
      return
    }

    setRouteSaving(true)
    try {
      await onUpdateRoute(site, nextRoute)
      setRouteEditing(false)
    } finally {
      setRouteSaving(false)
    }
  }

  const saveInlineEditor = async () => {
    if (!inlineEditor || inlineEditor.selection.editType === 'section') return
    await saveEditableContent(inlineEditor.selection, inlineEditor.value)
  }

  const handleInlineImageFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !inlineEditor || inlineEditor.mode !== 'image') return

    if (!file.type.startsWith('image/')) {
      setContentError('Sube una imagen valida.')
      return
    }

    try {
      const fileBase64 = await fileToBase64(file)
      await saveEditableContent(inlineEditor.selection, inlineEditor.value, {
        fileBase64,
        filename: file.name
      })
    } catch (error) {
      setContentError(error instanceof Error ? error.message : 'No se pudo leer la imagen.')
    }
  }

  const targetImportedPages = importedPages.filter(page => page.id !== activeImportedPage?.id)
  const buttonEditorNeedsUrl = buttonEditor?.buttonAction === 'url'
  const buttonEditorNeedsPage = buttonEditor?.buttonAction === 'specific_page'
  const canSaveButtonEditor = Boolean(
    buttonEditor &&
    buttonEditor.value.trim() &&
    !contentSaving &&
    (!buttonEditorNeedsUrl || buttonEditor.buttonUrl.trim()) &&
    (!buttonEditorNeedsPage || buttonEditor.buttonPageId.trim())
  )

  const saveButtonEditor = async () => {
    if (!buttonEditor || buttonEditor.selection.editType !== 'button') return
    await saveEditableContent(buttonEditor.selection, buttonEditor.value, undefined, {
      buttonAction: buttonEditor.buttonAction,
      buttonUrl: buttonEditor.buttonUrl.trim(),
      buttonPageId: buttonEditor.buttonPageId.trim(),
      buttonMessage: buttonEditor.buttonMessage.trim()
    })
  }

  const canSaveInlineEditor = Boolean(
    inlineEditor &&
    inlineEditor.selection.editType !== 'section' &&
    inlineEditor.value.trim() &&
    inlineEditor.value.trim() !== inlineEditor.selection.value.trim() &&
    !contentSaving
  )

  return (
    <div className={styles.importedEditorPanel}>
      <section className={styles.importedPreviewPane}>
        <div className={styles.importedPreviewToolbar}>
          <div>
            <span>Vista editable</span>
            <strong>{site.title || site.name}</strong>
          </div>
          <div className={styles.importedPreviewTools}>
            <span>{device === 'mobile' ? 'Movil' : 'Escritorio'}</span>
            <button
              type="button"
              className={styles.importedPreviewRefresh}
              onClick={() => void loadInlinePreview()}
              disabled={previewLoading}
              title="Recargar vista previa"
              aria-label="Recargar vista previa"
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </div>

        <div className={`${styles.importedPreviewStage} ${device === 'mobile' ? styles.importedPreviewStageMobile : ''}`}>
          {previewLoading && (
            <div className={styles.importedPreviewState}>
              <RefreshCw size={18} />
              <span>Cargando vista previa...</span>
            </div>
          )}
          {!previewLoading && previewError && (
            <div className={styles.importedPreviewState}>
              <AlertTriangle size={18} />
              <span>{previewError}</span>
            </div>
          )}
          {!previewLoading && !previewError && previewHtml && (
            <iframe
              ref={iframeRef}
              key={`${site.id}-${activeImportedPage?.id || DEFAULT_FUNNEL_PAGE_ID}-${previewVersion}-${device}`}
              className={styles.importedPreviewFrame}
              title={`Vista previa de ${activeImportedPage?.title || site.name}`}
              srcDoc={previewHtml}
              sandbox="allow-same-origin"
              referrerPolicy="no-referrer-when-downgrade"
            />
          )}
          {!previewLoading && !previewError && !previewHtml && (
            <div className={styles.importedPreviewState}>
              <FileText size={18} />
              <span>La vista previa todavia no tiene contenido.</span>
            </div>
          )}
        </div>
        {contentError && (
          <div className={styles.importedInlineError}>
            <AlertTriangle size={15} />
            <span>{contentError}</span>
          </div>
        )}
      </section>

      <aside className={styles.importedSidePanel}>
        <div className={styles.importedSidePanelActions}>
          {aiAgentAvailable && (
            <Button type="button" variant="secondary" onClick={onEditWithAI} disabled={saving}>
              <Sparkles size={15} />
              Modificar con IA
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onEditFields} disabled={loadingImportData}>
            {loadingImportData ? <RefreshCw size={15} /> : <Settings2 size={15} />}
            Editar ruta de datos
          </Button>
        </div>

        {buttonEditor && (
          <div className={styles.importedButtonActionBox}>
            <div className={styles.importedButtonActionHeader}>
              <MousePointerClick size={17} />
              <div>
                <span>Boton seleccionado</span>
                <strong>{buttonEditor.selection.label || 'Boton'}</strong>
              </div>
            </div>

            <label className={styles.importedActionField}>
              <span>Texto del boton</span>
              <input
                value={buttonEditor.value}
                disabled={contentSaving}
                onChange={(event) => setButtonEditor(current => current ? { ...current, value: event.target.value } : current)}
              />
            </label>

            <label className={styles.importedActionField}>
              <span>Accion</span>
              <select
                value={buttonEditor.buttonAction}
                disabled={contentSaving}
                onChange={(event) => setButtonEditor(current => current ? {
                  ...current,
                  buttonAction: event.target.value as ImportedButtonAction
                } : current)}
              >
                <option value="none">Solo dejarlo como texto</option>
                <option value="submit">Enviar formulario</option>
                <option value="next_page">Ir a la siguiente pagina</option>
                <option value="specific_page">Ir a una pagina especifica</option>
                <option value="url">Abrir enlace</option>
                <option value="disqualify">Descalificar / detener</option>
              </select>
            </label>

            {buttonEditor.buttonAction === 'url' && (
              <label className={styles.importedActionField}>
                <span>Enlace</span>
                <input
                  value={buttonEditor.buttonUrl}
                  placeholder="https://..."
                  disabled={contentSaving}
                  onChange={(event) => setButtonEditor(current => current ? { ...current, buttonUrl: event.target.value } : current)}
                />
              </label>
            )}

            {buttonEditor.buttonAction === 'specific_page' && (
              <label className={styles.importedActionField}>
                <span>Pagina destino</span>
                <select
                  value={buttonEditor.buttonPageId}
                  disabled={contentSaving}
                  onChange={(event) => setButtonEditor(current => current ? { ...current, buttonPageId: event.target.value } : current)}
                >
                  <option value="">Selecciona una pagina</option>
                  {targetImportedPages.map(page => (
                    <option key={page.id} value={page.id}>{page.title || page.id}</option>
                  ))}
                </select>
              </label>
            )}

            {buttonEditor.buttonAction === 'disqualify' && (
              <label className={styles.importedActionField}>
                <span>Mensaje</span>
                <textarea
                  rows={3}
                  value={buttonEditor.buttonMessage}
                  placeholder="Gracias. Por ahora esta solicitud no califica."
                  disabled={contentSaving}
                  onChange={(event) => setButtonEditor(current => current ? { ...current, buttonMessage: event.target.value } : current)}
                />
              </label>
            )}

            <div className={styles.importedButtonActionFooter}>
              <Button type="button" variant="secondary" size="sm" onClick={clearInlineSelection} disabled={contentSaving}>
                Cancelar
              </Button>
              <Button type="button" size="sm" onClick={() => void saveButtonEditor()} disabled={!canSaveButtonEditor} loading={contentSaving}>
                <Save size={14} />
                Guardar boton
              </Button>
            </div>
          </div>
        )}
      </aside>

      <input
        ref={inlineImageFileInputRef}
        className={styles.hiddenFileInput}
        type="file"
        accept="image/*"
        onChange={(event) => void handleInlineImageFile(event)}
      />
      {inlineEditor && (
        <div
          className={styles.importedInlineEditor}
          style={{ top: inlineEditor.top, left: inlineEditor.left }}
          role="dialog"
          aria-label={inlineEditor.mode === 'image' ? 'Cambiar imagen' : 'Editar texto'}
        >
          <div className={styles.importedInlineEditorHeader}>
            <span>{inlineEditor.mode === 'image' ? 'Cambiar imagen' : editableTypeLabels[inlineEditor.selection.editType]}</span>
            <button type="button" onClick={clearInlineSelection} aria-label="Cerrar editor rapido">
              <X size={14} />
            </button>
          </div>
          {inlineEditor.mode === 'image' ? (
            <>
              <input
                value={inlineEditor.value}
                onChange={(event) => setInlineEditor(current => current ? { ...current, value: event.target.value } : current)}
                placeholder="https://..."
                disabled={contentSaving}
              />
              <div className={styles.importedInlineEditorActions}>
                <Button type="button" variant="secondary" size="sm" onClick={() => inlineImageFileInputRef.current?.click()} disabled={contentSaving}>
                  <Upload size={14} />
                  Subir foto
                </Button>
                <Button type="button" size="sm" onClick={() => void saveInlineEditor()} disabled={!canSaveInlineEditor} loading={contentSaving}>
                  <Save size={14} />
                  Guardar URL
                </Button>
              </div>
            </>
          ) : (
            <>
              <textarea
                rows={inlineEditor.selection.editType === 'placeholder' || inlineEditor.selection.editType === 'button' ? 2 : 4}
                value={inlineEditor.value}
                onChange={(event) => setInlineEditor(current => current ? { ...current, value: event.target.value } : current)}
                disabled={contentSaving}
              />
              <div className={styles.importedInlineEditorActions}>
                <Button type="button" variant="secondary" size="sm" onClick={clearInlineSelection} disabled={contentSaving}>
                  Cancelar
                </Button>
                <Button type="button" size="sm" onClick={() => void saveInlineEditor()} disabled={!canSaveInlineEditor} loading={contentSaving}>
                  <Save size={14} />
                  Guardar
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const importedStandardFieldOptions = [
  { value: 'full_name', label: 'Nombre completo' },
  { value: 'first_name', label: 'Nombre' },
  { value: 'last_name', label: 'Apellido' },
  { value: 'email', label: 'Correo electronico' },
  { value: 'phone', label: 'Telefono / WhatsApp' },
  { value: 'message', label: 'Mensaje o nota' }
]

const normalizeImportedDestinationKey = (value: string, fallback: string) =>
  (value || fallback || 'campo_personalizado')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'campo_personalizado'

const importedStandardFieldAliases: Record<string, string[]> = {
  email: [
    'email',
    'e_mail',
    'emailaddress',
    'email_address',
    'mail',
    'correo',
    'correo_electronico',
    'correoelectronico',
    'correo_contacto',
    'contact_email',
    'customer_email',
    'client_email',
    'lead_email',
    'tu_email'
  ],
  phone: [
    'phone',
    'phone_number',
    'phonenumber',
    'phone_no',
    'tel',
    'telephone',
    'telefono',
    'numero_telefono',
    'numero_de_telefono',
    'telefono_contacto',
    'numero_contacto',
    'contact_phone',
    'contact_number',
    'contacto',
    'contact',
    'mobile',
    'mobile_phone',
    'mobile_number',
    'movil',
    'cel',
    'cell',
    'cellphone',
    'cell_phone',
    'celular',
    'numero_celular',
    'whatsapp',
    'whats_app',
    'whatsapp_number',
    'whatsapp_phone',
    'numero_whatsapp',
    'wpp',
    'wa'
  ],
  first_name: [
    'first_name',
    'firstname',
    'first',
    'fname',
    'given_name',
    'givenname',
    'forename',
    'nombre',
    'nombres',
    'primer_nombre',
    'nombre_1',
    'name_first',
    'contact_first_name',
    'customer_first_name',
    'client_first_name',
    'lead_first_name',
    'tu_nombre'
  ],
  last_name: [
    'last_name',
    'lastname',
    'last',
    'lname',
    'surname',
    'family_name',
    'familyname',
    'apellido',
    'apellidos',
    'primer_apellido',
    'segundo_apellido',
    'apellido_paterno',
    'apellido_materno',
    'name_last',
    'contact_last_name',
    'customer_last_name',
    'client_last_name',
    'lead_last_name'
  ],
  full_name: [
    'full_name',
    'fullname',
    'complete_name',
    'name',
    'nombre_completo',
    'nombre_y_apellido',
    'nombre_y_apellidos',
    'nombre_apellido',
    'nombre_apellidos',
    'contact_name',
    'customer_name',
    'client_name',
    'lead_name',
    'person_name',
    'nombre_contacto',
    'nombre_cliente',
    'your_name'
  ],
  message: [
    'message',
    'mensaje',
    'comments',
    'comment',
    'comentario',
    'comentarios',
    'observacion',
    'observaciones',
    'notes',
    'note',
    'nota',
    'notas',
    'details',
    'detalle',
    'detalles',
    'description',
    'descripcion'
  ]
}

const hasImportedStandardAlias = (text: string, aliases: string[]) =>
  aliases.some(alias => {
    const normalized = normalizeImportedDestinationKey(alias, '')
    if (!normalized) return false
    return new RegExp(`(?:^|\\s)${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(text)
  })

const inferImportedStandardKey = (field: ImportedSiteFieldMapping) => {
  const current = normalizeImportedDestinationKey(field.destinationKey, '')
  if (importedStandardFieldOptions.some(option => option.value === current)) return current
  const type = normalizeImportedDestinationKey(field.type, '')
  const text = [
    field.type,
    field.sourceName,
    field.label
  ].map(value => normalizeImportedDestinationKey(value || '', '')).filter(Boolean).join(' ')
  if (type === 'email') return 'email'
  if (type === 'tel') return 'phone'
  if (hasImportedStandardAlias(text, importedStandardFieldAliases.email)) return 'email'
  if (hasImportedStandardAlias(text, importedStandardFieldAliases.phone)) return 'phone'
  if (hasImportedStandardAlias(text, importedStandardFieldAliases.last_name)) return 'last_name'
  if (hasImportedStandardAlias(text, importedStandardFieldAliases.first_name)) return 'first_name'
  if (hasImportedStandardAlias(text, importedStandardFieldAliases.full_name)) return 'full_name'
  if (hasImportedStandardAlias(text, importedStandardFieldAliases.message)) return 'message'
  return 'full_name'
}

const cloneImportedFormMappings = (mappings: ImportedSiteFormMapping[]) =>
  mappings.map(form => ({
    ...form,
    fields: form.fields.map(field => ({ ...field }))
  }))

const ImportedHtmlReviewModal: React.FC<{
  review: ImportReviewState
  saving: boolean
  onClose: () => void
  onConfirm: (formMappings: ImportedSiteFormMapping[]) => void
}> = ({ review, saving, onClose, onConfirm }) => {
  const [draft, setDraft] = useState<ImportedSiteFormMapping[]>(() => cloneImportedFormMappings(review.importData.formMappings || []))

  useEffect(() => {
    setDraft(cloneImportedFormMappings(review.importData.formMappings || []))
  }, [review.importData])

  const patchField = (formIndex: number, fieldIndex: number, patch: Partial<ImportedSiteFieldMapping>) => {
    setDraft(current => current.map((form, currentFormIndex) => {
      if (currentFormIndex !== formIndex) return form
      return {
        ...form,
        fields: form.fields.map((field, currentFieldIndex) => (
          currentFieldIndex === fieldIndex ? { ...field, ...patch } : field
        ))
      }
    }))
  }

  const updateDestinationType = (formIndex: number, fieldIndex: number, field: ImportedSiteFieldMapping, destinationType: ImportedSiteFieldMapping['destinationType']) => {
    const nextKey = destinationType === 'standard'
      ? inferImportedStandardKey(field)
      : destinationType === 'custom'
        ? normalizeImportedDestinationKey(field.destinationKey || field.sourceName || field.label, 'campo_personalizado')
        : field.destinationKey
    patchField(formIndex, fieldIndex, {
      destinationType,
      ignored: destinationType === 'ignored',
      saveMode: destinationType,
      destinationKey: nextKey
    })
  }

  return (
    <div className={styles.importReviewOverlay} role="dialog" aria-modal="true" aria-labelledby="import-review-title">
      <div className={styles.importReviewDialog}>
        <header className={styles.importReviewHeader}>
          <div>
            <span>Ruta de datos</span>
            <h2 id="import-review-title">Enruta los campos del formulario</h2>
            <p>Ristak ya lo hace automatico; aqui puedes ajustar donde se guarda cada dato de {review.importData.originalFilename || review.site.name}.</p>
          </div>
          <button type="button" className={styles.importReviewClose} onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </header>

        {review.importData.securityReport?.length > 0 && (
          <div className={styles.importSecurityNote}>
            <AlertTriangle size={16} />
            <span>Se limpiaron partes inseguras del archivo antes de publicarlo.</span>
          </div>
        )}

        <div className={styles.importReviewForms}>
          {draft.length === 0 ? (
            <div className={styles.importEmptyFields}>
              <CheckCircle2 size={20} />
              <p>No encontramos formularios en este HTML. Puedes previsualizarlo y publicarlo como pagina informativa.</p>
            </div>
          ) : draft.map((form, formIndex) => (
            <section key={form.formId || formIndex} className={styles.importFormSection}>
              <div className={styles.importFormHeader}>
                <strong>{form.formTitle || `Formulario ${formIndex + 1}`}</strong>
                <span>{form.fields.length} campos detectados</span>
              </div>
              <div className={styles.importFieldList}>
                {form.fields.map((field, fieldIndex) => {
                  const destinationType = field.ignored ? 'ignored' : field.destinationType || 'custom'
                  return (
                    <div key={`${field.fieldId}-${fieldIndex}`} className={styles.importFieldRow}>
                      <div className={styles.importFieldSource}>
                        <strong>{field.label || field.sourceName || `Campo ${fieldIndex + 1}`}</strong>
                        <span>{field.sourceName || field.fieldId}</span>
                      </div>
                      <label>
                        <span>Guardar como</span>
                        <select
                          value={destinationType}
                          onChange={(event) => updateDestinationType(
                            formIndex,
                            fieldIndex,
                            field,
                            event.target.value as ImportedSiteFieldMapping['destinationType']
                          )}
                        >
                          <option value="standard">Dato del contacto</option>
                          <option value="custom">Campo personalizado</option>
                          <option value="ignored">No guardar</option>
                        </select>
                      </label>
                      {destinationType === 'standard' ? (
                        <label>
                          <span>Dato</span>
                          <select
                            value={field.destinationKey || inferImportedStandardKey(field)}
                            onChange={(event) => patchField(formIndex, fieldIndex, {
                              destinationKey: event.target.value,
                              ignored: false
                            })}
                          >
                            {importedStandardFieldOptions.map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <label>
                          <span>Nombre interno</span>
                          <input
                            value={field.destinationKey || ''}
                            disabled={destinationType === 'ignored'}
                            placeholder="campo_personalizado"
                            onChange={(event) => patchField(formIndex, fieldIndex, {
                              destinationKey: normalizeImportedDestinationKey(event.target.value, field.sourceName || field.label)
                            })}
                          />
                        </label>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>

        <footer className={styles.importReviewFooter}>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cerrar
          </Button>
          <Button onClick={() => onConfirm(draft)} loading={saving}>
            <Check size={15} />
            Guardar ruta de datos
          </Button>
        </footer>
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
  onPreview: (site: PublicSite) => void
  onUpdateRoute: (site: PublicSite, slug: string) => Promise<void>
  onDelete: (site: PublicSite) => void
}

const LibrarySitePreview: React.FC<{
  site: PublicSite
  forms: PublicSite[]
  calendars: CalendarType[]
}> = ({ site, forms, calendars }) => {
  const pages = hasEditablePages(site) ? normalizeFunnelPages(site) : []
  const activePageId = pages[0]?.id || DEFAULT_FUNNEL_PAGE_ID
  const blocks = getLibraryPreviewBlocks(site)
  const canvasTheme = buildCanvasTheme(site, 'desktop')
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
                {blocks.length ? (
                  blocks.map(block => (
                    <div key={block.id} className={getBlockStyleClassName(block)} style={getBlockCanvasStyle(block)}>
                      <CanvasPreviewBlock
                        block={block}
                        site={site}
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
                    <button type="button" data-submit><SubmitButtonContent theme={site.theme} /></button>
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
  onPreview,
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
    if (routeSavingId) return
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
  const routeEditingSite = routeEditingId ? sites.find(site => site.id === routeEditingId) || null : null

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
            >
              <div className={styles.libraryCardPreview}>
                <LibrarySitePreview site={site} forms={forms} calendars={calendars} />
                <span className={styles.libraryPreviewType}>{getSiteTypeLabel(site)}</span>
                <div className={styles.libraryCardHoverActions} data-library-card-action="true">
                  <button type="button" onClick={() => onEdit(site.id)}>
                    <Pencil size={16} />
                    <span>Editar</span>
                  </button>
                  <button type="button" onClick={() => onPreview(site)}>
                    {isPublicSiteLive(site, domainConfig) ? <ExternalLink size={16} /> : <Eye size={16} />}
                    <span>{isPublicSiteLive(site, domainConfig) ? 'Ver en vivo' : 'Previsualizar'}</span>
                  </button>
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
                </div>
              </div>

              <div className={styles.libraryCardBody}>
                <div className={styles.libraryCardTitleRow}>
                  <strong>{site.name}</strong>
                  <span className={`${styles.statusPill} ${getStatusClass(site, domainConfig)}`}>{getStatusLabel(site, domainConfig)}</span>
                </div>
                <span className={styles.siteDomain}>{getPublicRouteLabel(site, domainConfig)}</span>
              </div>
            </article>
          )
        })}
      </div>

      {routeEditingSite && (
        <div className={styles.libraryRouteOverlay} onMouseDown={(event) => {
          if (event.target === event.currentTarget) cancelRouteEdit()
        }}>
          <form
            className={styles.libraryRouteEditor}
            data-library-card-action="true"
            onMouseDown={stopCardAction}
            onClick={stopCardAction}
            onSubmit={(event) => {
              event.preventDefault()
              void saveRouteEdit(routeEditingSite)
            }}
          >
            <div className={styles.libraryRouteEditorHeader}>
              <div>
                <span>Ruta publica</span>
                <strong>{routeEditingSite.name}</strong>
              </div>
              <button type="button" className={styles.libraryRouteClose} disabled={routeSavingId === routeEditingSite.id} onClick={cancelRouteEdit} aria-label="Cerrar editor de ruta">
                <X size={17} />
              </button>
            </div>
            <label className={styles.libraryRouteField}>
              <span className={styles.libraryRouteDomain} title={getPublicDomainPreview(domainConfig)}>
                {getPublicDomainPreview(domainConfig)}
              </span>
              <span className={styles.libraryRouteSlash} aria-hidden="true">/</span>
              <input
                value={routeDraft}
                aria-label={`Ruta de ${routeEditingSite.name}`}
                autoFocus
                disabled={routeSavingId === routeEditingSite.id}
                placeholder={routeEditingSite.siteType === 'landing_page' ? 'embudo-01' : 'formulario-01'}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setRouteDraft(normalizeRouteEditorInput(event.target.value, domainConfig))}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelRouteEdit()
                  }
                }}
              />
              <span className={styles.libraryRouteEditHint} aria-hidden="true">
                <Pencil size={16} />
              </span>
            </label>
            <div className={styles.libraryRouteActions}>
              <button type="button" disabled={routeSavingId === routeEditingSite.id} onClick={cancelRouteEdit}>Cancelar</button>
              <button type="submit" disabled={routeSavingId === routeEditingSite.id}>
                <Check size={16} />
                Guardar ruta
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}

interface CreateFlowPanelProps {
  step: CreateFlow
  creating: boolean
  aiAgentAvailable: boolean
  onCreate: (siteType: SiteType, mode?: 'blank' | 'template', templateId?: SiteTemplateId) => void
  onCreateWithAI: (siteKind: SitesAICreationKind) => void
  onImportHtml: (siteType: SiteType) => void
  onAdvance: (step: CreateFlow) => void
}

type TemplateGalleryCategory = {
  id: string
  title: string
  description: string
  ids: SiteTemplateId[]
  siteType?: SiteType
}

const LANDING_TEMPLATE_CATEGORIES: TemplateGalleryCategory[] = [
  {
    id: 'full-page',
    title: 'Web grandes',
    description: 'Embudos completos con pagina principal, captura, agenda o confirmacion.',
    ids: ['ristak', 'executive', 'local']
  },
  {
    id: 'sales-pages',
    title: 'Cartas y lanzamientos',
    description: 'Flujos completos para vender, registrar interesados y cerrar con pagina de gracias.',
    ids: ['vsl', 'launch', 'premium']
  },
  {
    id: 'social',
    title: 'Redes sociales',
    description: 'Flujos cortos para anuncios sociales con captura y confirmacion final.',
    ids: ['facebook', 'instagram', 'tiktok']
  }
]

const FORM_TEMPLATE_CATEGORIES: TemplateGalleryCategory[] = [
  {
    id: 'capture-forms',
    title: 'Captura rapida',
    description: 'Formularios cortos para pedir datos, cotizar o preparar una llamada.',
    ids: ['compact', 'quote', 'callback'],
    siteType: 'standard_form'
  },
  {
    id: 'registration-forms',
    title: 'Registros y cupos',
    description: 'Formularios para eventos, listas de espera, clases, preventas o confirmaciones.',
    ids: ['event', 'waitlist'],
    siteType: 'standard_form'
  },
  {
    id: 'social-forms',
    title: 'Redes sociales',
    description: 'Formularios pequenos con apariencia nativa de Facebook, Instagram o TikTok.',
    ids: ['facebook', 'instagram', 'tiktok'],
    siteType: 'standard_form'
  }
]

const INTERACTIVE_TEMPLATE_CATEGORIES: TemplateGalleryCategory[] = [
  {
    id: 'guided',
    title: 'Quiz y formularios guiados',
    description: 'Una pregunta por pantalla para calificar prospectos paso a paso.',
    ids: ['interactive', 'callback', 'quote'],
    siteType: 'interactive_form'
  },
  {
    id: 'guided-registration',
    title: 'Registros paso a paso',
    description: 'Secuencias simples para confirmar interes antes de pedir todos los datos.',
    ids: ['event', 'waitlist'],
    siteType: 'interactive_form'
  },
  {
    id: 'social-guided',
    title: 'Redes sociales',
    description: 'Quiz con apariencia de plataforma social para mantener el mismo contexto visual.',
    ids: ['facebook', 'instagram', 'tiktok'],
    siteType: 'interactive_form'
  }
]

const getTemplatePreviewStyle = (meta: SiteTemplateMeta): React.CSSProperties => {
  const image = typeof meta.defaultTheme?.backgroundImage === 'string' ? meta.defaultTheme.backgroundImage : ''
  const paint = typeof meta.defaultTheme?.backgroundColor === 'string' ? meta.defaultTheme.backgroundColor : ''
  if (!image) {
    return { background: meta.swatchBg, color: meta.swatchInk }
  }

  const overlay = paint.startsWith('linear-gradient(')
    ? paint
    : 'linear-gradient(135deg, rgba(15,23,42,.16), rgba(15,23,42,.04))'

  return {
    backgroundColor: meta.swatchBg,
    backgroundImage: `${overlay}, url("${image.replace(/["\\\n\r]/g, '')}")`,
    backgroundPosition: 'center',
    backgroundSize: 'cover',
    color: meta.swatchInk
  }
}

const TemplateCard: React.FC<{ id: SiteTemplateId; disabled: boolean; siteType?: SiteType; onPick: () => void }> = ({ id, disabled, siteType, onPick }) => {
  const meta = templateMetaById(id)
  if (!meta) return null
  return (
    <button type="button" className={styles.templateCard} disabled={disabled} onClick={onPick}>
      <span className={styles.templatePreview} style={getTemplatePreviewStyle(meta)}>
        <span className={styles.templatePreviewBar}>
          <span className={styles.templateDot} style={{ background: meta.accent }} />
          <span className={styles.templatePreviewName}>{meta.label}</span>
          <span className={styles.templateBadge}>{meta.badge}</span>
        </span>
        <span className={styles.templatePreviewLines}><span /><span /></span>
        {siteType === 'landing_page' ? (
          <span className={styles.templatePreviewFlow}>
            <span style={{ background: meta.accent }} />
            <span />
            <span />
          </span>
        ) : (
          <span className={styles.templatePreviewBtn} style={{ background: meta.accent }} />
        )}
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
  defaultSiteType?: SiteType
  onPick: (id: SiteTemplateId, category: TemplateGalleryCategory) => void
}> = ({ categories, disabled, defaultSiteType, onPick }) => (
  <div className={styles.templateCategoryStack}>
    {categories.map(category => (
      <section key={category.id} className={styles.templateCategory}>
        <div className={styles.templateCategoryHeader}>
          <strong>{category.title}</strong>
          <p>{category.description}</p>
        </div>
        <div className={styles.templateGallery}>
          {category.ids.map(id => (
            <TemplateCard
              key={`${category.id}-${id}`}
              id={id}
              disabled={disabled}
              siteType={category.siteType || defaultSiteType}
              onPick={() => onPick(id, category)}
            />
          ))}
        </div>
      </section>
    ))}
  </div>
)

const CreateFlowPanel: React.FC<CreateFlowPanelProps> = ({ step, creating, aiAgentAvailable, onCreate, onCreateWithAI, onImportHtml, onAdvance }) => {
  return (
    <section className={styles.createPanel}>
      {step === 'landing-start' && (
        <div className={styles.choiceGrid}>
          <button type="button" disabled={creating} onClick={() => onCreate('landing_page', 'blank', 'ristak')}>
            <FileText size={22} />
            <strong>En blanco</strong>
            <p>Canvas limpio para agregar solo los bloques que necesitas.</p>
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={creating} onClick={() => onAdvance('landing-template')}>
            <LayoutTemplate size={22} />
            <strong>Desde plantilla</strong>
            <p>Elige embudos completos para web, ventas, lanzamientos o redes sociales.</p>
            <ChevronRight size={18} />
          </button>
          {aiAgentAvailable && (
            <button type="button" disabled={creating} onClick={() => onCreateWithAI('landing')}>
              <Sparkles size={22} />
              <strong>Usando IA</strong>
              <p>Genera una pagina HTML completa; Ristak la importa y revisa sus formularios.</p>
              <ChevronRight size={18} />
            </button>
          )}
          <button type="button" disabled={creating} onClick={() => onImportHtml('landing_page')}>
            <Upload size={22} />
            <strong>Subir HTML o ZIP</strong>
            <p>Usa tu pagina actual o un sitio comprimido; Ristak detecta sus formularios para guardar contactos.</p>
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {step === 'landing-template' && (
        <TemplateCategoryGallery
          categories={LANDING_TEMPLATE_CATEGORIES}
          disabled={creating}
          defaultSiteType="landing_page"
          onPick={(id) => onCreate('landing_page', 'template', id)}
        />
      )}

      {step === 'form-kind' && (
        <div className={styles.choiceGrid}>
          <button type="button" disabled={creating} onClick={() => onAdvance('form-start')}>
            <FileText size={22} />
            <strong>Formulario + paginas finales</strong>
            <p>La persona responde y despues ve agradecimiento o descalificacion segun sus respuestas.</p>
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={creating} onClick={() => onAdvance('interactive-start')}>
            <FormInput size={22} />
            <strong>Interactivo o multipagina</strong>
            <p>Divide las preguntas en pasos o paginas para guiar mejor a la persona que responde.</p>
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {step === 'form-start' && (
        <div className={styles.choiceGrid}>
          <button type="button" disabled={creating} onClick={() => onCreate('standard_form', 'blank', 'compact')}>
            <FileText size={22} />
            <strong>En blanco</strong>
            <p>Formulario limpio con paginas finales listas para personalizar.</p>
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={creating} onClick={() => onAdvance('form-template')}>
            <FormInput size={22} />
            <strong>Desde plantilla</strong>
            <p>Elige formularios de captura, registros o redes sociales.</p>
            <ChevronRight size={18} />
          </button>
          {aiAgentAvailable && (
            <button type="button" disabled={creating} onClick={() => onCreateWithAI('form')}>
              <Sparkles size={22} />
              <strong>Usando IA</strong>
              <p>Genera un formulario HTML completo y prepara sus campos para guardar contactos.</p>
              <ChevronRight size={18} />
            </button>
          )}
          <button type="button" disabled={creating} onClick={() => onImportHtml('standard_form')}>
            <Upload size={22} />
            <strong>Subir HTML o ZIP</strong>
            <p>Conserva tu formulario actual, aunque venga con varias paginas, y decide como guardar cada campo.</p>
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {step === 'interactive-start' && (
        <div className={styles.choiceGrid}>
          <button type="button" disabled={creating} onClick={() => onCreate('interactive_form', 'blank', 'interactive')}>
            <FileText size={22} />
            <strong>En blanco</strong>
            <p>Formulario interactivo limpio para crear pasos y agregar preguntas por pantalla.</p>
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={creating} onClick={() => onAdvance('interactive-template')}>
            <FormInput size={22} />
            <strong>Desde plantilla</strong>
            <p>Elige quiz guiados, registros paso a paso o formatos de redes sociales.</p>
            <ChevronRight size={18} />
          </button>
          {aiAgentAvailable && (
            <button type="button" disabled={creating} onClick={() => onCreateWithAI('interactive_form')}>
              <Sparkles size={22} />
              <strong>Usando IA</strong>
              <p>Genera una experiencia HTML por pasos y Ristak revisa como guardar cada campo.</p>
              <ChevronRight size={18} />
            </button>
          )}
          <button type="button" disabled={creating} onClick={() => onImportHtml('interactive_form')}>
            <Upload size={22} />
            <strong>Subir HTML o ZIP</strong>
            <p>Importa formularios multipagina y revisa que datos se guardan en el contacto.</p>
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
            defaultSiteType="interactive_form"
            onPick={(id) => onCreate('interactive_form', 'template', id)}
          />
        </>
      )}

      {step === 'form-template' && (
        <>
          <p className={styles.galleryHint}>Elige un formulario de captura, registro o redes sociales.</p>
          <TemplateCategoryGallery
            categories={FORM_TEMPLATE_CATEGORIES}
            disabled={creating}
            defaultSiteType="standard_form"
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
          <NumberInput
            min={min}
            max={max}
            step={step}
            value={value}
            onValueChange={set}
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
              <NumberInput
                min={min}
                max={max}
                step={1}
                value={values[side.id]}
                onValueChange={(value) => patchSide(side.id, value)}
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

type EditableGradientStop = {
  color: string
  position: number
}

type EditableGradient = {
  angle: number
  stops: EditableGradientStop[]
}

const gradientPresets = [
  { label: 'Azul claro', value: 'linear-gradient(135deg, #dbeafe 0%, #22d3ee 100%)' },
  { label: 'Noche', value: 'linear-gradient(135deg, #111827 0%, #2563eb 100%)' },
  { label: 'Verde venta', value: 'linear-gradient(135deg, #dcfce7 0%, #16a34a 100%)' },
  { label: 'Promo', value: 'linear-gradient(135deg, #ffedd5 0%, #f97316 100%)' },
  { label: 'Premium', value: 'linear-gradient(135deg, #101010 0%, #d4af37 100%)' },
  { label: 'Rosa', value: 'linear-gradient(135deg, #fce7f3 0%, #db2777 100%)' }
]

const clampPercent = (value: number) => clampNumber(value, 0, 100)
const MAX_GRADIENT_STOPS = 5

const parseGradientStop = (value: string, fallbackColor: string, fallbackPosition: number): EditableGradientStop => {
  const color = extractCssColor(value, fallbackColor)
  const positionMatch = value.replace(/rgba?\([^)]*\)/gi, '').match(/(-?\d+(?:\.\d+)?)%/)
  const position = positionMatch ? clampPercent(Number(positionMatch[1])) : fallbackPosition
  return { color, position }
}

const parseEditableGradient = (value: string, fallbackColor = '#111827'): EditableGradient => {
  const fallback: EditableGradient = {
    angle: 135,
    stops: [
      { color: normalizeCssColor(fallbackColor, '#111827'), position: 0 },
      { color: '#ffffff', position: 100 }
    ]
  }

  const raw = String(value || '').trim()
  const match = raw.match(/^linear-gradient\((.*)\)$/i)
  if (!match) return fallback

  const args = splitCssArgs(match[1])
  const first = args[0] || ''
  const angleMatch = first.match(/^(-?\d+(?:\.\d+)?)deg$/i)
  const angle = angleMatch ? clampNumber(Number(angleMatch[1]), 0, 360) : 135
  const stopArgs = angleMatch ? args.slice(1) : args
  if (stopArgs.length < 2) return fallback

  return {
    angle,
    stops: stopArgs.slice(0, MAX_GRADIENT_STOPS).map((stopArg, index, list) => (
      parseGradientStop(
        stopArg,
        index === 0 ? fallback.stops[0].color : fallback.stops[1].color,
        list.length === 1 ? 100 : (index / (list.length - 1)) * 100
      )
    ))
  }
}

const formatEditableGradient = (gradient: EditableGradient) =>
  `linear-gradient(${Math.round(gradient.angle)}deg, ${[...gradient.stops]
    .sort((a, b) => a.position - b.position)
    .map(stop => `${stop.color} ${Math.round(stop.position)}%`)
    .join(', ')})`

const defaultGradientFromPaint = (paint: string) => {
  if (isCssGradient(paint)) return paint
  const start = normalizeCssColor(paint, '#111827')
  const end = relLum(start) > 0.58 ? '#2563eb' : '#ffffff'
  return formatEditableGradient({
    angle: 135,
    stops: [
      { color: start, position: 0 },
      { color: end, position: 100 }
    ]
  })
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

// Ristak paint control: solid color or editable multi-stop gradient.
const ColorField: React.FC<ColorFieldProps> = ({ label, value, allowGradient = true, onChange, onCommit }) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const paint = allowGradient ? normalizeCssPaint(value, '#000000') : normalizeCssColor(value, '#000000')
  const isGradient = allowGradient && isCssGradient(paint)
  const gradient = useMemo(() => parseEditableGradient(paint, paintFallbackColor(paint, '#111827')), [paint])
  const [activeStopIndex, setActiveStopIndex] = useState(0)
  const safeActiveStopIndex = Math.min(activeStopIndex, Math.max(0, gradient.stops.length - 1))
  const activeStop = gradient.stops[safeActiveStopIndex]
  const activeColor = isGradient ? (activeStop?.color || '#000000') : paint
  const rgba = parseCssColor(activeColor, '#000000')
  const hsv = rgbToHsv(rgba)
  const hueRgb = hsvToRgb(hsv.h, 1, 1)
  const hueColor = rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b)
  const alphaColor = formatCssColor({ r: rgba.r, g: rgba.g, b: rgba.b, a: 1 })
  const [text, setText] = useState(paint)
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

  const emitPaint = (nextPaint: string) => {
    setText(nextPaint)
    onChange(nextPaint)
  }

  const patchGradient = (patch: Partial<EditableGradient> & { stops?: EditableGradientStop[] }) => {
    const nextGradient = {
      ...gradient,
      ...patch,
      stops: patch.stops || gradient.stops
    }
    emitPaint(formatEditableGradient(nextGradient))
  }

  const patchActiveColor = (next: { h?: number; s?: number; v?: number; a?: number }) => {
    const nextH = next.h ?? hsv.h
    const nextS = next.s ?? hsv.s
    const nextV = next.v ?? hsv.v
    const nextA = next.a ?? rgba.a
    const rgb = hsvToRgb(nextH, nextS, nextV)
    const formatted = formatCssColor({ ...rgb, a: nextA })
    if (!isGradient) {
      emitPaint(formatted)
      return
    }
    const stops = [...gradient.stops]
    stops[safeActiveStopIndex] = { ...stops[safeActiveStopIndex], color: formatted }
    patchGradient({ stops })
  }

  const setMode = (mode: 'solid' | 'gradient') => {
    if (mode === 'gradient') {
      emitPaint(defaultGradientFromPaint(paint))
      return
    }
    emitPaint(paintFallbackColor(paint, '#111827'))
  }

  const patchStopText = (index: number, nextColor: string) => {
    const normalized = normalizeCssColor(nextColor.startsWith('#') || nextColor.startsWith('rgb') || nextColor === 'transparent' ? nextColor : `#${nextColor}`, '')
    if (!normalized) return
    const stops = [...gradient.stops]
    stops[index] = { ...stops[index], color: normalized }
    patchGradient({ stops })
  }

  const patchStopPosition = (index: number, nextPosition: number) => {
    const stops = [...gradient.stops]
    stops[index] = { ...stops[index], position: clampPercent(nextPosition) }
    patchGradient({ stops })
  }

  const addGradientStop = () => {
    if (gradient.stops.length >= MAX_GRADIENT_STOPS) return
    const sorted = [...gradient.stops].sort((a, b) => a.position - b.position)
    const largestGap = sorted.slice(0, -1).reduce((best, stop, index) => {
      const next = sorted[index + 1]
      const gap = next.position - stop.position
      return gap > best.gap ? { gap, index, stop, next } : best
    }, { gap: -1, index: 0, stop: sorted[0], next: sorted[1] })
    const position = largestGap.stop && largestGap.next
      ? clampPercent(largestGap.stop.position + largestGap.gap / 2)
      : 50
    const color = largestGap.next?.color || activeStop?.color || '#ffffff'
    const stops = [...gradient.stops, { color, position }]
    setActiveStopIndex(stops.length - 1)
    patchGradient({ stops })
  }

  const removeActiveGradientStop = () => {
    if (gradient.stops.length <= 2) return
    const stops = gradient.stops.filter((_, index) => index !== safeActiveStopIndex)
    setActiveStopIndex(Math.max(0, Math.min(safeActiveStopIndex, stops.length - 1)))
    patchGradient({ stops })
  }

  const handleStopRailPointer = (event: React.PointerEvent<HTMLElement>, index: number) => {
    const rail = event.currentTarget.closest(`.${styles.gradientStopRail}`) as HTMLDivElement | null
    if (!rail) return
    const rect = rail.getBoundingClientRect()
    const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left))
    patchStopPosition(index, (x / rect.width) * 100)
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
      setText(paint)
    }
  }

  const handlePlanePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left))
    const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top))
    patchActiveColor({ s: x / rect.width, v: 1 - y / rect.height })
  }

  return (
    <div ref={rootRef} className={styles.colorField} data-paint-control="gradient-v3" data-paint-mode={isGradient ? 'gradient' : 'solid'}>
      <div className={styles.colorFieldHeader}>
        <span>{label}</span>
      </div>
      <div className={styles.colorRow} data-open={open ? 'true' : 'false'}>
        <button
          type="button"
          className={styles.colorSwatchButton}
          style={swatchBackground(paint)}
          onClick={() => setOpen(current => !current)}
          aria-label={`Elegir ${label}`}
        />
        <input
          className={styles.colorHex}
          value={text}
          spellCheck={false}
          maxLength={allowGradient ? 360 : 28}
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
              onChange={(event) => patchActiveColor({ h: Number(event.target.value) })}
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
              onChange={(event) => patchActiveColor({ a: Number(event.target.value) / 100 })}
              onBlur={onCommit}
            />
          </label>
          {allowGradient && (
            <section className={`${styles.gradientPanel} ${!isGradient ? styles.gradientPanelCollapsed : ''}`} aria-label={`Degradado para ${label}`}>
              {!isGradient ? (
                <button type="button" className={styles.gradientCreateButton} onClick={() => setMode('gradient')}>
                  <Plus size={14} />
                  <span>Crear degradado</span>
                </button>
              ) : (
                <>
                  <div className={styles.gradientPanelHeader}>
                    <span>Degradado</span>
                    <button type="button" className={styles.gradientClearButton} onClick={() => setMode('solid')} aria-label="Quitar degradado">
                      <X size={14} />
                      <span>Quitar</span>
                    </button>
                  </div>
                  <div className={styles.gradientEditor}>
                    <div className={styles.gradientPresetGrid} aria-label="Paletas de degradado">
                      {gradientPresets.map(preset => (
                        <button
                          key={preset.label}
                          type="button"
                          style={swatchBackground(preset.value)}
                          onClick={() => emitPaint(preset.value)}
                          title={preset.label}
                          aria-label={preset.label}
                        />
                      ))}
                    </div>
                    <div className={styles.gradientStops}>
                      <div
                        className={styles.gradientStopRail}
                        style={{ backgroundImage: formatEditableGradient(gradient) }}
                        aria-label="Distancia entre colores del degradado"
                      >
                        {gradient.stops.map((stop, index) => (
                          <button
                            key={`${stop.color}-${index}`}
                            type="button"
                            className={styles.gradientStopHandle}
                            data-active={safeActiveStopIndex === index ? 'true' : 'false'}
                            style={{ left: `${stop.position}%`, ...swatchBackground(stop.color) }}
                            onPointerDown={(event) => {
                              event.currentTarget.setPointerCapture(event.pointerId)
                              setActiveStopIndex(index)
                              handleStopRailPointer(event, index)
                            }}
                            onPointerMove={(event) => {
                              if (event.buttons) handleStopRailPointer(event, index)
                            }}
                            onPointerUp={onCommit}
                            aria-label={`Mover color ${index + 1}`}
                          />
                        ))}
                      </div>
                      <div className={styles.gradientStopActions}>
                        <button type="button" onClick={addGradientStop} disabled={gradient.stops.length >= MAX_GRADIENT_STOPS}>
                          Agregar punto
                        </button>
                        <button type="button" onClick={removeActiveGradientStop} disabled={gradient.stops.length <= 2}>
                          Quitar punto
                        </button>
                      </div>
                      <label className={styles.colorSlider}>
                        <span>Direccion</span>
                        <input
                          type="range"
                          min={0}
                          max={360}
                          value={Math.round(gradient.angle)}
                          onChange={(event) => patchGradient({ angle: Number(event.target.value) })}
                          onBlur={onCommit}
                        />
                      </label>
                      {gradient.stops.map((stop, index) => (
                        <div key={index} className={styles.gradientStopRow} data-active={safeActiveStopIndex === index ? 'true' : 'false'}>
                          <button
                            type="button"
                            className={styles.gradientStopButton}
                            style={swatchBackground(stop.color)}
                            onClick={() => setActiveStopIndex(index)}
                            aria-label={`Editar color ${index + 1}`}
                          />
                          <input
                            value={stop.color}
                            spellCheck={false}
                            onFocus={() => setActiveStopIndex(index)}
                            onChange={(event) => patchStopText(index, event.target.value)}
                            onBlur={onCommit}
                          />
                          <div className={styles.gradientStopPosition}>
                            <NumberInput
                              min={0}
                              max={100}
                              value={Math.round(stop.position)}
                              onFocus={() => setActiveStopIndex(index)}
                              onValueChange={(value) => patchStopPosition(index, value)}
                              onBlur={onCommit}
                            />
                            <small>%</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </section>
          )}
          <div className={styles.colorPopoverActions}>
            <button type="button" onClick={() => patchActiveColor({ a: 0 })}>Transparente</button>
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

const SocialPlatformBadge: React.FC<{ platform: SocialPlatform }> = ({ platform }) => {
  const platformClass = platform === 'facebook'
    ? styles.socialPlatformFacebook
    : platform === 'instagram'
      ? styles.socialPlatformInstagram
      : platform === 'threads'
        ? styles.socialPlatformThreads
        : styles.socialPlatformTiktok

  return (
    <span className={`${styles.socialPlatformBadge} ${platformClass}`} aria-hidden="true">
      {platform === 'instagram' && <Instagram size={16} strokeWidth={2.2} />}
      {platform === 'tiktok' && <Music2 size={16} strokeWidth={2.2} />}
      {platform === 'threads' && <span className={styles.socialPlatformThreadsGlyph}>@</span>}
    </span>
  )
}

const CanvasChrome: React.FC<{
  platform: SocialPlatform
  site: PublicSite
  embedded?: boolean
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSave: () => void
}> = ({ platform, site, embedded = false }) => {
  const theme = site.theme || {}
  const name = theme.brandName || site.title || site.name || 'Tu marca'
  const subtitle = theme.brandSubtitle || (platform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado')
  const followers = String(theme.followers || '')
  const secondary = followers ? `${followers} seguidores` : subtitle
  const platformClass = platform === 'facebook'
    ? styles.chromeFacebook
    : platform === 'instagram'
      ? styles.chromeInstagram
      : platform === 'threads'
        ? styles.chromeThreads
        : styles.chromeTiktok

  return (
    <div className={`${styles.canvasChrome} ${embedded ? styles.canvasChromeEmbedded : ''} ${platformClass}`} aria-label={`Perfil de ${platform}`}>
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

const SubmitButtonContent: React.FC<{ theme?: SiteTheme; label?: string; subtitle?: string }> = ({ theme, label: labelOverride, subtitle: subtitleOverride }) => {
  const label = labelOverride || getThemeString(theme, 'submitText') || 'Enviar'
  const subtitle = subtitleOverride !== undefined ? subtitleOverride : getThemeString(theme, 'submitSubtitle')

  return (
    <>
      <span className="rstk-button-label">{label}</span>
      {subtitle ? <span className="rstk-button-subtitle">{subtitle}</span> : null}
    </>
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
    items: ['title', 'subtitle', 'text', 'image', 'video', 'button', 'benefits', 'testimonials', 'services', 'faq', 'cta', 'embed', 'calendar_embed', 'form_embed', 'social_profile']
      .map(blockType => ({ id: blockType, label: blockLabels[blockType as SiteBlockType], blockType: blockType as SiteBlockType }))
  },
  {
    label: 'Campos',
    items: ['short_text', 'paragraph', 'email', 'phone', 'number', 'currency', 'date', 'dropdown', 'radio', 'checkboxes', 'description']
      .map(blockType => ({ id: blockType, label: blockLabels[blockType as SiteBlockType], blockType: blockType as SiteBlockType }))
  }
]

const hideNativeDragPreview = (dataTransfer: DataTransfer) => {
  if (typeof document === 'undefined') return
  const ghost = document.createElement('span')
  ghost.style.position = 'fixed'
  ghost.style.top = '-1000px'
  ghost.style.left = '-1000px'
  ghost.style.width = '1px'
  ghost.style.height = '1px'
  ghost.style.opacity = '0'
  ghost.style.pointerEvents = 'none'
  document.body.appendChild(ghost)
  dataTransfer.setDragImage(ghost, 0, 0)
  window.setTimeout(() => ghost.remove(), 0)
}

const seoLanguageOptions = ['es - Spanish', 'en - English', 'pt - Portuguese', 'fr - French']

interface SeoValidationState {
  checks: {
    titlePresent: boolean
    titleLength: boolean
    descriptionPresent: boolean
    descriptionLength: boolean
    keywordsPresent: boolean
    authorPresent: boolean
    imagePresent: boolean
    metaTagsPresent: boolean
    outgoingLinksLimit: boolean
    languagePresent: boolean
  }
  contentIssues: number
  keywordsIssues: number
  authorIssues: number
  imageIssues: number
  linkIssues: number
  languageIssues: number
  totalIssues: number
}

const cleanSeoValue = (value: unknown) => typeof value === 'string' ? value.trim() : ''

const countSeoLines = (value: string) => value
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean).length

const getSeoValidationState = (site?: PublicSite | null): SeoValidationState => {
  const theme = site?.theme || {}
  const title = cleanSeoValue(getPublicTitleEditorValue(site))
  const description = cleanSeoValue(site?.description)
  const keywords = cleanSeoValue(theme.seoKeywords)
  const author = cleanSeoValue(theme.seoAuthor)
  const image = cleanSeoValue(theme.seoImage)
  const metaTags = cleanSeoValue(theme.seoMetaTags)
  const outgoingLinks = cleanSeoValue(theme.seoCanonicalLinks)
  const language = cleanSeoValue(theme.seoLanguage || 'es - Spanish')
  const outgoingLinkCount = countSeoLines(outgoingLinks)
  const checks = {
    titlePresent: title.length > 0,
    titleLength: title.length > 0 && title.length <= 70,
    descriptionPresent: description.length > 0,
    descriptionLength: description.length > 0 && description.length <= 155,
    keywordsPresent: keywords.length > 0,
    authorPresent: author.length > 0,
    imagePresent: image.length > 0,
    metaTagsPresent: metaTags.length > 0,
    outgoingLinksLimit: outgoingLinks.length > 0 && outgoingLinkCount < 300,
    languagePresent: language.length > 0
  }
  const countIssues = (items: boolean[]) => items.filter(ok => !ok).length
  const contentIssues = countIssues([
    checks.titlePresent,
    checks.titleLength,
    checks.descriptionPresent,
    checks.descriptionLength
  ])
  const keywordsIssues = countIssues([checks.keywordsPresent])
  const authorIssues = countIssues([checks.authorPresent])
  const imageIssues = countIssues([checks.imagePresent])
  const linkIssues = countIssues([checks.metaTagsPresent, checks.outgoingLinksLimit])
  const languageIssues = countIssues([checks.languagePresent])

  return {
    checks,
    contentIssues,
    keywordsIssues,
    authorIssues,
    imageIssues,
    linkIssues,
    languageIssues,
    totalIssues: contentIssues + keywordsIssues + authorIssues + imageIssues + linkIssues + languageIssues
  }
}

const SeoCheckLine: React.FC<{ ok: boolean; children: React.ReactNode }> = ({ ok, children }) => (
  <p className={`${styles.seoCheckLine} ${ok ? styles.seoCheckOk : styles.seoCheckWarning}`}>
    {ok ? <Check size={14} /> : <AlertTriangle size={14} />}
    <span>{children}</span>
  </p>
)

const SeoSectionTitle: React.FC<{
  icon: React.ReactNode
  title: string
  issues?: number
}> = ({ icon, title, issues = 0 }) => (
  <div className={styles.seoSectionTitle}>
    <span className={styles.seoSectionIcon}>{icon}</span>
    <strong>{title}</strong>
    {issues > 0 && <span className={styles.seoIssueBadge}>{issues}</span>}
  </div>
)

const SeoOptimizationModal: React.FC<{
  site: PublicSite
  onClose: () => void
  onPatchSite: (patch: Partial<PublicSite>) => void
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSave: () => void
}> = ({ site, onClose, onPatchSite, onPatchTheme, onSave }) => {
  const theme = site.theme || {}
  const publicTitle = getPublicTitleEditorValue(site)
  const description = site.description || ''
  const keywords = theme.seoKeywords || ''
  const author = theme.seoAuthor || ''
  const seoImage = theme.seoImage || ''
  const metaTags = theme.seoMetaTags || ''
  const canonicalLinks = theme.seoCanonicalLinks || ''
  const language = theme.seoLanguage || 'es - Spanish'
  const validation = getSeoValidationState(site)
  const { checks } = validation

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const patchThemeText = (key: keyof SiteTheme, value: string) => {
    onPatchTheme({ [key]: value } as Partial<SiteTheme>)
  }

  const addThemeLine = (key: keyof SiteTheme, currentValue: string, line: string) => {
    const next = currentValue.trim() ? `${currentValue.trim()}\n${line}` : line
    patchThemeText(key, next)
  }

  const saveAndClose = () => {
    onSave()
    onClose()
  }

  return (
    <div className={styles.seoModalBackdrop} role="presentation" onMouseDown={onClose}>
      <section
        className={styles.seoModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="seo-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={styles.seoModalHeader}>
          <div>
            <span>Configuracion del sitio</span>
            <h2 id="seo-modal-title">SEO & optimizacion de busqueda</h2>
          </div>
          <button type="button" className={styles.seoModalClose} onClick={onClose} aria-label="Cerrar SEO">
            <X size={18} />
          </button>
        </div>

        <div className={styles.seoModalBody}>
          <section className={styles.seoSection}>
            <SeoSectionTitle icon={<FileText size={17} />} title="Contenido" issues={validation.contentIssues} />
            <label className={styles.seoField}>
              <span>Titulo publico</span>
              <input
                value={publicTitle}
                placeholder="Nombre que vera la gente"
                onChange={(event) => onPatchSite({ title: event.target.value })}
                onBlur={onSave}
              />
            </label>
            <SeoCheckLine ok={checks.titlePresent}>La pagina tiene un titulo.</SeoCheckLine>
            <SeoCheckLine ok={checks.titleLength}>El titulo tiene menos de 70 caracteres.</SeoCheckLine>
            <label className={styles.seoField}>
              <span>Descripcion</span>
              <textarea
                value={description}
                placeholder="Explica en una frase clara que ofrece esta pagina."
                rows={4}
                onChange={(event) => onPatchSite({ description: event.target.value })}
                onBlur={onSave}
              />
            </label>
            <SeoCheckLine ok={checks.descriptionPresent}>La pagina tiene una descripcion para buscadores.</SeoCheckLine>
            <SeoCheckLine ok={checks.descriptionLength}>La descripcion tiene menos de 155 caracteres.</SeoCheckLine>
          </section>

          <section className={styles.seoSection}>
            <SeoSectionTitle icon={<Search size={17} />} title="Palabras clave" issues={validation.keywordsIssues} />
            <label className={styles.seoField}>
              <span>Palabras clave</span>
              <textarea
                value={keywords}
                placeholder="servicio, ciudad, problema que resuelves"
                rows={3}
                onChange={(event) => patchThemeText('seoKeywords', event.target.value)}
                onBlur={onSave}
              />
            </label>
            <SeoCheckLine ok={checks.keywordsPresent}>La pagina tiene palabras clave.</SeoCheckLine>
          </section>

          <section className={styles.seoSection}>
            <SeoSectionTitle icon={<Pencil size={17} />} title="Autor" issues={validation.authorIssues} />
            <label className={styles.seoField}>
              <span>Autor</span>
              <input
                value={author}
                placeholder="Nombre de la persona o negocio"
                onChange={(event) => patchThemeText('seoAuthor', event.target.value)}
                onBlur={onSave}
              />
            </label>
            <SeoCheckLine ok={checks.authorPresent}>La pagina tiene nombre de autor.</SeoCheckLine>
          </section>

          <section className={styles.seoSection}>
            <SeoSectionTitle icon={<Image size={17} />} title="Imagenes" issues={validation.imageIssues} />
            <label className={styles.seoField}>
              <span>Imagen principal para compartir</span>
              <div className={styles.seoUrlField}>
                <input
                  value={seoImage}
                  placeholder="https://..."
                  onChange={(event) => patchThemeText('seoImage', event.target.value)}
                  onBlur={onSave}
                />
                <Image size={17} />
              </div>
            </label>
            <SeoCheckLine ok={checks.imagePresent}>La pagina tiene imagen para compartir.</SeoCheckLine>
          </section>

          <section className={styles.seoSection}>
            <SeoSectionTitle icon={<Link2 size={17} />} title="Enlaces y etiquetas" issues={validation.linkIssues} />
            <div className={styles.seoFieldHeader}>
              <span>Metaetiquetas personalizadas</span>
              <button
                type="button"
                onClick={() => addThemeLine('seoMetaTags', metaTags, '<meta name="robots" content="index, follow">')}
              >
                <Plus size={15} />
                Anadir
              </button>
            </div>
            <textarea
              className={styles.seoTextarea}
              value={metaTags}
              placeholder='<meta name="robots" content="index, follow">'
              rows={3}
              onChange={(event) => patchThemeText('seoMetaTags', event.target.value)}
              onBlur={onSave}
            />
            <SeoCheckLine ok={checks.metaTagsPresent}>La pagina tiene metaetiquetas personalizadas.</SeoCheckLine>
            <div className={styles.seoFieldHeader}>
              <span>Enlaces canonicos</span>
              <button
                type="button"
                onClick={() => addThemeLine('seoCanonicalLinks', canonicalLinks, getRoutePath(site))}
              >
                <Plus size={15} />
                Anadir
              </button>
            </div>
            <textarea
              className={styles.seoTextarea}
              value={canonicalLinks}
              placeholder="/embudo-01"
              rows={3}
              onChange={(event) => patchThemeText('seoCanonicalLinks', event.target.value)}
              onBlur={onSave}
            />
            <SeoCheckLine ok={checks.outgoingLinksLimit}>
              La pagina tiene menos de 300 enlaces salientes.
            </SeoCheckLine>
          </section>

          <section className={styles.seoSection}>
            <SeoSectionTitle icon={<Globe2 size={17} />} title="Idioma" issues={validation.languageIssues} />
            <label className={styles.seoField}>
              <span>Idioma</span>
              <select
                value={language}
                onChange={(event) => patchThemeText('seoLanguage', event.target.value)}
                onBlur={onSave}
              >
                {seoLanguageOptions.map(option => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <SeoCheckLine ok={checks.languagePresent}>La pagina tiene idioma seleccionado.</SeoCheckLine>
          </section>
        </div>

        <div className={styles.seoModalActions}>
          <Button variant="secondary" size="lg" onClick={onClose}>Cancelar</Button>
          <Button size="lg" onClick={saveAndClose}>
            <Save size={15} />
            Guardar SEO
          </Button>
        </div>
      </section>
    </div>
  )
}

interface FunnelPagesPanelProps {
  pages: SitePage[]
  activePageId: string
  locked?: boolean
  draggingPageId: string | null
  colorFinalPages?: boolean
  isFixedPage?: (page: SitePage) => boolean
  canDeletePage?: (page: SitePage) => boolean
  canDuplicatePage?: (page: SitePage) => boolean
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
  locked = false,
  draggingPageId,
  colorFinalPages = false,
  isFixedPage = () => false,
  canDeletePage = () => pages.length > 1,
  canDuplicatePage = () => true,
  onSelectPage,
  onAddPage,
  onDuplicatePage,
  onDeletePage,
  onDragPage,
  onReorderPages,
  onRenamePage
}) => {
  const [renamingPageId, setRenamingPageId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [menuPageId, setMenuPageId] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const activePage = pages.find(page => page.id === activePageId) || pages[0] || null

  useEffect(() => {
    if (!open) return

    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (dropdownRef.current?.contains(target)) return
      if (target.closest('[data-page-menu-portal="true"]')) return
      setOpen(false)
    }

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('click', handleDocumentClick)
    document.addEventListener('keydown', handleDocumentKeyDown)

    return () => {
      document.removeEventListener('click', handleDocumentClick)
      document.removeEventListener('keydown', handleDocumentKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      setMenuPageId(null)
      setRenamingPageId(null)
    }
  }, [open])

  const handleSelectPage = (pageId: string) => {
    setMenuPageId(null)
    onSelectPage(pageId)
    setOpen(false)
  }

  const pageSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const handlePageDragStart = (event: DragStartEvent) => {
    const pageId = String(event.active.id)
    const page = pages.find(item => item.id === pageId)
    if (!page || locked || isFixedPage(page)) return
    setMenuPageId(null)
    onDragPage(pageId)
  }

  const handlePageDragEnd = (event: DragEndEvent) => {
    const sourcePageId = String(event.active.id)
    const targetPageId = event.over?.id ? String(event.over.id) : ''
    onDragPage(null)
    if (!targetPageId || sourcePageId === targetPageId) return
    onReorderPages(sourcePageId, targetPageId)
  }

  return (
    <div ref={dropdownRef} className={`${styles.pagesDropdown} ${open ? styles.pagesDropdownOpen : ''}`}>
      <button
        type="button"
        className={styles.pagesDropdownTrigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <FileText size={15} />
        <span className={styles.pagesDropdownTriggerText}>
          <strong>{activePage?.title || 'Pagina 1'}</strong>
        </span>
        <ChevronDown size={15} className={styles.pagesDropdownChevron} />
      </button>

      {open && (
        <div className={styles.pagesDropdownPanel} role="dialog" aria-label="Paginas del sitio">
          <div className={styles.pagesDropdownHeader}>
            <span>Paginas</span>
            <strong>{pages.length}</strong>
          </div>
          <DndContext
            sensors={pageSensors}
            collisionDetection={closestCenter}
            onDragStart={handlePageDragStart}
            onDragEnd={handlePageDragEnd}
            onDragCancel={() => onDragPage(null)}
          >
            <SortableContext items={pages.map(page => page.id)} strategy={verticalListSortingStrategy}>
              <div className={styles.pagesDropdownList}>
                {pages.map((page, index) => {
                  const fixedPage = isFixedPage(page)
                  const pageCanDelete = !locked && canDeletePage(page)
                  const pageCanDuplicate = !locked && canDuplicatePage(page)
                  const pageToneClass = colorFinalPages && page.id === FORM_THANK_YOU_PAGE_ID
                    ? styles.pagesDropdownItemThankYou
                    : colorFinalPages && page.id === FORM_DISQUALIFIED_PAGE_ID
                      ? styles.pagesDropdownItemDisqualified
                      : ''

                  return (
                    <FunnelPageDropdownItem
                      key={page.id}
                      page={page}
                      index={index}
                      active={activePageId === page.id}
                      dragging={draggingPageId === page.id}
                      locked={locked}
                      fixedPage={fixedPage}
                      renaming={renamingPageId === page.id}
                      menuOpen={menuPageId === page.id}
                      pageToneClass={pageToneClass}
                      canDelete={pageCanDelete}
                      canDuplicate={pageCanDuplicate}
                      onSelect={() => handleSelectPage(page.id)}
                      onOpenMenu={() => setMenuPageId(current => current === page.id ? null : page.id)}
                      onStartRename={() => {
                        setMenuPageId(null)
                        onSelectPage(page.id)
                        setRenamingPageId(page.id)
                      }}
                      onDuplicate={() => {
                        setMenuPageId(null)
                        onDuplicatePage(page.id)
                      }}
                      onDelete={() => {
                        setMenuPageId(null)
                        onDeletePage(page.id)
                      }}
                      onRenamePage={onRenamePage}
                      onDoneRename={() => setRenamingPageId(null)}
                    />
                  )
                })}
                {!locked && (
                  <button type="button" className={styles.pagesDropdownAddButton} onClick={() => { setMenuPageId(null); onAddPage() }}>
                    <Plus size={15} />
                    Agregar pagina
                  </button>
                )}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      )}
    </div>
  )
}

interface FunnelPageDropdownItemProps {
  page: SitePage
  index: number
  active: boolean
  dragging: boolean
  locked: boolean
  fixedPage: boolean
  renaming: boolean
  menuOpen: boolean
  pageToneClass: string
  canDelete: boolean
  canDuplicate: boolean
  onSelect: () => void
  onOpenMenu: () => void
  onStartRename: () => void
  onDuplicate: () => void
  onDelete: () => void
  onRenamePage: (pageId: string, title: string) => void
  onDoneRename: () => void
}

const FunnelPageDropdownItem: React.FC<FunnelPageDropdownItemProps> = ({
  page,
  index,
  active,
  dragging,
  locked,
  fixedPage,
  renaming,
  menuOpen,
  pageToneClass,
  canDelete,
  canDuplicate,
  onSelect,
  onOpenMenu,
  onStartRename,
  onDuplicate,
  onDelete,
  onRenamePage,
  onDoneRename
}) => {
  const title = page.title || `Pagina ${index + 1}`
  const dragDisabled = locked || fixedPage
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: page.id,
    disabled: dragDisabled
  })
  const rowStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging || menuOpen ? 4 : undefined
  }

  return (
    <div
      ref={setNodeRef}
      style={rowStyle}
      className={`${styles.pagesDropdownItemWrap} ${dragging || isDragging ? styles.pagesDropdownItemDragging : ''}`}
    >
      <div
        className={`${styles.pagesDropdownItem} ${pageToneClass} ${fixedPage ? styles.pagesDropdownItemFixed : ''} ${locked ? styles.pagesDropdownItemLocked : ''} ${active ? styles.pagesDropdownItemActive : ''}`}
      >
        <span
          className={`${styles.pagesDropdownDragHandle} ${dragDisabled ? styles.pagesDropdownDragHandleDisabled : ''}`}
          {...(!dragDisabled ? attributes : {})}
          {...(!dragDisabled ? listeners : {})}
          aria-label={!dragDisabled ? `Arrastrar ${title}` : undefined}
          title={!dragDisabled ? 'Arrastra para ordenar' : 'Esta pagina no se puede mover'}
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical size={18} />
        </span>

        {renaming && !locked ? (
          <div className={styles.pagesDropdownTitleCell}>
            <EditablePageTitle
              pageId={page.id}
              title={title}
              inputClassName={styles.pagesDropdownTitleInput}
              onFocus={() => undefined}
              onRename={onRenamePage}
              onDone={onDoneRename}
            />
          </div>
        ) : (
          <button type="button" className={styles.pagesDropdownSelectButton} onClick={onSelect}>
            <span className={styles.pagesDropdownTitleText}>{title}</span>
          </button>
        )}

        {!locked && (
          <div className={styles.pagesDropdownActionWrap}>
            <button
              type="button"
              className={styles.pagesDropdownMenuButton}
              aria-label="Opciones de pagina"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(event) => {
                event.stopPropagation()
                onOpenMenu()
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <MoreVertical size={15} />
            </button>

            {menuOpen && (
              <div
                className={styles.pagesDropdownActionMenu}
                role="menu"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button type="button" role="menuitem" className={styles.pagesDropdownActionItem} onClick={onStartRename}>
                  Cambiar nombre
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.pagesDropdownActionItem}
                  disabled={!canDuplicate}
                  onClick={onDuplicate}
                >
                  <Copy size={14} />
                  Duplicar pagina
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.pagesDropdownActionItem} ${styles.pagesDropdownActionDanger}`}
                  disabled={!canDelete}
                  onClick={onDelete}
                >
                  <Trash2 size={14} />
                  Eliminar pagina
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const EditablePageTitle: React.FC<{
  pageId: string
  title: string
  inputClassName?: string
  onFocus: () => void
  onRename: (pageId: string, title: string) => void
  onDone: () => void
}> = ({ pageId, title, inputClassName, onFocus, onRename, onDone }) => {
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRenameRef = useRef(false)

  useEffect(() => setDraft(title), [title])
  useEffect(() => {
    window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }, [])

  const commit = () => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false
      setDraft(title)
      onDone()
      return
    }

    const next = draft.trim() || title
    setDraft(next)
    if (next !== title) onRename(pageId, next)
    onDone()
  }

  return (
    <input
      ref={inputRef}
      className={inputClassName || styles.pageTitleInput}
      value={draft}
      draggable={false}
      aria-label="Nombre de pagina"
      onFocus={onFocus}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          cancelRenameRef.current = true
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
  onPaletteDragStart: (payload: PaletteDragPayload, position: PaletteDragPosition | null) => void
  onPaletteDragMove: (position: PaletteDragPosition | null) => void
  onPaletteDragEnd: () => void
}> = ({ blockTypes, existingBlocks = [], onAdd, onPaletteDragStart, onPaletteDragMove, onPaletteDragEnd }) => {
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
                    hideNativeDragPreview(event.dataTransfer)
                    const rect = event.currentTarget.getBoundingClientRect()
                    onPaletteDragStart(
                      { blockType: item.blockType, initialSettings: item.initialSettings },
                      event.clientX || event.clientY
                        ? { x: event.clientX, y: event.clientY }
                        : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
                    )
                  }}
                  onDrag={(event) => {
                    if (event.clientX || event.clientY) {
                      onPaletteDragMove({ x: event.clientX, y: event.clientY })
                    }
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

const InlineButtonEditable: React.FC<Omit<InlineEditableProps, 'as' | 'className'>> = (props) => (
  <a className="rstk-button-link" href="#" onClick={(event) => event.preventDefault()}>
    <InlineEditable {...props} as="span" className="rstk-button-label" />
  </a>
)

// Renders the canvas page at its true desktop width and transform-scales it to
// fit the column — a faithful "monitor comprimido" of the published page.
interface CanvasStageProps {
  designWidth: number
  canvasClassName: string
  canvasStyle: React.CSSProperties
  active?: boolean
  pageSelected?: boolean
  fluidAboveDesign?: boolean
  onClear?: () => void
  onDragOver?: React.DragEventHandler<HTMLDivElement>
  onDragLeave?: React.DragEventHandler<HTMLDivElement>
  onDrop?: React.DragEventHandler<HTMLDivElement>
  children: React.ReactNode
}

const CanvasStage: React.FC<CanvasStageProps> = ({
  designWidth, canvasClassName, canvasStyle, active, pageSelected, fluidAboveDesign, onClear, onDragOver, onDragLeave, onDrop, children
}) => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [renderWidth, setRenderWidth] = useState(designWidth)
  const [stageHeight, setStageHeight] = useState(0)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const stage = stageRef.current
    if (!viewport || !stage) return
    const recompute = () => {
      const avail = Math.max(1, viewport.clientWidth - (fluidAboveDesign ? 0 : 8))
      const nextRenderWidth = fluidAboveDesign && avail > designWidth ? avail : designWidth
      const next = Math.max(0.2, Math.min(1, avail / nextRenderWidth))
      setRenderWidth(nextRenderWidth)
      setScale(next)
      setStageHeight(stage.offsetHeight * next)
    }
    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(viewport)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [designWidth, fluidAboveDesign])

  return (
    <div
      ref={viewportRef}
      className={`canvasViewport ${fluidAboveDesign ? 'canvasViewportFlush' : ''} ${active ? 'canvasViewportActive' : ''}`}
      style={canvasStyle}
      onClick={onClear}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className="canvasScaler"
        style={{ ...canvasStyle, width: Math.round(renderWidth * scale), height: Math.round(stageHeight) } as React.CSSProperties}
      >
        <div
          ref={stageRef}
          className={`canvasStage ${canvasClassName} ${pageSelected ? 'canvasPageSelected' : ''}`}
          style={{ ...canvasStyle, width: renderWidth, transform: `scale(${scale})`, ['--rstk-scale' as string]: scale } as React.CSSProperties}
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
  canMoveUp: boolean
  canMoveDown: boolean
  onSelect: () => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onPatchBlock: (patch: Partial<SiteBlock>) => void
  onPatchSettings: (patch: Record<string, unknown>) => void
  onSave: () => void
}

const sortableTransition = {
  duration: 520,
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
  canMoveUp,
  canMoveDown,
  onSelect,
  onDelete,
  onMoveUp,
  onMoveDown,
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
	        transition: transition || 'transform 520ms cubic-bezier(0.2, 0.8, 0.2, 1)',
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
      <div className="rstkBlockTools">
        <button type="button" className="rstkBlockTool rstkBlockToolDrag" {...attributes} {...listeners} aria-label="Reordenar bloque">
          <GripVertical size={15} />
        </button>
        <button
          type="button"
          className="rstkBlockTool"
          disabled={!canMoveUp}
          onClick={(event) => { event.stopPropagation(); onMoveUp() }}
          aria-label="Subir bloque"
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          className="rstkBlockTool"
          disabled={!canMoveDown}
          onClick={(event) => { event.stopPropagation(); onMoveDown() }}
          aria-label="Bajar bloque"
        >
          <ArrowDown size={14} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rstkBlockTool rstkBlockToolMenu"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label="Opciones del bloque"
            >
              <MoreVertical size={15} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className={styles.pageMenu}>
            <DropdownMenuItem
              className={styles.pageMenuDanger}
              onSelect={() => onDelete()}
            >
              <Trash2 size={14} />
              Eliminar
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CanvasPreviewBlock
        block={block}
        site={site}
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
  onMoveBlock: (blockId: string, direction: BlockMoveDirection) => void
  getBlockMoveState: (block: SiteBlock) => BlockMoveState
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
  onMoveBlock,
  getBlockMoveState,
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
          const moveState = getBlockMoveState(block)
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
                canMoveUp={moveState.canMoveUp}
                canMoveDown={moveState.canMoveDown}
                onSelect={() => onSelectBlock(block.id)}
                onDelete={() => onDeleteBlock(block.id)}
                onMoveUp={() => onMoveBlock(block.id, 'up')}
                onMoveDown={() => onMoveBlock(block.id, 'down')}
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
              onMoveBlock={onMoveBlock}
              getBlockMoveState={getBlockMoveState}
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
              onMoveBlock={onMoveBlock}
              getBlockMoveState={getBlockMoveState}
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
          onMoveBlock={onMoveBlock}
          getBlockMoveState={getBlockMoveState}
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
  onMoveBlock: (blockId: string, direction: BlockMoveDirection) => void
  getBlockMoveState: (block: SiteBlock) => BlockMoveState
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
  onMoveBlock,
  getBlockMoveState,
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
            {columnBlocks.map(block => {
              const moveState = getBlockMoveState(block)
              return (
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
                    canMoveUp={moveState.canMoveUp}
                    canMoveDown={moveState.canMoveDown}
                    onSelect={() => onSelectBlock(block.id)}
                    onDelete={() => onDeleteBlock(block.id)}
                    onMoveUp={() => onMoveBlock(block.id, 'up')}
                    onMoveDown={() => onMoveBlock(block.id, 'down')}
                    onPatchBlock={(patch) => onPatchBlock(block.id, patch)}
                    onPatchSettings={(patch) => onPatchBlockSettings(block, patch)}
                    onSave={() => onSaveBlock(block.id)}
                  />
                </React.Fragment>
              )
            })}
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
  onMoveBlock,
  getBlockMoveState,
  onPatchBlock,
  onPatchBlockSettings,
  onSaveBlock
}) => {
  const section = lane.section!
  const settings = section.settings || {}
  const selected = selectedBlockId === section.id
  const [toolbarEdge, setToolbarEdge] = useState<'top' | 'bottom'>('top')
  const moveState = getBlockMoveState(section)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
    animateLayoutChanges: sortableAnimateLayoutChanges,
    transition: sortableTransition
  })
  const hasHeading = Boolean(section.content || getSettingString(settings, 'subtitle'))
  const updateToolbarEdge = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const distanceToTop = Math.abs(event.clientY - rect.top)
    const distanceToBottom = Math.abs(rect.bottom - event.clientY)
    const nextEdge = distanceToBottom < distanceToTop ? 'bottom' : 'top'
    setToolbarEdge(current => current === nextEdge ? current : nextEdge)
  }, [])

  return (
	    <section
	      ref={setNodeRef}
	      data-rstk-block-id={section.id}
	      data-rstk-block-index={blockIndexById.get(section.id) ?? 0}
	      data-rstk-page-block="true"
	      data-rstk-section-index={blockIndexById.get(section.id) ?? 0}
      data-rstk-section-id={section.id}
      className={getBlockStyleClassName(section, `rstk-section-lane rstkSel ${selected ? 'rstkSelActive' : ''} ${toolbarEdge === 'bottom' ? 'rstkSectionToolsBottom' : ''} ${isDragging ? 'rstkSelDragging' : ''}`)}
      style={{
        transform: CSS.Transform.toString(transform),
	        transition: transition || 'transform 520ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        opacity: isDragging ? 0.34 : undefined,
        zIndex: isDragging ? 8 : undefined,
        ...getBlockCanvasStyle(section)
      }}
      onPointerEnter={updateToolbarEdge}
      onPointerMove={updateToolbarEdge}
      onPointerDown={updateToolbarEdge}
      onClick={(event) => {
        event.stopPropagation()
        onSelectBlock(section.id)
      }}
    >
      <div className="rstkBlockTools">
        <button type="button" className="rstkBlockTool rstkBlockToolDrag" {...attributes} {...listeners} aria-label="Reordenar franja">
          <GripVertical size={15} />
        </button>
        <button
          type="button"
          className="rstkBlockTool"
          disabled={!moveState.canMoveUp}
          onClick={(event) => { event.stopPropagation(); onMoveBlock(section.id, 'up') }}
          aria-label="Subir franja"
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          className="rstkBlockTool"
          disabled={!moveState.canMoveDown}
          onClick={(event) => { event.stopPropagation(); onMoveBlock(section.id, 'down') }}
          aria-label="Bajar franja"
        >
          <ArrowDown size={14} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rstkBlockTool rstkBlockToolMenu"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label="Opciones de la franja"
            >
              <MoreVertical size={15} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className={styles.pageMenu}>
            <DropdownMenuItem
              className={styles.pageMenuDanger}
              onSelect={() => onDeleteBlock(section.id)}
            >
              <Trash2 size={14} />
              Eliminar
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
          onMoveBlock={onMoveBlock}
          getBlockMoveState={getBlockMoveState}
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
  site?: PublicSite
  forms: PublicSite[]
  calendars: CalendarType[]
}> = ({ block, site, forms, calendars }) => (
  <div className={getBlockStyleClassName(block, 'rstkPalettePreview')} style={getBlockCanvasStyle(block)}>
    <CanvasPreviewBlock block={block} site={site} forms={forms} calendars={calendars} />
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
  blocks: SiteBlock[]
  onPatchSettings: (patch: Record<string, unknown>) => void
  onSave: () => void
}> = ({ site, block, blocks, onPatchSettings, onSave }) => {
  const settings = getPanelStyleSettings(site, block, blocks)
  const defaultAccent = defaultAccentForSite(site)
  const isSection = block.blockType === SECTION_BLOCK_TYPE
  const isLandingContent = isLanding(site) && !isSection
  const supportsButton = block.blockType === 'hero' || block.blockType === 'button' || block.blockType === 'cta'
  const supportsField = fieldBlockTypes.has(block.blockType)
  const isHardEmbed = block.blockType === 'embed' || block.blockType === 'calendar_embed'
  const supportsTextStyle = isSection || ['headline', 'title', 'subheading', 'subtitle', 'description', 'text', 'hero', 'cta', 'benefits', 'testimonials', 'services', 'faq', 'form_embed', 'social_profile'].includes(block.blockType)
  const supportsMedia = block.blockType === 'image' || block.blockType === 'video'
  const supportsCards = ['benefits', 'testimonials', 'services', 'faq'].includes(block.blockType)
  const defaultBorderWidth = getBlockBorderWidthFallback(site, block)
  const blockTextPaint = getSettingPaint(settings, 'blockText', getPageTextPaint(site))
  const isBold = settings.fontWeight === 'bold'
  const isItalic = settings.fontStyle === 'italic'
  const isUnderline = settings.textDecoration === 'underline'
  const currentFontFamily = getSettingString(settings, 'fontFamily')
  const fontOptions = currentFontFamily && !GOOGLE_FONT_OPTIONS.some(option => option.value === currentFontFamily)
    ? [...GOOGLE_FONT_OPTIONS, { label: 'Fuente actual', value: currentFontFamily }]
    : GOOGLE_FONT_OPTIONS
  const patchTextFormat = (patch: Record<string, unknown>) => {
    onPatchSettings(patch)
    window.setTimeout(onSave, 0)
  }

  return (
    <div className={styles.blockStyleControls} onClick={(event) => event.stopPropagation()}>
      {supportsTextStyle && (
        <>
          <div className={styles.panelSubheader}>Personalizacion del texto</div>
          <div className={styles.textFormatPanel}>
            <div className={styles.textToolbar}>
              <label className={styles.textFontSelect}>
                <span>Fuente</span>
                <select value={currentFontFamily} onChange={(event) => onPatchSettings({ fontFamily: event.target.value })} onBlur={onSave}>
                  {fontOptions.map(option => (
                    <option key={option.label} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <div className={styles.textFormatButtons} role="group" aria-label="Formato de texto">
                <button
                  type="button"
                  className={isBold ? styles.textFormatActive : ''}
                  aria-pressed={isBold}
                  title="Negrita"
                  aria-label="Negrita"
                  onClick={() => patchTextFormat({ fontWeight: isBold ? 'normal' : 'bold' })}
                >
                  <Bold size={15} />
                </button>
                <button
                  type="button"
                  className={isItalic ? styles.textFormatActive : ''}
                  aria-pressed={isItalic}
                  title="Italica"
                  aria-label="Italica"
                  onClick={() => patchTextFormat({ fontStyle: isItalic ? '' : 'italic' })}
                >
                  <Italic size={15} />
                </button>
                <button
                  type="button"
                  className={isUnderline ? styles.textFormatActive : ''}
                  aria-pressed={isUnderline}
                  title="Subrayado"
                  aria-label="Subrayado"
                  onClick={() => patchTextFormat({ textDecoration: isUnderline ? '' : 'underline' })}
                >
                  <Underline size={15} />
                </button>
              </div>
            </div>
            <AlignmentControl
              label="Alineacion"
              value={getHorizontalAlign(settings, 'textAlign', getBlockTextAlignFallback(site, block, blocks))}
              options={horizontalAlignOptions}
              onChange={(value) => onPatchSettings({ textAlign: value })}
              onCommit={onSave}
            />
            <div className={styles.twoColumn}>
              <DimensionField
                label="Tamano de letra"
                value={getSettingNumber(settings, 'fontSize', getBlockFontSizeFallback(site, block), 12, 96)}
                min={12}
                max={96}
                unit="px"
                onChange={(value) => onPatchSettings({ fontSize: value })}
                onCommit={onSave}
              />
              <DimensionField
                label="Ancho texto"
                value={getSettingNumber(settings, 'contentMaxWidth', getBlockContentMaxWidthFallback(site, block), 10, 120)}
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
                value={blockTextPaint}
                allowGradient
                onChange={(value) => onPatchSettings({ blockText: value })}
                onCommit={onSave}
              />
              <ColorField
                label="Color contorno"
                value={getSettingPaint(settings, 'textStrokeColor', paintFallbackColor(blockTextPaint, '#111827'))}
                allowGradient
                onChange={(value) => onPatchSettings({ textStrokeColor: value })}
                onCommit={onSave}
              />
            </div>
            <DimensionField
              label="Contorno"
              value={getSettingNumber(settings, 'textStrokeWidth', 0, 0, 12)}
              min={0}
              max={12}
              unit="px"
              onChange={(value) => onPatchSettings({ textStrokeWidth: value })}
              onCommit={onSave}
            />
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
              value={getSettingPaint(settings, 'buttonTextColor', onAccentFor(defaultAccent))}
              allowGradient
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
              value={getSettingPaint(settings, 'buttonBorderColor', getSettingPaint(settings, 'buttonBg', defaultAccent))}
              allowGradient
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
              value={getSettingPaint(settings, 'fieldBorder', '#dbe3ef')}
              allowGradient
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
              value={getSettingPaint(settings, 'cardBorderColor', '#dbe3ef')}
              allowGradient
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
        label={isSection ? 'Relleno de franja' : 'Relleno'}
        base="blockPadding"
        settings={settings}
        min={SPACING_OVERLAP_MIN}
        max={160}
        fallback={getSettingNumber(settings, 'blockPadding', 0, SPACING_OVERLAP_MIN, 160)}
        onChange={onPatchSettings}
        onCommit={onSave}
      />
      <LinkedSpacingField
        label={isSection ? 'Margen de franja' : 'Margen'}
        base="blockMargin"
        settings={settings}
        min={SPACING_OVERLAP_MIN}
        max={200}
        fallback={getSettingNumber(settings, 'blockMargin', 0, SPACING_OVERLAP_MIN, 200)}
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
            value={getSettingPaint(settings, 'blockBorderColor', '#dbe3ef')}
            allowGradient
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
  site?: PublicSite
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
  site,
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

  if (block.blockType === 'social_profile') {
    const platform = normalizeSocialPlatform(settings.platform)
    const fallbackTheme = site?.theme || {}
    const brandName = getSettingString(settings, 'brandName') || fallbackTheme.brandName || site?.title || site?.name || 'Tu marca'
    const socialSite = {
      ...(site || {}),
      id: site?.id || block.siteId,
      name: site?.name || brandName,
      title: site?.title || brandName,
      theme: {
        ...fallbackTheme,
        template: platform,
        brandName,
        brandSubtitle: getSettingString(settings, 'brandSubtitle') || fallbackTheme.brandSubtitle || (platform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado'),
        brandAvatar: getSettingString(settings, 'brandAvatar') || fallbackTheme.brandAvatar || '',
        followers: getSettingString(settings, 'followers') || fallbackTheme.followers || '',
        brandVerified: settings.brandVerified === undefined ? fallbackTheme.brandVerified : settings.brandVerified !== false
      }
    } as PublicSite

    return <CanvasChrome platform={platform} site={socialSite} embedded onPatchTheme={() => {}} onSave={() => {}} />
  }

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
        <InlineButtonEditable value={getSettingString(settings, 'buttonText')} placeholder="Texto del boton" disabled={!editable} onChange={(value) => patchSettings({ buttonText: value })} onCommit={save} />
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
      <InlineButtonEditable value={getSettingString(settings, 'buttonText') || block.content || ''} placeholder="Boton" disabled={!editable} onChange={(value) => patchSettings({ buttonText: value })} onCommit={save} />
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
    const selectedFormFields = Array.isArray(form?.blocks)
      ? form.blocks.filter(field => fieldBlockTypes.has(field.blockType))
      : []
    const description = form ? `Usando formulario: ${form.name}` : getSettingString(settings, 'description')
    const fields = embeddedBlocks.length
      ? embeddedBlocks
      : selectedFormFields.length
        ? selectedFormFields
        : [{ id: 'placeholder', blockType: 'short_text', label: 'Campo', required: true, placeholder: 'Respuesta' } as SiteBlock]
    return (
      <section className="rstk-embedded-form">
        <InlineEditable as="h2" value={block.content} placeholder="Formulario" disabled={!editable} onChange={(value) => patchBlock({ content: value })} onCommit={save} />
        {description && <p className="rstk-help">{description}</p>}
        {fields.map(field => <FieldStaticPreview key={field.id} block={field} />)}
        <div className="rstk-actions rstk-embed-actions">
          <button type="button" data-submit>Enviar</button>
        </div>
      </section>
    )
  }

  if (block.blockType === 'cta') {
    return (
      <section className="rstk-cta">
        <InlineEditable as="h2" value={block.content} placeholder={block.label || 'CTA final'} disabled={!editable} onChange={(value) => patchBlock({ content: value })} onCommit={save} />
        <InlineEditable as="p" multiline value={getSettingString(settings, 'subtitle')} placeholder="Subtitulo" disabled={!editable} onChange={(value) => patchSettings({ subtitle: value })} onCommit={save} />
        <InlineButtonEditable value={getSettingString(settings, 'buttonText')} placeholder="Texto del boton" disabled={!editable} onChange={(value) => patchSettings({ buttonText: value })} onCommit={save} />
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

const PhoneCountryInputPreview: React.FC<{ placeholder?: string }> = ({ placeholder }) => {
  const detected = getDetectedAccountLocaleDefaults()
  const selectedCountry = getCountryDefaults(detected.countryCode)

  return (
    <div className="rstk-phone-input">
      <select aria-label="Pais y lada" defaultValue={selectedCountry.value}>
        {COUNTRY_OPTIONS.map(country => (
          <option key={country.value} value={country.value}>
            {getCountryFlagEmoji(country.value)} +{country.dialCode}
          </option>
        ))}
      </select>
      <input type="tel" readOnly placeholder={placeholder || 'Numero'} />
    </div>
  )
}

const getFieldPreviewInputType = (blockType: SiteBlockType) => {
  if (blockType === 'email') return 'email'
  if (blockType === 'phone') return 'tel'
  if (blockType === 'date') return 'date'
  if (blockType === 'number' || blockType === 'currency') return 'number'
  return 'text'
}

const getPreviewOptions = (block: SiteBlock): SiteBlockOption[] => {
  const options = getOptions(block)
  return options.length ? options : [{ id: 'preview-option', label: 'Opcion', value: 'Opcion', action: 'continue' }]
}

const FieldControlPreview: React.FC<{ block: SiteBlock }> = ({ block }) => {
  if (block.blockType === 'paragraph') {
    return <textarea readOnly rows={4} placeholder={block.placeholder || ''} />
  }

  if (block.blockType === 'dropdown') {
    return (
      <select defaultValue="" aria-label={block.label || 'Pregunta'}>
        <option value="">{block.placeholder || 'Selecciona una opcion'}</option>
        {getPreviewOptions(block).map(option => (
          <option key={option.id || option.label} value={option.value || option.label}>{option.label}</option>
        ))}
      </select>
    )
  }

  if (block.blockType === 'radio' || block.blockType === 'checkboxes') {
    return (
      <div className="rstk-options">
        {getPreviewOptions(block).map(option => (
          <label key={option.id || option.label} className="rstk-option">
            <input type={block.blockType === 'checkboxes' ? 'checkbox' : 'radio'} name={block.id || block.label} readOnly />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    )
  }

  if (block.blockType === 'phone' && isPhoneCountrySelectorEnabled(block)) {
    return <PhoneCountryInputPreview placeholder={block.placeholder || ''} />
  }

  return <input type={getFieldPreviewInputType(block.blockType)} readOnly placeholder={block.placeholder || 'Respuesta'} />
}

// Read-only field preview (rstk markup) for embedded form fields on the canvas.
const FieldStaticPreview: React.FC<{ block: SiteBlock }> = ({ block }) => (
  <section className="rstk-field">
    <label>{block.label || 'Pregunta'}{block.required ? <span className="rstk-required">*</span> : null}</label>
    {block.content ? <p className="rstk-help">{block.content}</p> : null}
    <FieldControlPreview block={block} />
  </section>
)

// Field blocks: rstk-field markup with inline-editable label/help. The input is
// a non-interactive preview; placeholder/validation/options are edited in the panel.
const FieldPreview: React.FC<{
  block: SiteBlock
  editable: boolean
  onPatchBlock: (patch: Partial<SiteBlock>) => void
  onSave: () => void
}> = ({ block, editable, onPatchBlock, onSave }) => {
  return (
    <section className="rstk-field">
      <label>
        <InlineEditable as="span" value={block.label} placeholder="Pregunta" disabled={!editable} onChange={(value) => onPatchBlock({ label: value })} onCommit={onSave} />
        {block.required ? <span className="rstk-required">*</span> : null}
      </label>
      {(editable || block.content) && (
        <InlineEditable as="p" className="rstk-help" multiline value={block.content} placeholder="Texto de ayuda (opcional)" disabled={!editable} onChange={(value) => onPatchBlock({ content: value })} onCommit={onSave} />
      )}
      <FieldControlPreview block={block} />
    </section>
  )
}

interface PropertiesPanelProps {
  site: PublicSite
  block: SiteBlock | null
  blocks: SiteBlock[]
  allBlocks?: SiteBlock[]
  forms: PublicSite[]
  calendars: CalendarType[]
  customFields: CustomFieldDefinition[]
  pages: SitePage[]
  activePageId: string
  metaPixelConnected: boolean
  connectedSocialProfiles: ConnectedSocialProfile[]
  loadingSocialProfiles: boolean
  onPatchSite: (patch: Partial<PublicSite>) => void
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSaveSite: () => void
  onPatchBlock: (patch: Partial<SiteBlock>) => void
  onPatchSettings: (patch: Record<string, unknown>) => void
  onPatchCategorySettings: (block: SiteBlock, patch: Record<string, unknown>) => void
  onSaveCategory: (block: SiteBlock) => void
  onSave: () => void
}

const FormGlobalStyleControls: React.FC<{
  site: PublicSite
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSaveSite: () => void
}> = ({ site, onPatchTheme, onSaveSite }) => {
  if (!isFormSite(site)) return null

  const theme = site.theme || {}
  const defaultAccent = defaultAccentForSite(site)
  const inputText = isSiteDark(site) ? '#ffffff' : '#111827'
  const accentRgb = cssColorToHex(defaultAccent, '#111827').replace('#', '').match(/.{2}/g)?.map(hex => parseInt(hex, 16)).join(', ') || '17, 24, 39'
  const defaultChoiceSelectedBg = `rgba(${accentRgb}, 0.10)`
  const currentFontFamily = getThemeString(theme, 'formFontFamily')
  const fontOptions = currentFontFamily && !GOOGLE_FONT_OPTIONS.some(option => option.value === currentFontFamily)
    ? [...GOOGLE_FONT_OPTIONS, { label: 'Fuente actual', value: currentFontFamily }]
    : GOOGLE_FONT_OPTIONS
  const isBold = theme.formFontWeight === 'bold'
  const isItalic = theme.formFontStyle === 'italic'
  const isUnderline = theme.formTextDecoration === 'underline'
  const patchTextFormat = (patch: Partial<SiteTheme>) => {
    onPatchTheme(patch)
    window.setTimeout(onSaveSite, 0)
  }

  return (
    <div className={styles.formGlobalControls}>
      <div className={styles.panelSubheader}>Formulario global</div>
      <div className={styles.textFormatPanel}>
        <div className={styles.textToolbar}>
          <label className={styles.textFontSelect}>
            <span>Tipografia</span>
            <select value={currentFontFamily} onChange={(event) => onPatchTheme({ formFontFamily: event.target.value })} onBlur={onSaveSite}>
              {fontOptions.map(option => (
                <option key={option.label} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <div className={styles.textFormatButtons} role="group" aria-label="Formato global de formulario">
            <button type="button" className={isBold ? styles.textFormatActive : ''} aria-pressed={isBold} title="Negrita" aria-label="Negrita" onClick={() => patchTextFormat({ formFontWeight: isBold ? 'normal' : 'bold' })}>
              <Bold size={15} />
            </button>
            <button type="button" className={isItalic ? styles.textFormatActive : ''} aria-pressed={isItalic} title="Italica" aria-label="Italica" onClick={() => patchTextFormat({ formFontStyle: isItalic ? 'normal' : 'italic' })}>
              <Italic size={15} />
            </button>
            <button type="button" className={isUnderline ? styles.textFormatActive : ''} aria-pressed={isUnderline} title="Subrayado" aria-label="Subrayado" onClick={() => patchTextFormat({ formTextDecoration: isUnderline ? 'none' : 'underline' })}>
              <Underline size={15} />
            </button>
          </div>
        </div>
        <div className={styles.twoColumn}>
          <DimensionField label="Texto pregunta" value={getThemeNumber(theme, 'formLabelSize', 15, 11, 28)} min={11} max={28} onChange={(value) => onPatchTheme({ formLabelSize: value })} onCommit={onSaveSite} />
          <DimensionField label="Texto respuesta" value={getThemeNumber(theme, 'formInputSize', 16, 11, 28)} min={11} max={28} onChange={(value) => onPatchTheme({ formInputSize: value })} onCommit={onSaveSite} />
        </div>
        <DimensionField label="Texto ayuda" value={getThemeNumber(theme, 'formHelpSize', 14, 10, 24)} min={10} max={24} onChange={(value) => onPatchTheme({ formHelpSize: value })} onCommit={onSaveSite} />
      </div>

      <div className={styles.twoColumn}>
        <ColorField label="Pregunta" value={getThemePaint(theme, 'formLabelColor', getThemePaint(theme, 'textColor', inputText))} allowGradient onChange={(value) => onPatchTheme({ formLabelColor: value })} onCommit={onSaveSite} />
        <ColorField label="Ayuda" value={getThemePaint(theme, 'formHelpColor', '#64748b')} allowGradient onChange={(value) => onPatchTheme({ formHelpColor: value })} onCommit={onSaveSite} />
      </div>
      <div className={styles.twoColumn}>
        <ColorField label="Caja" value={getThemePaint(theme, 'formFieldBg', '#ffffff')} allowGradient onChange={(value) => onPatchTheme({ formFieldBg: value })} onCommit={onSaveSite} />
        <ColorField label="Texto caja" value={getThemePaint(theme, 'formFieldText', inputText)} allowGradient onChange={(value) => onPatchTheme({ formFieldText: value })} onCommit={onSaveSite} />
      </div>
      <div className={styles.twoColumn}>
        <ColorField label="Borde caja" value={getThemePaint(theme, 'formFieldBorder', '#dbe3ef')} allowGradient onChange={(value) => onPatchTheme({ formFieldBorder: value })} onCommit={onSaveSite} />
        <ColorField label="Texto de ejemplo" value={getThemePaint(theme, 'formPlaceholderColor', '#94a3b8')} allowGradient onChange={(value) => onPatchTheme({ formPlaceholderColor: value })} onCommit={onSaveSite} />
      </div>

      <div className={styles.twoColumn}>
        <DimensionField label="Alto caja" value={getThemeNumber(theme, 'formFieldHeight', 50, 34, 96)} min={34} max={96} onChange={(value) => onPatchTheme({ formFieldHeight: value })} onCommit={onSaveSite} />
        <DimensionField label="Radio caja" value={getThemeNumber(theme, 'formFieldRadius', 12, 0, 36)} min={0} max={36} onChange={(value) => onPatchTheme({ formFieldRadius: value })} onCommit={onSaveSite} />
      </div>
      <div className={styles.twoColumn}>
        <DimensionField label="Borde caja" value={getThemeNumber(theme, 'formFieldBorderWidth', 1, 0, 8)} min={0} max={8} onChange={(value) => onPatchTheme({ formFieldBorderWidth: value })} onCommit={onSaveSite} />
        <DimensionField label="Relleno lados" value={getThemeNumber(theme, 'formFieldPaddingX', 14, 6, 48)} min={6} max={48} onChange={(value) => onPatchTheme({ formFieldPaddingX: value })} onCommit={onSaveSite} />
      </div>
      <DimensionField label="Relleno vertical" value={getThemeNumber(theme, 'formFieldPaddingY', 13, 6, 36)} min={6} max={36} onChange={(value) => onPatchTheme({ formFieldPaddingY: value })} onCommit={onSaveSite} />

      <div className={styles.twoColumn}>
        <label className={styles.field}>
          <span>Estilo opciones</span>
          <select value={normalizeFormChoiceStyle(theme.formChoiceStyle)} onChange={(event) => onPatchTheme({ formChoiceStyle: event.target.value as FormChoiceStyle })} onBlur={onSaveSite}>
            {formChoiceStyleOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>Estilo lista</span>
          <select value={normalizeFormSelectStyle(theme.formSelectStyle)} onChange={(event) => onPatchTheme({ formSelectStyle: event.target.value as FormSelectStyle })} onBlur={onSaveSite}>
            {formSelectStyleOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <div className={styles.twoColumn}>
        <ColorField label="Opcion seleccionada" value={getThemePaint(theme, 'formChoiceSelectedBg', defaultChoiceSelectedBg)} allowGradient onChange={(value) => onPatchTheme({ formChoiceSelectedBg: value })} onCommit={onSaveSite} />
        <ColorField label="Borde seleccionado" value={getThemePaint(theme, 'formChoiceSelectedBorder', defaultAccent)} allowGradient onChange={(value) => onPatchTheme({ formChoiceSelectedBorder: value })} onCommit={onSaveSite} />
      </div>

      <div className={styles.panelSubheader}>Boton de envio</div>
      <div className={styles.twoColumn}>
        <label className={styles.field}>
          <span>Texto del boton</span>
          <input value={theme.submitText || ''} placeholder="Enviar" onChange={(event) => onPatchTheme({ submitText: event.target.value })} onBlur={onSaveSite} />
        </label>
        <label className={styles.field}>
          <span>Subtexto</span>
          <input value={theme.submitSubtitle || ''} placeholder="Tarda menos de un minuto" onChange={(event) => onPatchTheme({ submitSubtitle: event.target.value })} onBlur={onSaveSite} />
        </label>
      </div>
      <div className={styles.twoColumn}>
        <ColorField label="Fondo boton" value={getThemePaint(theme, 'submitBg', defaultAccent)} allowGradient onChange={(value) => onPatchTheme({ submitBg: value })} onCommit={onSaveSite} />
        <ColorField label="Texto boton" value={getThemePaint(theme, 'submitTextColor', onAccentFor(defaultAccent))} allowGradient onChange={(value) => onPatchTheme({ submitTextColor: value })} onCommit={onSaveSite} />
      </div>
      <div className={styles.twoColumn}>
        <ColorField label="Borde boton" value={getThemePaint(theme, 'submitBorderColor', defaultAccent)} allowGradient onChange={(value) => onPatchTheme({ submitBorderColor: value })} onCommit={onSaveSite} />
        <DimensionField label="Radio boton" value={getThemeNumber(theme, 'submitRadius', 12, 0, 80)} min={0} max={80} onChange={(value) => onPatchTheme({ submitRadius: value })} onCommit={onSaveSite} />
      </div>
      <div className={styles.twoColumn}>
        <DimensionField label="Alto boton" value={getThemeNumber(theme, 'submitHeight', 50, 34, 96)} min={34} max={96} onChange={(value) => onPatchTheme({ submitHeight: value })} onCommit={onSaveSite} />
        <DimensionField label="Texto boton" value={getThemeNumber(theme, 'submitFontSize', 16, 11, 32)} min={11} max={32} onChange={(value) => onPatchTheme({ submitFontSize: value })} onCommit={onSaveSite} />
      </div>
      <div className={styles.twoColumn}>
        <DimensionField label="Relleno boton" value={getThemeNumber(theme, 'submitPaddingX', 22, 8, 72)} min={8} max={72} onChange={(value) => onPatchTheme({ submitPaddingX: value })} onCommit={onSaveSite} />
        <DimensionField label="Borde boton" value={getThemeNumber(theme, 'submitBorderWidth', 1, 0, 8)} min={0} max={8} onChange={(value) => onPatchTheme({ submitBorderWidth: value })} onCommit={onSaveSite} />
      </div>
    </div>
  )
}

const PageInspector: React.FC<{
  site: PublicSite
  pages: SitePage[]
  activePageId: string
  metaPixelConnected: boolean
  onPatchSite: (patch: Partial<PublicSite>) => void
  onPatchTheme: (patch: Partial<SiteTheme>) => void
  onSaveSite: () => void
}> = ({ site, pages, activePageId, metaPixelConnected, onPatchSite, onPatchTheme, onSaveSite }) => {
  const theme = site.theme || {}
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
        <strong>Pagina</strong>
        <span>{isLanding(site) ? 'Sitio embudo' : 'Formulario'}</span>
      </div>
      <div className={styles.propertiesBody}>
        <>
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
              label="Texto de pagina"
              value={getThemePaint(theme, 'textColor', isSiteDark(site) ? '#ffffff' : '#111827')}
              allowGradient
              onChange={(value) => onPatchTheme({ textColor: value, textColorCustom: true })}
              onCommit={onSaveSite}
            />
          </div>
          <ColorField
            label="Acento"
            value={getThemePaint(theme, 'accentColor', userAccentColor(site) || (isSiteDark(site) ? '#ffffff' : '#111827'))}
            allowGradient
            onChange={(value) => onPatchTheme({ accentColor: value })}
            onCommit={onSaveSite}
          />
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
              label="Relleno de pagina"
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
              value={getThemePaint(theme, 'pageBorderColor', '#dbe3ef')}
              allowGradient
              onChange={(value) => onPatchTheme({ pageBorderColor: value })}
              onCommit={onSaveSite}
            />
          </div>
          {isFormSite(site) && (
            <FormGlobalStyleControls site={site} onPatchTheme={onPatchTheme} onSaveSite={onSaveSite} />
          )}
          {metaPixelConnected && (
            <>
              <div className={styles.panelSubheader}>Medicion Meta</div>
              <div className={`${styles.metaCard} ${site.metaCapiEnabled ? styles.metaCardActive : ''}`}>
                <span className={styles.metaMark} aria-hidden="true">∞</span>
                <div className={styles.metaCardInfo}>
                  <strong>{site.metaCapiEnabled ? 'Meta encendido' : 'Meta apagado'}</strong>
                  <small>{site.metaCapiEnabled ? 'Se mediran visitas y conversiones' : 'Activalo para enviar eventos'}</small>
                </div>
                <label className={styles.metaSwitch}>
                  <input
                    type="checkbox"
                    checked={Boolean(site.metaCapiEnabled)}
                    aria-label="Activar medicion de Meta"
                    onChange={(event) => {
                      onPatchSite({ metaCapiEnabled: event.target.checked })
                      window.setTimeout(onSaveSite, 0)
                    }}
                  />
                  <span className={styles.metaSwitchTrack} />
                </label>
              </div>
            </>
          )}
          {metaPixelConnected && isLanding(site) && activePage && (
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
          {metaPixelConnected && isFormSite(site) && (
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
	              {isStandardForm(site) && (
                <>
                  <label className={styles.field}>
                    <span>Al enviar formulario</span>
                    <select
                      value={getThemeFormCompletionAction(theme)}
                      onChange={(event) => onPatchTheme({ formCompletionAction: event.target.value as FormCompletionAction })}
                      onBlur={onSaveSite}
                    >
                      <option value="next_page_if_qualified">Mostrar Agradecimiento o Descalificacion segun resultado</option>
                      <option value="next_page">Siempre mostrar pagina Agradecimiento</option>
                      <option value="form_default">Mostrar mensaje en este formulario</option>
                    </select>
                  </label>
                  <label className={styles.field}>
                    <span>Mensaje si califica</span>
                    <textarea
                      rows={2}
                      value={theme.finalMessages?.success || ''}
                      placeholder="Listo. Recibimos tu informacion."
                      onChange={(event) => onPatchTheme({ finalMessages: { ...(theme.finalMessages || {}), success: event.target.value } })}
                      onBlur={onSaveSite}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>Mensaje si no califica</span>
                    <textarea
                      rows={2}
                      value={theme.finalMessages?.disqualified || ''}
                      placeholder="Gracias por responder. Por ahora no parece ser el siguiente paso ideal."
                      onChange={(event) => onPatchTheme({ finalMessages: { ...(theme.finalMessages || {}), disqualified: event.target.value } })}
                      onBlur={onSaveSite}
                    />
                  </label>
                </>
              )}
            </>
          )}
        </div>
        </>
      </div>
    </aside>
  )
}

const customFieldTypeCompatibility: Partial<Record<SiteBlockType, string[]>> = {
  short_text: ['text'],
  paragraph: ['textarea', 'text'],
  number: ['number'],
  currency: ['currency', 'number'],
  dropdown: ['dropdown', 'select', 'radio'],
  radio: ['radio', 'dropdown', 'select'],
  checkboxes: ['checkboxes', 'multiselect'],
  phone: ['phone'],
  email: ['email'],
  date: ['date']
}

const normalizeCustomFieldDataType = (value = '') => {
  if (value === 'select') return 'dropdown'
  if (value === 'multiselect') return 'checkboxes'
  return value
}

const customFieldTypeLabel = (value = '') => {
  const type = normalizeCustomFieldDataType(value)
  if (type === 'text') return 'Texto corto'
  if (type === 'textarea') return 'Parrafo'
  if (type === 'radio') return 'Opcion unica'
  if (type === 'dropdown') return 'Lista desplegable'
  if (type === 'checkboxes') return 'Varias opciones'
  if (type === 'number') return 'Numero'
  if (type === 'currency') return 'Moneda'
  if (type === 'date') return 'Fecha'
  if (type === 'email') return 'Correo'
  if (type === 'phone') return 'Telefono'
  return value || 'Campo'
}

const isCustomFieldCompatibleWithBlock = (blockType: SiteBlockType, field: CustomFieldDefinition) => {
  const allowed = customFieldTypeCompatibility[blockType]
  if (!allowed) return false
  const dataType = normalizeCustomFieldDataType(field.dataType)
  return allowed.includes(dataType)
}

const CustomFieldBindingControl: React.FC<{
  block: SiteBlock
  customFields: CustomFieldDefinition[]
  onPatchSettings: (patch: Record<string, unknown>) => void
  onSave: () => void
}> = ({ block, customFields, onPatchSettings, onSave }) => {
  const settings = block.settings || {}
  const currentDefinitionId = getSettingString(settings, 'customFieldDefinitionId')
  const compatibleFields = customFields
    .filter(field => !field.archived && isCustomFieldCompatibleWithBlock(block.blockType, field))
    .sort((a, b) => (
      String(a.folderName || '').localeCompare(String(b.folderName || '')) ||
      String(a.label || '').localeCompare(String(b.label || ''))
    ))
  const selectedField = compatibleFields.find(field => field.definitionId === currentDefinitionId) ||
    customFields.find(field => field.definitionId === currentDefinitionId)
  const groups = compatibleFields.reduce((acc, field) => {
    const folderName = field.folderName || 'Sin carpeta'
    const current = acc.get(folderName) || []
    current.push(field)
    acc.set(folderName, current)
    return acc
  }, new Map<string, CustomFieldDefinition[]>())

  return (
    <div className={styles.customFieldBinding}>
      <div className={styles.panelSubheader}>Guardado de respuesta</div>
      <label className={styles.field}>
        <span>Guardar respuesta en</span>
        <select
          value={currentDefinitionId}
          onChange={(event) => {
            const definitionId = event.target.value
            const field = compatibleFields.find(item => item.definitionId === definitionId)

            if (!field) {
              onPatchSettings({
                customFieldDefinitionId: '',
                customFieldKey: '',
                customFieldLabel: '',
                customFieldDataType: ''
              })
              window.setTimeout(onSave, 0)
              return
            }

            onPatchSettings({
              customFieldDefinitionId: field.definitionId,
              customFieldKey: field.fieldKey || field.key,
              customFieldLabel: field.label,
              customFieldDataType: field.dataType
            })
            window.setTimeout(onSave, 0)
          }}
          onBlur={onSave}
        >
          <option value="">No guardar en campo personalizado</option>
          {[...groups.entries()].map(([folderName, groupFields]) => (
            <optgroup key={folderName} label={folderName}>
              {groupFields.map(field => (
                <option key={field.definitionId} value={field.definitionId}>
                  {field.label} - {field.fieldKey || field.key}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {selectedField ? (
        <p className={styles.customFieldHint}>
          Se guardara como <code>{selectedField.fieldKey || selectedField.key}</code> ({customFieldTypeLabel(selectedField.dataType)}).
        </p>
      ) : (
        <p className={styles.customFieldHint}>
          Crea campos compatibles en Configuracion para guardar este dato dentro del contacto.
        </p>
      )}
    </div>
  )
}

const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  site,
  block,
  blocks,
  allBlocks,
  forms,
  calendars,
  customFields,
  pages,
  activePageId,
  metaPixelConnected,
  connectedSocialProfiles,
  loadingSocialProfiles,
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
    return (
      <PageInspector
        site={site}
        pages={pages}
        activePageId={activePageId}
        metaPixelConnected={metaPixelConnected}
        onPatchSite={onPatchSite}
        onPatchTheme={onPatchTheme}
        onSaveSite={onSaveSite}
      />
    )
  }

  const isField = fieldBlockTypes.has(block.blockType)
  const settings = block.settings || {}
  const contentLabel = isField
    ? 'Texto de ayuda'
    : block.blockType === SECTION_BLOCK_TYPE
      ? 'Titulo visible opcional'
      : block.blockType === 'embed'
        ? 'Codigo externo, iframe o URL'
        : 'Contenido'
  const contentRows = block.blockType === 'embed' ? 7 : isField || block.blockType === SECTION_BLOCK_TYPE ? 2 : 3

  return (
    <aside className={styles.propertiesPanel}>
      <div className={styles.panelHeader}>
        <strong>Propiedades</strong>
        <span>{blockLabels[block.blockType]}</span>
      </div>

      <div className={styles.propertiesBody}>
        {isFormSite(site) && isField && (
          <FormGlobalStyleControls site={site} onPatchTheme={onPatchTheme} onSaveSite={onSaveSite} />
        )}

        <label className={styles.field}>
          <span>{isField ? 'Pregunta visible' : block.blockType === SECTION_BLOCK_TYPE ? 'Nombre de la franja' : 'Nombre del bloque'}</span>
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
                <span>Texto dentro del campo</span>
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
                <span>Validacion</span>
                <select
                  value={getSettingString(settings, 'validation')}
                  onChange={(event) => onPatchSettings({ validation: event.target.value })}
                  onBlur={onSave}
                >
                  <option value="">Ninguna</option>
                  <option value="email">Correo</option>
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

            {block.blockType === 'phone' && (
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={isPhoneCountrySelectorEnabled(block)}
                  onChange={(event) => {
                    onPatchSettings({ phoneCountrySelectorEnabled: event.target.checked })
                    window.setTimeout(onSave, 0)
                  }}
                />
                <span>Mostrar pais y lada</span>
              </label>
            )}

            <CustomFieldBindingControl
              block={block}
              customFields={customFields}
              onPatchSettings={onPatchSettings}
              onSave={onSave}
            />
          </>
        )}

        {isChoiceBlock(block.blockType) && (
          <OptionsRulesEditor block={block} blocks={allBlocks || blocks} pages={pages} onPatchBlock={onPatchBlock} onSave={onSave} />
        )}

        {!isField && (
          <LandingBlockSettings
            site={site}
            block={block}
            forms={forms}
            calendars={calendars}
            pages={pages}
            activePageId={activePageId}
            connectedSocialProfiles={connectedSocialProfiles}
            loadingSocialProfiles={loadingSocialProfiles}
            onPatchSettings={onPatchSettings}
            onSave={onSave}
          />
        )}

        <InlineBlockStyleControls
          site={site}
          block={block}
          blocks={blocks}
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
  pages: SitePage[]
  onPatchBlock: (patch: Partial<SiteBlock>) => void
  onSave: () => void
}

const OptionsRulesEditor: React.FC<OptionsRulesEditorProps> = ({ block, blocks, pages, onPatchBlock, onSave }) => {
  const options = getOptions(block)
  const fieldTargets = blocks.filter(item => fieldBlockTypes.has(item.blockType) && item.id !== block.id)
  const getTargetLabel = (target: SiteBlock) => {
    const page = pages.find(item => item.id === getBlockPageId(target, pages))
    return page ? `${target.label} - ${page.title}` : target.label
  }

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

  const getVisibleRuleAction = (action?: SiteOptionAction) => (
    action && visibleRuleActionValues.has(action) ? action : 'continue'
  )

  const buildRuleActionPatch = (option: SiteBlockOption, action: SiteOptionAction): Partial<SiteBlockOption> => ({
    action,
    targetBlockId: action === 'jump' ? option.targetBlockId || '' : '',
    redirectUrl: action === 'redirect' ? option.redirectUrl || '' : '',
    message: '',
    tag: '',
    category: ''
  })

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
                value={getVisibleRuleAction(option.action)}
                onChange={(event) => {
                  const action = event.target.value as SiteOptionAction
                  patchOption(index, buildRuleActionPatch(option, action))
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
                {fieldTargets.map(target => <option key={target.id} value={target.id}>{getTargetLabel(target)}</option>)}
              </select>
            </label>
          )}

          {option.action === 'redirect' && (
            <label className={styles.field}>
              <span>Sitio</span>
              <input
                value={option.redirectUrl || ''}
                placeholder="https://tusitio.com"
                onChange={(event) => patchOption(index, { redirectUrl: event.target.value })}
                onBlur={onSave}
              />
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
  connectedSocialProfiles: ConnectedSocialProfile[]
  loadingSocialProfiles: boolean
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

const LandingBlockSettings: React.FC<LandingBlockSettingsProps> = ({ site, block, forms, calendars, pages, activePageId, connectedSocialProfiles, loadingSocialProfiles, onPatchSettings, onSave }) => {
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

  if (block.blockType === 'social_profile') {
    const platform = normalizeSocialPlatform(settings.platform || platformChromeFor(resolveTemplateId(site)))
    const connectedProfilesForPlatform = connectedSocialProfiles.filter(profile => profile.platform === platform)
    const selectedConnectedProfileId = getSettingString(settings, 'socialSourceProfileId')

    return (
      <div className={styles.settingsGroup}>
        <div className={styles.panelSubheader}>Perfil de red social</div>
        <label className={styles.field}>
          <span>Red social</span>
          <select
            value={platform}
            onChange={(event) => onPatchSettings({
              platform: event.target.value,
              socialAutoSync: false,
              socialSourceProfileId: '',
              socialSourcePlatform: '',
              socialSourceId: '',
              socialSourcePageId: '',
              socialSourceName: ''
            })}
            onBlur={onSave}
          >
            {socialPlatformOptions.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Perfil conectado</span>
          <select
            value={selectedConnectedProfileId}
            disabled={loadingSocialProfiles || connectedProfilesForPlatform.length === 0}
            onChange={(event) => {
              const profile = connectedProfilesForPlatform.find(item => item.id === event.target.value)
              if (profile) {
                onPatchSettings(connectedSocialProfileBlockPatch(profile))
                window.setTimeout(onSave, 0)
                return
              }
              onPatchSettings({
                socialAutoSync: false,
                socialSourceProfileId: '',
                socialSourcePlatform: '',
                socialSourceId: '',
                socialSourcePageId: '',
                socialSourceName: ''
              })
            }}
            onBlur={onSave}
          >
            <option value="">{loadingSocialProfiles ? 'Buscando perfiles...' : 'Escribir manualmente'}</option>
            {connectedProfilesForPlatform.map(profile => (
              <option key={profile.id} value={profile.id}>{socialProfileOptionLabel(profile)}</option>
            ))}
          </select>
        </label>
        <p className={styles.muted}>
          {connectedProfilesForPlatform.length > 0
            ? 'Elige un perfil para llenar los datos. Despues puedes cambiar el texto, foto o seguidores aqui mismo.'
            : 'Puedes llenar este perfil manualmente y moverlo dentro del formulario como cualquier bloque.'}
        </p>
        <label className={styles.field}>
          <span>Nombre que se vera</span>
          <input value={getSettingString(settings, 'brandName')} placeholder={site.title || site.name || 'Tu marca'} onChange={(event) => onPatchSettings({ brandName: event.target.value })} onBlur={onSave} />
        </label>
        <label className={styles.field}>
          <span>Texto secundario</span>
          <input value={getSettingString(settings, 'brandSubtitle')} placeholder={platform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado'} onChange={(event) => onPatchSettings({ brandSubtitle: event.target.value })} onBlur={onSave} />
        </label>
        <label className={styles.field}>
          <span>Foto de perfil (URL)</span>
          <input value={getSettingString(settings, 'brandAvatar')} placeholder="Pega la liga de la imagen" onChange={(event) => onPatchSettings({ brandAvatar: event.target.value })} onBlur={onSave} />
        </label>
        <div className={styles.twoColumn}>
          <label className={styles.field}>
            <span>Seguidores</span>
            <input value={getSettingString(settings, 'followers')} placeholder="12 mil" onChange={(event) => onPatchSettings({ followers: event.target.value })} onBlur={onSave} />
          </label>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={settings.brandVerified !== false}
              onChange={(event) => {
                onPatchSettings({ brandVerified: event.target.checked })
                window.setTimeout(onSave, 0)
              }}
            />
            <span>Mostrar verificado</span>
          </label>
        </div>
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
          <span>Descripcion del formulario</span>
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
