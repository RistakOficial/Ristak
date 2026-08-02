export const SITE_NAME_MAX_LENGTH = 120

export const normalizeSiteNameInput = (value: string) => (
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, SITE_NAME_MAX_LENGTH)
)
