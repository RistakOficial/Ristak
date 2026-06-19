const SITE_FONT_FAMILIES = [
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

const DEFAULT_SITE_FONT = "'Inter', Arial, sans-serif"
const DEFAULT_SERIF_SITE_FONT = "'Libre Baskerville', Georgia, serif"

export const SITE_FONT_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Predeterminada', value: '' },
  { label: 'Inter', value: DEFAULT_SITE_FONT },
  { label: 'Inter Tight', value: "'Inter Tight', 'Inter', Arial, sans-serif" },
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
  { label: 'Libre Baskerville', value: DEFAULT_SERIF_SITE_FONT }
]

const hasKnownSiteFontFamily = (value: string) => {
  const normalized = value.toLowerCase()
  return SITE_FONT_FAMILIES.some((family) => normalized.includes(family.toLowerCase()))
}

export const normalizeSiteFontFamily = (value?: string | null) => {
  const font = String(value || '').replace(/[;"{}<>]/g, '').trim()
  if (!font) return ''
  if (hasKnownSiteFontFamily(font)) return font

  const normalized = font.toLowerCase().replace(/['"]/g, '')
  if (normalized.includes('georgia') || normalized.includes('times new roman') || normalized === 'serif') {
    return DEFAULT_SERIF_SITE_FONT
  }
  if (
    normalized.includes('-apple-system') ||
    normalized.includes('blinkmacsystemfont') ||
    normalized.includes('system-ui') ||
    normalized.includes('segoe ui') ||
    normalized === 'arial' ||
    normalized === 'helvetica' ||
    normalized === 'sans-serif'
  ) {
    return DEFAULT_SITE_FONT
  }

  return font
}
