import apiClient from './apiClient'

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

let cachedTags: ContactTag[] | null = null
let pendingLoad: Promise<ContactTag[]> | null = null
const listeners = new Set<TagsListener>()

function notify(tags: ContactTag[]) {
  cachedTags = tags
  listeners.forEach((listener) => listener(tags))
}

export const contactTagsService = {
  /** Lista con caché compartida (los pickers de toda la app la reutilizan). */
  async getTags(forceRefresh = false): Promise<ContactTag[]> {
    if (cachedTags && !forceRefresh) return cachedTags
    if (!pendingLoad) {
      pendingLoad = apiClient
        .get<ContactTag[]>('/contact-tags')
        .then((tags) => {
          const list = Array.isArray(tags) ? tags : []
          notify(list)
          return list
        })
        .finally(() => {
          pendingLoad = null
        })
    }
    return pendingLoad
  },

  async getTagsWithUsage(): Promise<ContactTag[]> {
    const tags = await apiClient.get<ContactTag[]>('/contact-tags', { params: { includeUsage: 'true' } })
    const list = Array.isArray(tags) ? tags : []
    notify(list)
    return list
  },

  /** Etiquetas (con conteo de uso) + carpetas en una sola llamada */
  async getCatalog(): Promise<ContactTagsCatalog> {
    const catalog = await apiClient.get<ContactTagsCatalog>('/contact-tags/catalog')
    const tags = Array.isArray(catalog?.tags) ? catalog.tags : []
    notify(tags)
    return { tags, folders: Array.isArray(catalog?.folders) ? catalog.folders : [] }
  },

  async createTag(name: string, folderId?: string): Promise<ContactTag> {
    const tag = await apiClient.post<ContactTag>('/contact-tags', { name, folderId })
    await contactTagsService.getTags(true)
    return tag
  },

  async updateTag(id: string, patch: { name?: string; folderId?: string }): Promise<ContactTag> {
    const tag = await apiClient.put<ContactTag>(`/contact-tags/${id}`, patch)
    await contactTagsService.getTags(true)
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
    await contactTagsService.getTags(true)
  },

  async deleteTag(id: string): Promise<void> {
    await apiClient.delete(`/contact-tags/${id}`)
    await contactTagsService.getTags(true)
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
  subscribe(listener: TagsListener): () => void {
    listeners.add(listener)
    if (cachedTags) listener(cachedTags)
    return () => listeners.delete(listener)
  },

  getCachedTags(): ContactTag[] | null {
    return cachedTags
  }
}
