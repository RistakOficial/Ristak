import apiClient from './apiClient'
import {
  customFieldsService,
  isSystemCustomFieldDefinition,
  type CustomFieldDefinition
} from './customFieldsService'
import { calendarsService } from './calendarsService'
import { whatsappApiService, type WhatsAppApiTemplate, type WhatsAppApiTemplatesResponse } from './whatsappApiService'
import { contactTagsService } from './contactTagsService'
import { campaignsService, type ConnectedSocialProfile } from './campaignsService'
import { triggerLinksService } from './triggerLinksService'
import { userAccessService } from './userAccessService'
import { productsService, type ProductItem } from './productsService'
import { automationsService } from './automationsService'
import {
  getAuthScopedCacheRevision,
  registerAuthScopedCacheInvalidator,
  syncAuthScopedCachePrincipal
} from './authPrincipalCache'

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
  | 'contactChangeFields'
  | 'customFields'
  | 'calendars'
  | 'forms'
  | 'whatsappNumbers'
  | 'whatsappTemplates'
  | 'campaigns'
  | 'adsets'
  | 'links'
  | 'products'
  | 'ads'
  | 'adIds'
  | 'messengerPages'
  | 'instagramAccounts'
  | 'automations'

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

const STANDARD_CONTACT_CHANGE_FIELDS: CatalogOption[] = [
  { value: 'name', label: 'Nombre del contacto', meta: 'sistema' },
  { value: 'firstName', label: 'Nombre', meta: 'sistema' },
  { value: 'lastName', label: 'Apellido', meta: 'sistema' },
  { value: 'phone', label: 'Teléfono', meta: 'sistema' },
  { value: 'email', label: 'Email', meta: 'sistema' },
  { value: 'source', label: 'Fuente', meta: 'sistema' },
  { value: 'assignedUser', label: 'Usuario asignado', meta: 'crm' },
  { value: 'preferredWhatsAppPhoneNumberId', label: 'Número de WhatsApp asignado', meta: 'whatsapp' },
  { value: 'tags', label: 'Etiquetas', meta: 'crm' },
  { value: 'totalPaid', label: 'Total pagado', meta: 'pagos' },
  { value: 'purchasesCount', label: 'Cantidad de pagos exitosos', meta: 'pagos' },
  { value: 'paymentsCount', label: 'Cantidad de pagos', meta: 'pagos' },
  { value: 'appointmentsCount', label: 'Cantidad de citas', meta: 'citas' },
  { value: 'activeAppointmentsCount', label: 'Cantidad de citas activas', meta: 'citas' },
  { value: 'activeAppointment', label: 'Cita activa', meta: 'citas' },
  { value: 'appointmentStatus', label: 'Estado de cita activa', meta: 'citas' },
  { value: 'appointmentCalendar', label: 'Calendario de cita activa', meta: 'citas' },
  { value: 'appointmentAssignedUser', label: 'Usuario de cita activa', meta: 'citas' },
  { value: 'appointmentDate', label: 'Fecha de cita activa', meta: 'citas' },
  { value: 'attributionAd', label: 'Anuncio de origen', meta: 'atribución' },
  { value: 'attributionUrl', label: 'URL de origen', meta: 'atribución' },
  { value: 'updatedAt', label: 'Fecha de actualización', meta: 'sistema' }
]

/** Etiquetas editables del usuario; los estados internos se piden aparte cuando un filtro los necesita. */
async function loadTags(): Promise<CatalogOption[]> {
  const tags = await contactTagsService.getTags(true)
  return tags.map((tag) => ({
    value: tag.id,
    label: tag.name,
    meta: tag.isSystem ? 'interna' : undefined
  }))
}

const customFieldValue = (field: CustomFieldDefinition) =>
  String(field.key || field.fieldKey || field.definitionId || '').trim()

async function loadCustomFields(): Promise<CatalogOption[]> {
  const catalog = await customFieldsService.listCatalog()
  return (catalog.fields || [])
    .filter((field) => !field.archived && !isSystemCustomFieldDefinition(field) && customFieldValue(field))
    .map((field) => ({
      value: customFieldValue(field),
      label: field.label || field.name || customFieldValue(field),
      meta: field.dataType
    }))
}

async function loadContactFields(): Promise<CatalogOption[]> {
  const custom = (await loadCustomFields()).map((field) => ({
    ...field,
    value: `custom:${field.value}`
  }))
  return [...STANDARD_CONTACT_FIELDS, ...custom]
}

async function loadContactChangeFields(): Promise<CatalogOption[]> {
  const custom = (await loadCustomFields()).map((field) => ({
    ...field,
    value: `custom:${field.value}`,
    meta: field.meta ? `campo personalizado · ${field.meta}` : 'campo personalizado'
  }))
  return [...STANDARD_CONTACT_CHANGE_FIELDS, ...custom]
}

async function loadUsers(): Promise<CatalogOption[]> {
  const users = await userAccessService.listUsers()
  return users
    .filter((user) => user.isActive !== false)
    .map((user) => ({
      value: String(user.id),
      label: user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || user.username || `Usuario ${user.id}`,
      meta: user.email || user.role
    }))
    .filter((option) => option.value)
}

async function loadCalendars(): Promise<CatalogOption[]> {
  const calendars = await calendarsService.getCalendars()
  return (calendars || []).map((calendar) => ({
    value: String(calendar.id ?? calendar.name),
    label: calendar.name || 'Calendario sin nombre'
  }))
}

interface AutomationFormCatalogItem {
  id: string
  name: string
  siteName?: string
  meta?: string
}

interface AutomationFormFieldCatalogItem {
  id: string
  name: string
  type?: string
  meta?: string
}

async function loadForms(): Promise<CatalogOption[]> {
  const forms = await apiClient.get<AutomationFormCatalogItem[]>('/automations/catalogs/forms')
  return (forms || [])
    .map((form) => ({
      value: String(form.id || '').trim(),
      label: form.name || 'Formulario sin nombre',
      meta: form.meta || form.siteName
    }))
    .filter((option) => option.value)
}

const formFieldCache = new Map<string, Promise<CatalogOption[]>>()

export function getFormFieldCatalog(formId: string): Promise<CatalogOption[]> {
  syncAuthScopedCachePrincipal()
  const cleanFormId = String(formId || '').trim()
  if (!cleanFormId) return Promise.resolve([])
  if (!formFieldCache.has(cleanFormId)) {
    const promise = apiClient
      .get<AutomationFormFieldCatalogItem[]>('/automations/catalogs/form-fields', { params: { formId: cleanFormId } })
      .then((fields) => (fields || [])
        .map((field) => ({
          value: String(field.id || '').trim(),
          label: field.name || field.id || 'Pregunta sin nombre',
          meta: field.meta || field.type
        }))
        .filter((option) => option.value))
      .catch(() => {
        if (formFieldCache.get(cleanFormId) === promise) {
          formFieldCache.delete(cleanFormId)
        }
        return []
      })
    formFieldCache.set(cleanFormId, promise)
  }
  return formFieldCache.get(cleanFormId) as Promise<CatalogOption[]>
}

async function loadTriggerLinks(): Promise<CatalogOption[]> {
  const links = await triggerLinksService.list()
  return (links || [])
    .map((link) => ({
      value: link.id,
      label: link.name
    }))
}

const AUTOMATION_STATUS_META: Record<string, string> = {
  published: 'Publicada',
  paused: 'Pausada',
  draft: 'Borrador',
  archived: 'Archivada'
}

async function loadAutomations(): Promise<CatalogOption[]> {
  const overview = await automationsService.getOverview({
    suppressFeatureNotAvailableToast: true,
    limit: 100
  })
  return (overview?.automations || [])
    .map((automation) => ({
      value: automation.id,
      label: automation.name || automation.id,
      meta: AUTOMATION_STATUS_META[automation.status]
    }))
}

const productCatalogValue = (product: ProductItem) =>
  String(product.id || product._id || product.localId || product.ghlProductId || '').trim()

async function loadProducts(): Promise<CatalogOption[]> {
  const { products } = await productsService.listProducts({ limit: 200, includePrices: false })
  return products
    .map((product) => {
      const value = productCatalogValue(product)
      return {
        value,
        label: product.name || value,
        meta: product.source === 'ghl' ? 'HighLevel' : undefined
      }
    })
    .filter((option) => option.value && option.label)
}

interface MetaAdsCatalogItem {
  id: string
  name: string
  campaignId?: string
  campaignName?: string
  adsetId?: string
  adsetName?: string
  lastDate?: string
}

const compactMeta = (...parts: Array<string | undefined | null>) =>
  parts.map((part) => String(part || '').trim()).filter(Boolean).join(' · ') || undefined

/** Campañas reales sincronizadas desde Meta Ads */
async function loadCampaigns(): Promise<CatalogOption[]> {
  const campaigns = await apiClient.get<MetaAdsCatalogItem[]>('/automations/catalogs/campaigns')
  return (campaigns || []).map((campaign) => ({
    value: campaign.name || campaign.id,
    label: campaign.name || campaign.id,
    meta: campaign.name && campaign.id && campaign.name !== campaign.id ? campaign.id : undefined
  }))
}

/** Conjuntos reales sincronizados desde Meta Ads */
async function loadAdsets(): Promise<CatalogOption[]> {
  const adsets = await apiClient.get<MetaAdsCatalogItem[]>('/automations/catalogs/adsets')
  return (adsets || []).map((adset) => ({
    value: adset.id || adset.name,
    label: adset.name || adset.id,
    meta: compactMeta(adset.campaignName, adset.id && adset.name !== adset.id ? adset.id : undefined)
  }))
}

/** Anuncios reales para filtros legibles por nombre */
async function loadAds(): Promise<CatalogOption[]> {
  const ads = await apiClient.get<MetaAdsCatalogItem[]>('/automations/catalogs/ads')
  return (ads || []).map((ad) => ({
    value: ad.name || ad.id,
    label: ad.name || ad.id,
    meta: compactMeta(ad.adsetName, ad.id && ad.name !== ad.id ? ad.id : undefined)
  }))
}

/** Anuncios reales para campos que deben guardar el ID interno del anuncio */
async function loadAdIds(): Promise<CatalogOption[]> {
  const ads = await apiClient.get<MetaAdsCatalogItem[]>('/automations/catalogs/ads')
  return (ads || []).map((ad) => ({
    value: ad.id || ad.name,
    label: ad.name || ad.id,
    meta: compactMeta(ad.adsetName, ad.campaignName, ad.id && ad.name !== ad.id ? ad.id : undefined)
  }))
}

const socialProfileLabel = (profile: ConnectedSocialProfile) => {
  if (profile.platform === 'instagram') {
    const username = profile.username ? `@${profile.username}` : profile.name
    return profile.name && profile.name !== username ? `${profile.name} (${username})` : username
  }
  return profile.name || profile.pageName || profile.sourceId
}

async function loadConnectedSocialProfiles(platform: ConnectedSocialProfile['platform']): Promise<CatalogOption[]> {
  const response = await campaignsService.getConnectedSocialProfiles()
  return response.profiles
    .filter((profile) => profile.platform === platform)
    .map((profile) => ({
      value: platform === 'facebook' ? String(profile.pageId || profile.sourceId || '') : String(profile.sourceId || ''),
      label: socialProfileLabel(profile),
      meta: platform === 'facebook'
        ? compactMeta(profile.category || 'Facebook', profile.sourceId)
        : compactMeta(profile.pageName, profile.sourceId)
    }))
    .filter((option) => option.value)
}

async function loadMessengerPages(): Promise<CatalogOption[]> {
  return loadConnectedSocialProfiles('facebook')
}

async function loadInstagramAccounts(): Promise<CatalogOption[]> {
  return loadConnectedSocialProfiles('instagram')
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
  syncAuthScopedCachePrincipal()
  if (rawTemplatesCache) return rawTemplatesCache
  if (!rawTemplatesPromise) {
    const requestPrincipalRevision = getAuthScopedCacheRevision()
    const promise = apiClient
      .get<WhatsAppApiTemplatesResponse>('/automations/catalogs/whatsapp-templates', {
        params: { status: 'APPROVED' }
      })
      .then(async (response) => {
        if (requestPrincipalRevision !== getAuthScopedCacheRevision()) return []
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
        if (items.length > 0) {
          rawTemplatesCache = items
        } else {
          if (rawTemplatesPromise === promise) rawTemplatesPromise = null
        }
        return items
      })
      .catch(() => {
        if (rawTemplatesPromise === promise) rawTemplatesPromise = null
        return []
      })
    rawTemplatesPromise = promise
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
  users: loadUsers,
  contactFields: loadContactFields,
  contactChangeFields: loadContactChangeFields,
  customFields: loadCustomFields,
  calendars: loadCalendars,
  forms: loadForms,
  whatsappNumbers: loadWhatsAppNumbers,
  whatsappTemplates: loadWhatsAppTemplates,
  campaigns: loadCampaigns,
  adsets: loadAdsets,
  links: loadTriggerLinks,
  products: loadProducts,
  ads: loadAds,
  adIds: loadAdIds,
  messengerPages: loadMessengerPages,
  instagramAccounts: loadInstagramAccounts,
  automations: loadAutomations
}

const fallbacks: Partial<Record<CatalogKind, CatalogOption[]>> = {
  tags: [],
  users: [],
  contactFields: STANDARD_CONTACT_FIELDS,
  contactChangeFields: STANDARD_CONTACT_CHANGE_FIELDS,
  customFields: [],
  calendars: [],
  forms: [],
  links: [],
  whatsappNumbers: [],
  whatsappTemplates: [],
  campaigns: [],
  adsets: [],
  products: [],
  ads: [],
  adIds: [],
  messengerPages: [],
  instagramAccounts: [],
  automations: []
}

const cache = new Map<CatalogKind, Promise<CatalogOption[]>>()

export function getCatalog(kind: CatalogKind): Promise<CatalogOption[]> {
  syncAuthScopedCachePrincipal()
  if (!cache.has(kind)) {
    const promise = loaders[kind]()
      .then((loaded) => {
        if (kind === 'whatsappTemplates' && loaded.length === 0) {
          if (cache.get(kind) === promise) cache.delete(kind)
        }
        return loaded
      })
      .catch(() => {
        if (cache.get(kind) === promise) cache.delete(kind)
        return fallbacks[kind] || []
      })
    cache.set(kind, promise)
  }
  return cache.get(kind) as Promise<CatalogOption[]>
}

/** Limpia la caché (p. ej. al entrar de nuevo al editor) */
export function resetCatalogCache() {
  cache.clear()
  formFieldCache.clear()
  rawTemplatesCache = null
  rawTemplatesPromise = null
}

registerAuthScopedCacheInvalidator(resetCatalogCache)
