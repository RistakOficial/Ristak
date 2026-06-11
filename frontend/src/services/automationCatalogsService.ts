import apiClient from './apiClient'
import { customFieldsService } from './customFieldsService'
import { calendarsService } from './calendarsService'
import { whatsappApiService, type WhatsAppApiTemplate } from './whatsappApiService'
import { sitesService } from './sitesService'
import { contactTagsService } from './contactTagsService'

/**
 * Catálogos de datos reales del CRM para los selectores del editor de
 * automatizaciones (etiquetas, campos, calendarios, números de WhatsApp…).
 *
 * Cada catálogo expone opciones { value, label } listas para un select.
 * Los catálogos sin backend todavía devuelven datos MOCK claramente marcados
 * (constantes MOCK_*) y son fáciles de reemplazar por el endpoint real.
 */

export interface CatalogOption {
  value: string
  label: string
  /** Información secundaria (tipo de dato, idioma, número…) */
  meta?: string
}

export type CatalogKind =
  | 'tags'
  | 'users'
  | 'contactFields'
  | 'calendars'
  | 'forms'
  | 'whatsappNumbers'
  | 'whatsappTemplates'
  | 'campaigns'
  | 'links'
  | 'products'
  | 'ads'

// ---------------------------------------------------------------------------
// Mocks marcados (catálogos sin backend todavía)
// ---------------------------------------------------------------------------

// MOCK: no existe aún un endpoint de usuarios del equipo.
const MOCK_USERS: CatalogOption[] = [
  { value: 'owner', label: 'Cuenta principal' }
]

// MOCK: no existe aún catálogo de campañas/anuncios para automatizaciones.
const MOCK_CAMPAIGNS: CatalogOption[] = [
  { value: 'any', label: 'Cualquier campaña' }
]

// MOCK: no existe aún catálogo de enlaces rastreables.
const MOCK_LINKS: CatalogOption[] = [
  { value: 'activation', label: 'Enlace de activación' }
]

// MOCK: el catálogo de productos aún no está expuesto en el frontend.
const MOCK_PRODUCTS: CatalogOption[] = [
  { value: 'any', label: 'Cualquier producto' }
]

// ---------------------------------------------------------------------------
// Cargadores reales
// ---------------------------------------------------------------------------

/** Campos estándar del contacto (el email es dato de CRM, no canal de envío) */
export const STANDARD_CONTACT_FIELDS: CatalogOption[] = [
  { value: 'firstName', label: 'Nombre', meta: 'texto' },
  { value: 'lastName', label: 'Apellido', meta: 'texto' },
  { value: 'phone', label: 'Teléfono', meta: 'texto' },
  { value: 'email', label: 'Email (dato de contacto)', meta: 'texto' },
  { value: 'source', label: 'Fuente', meta: 'texto' },
  { value: 'assignedUser', label: 'Usuario asignado', meta: 'texto' },
  { value: 'stage', label: 'Etapa', meta: 'texto' },
  { value: 'createdAt', label: 'Fecha de creación', meta: 'fecha' },
  { value: 'updatedAt', label: 'Fecha de actualización', meta: 'fecha' },
  { value: 'lastActivityAt', label: 'Última actividad', meta: 'fecha' },
  { value: 'lastChannel', label: 'Último canal de contacto', meta: 'texto' }
]

/** Etiquetas reales del catálogo (incluye las internas, marcadas) */
async function loadTags(): Promise<CatalogOption[]> {
  const tags = await contactTagsService.getTags(true)
  return tags.map((tag) => ({
    value: tag.id,
    label: tag.name,
    meta: tag.isSystem ? 'interna' : undefined
  }))
}

async function loadContactFields(): Promise<CatalogOption[]> {
  const catalog = await customFieldsService.listCatalog()
  const custom = (catalog.fields || [])
    .filter((field) => !field.archived)
    .map((field) => ({
      value: `custom:${field.key || field.fieldKey || field.definitionId}`,
      label: field.label || field.name,
      meta: field.dataType
    }))
  return [...STANDARD_CONTACT_FIELDS, ...custom]
}

async function loadCalendars(): Promise<CatalogOption[]> {
  const calendars = await calendarsService.getCalendars()
  return (calendars || []).map((calendar) => ({
    value: String(calendar.id ?? calendar.name),
    label: calendar.name || 'Calendario sin nombre'
  }))
}

async function loadForms(): Promise<CatalogOption[]> {
  const sites = await sitesService.listSites()
  return (sites || [])
    .filter((site) => String(site.siteType || '').includes('form'))
    .map((site) => ({ value: site.id || site.slug, label: site.name }))
}

async function loadWhatsAppNumbers(): Promise<CatalogOption[]> {
  const status = await whatsappApiService.getStatus()
  return (status.phoneNumbers || []).map((phone) => ({
    value: String(phone.id || phone.display_phone_number || ''),
    label: phone.label || phone.verified_name || phone.display_phone_number || 'Número de WhatsApp',
    meta: phone.display_phone_number || undefined
  }))
}

// Plantillas completas (con components: cuerpo, botones…) para previsualizar
let rawTemplatesCache: WhatsAppApiTemplate[] | null = null
let rawTemplatesPromise: Promise<WhatsAppApiTemplate[]> | null = null

async function loadRawWhatsAppTemplates(): Promise<WhatsAppApiTemplate[]> {
  if (rawTemplatesCache) return rawTemplatesCache
  if (!rawTemplatesPromise) {
    rawTemplatesPromise = whatsappApiService
      .getTemplates('APPROVED')
      .then(async (response) => {
        let items = response.items || []
        if (items.length === 0) {
          // Tabla local sin sincronizar: trae las plantillas desde YCloud
          try {
            await whatsappApiService.refresh()
            items = (await whatsappApiService.getTemplates('APPROVED')).items || []
          } catch {
            // sin credenciales o sin conexión: se queda vacío
          }
        }
        rawTemplatesCache = items
        return rawTemplatesCache
      })
      .catch(() => {
        rawTemplatesPromise = null
        return []
      })
  }
  return rawTemplatesPromise
}

/** Devuelve la plantilla completa (para mostrar exactamente qué envía) */
export async function getWhatsAppTemplate(templateId: string): Promise<WhatsAppApiTemplate | null> {
  const templates = await loadRawWhatsAppTemplates()
  return templates.find((template) => template.id === templateId) || null
}

async function loadWhatsAppTemplates(): Promise<CatalogOption[]> {
  const templates = await loadRawWhatsAppTemplates()
  return templates.map((template) => ({
    value: template.id,
    label: template.name,
    meta: template.language
  }))
}

// ---------------------------------------------------------------------------
// API con caché en memoria
// ---------------------------------------------------------------------------

const loaders: Record<CatalogKind, () => Promise<CatalogOption[]>> = {
  tags: loadTags,
  users: async () => MOCK_USERS,
  contactFields: loadContactFields,
  calendars: loadCalendars,
  forms: loadForms,
  whatsappNumbers: loadWhatsAppNumbers,
  whatsappTemplates: loadWhatsAppTemplates,
  campaigns: async () => MOCK_CAMPAIGNS,
  links: async () => MOCK_LINKS,
  products: async () => MOCK_PRODUCTS
}

const fallbacks: Partial<Record<CatalogKind, CatalogOption[]>> = {
  tags: [],
  contactFields: STANDARD_CONTACT_FIELDS,
  calendars: [],
  forms: [],
  whatsappNumbers: [],
  whatsappTemplates: []
}

const cache = new Map<CatalogKind, Promise<CatalogOption[]>>()

export function getCatalog(kind: CatalogKind): Promise<CatalogOption[]> {
  if (!cache.has(kind)) {
    const promise = loaders[kind]().catch(() => {
      cache.delete(kind)
      return fallbacks[kind] || []
    })
    cache.set(kind, promise)
  }
  return cache.get(kind) as Promise<CatalogOption[]>
}

/** Limpia la caché (p. ej. al entrar de nuevo al editor) */
export function resetCatalogCache() {
  cache.clear()
}
