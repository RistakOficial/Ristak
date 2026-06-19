export interface ContactAvatarSource {
  name?: string | null
  email?: string | null
  phone?: string | null
  profilePhotoUrl?: string | null
  avatarUrl?: string | null
  photoUrl?: string | null
  pictureUrl?: string | null
  profile_picture_url?: string | null
}

export function getContactDisplayName(contact?: ContactAvatarSource | null) {
  return contact?.name || contact?.email || contact?.phone || 'Contacto sin nombre'
}

export function getContactDetailLabel(contact?: ContactAvatarSource | null) {
  return contact?.phone || contact?.email || 'Sin telefono guardado'
}

export function getContactAvatarUrl(contact?: ContactAvatarSource | null) {
  const candidates = [
    contact?.profilePhotoUrl,
    contact?.avatarUrl,
    contact?.photoUrl,
    contact?.pictureUrl,
    contact?.profile_picture_url
  ]

  return candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() || ''
}

export function getContactInitials(contact?: ContactAvatarSource | null) {
  const label = getContactDisplayName(contact)
  const normalizedLabel = label.includes('@') ? label.split('@')[0] : label
  const parts = normalizedLabel.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return normalizedLabel.slice(0, 2).toUpperCase() || '??'
}
