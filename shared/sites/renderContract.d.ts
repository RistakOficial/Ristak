// Tipos del contrato de render de Sites (hermano de renderContract.js).
// Mantener en lockstep con las exportaciones del .js.

export interface SiteTemplateVars {
  pageBg: string
  pageImage: string
  ink: string
  muted: string
  surface: string
  surface2: string
  border: string
  accent: string
  accentStrong: string
  onAccent: string
  ring: string
  inputBg: string
  inputInk: string
  inputBorder: string
  radius: string
  radiusLg: string
  shadow: string
  headingWeight: string
  btnRadius: string
  btnWeight: string
}

export interface SiteTemplate {
  id: string
  label?: string
  mode: 'light' | 'dark'
  chrome: 'none' | 'facebook' | 'instagram' | 'tiktok' | string
  centered?: boolean
  font: string
  gradient?: string
  cyan?: string
  vars: SiteTemplateVars
}

/** Theme guardado de un sitio (shape legacy-compatible, claves abiertas). */
export type SiteTheme = Record<string, unknown>

export interface SiteLike {
  siteType?: string
  theme?: SiteTheme | null
}

/** Mapa plano de variables CSS (--rstk-*) a valor serializable. */
export type CssVarMap = Record<string, string>

export interface RenderOverrides {
  vars?: Partial<SiteTemplateVars>
  accent?: string
}

export interface SitePageRenderState {
  template: SiteTemplate
  /** Theme mergeado con DEFAULT_THEME (lecturas de valores). */
  theme: SiteTheme
  /** Theme CRUDO guardado (checks de explicitud). */
  sourceTheme: SiteTheme
  vars: CssVarMap
  bodyClassList: string[]
  pageMaxWidth: number
  pagePadding: number
  pageRadius: number
  pageBorder: string
  pageBorderWidth: number
  /** Fondo resuelto: usuario > paleta derivada/template. */
  pageBg: string
  /** Fondo sólido elegido por el usuario ('' si no hay). */
  userPageBg: string
  pageImage: string
  pageVideo: string
  pageOverlay: string
  backgroundPaint: string
  textPaint: string
  ink: string
  muted: string
  accent: string
  accentStrong: string
  ring: string
  baseFont: string
  renderOverrides: RenderOverrides
  renderVars: SiteTemplateVars
  siteIsDark: boolean
  hasExplicitBackgroundColor: boolean
  isLandingType: boolean
  isInteractive: boolean
}

export interface FormThemeStyleContext {
  baseFont: string
  v: SiteTemplateVars
  accent: string
  ink: string
  muted: string
}

export interface EmbeddedFormThemeInput {
  hostTheme?: SiteTheme | null
  sourceFormTheme?: SiteTheme | null
  embeddedThemeOverride?: SiteTheme | null
  isImportedForm?: boolean
}

export interface EmbeddedFormThemeResult {
  /** Cadena completa mergeada con DEFAULT_THEME (lecturas de valores). */
  theme: SiteTheme
  /** Cadena cruda sin DEFAULT_THEME (explicitud del frame embebido). */
  sourceTheme: SiteTheme
}

export interface PopupSurfaceDefaults {
  background: string
  color: string
}

export declare const DEFAULT_THEME: { accentColor: string; backgroundColor: string; textColor: string }
export declare const EMBEDDED_FORM_DEFAULT_THEME: { pageBorderWidth: number; pageBorderColor: string }
export declare const MIN_TEXT_CONTRAST_RATIO: number
export declare const AUTO_DARK_TEXT: string
export declare const AUTO_LIGHT_TEXT: string
export declare const FORM_PAGE_BORDER_WIDTH_MAX: number
export declare const RSTK_SANS: string
export declare const SITE_TEMPLATES: Record<string, SiteTemplate>
export declare function resolveTemplate(site: SiteLike | null | undefined): SiteTemplate
export declare const RSTK_SITE_FONTS_CSS_PATH: string
export declare const RSTK_FONT_FAMILIES: string[]
export declare const RSTK_DEFAULT_FONT: string
export declare const RSTK_DEFAULT_SERIF_FONT: string
export declare function normalizeSiteFontFamily(value: unknown): string
export declare const RSTK_BASE_CSS: string
export declare const RSTK_TEMPLATE_EXTRAS: Record<string, string>
export declare const RSTK_POPUP_CSS: string
export declare function isCssColor(value: unknown): boolean
export declare function isCssGradient(value: unknown): boolean
export declare function isCssPaint(value: unknown): boolean
export declare function normalizeCssColor(value: unknown, fallback?: string): string
export declare function normalizeCssPaint(value: unknown, fallback?: string): string
export declare function extractCssColor(value: unknown, fallback?: string): string
export declare function paintFallbackColor(paint: unknown, fallback?: string): string
export declare function relLuminance(hex: unknown): number
export declare function contrastRatio(foreground: unknown, background: unknown): number
export declare function readableTextOnBackground(paint: unknown, background: unknown, fallback?: string): string
export declare function cssImageUrl(value: unknown): string
export declare function cssMediaUrl(value: unknown): string
export declare function paintLayer(paint: string): string
export declare function backgroundFitValue(value: unknown): string
export declare function backgroundRepeatValue(value: unknown): string
export declare function backgroundPositionValue(value: unknown): string
export declare function backgroundAttachmentValue(value: unknown): string
export declare function themeNumber(theme: SiteTheme | null | undefined, key: string, fallback: number, min: number, max: number): number
export declare function themePaint(theme: SiteTheme | null | undefined, key: string): string
export declare function blockButtonAlign(settings: Record<string, unknown> | null | undefined, fallback?: string): string
export declare function justifyForAlign(align: string): string
export declare function marginForAlign(align: string): { left: string; right: string }
export declare function deriveNeutralVars(template: SiteTemplate, bg: string, userAccent?: string | null): SiteTemplateVars
export declare function resolveRenderOverrides(
  template: SiteTemplate,
  theme: SiteTheme,
  isLandingType: boolean,
  options?: { hasExplicitBackgroundColor?: boolean }
): RenderOverrides
export declare function sanitizeCssFont(value: unknown): string
export declare function normalizeFormChoiceStyle(value: unknown): string
export declare function normalizeFormSelectStyle(value: unknown): string
export declare function normalizeFormInputStyle(value: unknown): string
export declare function buildFormThemeStyleVars(theme: SiteTheme, ctx: FormThemeStyleContext): CssVarMap
export declare function serializeCssVars(map: CssVarMap | null | undefined, separator?: string): string
export declare function computeSitePageRenderState(site: SiteLike | null | undefined): SitePageRenderState
export declare function buildStyleSheet(state: SitePageRenderState): string
export declare function buildEmbeddedFormTheme(input?: EmbeddedFormThemeInput): EmbeddedFormThemeResult
export declare function popupSurfaceDefaults(siteIsDark: boolean): PopupSurfaceDefaults
export declare function rescopeSiteCssForCanvas(css: string, options?: { scope?: string }): string

// --- Superficies embebidas (Paquete D) ---

/** Opciones del builder de URL del calendario embebido. metaCalEvent/metaCalData llegan ya resueltos. */
export interface CalendarEmbedParamsOptions {
  preview?: boolean
  bookingBridge?: boolean
  metaCalEvent?: string
  metaCalData?: string
}

/** Contexto de estilo de formulario de la página anfitriona (proxies embebidos). */
export interface HostFormStyleContext extends FormThemeStyleContext {
  pageBg: string
}

export declare function buildPopupSurfaceVars(theme?: SiteTheme | null, siteIsDark?: boolean): CssVarMap
export declare function appendCalendarEmbedParams(value: string, settings?: Record<string, unknown> | null, options?: CalendarEmbedParamsOptions): string
export declare function buildFormStyleContext(state: SitePageRenderState): HostFormStyleContext
export declare function buildEmbeddedFormProxyVars(theme?: SiteTheme | null, formStyleContext?: HostFormStyleContext | null): CssVarMap

// --- Contrato de bloques (Paquete C) ---

/** Bloque guardado (shape legacy-compatible, settings abiertos). */
export interface SiteBlockLike {
  id?: string
  blockType?: string
  content?: string
  label?: string
  placeholder?: string
  required?: boolean
  settings?: Record<string, unknown> | null
}

export interface BlockStyleContext {
  parentBlock?: SiteBlockLike | null
  /** Fondo de contraste de página: blockTextContrastBackground(state). */
  pageBg?: string
  /** Mapa ya calculado (evita recomputar en blockHasStyleWrapper). */
  vars?: CssVarMap
  /** El runtime del publicado también envuelve blancos de acciones video/contador. */
  hasActionTarget?: boolean
}

export declare const FIELD_BLOCK_TYPES: Set<string>
export declare const EMBED_MIN_HEIGHT: number
export declare const EMBED_MAX_HEIGHT: number
export declare const CALENDAR_EMBED_DEFAULT_HEIGHT: number
export declare const SOCIAL_PROFILE_SCALE_MIN: number
export declare const SOCIAL_PROFILE_SCALE_MAX: number
export declare const DEFAULT_SOCIAL_PROFILE_SCALE: number
export declare const DEFAULT_VIDEO_PLAYER_BACKGROUND: string
export declare const DEFAULT_VIDEO_TRANSPARENT: string
export declare const DEFAULT_VIDEO_BORDER_FALLBACK: string
export declare const DEFAULT_VIDEO_LANDSCAPE_ASPECT_RATIO: string
export declare const DEFAULT_VIDEO_PORTRAIT_ASPECT_RATIO: string
export declare const DEFAULT_VIDEO_PORTRAIT_MEDIA_WIDTH: number
export declare function isTransparentCssColorValue(value?: unknown): boolean
export declare function getVisibleVideoBorderColor(value?: unknown): string
export declare function normalizeVideoOrientation(settings?: Record<string, unknown>, detectedOrientation?: string): 'landscape' | 'portrait'
export declare function getVideoAspectRatio(orientation: string): string
export declare function shouldUseDefaultPortraitMediaWidth(settings?: Record<string, unknown>, orientation?: string): boolean
export declare function buildVideoFrameStyleVars(settings?: Record<string, unknown>, detectedOrientation?: string): CssVarMap
export declare function safeUrl(value?: unknown): string
export declare function safeHref(value?: unknown, fallback?: string): string
export interface PanelNavLink { label: string; url: string; pageId: string }
export declare function resolvePanelNavLinks(
  rawLinks?: unknown,
  pages?: Array<{ id?: unknown; title?: unknown }>
): PanelNavLink[]
export interface NativeFieldRulesAttributes {
  inputmode?: string
  min?: number | string
  max?: number | string
  step?: number
}
export declare function getNativeFieldRulesAttributes(block?: {
  blockType?: string
  settings?: Record<string, unknown>
}): NativeFieldRulesAttributes
export declare function safePublicMediaUrl(value?: unknown, kind?: 'image' | 'video'): string
export declare function isSocialTemplate(value?: unknown): boolean
export declare function isSupportedSocialPlatform(value?: unknown): boolean
export declare function normalizeSocialPlatform(value?: unknown, fallback?: string): string
export declare function parseCountdownTargetDate(value?: unknown): number | null
export declare function countdownShowLabelsValue(value?: unknown): boolean
export declare function extractWistiaMediaId(value?: unknown): string
export declare function wistiaEmbedIframeUrl(mediaId: string): string
export declare function blockSettingColor(settings: Record<string, unknown> | null | undefined, key: string): string
export declare function blockSettingPaint(settings: Record<string, unknown> | null | undefined, key: string): string
export declare function blockSettingNumber(settings: Record<string, unknown> | null | undefined, key: string, min: number, max: number): number | null
export declare function blockSettingNumberWithFallback(settings: Record<string, unknown> | null | undefined, key: string, fallback: number, min: number, max: number): number
export declare function blockTextContrastBackground(state: Pick<SitePageRenderState, 'pageBg'> | null | undefined): string
export declare function blockHorizontalAlign(settings: Record<string, unknown> | null | undefined, key: string, fallback?: string): string
export declare function blockTextDecoration(value?: unknown): string
export declare function blockTextTransform(value?: unknown): string
export declare function blockTextListStyle(value?: unknown): string
export declare function getSectionColumns(block?: SiteBlockLike | null): number
export declare function normalizeLegacyLandingBlockSettings(block?: SiteBlockLike | null): Record<string, unknown>
export declare function buildBlockStyleVars(block?: SiteBlockLike | null, ctx?: BlockStyleContext): CssVarMap
export declare function buildBlockStyleClassName(block: SiteBlockLike): string
export type ResponsiveDevice = 'desktop' | 'tablet' | 'mobile'
export declare const RESPONSIVE_DEVICE_MAX_WIDTH: Record<'tablet' | 'mobile', number>
export declare function resolveDeviceBlockSettings(settings?: Record<string, unknown>, device?: ResponsiveDevice): Record<string, unknown>
export interface ResponsiveCssOptions { queryType?: 'media' | 'container'; containerName?: string }
export declare function buildBlockResponsiveCss(block?: SiteBlockLike | null, options?: ResponsiveCssOptions, ctx?: BlockStyleContext): string
export declare function buildBlocksResponsiveCss(blocks?: SiteBlockLike[], options?: ResponsiveCssOptions, ctx?: BlockStyleContext): string
export declare function blockHasBackgroundVideo(block?: SiteBlockLike | null): boolean
export declare function blockIsUserHidden(block?: SiteBlockLike | null): boolean
export declare function blockHasStyleWrapper(block?: SiteBlockLike | null, ctx?: BlockStyleContext): boolean
