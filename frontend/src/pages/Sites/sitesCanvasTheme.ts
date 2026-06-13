import type React from 'react'
import type { PublicSite, SiteTemplateId } from '../../services/sitesService'

/**
 * WYSIWYG canvas theme.
 *
 * This is a faithful port of the backend public-site renderer
 * (backend/src/services/sitesService.js: SITE_TEMPLATES, deriveNeutralVars,
 * resolveRenderOverrides, buildStyleSheet). The editor canvas must compute the
 * exact same `--rstk-*` variables so the "cajita" looks identical to the
 * published page. Keep this in sync with that file.
 */

const RSTK_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif"

type TemplateVars = {
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

type Template = {
  id: SiteTemplateId
  mode: 'light' | 'dark'
  chrome: 'none' | 'facebook' | 'instagram' | 'tiktok'
  centered?: boolean
  font: string
  gradient?: string
  cyan?: string
  vars: TemplateVars
}

const SITE_TEMPLATES: Record<SiteTemplateId, Template> = {
  ristak: {
    id: 'ristak', mode: 'light', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#f5f6f8',
      pageImage: 'none',
      ink: '#0f172a', muted: '#64748b', surface: '#ffffff', surface2: '#f8fafc', border: '#e6e8ec',
      accent: '#111827', accentStrong: '#000000', onAccent: '#ffffff', ring: 'rgba(17,24,39,.16)',
      inputBg: '#ffffff', inputInk: '#0f172a', inputBorder: '#dfe3e8',
      radius: '12px', radiusLg: '18px', shadow: '0 30px 60px -42px rgba(15,23,42,.4)',
      headingWeight: '800', btnRadius: '12px', btnWeight: '750'
    }
  },
  imported_html: {
    id: 'imported_html', mode: 'light', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#ffffff',
      pageImage: 'none',
      ink: '#0f172a', muted: '#64748b', surface: '#ffffff', surface2: '#f8fafc', border: '#e6e8ec',
      accent: '#111827', accentStrong: '#000000', onAccent: '#ffffff', ring: 'rgba(17,24,39,.16)',
      inputBg: '#ffffff', inputInk: '#0f172a', inputBorder: '#dfe3e8',
      radius: '12px', radiusLg: '18px', shadow: '0 30px 60px -42px rgba(15,23,42,.4)',
      headingWeight: '800', btnRadius: '12px', btnWeight: '750'
    }
  },
  executive: {
    id: 'executive', mode: 'light', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#f8fafc',
      pageImage: 'none',
      ink: '#0f172a', muted: '#475569', surface: '#ffffff', surface2: '#ecfeff', border: '#cbd5e1',
      accent: '#0f766e', accentStrong: '#115e59', onAccent: '#ffffff', ring: 'rgba(15,118,110,.18)',
      inputBg: '#ffffff', inputInk: '#0f172a', inputBorder: '#cbd5e1',
      radius: '10px', radiusLg: '18px', shadow: '0 28px 70px -46px rgba(15,23,42,.42)',
      headingWeight: '800', btnRadius: '10px', btnWeight: '800'
    }
  },
  launch: {
    id: 'launch', mode: 'light', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#fff7ed',
      pageImage: 'none',
      ink: '#1f2937', muted: '#7c2d12', surface: '#ffffff', surface2: '#ffedd5', border: '#fed7aa',
      accent: '#ea580c', accentStrong: '#c2410c', onAccent: '#ffffff', ring: 'rgba(234,88,12,.2)',
      inputBg: '#ffffff', inputInk: '#1f2937', inputBorder: '#fdba74',
      radius: '14px', radiusLg: '22px', shadow: '0 32px 72px -46px rgba(124,45,18,.45)',
      headingWeight: '850', btnRadius: '999px', btnWeight: '850'
    }
  },
  premium: {
    id: 'premium', mode: 'dark', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#101010',
      pageImage: 'none',
      ink: '#f8fafc', muted: '#a1a1aa', surface: '#18181b', surface2: '#222225', border: 'rgba(255,255,255,.14)',
      accent: '#d4af37', accentStrong: '#b88916', onAccent: '#121212', ring: 'rgba(212,175,55,.26)',
      inputBg: '#202023', inputInk: '#f8fafc', inputBorder: 'rgba(255,255,255,.16)',
      radius: '8px', radiusLg: '18px', shadow: '0 48px 90px -52px rgba(0,0,0,.9)',
      headingWeight: '850', btnRadius: '8px', btnWeight: '850'
    }
  },
  local: {
    id: 'local', mode: 'light', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#f0fdf4',
      pageImage: 'none',
      ink: '#14532d', muted: '#4b5563', surface: '#ffffff', surface2: '#dcfce7', border: '#bbf7d0',
      accent: '#15803d', accentStrong: '#166534', onAccent: '#ffffff', ring: 'rgba(21,128,61,.2)',
      inputBg: '#ffffff', inputInk: '#14532d', inputBorder: '#86efac',
      radius: '16px', radiusLg: '24px', shadow: '0 30px 70px -46px rgba(20,83,45,.38)',
      headingWeight: '800', btnRadius: '16px', btnWeight: '800'
    }
  },
  compact: {
    id: 'compact', mode: 'light', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#f8fafc',
      pageImage: 'none',
      ink: '#0f172a', muted: '#64748b', surface: '#ffffff', surface2: '#f1f5f9', border: '#dbe3ef',
      accent: '#2563eb', accentStrong: '#1d4ed8', onAccent: '#ffffff', ring: 'rgba(37,99,235,.18)',
      inputBg: '#ffffff', inputInk: '#0f172a', inputBorder: '#cbd5e1',
      radius: '8px', radiusLg: '18px', shadow: '0 24px 54px -40px rgba(15,23,42,.35)',
      headingWeight: '800', btnRadius: '10px', btnWeight: '800'
    }
  },
  event: {
    id: 'event', mode: 'light', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#fdf2f8',
      pageImage: 'none',
      ink: '#500724', muted: '#831843', surface: '#ffffff', surface2: '#fce7f3', border: '#fbcfe8',
      accent: '#be123c', accentStrong: '#9f1239', onAccent: '#ffffff', ring: 'rgba(190,18,60,.2)',
      inputBg: '#ffffff', inputInk: '#500724', inputBorder: '#f9a8d4',
      radius: '14px', radiusLg: '24px', shadow: '0 30px 68px -44px rgba(131,24,67,.42)',
      headingWeight: '850', btnRadius: '999px', btnWeight: '850'
    }
  },
  quote: {
    id: 'quote', mode: 'light', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#f5f3ff',
      pageImage: 'none',
      ink: '#2e1065', muted: '#6d28d9', surface: '#ffffff', surface2: '#ede9fe', border: '#ddd6fe',
      accent: '#7c3aed', accentStrong: '#6d28d9', onAccent: '#ffffff', ring: 'rgba(124,58,237,.2)',
      inputBg: '#ffffff', inputInk: '#2e1065', inputBorder: '#c4b5fd',
      radius: '12px', radiusLg: '22px', shadow: '0 30px 68px -44px rgba(76,29,149,.4)',
      headingWeight: '850', btnRadius: '14px', btnWeight: '850'
    }
  },
  callback: {
    id: 'callback', mode: 'light', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#ecfeff',
      pageImage: 'none',
      ink: '#164e63', muted: '#0e7490', surface: '#ffffff', surface2: '#cffafe', border: '#a5f3fc',
      accent: '#0e7490', accentStrong: '#155e75', onAccent: '#ffffff', ring: 'rgba(14,116,144,.2)',
      inputBg: '#ffffff', inputInk: '#164e63', inputBorder: '#67e8f9',
      radius: '10px', radiusLg: '18px', shadow: '0 28px 64px -42px rgba(22,78,99,.38)',
      headingWeight: '800', btnRadius: '10px', btnWeight: '850'
    }
  },
  waitlist: {
    id: 'waitlist', mode: 'light', chrome: 'none', font: RSTK_SANS,
    vars: {
      pageBg: '#fff7ed',
      pageImage: 'none',
      ink: '#7c2d12', muted: '#9a3412', surface: '#ffffff', surface2: '#ffedd5', border: '#fed7aa',
      accent: '#c2410c', accentStrong: '#9a3412', onAccent: '#ffffff', ring: 'rgba(194,65,12,.2)',
      inputBg: '#ffffff', inputInk: '#7c2d12', inputBorder: '#fdba74',
      radius: '16px', radiusLg: '28px', shadow: '0 30px 68px -44px rgba(124,45,18,.42)',
      headingWeight: '850', btnRadius: '999px', btnWeight: '850'
    }
  },
  facebook: {
    id: 'facebook', mode: 'light', chrome: 'facebook', font: RSTK_SANS,
    vars: {
      pageBg: '#f0f2f5', pageImage: 'none',
      ink: '#1c1e21', muted: '#65676b', surface: '#ffffff', surface2: '#f7f8fa', border: '#ced0d4',
      accent: '#1877f2', accentStrong: '#166fe5', onAccent: '#ffffff', ring: 'rgba(24,119,242,.22)',
      inputBg: '#ffffff', inputInk: '#1c1e21', inputBorder: '#ccd0d5',
      radius: '8px', radiusLg: '12px', shadow: '0 1px 2px rgba(0,0,0,.1), 0 22px 48px -34px rgba(0,0,0,.5)',
      headingWeight: '800', btnRadius: '8px', btnWeight: '800'
    }
  },
  instagram: {
    id: 'instagram', mode: 'light', chrome: 'instagram', font: RSTK_SANS,
    gradient: 'linear-gradient(45deg, #feda75, #fa7e1e, #d62976, #962fbf, #4f5bd5)',
    vars: {
      pageBg: '#fafafa', pageImage: 'none',
      ink: '#262626', muted: '#8e8e8e', surface: '#ffffff', surface2: '#fafafa', border: '#dbdbdb',
      accent: '#0095f6', accentStrong: '#1877f2', onAccent: '#ffffff', ring: 'rgba(0,149,246,.2)',
      inputBg: '#ffffff', inputInk: '#262626', inputBorder: '#dbdbdb',
      radius: '12px', radiusLg: '16px', shadow: '0 24px 54px -38px rgba(0,0,0,.45)',
      headingWeight: '800', btnRadius: '10px', btnWeight: '800'
    }
  },
  tiktok: {
    id: 'tiktok', mode: 'dark', chrome: 'tiktok', font: RSTK_SANS, cyan: '#25f4ee',
    vars: {
      pageBg: '#000000', pageImage: 'none',
      ink: '#ffffff', muted: '#a1a1aa', surface: '#161616', surface2: '#1f1f1f', border: 'rgba(255,255,255,.12)',
      accent: '#fe2c55', accentStrong: '#ef1f49', onAccent: '#ffffff', ring: 'rgba(254,44,85,.32)',
      inputBg: '#1f1f1f', inputInk: '#ffffff', inputBorder: 'rgba(255,255,255,.16)',
      radius: '10px', radiusLg: '18px', shadow: '0 36px 70px -42px rgba(0,0,0,.9)',
      headingWeight: '900', btnRadius: '10px', btnWeight: '800'
    }
  },
  vsl: {
    id: 'vsl', mode: 'light', chrome: 'none', centered: true, font: RSTK_SANS,
    vars: {
      pageBg: '#0a0b0d', pageImage: 'none',
      ink: '#0f172a', muted: '#64748b', surface: '#ffffff', surface2: '#f8fafc', border: '#e6e8ec',
      accent: '#111827', accentStrong: '#000000', onAccent: '#ffffff', ring: 'rgba(17,24,39,.16)',
      inputBg: '#ffffff', inputInk: '#0f172a', inputBorder: '#dfe3e8',
      radius: '14px', radiusLg: '22px', shadow: '0 50px 90px -46px rgba(0,0,0,.75)',
      headingWeight: '800', btnRadius: '14px', btnWeight: '800'
    }
  },
  interactive: {
    id: 'interactive', mode: 'light', chrome: 'none', centered: true, font: RSTK_SANS,
    vars: {
      pageBg: '#0a0b0d', pageImage: 'none',
      ink: '#0f172a', muted: '#64748b', surface: '#ffffff', surface2: '#f6f7f9', border: '#e6e8ec',
      accent: '#111827', accentStrong: '#000000', onAccent: '#ffffff', ring: 'rgba(17,24,39,.14)',
      inputBg: '#ffffff', inputInk: '#0f172a', inputBorder: '#dfe3e8',
      radius: '14px', radiusLg: '24px', shadow: '0 60px 100px -52px rgba(0,0,0,.8)',
      headingWeight: '800', btnRadius: '14px', btnWeight: '800'
    }
  }
}

const DEFAULT_BG = '#ffffff'
const DEFAULT_ACCENT = '#111827'

const isHex6 = (value?: string): boolean => !!value && /^#[0-9a-f]{6}$/i.test(value)

const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`

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

const normalizeCssColor = (value: string, fallback: string) => {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'transparent') return 'rgba(255, 255, 255, 0)'
  if (isHex6(raw)) return raw
  if (!isCssColor(raw)) return fallback
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return fallback
  const [r, g, b] = match.slice(1, 4).map(valuePart => Math.round(Number(valuePart)))
  const alpha = match[4] === undefined ? 1 : Math.round(Number(match[4]) * 100) / 100
  return alpha >= 1 ? rgbToHex(r, g, b) : `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const normalizeCssPaint = (value: string | undefined, fallback = '') => {
  const raw = String(value || '').trim()
  if (isCssGradient(raw)) return raw
  return normalizeCssColor(raw, fallback)
}

const extractCssColor = (value: string, fallback = '#111827') => {
  const match = String(value || '').match(/(#[0-9a-f]{6}|rgba?\([^)]*\)|transparent)/i)
  return match ? normalizeCssColor(match[1], fallback) : fallback
}

const paintFallbackColor = (paint: string, fallback = '#111827') =>
  isCssGradient(paint) ? extractCssColor(paint, fallback) : normalizeCssColor(paint, fallback)

const paintLayer = (paint: string) => {
  if (!paint) return 'none'
  if (isCssGradient(paint)) return paint
  return `linear-gradient(${paint}, ${paint})`
}

const cssColorToHex = (value: string, fallback = '#ffffff') => {
  const normalized = normalizeCssColor(value, fallback)
  if (normalized.startsWith('#')) return normalized
  const match = normalized.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i)
  if (!match) return fallback
  return rgbToHex(Number(match[1]), Number(match[2]), Number(match[3]))
}

const cssImageUrl = (value?: string) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/') && !/^data:image\//i.test(raw)) return ''
  return `url("${raw.replace(/["\\\n\r]/g, '')}")`
}

const cssMediaUrl = (value?: string) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/') && !/^data:video\//i.test(raw)) return ''
  return raw.replace(/["\\\n\r]/g, '')
}

const backgroundFitValue = (value: unknown) => {
  if (value === 'contain') return 'contain'
  if (value === 'full_width') return '100% auto'
  if (value === 'auto') return 'auto'
  return 'cover'
}

const backgroundRepeatValue = (value: unknown) => {
  if (value === 'repeat' || value === 'repeat-x' || value === 'repeat-y') return value
  return 'no-repeat'
}

const backgroundPositionValue = (value: unknown) => {
  const raw = String(value || '').trim()
  return raw && !/[;{}<>]/.test(raw) ? raw : 'center center'
}

const backgroundAttachmentValue = (value: unknown) => value === 'fixed' ? 'fixed' : 'scroll'

const relLuminance = (hex: string): number => {
  const h = cssColorToHex(hex).replace('#', '')
  if (h.length < 6) return 1
  const lin = (c: number) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16))
}

const resolveTemplate = (site: PublicSite): Template => {
  const id = site?.theme?.template
  if (id && SITE_TEMPLATES[id]) return SITE_TEMPLATES[id]
  if (site?.siteType === 'interactive_form') return SITE_TEMPLATES.interactive
  return SITE_TEMPLATES.ristak
}

// Mirror of backend deriveNeutralVars: recolors the whole palette from a single
// page background so dark landings look premium and recolored forms stay legible.
const deriveNeutralVars = (template: Template, bg: string, userAccent: string | null): TemplateVars => {
  const dark = relLuminance(bg) < 0.5
  const ink = dark ? '#f4f4f6' : '#0f172a'
  const accent = userAccent || (dark ? '#ffffff' : '#0f172a')
  const onAccent = relLuminance(accent) > 0.6 ? '#08080a' : '#ffffff'
  return {
    ...template.vars,
    pageBg: bg,
    pageImage: 'none',
    ink,
    muted: `color-mix(in srgb, ${ink} 60%, ${bg})`,
    surface: dark ? 'rgba(255,255,255,0.04)' : 'rgba(15,23,42,0.022)',
    surface2: dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.04)',
    border: dark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.1)',
    accent,
    accentStrong: accent,
    onAccent,
    ring: `color-mix(in srgb, ${accent} 26%, transparent)`,
    inputBg: dark ? 'rgba(255,255,255,0.04)' : '#ffffff',
    inputInk: ink,
    inputBorder: dark ? 'rgba(255,255,255,0.14)' : '#dfe3e8'
  }
}

type Overrides = { vars?: TemplateVars; accent?: string }

const resolveRenderOverrides = (template: Template, theme: PublicSite['theme'], isLandingType: boolean): Overrides => {
  if (template.chrome !== 'none') return {}
  const hasExplicitBg = typeof theme.backgroundColor === 'string' && theme.backgroundColor.trim() !== ''
  const paintColor = (value?: string) => {
    const paint = normalizeCssPaint(value, '')
    return paint ? paintFallbackColor(paint, '') : null
  }
  const rawBg = paintColor(theme.backgroundColor)
  const userBg = rawBg && (hasExplicitBg || rawBg.toLowerCase() !== DEFAULT_BG) ? rawBg : null
  const rawAccent = paintColor(theme.accentColor)
  const userAccent = rawAccent && rawAccent.toLowerCase() !== DEFAULT_ACCENT.toLowerCase() ? rawAccent : null
  if (isLandingType) {
    return { vars: deriveNeutralVars(template, userBg || template.vars.pageBg, userAccent) }
  }
  if (userBg) {
    return { vars: deriveNeutralVars(template, userBg, userAccent) }
  }
  return userAccent ? { accent: userAccent } : {}
}

const themeNumber = (theme: PublicSite['theme'], key: keyof NonNullable<PublicSite['theme']>, fallback: number, min: number, max: number) => {
  const value = Number(theme?.[key])
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

const themePaint = (theme: PublicSite['theme'], key: keyof NonNullable<PublicSite['theme']>, fallback: string) => {
  const value = theme?.[key]
  return typeof value === 'string' && (isCssColor(value) || isCssGradient(value)) ? normalizeCssPaint(value, fallback) : fallback
}

const sanitizeCssFont = (value?: string) => String(value || '').replace(/[;"{}<>]/g, '').trim()

const normalizeFormChoiceStyle = (value: unknown) => {
  const raw = String(value || '').trim()
  return ['native', 'cards', 'pills', 'minimal'].includes(raw) ? raw : 'native'
}

const normalizeFormSelectStyle = (value: unknown) => {
  const raw = String(value || '').trim()
  return ['classic', 'filled', 'underline'].includes(raw) ? raw : 'classic'
}

export interface CanvasTheme {
  /** All --rstk-* variables, applied inline on the canvas root. */
  vars: React.CSSProperties
  /** body-equivalent classes: rstk-tpl-X rstk-mode rstk-kind-X rstk-centered ... */
  bodyClass: string
  /** Natural ("desktop") page width the canvas is rendered at before scaling. */
  designWidth: number
  templateId: SiteTemplateId
  centered: boolean
  chrome: Template['chrome']
  isLanding: boolean
}

/**
 * Compute the canvas theme for a site. `device` shrinks the design width so the
 * mobile toggle shows the real responsive layout instead of a scaled desktop one.
 */
export const buildCanvasTheme = (site: PublicSite, device: 'desktop' | 'mobile' = 'desktop'): CanvasTheme => {
  const template = resolveTemplate(site)
  const theme = site.theme || {}
  const isLandingType = site.siteType === 'landing_page'
  const overrides = resolveRenderOverrides(template, theme, isLandingType)
  const v: TemplateVars = { ...template.vars, ...(overrides.vars || {}) }

  const accent = overrides.accent || v.accent
  const accentStrong = overrides.accent ? `color-mix(in srgb, ${overrides.accent} 86%, #000)` : v.accentStrong
  const ring = overrides.accent ? `color-mix(in srgb, ${overrides.accent} 22%, transparent)` : v.ring
  const baseFont = template.chrome === 'none' ? `'Inter', ${template.font}` : template.font
  const display = template.chrome === 'none' ? `'Inter Tight', 'Inter', ${template.font}` : template.font

  const storedPageMaxWidth = Number(theme?.pageMaxWidth)
  const pageMaxWidth = isLandingType && storedPageMaxWidth === 1160
    ? 1440
    : themeNumber(theme, 'pageMaxWidth', isLandingType ? 1440 : (template.id === 'interactive' ? 600 : 520), 360, 1440)
  const pagePadding = themeNumber(theme, 'pagePadding', isLandingType ? 36 : 22, 0, 120)
  const pageRadius = themeNumber(theme, 'pageRadius', isLandingType ? 0 : 24, 0, 40)
  const pageBorderPaint = normalizeCssPaint(theme.pageBorderColor, '')
  const pageBorder = pageBorderPaint ? paintFallbackColor(pageBorderPaint, 'transparent') : 'transparent'
  const pageBorderWidth = themeNumber(theme, 'pageBorderWidth', 0, 0, 12)
  const rawBackgroundPaint = normalizeCssPaint(theme.backgroundColor, '')
  const backgroundPaint = rawBackgroundPaint.toLowerCase() === DEFAULT_BG ? '' : rawBackgroundPaint
  const backgroundMediaType = theme.backgroundMediaType === 'video' ? 'video' : 'image'
  const pageImage = backgroundMediaType === 'video' ? 'none' : (cssImageUrl(theme.backgroundImage) || v.pageImage)
  const pageVideo = backgroundMediaType === 'video' ? cssMediaUrl(theme.backgroundImage) : ''
  const pageOverlay = backgroundPaint ? paintLayer(backgroundPaint) : 'none'
  const pageBg = backgroundPaint && isCssColor(backgroundPaint) ? normalizeCssColor(backgroundPaint, v.pageBg) : v.pageBg
  const pageIsDark = isCssColor(pageBg) && relLuminance(pageBg) < 0.5
  const rawTextPaint = normalizeCssPaint(theme.textColor, '')
  const textPaint = rawTextPaint && (theme.textColorCustom || rawTextPaint.toLowerCase() !== DEFAULT_ACCENT.toLowerCase()) ? rawTextPaint : ''
  const ink = textPaint ? paintFallbackColor(textPaint, v.ink) : v.ink

	const vars = {
    '--rstk-color-scheme': template.mode,
    '--rstk-font': baseFont,
    '--rstk-display': display,
    '--rstk-ease': 'cubic-bezier(.16,.84,.44,1)',
    '--rstk-page-bg': pageBg,
    '--rstk-page-image': pageImage,
    '--rstk-page-overlay': pageOverlay,
    '--rstk-page-video': pageVideo,
    '--rstk-page-image-size': pageImage === 'none' ? 'auto' : backgroundFitValue(theme.backgroundFit),
    '--rstk-page-image-position': backgroundPositionValue(theme.backgroundPosition),
    '--rstk-page-image-repeat': backgroundRepeatValue(theme.backgroundRepeat),
    '--rstk-page-image-attachment': backgroundAttachmentValue(theme.backgroundAttachment),
    '--rstk-page-video-fit': backgroundFitValue(theme.backgroundFit),
    '--rstk-ink': ink,
    '--rstk-muted': textPaint && isCssColor(textPaint) ? `color-mix(in srgb, ${ink} 60%, ${pageBg})` : v.muted,
    '--rstk-surface': v.surface,
    '--rstk-surface2': v.surface2,
    '--rstk-border': v.border,
    '--rstk-accent': accent,
    '--rstk-accent-strong': accentStrong,
    '--rstk-on-accent': v.onAccent,
    '--rstk-ring': ring,
    '--rstk-selection-border': pageIsDark ? '#60a5fa' : '#2563eb',
    '--rstk-selection-border-hover': pageIsDark ? '#93c5fd' : '#1d4ed8',
    '--rstk-selection-shadow': pageIsDark ? 'rgba(96, 165, 250, 0.24)' : 'rgba(37, 99, 235, 0.16)',
    '--rstk-selection-contrast': pageIsDark ? 'rgba(15, 23, 42, 0.36)' : 'rgba(15, 23, 42, 0.2)',
    '--rstk-input-bg': v.inputBg,
    '--rstk-input-ink': v.inputInk,
    '--rstk-input-border': v.inputBorder,
    '--rstk-radius': v.radius,
    '--rstk-radius-lg': v.radiusLg,
    '--rstk-shadow': v.shadow,
    '--rstk-heading-weight': v.headingWeight,
    '--rstk-btn-radius': v.btnRadius,
    '--rstk-btn-weight': v.btnWeight,
    '--rstk-max': `${pageMaxWidth}px`,
    '--rstk-frame-pad': `${pagePadding}px`,
    '--rstk-page-border': pageBorder,
    '--rstk-page-border-width': `${pageBorderWidth}px`,
	    '--rstk-page-radius': `${pageRadius}px`,
	    '--rstk-pad': 'clamp(18px,4vw,30px)',
	    '--rstk-gap': 'clamp(16px,3vw,22px)',
	    '--rstk-form-font': sanitizeCssFont(theme.formFontFamily) || baseFont,
	    '--rstk-form-label-size': `${themeNumber(theme, 'formLabelSize', 15, 11, 28)}px`,
	    '--rstk-form-input-size': `${themeNumber(theme, 'formInputSize', 16, 11, 28)}px`,
	    '--rstk-form-help-size': `${themeNumber(theme, 'formHelpSize', 14, 10, 24)}px`,
	    '--rstk-form-weight': theme.formFontWeight === 'bold' ? '850' : theme.formFontWeight === 'normal' ? '400' : '700',
	    '--rstk-form-font-style': theme.formFontStyle === 'italic' ? 'italic' : 'normal',
	    '--rstk-form-text-decoration': theme.formTextDecoration === 'underline' ? 'underline' : 'none',
	    '--rstk-form-label-color': paintFallbackColor(themePaint(theme, 'formLabelColor', ink), ink),
	    '--rstk-form-help-color': paintFallbackColor(themePaint(theme, 'formHelpColor', v.muted), v.muted),
	    '--rstk-form-field-bg': themePaint(theme, 'formFieldBg', v.inputBg),
	    '--rstk-form-field-text': paintFallbackColor(themePaint(theme, 'formFieldText', v.inputInk), v.inputInk),
	    '--rstk-form-field-border': paintFallbackColor(themePaint(theme, 'formFieldBorder', v.inputBorder), v.inputBorder),
	    '--rstk-form-placeholder': paintFallbackColor(themePaint(theme, 'formPlaceholderColor', v.muted), v.muted),
	    '--rstk-form-field-radius': `${themeNumber(theme, 'formFieldRadius', Number.parseInt(v.radius, 10) || 12, 0, 36)}px`,
	    '--rstk-form-field-border-width': `${themeNumber(theme, 'formFieldBorderWidth', 1, 0, 8)}px`,
	    '--rstk-form-field-height': `${themeNumber(theme, 'formFieldHeight', 50, 34, 96)}px`,
	    '--rstk-form-field-pad-x': `${themeNumber(theme, 'formFieldPaddingX', 14, 6, 48)}px`,
	    '--rstk-form-field-pad-y': `${themeNumber(theme, 'formFieldPaddingY', 13, 6, 36)}px`,
	    '--rstk-form-choice-selected-bg': themePaint(theme, 'formChoiceSelectedBg', `color-mix(in srgb, ${accent} 10%, ${v.inputBg})`),
	    '--rstk-form-choice-selected-border': paintFallbackColor(themePaint(theme, 'formChoiceSelectedBorder', accent), accent),
	    '--rstk-submit-bg': themePaint(theme, 'submitBg', accent),
	    '--rstk-submit-text': paintFallbackColor(themePaint(theme, 'submitTextColor', v.onAccent), v.onAccent),
	    '--rstk-submit-border': paintFallbackColor(themePaint(theme, 'submitBorderColor', accent), accent),
	    '--rstk-submit-radius': `${themeNumber(theme, 'submitRadius', Number.parseInt(v.btnRadius, 10) || 12, 0, 80)}px`,
	    '--rstk-submit-height': `${themeNumber(theme, 'submitHeight', 50, 34, 96)}px`,
	    '--rstk-submit-pad-x': `${themeNumber(theme, 'submitPaddingX', 22, 8, 72)}px`,
	    '--rstk-submit-size': `${themeNumber(theme, 'submitFontSize', 16, 11, 32)}px`,
	    '--rstk-submit-border-width': `${themeNumber(theme, 'submitBorderWidth', 1, 0, 8)}px`,
	    ...(textPaint && isCssGradient(textPaint) ? { '--rstk-page-text-paint': textPaint } : {}),
    ...(template.gradient ? { '--rstk-gradient': template.gradient } : {}),
    ...(template.cyan ? { '--rstk-cyan': template.cyan } : {})
  } as React.CSSProperties

  const bodyClass = [
    `rstk-tpl-${template.id}`,
    `rstk-${template.mode}`,
    `rstk-kind-${isLandingType ? 'landing' : 'form'}`,
    template.centered ? 'rstk-centered' : '',
	    textPaint && isCssGradient(textPaint) ? 'rstkPageTextGradient' : '',
	    site.siteType === 'interactive_form' ? 'rstk-interactive' : '',
	    `rstk-choice-${normalizeFormChoiceStyle(theme.formChoiceStyle)}`,
	    `rstk-select-${normalizeFormSelectStyle(theme.formSelectStyle)}`
	  ].filter(Boolean).join(' ')

  const desktopChromePadding = isLandingType ? 48 : 32
  const designWidth = device === 'mobile' ? 390 : pageMaxWidth + desktopChromePadding

  return {
    vars,
    bodyClass,
    designWidth,
    templateId: template.id,
    centered: Boolean(template.centered),
    chrome: template.chrome,
    isLanding: isLandingType
  }
}
