import { createHash } from 'node:crypto'
import { buildUnifiedBusinessContext } from '../../../services/aiRuntimeService.js'

function normalizeContext(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim()
}

/**
 * La descripción es configuración del dueño, no un resultado de búsqueda.
 * Una respuesta como "sí" no puede retirar requisitos o datos del contexto.
 * La extracción es auxiliar: nunca sustituye una edición o un borrado reciente.
 */
export function buildConversationalBusinessKnowledge({ runtimeConfig = {}, businessProfile = null } = {}) {
  const hasSavedContext = Object.hasOwn(runtimeConfig, 'business_context')
  const context = hasSavedContext
    ? buildUnifiedBusinessContext(runtimeConfig)
    : normalizeContext(businessProfile?.sourceContext)
  const profileMatchesSource = Boolean(context) &&
    normalizeContext(buildUnifiedBusinessContext({ business_context: businessProfile?.sourceContext })) === normalizeContext(context)
  const currentProfile = profileMatchesSource ? businessProfile : null
  const version = context ? createHash('sha256').update(context, 'utf8').digest('hex') : null
  const source = context ? (hasSavedContext ? 'business_context' : 'business_profile') : 'empty'

  return {
    context,
    profile: currentProfile,
    found: Boolean(context),
    source,
    version,
    citations: context ? [{ source, version }] : []
  }
}
