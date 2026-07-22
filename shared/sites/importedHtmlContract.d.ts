export const IMPORTED_HTML_MOBILE_BREAKPOINT_PX: number
export const IMPORTED_HTML_MOBILE_PREVIEW_WIDTH_PX: number
export const IMPORTED_HTML_MOBILE_RULES: readonly string[]
export const IMPORTED_HTML_CUSTOM_CALENDAR_RULES: readonly string[]
export const IMPORTED_HTML_CUSTOM_CALENDAR_SKELETON: string
export const IMPORTED_HTML_CUSTOM_SOCIAL_PROFILE_RULES: readonly string[]
export function buildImportedHtmlMobileRulesText(heading?: string): string
export function buildImportedHtmlCustomCalendarRulesText(heading?: string): string
export function buildImportedHtmlCustomSocialProfileRulesText(heading?: string): string
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
