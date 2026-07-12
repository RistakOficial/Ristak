import { tool } from '@openai/agents'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { db } from '../../config/database.js'
import { invokeController, toToolResult } from '../invokeController.js'
import { createAppointment } from '../../controllers/calendarsController.js'
import { getLocalFreeSlots } from '../../services/localCalendarService.js'
import { inspectChangedAppointmentCreationReplay } from '../../services/appointmentCreationSafetyService.js'
import {
  buildConversationalPaymentLinkIdempotencyKey,
  registerAgentTransferPaymentProofForReview
} from '../../services/paymentFlowService.js'
import { createConversationalAgentLivePaymentLink } from '../../services/conversationalAgentLivePaymentService.js'
import { getBusinessProfileSnapshot, getOpenAIApiKey } from '../../services/aiAgentService.js'
import { analyzePaymentReceiptImage } from './mediaContext.js'
import { getTriggerLink } from '../../services/triggerLinksService.js'
import { getAccountTimezone, normalizeDateOnlyInTimezone, resolveTimezone } from '../../utils/dateUtils.js'
import { getAccountCurrency } from '../../utils/accountLocale.js'
import { normalizePhoneForStorage } from '../../utils/phoneUtils.js'
import {
  mergeContactCustomFields,
  parseContactCustomFields,
  serializeContactCustomFieldsForDb
} from '../../utils/contactCustomFields.js'
import {
  bindConversationalPaymentSourceEvent,
  completeConversationalAgentSalePaymentFromInvoice,
  consumeConversationalAppointmentDepositEvidence,
  releaseConversationalAppointmentDepositEvidence,
  reserveConversationalAppointmentDepositEvidence,
  setConversationSignal,
  recordConversationalAgentEvent,
  createConversationGoalLink,
  DEFAULT_GOAL_TRACKING_PARAM
} from '../../services/conversationalAgentService.js'
import { sendConversationalAgentPriorityNotification } from '../../services/pushNotificationsService.js'
import { logger } from '../../utils/logger.js'
import { getGHLClient } from '../../services/ghlClient.js'
import { getGhlContactIdForLocalContact } from '../../services/contactIdentityService.js'
import {
  applyConversationalAgentPreventiveMeasure,
  getActiveConversationalAgentPreventiveMeasure,
  withConversationalAgentSafetyLock
} from '../../services/conversationalAgentSafetyService.js'
import { dispatchConversationalAgentSafetyNotification } from '../../services/conversationalAgentSafetyNotificationService.js'
import {
  NON_LIVE_PAYMENT_MODES,
  SUCCESS_PAYMENT_STATUSES,
  buildCanonicalAppointmentSlotOption,
  depositRequirementAmountMatches,
  findVerifiedPaymentEvidence,
  revalidateAppointmentSlot,
  verifyNativeAppointmentSelectionEvidence
} from './actionEvidence.js'
import {
  getConversationalCapability,
  getEnabledConversationalCapabilities
} from './nativeRuntimeConfig.js'
import {
  CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
  buildConversationalAppointmentPreviewOfferEventId,
  isConversationalAppointmentPreviewScopeId
} from '../../services/conversationalAppointmentPreviewOfferService.js'

/**
 * Tools del agente conversacional. Se crean por ejecución con una factory
 * porque necesitan el contexto de la conversación (contactId, configuración
 * y modo simulación) cerrado sobre cada tool.
 *
 * ctx = {
 *   contactId, config, dryRun,
 *   actions: [] // acciones internas ejecutadas (para auditoría/preview)
 * }
 */

function pushAction(ctx, type, detail = {}) {
  const action = { type, ...detail }
  ctx.actions.push(action)
  return action
}

function settleAction(action, status, detail = {}) {
  if (!action) return null
  const normalizedStatus = ['ok', 'error', 'simulated'].includes(status) ? status : 'error'
  action.outcome = {
    status: normalizedStatus,
    ok: normalizedStatus !== 'error',
    simulated: normalizedStatus === 'simulated',
    actionCompleted: normalizedStatus === 'ok',
    ...detail
  }
  return action.outcome
}

function cleanAppointmentText(value, maxLength) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function getVirtualThreadContact(ctx = {}) {
  const source = ctx.virtualContact && typeof ctx.virtualContact === 'object'
    ? ctx.virtualContact
    : {}
  return {
    id: String(source.id || ctx.contactId || 'preview-contact').trim(),
    full_name: cleanAppointmentText(source.fullName || source.full_name || 'Contacto de prueba', 240),
    first_name: cleanAppointmentText(source.firstName || source.first_name, 120),
    last_name: cleanAppointmentText(source.lastName || source.last_name, 120),
    phone: cleanAppointmentText(source.phone, 80),
    email: cleanAppointmentText(source.email, 240),
    custom_fields: null,
    total_paid: 0,
    purchases_count: 0,
    virtual: true
  }
}

async function getThreadContact(ctx = {}) {
  const contactId = String(ctx.contactId || '').trim()
  if (ctx.virtualContact && typeof ctx.virtualContact === 'object') {
    return getVirtualThreadContact(ctx)
  }
  if (!contactId) return ctx.dryRun ? getVirtualThreadContact(ctx) : null
  const stored = await db.get(`
    SELECT id, full_name, first_name, last_name, phone, email, custom_fields, total_paid, purchases_count
    FROM contacts WHERE id = ?
  `, [contactId])
  return stored || (ctx.dryRun ? getVirtualThreadContact(ctx) : null)
}

function missingThreadContactResult(ctx = {}, actionType = 'contact_identity_unavailable') {
  const action = pushAction(ctx, actionType, {
    transferRequired: true,
    terminal: true,
    reason: 'thread_contact_missing'
  })
  const error = 'No se pudo comprobar el contacto interno de este hilo. No pidas nombre, apellido ni teléfono para buscar otra ficha; el caso necesita atención del equipo.'
  settleAction(action, 'error', { transferRequired: true, terminal: true, error })
  return {
    ok: false,
    actionCompleted: false,
    transferRequired: true,
    terminal: true,
    error
  }
}

function buildAppointmentParticipant({
  contact,
  title,
  notes,
  attendeeName,
  attendeeContext,
  primaryAttendee = null
} = {}) {
  const threadContactLabel = cleanAppointmentText(
    contact?.full_name || contact?.phone || contact?.email || 'Contacto',
    180
  ) || 'Contacto'
  const structuredPrimary = cleanParticipant(primaryAttendee)
  const attendee = cleanAppointmentText(structuredPrimary?.name || attendeeName, 180)
  const context = cleanAppointmentText(structuredPrimary?.relation || attendeeContext, 1000)
  const requestedTitle = cleanAppointmentText(title, 240)
  const requestedNotes = cleanAppointmentText(notes, 2000)

  if (!attendee) {
    return {
      title: requestedTitle || `Cita - ${threadContactLabel}`,
      notes: requestedNotes || 'Agendada por el agente conversacional',
      attendeeName: null,
      attendeeContext: null
    }
  }

  return {
    title: [`Cita para ${attendee}`, requestedTitle].filter(Boolean).join(' · ').slice(0, 240),
    notes: [
      `Solicitada desde el contacto ${threadContactLabel} para ${attendee}.`,
      context ? `Contexto del asistente: ${context}.` : '',
      requestedNotes
    ].filter(Boolean).join(' ').slice(0, 2000),
    attendeeName: attendee,
    attendeeContext: context || null
  }
}

function cleanParticipant(input = {}) {
  if (!input || typeof input !== 'object') return null
  const name = cleanAppointmentText(input.name || input.fullName, 180)
  const rawPhone = cleanAppointmentText(input.phone, 80)
  const normalizedPhone = rawPhone ? normalizePhoneForStorage(rawPhone) : ''
  const phoneDigits = normalizedPhone.replace(/\D/g, '')
  const phoneValid = !rawPhone || (phoneDigits.length >= 7 && phoneDigits.length <= 15)
  const phone = phoneValid ? normalizedPhone : ''
  const email = cleanAppointmentText(input.email, 180).toLowerCase()
  const relation = cleanAppointmentText(input.relation || input.context, 180)
  const phoneSourceQuote = cleanAppointmentText(input.phoneSourceQuote, 4000)
  const emailSourceQuote = cleanAppointmentText(input.emailSourceQuote, 4000)
  if (!name && !rawPhone && !email && !relation) return null
  return {
    name,
    phone,
    email,
    relation,
    phoneSourceQuote,
    emailSourceQuote,
    phoneProvided: Boolean(rawPhone),
    phoneValid
  }
}

function publicAppointmentParticipant(participant = {}) {
  const {
    phoneProvided: _phoneProvided,
    phoneValid: _phoneValid,
    phoneSourceQuote: _phoneSourceQuote,
    emailSourceQuote: _emailSourceQuote,
    ...publicParticipant
  } = participant
  return publicParticipant
}

function appointmentMessageText(message = {}) {
  return cleanAppointmentText(message?.content ?? message?.text ?? message?.message_text ?? '', 4000)
}

function isCustomerAppointmentMessage(message = {}) {
  const role = String(message?.role || message?.direction || '').trim().toLowerCase()
  return role === 'user' || role === 'inbound'
}

function emailTokens(value = '') {
  return String(value || '').match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi) || []
}

function phoneLikeSpans(value = '') {
  return String(value || '').match(/(?:\+|00)?\d(?:[\s().\/-]*\d){6,14}/g) || []
}

function participantValueAppearsInQuote(value = '', type = '', sourceQuote = '') {
  const normalizedValue = cleanAppointmentText(value, 180)
  const normalizedQuote = cleanAppointmentText(sourceQuote, 4000)
  if (!normalizedValue || !normalizedQuote) return false
  if (type === 'phone') {
    const canonicalValue = normalizePhoneForStorage(normalizedValue)
    if (!canonicalValue) return false
    return phoneLikeSpans(normalizedQuote).some((span) => normalizePhoneForStorage(span) === canonicalValue)
  }
  if (type === 'email') {
    const canonicalValue = normalizedValue.toLowerCase()
    return emailTokens(normalizedQuote).some((token) => token.toLowerCase() === canonicalValue)
  }
  return false
}

function customerQuoteSupportsParticipantValue(messages = [], value = '', type = '', sourceQuote = '') {
  const normalizedQuote = cleanAppointmentText(sourceQuote, 4000)
  if (!participantValueAppearsInQuote(value, type, normalizedQuote)) return false
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (!isCustomerAppointmentMessage(message)) return false
    return appointmentMessageText(message) === normalizedQuote
  })
}

function removeUnverifiedParticipantContactData(participant = {}, conversationMessages = []) {
  const sanitized = { ...participant }
  if (
    sanitized.email &&
    !customerQuoteSupportsParticipantValue(
      conversationMessages,
      sanitized.email,
      'email',
      sanitized.emailSourceQuote
    )
  ) {
    sanitized.email = ''
  }
  if (
    sanitized.phone &&
    !customerQuoteSupportsParticipantValue(
      conversationMessages,
      sanitized.phone,
      'phone',
      sanitized.phoneSourceQuote
    )
  ) {
    sanitized.phone = ''
    sanitized.phoneProvided = false
    sanitized.phoneValid = true
  }
  return sanitized
}

function participantEvidenceSearchQuery(value = '', type = '', sourceQuote = '') {
  const normalizedQuote = cleanAppointmentText(sourceQuote, 4000)
  if (!participantValueAppearsInQuote(value, type, normalizedQuote)) return ''
  if (type === 'email') {
    const canonicalValue = cleanAppointmentText(value, 180).toLowerCase()
    return emailTokens(normalizedQuote).find((token) => token.toLowerCase() === canonicalValue) || ''
  }
  if (type === 'phone') {
    const canonicalValue = normalizePhoneForStorage(value)
    return phoneLikeSpans(normalizedQuote).find((span) => normalizePhoneForStorage(span) === canonicalValue) || ''
  }
  return ''
}

function participantContactEvidenceRequests(primaryAttendee = null, guests = []) {
  const participants = [primaryAttendee, ...(Array.isArray(guests) ? guests : [])]
    .map((participant) => cleanParticipant(participant))
    .filter(Boolean)
  const requests = []
  for (const participant of participants) {
    if (participant.phone) {
      requests.push({ type: 'phone', value: participant.phone, sourceQuote: participant.phoneSourceQuote })
    }
    if (participant.email) {
      requests.push({ type: 'email', value: participant.email, sourceQuote: participant.emailSourceQuote })
    }
  }
  const seen = new Set()
  return requests.filter((request) => {
    const key = `${request.type}:${request.value}:${request.sourceQuote}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function resolveAppointmentParticipantEvidenceMessages({ ctx, primaryAttendee = null, guests = [] } = {}) {
  const messages = [...(Array.isArray(ctx?.conversationMessages) ? ctx.conversationMessages : [])]
  const loadOlderPage = ctx?.loadConversationHistoryPage
  if (typeof loadOlderPage !== 'function') return messages

  const loadEvidencePages = async ({ mode, query = null, request }) => {
    let cursor = null
    const seenCursors = new Set()
    const omittedMessages = Math.max(0, Number(ctx?.historyContext?.telemetry?.omittedMessages) || 0)
    const maxPages = omittedMessages > 0
      ? Math.max(1, Math.ceil(omittedMessages / 30) + 1)
      : 1000
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      let page
      try {
        page = await loadOlderPage({ mode, cursor, offset: null, query, limit: 30 })
      } catch (error) {
        logger.warn(`[Agente conversacional] No se pudo verificar el origen histórico de un dato de participante: ${error.message}`)
        break
      }
      if (!page?.ok) break
      messages.push(...(Array.isArray(page.messages) ? page.messages : []))
      if (customerQuoteSupportsParticipantValue(
        messages,
        request.value,
        request.type,
        request.sourceQuote
      )) return true
      const nextCursor = String(page.nextCursor || '').trim()
      if (!page.hasMore || !nextCursor || seenCursors.has(nextCursor)) break
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
    return false
  }

  for (const request of participantContactEvidenceRequests(primaryAttendee, guests)) {
    if (customerQuoteSupportsParticipantValue(
      messages,
      request.value,
      request.type,
      request.sourceQuote
    )) continue
    const query = participantEvidenceSearchQuery(
      request.value,
      request.type,
      request.sourceQuote
    )
    if (!query) continue
    const foundBySearch = await loadEvidencePages({ mode: 'search', query, request })
    if (!foundBySearch) {
      // La búsqueda literal puede no encontrar mensajes con saltos de línea o
      // formatos raros. El fallback recorre sólo el tramo omitido del mismo
      // contacto/canal y vuelve a comparar la cita completa, siempre fail-closed.
      await loadEvidencePages({ mode: 'oldest', request })
    }
  }
  return messages
}

function buildAppointmentParticipants({
  contact,
  primaryAttendee = null,
  guests = [],
  attendeeName = '',
  attendeeContext = '',
  requirements = {},
  conversationMessages = []
} = {}) {
  const requesterRawPhone = cleanAppointmentText(contact?.phone, 80)
  const requesterNormalizedPhone = requesterRawPhone ? normalizePhoneForStorage(requesterRawPhone) : ''
  const requesterPhoneDigits = requesterNormalizedPhone.replace(/\D/g, '')
  const requesterPhoneValid = !requesterRawPhone ||
    (requesterPhoneDigits.length >= 7 && requesterPhoneDigits.length <= 15)
  const requester = {
    role: 'requester',
    contactId: String(contact?.id || '').trim() || null,
    name: cleanAppointmentText(contact?.full_name, 180),
    phone: requesterPhoneValid ? requesterNormalizedPhone : '',
    email: cleanAppointmentText(contact?.email, 180).toLowerCase(),
    relation: ''
  }
  const legacyPrimary = attendeeName
    ? { name: attendeeName, relation: attendeeContext }
    : null
  const requestedPrimaryRaw = cleanParticipant(primaryAttendee || legacyPrimary)
  const requestedPrimary = requestedPrimaryRaw
    ? removeUnverifiedParticipantContactData(requestedPrimaryRaw, conversationMessages)
    : null
  const allowDifferentPrimary = requirements?.participants?.allowPrimaryAttendeeDifferentFromRequester !== false
  if (requestedPrimary && !allowDifferentPrimary) {
    return {
      ok: false,
      error: 'Este agente no permite agendar para un titular distinto. Usa al contacto de este hilo como titular y envía primaryAttendee en null; si la cita debe quedar a nombre de otra persona, pasa el caso al equipo.'
    }
  }
  const primary = requestedPrimary
    ? { ...publicAppointmentParticipant(requestedPrimary), role: 'primary_attendee', contactId: null }
    : { ...requester, role: 'primary_attendee' }
  const maxGuests = Math.min(20, Math.max(1, Number(requirements?.participants?.maxGuests) || 10))
  const rawGuests = Array.isArray(guests) ? guests : []
  if (rawGuests.length > maxGuests) {
    return {
      ok: false,
      error: `Esta agenda admite como máximo ${maxGuests} invitado${maxGuests === 1 ? '' : 's'}. Recibí ${rawGuests.length}; no se omitió ni truncó a nadie. Pide que reduzcan la lista antes de agendar.`
    }
  }
  const requiredGuestFields = requirements?.participants?.enabled
    ? new Set(Array.isArray(requirements.participants.guestFields) ? requirements.participants.guestFields : [])
    : new Set()
  if (!requestedPrimary && requesterRawPhone && !requesterPhoneValid) {
    return {
      ok: false,
      error: 'El teléfono del titular debe tener entre 7 y 15 dígitos. Pide que lo confirme antes de agendar.'
    }
  }
  if (requestedPrimary) {
    if (requestedPrimary.phoneProvided && !requestedPrimary.phoneValid) {
      return {
        ok: false,
        error: 'El teléfono del titular distinto debe tener entre 7 y 15 dígitos. Pide que lo confirme antes de agendar.'
      }
    }
    const missing = [...requiredGuestFields].filter((field) => !requestedPrimary[field])
    if (missing.length) {
      return {
        ok: false,
        error: `Faltan datos configurados del titular distinto: ${missing.join(', ')}. Pide únicamente esos datos antes de agendar.`
      }
    }
  }
  const normalizedGuests = []
  for (const rawGuest of rawGuests) {
    const rawGuestParticipant = cleanParticipant(rawGuest)
    if (!rawGuestParticipant) continue
    const guest = removeUnverifiedParticipantContactData(rawGuestParticipant, conversationMessages)
    if (guest.phoneProvided && !guest.phoneValid) {
      return {
        ok: false,
        error: 'El teléfono de un invitado debe tener entre 7 y 15 dígitos. Pide que lo confirme antes de agendar.'
      }
    }
    const missing = [...requiredGuestFields].filter((field) => !guest[field])
    if (missing.length) {
      return {
        ok: false,
        error: `Faltan datos configurados de un invitado: ${missing.join(', ')}. Pide únicamente esos datos antes de agendar.`
      }
    }
    normalizedGuests.push({ ...publicAppointmentParticipant(guest), role: 'guest', contactId: null })
  }
  return {
    ok: true,
    requester,
    primary,
    guests: normalizedGuests,
    all: [requester, primary, ...normalizedGuests]
  }
}

function isPlaceholderContactName(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
  if (!normalized) return true
  if (/^(contacto|cliente|prospecto|lead|sin nombre|unknown|desconocid[oa]|contacto de prueba)(\s+\d+)?$/.test(normalized)) {
    return true
  }
  if (/^(?:usuario(?: de)? (?:whatsapp|instagram|facebook|messenger)|(?:whatsapp|instagram|facebook|messenger) (?:user|usuario))$/.test(normalized)) {
    return true
  }
  const phoneLike = normalized.replace(/(?:ext\.?|extension|x)\s*\d+$/i, '').trim()
  return /\d/.test(phoneLike) && /^[+\d().\s-]+$/.test(phoneLike)
}

function splitConfirmedName(value = '') {
  const parts = cleanAppointmentText(value, 240).split(/\s+/).filter(Boolean)
  return {
    fullName: parts.join(' '),
    firstName: parts[0] || null,
    lastName: parts.slice(1).join(' ') || null
  }
}

function normalizeRequiredDataKey(value = '') {
  return cleanAppointmentText(value, 120)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function requiredContactFieldValue(contact = {}, requirement = {}) {
  const field = String(requirement?.field || '').trim()
  const fullName = cleanAppointmentText(contact.full_name, 240)
  if (field === 'first_name') {
    const firstName = cleanAppointmentText(contact.first_name || fullName.split(/\s+/)[0], 120)
    return firstName && !isPlaceholderContactName(fullName) ? firstName : ''
  }
  if (field === 'full_name') {
    return fullName && !isPlaceholderContactName(fullName) && fullName.split(/\s+/).filter(Boolean).length >= 2
      ? fullName
      : ''
  }
  if (field === 'phone') {
    const phone = normalizePhoneForStorage(contact.phone || '')
    const digits = phone.replace(/\D/g, '')
    return digits.length >= 7 && digits.length <= 15 ? phone : ''
  }
  if (field === 'email') {
    const email = cleanAppointmentText(contact.email, 240).toLowerCase()
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
  }

  const customFields = parseContactCustomFields(contact.custom_fields)
  const expectedKeys = field === 'address'
    ? ['address', 'address_1']
    : field === 'custom'
      ? [requirement.label]
      : [field]
  const normalizedKeys = new Set(expectedKeys.map(normalizeRequiredDataKey).filter(Boolean))
  const match = customFields.find((item) => {
    const identities = [item.key, item.fieldKey, item.id, item.label, item.name]
      .map(normalizeRequiredDataKey)
      .filter(Boolean)
    return identities.some((identity) => normalizedKeys.has(identity)) && cleanAppointmentText(item.value, 1000)
  })
  return match ? cleanAppointmentText(match.value, 1000) : ''
}

function requirementConditionMatches(requirement = {}, facts = {}) {
  const condition = requirement?.condition
  if (
    !condition || typeof condition !== 'object' || Array.isArray(condition) ||
    condition.operator !== 'is_true' || condition.value !== true
  ) return false
  const fact = String(condition.fact || '').trim()
  if (![
    'appointment.primary_attendee_is_different',
    'appointment.has_guests',
    'payment.is_deposit',
    'payment.is_full_payment'
  ].includes(fact)) return false
  return facts[fact] === true
}

function activeContactDataRequirements({ scope, dataRequirements, facts = {} } = {}) {
  if (!dataRequirements?.enabled) return []
  return (Array.isArray(dataRequirements.fields) ? dataRequirements.fields : [])
    .filter((item) => item?.scope === 'any_action' || item?.scope === scope)
    .filter((item) => (
      item?.level === 'required' ||
      (item?.level === 'conditional' && requirementConditionMatches(item, facts))
    ))
}

function appointmentRequirementFacts({ contact, primaryAttendee, attendeeName, attendeeContext, guests } = {}) {
  const legacyPrimary = attendeeName ? { name: attendeeName, relation: attendeeContext } : null
  const primary = cleanParticipant(primaryAttendee || legacyPrimary)
  const requesterName = cleanAppointmentText(contact?.full_name, 180).toLowerCase()
  const requesterPhone = normalizePhoneForStorage(contact?.phone || '')
  const requesterEmail = cleanAppointmentText(contact?.email, 180).toLowerCase()
  const primaryIsDifferent = Boolean(primary) && Boolean(
    (primary.name && primary.name.toLowerCase() !== requesterName) ||
    (primary.phone && normalizePhoneForStorage(primary.phone) !== requesterPhone) ||
    (primary.email && primary.email !== requesterEmail) ||
    primary.relation
  )
  const guestCount = (Array.isArray(guests) ? guests : [])
    .map((guest) => cleanParticipant(guest))
    .filter(Boolean)
    .length
  return {
    'appointment.primary_attendee_is_different': primaryIsDifferent,
    'appointment.has_guests': guestCount > 0
  }
}

function paymentRequirementFacts(paymentCapability = {}) {
  const isDeposit = paymentCapability?.chargeType === 'deposit' ||
    paymentCapability?.paymentMode === 'deposit' ||
    paymentCapability?.deposit?.enabled === true
  return {
    'payment.is_deposit': isDeposit,
    'payment.is_full_payment': !isDeposit
  }
}

function assertRequiredContactData({ scope, contact, dataRequirements, facts = {} } = {}) {
  if (!dataRequirements?.enabled) return { ok: true, missing: [] }
  const requirements = activeContactDataRequirements({ scope, dataRequirements, facts })
  if (!requirements.length) return { ok: true, missing: [] }

  const labels = {
    first_name: 'nombre',
    full_name: 'nombre completo',
    phone: 'teléfono',
    alternate_phone: 'otro teléfono',
    email: 'correo',
    company: 'empresa',
    address: 'dirección',
    custom: 'dato personalizado'
  }
  const missing = requirements
    .filter((requirement) => !requiredContactFieldValue(contact, requirement))
    .map((requirement) => ({
      field: requirement.field,
      label: cleanAppointmentText(requirement.label, 120) || labels[requirement.field] || requirement.field
    }))
  if (!missing.length) return { ok: true, missing: [] }
  return {
    ok: false,
    actionCompleted: false,
    needsData: true,
    requiredFields: missing,
    error: `Antes de continuar faltan datos obligatorios confirmados en la ficha: ${missing.map((item) => item.label).join(', ')}. Pide únicamente esos datos y guárdalos con save_contact_data; no ejecutes la acción todavía.`
  }
}

async function enforceRequiredContactData({ ctx, scope, dataRequirements, contact = null, facts = {} } = {}) {
  const hasRequiredFields = activeContactDataRequirements({ scope, dataRequirements, facts }).length > 0
  if (!hasRequiredFields) return null
  const resolvedContact = contact || await getThreadContact(ctx)
  if (!resolvedContact) return missingThreadContactResult(ctx)
  const validation = assertRequiredContactData({ scope, contact: resolvedContact, dataRequirements, facts })
  return validation.ok ? null : validation
}

async function guardMutationAgainstPreventiveMeasure(ctx = {}) {
  // Da oportunidad a que apply_safety_measure, aunque venga en el mismo lote
  // de tool calls de un proveedor compatible, establezca prioridad terminal.
  await new Promise((resolve) => setImmediate(resolve))
  if (ctx.preventiveSafetyRequested === true) {
    return {
      ok: false,
      actionCompleted: false,
      terminal: true,
      code: 'preventive_measure_wins',
      error: 'La medida preventiva tiene prioridad. Esta acción no se ejecutó.'
    }
  }
  if (ctx.dryRun) return null
  try {
    const active = await getActiveConversationalAgentPreventiveMeasure({
      contactId: ctx.contactId,
      channel: String(ctx.channel || 'whatsapp').trim().toLowerCase()
    })
    if (!active) return null
    return {
      ok: false,
      actionCompleted: false,
      terminal: true,
      code: 'preventive_measure_active',
      error: 'Este hilo tiene una medida preventiva activa. La acción no se ejecutó.'
    }
  } catch (error) {
    logger.error(`[Agente conversacional] No se pudo comprobar la medida preventiva antes de mutar: ${error.message}`)
    return {
      ok: false,
      actionCompleted: false,
      terminal: true,
      code: 'preventive_measure_check_failed',
      error: 'No se pudo comprobar si el hilo está en revisión preventiva. La acción se bloqueó por seguridad.'
    }
  }
}

const PREVENTIVE_FENCED_MUTATION_TOOLS = new Set([
  'save_contact_data',
  'book_appointment',
  'request_human_booking',
  'mark_ready_to_advance',
  'create_payment_link',
  'send_goal_url',
  'send_to_human',
  'register_deposit_payment_proof'
])

let preventiveMutationFenceHookForTest = null

export function setPreventiveMutationFenceHookForTest(hook = null) {
  preventiveMutationFenceHookForTest = typeof hook === 'function' ? hook : null
}

function wrapMutableToolWithPreventiveFence(toolDefinition, ctx = {}) {
  if (!toolDefinition || !PREVENTIVE_FENCED_MUTATION_TOOLS.has(toolDefinition.name)) return toolDefinition
  const invoke = toolDefinition.invoke.bind(toolDefinition)
  return {
    ...toolDefinition,
    invoke: async (...args) => {
      if (ctx.dryRun) return invoke(...args)
      const actionCountBeforeFence = Array.isArray(ctx.actions) ? ctx.actions.length : 0
      try {
        return await withConversationalAgentSafetyLock({
          contactId: ctx.contactId,
          channel: String(ctx.channel || 'whatsapp').trim().toLowerCase()
        }, async () => {
          // El chequeo y el efecto completo viven bajo el mismo candado. Así
          // ninguna otra instancia puede confirmar cuarentena entre ambos.
          const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
          if (safetyFence) return safetyFence
          if (preventiveMutationFenceHookForTest) {
            await preventiveMutationFenceHookForTest({
              toolName: toolDefinition.name,
              contactId: ctx.contactId,
              channel: String(ctx.channel || 'whatsapp').trim().toLowerCase()
            })
          }
          return invoke(...args)
        })
      } catch (error) {
        // El wrapper sólo traduce fallos al adquirir/sostener el fence. Si la
        // tool original lanzó, conserva exactamente el contrato de errores del
        // SDK para que su manejo normal no cambie.
        if (error?.conversationalSafetyLockCallbackStarted === true) throw error
        logger.error(`[Agente conversacional] No se pudo sostener el fence preventivo para ${toolDefinition.name}: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          terminal: true,
          code: error?.code || 'preventive_measure_lock_unavailable',
          error: 'No se pudo confirmar de forma segura el estado preventivo del hilo. La acción se bloqueó.'
        }
        if ((Array.isArray(ctx.actions) ? ctx.actions.length : 0) === actionCountBeforeFence) {
          const action = pushAction(ctx, toolDefinition.name, { blockedByPreventiveFence: true })
          settleAction(action, 'error', {
            ok: false,
            actionCompleted: false,
            terminal: true,
            code: errorResult.code,
            error: errorResult.error
          })
        }
        return errorResult
      }
    }
  }
}

const appointmentPersonSchema = z.object({
  name: z.string().nullable().describe('Nombre confirmado; null si no está disponible'),
  phone: z.string().nullable().describe('Teléfono confirmado; null si no fue requerido ni proporcionado'),
  phoneSourceQuote: z.preprocess(
    (value) => value ?? null,
    z.string().max(4000).nullable()
  ).describe('Mensaje COMPLETO y literal del cliente que proporcionó este teléfono; null si phone es null'),
  email: z.string().nullable().describe('Correo confirmado; null si no fue requerido ni proporcionado'),
  emailSourceQuote: z.preprocess(
    (value) => value ?? null,
    z.string().max(4000).nullable()
  ).describe('Mensaje COMPLETO y literal del cliente que proporcionó este correo; null si email es null'),
  relation: z.string().nullable().describe('Relación o contexto breve; null si no aplica')
})

function getToolRuntimeConfig(ctx = {}, config = {}) {
  return {
    ...config,
    capabilitiesConfig: ctx.capabilitiesConfig ?? config.capabilitiesConfig
  }
}

function getNativeCapability(ctx = {}, config = {}, capabilityId = '') {
  const capability = getConversationalCapability(getToolRuntimeConfig(ctx, config), capabilityId)
  return capability?.enabled ? capability : null
}

function getNativePaymentPurpose(ctx = {}, config = {}) {
  const payment = getNativeCapability(ctx, config, 'collect_payment')
  if (!payment) return ''
  if (payment.chargeType === 'deposit' || payment.paymentMode === 'deposit' || payment.deposit?.enabled === true) {
    return getNativeCapability(ctx, config, 'schedule_appointment')
      ? 'appointment_deposit'
      : 'deposit'
  }
  return 'purchase'
}

function normalizeCurrencyCode(value) {
  return String(value || '').trim().toUpperCase()
}

function currencyFractionDigits(currency) {
  try {
    const digits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: normalizeCurrencyCode(currency)
    }).resolvedOptions().maximumFractionDigits
    return Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 2
  } catch {
    return 2
  }
}

function normalizedMoney(value, currency = '') {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const factor = 10 ** currencyFractionDigits(currency)
  return Math.round((amount + Number.EPSILON) * factor) / factor
}

function currencyComparisonTolerance(currency) {
  return 0.5 / (10 ** currencyFractionDigits(currency))
}

function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function buildConversationalSlotRequestId(calendarId, startTime, {
  allowOverlaps = false,
  contactId = '',
  channel = '',
  executionId = ''
} = {}) {
  const resource = [calendarId, startTime, contactId, channel, executionId, allowOverlaps ? 'overlap' : 'exclusive'].join('\u0000')
  const digest = createHash('sha256').update(resource).digest('hex')
  return `conv-v2-attempt:${digest}`
}

async function resolveNativePaymentAuthority({ capability, quantity = 1, agreedAmount = null, accountCurrency = '' } = {}) {
  const boundedQuantity = Number(quantity || 1)
  if (!Number.isInteger(boundedQuantity) || boundedQuantity < 1 || boundedQuantity > 100) {
    return { ok: false, actionCompleted: false, error: 'La cantidad debe ser un entero entre 1 y 100. No se creó ningún link.' }
  }

  const trustedAccountCurrency = normalizeCurrencyCode(accountCurrency)
  if (!trustedAccountCurrency) {
    return { ok: false, actionCompleted: false, transferRequired: true, error: 'No se pudo leer la moneda configurada en la cuenta. No se creó ningún link.' }
  }

  const usesDeposit = capability?.chargeType === 'deposit' || capability?.paymentMode === 'deposit' || capability?.deposit?.enabled === true
  if (usesDeposit) {
    const deposit = capability.deposit || {}
    if (boundedQuantity !== 1) {
      return { ok: false, actionCompleted: false, error: 'Un anticipo se cobra una sola vez; la cantidad debe ser 1. No se creó ningún link.' }
    }
    const explicitAgreedAmount = agreedAmount === null || agreedAmount === undefined
      ? 0
      : normalizedMoney(agreedAmount, trustedAccountCurrency)
    const minAmount = normalizedMoney(deposit.minAmount, trustedAccountCurrency)
    const maxAmount = normalizedMoney(deposit.maxAmount, trustedAccountCurrency)
    const fixedAmount = normalizedMoney(deposit.amount, trustedAccountCurrency)
    let amount = fixedAmount
    if (deposit.mode === 'range') {
      if (!explicitAgreedAmount) {
        return {
          ok: false,
          actionCompleted: false,
          needsData: true,
          requiredField: 'agreedAmount',
          error: `Falta el monto acordado del anticipo${minAmount && maxAmount ? ` (debe estar entre ${minAmount} y ${maxAmount} ${trustedAccountCurrency})` : ''}. Pregúntalo antes de crear el link.`
        }
      }
      if ((minAmount && explicitAgreedAmount < minAmount) || (maxAmount && explicitAgreedAmount > maxAmount)) {
        return {
          ok: false,
          actionCompleted: false,
          amountOutOfRange: true,
          minAmount: minAmount || null,
          maxAmount: maxAmount || null,
          error: `El monto acordado (${explicitAgreedAmount} ${trustedAccountCurrency}) está fuera del rango configurado. No se creó ningún link.`
        }
      }
      amount = explicitAgreedAmount
    } else if (explicitAgreedAmount && Math.abs(explicitAgreedAmount - fixedAmount) >= currencyComparisonTolerance(trustedAccountCurrency)) {
      return {
        ok: false,
        actionCompleted: false,
        amountMismatch: true,
        error: `El anticipo fijo configurado es ${fixedAmount} ${trustedAccountCurrency}; el monto acordado no coincide. No se creó ningún link.`
      }
    }
    const currency = normalizeCurrencyCode(deposit.currency || capability.currency || trustedAccountCurrency)
    if (!amount) {
      return { ok: false, actionCompleted: false, transferRequired: true, error: 'El anticipo configurado no tiene un monto válido. No se creó ningún link.' }
    }
    if (currency !== trustedAccountCurrency) {
      return {
        ok: false,
        actionCompleted: false,
        currencyMismatch: true,
        error: `El anticipo configurado usa ${currency || 'una moneda inválida'} y la cuenta usa ${trustedAccountCurrency}. No se creó ningún link.`
      }
    }
    return {
      ok: true,
      trusted: {
        amount,
        currency: trustedAccountCurrency,
        concept: 'Anticipo',
        quantity: 1,
        source: 'capability_deposit',
        productId: capability.productId || null,
        priceId: capability.priceId || null,
        gateway: capability.gateway || 'highlevel',
        installments: capability.installments || { enabled: false, maxInstallments: 0 },
        expirationMinutes: capability.expirationMinutes || 60,
        afterPayment: capability.afterPayment || 'continue'
      }
    }
  }

  if (capability?.chargeType === 'direct') {
    if (boundedQuantity !== 1) {
      return { ok: false, actionCompleted: false, error: 'Un cobro directo usa cantidad 1. No se creó ningún link.' }
    }
    const direct = capability.direct || {}
    const currency = normalizeCurrencyCode(direct.currency || capability.currency || trustedAccountCurrency)
    const amount = normalizedMoney(direct.amount, currency)
    if (!amount || !String(direct.concept || '').trim()) {
      return { ok: false, actionCompleted: false, transferRequired: true, error: 'El cobro directo no tiene monto y concepto válidos. No se creó ningún link.' }
    }
    if (currency !== trustedAccountCurrency) {
      return { ok: false, actionCompleted: false, currencyMismatch: true, error: `El cobro configurado usa ${currency || 'una moneda inválida'} y la cuenta usa ${trustedAccountCurrency}. No se creó ningún link.` }
    }
    const explicitAgreedAmount = agreedAmount === null || agreedAmount === undefined
      ? 0
      : normalizedMoney(agreedAmount, trustedAccountCurrency)
    if (explicitAgreedAmount && Math.abs(explicitAgreedAmount - amount) >= currencyComparisonTolerance(trustedAccountCurrency)) {
      return { ok: false, actionCompleted: false, amountMismatch: true, error: `El monto indicado no coincide con el cobro configurado (${amount} ${trustedAccountCurrency}). No se creó ningún link.` }
    }
    return {
      ok: true,
      trusted: {
        amount,
        unitAmount: amount,
        currency: trustedAccountCurrency,
        concept: String(direct.concept).trim(),
        description: String(direct.description || '').trim(),
        quantity: 1,
        source: 'capability_direct',
        productId: null,
        priceId: null,
        gateway: capability.gateway || 'highlevel',
        installments: capability.installments || { enabled: false, maxInstallments: 0 },
        expirationMinutes: capability.expirationMinutes || 60,
        afterPayment: capability.afterPayment || 'continue'
      }
    }
  }

  const productId = String(capability?.productId || '').trim()
  const priceId = String(capability?.priceId || '').trim()
  if (!productId || !priceId) {
    return { ok: false, actionCompleted: false, transferRequired: true, error: 'La capacidad de cobro no tiene producto y precio configurados. No se creó ningún link.' }
  }

  const row = await db.get(`
    SELECT
      p.id AS product_id,
      p.ghl_product_id,
      p.name AS product_name,
      p.currency AS product_currency,
      pp.id AS price_id,
      pp.ghl_price_id,
      pp.name AS price_name,
      pp.amount,
      pp.currency AS price_currency
    FROM products p
    INNER JOIN product_prices pp ON pp.product_id = p.id
    WHERE p.is_active = 1
      AND (p.id = ? OR p.ghl_product_id = ?)
      AND (pp.id = ? OR pp.ghl_price_id = ?)
    LIMIT 1
  `, [productId, productId, priceId, priceId])
  if (!row) {
    return { ok: false, actionCompleted: false, transferRequired: true, error: 'El producto o precio configurado ya no existe o no está activo. No se creó ningún link.' }
  }

  const currency = normalizeCurrencyCode(row.price_currency || row.product_currency || trustedAccountCurrency)
  const unitAmount = normalizedMoney(row.amount, currency)
  if (!unitAmount) {
    return { ok: false, actionCompleted: false, transferRequired: true, error: 'El precio guardado no tiene un monto válido. No se creó ningún link.' }
  }
  if (currency !== trustedAccountCurrency) {
    return {
      ok: false,
      actionCompleted: false,
      currencyMismatch: true,
      error: `El precio guardado usa ${currency || 'una moneda inválida'} y la cuenta usa ${trustedAccountCurrency}. No se creó ningún link.`
    }
  }

  const amount = normalizedMoney(unitAmount * boundedQuantity, trustedAccountCurrency)
  const explicitAgreedAmount = agreedAmount === null || agreedAmount === undefined
    ? 0
    : normalizedMoney(agreedAmount, trustedAccountCurrency)
  if (explicitAgreedAmount && Math.abs(explicitAgreedAmount - amount) >= currencyComparisonTolerance(trustedAccountCurrency)) {
    return {
      ok: false,
      actionCompleted: false,
      amountMismatch: true,
      error: `El monto indicado no coincide con el precio real (${amount} ${trustedAccountCurrency}). No se creó ningún link.`
    }
  }
  return {
    ok: true,
    trusted: {
      amount,
      unitAmount,
      currency: trustedAccountCurrency,
      concept: [row.product_name, row.price_name].filter(Boolean).join(' · ') || 'Pago',
      quantity: boundedQuantity,
      source: 'product_price',
      productId: row.product_id,
      priceId: row.price_id,
      gateway: capability.gateway || 'highlevel',
      installments: capability.installments || { enabled: false, maxInstallments: 0 },
      expirationMinutes: capability.expirationMinutes || 60,
      afterPayment: capability.afterPayment || 'continue'
    }
  }
}

async function assignNativeHandoffUser({ contactId, capability } = {}) {
  const configuredUserId = String(capability?.userId || '').trim()
  if (!configuredUserId) return { assigned: false, alreadyAssigned: false, userName: null }

  return db.transaction(async () => {
    const user = await db.get(
      `SELECT id, username, email, full_name
       FROM users
       WHERE CAST(id AS TEXT) = ? AND is_active = 1
       LIMIT 1`,
      [configuredUserId]
    )
    if (!user?.id) {
      const error = new Error('La persona configurada para recibir el chat ya no está activa. No se completó la transferencia.')
      error.status = 409
      error.code = 'handoff_user_unavailable'
      throw error
    }

    const contact = await db.get(
      'SELECT id, assigned_user_id, assignment_test_effect_id FROM contacts WHERE id = ?',
      [contactId]
    )
    if (!contact?.id) {
      const error = new Error('El contacto ya no existe. No se completó la transferencia.')
      error.status = 404
      error.code = 'handoff_contact_not_found'
      throw error
    }

    const assignedUserId = String(user.id)
    const hasTemporaryTestAssignment = Boolean(String(contact.assignment_test_effect_id || '').trim())
    let alreadyAssigned = String(contact.assigned_user_id || '') === assignedUserId && !hasTemporaryTestAssignment
    if (!alreadyAssigned || hasTemporaryTestAssignment) {
      const update = await db.run(
        `UPDATE contacts
         SET assigned_user_id = ?, assignment_test_effect_id = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND (
             assigned_user_id IS NULL
             OR CAST(assigned_user_id AS TEXT) <> ?
             OR assignment_test_effect_id IS NOT NULL
           )`,
        [assignedUserId, contactId, assignedUserId]
      )
      if (Number(update?.changes ?? update?.rowCount ?? 0) !== 1) {
        const current = await db.get(
          'SELECT assigned_user_id, assignment_test_effect_id FROM contacts WHERE id = ?',
          [contactId]
        )
        const committed = String(current?.assigned_user_id || '') === assignedUserId &&
          !String(current?.assignment_test_effect_id || '').trim()
        if (!committed) {
          const error = new Error('No se pudo asignar el contacto a la persona configurada. No se completó la transferencia.')
          error.status = 503
          error.code = 'handoff_assignment_failed'
          throw error
        }
        alreadyAssigned = true
      }
    }

    const userName = String(user.full_name || user.email || user.username || capability?.userName || '').trim().slice(0, 180)
    return { assigned: true, alreadyAssigned, assignedUserId, userName: userName || null }
  })
}

let nativeHandoffAfterAssignmentHookForTest = null
let nativePaymentReceiptAnalysisHookForTest = null

export function setNativeHandoffAfterAssignmentHookForTest(hook = null) {
  nativeHandoffAfterAssignmentHookForTest = typeof hook === 'function' ? hook : null
}

export function setNativePaymentReceiptAnalysisHookForTest(hook = null) {
  nativePaymentReceiptAnalysisHookForTest = typeof hook === 'function' ? hook : null
}

/**
 * El handoff v2 cambia dos fuentes de verdad: quién atiende al contacto y el
 * estado terminal de la conversación. Deben confirmar o revertirse juntas;
 * de otro modo un fallo después de asignar deja al contacto en manos de una
 * persona mientras el bot cree que la transferencia no ocurrió.
 *
 * db.transaction usa la misma conexión mediante AsyncLocalStorage tanto en
 * SQLite como en Postgres, por lo que assignNativeHandoffUser (transacción
 * anidada), setConversationSignal y sus eventos participan del mismo commit.
 */
async function commitNativeHandoff({
  ctx,
  config,
  capability,
  signal = 'ready_for_human',
  signalOptions = {},
  assignmentEventSource = 'handoff_human',
  evidenceEvent = null
} = {}) {
  return db.transaction(async () => {
    let evidenceInserted = null
    const assignment = await assignNativeHandoffUser({
      contactId: ctx.contactId,
      capability
    })

    if (nativeHandoffAfterAssignmentHookForTest) {
      await nativeHandoffAfterAssignmentHookForTest({
        contactId: ctx.contactId,
        agentId: config.id || ctx.agentId || null,
        channel: ctx.channel || 'whatsapp',
        signal,
        assignment
      })
    }

    const state = await setConversationSignal(ctx.contactId, signal, {
      ...signalOptions,
      agentId: config.id || ctx.agentId || '',
      channel: ctx.channel || 'whatsapp',
      strictEvent: true
    })
    if (!state?.id) {
      const error = new Error('No se pudo confirmar el estado de la conversación. No se completó la transferencia.')
      error.status = 503
      error.code = 'handoff_state_commit_failed'
      throw error
    }

    if (assignment.assigned && !assignment.alreadyAssigned) {
      await recordConversationalAgentEvent({
        contactId: ctx.contactId,
        eventType: 'handoff_user_assigned',
        detail: {
          agentId: config.id || ctx.agentId || null,
          assignedUserId: assignment.assignedUserId,
          assignedUserName: assignment.userName || null,
          source: assignmentEventSource
        },
        throwOnError: true
      })
    }

    if (evidenceEvent?.eventType) {
      const evidenceResult = await recordConversationalAgentEvent({
        eventId: evidenceEvent.eventId || '',
        contactId: ctx.contactId,
        eventType: evidenceEvent.eventType,
        detail: {
          ...(evidenceEvent.detail && typeof evidenceEvent.detail === 'object' ? evidenceEvent.detail : {}),
          agentId: config.id || ctx.agentId || null
        },
        throwOnError: true
      })
      evidenceInserted = evidenceResult?.inserted === true
    }

    return { assignment, state, evidenceInserted }
  })
}

async function resolveNativeScheduleCalendar(capability = {}) {
  const configuredId = String(capability?.calendarId || '').trim()
  if (!configuredId) return null
  const calendar = await db.get(
    `SELECT id, ghl_calendar_id, name, slot_duration, is_active
     FROM calendars
     WHERE id = ? OR ghl_calendar_id = ?
     LIMIT 1`,
    [configuredId, configuredId]
  )
  if (!calendar?.id) return null
  const activeValue = String(calendar.is_active ?? '1').trim().toLowerCase()
  if (['0', 'false', 'off'].includes(activeValue)) return null
  return calendar
}

export function buildNativeFreeSlotDays(days = [], fallbackTimezone = '') {
  const timezone = resolveTimezone(fallbackTimezone)

  return (Array.isArray(days) ? days : []).map((day) => {
    const dayTimezone = resolveTimezone(day?.timezone, timezone)
    const options = (Array.isArray(day?.slots) ? day.slots : []).flatMap((startTime) => {
      const option = buildCanonicalAppointmentSlotOption(startTime, dayTimezone)
      return option
        ? [{
            startTime: option.startTime,
            localDate: option.localDate,
            localTime: option.localTime,
            localLabel: option.localLabel
          }]
        : []
    })

    return {
      localDate: String(day?.date || options[0]?.localDate || '').trim() || null,
      timezone: dayTimezone,
      options
    }
  }).filter((day) => day.options.length > 0)
}

const NATIVE_APPOINTMENT_SELECTION_EVENT = 'appointment_slot_selection_verified'
const NATIVE_APPOINTMENT_OFFER_EVENT = 'appointment_slot_offer_created'
const NATIVE_APPOINTMENT_DEPOSIT_INTENT_EVENT = 'appointment_deposit_intent_pending'
const NATIVE_APPOINTMENT_RECEIPT_INTENT_EVENT = 'appointment_deposit_receipt_intent_bound'
const NATIVE_APPOINTMENT_SELECTION_COLLECTION_TTL_MS = 15 * 60 * 1000
const NATIVE_APPOINTMENT_TRANSFER_INTENT_TTL_MS = 24 * 60 * 60 * 1000

function parseNativeEventDetail(value) {
  try {
    const parsed = value ? JSON.parse(value) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function appointmentSelectionError(message, code = 'appointment_selection_required') {
  return { ok: false, actionCompleted: false, confirmationRequired: true, code, error: message }
}

function nativeAppointmentOfferText(localLabel = '') {
  const label = String(localLabel || '').trim()
  const separator = /[.!?]$/u.test(label) ? ' ' : '. '
  return `Tengo disponible ${label}${separator}¿Te funciona ese horario?`
}

async function persistNativeAppointmentOffer({ ctx, config, calendarId, startTime, localLabel, timezone } = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  if (ctx?.dryRun && !previewScopeId) {
    return appointmentSelectionError(
      'La sesión del tester no conserva una identidad segura para la oferta. Reinicia el chat de prueba.',
      'appointment_preview_scope_missing'
    )
  }
  if (!agentId || !contactId || !executionId || !calendarId || !startTime || !localLabel) {
    return appointmentSelectionError('No se pudo identificar la oferta de horario. No se mostró ningún horario.', 'appointment_offer_identity_missing')
  }
  const eventType = previewScopeId
    ? CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT
    : NATIVE_APPOINTMENT_OFFER_EVENT
  const eventId = previewScopeId
    ? buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
    : `cae_appointment_offer_${createHash('sha256').update([
        agentId, contactId, calendarId, startTime, executionId
      ].join('\u0000')).digest('hex').slice(0, 48)}`
  const detail = {
    agentId,
    contactId,
    calendarId,
    startTime,
    localLabel,
    timezone,
    channel: String(ctx?.channel || '').trim(),
    executionId,
    offerText: nativeAppointmentOfferText(localLabel),
    status: 'active',
    offeredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + NATIVE_APPOINTMENT_SELECTION_COLLECTION_TTL_MS).toISOString(),
    ...(previewScopeId ? { previewScopeId } : {})
  }

  if (previewScopeId) {
    let previewConflict = false
    await db.transaction(async () => {
      const inserted = await db.run(
        `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        [eventId, contactId, agentId, eventType, JSON.stringify(detail)]
      )
      if (Number(inserted?.changes ?? inserted?.rowCount ?? 0) === 1) return
      const current = await db.get(
        `SELECT contact_id, agent_id, event_type, detail_json
         FROM conversational_agent_events WHERE id = ?`,
        [eventId]
      )
      const currentDetail = parseNativeEventDetail(current?.detail_json)
      if (
        current?.event_type !== eventType ||
        String(current?.contact_id || '') !== contactId ||
        String(current?.agent_id || '') !== agentId ||
        String(currentDetail.previewScopeId || '') !== previewScopeId ||
        (String(currentDetail.channel || '') && String(currentDetail.channel || '') !== String(detail.channel || '')) ||
        ['materializing', 'materialized'].includes(String(currentDetail.status || ''))
      ) {
        previewConflict = true
        return
      }
      const updated = await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = ? AND detail_json = ?`,
        [JSON.stringify(detail), eventId, contactId, agentId, eventType, current.detail_json]
      )
      if (Number(updated?.changes ?? updated?.rowCount ?? 0) !== 1) previewConflict = true
    })
    if (previewConflict) {
      return appointmentSelectionError(
        'La identidad de esta sesión de prueba cambió. Reinicia el chat antes de ofrecer otro horario.',
        'appointment_preview_offer_conflict'
      )
    }
  } else {
  await db.transaction(async () => {
    const contactLock = await db.get(
      `SELECT id FROM contacts WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
      [contactId]
    )
    if (!contactLock?.id) throw new Error('El contacto dejó de existir antes de guardar la oferta')
    const inserted = await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      [eventId, contactId, agentId, eventType, JSON.stringify(detail)]
    )
    if (Number(inserted?.changes ?? inserted?.rowCount ?? 0) !== 1) return
    const rows = await db.all(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = ? AND id != ?`,
      [contactId, agentId, eventType, eventId]
    )
    const supersededAt = new Date().toISOString()
    for (const row of rows || []) {
      const prior = parseNativeEventDetail(row.detail_json)
      if (String(prior.status || '') !== 'active') continue
      await db.run(
        'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
        [JSON.stringify({ ...prior, status: 'superseded', supersededAt, supersededByOfferEventId: eventId }), row.id, row.detail_json]
      )
    }
  })
  }
  const stored = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json FROM conversational_agent_events WHERE id = ?`,
    [eventId]
  )
  const storedDetail = parseNativeEventDetail(stored?.detail_json)
  if (
    stored?.event_type !== eventType ||
    String(stored?.contact_id || '') !== contactId ||
    String(stored?.agent_id || '') !== agentId ||
    String(storedDetail.status || '') !== 'active' ||
    String(storedDetail.calendarId || '') !== String(calendarId) ||
    String(storedDetail.startTime || '') !== String(startTime) ||
    (previewScopeId && String(storedDetail.previewScopeId || '') !== previewScopeId)
  ) {
    return appointmentSelectionError('La oferta de horario ya fue reemplazada por otra. Vuelve a ofrecer un solo horario.', 'appointment_offer_superseded')
  }
  return {
    ok: true,
    durable: true,
    preview: Boolean(previewScopeId),
    offerEventId: eventId,
    detail: storedDetail
  }
}

function verifiedTestPaymentAuthorizesPreviewOffer({ ctx, offer, detail } = {}) {
  const evidence = ctx?.dryRun && ctx?.testVerifiedPaymentEvidence && typeof ctx.testVerifiedPaymentEvidence === 'object'
    ? ctx.testVerifiedPaymentEvidence
    : null
  if (!evidence || !offer?.detail_json) return false
  return Boolean(
    String(evidence.paymentMode || '').toLowerCase() === 'test' &&
    String(evidence.paymentPurpose || '') === 'appointment_deposit' &&
    String(evidence.previewScopeId || '') === String(ctx?.previewScopeId || '') &&
    String(evidence.previewScopeId || '') === String(detail?.previewScopeId || '') &&
    String(evidence.appointmentOfferEventId || '') === String(offer?.id || '') &&
    String(evidence.appointmentOfferFingerprint || '') === createHash('sha256').update(String(offer.detail_json)).digest('hex') &&
    String(evidence.calendarId || '') === String(detail?.calendarId || '') &&
    String(evidence.startTime || '') === String(detail?.startTime || '') &&
    String(evidence.testRunId || '').trim() &&
    String(evidence.testEffectId || '').trim()
  )
}

async function loadNativeAppointmentOfferCandidate({ ctx, config } = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const channel = String(ctx?.channel || '').trim()
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  if (!agentId || !contactId) {
    return appointmentSelectionError(
      'No se pudo identificar la conversación de la oferta. No se agendó nada.',
      'appointment_offer_identity_missing'
    )
  }
  if (ctx?.dryRun && !previewScopeId) {
    return appointmentSelectionError(
      'La sesión del tester no conserva la oferta anterior. Reinicia el chat de prueba.',
      'appointment_preview_scope_missing'
    )
  }

  const eventType = previewScopeId
    ? CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT
    : NATIVE_APPOINTMENT_OFFER_EVENT
  const rows = previewScopeId
    ? [await db.get(
        `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
         FROM conversational_agent_events WHERE id = ?`,
        [buildConversationalAppointmentPreviewOfferEventId(previewScopeId)]
      )].filter(Boolean)
    : await db.all(
        `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
         FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = ?
         ORDER BY created_at DESC, id DESC LIMIT 20`,
        [contactId, agentId, eventType]
      )

  const eligible = []
  let expired = false
  let sameExecution = false
  for (const row of rows || []) {
    const detail = parseNativeEventDetail(row.detail_json)
    if (
      row.event_type !== eventType ||
      String(row.contact_id || '') !== contactId ||
      String(row.agent_id || '') !== agentId ||
      (previewScopeId && String(detail.previewScopeId || '') !== previewScopeId) ||
      (String(detail.channel || '') && String(detail.channel || '') !== channel)
    ) continue
    const status = String(detail.status || '')
    const expiresAtMs = Date.parse(detail.expiresAt || '')
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      expired = true
      continue
    }
    if (status === 'active') {
      if (String(detail.executionId || '') === executionId) {
        sameExecution = true
        continue
      }
      eligible.push({ ...row, detail })
      continue
    }
    if (previewScopeId) {
      const testPaymentResume = status === 'accepted' && verifiedTestPaymentAuthorizesPreviewOffer({ ctx, offer: row, detail })
      if (
        status === 'accepted' &&
        (String(detail.acceptedExecutionId || '') === executionId || testPaymentResume)
      ) {
        eligible.push({ ...row, detail, testPaymentResume })
      }
      continue
    }
    if (status !== 'accepted' || !detail.selectionEventId) continue
    const selection = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ? AND event_type = ?',
      [detail.selectionEventId, NATIVE_APPOINTMENT_SELECTION_EVENT]
    )
    const selectionDetail = parseNativeEventDetail(selection?.detail_json)
    if (
      String(selectionDetail.offerEventId || '') === row.id &&
      String(selectionDetail.executionId || '') === executionId
    ) eligible.push({ ...row, detail })
  }
  if (eligible.length !== 1) {
    return appointmentSelectionError(
      expired
        ? 'La oferta de horario expiró. Consulta disponibilidad y ofrece un horario nuevo.'
        : sameExecution
          ? 'La oferta necesita una respuesta nueva de la persona en otro turno antes de poder confirmarse.'
        : 'No hay una única oferta estructurada vigente. Ofrece un solo horario con offer_appointment_slot.',
      expired
        ? 'appointment_offer_expired'
        : (sameExecution ? 'appointment_confirmation_turn_required' : 'appointment_offer_required')
    )
  }
  return { ok: true, offer: eligible[0], preview: Boolean(previewScopeId) }
}

async function verifyNativeAppointmentOfferEvent({ ctx, config, calendarId, startTime, evidence } = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  if (evidence?.reusedForPaymentResume === true) {
    const selectionEventId = String(evidence?.selectionEventId || '').trim()
    const selection = await db.get(
      `SELECT id, contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [selectionEventId]
    )
    const selectionDetail = parseNativeEventDetail(selection?.detail_json)
    const offerEventId = String(selectionDetail.offerEventId || '').trim()
    const offer = offerEventId
      ? await db.get(
          `SELECT id, contact_id, agent_id, event_type, detail_json
           FROM conversational_agent_events WHERE id = ?`,
          [offerEventId]
        )
      : null
    const offerDetail = parseNativeEventDetail(offer?.detail_json)
    const exactDurableChain = Boolean(
      selection?.event_type === NATIVE_APPOINTMENT_SELECTION_EVENT &&
      String(selection?.contact_id || '') === contactId &&
      String(selection?.agent_id || '') === agentId &&
      String(selectionDetail.status || '') === 'active' &&
      String(selectionDetail.calendarId || '') === String(calendarId || '') &&
      String(selectionDetail.startTime || '') === String(startTime || '') &&
      offer?.event_type === NATIVE_APPOINTMENT_OFFER_EVENT &&
      String(offer?.contact_id || '') === contactId &&
      String(offer?.agent_id || '') === agentId &&
      String(offerDetail.status || '') === 'accepted' &&
      String(offerDetail.selectionEventId || '') === selectionEventId &&
      String(offerDetail.calendarId || '') === String(calendarId || '') &&
      String(offerDetail.startTime || '') === String(startTime || '')
    )
    return exactDurableChain
      ? { ok: true, offerEventId, offerDetail }
      : appointmentSelectionError('La selección pagada no conserva una oferta estructurada exacta. No se agendó nada.', 'payment_resume_offer_mismatch')
  }
  const candidate = await loadNativeAppointmentOfferCandidate({ ctx, config })
  if (!candidate.ok) return candidate
  const offer = candidate.offer
  const offerTurnIds = new Set(Array.isArray(evidence?.offerTurnMessageIds) ? evidence.offerTurnMessageIds.map(String) : [])
  const offerTurnText = (Array.isArray(ctx?.conversationMessages) ? ctx.conversationMessages : [])
    .filter((message) => offerTurnIds.has(String(message?.id || '')))
    .map((message) => String(message?.content ?? message?.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const expectedText = String(offer.detail.offerText || '').replace(/\s+/g, ' ').trim()
  if (
    String(offer.detail.calendarId || '') !== String(calendarId || '') ||
    String(offer.detail.startTime || '') !== String(startTime || '') ||
    String(offer.detail.localLabel || '') !== String(evidence?.localLabel || '') ||
    (evidence?.offerEventId && String(evidence.offerEventId) !== String(offer.id)) ||
    (
      String(offer.detail.status || '') === 'active' &&
      (!Number.isFinite(Date.parse(offer.detail.expiresAt || '')) || Date.parse(offer.detail.expiresAt || '') <= Date.now())
    ) ||
    offerTurnText !== expectedText
  ) {
    return appointmentSelectionError('La respuesta no confirma la oferta estructurada vigente o el agente agregó otro horario. Reofrece uno solo.', 'appointment_offer_mismatch')
  }
  return { ok: true, offerEventId: offer.id, offerDetail: offer.detail }
}

async function persistNativeAppointmentSelection({
  ctx,
  config,
  calendarId,
  startTime,
  evidence
} = {}) {
  if (ctx.dryRun) {
    const previewScopeId = isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
      ? String(ctx.previewScopeId).trim()
      : ''
    const offerEventId = String(evidence?.offerEventId || '').trim()
    const executionId = String(ctx?.executionId || '').trim()
    if (!previewScopeId || !offerEventId || !executionId) {
      return appointmentSelectionError(
        'La prueba perdió el vínculo interno con la oferta. Reinicia el chat y vuelve a ofrecer el horario.',
        'appointment_preview_selection_identity_missing'
      )
    }
    const current = await db.get(
      `SELECT id, contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [offerEventId]
    )
    const currentDetail = parseNativeEventDetail(current?.detail_json)
    const sameIdentity = Boolean(
      current?.event_type === CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT &&
      String(current?.contact_id || '') === String(ctx?.contactId || '') &&
      String(current?.agent_id || '') === String(config?.id || ctx?.agentId || '') &&
      String(currentDetail.previewScopeId || '') === previewScopeId &&
      String(currentDetail.calendarId || '') === String(calendarId || '') &&
      String(currentDetail.startTime || '') === String(startTime || '')
    )
    if (!sameIdentity) {
      return appointmentSelectionError(
        'La oferta de prueba cambió antes de confirmar el horario. No se registró ninguna acción.',
        'appointment_preview_offer_mismatch'
      )
    }
    if (
      String(currentDetail.status || '') === 'accepted' &&
      verifiedTestPaymentAuthorizesPreviewOffer({ ctx, offer: current, detail: currentDetail })
    ) {
      return {
        ...evidence,
        durable: true,
        preview: true,
        reusedForTestPaymentResume: true,
        selectionEventId: null
      }
    }
    if (
      String(currentDetail.status || '') === 'accepted' &&
      String(currentDetail.acceptedExecutionId || '') === executionId
    ) {
      return { ...evidence, durable: true, preview: true, selectionEventId: null }
    }
    if (String(currentDetail.status || '') !== 'active') {
      return appointmentSelectionError(
        'La oferta de prueba ya fue consumida por otro mensaje. Ofrece un horario nuevo.',
        'appointment_preview_offer_already_consumed'
      )
    }
    const acceptedDetail = {
      ...currentDetail,
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
      acceptedExecutionId: executionId
    }
    const accepted = await db.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND event_type = ? AND detail_json = ?`,
      [JSON.stringify(acceptedDetail), offerEventId, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT, current.detail_json]
    )
    if (Number(accepted?.changes ?? accepted?.rowCount ?? 0) !== 1) {
      const replay = await db.get(
        'SELECT detail_json FROM conversational_agent_events WHERE id = ? AND event_type = ?',
        [offerEventId, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT]
      )
      const replayDetail = parseNativeEventDetail(replay?.detail_json)
      if (
        String(replayDetail.status || '') !== 'accepted' ||
        String(replayDetail.acceptedExecutionId || '') !== executionId
      ) {
        return appointmentSelectionError(
          'Otro mensaje cambió la oferta mientras se confirmaba. No se registró ninguna acción.',
          'appointment_preview_selection_race'
        )
      }
    }
    return { ...evidence, durable: true, preview: true, selectionEventId: null }
  }
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const customerMessageId = String(evidence?.customerMessageId || '').trim()
  const latestCustomerMessageId = String(evidence?.latestCustomerMessageId || customerMessageId).trim()
  const offerMessageId = String(evidence?.offerMessageId || '').trim()
  const offerEventId = String(evidence?.offerEventId || '').trim()
  const customerMessageIds = Array.isArray(evidence?.customerMessageIds)
    ? evidence.customerMessageIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [customerMessageId].filter(Boolean)
  const offerTurnMessageIds = Array.isArray(evidence?.offerTurnMessageIds)
    ? evidence.offerTurnMessageIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [offerMessageId].filter(Boolean)
  const offerTurnId = String(evidence?.offerTurnId || '').trim()
  if (!agentId || !contactId || !calendarId || !startTime || !executionId || !customerMessageId || !latestCustomerMessageId || !offerMessageId || !offerTurnId || !offerEventId) {
    return appointmentSelectionError(
      'No se pudo identificar de forma durable la oferta y la respuesta que eligieron el horario. No se agendó nada.',
      'appointment_selection_identity_missing'
    )
  }
  if (latestCustomerMessageId !== executionId) {
    return appointmentSelectionError(
      'La confirmación no pertenece al mensaje que se está procesando. No se agendó nada.',
      'appointment_selection_message_mismatch'
    )
  }
  const customerQuote = String(evidence?.customerQuote || '').trim()
  const customerQuoteHash = createHash('sha256').update(customerQuote).digest('hex')
  const customerMessageIdsHash = createHash('sha256').update(customerMessageIds.join('\u0000')).digest('hex')
  const offerTurnMessageIdsHash = createHash('sha256').update(offerTurnMessageIds.join('\u0000')).digest('hex')
  const eventId = `cae_appointment_selection_${createHash('sha256').update([
    agentId,
    contactId,
    calendarId,
    startTime,
    executionId,
    offerMessageId,
    offerEventId,
    customerQuoteHash
  ].join('\u0000')).digest('hex').slice(0, 48)}`
  const detail = {
    agentId,
    contactId,
    calendarId,
    startTime,
    executionId,
    customerMessageId,
    customerMessageIds,
    customerMessageIdsHash,
    latestCustomerMessageId,
    offerMessageId,
    offerEventId,
    offerTurnId,
    offerTurnMessageIds,
    offerTurnMessageIdsHash,
    selectionMode: 'accepted_prior_offer',
    localLabel: String(evidence?.localLabel || ''),
    timezone: String(evidence?.timezone || ''),
    customerQuoteHash,
    customerQuoteLength: customerQuote.length,
    customerQuotePreview: customerQuote.slice(0, 800),
    status: 'active',
    verifiedAt: new Date().toISOString()
  }
  await db.transaction(async () => {
    const contactLock = await db.get(
      `SELECT id FROM contacts WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
      [contactId]
    )
    if (!contactLock?.id) throw new Error('El contacto dejó de existir antes de guardar la selección del horario')
    const offer = await db.get(
      `SELECT id, contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [offerEventId]
    )
    const offerDetail = parseNativeEventDetail(offer?.detail_json)
    if (
      offer?.event_type !== NATIVE_APPOINTMENT_OFFER_EVENT ||
      String(offer?.contact_id || '') !== contactId ||
      String(offer?.agent_id || '') !== agentId ||
      !(
        String(offerDetail.status || '') === 'active' ||
        (
          String(offerDetail.status || '') === 'accepted' &&
          String(offerDetail.selectionEventId || '') === eventId
        )
      ) ||
      String(offerDetail.calendarId || '') !== String(calendarId) ||
      String(offerDetail.startTime || '') !== String(startTime)
    ) throw new Error('La oferta estructurada dejó de estar activa antes de guardar la selección')
    const inserted = await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [eventId, contactId, agentId, NATIVE_APPOINTMENT_SELECTION_EVENT, JSON.stringify(detail)]
    )
    if (Number(inserted?.changes ?? inserted?.rowCount ?? 0) !== 1) return
    if (String(offerDetail.status || '') === 'active') {
      await db.run(
        'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
        [JSON.stringify({ ...offerDetail, status: 'accepted', acceptedAt: new Date().toISOString(), selectionEventId: eventId }), offerEventId, offer.detail_json]
      )
    }
    const supersededAt = new Date().toISOString()
    const priorSelections = await db.all(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = ? AND id != ?`,
      [contactId, agentId, NATIVE_APPOINTMENT_SELECTION_EVENT, eventId]
    )
    for (const row of priorSelections || []) {
      const prior = parseNativeEventDetail(row.detail_json)
      if (String(prior.status || 'active') !== 'active') continue
      await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND detail_json = ?`,
        [JSON.stringify({
          ...prior,
          status: 'superseded',
          supersededAt,
          supersededBySelectionEventId: eventId
        }), row.id, row.detail_json]
      )
    }
    const priorIntents = await db.all(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = ?`,
      [contactId, agentId, NATIVE_APPOINTMENT_DEPOSIT_INTENT_EVENT]
    )
    for (const row of priorIntents || []) {
      const prior = parseNativeEventDetail(row.detail_json)
      if (String(prior.status || '') !== 'pending' || String(prior.selectionEventId || '') === eventId) continue
      await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND detail_json = ?`,
        [JSON.stringify({
          ...prior,
          status: 'superseded',
          supersededAt,
          supersededBySelectionEventId: eventId
        }), row.id, row.detail_json]
      )
    }
  })
  const stored = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
     FROM conversational_agent_events WHERE id = ?`,
    [eventId]
  )
  const storedDetail = parseNativeEventDetail(stored?.detail_json)
  const matches = Boolean(
    stored?.event_type === NATIVE_APPOINTMENT_SELECTION_EVENT &&
    String(stored?.contact_id || '') === contactId &&
    String(stored?.agent_id || '') === agentId &&
    String(storedDetail.status || '') === 'active' &&
    ['calendarId', 'startTime', 'executionId', 'customerMessageId', 'customerMessageIdsHash', 'latestCustomerMessageId', 'offerMessageId', 'offerEventId', 'offerTurnId', 'offerTurnMessageIdsHash', 'localLabel', 'timezone', 'customerQuoteHash']
      .every((key) => String(storedDetail[key] || '') === String(detail[key] || ''))
  )
  if (!matches) {
    return appointmentSelectionError(
      'La selección durable del horario ya existe con datos distintos. No se agendó nada.',
      'appointment_selection_event_conflict'
    )
  }
  return {
    ...evidence,
    durable: true,
    selectionEventId: eventId,
    verifiedAt: storedDetail.verifiedAt || stored.created_at || null
  }
}

async function listNativeAppointmentSelections({ agentId = '', contactId = '' } = {}) {
  const rows = await db.all(
    `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
     FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 100`,
    [String(contactId || '').trim(), String(agentId || '').trim(), NATIVE_APPOINTMENT_SELECTION_EVENT]
  )
  return (rows || []).map((row) => ({ ...row, detail: parseNativeEventDetail(row.detail_json) }))
    .sort((left, right) => {
      const rightMs = Date.parse(right.detail.verifiedAt || right.created_at || '') || 0
      const leftMs = Date.parse(left.detail.verifiedAt || left.created_at || '') || 0
      return rightMs - leftMs || String(right.id).localeCompare(String(left.id))
    })
}

async function getLatestNativeAppointmentSelection({ agentId = '', contactId = '' } = {}) {
  return (await listNativeAppointmentSelections({ agentId, contactId }))[0] || null
}

async function ensureNativeAppointmentDepositIntent({
  ctx,
  config,
  selectionEvidence,
  methods = {}
} = {}) {
  if (ctx?.dryRun) return { ok: true, durable: false }
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const selectionEventId = String(selectionEvidence?.selectionEventId || '').trim()
  if (!agentId || !contactId || !executionId || !selectionEventId) {
    return appointmentSelectionError(
      'No se pudo abrir de forma segura el intento de anticipo para este horario. No se creó ningún cobro.',
      'appointment_deposit_intent_identity_missing'
    )
  }
  const selection = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
     FROM conversational_agent_events WHERE id = ?`,
    [selectionEventId]
  )
  const selectionDetail = parseNativeEventDetail(selection?.detail_json)
  if (
    selection?.event_type !== NATIVE_APPOINTMENT_SELECTION_EVENT ||
    String(selection?.contact_id || '') !== contactId ||
    String(selection?.agent_id || '') !== agentId ||
    String(selectionDetail.status || '') !== 'active' ||
    String(selectionDetail.executionId || '') !== executionId
  ) {
    return appointmentSelectionError(
      'La selección del horario ya no está activa para iniciar este anticipo. Vuelve a consultar horarios.',
      'appointment_deposit_selection_inactive'
    )
  }
  const intentId = `cae_appointment_deposit_intent_${createHash('sha256').update([
    agentId,
    contactId,
    selectionEventId,
    executionId
  ].join('\u0000')).digest('hex').slice(0, 48)}`
  const createdAt = new Date().toISOString()
  const selectionStartMs = Date.parse(selectionDetail.startTime || '')
  const intentExpiresAtMs = Math.min(
    Number.isFinite(selectionStartMs) ? selectionStartMs : Date.now() + NATIVE_APPOINTMENT_TRANSFER_INTENT_TTL_MS,
    Date.now() + NATIVE_APPOINTMENT_TRANSFER_INTENT_TTL_MS
  )
  const detail = {
    agentId,
    contactId,
    selectionEventId,
    calendarId: selectionDetail.calendarId,
    startTime: selectionDetail.startTime,
    selectionVerifiedAt: selectionDetail.verifiedAt,
    executionId,
    methods: {
      paymentLink: methods.paymentLink === true,
      bankTransfer: methods.bankTransfer === true
    },
    status: 'pending',
    createdAt,
    expiresAt: new Date(intentExpiresAtMs).toISOString()
  }
  await db.run(
    `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [intentId, contactId, agentId, NATIVE_APPOINTMENT_DEPOSIT_INTENT_EVENT, JSON.stringify(detail)]
  )
  const stored = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
     FROM conversational_agent_events WHERE id = ?`,
    [intentId]
  )
  const storedDetail = parseNativeEventDetail(stored?.detail_json)
  const storedStatus = String(storedDetail.status || '')
  const collectionMethod = String(storedDetail.collectionMethod || '')
  const collectionMethodEnabled = (
    collectionMethod === 'paymentLink'
      ? storedDetail.methods?.paymentLink === true
      : collectionMethod === 'bankTransfer' && storedDetail.methods?.bankTransfer === true
  )
  // El mismo inbound puede reejecutarse después de que el proveedor ya creó el
  // link pero antes de que el Runner alcanzara a guardar el plan de respuesta.
  // En ese caso no se abre otro intento ni se revierte el source binding: sólo
  // se reconoce el mismo contrato para que book_appointment vuelva a devolver
  // el hint de cobro y create_payment_link reproduzca la fuente exacta.
  const recoverableReplayStatus = storedStatus === 'pending' || (
    storedStatus === 'collecting' &&
    collectionMethodEnabled &&
    Boolean(String(storedDetail.claimKey || '').trim()) &&
    Boolean(String(storedDetail.claimToken || '').trim())
  ) || (
    storedStatus === 'source_bound' &&
    collectionMethodEnabled &&
    Boolean(String(storedDetail.sourceEventId || '').trim())
  )
  if (
    stored?.event_type !== NATIVE_APPOINTMENT_DEPOSIT_INTENT_EVENT ||
    String(stored?.contact_id || '') !== contactId ||
    String(stored?.agent_id || '') !== agentId ||
    String(storedDetail.selectionEventId || '') !== selectionEventId ||
    String(storedDetail.executionId || '') !== executionId ||
    String(storedDetail.calendarId || '') !== String(selectionDetail.calendarId || '') ||
    String(storedDetail.startTime || '') !== String(selectionDetail.startTime || '') ||
    String(storedDetail.selectionVerifiedAt || '') !== String(selectionDetail.verifiedAt || '') ||
    storedDetail.methods?.paymentLink !== (methods.paymentLink === true) ||
    storedDetail.methods?.bankTransfer !== (methods.bankTransfer === true) ||
    !recoverableReplayStatus
  ) {
    return appointmentSelectionError(
      'El intento de anticipo ya cambió o venció. No se creó ningún cobro.',
      'appointment_deposit_intent_conflict'
    )
  }
  return { ok: true, intent: { ...stored, detail: storedDetail }, selection: { ...selection, detail: selectionDetail } }
}

async function listNativeAppointmentDepositIntents({ agentId = '', contactId = '' } = {}) {
  const rows = await db.all(
    `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
     FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 100`,
    [String(contactId || '').trim(), String(agentId || '').trim(), NATIVE_APPOINTMENT_DEPOSIT_INTENT_EVENT]
  )
  return (rows || []).map((row) => ({ ...row, detail: parseNativeEventDetail(row.detail_json) }))
}

async function validateNativeAppointmentDepositIntent({
  ctx,
  config,
  scheduleCapability,
  intent,
  method,
  requireSameExecution = false,
  enforceSelectionCollectionTtl = false,
  requireAvailableSlot = true,
  expectedClaimKey = ''
} = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const detail = intent?.detail || {}
  const now = Date.now()
  const cleanExpectedClaimKey = String(expectedClaimKey || '').trim()
  const sourceAlreadyBound = (
    String(detail.status || '') === 'source_bound' &&
    String(detail.collectionMethod || '') === String(method || '') &&
    String(detail.sourceEventId || '') === cleanExpectedClaimKey &&
    Boolean(cleanExpectedClaimKey)
  )
  const intentStatusValid = String(detail.status || '') === 'pending' || (
    String(detail.status || '') === 'collecting' &&
    String(detail.collectionMethod || '') === String(method || '') &&
    String(detail.claimKey || '') === cleanExpectedClaimKey &&
    Boolean(cleanExpectedClaimKey)
  ) || sourceAlreadyBound
  if (
    !intent?.id ||
    String(intent.contact_id || '') !== contactId ||
    String(intent.agent_id || '') !== agentId ||
    !intentStatusValid ||
    (!sourceAlreadyBound && Date.parse(detail.expiresAt || '') <= now) ||
    detail.methods?.[method] !== true ||
    (requireSameExecution && String(detail.executionId || '') !== executionId)
  ) {
    return appointmentSelectionError(
      'El intento de anticipo para este horario ya no está vigente. Vuelve a confirmar un horario antes de cobrar.',
      'appointment_deposit_intent_not_pending'
    )
  }
  const selection = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
     FROM conversational_agent_events WHERE id = ?`,
    [String(detail.selectionEventId || '')]
  )
  const selectionDetail = parseNativeEventDetail(selection?.detail_json)
  const configuredCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
  const startMs = Date.parse(selectionDetail.startTime || '')
  const verifiedMs = Date.parse(selectionDetail.verifiedAt || '')
  if (
    selection?.event_type !== NATIVE_APPOINTMENT_SELECTION_EVENT ||
    String(selection?.contact_id || '') !== contactId ||
    String(selection?.agent_id || '') !== agentId ||
    (!sourceAlreadyBound && String(selectionDetail.status || '') !== 'active') ||
    String(selectionDetail.calendarId || '') !== String(detail.calendarId || '') ||
    String(selectionDetail.startTime || '') !== String(detail.startTime || '') ||
    String(selectionDetail.verifiedAt || '') !== String(detail.selectionVerifiedAt || '') ||
    (!sourceAlreadyBound && String(configuredCalendar?.id || '') !== String(detail.calendarId || '')) ||
    !Number.isFinite(startMs) ||
    (!sourceAlreadyBound && startMs <= now) ||
    (!sourceAlreadyBound && enforceSelectionCollectionTtl && (!Number.isFinite(verifiedMs) || now - verifiedMs > NATIVE_APPOINTMENT_SELECTION_COLLECTION_TTL_MS))
  ) {
    return appointmentSelectionError(
      'La selección ligada al anticipo está vencida, ya cambió o pertenece a otro calendario. No se creó ningún cobro.',
      'appointment_deposit_selection_stale'
    )
  }
  if (requireAvailableSlot && !sourceAlreadyBound) {
    const timezone = await getAccountTimezone()
    const slotValidation = await revalidateAppointmentSlot({
      calendarId: configuredCalendar.id,
      requestedStartTime: new Date(startMs).toISOString(),
      windowStart: normalizeDateOnlyInTimezone(new Date(startMs - 86400000).toISOString(), timezone),
      windowEnd: normalizeDateOnlyInTimezone(new Date(startMs + 86400000).toISOString(), timezone),
      lookupSlots: getLocalFreeSlots,
      ignoreAppointmentConflicts: scheduleCapability?.allowOverlaps === true
    })
    if (!slotValidation.ok) {
      return appointmentSelectionError(
        'El horario ligado al anticipo ya no está libre. No se creó ningún cobro; ofrece horarios nuevos.',
        'appointment_deposit_slot_unavailable'
      )
    }
  }
  return { ok: true, intent, selection: { ...selection, detail: selectionDetail } }
}

async function resolveNativeAppointmentDepositIntentForLink({ ctx, config, scheduleCapability, claimKey = '' } = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const cleanClaimKey = String(claimKey || '').trim()
  const intents = await listNativeAppointmentDepositIntents({ agentId, contactId })
  const matches = intents.filter((intent) => (
    (
      String(intent.detail?.status || '') === 'pending' ||
      (
        String(intent.detail?.status || '') === 'collecting' &&
        String(intent.detail?.collectionMethod || '') === 'paymentLink' &&
        String(intent.detail?.claimKey || '') === cleanClaimKey
      ) ||
      (
        String(intent.detail?.status || '') === 'source_bound' &&
        String(intent.detail?.collectionMethod || '') === 'paymentLink' &&
        String(intent.detail?.sourceEventId || '') === cleanClaimKey
      )
    ) &&
    String(intent.detail?.executionId || '') === executionId
  ))
  if (matches.length !== 1) {
    return appointmentSelectionError(
      'No hay un único intento de anticipo vigente para este mensaje y horario. Vuelve a confirmar el horario.',
      'appointment_deposit_intent_required'
    )
  }
  return validateNativeAppointmentDepositIntent({
    ctx,
    config,
    scheduleCapability,
    intent: matches[0],
    method: 'paymentLink',
    requireSameExecution: true,
    enforceSelectionCollectionTtl: true,
    expectedClaimKey: cleanClaimKey
  })
}

async function resolveAndBindNativeAppointmentDepositIntentForReceipt({
  ctx,
  config,
  scheduleCapability,
  receiptMessageId,
  receiptReceivedAt
} = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const channel = String(ctx?.channel || 'whatsapp').trim().toLowerCase()
  const cleanReceiptMessageId = String(receiptMessageId || '').trim()
  const receiptReceivedMs = Date.parse(receiptReceivedAt || '')
  if (!agentId || !contactId || !cleanReceiptMessageId) {
    return appointmentSelectionError('No se pudo identificar el comprobante recibido.', 'appointment_deposit_receipt_identity_missing')
  }
  const bindingEventId = `cae_appointment_receipt_intent_${createHash('sha256').update([
    agentId,
    contactId,
    channel,
    cleanReceiptMessageId
  ].join('\u0000')).digest('hex').slice(0, 48)}`
  let binding = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
     FROM conversational_agent_events WHERE id = ?`,
    [bindingEventId]
  )
  if (!binding) {
    const recentAfter = Date.now() - NATIVE_APPOINTMENT_TRANSFER_INTENT_TTL_MS
    const recent = (await listNativeAppointmentDepositIntents({ agentId, contactId })).filter((intent) => (
      intent.detail?.methods?.bankTransfer === true &&
      (Date.parse(intent.detail?.createdAt || intent.created_at || '') || 0) >= recentAfter &&
      (!Number.isFinite(receiptReceivedMs) || receiptReceivedMs >= (Date.parse(intent.detail?.createdAt || intent.created_at || '') || 0))
    ))
    const candidates = recent.filter((intent) => String(intent.detail?.status || '') !== 'source_bound')
    const alternateSourceIntent = candidates.length === 0 && recent.length === 1 && String(recent[0].detail?.status || '') === 'source_bound'
      ? recent[0]
      : null
    const intent = candidates.length === 1 ? candidates[0] : alternateSourceIntent
    const detail = {
      agentId,
      contactId,
      channel,
      receiptMessageId: cleanReceiptMessageId,
      receiptReceivedAt: Number.isFinite(receiptReceivedMs) ? new Date(receiptReceivedMs).toISOString() : null,
      intentEventId: intent?.id || null,
      selectionEventId: intent?.detail?.selectionEventId || null,
      calendarId: intent?.detail?.calendarId || null,
      startTime: intent?.detail?.startTime || null,
      selectionVerifiedAt: intent?.detail?.selectionVerifiedAt || null,
      ambiguousIntent: candidates.length !== 1 && !alternateSourceIntent,
      alternateSource: Boolean(alternateSourceIntent),
      possibleDoublePayment: Boolean(alternateSourceIntent),
      candidateIntentCount: recent.length,
      needsHumanReview: candidates.length !== 1,
      boundAt: new Date().toISOString()
    }
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [bindingEventId, contactId, agentId, NATIVE_APPOINTMENT_RECEIPT_INTENT_EVENT, JSON.stringify(detail)]
    )
    binding = await db.get(
      `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
       FROM conversational_agent_events WHERE id = ?`,
      [bindingEventId]
    )
  }
  const bindingDetail = parseNativeEventDetail(binding?.detail_json)
  if (
    binding?.event_type !== NATIVE_APPOINTMENT_RECEIPT_INTENT_EVENT ||
    String(binding?.contact_id || '') !== contactId ||
    String(binding?.agent_id || '') !== agentId ||
    String(bindingDetail.receiptMessageId || '') !== cleanReceiptMessageId
  ) {
    return appointmentSelectionError('El comprobante ya quedó ligado a otro intento.', 'appointment_deposit_receipt_binding_conflict')
  }
  if (!bindingDetail.intentEventId) {
    return {
      ok: true,
      manualReviewOnly: true,
      needsHumanReview: true,
      staleReasons: ['appointment_intent_ambiguous'],
      receiptIntentBindingEventId: bindingEventId,
      intent: null,
      selection: null,
      claim: null
    }
  }
  const intentRow = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
     FROM conversational_agent_events WHERE id = ?`,
    [String(bindingDetail.intentEventId || '')]
  )
  const intent = intentRow ? { ...intentRow, detail: parseNativeEventDetail(intentRow.detail_json) } : null
  const selectionRow = intent?.detail?.selectionEventId
    ? await db.get(
        `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
         FROM conversational_agent_events WHERE id = ?`,
        [intent.detail.selectionEventId]
      )
    : null
  const selection = selectionRow ? { ...selectionRow, detail: parseNativeEventDetail(selectionRow.detail_json) } : null
  if (
    intent?.event_type !== NATIVE_APPOINTMENT_DEPOSIT_INTENT_EVENT ||
    String(intent?.contact_id || '') !== contactId ||
    String(intent?.agent_id || '') !== agentId ||
    selection?.event_type !== NATIVE_APPOINTMENT_SELECTION_EVENT ||
    String(selection?.contact_id || '') !== contactId ||
    String(selection?.agent_id || '') !== agentId ||
    String(selection?.id || '') !== String(bindingDetail.selectionEventId || '')
  ) {
    return {
      ok: true,
      manualReviewOnly: true,
      needsHumanReview: true,
      staleReasons: ['appointment_intent_identity_invalid'],
      receiptIntentBindingEventId: bindingEventId,
      intent: null,
      selection: null,
      claim: null
    }
  }
  if (String(intent.detail?.status || '') === 'source_bound') {
    return {
      ok: true,
      manualReviewOnly: true,
      needsHumanReview: true,
      possibleDoublePayment: true,
      staleReasons: ['alternate_payment_source_after_link'],
      receiptIntentBindingEventId: bindingEventId,
      intent,
      selection,
      claim: null
    }
  }
  const configuredCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
  const staleReasons = []
  if (String(selection.detail?.status || '') !== 'active') staleReasons.push('selection_superseded')
  if (Date.parse(intent.detail?.expiresAt || '') <= Date.now()) staleReasons.push('intent_expired')
  if (Date.parse(selection.detail?.startTime || '') <= Date.now()) staleReasons.push('appointment_start_passed')
  if (String(configuredCalendar?.id || '') !== String(selection.detail?.calendarId || '')) staleReasons.push('calendar_changed')
  const claim = await claimNativeAppointmentDepositIntent({
    intent,
    selection,
    method: 'bankTransfer',
    claimKey: bindingEventId,
    allowStaleEvidence: true
  })
  if (!claim.ok) {
    return {
      ok: true,
      manualReviewOnly: true,
      needsHumanReview: true,
      staleReasons: [...staleReasons, 'appointment_intent_already_claimed'],
      receiptIntentBindingEventId: bindingEventId,
      intent: null,
      selection: null,
      claim: null
    }
  }
  return {
    ok: true,
    intent: claim.intent,
    selection,
    claim,
    staleReasons,
    needsHumanReview: staleReasons.length > 0,
    receiptIntentBindingEventId: bindingEventId
  }
}

async function claimNativeAppointmentDepositIntent({ intent, selection, method, claimKey, allowStaleEvidence = false } = {}) {
  const cleanMethod = String(method || '').trim()
  const cleanClaimKey = String(claimKey || '').trim()
  if (!intent?.id || !selection?.id || !cleanMethod || !cleanClaimKey) return { ok: false }
  const claimToken = createHash('sha256').update([
    intent.id,
    selection.id,
    cleanMethod,
    cleanClaimKey
  ].join('\u0000')).digest('hex')
  return db.transaction(async () => {
    const current = await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [intent.id])
    const detail = parseNativeEventDetail(current?.detail_json)
    if (
      String(detail.status || '') === 'source_bound' &&
      String(detail.collectionMethod || '') === cleanMethod &&
      String(detail.sourceEventId || '') === cleanClaimKey &&
      String(detail.claimToken || '') === claimToken
    ) {
      return { ok: true, claimToken, reused: true, sourceAlreadyBound: true, intent: { ...intent, detail } }
    }
    if (
      String(detail.status || '') === 'collecting' &&
      String(detail.claimToken || '') === claimToken &&
      String(detail.collectionMethod || '') === cleanMethod &&
      String(detail.claimKey || '') === cleanClaimKey
    ) {
      return { ok: true, claimToken, reused: true, intent: { ...intent, detail } }
    }
    const claimableStatus = String(detail.status || '') === 'pending' || (
      allowStaleEvidence && String(detail.status || '') === 'superseded'
    )
    if (
      !claimableStatus ||
      String(detail.selectionEventId || '') !== String(selection.id)
    ) return { ok: false }
    const next = {
      ...detail,
      ...(String(detail.status || '') !== 'pending' ? { statusBeforeEvidenceClaim: detail.status } : {}),
      status: 'collecting',
      collectionMethod: cleanMethod,
      claimKey: cleanClaimKey,
      claimToken,
      claimedAt: new Date().toISOString()
    }
    const result = await db.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND detail_json = ?`,
      [JSON.stringify(next), intent.id, current.detail_json]
    )
    return Number(result?.changes ?? result?.rowCount ?? 0) === 1
      ? { ok: true, claimToken, reused: false, intent: { ...intent, detail: next } }
      : { ok: false }
  })
}

async function markNativeAppointmentDepositIntentBound({ intent, selection, sourceEventId, method, claimToken } = {}) {
  if (!intent?.id || !selection?.id || !sourceEventId) return false
  const current = await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [intent.id])
  const detail = parseNativeEventDetail(current?.detail_json)
  if (
    String(detail.status || '') === 'source_bound' &&
    String(detail.selectionEventId || '') === String(selection.id) &&
    String(detail.sourceEventId || '') === String(sourceEventId)
  ) return true
  if (
    String(detail.status || '') !== 'collecting' ||
    String(detail.selectionEventId || '') !== String(selection.id) ||
    String(detail.claimToken || '') !== String(claimToken || '') ||
    String(detail.collectionMethod || '') !== String(method || '')
  ) return false
  const result = await db.run(
    `UPDATE conversational_agent_events SET detail_json = ?
     WHERE id = ? AND detail_json = ?`,
    [JSON.stringify({
      ...detail,
      status: 'source_bound',
      collectionMethod: method,
      sourceEventId,
      sourceBoundAt: new Date().toISOString()
    }), intent.id, current.detail_json]
  )
  return Number(result?.changes ?? result?.rowCount ?? 0) === 1
}

async function verifyPaymentResumeAppointmentSelection({
  reconciliationId,
  agentId,
  contactId,
  calendarId
} = {}) {
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const reconciliation = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [cleanReconciliationId]
  )
  const reconciliationDetail = parseNativeEventDetail(reconciliation?.detail_json)
  const sourceEventId = String(reconciliationDetail.sourceEventId || '').trim()
  if (
    reconciliation?.event_type !== 'payment_reconciliation_v2' ||
    String(reconciliation?.contact_id || '') !== cleanContactId ||
    String(reconciliation?.agent_id || '') !== cleanAgentId ||
    !sourceEventId
  ) {
    return appointmentSelectionError(
      'La reanudación del pago no conserva su vínculo exacto con el cobro. No se agendó nada.',
      'payment_resume_source_missing'
    )
  }
  const source = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [sourceEventId]
  )
  const sourceDetail = parseNativeEventDetail(source?.detail_json)
  const selectionEventId = String(sourceDetail.appointmentSelectionEventId || '').trim()
  if (
    !['payment_link_created', 'payment_link_reused', 'deposit_transfer_pending_review'].includes(source?.event_type) ||
    String(source?.contact_id || '') !== cleanContactId ||
    String(source?.agent_id || '') !== cleanAgentId ||
    !selectionEventId
  ) {
    return appointmentSelectionError(
      'El cobro no quedó ligado a una selección de horario anterior. No se agendó nada.',
      'payment_resume_selection_binding_missing'
    )
  }
  const selection = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
     FROM conversational_agent_events WHERE id = ?`,
    [selectionEventId]
  )
  const detail = parseNativeEventDetail(selection?.detail_json)
  const durableStartTime = String(detail.startTime || '').trim()
  const identityMatches = Boolean(
    selection?.event_type === NATIVE_APPOINTMENT_SELECTION_EVENT &&
    String(selection?.contact_id || '') === cleanContactId &&
    String(selection?.agent_id || '') === cleanAgentId &&
    String(detail.status || '') === 'active' &&
    String(detail.calendarId || '') === String(calendarId || '') &&
    String(sourceDetail.appointmentSelectionCalendarId || '') === String(calendarId || '') &&
    durableStartTime &&
    !Number.isNaN(new Date(durableStartTime).getTime()) &&
    String(sourceDetail.appointmentSelectionStartTime || '') === durableStartTime &&
    String(sourceDetail.appointmentSelectionVerifiedAt || '') === String(detail.verifiedAt || '')
  )
  if (!identityMatches) {
    return appointmentSelectionError(
      'La selección ligada al pago no coincide con agente, contacto, calendario y horario solicitados. No se agendó nada.',
      'payment_resume_selection_mismatch'
    )
  }
  return {
    ok: true,
    evidenceVerified: true,
    nativeToolDecision: true,
    selectionMode: 'accepted_prior_offer',
    selectedStartTime: detail.startTime,
    customerQuote: detail.customerQuotePreview || '',
    customerMessageId: detail.customerMessageId || null,
    assistantOfferQuote: detail.localLabel || null,
    localLabel: detail.localLabel || null,
    timezone: detail.timezone || null,
    offerMessageId: detail.offerMessageId || null,
    offerEventId: detail.offerEventId || null,
    durable: true,
    reusedForPaymentResume: true,
    selectionEventId: selection.id,
    paymentSourceEventId: source.id,
    reconciliationId: reconciliation.id
  }
}

async function resolveNativeAppointmentSelection({
  ctx,
  config,
  calendarId,
  timezone
} = {}) {
  const executionId = String(ctx?.executionId || '').trim()
  if (executionId.startsWith('payment-resume:')) {
    const paymentEvidence = await verifyPaymentResumeAppointmentSelection({
      reconciliationId: executionId.slice('payment-resume:'.length).trim(),
      agentId: config?.id || ctx?.agentId,
      contactId: ctx?.contactId,
      calendarId
    })
    if (!paymentEvidence.ok) return paymentEvidence
    const offerAuthorization = await verifyNativeAppointmentOfferEvent({
      ctx,
      config,
      calendarId,
      startTime: paymentEvidence.selectedStartTime,
      evidence: paymentEvidence
    })
    return offerAuthorization.ok
      ? { ...paymentEvidence, offerEventId: offerAuthorization.offerEventId }
      : offerAuthorization
  }
  const candidate = await loadNativeAppointmentOfferCandidate({ ctx, config })
  if (!candidate.ok) return candidate
  const startTime = String(candidate.offer?.detail?.startTime || '').trim()
  const offerTimezone = String(candidate.offer?.detail?.timezone || timezone || '').trim()
  if (candidate.offer.testPaymentResume === true) {
    // El webhook sandbox ya probó el hecho importante: el anticipo pagado está
    // ligado criptográficamente a esta oferta preview exacta. El mensaje que
    // reanuda el flujo puede ser el mismo transcript que creó el link y no debe
    // reinterpretarse como una segunda confirmación textual. La identidad, el
    // fingerprint, el calendario y el UTC ya fueron revalidados en el loader y
    // volverán a comprobarse al persistir/materializar el efecto temporal.
    return {
      ok: true,
      evidenceVerified: true,
      nativeToolDecision: true,
      selectionMode: 'accepted_prior_offer',
      selectedStartTime: startTime,
      customerQuote: '',
      customerMessageId: null,
      assistantOfferQuote: candidate.offer.detail.localLabel || null,
      localLabel: candidate.offer.detail.localLabel || null,
      timezone: offerTimezone || null,
      offerMessageId: candidate.offer.detail.offerMessageId || null,
      offerEventId: candidate.offer.id,
      durable: true,
      preview: true,
      reusedForTestPaymentResume: true,
      testPaymentEffectId: String(ctx?.testVerifiedPaymentEvidence?.testEffectId || '').trim() || null
    }
  }
  const canonicalSlot = buildCanonicalAppointmentSlotOption(startTime, offerTimezone)
  const latestCustomerMessage = [...(Array.isArray(ctx?.conversationMessages) ? ctx.conversationMessages : [])]
    .reverse()
    .find((message) => isCustomerAppointmentMessage(message) && appointmentMessageText(message))
  const selectionEvidence = canonicalSlot && latestCustomerMessage
    ? {
        selectionMode: 'accepted_prior_offer',
        selectedStartTime: String(startTime || '').trim(),
        customerQuote: appointmentMessageText(latestCustomerMessage),
        assistantOfferQuote: canonicalSlot.localLabel
      }
    : null
  const verified = verifyNativeAppointmentSelectionEvidence({
    messages: ctx?.conversationMessages,
    startTime,
    timezone: offerTimezone,
    executionId,
    evidence: selectionEvidence
  })
  if (!verified.ok) return verified
  const evidence = {
    ...verified,
    offerEventId: candidate.offer.id
  }
  const offerAuthorization = await verifyNativeAppointmentOfferEvent({
    ctx,
    config,
    calendarId,
    startTime,
    evidence
  })
  return offerAuthorization.ok
    ? { ...evidence, offerEventId: offerAuthorization.offerEventId }
    : offerAuthorization
}

function getDepositRequirementForRuntime(ctx = {}, config = {}) {
  const capability = getNativeCapability(ctx, config, 'collect_payment')
  return capability && (capability.paymentMode === 'deposit' || capability.deposit?.enabled)
    ? capability.deposit
    : null
}

function getDepositPaymentMethodsForRuntime(ctx = {}, config = {}) {
  const capability = getNativeCapability(ctx, config, 'collect_payment')
  return {
    paymentLink: capability?.deposit?.methods?.paymentLink === true,
    bankTransfer: capability?.deposit?.methods?.bankTransfer === true
  }
}

function getAccountCurrencyLabel(accountLocale = {}) {
  const currency = String(accountLocale?.currency || '').trim().toUpperCase()
  return currency || 'moneda configurada en la cuenta'
}

function getDepositRequirementLabel(ctx = {}, config = {}) {
  return getNativeCapability(ctx, config, 'schedule_appointment') ? 'anticipo' : 'pago solicitado'
}

function formatDepositRequirement(deposit = {}, accountLocale = {}) {
  const currency = String(deposit.currency || '').trim().toUpperCase() || getAccountCurrencyLabel(accountLocale)
  if (deposit.mode === 'range') {
    const min = Number(deposit.minAmount) || 0
    const max = Number(deposit.maxAmount) || 0
    if (min > 0 && max > 0) return `entre ${min} y ${max} ${currency}`
    if (min > 0) return `desde ${min} ${currency}`
    if (max > 0) return `hasta ${max} ${currency}`
  }
  const amount = Number(deposit.amount) || 0
  return amount > 0 ? `${amount} ${currency}` : 'monto pendiente de configurar'
}

async function rejectMissingDepositIfNeeded(
  ctx,
  config = {},
  accountLocale = {},
  { appointmentRequestId = '', calendarId = '', startTime = '' } = {}
) {
  const deposit = getDepositRequirementForRuntime(ctx, config)
  if (!deposit) return null
  const nativePaymentPurpose = getNativePaymentPurpose(ctx, config)
  const executionId = String(ctx.executionId || '').trim()
  const reconciliationId = executionId.startsWith('payment-resume:')
    ? executionId.slice('payment-resume:'.length).trim()
    : ''
  const paymentLabel = getDepositRequirementLabel(ctx, config)
  if (ctx.dryRun && ctx.testVerifiedPaymentEvidence && typeof ctx.testVerifiedPaymentEvidence === 'object') {
    const evidence = ctx.testVerifiedPaymentEvidence
    const expectedCurrency = String(deposit.currency || accountLocale.currency || '').trim().toUpperCase()
    const testEvidenceMatches = Boolean(
      String(evidence.paymentMode || '').toLowerCase() === 'test' &&
      String(evidence.paymentPurpose || '') === 'appointment_deposit' &&
      String(evidence.previewScopeId || '') === String(ctx.previewScopeId || '') &&
      String(evidence.calendarId || '') === String(calendarId || '') &&
      String(evidence.startTime || '') === String(startTime || '') &&
      String(evidence.currency || '').trim().toUpperCase() === expectedCurrency &&
      depositRequirementAmountMatches(deposit, evidence.amount) &&
      String(evidence.testRunId || '').trim() &&
      String(evidence.testEffectId || '').trim()
    )
    if (testEvidenceMatches) {
      ctx.verifiedPaymentEvidence = { ...evidence, testPayment: true }
      return null
    }
  }
  if (!ctx.dryRun) {
    const verification = await findVerifiedPaymentEvidence({
      database: db,
      contactId: ctx.contactId,
      agentId: config.id || ctx.agentId || null,
      requiredPurpose: nativePaymentPurpose,
      reconciliationId,
      appointmentRequestId
    })
    if (verification.ok) {
      ctx.verifiedPaymentEvidence = verification.evidence
      return null
    }
  }
  const methods = getDepositPaymentMethodsForRuntime(ctx, config)
  const collectionHints = []
  if (methods.paymentLink) collectionHints.push('manda el link de pago con create_payment_link')
  if (methods.bankTransfer) collectionHints.push('comparte los datos de transferencia y, cuando llegue la foto del comprobante, valídala con register_deposit_payment_proof')
  const collectionHint = collectionHints.length
    ? `Para cobrarlo: ${collectionHints.join('; o ')}.`
    : 'Solicita que el equipo registre el pago o pasa la conversación a una persona.'
  return {
    ok: false,
    actionCompleted: false,
    paymentEvidenceRequired: true,
    transferRequired: !ctx.dryRun && !collectionHints.length,
    error: ctx.dryRun
      ? `Falta validar el ${paymentLabel} (${formatDepositRequirement(deposit, accountLocale)}). En vivo se exigirá un pago confirmado o registro real; una foto sin validar o un booleano de la IA no bastan. ${collectionHint}`
      : `No existe un pago confirmado o registro verificable del ${paymentLabel} (${formatDepositRequirement(deposit, accountLocale)}). No se ejecutó la acción y no debes afirmar que el comprobante fue validado. ${collectionHint}`
  }
}

function buildGoalLinkPreview(targetUrl, trackingParam, goalId, linkParams = {}) {
  try {
    const parsed = new URL(targetUrl)
    parsed.searchParams.set(trackingParam, goalId)
    for (const [key, value] of Object.entries(linkParams)) {
      if (value) parsed.searchParams.set(key, value)
    }
    return parsed.toString()
  } catch {
    const separator = targetUrl.includes('?') ? '&' : '?'
    return `${targetUrl}${separator}${trackingParam}=${goalId}`
  }
}

function buildPaymentChannels(channel) {
  const normalized = String(channel || '').toLowerCase()
  return {
    email: normalized === 'email' || normalized === 'all',
    whatsapp: normalized === 'whatsapp' || normalized === 'all',
    sms: normalized === 'sms' || normalized === 'all'
  }
}

async function getPaymentContact(ctx = {}) {
  const contact = await getThreadContact(ctx)
  if (!contact) return null
  return {
    ...contact,
    id: contact.id,
    name: contact.full_name,
    email: contact.email,
    phone: contact.phone,
    virtual: contact.virtual === true
  }
}

const RECEIPT_MEDIA_WINDOW_HOURS = 72

// Busca la imagen o PDF ENTRANTE más reciente del contacto (WhatsApp/SMS/webchat
// y DMs de Meta) dentro de la ventana: es el comprobante que se va a validar.
async function findLatestInboundReceiptMedia(contactId) {
  if (!contactId) return null
  const sinceIso = new Date(Date.now() - RECEIPT_MEDIA_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const mediaFilter = "(LOWER(COALESCE(media_mime_type, '')) LIKE 'image/%' OR LOWER(COALESCE(media_mime_type, '')) = 'application/pdf')"

  const [whatsappRow, metaRow] = await Promise.all([
    db.get(`
      SELECT id, media_url, media_mime_type, COALESCE(message_timestamp, created_at) AS media_at
      FROM whatsapp_api_messages
      WHERE contact_id = ? AND direction = 'inbound'
        AND COALESCE(media_url, '') != '' AND ${mediaFilter}
        AND COALESCE(message_timestamp, created_at) >= ?
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT 1
    `, [contactId, sinceIso]).catch(() => null),
    db.get(`
      SELECT id, media_url, media_mime_type, COALESCE(message_timestamp, created_at) AS media_at
      FROM meta_social_messages
      WHERE contact_id = ? AND direction = 'inbound'
        AND COALESCE(media_url, '') != '' AND ${mediaFilter}
        AND COALESCE(message_timestamp, created_at) >= ?
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT 1
    `, [contactId, sinceIso]).catch(() => null)
  ])

  const candidates = [whatsappRow, metaRow].filter((row) => row?.media_url)
  if (!candidates.length) return null
  candidates.sort((a, b) => new Date(b.media_at || 0).getTime() - new Date(a.media_at || 0).getTime())
  const chosen = candidates[0]
  return { messageId: chosen.id, mediaUrl: chosen.media_url, mimeType: chosen.media_mime_type || '', receivedAt: chosen.media_at || null }
}

async function notifyHumanPriority(ctx, { reason = '', summary = '', signal = 'ready_for_human' } = {}) {
  if (ctx.dryRun || !ctx.contactId) return
  try {
    const result = await sendConversationalAgentPriorityNotification({
      contactId: ctx.contactId,
      reason,
      summary,
      signal
    })
    await recordConversationalAgentEvent({
      contactId: ctx.contactId,
      eventType: 'priority_push_notification',
      detail: { signal, sent: result?.sent || 0, skipped: Boolean(result?.skipped), reason: result?.reason || null }
    })
  } catch (error) {
    await recordConversationalAgentEvent({
      contactId: ctx.contactId,
      eventType: 'priority_push_notification_failed',
      detail: { signal, error: error.message }
    })
  }
}

async function releaseNativeAppointmentDepositReceiptClaim({ intent, claim, reviewEventId } = {}) {
  const intentId = String(intent?.id || '').trim()
  const claimToken = String(claim?.claimToken || '').trim()
  if (!intentId || !claimToken) return false
  const current = await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [intentId])
  const detail = parseNativeEventDetail(current?.detail_json)
  if (
    String(detail.status || '') !== 'collecting' ||
    String(detail.collectionMethod || '') !== 'bankTransfer' ||
    String(detail.claimToken || '') !== claimToken
  ) return false
  const {
    collectionMethod: _collectionMethod,
    claimKey: _claimKey,
    claimToken: _claimToken,
    claimedAt: _claimedAt,
    statusBeforeEvidenceClaim,
    ...rest
  } = detail
  const next = {
    ...rest,
    status: String(statusBeforeEvidenceClaim || '') === 'superseded' ? 'superseded' : 'pending',
    lastManualReviewEventId: String(reviewEventId || '').trim() || null,
    receiptClaimReleasedAt: new Date().toISOString()
  }
  const released = await db.run(
    'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
    [JSON.stringify(next), intentId, current.detail_json]
  )
  return Number(released?.changes ?? released?.rowCount ?? 0) === 1
}

async function recordNativePaymentProofManualReviewCase({
  ctx,
  config,
  receiptMedia,
  paymentPurpose,
  expectedRequirement,
  failureReason,
  analysis,
  appointmentDepositIntent,
  appointmentDepositClaim,
  handoffCapability
} = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const channel = String(ctx?.channel || 'whatsapp').trim().toLowerCase()
  const mediaMessageId = String(receiptMedia?.messageId || '').trim()
  const cleanFailureReason = String(failureReason || '').trim()
  if (!agentId || !contactId || !mediaMessageId || !cleanFailureReason) {
    throw new Error('Falta la identidad durable del comprobante que requiere revisión')
  }
  const eventId = `cae_payment_proof_review_${createHash('sha256').update([
    agentId,
    contactId,
    channel,
    mediaMessageId
  ].join('\u0000')).digest('hex').slice(0, 48)}`
  const detail = {
    agentId,
    channel,
    runtimeMode: 'tool_calling_v2',
    mediaMessageId,
    mediaUrl: String(receiptMedia?.mediaUrl || '').trim() || null,
    mediaMimeType: String(receiptMedia?.mimeType || '').trim() || null,
    receivedAt: receiptMedia?.receivedAt || null,
    paymentPurpose: String(paymentPurpose || '').trim() || null,
    appointmentDeposit: paymentPurpose === 'appointment_deposit',
    expectedPayment: {
      mode: expectedRequirement?.mode || 'fixed',
      amount: Number(expectedRequirement?.amount) || null,
      minAmount: Number(expectedRequirement?.minAmount) || null,
      maxAmount: Number(expectedRequirement?.maxAmount) || null,
      currency: String(expectedRequirement?.currency || '').trim().toUpperCase() || null
    },
    failureReason: cleanFailureReason,
    detected: {
      isPaymentReceipt: analysis?.isPaymentReceipt === true,
      amount: Number(analysis?.amount) || null,
      currency: String(analysis?.currency || '').trim().toUpperCase() || null,
      reference: String(analysis?.reference || '').trim() || null,
      confidence: Number.isFinite(Number(analysis?.confidence)) ? Number(analysis.confidence) : null
    },
    ledgerPaymentId: null,
    approvalAllowed: false,
    autoResumeAllowed: false,
    status: 'manual_review_required',
    createdAt: new Date().toISOString()
  }
  const commitReviewHandoff = (capability) => commitNativeHandoff({
    ctx,
    config,
    capability,
    signal: 'ready_for_human',
    signalOptions: {
      reason: 'Comprobante recibido que requiere revisión manual',
      summary: `No se creó ningún pago · ${cleanFailureReason}`,
      status: 'human',
      eventId: `${eventId}_handoff`
    },
    assignmentEventSource: 'payment_proof_manual_review_required',
    evidenceEvent: {
      eventId,
      eventType: 'payment_proof_manual_review_required',
      detail
    }
  })
  let handoff
  try {
    handoff = await commitReviewHandoff(handoffCapability)
  } catch (error) {
    if (!handoffCapability?.userId) throw error
    logger.warn(`[Agente conversacional] La asignación configurada para revisar el comprobante falló; se dejará el chat al equipo general: ${error.message}`)
    handoff = await commitReviewHandoff({})
  }
  const newlyCreated = handoff?.evidenceInserted === true
  const stored = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [eventId]
  )
  const storedDetail = parseNativeEventDetail(stored?.detail_json)
  if (
    stored?.event_type !== 'payment_proof_manual_review_required' ||
    String(stored?.contact_id || '') !== contactId ||
    String(stored?.agent_id || '') !== agentId ||
    String(storedDetail.mediaMessageId || '') !== mediaMessageId ||
    storedDetail.ledgerPaymentId !== null ||
    storedDetail.approvalAllowed !== false ||
    storedDetail.autoResumeAllowed !== false
  ) throw new Error('El caso durable del comprobante no coincide con la evidencia recibida')

  await releaseNativeAppointmentDepositReceiptClaim({
    intent: appointmentDepositIntent,
    claim: appointmentDepositClaim,
    reviewEventId: eventId
  })
  if (newlyCreated) {
    await notifyHumanPriority(ctx, {
      reason: 'Comprobante recibido que requiere revisión manual',
      summary: `No se creó ningún pago · ${cleanFailureReason}`,
      signal: 'ready_for_human'
    })
  }
  return { eventId, newlyCreated, detail: storedDetail, handoff }
}

async function commitNativePaymentProofEscalation({
  ctx,
  config,
  handoffCapability,
  receiptMedia,
  paymentPurpose,
  expectedRequirement,
  analysis,
  staleReasons = [],
  possibleDoublePayment = false
} = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const channel = String(ctx?.channel || 'whatsapp').trim().toLowerCase()
  const mediaMessageId = String(receiptMedia?.messageId || '').trim()
  if (!agentId || !contactId || !mediaMessageId) throw new Error('Falta la identidad del comprobante escalado')
  const eventId = `cae_payment_proof_escalated_${createHash('sha256').update([
    agentId,
    contactId,
    channel,
    mediaMessageId
  ].join('\u0000')).digest('hex').slice(0, 48)}`
  const detail = {
    agentId,
    channel,
    runtimeMode: 'tool_calling_v2',
    mediaMessageId,
    mediaUrl: String(receiptMedia?.mediaUrl || '').trim() || null,
    mediaMimeType: String(receiptMedia?.mimeType || '').trim() || null,
    receivedAt: receiptMedia?.receivedAt || null,
    paymentPurpose: String(paymentPurpose || '').trim() || null,
    expectedPayment: {
      mode: expectedRequirement?.mode || 'fixed',
      amount: Number(expectedRequirement?.amount) || null,
      minAmount: Number(expectedRequirement?.minAmount) || null,
      maxAmount: Number(expectedRequirement?.maxAmount) || null,
      currency: String(expectedRequirement?.currency || '').trim().toUpperCase() || null
    },
    detectedAmount: Number(analysis?.amount) || null,
    detectedCurrency: String(analysis?.currency || '').trim().toUpperCase() || null,
    staleReasons: Array.isArray(staleReasons) ? staleReasons : [],
    possibleDoublePayment: possibleDoublePayment === true,
    ledgerPaymentId: null,
    autoResumeAllowed: false,
    status: 'pending_review'
  }
  const commitEscalation = (capability) => commitNativeHandoff({
    ctx,
    config,
    capability,
    signal: 'ready_for_human',
    signalOptions: {
      reason: 'Comprobante de pago que requiere revisión humana',
      summary: possibleDoublePayment ? 'Posible segundo pago después de generar un enlace' : 'Comprobante ligado a evidencia de cita vencida o ambigua',
      status: 'human',
      eventId: `${eventId}_handoff`
    },
    assignmentEventSource: 'payment_proof_escalated_for_review',
    evidenceEvent: {
      eventId,
      eventType: 'payment_proof_escalated_for_review',
      detail
    }
  })
  try {
    return { eventId, handoff: await commitEscalation(handoffCapability) }
  } catch (error) {
    if (!handoffCapability?.userId) throw error
    logger.warn(`[Agente conversacional] La asignación configurada del comprobante escalado falló; se dejará al equipo general: ${error.message}`)
    return { eventId, handoff: await commitEscalation({}) }
  }
}

async function syncNativeAppointmentCompletion({ ctx, config, appointment, calendarId }) {
  const appointmentId = String(appointment?.id || '').trim()
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  if (!ctx?.contactId || !appointmentId || !agentId) {
    throw new Error('Falta la identidad canónica para cerrar la cita')
  }
  const startTime = appointment.start_time || appointment.startTime
  const title = appointment.title || 'Cita'
  const technicalSummary = `${title} · ${startTime}`
  const digest = createHash('sha256')
    .update([ctx.contactId, agentId, appointmentId].join('\u0000'))
    .digest('hex')
    .slice(0, 48)
  const appointmentEventId = `cae_appointment_booked_${digest}`
  const eventAlreadyRecorded = Boolean(await db.get(
    'SELECT id FROM conversational_agent_events WHERE id = ?',
    [appointmentEventId]
  ).catch(() => null))

  await setConversationSignal(ctx.contactId, 'appointment_booked', {
    reason: 'Cita agendada por el agente',
    actionSummarySource: technicalSummary,
    originalSummary: technicalSummary,
    status: 'completed',
    agentId,
    channel: ctx.channel,
    eventId: `cae_appointment_signal_${digest}`,
    strictEvent: true
  })
  await recordConversationalAgentEvent({
    eventId: appointmentEventId,
    contactId: ctx.contactId,
    eventType: 'appointment_booked',
    detail: {
      agentId,
      appointmentId,
      startTime,
      calendarId: appointment.calendar_id || appointment.calendarId || calendarId || null
    },
    throwOnError: true
  })
  if (!eventAlreadyRecorded) {
    await notifyHumanPriority(ctx, {
      reason: 'Cita agendada por el agente',
      summary: technicalSummary,
      signal: 'appointment_booked'
    })
  }
  return { completed: true }
}

async function consumeReservedDepositForExistingNativeAppointment({ ctx, config, appointment }) {
  const appointmentId = String(appointment?.id || '').trim()
  if (!appointmentId || !ctx?.contactId) return { consumed: false, reason: 'appointment_missing' }
  const request = await db.get(
    `SELECT client_request_id
     FROM appointment_creation_requests
     WHERE appointment_id = ? AND status = 'completed'
       AND client_request_id LIKE 'conv-v2-attempt:%'
     ORDER BY updated_at DESC LIMIT 1`,
    [appointmentId]
  ).catch(() => null)
  if (!request?.client_request_id) return { consumed: false, reason: 'no_payment_reservation' }

  const rows = await db.all(
    `SELECT id, detail_json
     FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type = 'deposit_payment_consumed'
     ORDER BY created_at DESC LIMIT 40`,
    [ctx.contactId, config.id || ctx.agentId || '']
  ).catch(() => [])
  const matches = rows.flatMap((row) => {
    try {
      const detail = JSON.parse(row.detail_json || '{}')
      return detail.appointmentRequestId === request.client_request_id ? [{ row, detail }] : []
    } catch {
      return []
    }
  })
  if (!matches.length) return { consumed: false, reason: 'no_payment_reservation' }
  if (matches.length !== 1) throw new Error('La cita tiene más de una reserva de anticipo')
  const [{ detail }] = matches
  if (detail.status === 'consumed' && detail.appointmentId === appointmentId) {
    return { consumed: true, replayed: true }
  }
  if (detail.status !== 'reserved') {
    throw new Error('La reserva del anticipo no coincide con la cita canónica')
  }
  return consumeConversationalAppointmentDepositEvidence({
    reconciliationId: detail.reconciliationId,
    contactId: ctx.contactId,
    agentId: config.id || ctx.agentId || '',
    paymentId: detail.ledgerPaymentId,
    appointmentRequestId: request.client_request_id,
    appointmentId
  })
}

const NATIVE_APPOINTMENT_BINDING_EVENT = 'appointment_creation_binding_v2'

function nativeAppointmentDepositContract(ctx, config) {
  const deposit = getDepositRequirementForRuntime(ctx, config)
  const methods = getDepositPaymentMethodsForRuntime(ctx, config)
  const currency = normalizeCurrencyCode(deposit?.currency || ctx?.accountLocale?.currency || '')
  const canonical = deposit
    ? {
        required: true,
        paymentPurpose: getNativePaymentPurpose(ctx, config),
        mode: String(deposit.mode || 'fixed'),
        amount: normalizedMoney(deposit.amount, currency),
        minAmount: normalizedMoney(deposit.minAmount, currency),
        maxAmount: normalizedMoney(deposit.maxAmount, currency),
        currency,
        paymentLink: methods.paymentLink === true,
        bankTransfer: methods.bankTransfer === true
      }
    : { required: false }
  return {
    required: canonical.required,
    hash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  }
}

async function reserveNativeAppointmentBinding({
  ctx,
  config,
  calendarId,
  startTime,
  endTime,
  appointmentRequestId,
  depositContract
}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  if (!agentId || !contactId || !appointmentRequestId) {
    throw new Error('Falta la identidad durable para vincular la cita al agente')
  }
  const eventId = `cae_appointment_binding_${createHash('sha256')
    .update([agentId, appointmentRequestId].join('\u0000'))
    .digest('hex')
    .slice(0, 48)}`
  const detail = {
    agentId,
    contactId,
    calendarId,
    startTime,
    endTime,
    appointmentRequestId,
    depositRequired: depositContract.required,
    depositContractHash: depositContract.hash,
    reconciliationId: ctx.verifiedPaymentEvidence?.reconciliationId || null,
    paymentId: ctx.verifiedPaymentEvidence?.paymentId || null
  }
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [eventId, contactId, agentId, NATIVE_APPOINTMENT_BINDING_EVENT, JSON.stringify(detail)]
    )
    const stored = await db.get(
      `SELECT contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [eventId]
    )
    let storedDetail = null
    try { storedDetail = JSON.parse(stored?.detail_json || '') } catch {}
    if (
      stored?.event_type !== NATIVE_APPOINTMENT_BINDING_EVENT ||
      String(stored?.contact_id || '') !== contactId ||
      String(stored?.agent_id || '') !== agentId ||
      JSON.stringify(storedDetail) !== JSON.stringify(detail)
    ) {
      throw new Error('El vínculo durable de la cita ya existe con datos distintos')
    }
  })
  return { eventId, detail }
}

async function findBoundNativeAppointment({ ctx, config, calendarId }) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  if (!agentId || !contactId) return null
  const rows = await db.all(
    `SELECT id, detail_json FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type = ?
     ORDER BY created_at DESC LIMIT 80`,
    [contactId, agentId, NATIVE_APPOINTMENT_BINDING_EVENT]
  ).catch(() => [])
  const matches = []
  for (const row of rows) {
    let detail
    try { detail = JSON.parse(row.detail_json || '{}') } catch { continue }
    if (String(detail.calendarId || '') !== String(calendarId)) continue
    const request = await db.get(
      `SELECT client_request_id, appointment_id, status
       FROM appointment_creation_requests WHERE client_request_id = ?`,
      [detail.appointmentRequestId]
    ).catch(() => null)
    if (request?.status !== 'completed' || !request.appointment_id) continue
    const appointment = await db.get(
      `SELECT id, calendar_id, contact_id, title, start_time, end_time, appointment_status, status, deleted_at
       FROM appointments WHERE id = ?`,
      [request.appointment_id]
    ).catch(() => null)
    const appointmentStatus = String(appointment?.appointment_status || appointment?.status || '').toLowerCase()
    if (
      !appointment || appointment.deleted_at ||
      String(appointment.contact_id || '') !== contactId ||
      String(appointment.calendar_id || '') !== String(calendarId) ||
      new Date(appointment.start_time).getTime() < Date.now() ||
      ['cancelled', 'canceled', 'noshow', 'deleted'].includes(appointmentStatus)
    ) continue
    matches.push({ appointment, request, detail })
  }
  if (matches.length > 1) throw new Error('Hay más de una cita vinculada al mismo agente, calendario y horario')
  return matches[0] || null
}

export function createConversationalTools(ctx) {
  const { config } = ctx
  const runtimeConfig = getToolRuntimeConfig(ctx, config)
  const scheduleCapability = getNativeCapability(ctx, config, 'schedule_appointment')
  const paymentCapability = getNativeCapability(ctx, config, 'collect_payment')
  const linkCapability = getNativeCapability(ctx, config, 'send_link')
  const handoffCapability = getNativeCapability(ctx, config, 'handoff_human')
  const customCapability = getNativeCapability(ctx, config, 'custom_goal')
  const dataRequirements = ctx.capabilitiesConfig?.dataRequirements || {}
  const safetyPolicy = ctx.capabilitiesConfig?.safetyPolicy || {}
  const nativePaymentPurpose = getNativePaymentPurpose(ctx, config)

  const failClosedPreventiveMeasureToHuman = async ({ action, category, reason, cause }) => {
    try {
      const committed = await withConversationalAgentSafetyLock({
        contactId: ctx.contactId,
        channel: String(ctx.channel || 'whatsapp').trim().toLowerCase()
      }, () => commitNativeHandoff({
        ctx,
        config,
        capability: handoffCapability,
        signal: 'ready_for_human',
        signalOptions: {
          reason: 'Revisión preventiva (respaldo seguro)',
          summary: `${category}: ${reason}`.slice(0, 1200),
          status: 'human'
        },
        assignmentEventSource: 'safety_measure_fail_closed'
      }))
      await notifyHumanPriority(ctx, {
        reason: 'Revisión preventiva urgente',
        summary: `${category}: ${reason}`.slice(0, 1200),
        signal: 'ready_for_human'
      }).catch((notificationError) => {
        logger.warn(`[Agente conversacional] El fallback preventivo quedó registrado, pero falló la notificación: ${notificationError.message}`)
      })
      settleAction(action, 'ok', {
        actionCompleted: true,
        quarantined: false,
        fallbackHandoff: true,
        suppressReply: true,
        terminal: true,
        transferredToHuman: true,
        ...(committed?.assignment?.assignedUserId
          ? { assignedUserId: committed.assignment.assignedUserId }
          : {}),
        warning: String(cause?.message || cause || 'preventive_measure_failed').slice(0, 800)
      })
      return {
        ok: true,
        actionCompleted: true,
        quarantined: false,
        fallbackHandoff: true,
        transferredToHuman: true,
        suppressReply: true,
        terminal: true
      }
    } catch (fallbackError) {
      logger.error(`[Agente conversacional] También falló el handoff preventivo de respaldo: ${fallbackError.message}`)
      await Promise.allSettled([
        notifyHumanPriority(ctx, {
          reason: 'Fallo preventivo urgente',
          summary: `${category}: ${reason}`.slice(0, 1200),
          signal: 'safety_fail_closed'
        }),
        recordConversationalAgentEvent({
          contactId: ctx.contactId,
          eventType: 'preventive_measure_fail_closed',
          detail: {
            agentId: config.id || ctx.agentId || null,
            channel: String(ctx.channel || 'whatsapp').trim().toLowerCase(),
            category,
            preventiveMeasureError: String(cause?.message || cause || '').slice(0, 800),
            handoffError: String(fallbackError.message || fallbackError).slice(0, 800),
            retryRequired: true
          }
        })
      ])
      settleAction(action, 'error', {
        actionCompleted: false,
        suppressReply: true,
        terminal: true,
        failClosed: true,
        retryRequired: true,
        error: fallbackError.message,
        preventiveMeasureError: String(cause?.message || cause || '').slice(0, 800)
      })
      return {
        ok: false,
        actionCompleted: false,
        suppressReply: true,
        terminal: true,
        failClosed: true,
        retryRequired: true,
        transferRequired: true,
        error: 'No se pudo activar la prevención ni confirmar el traspaso. Este turno quedó silenciado por seguridad y requiere atención humana inmediata.'
      }
    }
  }

  const applySafetyMeasureTool = tool({
    name: 'apply_safety_measure',
    description: 'Activa una cuarentena reversible y revisión humana sólo ante riesgo claro de severidad alta o crítica. Nunca borra el contacto ni bloquea directamente una cuenta del proveedor.',
    parameters: z.object({
      category: z.enum(['phishing', 'malicious_link', 'fraud', 'spam', 'sexual_harassment', 'threat', 'severe_abuse', 'prompt_injection', 'other']),
      severity: z.enum(['high', 'critical']),
      confidence: z.enum(['high', 'certain']).describe('Usa la medida sólo con evidencia contextual clara'),
      reason: z.string().min(8).max(800).describe('Motivo factual y breve, sin secretos ni instrucciones internas'),
      evidenceSummary: z.string().min(4).max(1200).describe('Resumen de la evidencia observada en el hilo, sin copiar datos sensibles innecesarios')
    }),
    execute: async ({ category, severity, confidence, reason, evidenceSummary }) => {
      // Se fija antes del primer await para ganar frente a cualquier otra tool
      // mutable que un proveedor intentara ejecutar en el mismo lote.
      ctx.preventiveSafetyRequested = true
      const sourceMessageId = String(ctx.executionId || '').trim()
      const action = pushAction(ctx, 'apply_safety_measure', {
        category,
        severity,
        terminal: true,
        suppressReply: true,
        effect: {
          liveEffect: 'PAUSARÍA respuestas y marcaría el contacto para revisión preventiva',
          marksObjectiveCompleted: false
        }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          wouldQuarantine: true,
          wouldNotifyHuman: safetyPolicy.notify !== false
        })
        return { ok: true, simulated: true, wouldQuarantine: true }
      }
      if (!sourceMessageId) {
        const error = new Error('No se pudo identificar el mensaje que originó la medida preventiva.')
        return failClosedPreventiveMeasureToHuman({ action, category, reason, cause: error })
      }
      try {
        const preventivePayload = {
          agentId: config.id || ctx.agentId || 'conversational-agent',
          contactId: ctx.contactId,
          channel: String(ctx.channel || 'whatsapp').trim().toLowerCase(),
          sourceMessageId,
          category,
          severity,
          reason,
          evidence: { summary: evidenceSummary, confidence },
          serverPolicy: {
            id: 'conversational-default-prevention',
            version: '2',
            quarantine: {
              mode: 'temporary',
              durationMinutes: Math.min(30 * 24 * 60, Math.max(15, Number(safetyPolicy.durationMinutes) || 24 * 60))
            },
            notification: {
              enabled: safetyPolicy.notify !== false,
              audience: safetyPolicy.notifyUserId
                ? 'specific_user'
                : (safetyPolicy.action === 'handoff_and_review' ? 'human_review' : 'account_admins'),
              ...(safetyPolicy.notifyUserId ? { userId: safetyPolicy.notifyUserId } : {})
            }
          }
        }
        let result = null
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            result = await applyConversationalAgentPreventiveMeasure(preventivePayload)
            break
          } catch (error) {
            if (attempt === 2) throw error
            logger.warn(`[Agente conversacional] Falló el primer intento de cuarentena; reintentando de forma idempotente: ${error.message}`)
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }

        let handoffWarning = null
        if (safetyPolicy.action === 'handoff_and_review') {
          try {
            await withConversationalAgentSafetyLock({
              contactId: ctx.contactId,
              channel: String(ctx.channel || 'whatsapp').trim().toLowerCase()
            }, () => commitNativeHandoff({
              ctx,
              config,
              capability: handoffCapability,
              signal: 'ready_for_human',
              signalOptions: {
                reason: 'Revisión preventiva',
                summary: reason,
                status: 'human'
              },
              assignmentEventSource: 'safety_measure'
            }))
          } catch (error) {
            handoffWarning = error.message
            logger.warn(`[Agente conversacional] La cuarentena preventiva quedó activa, pero falló el handoff: ${error.message}`)
          }
        }

        if (result.event?.notificationStatus === 'pending') {
          await dispatchConversationalAgentSafetyNotification(result.event.id).catch((error) => {
            logger.warn(`[Agente conversacional] La cuarentena preventiva quedó activa, pero la notificación seguirá en reintento: ${error.message}`)
          })
        }
        settleAction(action, 'ok', {
          actionCompleted: true,
          quarantined: true,
          safetyCaseId: result.case?.id || null,
          suppressReply: true,
          terminal: true,
          ...(handoffWarning ? { warnings: ['handoff'], handoffWarning } : {})
        })
        return { ok: true, actionCompleted: true, quarantined: true, suppressReply: true, terminal: true }
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo aplicar la medida preventiva: ${error.message}`)
        return failClosedPreventiveMeasureToHuman({ action, category, reason, cause: error })
      }
    }
  })

  const getConversationHistoryTool = tool({
    name: 'get_conversation_history',
    description: 'Consulta mensajes omitidos del mismo hilo sin otra IA. Usa mode=previous para la página inmediatamente anterior, oldest para empezar por el inicio, offset para saltar a una posición contada desde el mensaje omitido más antiguo, o search para buscar texto literal. Reutiliza nextCursor sólo con el mismo mode y query. Es sólo lectura y el servidor la liga al contacto y canal actuales.',
    parameters: z.object({
      mode: z.enum(['previous', 'oldest', 'offset', 'search']).describe('Forma de acceso al historial omitido'),
      cursor: z.string().nullable().describe('Cursor opaco devuelto por una llamada anterior del mismo modo y búsqueda; null para iniciar'),
      offset: z.number().int().min(0).nullable().describe('Posición desde el mensaje omitido más antiguo; sólo para mode=offset, null en los demás modos'),
      query: z.string().max(200).nullable().describe('Texto literal a buscar; sólo para mode=search, null en los demás modos'),
      limit: z.number().int().min(1).max(30).describe('Cantidad máxima de mensajes enteros a consultar')
    }),
    execute: async ({ mode, cursor, offset, query, limit }) => {
      if (typeof ctx.loadConversationHistoryPage !== 'function') {
        return { ok: false, error: 'No hay historial anterior disponible en esta conversación.' }
      }
      try {
        return await ctx.loadConversationHistoryPage({ mode, cursor, offset, query, limit })
      } catch (error) {
        logger.warn(`[Agente conversacional] No se pudo consultar una página anterior del hilo: ${error.message}`)
        return { ok: false, error: 'No se pudo consultar el historial anterior en este momento.' }
      }
    }
  })

  const getBusinessProfileTool = tool({
    name: 'get_business_profile',
    description: 'Devuelve los datos reales y estructurados del negocio: giro, oferta, ubicación, horarios, teléfonos, pagos, facturación, precios resumidos y calendarios. Úsala antes de responder preguntas del negocio.',
    parameters: z.object({}),
    execute: async () => {
      const [hlRow, userRow, calendars, businessProfile] = await Promise.all([
        db.get('SELECT location_data FROM highlevel_config LIMIT 1').catch(() => null),
        db.get('SELECT business_name FROM users ORDER BY id ASC LIMIT 1').catch(() => null),
        db.all("SELECT id, name, is_active FROM calendars WHERE is_active = 1 ORDER BY name ASC LIMIT 20").catch(() => []),
        getBusinessProfileSnapshot().catch(() => null)
      ])

      let location = null
      try {
        location = hlRow?.location_data ? JSON.parse(hlRow.location_data) : null
      } catch { /* JSON inválido */ }

      return {
        ok: true,
        business: {
          name: businessProfile?.businessName || businessProfile?.profile?.businessName || location?.name || userRow?.business_name || null,
          industry: businessProfile?.industry || businessProfile?.profile?.industry || null,
          businessType: businessProfile?.businessType || businessProfile?.profile?.businessType || null,
          summary: businessProfile?.summary || null,
          offeringsSummary: businessProfile?.offeringsSummary || null,
          pricingSummary: businessProfile?.pricingSummary || null,
          locationSummary: businessProfile?.locationSummary || null,
          paymentSummary: businessProfile?.paymentSummary || null,
          contactSummary: businessProfile?.contactSummary || null,
          address: location?.address || null,
          city: location?.city || null,
          phone: location?.phone || null,
          email: location?.email || null,
          timezone: location?.timezone || null,
          structuredProfile: businessProfile?.profile || null
        },
        promptParameters: businessProfile?.promptParameters || null,
        profileStatus: businessProfile?.extractionStatus || businessProfile?.status || 'empty',
        calendars: (calendars || []).map((cal) => ({ name: cal.name }))
      }
    }
  })

  const listProductsTool = tool({
    name: 'list_products',
    description: 'Lista los servicios/productos reales del negocio con su valor (precio). Úsala antes de hablar de valor o de lo que incluye un servicio. Nunca inventes valores.',
    parameters: z.object({
      query: z.string().nullable().describe('Texto para filtrar por nombre (opcional)')
    }),
    execute: async ({ query }) => {
      const params = []
      let sql = `
        SELECT p.id, p.ghl_product_id, p.name, p.description,
               pp.id AS price_id, pp.ghl_price_id, pp.name AS price_name,
               pp.amount, pp.currency, pp.type AS price_type
        FROM products p
        LEFT JOIN product_prices pp ON pp.product_id = p.id
        WHERE p.is_active = 1`
      if (paymentCapability?.paymentMode !== 'deposit' && paymentCapability?.productId) {
        sql += ' AND (p.id = ? OR p.ghl_product_id = ?)'
        params.push(paymentCapability.productId, paymentCapability.productId)
      }
      if (paymentCapability?.paymentMode !== 'deposit' && paymentCapability?.priceId) {
        sql += ' AND (pp.id = ? OR pp.ghl_price_id = ?)'
        params.push(paymentCapability.priceId, paymentCapability.priceId)
      }
      if (query) {
        sql += ' AND LOWER(p.name) LIKE ?'
        params.push(`%${String(query).toLowerCase()}%`)
      }
      sql += ' ORDER BY p.name ASC LIMIT 60'

      const rows = await db.all(sql, params)
      const byProduct = new Map()
      for (const row of rows) {
        if (!byProduct.has(row.id)) {
          byProduct.set(row.id, {
            name: row.name,
            description: row.description || null,
            ...(paymentCapability && paymentCapability.paymentMode !== 'deposit'
              ? { configuredForPayment: true }
              : {}),
            prices: []
          })
        }
        if (row.amount !== null && row.amount !== undefined) {
          byProduct.get(row.id).prices.push({
            ...(paymentCapability && paymentCapability.paymentMode !== 'deposit'
              ? { configuredForPayment: true }
              : {}),
            name: row.price_name || null,
            amount: row.amount,
            currency: row.currency || ctx.accountLocale?.currency || null,
            type: row.price_type || 'one_time'
          })
        }
      }
      const products = [...byProduct.values()]
      return { ok: true, total: products.length, products }
    }
  })

  const getContactProfileTool = tool({
    name: 'get_contact_profile',
    description: handoffCapability?.pastClientsToHuman
      ? 'Consulta obligatoria antes de seguir: devuelve datos reales del contacto, citas próximas y evidencia factual de cliente previo. Si pastClientEvidence.isPastClient es true, usa send_to_human; no sigas vendiendo ni interrogando.'
      : 'Devuelve los datos reales del contacto con el que conversas (nombre, teléfono, email, datos personalizados) y sus citas próximas. Úsala para no pedir datos que ya existen y para saber si ya tiene cita agendada.',
    parameters: z.object({}),
    execute: async () => {
      const contact = await getThreadContact(ctx)
      if (!contact) return missingThreadContactResult(ctx)

      if (contact.virtual) {
        return {
          ok: true,
          contact: {
            fullName: contact.full_name || 'Contacto de prueba',
            phone: contact.phone || null,
            email: contact.email || null,
            customFields: null,
            source: 'preview_thread'
          },
          upcomingAppointments: [],
          pastClientEvidence: {
            isPastClient: false,
            successfulPayments: [],
            pastAppointments: []
          },
          note: 'Este es el contacto virtual estable del probador. Úsalo como la identidad del hilo; no pidas teléfono ni intentes buscar otra ficha.'
        }
      }

      const nowIso = new Date().toISOString()
      const [appointments, pastAppointments, paymentRows] = await Promise.all([
        db.all(`
          SELECT id, title, start_time, end_time, appointment_status, status
          FROM appointments
          WHERE contact_id = ? AND deleted_at IS NULL AND start_time >= ?
          ORDER BY start_time ASC LIMIT 5
        `, [ctx.contactId, nowIso]),
        db.all(`
              SELECT title, start_time, end_time, appointment_status, status
              FROM appointments
              WHERE contact_id = ? AND deleted_at IS NULL AND start_time < ?
                AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'invalid')
              ORDER BY start_time DESC LIMIT 10
            `, [ctx.contactId, nowIso]).catch(() => []),
        db.all(`
              SELECT amount, currency, status, payment_mode, payment_provider,
                     COALESCE(paid_at, date, created_at) AS payment_at
              FROM payments
              WHERE contact_id = ?
              ORDER BY COALESCE(paid_at, date, created_at) DESC
              LIMIT 100
            `, [ctx.contactId]).catch(() => [])
      ])

      let customFields = null
      try {
        customFields = contact.custom_fields ? JSON.parse(contact.custom_fields) : null
      } catch { /* texto plano */ customFields = contact.custom_fields }

      const successfulPayments = (paymentRows || []).filter((payment) => {
            const status = String(payment.status || '').trim().toLowerCase()
            const rawMode = String(payment.payment_mode || '').trim().toLowerCase()
            const normalizedMode = rawMode.replace(/_/g, ' ')
            return SUCCESS_PAYMENT_STATUSES.has(status) &&
              !NON_LIVE_PAYMENT_MODES.has(rawMode) &&
              !NON_LIVE_PAYMENT_MODES.has(normalizedMode)
          }).slice(0, 10).map((payment) => ({
            amount: Number(payment.amount) || 0,
            currency: normalizeCurrencyCode(payment.currency || ctx.accountLocale?.currency),
            status: String(payment.status || '').trim().toLowerCase(),
            paidAt: payment.payment_at || null,
            provider: payment.payment_provider || null
          }))
      const visiblePastAppointments = (pastAppointments || []).map((appointment) => ({
            title: appointment.title || null,
            startTime: appointment.start_time,
            endTime: appointment.end_time,
            status: appointment.appointment_status || appointment.status || null
          }))

      return {
        ok: true,
        contact: {
          fullName: contact.full_name || null,
          phone: contact.phone || null,
          email: contact.email || null,
          customFields,
          source: 'current_thread'
        },
        upcomingAppointments: appointments.map((appt) => ({
          title: appt.title,
          startTime: appt.start_time,
          endTime: appt.end_time,
          status: appt.appointment_status || appt.status
        })),
        pastClientEvidence: {
          isPastClient: successfulPayments.length > 0 || visiblePastAppointments.length > 0,
          successfulPayments,
          pastAppointments: visiblePastAppointments
        },
        note: 'Esta ficha ya es la identidad del hilo actual. No pidas otro teléfono, apellido ni registro para buscar a la misma persona.'
      }
    }
  })

  const saveContactDataTool = tool({
    name: 'save_contact_data',
    description: 'Guarda sólo datos que quien escribe confirmó como propios para el contacto de este mismo hilo. Nunca guarda aquí datos del titular distinto o invitados. No busca ni crea otra ficha; el servidor protege datos existentes y sólo reemplaza cuando la política lo permite.',
    parameters: z.object({
      fullName: z.string().nullable().describe('Nombre completo confirmado; null si no se proporcionó'),
      phone: z.string().nullable().describe('Teléfono principal confirmado; null si no se proporcionó'),
      alternatePhone: z.string().nullable().describe('Otro teléfono confirmado; null si no aplica'),
      email: z.string().nullable().describe('Correo confirmado; null si no se proporcionó'),
      company: z.string().nullable().describe('Empresa confirmada; null si no aplica'),
      address: z.string().nullable().describe('Dirección confirmada; null si no aplica'),
      customValues: z.array(z.object({
        key: z.string().min(1).max(120),
        value: z.string().max(1000)
      })).max(20).nullable().describe('Datos personalizados confirmados; null si no aplica'),
      confirmedReplacement: z.boolean().describe('Compatibilidad: el servidor nunca usa este booleano como autorización suficiente para reemplazar una identidad existente')
    }),
    execute: async ({ fullName, phone, alternatePhone, email, company, address, customValues }) => {
      if (!dataRequirements?.enabled || !dataRequirements?.updateContact?.enabled) {
        return { ok: false, actionCompleted: false, error: 'La actualización automática del contacto no está habilitada.' }
      }
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const configuredFields = Array.isArray(dataRequirements.fields) ? dataRequirements.fields : []
      const allowedFields = new Set(configuredFields.map((item) => String(item?.field || '').trim()))
      const normalizeCustomKey = (value) => cleanAppointmentText(value, 120)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
      const allowedCustomFields = new Map(
        configuredFields
          .filter((item) => item?.field === 'custom' && item?.label)
          .map((item) => [normalizeCustomKey(item.label), cleanAppointmentText(item.label, 120)])
          .filter(([key]) => Boolean(key))
      )
      const unauthorizedFields = []
      if (fullName && !allowedFields.has('full_name') && !allowedFields.has('first_name')) unauthorizedFields.push('name')
      if (phone && !allowedFields.has('phone')) unauthorizedFields.push('phone')
      if (alternatePhone && !allowedFields.has('alternate_phone')) unauthorizedFields.push('alternate_phone')
      if (email && !allowedFields.has('email')) unauthorizedFields.push('email')
      if (company && !allowedFields.has('company')) unauthorizedFields.push('company')
      if (address && !allowedFields.has('address')) unauthorizedFields.push('address')
      for (const item of Array.isArray(customValues) ? customValues : []) {
        const key = normalizeCustomKey(item?.key)
        if (!key || !allowedCustomFields.has(key)) unauthorizedFields.push(key || 'custom')
      }
      if (unauthorizedFields.length) {
        return {
          ok: false,
          actionCompleted: false,
          error: `Estos datos no están autorizados en la configuración: ${[...new Set(unauthorizedFields)].join(', ')}.`
        }
      }
      const cleanFullName = cleanAppointmentText(fullName, 240)
      const cleanPhone = phone ? normalizePhoneForStorage(phone) : ''
      const cleanAlternatePhone = alternatePhone ? normalizePhoneForStorage(alternatePhone) : ''
      const cleanEmail = cleanAppointmentText(email, 240).toLowerCase()
      if (phone && (cleanPhone.replace(/\D/g, '').length < 7 || cleanPhone.replace(/\D/g, '').length > 15)) {
        return { ok: false, actionCompleted: false, error: 'El teléfono confirmado no tiene un formato válido.' }
      }
      if (alternatePhone && (cleanAlternatePhone.replace(/\D/g, '').length < 7 || cleanAlternatePhone.replace(/\D/g, '').length > 15)) {
        return { ok: false, actionCompleted: false, error: 'El teléfono alterno confirmado no tiene un formato válido.' }
      }
      if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return { ok: false, actionCompleted: false, error: 'El correo confirmado no tiene un formato válido.' }
      }
      const contact = await getThreadContact(ctx)
      if (!contact) return missingThreadContactResult(ctx)
      const action = pushAction(ctx, 'save_contact_data', {
        fields: [
          fullName ? 'full_name' : '',
          phone ? 'phone' : '',
          alternatePhone ? 'alternate_phone' : '',
          email ? 'email' : '',
          company ? 'company' : '',
          address ? 'address' : '',
          ...(Array.isArray(customValues) ? customValues.map((item) => item?.key) : [])
        ].filter(Boolean)
      })
      if (ctx.dryRun || contact.virtual) {
        if (contact.virtual) {
          const virtualCustomFields = parseContactCustomFields(ctx.virtualContact?.custom_fields)
          const virtualUpdates = []
          if (cleanAlternatePhone) virtualUpdates.push({ key: 'alternate_phone', label: 'Teléfono alterno', value: cleanAlternatePhone })
          if (company) virtualUpdates.push({ key: 'company', label: 'Empresa', value: cleanAppointmentText(company, 400) })
          if (address) virtualUpdates.push({ key: 'address_1', label: 'Dirección', value: cleanAppointmentText(address, 800) })
          for (const item of Array.isArray(customValues) ? customValues : []) {
            const key = normalizeCustomKey(item?.key)
            if (key && allowedCustomFields.has(key)) {
              virtualUpdates.push({ key, label: allowedCustomFields.get(key), value: cleanAppointmentText(item.value, 1000) })
            }
          }
          ctx.virtualContact = {
            ...(ctx.virtualContact || {}),
            ...(cleanFullName ? { fullName: cleanFullName, full_name: cleanFullName } : {}),
            ...(cleanPhone ? { phone: cleanPhone } : {}),
            ...(cleanEmail ? { email: cleanEmail } : {}),
            ...(virtualUpdates.length
              ? { custom_fields: serializeContactCustomFieldsForDb(mergeContactCustomFields(virtualCustomFields, virtualUpdates)) }
              : {})
          }
        }
        settleAction(action, 'simulated', { actionCompleted: false, wouldUpdateThreadContact: true })
        return { ok: true, simulated: true, wouldUpdateThreadContact: true }
      }

      const policy = String(dataRequirements?.updateContact?.policy || 'replace_placeholders')
      const persistAgainstCurrentIdentity = () => db.transaction(async (tx) => {
        // PostgreSQL bloquea la fila; SQLite entra a esta transacción con BEGIN
        // IMMEDIATE. Toda decisión se recalcula con la identidad vigente, nunca
        // con el snapshot que existía antes de esperar el candado.
        const lockSuffix = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
        const current = await tx.get(
          `SELECT id, full_name, first_name, last_name, phone, email, custom_fields
           FROM contacts WHERE id = ? AND deleted_at IS NULL${lockSuffix}`,
          [ctx.contactId]
        )
        if (!current) return { missing: true, changedFields: [], preservedFields: [] }

        const updates = []
        const params = []
        const changedFields = []
        const preservedFields = []
        const customUpdates = []
        if (cleanFullName) {
          const mayReplace = !current.full_name ||
            (policy === 'replace_placeholders' && isPlaceholderContactName(current.full_name)) ||
            String(current.full_name).trim().toLowerCase() === cleanFullName.toLowerCase()
          if (mayReplace) {
            const name = splitConfirmedName(cleanFullName)
            updates.push('full_name = ?', 'first_name = ?', 'last_name = ?')
            params.push(name.fullName, name.firstName, name.lastName)
            changedFields.push('full_name')
          } else {
            preservedFields.push('full_name')
            customUpdates.push({ key: 'alternate_name', label: 'Nombre alternativo', value: cleanFullName })
          }
        }

        if (cleanPhone) {
          const currentPhone = current.phone ? normalizePhoneForStorage(current.phone) : ''
          const mayReplace = !currentPhone || currentPhone === cleanPhone
          if (mayReplace) {
            const conflict = await tx.get(
              `SELECT id FROM contacts
               WHERE phone = ? AND id <> ? AND deleted_at IS NULL${lockSuffix}`,
              [cleanPhone, ctx.contactId]
            )
            if (conflict) {
              preservedFields.push('phone')
              customUpdates.push({ key: 'alternate_phone', label: 'Teléfono alterno', value: cleanPhone })
            } else {
              updates.push('phone = ?')
              params.push(cleanPhone)
              changedFields.push('phone')
            }
          } else {
            customUpdates.push({ key: 'alternate_phone', label: 'Teléfono alterno', value: cleanPhone })
            preservedFields.push('phone')
          }
        }
        if (cleanAlternatePhone) customUpdates.push({ key: 'alternate_phone', label: 'Teléfono alterno', value: cleanAlternatePhone })

        if (cleanEmail) {
          const currentEmail = String(current.email || '').trim().toLowerCase()
          const mayReplace = !currentEmail || currentEmail === cleanEmail
          if (mayReplace) {
            const conflict = await tx.get(
              `SELECT id FROM contacts
               WHERE LOWER(email) = ? AND id <> ? AND deleted_at IS NULL${lockSuffix}`,
              [cleanEmail, ctx.contactId]
            )
            if (conflict) {
              preservedFields.push('email')
              customUpdates.push({ key: 'alternate_email', label: 'Correo alterno', value: cleanEmail })
            } else {
              updates.push('email = ?')
              params.push(cleanEmail)
              changedFields.push('email')
            }
          } else {
            customUpdates.push({ key: 'alternate_email', label: 'Correo alterno', value: cleanEmail })
            preservedFields.push('email')
          }
        }
        if (company) customUpdates.push({ key: 'company', label: 'Empresa', value: cleanAppointmentText(company, 400) })
        if (address) customUpdates.push({ key: 'address_1', label: 'Dirección', value: cleanAppointmentText(address, 800) })
        for (const item of Array.isArray(customValues) ? customValues : []) {
          const key = normalizeCustomKey(item?.key)
          if (key && allowedCustomFields.has(key)) {
            customUpdates.push({ key, label: allowedCustomFields.get(key), value: cleanAppointmentText(item.value, 1000) })
          }
        }
        if (customUpdates.length) {
          const merged = mergeContactCustomFields(parseContactCustomFields(current.custom_fields), customUpdates)
          updates.push(`custom_fields = ${process.env.DATABASE_URL ? '?::jsonb' : '?'}`)
          params.push(serializeContactCustomFieldsForDb(merged))
          changedFields.push(...customUpdates.map((item) => item.key))
        }
        if (!updates.length) return { missing: false, changedFields: [], preservedFields }

        updates.push('updated_at = CURRENT_TIMESTAMP')
        params.push(ctx.contactId)
        const update = await tx.run(
          `UPDATE contacts SET ${updates.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
          params
        )
        if (Number(update?.changes ?? update?.rowCount ?? 0) !== 1) {
          const race = new Error('La identidad del contacto cambió antes de confirmar el guardado.')
          race.code = 'contact_identity_update_race'
          throw race
        }
        return { missing: false, changedFields, preservedFields }
      })

      let persisted
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          persisted = await persistAgainstCurrentIdentity()
          break
        } catch (error) {
          const uniqueConflict = error?.code === '23505' ||
            error?.code === 'SQLITE_CONSTRAINT' ||
            error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
          if (!uniqueConflict || attempt === 2) throw error
        }
      }
      if (persisted?.missing) return missingThreadContactResult(ctx)
      const changedFields = persisted?.changedFields || []
      const preservedFields = persisted?.preservedFields || []

      // La base local es la autoridad del runtime. La sincronización de los
      // campos estándar a HighLevel es best-effort y nunca revierte el guardado.
      try {
        const ghlContactId = await getGhlContactIdForLocalContact(ctx.contactId)
        if (ghlContactId) {
          const ghlClient = await getGHLClient()
          const standard = {}
          if (changedFields.includes('full_name')) standard.name = cleanFullName
          if (changedFields.includes('phone')) standard.phone = cleanPhone
          if (changedFields.includes('email')) standard.email = cleanEmail
          if (Object.keys(standard).length) await ghlClient.updateContact(ghlContactId, standard)
        }
      } catch (error) {
        logger.warn(`[Agente conversacional] Datos del contacto guardados localmente; sync HighLevel pendiente: ${error.message}`)
      }
      settleAction(action, 'ok', { actionCompleted: true, changedFields, preservedFields })
      return { ok: true, actionCompleted: true, changedFields, preservedFields }
    }
  })

  const getFreeSlotsForAgentTool = tool({
    name: 'get_free_slots',
    description: [
      scheduleCapability?.allowOverlaps
        ? 'Obtiene horarios reales del calendario blindado. El negocio permite empalmar citas dentro de sus horas de atención.'
        : 'Obtiene horarios reales y libres del calendario blindado; no devuelve horarios ocupados.',
      'Cada opción incluye localLabel/localDate/localTime ya calculados en la zona del negocio: usa esos campos para hablar con la persona y NO conviertas el horario por tu cuenta.',
      'Para agendar, pasa options[].startTime exactamente como aparece, sin recalcularlo ni reconstruirlo.'
    ].join(' '),
    parameters: z.object({
      startDate: z.string().describe('Fecha inicial YYYY-MM-DD en la zona horaria del negocio'),
      endDate: z.string().describe('Fecha final YYYY-MM-DD en la zona horaria del negocio')
    }),
    execute: async ({ startDate, endDate }) => {
      const nativeCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
      const effectiveCalendarId = nativeCalendar?.id || null
      if (!effectiveCalendarId) {
        return { ok: false, total: 0, slots: [], error: 'El calendario blindado de la capacidad no existe o ya no está activo. Pasa la conversación a una persona.' }
      }
      const overlapsAllowed = scheduleCapability?.allowOverlaps === true
      const accountTimezone = await getAccountTimezone()
      const rawSlots = await getLocalFreeSlots(effectiveCalendarId, startDate, endDate, accountTimezone, {
        ignoreAppointmentConflicts: overlapsAllowed,
        appointmentLimit: overlapsAllowed ? undefined : 1
      })
      const slots = buildNativeFreeSlotDays(rawSlots, accountTimezone)

      if (!Array.isArray(slots) || !slots.length) {
        return {
          ok: true,
          total: 0,
          slots: [],
          note: 'Sin horarios disponibles en ese rango (o el calendario no existe).'
        }
      }

      return {
        ok: true,
        total: slots.reduce((total, day) => total + (
          Array.isArray(day.options)
            ? day.options.length
            : (Array.isArray(day.slots) ? day.slots.length : 0)
        ), 0),
        overlapPolicy: overlapsAllowed ? 'allowed' : 'blocked',
        note: [
          overlapsAllowed
            ? 'Empalme permitido: estos horarios respetan horas de atención, pero pueden coincidir con citas existentes.'
            : 'Empalme bloqueado: estos horarios no tienen otra cita activa encima.',
          'No escribas horarios por tu cuenta: pasa un solo options[].startTime sin modificar a offer_appointment_slot; la hora local ya está calculada por Ristak.'
        ].filter(Boolean).join(' '),
        slots
      }
    }
  })

  const offerAppointmentSlotTool = tool({
    name: 'offer_appointment_slot',
    description: 'Ofrece UN solo slot real con texto construido por el servidor. Úsala después de get_free_slots; esta herramienta cierra el turno y su visibleReply no se puede mezclar con otro horario.',
    parameters: z.object({
      startTime: z.string().describe('options[].startTime exacto devuelto por get_free_slots')
    }),
    execute: async ({ startTime }) => {
      const nativeCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
      const calendarId = nativeCalendar?.id || null
      const startMs = Date.parse(startTime || '')
      if (!calendarId || !Number.isFinite(startMs) || startMs <= Date.now()) {
        return { ok: false, actionCompleted: false, error: 'El horario ya no es válido o el calendario dejó de estar activo.' }
      }
      const timezone = await getAccountTimezone()
      const slotValidation = await revalidateAppointmentSlot({
        calendarId,
        requestedStartTime: new Date(startMs).toISOString(),
        windowStart: normalizeDateOnlyInTimezone(new Date(startMs - 86400000).toISOString(), timezone),
        windowEnd: normalizeDateOnlyInTimezone(new Date(startMs + 86400000).toISOString(), timezone),
        lookupSlots: getLocalFreeSlots,
        ignoreAppointmentConflicts: scheduleCapability?.allowOverlaps === true
      })
      if (!slotValidation.ok) return slotValidation
      const canonicalStartTime = new Date(slotValidation.matchedStartTime).toISOString()
      const canonical = buildCanonicalAppointmentSlotOption(canonicalStartTime, timezone)
      if (!canonical?.localLabel) {
        return { ok: false, actionCompleted: false, error: 'No se pudo construir la oferta canónica del horario.' }
      }
      const visibleReply = nativeAppointmentOfferText(canonical.localLabel)
      const action = pushAction(ctx, 'offer_appointment_slot', {
        calendarId,
        startTime: canonicalStartTime,
        localLabel: canonical.localLabel,
        visibleReply,
        effect: { liveEffect: 'OFRECERÍA un solo horario real y esperaría confirmación', marksObjectiveCompleted: false }
      })
      const persisted = await persistNativeAppointmentOffer({
        ctx,
        config,
        calendarId,
        startTime: canonicalStartTime,
        localLabel: canonical.localLabel,
        timezone
      })
      if (!persisted.ok) {
        settleAction(action, 'error', { error: persisted.error })
        return persisted
      }
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          visibleReply,
          terminal: true,
          actionCompleted: false,
          offerEventId: persisted.offerEventId
        })
        return {
          ok: true,
          simulated: true,
          actionCompleted: false,
          terminal: true,
          visibleReply,
          offerEventId: persisted.offerEventId
        }
      }
      settleAction(action, 'ok', {
        terminal: true,
        visibleReply,
        offerEventId: persisted.offerEventId,
        actionCompleted: true
      })
      return { ok: true, actionCompleted: true, terminal: true, visibleReply }
    }
  })

  const bookAppointmentTool = tool({
    name: 'book_appointment',
    description: 'Agenda una cita real en el calendario blindado. Sólo se usa cuando el cliente confirma en otro turno la última oferta estructurada creada por offer_appointment_slot. Querer agendar, querer ir o proponer una fecha/hora no autoriza reservar en ese mismo turno. No recibe horarios: el servidor recupera el único slot ofrecido, deriva la evidencia del hilo y comprueba oferta, orden de turnos, selección durable, disponibilidad y carreras.',
    parameters: z.object({
      title: z.string().nullable().describe('Título corto de la cita; null usa el título seguro por defecto'),
      notes: z.string().nullable().describe('Resumen breve de lo que busca la persona; null usa una nota segura'),
      attendeeName: z.string().nullable().describe('Nombre de la persona que asistirá sólo cuando sea distinta del contacto del hilo; null si la cita es para quien escribe'),
      attendeeContext: z.string().nullable().describe('Compatibilidad: relación o contexto del asistente distinto; null si primaryAttendee ya contiene el dato'),
      primaryAttendee: z.preprocess(
        (value) => value ?? null,
        appointmentPersonSchema.nullable()
      ).describe('Titular real de la cita cuando es distinto de quien escribe; null usa el contacto del hilo'),
      guests: z.preprocess(
        (value) => value ?? null,
        z.array(appointmentPersonSchema).nullable()
      ).describe('Invitados adicionales confirmados; null o [] si no hay')
    }),
    execute: async (args) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const {
        title,
        notes,
        attendeeName,
        attendeeContext,
        primaryAttendee,
        guests
      } = args || {}
      const nativeCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
      const calendarId = nativeCalendar?.id || null
      if (!calendarId) {
        return { ok: false, actionCompleted: false, error: 'El calendario blindado de la capacidad no existe o ya no está activo. No se agendó nada; pasa la conversación a una persona.' }
      }
      const businessTimezone = await getAccountTimezone()
      let confirmationEvidence = await resolveNativeAppointmentSelection({
        ctx,
        config,
        calendarId,
        timezone: businessTimezone
      })
      if (!confirmationEvidence.ok) return confirmationEvidence
      const startTime = String(confirmationEvidence.selectedStartTime || '').trim()
      const start = new Date(startTime)
      if (Number.isNaN(start.getTime())) {
        return { ok: false, actionCompleted: false, error: 'La oferta guardada no conserva un horario válido. No se agendó nada.' }
      }
      const threadContact = await getThreadContact(ctx)
      if (!threadContact) return missingThreadContactResult(ctx)
      const participantEvidenceMessages = await resolveAppointmentParticipantEvidenceMessages({
        ctx,
        primaryAttendee,
        guests
      })
      const participants = buildAppointmentParticipants({
        contact: threadContact,
        primaryAttendee,
        guests,
        attendeeName,
        attendeeContext,
        requirements: dataRequirements,
        conversationMessages: participantEvidenceMessages
      })
      if (!participants.ok) return { ok: false, actionCompleted: false, error: participants.error }
      const requiredDataError = await enforceRequiredContactData({
        ctx,
        scope: 'appointment',
        dataRequirements,
        contact: threadContact,
        facts: appointmentRequirementFacts({
          contact: threadContact,
          primaryAttendee,
          attendeeName,
          attendeeContext,
          guests
        })
      })
      if (requiredDataError) return requiredDataError
      const participant = buildAppointmentParticipant({
        contact: threadContact,
        title,
        notes,
        attendeeName,
        attendeeContext,
        primaryAttendee
      })

      const nativeExecutionId = String(ctx.executionId || '').trim()
      const nativeOverlapsAllowed = scheduleCapability?.allowOverlaps === true
      const nativeDurationMinutes = Number(nativeCalendar?.slot_duration) > 0 ? Number(nativeCalendar.slot_duration) : 60
      if (!ctx.dryRun && !nativeExecutionId) {
        return {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo identificar de forma segura el mensaje que pidió la cita. No se agendó nada; pasa la conversación a una persona.'
        }
      }
      const nativeClientRequestId = buildConversationalSlotRequestId(calendarId, start.toISOString(), {
        allowOverlaps: nativeOverlapsAllowed,
        contactId: ctx.contactId,
        channel: ctx.channel,
        executionId: nativeExecutionId
      })
      // El replay exacto manda sobre el guard de cualquier cita futura: conserva
      // el contrato que informa reprogramación/cancelación de ese mismo intento.
      if (!ctx.dryRun) {
        const provisionalEnd = new Date(start.getTime() + nativeDurationMinutes * 60000)
        const changedReplay = await inspectChangedAppointmentCreationReplay({
          clientRequestId: nativeClientRequestId,
          payload: {
            calendarId,
            contactId: ctx.contactId,
            startTime: start.toISOString(),
            endTime: provisionalEnd.toISOString(),
            source: 'conversational_agent_v2'
          }
        })
        if (changedReplay?.idempotencyReplay?.canonicalChanged) {
          const replayState = changedReplay.idempotencyReplay.state
          const replayError = replayState === 'appointment_rescheduled'
            ? 'La cita vinculada a este intento ya fue reprogramada. No se reservó otra vez el horario anterior; usa únicamente la fecha y hora vigentes que aparecen en existingAppointment.'
            : 'La cita vinculada a este intento ya no está activa. No se creó una cita nueva; ofrece volver a consultar horarios o pasa la conversación a una persona.'
          const replayAction = pushAction(ctx, 'book_appointment', {
            calendarId,
            startTime: start.toISOString(),
            endTime: provisionalEnd.toISOString(),
            clientRequestId: nativeClientRequestId,
            confirmationEvidence
          })
          settleAction(replayAction, 'error', {
            appointmentCreated: false,
            appointmentRescheduled: replayState === 'appointment_rescheduled',
            canonicalAppointment: {
              calendarId: changedReplay.calendarId || null,
              startTime: changedReplay.startTime || null,
              endTime: changedReplay.endTime || null,
              status: changedReplay.appointmentStatus || changedReplay.status || null
            },
            error: replayError
          })
          return {
            ok: false,
            actionCompleted: false,
            alreadyBooked: true,
            appointmentRescheduled: replayState === 'appointment_rescheduled',
            existingAppointment: {
              title: changedReplay.title || 'Cita',
              startTime: changedReplay.startTime || null,
              endTime: changedReplay.endTime || null,
              status: changedReplay.appointmentStatus || changedReplay.status || null
            },
            error: replayError
          }
        }
      }

      const depositContract = nativeAppointmentDepositContract(ctx, config)
      // Sólo una cita unida durablemente al mismo agente y a su request canónico
      // puede declararse propia; una cita propia en otro slot también bloquea una
      // segunda alta y repara el cierre.
      let existing = null
      let boundExisting = null
      if (ctx.contactId) {
        const candidates = await db.all(`
          SELECT id, calendar_id, contact_id, title, start_time, end_time, appointment_status, status, deleted_at
          FROM appointments
          WHERE contact_id = ? AND calendar_id = ? AND deleted_at IS NULL AND start_time >= ?
            AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'deleted')
          ORDER BY start_time ASC LIMIT 20
        `, [ctx.contactId, calendarId, new Date().toISOString()])
        const exactSlotExisting = (candidates || []).find((appointment) => (
          Math.abs(new Date(appointment.start_time).getTime() - start.getTime()) < 60000
        )) || null
        try {
          const ownedExisting = await findBoundNativeAppointment({
            ctx,
            config,
            calendarId
          })
          if (ownedExisting) {
            existing = ownedExisting.appointment
            boundExisting = ownedExisting
          } else {
            existing = exactSlotExisting
          }
        } catch (error) {
          logger.error(`[Agente conversacional] No se pudo probar el vínculo de las citas existentes: ${error.message}`)
          return {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            error: 'No se pudo comprobar de forma única qué cita pertenece a este agente. No se agendó nada; pasa la conversación a una persona.'
          }
        }
      }
      if (existing) {
        if (!boundExisting) {
          return {
            ok: false,
            actionCompleted: false,
            alreadyBooked: true,
            verifiedExistingAction: false,
            transferRequired: true,
            existingAppointment: {
              title: existing.title || 'Cita',
              startTime: existing.start_time,
              endTime: existing.end_time,
              status: existing.appointment_status || existing.status || null
            },
            error: 'Ya existe una cita real, pero no coincide con el vínculo y contrato actuales de este agente. No se creó ni se cerró nada; pasa la conversación a una persona.'
          }
        }
        existing = boundExisting.appointment
        const existingClientRequestId = boundExisting.request.client_request_id
        const existingAction = pushAction(ctx, 'book_appointment', {
          calendarId: existing.calendar_id,
          startTime: existing.start_time,
          endTime: existing.end_time,
          appointmentId: existing.id,
          clientRequestId: existingClientRequestId,
          confirmationEvidence,
          verifiedExistingAction: true,
          effect: { liveEffect: 'REUTILIZA la cita real existente y repara su cierre interno', marksObjectiveCompleted: true }
        })
        if (boundExisting.detail.depositRequired === true) {
          try {
            const depositConsumption = await consumeReservedDepositForExistingNativeAppointment({ ctx, config, appointment: existing })
            if (!depositConsumption?.consumed) {
              throw new Error('La cita vinculada no conserva una reserva de anticipo válida')
            }
          } catch (error) {
            settleAction(existingAction, 'error', {
              appointmentCreated: false,
              verifiedExistingAction: false,
              transferRequired: true,
              error: error.message
            })
            return {
              ok: false,
              actionCompleted: false,
              alreadyBooked: true,
              verifiedExistingAction: false,
              transferRequired: true,
              error: 'La cita existe, pero no se pudo demostrar que su anticipo siga válido y ligado a ella. No se cerró el objetivo; pasa la conversación a una persona.'
            }
          }
        }
        let completionSyncWarning = false
        try {
          await syncNativeAppointmentCompletion({
            ctx,
            config,
            appointment: existing,
            calendarId: existing.calendar_id
          })
        } catch (error) {
          completionSyncWarning = true
          logger.error(`[Agente conversacional] La cita ${existing.id} ya existía, pero no se pudo reparar su cierre: ${error.message}`)
        }
        settleAction(existingAction, 'ok', {
          appointmentId: existing.id,
          calendarId: existing.calendar_id,
          startTime: existing.start_time,
          appointmentCreated: false,
          verifiedExistingAction: true,
          objectiveCompleted: !completionSyncWarning,
          completionSyncWarning
        })
        return {
          ok: true,
          actionCompleted: true,
          alreadyBooked: true,
          verifiedExistingAction: true,
          appointment: {
            title: existing.title || 'Cita',
            startTime: existing.start_time,
            endTime: existing.end_time,
            status: existing.appointment_status || existing.status || 'confirmed'
          },
          ...(completionSyncWarning
            ? { completionSyncWarning: true, note: 'La cita real ya existe y no se duplicó; el cierre interno seguirá reintentándose.' }
            : { note: 'La cita real ya existía y su cierre quedó confirmado; no crees otra.' })
        }
      }

      const calendar = nativeCalendar
      if (!calendar) return { ok: false, actionCompleted: false, error: 'Calendario no encontrado: usa list_calendars para obtener el ID real. No se agendó nada.' }

      const durationMinutes = Number(calendar.slot_duration) > 0 ? Number(calendar.slot_duration) : 60
      const overlapsAllowed = nativeOverlapsAllowed
      const clientRequestId = nativeClientRequestId

      // Candado funcional anti-cita-inventada: el horario debe seguir siendo un slot
      // real y libre del calendario al momento de confirmar. La creación vuelve a
      // comprobarlo dentro de su lock transaccional para cerrar también la carrera
      // entre esta lectura y el INSERT definitivo.
      const startMs = start.getTime()
      const slotWindowStart = normalizeDateOnlyInTimezone(new Date(startMs - 24 * 60 * 60 * 1000).toISOString(), businessTimezone)
      const slotWindowEnd = normalizeDateOnlyInTimezone(new Date(startMs + 24 * 60 * 60 * 1000).toISOString(), businessTimezone)
      const slotValidation = await revalidateAppointmentSlot({
        calendarId,
        requestedStartTime: start.toISOString(),
        windowStart: slotWindowStart,
        windowEnd: slotWindowEnd,
        lookupSlots: getLocalFreeSlots,
        ignoreAppointmentConflicts: overlapsAllowed
      })
      if (!slotValidation.ok) {
        if (slotValidation.availabilityCheckFailed) {
          logger.warn(`[Agente conversacional] Revalidación de slot bloqueada: ${slotValidation.technicalError || slotValidation.error}`)
        }
        return slotValidation
      }
      // Snap al slot exacto para no arrastrar deriva de segundos del modelo.
      start.setTime(new Date(slotValidation.matchedStartTime).getTime())

      if (!confirmationEvidence.reusedForPaymentResume) {
        confirmationEvidence = await persistNativeAppointmentSelection({
          ctx,
          config,
          calendarId,
          startTime: start.toISOString(),
          evidence: confirmationEvidence
        })
        if (!confirmationEvidence.ok && confirmationEvidence.actionCompleted === false) return confirmationEvidence
      }

      const depositError = await rejectMissingDepositIfNeeded(
        ctx,
        config,
        ctx.accountLocale,
        {
          appointmentRequestId: clientRequestId || '',
          calendarId,
          startTime: start.toISOString()
        }
      )
      if (depositError) {
        if (!ctx.dryRun && confirmationEvidence?.durable === true) {
          const intent = await ensureNativeAppointmentDepositIntent({
            ctx,
            config,
            selectionEvidence: confirmationEvidence,
            methods: getDepositPaymentMethodsForRuntime(ctx, config)
          })
          if (!intent.ok) return intent
        }
        return depositError
      }

      const end = new Date(start.getTime() + durationMinutes * 60000)

      // El controller debe recibir primero la llave durable: así un retry
      // idéntico reproduce la cita ya creada antes de volver a evaluar conflicto.
      // La primera creación sí vuelve a comprobar cupo dentro del lock transaccional.
      const finalTitle = participant.title
      const action = pushAction(ctx, 'book_appointment', {
        calendarId, startTime: start.toISOString(), endTime: end.toISOString(), title: finalTitle,
        participants: participants.all,
        confirmationEvidence,
        ...(clientRequestId ? { clientRequestId } : {}),
        effect: { liveEffect: 'AGENDARÍA UNA CITA REAL y marcaría el objetivo como CUMPLIDO', marksObjectiveCompleted: true }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          wouldMarkObjectiveCompleted: true,
          calendarId,
          startTime: start.toISOString()
        })
        return {
          ok: true,
          simulated: true,
          wouldMarkObjectiveCompleted: true,
          appointment: {
            title: finalTitle,
            startTime: start.toISOString(),
            endTime: end.toISOString()
          }
        }
      }

      let depositReservation = null
      if (ctx.verifiedPaymentEvidence?.paymentPurpose === 'appointment_deposit') {
        try {
          depositReservation = await reserveConversationalAppointmentDepositEvidence({
            reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
            contactId: ctx.contactId,
            agentId: config.id || ctx.agentId || '',
            paymentId: ctx.verifiedPaymentEvidence.paymentId,
            appointmentRequestId: clientRequestId
          })
        } catch (error) {
          const reservationError = {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            error: 'El anticipo verificado ya está reservado para otra cita o perdió su vínculo seguro. No se agendó nada; pasa la conversación a una persona.'
          }
          settleAction(action, 'error', { error: error.message, transferRequired: true })
          return reservationError
        }
      }

      const releaseDepositReservationAfterDefinitiveFailure = async (reason) => {
        if (!depositReservation?.reserved || !ctx.verifiedPaymentEvidence) return
        const request = await db.get(
          'SELECT status FROM appointment_creation_requests WHERE client_request_id = ?',
          [clientRequestId]
        ).catch(() => null)
        // processing es incierto: conservar la reserva hasta que el retry exacto
        // reconcilie si alcanzó a existir una cita. completed nunca se libera.
        if (request?.status === 'processing' || request?.status === 'completed') return
        await releaseConversationalAppointmentDepositEvidence({
          reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
          contactId: ctx.contactId,
          agentId: config.id || ctx.agentId || '',
          paymentId: ctx.verifiedPaymentEvidence.paymentId,
          appointmentRequestId: clientRequestId,
          reason
        }).catch((error) => {
          logger.warn(`[Agente conversacional] No se pudo liberar la reserva del anticipo: ${error.message}`)
        })
      }

      try {
        await reserveNativeAppointmentBinding({
          ctx,
          config,
          calendarId,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          appointmentRequestId: clientRequestId,
          depositContract
        })
      } catch (error) {
        await releaseDepositReservationAfterDefinitiveFailure('appointment_binding_failed')
        settleAction(action, 'error', { error: error.message, transferRequired: true })
        return {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo guardar el vínculo seguro entre esta conversación y la cita. No se agendó nada; pasa la conversación a una persona.'
        }
      }

      // Renueva y vuelve a comprobar la propiedad de la reserva justo antes de
      // entrar al controller. Si otro recovery tomó una lease vencida mientras
      // se preparaba el vínculo, este proceso viejo queda cercado y no crea una
      // cita con un anticipo que ya pertenece a otro intento.
      if (depositReservation?.reserved && ctx.verifiedPaymentEvidence) {
        try {
          depositReservation = await reserveConversationalAppointmentDepositEvidence({
            reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
            contactId: ctx.contactId,
            agentId: config.id || ctx.agentId || '',
            paymentId: ctx.verifiedPaymentEvidence.paymentId,
            appointmentRequestId: clientRequestId
          })
        } catch (error) {
          settleAction(action, 'error', { error: error.message, transferRequired: true })
          return {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            error: 'La reserva segura del anticipo cambió antes de crear la cita. No se agendó nada; pasa la conversación a una persona.'
          }
        }
      }

      let toolResult
      try {
        const result = await invokeController(createAppointment, {
          body: {
            calendarId,
            contactId: ctx.contactId,
            title: finalTitle,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            notes: participant.notes,
            participants: participants.all,
            clientRequestId,
            strictAvailabilityCheck: true,
            source: 'conversational_agent_v2',
            ignoreAppointmentConflicts: overlapsAllowed,
            ...(depositReservation?.reserved
              ? {
                  depositReservationEventId: depositReservation.eventId,
                  depositReservationClaimToken: depositReservation.claimToken,
                  depositReservationAgentId: config.id || ctx.agentId || ''
                }
              : {})
          }
        })
        toolResult = toToolResult(result, (data) => ({
          id: data?.id,
          calendarId: data?.calendarId || data?.calendar_id,
          title: data?.title,
          startTime: data?.startTime || data?.start_time,
          endTime: data?.endTime || data?.end_time,
          status: data?.appointmentStatus || data?.appointment_status || data?.status,
          idempotencyReplay: data?.idempotencyReplay || null
        }))
        if (result.statusCode >= 400 || !toolResult.ok || !toolResult.data?.id) {
          await releaseDepositReservationAfterDefinitiveFailure(`appointment_controller_${result.statusCode || 'failed'}`)
          const errorResult = {
            ok: false,
            actionCompleted: false,
            transferRequired: result.statusCode >= 500,
            statusCode: result.statusCode,
            error: `No se pudo agendar la cita y no debes afirmar que quedó confirmada.${toolResult.error ? ` ${toolResult.error}` : ''}`
          }
          settleAction(action, 'error', {
            statusCode: result.statusCode,
            error: errorResult.error,
            transferRequired: errorResult.transferRequired
          })
          return errorResult
        }
        if (toolResult.data?.idempotencyReplay?.canonicalChanged) {
          const replayState = toolResult.data.idempotencyReplay.state
          if (replayState === 'appointment_rescheduled' && toolResult.data.id) {
            let completionSyncWarning = false
            try {
              if (depositReservation?.reserved && ctx.verifiedPaymentEvidence) {
                await consumeConversationalAppointmentDepositEvidence({
                  reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
                  contactId: ctx.contactId,
                  agentId: config.id || ctx.agentId || '',
                  paymentId: ctx.verifiedPaymentEvidence.paymentId,
                  appointmentRequestId: clientRequestId,
                  appointmentId: toolResult.data.id
                })
              }
              await syncNativeAppointmentCompletion({
                ctx,
                config,
                appointment: {
                  id: toolResult.data.id,
                  calendarId: toolResult.data.calendarId,
                  title: toolResult.data.title || finalTitle,
                  startTime: toolResult.data.startTime,
                  endTime: toolResult.data.endTime,
                  status: toolResult.data.status
                },
                calendarId: toolResult.data.calendarId
              })
            } catch (error) {
              completionSyncWarning = true
              logger.error(`[Agente conversacional] La cita reprogramada ${toolResult.data.id} existe, pero falló su cierre durable: ${error.message}`)
            }
            settleAction(action, 'ok', {
              appointmentCreated: false,
              appointmentRescheduled: true,
              verifiedExistingAction: true,
              objectiveCompleted: !completionSyncWarning,
              completionSyncWarning,
              canonicalAppointment: {
                calendarId: toolResult.data.calendarId || null,
                startTime: toolResult.data.startTime || null,
                endTime: toolResult.data.endTime || null,
                status: toolResult.data.status || null
              }
            })
            return {
              ok: true,
              actionCompleted: true,
              alreadyBooked: true,
              appointmentRescheduled: true,
              appointment: {
                title: toolResult.data.title || finalTitle,
                startTime: toolResult.data.startTime || null,
                endTime: toolResult.data.endTime || null,
                status: toolResult.data.status || null
              },
              note: 'La cita ya existía y fue reprogramada; confirma únicamente estos datos canónicos y no reserves el horario anterior.'
            }
          }
          if (depositReservation?.reserved && ctx.verifiedPaymentEvidence) {
            await releaseConversationalAppointmentDepositEvidence({
              reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
              contactId: ctx.contactId,
              agentId: config.id || ctx.agentId || '',
              paymentId: ctx.verifiedPaymentEvidence.paymentId,
              appointmentRequestId: clientRequestId,
              reason: replayState
            }).catch((error) => {
              logger.warn(`[Agente conversacional] No se pudo liberar el anticipo de una cita inactiva: ${error.message}`)
            })
          }
          const replayError = replayState === 'appointment_rescheduled'
            ? 'La cita vinculada a este intento ya fue reprogramada. No se reservó otra vez el horario anterior; usa únicamente la fecha y hora vigentes que aparecen en existingAppointment.'
            : 'La cita vinculada a este intento ya no está activa. No se creó una cita nueva; ofrece volver a consultar horarios o pasa la conversación a una persona.'
          settleAction(action, 'error', {
            appointmentCreated: false,
            appointmentRescheduled: replayState === 'appointment_rescheduled',
            canonicalAppointment: {
              calendarId: toolResult.data.calendarId || null,
              startTime: toolResult.data.startTime || null,
              endTime: toolResult.data.endTime || null,
              status: toolResult.data.status || null
            },
            error: replayError
          })
          return {
            ok: false,
            actionCompleted: false,
            alreadyBooked: true,
            appointmentRescheduled: replayState === 'appointment_rescheduled',
            existingAppointment: {
              title: toolResult.data.title || finalTitle,
              startTime: toolResult.data.startTime || null,
              endTime: toolResult.data.endTime || null,
              status: toolResult.data.status || null
            },
            error: replayError
          }
        }
      } catch (error) {
        logger.error(`[Agente conversacional] Falló la creación real de la cita: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo crear la cita. No se agendó nada y no debes afirmar lo contrario; pasa la conversación a una persona.'
        }
        settleAction(action, 'error', {
          error: errorResult.error,
          transferRequired: true
        })
        return errorResult
      }

      let completionSyncWarning = false
      if (toolResult.ok) {
        try {
          if (depositReservation?.reserved && ctx.verifiedPaymentEvidence) {
            await consumeConversationalAppointmentDepositEvidence({
              reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
              contactId: ctx.contactId,
              agentId: config.id || ctx.agentId || '',
              paymentId: ctx.verifiedPaymentEvidence.paymentId,
              appointmentRequestId: clientRequestId,
              appointmentId: toolResult.data.id
            })
          }
          await syncNativeAppointmentCompletion({
            ctx,
            config,
            appointment: {
              id: toolResult.data.id,
              calendarId,
              title: toolResult.data.title || finalTitle,
              startTime: toolResult.data.startTime || start.toISOString(),
              endTime: toolResult.data.endTime || end.toISOString(),
              status: toolResult.data.status || 'confirmed'
            },
            calendarId
          })
        } catch (error) {
          completionSyncWarning = true
          logger.error(`[Agente conversacional] La cita ${toolResult.data?.id} sí se creó, pero falló la sincronización durable del cierre: ${error.message}`)
        }
      }
      settleAction(action, 'ok', {
        appointmentId: toolResult.data?.id || null,
        calendarId,
        startTime: start.toISOString(),
        appointmentCreated: true,
        objectiveCompleted: !completionSyncWarning,
        completionSyncWarning
      })
      return {
        ok: true,
        actionCompleted: true,
        appointment: {
          title: toolResult.data?.title || finalTitle,
          startTime: toolResult.data?.startTime || start.toISOString(),
          endTime: toolResult.data?.endTime || end.toISOString(),
          status: toolResult.data?.status || 'confirmed'
        },
        ...(completionSyncWarning
          ? { completionSyncWarning: true, note: 'La cita sí fue creada. No la repitas; el cierre interno necesita revisión humana.' }
          : {})
      }
    }
  })

  const requestHumanBookingTool = tool({
    name: 'request_human_booking',
    description: 'Revalida el horario y entrega el hilo al equipo sin crear una cita. Sólo se usa cuando el cliente confirma en otro turno la última oferta estructurada creada por offer_appointment_slot. Querer agendar, querer ir o proponer una fecha/hora no autoriza transferir ese slot en el mismo turno. No recibe horarios: el servidor recupera el único slot ofrecido y comprueba la oferta, el orden de turnos y la disponibilidad.',
    parameters: z.object({
      title: z.string().nullable().describe('Motivo corto de la cita; null usa un título seguro'),
      notes: z.string().nullable().describe('Resumen factual para la persona que terminará de agendar'),
      attendeeName: z.string().nullable().describe('Nombre de quien asistirá sólo si es distinto del contacto del hilo; null si es quien escribe'),
      attendeeContext: z.string().nullable().describe('Compatibilidad: relación o contexto del asistente distinto; null si primaryAttendee ya contiene el dato'),
      primaryAttendee: z.preprocess(
        (value) => value ?? null,
        appointmentPersonSchema.nullable()
      ).describe('Titular real de la cita cuando es distinto de quien escribe; null usa el contacto del hilo'),
      guests: z.preprocess(
        (value) => value ?? null,
        z.array(appointmentPersonSchema).nullable()
      ).describe('Invitados adicionales confirmados; null o [] si no hay')
    }),
    execute: async ({ title, notes, attendeeName, attendeeContext, primaryAttendee, guests }) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const nativeCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
      const calendarId = nativeCalendar?.id || null
      if (!calendarId) {
        return { ok: false, actionCompleted: false, error: 'El calendario blindado ya no existe o está apagado. No se entregó una solicitud de cita.' }
      }

      const businessTimezone = await getAccountTimezone()
      let confirmationEvidence = await resolveNativeAppointmentSelection({
        ctx,
        config,
        calendarId,
        timezone: businessTimezone
      })
      if (!confirmationEvidence.ok) return confirmationEvidence
      const startTime = String(confirmationEvidence.selectedStartTime || '').trim()
      const start = new Date(startTime)
      if (Number.isNaN(start.getTime())) {
        return { ok: false, actionCompleted: false, error: 'La oferta guardada no conserva un horario válido. No se entregó ninguna solicitud.' }
      }
      const threadContact = await getThreadContact(ctx)
      if (!threadContact) return missingThreadContactResult(ctx)
      const participantEvidenceMessages = await resolveAppointmentParticipantEvidenceMessages({
        ctx,
        primaryAttendee,
        guests
      })
      const participants = buildAppointmentParticipants({
        contact: threadContact,
        primaryAttendee,
        guests,
        attendeeName,
        attendeeContext,
        requirements: dataRequirements,
        conversationMessages: participantEvidenceMessages
      })
      if (!participants.ok) return { ok: false, actionCompleted: false, error: participants.error }
      const requiredDataError = await enforceRequiredContactData({
        ctx,
        scope: 'appointment',
        dataRequirements,
        contact: threadContact,
        facts: appointmentRequirementFacts({
          contact: threadContact,
          primaryAttendee,
          attendeeName,
          attendeeContext,
          guests
        })
      })
      if (requiredDataError) return requiredDataError
      const participant = buildAppointmentParticipant({
        contact: threadContact,
        title,
        notes,
        attendeeName,
        attendeeContext,
        primaryAttendee
      })

      const durationMinutes = Number(nativeCalendar.slot_duration) > 0 ? Number(nativeCalendar.slot_duration) : 60
      const startMs = start.getTime()
      const slotWindowStart = normalizeDateOnlyInTimezone(
        new Date(startMs - 24 * 60 * 60 * 1000).toISOString(),
        businessTimezone
      )
      const slotWindowEnd = normalizeDateOnlyInTimezone(
        new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
        businessTimezone
      )
      const slotValidation = await revalidateAppointmentSlot({
        calendarId,
        requestedStartTime: start.toISOString(),
        windowStart: slotWindowStart,
        windowEnd: slotWindowEnd,
        lookupSlots: getLocalFreeSlots,
        ignoreAppointmentConflicts: scheduleCapability?.allowOverlaps === true
      })
      if (!slotValidation.ok) return slotValidation
      start.setTime(new Date(slotValidation.matchedStartTime).getTime())
      if (!confirmationEvidence.reusedForPaymentResume) {
        confirmationEvidence = await persistNativeAppointmentSelection({
          ctx,
          config,
          calendarId,
          startTime: start.toISOString(),
          evidence: confirmationEvidence
        })
        if (!confirmationEvidence.ok && confirmationEvidence.actionCompleted === false) return confirmationEvidence
      }
      const end = new Date(start.getTime() + durationMinutes * 60000)

      const action = pushAction(ctx, 'request_human_booking', {
        calendarId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        title: participant.title,
        attendeeName: participant.attendeeName,
        participants: participants.all,
        confirmationEvidence,
        effect: {
          liveEffect: 'ENTREGARÍA el horario elegido al equipo sin crear una cita',
          marksObjectiveCompleted: false
        }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          appointmentCreated: false,
          wouldTransferToHuman: true,
          wouldNotifyHuman: true,
          objectiveCompleted: false
        })
        return {
          ok: true,
          simulated: true,
          appointmentCreated: false,
          wouldTransferToHuman: true,
          wouldNotifyHuman: true,
          requestedSlot: {
            title: participant.title,
            startTime: start.toISOString(),
            endTime: end.toISOString()
          },
          note: 'Simulación: el horario está disponible. En vivo se entregaría al equipo, pero no se crearía ni confirmaría una cita.'
        }
      }

      const executionId = String(ctx.executionId || '').trim()
      if (!executionId) {
        const error = 'No se pudo identificar el mensaje que eligió el horario. No se entregó ni creó una cita.'
        settleAction(action, 'error', { transferRequired: true, error })
        return { ok: false, actionCompleted: false, transferRequired: true, error }
      }

      const agentId = String(config.id || ctx.agentId || '').trim()
      const requestDigest = createHash('sha256')
        .update([agentId, ctx.contactId, calendarId, start.toISOString(), executionId].join('\u0000'))
        .digest('hex')
        .slice(0, 48)
      const evidenceEventId = `cae_human_booking_${requestDigest}`
      const assignmentCapability = {
        userId: scheduleCapability?.handoffUserId || '',
        userName: scheduleCapability?.handoffUserName || ''
      }

      let assignment = { assigned: false, alreadyAssigned: false, userName: null }
      let evidenceInserted = true
      try {
        const committed = await commitNativeHandoff({
          ctx,
          config,
          capability: assignmentCapability,
          signal: 'ready_for_human',
          signalOptions: {
            reason: 'La persona eligió un horario y el equipo debe terminar de agendar',
            summary: `${participant.title}: ${start.toISOString()}`,
            status: 'human'
          },
          assignmentEventSource: 'human_booking_requested',
          evidenceEvent: {
            eventId: evidenceEventId,
            eventType: 'human_booking_requested',
            detail: {
              bookingOwner: 'human',
              calendarId,
              startTime: start.toISOString(),
              endTime: end.toISOString(),
              title: participant.title,
              notes: participant.notes,
              attendeeName: participant.attendeeName,
              attendeeContext: participant.attendeeContext,
              participants: participants.all,
              appointmentCreated: false,
              objectiveCompleted: false,
              sourceMessageId: executionId
            }
          }
        })
        assignment = committed.assignment
        evidenceInserted = committed.evidenceInserted !== false
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo entregar la solicitud humana de cita: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          ...(error?.code ? { code: error.code } : {}),
          error: error?.code
            ? error.message
            : 'No se pudo guardar y transferir la solicitud de cita. No afirmes que el equipo la recibió ni que la cita quedó confirmada.'
        }
        settleAction(action, 'error', { transferRequired: true, error: errorResult.error })
        return errorResult
      }

      let notificationWarning = false
      if (evidenceInserted) {
        try {
          await notifyHumanPriority(ctx, {
            reason: 'Horario elegido pendiente de confirmación humana',
            summary: `${participant.title}: ${start.toISOString()}`,
            signal: 'ready_for_human'
          })
        } catch (error) {
          notificationWarning = true
          logger.warn(`[Agente conversacional] La solicitud humana quedó guardada, pero falló la notificación: ${error.message}`)
        }
      }

      settleAction(action, 'ok', {
        transferredToHuman: true,
        appointmentCreated: false,
        objectiveCompleted: false,
        evidenceEventId,
        replayed: !evidenceInserted,
        ...(assignment.assigned
          ? {
              assignedUserId: assignment.assignedUserId,
              assignedUserName: assignment.userName,
              assignmentReused: assignment.alreadyAssigned
            }
          : {}),
        ...(notificationWarning ? { warnings: ['priority_notification'] } : {})
      })
      return {
        ok: true,
        actionCompleted: true,
        transferredToHuman: true,
        appointmentCreated: false,
        requestedSlot: {
          title: participant.title,
          startTime: start.toISOString(),
          endTime: end.toISOString()
        },
        ...(assignment.assigned ? { assignedUserName: assignment.userName } : {}),
        note: 'El horario seguía disponible y la solicitud quedó en manos del equipo. La cita todavía no está creada ni confirmada; dilo claramente.'
      }
    }
  })

  const markReadyTool = tool({
    name: 'mark_ready_to_advance',
    description: `Marca como cumplido el objetivo propio configurado: ${customCapability?.description || 'objetivo personalizado'}. Registra el resultado y entrega el seguimiento al equipo.`,
    parameters: z.object({
      intencionDetectada: z.string().describe('Qué condición concreta del objetivo propio ya se cumplió'),
      resumen: z.string().describe('Resumen breve y factual del resultado'),
      urgencia: z.enum(['baja', 'media', 'alta']).nullable().describe('Urgencia para el seguimiento humano; null usa media'),
      siguientePaso: z.string().nullable().describe('Siguiente paso recomendado para el equipo')
    }),
    execute: async ({ intencionDetectada, resumen, urgencia, siguientePaso }) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const requiredDataError = await enforceRequiredContactData({ ctx, scope: 'handoff', dataRequirements })
      if (requiredDataError) return requiredDataError
      const resolvedUrgency = urgencia || 'media'
      const signal = 'ready_for_human'
      const action = pushAction(ctx, 'mark_ready_to_advance', {
        signal,
        intencionDetectada,
        urgencia: resolvedUrgency,
        effect: { liveEffect: 'MARCARÍA el objetivo como CUMPLIDO y pasaría el chat a un humano (el bot deja de responder)', marksObjectiveCompleted: true }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          signal,
          wouldMarkObjectiveCompleted: true,
          wouldNotifyHuman: true,
          ...(handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {})
        })
        return {
          ok: true,
          simulated: true,
          signal,
          wouldMarkObjectiveCompleted: true,
          wouldNotifyHuman: true,
          ...(handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {})
        }
      }

      let assignment = { assigned: false, alreadyAssigned: false, userName: null }
      try {
        const committedHandoff = await commitNativeHandoff({
          ctx,
          config,
          capability: handoffCapability,
          signal,
          signalOptions: {
            reason: `${intencionDetectada} (urgencia ${resolvedUrgency})`,
            summary: resumen,
            actionSummarySource: resumen,
            originalSummary: resumen,
            status: 'completed'
          },
          assignmentEventSource: 'custom_goal_completed'
        })
        assignment = committedHandoff.assignment
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo registrar el objetivo cumplido: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          ...(error?.code ? { code: error.code } : {}),
          error: error?.code
            ? error.message
            : 'No se pudo registrar el objetivo como cumplido. No afirmes que se transfirió ni que terminó; requiere revisión humana.'
        }
        settleAction(action, 'error', { error: errorResult.error, transferRequired: true })
        return errorResult
      }

      const postCommitWarnings = []
      const runPostCommitStep = async (label, callback) => {
        try {
          await callback()
        } catch (error) {
          postCommitWarnings.push(label)
          logger.warn(`[Agente conversacional] Objetivo ${signal} sí quedó registrado, pero falló ${label}: ${error.message}`)
        }
      }
      await runPostCommitStep('priority_notification', () => notifyHumanPriority(ctx, {
        reason: intencionDetectada,
        summary: resumen,
        signal
      }))
      await runPostCommitStep('objective_event', () => recordConversationalAgentEvent({
        contactId: ctx.contactId,
        eventType: 'objective_completed',
        detail: {
          agentId: config.id || ctx.agentId || null,
          signal,
          kind: 'ready_for_human',
          intencionDetectada,
          urgencia: resolvedUrgency,
          siguientePaso: siguientePaso || null
        }
      }))
      settleAction(action, 'ok', {
        signal,
        objectiveCompleted: true,
        ...(assignment.assigned
          ? {
              assignedUserId: assignment.assignedUserId,
              assignedUserName: assignment.userName,
              assignmentReused: assignment.alreadyAssigned
            }
          : {}),
        ...(postCommitWarnings.length ? { warnings: postCommitWarnings } : {})
      })
      return {
        ok: true,
        actionCompleted: true,
        signal,
        ...(assignment.assigned ? { assignedUserName: assignment.userName } : {}),
        ...(postCommitWarnings.length ? { postCommitWarning: true } : {}),
        note: 'Objetivo registrado y entregado al equipo. Responde siempre con un cierre breve, visible y natural.'
      }
    }
  })
  const createPaymentLinkTool = tool({
    name: 'create_payment_link',
    description: 'Crea el link del producto/precio blindado en la capacidad de cobro. El servidor decide concepto, monto y moneda desde la base; la herramienta nunca confirma el pago.',
    parameters: z.object({
      quantity: z.number().int().min(1).max(100).nullable().describe('Cantidad entre 1 y 100; null equivale a 1'),
      agreedAmount: z.number().positive().nullable().describe('Monto acordado dentro del rango del anticipo; null cuando el precio es fijo')
    }),
    execute: async ({ quantity, agreedAmount }) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence

      // El link es el mecanismo para cobrar el pago completo o el anticipo. No exigimos
      // un comprobante previo para crearlo; sí amarramos el cobro al workflow/catálogo.
      const accountCurrency = String(
        ctx.accountLocale?.currency || await getAccountCurrency().catch(() => '')
      ).trim().toUpperCase()
      const paymentValidation = await resolveNativePaymentAuthority({
        capability: paymentCapability,
        quantity: quantity || 1,
        agreedAmount,
        accountCurrency
      })
      if (!paymentValidation.ok) return paymentValidation
      const trustedPayment = paymentValidation.trusted
      const deliveryChannel = String(ctx.channel || '').toLowerCase()
      let appointmentSelection = null
      let appointmentDepositIntent = null
      let appointmentDepositClaim = null
      const paymentIdempotencyKey = buildConversationalPaymentLinkIdempotencyKey({
        agentId: config.id || ctx.agentId || '',
        contactId: ctx.contactId || '',
        productId: trustedPayment.productId || '',
        priceId: trustedPayment.priceId || '',
        amount: trustedPayment.amount,
        currency: trustedPayment.currency,
        channel: deliveryChannel,
        paymentPurpose: nativePaymentPurpose,
        executionId: ctx.executionId
      })
      if (!ctx.dryRun && !paymentIdempotencyKey) {
        return {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          code: 'payment_execution_id_missing',
          error: 'No se pudo identificar de forma segura el mensaje que autorizó este cobro. No se creó ningún link; pasa la conversación a una persona.'
        }
      }
      const paymentSourceEventId = paymentIdempotencyKey
        ? `cae_payment_${createHash('sha256').update(paymentIdempotencyKey).digest('hex').slice(0, 48)}`
        : ''

      const contact = await getPaymentContact(ctx)
      if (!contact) return { ok: false, actionCompleted: false, error: 'Contacto no encontrado. No se creó ni envió ningún link.' }
      const requiredDataError = await enforceRequiredContactData({
        ctx,
        scope: 'payment',
        dataRequirements,
        contact,
        facts: paymentRequirementFacts(paymentCapability)
      })
      if (requiredDataError) return requiredDataError
      if (!ctx.dryRun && nativePaymentPurpose === 'appointment_deposit') {
        const resolvedIntent = await resolveNativeAppointmentDepositIntentForLink({
          ctx,
          config,
          scheduleCapability,
          claimKey: paymentSourceEventId
        })
        if (!resolvedIntent.ok) return resolvedIntent
        appointmentDepositIntent = resolvedIntent.intent
        appointmentSelection = resolvedIntent.selection
        appointmentDepositClaim = await claimNativeAppointmentDepositIntent({
          intent: appointmentDepositIntent,
          selection: appointmentSelection,
          method: 'paymentLink',
          claimKey: paymentSourceEventId
        })
        if (!appointmentDepositClaim.ok) {
          return appointmentSelectionError(
            'Otro cobro o comprobante ya tomó este intento de anticipo. No se creó otro link.',
            'appointment_deposit_intent_claimed'
          )
        }
        appointmentDepositIntent = appointmentDepositClaim.intent
      }

      const action = pushAction(ctx, 'create_payment_link', {
        amount: trustedPayment.amount,
        unitAmount: trustedPayment.unitAmount || trustedPayment.amount,
        quantity: trustedPayment.quantity || 1,
        currency: trustedPayment.currency,
        concept: trustedPayment.concept,
        catalogEvidence: {
          source: trustedPayment.source,
          productId: trustedPayment.productId,
          priceId: trustedPayment.priceId
        },
        channel: deliveryChannel,
        ...(appointmentSelection
          ? {
              appointmentSelectionEventId: appointmentSelection.id,
              appointmentSelectionCalendarId: appointmentSelection.detail.calendarId,
              appointmentSelectionStartTime: appointmentSelection.detail.startTime,
              appointmentSelectionVerifiedAt: appointmentSelection.detail.verifiedAt,
              appointmentDepositIntentEventId: appointmentDepositIntent?.id || null
            }
          : {}),
        effect: { liveEffect: 'ENVIARÍA un link de pago real (la venta sigue PENDIENTE hasta que se pague)', marksObjectiveCompleted: false }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          amount: trustedPayment.amount,
          currency: trustedPayment.currency,
          channel: deliveryChannel,
          wouldCreateAndSendLink: true
        })
        return {
          ok: true,
          simulated: true,
          amount: trustedPayment.amount,
          currency: trustedPayment.currency,
          concept: trustedPayment.concept,
          channel: deliveryChannel,
          catalogEvidence: trustedPayment.source
        }
      }

      try {
        const result = await createConversationalAgentLivePaymentLink({
          contact,
          gateway: paymentCapability?.gateway || 'highlevel',
          amount: trustedPayment.amount,
          currency: trustedPayment.currency,
          concept: trustedPayment.concept,
          installments: paymentCapability?.installments,
          expirationMinutes: paymentCapability?.expirationMinutes,
          afterPayment: paymentCapability?.afterPayment,
          channels: buildPaymentChannels(deliveryChannel),
          source: 'conversational_agent_v2',
          idempotencyKey: paymentIdempotencyKey,
          idempotencyPayload: {
            agentId: config.id || ctx.agentId || null,
            contactId: ctx.contactId,
            productId: trustedPayment.productId,
            priceId: trustedPayment.priceId,
            amount: trustedPayment.amount,
            currency: trustedPayment.currency,
            channel: deliveryChannel,
            paymentPurpose: nativePaymentPurpose,
            executionId: String(ctx.executionId || '').trim(),
            appointmentSelectionEventId: appointmentSelection?.id || null,
            appointmentSelectionCalendarId: appointmentSelection?.detail?.calendarId || null,
            appointmentSelectionStartTime: appointmentSelection?.detail?.startTime || null,
            appointmentSelectionVerifiedAt: appointmentSelection?.detail?.verifiedAt || null,
            appointmentDepositIntentEventId: appointmentDepositIntent?.id || null,
            appointmentDepositIntentClaimKey: paymentSourceEventId || null,
            appointmentDepositIntentClaimToken: appointmentDepositClaim?.claimToken || null
          }
        })

        const resultCurrency = String(result?.currency || '').trim().toUpperCase()
        const resultAmount = Number(result?.amount)
        const paymentLedger = result?.ledgerPaymentId
          ? await db.get(
              `SELECT id, contact_id, amount, currency, status, payment_mode, payment_provider,
                      ghl_invoice_id, public_payment_id, payment_link_request_key
               FROM payments
               WHERE contact_id = ? AND id = ? AND payment_link_request_key = ?
               LIMIT 1`,
              [ctx.contactId, result.ledgerPaymentId, paymentIdempotencyKey]
            ).catch(() => null)
          : null
        const ledgerCurrency = String(paymentLedger?.currency || '').trim().toUpperCase()
        const ledgerAmount = Number(paymentLedger?.amount)
        const ledgerEnvironment = String(paymentLedger?.payment_mode || '').trim().toLowerCase()
        const ledgerProvider = String(paymentLedger?.payment_provider || '').trim().toLowerCase()
        const expectedProvider = String(paymentCapability?.gateway || 'highlevel').trim().toLowerCase()
        const externalIdentityMatches = expectedProvider === 'highlevel'
          ? String(paymentLedger?.ghl_invoice_id || '').trim() === String(result?.invoiceId || '').trim()
          : String(paymentLedger?.public_payment_id || '').trim() === String(result?.publicPaymentId || '').trim()
        const ledgerCanonicalMatch = Boolean(
          paymentLedger?.id &&
          Number.isFinite(ledgerAmount) &&
          Math.abs(ledgerAmount - trustedPayment.amount) < 0.005 &&
          ledgerCurrency === trustedPayment.currency &&
          ledgerEnvironment === 'live' &&
          ledgerProvider === expectedProvider &&
          externalIdentityMatches &&
          String(result?.provider || '').trim().toLowerCase() === expectedProvider &&
          String(result?.paymentMode || '').trim().toLowerCase() === 'live'
        )
        const sent = Boolean(result?.invoiceId && result?.paymentLink && result?.sendMethod !== 'none' && result?.status !== 'draft')
        const prepared = Boolean(result?.invoiceId && result?.paymentLink && paymentLedger?.id)
        const canonicalMatch = Math.abs(resultAmount - trustedPayment.amount) < 0.005 && resultCurrency === trustedPayment.currency
        if (!prepared || !canonicalMatch || !ledgerCanonicalMatch) {
          await recordConversationalAgentEvent({
            contactId: ctx.contactId,
            eventType: 'payment_link_failed',
            detail: {
              reason: !prepared
                ? 'link_not_prepared'
                : (!ledgerCanonicalMatch ? 'payment_ledger_mismatch' : 'canonical_payment_mismatch'),
              invoiceId: result?.invoiceId || null,
              expectedAmount: trustedPayment.amount,
              expectedCurrency: trustedPayment.currency,
              actualAmount: result?.amount || null,
              actualCurrency: result?.currency || null,
              ledgerAmount: Number.isFinite(ledgerAmount) ? ledgerAmount : null,
              ledgerCurrency: ledgerCurrency || null,
              ledgerEnvironment: ledgerEnvironment || null,
              ledgerProvider: ledgerProvider || null,
              expectedProvider
            }
          }).catch(() => undefined)
          const errorResult = {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            invoiceCreated: Boolean(result?.invoiceId),
            error: result?.invoiceId
              ? 'El cobro pudo crear un borrador, pero no hay evidencia de que el link correcto se haya enviado. No afirmes que se envió; pasa la conversación a una persona.'
              : 'No se pudo crear ni enviar el link de pago. No afirmes lo contrario; pasa la conversación a una persona.'
          }
          settleAction(action, 'error', {
            error: errorResult.error,
            invoiceId: result?.invoiceId || null,
            invoiceCreated: errorResult.invoiceCreated,
            deliveryConfirmed: false,
            canonicalMatch,
            ledgerCanonicalMatch,
            transferRequired: true
          })
          return errorResult
        }

        try {
          const sourceEventType = result.reused ? 'payment_link_reused' : 'payment_link_created'
          const sourceDetail = {
            agentId: config.id || ctx.agentId || null,
            invoiceId: result.invoiceId,
            amount: result.amount,
            currency: result.currency,
            channel: deliveryChannel,
            paymentMode: paymentCapability?.paymentMode,
            runtimeMode: 'tool_calling_v2',
            ledgerPaymentId: paymentLedger.id,
            paymentEnvironment: ledgerEnvironment,
            paymentProvider: ledgerProvider,
            publicPaymentId: result.publicPaymentId || null,
            productId: trustedPayment.productId || null,
            priceId: trustedPayment.priceId || null,
            paymentPurpose: nativePaymentPurpose,
            appointmentDeposit: nativePaymentPurpose === 'appointment_deposit',
            appointmentSelectionEventId: appointmentSelection?.id || null,
            appointmentSelectionCalendarId: appointmentSelection?.detail?.calendarId || null,
            appointmentSelectionStartTime: appointmentSelection?.detail?.startTime || null,
            appointmentSelectionVerifiedAt: appointmentSelection?.detail?.verifiedAt || null,
            appointmentDepositIntentEventId: appointmentDepositIntent?.id || null,
            appointmentDepositIntentClaimKey: paymentSourceEventId || null,
            appointmentDepositIntentClaimToken: appointmentDepositClaim?.claimToken || null,
            executionId: String(ctx.executionId || '').trim(),
            status: result.status,
            expiresAt: result.expiresAt || null,
            expirationMinutes: result.expirationMinutes || null,
            installments: result.installments || null,
            afterPayment: result.afterPayment || paymentCapability?.afterPayment || 'continue',
            ...(result.reused ? { reused: true } : {})
          }
          await bindConversationalPaymentSourceEvent({
            eventId: paymentSourceEventId,
            contactId: ctx.contactId,
            eventType: sourceEventType,
            detail: sourceDetail
          })
          if (appointmentDepositIntent) {
            const intentBound = await markNativeAppointmentDepositIntentBound({
              intent: appointmentDepositIntent,
              selection: appointmentSelection,
              sourceEventId: paymentSourceEventId,
              method: 'paymentLink',
              claimToken: appointmentDepositClaim?.claimToken
            })
            if (!intentBound) throw new Error('El intento de anticipo cambió mientras se preparaba el link')
          }
          const alreadyPaid = ['paid', 'succeeded', 'completed', 'success'].includes(
            String(paymentLedger.status || '').trim().toLowerCase()
          ) && ledgerEnvironment === 'live'
          if (alreadyPaid) {
            const completion = await completeConversationalAgentSalePaymentFromInvoice({
              contactId: ctx.contactId,
              invoiceId: result.invoiceId,
              paymentId: paymentLedger.id,
              amount: paymentLedger.amount,
              currency: paymentLedger.currency,
              status: paymentLedger.status,
              paymentMode: paymentLedger.payment_mode
            })
            if (!completion?.matched) {
              await db.run(
                `UPDATE conversational_payment_link_requests
                 SET binding_status = 'pending', binding_error = ?, updated_at = ?
                 WHERE idempotency_key = ? AND binding_status = 'bound'`,
                ['El pago ya estaba confirmado pero su reconciliación quedó pendiente.', new Date().toISOString(), paymentIdempotencyKey]
              ).catch(() => {})
              throw new Error('El pago ya estaba confirmado, pero no se pudo reconciliar con el agente')
            }
          }
        } catch (error) {
          const bindingError = 'El link quedó preparado, pero no se pudo guardar su vínculo seguro con este cobro. No generes otro: vuelve a intentar esta misma acción para reparar el registro o pasa la conversación a una persona.'
          settleAction(action, 'error', {
            error: bindingError,
            linkAvailable: true,
            deliveryConfirmed: sent,
            retryUsesSameLink: true,
            transferRequired: true
          })
          return {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            retryUsesSameLink: true,
            error: bindingError
          }
        }
        settleAction(action, 'ok', {
          invoiceId: result.invoiceId,
          paymentLink: result.paymentLink,
          provider: result.provider,
          publicPaymentId: result.publicPaymentId || null,
          expiresAt: result.expiresAt || null,
          amount: result.amount,
          currency: result.currency,
          sendMethod: result.sendMethod,
          linkAvailable: true,
          deliveryConfirmed: sent && !result.reused,
          priorEquivalentLinkFound: Boolean(result.reused),
          reused: Boolean(result.reused),
          objectiveCompleted: false
        })
        return {
          ok: true,
          actionCompleted: true,
          paymentLink: result.paymentLink,
          sendMethod: result.sendMethod,
          provider: result.provider,
          expiresAt: result.expiresAt || null,
          amount: result.amount,
          currency: result.currency,
          status: 'pending',
          providerStatus: result.status,
          paymentConfirmed: false,
          objectiveCompleted: false,
          // (AI-004) Evita que el modelo reenvíe/duplique: avísale que ya había un link equivalente.
          note: result.reused
            ? 'Ya existía un link de pago equivalente reciente para este contacto; se reutilizó en lugar de crear otro. Confirma a la persona con ese mismo link; no generes uno nuevo.'
            : 'Link preparado. El pago sigue pendiente: sólo una confirmación real del proveedor puede marcarlo como pagado.'
        }
      } catch (error) {
        logger.error(`[Agente conversacional] Falló la creación durable del link de pago: ${error.message}`)
        await recordConversationalAgentEvent({
          contactId: ctx.contactId,
          eventType: 'payment_link_failed',
          detail: {
            error: error.message,
            amount: trustedPayment.amount,
            currency: trustedPayment.currency,
            concept: trustedPayment.concept
          }
        }).catch(() => undefined)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo crear ni enviar el link de pago. No afirmes que se envió; pasa la conversación a una persona.'
        }
        settleAction(action, 'error', {
          error: errorResult.error,
          deliveryConfirmed: false,
          transferRequired: true
        })
        return errorResult
      }
    }
  })

  const sendGoalUrlTool = tool({
    name: 'send_goal_url',
    description: 'Prepara el enlace blindado de la capacidad send_link. Nunca agrega contact_id ni marca la meta como cumplida por un clic no autenticado.',
    parameters: z.object({
      intencionDetectada: z.string().nullable().describe('Qué quiere lograr la persona; null si no hace falta contexto extra'),
      resumen: z.string().nullable().describe('Resumen breve para auditoría; null si no hace falta contexto extra')
    }),
    execute: async ({ intencionDetectada, resumen }) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const requiredDataError = await enforceRequiredContactData({ ctx, scope: 'link', dataRequirements })
      if (requiredDataError) return requiredDataError
      intencionDetectada = intencionDetectada || 'Solicitó el enlace'
      resumen = resumen || ''

      let goalConfig = {
        url: linkCapability?.url || '',
        trackingParam: linkCapability?.trackingParam || DEFAULT_GOAL_TRACKING_PARAM
      }
      const nativeExecutionId = String(ctx.executionId || '').trim()
      if (!ctx.dryRun && !nativeExecutionId) {
        return {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          code: 'goal_link_execution_id_missing',
          error: 'No se pudo identificar de forma segura el mensaje que pidió este enlace. No se preparó nada; pasa la conversación a una persona.'
        }
      }

      if (linkCapability?.linkKind === 'trigger') {
        let triggerLink = null
        if (linkCapability.triggerLinkId) {
          triggerLink = await getTriggerLink(linkCapability.triggerLinkId)
          if (!triggerLink || triggerLink.archived || !triggerLink.active) {
            return { ok: false, actionCompleted: false, transferRequired: true, error: 'El enlace configurado ya no existe o está apagado. No se envió nada; pasa la conversación a una persona.' }
          }
          goalConfig = { ...goalConfig, url: triggerLink.destinationUrl }
        }

        const targetUrl = String(goalConfig.url || '').trim()
        if (!isSafeHttpUrl(targetUrl)) {
          return { ok: false, actionCompleted: false, transferRequired: true, error: 'El destino configurado no es un enlace web seguro. No se envió nada; pasa la conversación a una persona.' }
        }
        const action = pushAction(ctx, 'send_goal_url', {
          objective: 'custom',
          intencionDetectada,
          targetUrl,
          triggerLinkId: triggerLink?.id || null,
          effect: { liveEffect: 'ENVIARÍA el destino configurado sin identidad en la URL y sin completar la meta', marksObjectiveCompleted: false }
        })
        if (!ctx.dryRun) {
          await recordConversationalAgentEvent({
            contactId: ctx.contactId,
            eventType: 'safe_link_sent',
            detail: {
              agentId: config.id || ctx.agentId || null,
              triggerLinkId: triggerLink?.id || null,
              intencionDetectada,
              resumen
            }
          }).catch(() => {})
        }
        settleAction(action, ctx.dryRun ? 'simulated' : 'ok', {
          actionCompleted: !ctx.dryRun,
          linkPrepared: true,
          sentUrl: targetUrl,
          deliveryConfirmed: false,
          objectiveCompleted: false,
          confirmationMode: 'none'
        })
        return {
          ok: true,
          actionCompleted: !ctx.dryRun,
          simulated: Boolean(ctx.dryRun),
          sentUrl: targetUrl,
          confirmationMode: 'none',
          objectiveCompleted: false,
          note: 'Manda sentUrl visible en el chat. Este envío no confirma ni completa ninguna meta.'
        }
      }

      const targetUrl = goalConfig.url || ''
      const trackingParam = goalConfig.trackingParam || DEFAULT_GOAL_TRACKING_PARAM
      if (!targetUrl || !isSafeHttpUrl(targetUrl)) {
        return { ok: false, error: 'No hay enlace configurado para este objetivo. Manda a humano con send_to_human y avisa que falta configurar el enlace.' }
      }
      const linkContext = { linkParams: {}, expected: { capabilityId: 'send_link' } }

      const action = pushAction(ctx, 'send_goal_url', {
        objective: 'custom', intencionDetectada, targetUrl,
        effect: { liveEffect: 'ENVIARÍA el enlace configurado (el objetivo sigue PENDIENTE hasta la confirmación con ID real)', marksObjectiveCompleted: false }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          linkPrepared: false,
          confirmationMode: 'trusted_integration',
          deliveryConfirmed: false,
          objectiveCompleted: false
        })
        return {
          ok: true,
          simulated: true,
          sentUrl: buildGoalLinkPreview(targetUrl, trackingParam, 'goal_simulado', linkContext.linkParams),
          trackingParam,
          linkParams: linkContext.linkParams,
          confirmationMode: 'trusted_integration',
          note: 'Vista previa solamente: en vivo se manda el enlace y la meta queda pendiente hasta que una integración autenticada confirme el resultado real.'
        }
      }

      let link
      try {
        link = await createConversationGoalLink({
          contactId: ctx.contactId,
          agentId: config.id || ctx.agentId || null,
          objective: 'custom',
          targetUrl,
          trackingParam,
          linkParams: linkContext.linkParams,
          idempotencyKey: `send_goal_url_v2:${createHash('sha256').update([
            ctx.contactId || '',
            config.id || ctx.agentId || '',
            targetUrl,
            String(ctx.channel || '').trim().toLowerCase(),
            nativeExecutionId
          ].join('\u0000')).digest('hex')}`,
          metadata: {
            expected: linkContext.expected,
            intencionDetectada,
            resumen,
            channel: String(ctx.channel || '').trim().toLowerCase(),
            executionId: nativeExecutionId
          }
        })
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo preparar el enlace del objetivo: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo preparar el enlace del objetivo. No afirmes que se envió; pasa la conversación a una persona.'
        }
        settleAction(action, 'error', {
          error: errorResult.error,
          linkPrepared: false,
          confirmationMode: 'trusted_integration',
          deliveryConfirmed: false,
          transferRequired: true
        })
        return errorResult
      }

      if (link.status === 'completed') {
        settleAction(action, 'ok', {
          goalId: link.id,
          linkPrepared: false,
          confirmationMode: 'trusted_integration',
          deliveryConfirmed: true,
          objectiveCompleted: true,
          idempotent: true
        })
        return {
          ok: true,
          actionCompleted: false,
          objectiveCompleted: true,
          alreadyCompleted: true,
          confirmationMode: 'trusted_integration',
          note: 'Esta misma meta ya fue confirmada. No vuelvas a mandar el enlace.'
        }
      }

      settleAction(action, 'ok', {
        goalId: link.id,
        sentUrl: link.sentUrl,
        linkPrepared: true,
        confirmationMode: 'trusted_integration',
        deliveryConfirmed: false,
        objectiveCompleted: false
      })

      return {
        ok: true,
        actionCompleted: true,
        sentUrl: link.sentUrl,
        trackingParam: link.trackingParam,
        linkParams: link.linkParams,
        confirmationMode: 'trusted_integration',
        idempotent: link.idempotent === true,
        note: 'Manda sentUrl visible en el chat. No digas que el objetivo ya quedó cumplido; sólo una integración autenticada puede confirmar el ID real.'
      }
    }
  })

  const sendToHumanTool = tool({
    name: 'send_to_human',
    description: `Entrega la conversación al equipo${handoffCapability?.userName ? `, asignándola a ${handoffCapability.userName}` : ''}. Úsala para las reglas configuradas${handoffCapability?.pastClientsToHuman ? ' y siempre que get_contact_profile confirme que es cliente previo' : ''}.`,
    parameters: z.object({
      motivo: z.string().describe('Por qué necesita humano'),
      resumen: z.string().describe('Resumen breve de la situación')
    }),
    execute: async ({ motivo, resumen }) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const requiredDataError = await enforceRequiredContactData({ ctx, scope: 'handoff', dataRequirements })
      if (requiredDataError) return requiredDataError
      const action = pushAction(ctx, 'send_to_human', {
        motivo,
        effect: { liveEffect: 'PASARÍA el chat a un humano (el bot deja de responder). NO marca el objetivo como cumplido.', marksObjectiveCompleted: false }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          signal: 'ready_for_human',
          wouldNotifyHuman: true,
          ...(handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {}),
          objectiveCompleted: false
        })
        return {
          ok: true,
          simulated: true,
          signal: 'ready_for_human',
          wouldNotifyHuman: true,
          wouldMarkObjectiveCompleted: false,
          ...(handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {})
        }
      }

      let assignment = { assigned: false, alreadyAssigned: false, userName: null }
      try {
        const committedHandoff = await commitNativeHandoff({
          ctx,
          config,
          capability: handoffCapability,
          signal: 'ready_for_human',
          signalOptions: {
            reason: motivo,
            summary: resumen,
            status: 'human'
          },
          assignmentEventSource: 'handoff_human'
        })
        assignment = committedHandoff.assignment
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo transferir la conversación: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          ...(error?.code ? { code: error.code } : {}),
          error: error?.code
            ? error.message
            : 'No se pudo registrar la transferencia. No afirmes que un humano ya tomó el chat; requiere revisión manual.'
        }
        settleAction(action, 'error', { error: errorResult.error, transferRequired: true })
        return errorResult
      }

      let notificationWarning = false
      try {
        await notifyHumanPriority(ctx, { reason: motivo, summary: resumen, signal: 'ready_for_human' })
      } catch (error) {
        notificationWarning = true
        logger.warn(`[Agente conversacional] El handoff sí quedó registrado, pero falló la notificación: ${error.message}`)
      }
      settleAction(action, 'ok', {
        signal: 'ready_for_human',
        transferredToHuman: true,
        ...(assignment.assigned
          ? {
              assignedUserId: assignment.assignedUserId,
              assignedUserName: assignment.userName,
              assignmentReused: assignment.alreadyAssigned
            }
          : {}),
        objectiveCompleted: false,
        ...(notificationWarning ? { warnings: ['priority_notification'] } : {})
      })
      return {
        ok: true,
        actionCompleted: true,
        signal: 'ready_for_human',
        ...(assignment.assigned ? { assignedUserName: assignment.userName } : {}),
        note: 'Un humano seguirá la conversación. Si hace falta, cierra con una frase breve y natural (ej. que en un momento le confirmas).'
      }
    }
  })

  const registerDepositProofTool = tool({
    name: 'register_deposit_payment_proof',
    description: 'Lee la foto o PDF de una transferencia y registra el comprobante como PENDIENTE DE REVISIÓN. Nunca confirma fondos ni marca el pago como pagado.',
    parameters: z.object({
      montoIndicado: z.number().nullable().describe('Monto que la persona dijo haber transferido, si lo mencionó (solo referencia; la validación usa el comprobante)'),
      referencia: z.string().nullable().describe('Referencia o folio si la persona lo compartió en texto')
    }),
    execute: async ({ montoIndicado, referencia }) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const requiredDataError = await enforceRequiredContactData({
        ctx,
        scope: 'payment',
        dataRequirements,
        facts: paymentRequirementFacts(paymentCapability)
      })
      if (requiredDataError) return requiredDataError
      const configuredDeposit = getDepositRequirementForRuntime(ctx, config)
      const methods = getDepositPaymentMethodsForRuntime(ctx, config)
      const receiptProofEnabled = paymentCapability?.receiptProof?.enabled === true
      let deposit = configuredDeposit
      let paymentLabel = configuredDeposit ? getDepositRequirementLabel(ctx, config) : 'pago'
      if (!deposit && receiptProofEnabled) {
        const accountCurrency = String(ctx.accountLocale?.currency || await getAccountCurrency().catch(() => '')).trim().toUpperCase()
        const authority = await resolveNativePaymentAuthority({
          capability: paymentCapability,
          quantity: 1,
          accountCurrency
        })
        if (!authority.ok) return authority
        deposit = {
          enabled: true,
          mode: 'fixed',
          amount: authority.trusted.amount,
          currency: authority.trusted.currency
        }
      }
      if (!deposit) {
        return { ok: false, actionCompleted: false, error: 'Este agente no tiene un cobro verificable configurado.' }
      }
      if (!methods.bankTransfer && !receiptProofEnabled) {
        return { ok: false, actionCompleted: false, error: 'La revisión de comprobantes no está habilitada para este cobro. Usa el enlace configurado o manda a humano.' }
      }
      const expectedLabel = formatDepositRequirement(deposit, ctx.accountLocale)
      let appointmentSelection = null
      let appointmentDepositIntent = null
      let appointmentDepositClaim = null
      let receiptIntentBindingEventId = null
      let receiptNeedsHumanReview = false
      let receiptStaleReasons = []
      let receiptPossibleDoublePayment = false

      const action = pushAction(ctx, 'register_deposit_payment_proof', {
        montoIndicado: Number(montoIndicado) || null,
        referencia: referencia || null,
        effect: { liveEffect: `LEERÍA el comprobante y lo registraría como pendiente de revisión; no confirma el ${paymentLabel}`, marksObjectiveCompleted: false }
      })

      if (ctx.dryRun) {
        settleAction(action, 'simulated', { actionCompleted: false, wouldRegisterPayment: false, wouldRegisterPendingReview: true })
        return {
          ok: true,
          simulated: true,
          wouldRegisterPayment: false,
          wouldRegisterPendingReview: true,
          paymentConfirmed: false,
          note: `Simulación: en vivo se leería el comprobante y, si coincide con ${expectedLabel}, quedaría pendiente de revisión humana; no se marcaría pagado.`
        }
      }

      const accountCurrency = String(ctx.accountLocale?.currency || await getAccountCurrency().catch(() => '')).trim().toUpperCase()

      // Idempotencia: si el anticipo ya quedó registrado (por esta tool o por el
      // equipo), no se duplica el pago.
      const existingEvidence = await findVerifiedPaymentEvidence({
        database: db,
        contactId: ctx.contactId,
        agentId: config.id || ctx.agentId || null,
        requiredPurpose: nativePaymentPurpose,
        reconciliationId: String(ctx.executionId || '').startsWith('payment-resume:')
          ? String(ctx.executionId).slice('payment-resume:'.length).trim()
          : ''
      })
      if (existingEvidence.ok) {
        settleAction(action, 'ok', { actionCompleted: true, alreadyRegistered: true, paymentId: existingEvidence.evidence.paymentId })
        const visibleEvidence = {
          amount: existingEvidence.evidence.amount,
          currency: existingEvidence.evidence.currency,
          status: existingEvidence.evidence.status,
          paidAt: existingEvidence.evidence.paidAt
        }
        return { ok: true, actionCompleted: true, alreadyRegistered: true, payment: visibleEvidence, paymentConfirmed: true, note: `El ${paymentLabel} ya estaba registrado; continúa con la acción de avance.` }
      }

      const receiptMedia = await findLatestInboundReceiptMedia(ctx.contactId)
      if (!receiptMedia) {
        settleAction(action, 'error', { error: 'no_receipt_media' })
        return { ok: false, actionCompleted: false, error: 'No encontré una foto o PDF reciente del comprobante en la conversación. Pide a la persona que mande la foto del comprobante y vuelve a intentar.' }
      }
      if (nativePaymentPurpose === 'appointment_deposit') {
        const resolvedIntent = await resolveAndBindNativeAppointmentDepositIntentForReceipt({
          ctx,
          config,
          scheduleCapability,
          receiptMessageId: receiptMedia.messageId,
          receiptReceivedAt: receiptMedia.receivedAt
        })
        if (!resolvedIntent.ok) {
          settleAction(action, 'error', { error: resolvedIntent.error, code: resolvedIntent.code })
          return resolvedIntent
        }
        appointmentDepositIntent = resolvedIntent.intent
        appointmentSelection = resolvedIntent.selection
        appointmentDepositClaim = resolvedIntent.claim
        receiptIntentBindingEventId = resolvedIntent.receiptIntentBindingEventId
        receiptNeedsHumanReview = resolvedIntent.needsHumanReview === true
        receiptStaleReasons = Array.isArray(resolvedIntent.staleReasons) ? resolvedIntent.staleReasons : []
        receiptPossibleDoublePayment = resolvedIntent.possibleDoublePayment === true
      }

      const apiKey = await getOpenAIApiKey().catch(() => null)
      const analyzeReceipt = nativePaymentReceiptAnalysisHookForTest || analyzePaymentReceiptImage
      let analysis
      try {
        analysis = await analyzeReceipt({
          mediaUrl: receiptMedia.mediaUrl,
          expectedCurrency: accountCurrency,
          apiKey
        })
      } catch (error) {
        analysis = { ok: false, reason: 'analysis_failed', technicalError: error.message }
      }
      const keepUncertainProofForManualReview = async (failureReason) => {
        try {
          const reviewCase = await recordNativePaymentProofManualReviewCase({
            ctx,
            config,
            receiptMedia,
            paymentPurpose: nativePaymentPurpose,
            expectedRequirement: deposit,
            failureReason,
            analysis,
            appointmentDepositIntent,
            appointmentDepositClaim,
            handoffCapability
          })
          settleAction(action, 'ok', {
            actionCompleted: true,
            paymentConfirmed: false,
            manualReviewRequired: true,
            transferredToHuman: true,
            signal: 'ready_for_human',
            manualReviewEventId: reviewCase.eventId,
            alreadyRegistered: reviewCase.newlyCreated !== true
          })
          return {
            ok: true,
            actionCompleted: true,
            paymentConfirmed: false,
            manualReviewRequired: true,
            transferredToHuman: true,
            signal: 'ready_for_human',
            alreadyRegistered: reviewCase.newlyCreated !== true,
            note: 'Comprobante recibido y enviado a revisión humana. No hay un pago registrado ni confirmado todavía.'
          }
        } catch (error) {
          logger.error(`[Agente conversacional] No se pudo conservar el comprobante incierto: ${error.message}`)
          settleAction(action, 'error', { error: 'payment_proof_manual_review_case_failed' })
          return {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            error: 'No pude guardar el comprobante para revisión. No confirmes ningún pago y pasa la conversación a una persona.'
          }
        }
      }
      if (!analysis.ok) {
        return keepUncertainProofForManualReview('analysis_failed')
      }
      if (!analysis.isPaymentReceipt || !analysis.amount) {
        return keepUncertainProofForManualReview(analysis.isPaymentReceipt ? 'amount_missing' : 'receipt_not_recognized')
      }
      if (analysis.currency && accountCurrency && String(analysis.currency).trim().toUpperCase() !== accountCurrency) {
        return keepUncertainProofForManualReview('currency_mismatch')
      }
      if (!depositRequirementAmountMatches(deposit, analysis.amount)) {
        return keepUncertainProofForManualReview('amount_mismatch')
      }

      let escalatedReview = null
      if (receiptNeedsHumanReview) {
        try {
          escalatedReview = await commitNativePaymentProofEscalation({
            ctx,
            config,
            handoffCapability,
            receiptMedia,
            paymentPurpose: nativePaymentPurpose,
            expectedRequirement: deposit,
            analysis,
            staleReasons: receiptStaleReasons,
            possibleDoublePayment: receiptPossibleDoublePayment
          })
        } catch (error) {
          logger.error(`[Agente conversacional] No se pudo escalar el comprobante riesgoso antes de registrarlo: ${error.message}`)
          settleAction(action, 'error', { error: 'payment_proof_escalation_failed' })
          return {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            error: 'No pude dejar el comprobante bajo revisión humana. No confirmes el pago ni continúes con la cita.'
          }
        }
      }

      let payment
      try {
        const proofBoundToAppointmentIntent = Boolean(appointmentDepositIntent && appointmentSelection && appointmentDepositClaim?.claimToken)
        payment = await registerAgentTransferPaymentProofForReview({
          contactId: ctx.contactId,
          amount: analysis.amount,
          currency: accountCurrency,
          concept: `${paymentLabel === 'anticipo' ? 'Anticipo' : 'Pago'} por transferencia`,
          reference: analysis.reference || (referencia || null),
          agentId: config.id || ctx.agentId || null,
          mediaUrl: receiptMedia.mediaUrl,
          mediaMessageId: receiptMedia.messageId || null,
          receivedAt: receiptMedia.receivedAt || null,
          extracted: {
            amount: analysis.amount,
            currency: analysis.currency,
            date: analysis.date,
            bank: analysis.bank,
            reference: analysis.reference,
            recipientHint: analysis.recipientHint,
            confidence: analysis.confidence,
            needsHumanReview: receiptNeedsHumanReview,
            staleReasons: receiptStaleReasons,
            possibleDoublePayment: receiptPossibleDoublePayment
          },
          conversationalBinding: {
            bindingKey: receiptMedia.messageId,
            channel: String(ctx.channel || 'whatsapp').trim().toLowerCase(),
            executionId: String(ctx.executionId || '').trim(),
            paymentPurpose: nativePaymentPurpose,
            appointmentDeposit: nativePaymentPurpose === 'appointment_deposit',
            manualReviewOnly: nativePaymentPurpose === 'appointment_deposit' && (!proofBoundToAppointmentIntent || receiptNeedsHumanReview),
            autoResumeAllowed: nativePaymentPurpose !== 'appointment_deposit' || (proofBoundToAppointmentIntent && !receiptNeedsHumanReview),
            appointmentSelectionEventId: appointmentSelection?.id || null,
            appointmentSelectionCalendarId: appointmentSelection?.detail?.calendarId || null,
            appointmentSelectionStartTime: appointmentSelection?.detail?.startTime || null,
            appointmentSelectionVerifiedAt: appointmentSelection?.detail?.verifiedAt || null,
            appointmentDepositIntentEventId: appointmentDepositIntent?.id || null,
            appointmentDepositIntentClaimKey: receiptIntentBindingEventId,
            appointmentDepositIntentClaimToken: appointmentDepositClaim?.claimToken || null,
            receiptIntentBindingEventId,
            confidence: analysis.confidence
          }
        })
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo registrar el anticipo por transferencia: ${error.message}`)
        if (escalatedReview?.eventId) {
          settleAction(action, 'ok', {
            actionCompleted: true,
            paymentConfirmed: false,
            paymentRecorded: false,
            manualReviewRequired: true,
            transferredToHuman: true,
            signal: 'ready_for_human',
            warning: 'payment_ledger_registration_failed_after_handoff'
          })
          return {
            ok: true,
            actionCompleted: true,
            paymentConfirmed: false,
            paymentRecorded: false,
            manualReviewRequired: true,
            transferredToHuman: true,
            signal: 'ready_for_human',
            note: 'El comprobante quedó con el equipo para revisión, pero no se registró ni confirmó ningún pago.'
          }
        }
        settleAction(action, 'error', { error: error.message })
        return { ok: false, actionCompleted: false, transferRequired: true, error: 'El comprobante se leyó bien pero no se pudo registrar el pago. Pasa la conversación a una persona con send_to_human.' }
      }

      if (appointmentDepositIntent && appointmentDepositClaim?.claimToken && payment.bindingEventId) {
        const intentBound = await markNativeAppointmentDepositIntentBound({
          intent: appointmentDepositIntent,
          selection: appointmentSelection,
          sourceEventId: payment.bindingEventId,
          method: 'bankTransfer',
          claimToken: appointmentDepositClaim?.claimToken
        })
        if (!intentBound && payment.alreadyRegistered !== true) {
          settleAction(action, 'error', { error: 'appointment_deposit_intent_binding_failed' })
          return {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            error: 'El comprobante quedó registrado para revisión, pero su vínculo con el horario cambió. No lo repitas; pasa la conversación a una persona.'
          }
        }
      }

      if (escalatedReview?.eventId && payment.paymentId) {
        const escalationRow = await db.get(
          'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
          [escalatedReview.eventId]
        )
        const escalationDetail = parseNativeEventDetail(escalationRow?.detail_json)
        if (!escalationDetail.ledgerPaymentId) {
          await db.run(
            'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
            [JSON.stringify({ ...escalationDetail, ledgerPaymentId: payment.paymentId }), escalatedReview.eventId, escalationRow.detail_json]
          )
        }
      }

      // El equipo recibe aviso para auditar el comprobante aunque el agente continúe.
      if (!payment.alreadyRegistered) {
        await notifyHumanPriority(ctx, {
          reason: `${paymentLabel === 'anticipo' ? 'Anticipo' : 'Pago'} por transferencia pendiente de revisar`,
          summary: `${payment.amount} ${payment.currency} · revisar comprobante`,
          signal: receiptNeedsHumanReview ? 'ready_for_human' : 'deposit_transfer_pending_review'
        })
      }

      settleAction(action, 'ok', {
        actionCompleted: true,
        paymentId: payment.paymentId,
        amount: payment.amount,
        currency: payment.currency,
        paymentStatus: payment.status,
        paymentConfirmed: false,
        manualReviewRequired: receiptNeedsHumanReview,
        transferredToHuman: receiptNeedsHumanReview,
        ...(receiptNeedsHumanReview ? { signal: 'ready_for_human' } : {}),
        alreadyRegistered: payment.alreadyRegistered === true
      })
      return {
        ok: true,
        actionCompleted: true,
        payment: {
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status
        },
        paymentConfirmed: false,
        manualReviewRequired: receiptNeedsHumanReview,
        transferredToHuman: receiptNeedsHumanReview,
        ...(receiptNeedsHumanReview ? { signal: 'ready_for_human' } : {}),
        note: 'Comprobante recibido y pendiente de revisión humana. No digas que el pago está confirmado y no continúes con una acción que exija fondos verificados.'
      }
    }
  })

  const enabledCapabilities = new Set(
    getEnabledConversationalCapabilities(runtimeConfig).map((capability) => capability.id)
  )
  const nativeTools = [getBusinessProfileTool, listProductsTool, getContactProfileTool]

  if (!ctx.followUpMode && safetyPolicy?.enabled !== false) {
    nativeTools.push(applySafetyMeasureTool)
  }

  if (
    Number(ctx.historyContext?.telemetry?.omittedMessages || 0) > 0 &&
    typeof ctx.loadConversationHistoryPage === 'function'
  ) {
    nativeTools.push(getConversationHistoryTool)
  }
  if (!ctx.followUpMode && dataRequirements?.enabled && dataRequirements?.updateContact?.enabled) {
    nativeTools.push(saveContactDataTool)
  }
  if (
    !ctx.followUpMode &&
    (
      enabledCapabilities.has('handoff_human') ||
      (enabledCapabilities.has('collect_payment') && paymentCapability?.afterPayment === 'handoff')
    )
  ) {
    nativeTools.push(sendToHumanTool)
  }
  if (!ctx.followUpMode && enabledCapabilities.has('schedule_appointment')) {
    nativeTools.push(getFreeSlotsForAgentTool)
    nativeTools.push(offerAppointmentSlotTool)
    nativeTools.push(
      scheduleCapability?.bookingOwner === 'human'
        ? requestHumanBookingTool
        : bookAppointmentTool
    )
  }
  if (!ctx.followUpMode && enabledCapabilities.has('collect_payment')) {
    const methods = paymentCapability?.deposit?.methods || {}
    if (paymentCapability?.paymentMode !== 'deposit' || methods.paymentLink === true) {
      nativeTools.push(createPaymentLinkTool)
    }
    if ((paymentCapability?.deposit?.enabled && methods.bankTransfer === true) || paymentCapability?.receiptProof?.enabled === true) {
      nativeTools.push(registerDepositProofTool)
    }
  }
  if (!ctx.followUpMode && enabledCapabilities.has('send_link')) {
    nativeTools.push(sendGoalUrlTool)
  }
  if (
    !ctx.followUpMode &&
    enabledCapabilities.has('custom_goal') &&
    customCapability?.completion === 'handoff'
  ) {
    nativeTools.push(markReadyTool)
  }
  return nativeTools.map((toolDefinition) => wrapMutableToolWithPreventiveFence(toolDefinition, ctx))
}

export const __conversationalToolsTestHooks = Object.freeze({
  assertRequiredContactData,
  isPlaceholderContactName,
  buildAppointmentParticipant,
  buildAppointmentParticipants,
  resolveAppointmentParticipantEvidenceMessages,
  appointmentRequirementFacts,
  paymentRequirementFacts
})
