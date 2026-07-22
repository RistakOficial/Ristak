import { createHash } from 'node:crypto'

import {
  createBlockHandler,
  createSiteHandler,
  createSitesPublicDomainHandler,
  deleteBlockHandler,
  deleteSiteContentAssetHandler,
  deleteSiteHandler,
  getImportedSiteMappingHandler,
  getSiteContentAssetsHandler,
  getSiteHandler,
  getSitesDomainHandler,
  getSitesHandler,
  importSiteHtmlHandler,
  previewSiteHandler,
  removeSitesPublicDomainByIdHandler,
  reorderBlocksHandler,
  restoreBlocksHandler,
  saveSiteContentAssetHandler,
  setSitesPublicDomainDefaultRouteHandler,
  updateBlockHandler,
  updateImportedSiteCodeFilesHandler,
  updateImportedSiteFieldMappingHandler,
  updateSiteHandler,
  verifySitesPublicDomainByIdHandler
} from '../controllers/sitesController.js'
import { hasFeature, isLicenseEnforced } from '../services/licenseService.js'
import { BLOCK_TYPES } from '../services/sitesService.js'

const MAX_IMPORTED_HTML_CHARS = 2 * 1024 * 1024
const MAX_CODE_FILE_CHARS = 2 * 1024 * 1024
const MAX_CODE_UPDATE_BYTES = Math.floor(2.5 * 1024 * 1024)
const MAX_STRUCTURED_BODY_BYTES = 1024 * 1024

const SITE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 180,
  pattern: '^[A-Za-z0-9_-]+$'
}

const DOMAIN_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 180,
  pattern: '^[A-Za-z0-9_-]+$'
}

const PAGE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 180,
  pattern: '^[A-Za-z0-9_-]+$'
}

const IDEMPOTENCY_KEY_SCHEMA = {
  type: 'string',
  minLength: 8,
  maxLength: 180,
  pattern: '^[A-Za-z0-9._:-]+$'
}

const CONFIRM_SCHEMA = {
  type: 'boolean',
  description: 'Debe ser true después de confirmar esta acción con la persona usuaria.'
}

const STRUCTURED_OBJECT_SCHEMA = {
  type: 'object',
  maxProperties: 200,
  additionalProperties: true
}

const BLOCK_TYPE_VALUES = [...BLOCK_TYPES].sort()

const BLOCK_INPUT_PROPERTIES = {
  blockType: { type: 'string', enum: BLOCK_TYPE_VALUES },
  label: { type: 'string', maxLength: 300 },
  content: { type: 'string', maxLength: 500000 },
  placeholder: { type: 'string', maxLength: 500 },
  required: { type: 'boolean' },
  options: {
    type: 'array',
    maxItems: 100,
    items: STRUCTURED_OBJECT_SCHEMA
  },
  settings: STRUCTURED_OBJECT_SCHEMA,
  sortOrder: { type: 'integer', minimum: 0, maximum: 10000 }
}

function makeInputSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  }
}

function writeControls({ confirmRequired = false } = {}) {
  return {
    idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
    ...(confirmRequired ? { confirm: CONFIRM_SCHEMA } : {})
  }
}

function writeRequirements(required = [], { confirmRequired = false } = {}) {
  return [...required, 'idempotencyKey', ...(confirmRequired ? ['confirm'] : [])]
}

function spec(definition) {
  return Object.freeze({
    module: 'sites',
    featureKeys: ['sites'],
    confirmRequired: false,
    idempotencyRequired: false,
    ...definition
  })
}

function call(context, handler, request = {}) {
  if (typeof context?.invoke !== 'function') {
    const error = new Error('El contexto MCP no puede ejecutar acciones de Ristak.')
    error.code = 'mcp_controller_invoker_unavailable'
    throw error
  }
  return context.invoke(handler, request)
}

function dataFrom(response) {
  return response?.data ?? response
}

function revisionString(value) {
  if (value instanceof Date) return value.toISOString()
  return String(value || '')
}

function importedCodeRevision(imported = {}) {
  const hash = createHash('sha256')
  const files = Array.isArray(imported.codeFiles) ? [...imported.codeFiles] : []
  files.sort((left, right) => String(left?.path || '').localeCompare(String(right?.path || '')))
  for (const file of files) {
    const path = String(file?.path || '')
    const content = String(file?.content || '')
    hash.update(String(Buffer.byteLength(path, 'utf8')))
    hash.update(':')
    hash.update(path)
    hash.update(':')
    hash.update(String(Buffer.byteLength(content, 'utf8')))
    hash.update(':')
    hash.update(content)
    hash.update('\n')
  }
  return `sha256:${hash.digest('hex')}`
}

function assertBooleanConfirmation(args = {}) {
  if (args.confirm === true) return
  const error = new Error('Esta acción requiere confirmación explícita (confirm=true).')
  error.status = 400
  error.code = 'confirmation_required'
  throw error
}

function assertStructuredBodySize(value, label) {
  if (value === undefined) return
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes <= MAX_STRUCTURED_BODY_BYTES) return
  const error = new Error(`${label} supera el límite de 1 MB.`)
  error.status = 413
  error.code = 'payload_too_large'
  throw error
}

function assertCodeUpdateSize(files = []) {
  const paths = new Set()
  let totalBytes = 0
  for (const file of files) {
    const path = String(file?.path ?? '')
    if (paths.has(path)) {
      const error = new Error(`El archivo "${path || 'principal'}" aparece más de una vez.`)
      error.status = 400
      error.code = 'duplicate_code_file'
      throw error
    }
    paths.add(path)
    totalBytes += Buffer.byteLength(String(file?.content ?? ''), 'utf8')
  }
  if (totalBytes <= MAX_CODE_UPDATE_BYTES) return
  const error = new Error('La edición conjunta de código supera el límite de 12 MB.')
  error.status = 413
  error.code = 'payload_too_large'
  throw error
}

function containsPaymentFeature(value, depth = 0) {
  if (!value || depth > 8) return false
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    return /data-(?:rstk|ristak|ristack)-(?:native-element|element|element-type|component|widget)\s*=\s*(?:"payment"|'payment'|payment(?:\s|>))/.test(normalized) ||
      normalized.includes('data-rstk-payment-gate') ||
      normalized.includes('site-payment-checkout')
  }
  if (Array.isArray(value)) return value.some((entry) => containsPaymentFeature(entry, depth + 1))
  if (typeof value !== 'object') return false

  const type = String(value.type || value.blockType || value.elementType || value.nativeElement || value.kind || '')
    .trim()
    .toLowerCase()
  if (['payment', 'checkout', 'payment-gate', 'payment_gate'].includes(type)) return true

  const paymentGate = value.paymentGate || value.payment_gate || value.checkout || value.paymentCheckout
  if (paymentGate && typeof paymentGate === 'object' && (
    paymentGate.enabled === true ||
    paymentGate.required === true ||
    paymentGate.collectPayment === true ||
    paymentGate.collect_payment === true
  )) return true

  return Object.entries(value).some(([key, entryValue]) => {
    const normalizedKey = key.toLowerCase()
    if ((normalizedKey.includes('payment') || normalizedKey.includes('checkout')) && entryValue === true) return true
    return containsPaymentFeature(entryValue, depth + 1)
  })
}

async function assertConditionalPaymentFeature(context, value) {
  if (!containsPaymentFeature(value) || !isLicenseEnforced()) return
  if (await hasFeature('payment_checkout', { state: context?.license || null })) return
  const error = new Error('El contenido de pago de Sites no está incluido en el plan actual.')
  error.status = 403
  error.code = 'feature_not_available'
  error.feature = 'payment_checkout'
  throw error
}

function compactCodeFile(file = {}, includeContent = false) {
  return {
    path: file.path || '',
    label: file.label || '',
    pageId: file.pageId || '',
    pageTitle: file.pageTitle || '',
    contentType: file.contentType || '',
    language: file.language || '',
    sizeBytes: Number(file.sizeBytes || 0),
    updatedAt: revisionString(file.updatedAt),
    role: file.role || '',
    ...(includeContent ? { content: String(file.content || '') } : {})
  }
}

function compactImportedCodeResponse(response, { path, includeContent = false } = {}) {
  const payload = dataFrom(response) || {}
  const imported = payload.import || payload
  const files = Array.isArray(imported.codeFiles) ? imported.codeFiles : []
  const filteredFiles = path === undefined
    ? files
    : files.filter((file) => String(file?.path || '') === String(path || ''))

  if (path !== undefined && filteredFiles.length === 0) {
    const error = new Error(`El archivo "${path || 'principal'}" no existe o no se puede editar como código.`)
    error.status = 404
    error.code = 'site_code_file_not_found'
    throw error
  }

  return {
    success: true,
    data: {
      siteId: imported.siteId || payload.site?.id || '',
      importId: imported.id || '',
      importType: imported.importType || '',
      status: imported.status || '',
      revision: importedCodeRevision(imported),
      updatedAt: revisionString(imported.updatedAt),
      securityReport: Array.isArray(imported.securityReport) ? imported.securityReport : [],
      files: filteredFiles.map((file) => compactCodeFile(file, includeContent || path !== undefined))
    }
  }
}

function compactImportMappingResponse(response) {
  const imported = dataFrom(response) || {}
  return {
    success: true,
    data: {
      id: imported.id || '',
      siteId: imported.siteId || '',
      originalFilename: imported.originalFilename || '',
      importType: imported.importType || '',
      status: imported.status || '',
      revision: revisionString(imported.updatedAt),
      detectedForms: Array.isArray(imported.detectedForms) ? imported.detectedForms : [],
      formMappings: Array.isArray(imported.formMappings) ? imported.formMappings : [],
      securityReport: Array.isArray(imported.securityReport) ? imported.securityReport : []
    }
  }
}

function siteUpdateBody(args = {}) {
  const body = {}
  for (const key of [
    'name',
    'slug',
    'siteType',
    'title',
    'description',
    'theme',
    'antiTrackingEnabled',
    'metaCapiEnabled',
    'metaEventName'
  ]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) body[key] = args[key]
  }
  return body
}

function blockBody(args = {}) {
  const body = {}
  for (const key of Object.keys(BLOCK_INPUT_PROPERTIES)) {
    if (Object.prototype.hasOwnProperty.call(args, key)) body[key] = args[key]
  }
  return body
}

const dangerousControlProperties = writeControls({ confirmRequired: true })

export const siteToolSpecs = Object.freeze([
  spec({
    name: 'sites_list',
    description: 'Lista Sites, formularios y landings con paginación acotada. No incluye HTML ni submissions.',
    inputSchema: makeInputSchema({
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string', maxLength: 600 },
      search: { type: 'string', maxLength: 160 },
      view: { type: 'string', enum: ['library', 'landing_library', 'form_library', 'analytics_selector'] },
      siteType: { type: 'string', enum: ['sites', 'forms', 'videos'] },
      landingMode: { type: 'string', maxLength: 80 }
    }),
    access: 'read',
    scope: 'ristak.read',
    risk: 'low',
    async execute(context, args) {
      return call(context, getSitesHandler, {
        method: 'GET',
        query: {
          paginated: 'true',
          limit: args.limit,
          cursor: args.cursor,
          search: args.search,
          view: args.view,
          siteType: args.siteType,
          landingMode: args.landingMode,
          includeFacets: 'false'
        }
      })
    }
  }),
  spec({
    name: 'sites_get',
    description: 'Obtiene un Site con sus bloques. Por defecto omite submissions y estadísticas pesadas.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      includeTrackingStats: { type: 'boolean' }
    }, ['siteId']),
    access: 'read',
    scope: 'ristak.read',
    risk: 'low',
    async execute(context, args) {
      return call(context, getSiteHandler, {
        method: 'GET',
        params: { siteId: args.siteId },
        query: {
          includeSubmissions: '0',
          includeTrackingStats: args.includeTrackingStats ? '1' : '0'
        }
      })
    }
  }),
  spec({
    name: 'sites_create_draft',
    description: 'Crea un Site vacío o basado en plantilla, siempre como borrador. Nunca lo publica automáticamente.',
    inputSchema: makeInputSchema({
      name: { type: 'string', minLength: 1, maxLength: 100 },
      slug: { type: 'string', maxLength: 140 },
      siteType: { type: 'string', enum: ['standard_form', 'interactive_form', 'landing_page'] },
      title: { type: 'string', maxLength: 160 },
      description: { type: 'string', maxLength: 2000 },
      theme: STRUCTURED_OBJECT_SCHEMA,
      blankCanvas: { type: 'boolean' },
      ...writeControls()
    }, writeRequirements(['name'])),
    access: 'write',
    scope: 'ristak.write',
    risk: 'medium',
    idempotencyRequired: true,
    async execute(context, args) {
      assertStructuredBodySize(args.theme, 'El tema')
      await assertConditionalPaymentFeature(context, args.theme)
      return call(context, createSiteHandler, {
        method: 'POST',
        body: {
          name: args.name,
          slug: args.slug,
          siteType: args.siteType || 'landing_page',
          title: args.title,
          description: args.description,
          theme: args.theme,
          blankCanvas: args.blankCanvas,
          status: 'draft'
        }
      })
    }
  }),
  spec({
    name: 'sites_import_html',
    description: 'Importa un documento HTML, lo sanitiza con el pipeline de Sites y crea un borrador. No acepta ZIP ni publica.',
    inputSchema: makeInputSchema({
      name: { type: 'string', minLength: 1, maxLength: 100 },
      filename: { type: 'string', minLength: 1, maxLength: 180 },
      slug: { type: 'string', maxLength: 140 },
      title: { type: 'string', maxLength: 160 },
      description: { type: 'string', maxLength: 2000 },
      siteType: { type: 'string', enum: ['standard_form', 'interactive_form', 'landing_page'] },
      html: { type: 'string', minLength: 1, maxLength: MAX_IMPORTED_HTML_CHARS },
      ...writeControls()
    }, writeRequirements(['name', 'html'])),
    access: 'write',
    scope: 'ristak.write',
    risk: 'medium',
    idempotencyRequired: true,
    async execute(context, args) {
      await assertConditionalPaymentFeature(context, args.html)
      const filename = String(args.filename || 'pagina.html')
      if (!/\.html?$/i.test(filename)) {
        const error = new Error('filename debe terminar en .html o .htm.')
        error.status = 400
        error.code = 'invalid_html_filename'
        throw error
      }
      return call(context, importSiteHtmlHandler, {
        method: 'POST',
        body: {
          name: args.name,
          filename,
          slug: args.slug,
          title: args.title,
          description: args.description,
          siteType: args.siteType || 'landing_page',
          html: args.html
        }
      })
    }
  }),
  spec({
    name: 'sites_get_code',
    description: 'Lee el inventario de archivos editables de un Site HTML. Envía path para obtener el contenido de un archivo concreto.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      path: { type: 'string', maxLength: 500 },
      includeContent: { type: 'boolean' }
    }, ['siteId']),
    access: 'read',
    scope: 'ristak.read',
    risk: 'low',
    async execute(context, args) {
      const response = await call(context, getImportedSiteMappingHandler, {
        method: 'GET',
        params: { siteId: args.siteId }
      })
      return compactImportedCodeResponse(response, {
        ...(Object.prototype.hasOwnProperty.call(args, 'path') ? { path: args.path } : {}),
        includeContent: args.includeContent === true
      })
    }
  }),
  spec({
    name: 'sites_update_code',
    description: 'Reemplaza archivos editables de un Site HTML mediante el sanitizador canónico. expectedRevision evita sobreescribir una versión ya observada, pero la publicación sigue siendo una acción separada.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      expectedRevision: {
        type: 'string',
        minLength: 71,
        maxLength: 71,
        pattern: '^sha256:[a-f0-9]{64}$'
      },
      files: {
        type: 'array',
        minItems: 1,
        maxItems: 25,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', maxLength: 500 },
            content: { type: 'string', maxLength: MAX_CODE_FILE_CHARS }
          },
          required: ['path', 'content'],
          additionalProperties: false
        }
      },
      ...dangerousControlProperties
    }, writeRequirements(['siteId', 'expectedRevision', 'files'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      assertCodeUpdateSize(args.files)
      await assertConditionalPaymentFeature(context, args.files)

      const currentResponse = await call(context, getImportedSiteMappingHandler, {
        method: 'GET',
        params: { siteId: args.siteId }
      })
      const currentImport = dataFrom(currentResponse) || {}
      const currentRevision = importedCodeRevision(currentImport)
      if (currentRevision !== String(args.expectedRevision || '')) {
        const error = new Error('El código cambió desde la última lectura. Vuelve a ejecutar sites_get_code antes de guardar.')
        error.status = 409
        error.code = 'site_code_revision_conflict'
        error.currentRevision = currentRevision
        throw error
      }

      const response = await call(context, updateImportedSiteCodeFilesHandler, {
        method: 'PATCH',
        params: { siteId: args.siteId },
        body: { files: args.files }
      })
      return compactImportedCodeResponse(response)
    }
  }),
  spec({
    name: 'sites_get_import_mapping',
    description: 'Obtiene formularios detectados, mapeo de campos y reporte de seguridad de un Site HTML sin duplicar su código.',
    inputSchema: makeInputSchema({ siteId: SITE_ID_SCHEMA }, ['siteId']),
    access: 'read',
    scope: 'ristak.read',
    risk: 'low',
    async execute(context, args) {
      const response = await call(context, getImportedSiteMappingHandler, {
        method: 'GET',
        params: { siteId: args.siteId }
      })
      return compactImportMappingResponse(response)
    }
  }),
  spec({
    name: 'sites_update_field_mapping',
    description: 'Cambia el destino de un campo detectado en un formulario HTML. Puede modificar cómo se guardan submissions reales.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      formId: { type: 'string', minLength: 1, maxLength: 180 },
      fieldId: { type: 'string', minLength: 1, maxLength: 180 },
      pagePath: { type: 'string', maxLength: 500 },
      destinationType: { type: 'string', enum: ['standard', 'ignored', 'custom', 'new_custom'] },
      destinationKey: { type: 'string', maxLength: 180 },
      customFieldDefinitionId: { type: 'string', maxLength: 180 },
      ...dangerousControlProperties
    }, writeRequirements(['siteId', 'formId', 'fieldId', 'destinationType'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      const response = await call(context, updateImportedSiteFieldMappingHandler, {
        method: 'PATCH',
        params: { siteId: args.siteId },
        body: {
          formId: args.formId,
          fieldId: args.fieldId,
          pagePath: args.pagePath,
          destinationType: args.destinationType,
          destinationKey: args.destinationKey,
          customFieldDefinitionId: args.customFieldDefinitionId
        }
      })
      return compactImportMappingResponse(response)
    }
  }),
  spec({
    name: 'sites_list_content_assets',
    description: 'Lista las asociaciones de Media usadas por zonas declaradas dentro de un Site HTML.',
    inputSchema: makeInputSchema({ siteId: SITE_ID_SCHEMA }, ['siteId']),
    access: 'read',
    scope: 'ristak.read',
    risk: 'low',
    async execute(context, args) {
      return call(context, getSiteContentAssetsHandler, {
        method: 'GET',
        params: { siteId: args.siteId }
      })
    }
  }),
  spec({
    name: 'sites_save_content_asset',
    description: 'Crea o reemplaza la asociación entre una zona de contenido HTML y un archivo público ya existente en Media.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      bindingId: { type: 'string', maxLength: 180 },
      mediaAssetId: { type: 'string', minLength: 1, maxLength: 180 },
      assetKey: { type: 'string', maxLength: 80 },
      label: { type: 'string', maxLength: 300 },
      kind: { type: 'string', enum: ['image', 'audio', 'video', 'document', 'other'] },
      ...dangerousControlProperties
    }, writeRequirements(['siteId', 'mediaAssetId'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      return call(context, saveSiteContentAssetHandler, {
        method: args.bindingId ? 'PUT' : 'POST',
        params: { siteId: args.siteId, ...(args.bindingId ? { bindingId: args.bindingId } : {}) },
        body: {
          mediaAssetId: args.mediaAssetId,
          assetKey: args.assetKey,
          label: args.label,
          kind: args.kind
        }
      })
    }
  }),
  spec({
    name: 'sites_delete_content_asset',
    description: 'Quita una asociación de contenido de un Site. No elimina el archivo original de Media.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      bindingId: { type: 'string', minLength: 1, maxLength: 180 },
      ...dangerousControlProperties
    }, writeRequirements(['siteId', 'bindingId'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.destructive',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      return call(context, deleteSiteContentAssetHandler, {
        method: 'DELETE',
        params: { siteId: args.siteId, bindingId: args.bindingId }
      })
    }
  }),
  spec({
    name: 'sites_preview_html',
    description: 'Renderiza el HTML de preview sin tracking ni cobros reales. Devuelve el documento directamente al cliente MCP y no crea una URL pública.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      pageId: PAGE_ID_SCHEMA
    }, ['siteId']),
    access: 'read',
    scope: 'ristak.read',
    risk: 'low',
    async execute(context, args) {
      const html = await call(context, previewSiteHandler, {
        method: 'POST',
        params: { siteId: args.siteId },
        query: { page: args.pageId },
        body: { pageId: args.pageId }
      })
      return { success: true, data: { html } }
    }
  }),
  spec({
    name: 'sites_update',
    description: 'Actualiza la configuración editable de un Site sin cambiar su estado de publicación. Los cambios pueden verse inmediatamente si ya está publicado.',
    inputSchema: {
      ...makeInputSchema({
        siteId: SITE_ID_SCHEMA,
        name: { type: 'string', maxLength: 100 },
        slug: { type: 'string', maxLength: 140 },
        siteType: { type: 'string', enum: ['standard_form', 'interactive_form', 'landing_page'] },
        title: { type: 'string', maxLength: 160 },
        description: { type: 'string', maxLength: 2000 },
        theme: STRUCTURED_OBJECT_SCHEMA,
        antiTrackingEnabled: { type: 'boolean' },
        metaCapiEnabled: { type: 'boolean' },
        metaEventName: { type: 'string', maxLength: 80 },
        ...dangerousControlProperties
      }, writeRequirements(['siteId'], { confirmRequired: true })),
      anyOf: [
        { required: ['name'] },
        { required: ['slug'] },
        { required: ['siteType'] },
        { required: ['title'] },
        { required: ['description'] },
        { required: ['theme'] },
        { required: ['antiTrackingEnabled'] },
        { required: ['metaCapiEnabled'] },
        { required: ['metaEventName'] }
      ]
    },
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      const body = siteUpdateBody(args)
      assertStructuredBodySize(body.theme, 'El tema')
      await assertConditionalPaymentFeature(context, body)
      return call(context, updateSiteHandler, {
        method: 'PUT',
        params: { siteId: args.siteId },
        body
      })
    }
  }),
  ...[
    {
      name: 'sites_publish',
      description: 'Publica el Site. No crea ni modifica dominios.',
      status: 'published',
      scope: 'ristak.execute',
      risk: 'high'
    },
    {
      name: 'sites_unpublish',
      description: 'Retira el Site de publicación y lo devuelve a borrador.',
      status: 'draft',
      scope: 'ristak.destructive',
      risk: 'high'
    },
    {
      name: 'sites_archive',
      description: 'Archiva el Site y lo retira de su flujo activo.',
      status: 'archived',
      scope: 'ristak.destructive',
      risk: 'high'
    }
  ].map((stateTool) => spec({
    name: stateTool.name,
    description: stateTool.description,
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      ...dangerousControlProperties
    }, writeRequirements(['siteId'], { confirmRequired: true })),
    access: 'write',
    scope: stateTool.scope,
    risk: stateTool.risk,
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      return call(context, updateSiteHandler, {
        method: 'PUT',
        params: { siteId: args.siteId },
        body: { status: stateTool.status }
      })
    }
  })),
  spec({
    name: 'sites_delete',
    description: 'Elimina permanentemente el Site, sus bloques y su importación. Los archivos de Media asociados siguen la limpieza canónica de Sites.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      ...dangerousControlProperties
    }, writeRequirements(['siteId'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.destructive',
    risk: 'critical',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      return call(context, deleteSiteHandler, {
        method: 'DELETE',
        params: { siteId: args.siteId }
      })
    }
  }),
  spec({
    name: 'sites_create_block',
    description: 'Agrega un bloque al Site. Si el Site está publicado, el cambio puede verse en vivo.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      ...BLOCK_INPUT_PROPERTIES,
      ...dangerousControlProperties
    }, writeRequirements(['siteId', 'blockType'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      const body = blockBody(args)
      assertStructuredBodySize({ options: body.options, settings: body.settings }, 'La configuración del bloque')
      await assertConditionalPaymentFeature(context, body)
      return call(context, createBlockHandler, {
        method: 'POST',
        params: { siteId: args.siteId },
        body
      })
    }
  }),
  spec({
    name: 'sites_update_block',
    description: 'Actualiza un bloque existente. Si el Site está publicado, el cambio puede verse en vivo.',
    inputSchema: {
      ...makeInputSchema({
        siteId: SITE_ID_SCHEMA,
        blockId: SITE_ID_SCHEMA,
        ...BLOCK_INPUT_PROPERTIES,
        ...dangerousControlProperties
      }, writeRequirements(['siteId', 'blockId'], { confirmRequired: true })),
      anyOf: Object.keys(BLOCK_INPUT_PROPERTIES).map((key) => ({ required: [key] }))
    },
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      const body = blockBody(args)
      assertStructuredBodySize({ options: body.options, settings: body.settings }, 'La configuración del bloque')
      await assertConditionalPaymentFeature(context, body)
      return call(context, updateBlockHandler, {
        method: 'PUT',
        params: { siteId: args.siteId, blockId: args.blockId },
        body
      })
    }
  }),
  spec({
    name: 'sites_delete_block',
    description: 'Elimina un bloque. Si es una sección, la limpieza canónica también puede retirar sus bloques hijos.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      blockId: SITE_ID_SCHEMA,
      ...dangerousControlProperties
    }, writeRequirements(['siteId', 'blockId'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.destructive',
    risk: 'critical',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      return call(context, deleteBlockHandler, {
        method: 'DELETE',
        params: { siteId: args.siteId, blockId: args.blockId }
      })
    }
  }),
  spec({
    name: 'sites_restore_blocks',
    description: 'Restaura una colección acotada de bloques con el mismo flujo de deshacer del editor.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      blocks: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          properties: {
            id: SITE_ID_SCHEMA,
            ...BLOCK_INPUT_PROPERTIES,
            createdAt: { type: 'string', maxLength: 80 }
          },
          required: ['blockType'],
          additionalProperties: false
        }
      },
      ...dangerousControlProperties
    }, writeRequirements(['siteId', 'blocks'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      assertStructuredBodySize(args.blocks, 'Los bloques')
      await assertConditionalPaymentFeature(context, args.blocks)
      return call(context, restoreBlocksHandler, {
        method: 'POST',
        params: { siteId: args.siteId },
        body: { blocks: args.blocks }
      })
    }
  }),
  spec({
    name: 'sites_reorder_blocks',
    description: 'Reordena bloques existentes dentro del Site o de una página concreta.',
    inputSchema: makeInputSchema({
      siteId: SITE_ID_SCHEMA,
      pageId: PAGE_ID_SCHEMA,
      blockIds: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        uniqueItems: true,
        items: SITE_ID_SCHEMA
      },
      ...dangerousControlProperties
    }, writeRequirements(['siteId', 'blockIds'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      return call(context, reorderBlocksHandler, {
        method: 'PUT',
        params: { siteId: args.siteId },
        body: { blockIds: args.blockIds, pageId: args.pageId }
      })
    }
  }),
  spec({
    name: 'sites_get_domains',
    description: 'Consulta únicamente configuración no secreta de dominios públicos, verificación y rutas predeterminadas de Sites.',
    inputSchema: makeInputSchema({}),
    access: 'read',
    scope: 'ristak.read',
    risk: 'low',
    async execute(context) {
      return call(context, getSitesDomainHandler, { method: 'GET' })
    }
  }),
  spec({
    name: 'sites_add_public_domain',
    description: 'Verifica y agrega un dominio público de Sites. No modifica DNS ni crea secrets.',
    inputSchema: makeInputSchema({
      domain: {
        type: 'string',
        minLength: 1,
        maxLength: 253,
        pattern: '^[A-Za-z0-9.-]+$'
      },
      siteId: SITE_ID_SCHEMA,
      pageId: PAGE_ID_SCHEMA,
      ...dangerousControlProperties
    }, writeRequirements(['domain'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      return call(context, createSitesPublicDomainHandler, {
        method: 'POST',
        body: { domain: args.domain, siteId: args.siteId, pageId: args.pageId }
      })
    }
  }),
  spec({
    name: 'sites_verify_public_domain',
    description: 'Revalida que un dominio público existente apunta a esta instalación y guarda el diagnóstico no secreto.',
    inputSchema: makeInputSchema({
      domainId: DOMAIN_ID_SCHEMA,
      ...dangerousControlProperties
    }, writeRequirements(['domainId'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.execute',
    risk: 'medium',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      return call(context, verifySitesPublicDomainByIdHandler, {
        method: 'POST',
        params: { domainId: args.domainId }
      })
    }
  }),
  spec({
    name: 'sites_set_domain_default_route',
    description: 'Cambia qué Site o página abre en la raíz de un dominio público.',
    inputSchema: makeInputSchema({
      domainId: DOMAIN_ID_SCHEMA,
      siteId: SITE_ID_SCHEMA,
      pageId: PAGE_ID_SCHEMA,
      ...dangerousControlProperties
    }, writeRequirements(['domainId', 'siteId'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      return call(context, setSitesPublicDomainDefaultRouteHandler, {
        method: 'POST',
        params: { domainId: args.domainId },
        body: { siteId: args.siteId, pageId: args.pageId }
      })
    }
  }),
  spec({
    name: 'sites_remove_public_domain',
    description: 'Desconecta un dominio público de Sites dentro de Ristak. No cambia ni elimina registros DNS del proveedor.',
    inputSchema: makeInputSchema({
      domainId: DOMAIN_ID_SCHEMA,
      ...dangerousControlProperties
    }, writeRequirements(['domainId'], { confirmRequired: true })),
    access: 'write',
    scope: 'ristak.destructive',
    risk: 'critical',
    confirmRequired: true,
    idempotencyRequired: true,
    async execute(context, args) {
      assertBooleanConfirmation(args)
      return call(context, removeSitesPublicDomainByIdHandler, {
        method: 'DELETE',
        params: { domainId: args.domainId }
      })
    }
  })
])

export default siteToolSpecs
