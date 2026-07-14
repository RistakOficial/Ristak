import apiClient from './apiClient'
import {
  getAuthScopedCacheRevision,
  registerAuthScopedCacheInvalidator,
  syncAuthScopedCachePrincipal
} from './authPrincipalCache'

/**
 * Etiquetas de contactos. Cada etiqueta tiene un ID estable (es lo que se
 * guarda en el contacto y en las automatizaciones) y un nombre editable:
 * renombrar no rompe filtros ni reglas. Las internas (Cliente, Cita agendada,
 * Prospecto) las calcula el backend y no se pueden editar ni borrar.
 */
export interface ContactTag {
  id: string
  name: string
  isSystem: boolean
  folderId?: string | null
  usageCount?: number
  createdAt?: string
  updatedAt?: string
}

export interface ContactTagFolder {
  id: string
  name: string
  description?: string
  createdAt?: string
  updatedAt?: string
}

export interface ContactTagsCatalog {
  tags: ContactTag[]
  folders: ContactTagFolder[]
}

type TagsListener = (tags: ContactTag[]) => void
type GetTagsOptions = boolean | {
  forceRefresh?: boolean
  includeSystem?: boolean
}

const GENERATED_TAG_ID_PATTERN = /^(?:tag_sys_[a-z0-9_]+|[a-z0-9]+(?:_[a-z0-9]+)*)$/
let cachedUserTags: ContactTag[] | null = null
let cachedTagsWithSystem: ContactTag[] | null = null
let pendingUserLoad: Promise<ContactTag[]> | null = null
let pendingSystemLoad: Promise<ContactTag[]> | null = null
const listeners = new Set<{ listener: TagsListener; includeSystem: boolean }>()

function normalizeGetTagsOptions(options?: GetTagsOptions) {
  if (typeof options === 'boolean') return { forceRefresh: options, includeSystem: false }
  return {
    forceRefresh: Boolean(options?.forceRefresh),
    includeSystem: Boolean(options?.includeSystem)
  }
}

function cacheFor(includeSystem: boolean) {
  return includeSystem ? cachedTagsWithSystem : cachedUserTags
}

function setCache(includeSystem: boolean, tags: ContactTag[]) {
  if (includeSystem) {
    cachedTagsWithSystem = tags
    cachedUserTags = tags.filter((tag) => !tag.isSystem)
  } else {
    cachedUserTags = tags
  }
}

function notify(includeSystem: boolean, tags: ContactTag[]) {
  setCache(includeSystem, tags)
  listeners.forEach((entry) => {
    const current = cacheFor(entry.includeSystem)
    if (current) entry.listener(current)
  })
}

function invalidateCaches() {
  cachedUserTags = null
  cachedTagsWithSystem = null
  pendingUserLoad = null
  pendingSystemLoad = null
}

registerAuthScopedCacheInvalidator(invalidateCaches)

function cachedTagByValue(value: string, includeSystem = true): ContactTag | undefined {
  syncAuthScopedCachePrincipal()
  const clean = String(value || '').trim()
  if (!clean) return undefined
  const lists = includeSystem
    ? [cachedTagsWithSystem, cachedUserTags]
    : [cachedUserTags]
  for (const list of lists) {
    const match = list?.find((tag) => tag.id === clean || tag.name === clean)
    if (match) return match
  }
  return undefined
}

function displayNameFromCache(value: string, fallback = 'Etiqueta seleccionada', includeSystem = true): string {
  const clean = String(value || '').trim()
  if (!clean) return ''
  const cached = cachedTagByValue(clean, includeSystem)
  if (cached) return cached.name
  return GENERATED_TAG_ID_PATTERN.test(clean) ? fallback : clean
}

async function refreshAfterMutation() {
  const hadSystemCache = Boolean(cachedTagsWithSystem)
  invalidateCaches()
  await contactTagsService.getTags({ forceRefresh: true, includeSystem: false })
  if (hadSystemCache) {
    await contactTagsService.getTags({ forceRefresh: true, includeSystem: true })
  }
}

export const contactTagsService = {
  /** Lista con caché compartida. Por defecto devuelve sólo etiquetas del usuario. */
  async getTags(options?: GetTagsOptions): Promise<ContactTag[]> {
    syncAuthScopedCachePrincipal()
    const requestPrincipalRevision = getAuthScopedCacheRevision()
    const { forceRefresh, includeSystem } = normalizeGetTagsOptions(options)
    const cached = cacheFor(includeSystem)
    if (cached && !forceRefresh) return cached
    const pendingKey = includeSystem ? pendingSystemLoad : pendingUserLoad
    if (!pendingKey) {
      const request = apiClient
        .get<ContactTag[]>('/contact-tags', includeSystem ? { params: { includeSystem: 'true' } } : undefined)
        .then((tags) => {
          const list = Array.isArray(tags) ? tags : []
          if (requestPrincipalRevision === getAuthScopedCacheRevision()) {
            notify(includeSystem, list)
          }
          return list
        })
        .finally(() => {
          if (includeSystem && pendingSystemLoad === request) pendingSystemLoad = null
          else if (!includeSystem && pendingUserLoad === request) pendingUserLoad = null
        })
      if (includeSystem) pendingSystemLoad = request
      else pendingUserLoad = request
    }
    return includeSystem ? pendingSystemLoad! : pendingUserLoad!
  },

  async getTagsWithUsage(): Promise<ContactTag[]> {
    syncAuthScopedCachePrincipal()
    const requestPrincipalRevision = getAuthScopedCacheRevision()
    const tags = await apiClient.get<ContactTag[]>('/contact-tags', { params: { includeUsage: 'true' } })
    const list = Array.isArray(tags) ? tags : []
    if (requestPrincipalRevision === getAuthScopedCacheRevision()) {
      notify(false, list)
    }
    return list
  },

  async getSystemTags(): Promise<ContactTag[]> {
    return apiClient.get<ContactTag[]>('/contact-tags/system')
  },

  /** Etiquetas (con conteo de uso) + carpetas en una sola llamada */
  async getCatalog(options: { includeSystem?: boolean } = {}): Promise<ContactTagsCatalog> {
    syncAuthScopedCachePrincipal()
    const requestPrincipalRevision = getAuthScopedCacheRevision()
    const includeSystem = Boolean(options.includeSystem)
    const catalog = await apiClient.get<ContactTagsCatalog>(
      '/contact-tags/catalog',
      includeSystem ? { params: { includeSystem: 'true' } } : undefined
    )
    const tags = Array.isArray(catalog?.tags) ? catalog.tags : []
    if (requestPrincipalRevision === getAuthScopedCacheRevision()) {
      notify(includeSystem, tags)
    }
    return { tags, folders: Array.isArray(catalog?.folders) ? catalog.folders : [] }
  },

  async createTag(name: string, folderId?: string): Promise<ContactTag> {
    const tag = await apiClient.post<ContactTag>('/contact-tags', { name, folderId })
    await refreshAfterMutation()
    return tag
  },

  async updateTag(id: string, patch: { name?: string; folderId?: string }): Promise<ContactTag> {
    const tag = await apiClient.put<ContactTag>(`/contact-tags/${id}`, patch)
    await refreshAfterMutation()
    return tag
  },

  async renameTag(id: string, name: string): Promise<ContactTag> {
    return contactTagsService.updateTag(id, { name })
  },

  async createFolder(input: { name: string; description?: string }): Promise<ContactTagFolder> {
    return apiClient.post<ContactTagFolder>('/contact-tags/folders', input)
  },

  async deleteFolder(id: string): Promise<void> {
    await apiClient.delete(`/contact-tags/folders/${id}`)
    await refreshAfterMutation()
  },

  async deleteTag(id: string): Promise<void> {
    await apiClient.delete(`/contact-tags/${id}`)
    await refreshAfterMutation()
  },

  /** Añade/quita etiquetas a varios contactos a la vez (selección múltiple). */
  async bulkUpdateTags(contactIds: string[], addTagIds: string[], removeTagIds: string[]): Promise<{ updated: number; total: number }> {
    return apiClient.post<{ updated: number; total: number }>('/contacts/bulk/tags', {
      contactIds,
      addTagIds,
      removeTagIds
    })
  },

  /** Suscripción a cambios del catálogo (para refrescar pickers abiertos). */
  subscribe(listener: TagsListener, options: { includeSystem?: boolean } = {}): () => void {
    const entry = { listener, includeSystem: Boolean(options.includeSystem) }
    listeners.add(entry)
    const cached = cacheFor(entry.includeSystem)
    if (cached) listener(cached)
    return () => listeners.delete(entry)
  },

  getCachedTags(options: { includeSystem?: boolean } = {}): ContactTag[] | null {
    return cacheFor(Boolean(options.includeSystem))
  },

  getCachedTagByValue(value: string, options: { includeSystem?: boolean } = {}): ContactTag | undefined {
    return cachedTagByValue(value, options.includeSystem !== false)
  },

  getDisplayName(value: string, options: { fallback?: string; includeSystem?: boolean } = {}): string {
    return displayNameFromCache(value, options.fallback || 'Etiqueta seleccionada', options.includeSystem !== false)
  }
}
