// Fuentes de Sites: la lista canónica y el normalizador viven en el contrato
// compartido (shared/sites/renderContract.js), la misma copia que usa el
// renderer público del backend. Aquí solo queda el catálogo de opciones para
// los selectores de la UI del editor.
import {
  RSTK_DEFAULT_FONT,
  RSTK_DEFAULT_SERIF_FONT,
  normalizeSiteFontFamily as normalizeSharedSiteFontFamily
} from '../../../../shared/sites/renderContract.js'

export const normalizeSiteFontFamily = (value?: string | null): string =>
  normalizeSharedSiteFontFamily(value)

export const SITE_FONT_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Predeterminada', value: '' },
  { label: 'Inter', value: RSTK_DEFAULT_FONT },
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
  { label: 'Libre Baskerville', value: RSTK_DEFAULT_SERIF_FONT }
]
