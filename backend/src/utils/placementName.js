/**
 * Normaliza el nombre de una ubicación (placement) de anuncio a un texto legible.
 * Misma lógica que el frontend (Contacts.tsx / Analytics) para mantener consistencia.
 * @param {string} placement
 * @returns {string}
 */
export function formatPlacementName(placement) {
  if (!placement || placement === 'Sin ubicación') return 'Sin ubicación'

  const cleaned = String(placement).toLowerCase().trim()

  if (cleaned.includes('facebook') && cleaned.includes('feed')) return 'Facebook Feed'
  if (cleaned.includes('facebook') && cleaned.includes('reel')) return 'Facebook Reels'
  if (cleaned.includes('facebook') && cleaned.includes('story')) return 'Facebook Stories'
  if (cleaned.includes('facebook') && cleaned.includes('right_column')) return 'Facebook Columna Derecha'
  if (cleaned.includes('facebook') && cleaned.includes('video')) return 'Facebook Video'
  if (cleaned.includes('facebook') && cleaned.includes('marketplace')) return 'Facebook Marketplace'
  if (cleaned.includes('facebook') && cleaned.includes('search')) return 'Facebook Búsqueda'

  if (cleaned.includes('instagram') && cleaned.includes('feed')) return 'Instagram Feed'
  if (cleaned.includes('instagram') && cleaned.includes('reel')) return 'Instagram Reels'
  if (cleaned.includes('instagram') && cleaned.includes('story')) return 'Instagram Stories'
  if (cleaned.includes('instagram') && cleaned.includes('explore')) return 'Instagram Explorar'
  if (cleaned.includes('instagram') && cleaned.includes('profile')) return 'Instagram Perfil'
  if (cleaned.includes('instagram') && cleaned.includes('search')) return 'Instagram Búsqueda'

  if (cleaned.includes('messenger')) return 'Messenger'
  if (cleaned.includes('audience_network')) return 'Audience Network'
  if (cleaned.includes('instant_article')) return 'Artículo Instantáneo'
  if (cleaned.includes('instream')) return 'In-Stream Video'
  if (cleaned === 'fb') return 'Facebook'
  if (cleaned === 'ig') return 'Instagram'

  return String(placement).replace(/_/g, ' ').split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ')
}
