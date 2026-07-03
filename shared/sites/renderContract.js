// Contrato de render de Sites — módulo compartido backend/frontend.
// ESM puro, CERO imports: todo lo que hay aquí debe poder ejecutarse igual en
// Node (renderPublicSiteHtml) y en el navegador (canvas del editor). Es LA
// única fuente de verdad de templates, variables --rstk-*, stylesheet público
// y helpers de color/tema. No agregues dependencias ni APIs de plataforma.
//
// Regla de contrato: los checks de explicitud (backgroundColor/textColor
// definidos por el usuario) se calculan sobre el theme CRUDO guardado, mientras
// que las lecturas de valores usan el theme mergeado con DEFAULT_THEME. Así un
// backgroundColor sin definir conserva la paleta del template en TODAS las
// superficies (editor, público, frames embebidos).

// Copia local: el módulo no puede depender de utilidades del backend.
function cleanString(value) {
  return String(value || '').trim()
}

const DEFAULT_THEME = {
  accentColor: '#111827',
  backgroundColor: '#ffffff',
  textColor: '#111827'
}
const MIN_TEXT_CONTRAST_RATIO = 4.5
// WCAG AA para TEXTO GRANDE (>=24px o >=18.66px bold) permite 3.0. Los títulos son
// texto grande, así que un color legible en un título ya no se voltea por usar el
// umbral de texto normal (4.5). Evita "puse un color en el título y salió blanco".
const MIN_LARGE_TEXT_CONTRAST_RATIO = 3.0
const LARGE_TEXT_BLOCK_TYPES = new Set(['title', 'headline', 'hero', 'cta', 'subtitle', 'subheading'])
const AUTO_DARK_TEXT = '#0f172a'
const AUTO_LIGHT_TEXT = '#f4f4f6'
const EMBEDDED_FORM_DEFAULT_THEME = {
  pageBorderWidth: 0,
  pageBorderColor: 'transparent'
}
const FORM_PAGE_BORDER_WIDTH_MAX = 80

const RSTK_SANS = "'Inter', Arial, sans-serif"

const SITE_TEMPLATES = {
  ristak: {
    id: 'ristak',
    label: 'Base comercial',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#eef2f7',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#64748b',
      surface: '#ffffff',
      surface2: '#f8fafc',
      border: '#d7dee8',
      accent: '#0f172a',
      accentStrong: '#020617',
      onAccent: '#ffffff',
      ring: 'rgba(15,23,42,.16)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#d7dee8',
      radius: '14px',
      radiusLg: '24px',
      shadow: '0 34px 80px -52px rgba(15,23,42,.45)',
      headingWeight: '820',
      btnRadius: '14px',
      btnWeight: '800'
    }
  },

  // Fix deliberado (theme-vars #2): paleta del editor para HTML importado; el
  // backend caía a ristak y los formularios importados embebidos cambiaban de look.
  imported_html: {
    id: 'imported_html',
    label: 'HTML importado',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#ffffff',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#64748b',
      surface: '#ffffff',
      surface2: '#f8fafc',
      border: '#e6e8ec',
      accent: '#111827',
      accentStrong: '#000000',
      onAccent: '#ffffff',
      ring: 'rgba(17,24,39,.16)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#dfe3e8',
      radius: '12px',
      radiusLg: '18px',
      shadow: '0 30px 60px -42px rgba(15,23,42,.4)',
      headingWeight: '800',
      btnRadius: '12px',
      btnWeight: '750'
    }
  },

  executive: {
    id: 'executive',
    label: 'Consultoria premium',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#eff6ff',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#475569',
      surface: '#ffffff',
      surface2: '#ecfeff',
      border: '#bae6fd',
      accent: '#0f766e',
      accentStrong: '#115e59',
      onAccent: '#ffffff',
      ring: 'rgba(15,118,110,.18)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#99f6e4',
      radius: '12px',
      radiusLg: '22px',
      shadow: '0 34px 84px -54px rgba(15,118,110,.38)',
      headingWeight: '820',
      btnRadius: '12px',
      btnWeight: '820'
    }
  },

  launch: {
    id: 'launch',
    label: 'Lanzamiento',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#fff7ed',
      pageImage: 'none',
      ink: '#1f2937',
      muted: '#7c2d12',
      surface: '#ffffff',
      surface2: '#ffedd5',
      border: '#fed7aa',
      accent: '#ea580c',
      accentStrong: '#c2410c',
      onAccent: '#ffffff',
      ring: 'rgba(234,88,12,.2)',
      inputBg: '#ffffff',
      inputInk: '#1f2937',
      inputBorder: '#fdba74',
      radius: '16px',
      radiusLg: '26px',
      shadow: '0 36px 84px -52px rgba(124,45,18,.48)',
      headingWeight: '860',
      btnRadius: '999px',
      btnWeight: '860'
    }
  },

  premium: {
    id: 'premium',
    label: 'Premium sobrio',
    mode: 'dark',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#0f0f10',
      pageImage: 'none',
      ink: '#f8fafc',
      muted: '#a1a1aa',
      surface: '#17171a',
      surface2: '#242428',
      border: 'rgba(255,255,255,.14)',
      accent: '#d4af37',
      accentStrong: '#b88916',
      onAccent: '#121212',
      ring: 'rgba(212,175,55,.26)',
      inputBg: '#202024',
      inputInk: '#f8fafc',
      inputBorder: 'rgba(255,255,255,.16)',
      radius: '10px',
      radiusLg: '22px',
      shadow: '0 54px 110px -58px rgba(0,0,0,.92)',
      headingWeight: '860',
      btnRadius: '10px',
      btnWeight: '860'
    }
  },

  local: {
    id: 'local',
    label: 'Negocio local',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f0fdf4',
      pageImage: 'none',
      ink: '#14532d',
      muted: '#4b5563',
      surface: '#ffffff',
      surface2: '#dcfce7',
      border: '#bbf7d0',
      accent: '#15803d',
      accentStrong: '#166534',
      onAccent: '#ffffff',
      ring: 'rgba(21,128,61,.2)',
      inputBg: '#ffffff',
      inputInk: '#14532d',
      inputBorder: '#86efac',
      radius: '18px',
      radiusLg: '28px',
      shadow: '0 34px 82px -52px rgba(20,83,45,.38)',
      headingWeight: '820',
      btnRadius: '18px',
      btnWeight: '820'
    }
  },

  compact: {
    id: 'compact',
    label: 'Formulario compacto',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#eff6ff',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#475569',
      surface: '#ffffff',
      surface2: '#dbeafe',
      border: '#bfdbfe',
      accent: '#2563eb',
      accentStrong: '#1d4ed8',
      onAccent: '#ffffff',
      ring: 'rgba(37,99,235,.18)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#bfdbfe',
      radius: '12px',
      radiusLg: '24px',
      shadow: '0 28px 70px -48px rgba(37,99,235,.36)',
      headingWeight: '820',
      btnRadius: '14px',
      btnWeight: '820'
    }
  },

  event: {
    id: 'event',
    label: 'Registro simple',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#fdf2f8',
      pageImage: 'none',
      ink: '#500724',
      muted: '#831843',
      surface: '#ffffff',
      surface2: '#fce7f3',
      border: '#fbcfe8',
      accent: '#be123c',
      accentStrong: '#9f1239',
      onAccent: '#ffffff',
      ring: 'rgba(190,18,60,.2)',
      inputBg: '#ffffff',
      inputInk: '#500724',
      inputBorder: '#f9a8d4',
      radius: '16px',
      radiusLg: '26px',
      shadow: '0 34px 78px -48px rgba(131,24,67,.42)',
      headingWeight: '860',
      btnRadius: '999px',
      btnWeight: '860'
    }
  },

  quote: {
    id: 'quote',
    label: 'Cotizacion rapida',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f5f3ff',
      pageImage: 'none',
      ink: '#2e1065',
      muted: '#6d28d9',
      surface: '#ffffff',
      surface2: '#ede9fe',
      border: '#ddd6fe',
      accent: '#5b21b6',
      accentStrong: '#4c1d95',
      onAccent: '#ffffff',
      ring: 'rgba(91,33,182,.2)',
      inputBg: '#ffffff',
      inputInk: '#2e1065',
      inputBorder: '#c4b5fd',
      radius: '14px',
      radiusLg: '24px',
      shadow: '0 34px 78px -48px rgba(76,29,149,.42)',
      headingWeight: '850',
      btnRadius: '16px',
      btnWeight: '850'
    }
  },

  callback: {
    id: 'callback',
    label: 'Llamada consultiva',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#ecfeff',
      pageImage: 'none',
      ink: '#164e63',
      muted: '#0e7490',
      surface: '#ffffff',
      surface2: '#cffafe',
      border: '#a5f3fc',
      accent: '#0e7490',
      accentStrong: '#155e75',
      onAccent: '#ffffff',
      ring: 'rgba(14,116,144,.2)',
      inputBg: '#ffffff',
      inputInk: '#164e63',
      inputBorder: '#67e8f9',
      radius: '12px',
      radiusLg: '20px',
      shadow: '0 32px 74px -48px rgba(22,78,99,.38)',
      headingWeight: '820',
      btnRadius: '12px',
      btnWeight: '850'
    }
  },

  waitlist: {
    id: 'waitlist',
    label: 'Lista de espera',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#fff7ed',
      pageImage: 'none',
      ink: '#7c2d12',
      muted: '#9a3412',
      surface: '#ffffff',
      surface2: '#ffedd5',
      border: '#fed7aa',
      accent: '#c2410c',
      accentStrong: '#9a3412',
      onAccent: '#ffffff',
      ring: 'rgba(194,65,12,.2)',
      inputBg: '#ffffff',
      inputInk: '#7c2d12',
      inputBorder: '#fdba74',
      radius: '18px',
      radiusLg: '30px',
      shadow: '0 34px 78px -48px rgba(124,45,18,.42)',
      headingWeight: '860',
      btnRadius: '999px',
      btnWeight: '860'
    }
  },

  facebook: {
    id: 'facebook',
    label: 'Facebook',
    mode: 'light',
    chrome: 'facebook',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f0f2f5',
      pageImage: 'none',
      ink: '#1c1e21',
      muted: '#65676b',
      surface: '#ffffff',
      surface2: '#f7f8fa',
      border: '#ced0d4',
      accent: '#1877f2',
      accentStrong: '#166fe5',
      onAccent: '#ffffff',
      ring: 'rgba(24,119,242,.22)',
      inputBg: '#ffffff',
      inputInk: '#1c1e21',
      inputBorder: '#ccd0d5',
      radius: '10px',
      radiusLg: '16px',
      shadow: '0 1px 2px rgba(0,0,0,.1), 0 24px 54px -36px rgba(0,0,0,.45)',
      headingWeight: '820',
      btnRadius: '10px',
      btnWeight: '820'
    }
  },

  instagram: {
    id: 'instagram',
    label: 'Instagram',
    mode: 'light',
    chrome: 'instagram',
    font: RSTK_SANS,
    gradient: 'linear-gradient(45deg, #feda75, #fa7e1e, #d62976, #962fbf, #4f5bd5)',
    vars: {
      pageBg: '#fafafa',
      pageImage: 'none',
      ink: '#262626',
      muted: '#8e8e8e',
      surface: '#ffffff',
      surface2: '#fafafa',
      border: '#dbdbdb',
      accent: '#0095f6',
      accentStrong: '#1877f2',
      onAccent: '#ffffff',
      ring: 'rgba(0,149,246,.2)',
      inputBg: '#ffffff',
      inputInk: '#262626',
      inputBorder: '#dbdbdb',
      radius: '12px',
      radiusLg: '18px',
      shadow: '0 26px 58px -40px rgba(0,0,0,.42)',
      headingWeight: '820',
      btnRadius: '12px',
      btnWeight: '820'
    }
  },

  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    mode: 'dark',
    chrome: 'tiktok',
    font: RSTK_SANS,
    cyan: '#25f4ee',
    vars: {
      pageBg: '#000000',
      pageImage: 'none',
      ink: '#ffffff',
      muted: '#a1a1aa',
      surface: '#161616',
      surface2: '#1f1f1f',
      border: 'rgba(255,255,255,.12)',
      accent: '#fe2c55',
      accentStrong: '#ef1f49',
      onAccent: '#ffffff',
      ring: 'rgba(254,44,85,.32)',
      inputBg: '#1f1f1f',
      inputInk: '#ffffff',
      inputBorder: 'rgba(255,255,255,.16)',
      radius: '12px',
      radiusLg: '20px',
      shadow: '0 38px 78px -44px rgba(0,0,0,.92)',
      headingWeight: '900',
      btnRadius: '12px',
      btnWeight: '820'
    }
  },

  vsl: {
    id: 'vsl',
    label: 'Carta de ventas (VSL)',
    mode: 'dark',
    chrome: 'none',
    centered: true,
    font: RSTK_SANS,
    vars: {
      pageBg: '#0a0b0d',
      pageImage: 'none',
      ink: '#f8fafc',
      muted: '#cbd5e1',
      surface: 'rgba(255,255,255,.08)',
      surface2: 'rgba(255,255,255,.12)',
      border: 'rgba(255,255,255,.16)',
      accent: '#f8fafc',
      accentStrong: '#ffffff',
      onAccent: '#0a0b0d',
      ring: 'rgba(248,250,252,.18)',
      inputBg: 'rgba(255,255,255,.08)',
      inputInk: '#f8fafc',
      inputBorder: 'rgba(255,255,255,.18)',
      radius: '14px',
      radiusLg: '24px',
      shadow: '0 56px 110px -52px rgba(0,0,0,.82)',
      headingWeight: '840',
      btnRadius: '14px',
      btnWeight: '840'
    }
  },

  interactive: {
    id: 'interactive',
    label: 'Interactivo',
    mode: 'dark',
    chrome: 'none',
    centered: true,
    font: RSTK_SANS,
    vars: {
      pageBg: '#0a0b0d',
      pageImage: 'none',
      ink: '#f8fafc',
      muted: '#cbd5e1',
      surface: 'rgba(255,255,255,.08)',
      surface2: 'rgba(255,255,255,.12)',
      border: 'rgba(255,255,255,.16)',
      accent: '#f8fafc',
      accentStrong: '#ffffff',
      onAccent: '#0a0b0d',
      ring: 'rgba(248,250,252,.18)',
      inputBg: 'rgba(255,255,255,.08)',
      inputInk: '#f8fafc',
      inputBorder: 'rgba(255,255,255,.18)',
      radius: '16px',
      radiusLg: '28px',
      shadow: '0 64px 120px -58px rgba(0,0,0,.86)',
      headingWeight: '840',
      btnRadius: '16px',
      btnWeight: '840'
    }
  }
}

function resolveTemplate(site) {
  const id = cleanString(site && site.theme && site.theme.template)
  if (id && SITE_TEMPLATES[id]) return SITE_TEMPLATES[id]
  if (site && site.siteType === 'interactive_form') return SITE_TEMPLATES.interactive
  return SITE_TEMPLATES.ristak
}

const RSTK_SITE_FONTS_CSS_PATH = '/api/sites/public/fonts.css'
const RSTK_FONT_FAMILIES = [
  'Archivo',
  'Barlow',
  'Bebas Neue',
  'Inter',
  'Inter Tight',
  'Lato',
  'Libre Baskerville',
  'Manrope',
  'Merriweather',
  'Montserrat',
  'Nunito',
  'Open Sans',
  'Oswald',
  'Playfair Display',
  'Poppins',
  'Raleway',
  'Roboto',
  'Work Sans'
]
const RSTK_DEFAULT_FONT = "'Inter', Arial, sans-serif"
const RSTK_DEFAULT_SERIF_FONT = "'Libre Baskerville', Georgia, serif"

function normalizeSiteFontFamily(value) {
  const font = cleanString(value).replace(/[;"{}<>]/g, '').trim()
  if (!font) return ''

  const normalized = font.toLowerCase()
  if (RSTK_FONT_FAMILIES.some((family) => normalized.includes(family.toLowerCase()))) return font

  const plain = normalized.replace(/['"]/g, '')
  if (plain.includes('georgia') || plain.includes('times new roman') || plain === 'serif') {
    return RSTK_DEFAULT_SERIF_FONT
  }
  if (
    plain.includes('-apple-system') ||
    plain.includes('blinkmacsystemfont') ||
    plain.includes('system-ui') ||
    plain.includes('segoe ui') ||
    plain === 'arial' ||
    plain === 'helvetica' ||
    plain === 'sans-serif'
  ) {
    return RSTK_DEFAULT_FONT
  }

  return font
}

function isCssColor(value) {
  const raw = cleanString(value).toLowerCase()
  if (!raw) return false
  if (raw === 'transparent') return true
  if (/^#[0-9a-f]{6}$/i.test(raw)) return true
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return false
  const channels = match.slice(1, 4).map(Number)
  const alpha = match[4] === undefined ? 1 : Number(match[4])
  return channels.every(channel => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1
}

function isCssGradient(value) {
  const raw = cleanString(value)
  return /^(linear|radial|conic)-gradient\(/i.test(raw) && !/[;{}<>]/.test(raw)
}

function isCssPaint(value) {
  return isCssColor(value) || isCssGradient(value)
}

function normalizeCssColor(value, fallback = '') {
  const raw = cleanString(value).toLowerCase()
  if (!raw) return fallback
  if (raw === 'transparent') return 'rgba(255, 255, 255, 0)'
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw
  if (!isCssColor(raw)) return fallback
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return fallback
  const [r, g, b] = match.slice(1, 4).map(valuePart => Math.round(Number(valuePart)))
  const alpha = match[4] === undefined ? 1 : Math.round(Number(match[4]) * 100) / 100
  const toHex = channel => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0')
  return alpha >= 1 ? `#${toHex(r)}${toHex(g)}${toHex(b)}` : `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function normalizeCssPaint(value, fallback = '') {
  const raw = cleanString(value)
  if (isCssGradient(raw)) return raw
  return normalizeCssColor(raw, fallback)
}

function extractCssColor(value, fallback = '#111827') {
  const raw = cleanString(value)
  const match = raw.match(/(#[0-9a-f]{6}|rgba?\([^)]*\)|transparent)/i)
  return match ? normalizeCssColor(match[1], fallback) : fallback
}

function paintFallbackColor(paint, fallback = '#111827') {
  return isCssGradient(paint) ? extractCssColor(paint, fallback) : normalizeCssColor(paint, fallback)
}

function themeNumber(theme, key, fallback, min, max) {
  const value = Number(theme && theme[key])
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function themePaint(theme, key) {
  return normalizeCssPaint(theme && theme[key], '')
}

function blockButtonAlign(settings, fallback = 'center') {
  const value = cleanString(settings && settings.buttonAlign)
  return ['left', 'center', 'right', 'full'].includes(value) ? value : fallback
}

function justifyForAlign(align) {
  if (align === 'center') return 'center'
  if (align === 'right') return 'end'
  if (align === 'full' || align === 'justify') return 'stretch'
  return 'start'
}

function marginForAlign(align) {
  if (align === 'center') return { left: 'auto', right: 'auto' }
  if (align === 'right') return { left: 'auto', right: '0' }
  if (align === 'justify') return { left: '0', right: '0' }
  return { left: '0', right: align === 'full' ? '0' : 'auto' }
}

const RSTK_BASE_CSS = `
  *,*::before,*::after{box-sizing:border-box}
  [hidden]{display:none !important}
  [data-rstk-video-action-hidden="true"]{display:none!important}
  [data-rstk-user-hidden="true"],[data-rstk-countdown-hidden="true"]{display:none!important}
  html{-webkit-text-size-adjust:100%}
  body{
    margin:0;min-height:100vh;
    font-family:var(--rstk-font);
    color:var(--rstk-ink);
    background-color:var(--rstk-page-bg);
    background-image:var(--rstk-page-image);
    background-position:var(--rstk-page-image-position,center top);
    background-repeat:var(--rstk-page-image-repeat,no-repeat);
    background-size:var(--rstk-page-image-size,auto);
    background-attachment:var(--rstk-page-image-attachment,scroll);
    line-height:1.5;letter-spacing:0;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  }
  img{max-width:100%;display:block}
  .rstk-frame{position:relative;isolation:isolate;overflow:hidden;min-height:100vh;padding:var(--rstk-frame-pad,clamp(10px,3vw,32px)) 16px;background-color:var(--rstk-page-bg);background-image:var(--rstk-page-image);background-position:var(--rstk-page-image-position,center top);background-repeat:var(--rstk-page-image-repeat,no-repeat);background-size:var(--rstk-page-image-size,auto);background-attachment:var(--rstk-page-image-attachment,scroll)}
  .rstk-frame::before{content:"";position:absolute;inset:0;z-index:1;background:var(--rstk-page-overlay,none);pointer-events:none}
  .rstk-bg-video{position:absolute;inset:0;z-index:0;width:100%;height:100%;object-fit:var(--rstk-page-video-fit,cover);pointer-events:none}
  .rstk-page{position:relative;z-index:2;width:100%;max-width:var(--rstk-max);margin:0 auto;border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,transparent);border-radius:var(--rstk-page-radius,0)}
  .rstk-shell{display:grid;gap:var(--rstk-gap)}
  .rstk-centered .rstk-shell{text-align:center;justify-items:center}
  .rstk-centered .rstk-subheading,.rstk-centered .rstk-text{margin-inline:auto}
  .rstk-section-lane.rstk-block-style,.rstk-section-lane{position:relative;width:100%;margin:var(--rstk-block-margin,0);background-color:var(--rstk-block-bg-color,var(--rstk-block-bg,transparent));background-image:var(--rstk-block-bg-layer,none),var(--rstk-block-bg-image,none);background-position:center center,var(--rstk-block-bg-position,center center);background-repeat:no-repeat,var(--rstk-block-bg-repeat,no-repeat);background-size:100% 100%,var(--rstk-block-bg-size,cover);color:var(--rstk-block-text,var(--rstk-ink));border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);padding:0}
  .rstk-section-inner{width:100%;max-width:var(--rstk-max);margin:0 auto;padding:var(--rstk-block-pad,0);display:grid;gap:var(--rstk-section-gap,clamp(18px,3vw,30px))}
  .rstk-section-heading{display:grid;gap:10px;justify-items:var(--rstk-block-justify,stretch);text-align:var(--rstk-block-align,inherit)}
  .rstk-section-heading h2,.rstk-section-heading p{margin:0}
  .rstk-section-columns{display:grid;grid-template-columns:repeat(var(--rstk-section-columns,1),minmax(0,1fr));gap:var(--rstk-section-gap,clamp(18px,3vw,30px));align-items:start}
  .rstk-section-column{min-width:0;display:grid;align-content:start;gap:var(--rstk-gap)}
  .rstk-section-column>.rstk-block-style:not(.rstkBlockBgSet){--rstk-block-bg:transparent;--rstk-block-bg-color:transparent;--rstk-block-bg-layer:none;--rstk-block-bg-image:none}
  .rstk-section-column>.rstk-block-style:not(.rstkBlockBorderSet){--rstk-block-border:transparent;--rstk-block-border-width:0px;--rstk-block-shell-border-width:0px}
  .rstk-block-style{
    position:relative;
    width:auto;
    min-width:0;
    margin:var(--rstk-block-margin,0);
    background-color:var(--rstk-block-bg-color,var(--rstk-block-bg,transparent));
    background-image:var(--rstk-block-bg-layer,none),var(--rstk-block-bg-image,none);
    background-position:center center,var(--rstk-block-bg-position,center center);
    background-repeat:no-repeat,var(--rstk-block-bg-repeat,no-repeat);
    background-size:100% 100%,var(--rstk-block-bg-size,cover);
    color:var(--rstk-block-text,var(--rstk-ink));
    font-family:var(--rstk-block-font,var(--rstk-font));
    font-size:var(--rstk-block-size,inherit);
    font-weight:var(--rstk-block-weight,inherit);
    text-align:var(--rstk-block-align,inherit);
    border:var(--rstk-block-shell-border-width,0) solid var(--rstk-block-border,transparent);
    border-radius:var(--rstk-block-radius,0);
    padding:var(--rstk-block-pad,0);
  }
  .rstkCalendarBlock.rstk-block-style{background:transparent;border:0;padding:0}
  .rstkSocialProfileBlock.rstk-block-style{width:fit-content;min-width:0;max-width:100%}
  .rstk-kind-form:not(.rstk-embedded-form-source-frame) .rstkSocialProfileBlock.rstk-block-style{justify-self:start;transform:translateX(var(--rstk-social-profile-nudge,clamp(-22px,-5vw,-14px)))}
  .rstkHasBgVideo{isolation:isolate;overflow:hidden}
  .rstk-block-bg-video{position:absolute;inset:0;z-index:0;width:100%;height:100%;object-fit:var(--rstk-block-bg-size,cover);pointer-events:none}
  .rstkHasBgVideo > :not(.rstk-block-bg-video){position:relative;z-index:1}
  .rstkHeaderPanelBlock{z-index:6}
  .rstkFooterPanelBlock{z-index:1}
  .rstk-block-style .rstk-headline,
  .rstk-block-style h2,
  .rstk-block-style .rstk-subheading,
  .rstk-block-style .rstk-text,
  .rstk-block-style .rstk-help{
    margin-left:var(--rstk-content-margin-left,0);
    margin-right:var(--rstk-content-margin-right,0);
  }
  .rstk-block-style .rstk-headline,
  .rstk-block-style h2,
  .rstk-block-style label,
  .rstk-block-style strong{color:var(--rstk-block-text,var(--rstk-ink))}
  .rstk-block-style .rstk-social-name{color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 92%,var(--rstk-muted) 8%)}
  .rstk-block-style .rstk-subheading,
  .rstk-block-style .rstk-text,
  .rstk-block-style .rstk-help,
  .rstk-block-style p,
  .rstk-block-style .rstk-social-followers{color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 50%,var(--rstk-muted) 50%)}
  /* Cuando el usuario elige un color de texto EXPLÍCITO (no gradiente), el
     subtítulo/texto secundario debe pintarlo pleno, no mezclado 50% con muted.
     Mayor especificidad que la regla de arriba; el gradiente usa su propia regla
     con !important, así que queda excluido con :not(.rstkTextGradient). */
  .rstk-block-style.rstkBlockTextOverride:not(.rstkTextGradient) .rstk-subheading,
  .rstk-block-style.rstkBlockTextOverride:not(.rstkTextGradient) .rstk-text{color:var(--rstk-block-text,var(--rstk-ink))}
  .rstk-block-style .rstk-social-name,
  .rstk-block-style .rstk-social-followers{font-family:var(--rstk-block-font,var(--rstk-font));font-style:var(--rstk-block-font-style,normal);text-decoration:var(--rstk-block-text-decoration,none)}
  .rstk-block-style .rstk-social-name{font-size:var(--rstk-social-name-size,var(--rstk-block-size,18px));font-weight:700}
  .rstk-block-style .rstk-social-followers{font-size:var(--rstk-social-followers-size,14px);font-weight:500}
  .rstk-block-style .rstk-button-link,
  .rstk-block-style button[data-rstk-edit-type="button"],
  .rstk-block-style .rstk-actions button{border-radius:var(--rstk-block-button-radius,var(--rstk-btn-radius))}
  .rstk-block-style input,
  .rstk-block-style textarea,
  .rstk-block-style select,
  .rstk-block-style .rstk-option{
    background:var(--rstk-field-bg,var(--rstk-input-bg));
    border-color:var(--rstk-field-border,var(--rstk-input-border));
    border-radius:var(--rstk-field-radius,var(--rstk-radius));
  }
  .rstk-block-style .rstk-media,
  .rstk-block-style .rstk-video{
    justify-self:var(--rstk-media-justify,center);
    width:var(--rstk-media-width,100%);
    margin-left:var(--rstk-media-margin-left,auto);
    margin-right:var(--rstk-media-margin-right,auto);
  }

  .rstk-checkout-card{box-sizing:border-box;width:100%;max-width:var(--rstk-checkout-width,504px);margin-inline:auto;padding:var(--rstk-block-pad,22px);background:var(--rstk-block-bg,var(--rstk-surface));color:var(--rstk-block-text,var(--rstk-ink));border:var(--rstk-block-border-width,1px) solid var(--rstk-block-border,var(--rstk-border));border-radius:var(--rstk-block-radius,var(--rstk-radius-lg));box-shadow:none;text-align:var(--rstk-checkout-align,var(--rstk-block-align,left))}
  .rstk-checkout-card *,.rstk-checkout-card *::before,.rstk-checkout-card *::after{box-sizing:border-box}
  .rstk-checkout-inner{box-sizing:border-box;width:100%;max-width:var(--rstk-checkout-content-width,456px);margin-inline:auto;min-width:0;display:grid;gap:16px}
  .rstk-block-style:has(> .rstk-payment-block){background:transparent;border:0;padding:0;box-shadow:none}
  .rstk-payment-banner .rstk-checkout-card{max-width:var(--rstk-checkout-width,672px)}
  .rstk-payment-minimal .rstk-checkout-card{border:0;box-shadow:none;padding:0;background:transparent}
  .rstkBlockFullWidth .rstk-checkout-card{max-width:none}
  .rstk-checkout-head{display:grid;gap:4px;min-width:0}
  .rstk-checkout-head .rstk-payment-kicker{color:var(--rstk-accent);font-size:.74rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;overflow-wrap:anywhere}
  .rstk-checkout-title{color:var(--rstk-block-text,var(--rstk-ink));font-size:1.12rem;font-weight:700;line-height:1.25;min-width:0;overflow-wrap:anywhere;word-break:break-word}
  .rstk-checkout-desc{margin:0;color:var(--rstk-muted);font-size:.92rem;line-height:1.4;min-width:0;overflow-wrap:anywhere;word-break:break-word}
  .rstk-checkout-amount{color:var(--rstk-block-text,var(--rstk-ink));font-size:1.5rem;font-weight:800;margin-top:2px;min-width:0;overflow-wrap:anywhere;word-break:break-word}
  .rstk-checkout-testbadge{margin:0;justify-self:start;padding:4px 10px;border-radius:999px;font-size:.72rem;font-weight:700;color:var(--rstk-block-text,var(--rstk-ink));background:color-mix(in srgb,var(--rstk-accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--rstk-accent) 30%,var(--rstk-border))}
  .rstk-checkout-body{display:grid;gap:14px;min-width:0;max-width:100%}
  .rstk-checkout-loading{display:flex;align-items:center;gap:10px;color:var(--rstk-muted);font-size:.9rem;padding:8px 0}
  .rstk-checkout-spinner{width:18px;height:18px;border-radius:50%;border:2px solid color-mix(in srgb,var(--rstk-ink) 20%,transparent);border-top-color:var(--rstk-accent);animation:rstk-checkout-spin .7s linear infinite}
  @keyframes rstk-checkout-spin{to{transform:rotate(360deg)}}
  .rstk-checkout-fields{display:grid;gap:10px;min-height:20px;min-width:0;max-width:100%}
  .rstk-checkout-installments{display:grid;gap:6px}
  .rstk-checkout-select{width:100%;min-height:44px;padding:0 12px;background:var(--rstk-input-bg);color:var(--rstk-input-ink,var(--rstk-ink));border:1px solid var(--rstk-input-border);border-radius:var(--rstk-radius);font:inherit;font-size:.92rem}
  /* El botón de pago consume las MISMAS variables de diseño de botón que el resto de
     bloques (--rstk-button-*): fondo, texto, borde, radio, padding, tipografía, sombra
     y hover. Los fallbacks reproducen el look anterior si el bloque no define nada. */
  .rstk-checkout-pay{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:var(--rstk-button-height,48px);padding:var(--rstk-button-pad-y,0) var(--rstk-button-pad-x,18px);border:var(--rstk-button-border-width,0) solid var(--rstk-button-border,var(--rstk-button-bg,var(--rstk-accent)));border-radius:var(--rstk-block-button-radius,var(--rstk-btn-radius,var(--rstk-radius)));background:var(--rstk-button-bg,var(--rstk-accent));color:var(--rstk-button-text,var(--rstk-on-accent,#fff));font:inherit;font-family:var(--rstk-button-font,inherit);font-size:var(--rstk-button-size,1rem);font-weight:var(--rstk-button-weight,var(--rstk-btn-weight,700));font-style:var(--rstk-button-font-style,normal);line-height:var(--rstk-button-line-height,1.2);text-decoration:var(--rstk-button-text-decoration,none);text-transform:var(--rstk-button-text-transform,none);box-shadow:var(--rstk-button-shadow,none);cursor:pointer;transition:background .15s ease,border-color .15s ease,filter .15s var(--rstk-ease,ease),opacity .15s}
  .rstk-checkout-pay:hover{background:var(--rstk-button-hover-bg,var(--rstk-button-bg,var(--rstk-accent)));filter:brightness(1.05)}
  .rstk-checkout-pay:disabled{opacity:.6;cursor:default}
  /* button.<clase> gana en especificidad al legacy .rstk-payment-block .rstk-button-link
     (que alineaba el botón a la derecha), sin importar el orden en la hoja. El ancho y
     la posición se controlan por bloque (--rstk-checkout-pay-*): default ancho completo. */
  .rstk-payment-block button.rstk-checkout-pay{justify-self:var(--rstk-checkout-pay-justify,stretch);width:var(--rstk-checkout-pay-width,100%);max-width:100%;margin-inline:0}
  .rstk-checkout-message{margin:0;font-size:.88rem;line-height:1.4;padding:10px 12px;border-radius:var(--rstk-radius);border:1px solid var(--rstk-border);color:var(--rstk-ink);background:color-mix(in srgb,var(--rstk-ink) 4%,transparent);min-width:0;overflow-wrap:anywhere;word-break:break-word}
  .rstk-checkout-message[data-kind="success"]{color:var(--rstk-accent);border-color:color-mix(in srgb,var(--rstk-accent) 35%,var(--rstk-border));background:color-mix(in srgb,var(--rstk-accent) 8%,transparent)}
  .rstk-checkout-message[data-kind="error"]{color:var(--rstk-danger,#d64545);border-color:color-mix(in srgb,var(--rstk-danger,#d64545) 35%,var(--rstk-border));background:color-mix(in srgb,var(--rstk-danger,#d64545) 8%,transparent)}
  .rstk-checkout-secure{margin:0;color:var(--rstk-muted);font-size:.76rem;text-align:inherit}
  .rstk-checkout-success{display:grid;gap:8px;padding:22px;text-align:center;color:var(--rstk-ink);font-size:1.02rem;font-weight:600}

  .rstk-kind-form .rstk-shell{
    background:var(--rstk-form-surface,var(--rstk-surface));border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,var(--rstk-border));
    border-radius:var(--rstk-radius-lg);box-shadow:none;
    padding:var(--rstk-pad);overflow:hidden;
  }
  form{width:100%;display:grid;gap:18px;background:transparent;border:0;box-shadow:none;padding:0;margin:0}
  .rstk-kind-landing form{gap:0}

  .rstk-headline{margin:0;font-family:var(--rstk-block-font,var(--rstk-site-title-font,inherit));font-weight:var(--rstk-heading-weight);font-size:clamp(1.7rem,4.6vw,3rem);line-height:1.05;letter-spacing:0}
  .rstk-kind-landing .rstk-headline{font-size:clamp(2rem,5.4vw,3.6rem)}
  .rstk-subheading{margin:0;font-family:var(--rstk-block-font,var(--rstk-site-subtitle-font,inherit));color:var(--rstk-muted);font-size:clamp(1rem,2vw,1.18rem);max-width:var(--rstk-content-max,60ch)}
  .rstk-kicker{margin:0;color:var(--rstk-accent);font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.09em}
  .rstk-text{margin:0;color:color-mix(in srgb,var(--rstk-ink) 80%,transparent);max-width:var(--rstk-content-max,66ch)}
  .rstk-hero,.rstk-section-break,.rstk-cta,.rstk-section-list,.rstk-countdown,.rstk-embedded-form,.rstk-embedded-form-result{display:grid;gap:14px;justify-items:var(--rstk-block-justify,stretch);text-align:var(--rstk-block-align,inherit)}
  .rstk-embedded-form-result{width:100%;place-items:center;text-align:center}
  .rstk-hero{gap:16px}
  .rstk-section-break h2,.rstk-section-list h2,.rstk-cta h2,.rstk-embedded-form h2{margin:0;font-family:var(--rstk-block-font,var(--rstk-site-title-font,inherit));font-size:clamp(1.25rem,2.6vw,1.7rem);font-weight:var(--rstk-heading-weight);letter-spacing:0}
  .rstk-countdown{width:100%;max-width:var(--rstk-content-max,720px);margin-left:var(--rstk-content-margin-left,0);margin-right:var(--rstk-content-margin-right,0)}
  .rstk-countdown-title,.rstk-countdown-note{margin:0}
  .rstk-countdown-title{color:var(--rstk-block-text,var(--rstk-ink));font-weight:var(--rstk-block-weight,700);font-size:var(--rstk-block-size,1.05rem);line-height:var(--rstk-block-line-height,1.35)}
  .rstk-countdown-grid{width:100%;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--rstk-countdown-gap,10px)}
  .rstk-countdown-unit{min-width:0;display:grid;gap:4px;justify-items:center;align-content:center;border:var(--rstk-block-border-width,1px) solid var(--rstk-countdown-unit-border,var(--rstk-block-border,var(--rstk-border)));border-radius:var(--rstk-countdown-unit-radius,var(--rstk-block-radius,var(--rstk-radius)));background:var(--rstk-countdown-unit-bg,var(--rstk-block-bg,transparent));padding:clamp(12px,2vw,20px) 8px}
  .rstk-countdown-unit strong{color:var(--rstk-countdown-number,var(--rstk-block-text,var(--rstk-ink)));font-family:var(--rstk-block-font,var(--rstk-display));font-size:var(--rstk-countdown-number-size,clamp(2rem,5vw,3rem));font-weight:850;line-height:.95;letter-spacing:0}
  .rstk-countdown-unit span{color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 66%,var(--rstk-muted) 34%);font-size:.72rem;font-weight:700;letter-spacing:0;text-transform:uppercase}
  .rstk-countdown-note{color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 72%,var(--rstk-muted) 28%);font-size:.9rem}

  .rstk-button-link,.rstk-actions button{
    -webkit-appearance:none;appearance:none;cursor:pointer;
    min-height:var(--rstk-button-height,50px);display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
    border:var(--rstk-button-border-width,1px) solid var(--rstk-button-border,var(--rstk-button-bg,var(--rstk-accent)));border-radius:var(--rstk-block-button-radius,var(--rstk-btn-radius));
    background:var(--rstk-button-bg,var(--rstk-accent));color:var(--rstk-button-text,var(--rstk-on-accent));
    font-family:var(--rstk-button-font,inherit);font-weight:var(--rstk-button-weight,var(--rstk-btn-weight));font-size:var(--rstk-button-size,1.02rem);font-style:var(--rstk-button-font-style,normal);line-height:var(--rstk-button-line-height,1.08);
    padding:var(--rstk-button-pad-y,8px) var(--rstk-button-pad-x,22px);text-decoration:var(--rstk-button-text-decoration,none);text-transform:var(--rstk-button-text-transform,none);
    box-shadow:var(--rstk-button-shadow,none);
    transition:background .15s ease,border-color .15s ease,transform .04s ease,box-shadow .15s ease;
  }
	  .rstk-button-link{justify-self:var(--rstk-button-justify,center);width:var(--rstk-button-width,fit-content);margin-left:var(--rstk-button-margin-left,auto);margin-right:var(--rstk-button-margin-right,auto)}
	  .rstk-button-content{min-width:0;max-width:100%;display:inline-flex;align-items:center;justify-content:center;gap:.55em}
	  .rstk-button-text-stack{min-width:0;display:inline-grid;gap:2px;justify-items:center}
	  .rstk-button-icon{flex:0 0 auto;width:1.05em;height:1.05em;display:inline-flex;align-items:center;justify-content:center;color:currentColor}
	  .rstk-button-icon svg{width:1em;height:1em;display:block}
	  .rstk-button-label{display:inline-block}
	  .rstk-button-subtitle{display:block;font-size:var(--rstk-button-subtitle-size,.78em);font-weight:650;line-height:1.25;opacity:.82}
	  .rstk-centered .rstk-button-link{margin-inline:auto}
  .rstk-button-link:hover,.rstk-actions button:hover{background:var(--rstk-button-hover-bg,var(--rstk-accent-strong));border-color:var(--rstk-button-hover-border,var(--rstk-button-border,var(--rstk-button-hover-bg,var(--rstk-accent-strong))))}
  .rstk-actions button:active{transform:translateY(1px)}
  .rstk-actions button[disabled]{opacity:.6;cursor:not-allowed}
  .rstk-secondary{background:transparent !important;color:var(--rstk-ink) !important;border-color:var(--rstk-border) !important}

  .rstk-list-grid{display:grid;grid-template-columns:var(--rstk-list-columns,repeat(auto-fit,minmax(190px,1fr)));gap:12px}
  .rstk-list-grid article{border:var(--rstk-card-border-width,var(--rstk-block-border-width,1px)) solid var(--rstk-card-border,var(--rstk-block-border,var(--rstk-border)));border-radius:var(--rstk-card-radius,var(--rstk-radius));background:var(--rstk-card-bg,var(--rstk-block-bg,var(--rstk-surface2)));padding:16px;text-align:var(--rstk-card-align,left)}
  .rstk-list-grid strong{display:block;font-weight:750}
  .rstk-list-grid p{margin:6px 0 0;color:var(--rstk-muted);font-size:.92rem}
  .rstk-list-grid small{display:block;margin-top:8px;color:var(--rstk-muted);font-weight:700}

  .rstk-check-list{list-style:none;margin:0;padding:0;display:grid;gap:11px;text-align:left}
  .rstk-check{display:flex;align-items:flex-start;gap:11px}
  .rstk-check-icon{flex:0 0 auto;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;margin-top:1px}
  .rstk-check-pro .rstk-check-icon{background:color-mix(in srgb,#16a34a 16%,var(--rstk-surface));color:#16a34a}
  .rstk-check-con .rstk-check-icon{background:color-mix(in srgb,var(--rstk-danger,#dc2626) 14%,var(--rstk-surface));color:var(--rstk-danger,#dc2626)}
  .rstk-check-neutral .rstk-check-icon{background:color-mix(in srgb,var(--rstk-accent) 14%,var(--rstk-surface));color:var(--rstk-accent)}
  .rstk-check-body{display:grid;gap:2px}
  .rstk-check-body strong{font-weight:650;font-size:1rem}
  .rstk-check-body span{color:var(--rstk-muted);font-size:.92rem}

  .rstk-media,.rstk-video{width:var(--rstk-media-width,100%);margin-top:0;margin-bottom:0;margin-left:var(--rstk-media-margin-left,0);margin-right:var(--rstk-media-margin-right,0);overflow:hidden;border:var(--rstk-block-border-width,1px) solid var(--rstk-block-border,var(--rstk-border));border-radius:var(--rstk-media-radius,var(--rstk-block-radius,var(--rstk-radius)));background:var(--rstk-block-bg,var(--rstk-surface2))}
  .rstk-media img,.rstk-video iframe,.rstk-video video{width:100%;display:block;border:0}
  .rstk-video{aspect-ratio:var(--rstk-video-aspect-ratio,16/9);position:relative;border-width:var(--rstk-video-border-width,var(--rstk-block-border-width,1px));border-color:var(--rstk-video-border-color,var(--rstk-block-border,var(--rstk-border)));border-radius:var(--rstk-video-radius,var(--rstk-media-radius,var(--rstk-block-radius,var(--rstk-radius))));background:var(--rstk-video-bg,var(--rstk-block-bg,var(--rstk-surface2)))}
	  .rstk-video-portrait{aspect-ratio:var(--rstk-video-aspect-ratio,9/16)}
	  .rstk-kind-form .rstk-video.rstk-video-portrait.rstk-video-wauto:not(.rstk-video-form-gate-fit-wide){width:100%;margin-left:auto;margin-right:auto}
	  .rstk-video.rstk-video-portrait.rstk-video-fill-width:not(.rstk-video-form-gate-fit-wide){width:100%;margin-left:auto;margin-right:auto}
	  .rstk-video iframe,.rstk-video video{height:100%}
	  .rstk-video video{background:var(--rstk-video-bg,#000);object-fit:cover}
	  .rstk-video-player{container-type:inline-size;isolation:isolate}
		  .rstk-video-form-gate-fit-expanded,.rstk-video-gate-active.rstk-video-form-gate-fit-expanded{aspect-ratio:auto;min-height:var(--rstk-video-form-gate-fit-height,min(760px,max(520px,86svh)))}
		  .rstk-video-form-gate-fit-wide,.rstk-video-gate-active.rstk-video-form-gate-fit-wide{width:min(100%,var(--rstk-video-form-gate-fit-width,100%));margin-inline:auto}
	  .rstk-video-custom-controls video{cursor:pointer}
		  .rstk-video-overlay{position:absolute;inset:0;z-index:2;display:grid;place-items:center;border:0;background:transparent;color:var(--rstk-video-play-color,#fff);cursor:pointer}
		  .rstk-video-play-dot{width:var(--rstk-video-play-width,var(--rstk-video-play-size,160px));height:var(--rstk-video-play-size,160px);display:grid;place-items:center;border:0;border-radius:var(--rstk-video-play-radius,0);background:var(--rstk-video-player-color,#000000);color:var(--rstk-video-play-color,#fff);box-shadow:none;transition:opacity .18s ease,transform .18s ease}
		  .rstk-video-is-playing .rstk-video-play-dot{opacity:0;transform:scale(.9)}
		  .rstk-video-play-shape-round .rstk-video-play-dot{border-radius:var(--rstk-video-play-radius,999px)}
		  .rstk-video-play-shape-rectangle .rstk-video-play-dot{border-radius:var(--rstk-video-play-radius,0)}
		  .rstk-video-play-dot svg{width:var(--rstk-video-play-icon-size,95px);height:var(--rstk-video-play-icon-size,95px)}
		  .rstk-video-sound{--rstk-video-sound-size:58px;--rstk-video-sound-icon-size:34px;position:absolute;top:22px;right:22px;z-index:3;box-sizing:border-box;display:inline-flex;flex-direction:row-reverse;align-items:center;justify-content:flex-start;gap:10px;width:max-content;max-width:var(--rstk-video-sound-size);min-width:var(--rstk-video-sound-size);height:var(--rstk-video-sound-size);min-height:var(--rstk-video-sound-size);overflow:hidden;border-radius:999px;background:transparent;color:var(--rstk-video-sound-color,var(--rstk-video-play-color,#fff));box-shadow:none;padding:0 12px;pointer-events:none;isolation:isolate;contain:paint;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;transform-origin:right center}
		  .rstk-video-sound::before{content:"";position:absolute;inset:0;z-index:0;border-radius:inherit;background:color-mix(in srgb,#020617 72%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
		  .rstk-video-has-control-bar .rstk-video-sound{top:22px}
		  .rstk-video-sound-auto{animation:rstkVideoSoundNotice var(--rstk-video-sound-cycle,6.6s) cubic-bezier(.2,.8,.2,1) .45s both}
		  .rstk-video-sound-persistent{animation:rstkVideoSoundNoticeOpen .8s cubic-bezier(.2,.8,.2,1) .45s both}
		  .rstk-video-sound-icon{position:relative;z-index:1;display:grid;place-items:center;flex:0 0 var(--rstk-video-sound-icon-size);width:var(--rstk-video-sound-icon-size);min-width:var(--rstk-video-sound-icon-size);height:var(--rstk-video-sound-icon-size);border-radius:999px}
		  .rstk-video-sound-icon svg{display:block;width:22px;height:22px;flex:0 0 auto;shape-rendering:geometricPrecision}
		  .rstk-video-sound-text{position:relative;z-index:1;display:inline-block;max-width:min(260px,calc(100vw - 150px));min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:currentColor;font-size:1rem;font-weight:500;line-height:1.25;letter-spacing:0;opacity:0;transform:translateX(10px)}
	  .rstk-video-sound-auto .rstk-video-sound-text{animation:rstkVideoSoundText var(--rstk-video-sound-cycle,6.6s) ease .45s both}
	  .rstk-video-sound-persistent .rstk-video-sound-text{animation:rstkVideoSoundTextOpen .8s ease .55s both}
	  .rstk-video-control-bar{position:absolute;left:12px;right:12px;bottom:12px;z-index:4;display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.14);border-radius:var(--rstk-video-control-radius,24px);background:var(--rstk-video-player-color,#000000);color:var(--rstk-video-play-color,#fff);box-shadow:none;opacity:1;padding:7px;pointer-events:auto;transform:translateY(0);transition:opacity .2s ease,transform .2s ease;backdrop-filter:blur(14px)}
	  .rstk-video-controls-hidden .rstk-video-control-bar{opacity:0;pointer-events:none;transform:translateY(8px)}
	  .rstk-video-controls-hidden .rstk-video-control-bar:focus-within{opacity:1;pointer-events:auto;transform:translateY(0)}
	  .rstk-video-controls-start-hidden.rstk-video-controls-hidden .rstk-video-control-bar:focus-within{opacity:0;pointer-events:none;transform:translateY(8px)}
	  .rstk-video-custom-controls.rstk-video-is-playing.rstk-video-controls-hidden video{cursor:none}
	  .rstk-video-control-button{flex:0 0 auto;width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:999px;background:rgba(255,255,255,.12);color:inherit;cursor:pointer}
	  .rstk-video-control-button:hover{background:rgba(255,255,255,.2)}
	  .rstk-video-control-button svg{display:block;flex:0 0 auto;width:15px;height:15px}
	  .rstk-video-control-play svg{transform:translateX(1px)}
	  .rstk-video-control-pause,.rstk-video-control-muted{display:none}
	  .rstk-video-is-playing .rstk-video-control-play{display:none}
	  .rstk-video-is-playing .rstk-video-control-pause{display:block}
	  .rstk-video-is-muted .rstk-video-control-volume{display:none}
	  .rstk-video-is-muted .rstk-video-control-muted{display:block}
	  .rstk-video-progress{flex:1 1 44px;min-width:44px;position:relative;height:18px;overflow:visible;border-radius:999px;background:transparent;cursor:pointer;touch-action:none}
	  .rstk-video-progress::before{content:"";position:absolute;inset:50% 0 auto;height:5px;border-radius:inherit;background:rgba(255,255,255,.2);transform:translateY(-50%)}
	  .rstk-video-progress span{position:absolute;left:0;top:50%;display:block;width:0;height:5px;border-radius:inherit;background:currentColor;transform:translateY(-50%)}
	  .rstk-video-progress:focus-visible{outline:2px solid currentColor;outline-offset:3px}
	  .rstk-video-timecode{flex:0 0 auto;min-width:98px;height:30px;display:inline-flex;align-items:center;justify-content:center;gap:5px;border-radius:999px;background:rgba(255,255,255,.1);color:inherit;padding:0 10px;font-size:.72rem;font-variant-numeric:tabular-nums;font-weight:700;line-height:1;white-space:nowrap}
	  .rstk-video-timecode span + span{opacity:.68}
	  .rstk-video-speed-control{flex:0 0 auto;position:relative;min-width:66px;height:30px;display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:rgba(255,255,255,.12);color:inherit;padding:0 20px 0 8px}
	  .rstk-video-speed-no-settings{min-width:48px;padding-left:10px}
	  .rstk-video-settings-icon{display:grid;place-items:center;flex:0 0 auto}
	  .rstk-video-settings-icon svg{display:block}
	  .rstk-video-speed-control::after{content:"";position:absolute;top:50%;right:8px;width:0;height:0;border-top:4px solid currentColor;border-right:4px solid transparent;border-left:4px solid transparent;opacity:.72;pointer-events:none;transform:translateY(-35%)}
	  .rstk-video-speed-control select{-webkit-appearance:none;appearance:none;width:34px;min-width:0;height:100%;margin:0;border:0!important;border-radius:0;background:transparent!important;background-image:none!important;box-shadow:none!important;color:inherit;cursor:pointer;font:inherit;font-size:.76rem;font-weight:750;line-height:1;outline:0;padding:0}
	  .rstk-video-speed-control option{color:#111827}
	  .rstk-video-has-form-gate{overflow:hidden}
	  .rstk-video-gate-active > video,.rstk-video-gate-active > iframe{pointer-events:none}
	  .rstk-video-form-gate{position:absolute;inset:0;z-index:9;display:grid;place-items:center;min-width:0;padding:clamp(8px,3cqw,22px);background:var(--rstk-video-form-gate-video-bg,color-mix(in srgb,var(--rstk-video-bg,#000) 84%,transparent));color:var(--rstk-ink);font-family:var(--rstk-form-font,var(--rstk-font));backdrop-filter:blur(12px)}
	  .rstk-video-form-gate[hidden]{display:none!important}
	  .rstk-video-form-gate-anim-fade:not([hidden]){animation:rstkVideoFormGateFade .22s ease-out both}
	  .rstk-video-form-gate-anim-slide_up:not([hidden]){animation:rstkVideoFormGateSlide .24s ease-out both}
	  .rstk-video-form-gate-anim-instant:not([hidden]){animation:none}
	  .rstk-video-form-gate-panel{width:min(100%,680px);height:auto;max-width:100%;max-height:100%;min-height:0;--rstk-video-form-item-gap:clamp(8px,2cqw,14px);display:grid;grid-template-rows:auto auto minmax(0,max-content) auto auto;gap:var(--rstk-video-form-item-gap);overflow:hidden;border:var(--rstk-video-form-panel-border-width,0) solid var(--rstk-form-field-border,var(--rstk-input-border));border-radius:clamp(10px,2.4cqw,20px);background:var(--rstk-video-form-panel-bg,var(--rstk-block-bg,var(--rstk-surface)));color:var(--rstk-ink);box-shadow:0 24px 70px -42px rgba(0,0,0,.66);padding:clamp(12px,3cqw,24px);text-align:var(--rstk-form-content-align,left)}
	  .rstk-video-form-gate-fit-expanded .rstk-video-form-gate-panel,.rstk-video-gate-active.rstk-video-form-gate-fit-expanded .rstk-video-form-gate-panel{height:100%;grid-template-rows:auto auto minmax(0,1fr) auto auto}
	  .rstk-video-form-gate-header{display:grid;gap:4px;text-align:var(--rstk-form-content-align,left)}
	  .rstk-video-form-gate-header strong{display:block;color:var(--rstk-ink);font-family:var(--rstk-form-font,var(--rstk-font));font-size:clamp(1rem,3.2cqw,1.5rem);font-weight:800;line-height:1.1}
	  .rstk-video-form-gate-header p{margin:0;color:var(--rstk-form-help-color,var(--rstk-muted));font-size:clamp(.78rem,2.1cqw,.95rem);line-height:1.35}
	  .rstk-video-form-gate-progress{min-height:18px;color:var(--rstk-form-help-color,var(--rstk-muted));font-size:clamp(.72rem,1.8cqw,.86rem);font-weight:700;text-align:var(--rstk-form-content-align,left)}
	  .rstk-video-form-fields{min-height:0;display:grid;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:2px 4px 0}
	  .rstk-video-form-field-stack{display:grid;width:min(100%,var(--rstk-form-field-width,560px));max-width:100%;justify-self:var(--rstk-form-field-justify,center);gap:var(--rstk-video-form-item-gap);min-width:0}
	  .rstk-video-form-field{display:grid;gap:clamp(5px,1.3cqw,8px);min-width:0;max-width:100%;text-align:var(--rstk-form-content-align,left)}
	  .rstk-video-form-content{min-width:0;max-width:100%;--rstk-block-text:var(--rstk-ink);text-align:var(--rstk-form-content-align,left)}
	  .rstk-video-form-content > .rstk-block-style{width:100%}
	  .rstk-video-form-content .rstk-media{margin:0}
	  .rstk-video-form-field > label{color:var(--rstk-form-label-color,var(--rstk-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:clamp(.84rem,2.2cqw,.98rem);font-style:var(--rstk-form-font-style,normal);font-weight:650;text-decoration:var(--rstk-form-text-decoration,none);line-height:1.25}
	  .rstk-video-form-field .rstk-help{color:var(--rstk-form-help-color,var(--rstk-muted));font-family:var(--rstk-form-font,var(--rstk-font));font-size:clamp(.74rem,1.9cqw,.9rem);line-height:1.3}
	  .rstk-video-form-gate input,.rstk-video-form-gate textarea,.rstk-video-form-gate select{box-sizing:border-box;width:100%;max-width:100%;min-width:0;min-height:clamp(38px,8cqw,var(--rstk-form-field-height,50px));border:var(--rstk-form-field-border-width,1px) solid var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:var(--rstk-form-field-bg,var(--rstk-input-bg));color:var(--rstk-form-field-text,var(--rstk-input-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:clamp(.86rem,2.4cqw,var(--rstk-form-input-size,1rem));font-style:var(--rstk-form-font-style,normal);font-weight:var(--rstk-form-weight,500);text-decoration:var(--rstk-form-text-decoration,none);padding:clamp(9px,2cqw,var(--rstk-form-field-pad-y,13px)) clamp(10px,2.4cqw,var(--rstk-form-field-pad-x,14px))}
	  .rstk-video-form-gate input::placeholder,.rstk-video-form-gate textarea::placeholder{color:var(--rstk-form-placeholder,color-mix(in srgb,var(--rstk-muted) 80%,transparent))}
	  .rstk-video-form-gate textarea{min-height:clamp(78px,18cqw,108px)}
	  .rstk-video-form-gate .rstk-phone-input{display:grid;width:100%;max-width:100%;min-width:0;grid-template-columns:minmax(98px,clamp(98px,18%,108px)) minmax(0,1fr);gap:8px;align-items:stretch}
	  .rstk-video-form-gate .rstk-phone-input[data-phone-country-hidden]{grid-template-columns:minmax(0,1fr)}
	  .rstk-video-form-gate .rstk-phone-input[data-phone-country-hidden] > select{display:none}
	  .rstk-video-form-gate .rstk-phone-input > input,.rstk-video-form-gate .rstk-phone-input > select{min-width:0}
	  .rstk-video-form-gate .rstk-phone-input > select{appearance:none;-webkit-appearance:none;background:linear-gradient(45deg,transparent 50%,var(--rstk-form-field-text,var(--rstk-muted)) 50%) calc(100% - 15px) calc(50% - 3px)/5px 5px no-repeat,linear-gradient(135deg,var(--rstk-form-field-text,var(--rstk-muted)) 50%,transparent 50%) calc(100% - 10px) calc(50% - 3px)/5px 5px no-repeat,var(--rstk-form-field-bg,var(--rstk-input-bg));color:var(--rstk-form-field-text,var(--rstk-input-ink));padding-left:9px;padding-right:26px}
	  .rstk-video-form-gate .rstk-options{display:grid;gap:clamp(7px,1.8cqw,10px);width:100%;max-width:100%;min-width:0}
	  .rstk-video-form-gate .rstk-option{width:100%;max-width:100%;min-width:0;min-height:clamp(38px,8cqw,var(--rstk-form-field-height,50px));border-width:var(--rstk-form-field-border-width,1px);border-color:var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:var(--rstk-form-field-bg,var(--rstk-input-bg));color:var(--rstk-form-field-text,var(--rstk-input-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:clamp(.84rem,2.2cqw,var(--rstk-form-input-size,1rem));font-style:var(--rstk-form-font-style,normal);font-weight:var(--rstk-form-weight,500);text-decoration:var(--rstk-form-text-decoration,none);padding:clamp(9px,2cqw,var(--rstk-form-field-pad-y,13px)) clamp(10px,2.4cqw,var(--rstk-form-field-pad-x,14px))}
	  .rstk-video-form-gate .rstk-option:has(input:checked){border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));background:var(--rstk-form-choice-selected-bg,color-mix(in srgb,var(--rstk-accent) 8%,transparent))}
	  .rstk-video-form-gate .rstk-error{margin:0;color:var(--rstk-form-error,var(--neg,var(--rstk-accent)));font-size:clamp(.72rem,1.8cqw,.84rem);font-weight:700}
	  .rstk-video-form-field[data-invalid] input,.rstk-video-form-field[data-invalid] textarea,.rstk-video-form-field[data-invalid] select,.rstk-video-form-field[data-invalid] .rstk-option{border-color:var(--rstk-form-error,var(--neg,var(--rstk-accent)))!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--rstk-form-error,var(--neg,var(--rstk-accent))) 16%,transparent)}
	  .rstk-video-form-gate .rstk-disqualify-notice{margin:0;padding:clamp(7px,1.6cqw,9px) clamp(9px,2cqw,12px);border-radius:8px;border:1px solid color-mix(in srgb,#d97706 38%,transparent);background:color-mix(in srgb,#d97706 12%,transparent);color:var(--rstk-ink,#1f2937);font-size:clamp(.72rem,1.8cqw,.84rem);font-weight:600;line-height:1.4}
	  .rstk-video-form-actions{display:flex;align-items:center;justify-content:var(--rstk-submit-justify,center);gap:8px;min-width:0}
	  .rstk-video-form-actions button{box-sizing:border-box;width:var(--rstk-submit-width,fit-content);max-width:100%;min-width:min(128px,46%);min-height:clamp(38px,7.5cqw,var(--rstk-submit-height,48px));border:var(--rstk-submit-border-width,1px) solid var(--rstk-submit-border,var(--rstk-accent));border-radius:var(--rstk-submit-radius,var(--rstk-btn-radius));background:var(--rstk-submit-bg,var(--rstk-accent));color:var(--rstk-submit-text,var(--rstk-on-accent));font-family:var(--rstk-form-font,var(--rstk-font));font-size:clamp(.84rem,2.1cqw,var(--rstk-submit-size,.98rem));font-weight:var(--rstk-btn-weight,800);cursor:pointer;flex:0 1 var(--rstk-submit-width,fit-content);padding:var(--rstk-submit-pad-y,9px) var(--rstk-submit-pad-x,14px)}
	  .rstk-video-form-actions .rstk-secondary{background:transparent;color:var(--rstk-ink);border:1px solid var(--rstk-form-field-border,var(--rstk-input-border))}
	  .rstk-video-form-actions button:disabled{opacity:.62;cursor:not-allowed}
	  .rstk-video-form-gate .rstk-submit-message{min-height:18px;margin:0;color:var(--rstk-form-help-color,var(--rstk-muted));font-size:clamp(.74rem,1.8cqw,.88rem);font-weight:650;text-align:var(--rstk-form-content-align,left)}
	  @keyframes rstkVideoFormGateFade{from{opacity:0}to{opacity:1}}
	  @keyframes rstkVideoFormGateSlide{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
	  @container (max-width:460px){.rstk-video-form-gate{padding:8px}.rstk-video-form-gate-panel{--rstk-video-form-item-gap:8px;gap:var(--rstk-video-form-item-gap);padding:10px;border-radius:12px}.rstk-video-form-actions{justify-content:stretch}.rstk-video-form-actions button{flex:1 1 0;min-width:0;padding-inline:10px}.rstk-video-form-gate .rstk-phone-input{grid-template-columns:minmax(96px,104px) minmax(0,1fr)}.rstk-video-form-gate .rstk-phone-input[data-phone-country-hidden]{grid-template-columns:minmax(0,1fr)}}
		  @media (max-width:760px){.rstk-video-form-gate-fit-expanded,.rstk-video-gate-active.rstk-video-form-gate-fit-expanded{width:min(100%,var(--rstk-video-form-gate-fit-width,100%));margin-inline:auto}}
		  @supports not (height:1svh){.rstk-video-form-gate-fit-expanded,.rstk-video-gate-active.rstk-video-form-gate-fit-expanded{min-height:var(--rstk-video-form-gate-fit-height,min(760px,max(520px,86vh)))}}
	  @supports (width:1cqw){.rstk-video-play-dot{width:min(var(--rstk-video-play-size,160px),max(72px,min(15cqw,calc(100% - 32px))));height:min(var(--rstk-video-play-size,160px),max(72px,min(15cqw,calc(100% - 32px))))}.rstk-video-play-shape-rectangle .rstk-video-play-dot{width:min(var(--rstk-video-play-width,232px),max(104px,min(22cqw,calc(100% - 32px))))}.rstk-video-play-dot svg{width:min(var(--rstk-video-play-icon-size,95px),max(42px,min(9cqw,calc(100% - 20px))));height:min(var(--rstk-video-play-icon-size,95px),max(42px,min(9cqw,calc(100% - 20px))))}.rstk-video-control-bar{left:max(6px,min(12px,2cqw));right:max(6px,min(12px,2cqw));bottom:max(6px,min(12px,2cqw));gap:max(4px,min(8px,1.4cqw));padding:max(5px,min(7px,1.2cqw))}.rstk-video-control-button{width:max(24px,min(30px,5cqw));height:max(24px,min(30px,5cqw))}.rstk-video-timecode{min-width:max(76px,min(98px,16cqw));height:max(24px,min(30px,5cqw));gap:max(3px,min(5px,1cqw));padding-inline:max(7px,min(10px,1.7cqw));font-size:max(.62rem,min(.72rem,1.4cqw))}.rstk-video-speed-control{min-width:max(54px,min(66px,11cqw));height:max(24px,min(30px,5cqw));padding-inline:max(6px,min(8px,1.5cqw)) max(18px,min(20px,3cqw))}@media (max-width:760px){.rstk-video-play-dot{width:min(var(--rstk-video-play-size,160px),max(60px,min(12cqw,calc(100% - 32px))));height:min(var(--rstk-video-play-size,160px),max(60px,min(12cqw,calc(100% - 32px))))}.rstk-video-play-shape-rectangle .rstk-video-play-dot{width:min(var(--rstk-video-play-width,232px),max(88px,min(18cqw,calc(100% - 32px))))}.rstk-video-play-dot svg{width:min(var(--rstk-video-play-icon-size,95px),max(36px,min(7cqw,calc(100% - 20px))));height:min(var(--rstk-video-play-icon-size,95px),max(36px,min(7cqw,calc(100% - 20px))))}}}
	  @media (max-width:760px){.rstk-block-style .rstk-video-portrait{width:100%;margin-left:auto;margin-right:auto}}
		  @keyframes rstkVideoSoundNotice{0%{max-width:var(--rstk-video-sound-size,58px);opacity:0;transform:translateY(-4px)}10%,18%{max-width:var(--rstk-video-sound-size,58px);opacity:1;transform:translateY(0)}28%,70%{max-width:min(calc(100% - 44px),360px);opacity:1;transform:translateY(0)}86%{max-width:var(--rstk-video-sound-size,58px);opacity:1;transform:translateY(0)}100%{max-width:var(--rstk-video-sound-size,58px);opacity:0;transform:translateY(-4px)}}
		  @keyframes rstkVideoSoundNoticeOpen{0%{max-width:var(--rstk-video-sound-size,58px);opacity:0;transform:translateY(-4px)}45%{opacity:1;transform:translateY(0)}100%{max-width:min(calc(100% - 44px),360px);opacity:1;transform:translateY(0)}}
		  @keyframes rstkVideoSoundText{0%,17%,76%,100%{opacity:0;transform:translateX(10px)}26%,68%{opacity:1;transform:translateX(0)}}
		  @keyframes rstkVideoSoundTextOpen{0%{opacity:0;transform:translateX(10px)}100%{opacity:1;transform:translateX(0)}}
  .rstk-media-empty{min-height:190px;display:grid;place-items:center;gap:8px;color:var(--rstk-muted);font-size:.92rem}
  .rstk-play{display:grid;place-items:center;width:58px;height:58px;border-radius:50%;background:var(--rstk-accent);color:var(--rstk-on-accent)}
  .rstk-media-empty-mock{min-height:0;aspect-ratio:16/9;width:100%;display:grid;place-content:center;justify-items:center;gap:10px;padding:24px;border:2px dashed var(--rstk-input-border,var(--rstk-border));border-radius:var(--rstk-media-radius,var(--rstk-block-radius,var(--rstk-radius)));background:color-mix(in srgb,var(--rstk-ink) 4%,transparent);color:var(--rstk-muted);font-size:.9rem;font-weight:500}
  .rstk-media-empty-mock .rstk-media-empty-icon{display:grid;place-items:center;width:56px;height:56px;border-radius:14px;background:color-mix(in srgb,var(--rstk-accent) 12%,transparent);color:var(--rstk-accent)}
  .rstk-media-empty-video .rstk-play{box-shadow:0 8px 22px color-mix(in srgb,var(--rstk-accent) 30%,transparent)}

  .rstk-site-panel{width:100%;display:flex;align-items:center;justify-content:space-between;gap:18px;color:var(--rstk-block-text,var(--rstk-ink))}
  .rstk-site-panel-copy{margin:0;color:inherit;font:inherit;font-weight:800}
  .rstk-site-panel-footer .rstk-site-panel-copy{font-weight:600;color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 72%,var(--rstk-muted) 28%)}
  .rstk-site-panel-links{display:flex;align-items:center;justify-content:flex-end;gap:14px;flex-wrap:wrap}
  .rstk-site-panel-links a{color:inherit;text-decoration:none;font-size:.92rem;font-weight:750}
  .rstk-site-panel-footer{justify-content:center;text-align:center;flex-wrap:wrap}
  .rstk-site-panel-footer .rstk-site-panel-links{justify-content:center}

  .rstk-field{display:grid;gap:8px;text-align:left}
  .rstk-kind-form .rstk-field,.rstk-kind-form .rstk-options,.rstk-kind-form .rstk-actions,.rstk-kind-form .rstk-payment-block,.rstk-embedded-form .rstk-field,.rstk-embedded-form .rstk-options,.rstk-embedded-form .rstk-actions,.rstk-embedded-form .rstk-payment-block{width:min(100%,var(--rstk-form-field-width,560px));justify-self:var(--rstk-form-field-justify,center);text-align:var(--rstk-block-align,left)}
  .rstk-embedded-form > .rstk-help{width:min(100%,620px);justify-self:center}
  .rstk-embedded-pages,.rstk-embedded-pages [data-embedded-page-content]{width:min(100%,var(--rstk-form-field-width,560px));justify-self:var(--rstk-form-field-justify,center);display:grid;gap:14px}
  /* Contrato form-fields #5: el override de ancho por campo cuelga de
     .rstk-field-width-set (emitida SOLO con fieldWidth válido), no del wrapper
     genérico .rstk-block-style — un wrapper sin fieldWidth ya no secuestra
     --rstk-form-field-width/--rstk-form-field-justify. */
  .rstk-field-width-set.rstk-field,.rstk-field-width-set > .rstk-field{width:min(100%,var(--rstk-field-width,100%));justify-self:center}
	  .rstk-kind-form form,.rstk-embedded-form{font-family:var(--rstk-form-font,var(--rstk-font))}
	  label{font-size:.95rem;font-weight:700;color:var(--rstk-ink)}
	  .rstk-kind-form .rstk-field > label,.rstk-embedded-form .rstk-field > label{color:var(--rstk-form-label-color,var(--rstk-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:var(--rstk-form-label-size,.95rem);font-style:var(--rstk-form-font-style,normal);font-weight:var(--rstk-form-weight,500);text-decoration:var(--rstk-form-text-decoration,none)}
	  .rstk-required{color:var(--rstk-form-error,var(--neg,var(--rstk-accent)));margin-left:3px}
	  .rstk-help{margin:0;color:var(--rstk-muted);font-size:.9rem}
	  .rstk-kind-form .rstk-help,.rstk-embedded-form .rstk-help{color:var(--rstk-form-help-color,var(--rstk-muted));font-family:var(--rstk-form-font,var(--rstk-font));font-size:var(--rstk-form-help-size,.9rem);font-style:var(--rstk-form-font-style,normal);text-decoration:var(--rstk-form-text-decoration,none)}
	  input,textarea,select{
	    width:100%;border:1px solid var(--rstk-input-border);border-radius:var(--rstk-field-radius,var(--rstk-radius));
	    background:var(--rstk-input-bg);color:var(--rstk-input-ink);font:inherit;font-size:1rem;
	    padding:13px 14px;outline:none;transition:border-color .15s ease,box-shadow .15s ease;
	  }
	  input[type='number']{appearance:textfield;-webkit-appearance:none;-moz-appearance:textfield}
	  input[type='number']::-webkit-outer-spin-button,input[type='number']::-webkit-inner-spin-button{display:none;margin:0;appearance:none;-webkit-appearance:none}
	  .rstk-kind-form .rstk-field > input,.rstk-kind-form .rstk-field > textarea,.rstk-kind-form .rstk-field > select,.rstk-embedded-form .rstk-field > input,.rstk-embedded-form .rstk-field > textarea,.rstk-embedded-form .rstk-field > select{min-height:var(--rstk-form-field-height,50px);border-width:var(--rstk-form-field-border-width,1px);border-color:var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));color:var(--rstk-form-field-text,var(--rstk-input-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:var(--rstk-form-input-size,1rem);font-style:var(--rstk-form-font-style,normal);font-weight:var(--rstk-form-weight,500);text-decoration:var(--rstk-form-text-decoration,none);padding:var(--rstk-form-field-pad-y,13px) var(--rstk-form-field-pad-x,14px)}
	  /* Fondo por separado: --rstk-form-field-bg es un PAINT (color o gradiente).
	     background-color:<gradiente> es inválido y se descarta, así que inputs y
	     textareas usan el shorthand background: (acepta ambos). El select lleva sus
	     capas de caret encima del paint del usuario para que las flechas sobrevivan
	     (form-fields #1) sin perder fondos gradiente. */
	  .rstk-kind-form .rstk-field > input,.rstk-kind-form .rstk-field > textarea,.rstk-embedded-form .rstk-field > input,.rstk-embedded-form .rstk-field > textarea{background:var(--rstk-form-field-bg,var(--rstk-input-bg))}
	  .rstk-kind-form .rstk-field > select,.rstk-embedded-form .rstk-field > select{background:linear-gradient(45deg,transparent 50%,var(--rstk-muted) 50%) calc(100% - 20px) calc(50% - 3px)/5px 5px no-repeat,linear-gradient(135deg,var(--rstk-muted) 50%,transparent 50%) calc(100% - 15px) calc(50% - 3px)/5px 5px no-repeat,var(--rstk-form-field-bg,var(--rstk-input-bg))}
	  .rstk-phone-input{display:grid;grid-template-columns:minmax(132px,clamp(132px,24%,142px)) minmax(0,1fr);gap:8px;align-items:stretch;max-width:100%}
	  .rstk-phone-input[data-phone-country-hidden]{grid-template-columns:minmax(0,1fr)}
	  .rstk-phone-input[data-phone-country-hidden] > select{display:none}
	  .rstk-phone-input > select,.rstk-phone-input > input{min-width:0}
	  .rstk-kind-form .rstk-field .rstk-phone-input > input,.rstk-kind-form .rstk-field .rstk-phone-input > select,.rstk-embedded-form .rstk-field .rstk-phone-input > input,.rstk-embedded-form .rstk-field .rstk-phone-input > select{min-height:var(--rstk-form-field-height,50px);border-width:var(--rstk-form-field-border-width,1px);border-color:var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:var(--rstk-form-field-bg,var(--rstk-input-bg));color:var(--rstk-form-field-text,var(--rstk-input-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:var(--rstk-form-input-size,1rem);font-style:var(--rstk-form-font-style,normal);font-weight:var(--rstk-form-weight,500);text-decoration:var(--rstk-form-text-decoration,none);padding:var(--rstk-form-field-pad-y,13px) var(--rstk-form-field-pad-x,14px)}
	  textarea{resize:vertical;min-height:108px}
	  .rstk-kind-form.rstk-input-underline .rstk-field > input,.rstk-kind-form.rstk-input-underline .rstk-field > textarea,.rstk-input-underline .rstk-embedded-form .rstk-field > input,.rstk-input-underline .rstk-embedded-form .rstk-field > textarea{border-width:0 0 var(--rstk-form-field-border-width,1px);border-radius:0;background:transparent;padding-left:0;padding-right:0}
	  .rstk-kind-form.rstk-input-filled .rstk-field > input,.rstk-kind-form.rstk-input-filled .rstk-field > textarea,.rstk-input-filled .rstk-embedded-form .rstk-field > input,.rstk-input-filled .rstk-embedded-form .rstk-field > textarea{border-width:0 0 var(--rstk-form-field-border-width,1px);border-color:var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius))) var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius))) 0 0;background:color-mix(in srgb,var(--rstk-muted) 10%,transparent)}
	  .rstk-kind-form.rstk-input-soft .rstk-field > input,.rstk-input-soft .rstk-embedded-form .rstk-field > input{border-radius:999px;border-color:transparent;background:color-mix(in srgb,var(--rstk-muted) 8%,transparent);padding-left:calc(var(--rstk-form-field-pad-x,14px) + 6px);padding-right:calc(var(--rstk-form-field-pad-x,14px) + 6px)}
	  .rstk-kind-form.rstk-input-soft .rstk-field > textarea,.rstk-input-soft .rstk-embedded-form .rstk-field > textarea{border-radius:20px;border-color:transparent;background:color-mix(in srgb,var(--rstk-muted) 8%,transparent)}
	  input::placeholder,textarea::placeholder{color:color-mix(in srgb,var(--rstk-muted) 80%,transparent)}
	  .rstk-kind-form input::placeholder,.rstk-kind-form textarea::placeholder,.rstk-embedded-form input::placeholder,.rstk-embedded-form textarea::placeholder{color:var(--rstk-form-placeholder,color-mix(in srgb,var(--rstk-muted) 80%,transparent))}
	  input:not([type='radio']):not([type='checkbox']):focus,textarea:focus,select:focus{border-color:var(--rstk-accent);box-shadow:0 0 0 4px var(--rstk-ring)}
	  select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--rstk-muted) 50%),linear-gradient(135deg,var(--rstk-muted) 50%,transparent 50%);background-position:calc(100% - 20px) calc(50% - 3px),calc(100% - 15px) calc(50% - 3px);background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:42px}
	  .rstk-kind-form.rstk-select-filled .rstk-field select,.rstk-select-filled .rstk-embedded-form select{background-color:color-mix(in srgb,var(--rstk-form-field-bg,transparent) 88%,var(--rstk-accent) 12%)}
	  .rstk-kind-form.rstk-select-underline .rstk-field select,.rstk-select-underline .rstk-embedded-form select{border-width:0 0 var(--rstk-form-field-border-width,1px);border-radius:0;background-color:transparent;padding-left:0;padding-right:36px}
	  .rstk-kind-form.rstk-select-soft .rstk-field select,.rstk-select-soft .rstk-embedded-form select{border-radius:999px;background-color:color-mix(in srgb,var(--rstk-form-field-bg,var(--rstk-input-bg)) 90%,var(--rstk-accent) 10%);padding-left:20px}
	  .rstk-phone-input > select{background:linear-gradient(45deg,transparent 50%,var(--rstk-muted) 50%) calc(100% - 15px) calc(50% - 3px)/5px 5px no-repeat,linear-gradient(135deg,var(--rstk-muted) 50%,transparent 50%) calc(100% - 10px) calc(50% - 3px)/5px 5px no-repeat,var(--rstk-input-bg)}
	  .rstk-kind-form .rstk-field .rstk-phone-input > select,.rstk-kind-form.rstk-select-filled .rstk-field .rstk-phone-input > select,.rstk-kind-form.rstk-select-underline .rstk-field .rstk-phone-input > select,.rstk-embedded-form .rstk-field .rstk-phone-input > select,.rstk-select-filled .rstk-embedded-form .rstk-field .rstk-phone-input > select,.rstk-select-underline .rstk-embedded-form .rstk-field .rstk-phone-input > select{border-width:var(--rstk-form-field-border-width,1px);border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:linear-gradient(45deg,transparent 50%,var(--rstk-muted) 50%) calc(100% - 15px) calc(50% - 3px)/5px 5px no-repeat,linear-gradient(135deg,var(--rstk-muted) 50%,transparent 50%) calc(100% - 10px) calc(50% - 3px)/5px 5px no-repeat,var(--rstk-form-field-bg,var(--rstk-input-bg));padding-left:9px;padding-right:26px}

	  .rstk-options{display:grid;gap:10px}
	  .rstk-option{display:flex;align-items:center;gap:11px;min-height:50px;border:1px solid var(--rstk-input-border);border-radius:var(--rstk-field-radius,var(--rstk-radius));padding:11px 14px;background:var(--rstk-input-bg);color:var(--rstk-input-ink);font-weight:600;cursor:pointer;transition:border-color .15s ease,background .15s ease}
	  .rstk-option:hover{border-color:var(--rstk-accent)}
	  .rstk-option:has(input:checked){border-color:var(--rstk-accent);background:color-mix(in srgb,var(--rstk-accent) 8%,var(--rstk-input-bg))}
	  .rstk-option input[type='radio'],.rstk-option input[type='checkbox']{appearance:none;-webkit-appearance:none;box-sizing:border-box;width:19px;min-width:19px;height:19px;min-height:19px;margin:0;padding:0;border:1.5px solid var(--rstk-form-field-border,var(--rstk-input-border));background:var(--rstk-form-field-bg,var(--rstk-input-bg));box-shadow:none;color:var(--rstk-form-field-text,var(--rstk-input-ink));flex:0 0 auto;display:inline-grid;place-content:center;cursor:pointer}
	  .rstk-option input[type='radio']{border-radius:50%}
	  .rstk-option input[type='checkbox']{border-radius:min(6px,var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius))))}
	  .rstk-option input[type='radio']::after{content:'';width:7px;height:7px;border:0;border-radius:50%;background:var(--rstk-form-choice-selected-border,var(--rstk-accent));transform:scale(0);transition:transform .15s}
	  .rstk-option input[type='radio']:checked{border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));background:var(--rstk-form-field-bg,var(--rstk-input-bg))}
	  .rstk-option input[type='radio']:checked::after{transform:scale(1)}
	  .rstk-option input[type='checkbox']:checked{border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));background:var(--rstk-form-choice-selected-border,var(--rstk-accent))}
	  .rstk-option input[type='checkbox']:checked::after{content:'';width:5px;height:9px;border:solid var(--rstk-on-accent);border-width:0 2px 2px 0;transform:translateY(-1px) rotate(45deg)}
	  .rstk-option input[type='radio']:focus,.rstk-option input[type='checkbox']:focus{outline:none;box-shadow:none}
	  .rstk-kind-form .rstk-options .rstk-option,.rstk-embedded-form .rstk-option{min-height:var(--rstk-form-field-height,50px);border-width:var(--rstk-form-field-border-width,1px);border-color:var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:var(--rstk-form-field-bg,var(--rstk-input-bg));color:var(--rstk-form-field-text,var(--rstk-input-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:var(--rstk-form-input-size,1rem);font-style:var(--rstk-form-font-style,normal);font-weight:var(--rstk-form-weight,500);text-decoration:var(--rstk-form-text-decoration,none);padding:var(--rstk-form-field-pad-y,13px) var(--rstk-form-field-pad-x,14px)}
	  .rstk-kind-form .rstk-option:has(input:checked),.rstk-embedded-form .rstk-option:has(input:checked){border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));background:var(--rstk-form-choice-selected-bg,color-mix(in srgb,var(--rstk-accent) 8%,transparent))}
	  .rstk-kind-form.rstk-choice-cards .rstk-option,.rstk-kind-form.rstk-choice-pills .rstk-option,.rstk-choice-cards .rstk-embedded-form .rstk-option,.rstk-choice-pills .rstk-embedded-form .rstk-option{position:relative;gap:0}
	  .rstk-kind-form.rstk-choice-cards .rstk-option input,.rstk-kind-form.rstk-choice-pills .rstk-option input,.rstk-choice-cards .rstk-embedded-form .rstk-option input,.rstk-choice-pills .rstk-embedded-form .rstk-option input{position:absolute;opacity:0;pointer-events:none}
	  .rstk-kind-form.rstk-choice-cards .rstk-option,.rstk-choice-cards .rstk-embedded-form .rstk-option{padding-left:var(--rstk-form-field-pad-x,14px);box-shadow:inset 4px 0 0 transparent}
	  .rstk-kind-form.rstk-choice-cards .rstk-option:has(input:checked),.rstk-choice-cards .rstk-embedded-form .rstk-option:has(input:checked){box-shadow:inset 4px 0 0 var(--rstk-form-choice-selected-border,var(--rstk-accent))}
	  .rstk-kind-form.rstk-choice-pills .rstk-options,.rstk-choice-pills .rstk-embedded-form .rstk-options{display:flex;flex-wrap:wrap;gap:8px}
	  .rstk-kind-form.rstk-choice-pills .rstk-option,.rstk-choice-pills .rstk-embedded-form .rstk-option{flex:0 1 auto;min-height:40px;border-radius:999px;padding:9px 16px}
	  .rstk-kind-form.rstk-choice-minimal .rstk-option,.rstk-choice-minimal .rstk-embedded-form .rstk-option{min-height:38px;border-width:0 0 var(--rstk-form-field-border-width,1px);border-radius:0;background:transparent;padding-inline:0}
	  .rstk-kind-form.rstk-choice-grid .rstk-options,.rstk-choice-grid .rstk-embedded-form .rstk-options{grid-template-columns:repeat(2,minmax(0,1fr))}
	  .rstk-kind-form.rstk-choice-grid .rstk-option,.rstk-choice-grid .rstk-embedded-form .rstk-option,.rstk-kind-form.rstk-choice-button .rstk-option,.rstk-choice-button .rstk-embedded-form .rstk-option{justify-content:center;text-align:center;gap:0}
	  .rstk-kind-form.rstk-choice-button .rstk-option:has(input:checked),.rstk-choice-button .rstk-embedded-form .rstk-option:has(input:checked){background:var(--rstk-form-choice-selected-border,var(--rstk-accent));border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));color:var(--rstk-on-accent)}
	  .rstk-kind-form.rstk-choice-check .rstk-option,.rstk-choice-check .rstk-embedded-form .rstk-option{justify-content:space-between;gap:12px;border-width:0 0 var(--rstk-form-field-border-width,1px);border-radius:0;background:transparent;padding-inline:0}
	  .rstk-kind-form.rstk-choice-check .rstk-option::after,.rstk-choice-check .rstk-embedded-form .rstk-option::after{content:'';flex:0 0 auto;width:20px;height:20px;border-radius:999px;border:2px solid var(--rstk-form-field-border,var(--rstk-input-border));box-sizing:border-box;transition:border-color .15s ease,background .15s ease}
	  .rstk-kind-form.rstk-choice-check .rstk-option:has(input:checked),.rstk-choice-check .rstk-embedded-form .rstk-option:has(input:checked){background:transparent}
	  .rstk-kind-form.rstk-choice-check .rstk-option:has(input:checked)::after,.rstk-choice-check .rstk-embedded-form .rstk-option:has(input:checked)::after{border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));background:var(--rstk-form-choice-selected-border,var(--rstk-accent));box-shadow:inset 0 0 0 3px var(--rstk-form-field-bg,var(--rstk-input-bg))}
	  .rstk-kind-form.rstk-choice-segmented .rstk-options,.rstk-choice-segmented .rstk-embedded-form .rstk-options{display:flex;flex-wrap:wrap;gap:0}
	  .rstk-kind-form.rstk-choice-segmented .rstk-option,.rstk-choice-segmented .rstk-embedded-form .rstk-option{position:relative;flex:1 1 0;justify-content:center;text-align:center;gap:0;border-radius:0;margin-left:calc(-1 * var(--rstk-form-field-border-width,1px))}
	  .rstk-kind-form.rstk-choice-segmented .rstk-option:first-child,.rstk-choice-segmented .rstk-embedded-form .rstk-option:first-child{margin-left:0;border-top-left-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));border-bottom-left-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)))}
	  .rstk-kind-form.rstk-choice-segmented .rstk-option:last-child,.rstk-choice-segmented .rstk-embedded-form .rstk-option:last-child{border-top-right-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));border-bottom-right-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)))}
	  .rstk-kind-form.rstk-choice-segmented .rstk-option:has(input:checked),.rstk-choice-segmented .rstk-embedded-form .rstk-option:has(input:checked){z-index:1;background:var(--rstk-form-choice-selected-border,var(--rstk-accent));border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));color:var(--rstk-on-accent)}
	  .rstk-kind-form.rstk-choice-grid .rstk-option input,.rstk-kind-form.rstk-choice-button .rstk-option input,.rstk-kind-form.rstk-choice-check .rstk-option input,.rstk-kind-form.rstk-choice-segmented .rstk-option input,.rstk-choice-grid .rstk-embedded-form .rstk-option input,.rstk-choice-button .rstk-embedded-form .rstk-option input,.rstk-choice-check .rstk-embedded-form .rstk-option input,.rstk-choice-segmented .rstk-embedded-form .rstk-option input{position:absolute;opacity:0;pointer-events:none}

  /* Estilo de opciones/lista/caja POR CAMPO (override del global). Aditivo: el
     estilo global sigue intacto; un campo con override lleva en su .rstk-field
     la clase .rstk-fieldstyled (reset a base) + la variante. Gana por orden.
     LOCKSTEP con frontend sitesCanvas.css y getFieldOwnStyleClass (Sites.tsx/este archivo). */
  .rstk-field.rstk-fieldstyled .rstk-options{display:grid;grid-template-columns:none;flex-wrap:nowrap;gap:10px}
  .rstk-field.rstk-fieldstyled .rstk-option{position:static;gap:11px;min-height:var(--rstk-form-field-height,50px);border-width:var(--rstk-form-field-border-width,1px);border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:var(--rstk-form-field-bg,var(--rstk-input-bg));box-shadow:none;justify-content:flex-start;text-align:left;flex:0 1 auto;margin-left:0;padding:var(--rstk-form-field-pad-y,13px) var(--rstk-form-field-pad-x,14px)}
  .rstk-field.rstk-fieldstyled .rstk-option input{position:static;opacity:1;pointer-events:auto}
  .rstk-field.rstk-fieldstyled .rstk-option::after{content:none}
  .rstk-field.rstk-fieldstyled select{border-width:var(--rstk-form-field-border-width,1px);border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background-color:var(--rstk-form-field-bg,var(--rstk-input-bg));padding-left:9px;padding-right:42px}
  .rstk-field.rstk-fieldstyled > input,.rstk-field.rstk-fieldstyled > textarea{border-width:var(--rstk-form-field-border-width,1px);border-color:var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:var(--rstk-form-field-bg,var(--rstk-input-bg));padding-left:var(--rstk-form-field-pad-x,14px);padding-right:var(--rstk-form-field-pad-x,14px)}
  .rstk-field.rstk-choice-cards .rstk-option{position:relative;gap:0;padding-left:var(--rstk-form-field-pad-x,14px);box-shadow:inset 4px 0 0 transparent}
  .rstk-field.rstk-choice-cards .rstk-option input{position:absolute;opacity:0;pointer-events:none}
  .rstk-field.rstk-choice-cards .rstk-option:has(input:checked){box-shadow:inset 4px 0 0 var(--rstk-form-choice-selected-border,var(--rstk-accent))}
  .rstk-field.rstk-choice-pills .rstk-options{display:flex;flex-wrap:wrap;gap:8px}
  .rstk-field.rstk-choice-pills .rstk-option{position:relative;flex:0 1 auto;min-height:40px;border-radius:999px;padding:9px 16px;gap:0}
  .rstk-field.rstk-choice-pills .rstk-option input{position:absolute;opacity:0;pointer-events:none}
  .rstk-field.rstk-choice-minimal .rstk-option{min-height:38px;border-width:0 0 var(--rstk-form-field-border-width,1px);border-radius:0;background:transparent;padding-inline:0}
  .rstk-field.rstk-choice-grid .rstk-options{grid-template-columns:repeat(2,minmax(0,1fr))}
  .rstk-field.rstk-choice-grid .rstk-option{justify-content:center;text-align:center;gap:0}
  .rstk-field.rstk-choice-grid .rstk-option input{position:absolute;opacity:0;pointer-events:none}
  .rstk-field.rstk-choice-button .rstk-option{justify-content:center;text-align:center;gap:0}
  .rstk-field.rstk-choice-button .rstk-option input{position:absolute;opacity:0;pointer-events:none}
  .rstk-field.rstk-choice-button .rstk-option:has(input:checked){background:var(--rstk-form-choice-selected-border,var(--rstk-accent));border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));color:var(--rstk-on-accent)}
  .rstk-field.rstk-choice-check .rstk-option{justify-content:space-between;gap:12px;border-width:0 0 var(--rstk-form-field-border-width,1px);border-radius:0;background:transparent;padding-inline:0}
  .rstk-field.rstk-choice-check .rstk-option input{position:absolute;opacity:0;pointer-events:none}
  .rstk-field.rstk-choice-check .rstk-option::after{content:'';flex:0 0 auto;width:20px;height:20px;border-radius:999px;border:2px solid var(--rstk-form-field-border,var(--rstk-input-border));box-sizing:border-box}
  .rstk-field.rstk-choice-check .rstk-option:has(input:checked)::after{border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));background:var(--rstk-form-choice-selected-border,var(--rstk-accent));box-shadow:inset 0 0 0 3px var(--rstk-form-field-bg,var(--rstk-input-bg))}
  .rstk-field.rstk-choice-segmented .rstk-options{display:flex;flex-wrap:wrap;gap:0}
  .rstk-field.rstk-choice-segmented .rstk-option{position:relative;flex:1 1 0;justify-content:center;text-align:center;gap:0;border-radius:0;margin-left:calc(-1 * var(--rstk-form-field-border-width,1px))}
  .rstk-field.rstk-choice-segmented .rstk-option input{position:absolute;opacity:0;pointer-events:none}
  .rstk-field.rstk-choice-segmented .rstk-option:first-child{margin-left:0}
  .rstk-field.rstk-choice-segmented .rstk-option:has(input:checked){z-index:1;background:var(--rstk-form-choice-selected-border,var(--rstk-accent));border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));color:var(--rstk-on-accent)}
  .rstk-field.rstk-select-filled select{background-color:color-mix(in srgb,var(--rstk-form-field-bg,transparent) 88%,var(--rstk-accent) 12%)}
  .rstk-field.rstk-select-underline select{border-width:0 0 var(--rstk-form-field-border-width,1px);border-radius:0;background-color:transparent;padding-left:0;padding-right:36px}
  .rstk-field.rstk-select-soft select{border-radius:999px;background-color:color-mix(in srgb,var(--rstk-form-field-bg,var(--rstk-input-bg)) 90%,var(--rstk-accent) 10%);padding-left:20px}
  .rstk-field.rstk-input-underline > input,.rstk-field.rstk-input-underline > textarea{border-width:0 0 var(--rstk-form-field-border-width,1px);border-radius:0;background:transparent;padding-left:0;padding-right:0}
  .rstk-field.rstk-input-filled > input,.rstk-field.rstk-input-filled > textarea{border-width:0 0 var(--rstk-form-field-border-width,1px);border-color:var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius))) var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius))) 0 0;background:color-mix(in srgb,var(--rstk-muted) 10%,transparent)}
  .rstk-field.rstk-input-soft > input{border-radius:999px;border-color:transparent;background:color-mix(in srgb,var(--rstk-muted) 8%,transparent);padding-left:calc(var(--rstk-form-field-pad-x,14px) + 6px);padding-right:calc(var(--rstk-form-field-pad-x,14px) + 6px)}
  .rstk-field.rstk-input-soft > textarea{border-radius:20px;border-color:transparent;background:color-mix(in srgb,var(--rstk-muted) 8%,transparent)}

  .rstk-embed{width:100%;min-height:var(--rstk-embed-height,360px);display:block;border:var(--rstk-block-border-width,1px) solid var(--rstk-block-border,var(--rstk-border));border-radius:var(--rstk-block-radius,var(--rstk-radius));background:var(--rstk-block-bg,var(--rstk-surface2))}
  .rstk-calendar-embed{width:var(--rstk-media-width,100%);min-height:var(--rstk-embed-height,760px);margin-left:var(--rstk-media-margin-left,0);margin-right:var(--rstk-media-margin-right,0);border:var(--rstk-calendar-frame-border-width,0) solid var(--rstk-calendar-frame-border,transparent);border-radius:var(--rstk-media-radius,0);background:transparent;box-shadow:none}
  iframe.rstk-embed{overflow:hidden}
  .rstk-embed-code{background:transparent}
  .rstk-embed-empty{display:grid;place-items:center;min-height:160px;color:var(--rstk-muted)}

	  .rstk-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
	  .rstk-actions [data-submit],.rstk-actions [data-next],.rstk-actions [data-form-next],.rstk-actions [data-embedded-next]{flex:1 1 auto}
	  .rstk-kind-form .rstk-actions,.rstk-embedded-form .rstk-actions{justify-content:var(--rstk-submit-justify,center)}
	  .rstk-kind-form .rstk-actions [data-submit],.rstk-kind-form .rstk-actions [data-form-next],.rstk-kind-form .rstk-actions [data-next],.rstk-embedded-form .rstk-actions [data-submit],.rstk-embedded-form .rstk-actions [data-embedded-next]{min-height:var(--rstk-submit-height,var(--rstk-button-height,50px));border-width:var(--rstk-submit-border-width,var(--rstk-button-border-width,1px));border-color:var(--rstk-submit-border,var(--rstk-button-border,var(--rstk-accent)));border-radius:var(--rstk-submit-radius,var(--rstk-btn-radius));background:var(--rstk-submit-bg,var(--rstk-accent));color:var(--rstk-submit-text,var(--rstk-on-accent));flex-direction:column;gap:2px;font-size:var(--rstk-submit-size,var(--rstk-button-size,1.02rem));padding:var(--rstk-submit-pad-y,var(--rstk-button-pad-y,8px)) var(--rstk-submit-pad-x,var(--rstk-button-pad-x,22px));flex:0 1 var(--rstk-submit-width,fit-content);width:var(--rstk-submit-width,fit-content)}
  .rstk-actions [data-back]{flex:0 0 auto;min-width:120px}
  .rstk-error{margin:2px 0 0;color:var(--rstk-form-error,var(--neg,var(--rstk-accent)));font-size:.85rem;font-weight:650}
  .rstk-field[data-invalid] > input,.rstk-field[data-invalid] > textarea,.rstk-field[data-invalid] > select,.rstk-field[data-invalid] .rstk-phone-input > input,.rstk-field[data-invalid] .rstk-phone-input > select,.rstk-field[data-invalid] .rstk-option{border-color:var(--rstk-form-error,var(--neg,var(--rstk-accent)))!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--rstk-form-error,var(--neg,var(--rstk-accent))) 14%,transparent)}
  .rstk-disqualify-notice{margin:6px 0 0;padding:8px 11px;border-radius:8px;border:1px solid color-mix(in srgb,#d97706 38%,transparent);background:color-mix(in srgb,#d97706 12%,transparent);color:var(--rstk-ink,#1f2937);font-size:.82rem;font-weight:600;line-height:1.4}
  .rstk-submit-message{margin:0;color:var(--rstk-muted);font-weight:650;text-align:center}
  .rstk-submit-message .rstk-payment-action{display:inline-flex;align-items:center;justify-content:center;min-height:42px;margin:10px auto 0;border:1px solid var(--rstk-submit-border,var(--rstk-accent));border-radius:var(--rstk-submit-radius,var(--rstk-btn-radius));background:var(--rstk-submit-bg,var(--rstk-accent));color:var(--rstk-submit-text,var(--rstk-on-accent));font-weight:800;text-decoration:none;padding:8px 16px}
  .rstk-payment-block{width:100%;display:grid;justify-self:var(--rstk-form-field-justify,stretch);text-align:var(--rstk-block-align,left)}
  .rstk-payment-panel{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px;width:100%;border:var(--rstk-block-border-width,1px) solid var(--rstk-block-border,var(--rstk-border));border-radius:var(--rstk-block-radius,var(--rstk-radius));background:var(--rstk-block-bg,var(--rstk-surface));color:var(--rstk-block-text,var(--rstk-ink));padding:clamp(16px,3vw,24px)}
  .rstk-payment-copy{min-width:0;display:grid;gap:5px}
  .rstk-payment-kicker{color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 58%,var(--rstk-muted) 42%);font-size:.78rem;font-weight:750;letter-spacing:0;text-transform:uppercase}
  .rstk-payment-copy strong{color:var(--rstk-block-text,var(--rstk-ink));font-size:clamp(1.05rem,2vw,1.35rem);font-weight:850;line-height:1.1}
  .rstk-payment-copy p{margin:0;color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 60%,var(--rstk-muted) 40%)}
  .rstk-payment-side{min-width:min(220px,100%);display:grid;gap:10px;justify-items:end}
  .rstk-payment-amount{color:var(--rstk-block-text,var(--rstk-ink));font-size:clamp(1.05rem,2.1vw,1.5rem);font-weight:850;font-variant-numeric:tabular-nums;line-height:1}
  .rstk-payment-block .rstk-button-link{justify-self:var(--rstk-button-justify,end);width:var(--rstk-button-width,fit-content);margin-left:var(--rstk-button-margin-left,auto);margin-right:var(--rstk-button-margin-right,0)}
  .rstk-payment-banner .rstk-payment-panel{border-left-width:max(var(--rstk-block-border-width,1px),4px);background:color-mix(in srgb,var(--rstk-block-bg,var(--rstk-surface)) 88%,var(--rstk-accent) 12%)}
  .rstk-payment-minimal .rstk-payment-panel{grid-template-columns:minmax(0,1fr);border-width:0;background:transparent;padding:0}
  .rstk-payment-minimal .rstk-payment-side{justify-items:start}

  .rstk-progress{display:grid;gap:8px}
  .rstk-progress-track{height:6px;border-radius:999px;background:color-mix(in srgb,var(--rstk-ink) 12%,transparent);overflow:hidden}
  .rstk-progress-fill{display:block;height:100%;width:0;border-radius:999px;background:var(--rstk-accent);transition:width .35s cubic-bezier(.4,0,.2,1)}
  .rstk-progress b{font-size:.8rem;color:var(--rstk-muted);font-weight:700}

  @media (max-width:640px){
    .rstk-list-grid{grid-template-columns:1fr}
    .rstk-countdown-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
    .rstk-payment-panel{grid-template-columns:1fr}
    .rstk-payment-side{justify-items:stretch}
    .rstk-payment-block .rstk-button-link{width:100%;margin-inline:0}
    .rstk-site-panel{align-items:flex-start;flex-direction:column}
    .rstk-site-panel-footer{align-items:center}
    .rstk-site-panel-links{justify-content:flex-start}
  }

  .rstk-footer{margin:6px 0 0;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--rstk-muted);font-size:.78rem;text-align:center}
  .rstk-footer .rstk-lock{display:inline-flex}

  .rstk-chrome .rstk-avatar{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;overflow:hidden;background:var(--rstk-accent);color:#fff;font-weight:800;font-size:1.15rem;flex:0 0 auto}
  .rstk-chrome .rstk-avatar img{width:100%;height:100%;object-fit:cover}
	  .rstk-social-profile{margin:calc(-1 * var(--rstk-pad)) calc(-1 * var(--rstk-pad)) 0;padding:20px var(--rstk-pad) 14px;display:flex;align-items:center;gap:8px;background:transparent;border:0}
	  .rstk-social-profile-block{width:fit-content;min-width:0;max-width:100%;margin:0;padding:0;border:0;border-radius:0;background:transparent;gap:var(--rstk-social-gap,12px)}
	  .rstk-social-image{position:relative;display:inline-block;flex:0 0 auto}
	  .rstk-social-profile .rstk-avatar{width:64px;height:64px;font-size:1.35rem}
	  .rstk-social-profile-block .rstk-avatar{width:var(--rstk-social-avatar-size,70px);height:var(--rstk-social-avatar-size,70px);font-size:var(--rstk-social-avatar-font-size,22px)}
  .rstk-social-platform{position:absolute;right:-2px;bottom:-1px;z-index:2;width:var(--rstk-social-badge-size,25px);height:var(--rstk-social-badge-size,25px);border-radius:50%;border:2px solid #fff;background:#fff;display:grid;place-items:center;padding:1px;color:#fff;overflow:hidden}
  .rstk-social-platform-facebook{background:#1877f2 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23fff' d='M15.4 8.4h-2V7.05c0-.5.34-.62.58-.62h1.38V4.12l-1.9-.01c-2.12 0-2.62 1.58-2.62 2.6V8.4H9.2v2.6h1.64V20h2.56v-9h1.74z'/%3E%3C/svg%3E") center/58% no-repeat}
  .rstk-social-platform-instagram{background:var(--rstk-gradient)}
  .rstk-social-platform-tiktok{background:#050505;box-shadow:inset 1px 0 var(--rstk-cyan),inset -1px 0 var(--rstk-accent)}
  .rstk-social-platform-threads{background:#050505;font-size:var(--rstk-social-badge-icon-size,14px);font-weight:900;line-height:1}
  .rstk-social-platform svg{width:var(--rstk-social-badge-icon-size,14px);height:var(--rstk-social-badge-icon-size,14px)}
  .rstk-social-details{display:flex;flex-direction:column;min-width:0}
  .rstk-social-profile-block .rstk-social-details{flex:1 1 auto;min-width:0;max-width:100%}
  .rstk-social-name{display:flex;align-items:center;gap:2px;min-width:0;font-size:var(--rstk-social-name-size,20px);line-height:1.08;font-weight:700;color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 92%,var(--rstk-muted) 8%)}
  .rstk-social-profile-block .rstk-social-name,.rstk-social-profile-block .rstk-social-followers{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rstk-social-name .rstk-verified{width:var(--rstk-social-verified-size,18px);height:var(--rstk-social-verified-size,18px);margin-left:0;color:#1877f2;flex:0 0 auto;align-self:center;position:relative;top:0;transform:translateY(0.04em)}
  .rstk-social-followers{margin-top:1px;color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 50%,var(--rstk-muted) 50%);font-size:var(--rstk-social-followers-size,16px);line-height:1.18;font-weight:500}
  @media (max-width:480px){
    .rstk-social-profile{padding:15px var(--rstk-pad) 12px}
    .rstk-social-profile .rstk-avatar{width:60px;height:60px}
    .rstk-social-name{font-size:18px}
    .rstk-social-followers{font-size:12px}
  }

  @media (max-width:540px){
    .rstk-actions{flex-direction:column-reverse}
    .rstk-actions button{width:100%}
    .rstk-actions [data-back]{width:100%}
  }

  /* ---------- Premium landing ---------- */
  .rstk-kind-landing .rstk-frame{padding:0}
  .rstk-kind-landing .rstk-page{max-width:none;margin:0;border-radius:var(--rstk-page-radius,0);overflow:hidden}
  .rstk-kind-landing .rstk-shell{gap:0;padding-top:0}
  .rstk-kind-landing .rstk-section-column{gap:0}
  .rstk-kind-landing .rstk-headline{font-family:var(--rstk-block-font,var(--rstk-site-title-font,var(--rstk-display)));font-size:clamp(2.3rem,5.6vw,4rem);line-height:1.03;letter-spacing:0;background:none;color:var(--rstk-block-text,var(--rstk-ink))}
  .rstk-kind-landing .rstk-subheading{font-size:clamp(1.05rem,1.7vw,1.28rem);max-width:var(--rstk-content-max,60ch);line-height:1.6}
  .rstk-kind-landing h2{font-family:var(--rstk-block-font,var(--rstk-site-title-font,var(--rstk-display)))}
  .rstk-kind-landing .rstk-text{font-size:1.06rem;line-height:1.7}

  .rstk-kind-landing .rstk-kicker{display:inline-flex;align-items:center;gap:8px;width:fit-content;padding:7px 14px 7px 12px;border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,var(--rstk-border));border-radius:999px;background:var(--rstk-block-bg,transparent);color:var(--rstk-muted);font-size:.72rem;font-weight:700;letter-spacing:0;text-transform:uppercase}
  .rstk-kind-landing .rstk-kicker::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--rstk-accent)}

  .rstk-kind-landing .rstk-hero{position:relative;isolation:isolate;overflow:hidden;gap:22px;justify-items:var(--rstk-block-justify,center);text-align:var(--rstk-block-align,center);padding:clamp(32px,4.8vw,68px) clamp(20px,3.2vw,44px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent)}
  .rstk-kind-landing .rstk-hero::before,.rstk-kind-landing .rstk-hero::after{content:none}
  .rstk-kind-landing .rstk-hero .rstk-headline{font-size:clamp(2.6rem,6.2vw,4.6rem);max-width:var(--rstk-content-max,16ch)}
  .rstk-kind-landing .rstk-hero .rstk-subheading{margin-left:var(--rstk-content-margin-left,auto);margin-right:var(--rstk-content-margin-right,auto)}

  .rstk-kind-landing .rstk-section-break{min-height:clamp(160px,24vw,360px);align-content:center;padding:clamp(28px,5vw,76px) clamp(20px,4vw,56px)}
  .rstk-kind-landing .rstk-section-break h2{font-family:var(--rstk-block-font,var(--rstk-site-title-font,var(--rstk-display)));font-size:clamp(2rem,4.6vw,3.4rem);line-height:1.08}
  .rstk-kind-landing .rstk-section-break p{max-width:var(--rstk-content-max,58ch);margin:0;color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 74%,transparent)}

  .rstk-kind-landing .rstk-section-list{gap:clamp(20px,3vw,38px)}
  .rstk-kind-landing .rstk-section-list h2{text-align:var(--rstk-block-align,center);max-width:var(--rstk-content-max,20ch);margin-left:var(--rstk-content-margin-left,auto);margin-right:var(--rstk-content-margin-right,auto);font-size:clamp(1.85rem,3.4vw,2.85rem);line-height:1.08;letter-spacing:0}
  .rstk-kind-landing .rstk-list-grid{gap:16px}
  .rstk-kind-landing .rstk-list-grid article{padding:24px;border:var(--rstk-card-border-width,var(--rstk-block-border-width,0)) solid var(--rstk-card-border,var(--rstk-block-border,transparent));border-radius:var(--rstk-card-radius,0);background:var(--rstk-card-bg,var(--rstk-block-bg,transparent));transition:border-color .15s ease}
  .rstk-kind-landing .rstk-list-grid article:hover{border-color:color-mix(in srgb,var(--rstk-ink) 22%,transparent)}
  .rstk-kind-landing .rstk-list-grid strong{font-size:1.06rem}

  .rstk-kind-landing .rstk-checklist{padding:clamp(24px,3vw,40px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent);width:100%;margin-inline:auto}
  .rstk-kind-landing .rstk-checklist h2{text-align:var(--rstk-block-align,center);margin-bottom:4px}
  .rstk-kind-landing .rstk-check-body strong{font-size:1.04rem}

  .rstk-kind-landing .rstk-cta{position:relative;overflow:hidden;justify-items:var(--rstk-block-justify,center);text-align:var(--rstk-block-align,center);gap:18px;padding:clamp(30px,4.4vw,62px) clamp(20px,3.2vw,44px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent)}
  .rstk-kind-landing .rstk-cta::after{content:none}
  .rstk-kind-landing .rstk-cta > *{position:relative;z-index:1}
  .rstk-kind-landing .rstk-cta h2{font-size:clamp(2rem,4vw,3.1rem)}
  .rstk-kind-landing .rstk-cta p{font-size:1.1rem;max-width:var(--rstk-content-max,52ch);margin-left:var(--rstk-content-margin-left,auto);margin-right:var(--rstk-content-margin-right,auto)}

  .rstk-kind-landing .rstk-button-link{border-radius:var(--rstk-block-button-radius,999px);min-height:var(--rstk-button-height,54px);padding:var(--rstk-button-pad-y,0) var(--rstk-button-pad-x,28px);font-family:var(--rstk-button-font,var(--rstk-display));font-weight:var(--rstk-button-weight,600);transition:transform .25s var(--rstk-ease),box-shadow .25s var(--rstk-ease),background .2s ease}
  .rstkButtonPaddingOverride .rstk-button-link,.rstkButtonPaddingOverride .rstk-actions button{min-height:auto}
  .rstk-kind-landing .rstk-button-link:hover{transform:none;box-shadow:none}

  .rstk-kind-landing .rstk-media,.rstk-kind-landing .rstk-embed{border-radius:var(--rstk-media-radius,var(--rstk-block-radius,clamp(16px,2vw,22px)));box-shadow:none}
  .rstk-kind-landing .rstk-video{border-radius:var(--rstk-video-radius,var(--rstk-media-radius,var(--rstk-block-radius,clamp(16px,2vw,22px))));box-shadow:none}
  .rstk-kind-landing .rstk-calendar-embed{border-radius:var(--rstk-media-radius,0)}
  .rstk-kind-landing .rstk-embedded-form{padding:clamp(24px,3vw,40px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent);width:100%;margin-inline:auto}
  .rstk-section-lane:has(.rstk-embedded-form-source-frame),.rstk-section-column:has(.rstk-embedded-form-source-frame),.rstk-block-style:has(.rstk-embedded-form-source-frame){overflow:visible}
  .rstk-embedded-form-source-frame{--rstk-block-text:var(--rstk-ink);--rstk-block-font:var(--rstk-font);--rstk-block-font-style:normal;--rstk-block-text-decoration:none;--rstk-block-text-transform:none;--rstk-block-align:initial;--rstk-block-justify:initial;--rstk-content-margin-left:initial;--rstk-content-margin-right:initial;text-align:var(--rstk-block-align,left);position:relative;isolation:isolate;min-height:auto;box-sizing:border-box;width:100%;max-width:100%;min-width:0;margin:0;padding:0;background-color:var(--rstk-page-bg);background-image:var(--rstk-page-image);background-position:var(--rstk-page-image-position,center top);background-repeat:var(--rstk-page-image-repeat,no-repeat);background-size:var(--rstk-page-image-size,auto);background-attachment:var(--rstk-page-image-attachment,scroll);border-radius:var(--rstk-page-radius,0);overflow:visible}
  .rstk-embedded-form-source-frame::before{content:"";position:absolute;inset:0;z-index:1;background:var(--rstk-page-overlay,none);pointer-events:none}
  .rstk-embedded-form-source-frame>.rstk-bg-video{position:absolute;inset:0;z-index:0;width:100%;height:100%;object-fit:var(--rstk-page-video-fit,cover);pointer-events:none}
  .rstk-embedded-form-source-frame>.rstk-page{position:relative;z-index:2;width:100%;max-width:min(100%,var(--rstk-max));min-width:0;margin-top:0;margin-bottom:0;margin-left:var(--rstk-form-page-margin-left,auto);margin-right:var(--rstk-form-page-margin-right,auto);border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,transparent);border-radius:var(--rstk-page-radius,0);overflow:visible}
  body:has(.rstkBlockFullWidth){overflow-x:hidden}
  .rstk-frame:has(.rstkBlockFullWidth),.rstk-kind-form .rstk-shell:has(.rstkBlockFullWidth),.rstk-kind-landing .rstk-page:has(.rstkBlockFullWidth),.rstk-section-lane:has(.rstkBlockFullWidth),.rstk-section-inner:has(.rstkBlockFullWidth),.rstk-section-column:has(.rstkBlockFullWidth){overflow:visible}
  .rstk-kind-form .rstk-page:has(.rstkEmbeddedFormStretch){max-width:none;margin:0}
  .rstk-embedded-form-source-frame.rstkEmbeddedFormStretch{width:100%;max-width:none;margin:0}
  .rstk-embedded-form-source-frame.rstkEmbeddedFormStretch>.rstk-page{max-width:min(100%,var(--rstk-max));width:100%;margin-top:0;margin-bottom:0;margin-left:var(--rstk-form-page-margin-left,auto);margin-right:var(--rstk-form-page-margin-right,auto)}
  .rstk-block-style.rstkBlockFullWidth{width:100vw;max-width:100vw;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw);padding-inline:max(24px,calc(50vw - var(--rstk-max)/2))}
  .rstk-embedded-form-source-frame .rstk-block-style.rstkBlockFullWidth{width:100%;max-width:100%;margin-left:0;margin-right:0;padding-inline:max(24px,calc(50% - var(--rstk-max)/2))}
  .rstk-embedded-form-source-frame .rstk-shell{display:grid;grid-template-columns:minmax(0,1fr);width:100%;max-width:100%;min-width:0;gap:var(--rstk-gap);background:var(--rstk-form-surface,var(--rstk-surface));border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,var(--rstk-border));border-radius:var(--rstk-page-radius,var(--rstk-radius-lg));box-shadow:none;padding:0;overflow:hidden}
  .rstk-embedded-form-source-frame .rstk-shell:has(.rstkBlockFullWidth){overflow:visible}
  .rstk-kind-landing .rstk-embedded-form-source-frame .rstk-embedded-form,.rstk-embedded-form-source-frame .rstk-embedded-form{width:100%;max-width:100%;min-width:0;justify-self:stretch;margin:0;padding:0;border:0;border-radius:0;background:transparent}
  .rstk-embedded-form-source-frame .rstk-embedded-pages,.rstk-embedded-form-source-frame .rstk-embedded-pages [data-embedded-page-content]{width:100%;max-width:100%;min-width:0;justify-self:stretch}
  .rstk-embedded-form-source-frame .rstk-block-style{max-width:100%;min-width:0}
  .rstk-embedded-form-source-frame .rstkSocialProfileBlock.rstk-block-style{justify-self:start;transform:none}
  .rstk-embedded-form-source-frame .rstk-social-profile-block{padding:0}
  .rstk-embedded-form-source-frame .rstk-headline{margin:0;color:var(--rstk-ink);font-family:var(--rstk-font);font-size:clamp(1.7rem,4.6vw,3rem);font-weight:var(--rstk-heading-weight);line-height:1.05;letter-spacing:0;background-image:none;-webkit-text-fill-color:currentColor;max-width:100%;min-width:0;overflow-wrap:break-word}
  .rstk-embedded-form-source-frame .rstk-subheading{margin:0;color:var(--rstk-muted);font-size:clamp(1rem,2vw,1.18rem);line-height:1.5;max-width:min(100%,var(--rstk-content-max,60ch));min-width:0;background-image:none;-webkit-text-fill-color:currentColor;overflow-wrap:break-word}
  .rstk-embedded-form-source-frame .rstk-text{margin:0;color:color-mix(in srgb,var(--rstk-ink) 80%,transparent);font-size:1rem;line-height:1.55;max-width:min(100%,var(--rstk-content-max,66ch));min-width:0;background-image:none;-webkit-text-fill-color:currentColor;overflow-wrap:break-word}
  .rstk-embedded-form-source-frame .rstk-media,.rstk-embedded-form-source-frame .rstk-video{max-width:100%;min-width:0}
  .rstk-embedded-form-source-frame .rstk-media img,.rstk-embedded-form-source-frame .rstk-video iframe,.rstk-embedded-form-source-frame .rstk-video video{max-width:100%;min-width:0}
  .rstk-embedded-form-source-frame .rstk-video-control-bar{max-width:calc(100% - 24px);min-width:0}
  .rstk-embedded-form-source-frame .rstk-field > label{color:var(--rstk-form-label-color,var(--rstk-ink))}
  .rstk-embedded-form-source-frame .rstk-help{color:var(--rstk-form-help-color,var(--rstk-muted));background-image:none;-webkit-text-fill-color:currentColor}
  @media (max-width:760px){.rstk-section-columns{grid-template-columns:1fr}}
  .rstkFontOverride .rstk-headline,.rstkFontOverride .rstk-subheading,.rstkFontOverride .rstk-text,.rstkFontOverride h2,.rstkFontOverride label,.rstkFontOverride .rstk-help,.rstkFontOverride .rstk-list-grid strong,.rstkFontOverride .rstk-list-grid p,.rstkFontOverride .rstk-check-body strong,.rstkFontOverride .rstk-check-body span{font-family:var(--rstk-block-font,inherit)}
  .rstkSizeOverride .rstk-headline,.rstkSizeOverride .rstk-subheading,.rstkSizeOverride .rstk-text,.rstkSizeOverride h2,.rstkSizeOverride label,.rstkSizeOverride .rstk-help,.rstkSizeOverride .rstk-list-grid strong,.rstkSizeOverride .rstk-list-grid p,.rstkSizeOverride .rstk-list-grid small,.rstkSizeOverride .rstk-check-body strong,.rstkSizeOverride .rstk-check-body span{font-size:var(--rstk-block-size)}
  .rstkWeightOverride .rstk-headline,.rstkWeightOverride .rstk-subheading,.rstkWeightOverride .rstk-text,.rstkWeightOverride h2,.rstkWeightOverride label,.rstkWeightOverride .rstk-help,.rstkWeightOverride .rstk-list-grid strong,.rstkWeightOverride .rstk-check-body strong{font-weight:var(--rstk-block-weight,850)}
  .rstkItalicOverride .rstk-headline,.rstkItalicOverride .rstk-subheading,.rstkItalicOverride .rstk-text,.rstkItalicOverride h2,.rstkItalicOverride label,.rstkItalicOverride .rstk-help,.rstkItalicOverride .rstk-list-grid strong,.rstkItalicOverride .rstk-list-grid p,.rstkItalicOverride .rstk-check-body strong,.rstkItalicOverride .rstk-check-body span{font-style:var(--rstk-block-font-style,italic)}
  .rstkUnderlineOverride .rstk-headline,.rstkUnderlineOverride .rstk-subheading,.rstkUnderlineOverride .rstk-text,.rstkUnderlineOverride h2,.rstkUnderlineOverride label,.rstkUnderlineOverride .rstk-help,.rstkUnderlineOverride .rstk-list-grid strong,.rstkUnderlineOverride .rstk-list-grid p,.rstkUnderlineOverride .rstk-check-body strong,.rstkUnderlineOverride .rstk-check-body span{text-decoration:var(--rstk-block-text-decoration,underline)}
  .rstkTextTransformOverride .rstk-headline,.rstkTextTransformOverride .rstk-subheading,.rstkTextTransformOverride .rstk-text,.rstkTextTransformOverride h2,.rstkTextTransformOverride label,.rstkTextTransformOverride .rstk-help,.rstkTextTransformOverride .rstk-list-grid strong,.rstkTextTransformOverride .rstk-list-grid p,.rstkTextTransformOverride .rstk-check-body strong,.rstkTextTransformOverride .rstk-check-body span{text-transform:var(--rstk-block-text-transform,none)}
  .rstkLineHeightOverride .rstk-headline,.rstkLineHeightOverride .rstk-subheading,.rstkLineHeightOverride .rstk-text,.rstkLineHeightOverride h2,.rstkLineHeightOverride label,.rstkLineHeightOverride .rstk-help,.rstkLineHeightOverride .rstk-list-grid strong,.rstkLineHeightOverride .rstk-list-grid p,.rstkLineHeightOverride .rstk-check-body strong,.rstkLineHeightOverride .rstk-check-body span{line-height:var(--rstk-block-line-height)}
  .rstkListStyleOverride .rstk-text{display:list-item;list-style-position:inside;list-style-type:var(--rstk-text-list-style,disc)}
  .rstkStrokeOverride .rstk-headline,.rstkStrokeOverride .rstk-subheading,.rstkStrokeOverride .rstk-text,.rstkStrokeOverride h2,.rstkStrokeOverride label,.rstkStrokeOverride .rstk-help,.rstkStrokeOverride .rstk-list-grid strong,.rstkStrokeOverride .rstk-list-grid p,.rstkStrokeOverride .rstk-check-body strong,.rstkStrokeOverride .rstk-check-body span{-webkit-text-stroke:var(--rstk-text-stroke-width,0) var(--rstk-text-stroke-color,currentColor)}
  .rstkTextGradient .rstk-headline,.rstkTextGradient .rstk-subheading,.rstkTextGradient .rstk-text,.rstkTextGradient h2,.rstkTextGradient label,.rstkTextGradient .rstk-help,.rstkTextGradient .rstk-site-panel-copy,.rstkTextGradient .rstk-list-grid strong,.rstkTextGradient .rstk-list-grid p,.rstkTextGradient .rstk-check-body strong,.rstkTextGradient .rstk-check-body span,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-headline,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-subheading,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-text,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) h2,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) label,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-help,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-site-panel-copy,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-list-grid strong,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-list-grid p,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-check-body strong,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-check-body span{background-image:var(--rstk-block-text-paint,var(--rstk-page-text-paint));background-clip:text;-webkit-background-clip:text;color:transparent !important;-webkit-text-fill-color:transparent}
  .rstkButtonTextGradient .rstk-button-label{background-image:var(--rstk-button-text-paint);background-clip:text;-webkit-background-clip:text;color:transparent;-webkit-text-fill-color:transparent}
  .rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-embedded-form-source-frame:not(.rstkPageTextGradient) .rstk-headline,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-embedded-form-source-frame:not(.rstkPageTextGradient) .rstk-subheading,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-embedded-form-source-frame:not(.rstkPageTextGradient) .rstk-text,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-embedded-form-source-frame:not(.rstkPageTextGradient) label,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-embedded-form-source-frame:not(.rstkPageTextGradient) .rstk-help{background-image:none !important;color:var(--rstk-ink) !important;-webkit-text-fill-color:currentColor !important}
  .rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-embedded-form-source-frame:not(.rstkPageTextGradient) .rstk-subheading,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-embedded-form-source-frame:not(.rstkPageTextGradient) .rstk-help{color:var(--rstk-muted) !important}

  @media (max-width:640px){
    .rstk-kind-landing .rstk-hero{padding:clamp(32px,8vw,56px) 20px}
    .rstk-phone-input{grid-template-columns:minmax(124px,132px) minmax(0,1fr)}
    .rstk-phone-input[data-phone-country-hidden]{grid-template-columns:minmax(0,1fr)}
  }
  @media (max-width:340px){
    .rstk-phone-input{grid-template-columns:1fr}
    .rstk-phone-input[data-phone-country-hidden]{grid-template-columns:minmax(0,1fr)}
  }
`

const RSTK_TEMPLATE_EXTRAS = {
  ristak: `
    .rstk-tpl-ristak .rstk-kind-form .rstk-shell{}
  `,

  facebook: `
    .rstk-fb{position:relative;margin:calc(-1 * var(--rstk-pad));margin-bottom:var(--rstk-gap);padding:14px var(--rstk-pad) 12px;border-bottom:1px solid var(--rstk-border)}
    .rstk-fb-line{position:absolute;top:0;left:0;right:0;height:4px;background:var(--rstk-accent)}
    .rstk-fb-row{display:flex;align-items:center;gap:10px}
    .rstk-fb-meta{flex:1 1 auto;min-width:0}
    .rstk-fb-name{display:flex;align-items:center;gap:5px;font-weight:700;font-size:1rem;color:var(--rstk-ink)}
    .rstk-verified{color:#1877f2;flex:0 0 auto}
    .rstk-fb-sub{display:flex;align-items:center;gap:5px;color:var(--rstk-muted);font-size:.82rem;margin-top:1px}
    .rstk-fb-mark{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--rstk-accent);color:#fff;font-weight:900;font-family:Georgia,'Times New Roman',serif;font-size:1.2rem;flex:0 0 auto}
  `,

  instagram: `
    .rstk-ig{position:relative;margin:calc(-1 * var(--rstk-pad));margin-bottom:var(--rstk-gap);padding:0 var(--rstk-pad) 14px}
    .rstk-ig::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:var(--rstk-gradient)}
    .rstk-ig-bar{display:flex;align-items:center;gap:8px;padding:12px 0 14px;border-bottom:1px solid var(--rstk-border)}
    .rstk-ig-cam{display:inline-flex;color:var(--rstk-ink)}
    .rstk-ig-word{font-weight:800;font-size:1.05rem}
    .rstk-ig-dots{margin-left:auto;color:var(--rstk-ink);font-size:1.2rem;line-height:1}
    .rstk-ig-profile{display:flex;align-items:center;gap:11px;padding-top:14px}
    .rstk-ig-ring{display:inline-grid;place-items:center;padding:2px;border-radius:50%;background:var(--rstk-gradient);flex:0 0 auto}
    .rstk-ig-ring .rstk-avatar{width:42px;height:42px;border:2px solid var(--rstk-surface)}
    .rstk-ig-name{font-weight:700;font-size:.95rem}
    .rstk-ig-sub{color:var(--rstk-muted);font-size:.8rem;margin-top:1px}
    .rstk-tpl-instagram .rstk-button-link,.rstk-tpl-instagram .rstk-actions [data-submit],.rstk-tpl-instagram .rstk-actions [data-form-next],.rstk-tpl-instagram .rstk-actions [data-next],.rstk-tpl-instagram .rstk-actions [data-embedded-next]{background:var(--rstk-accent)}
  `,

  tiktok: `
    .rstk-tt{margin:calc(-1 * var(--rstk-pad));margin-bottom:var(--rstk-gap);padding:14px var(--rstk-pad);border-bottom:1px solid var(--rstk-border);display:grid;gap:10px;justify-items:center}
    .rstk-tt-bar{display:flex;align-items:center;gap:8px;font-weight:800;font-size:1.05rem;letter-spacing:.2px}
    .rstk-tt-note{display:inline-flex;color:#fff;filter:drop-shadow(1.5px 0 var(--rstk-cyan)) drop-shadow(-1.5px 0 var(--rstk-accent))}
    .rstk-tt-profile{display:flex;align-items:center;gap:11px}
    .rstk-tt-name{font-weight:800}
    .rstk-tt-sub{color:var(--rstk-muted);font-size:.8rem}
    .rstk-tpl-tiktok .rstk-headline{text-shadow:1.5px 0 var(--rstk-cyan),-1.5px 0 var(--rstk-accent)}
    .rstk-tpl-tiktok ::selection{background:var(--rstk-accent);color:#fff}
  `,

  vsl: `
    .rstk-tpl-vsl .rstk-shell{background:var(--rstk-surface);border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,var(--rstk-border));border-radius:var(--rstk-radius-lg);box-shadow:none;padding:clamp(20px,4vw,40px)}
    .rstk-tpl-vsl .rstk-kicker{display:inline-block}
  `,

  interactive: `
    .rstk-interactive .rstk-shell{min-height:min(72vh,560px);align-content:center;padding:clamp(22px,5vw,46px)}
    .rstk-interactive .rstk-field{gap:14px}
    .rstk-interactive label{font-size:clamp(1.3rem,3.4vw,1.9rem);font-weight:800;letter-spacing:0;line-height:1.15}
    .rstk-interactive .rstk-help{font-size:1rem}
    .rstk-interactive .rstk-options{counter-reset:rstk-opt;gap:12px}
    .rstk-interactive .rstk-option{position:relative;min-height:60px;padding:16px 18px 16px 60px;font-size:1.05rem;font-weight:600}
    .rstk-interactive .rstk-option input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
    .rstk-interactive .rstk-option::before{counter-increment:rstk-opt;content:counter(rstk-opt,upper-alpha);position:absolute;left:14px;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:9px;display:grid;place-items:center;border:1px solid var(--rstk-border);font-weight:800;font-size:.9rem;color:var(--rstk-muted);background:var(--rstk-surface);transition:all .15s ease}
    .rstk-interactive .rstk-option:has(input:checked)::before{background:var(--rstk-accent);color:var(--rstk-on-accent);border-color:var(--rstk-accent)}
    .rstk-interactive .rstk-actions{margin-top:10px}
    .rstk-interactive input,.rstk-interactive textarea,.rstk-interactive select{font-size:1.1rem;padding:15px 16px}
  `
}

function relLuminance(hex) {
  const normalized = normalizeCssColor(hex, '#ffffff')
  let h = String(normalized || '').replace('#', '')
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) {
    const match = normalized.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i)
    if (match) {
      h = [match[1], match[2], match[3]]
        .map(channel => Math.max(0, Math.min(255, Number(channel))).toString(16).padStart(2, '0'))
        .join('')
    }
  }
  if (h.length < 6) return 1
  const toLin = (c) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  const r = toLin(parseInt(h.slice(0, 2), 16))
  const g = toLin(parseInt(h.slice(2, 4), 16))
  const b = toLin(parseInt(h.slice(4, 6), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(foreground, background) {
  const fg = relLuminance(foreground)
  const bg = relLuminance(background)
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
}

function readableTextOnBackground(paint, background, fallback = AUTO_DARK_TEXT, minRatio = MIN_TEXT_CONTRAST_RATIO) {
  const textColor = paintFallbackColor(paint, fallback)
  if (!isCssColor(textColor) || !isCssColor(background)) return textColor
  if (contrastRatio(textColor, background) >= minRatio) return textColor
  return relLuminance(background) < 0.5 ? AUTO_LIGHT_TEXT : AUTO_DARK_TEXT
}

function cssImageUrl(value) {
  const raw = cleanString(value)
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/') && !/^data:image\//i.test(raw)) return ''
  return `url("${raw.replace(/["\\\n\r]/g, '')}")`
}

function cssMediaUrl(value) {
  const raw = cleanString(value)
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/') && !/^data:video\//i.test(raw)) return ''
  return raw.replace(/["\\\n\r]/g, '')
}

function paintLayer(paint) {
  if (!paint) return 'none'
  if (isCssGradient(paint)) return paint
  return `linear-gradient(${paint}, ${paint})`
}

function backgroundFitValue(value) {
  const raw = cleanString(value)
  if (raw === 'contain') return 'contain'
  if (raw === 'full_width') return '100% auto'
  if (raw === 'auto') return 'auto'
  return 'cover'
}

function backgroundRepeatValue(value) {
  const raw = cleanString(value)
  return ['repeat', 'repeat-x', 'repeat-y'].includes(raw) ? raw : 'no-repeat'
}

function backgroundPositionValue(value) {
  const raw = cleanString(value)
  return raw && !/[;{}<>]/.test(raw) ? raw : 'center center'
}

function backgroundAttachmentValue(value) {
  return cleanString(value) === 'fixed' ? 'fixed' : 'scroll'
}

function deriveNeutralVars(template, bg, userAccent) {
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

function resolveRenderOverrides(template, theme, isLandingType, { hasExplicitBackgroundColor } = {}) {
  if (template.chrome !== 'none') return {}
  // La explicitud debe venir del theme CRUDO (theme-vars #1): con el theme ya
  // mergeado backgroundColor siempre existe y el guard de abajo quedaba muerto.
  const hasExplicitBg = hasExplicitBackgroundColor === undefined
    ? typeof theme.backgroundColor === 'string' && theme.backgroundColor.trim() !== ''
    : Boolean(hasExplicitBackgroundColor)
  const paintColor = (value) => {
    const paint = normalizeCssPaint(value, '')
    return paint ? paintFallbackColor(paint, '') : null
  }
  const rawBg = paintColor(theme.backgroundColor)
  const userBg = rawBg && (hasExplicitBg || rawBg.toLowerCase() !== String(DEFAULT_THEME.backgroundColor).toLowerCase()) ? rawBg : null
  const rawAccent = paintColor(theme.accentColor)
  const userAccent = rawAccent && rawAccent.toLowerCase() !== String(DEFAULT_THEME.accentColor).toLowerCase() ? rawAccent : null
  if (isLandingType) {
    return { vars: deriveNeutralVars(template, userBg || template.vars.pageBg, userAccent) }
  }
  if (userBg) {
    return { vars: deriveNeutralVars(template, userBg, userAccent) }
  }
  return userAccent ? { accent: userAccent } : {}
}

function sanitizeCssFont(value) {
  return normalizeSiteFontFamily(value)
}

function normalizeFormChoiceStyle(value) {
  const raw = cleanString(value)
  return ['native', 'cards', 'pills', 'minimal', 'grid', 'button', 'check', 'segmented'].includes(raw) ? raw : 'native'
}

function normalizeFormSelectStyle(value) {
  const raw = cleanString(value)
  return ['classic', 'filled', 'underline', 'soft'].includes(raw) ? raw : 'classic'
}

function normalizeFormInputStyle(value) {
  const raw = cleanString(value)
  return ['box', 'underline', 'filled', 'soft'].includes(raw) ? raw : 'box'
}

// Igual que la versión histórica del backend pero devuelve un MAPA de variables
// (el backend lo serializa a :root/style y el editor lo aplica inline).
function buildFormThemeStyleVars(theme, { baseFont, v, accent, ink, muted }) {
  const formFont = sanitizeCssFont(theme.formFontFamily) || baseFont
  const formLabel = themePaint(theme, 'formLabelColor') || ink
  const formHelp = themePaint(theme, 'formHelpColor') || muted
  const formSurface = themePaint(theme, 'formSurfaceColor')
  const formFieldBg = themePaint(theme, 'formFieldBg') || 'transparent'
  const formFieldText = themePaint(theme, 'formFieldText') || v.inputInk
  const formFieldBorder = themePaint(theme, 'formFieldBorder') || v.inputBorder
  const formPlaceholder = themePaint(theme, 'formPlaceholderColor') || muted
  const choiceSelectedBg = themePaint(theme, 'formChoiceSelectedBg') || ('color-mix(in srgb, ' + accent + ' 10%, transparent)')
  const choiceSelectedBorder = themePaint(theme, 'formChoiceSelectedBorder') || accent
  const submitBg = themePaint(theme, 'submitBg') || accent
  const submitText = themePaint(theme, 'submitTextColor') || v.onAccent
  const submitBorder = themePaint(theme, 'submitBorderColor') || accent
  const defaultRadius = Number.parseInt(v.radius, 10) || 12
  const defaultButtonRadius = Number.parseInt(v.btnRadius, 10) || 12
  const submitAlign = blockButtonAlign({ buttonAlign: theme.submitAlign }, 'center')
  const submitWidth = themeNumber(theme, 'submitWidth', 0, 0, 100)
  const formContentAlign = ['center', 'right'].includes(cleanString(theme.formContentAlign)) ? cleanString(theme.formContentAlign) : 'left'
  // La columna del formulario se centra por default (igual que en el editor); solo se mueve
  // si el usuario eligió explícitamente una alineación. El texto/etiquetas sigue a formContentAlign.
  const formFieldAlign = ['left', 'center', 'right'].includes(cleanString(theme.formContentAlign)) ? cleanString(theme.formContentAlign) : 'center'
  const formPageMargins = marginForAlign(formFieldAlign)

  return {
    ...(formSurface ? { '--rstk-form-surface': formSurface } : {}),
    '--rstk-form-font': formFont,
    '--rstk-form-label-size': themeNumber(theme, 'formLabelSize', 15, 11, 28) + 'px',
    '--rstk-form-input-size': themeNumber(theme, 'formInputSize', 16, 11, 28) + 'px',
    '--rstk-form-help-size': themeNumber(theme, 'formHelpSize', 14, 10, 24) + 'px',
    '--rstk-form-weight': theme.formFontWeight === 'bold' ? '700' : theme.formFontWeight === 'normal' ? '400' : '500',
    '--rstk-form-font-style': theme.formFontStyle === 'italic' ? 'italic' : 'normal',
    '--rstk-form-text-decoration': theme.formTextDecoration === 'underline' ? 'underline' : 'none',
    '--rstk-form-label-color': paintFallbackColor(formLabel, ink),
    '--rstk-form-help-color': paintFallbackColor(formHelp, muted),
    '--rstk-form-field-bg': formFieldBg,
    '--rstk-form-field-text': paintFallbackColor(formFieldText, v.inputInk),
    '--rstk-form-field-border': paintFallbackColor(formFieldBorder, v.inputBorder),
    '--rstk-form-placeholder': paintFallbackColor(formPlaceholder, muted),
    '--rstk-form-field-radius': themeNumber(theme, 'formFieldRadius', defaultRadius, 0, 36) + 'px',
    '--rstk-form-field-border-width': themeNumber(theme, 'formFieldBorderWidth', 1, 0, 8) + 'px',
    '--rstk-form-field-height': themeNumber(theme, 'formFieldHeight', 50, 34, 96) + 'px',
    '--rstk-form-field-pad-x': themeNumber(theme, 'formFieldPaddingX', 14, 6, 48) + 'px',
    '--rstk-form-field-pad-y': themeNumber(theme, 'formFieldPaddingY', 13, 6, 36) + 'px',
    '--rstk-form-field-width': themeNumber(theme, 'formFieldWidth', 560, 120, 2000) + 'px',
    '--rstk-form-content-align': formContentAlign,
    '--rstk-form-field-justify': justifyForAlign(formFieldAlign),
    '--rstk-form-page-margin-left': formPageMargins.left,
    '--rstk-form-page-margin-right': formPageMargins.right,
    '--rstk-form-choice-selected-bg': choiceSelectedBg,
    '--rstk-form-choice-selected-border': paintFallbackColor(choiceSelectedBorder, accent),
    // Fix deliberado (form-fields #2): el rojo de error/required se define aquí
    // para que la cadena var(--rstk-form-error, var(--neg, var(--rstk-accent)))
    // resuelva IGUAL en editor y público (antes el editor heredaba el --neg del CRM
    // y el público caía al accent del sitio).
    '--rstk-form-error': '#dc2626',
    '--rstk-submit-bg': submitBg,
    '--rstk-submit-text': paintFallbackColor(submitText, v.onAccent),
    '--rstk-submit-border': paintFallbackColor(submitBorder, accent),
    '--rstk-submit-radius': themeNumber(theme, 'submitRadius', defaultButtonRadius, 0, 80) + 'px',
    '--rstk-submit-height': themeNumber(theme, 'submitHeight', 50, 34, 96) + 'px',
    '--rstk-submit-pad-x': themeNumber(theme, 'submitPaddingX', 22, 8, 72) + 'px',
    '--rstk-submit-pad-y': themeNumber(theme, 'submitPaddingY', 9, 6, 36) + 'px',
    '--rstk-submit-size': themeNumber(theme, 'submitFontSize', 16, 11, 32) + 'px',
    '--rstk-submit-border-width': themeNumber(theme, 'submitBorderWidth', 1, 0, 8) + 'px',
    '--rstk-submit-justify': justifyForAlign(submitAlign),
    '--rstk-submit-width': submitAlign === 'full' ? '100%' : submitWidth > 0 ? submitWidth + '%' : 'fit-content'
  }
}

function serializeCssVars(map, separator = ';') {
  return Object.entries(map || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => name + ':' + value)
    .join(separator)
}

// Estado de render de la página: LA función que consumen renderPublicSiteHtml y
// el canvas del editor. Reproduce el cálculo público histórico (geometría,
// fondo, textPaint, overrides, clases de body y variables) con el contrato de
// explicitud raw-vs-merged descrito arriba.
function computeSitePageRenderState(site = {}) {
  const sourceTheme = (site && site.theme) || {}
  const theme = { ...DEFAULT_THEME, ...sourceTheme }
  const template = resolveTemplate(site)
  const isLandingType = site.siteType === 'landing_page'
  const isInteractive = site.siteType === 'interactive_form'

  // 1160 era el ancho default histórico de landings; se remapea al default actual.
  const storedPageMaxWidth = Number(theme.pageMaxWidth)
  const pageMaxWidth = isLandingType && storedPageMaxWidth === 1160
    ? 1440
    : themeNumber(theme, 'pageMaxWidth', isLandingType ? 1440 : (template.id === 'interactive' ? 600 : 520), 240, 3000)
  const pagePadding = themeNumber(theme, 'pagePadding', isLandingType ? 36 : 22, 0, 600)
  const pageRadius = themeNumber(theme, 'pageRadius', isLandingType ? 0 : 24, 0, 400)
  const pageBorderWidth = themeNumber(theme, 'pageBorderWidth', 0, 0, FORM_PAGE_BORDER_WIDTH_MAX)
  const pageBorderPaint = themePaint(theme, 'pageBorderColor')
  const pageBorder = pageBorderPaint ? paintFallbackColor(pageBorderPaint, 'transparent') : 'transparent'

  const backgroundMediaType = cleanString(theme.backgroundMediaType) === 'video' ? 'video' : 'image'
  const rawBackgroundPaint = normalizeCssPaint(theme.backgroundColor, '')
  // Explicitud desde el theme CRUDO: un backgroundColor ausente NO cuenta como
  // blanco elegido por el usuario (theme-vars #1).
  const hasExplicitBackgroundColor = typeof sourceTheme.backgroundColor === 'string' && sourceTheme.backgroundColor.trim() !== ''
  const backgroundPaint = rawBackgroundPaint && (hasExplicitBackgroundColor || rawBackgroundPaint.toLowerCase() !== String(DEFAULT_THEME.backgroundColor).toLowerCase()) ? rawBackgroundPaint : ''

  const renderOverrides = resolveRenderOverrides(template, theme, isLandingType, { hasExplicitBackgroundColor })
  const v = { ...template.vars, ...(renderOverrides.vars || {}) }
  const accent = renderOverrides.accent || v.accent
  const accentStrong = renderOverrides.accent ? 'color-mix(in srgb, ' + renderOverrides.accent + ' 86%, #000)' : v.accentStrong
  const ring = renderOverrides.accent ? 'color-mix(in srgb, ' + renderOverrides.accent + ' 22%, transparent)' : v.ring

  const bodyFont = sanitizeCssFont(theme.siteBodyFontFamily) || template.font
  const siteTitleFont = sanitizeCssFont(theme.siteHeadingFontFamily)
  const siteSubtitleFont = sanitizeCssFont(theme.siteSubheadingFontFamily)
  const baseFont = bodyFont
  const display = "'Inter Tight', " + bodyFont

  const pageImage = backgroundMediaType === 'video' ? 'none' : (cssImageUrl(theme.backgroundImage) || v.pageImage)
  const pageVideo = backgroundMediaType === 'video' ? cssMediaUrl(theme.backgroundImage) : ''
  const pageOverlay = backgroundPaint ? paintLayer(backgroundPaint) : 'none'
  const userPageBg = backgroundPaint && isCssColor(backgroundPaint) ? normalizeCssColor(backgroundPaint, '') : ''
  const pageBg = userPageBg || v.pageBg

  // textColor: valor desde el theme crudo (igual que el público histórico); la
  // marca textColorCustom fuerza el paint aunque coincida con el default.
  const rawTextPaint = normalizeCssPaint(sourceTheme.textColor, '')
  const textPaint = rawTextPaint && (sourceTheme.textColorCustom || rawTextPaint.toLowerCase() !== String(DEFAULT_THEME.textColor).toLowerCase()) ? rawTextPaint : ''
  const ink = textPaint ? readableTextOnBackground(textPaint, pageBg, v.ink) : v.ink
  const muted = textPaint && isCssColor(textPaint) ? 'color-mix(in srgb, ' + ink + ' 60%, ' + pageBg + ')' : v.muted

  const formVars = buildFormThemeStyleVars(theme, { baseFont, v, accent, ink, muted })

  const vars = {
    '--rstk-color-scheme': template.mode,
    '--rstk-font': baseFont,
    '--rstk-display': display,
    ...(siteTitleFont ? { '--rstk-site-title-font': siteTitleFont } : {}),
    ...(siteSubtitleFont ? { '--rstk-site-subtitle-font': siteSubtitleFont } : {}),
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
    '--rstk-muted': muted,
    ...(textPaint && isCssGradient(textPaint) ? { '--rstk-page-text-paint': textPaint } : {}),
    '--rstk-surface': v.surface,
    '--rstk-surface2': v.surface2,
    '--rstk-border': v.border,
    '--rstk-accent': accent,
    '--rstk-accent-strong': accentStrong,
    '--rstk-on-accent': v.onAccent,
    '--rstk-ring': ring,
    '--rstk-input-bg': v.inputBg,
    '--rstk-input-ink': v.inputInk,
    '--rstk-input-border': v.inputBorder,
    '--rstk-radius': v.radius,
    '--rstk-radius-lg': v.radiusLg,
    '--rstk-shadow': v.shadow,
    '--rstk-heading-weight': v.headingWeight,
    '--rstk-btn-radius': v.btnRadius,
    '--rstk-btn-weight': v.btnWeight,
    '--rstk-max': pageMaxWidth + 'px',
    '--rstk-frame-pad': pagePadding + 'px',
    '--rstk-page-border': pageBorder,
    '--rstk-page-border-width': pageBorderWidth + 'px',
    '--rstk-page-radius': pageRadius + 'px',
    '--rstk-pad': 'clamp(18px,4vw,30px)',
    '--rstk-gap': 'clamp(16px,3vw,22px)',
    ...formVars,
    ...(template.gradient ? { '--rstk-gradient': template.gradient } : {}),
    ...(template.cyan ? { '--rstk-cyan': template.cyan } : {})
  }

  const bodyClassList = [
    'rstk-tpl-' + template.id,
    'rstk-' + template.mode,
    'rstk-kind-' + (isLandingType ? 'landing' : 'form'),
    template.centered ? 'rstk-centered' : '',
    textPaint && isCssGradient(textPaint) ? 'rstkPageTextGradient' : '',
    isInteractive ? 'rstk-interactive' : '',
    'rstk-choice-' + normalizeFormChoiceStyle(theme.formChoiceStyle),
    'rstk-select-' + normalizeFormSelectStyle(theme.formSelectStyle),
    'rstk-input-' + normalizeFormInputStyle(theme.formInputStyle)
  ].filter(Boolean)

  // Oscuridad efectiva: manda el fondo RESUELTO (usuario > paleta derivada >
  // template); si no es un color sólido (gradiente), decide el modo del template.
  const siteIsDark = isCssColor(pageBg) ? relLuminance(pageBg) < 0.5 : template.mode === 'dark'

  return {
    template,
    theme,
    sourceTheme,
    vars,
    bodyClassList,
    pageMaxWidth,
    pagePadding,
    pageRadius,
    pageBorder,
    pageBorderWidth,
    pageBg,
    userPageBg,
    pageImage,
    pageVideo,
    pageOverlay,
    backgroundPaint,
    textPaint,
    ink,
    muted,
    accent,
    accentStrong,
    ring,
    baseFont,
    renderOverrides,
    renderVars: v,
    siteIsDark,
    hasExplicitBackgroundColor,
    isLandingType,
    isInteractive
  }
}

// Hoja de estilos pública completa: :root con TODAS las variables del estado +
// color-scheme (fix deliberado theme-vars #3) + CSS base + extras del template.
function buildStyleSheet(state) {
  return '\n\t  :root{\n    ' + serializeCssVars(state.vars, ';\n    ') + ';\n    color-scheme:' + state.template.mode + ';\n  }\n  ' + RSTK_BASE_CSS + '\n  ' + (RSTK_TEMPLATE_EXTRAS[state.template.id] || '') + '\n  '
}

// Cadena de merge del theme de un formulario embebido (misma receta que el
// renderPublicBlock form_embed histórico). sourceTheme es la cadena CRUDA (sin
// DEFAULT_THEME): de ahí sale la explicitud del frame embebido.
function buildEmbeddedFormTheme({ hostTheme, sourceFormTheme, embeddedThemeOverride, isImportedForm } = {}) {
  const sourceTheme = {
    ...(hostTheme || {}),
    ...(isImportedForm ? {} : EMBEDDED_FORM_DEFAULT_THEME),
    ...(sourceFormTheme || {}),
    ...(embeddedThemeOverride || {})
  }
  return { theme: { ...DEFAULT_THEME, ...sourceTheme }, sourceTheme }
}

// Defaults del popup según el modo del sitio (fix deliberado embeds #11: el
// público adopta los defaults conscientes de tema que ya usaba el editor).
function popupSurfaceDefaults(siteIsDark) {
  return siteIsDark
    ? { background: '#0f172a', color: '#f8fafc' }
    : { background: '#ffffff', color: '#111827' }
}

// Shell del popup del sitio. Los valores configurables viajan como variables
// --rstk-popup-* (el emisor las setea inline) para que esta hoja sea estática y
// compartible con el canvas del editor.
const RSTK_POPUP_CSS = `
  .rstk-site-popup[hidden]{display:none!important}
  .rstk-site-popup{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:22px;background:var(--rstk-popup-backdrop,rgba(2, 6, 23, 0.62));backdrop-filter:blur(8px)}
  .rstk-site-popup__box{position:relative;width:min(var(--rstk-popup-max-width,560px),100%);border:var(--rstk-popup-border-width,1px) solid var(--rstk-popup-border-color,rgba(148, 163, 184, 0.32));border-radius:var(--rstk-popup-radius,18px);background:var(--rstk-popup-bg,#ffffff);color:var(--rstk-popup-text,#111827);box-shadow:0 28px 80px -34px rgba(2,6,23,.9);padding:var(--rstk-popup-padding,24px)}
  .rstk-site-popup__content{display:grid;gap:14px}
  .rstk-site-popup__content:empty{min-height:96px}
  .rstk-site-popup h2{margin:0;color:inherit;font:800 1.35rem/1.15 "Inter",Arial,sans-serif;letter-spacing:0}
  .rstk-site-popup p{margin:12px 0 0;color:inherit;opacity:.78;font:500 .96rem/1.55 "Inter",Arial,sans-serif}
  .rstk-site-popup__close{position:absolute;top:12px;right:auto;left:12px;min-width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid rgba(148,163,184,.24);border-radius:10px;background:rgba(255,255,255,.08);color:inherit;padding:0 10px;font:800 14px/1 "Inter",Arial,sans-serif;cursor:pointer}
  .rstk-site-popup__close span{font-size:22px;line-height:1}
  .rstk-site-popup__close strong{font-size:12px;line-height:1}
  .rstk-site-popup__action{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:18px;border:0;border-radius:10px;background:#3b82f6;color:#fff;padding:0 18px;font:800 .92rem/1 "Inter",Arial,sans-serif;text-decoration:none;cursor:pointer}
`

// ---------------------------------------------------------------------------
// Contrato de bloques (Paquete C): variables --rstk-block-*/--rstk-button-*/...,
// clases del wrapper .rstk-block-style y helpers puros por-bloque. Una sola
// copia consumida por renderBlockStyleVars/renderBlockStyleClassName (backend)
// y getBlockCanvasStyle/getBlockStyleClassName (editor). Semántica canónica: la
// del renderer público histórico (content-blocks #10/#11: números no finitos se
// OMITEN, posiciones de fondo se sanitizan, paint sin fallback '#ffffff').
// ---------------------------------------------------------------------------

const FIELD_BLOCK_TYPES = new Set([
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

const EMBED_MIN_HEIGHT = 180
const EMBED_MAX_HEIGHT = 5000
const CALENDAR_EMBED_DEFAULT_HEIGHT = 760

const SOCIAL_PROFILE_SCALE_MIN = 80
const SOCIAL_PROFILE_SCALE_MAX = 150
const DEFAULT_SOCIAL_PROFILE_SCALE = 110

const SOCIAL_TEMPLATE_IDS = new Set(['facebook', 'instagram', 'tiktok'])

const DEFAULT_VIDEO_PLAYER_BACKGROUND = '#000000'
const DEFAULT_VIDEO_TRANSPARENT = 'rgba(255, 255, 255, 0)'
const DEFAULT_VIDEO_BORDER_FALLBACK = 'var(--rstk-border)'
const VIDEO_ORIENTATIONS = new Set(['auto', 'landscape', 'portrait'])
const DEFAULT_VIDEO_LANDSCAPE_ASPECT_RATIO = '16 / 9'
const DEFAULT_VIDEO_PORTRAIT_ASPECT_RATIO = '9 / 16'
const DEFAULT_VIDEO_PORTRAIT_MEDIA_WIDTH = 44

function isTransparentCssColorValue(value = '') {
  const raw = cleanString(value).toLowerCase()
  if (!raw || raw === 'transparent') return true
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return false
  const alpha = match[4] === undefined ? 1 : Number(match[4])
  return Number.isFinite(alpha) && alpha <= 0
}

function getVisibleVideoBorderColor(value = '') {
  return isTransparentCssColorValue(value) ? DEFAULT_VIDEO_BORDER_FALLBACK : value
}

function normalizeVideoOrientation(settings = {}, detectedOrientation = '') {
  const requested = cleanString(settings.videoOrientation)
  if (requested === 'portrait' || requested === 'landscape') return requested
  if (VIDEO_ORIENTATIONS.has(requested) && detectedOrientation) return detectedOrientation
  return detectedOrientation || 'landscape'
}

function getVideoAspectRatio(orientation) {
  return orientation === 'portrait' ? DEFAULT_VIDEO_PORTRAIT_ASPECT_RATIO : DEFAULT_VIDEO_LANDSCAPE_ASPECT_RATIO
}

function shouldUseDefaultPortraitMediaWidth(settings = {}, orientation = '') {
  const mediaWidth = Number(settings.mediaWidth)
  return orientation === 'portrait' && !Number.isFinite(mediaWidth)
}

// Marco de video en iframe (YouTube/Vimeo/Loom/Wistia) — content-blocks #1.
// Devuelve el MAPA de variables crudo; cada lado lo serializa a su manera.
function buildVideoFrameStyleVars(settings = {}, detectedOrientation = '') {
  const orientation = normalizeVideoOrientation(settings, detectedOrientation)
  const playerBackground = normalizeCssPaint(settings.videoPlayerBackground, DEFAULT_VIDEO_PLAYER_BACKGROUND) || DEFAULT_VIDEO_PLAYER_BACKGROUND
  const rawPlayerRadius = Number(settings.videoPlayerRadius ?? 18)
  const playerRadius = Number.isFinite(rawPlayerRadius) ? Math.min(80, Math.max(0, rawPlayerRadius)) : 18
  const rawPlayerBorderColor = normalizeCssPaint(settings.videoPlayerBorderColor, DEFAULT_VIDEO_TRANSPARENT) || DEFAULT_VIDEO_TRANSPARENT
  const playerBorderColor = getVisibleVideoBorderColor(rawPlayerBorderColor)
  const rawPlayerBorderWidth = Number(settings.videoPlayerBorderWidth ?? 0)
  const playerBorderWidth = Number.isFinite(rawPlayerBorderWidth) ? Math.min(12, Math.max(0, rawPlayerBorderWidth)) : 0

  return {
    '--rstk-video-bg': playerBackground,
    '--rstk-video-radius': `${playerRadius}px`,
    '--rstk-video-border-color': playerBorderColor,
    '--rstk-video-border-width': `${playerBorderWidth}px`,
    '--rstk-video-aspect-ratio': getVideoAspectRatio(orientation),
    ...(shouldUseDefaultPortraitMediaWidth(settings, orientation) ? { '--rstk-media-width': `${DEFAULT_VIDEO_PORTRAIT_MEDIA_WIDTH}%` } : {})
  }
}

// URLs seguras compartidas (sanitización idéntica en editor y publicado).
function safeUrl(value) {
  const raw = cleanString(value)
  if (!raw) return ''

  try {
    const parsed = new URL(raw)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function safeHref(value, fallback = '#') {
  const raw = cleanString(value)
  if (!raw) return fallback
  if (raw.startsWith('#') || raw.startsWith('/')) return raw
  return safeUrl(raw) || fallback
}

// Enlaces del header/footer panel (fuente única editor↔publicado). Un enlace
// puede apuntar a una PÁGINA real del sitio (pageId) o a una URL/ancla libre.
// - Si trae pageId y la página existe: se conserva; su label por defecto es el
//   título vivo de la página (así, renombrar la página actualiza el menú).
// - Si el pageId apunta a una página que ya NO existe: se descarta (evita
//   enlaces del menú que no llevan a ningún lado — el bug reportado).
// - Enlaces sin pageId (URL/ancla, retrocompat) se conservan tal cual.
// Devuelve [{ label, url, pageId }] ya filtrado y con label resuelto; el href
// final lo calcula cada superficie (backend: buildPageHref; editor: no navega).
function resolvePanelNavLinks(rawLinks, pages = []) {
  const list = Array.isArray(rawLinks) ? rawLinks : []
  const pageById = new Map(
    (Array.isArray(pages) ? pages : [])
      .filter(page => page && cleanString(page.id))
      .map(page => [cleanString(page.id), page])
  )

  const resolved = []
  for (const item of list) {
    let label = ''
    let url = '#'
    let pageId = ''

    if (item && typeof item === 'object') {
      label = cleanString(item.label || item.title || item.name)
      url = cleanString(item.url || item.href || '#') || '#'
      pageId = cleanString(item.pageId || item.page_id)
    } else {
      const [rawLabel, rawUrl] = cleanString(item).split('|').map(part => cleanString(part))
      label = rawLabel
      url = rawUrl || '#'
    }

    if (pageId) {
      const page = pageById.get(pageId)
      if (!page) continue // enlace a página inexistente -> se descarta
      resolved.push({ label: label || cleanString(page.title) || 'Página', url: '', pageId })
      continue
    }

    if (label) resolved.push({ label, url, pageId: '' })
  }

  return resolved
}

// Reglas nativas de campo (number/currency/date) como atributos HTML — fuente
// única editor↔publicado. Devuelve un objeto { inputmode?, min?, max?, step? }
// SOLO con las claves presentes. Retrocompat exacta: sin settings, currency
// mantiene inputmode="decimal" min="0" step="0.01", number mantiene
// inputmode="decimal", date no emite nada (idéntico al render histórico).
function getNativeFieldRulesAttributes(block = {}) {
  const settings = (block && block.settings) || {}
  const attrs = {}
  const finiteNumber = (value) => {
    // null/undefined/'' NO son 0: un setting vacío o ausente = sin regla.
    if (value === null || value === undefined || value === '') return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  if (block.blockType === 'number') {
    const min = finiteNumber(settings.numberMin)
    const max = finiteNumber(settings.numberMax)
    const step = finiteNumber(settings.numberStep)
    attrs.inputmode = 'decimal'
    if (min !== null) attrs.min = min
    if (max !== null) attrs.max = max
    if (step !== null && step > 0) attrs.step = step
  } else if (block.blockType === 'currency') {
    const min = finiteNumber(settings.currencyMin)
    const max = finiteNumber(settings.currencyMax)
    const rawDecimals = finiteNumber(settings.currencyDecimals)
    const decimals = rawDecimals !== null ? Math.min(4, Math.max(0, Math.round(rawDecimals))) : 2
    attrs.inputmode = 'decimal'
    attrs.min = min !== null ? min : 0
    if (max !== null) attrs.max = max
    attrs.step = decimals === 0 ? 1 : Number((1 / Math.pow(10, decimals)).toFixed(decimals))
  } else if (block.blockType === 'date') {
    const isIsoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    if (isIsoDate(settings.dateMin)) attrs.min = settings.dateMin.trim()
    if (isIsoDate(settings.dateMax)) attrs.max = settings.dateMax.trim()
  }

  return attrs
}

function safePublicMediaUrl(value, kind = 'image') {
  const raw = cleanString(value)
  if (!raw) return ''
  if (raw.startsWith('/')) return raw.replace(/["\\\n\r]/g, '')
  if (kind === 'image' && /^data:image\//i.test(raw)) return raw
  if (kind === 'video' && /^data:video\//i.test(raw)) return raw
  return safeUrl(raw)
}

function isSocialTemplate(value) {
  return SOCIAL_TEMPLATE_IDS.has(cleanString(value))
}

function isSupportedSocialPlatform(value) {
  return ['facebook', 'instagram', 'tiktok', 'threads'].includes(cleanString(value))
}

function normalizeSocialPlatform(value, fallback = 'facebook') {
  const platform = cleanString(value)
  return isSupportedSocialPlatform(platform) ? platform : fallback
}

// Fecha objetivo del contador (content-blocks #12): semántica UTC del editor —
// 'YYYY-MM-DD' y 'YYYY-MM-DD HH:mm' se normalizan a Z para que el primer paint
// no dependa de la zona horaria del servidor. Devuelve timestamp o null.
function parseCountdownTargetDate(value) {
  const raw = cleanString(value)
  if (!raw) return null

  let normalized = raw
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    normalized = `${raw}T00:00:00.000Z`
  } else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    const withDateSeparator = raw.replace(/\s+/, 'T')
    const withNormalizedOffset = withDateSeparator
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
      .replace(/([+-]\d{2})$/, '$1:00')
    normalized = /[zZ]$|[+-]\d{2}:\d{2}$/.test(withNormalizedOffset)
      ? withNormalizedOffset
      : `${withNormalizedOffset}Z`
  }

  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? timestamp : null
}

// countdownShowLabels (content-blocks #12): coerción booleana del editor —
// 'false'/'0' (strings) también apagan las etiquetas. Default: encendidas.
function countdownShowLabelsValue(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on', 'enabled'].includes(value.trim().toLowerCase())
  return true
}

// Wistia (content-blocks #9 / embeds #17): detector de media-id compartido.
function decodeWistiaHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function extractWistiaMediaId(value) {
  const raw = decodeWistiaHtmlEntities(String(value || '')).trim()
  if (!raw) return ''

  const patterns = [
    /(?:media-id|data-media-id)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i,
    /(?:hashedId|mediaId)\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([a-z0-9]+))/i,
    /wistia_async_([a-z0-9]+)/i,
    /fast\.wistia\.(?:com|net)\/embed\/([a-z0-9]+)\.js/i,
    /(?:fast\.)?wistia\.(?:com|net)\/embed\/iframe\/([a-z0-9]+)/i,
    /(?:fast\.)?wistia\.(?:com|net)\/embed\/medias\/([a-z0-9]+)\/swatch/i,
    /wistia\.com\/medias\/([a-z0-9]+)/i
  ]

  for (const pattern of patterns) {
    const match = raw.match(pattern)
    const mediaId = String((match && (match[1] || match[2] || match[3])) || '').trim()
    if (/^[a-z0-9]+$/i.test(mediaId)) return mediaId
  }
  return ''
}

function wistiaEmbedIframeUrl(mediaId) {
  return `https://fast.wistia.net/embed/iframe/${encodeURIComponent(mediaId)}`
}

// --- Helpers de settings por bloque (semántica backend) ---

function blockSettingColor(settings, key) {
  return normalizeCssColor(settings && settings[key], '')
}

function blockSettingPaint(settings, key) {
  return normalizeCssPaint(settings && settings[key], '')
}

function blockSettingNumber(settings, key, min, max) {
  const value = Number(settings && settings[key])
  if (!Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, value))
}

function blockSettingNumberWithFallback(settings = {}, key, fallback, min, max) {
  const value = Number(settings[key])
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function blockSolidBackground(block) {
  const settings = (block && block.settings) || {}
  const blockBg = blockSettingPaint(settings, 'blockBg')
  if (!blockBg || !isCssColor(blockBg) || isTransparentCssColorValue(blockBg)) return ''
  return blockBg
}

// Fondo de contraste de página para blockText (content-blocks #8): el pageBg
// RESUELTO del estado compartido (color sólido del usuario o el del template).
// Nunca el primer stop de un gradiente ni swatches hardcodeados por template.
function blockTextContrastBackground(state) {
  return cleanString(state && state.pageBg)
}

function resolveBlockContrastBackground(block, ctx = {}) {
  return blockSolidBackground(block) ||
    blockSolidBackground(ctx.parentBlock) ||
    cleanString(ctx.pageBg)
}

// --- Spacing (padding/margen por lado + normalización legacy de landings) ---

const SPACING_SIDES = ['Top', 'Right', 'Bottom', 'Left']

function makeRenderLandingSpacing(top, bottom, right = 0, left = 0) {
  return {
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
  }
}

function getRenderLandingSpacing(blockType) {
  const spacing = {
    headline: makeRenderLandingSpacing(0, 10),
    title: makeRenderLandingSpacing(0, 10),
    subheading: makeRenderLandingSpacing(6, 14),
    subtitle: makeRenderLandingSpacing(6, 14),
    description: makeRenderLandingSpacing(6, 16),
    text: makeRenderLandingSpacing(8, 16),
    image: makeRenderLandingSpacing(16, 18),
    video: makeRenderLandingSpacing(16, 18),
    embed: makeRenderLandingSpacing(16, 18),
    calendar_embed: makeRenderLandingSpacing(48, 56),
    button: makeRenderLandingSpacing(18, 18),
    hero: makeRenderLandingSpacing(0, 0),
    benefits: makeRenderLandingSpacing(0, 0),
    testimonials: makeRenderLandingSpacing(0, 0),
    services: makeRenderLandingSpacing(0, 0),
    faq: makeRenderLandingSpacing(0, 0),
    form_embed: makeRenderLandingSpacing(0, 0),
    cta: makeRenderLandingSpacing(0, 0),
    header_panel: makeRenderLandingSpacing(0, 0),
    footer_panel: makeRenderLandingSpacing(0, 0)
  }
  return spacing[blockType] || makeRenderLandingSpacing(10, 14)
}

function isZeroSpacingValue(value) {
  if (value === undefined || value === null || value === '') return true
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric === 0
}

function isPanelBlockType(blockType) {
  return blockType === 'header_panel' || blockType === 'footer_panel'
}

function normalizeLegacyLandingBlockSettings(block) {
  const settings = (block && block.settings) || {}
  if (!block || FIELD_BLOCK_TYPES.has(block.blockType) || block.blockType === 'section' || isPanelBlockType(block.blockType)) return settings
  const top = Number(settings.blockMarginTop)
  const bottom = Number(settings.blockMarginBottom)
  const hasOldVerticalMargin = top === 50 || bottom === 50
  const hasOldFormEmbedDefaultMargin = block.blockType === 'form_embed' && top === 18 && bottom === 0
  if (!hasOldVerticalMargin && !hasOldFormEmbedDefaultMargin) return settings
  if (!isZeroSpacingValue(settings.blockMarginRight) || !isZeroSpacingValue(settings.blockMarginLeft)) return settings
  const paddingIsZero = ['blockPadding', 'blockPaddingTop', 'blockPaddingRight', 'blockPaddingBottom', 'blockPaddingLeft']
    .every(key => isZeroSpacingValue(settings[key]))
  if (!paddingIsZero) return settings
  return {
    ...settings,
    ...getRenderLandingSpacing(block.blockType)
  }
}

function hasSpacingSideValue(settings, base) {
  return SPACING_SIDES.some(side => settings && settings[`${base}${side}`] !== undefined)
}

function blockSpacingValue(settings, base, side, fallback, min, max) {
  const sideValue = blockSettingNumber(settings, `${base}${side}`, min, max)
  if (sideValue !== null) return sideValue

  const baseValue = blockSettingNumber(settings, base, min, max)
  if (baseValue !== null) return baseValue

  return fallback
}

function blockSpacingValues(settings, base, fallback, min, max) {
  if (!settings || (settings[base] === undefined && !hasSpacingSideValue(settings, base))) return null
  return SPACING_SIDES.reduce((acc, side) => {
    acc[side] = blockSpacingValue(settings, base, side, fallback, min, max)
    return acc
  }, {})
}

function spacingValuesToCss(values) {
  return SPACING_SIDES.map(side => `${values[side]}px`).join(' ')
}

function positiveSpacingValues(values) {
  return SPACING_SIDES.reduce((acc, side) => {
    acc[side] = Math.max(0, values[side])
    return acc
  }, {})
}

function negativeSpacingValues(values) {
  return SPACING_SIDES.reduce((acc, side) => {
    acc[side] = Math.min(0, values[side])
    return acc
  }, {})
}

function hasNegativeSpacing(values) {
  return values && SPACING_SIDES.some(side => values[side] < 0)
}

function combineSpacingValues(first, second) {
  return SPACING_SIDES.reduce((acc, side) => {
    acc[side] = (first && first[side] ? first[side] : 0) + (second && second[side] ? second[side] : 0)
    return acc
  }, {})
}

// --- Texto / alineación por bloque ---

function blockHorizontalAlign(settings, key, fallback = 'left') {
  const value = cleanString(settings && settings[key])
  return ['left', 'center', 'right', 'justify'].includes(value) ? value : fallback
}

function blockTextDecoration(value) {
  const tokens = cleanString(value).split(/\s+/).filter(token => token === 'underline' || token === 'line-through')
  return [...new Set(tokens)].join(' ')
}

function blockTextTransform(value) {
  const normalized = cleanString(value)
  return normalized === 'uppercase' || normalized === 'capitalize' ? normalized : ''
}

function blockTextListStyle(value) {
  const normalized = cleanString(value)
  return normalized === 'disc' || normalized === 'decimal' ? normalized : ''
}

function getSectionColumns(block) {
  const value = Number(block && block.settings && (block.settings.sectionColumns ?? block.settings.columns))
  if (!Number.isFinite(value)) return 1
  return Math.min(3, Math.max(1, Math.round(value)))
}

// --- Builder canónico de variables por bloque ---
// ctx: { parentBlock, pageBg } — pageBg viene de blockTextContrastBackground(state).
// Devuelve un mapa { '--rstk-*': valor } con el MISMO orden de inserción que el
// emisor histórico del backend (el editor lo aplica inline tal cual).
function buildBlockStyleVars(block, ctx = {}) {
  if (!block) return {}
  const settings = normalizeLegacyLandingBlockSettings(block)
  const vars = {}
  const textContrastBackground = resolveBlockContrastBackground(block, ctx)
  const blockBg = blockSettingPaint(settings, 'blockBg')
  const blockText = blockSettingPaint(settings, 'blockText')
  const blockBorder = blockSettingPaint(settings, 'blockBorderColor')
  const buttonBg = blockSettingPaint(settings, 'buttonBg')
  const buttonText = blockSettingPaint(settings, 'buttonTextColor')
  const buttonBorder = blockSettingPaint(settings, 'buttonBorderColor')
  const cardBg = blockSettingPaint(settings, 'cardBg')
  const cardBorder = blockSettingPaint(settings, 'cardBorderColor')
  const countdownNumberColor = blockSettingPaint(settings, 'countdownNumberColor')
  const countdownUnitBg = blockSettingPaint(settings, 'countdownUnitBg')
  const countdownUnitBorder = blockSettingPaint(settings, 'countdownUnitBorder')
  const fieldBg = blockSettingPaint(settings, 'fieldBg')
  const fieldBorder = blockSettingPaint(settings, 'fieldBorder')
  const fontFamily = normalizeSiteFontFamily(settings.fontFamily)
  const buttonFontFamily = normalizeSiteFontFamily(settings.buttonFontFamily)
  const textStrokeColor = blockSettingPaint(settings, 'textStrokeColor')
  const blockBackgroundImage = cleanString(settings.blockBackgroundImage)
  const fontSize = blockSettingNumber(settings, 'fontSize', 12, 96)
  const textStrokeWidth = blockSettingNumber(settings, 'textStrokeWidth', 0, 12)
  const contentMaxWidth = blockSettingNumber(settings, 'contentMaxWidth', 10, 120)
  const blockPaddingValues = blockSpacingValues(settings, 'blockPadding', 0, -400, 600)
  const blockMarginValues = blockSpacingValues(settings, 'blockMargin', 0, -400, 800)
  const blockPadding = blockPaddingValues ? spacingValuesToCss(positiveSpacingValues(blockPaddingValues)) : ''
  const blockMargin = blockMarginValues || hasNegativeSpacing(blockPaddingValues)
    ? spacingValuesToCss(combineSpacingValues(blockMarginValues, blockPaddingValues ? negativeSpacingValues(blockPaddingValues) : null))
    : ''
  const blockRadius = blockSettingNumber(settings, 'blockRadius', 0, 400)
  const blockBorderWidth = blockSettingNumber(settings, 'blockBorderWidth', 0, 80)
  const buttonRadius = blockSettingNumber(settings, 'buttonRadius', 0, 80)
  const buttonHeight = blockSettingNumber(settings, 'buttonHeight', 34, 88)
  const buttonPaddingX = blockSettingNumber(settings, 'buttonPaddingX', 8, 72)
  const buttonPaddingY = blockSettingNumber(settings, 'buttonPaddingY', 0, 40)
  const buttonFontSize = blockSettingNumber(settings, 'buttonFontSize', 11, 32)
  const buttonBorderWidth = blockSettingNumber(settings, 'buttonBorderWidth', 0, 8)
  const lineHeight = blockSettingNumber(settings, 'lineHeight', 0.8, 2.6)
  const buttonLineHeight = blockSettingNumber(settings, 'buttonLineHeight', 0.8, 2.6)
  const textDecoration = blockTextDecoration(settings.textDecoration)
  const buttonTextDecoration = blockTextDecoration(settings.buttonTextDecoration)
  const textTransform = blockTextTransform(settings.textTransform)
  const buttonTextTransform = blockTextTransform(settings.buttonTextTransform)
  const textListStyle = blockTextListStyle(settings.textListStyle)
  const mediaWidth = blockSettingNumber(settings, 'mediaWidth', 30, 100)
  const mediaRadius = blockSettingNumber(settings, 'mediaRadius', 0, 48)
  const embedHeight = blockSettingNumber(settings, 'embedHeight', EMBED_MIN_HEIGHT, EMBED_MAX_HEIGHT)
  const cardRadius = blockSettingNumber(settings, 'cardRadius', 0, 48)
  const cardBorderWidth = blockSettingNumber(settings, 'cardBorderWidth', 0, 8)
  const listColumns = blockSettingNumber(settings, 'listColumns', 1, 4)
  const fieldWidth = blockSettingNumber(settings, 'fieldWidth', 5, 100)
  const fieldRadius = blockSettingNumber(settings, 'fieldRadius', 0, 32)
  const countdownNumberSize = blockSettingNumber(settings, 'countdownNumberSize', 14, 96)
  const countdownUnitRadius = blockSettingNumber(settings, 'countdownUnitRadius', 0, 48)
  const countdownUnitGap = blockSettingNumber(settings, 'countdownUnitGap', 0, 48)
  const sectionGap = blockSettingNumber(settings, 'sectionGap', 0, 400)
  const blockHasNativeBorder = ['hero', 'section', 'cta', 'benefits', 'testimonials', 'services', 'faq', 'form_embed', 'image', 'video', 'countdown', 'embed', 'calendar_embed', 'payment'].includes(block.blockType)
  const supportsButton = ['hero', 'button', 'cta', 'form_embed', 'payment'].includes(block.blockType)
  const isCalendarEmbed = block.blockType === 'calendar_embed'

  if (!isCalendarEmbed && blockBg) {
    vars['--rstk-block-bg'] = blockBg
    vars['--rstk-block-bg-layer'] = paintLayer(blockBg)
    vars['--rstk-block-bg-color'] = isCssGradient(blockBg) ? 'transparent' : blockBg
  }
  if (!isCalendarEmbed && blockBackgroundImage && cleanString(settings.blockBackgroundMediaType) !== 'video') {
    const imageLayer = cssImageUrl(blockBackgroundImage)
    if (imageLayer) {
      vars['--rstk-block-bg-image'] = imageLayer
      vars['--rstk-block-bg-size'] = backgroundFitValue(settings.blockBackgroundFit)
      vars['--rstk-block-bg-position'] = backgroundPositionValue(settings.blockBackgroundPosition)
    }
  }
  if (blockText) {
    // Títulos / texto grande: umbral de contraste 3.0 (WCAG AA large text) en vez de
    // 4.5, para no voltear colores legibles que el usuario eligió a propósito.
    const isLargeText = LARGE_TEXT_BLOCK_TYPES.has(block.blockType) || (Number.isFinite(fontSize) && fontSize >= 24)
    const textMinRatio = isLargeText ? MIN_LARGE_TEXT_CONTRAST_RATIO : MIN_TEXT_CONTRAST_RATIO
    vars['--rstk-block-text'] = readableTextOnBackground(blockText, textContrastBackground, '#111827', textMinRatio)
    if (isCssGradient(blockText)) vars['--rstk-block-text-paint'] = blockText
  }
  if (!isCalendarEmbed && blockBorder) vars['--rstk-block-border'] = paintFallbackColor(blockBorder, '#dbe3ef')
  const buttonHoverBg = blockSettingPaint(settings, 'buttonHoverBg')
  if (buttonBg) {
    vars['--rstk-button-bg'] = buttonBg
    vars['--rstk-button-hover-bg'] = buttonHoverBg || buttonBg
  } else if (buttonHoverBg) {
    vars['--rstk-button-hover-bg'] = buttonHoverBg
  }
  if (buttonText) {
    vars['--rstk-button-text'] = paintFallbackColor(buttonText, '#ffffff')
    if (isCssGradient(buttonText)) vars['--rstk-button-text-paint'] = buttonText
  }
  if (buttonBorder) vars['--rstk-button-border'] = paintFallbackColor(buttonBorder, '#111827')
  const buttonShadowPreset = cleanString(settings.buttonShadow)
  if (buttonShadowPreset === 'soft') vars['--rstk-button-shadow'] = '0 4px 12px color-mix(in srgb,var(--rstk-ink) 14%,transparent)'
  if (buttonShadowPreset === 'medium') vars['--rstk-button-shadow'] = '0 8px 22px color-mix(in srgb,var(--rstk-ink) 20%,transparent)'
  if (buttonShadowPreset === 'strong') vars['--rstk-button-shadow'] = '0 14px 34px color-mix(in srgb,var(--rstk-ink) 28%,transparent)'
  if (cardBg) vars['--rstk-card-bg'] = cardBg
  if (cardBorder) vars['--rstk-card-border'] = paintFallbackColor(cardBorder, '#dbe3ef')
  if (countdownNumberColor) vars['--rstk-countdown-number'] = paintFallbackColor(countdownNumberColor, '#111827')
  if (countdownUnitBg) vars['--rstk-countdown-unit-bg'] = countdownUnitBg
  if (countdownUnitBorder) vars['--rstk-countdown-unit-border'] = paintFallbackColor(countdownUnitBorder, '#dbe3ef')
  if (fieldBg) vars['--rstk-field-bg'] = fieldBg
  if (fieldBorder) vars['--rstk-field-border'] = paintFallbackColor(fieldBorder, '#dbe3ef')
  if (fontFamily) vars['--rstk-block-font'] = fontFamily
  if (buttonFontFamily) vars['--rstk-button-font'] = buttonFontFamily
  if (settings.fontStyle === 'italic') vars['--rstk-block-font-style'] = 'italic'
  if (textDecoration) vars['--rstk-block-text-decoration'] = textDecoration
  if (textTransform) vars['--rstk-block-text-transform'] = textTransform
  if (textListStyle && block.blockType === 'text') vars['--rstk-text-list-style'] = textListStyle
  if (cleanString(settings.lineHeight) && lineHeight !== null) vars['--rstk-block-line-height'] = String(lineHeight)
  if (textStrokeWidth !== null) vars['--rstk-text-stroke-width'] = `${textStrokeWidth}px`
  if (textStrokeColor) vars['--rstk-text-stroke-color'] = paintFallbackColor(textStrokeColor, '#111827')
  if (settings.fontWeight === 'bold') vars['--rstk-block-weight'] = '850'
  if (settings.fontWeight === 'normal') vars['--rstk-block-weight'] = '400'
  if (block.blockType === 'social_profile') {
    const profileScale = blockSettingNumberWithFallback(settings, 'socialProfileScale', DEFAULT_SOCIAL_PROFILE_SCALE, SOCIAL_PROFILE_SCALE_MIN, SOCIAL_PROFILE_SCALE_MAX) / 100
    const socialFontSize = blockSettingNumberWithFallback(settings, 'fontSize', 18, 12, 96)
    const socialPx = (value) => `${Number(value.toFixed(3))}px`

    vars['--rstk-social-profile-scale'] = String(Number(profileScale.toFixed(3)))
    vars['--rstk-social-avatar-size'] = socialPx(64 * profileScale)
    vars['--rstk-social-avatar-font-size'] = socialPx(20 * profileScale)
    vars['--rstk-social-badge-size'] = socialPx(23 * profileScale)
    vars['--rstk-social-badge-icon-size'] = socialPx(13 * profileScale)
    vars['--rstk-social-gap'] = socialPx(11 * profileScale)
    vars['--rstk-social-name-size'] = socialPx(socialFontSize * profileScale)
    vars['--rstk-social-followers-size'] = socialPx(Math.max(11, socialFontSize * profileScale * 0.82))
    vars['--rstk-social-verified-size'] = socialPx(16.5 * profileScale)
    // El ancho del chip lo dan las reglas CSS (.rstkSocialProfileBlock /
    // .rstk-embedded-form > .rstkSocialProfileBlock), NO inline: así dentro de un
    // formulario puede seguir --rstk-form-field-justify (alinearse en su franja).
  }
  if (settings.textAlign !== undefined) {
    const align = blockHorizontalAlign(settings, 'textAlign', 'left')
    const margins = marginForAlign(align)
    vars['--rstk-block-align'] = align
    vars['--rstk-block-justify'] = justifyForAlign(align)
    vars['--rstk-content-margin-left'] = margins.left
    vars['--rstk-content-margin-right'] = margins.right
  }
  if (fontSize !== null) vars['--rstk-block-size'] = `${fontSize}px`
  if (contentMaxWidth !== null) vars['--rstk-content-max'] = `${contentMaxWidth}ch`
  if (!isCalendarEmbed && blockPadding) vars['--rstk-block-pad'] = blockPadding
  if (blockMargin) vars['--rstk-block-margin'] = blockMargin
  if (!isCalendarEmbed && blockRadius !== null) vars['--rstk-block-radius'] = `${blockRadius}px`
  if (!isCalendarEmbed && blockBorderWidth !== null) {
    vars['--rstk-block-border-width'] = `${blockBorderWidth}px`
    if (!blockHasNativeBorder) vars['--rstk-block-shell-border-width'] = `${blockBorderWidth}px`
  }
  if (supportsButton) {
    const align = blockButtonAlign(settings, 'center')
    const margins = marginForAlign(align)
    const buttonWidth = blockSettingNumber(settings, 'buttonWidth', 0, 100)
    vars['--rstk-button-justify'] = justifyForAlign(align)
    vars['--rstk-button-margin-left'] = margins.left
    vars['--rstk-button-margin-right'] = margins.right
    vars['--rstk-button-width'] = align === 'full' ? '100%' : buttonWidth && buttonWidth > 0 ? `${buttonWidth}%` : 'fit-content'
  }
  if (buttonRadius !== null) vars['--rstk-block-button-radius'] = `${buttonRadius}px`
  if (buttonHeight !== null) vars['--rstk-button-height'] = `${buttonHeight}px`
  if (buttonPaddingX !== null) vars['--rstk-button-pad-x'] = `${buttonPaddingX}px`
  if (buttonPaddingY !== null) vars['--rstk-button-pad-y'] = `${buttonPaddingY}px`
  if (buttonFontSize !== null) vars['--rstk-button-size'] = `${buttonFontSize}px`
  if (settings.buttonSubtitleFontSize !== undefined) {
    const buttonSubtitleFontSize = blockSettingNumber(settings, 'buttonSubtitleFontSize', 10, 24)
    if (buttonSubtitleFontSize !== null) vars['--rstk-button-subtitle-size'] = `${buttonSubtitleFontSize}px`
  }
  if (buttonBorderWidth !== null) vars['--rstk-button-border-width'] = `${buttonBorderWidth}px`
  if (settings.buttonFontWeight === 'bold') vars['--rstk-button-weight'] = '850'
  if (settings.buttonFontWeight === 'normal') vars['--rstk-button-weight'] = '400'
  if (settings.buttonFontStyle === 'italic') vars['--rstk-button-font-style'] = 'italic'
  if (buttonTextDecoration) vars['--rstk-button-text-decoration'] = buttonTextDecoration
  if (buttonTextTransform) vars['--rstk-button-text-transform'] = buttonTextTransform
  if (cleanString(settings.buttonLineHeight) && buttonLineHeight !== null) vars['--rstk-button-line-height'] = String(buttonLineHeight)
  if (mediaWidth !== null) vars['--rstk-media-width'] = `${mediaWidth}%`
  if (settings.mediaAlign !== undefined) {
    const align = blockHorizontalAlign(settings, 'mediaAlign', 'center')
    const margins = marginForAlign(align)
    vars['--rstk-media-justify'] = justifyForAlign(align)
    vars['--rstk-media-margin-left'] = margins.left
    vars['--rstk-media-margin-right'] = margins.right
  }
  if (mediaRadius !== null) vars['--rstk-media-radius'] = `${mediaRadius}px`
  if (embedHeight !== null) {
    const minEmbedHeight = isCalendarEmbed ? CALENDAR_EMBED_DEFAULT_HEIGHT : EMBED_MIN_HEIGHT
    vars['--rstk-embed-height'] = `${Math.max(embedHeight, minEmbedHeight)}px`
  }
  if (isCalendarEmbed) {
    const calendarFrameBorderWidth = blockSettingNumber(settings, 'calendarFrameBorderWidth', 0, 8)
    const calendarFrameBorder = blockSettingColor(settings, 'calendarFrameBorderColor')
    if (calendarFrameBorderWidth !== null) vars['--rstk-calendar-frame-border-width'] = `${calendarFrameBorderWidth}px`
    if (calendarFrameBorder) vars['--rstk-calendar-frame-border'] = calendarFrameBorder
  }
  if (cardRadius !== null) vars['--rstk-card-radius'] = `${cardRadius}px`
  if (cardBorderWidth !== null) vars['--rstk-card-border-width'] = `${cardBorderWidth}px`
  if (listColumns !== null) vars['--rstk-list-columns'] = `repeat(${listColumns},minmax(0,1fr))`
  if (settings.cardAlign !== undefined) vars['--rstk-card-align'] = blockHorizontalAlign(settings, 'cardAlign', 'left')
  if (fieldWidth !== null) vars['--rstk-field-width'] = `${fieldWidth}%`
  if (fieldRadius !== null) vars['--rstk-field-radius'] = `${fieldRadius}px`
  if (countdownNumberSize !== null) vars['--rstk-countdown-number-size'] = `${countdownNumberSize}px`
  if (countdownUnitRadius !== null) vars['--rstk-countdown-unit-radius'] = `${countdownUnitRadius}px`
  if (countdownUnitGap !== null) vars['--rstk-countdown-gap'] = `${countdownUnitGap}px`
  if (block.blockType === 'section') {
    vars['--rstk-section-columns'] = String(getSectionColumns(block))
    if (sectionGap !== null) vars['--rstk-section-gap'] = `${sectionGap}px`
  }

  return vars
}

// --- Responsive por dispositivo (overrides por bloque) ---
//
// Modelo de datos RETROCOMPATIBLE: los valores actuales de settings son el DESKTOP
// (base). Los overrides por dispositivo viven anidados en settings.responsive:
//   settings.responsive = { tablet: { fontSize: 20 }, mobile: { fontSize: 16 } }
// Un sitio sin settings.responsive se comporta EXACTO como antes (0 migración).
// La cascada es desktop -> tablet -> mobile (cada uno hereda del anterior).
const RESPONSIVE_DEVICES = ['tablet', 'mobile']
// Breakpoints (max-width). El canvas del editor usa @container rstk-canvas con el
// mismo ancho; el sitio publicado usa @media. Mismo valor en ambos = paridad.
const RESPONSIVE_DEVICE_MAX_WIDTH = { tablet: 1024, mobile: 640 }

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// Devuelve los settings efectivos para un dispositivo aplicando la cascada
// desktop -> tablet -> mobile sobre settings.responsive. Puro y testeable.
function resolveDeviceBlockSettings(settings = {}, device = 'desktop') {
  const base = isPlainObject(settings) ? settings : {}
  if (device === 'desktop') return { ...base }
  const responsive = isPlainObject(base.responsive) ? base.responsive : {}
  const tablet = isPlainObject(responsive.tablet) ? responsive.tablet : {}
  const mobile = isPlainObject(responsive.mobile) ? responsive.mobile : {}
  if (device === 'tablet') return { ...base, ...tablet }
  // mobile hereda de tablet (que hereda de desktop)
  return { ...base, ...tablet, ...mobile }
}

// Emite el CSS de overrides responsive de UN bloque. Reutiliza buildBlockStyleVars
// (misma normalización/clamps/variables que el desktop => cero divergencia) y solo
// emite las variables que CAMBIAN respecto al desktop, dentro de la media/container
// query del dispositivo, apuntando al bloque por su data-rstk-block-id.
//   queryType 'media'     -> sitio publicado (@media)
//   queryType 'container' -> canvas del editor (@container rstk-canvas)
function buildBlockResponsiveCss(block, { queryType = 'media', containerName = 'rstk-canvas' } = {}, ctx = {}) {
  if (!block || !isPlainObject(block.settings) || !isPlainObject(block.settings.responsive)) return ''
  const blockId = cleanString(block.id)
  if (!blockId) return ''
  const baseVars = buildBlockStyleVars(block, ctx)
  const blocks = []
  for (const device of RESPONSIVE_DEVICES) {
    const overrides = block.settings.responsive[device]
    if (!isPlainObject(overrides) || !Object.keys(overrides).length) continue
    const deviceSettings = resolveDeviceBlockSettings(block.settings, device)
    const deviceVars = buildBlockStyleVars({ ...block, settings: deviceSettings }, ctx)
    const decls = []
    for (const [name, value] of Object.entries(deviceVars)) {
      if (baseVars[name] !== value) decls.push(`${name}:${value}`)
    }
    if (!decls.length) continue
    const maxWidth = RESPONSIVE_DEVICE_MAX_WIDTH[device]
    const query = queryType === 'container'
      ? `@container ${containerName} (max-width:${maxWidth}px)`
      : `@media (max-width:${maxWidth}px)`
    blocks.push(`${query}{[data-rstk-block-id="${blockId}"]{${decls.join(';')}}}`)
  }
  return blocks.join('\n')
}

// Emite el CSS responsive de TODOS los bloques de una lista (helper para el render).
function buildBlocksResponsiveCss(blocks = [], options = {}, ctx = {}) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map(block => buildBlockResponsiveCss(block, options, ctx))
    .filter(Boolean)
    .join('\n')
}

// --- Clases del wrapper de bloque ---

function blockHasExplicitBg(settings) {
  const paint = cleanString(settings.blockBg)
  if (isCssPaint(paint) && paint.toLowerCase() !== 'transparent') return true
  return Boolean(cleanString(settings.blockBackgroundImage))
}

function blockHasExplicitBorder(settings) {
  return (blockSettingNumber(settings, 'blockBorderWidth', 0, 80) || 0) > 0
}

function buildBlockStyleClassName(block) {
  const settings = (block && block.settings) || {}
  const classes = [
    'rstk-block-style',
    blockHasExplicitBg(settings) ? 'rstkBlockBgSet' : '',
    blockHasExplicitBorder(settings) ? 'rstkBlockBorderSet' : '',
    settings.blockFullWidth === true ? 'rstkBlockFullWidth' : '',
    block.blockType === 'header_panel' ? 'rstkHeaderPanelBlock' : '',
    block.blockType === 'footer_panel' ? 'rstkFooterPanelBlock' : '',
    block.blockType === 'calendar_embed' ? 'rstkCalendarBlock' : '',
    block.blockType === 'social_profile' ? 'rstkSocialProfileBlock' : '',
    cleanString(settings.blockText) ? 'rstkBlockTextOverride' : '',
    isCssGradient(settings.blockText) ? 'rstkTextGradient' : '',
    isCssGradient(settings.buttonTextColor) ? 'rstkButtonTextGradient' : '',
    settings.buttonPaddingY !== undefined ? 'rstkButtonPaddingOverride' : '',
    cleanString(settings.blockBackgroundMediaType) === 'video' && safePublicMediaUrl(settings.blockBackgroundImage, 'video') ? 'rstkHasBgVideo' : '',
    cleanString(settings.fontFamily) ? 'rstkFontOverride' : '',
    settings.fontSize !== undefined ? 'rstkSizeOverride' : '',
    settings.fontWeight === 'bold' || settings.fontWeight === 'normal' ? 'rstkWeightOverride' : '',
    settings.fontStyle === 'italic' ? 'rstkItalicOverride' : '',
    blockTextDecoration(settings.textDecoration) ? 'rstkUnderlineOverride' : '',
    blockTextTransform(settings.textTransform) ? 'rstkTextTransformOverride' : '',
    settings.lineHeight !== undefined && cleanString(settings.lineHeight) ? 'rstkLineHeightOverride' : '',
    block.blockType === 'text' && blockTextListStyle(settings.textListStyle) ? 'rstkListStyleOverride' : '',
    settings.textStrokeWidth !== undefined ? 'rstkStrokeOverride' : '',
    // Contrato form-fields #5: la clase de "ancho por campo" solo existe cuando
    // el bloque trae un fieldWidth VÁLIDO (misma condición que la variable
    // --rstk-field-width). La regla de RSTK_BASE_CSS cuelga de esta clase, así
    // el wrapper del editor sin fieldWidth ya no pisa --rstk-form-field-width.
    blockSettingNumber(settings, 'fieldWidth', 5, 100) !== null ? 'rstk-field-width-set' : ''
  ].filter(Boolean)

  return classes.join(' ')
}

// --- Predicado del wrapper (content #3 / form-fields #5) ---
// El publicado SOLO envuelve en div.rstk-block-style cuando hay variables,
// full-width, video de fondo o el bloque está oculto por el usuario (más los
// atributos runtime de acciones de video/contador, que viajan en ctx).

function blockHasBackgroundVideo(block) {
  const settings = (block && block.settings) || {}
  return cleanString(settings.blockBackgroundMediaType) === 'video' &&
    Boolean(safePublicMediaUrl(settings.blockBackgroundImage, 'video'))
}

function blockIsUserHidden(block) {
  const hidden = block && block.settings ? block.settings.hidden : undefined
  if (hidden === true || hidden === 1) return true
  if (typeof hidden === 'string') return ['1', 'true', 'yes', 'on', 'enabled'].includes(hidden.trim().toLowerCase())
  return false
}

function blockHasResponsiveOverrides(block) {
  const responsive = block?.settings?.responsive
  if (!isPlainObject(responsive)) return false
  return RESPONSIVE_DEVICES.some(device => isPlainObject(responsive[device]) && Object.keys(responsive[device]).length)
}

function blockHasStyleWrapper(block, ctx = {}) {
  if (!block) return false
  const settings = block.settings || {}
  const vars = ctx.vars || buildBlockStyleVars(block, ctx)
  return Boolean(
    Object.keys(vars).length ||
    settings.blockFullWidth === true ||
    blockHasBackgroundVideo(block) ||
    blockIsUserHidden(block) ||
    // Con overrides responsive el bloque necesita su wrapper + data-rstk-block-id
    // para que el CSS por dispositivo ([data-rstk-block-id="X"]) lo alcance.
    blockHasResponsiveOverrides(block) ||
    ctx.hasActionTarget
  )
}

// ---------------------------------------------------------------------------
// rescopeSiteCssForCanvas: transforma la hoja pública para vivir dentro del
// canvas del editor (div, no documento):
//   :root/body/html -> scope; body.CLS/body:has() -> el scope ES el body.
//   Selector que ARRANCA con clase -> DOBLE variante: `scope<compound> rest`
//     (las clases de body viven EN el scope: .rstk-kind-form, .rstk-choice-*,
//     .rstk-centered...) + `scope selector` (las mismas clases también aparecen
//     dentro del contenido, p.ej. overrides por-campo .rstk-field.rstk-choice-*).
//     Ambas ramas suman +0,1,0 uniforme: el orden de cascada interno se conserva.
//   Selector que arranca con elemento/atributo/* -> solo descendiente (+0,1,0).
//   @media (min|max-width) -> @container rstk-canvas (mismas condiciones).
//   vw -> cqw; Nvh -> var/calc sobre --rstk-vh100 (no hay viewport real).
//   @keyframes/@font-face quedan intactos; @supports/@container por dentro.
// Tokenizador propio: respeta strings, url(), comas dentro de :is()/:has() y
// at-rules anidadas. Cubre el CSS del contrato y formas futuras equivalentes.
// ---------------------------------------------------------------------------

function findCommentEnd(css, start) {
  const end = css.indexOf('*/', start + 2)
  return end === -1 ? css.length : end + 2
}

function skipString(css, start) {
  const quote = css[start]
  let i = start + 1
  while (i < css.length) {
    if (css[i] === '\\') { i += 2; continue }
    if (css[i] === quote) return i + 1
    i += 1
  }
  return css.length
}

// Busca el fin del prelude ('{' abre bloque, ';' cierra at-rule sin bloque).
function scanPreludeEnd(css, start) {
  let i = start
  let depth = 0
  while (i < css.length) {
    const ch = css[i]
    if (ch === '"' || ch === "'") { i = skipString(css, i); continue }
    if (ch === '/' && css[i + 1] === '*') { i = findCommentEnd(css, i); continue }
    if (ch === '(' || ch === '[') { depth += 1; i += 1; continue }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); i += 1; continue }
    if (depth === 0 && (ch === '{' || ch === ';')) return { index: i, char: ch }
    i += 1
  }
  return { index: css.length, char: '' }
}

function findMatchingBrace(css, openIndex) {
  let i = openIndex + 1
  let depth = 1
  while (i < css.length) {
    const ch = css[i]
    if (ch === '"' || ch === "'") { i = skipString(css, i); continue }
    if (ch === '/' && css[i + 1] === '*') { i = findCommentEnd(css, i); continue }
    if (ch === '{') { depth += 1; i += 1; continue }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
      i += 1
      continue
    }
    i += 1
  }
  return css.length
}

function splitTopLevelCommas(text) {
  const parts = []
  let current = ''
  let depth = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i)
      current += text.slice(i, end)
      i = end
      continue
    }
    if (ch === '(' || ch === '[') depth += 1
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  parts.push(current)
  return parts
}

// Corta el primer compound del selector: termina en el primer espacio o
// combinador (> + ~) de nivel superior (fuera de paréntesis/corchetes/strings).
function splitFirstCompound(sel) {
  let i = 0
  let depth = 0
  while (i < sel.length) {
    const ch = sel[i]
    if (ch === '"' || ch === "'") { i = skipString(sel, i); continue }
    if (ch === '(' || ch === '[') { depth += 1; i += 1; continue }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); i += 1; continue }
    if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '>' || ch === '+' || ch === '~')) {
      return { compound: sel.slice(0, i), rest: sel.slice(i) }
    }
    i += 1
  }
  return { compound: sel, rest: '' }
}

function rescopeSelector(selector, scope) {
  const sel = selector.trim()
  if (!sel) return sel
  if (sel === ':root') return scope
  if (/^html$/i.test(sel)) return scope
  if (/^html[\s>+~]/i.test(sel)) {
    const rest = sel.replace(/^html\s*/i, '').trim()
    return rest ? scope + ' ' + rest : scope
  }
  if (/^body$/i.test(sel)) return scope
  // body.CLS / body:has(...) / body[attr] -> el scope ES el body del canvas.
  if (/^body(?=[.:#[])/i.test(sel)) return scope + sel.slice(4)
  if (/^body[\s>+~]/i.test(sel)) {
    const rest = sel.slice(4).trim()
    const combinator = /^[>+~]/.test(rest) ? rest : ' ' + rest
    return scope + (combinator.startsWith('>') || combinator.startsWith('+') || combinator.startsWith('~') ? combinator : combinator)
  }
  // Selector encabezado por CLASE: en vivo esas clases van en el <body> (que en
  // el canvas ES el scope) y también pueden aparecer en el contenido (overrides
  // por-campo). Se emiten AMBAS ramas con +0,1,0 uniforme.
  if (sel.startsWith('.')) {
    const { compound, rest } = splitFirstCompound(sel)
    return scope + compound + rest + ',' + scope + ' ' + sel
  }
  // Prefijo uniforme (+0,1,0 para todos: conserva el orden de cascada interno).
  return scope + ' ' + sel
}

// Reescritura de unidades de viewport dentro de valores (saltando strings):
// vw -> cqw (el canvas es un container inline-size); 100vh -> var(--rstk-vh100),
// Nvh -> calc(var(--rstk-vh100) * N / 100).
function rewriteViewportUnits(text) {
  let out = ''
  let i = 0
  let run = ''
  const flush = () => {
    // El signo negativo forma parte del número (clamp(-22px,-5vw,-14px)); el
    // guard [^\w.-] evita comerse identificadores tipo --custom-prop.
    out += run
      .replace(/(^|[^\w.-])(-?(?:\d+\.?\d*|\.\d+))vw\b/g, '$1$2cqw')
      .replace(/(^|[^\w.-])(-?(?:\d+\.?\d*|\.\d+))vh\b/g, (match, prefix, num) => {
        return Number(num) === 100
          ? prefix + 'var(--rstk-vh100,100vh)'
          : prefix + 'calc(var(--rstk-vh100,100vh) * ' + num + ' / 100)'
      })
    run = ''
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      flush()
      const end = skipString(text, i)
      out += text.slice(i, end)
      i = end
      continue
    }
    run += ch
    i += 1
  }
  flush()
  return out
}

function rescopeCssText(css, scope) {
  let out = ''
  let i = 0
  const n = css.length
  while (i < n) {
    const ch = css[i]
    if (/\s/.test(ch)) { out += ch; i += 1; continue }
    if (ch === '/' && css[i + 1] === '*') {
      const end = findCommentEnd(css, i)
      out += css.slice(i, end)
      i = end
      continue
    }
    if (ch === '}') { i += 1; continue } // basura defensiva: llave suelta
    const preludeEnd = scanPreludeEnd(css, i)
    if (preludeEnd.char === ';' || preludeEnd.char === '') {
      // at-rule sin bloque (@import/@charset): se copia tal cual.
      out += css.slice(i, Math.min(preludeEnd.index + 1, n))
      i = preludeEnd.index + 1
      continue
    }
    const prelude = css.slice(i, preludeEnd.index).trim()
    const closeIndex = findMatchingBrace(css, preludeEnd.index)
    const body = css.slice(preludeEnd.index + 1, closeIndex)
    if (prelude.startsWith('@')) {
      const name = prelude.slice(1).split(/[\s(]/, 1)[0].toLowerCase()
      if (name === 'keyframes' || name === 'font-face' || name === 'property' || name.endsWith('-keyframes')) {
        out += prelude + '{' + body + '}'
      } else if (name === 'media') {
        const condition = prelude.slice(6).trim()
        // Solo condiciones de ancho se vuelven container queries; el resto de
        // @media (print, motion...) se conserva pero se rescopea por dentro.
        const widthOnly = /^\(\s*(?:max|min)-width\s*:[^)]+\)(?:\s+and\s+\(\s*(?:max|min)-width\s*:[^)]+\))*$/i.test(condition)
        const newPrelude = widthOnly ? '@container rstk-canvas ' + condition : prelude
        out += newPrelude + '{' + rescopeCssText(body, scope) + '}'
      } else {
        // @supports/@container/@layer: prelude intacto, contenido rescopeado.
        out += prelude + '{' + rescopeCssText(body, scope) + '}'
      }
    } else {
      const selectors = splitTopLevelCommas(prelude).map(part => rescopeSelector(part, scope))
      out += selectors.join(',') + '{' + rewriteViewportUnits(body) + '}'
    }
    i = closeIndex + 1
  }
  return out
}

function rescopeSiteCssForCanvas(css, { scope = '.rstkCanvas' } = {}) {
  return rescopeCssText(String(css || ''), scope)
}

// ---------------------------------------------------------------------------
// Superficies embebidas (Paquete D): variables del popup, query params del
// calendario embebido y variables proxy del gate de video. Una sola copia
// consumida por renderSitePopup/renderPublicBlock/renderVideoFormGateMarkup
// (backend) y por el canvas del editor.
// ---------------------------------------------------------------------------

// Variables --rstk-popup-* del shell del popup (mismos defaults/clamps que el
// renderSitePopup histórico). El emisor las pone inline sobre .rstk-site-popup
// y la hoja estática RSTK_POPUP_CSS las consume. Mismo orden histórico: el
// backend serializa este mapa directo al atributo style.
function buildPopupSurfaceVars(theme = {}, siteIsDark = false) {
  const surfaceDefaults = popupSurfaceDefaults(siteIsDark)
  return {
    '--rstk-popup-backdrop': normalizeCssPaint(theme.popupBackdropColor ?? theme.popup_backdrop_color, 'rgba(2, 6, 23, 0.62)'),
    '--rstk-popup-max-width': themeNumber(theme, 'popupMaxWidth', 560, 320, 960) + 'px',
    '--rstk-popup-border-width': themeNumber(theme, 'popupBorderWidth', 1, 0, 12) + 'px',
    '--rstk-popup-border-color': normalizeCssPaint(theme.popupBorderColor ?? theme.popup_border_color, 'rgba(148, 163, 184, 0.32)'),
    '--rstk-popup-radius': themeNumber(theme, 'popupRadius', 18, 0, 60) + 'px',
    '--rstk-popup-bg': normalizeCssPaint(theme.popupBackgroundColor ?? theme.popup_background_color, surfaceDefaults.background),
    '--rstk-popup-text': normalizeCssPaint(theme.popupTextColor ?? theme.popup_text_color, surfaceDefaults.color),
    '--rstk-popup-padding': themeNumber(theme, 'popupPadding', 24, 0, 96) + 'px'
  }
}

// calendar_embed: estilo reenviable al widget real vía query params (mismas
// llaves que "Estilos y diseños" del calendario). Solo se reenvía un color/
// número cuando el bloque lo DEFINE; sin definir, el widget resuelve desde su
// propia paleta (embeds #9 documenta esa semántica como contrato).
const CALENDAR_EMBED_COLOR_QUERY_SETTINGS = [
  ['calendarAccentColor', 'accent'],
  ['calendarTextColor', 'text'],
  ['calendarMutedColor', 'muted'],
  ['calendarLineColor', 'line'],
  ['calendarControlBg', 'controlBg'],
  ['calendarSlotBg', 'slotBg'],
  ['calendarSlotText', 'slotText'],
  ['calendarSelectedText', 'selectedText'],
  ['calendarFieldBg', 'fieldBg'],
  ['calendarFieldText', 'fieldText'],
  ['calendarFieldBorder', 'fieldBorder'],
  ['calendarButtonText', 'buttonText']
]

const CALENDAR_EMBED_NUMBER_QUERY_SETTINGS = [
  ['calendarSlotRadius', 'slotRadius', 0, 32],
  ['calendarFieldRadius', 'fieldRadius', 0, 32]
]

// Toggles de "qué se muestra". En modo "Personalizar para sitio" el bloque
// controla la visibilidad por completo: se reenvían SIEMPRE (ON por defecto).
const CALENDAR_EMBED_TOGGLE_QUERY_SETTINGS = [
  ['calendarShowSidebar', 'showSidebar'],
  ['calendarShowIcon', 'showIcon'],
  ['calendarShowEventTitle', 'showEventTitle'],
  ['calendarShowCalendarName', 'showCalendarName'],
  ['calendarShowDescription', 'showDescription'],
  ['calendarShowDuration', 'showDuration'],
  ['calendarShowConfirmation', 'showConfirmation'],
  ['calendarAllowTimezoneSelection', 'allowTimezoneSelection']
]

// Un toggle está "encendido" salvo que su valor sea explícitamente falso.
function isCalendarToggleOff(value) {
  return value === false || value === 'false' || value === 0 || value === '0' || value === 'no' || value === 'off'
}

// El bloque de calendario ya no ofrece selector de layout: siempre clásico.
// Se ignora cualquier valor antiguo guardado (compact/stacked).
function calendarEmbedLayoutValue() {
  return 'classic'
}

// Construye la URL del calendario embebido con los MISMOS parámetros en el
// publicado (/calendar/:slug) y en el canvas (/api/sites/public/calendar-preview/:slug).
// options.metaCalEvent / options.metaCalData llegan YA resueltos (el override
// Meta del sitio lo calcula el backend; el editor no lo manda).
function appendCalendarEmbedParams(value, settings = {}, options = {}) {
  const raw = cleanString(value)
  if (!raw) return raw

  try {
    const absolute = /^https?:\/\//i.test(raw)
    const parsed = new URL(raw, 'https://rstk.local')
    const designMode = cleanString(settings.calendarDesignMode || settings.calendar_design_mode).toLowerCase() === 'original' ? 'original' : 'custom'
    const layout = calendarEmbedLayoutValue()
    const coverImage = cleanString(settings.calendarCoverImage || settings.calendar_cover_image)

    parsed.searchParams.set('test', '1')
    parsed.searchParams.set('embed', '1')
    parsed.searchParams.set('designMode', designMode)
    if (options.preview) parsed.searchParams.set('editor_preview', '1')
    if (options.bookingBridge) parsed.searchParams.set('bookingBridge', '1')
    // Override del evento Meta del sitio (el sitio es master del calendario embebido).
    if (cleanString(options.metaCalEvent)) parsed.searchParams.set('metaCalEvent', cleanString(options.metaCalEvent))
    if (cleanString(options.metaCalData)) parsed.searchParams.set('metaCalData', cleanString(options.metaCalData))
    parsed.searchParams.set('layout', layout)
    if (coverImage) parsed.searchParams.set('coverImage', coverImage)

    if (designMode === 'custom') {
      CALENDAR_EMBED_COLOR_QUERY_SETTINGS.forEach(([settingKey, paramKey]) => {
        if (settings[settingKey] === undefined) return
        const color = blockSettingColor(settings, settingKey)
        if (color) parsed.searchParams.set(paramKey, color)
      })

      CALENDAR_EMBED_NUMBER_QUERY_SETTINGS.forEach(([settingKey, paramKey, min, max]) => {
        if (settings[settingKey] === undefined) return
        const valueNumber = blockSettingNumber(settings, settingKey, min, max)
        if (valueNumber !== null) parsed.searchParams.set(paramKey, String(valueNumber))
      })

      // En custom el bloque dicta qué se muestra: reenviamos siempre los toggles
      // (ON por defecto) para que el editor y el sitio publicado coincidan.
      CALENDAR_EMBED_TOGGLE_QUERY_SETTINGS.forEach(([settingKey, paramKey]) => {
        parsed.searchParams.set(paramKey, isCalendarToggleOff(settings[settingKey]) ? '0' : '1')
      })

      const fontFamily = cleanString(settings.calendarFontFamily || settings.calendar_font_family)
      if (fontFamily) parsed.searchParams.set('fontFamily', fontFamily)

      const widgetTheme = cleanString(settings.calendarWidgetTheme || settings.calendar_widget_theme)
      if (widgetTheme) parsed.searchParams.set('widgetTheme', widgetTheme)
    }

    return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return raw
  }
}

// Contexto de estilo de formulario de la página anfitriona: el subconjunto del
// estado de página que consumen los proxies embebidos. Mismo shape que el
// renderContext.formStyleContext del renderer público.
function buildFormStyleContext(state) {
  return {
    baseFont: state.baseFont,
    v: state.renderVars,
    accent: state.accent,
    ink: state.ink,
    muted: state.muted,
    pageBg: blockTextContrastBackground(state)
  }
}

// Variables proxy de un formulario embebido "ligero" (gate de video): SOLO
// ink/muted/(block-bg) + variables de formulario/submit; acento, superficies,
// radios y fuentes se HEREDAN de la página anfitriona (embeds #14). theme llega
// MERGEADO con DEFAULT_THEME (cadena histórica del gate), así que aquí la
// explicitud del fondo es "distinto del blanco default", no raw-vs-merged.
function buildEmbeddedFormProxyVars(theme = {}, formStyleContext = null) {
  if (!formStyleContext) return {}

  const rawBg = normalizeCssPaint(theme.backgroundColor, '')
  const hasExplicitBg = Boolean(rawBg) && rawBg.toLowerCase() !== String(DEFAULT_THEME.backgroundColor).toLowerCase()
  const inheritedBg = formStyleContext.pageBg || formStyleContext.v.pageBg
  const proxyBg = hasExplicitBg && !(isCssColor(rawBg) && isTransparentCssColorValue(rawBg))
    ? paintFallbackColor(rawBg, inheritedBg)
    : inheritedBg
  const rawTextPaint = normalizeCssPaint(theme.textColor, '')
  const textPaint = rawTextPaint && (theme.textColorCustom || rawTextPaint.toLowerCase() !== String(DEFAULT_THEME.textColor).toLowerCase()) ? rawTextPaint : ''
  const ink = textPaint ? readableTextOnBackground(textPaint, proxyBg, formStyleContext.ink) : formStyleContext.ink
  const muted = textPaint && isCssColor(textPaint)
    ? `color-mix(in srgb, ${ink} 60%, ${proxyBg})`
    : formStyleContext.muted
  const styleVars = buildFormThemeStyleVars(theme, {
    baseFont: formStyleContext.baseFont,
    v: formStyleContext.v,
    accent: formStyleContext.accent,
    ink,
    muted
  })

  return {
    '--rstk-ink': ink,
    '--rstk-muted': muted,
    ...(hasExplicitBg ? { '--rstk-block-bg': rawBg } : {}),
    ...styleVars
  }
}


export {
  DEFAULT_THEME,
  EMBEDDED_FORM_DEFAULT_THEME,
  MIN_TEXT_CONTRAST_RATIO,
  AUTO_DARK_TEXT,
  AUTO_LIGHT_TEXT,
  FORM_PAGE_BORDER_WIDTH_MAX,
  RSTK_SANS,
  SITE_TEMPLATES,
  resolveTemplate,
  RSTK_SITE_FONTS_CSS_PATH,
  RSTK_FONT_FAMILIES,
  RSTK_DEFAULT_FONT,
  RSTK_DEFAULT_SERIF_FONT,
  normalizeSiteFontFamily,
  RSTK_BASE_CSS,
  RSTK_TEMPLATE_EXTRAS,
  RSTK_POPUP_CSS,
  isCssColor,
  isCssGradient,
  isCssPaint,
  normalizeCssColor,
  normalizeCssPaint,
  extractCssColor,
  paintFallbackColor,
  relLuminance,
  contrastRatio,
  readableTextOnBackground,
  cssImageUrl,
  cssMediaUrl,
  paintLayer,
  backgroundFitValue,
  backgroundRepeatValue,
  backgroundPositionValue,
  backgroundAttachmentValue,
  themeNumber,
  themePaint,
  blockButtonAlign,
  justifyForAlign,
  marginForAlign,
  deriveNeutralVars,
  resolveRenderOverrides,
  sanitizeCssFont,
  normalizeFormChoiceStyle,
  normalizeFormSelectStyle,
  normalizeFormInputStyle,
  buildFormThemeStyleVars,
  serializeCssVars,
  computeSitePageRenderState,
  buildStyleSheet,
  buildEmbeddedFormTheme,
  popupSurfaceDefaults,
  rescopeSiteCssForCanvas,
  // Superficies embebidas (Paquete D)
  buildPopupSurfaceVars,
  appendCalendarEmbedParams,
  buildFormStyleContext,
  buildEmbeddedFormProxyVars,
  // Contrato de bloques (Paquete C)
  FIELD_BLOCK_TYPES,
  EMBED_MIN_HEIGHT,
  EMBED_MAX_HEIGHT,
  CALENDAR_EMBED_DEFAULT_HEIGHT,
  SOCIAL_PROFILE_SCALE_MIN,
  SOCIAL_PROFILE_SCALE_MAX,
  DEFAULT_SOCIAL_PROFILE_SCALE,
  DEFAULT_VIDEO_PLAYER_BACKGROUND,
  DEFAULT_VIDEO_TRANSPARENT,
  DEFAULT_VIDEO_BORDER_FALLBACK,
  DEFAULT_VIDEO_LANDSCAPE_ASPECT_RATIO,
  DEFAULT_VIDEO_PORTRAIT_ASPECT_RATIO,
  DEFAULT_VIDEO_PORTRAIT_MEDIA_WIDTH,
  isTransparentCssColorValue,
  getVisibleVideoBorderColor,
  normalizeVideoOrientation,
  getVideoAspectRatio,
  shouldUseDefaultPortraitMediaWidth,
  buildVideoFrameStyleVars,
  safeUrl,
  safeHref,
  resolvePanelNavLinks,
  getNativeFieldRulesAttributes,
  safePublicMediaUrl,
  isSocialTemplate,
  isSupportedSocialPlatform,
  normalizeSocialPlatform,
  parseCountdownTargetDate,
  countdownShowLabelsValue,
  extractWistiaMediaId,
  wistiaEmbedIframeUrl,
  blockSettingColor,
  blockSettingPaint,
  blockSettingNumber,
  blockSettingNumberWithFallback,
  blockTextContrastBackground,
  blockHorizontalAlign,
  blockTextDecoration,
  blockTextTransform,
  blockTextListStyle,
  getSectionColumns,
  normalizeLegacyLandingBlockSettings,
  buildBlockStyleVars,
  buildBlockStyleClassName,
  resolveDeviceBlockSettings,
  buildBlockResponsiveCss,
  buildBlocksResponsiveCss,
  blockHasResponsiveOverrides,
  RESPONSIVE_DEVICE_MAX_WIDTH,
  blockHasBackgroundVideo,
  blockIsUserHidden,
  blockHasStyleWrapper
}
