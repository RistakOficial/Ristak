import crypto from 'node:crypto'
import { db } from '../config/database.js'
import { hasFeature, hasModuleFeature, isLicenseEnforced } from '../services/licenseService.js'
import { hasUserAccess } from '../utils/userAccess.js'
import { hasGrantedScope } from '../utils/oauthTokens.js'
import { logger } from '../utils/logger.js'
import { getMissingMcpConnectionPrerequisites } from '../services/mcpConnectionPrerequisitesService.js'
import {
  acknowledgeMcpBusinessEvents,
  listMcpBusinessEvents
} from '../services/mcpEventInboxService.js'
import {
  consumeMcpActionConfirmation,
  createMcpActionConfirmation,
  getMcpActionConfirmationStatus,
  stripMcpActionControls
} from '../services/mcpActionConfirmationService.js'
import { domainToolSpecs } from './domainTools.js'
import { extendedToolSpecs } from './extendedTools.js'
import { siteToolSpecs } from './siteTools.js'
import { capabilityToolSpecs } from './capabilityTools.js'

const SECRET_KEY_PATTERN = /(token|secret|password|authorization|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|database[_-]?url|encrypted|hash|cookie|idempotency)/i
const AUDIT_SECRET_KEY_PATTERN = /(token|secret|password|authorization|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|database[_-]?url|encrypted|hash|cookie|idempotency|approval[_-]?ticket|file[_-]?base64|data[_-]?url|bytes[_-]?base64)/i
const MAX_AUDIT_STRING_LENGTH = 2000
const MAX_AUDIT_JSON_LENGTH = 24000
const MAX_IDEMPOTENCY_RESULT_LENGTH = 2 * 1024 * 1024
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const EPHEMERAL_IDEMPOTENCY_RESULT = Object.freeze({
  __ristakMcpReplayUnavailable: true,
  reason: 'ephemeral'
})

function makeError(message, code, status = 400, details = null) {
  const error = new Error(message)
  error.code = code
  error.status = status
  if (details) error.details = details
  return error
}

function matchesJsonType(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function validateSchemaValue(value, inputSchema = {}, path = 'arguments') {
  if (!inputSchema || typeof inputSchema !== 'object') return
  const types = Array.isArray(inputSchema.type)
    ? inputSchema.type
    : inputSchema.type ? [inputSchema.type] : []
  if (types.length && !types.some((type) => matchesJsonType(value, type))) {
    throw makeError(`${path} debe ser ${types.join(' o ')}.`, 'invalid_arguments', 400)
  }
  if (Array.isArray(inputSchema.enum) && !inputSchema.enum.includes(value)) {
    throw makeError(`${path} tiene un valor no permitido.`, 'invalid_arguments', 400)
  }
  if (typeof value === 'string') {
    if (inputSchema.minLength !== undefined && value.length < inputSchema.minLength) {
      throw makeError(`${path} es demasiado corto.`, 'invalid_arguments', 400)
    }
    if (inputSchema.maxLength !== undefined && value.length > inputSchema.maxLength) {
      throw makeError(`${path} supera el tamaño permitido.`, 'invalid_arguments', 400)
    }
    if (inputSchema.pattern && !(new RegExp(inputSchema.pattern).test(value))) {
      throw makeError(`${path} no tiene el formato esperado.`, 'invalid_arguments', 400)
    }
  }
  if (typeof value === 'number') {
    if (inputSchema.minimum !== undefined && value < inputSchema.minimum) {
      throw makeError(`${path} es menor al mínimo permitido.`, 'invalid_arguments', 400)
    }
    if (inputSchema.maximum !== undefined && value > inputSchema.maximum) {
      throw makeError(`${path} supera el máximo permitido.`, 'invalid_arguments', 400)
    }
    if (inputSchema.exclusiveMinimum !== undefined && value <= inputSchema.exclusiveMinimum) {
      throw makeError(`${path} debe ser mayor a ${inputSchema.exclusiveMinimum}.`, 'invalid_arguments', 400)
    }
  }
  if (Array.isArray(value)) {
    if (inputSchema.minItems !== undefined && value.length < inputSchema.minItems) {
      throw makeError(`${path} necesita al menos ${inputSchema.minItems} elemento(s).`, 'invalid_arguments', 400)
    }
    if (inputSchema.maxItems !== undefined && value.length > inputSchema.maxItems) {
      throw makeError(`${path} supera ${inputSchema.maxItems} elemento(s).`, 'invalid_arguments', 400)
    }
    value.forEach((entry, index) => validateSchemaValue(entry, inputSchema.items || {}, `${path}[${index}]`))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = inputSchema.properties || {}
    for (const requiredKey of inputSchema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, requiredKey) || value[requiredKey] === undefined) {
        throw makeError(`${path}.${requiredKey} es requerido.`, 'invalid_arguments', 400)
      }
    }
    if (inputSchema.maxProperties !== undefined && Object.keys(value).length > inputSchema.maxProperties) {
      throw makeError(`${path} contiene demasiados campos.`, 'invalid_arguments', 400)
    }
    if (inputSchema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.prototype.hasOwnProperty.call(properties, key))
      if (unknown) throw makeError(`${path}.${unknown} no está permitido.`, 'invalid_arguments', 400)
    }
    for (const [key, entryValue] of Object.entries(value)) {
      const propertySchema = properties[key]
      if (propertySchema) validateSchemaValue(entryValue, propertySchema, `${path}.${key}`)
      else if (inputSchema.additionalProperties && typeof inputSchema.additionalProperties === 'object') {
        validateSchemaValue(entryValue, inputSchema.additionalProperties, `${path}.${key}`)
      }
    }
    if (Array.isArray(inputSchema.anyOf) && !inputSchema.anyOf.some((option) => (
      (option.required || []).every((key) => Object.prototype.hasOwnProperty.call(value, key))
    ))) {
      throw makeError(`${path} no incluye ningún cambio válido.`, 'invalid_arguments', 400)
    }
  }
}

function sanitizeExternal(value, key = '', depth = 0) {
  if (SECRET_KEY_PATTERN.test(String(key || ''))) return '[redacted]'
  if (depth > 12) return '[truncated]'
  if (typeof value === 'string') {
    return value.length > MAX_AUDIT_STRING_LENGTH
      ? `${value.slice(0, MAX_AUDIT_STRING_LENGTH)}…`
      : value
  }
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeExternal(item, '', depth + 1))
  return Object.fromEntries(
    Object.entries(value).slice(0, 300).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeExternal(entryValue, entryKey, depth + 1)
    ])
  )
}

function sanitizeAuditInput(value, key = '', depth = 0) {
  if (AUDIT_SECRET_KEY_PATTERN.test(String(key || ''))) return '[redacted]'
  if (depth > 12) return '[truncated]'
  if (typeof value === 'string') {
    return value.length > MAX_AUDIT_STRING_LENGTH
      ? `${value.slice(0, MAX_AUDIT_STRING_LENGTH)}…`
      : value
  }
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeAuditInput(item, '', depth + 1))
  return Object.fromEntries(
    Object.entries(value).slice(0, 300).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeAuditInput(entryValue, entryKey, depth + 1)
    ])
  )
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  )
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function safeJson(value, maxLength = MAX_AUDIT_JSON_LENGTH) {
  try {
    const serialized = JSON.stringify(value)
    return serialized.length <= maxLength
      ? serialized
      : JSON.stringify({ truncated: true, bytes: Buffer.byteLength(serialized, 'utf8') })
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

function sanitizeErrorMessage(value) {
  return String(value || '')
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:access_token|refresh_token|token|secret|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:ristak_(?:live|test)_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .slice(0, 1000)
}

function outputSummary(value) {
  if (Array.isArray(value)) return { type: 'array', count: value.length }
  if (!value || typeof value !== 'object') return { type: typeof value }
  const data = value.data
  return {
    type: 'object',
    success: value.success !== false,
    keys: Object.keys(value).slice(0, 30),
    ...(Array.isArray(data) ? { dataCount: data.length } : {}),
    ...(Array.isArray(data?.items) ? { itemCount: data.items.length } : {}),
    ...(Array.isArray(value.items) ? { itemCount: value.items.length } : {})
  }
}

function riskLevelFor(spec) {
  if (spec.scope === 'ristak.destructive') return 'destructive'
  if (spec.scope === 'ristak.execute') return 'execute'
  if (spec.scope === 'ristak.write') return 'write'
  return spec.access === 'write' ? 'write' : 'read'
}

function modulePoliciesFor(spec) {
  return [
    { module: spec.module, access: spec.access },
    ...((spec.additionalModules || []).map((entry) => (
      typeof entry === 'string'
        ? { module: entry, access: 'read' }
        : { module: entry.module, access: entry.access || 'read' }
    )))
  ]
}

function toolDefinition(spec) {
  const securitySchemes = (spec.scopesAny?.length ? spec.scopesAny : [spec.scope])
    .map(scope => ({ type: 'oauth2', scopes: [scope] }))
  return {
    name: spec.name,
    title: spec.title || spec.name.replaceAll('_', ' '),
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    securitySchemes,
    annotations: {
      readOnlyHint: spec.readOnlyHint ?? spec.access === 'read',
      destructiveHint: spec.scope === 'ristak.destructive',
      openWorldHint: spec.openWorld === true || spec.scope === 'ristak.execute',
      idempotentHint: spec.idempotentHint ?? spec.idempotencyRequired === true
    },
    _meta: {
      securitySchemes,
      'ristak/domain': spec.module,
      'ristak/risk': riskLevelFor(spec),
      'ristak/confirmationRequired': spec.confirmRequired === true,
      'ristak/idempotencyRequired': spec.idempotencyRequired === true,
      'ristak/connectionPrerequisites': spec.connectionPrerequisites || []
    }
  }
}

function businessInputSchema(spec) {
  const inputSchema = spec?.inputSchema || { type: 'object' }
  const properties = Object.fromEntries(
    Object.entries(inputSchema.properties || {}).filter(([key]) => (
      !['approvalTicket', 'confirm', 'idempotencyKey'].includes(key)
    ))
  )
  return {
    ...inputSchema,
    properties,
    required: (inputSchema.required || []).filter((key) => (
      !['approvalTicket', 'confirm', 'idempotencyKey'].includes(key)
    ))
  }
}

const ACTION_TICKET_SCHEMA = {
  type: 'string',
  minLength: 32,
  maxLength: 4096,
  description: 'Pase firmado y de un solo uso emitido por mcp_prepare_action_confirmation.'
}

const controlToolSpecs = [
  Object.freeze({
    name: 'mcp_prepare_action_confirmation',
    title: 'Solicitar aprobación humana',
    description: 'Prepara una acción de alto impacto, la liga a sus argumentos exactos y devuelve una página segura para que la persona autenticada la apruebe o rechace.',
    module: 'settings_api_access',
    access: 'read',
    scope: 'ristak.write',
    scopesAny: ['ristak.write', 'ristak.execute', 'ristak.destructive'],
    risk: 'medium',
    featureKeys: [],
    adminOnly: false,
    confirmRequired: false,
    idempotencyRequired: false,
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string', minLength: 1, maxLength: 180 },
        arguments: {
          type: 'object',
          maxProperties: 200,
          additionalProperties: true,
          description: 'Argumentos de negocio exactos, sin confirm, approvalTicket ni idempotencyKey.'
        }
      },
      required: ['toolName', 'arguments'],
      additionalProperties: false
    },
    async execute(context, args) {
      const target = specByName.get(String(args.toolName || ''))
      if (!target || controlToolSpecs.includes(target)) {
        throw makeError('La herramienta solicitada no existe.', 'tool_not_found', 404)
      }
      if (!target.confirmRequired) {
        throw makeError('Esta herramienta no necesita aprobación humana.', 'confirmation_not_required', 409)
      }
      const businessArgs = stripMcpActionControls(args.arguments)
      validateSchemaValue(businessArgs, businessInputSchema(target))
      await assertToolAuthorization({ ...context, args: businessArgs }, target)
      return createMcpActionConfirmation(context, target, businessArgs)
    }
  }),
  Object.freeze({
    name: 'mcp_action_confirmation_status',
    title: 'Consultar aprobación humana',
    description: 'Consulta si una solicitud de acción MCP sigue pendiente, fue aprobada, rechazada, utilizada o expiró.',
    module: 'settings_api_access',
    access: 'read',
    scope: 'ristak.read',
    scopesAny: ['ristak.read', 'ristak.write', 'ristak.execute', 'ristak.destructive'],
    risk: 'low',
    featureKeys: [],
    adminOnly: false,
    confirmRequired: false,
    idempotencyRequired: false,
    inputSchema: {
      type: 'object',
      properties: { approvalTicket: ACTION_TICKET_SCHEMA },
      required: ['approvalTicket'],
      additionalProperties: false
    },
    execute(context, args) {
      return getMcpActionConfirmationStatus(context, args.approvalTicket)
    }
  }),
  Object.freeze({
    name: 'mcp_search_capabilities',
    title: 'Buscar capacidades de Ristak',
    description: 'Úsala cuando necesites encontrar la herramienta correcta por intención, dominio, acceso o riesgo sin revisar manualmente todo el catálogo MCP.',
    module: 'settings_api_access',
    access: 'read',
    scope: 'ristak.read',
    scopesAny: ['ristak.read', 'ristak.write', 'ristak.execute', 'ristak.destructive'],
    risk: 'low',
    featureKeys: [],
    adminOnly: false,
    confirmRequired: false,
    idempotencyRequired: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 300 },
        domain: { type: 'string', minLength: 1, maxLength: 120 },
        access: { type: 'string', enum: ['read', 'write'] },
        risk: { type: 'string', enum: ['read', 'write', 'execute', 'destructive'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 }
      },
      required: ['query'],
      additionalProperties: false
    },
    execute(context, args) {
      return searchMcpCapabilities(context, args)
    }
  }),
  Object.freeze({
    name: 'mcp_events_list',
    title: 'Leer eventos pendientes',
    description: 'Recupera mensajes y cambios de pagos durables que esta conexión todavía no ha confirmado. Úsala al retomar una sesión o desde un runtime que haga polling.',
    module: 'settings_api_access',
    access: 'read',
    scope: 'ristak.read',
    scopesAny: ['ristak.read', 'ristak.write', 'ristak.execute', 'ristak.destructive'],
    risk: 'low',
    featureKeys: [],
    adminOnly: false,
    confirmRequired: false,
    idempotencyRequired: false,
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: ['chat', 'payments'] },
        eventType: { type: 'string', minLength: 1, maxLength: 120 },
        afterCursor: { type: 'string', minLength: 1, maxLength: 1000 },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    },
    execute(context, args) {
      return listMcpBusinessEvents(context, args)
    }
  }),
  Object.freeze({
    name: 'mcp_events_acknowledge',
    title: 'Confirmar eventos procesados',
    description: 'Marca como procesados, solo para esta conexión OAuth, uno o varios eventos ya atendidos. Es idempotente y no modifica los datos del negocio.',
    module: 'settings_api_access',
    access: 'read',
    scope: 'ristak.write',
    risk: 'low',
    featureKeys: [],
    adminOnly: false,
    confirmRequired: false,
    idempotencyRequired: false,
    idempotentHint: true,
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        eventIds: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string', minLength: 1, maxLength: 120 }
        }
      },
      required: ['eventIds'],
      additionalProperties: false
    },
    execute(context, args) {
      return acknowledgeMcpBusinessEvents(context, args.eventIds)
    }
  })
]
const controlToolNames = new Set(controlToolSpecs.map(entry => entry.name))

const BASE_TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    success: { type: 'boolean', description: 'Indica si Ristak completó la operación.' },
    data: { description: 'Datos principales de la operación cuando el controlador usa un sobre data.' },
    items: { type: 'array', items: {}, description: 'Colección principal cuando la respuesta usa items.' },
    message: { type: 'string', description: 'Resumen seguro y legible del resultado.' },
    error: { type: 'string', description: 'Mensaje seguro cuando la herramienta no pudo completarse.' },
    code: { type: 'string', description: 'Código estable de error o estado cuando existe.' }
  },
  additionalProperties: true
})

// La IA puede leer, sincronizar y analizar Publicidad/Meta. La creación o
// modificación de borradores de campaña queda fuera del MCP por política de
// producto, incluso si Meta Ads se conecta en el futuro.
const MCP_DISABLED_TOOL_NAMES = new Set([
  'campaigns_builder_draft_create',
  'campaigns_builder_draft_preview'
])

const allSpecs = Object.freeze([
  ...controlToolSpecs,
  ...domainToolSpecs,
  ...siteToolSpecs,
  ...extendedToolSpecs,
  ...capabilityToolSpecs
]
  .filter(entry => !MCP_DISABLED_TOOL_NAMES.has(entry?.name))
  .map(entry => Object.freeze({
    ...entry,
    outputSchema: entry.outputSchema || BASE_TOOL_OUTPUT_SCHEMA
  })))
const specByName = new Map()
for (const entry of allSpecs) {
  if (!entry?.name || typeof entry.execute !== 'function') {
    throw new Error('El registro MCP contiene una herramienta inválida')
  }
  if (specByName.has(entry.name)) throw new Error(`Herramienta MCP duplicada: ${entry.name}`)
  specByName.set(entry.name, entry)
}

async function missingConnectionPrerequisites(context, prerequisites = []) {
  const key = [...new Set(prerequisites || [])].sort().join('|')
  if (!key) return []
  const cache = context.connectionPrerequisiteCache
  if (cache?.has(key)) return cache.get(key)
  const pending = getMissingMcpConnectionPrerequisites(prerequisites)
  cache?.set(key, pending)
  return pending
}

async function hasToolPolicy(context, spec) {
  const user = context.user || {}
  if (!hasRequiredToolScope(context, spec)) return false
  if (spec.adminOnly && user.role !== 'admin') return false
  if (modulePoliciesFor(spec).some(policy => !hasUserAccess(user, policy.module, policy.access))) return false
  if ((await missingConnectionPrerequisites(context, spec.connectionPrerequisites)).length) return false
  if (!isLicenseEnforced()) return true

  const licenseOptions = {
    state: context.license || null,
    email: user.email || user.username || null
  }
  for (const policy of modulePoliciesFor(spec)) {
    if (!(await hasModuleFeature(policy.module, licenseOptions))) return false
  }
  for (const featureKey of spec.featureKeys || []) {
    if (!(await hasFeature(featureKey, licenseOptions))) return false
  }
  return true
}

function hasRequiredToolScope(context, spec) {
  const granted = context.scopes || context.mcpUser?.scope
  if (spec.scopesAny?.length) {
    return spec.scopesAny.some(scope => hasGrantedScope(granted, scope))
  }
  return hasGrantedScope(granted, spec.scope)
}

async function assertToolAuthorization(context, spec) {
  if (!hasRequiredToolScope(context, spec)) {
    const requiredScopes = spec.scopesAny?.length ? spec.scopesAny : [spec.scope]
    throw makeError(`La conexión necesita uno de estos scopes: ${requiredScopes.join(', ')}.`, 'insufficient_scope', 403, {
      requiredScopes
    })
  }
  if (spec.adminOnly && context.user?.role !== 'admin') {
    throw makeError('Esta acción requiere un administrador.', 'admin_required', 403)
  }
  const deniedPolicy = modulePoliciesFor(spec).find(policy => (
    !hasUserAccess(context.user || {}, policy.module, policy.access)
  ))
  if (deniedPolicy) {
    throw makeError(
      deniedPolicy.access === 'write'
        ? 'El usuario conectado no tiene permiso para modificar este módulo.'
        : 'El usuario conectado no tiene acceso a este módulo.',
      deniedPolicy.access === 'write' ? 'write_access_required' : 'read_access_required',
      403,
      { module: deniedPolicy.module }
    )
  }
  const missingConnections = await missingConnectionPrerequisites(context, spec.connectionPrerequisites)
  if (missingConnections.length) {
    const handoffProviders = [...new Set(missingConnections.map(provider => (
      provider === 'payment_subscriptions' ? 'payments' : provider
    )))]
    throw makeError(
      `Falta conectar: ${missingConnections.join(', ')}. Usa integrations_connection_handoff con: ${handoffProviders.join(', ')}.`,
      'integration_not_connected',
      409,
      { missingConnections, handoffProviders }
    )
  }
  if (isLicenseEnforced()) {
    const licenseOptions = {
      state: context.license || null,
      email: context.user?.email || context.user?.username || null
    }
    for (const policy of modulePoliciesFor(spec)) {
      if (!(await hasModuleFeature(policy.module, licenseOptions))) {
        throw makeError('Este módulo no está incluido en el plan actual.', 'feature_not_available', 403, {
          module: policy.module
        })
      }
    }
    for (const featureKey of spec.featureKeys || []) {
      if (!(await hasFeature(featureKey, licenseOptions))) {
        throw makeError('Esta función no está incluida en el plan actual.', 'feature_not_available', 403, {
          feature: featureKey
        })
      }
    }
  }
}

async function searchMcpCapabilities(context, args = {}) {
  const normalizedQuery = String(args.query || '').trim().toLowerCase()
  const terms = normalizedQuery.split(/\s+/).filter(Boolean)
  const domain = String(args.domain || '').trim()
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50))
  const policyContext = { ...context, connectionPrerequisiteCache: new Map() }
  const allowed = await Promise.all(allSpecs.map(entry => hasToolPolicy(policyContext, entry)))

  const results = allSpecs
    .filter((_entry, index) => allowed[index])
    .filter(entry => !controlToolNames.has(entry.name))
    .filter(entry => !domain || entry.module === domain)
    .filter(entry => !args.access || entry.access === args.access)
    .filter(entry => !args.risk || riskLevelFor(entry) === args.risk)
    .map(entry => {
      const haystack = [entry.name, entry.title, entry.description, entry.module]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
      return { entry, score }
    })
    .filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))

  return {
    success: true,
    query: args.query,
    total: results.length,
    tools: results.slice(0, limit).map(({ entry }) => ({
      name: entry.name,
      title: entry.title || entry.name.replaceAll('_', ' '),
      description: entry.description,
      domain: entry.module,
      access: entry.access,
      scope: entry.scope,
      risk: riskLevelFor(entry),
      confirmationRequired: entry.confirmRequired === true,
      connectionPrerequisites: entry.connectionPrerequisites || []
    }))
  }
}

function assertToolControls(context, spec) {
  if (spec.idempotencyRequired) {
    const key = String(context.args?.idempotencyKey || '').trim()
    if (key.length < 8 || key.length > 180) {
      throw makeError('idempotencyKey debe tener entre 8 y 180 caracteres.', 'idempotency_key_required', 400)
    }
  }
}

async function assertToolPolicy(context, spec) {
  await assertToolAuthorization(context, spec)
  assertToolControls(context, spec)
}

async function beginIdempotentCall(context, spec, args) {
  if (!spec.idempotencyRequired) return { mode: 'execute', id: null }

  const clientId = String(context.mcpUser?.clientId || context.clientId || '')
  const userId = context.user?.id || context.user?.userId
  const keyHash = sha256(args.idempotencyKey)
  const requestHash = sha256(JSON.stringify(stableValue({
    ...args,
    idempotencyKey: undefined
  })))
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString()

  const inserted = await db.run(
    `INSERT INTO mcp_idempotency_keys (
       user_id, client_id, tool_name, key_hash, request_hash, status, expires_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(user_id, client_id, tool_name, key_hash) DO NOTHING`,
    [userId, clientId, spec.name, keyHash, requestHash, expiresAt]
  )
  if (Number(inserted?.changes ?? inserted?.rowCount) === 1) {
    const row = await db.get(
      `SELECT id FROM mcp_idempotency_keys
       WHERE user_id = ? AND client_id = ? AND tool_name = ? AND key_hash = ?`,
      [userId, clientId, spec.name, keyHash]
    )
    return {
      mode: 'execute',
      id: row?.id || null,
      resultMode: spec.idempotencyResultMode || 'replayable'
    }
  }

  const existing = await db.get(
    `SELECT id, request_hash, status, result_json, expires_at
     FROM mcp_idempotency_keys
     WHERE user_id = ? AND client_id = ? AND tool_name = ? AND key_hash = ?`,
    [userId, clientId, spec.name, keyHash]
  )
  if (!existing) throw makeError('No se pudo reservar la operación idempotente.', 'idempotency_unavailable', 503)
  if (existing.request_hash !== requestHash) {
    throw makeError('La misma idempotencyKey ya se usó con argumentos distintos.', 'idempotency_conflict', 409)
  }
  if (existing.status === 'succeeded' && existing.result_json) {
    let result
    try {
      result = JSON.parse(existing.result_json)
    } catch {
      throw makeError('El resultado idempotente previo no se puede recuperar.', 'idempotency_result_invalid', 500)
    }
    if (result?.__ristakMcpReplayUnavailable === true) {
      throw makeError(
        result.reason === 'ephemeral'
          ? 'La operación anterior sí terminó, pero su respuesta temporal no se guarda. Usa una idempotencyKey nueva para solicitar otro pase.'
          : 'La operación anterior sí terminó, pero su respuesta era demasiado grande para repetirla. Consulta el recurso actualizado.',
        'idempotency_replay_unavailable',
        409
      )
    }
    return { mode: 'replay', id: existing.id, result }
  }
  if (existing.status === 'failed') {
    throw makeError(
      'El intento anterior con esta idempotencyKey falló. Verifica el estado real antes de reintentar con una clave nueva.',
      'idempotency_previous_attempt_failed',
      409
    )
  }
  if (new Date(existing.expires_at).getTime() > Date.now()) {
    throw makeError('Esta operación ya está en curso. Espera y consulta de nuevo.', 'idempotency_in_progress', 409)
  }

  throw makeError(
    'El intento anterior quedó sin resultado confirmado. Verifica la acción en Ristak antes de usar una clave nueva.',
    'idempotency_outcome_unknown',
    409
  )
}

async function completeIdempotentCall(reservation, status, result = null) {
  if (!reservation?.id) return
  let serialized = null
  if (result !== null) {
    if (reservation.resultMode === 'ephemeral') {
      serialized = JSON.stringify(EPHEMERAL_IDEMPOTENCY_RESULT)
    } else {
      try {
        const candidate = JSON.stringify(result)
        serialized = candidate.length <= MAX_IDEMPOTENCY_RESULT_LENGTH
          ? candidate
          : JSON.stringify({ __ristakMcpReplayUnavailable: true, reason: 'too_large' })
      } catch {
        serialized = JSON.stringify({ __ristakMcpReplayUnavailable: true, reason: 'unserializable' })
      }
    }
  }
  await db.run(
    `UPDATE mcp_idempotency_keys
     SET status = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status, serialized, reservation.id]
  )
}

async function recordAudit(context, spec, args, startedAt, { success, result, error } = {}) {
  const completedAt = new Date().toISOString()
  try {
    await db.run(
      `INSERT INTO mcp_audit_log (
         actor_user_id, client_id, oauth_grant_id, tool_name, risk_level, success,
         input_redacted_json, result_summary_json, error_code, error_message,
         ip_address, user_agent, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        context.user?.id || context.user?.userId || null,
        context.mcpUser?.clientId || context.clientId || null,
        context.mcpUser?.grantId || context.grant?.id || context.grant?.grantId || null,
        spec.name,
        riskLevelFor(spec),
        success ? 1 : 0,
        safeJson(sanitizeAuditInput(args)),
        result === undefined ? null : safeJson(outputSummary(result)),
        error?.code || null,
        error?.message ? sanitizeErrorMessage(error.message) : null,
        String(context.ip || '').slice(0, 120),
        String(context.userAgent || '').slice(0, 500),
        startedAt,
        completedAt
      ]
    )
  } catch (auditError) {
    logger.error(`[MCP] No se pudo guardar auditoría de ${spec.name}: ${auditError.message}`)
  }
}

export function getMcpRegistrySummary() {
  const domains = Array.from(new Set(allSpecs.map((entry) => entry.module))).sort()
  return {
    toolCount: allSpecs.length,
    domains,
    toolsByDomain: Object.fromEntries(domains.map((domain) => [
      domain,
      allSpecs.filter((entry) => entry.module === domain).length
    ]))
  }
}

export function getMcpToolMetadata(name) {
  const spec = specByName.get(String(name || ''))
  if (!spec) return null
  return {
    name: spec.name,
    title: spec.title || spec.name.replaceAll('_', ' '),
    description: spec.description,
    riskLevel: riskLevelFor(spec),
    confirmRequired: spec.confirmRequired === true
  }
}

export async function listMcpToolDefinitions(context) {
  const policyContext = { ...context, connectionPrerequisiteCache: new Map() }
  const allowed = await Promise.all(allSpecs.map(entry => hasToolPolicy(policyContext, entry)))
  return allSpecs
    .filter((_entry, index) => allowed[index])
    .map(toolDefinition)
}

export async function callRegisteredMcpTool(context, name, args = {}) {
  const spec = specByName.get(String(name || ''))
  if (!spec) throw makeError(`Tool no soportada: ${name}`, 'tool_not_found', 404)
  const startedAt = new Date().toISOString()
  const callContext = { ...context, args, connectionPrerequisiteCache: new Map() }
  let reservation = null

  try {
    validateSchemaValue(args, spec.inputSchema)
    await assertToolPolicy(callContext, spec)
    if (spec.confirmRequired && args.confirm !== true) {
      throw makeError('Esta acción requiere confirm=true después de la aprobación humana.', 'confirmation_required', 400)
    }
    reservation = await beginIdempotentCall(callContext, spec, args)
    if (reservation.mode === 'replay') {
      await recordAudit(callContext, spec, args, startedAt, { success: true, result: reservation.result })
      return reservation.result
    }

    if (spec.confirmRequired) {
      await consumeMcpActionConfirmation(callContext, spec, args)
    }

    const result = await spec.execute(callContext, args)
    await completeIdempotentCall(reservation, 'succeeded', result)
    await recordAudit(callContext, spec, args, startedAt, { success: true, result })
    return result
  } catch (error) {
    await completeIdempotentCall(reservation, 'failed').catch(() => {})
    await recordAudit(callContext, spec, args, startedAt, { success: false, error })
    throw error
  }
}

export function sanitizeMcpResult(value) {
  return sanitizeExternal(value)
}

export const __mcpRegistryTestHooks = {
  allSpecs,
  MCP_DISABLED_TOOL_NAMES,
  riskLevelFor,
  searchMcpCapabilities,
  stableValue,
  sanitizeAuditInput,
  sanitizeExternal,
  validateSchemaValue,
  toolDefinition
}
