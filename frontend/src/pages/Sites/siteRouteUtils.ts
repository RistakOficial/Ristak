const normalizePublicDomain = (value: string) => String(value || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/+$/, '')

export const normalizeRouteSegment = (value: string) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

const decodeRouteSegment = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const normalizeSiteRoutePath = (value: string) => String(value || '')
  .trim()
  .split(/[?#]/, 1)[0]
  .split('/')
  .map(segment => normalizeRouteSegment(decodeRouteSegment(segment)))
  .filter(Boolean)
  .join('/')

const extractEditorRoutePath = (value: string, publicDomain: string) => {
  const input = String(value || '')
  const raw = input.trim()
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).pathname
    } catch {
      return raw
    }
  }

  const withoutProtocol = input.trimStart().replace(/^https?:\/\//i, '')
  const domain = normalizePublicDomain(publicDomain)
  return domain && withoutProtocol.toLowerCase().startsWith(`${domain.toLowerCase()}/`)
    ? withoutProtocol.slice(domain.length)
    : input.trimStart()
}

export const normalizeSiteRouteEditorInput = (value: string, publicDomain: string) =>
  normalizeSiteRoutePath(extractEditorRoutePath(value, publicDomain))

export const normalizeSiteRouteEditorDraft = (value: string, publicDomain: string) => {
  const routePath = extractEditorRoutePath(value, publicDomain)
  const normalized = normalizeSiteRoutePath(routePath)
  if (!normalized) return ''

  if (/\/\s*$/.test(routePath)) return `${normalized}/`
  if (/[-_\s]\s*$/.test(routePath)) return `${normalized}-`
  return normalized
}
