export const IMPORTED_HTML_MOBILE_BREAKPOINT_PX: number
export const IMPORTED_HTML_MOBILE_PREVIEW_WIDTH_PX: number
export const IMPORTED_HTML_DEVICE_ONLY_ATTRIBUTE: string
export const DEFAULT_IMPORTED_HTML_FAVICON_TAG: string
export const IMPORTED_HTML_FAVICON_RULES: readonly string[]
export const IMPORTED_HTML_MOBILE_RULES: readonly string[]
export const IMPORTED_HTML_CUSTOM_CALENDAR_RULES: readonly string[]
export const IMPORTED_HTML_CUSTOM_CALENDAR_SKELETON: string
export const IMPORTED_HTML_CUSTOM_SOCIAL_PROFILE_RULES: readonly string[]
export const IMPORTED_HTML_VIDEO_PLAYER_SETTINGS_ATTRIBUTE: string
export const IMPORTED_HTML_VIDEO_PLAYER_SETTING_KEYS: readonly string[]
export const IMPORTED_HTML_VIDEO_PLAYER_RULES: readonly string[]
export const IMPORTED_HTML_VIDEO_PLAYER_EXAMPLE: string
export const IMPORTED_HTML_VIDEO_ACTION_TARGET_RULES: readonly string[]
export function buildImportedHtmlFaviconRulesText(heading?: string): string
export function importedHtmlHasFavicon(html?: string): boolean
export function ensureImportedHtmlFavicon(html?: string): string
export function buildImportedHtmlMobileRulesText(heading?: string): string
export function buildImportedHtmlDeviceVisibilityStyle(previewDevice?: 'desktop' | 'mobile' | ''): string
export function buildImportedHtmlCustomCalendarRulesText(heading?: string): string
export function buildImportedHtmlCustomSocialProfileRulesText(heading?: string): string
export function buildImportedHtmlVideoPlayerRulesText(heading?: string): string
export function normalizeImportedHtmlVideoPlayerManifest(value?: string | Record<string, unknown>): {
  valid: boolean
  settings: Record<string, unknown>
  tombstones: string[]
  error: string
}
export function buildImportedHtmlVideoActionTargetRulesText(heading?: string): string
export function ensureImportedHtmlVideoActionTargets(html?: string): string
export function getImportedNativeResponsiveVariant(value?: string): {
  device: 'desktop' | 'mobile' | ''
  family: string
}
export function areImportedNativeResponsiveVariants(first?: string, second?: string): boolean
export function resolveVisibleImportedNativeElementSelection(options?: {
  slots?: Array<{ id?: string; key?: string; type?: string }>
  currentKey?: string
  visibleKeys?: string[]
}): string
