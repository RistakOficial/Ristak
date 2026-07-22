import { tool } from '@openai/agents'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'
import { db } from '../../config/database.js'
import { invokeController, toToolResult } from '../invokeController.js'
import {
  createAppointment,
  getFreeSlots as getCalendarFreeSlots,
  updateAppointment
} from '../../controllers/calendarsController.js'
import { calendarDurationToMinutes, getLocalFreeSlots } from '../../services/localCalendarService.js'
import { inspectChangedAppointmentCreationReplay } from '../../services/appointmentCreationSafetyService.js'
import {
  buildConversationalPaymentLinkIdempotencyKey,
  registerAgentTransferPaymentProofForReview
} from '../../services/paymentFlowService.js'
import {
  conversationalPaymentLinkIsStillValid,
  conversationalPaymentProviderStatusIsClosed,
  conversationalPaymentStatusIsReusable,
  createConversationalAgentLivePaymentLink,
  getConversationalPaymentProviderRawStatus,
  paymentAmountInMinorUnits
} from '../../services/conversationalAgentLivePaymentService.js'
import { getBusinessProfileSnapshot, getOpenAIApiKey } from '../../services/aiAgentService.js'
import { analyzePaymentReceiptImage } from './mediaContext.js'
import { getTriggerLink } from '../../services/triggerLinksService.js'
import {
  businessTodayDateOnly,
  getAccountTimezone,
  normalizeDateOnlyInTimezone,
  resolveTimezone
} from '../../utils/dateUtils.js'
import { getAccountCurrency } from '../../utils/accountLocale.js'
import { normalizePhoneForStorage } from '../../utils/phoneUtils.js'
import {
  mergeContactCustomFields,
  parseContactCustomFields,
  serializeContactCustomFieldsForDb
} from '../../utils/contactCustomFields.js'
import {
  bindConversationalPaymentSourceEvent,
  claimConversationalTerminalMutationAuthority,
  completeConversationalAgentSalePaymentFromInvoice,
  consumeConversationalAppointmentDepositForHumanBooking,
  consumeConversationalAppointmentDepositEvidence,
  notifyConversationalAiBookingDeposit,
  notifyConversationalHumanBookingDeposit,
  releaseConversationalAppointmentDepositEvidence,
  reserveConversationalAppointmentDepositEvidence,
  setConversationSignal,
  recordConversationalAgentEvent,
  createConversationGoalLink,
  DEFAULT_GOAL_TRACKING_PARAM,
  getConversationalAgent,
  getConversationalReplyDeliveryPlan,
  CONVERSATIONAL_REPLY_DELIVERY_EVENT_TYPE
} from '../../services/conversationalAgentService.js'
import { sendConversationalAgentPriorityNotification } from '../../services/pushNotificationsService.js'
import { logger } from '../../utils/logger.js'
import { getGHLClient } from '../../services/ghlClient.js'
import { hasFeature } from '../../services/licenseService.js'
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
  buildConversationalCapabilityManifest,
  getConversationalCapabilitiesConfig,
  getConversationalCapability,
  isSafeConversationalHttpUrl
} from './nativeRuntimeConfig.js'
import {
  CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
  CONVERSATIONAL_APPOINTMENT_PREVIEW_AUTHORITY_EVENT,
  CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT,
  buildConversationalAppointmentPreviewAuthorityEventId,
  buildConversationalAppointmentPreviewOfferEventId,
  isConversationalAppointmentPreviewScopeId
} from '../../services/conversationalAppointmentPreviewOfferService.js'
import { findNewerSubstantiveConversationalInbound } from '../../services/conversationalInboundAuthorityService.js'
import { acquireConversationalInboundCommitLock } from '../../services/conversationalInboundCommitLockService.js'
import { runBoundedAppointmentControllerRequest } from '../../services/appointmentControllerRetryService.js'

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

function buildNativeTerminalAuthorityToken(ctx = {}, config = {}, terminalToolName = '') {
  const contactId = String(ctx.contactId || '').trim()
  const agentId = String(config.id || ctx.agentId || '').trim()
  const channel = String(ctx.channel || 'whatsapp').trim().toLowerCase()
  const executionId = String(ctx.executionId || '').trim()
  const reconciliationId = String(ctx.paymentResumeClaim?.reconciliationId || '').trim()
  const claimToken = String(ctx.paymentResumeClaim?.claimToken || '').trim()
  if (!contactId || !agentId || !executionId || !terminalToolName) return ''
  const digest = createHash('sha256')
    .update([contactId, agentId, channel, executionId, reconciliationId, claimToken, terminalToolName].join('\u0000'))
    .digest('hex')
  return `conv_terminal_${digest.slice(0, 48)}`
}

function cleanAppointmentText(value, maxLength) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function requiredDataVisibleReply(result = {}) {
  const labels = Array.isArray(result.requiredFields)
    ? result.requiredFields.map((item) => cleanAppointmentText(item?.label, 120)).filter(Boolean)
    : []
  if (labels.length) {
    return `para continuar me falta ${labels.join(', ')}. me pasas ${labels.length === 1 ? 'ese dato' : 'esos datos'}?`
  }
  if (result.requiredField === 'agreedAmount') {
    const min = Number(result.minAmount) || 0
    const max = Number(result.maxAmount) || 0
    const range = min && max ? ` entre ${min} y ${max}` : ''
    return `qué monto de anticipo vas a dejar${range}?`
  }
  if (result.amountOutOfRange) {
    const min = Number(result.minAmount) || 0
    const max = Number(result.maxAmount) || 0
    return min && max
      ? `ese anticipo debe quedar entre ${min} y ${max}. qué monto vas a dejar?`
      : 'ese monto no entra en el rango configurado. qué monto vas a dejar?'
  }
  return ''
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
    custom_fields: source.custom_fields || null,
    total_paid: 0,
    purchases_count: 0,
    virtual: true
  }
}

function applyActionScopedContactData(ctx = {}, contact = null) {
  if (!contact) return null
  const actionScoped = ctx.actionScopedContactData && typeof ctx.actionScopedContactData === 'object'
    ? ctx.actionScopedContactData
    : null
  if (!actionScoped) return contact
  return {
    ...contact,
    ...actionScoped,
    custom_fields: serializeContactCustomFieldsForDb(mergeContactCustomFields(
      parseContactCustomFields(contact.custom_fields),
      parseContactCustomFields(actionScoped.custom_fields)
    ))
  }
}

async function getThreadContact(ctx = {}) {
  const contactId = String(ctx.contactId || '').trim()
  if (ctx.virtualContact && typeof ctx.virtualContact === 'object') {
    return applyActionScopedContactData(ctx, getVirtualThreadContact(ctx))
  }
  if (!contactId) return ctx.dryRun ? applyActionScopedContactData(ctx, getVirtualThreadContact(ctx)) : null
  const stored = await db.get(`
    SELECT id, full_name, first_name, last_name, phone, email, custom_fields, total_paid, purchases_count
    FROM contacts WHERE id = ?
  `, [contactId])
  return applyActionScopedContactData(ctx, stored || (ctx.dryRun ? getVirtualThreadContact(ctx) : null))
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
  // Los perfiles de canal pueden traer sólo emojis/símbolos o un nombre
  // decorado con ellos. Esos valores no son una identidad humana confirmada y
  // deben poder sustituirse cuando la persona comparte su nombre real.
  if (/\p{Extended_Pictographic}/u.test(normalized) || !/\p{L}/u.test(normalized)) {
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
  const resolvedContact = contact
    ? applyActionScopedContactData(ctx, contact)
    : await getThreadContact(ctx)
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
  'resolve_active_appointment_offer',
  'book_appointment',
  'request_human_booking',
  'reschedule_appointment',
  'cancel_appointment',
  'mark_ready_to_advance',
  'create_payment_link',
  'send_trigger_link',
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

const NATIVE_APPOINTMENT_REQUEST_DRAFT_VERSION = 1

function nullableAppointmentDraftText(value, maxLength) {
  return cleanAppointmentText(value, maxLength) || null
}

function normalizeNativeAppointmentPersonDraft(value) {
  const participant = cleanParticipant(value)
  if (!participant) return null
  return {
    name: participant.name || null,
    phone: participant.phone || null,
    phoneSourceQuote: participant.phone && participant.phoneSourceQuote
      ? participant.phoneSourceQuote
      : null,
    email: participant.email || null,
    emailSourceQuote: participant.email && participant.emailSourceQuote
      ? participant.emailSourceQuote
      : null,
    relation: participant.relation || null
  }
}

function normalizeNativeAppointmentRequestDraft(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rawGuests = Array.isArray(value.guests) ? value.guests : []
  if (rawGuests.length > 20) return null
  return {
    version: NATIVE_APPOINTMENT_REQUEST_DRAFT_VERSION,
    title: nullableAppointmentDraftText(value.title, 240),
    notes: nullableAppointmentDraftText(value.notes, 2000),
    attendeeName: nullableAppointmentDraftText(value.attendeeName, 180),
    attendeeContext: nullableAppointmentDraftText(value.attendeeContext, 1000),
    primaryAttendee: normalizeNativeAppointmentPersonDraft(value.primaryAttendee),
    guests: rawGuests.map(normalizeNativeAppointmentPersonDraft).filter(Boolean)
  }
}

function buildValidatedNativeAppointmentPersonDraft(rawValue, validatedValue) {
  const raw = cleanParticipant(rawValue)
  if (!raw || !validatedValue || typeof validatedValue !== 'object') return null
  const validatedPhone = cleanAppointmentText(validatedValue.phone, 80)
  const validatedEmail = cleanAppointmentText(validatedValue.email, 180).toLowerCase()
  return normalizeNativeAppointmentPersonDraft({
    name: validatedValue.name || raw.name || null,
    phone: validatedPhone || null,
    phoneSourceQuote: validatedPhone ? raw.phoneSourceQuote || null : null,
    email: validatedEmail || null,
    emailSourceQuote: validatedEmail ? raw.emailSourceQuote || null : null,
    relation: validatedValue.relation || raw.relation || null
  })
}

function buildValidatedNativeAppointmentRequestDraft({
  title,
  notes,
  attendeeName,
  attendeeContext,
  primaryAttendee,
  guests,
  participants
} = {}) {
  if (!participants?.ok) return null
  const legacyPrimary = attendeeName
    ? { name: attendeeName, relation: attendeeContext || null }
    : null
  const rawPrimary = primaryAttendee || legacyPrimary
  const boundPrimary = participants.primary?.contactId === null
    ? buildValidatedNativeAppointmentPersonDraft(rawPrimary, participants.primary)
    : null
  const rawGuests = (Array.isArray(guests) ? guests : [])
    .map((guest) => ({ raw: guest, normalized: cleanParticipant(guest) }))
    .filter((entry) => entry.normalized)
  const validatedGuests = Array.isArray(participants.guests) ? participants.guests : []
  if (rawGuests.length !== validatedGuests.length) return null
  const boundGuests = rawGuests.map((entry, index) => (
    buildValidatedNativeAppointmentPersonDraft(entry.raw, validatedGuests[index])
  ))
  if (boundGuests.some((guest) => !guest)) return null
  return normalizeNativeAppointmentRequestDraft({
    title,
    notes,
    attendeeName: null,
    attendeeContext: null,
    primaryAttendee: boundPrimary,
    guests: boundGuests
  })
}

function nativeAppointmentRequestDraftHash(draft = null) {
  return draft
    ? createHash('sha256').update(JSON.stringify(draft)).digest('hex')
    : ''
}

function readBoundNativeAppointmentRequestDraft(detail = {}) {
  const draft = normalizeNativeAppointmentRequestDraft(detail?.appointmentRequestDraft)
  const expectedHash = String(detail?.appointmentRequestDraftHash || '').trim()
  if (!draft || !expectedHash || nativeAppointmentRequestDraftHash(draft) !== expectedHash) return null
  return draft
}

const NATIVE_APPOINTMENT_TERMINAL_TOOL_BY_OWNER = Object.freeze({
  ai: 'book_appointment',
  human: 'request_human_booking'
})

function normalizeNativeAppointmentTerminalBinding(value = {}) {
  const bookingOwner = String(value?.bookingOwner || '').trim().toLowerCase()
  const terminalToolName = String(value?.terminalToolName || '').trim()
  if (!Object.hasOwn(NATIVE_APPOINTMENT_TERMINAL_TOOL_BY_OWNER, bookingOwner)) return null
  if (NATIVE_APPOINTMENT_TERMINAL_TOOL_BY_OWNER[bookingOwner] !== terminalToolName) return null
  return { bookingOwner, terminalToolName }
}

function readBoundNativeAppointmentTerminalBinding(detail = {}) {
  return normalizeNativeAppointmentTerminalBinding({
    bookingOwner: detail?.bookingOwner,
    terminalToolName: detail?.terminalToolName
  })
}

function buildNativeAppointmentTerminalBinding(scheduleCapability = {}, terminalToolName = '') {
  const bookingOwner = scheduleCapability?.bookingOwner === 'human' ? 'human' : 'ai'
  return normalizeNativeAppointmentTerminalBinding({ bookingOwner, terminalToolName })
}

function appointmentResumeUsesBoundDraft(evidence = {}) {
  return evidence?.reusedForPaymentResume === true || evidence?.reusedForTestPaymentResume === true
}

function getToolRuntimeConfig(ctx = {}, config = {}) {
  return {
    ...config,
    capabilitiesConfig: ctx.capabilitiesConfig ?? config.capabilitiesConfig
  }
}

function nativeAppointmentCapabilitiesFingerprint(ctx = {}, config = {}) {
  const normalized = getConversationalCapabilitiesConfig(getToolRuntimeConfig(ctx, config))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function buildEffectiveDataRequirements(capabilitiesConfig = {}, availableCapabilityIds = new Set()) {
  const configured = capabilitiesConfig?.dataRequirements && typeof capabilitiesConfig.dataRequirements === 'object'
    ? capabilitiesConfig.dataRequirements
    : {}
  const fields = (Array.isArray(configured.fields) ? configured.fields : []).filter((field) => {
    if (field?.scope === 'appointment') return availableCapabilityIds.has('schedule_appointment')
    if (field?.scope === 'payment') return availableCapabilityIds.has('collect_payment')
    return availableCapabilityIds.size > 0
  })
  const scheduleAvailable = availableCapabilityIds.has('schedule_appointment')
  const participants = configured.participants && typeof configured.participants === 'object'
    ? configured.participants
    : {}
  const effectiveParticipants = {
    ...participants,
    enabled: scheduleAvailable && participants.enabled === true,
    guestFields: scheduleAvailable && participants.enabled === true
      ? (Array.isArray(participants.guestFields) ? participants.guestFields : [])
      : []
  }
  return {
    ...configured,
    enabled: fields.length > 0 || effectiveParticipants.enabled,
    fields,
    participants: effectiveParticipants
  }
}

function buildSaveContactDataParameters(fields = []) {
  const configuredFields = Array.isArray(fields) ? fields : []
  const allowed = new Set(configuredFields.map((item) => String(item?.field || '').trim()))
  const shape = {}
  if (allowed.has('full_name') || allowed.has('first_name')) {
    shape.fullName = z.string().nullable().describe(
      allowed.has('full_name')
        ? 'Nombre completo confirmado de quien escribe; null si todavía no lo proporcionó'
        : 'Nombre confirmado de quien escribe; null si todavía no lo proporcionó'
    )
  }
  if (allowed.has('phone')) {
    shape.phone = z.string().nullable().describe('Teléfono principal confirmado de quien escribe; null si todavía no lo proporcionó')
  }
  if (allowed.has('alternate_phone')) {
    shape.alternatePhone = z.string().nullable().describe('Otro teléfono confirmado de quien escribe; null si todavía no lo proporcionó')
  }
  if (allowed.has('email')) {
    shape.email = z.string().nullable().describe('Correo confirmado de quien escribe; null si todavía no lo proporcionó')
  }
  if (allowed.has('company')) {
    shape.company = z.string().nullable().describe('Empresa confirmada de quien escribe; null si todavía no la proporcionó')
  }
  if (allowed.has('address')) {
    shape.address = z.string().nullable().describe('Dirección confirmada de quien escribe; null si todavía no la proporcionó')
  }
  const customLabels = configuredFields
    .filter((item) => item?.field === 'custom' && item?.label)
    .map((item) => cleanAppointmentText(item.label, 120))
    .filter(Boolean)
  if (customLabels.length) {
    shape.customValues = z.array(z.object({
      key: z.string().min(1).max(120),
      value: z.string().max(1000)
    })).max(20).nullable().describe(`Sólo estos datos personalizados confirmados: ${customLabels.join(', ')}; null si no aplica`)
  }
  return z.object(shape)
}

function getNativeCapability(ctx = {}, config = {}, capabilityId = '') {
  const runtimeConfig = getToolRuntimeConfig(ctx, config)
  const capabilitiesConfig = getConversationalCapabilitiesConfig(runtimeConfig)
  const capability = getConversationalCapability({ capabilitiesConfig }, capabilityId)
  const manifestItem = buildConversationalCapabilityManifest({ capabilitiesConfig })
    .find((item) => item.id === capabilityId)
  return capability?.enabled && manifestItem?.ready ? capability : null
}

function getNativePaymentPurpose(ctx = {}, config = {}) {
  const payment = getNativeCapability(ctx, config, 'collect_payment')
  if (!payment) return ''
  if (payment.chargeType === 'deposit' || payment.paymentMode === 'deposit' || payment.deposit?.enabled === true) {
    // Que Agendar y Cobrar estén activados al mismo tiempo no convierte todo
    // anticipo en anticipo de cita. Ese vínculo sólo existe después de que una
    // oferta estructurada fue aceptada y el terminal de agenda abrió un intento
    // durable para ese horario exacto.
    return 'deposit'
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
        productId: null,
        priceId: null,
        gateway: capability.gateway || 'stripe',
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
        gateway: capability.gateway || 'stripe',
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
      gateway: capability.gateway || 'stripe',
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
let nativeHumanBookingAfterCommitHookForTest = null
let nativePaymentResumeBeforeTerminalCommitHookForTest = null
let nativePaymentReceiptAnalysisHookForTest = null
let nativeAppointmentBeforeResolverTerminalHookForTest = null
let nativeAppointmentAvailabilityLookupHookForTest = null
let nativeAppointmentRuntimeAgentLookupHookForTest = null
let nativeAppointmentAfterPreCommitAuthorityHookForTest = null
let nativeAppointmentCreateControllerInvokeHookForTest = null

export function setNativeHandoffAfterAssignmentHookForTest(hook = null) {
  nativeHandoffAfterAssignmentHookForTest = typeof hook === 'function' ? hook : null
}

export function setNativeHumanBookingAfterCommitHookForTest(hook = null) {
  nativeHumanBookingAfterCommitHookForTest = typeof hook === 'function' ? hook : null
}

export function setNativePaymentResumeBeforeTerminalCommitHookForTest(hook = null) {
  nativePaymentResumeBeforeTerminalCommitHookForTest = typeof hook === 'function' ? hook : null
}

export function setNativePaymentReceiptAnalysisHookForTest(hook = null) {
  nativePaymentReceiptAnalysisHookForTest = typeof hook === 'function' ? hook : null
}

export function setNativeAppointmentBeforeResolverTerminalHookForTest(hook = null) {
  nativeAppointmentBeforeResolverTerminalHookForTest = typeof hook === 'function' ? hook : null
}

export function setNativeAppointmentAvailabilityLookupHookForTest(hook = null) {
  nativeAppointmentAvailabilityLookupHookForTest = typeof hook === 'function' ? hook : null
}

export function setNativeAppointmentRuntimeAgentLookupHookForTest(hook = null) {
  nativeAppointmentRuntimeAgentLookupHookForTest = typeof hook === 'function' ? hook : null
}

export function setNativeAppointmentAfterPreCommitAuthorityHookForTest(hook = null) {
  nativeAppointmentAfterPreCommitAuthorityHookForTest = typeof hook === 'function' ? hook : null
}

export function setNativeAppointmentCreateControllerInvokeHookForTest(hook = null) {
  nativeAppointmentCreateControllerInvokeHookForTest = typeof hook === 'function' ? hook : null
}

async function runNativeAppointmentAfterPreCommitAuthorityHook({
  terminalToolName,
  purpose = 'book',
  ctx,
  config,
  calendarId,
  appointmentId = null,
  preCommitAuthority
} = {}) {
  if (!nativeAppointmentAfterPreCommitAuthorityHookForTest) return
  await nativeAppointmentAfterPreCommitAuthorityHookForTest({
    terminalToolName,
    purpose,
    contactId: ctx?.contactId || null,
    agentId: config?.id || ctx?.agentId || null,
    channel: ctx?.channel || 'whatsapp',
    calendarId: String(calendarId || '').trim(),
    appointmentId: String(appointmentId || '').trim() || null,
    calendarFingerprint: preCommitAuthority?.calendarFingerprint || null
  })
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
  evidenceEvent = null,
  beforeAssignment = null,
  afterEvidence = null,
  terminalAuthorityToken = '',
  authorityFence = null
} = {}) {
  return db.transaction(async () => {
    let evidenceInserted = null
    const cleanTerminalAuthorityToken = String(terminalAuthorityToken || '').trim()
    if (cleanTerminalAuthorityToken && evidenceEvent?.eventId && typeof afterEvidence === 'function') {
      const existingEvidence = await db.get(
        `SELECT id FROM conversational_agent_events
         WHERE id = ? AND contact_id = ? AND event_type = ?`,
        [evidenceEvent.eventId, ctx.contactId, evidenceEvent.eventType]
      )
      if (existingEvidence?.id) {
        const afterEvidenceResult = await afterEvidence({
          assignment: { assigned: false, alreadyAssigned: true, userName: null },
          state: null,
          evidenceInserted: false,
          beforeAssignmentResult: null
        })
        return {
          assignment: { assigned: false, alreadyAssigned: true, userName: null },
          state: null,
          evidenceInserted: false,
          beforeAssignmentResult: null,
          afterEvidenceResult
        }
      }
    }
    if (typeof authorityFence === 'function') await authorityFence()
    const beforeAssignmentResult = typeof beforeAssignment === 'function'
      ? await beforeAssignment()
      : null
    if (cleanTerminalAuthorityToken) {
      await claimConversationalTerminalMutationAuthority({
        contactId: ctx.contactId,
        agentId: config.id || ctx.agentId || '',
        channel: ctx.channel || 'whatsapp',
        authorityToken: cleanTerminalAuthorityToken,
        database: db
      })
    }
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
      strictEvent: true,
      expectedUpdatedBy: cleanTerminalAuthorityToken
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

    const afterEvidenceResult = typeof afterEvidence === 'function'
      ? await afterEvidence({ assignment, state, evidenceInserted, beforeAssignmentResult })
      : null

    return { assignment, state, evidenceInserted, beforeAssignmentResult, afterEvidenceResult }
  })
}

async function assertNativeHumanBookingDepositEvent({
  eventId,
  contactId,
  agentId,
  reconciliationId,
  paymentId,
  calendarId,
  startTime,
  selectionRequestDraftHash,
  sourceMessageId
} = {}) {
  const row = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [String(eventId || '').trim()]
  )
  const detail = parseNativeEventDetail(row?.detail_json)
  const valid = Boolean(
    row?.event_type === 'human_booking_requested' &&
    String(row?.contact_id || '') === String(contactId || '').trim() &&
    String(row?.agent_id || '') === String(agentId || '').trim() &&
    detail.bookingOwner === 'human' &&
    detail.terminalToolName === 'request_human_booking' &&
    String(detail.depositReconciliationId || '') === String(reconciliationId || '').trim() &&
    String(detail.depositPaymentId || '') === String(paymentId || '').trim() &&
    String(detail.calendarId || '') === String(calendarId || '').trim() &&
    String(detail.startTime || '') === String(startTime || '').trim() &&
    String(detail.selectionRequestDraftHash || '') === String(selectionRequestDraftHash || '').trim() &&
    String(detail.sourceMessageId || '') === String(sourceMessageId || '').trim() &&
    detail.appointmentCreated === false
  )
  if (!valid) {
    throw Object.assign(new Error('La solicitud humana durable ya existe con otro contrato'), {
      statusCode: 409,
      code: 'human_booking_event_contract_conflict'
    })
  }
  return { row, detail }
}

async function resolveNativeScheduleCalendar(capability = {}) {
  const configuredId = String(capability?.calendarId || '').trim()
  if (!configuredId) return null
  const calendar = await db.get(
    `SELECT id, ghl_calendar_id, name, slot_duration, slot_duration_unit,
            slot_interval, slot_interval_unit, slot_buffer, slot_buffer_unit,
            pre_buffer, pre_buffer_unit, is_active, source, open_hours,
            availability_schedule_configured, appoinment_per_slot, allow_overlaps, appoinment_per_day,
            allow_booking_after, allow_booking_after_unit,
            allow_booking_for, allow_booking_for_unit,
            allow_reschedule, allow_cancellation
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

const CANCELLED_APPOINTMENT_STATUSES = new Set(['cancelled', 'canceled'])
const INACTIVE_APPOINTMENT_STATUSES = new Set([
  ...CANCELLED_APPOINTMENT_STATUSES,
  'no_show', 'no-show', 'noshow', 'invalid', 'deleted',
  'showed', 'show', 'attended', 'completed', 'complete'
])

function nativeAppointmentStatus(row = {}) {
  return String(row.appointment_status || row.appointmentStatus || row.status || '').trim().toLowerCase()
}

function nativeAppointmentIsCancelled(row = {}) {
  return CANCELLED_APPOINTMENT_STATUSES.has(nativeAppointmentStatus(row))
}

function nativeCalendarPermissionEnabled(value) {
  return !['0', 'false', 'off', 'no'].includes(String(value ?? '1').trim().toLowerCase())
}

function nativeCalendarAllowsOverlaps(calendar = {}) {
  return calendar?.allowOverlaps === true || Number(calendar?.allow_overlaps) === 1
}

function canonicalNativeAppointmentFingerprintValue(value) {
  if (Array.isArray(value)) return value.map(canonicalNativeAppointmentFingerprintValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalNativeAppointmentFingerprintValue(value[key])
      return result
    }, {})
}

function nativeAppointmentCalendarFingerprint(calendar = null) {
  if (!calendar?.id) return ''
  let openHours = calendar.open_hours ?? calendar.openHours ?? null
  if (typeof openHours === 'string') {
    try {
      openHours = JSON.parse(openHours)
    } catch {
      openHours = openHours.trim()
    }
  }
  const semantic = canonicalNativeAppointmentFingerprintValue({
    id: String(calendar.id || '').trim(),
    ghlCalendarId: String(calendar.ghl_calendar_id || calendar.ghlCalendarId || '').trim(),
    isActive: nativeCalendarPermissionEnabled(calendar.is_active ?? calendar.isActive),
    source: String(calendar.source || '').trim().toLowerCase(),
    slotDuration: Number(calendar.slot_duration ?? calendar.slotDuration ?? 0),
    slotDurationUnit: String(calendar.slot_duration_unit ?? calendar.slotDurationUnit ?? '').trim().toLowerCase(),
    slotInterval: Number(calendar.slot_interval ?? calendar.slotInterval ?? 0),
    slotIntervalUnit: String(calendar.slot_interval_unit ?? calendar.slotIntervalUnit ?? '').trim().toLowerCase(),
    slotBuffer: Number(calendar.slot_buffer ?? calendar.slotBuffer ?? 0),
    slotBufferUnit: String(calendar.slot_buffer_unit ?? calendar.slotBufferUnit ?? '').trim().toLowerCase(),
    preBuffer: Number(calendar.pre_buffer ?? calendar.preBuffer ?? 0),
    preBufferUnit: String(calendar.pre_buffer_unit ?? calendar.preBufferUnit ?? '').trim().toLowerCase(),
    openHours,
    availabilityScheduleConfigured: nativeCalendarPermissionEnabled(
      calendar.availability_schedule_configured ?? calendar.availabilityScheduleConfigured
    ),
    appointmentsPerSlot: Number(calendar.appoinment_per_slot ?? calendar.appoinmentPerSlot ?? 0),
    allowOverlaps: nativeCalendarAllowsOverlaps(calendar),
    appointmentsPerDay: Number(calendar.appoinment_per_day ?? calendar.appoinmentPerDay ?? 0),
    allowBookingAfter: Number(calendar.allow_booking_after ?? calendar.allowBookingAfter ?? 0),
    allowBookingAfterUnit: String(calendar.allow_booking_after_unit ?? calendar.allowBookingAfterUnit ?? '').trim().toLowerCase(),
    allowBookingFor: Number(calendar.allow_booking_for ?? calendar.allowBookingFor ?? 0),
    allowBookingForUnit: String(calendar.allow_booking_for_unit ?? calendar.allowBookingForUnit ?? '').trim().toLowerCase(),
    allowReschedule: nativeCalendarPermissionEnabled(calendar.allow_reschedule ?? calendar.allowReschedule),
    allowCancellation: nativeCalendarPermissionEnabled(calendar.allow_cancellation ?? calendar.allowCancellation)
  })
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
}

function nativeAppointmentDurationMs(row = {}) {
  const startMs = new Date(row.start_time || row.startTime || '').getTime()
  const endMs = new Date(row.end_time || row.endTime || '').getTime()
  const durationMs = endMs - startMs
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : NaN
}

function rescheduleSlotLookup({ appointmentId = '', durationMs = NaN } = {}) {
  const cleanAppointmentId = String(appointmentId || '').trim()
  const durationMinutes = Number(durationMs) / 60000
  return (calendarId, startDate, endDate, timezone, options = {}) => getLocalFreeSlots(
    calendarId,
    startDate,
    endDate,
    timezone,
    {
      ...options,
      ...(cleanAppointmentId ? { excludeAppointmentId: cleanAppointmentId } : {}),
      ...(Number.isFinite(durationMinutes) && durationMinutes > 0 ? { durationMinutes } : {})
    }
  )
}

async function loadOwnedConversationalAppointment({
  ctx,
  calendarId,
  appointmentId,
  throwOnError = false
} = {}) {
  const contactId = String(ctx?.contactId || '').trim()
  const cleanCalendarId = String(calendarId || '').trim()
  const cleanAppointmentId = String(appointmentId || '').trim()
  if (!contactId || !cleanCalendarId || !cleanAppointmentId) return null
  const lookup = db.get(
    `SELECT a.id, a.calendar_id, a.contact_id, a.title, a.notes,
            a.start_time, a.end_time, a.appointment_status, a.status,
            a.ghl_appointment_id, a.google_event_id, a.sync_status,
            a.deleted_at
     FROM appointments a
     WHERE a.id = ?
       AND a.calendar_id = ?
       AND a.deleted_at IS NULL
       AND COALESCE(a.sync_status, '') != 'pending_delete'
       AND (
         a.contact_id = ? OR EXISTS (
           SELECT 1 FROM appointment_participants ap
           WHERE ap.appointment_id = a.id AND ap.contact_id = ? AND ap.role = 'requester'
         )
       )
       AND a.start_time >= ?
    LIMIT 1`,
    [cleanAppointmentId, cleanCalendarId, contactId, contactId, new Date().toISOString()]
  )
  return throwOnError ? lookup : lookup.catch(() => null)
}

async function listOwnedConversationalAppointments({ ctx, calendarId, timezone, limit = 10, offset = 0 } = {}) {
  const contactId = String(ctx?.contactId || '').trim()
  const cleanCalendarId = String(calendarId || '').trim()
  if (!contactId || !cleanCalendarId) return { appointments: [], total: 0, limit: 10, offset: 0 }
  const pageSize = Math.max(1, Math.min(20, Number(limit) || 10))
  const pageOffset = Math.max(0, Math.trunc(Number(offset) || 0))
  const ownershipParams = [cleanCalendarId, contactId, contactId, new Date().toISOString()]
  const ownershipWhere = `a.calendar_id = ?
    AND (a.contact_id = ? OR (ap.contact_id = ? AND ap.role = 'requester'))
    AND a.deleted_at IS NULL
    AND COALESCE(a.sync_status, '') != 'pending_delete'
    AND a.start_time >= ?
    AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (
      'cancelled', 'canceled', 'no_show', 'no-show', 'noshow', 'invalid', 'deleted',
      'showed', 'show', 'attended', 'completed', 'complete'
    )`
  const totalRow = await db.get(
    `SELECT COUNT(DISTINCT a.id) AS total
     FROM appointments a
     LEFT JOIN appointment_participants ap ON ap.appointment_id = a.id
     WHERE ${ownershipWhere}`,
    ownershipParams
  ).catch(() => ({ total: 0 }))
  const rows = await db.all(
    `SELECT owned.*
     FROM (
       SELECT DISTINCT a.id, a.calendar_id, a.contact_id, a.title,
              a.start_time, a.end_time, a.appointment_status, a.status
       FROM appointments a
       LEFT JOIN appointment_participants ap ON ap.appointment_id = a.id
       WHERE ${ownershipWhere}
     ) owned
     ORDER BY owned.start_time ASC, owned.id ASC
     LIMIT ? OFFSET ?`,
    [...ownershipParams, pageSize, pageOffset]
  ).catch(() => [])
  const appointments = (rows || []).flatMap((row) => {
    const canonical = buildCanonicalAppointmentSlotOption(row.start_time, timezone)
    if (!canonical) return []
    return [{
      appointmentId: String(row.id),
      title: cleanAppointmentText(row.title || 'Cita', 180),
      startTime: canonical.startTime,
      endTime: row.end_time ? new Date(row.end_time).toISOString() : null,
      localLabel: canonical.localLabel,
      status: nativeAppointmentStatus(row) || 'confirmed'
    }]
  })
  return {
    appointments,
    total: Number(totalRow?.total || 0),
    limit: pageSize,
    offset: pageOffset
  }
}

async function supersedeActiveRescheduleOffersForAppointment({ ctx, config, appointmentId } = {}) {
  const contactId = String(ctx?.contactId || '').trim()
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const cleanAppointmentId = String(appointmentId || '').trim()
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  if (!contactId || !agentId || !cleanAppointmentId || (ctx?.dryRun && !previewScopeId)) return 0
  const eventType = previewScopeId
    ? CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT
    : NATIVE_APPOINTMENT_OFFER_EVENT
  let superseded = 0
  await db.transaction(async () => {
    if (!previewScopeId) {
      const contactLock = await db.get(
        `SELECT id FROM contacts WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
        [contactId]
      )
      if (!contactLock?.id) return
    }
    const rows = previewScopeId
      ? [await db.get(
          `SELECT id, detail_json
           FROM conversational_agent_events
           WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = ?`,
          [buildConversationalAppointmentPreviewOfferEventId(previewScopeId), contactId, agentId, eventType]
        )].filter(Boolean)
      : await db.all(
          `SELECT id, detail_json
           FROM conversational_agent_events
           WHERE contact_id = ? AND agent_id = ? AND event_type = ?`,
          [contactId, agentId, eventType]
        )
    const supersededAt = new Date().toISOString()
    for (const row of rows || []) {
      const detail = parseNativeEventDetail(row.detail_json)
      if (
        String(detail.status || '') !== 'active' ||
        String(detail.purpose || 'book') !== 'reschedule' ||
        String(detail.appointmentId || '') !== cleanAppointmentId ||
        !nativeAppointmentEventMatchesChannel(detail, channel)
      ) continue
      const nextDetail = {
        ...detail,
        status: 'superseded',
        phase: 'resolved',
        resolution: 'appointment_cancelled',
        resolvedAt: supersededAt,
        resolvedExecutionId: String(ctx?.executionId || '').trim(),
        supersededAt
      }
      const updated = await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND event_type = ? AND detail_json = ?`,
        [JSON.stringify(nextDetail), row.id, eventType, row.detail_json]
      )
      superseded += Number(updated?.changes ?? updated?.rowCount ?? 0)
    }
  })
  return superseded
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

function normalizeNativeAvailabilityTime(value = '') {
  const clean = String(value || '').trim()
  const match = /^(\d{2}):(\d{2})$/.exec(clean)
  if (!match) return ''
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return ''
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function nativeLocalTimeToMinutes(value = '') {
  const normalized = normalizeNativeAvailabilityTime(value)
  if (!normalized) return NaN
  const [hour, minute] = normalized.split(':').map(Number)
  return hour * 60 + minute
}

function nativeAppointmentEpochMinute(value = '') {
  const timestamp = Date.parse(String(value || '').trim())
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 60000) : null
}

function mergeNativeRejectedAppointmentStartTimes(...groups) {
  const byEpochMinute = new Map()
  for (const value of groups.flatMap((group) => (Array.isArray(group) ? group : []))) {
    const startTime = String(value || '').trim()
    const epochMinute = nativeAppointmentEpochMinute(startTime)
    if (epochMinute === null || byEpochMinute.has(epochMinute)) continue
    byEpochMinute.set(epochMinute, startTime)
  }
  return [...byEpochMinute.values()].slice(-100)
}

function nativeAvailabilityTimeLabel(value = '') {
  const totalMinutes = nativeLocalTimeToMinutes(value)
  if (!Number.isFinite(totalMinutes)) return String(value || '').trim()
  const hour24 = Math.floor(totalMinutes / 60)
  const minute = totalMinutes % 60
  const hour12 = hour24 % 12 || 12
  return `${hour12}:${String(minute).padStart(2, '0')} ${hour24 < 12 ? 'a.m.' : 'p.m.'}`
}

function nativeAvailabilityDayLabel(localDate = '', timezone = '') {
  const local = DateTime.fromISO(String(localDate || ''), { zone: resolveTimezone(timezone) }).setLocale('es-MX')
  if (!local.isValid) return String(localDate || '').trim()
  const label = local.toFormat("cccc d 'de' LLLL")
  return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : String(localDate || '').trim()
}

export function filterNativeFreeSlotDays(days = [], {
  timezone = '',
  weekdays = null,
  earliestLocalTime = null,
  latestLocalTime = null,
  excludedStartTimes = [],
  relativeToStartTime = null,
  relativeToLocalTime = null,
  relativeToLocalDate = null,
  relativeToTimezone = null,
  relativeReferenceKind = 'individual',
  relativeDirection = null
} = {}) {
  const resolvedTimezone = resolveTimezone(timezone)
  const allowedWeekdays = new Set((Array.isArray(weekdays) ? weekdays : [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 7))
  const earliest = normalizeNativeAvailabilityTime(earliestLocalTime)
  const latest = normalizeNativeAvailabilityTime(latestLocalTime)
  const excluded = new Set((Array.isArray(excludedStartTimes) ? excludedStartTimes : [])
    .map(nativeAppointmentEpochMinute)
    .filter((value) => value !== null))
  const referenceTimezone = resolveTimezone(relativeToTimezone, resolvedTimezone)
  const relativeSlot = buildCanonicalAppointmentSlotOption(relativeToStartTime, referenceTimezone)
  const relativeTime = normalizeNativeAvailabilityTime(relativeToLocalTime) || relativeSlot?.localTime || ''
  const relativeDate = String(relativeToLocalDate || relativeSlot?.localDate || '').trim()
  const relativeEpochMinute = nativeAppointmentEpochMinute(relativeToStartTime)
  const normalizedDirection = ['later', 'earlier'].includes(String(relativeDirection || '').trim())
    ? String(relativeDirection).trim()
    : ''

  return (Array.isArray(days) ? days : []).flatMap((day) => {
    const dayTimezone = resolveTimezone(day?.timezone, resolvedTimezone)
    const localDate = String(day?.localDate || '').trim()
    const localDay = DateTime.fromISO(localDate, { zone: dayTimezone })
    if (!localDay.isValid || (allowedWeekdays.size && !allowedWeekdays.has(localDay.weekday))) return []
    const options = (Array.isArray(day?.options) ? day.options : []).filter((option) => {
      const startTime = String(option?.startTime || '').trim()
      const epochMinute = nativeAppointmentEpochMinute(startTime)
      const localTime = normalizeNativeAvailabilityTime(option?.localTime)
      const optionLocalDate = String(option?.localDate || localDate || '').trim()
      if (!startTime || epochMinute === null || !localTime || excluded.has(epochMinute)) return false
      if (earliest && localTime < earliest) return false
      if (latest && localTime > latest) return false
      if (normalizedDirection === 'later' && relativeTime) {
        if (localTime < relativeTime) return false
        if (localTime === relativeTime) {
          const isLaterRepeatedClockTime = Boolean(
            relativeDate &&
            optionLocalDate === relativeDate &&
            dayTimezone === referenceTimezone &&
            relativeEpochMinute !== null &&
            epochMinute > relativeEpochMinute
          )
          if (!isLaterRepeatedClockTime) return false
        }
      }
      if (normalizedDirection === 'earlier' && relativeTime) {
        if (localTime > relativeTime) return false
        if (localTime === relativeTime) {
          const isEarlierRepeatedClockTime = Boolean(
            relativeDate &&
            optionLocalDate === relativeDate &&
            dayTimezone === referenceTimezone &&
            relativeEpochMinute !== null &&
            epochMinute < relativeEpochMinute
          )
          if (!isEarlierRepeatedClockTime) return false
        }
      }
      return true
    })
    return options.length ? [{ ...day, timezone: dayTimezone, localDate, options }] : []
  })
}

function buildNativeAvailabilityRanges(options = [], intervalMinutes = 60, timezone = '') {
  const step = Math.max(1, Math.round(Number(intervalMinutes) || 60))
  const seenEpochMinutes = new Set()
  const times = (Array.isArray(options) ? options : []).flatMap((option) => {
    const localTime = normalizeNativeAvailabilityTime(option?.localTime)
    const startTime = String(option?.startTime || '').trim()
    const epochMinute = nativeAppointmentEpochMinute(startTime)
    if (!localTime || epochMinute === null || seenEpochMinutes.has(epochMinute)) return []
    seenEpochMinutes.add(epochMinute)
    const local = DateTime.fromISO(startTime, { setZone: true })
      .setZone(resolveTimezone(option?.timezone, timezone))
    return [{
      ...option,
      startTime,
      localTime,
      minutes: nativeLocalTimeToMinutes(localTime),
      epochMinute,
      utcOffset: local.isValid ? `UTC${local.toFormat('ZZ')}` : ''
    }]
  }).sort((left, right) => left.epochMinute - right.epochMinute)
  const ranges = []
  for (const item of times) {
    const current = ranges.at(-1)
    if (
      current &&
      item.minutes === current.end.minutes + step &&
      item.epochMinute > current.end.epochMinute &&
      item.utcOffset === current.end.utcOffset
    ) {
      current.end = item
      current.count += 1
      current.items.push(item)
    } else {
      ranges.push({ start: item, end: item, count: 1, items: [item] })
    }
  }
  return ranges
}

function nativeAvailabilityRangeItemLabel(item = {}, duplicatedLocalTimes = new Set()) {
  const timeLabel = nativeAvailabilityTimeLabel(item.localTime)
  return duplicatedLocalTimes.has(item.localTime) && item.utcOffset
    ? `${timeLabel} (${item.utcOffset})`
    : timeLabel
}

export function buildNativeAppointmentAvailabilityPresentation(days = [], {
  timezone = '',
  intervalMinutes = 60,
  maxDays = 3,
  maxRangesPerDay = 3,
  questionMode = 'date_and_time'
} = {}) {
  const selectedDays = (Array.isArray(days) ? days : [])
    .filter((day) => Array.isArray(day?.options) && day.options.length)
    .slice(0, Math.max(1, Math.min(3, Number(maxDays) || 3)))
  if (!selectedDays.length) return { visibleReply: '', displayedStartTimes: [], displayedDays: 0 }

  const blocks = []
  const displayedStartTimes = []
  const displayedRanges = []
  for (const day of selectedDays) {
    const dayTimezone = resolveTimezone(day?.timezone, timezone)
    const localTimeEpochs = new Map()
    for (const option of day.options) {
      const localTime = normalizeNativeAvailabilityTime(option?.localTime)
      const epochMinute = nativeAppointmentEpochMinute(option?.startTime)
      if (!localTime || epochMinute === null) continue
      const epochs = localTimeEpochs.get(localTime) || new Set()
      epochs.add(epochMinute)
      localTimeEpochs.set(localTime, epochs)
    }
    const duplicatedLocalTimes = new Set(
      [...localTimeEpochs.entries()]
        .filter(([, epochs]) => epochs.size > 1)
        .map(([localTime]) => localTime)
    )
    const ranges = buildNativeAvailabilityRanges(day.options, intervalMinutes, dayTimezone)
      .slice(0, Math.max(1, Math.min(3, Number(maxRangesPerDay) || 3)))
    if (!ranges.length) continue
    const lines = ranges.map((range) => {
      displayedStartTimes.push(...range.items.map((option) => String(option.startTime || '').trim()).filter(Boolean))
      displayedRanges.push({
        localDate: String(day.localDate || '').trim(),
        firstStartTime: String(range.start?.startTime || '').trim(),
        lastStartTime: String(range.end?.startTime || '').trim(),
        firstLocalTime: normalizeNativeAvailabilityTime(range.start?.localTime),
        lastLocalTime: normalizeNativeAvailabilityTime(range.end?.localTime),
        count: Math.max(1, Number(range.count) || 1),
        intervalMinutes: Math.max(1, Math.round(Number(intervalMinutes) || 60))
      })
      if (range.count >= 3 && Number(intervalMinutes) <= 60) {
        const cadence = Number(intervalMinutes) === 60 ? 'cada hora' : `cada ${Number(intervalMinutes)} min`
        return `${nativeAvailabilityRangeItemLabel(range.start, duplicatedLocalTimes)} a ${nativeAvailabilityRangeItemLabel(range.end, duplicatedLocalTimes)} (${cadence})`
      }
      if (range.count === 2) {
        return `${nativeAvailabilityRangeItemLabel(range.start, duplicatedLocalTimes)} y ${nativeAvailabilityRangeItemLabel(range.end, duplicatedLocalTimes)}`
      }
      if (range.count > 2) {
        const labels = range.items.map((item) => nativeAvailabilityRangeItemLabel(item, duplicatedLocalTimes))
        return `${labels.slice(0, -1).join(', ')} y ${labels.at(-1)}`
      }
      return nativeAvailabilityRangeItemLabel(range.start, duplicatedLocalTimes)
    })
    blocks.push({
      dayLabel: nativeAvailabilityDayLabel(day.localDate, dayTimezone),
      localDate: day.localDate,
      lines
    })
  }
  if (!blocks.length) return { visibleReply: '', displayedStartTimes: [], displayedDays: 0 }
  const timeOnly = questionMode === 'time_only' && blocks.length === 1
  const visibleReply = timeOnly
    ? `Perfecto, para el *${blocks[0].dayLabel.toLowerCase()}* tengo:\n${blocks[0].lines.join('\n')}\n\n¿A qué hora te acomodaría?`
    : `Sí, mira, tengo:\n\n${blocks.map((block) => `*${block.dayLabel}*\n${block.lines.join('\n')}`).join('\n\n')}\n\n¿Qué día y horario te acomoda mejor?`
  return {
    visibleReply,
    displayedStartTimes: [...new Set(displayedStartTimes)],
    displayedRanges,
    displayedDays: blocks.length,
    focusedLocalDate: timeOnly ? blocks[0].localDate : null,
    missingField: timeOnly ? 'time' : 'date_and_time'
  }
}

async function lookupVerifiedAppointmentSlots(
  calendarId,
  startDate,
  endDate,
  timezone = null,
  options = {}
) {
  if (nativeAppointmentAvailabilityLookupHookForTest) {
    const hookedResult = await nativeAppointmentAvailabilityLookupHookForTest({
      calendarId,
      startDate,
      endDate,
      timezone,
      options
    })
    if (hookedResult !== undefined) return hookedResult
  }
  const businessTimezone = resolveTimezone(timezone || await getAccountTimezone())
  const response = toToolResult(await invokeController(getCalendarFreeSlots, {
    params: { id: calendarId },
    query: { startDate, endDate, timezone: businessTimezone },
    internalContext: {
      availabilityOptions: {
        ...options,
        allowDefaultOpenHours: false
      }
    }
  }))
  if (!response.ok) {
    throw Object.assign(
      new Error(response.error || 'No se pudo comprobar la disponibilidad actual.'),
      { statusCode: response.statusCode }
    )
  }
  if (!Array.isArray(response.data)) throw new Error('El calendario devolvió una respuesta inválida.')
  return response.data
}

const NATIVE_APPOINTMENT_SELECTION_EVENT = 'appointment_slot_selection_verified'
const NATIVE_APPOINTMENT_OFFER_EVENT = 'appointment_slot_offer_created'
const NATIVE_APPOINTMENT_OPTIONS_REFERENCE_EVENT = 'appointment_availability_options_presented'
const NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT = CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT
const NATIVE_APPOINTMENT_DEPOSIT_INTENT_EVENT = 'appointment_deposit_intent_pending'
const NATIVE_APPOINTMENT_RECEIPT_INTENT_EVENT = 'appointment_deposit_receipt_intent_bound'
const NATIVE_APPOINTMENT_SELECTION_COLLECTION_TTL_MS = 15 * 60 * 1000
const NATIVE_APPOINTMENT_REJECTED_SLOT_TTL_MS = 24 * 60 * 60 * 1000
const NATIVE_APPOINTMENT_SELECTION_PROGRESS_TTL_MS = 24 * 60 * 60 * 1000
const NATIVE_APPOINTMENT_TRANSFER_INTENT_TTL_MS = 24 * 60 * 60 * 1000

function buildNativeTransferProofBindingEventId({ contactId = '', channel = 'whatsapp', receiptMessageId = '' } = {}) {
  const cleanContactId = String(contactId || '').trim()
  const cleanChannel = String(channel || 'whatsapp').trim().toLowerCase()
  const cleanReceiptMessageId = String(receiptMessageId || '').trim()
  if (!cleanContactId || !cleanChannel || !cleanReceiptMessageId) return ''
  return `cae_transfer_proof_${createHash('sha256').update([
    cleanContactId,
    cleanChannel,
    cleanReceiptMessageId
  ].join('\u0000')).digest('hex').slice(0, 48)}`
}

function parseNativeEventDetail(value) {
  try {
    const parsed = value ? JSON.parse(value) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeNativeAppointmentChannel(value = '') {
  return String(value || '').trim().toLowerCase()
}

function nativeAppointmentEventMatchesChannel(detail = {}, channel = '', { allowLegacy = true } = {}) {
  const expectedChannel = normalizeNativeAppointmentChannel(channel)
  const eventChannel = normalizeNativeAppointmentChannel(detail?.channel)
  if (!eventChannel) return allowLegacy
  return Boolean(expectedChannel) && eventChannel === expectedChannel
}

function nativeAppointmentReferenceMatches({
  detail = {},
  channel = '',
  calendarId = '',
  purpose = 'book',
  appointmentId = '',
  previewScopeId = ''
} = {}) {
  const normalizedPurpose = purpose === 'reschedule' ? 'reschedule' : 'book'
  const normalizedAppointmentId = normalizedPurpose === 'reschedule'
    ? String(appointmentId || '').trim()
    : ''
  const detailPurpose = String(detail?.purpose || 'book').trim() === 'reschedule'
    ? 'reschedule'
    : 'book'
  const detailPreviewScopeId = String(detail?.previewScopeId || '').trim()
  return String(detail?.calendarId || '').trim() === String(calendarId || '').trim() &&
    nativeAppointmentEventMatchesChannel(detail, channel, { allowLegacy: false }) &&
    detailPurpose === normalizedPurpose &&
    String(detail?.appointmentId || '').trim() === normalizedAppointmentId &&
    (previewScopeId
      ? detailPreviewScopeId === String(previewScopeId).trim()
      : !detailPreviewScopeId)
}

function buildNativeAppointmentSelectionProgressEventId({ ctx, config } = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  if (!agentId || !contactId || !channel || (ctx?.dryRun && !previewScopeId)) return ''
  return `cae_appointment_progress_${createHash('sha256').update([
    agentId,
    contactId,
    channel,
    previewScopeId
  ].join('\u0000')).digest('hex').slice(0, 48)}`
}

async function persistNativeAppointmentSelectionProgress({
  ctx,
  config,
  calendarId,
  purpose = 'book',
  appointmentId = '',
  timezone = '',
  selectedDate = null,
  selectedTime = null,
  selectedStartTime = null,
  displayedRanges = [],
  availabilityCheckedAt = null,
  availabilityVerificationRequired = false,
  lastError = null,
  status = 'collecting_time',
  allowSelectedDateReplacement = false
} = {}) {
  const eventId = buildNativeAppointmentSelectionProgressEventId({ ctx, config })
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  const cleanCalendarId = String(calendarId || '').trim()
  const normalizedPurpose = purpose === 'reschedule' ? 'reschedule' : 'book'
  const normalizedAppointmentId = normalizedPurpose === 'reschedule'
    ? String(appointmentId || '').trim()
    : ''
  const resolvedTimezone = resolveTimezone(timezone)
  const cleanSelectedDate = String(selectedDate || '').trim() || null
  const cleanSelectedTime = normalizeNativeAvailabilityTime(selectedTime) || null
  const cleanSelectedStartTime = String(selectedStartTime || '').trim() || null
  const cleanAvailabilityVerificationRequired = availabilityVerificationRequired === true
  const cleanLastErrorCode = String(lastError?.code || lastError || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '_')
    .slice(0, 120)
  const allowedStatuses = new Set([
    'browsing',
    'collecting_date',
    'collecting_time',
    'restarted',
    'cancelled',
    'superseded',
    'materialized'
  ])
  const cleanStatus = allowedStatuses.has(String(status || '').trim())
    ? String(status).trim()
    : 'browsing'
  if (
    !eventId || !agentId || !contactId || !channel || !cleanCalendarId ||
    (normalizedPurpose === 'reschedule' && !normalizedAppointmentId)
  ) {
    throw new Error('No se pudo identificar el estado progresivo de la cita')
  }
  if (cleanSelectedDate) {
    const normalizedDate = normalizeDateOnlyInTimezone(cleanSelectedDate, resolvedTimezone)
    const parsedDate = DateTime.fromISO(normalizedDate, { zone: resolvedTimezone })
    if (!parsedDate.isValid || parsedDate.toISODate() !== cleanSelectedDate) {
      throw new Error('La fecha seleccionada no es una fecha de negocio válida')
    }
    if (cleanStatus === 'collecting_time' && cleanSelectedDate < businessTodayDateOnly(resolvedTimezone)) {
      throw new Error('La fecha seleccionada ya pasó en la zona horaria del negocio')
    }
  }
  if (cleanStatus === 'collecting_time' && !cleanSelectedDate) {
    throw new Error('El estado de cita pendiente de hora perdió la fecha seleccionada')
  }
  if (cleanAvailabilityVerificationRequired && cleanStatus !== 'collecting_time') {
    throw new Error('La revalidación de disponibilidad requiere conservar una fecha seleccionada')
  }
  if (cleanStatus === 'collecting_date' && cleanSelectedDate) {
    throw new Error('El estado de cita pendiente de fecha no puede conservar un día anterior')
  }

  const updatedAt = new Date().toISOString()
  const detail = {
    schemaVersion: 1,
    agentId,
    contactId,
    channel,
    previewScopeId: previewScopeId || null,
    calendarId: cleanCalendarId,
    selectedCalendar: cleanCalendarId,
    purpose: normalizedPurpose,
    appointmentId: normalizedAppointmentId || null,
    selectedDate: cleanSelectedDate,
    selectedTime: cleanSelectedTime,
    selectedStartTime: cleanSelectedStartTime,
    selectedTimezone: resolvedTimezone,
    previouslyShownRanges: (Array.isArray(displayedRanges) ? displayedRanges : []).slice(0, 32),
    availabilityCheckedAt: availabilityCheckedAt || null,
    availabilityVerificationRequired: cleanAvailabilityVerificationRequired,
    lastError: cleanLastErrorCode
      ? {
          code: cleanLastErrorCode,
          at: String(lastError?.at || updatedAt)
        }
      : null,
    appointmentStatus: cleanStatus,
    missingFields: cleanAvailabilityVerificationRequired
      ? ['availability']
      : cleanStatus === 'collecting_time'
        ? ['time']
      : (cleanStatus === 'collecting_date' ? ['date'] : []),
    sourceExecutionId: String(ctx?.executionId || '').trim() || null,
    updatedAt,
    expiresAt: new Date(Date.now() + NATIVE_APPOINTMENT_SELECTION_PROGRESS_TTL_MS).toISOString()
  }
  const detailJson = JSON.stringify(detail)
  if (Buffer.byteLength(detailJson, 'utf8') > 3900) {
    throw new Error('El estado progresivo de la cita excede el límite seguro del ledger')
  }
  const current = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [eventId]
  )
  const currentDetail = parseNativeEventDetail(current?.detail_json)
  const expectedUpdatedAt = String(ctx?.appointmentSelectionProgress?.updatedAt || '').trim()
  const expectedFingerprint = String(ctx?.appointmentSelectionProgress?.stateFingerprint || '').trim()
  const currentFingerprint = current
    ? createHash('sha256').update(String(current.detail_json || '')).digest('hex')
    : ''
  const currentExpiresAtMs = Date.parse(String(currentDetail.expiresAt || ''))
  const currentPurpose = String(currentDetail.purpose || '')
  const currentPurposeIsValid = currentPurpose === 'reschedule'
    ? Boolean(String(currentDetail.appointmentId || '').trim())
    : currentPurpose === 'book' && !String(currentDetail.appointmentId || '').trim()
  const currentPreviewScopeId = String(currentDetail.previewScopeId || '').trim()
  const currentSelectedDate = String(currentDetail.selectedDate || '').trim()
  const currentSelectedDateParsed = DateTime.fromISO(currentSelectedDate, {
    zone: String(currentDetail.selectedTimezone || resolvedTimezone)
  })
  const currentStatus = String(currentDetail.appointmentStatus || '')
  const currentAvailabilityVerificationRequired = currentDetail.availabilityVerificationRequired === true
  const knownProgressStatuses = new Set(['browsing', 'collecting_date', 'collecting_time', 'restarted', 'cancelled', 'superseded', 'materialized'])
  const currentCollectingShapeIsValid = currentStatus === 'collecting_time'
    ? Boolean(
        currentSelectedDateParsed.isValid &&
        currentSelectedDateParsed.toISODate() === currentSelectedDate &&
        Array.isArray(currentDetail.missingFields) &&
        currentDetail.missingFields.length === 1 &&
        currentDetail.missingFields[0] === (
          currentAvailabilityVerificationRequired ? 'availability' : 'time'
        ) &&
        (!currentAvailabilityVerificationRequired || !currentDetail.availabilityCheckedAt)
      )
    : currentStatus === 'collecting_date'
      ? Boolean(
          !currentSelectedDate &&
          Array.isArray(currentDetail.missingFields) &&
          currentDetail.missingFields.length === 1 &&
          currentDetail.missingFields[0] === 'date'
        )
      : true
  const currentIsKnownProgressRecord = Boolean(
    current?.event_type === NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT &&
    String(current?.contact_id || '') === contactId &&
    String(current?.agent_id || '') === agentId &&
    Number(currentDetail.schemaVersion || 0) === 1 &&
    String(currentDetail.channel || '') === channel &&
    String(currentDetail.calendarId || '').trim() &&
    String(currentDetail.selectedCalendar || '') === String(currentDetail.calendarId || '') &&
    String(currentDetail.selectedTimezone || '').trim() &&
    currentPurposeIsValid &&
    knownProgressStatuses.has(currentStatus) &&
    currentCollectingShapeIsValid &&
    (ctx?.dryRun ? currentPreviewScopeId === previewScopeId : !currentPreviewScopeId)
  )
  const currentIsValidActiveProgress = Boolean(
    currentIsKnownProgressRecord &&
    ['collecting_date', 'collecting_time'].includes(currentStatus) &&
    String(currentDetail.calendarId || '') === cleanCalendarId &&
    String(currentDetail.selectedCalendar || '') === cleanCalendarId &&
    String(currentDetail.selectedTimezone || '') === resolvedTimezone &&
    currentPurposeIsValid &&
    currentCollectingShapeIsValid &&
    (currentStatus !== 'collecting_time' || currentSelectedDate >= businessTodayDateOnly(resolvedTimezone)) &&
    Number.isFinite(currentExpiresAtMs) &&
    currentExpiresAtMs > Date.now() &&
    (ctx?.dryRun ? currentPreviewScopeId === previewScopeId : !currentPreviewScopeId)
  )
  const changesActiveSelectionDate = Boolean(
    currentIsValidActiveProgress &&
    ['browsing', 'collecting_date', 'collecting_time'].includes(cleanStatus) &&
    currentSelectedDate !== String(cleanSelectedDate || '')
  )
  if (
    currentIsKnownProgressRecord &&
    currentPreviewScopeId &&
    currentStatus === 'materialized' &&
    cleanStatus !== 'materialized'
  ) {
    throw Object.assign(
      new Error('La cita de esta sesión de prueba ya fue materializada; reinicia el tester antes de abrir otra selección.'),
      { code: 'appointment_preview_already_materialized' }
    )
  }
  if (
    current &&
    (
      current.event_type !== NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT ||
      String(current.contact_id || '') !== contactId ||
      String(current.agent_id || '') !== agentId ||
      (expectedFingerprint && currentFingerprint !== expectedFingerprint) ||
      (expectedUpdatedAt && String(currentDetail.updatedAt || '') !== expectedUpdatedAt) ||
      (changesActiveSelectionDate && allowSelectedDateReplacement !== true) ||
      (!expectedFingerprint && !expectedUpdatedAt && (
        !currentIsKnownProgressRecord || currentIsValidActiveProgress
      ))
    )
  ) {
    throw Object.assign(
      new Error('La selección de cita cambió en otra ejecución antes de guardar este turno'),
      { code: 'appointment_progress_state_conflict' }
    )
  }
  const write = current
    ? await db.run(
        `UPDATE conversational_agent_events
         SET detail_json = ?
         WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = ? AND detail_json = ?`,
        [
          detailJson,
          eventId,
          contactId,
          agentId,
          NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT,
          current.detail_json
        ]
      )
    : await db.run(
        `INSERT INTO conversational_agent_events
          (id, contact_id, agent_id, event_type, detail_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [eventId, contactId, agentId, NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT, detailJson]
      )
  if (Number(write?.changes ?? write?.rowCount ?? 0) !== 1) {
    throw Object.assign(
      new Error('La selección de cita cambió mientras se guardaba este turno'),
      { code: 'appointment_progress_state_conflict' }
    )
  }
  const stored = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [eventId]
  )
  const storedDetail = parseNativeEventDetail(stored?.detail_json)
  if (
    stored?.event_type !== NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT ||
    String(stored?.contact_id || '') !== contactId ||
    String(stored?.agent_id || '') !== agentId ||
    String(storedDetail.updatedAt || '') !== updatedAt ||
    String(storedDetail.calendarId || '') !== cleanCalendarId ||
    String(storedDetail.appointmentStatus || '') !== cleanStatus
  ) {
    throw new Error('El estado progresivo de la cita no quedó guardado de forma íntegra')
  }
  const context = {
    active: ['collecting_date', 'collecting_time'].includes(cleanStatus),
    ...storedDetail,
    eventId,
    stateFingerprint: createHash('sha256').update(String(stored.detail_json || '')).digest('hex')
  }
  ctx.appointmentSelectionProgress = context
  return context
}

/**
 * Hidrata únicamente una selección parcial todavía vigente. Puede faltar la
 * fecha o sólo la hora. La oferta individual
 * mantiene su propio contrato durable y siempre tiene prioridad sobre este
 * estado de exploración.
 */
export async function loadConversationalAppointmentSelectionProgressContext({ ctx, config } = {}) {
  const scheduleCapability = getNativeCapability(ctx, config, 'schedule_appointment')
  if (!scheduleCapability || ctx?.appointmentOfferDecision?.active === true) return null
  const eventId = buildNativeAppointmentSelectionProgressEventId({ ctx, config })
  if (!eventId) return null
  const row = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [eventId]
  )
  const detail = parseNativeEventDetail(row?.detail_json)
  const expiresAtMs = Date.parse(String(detail.expiresAt || ''))
  const calendar = await resolveNativeScheduleCalendar(scheduleCapability)
  const currentTimezone = resolveTimezone(await getAccountTimezone().catch(() => detail.selectedTimezone))
  const selectedDate = String(detail.selectedDate || '').trim()
  const parsedSelectedDate = DateTime.fromISO(selectedDate, { zone: currentTimezone })
  const selectedDateIsValid = parsedSelectedDate.isValid && parsedSelectedDate.toISODate() === selectedDate
  const baseIdentityMatches = Boolean(
    row?.event_type === NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT &&
    String(row?.contact_id || '') === String(ctx?.contactId || '').trim() &&
    String(row?.agent_id || '') === String(config?.id || ctx?.agentId || '').trim() &&
    String(detail.channel || '') === normalizeNativeAppointmentChannel(ctx?.channel) &&
    (ctx?.dryRun
      ? String(detail.previewScopeId || '') === String(ctx?.previewScopeId || '').trim()
      : !String(detail.previewScopeId || '').trim())
  )
  const knownProgressSchema = Number(detail.schemaVersion || 0) === 1
  let rescheduleTarget = null
  let rescheduleTargetLookupFailed = false
  if (baseIdentityMatches && knownProgressSchema && detail.purpose === 'reschedule') {
    try {
      rescheduleTarget = await loadOwnedConversationalAppointment({
        ctx,
        calendarId: detail.calendarId,
        appointmentId: detail.appointmentId,
        throwOnError: true
      })
    } catch {
      rescheduleTargetLookupFailed = true
    }
  }
  const reschedulePermissionIsValid = detail.purpose !== 'reschedule' || nativeCalendarPermissionEnabled(
    calendar?.allow_reschedule
  )
  const rescheduleTargetIsValid = detail.purpose !== 'reschedule' || Boolean(
    !rescheduleTargetLookupFailed &&
    reschedulePermissionIsValid &&
    rescheduleTarget &&
    !INACTIVE_APPOINTMENT_STATUSES.has(nativeAppointmentStatus(rescheduleTarget))
  )
  const collectingStatus = String(detail.appointmentStatus || '')
  const availabilityVerificationRequired = detail.availabilityVerificationRequired === true
  const collectingShapeIsValid = collectingStatus === 'collecting_time'
    ? Boolean(
        selectedDateIsValid &&
        selectedDate >= businessTodayDateOnly(currentTimezone) &&
        Array.isArray(detail.missingFields) &&
        detail.missingFields.length === 1 &&
        detail.missingFields[0] === (
          availabilityVerificationRequired ? 'availability' : 'time'
        ) &&
        (!availabilityVerificationRequired || !detail.availabilityCheckedAt)
      )
    : collectingStatus === 'collecting_date'
      ? Boolean(
          !selectedDate &&
          Array.isArray(detail.missingFields) &&
          detail.missingFields.length === 1 &&
          detail.missingFields[0] === 'date'
        )
      : false
  const valid = Boolean(
    baseIdentityMatches &&
    String(detail.calendarId || '') === String(calendar?.id || '') &&
    String(detail.selectedCalendar || '') === String(calendar?.id || '') &&
    ['book', 'reschedule'].includes(String(detail.purpose || '')) &&
    (String(detail.purpose || '') === 'reschedule'
      ? Boolean(String(detail.appointmentId || '').trim())
      : !String(detail.appointmentId || '').trim()) &&
    rescheduleTargetIsValid &&
    String(detail.selectedTimezone || '') === currentTimezone &&
    knownProgressSchema &&
    collectingShapeIsValid &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > Date.now()
  )
  if (!valid) {
    // Un progreso vencido o ligado a una configuración anterior no puede
    // quedarse eternamente activo: además de bloquear una búsqueda
    // nueva, reviviría si el calendario o la zona regresaran al valor anterior.
    // Lo cerramos por CAS; una escritura concurrente más nueva siempre gana.
    if (
      baseIdentityMatches &&
      knownProgressSchema &&
      !rescheduleTargetLookupFailed &&
      ['collecting_date', 'collecting_time'].includes(String(detail.appointmentStatus || ''))
    ) {
      const invalidatedAt = new Date().toISOString()
      let invalidationReason = 'invalid_scope'
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        invalidationReason = 'expired'
      } else if (selectedDate && selectedDate < businessTodayDateOnly(currentTimezone)) {
        invalidationReason = 'selected_date_elapsed'
      } else if (!calendar?.id || String(detail.calendarId || '') !== String(calendar.id)) {
        invalidationReason = 'calendar_changed'
      } else if (String(detail.selectedTimezone || '') !== currentTimezone) {
        invalidationReason = 'timezone_changed'
      } else if (!reschedulePermissionIsValid) {
        invalidationReason = 'reschedule_permission_changed'
      } else if (!rescheduleTargetIsValid) {
        invalidationReason = 'reschedule_target_changed'
      }
      await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND event_type = ? AND detail_json = ?`,
        [JSON.stringify({
          ...detail,
          appointmentStatus: 'superseded',
          missingFields: [],
          invalidatedAt,
          invalidationReason
        }), eventId, NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT, row.detail_json]
      ).catch(() => undefined)
    }
    return null
  }
  return {
    active: true,
    eventId,
    ...detail,
    stateFingerprint: createHash('sha256').update(String(row.detail_json || '')).digest('hex')
  }
}

async function persistNativeAppointmentOptionsReference({
  ctx,
  config,
  calendarId,
  purpose = 'book',
  appointmentId = '',
  timezone = '',
  rangeStartDate = '',
  rangeEndDate = '',
  displayedStartTimes = []
} = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  const normalizedPurpose = purpose === 'reschedule' ? 'reschedule' : 'book'
  const normalizedAppointmentId = normalizedPurpose === 'reschedule'
    ? String(appointmentId || '').trim()
    : ''
  if (
    !agentId || !contactId || !channel || !String(calendarId || '').trim() ||
    (ctx?.dryRun && !previewScopeId) ||
    (normalizedPurpose === 'reschedule' && !normalizedAppointmentId)
  ) {
    throw new Error('No se pudo identificar de forma durable la lista de horarios')
  }

  const resolvedTimezone = resolveTimezone(timezone)
  const displayed = (Array.isArray(displayedStartTimes) ? displayedStartTimes : [])
    .flatMap((startTime) => {
      const canonical = buildCanonicalAppointmentSlotOption(startTime, resolvedTimezone)
      return canonical
        ? [{
            startTime: canonical.startTime,
            localDate: canonical.localDate,
            localTime: canonical.localTime,
            timezone: canonical.timezone,
            epochMinute: nativeAppointmentEpochMinute(canonical.startTime)
          }]
        : []
    })
    .filter((item) => item.localTime && item.epochMinute !== null)
    .sort((left, right) => (
      left.localTime.localeCompare(right.localTime) || left.epochMinute - right.epochMinute
    ))
  if (!displayed.length) throw new Error('La lista no conserva referencias de horario válidas')

  const displayedAt = new Date().toISOString()
  const detail = {
    agentId,
    contactId,
    channel,
    calendarId: String(calendarId).trim(),
    purpose: normalizedPurpose,
    appointmentId: normalizedAppointmentId || null,
    previewScopeId: previewScopeId || null,
    timezone: resolvedTimezone,
    rangeStartDate: String(rangeStartDate || '').trim() || null,
    rangeEndDate: String(rangeEndDate || '').trim() || null,
    minimumDisplayedStartTime: displayed[0].startTime,
    maximumDisplayedStartTime: displayed.at(-1).startTime,
    displayedAt,
    expiresAt: new Date(Date.now() + NATIVE_APPOINTMENT_REJECTED_SLOT_TTL_MS).toISOString()
  }
  const recorded = await recordConversationalAgentEvent({
    contactId,
    eventType: NATIVE_APPOINTMENT_OPTIONS_REFERENCE_EVENT,
    detail,
    throwOnError: true
  })
  if (!recorded?.inserted || !recorded?.id) {
    throw new Error('No se pudo guardar la referencia durable de la lista')
  }
  const stored = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [recorded.id]
  )
  const storedDetail = parseNativeEventDetail(stored?.detail_json)
  if (
    stored?.event_type !== NATIVE_APPOINTMENT_OPTIONS_REFERENCE_EVENT ||
    String(stored?.contact_id || '') !== contactId ||
    String(stored?.agent_id || '') !== agentId ||
    !nativeAppointmentReferenceMatches({
      detail: storedDetail,
      channel,
      calendarId,
      purpose: normalizedPurpose,
      appointmentId: normalizedAppointmentId,
      previewScopeId
    }) ||
    String(storedDetail.minimumDisplayedStartTime || '') !== detail.minimumDisplayedStartTime ||
    String(storedDetail.maximumDisplayedStartTime || '') !== detail.maximumDisplayedStartTime ||
    String(storedDetail.displayedAt || '') !== displayedAt
  ) {
    throw new Error('La referencia durable de la lista quedó incompleta')
  }
  return { id: recorded.id, detail }
}

async function loadNativeAppointmentRelativeReference({
  ctx,
  config,
  calendarId,
  purpose = 'book',
  appointmentId = '',
  timezone = ''
} = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  if (!agentId || !contactId || !channel || !String(calendarId || '').trim()) return null
  if (ctx?.dryRun && !previewScopeId) return null

  const individualEventType = previewScopeId
    ? CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT
    : NATIVE_APPOINTMENT_OFFER_EVENT
  const rows = await db.all(
    `SELECT id, event_type, detail_json
     FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type IN (?, ?)
     ORDER BY created_at DESC, id DESC LIMIT 160`,
    [
      contactId,
      agentId,
      NATIVE_APPOINTMENT_OPTIONS_REFERENCE_EVENT,
      individualEventType
    ]
  )
  const now = Date.now()
  const candidates = []
  for (const row of rows || []) {
    const detail = parseNativeEventDetail(row?.detail_json)
    if (!nativeAppointmentReferenceMatches({
      detail,
      channel,
      calendarId,
      purpose,
      appointmentId,
      previewScopeId
    })) continue

    if (row.event_type === NATIVE_APPOINTMENT_OPTIONS_REFERENCE_EVENT) {
      const displayedAtMs = Date.parse(String(detail.displayedAt || ''))
      const expiresAtMs = Date.parse(String(detail.expiresAt || ''))
      if (
        !Number.isFinite(displayedAtMs) ||
        !Number.isFinite(expiresAtMs) ||
        displayedAtMs > now ||
        expiresAtMs <= now ||
        now - displayedAtMs > NATIVE_APPOINTMENT_REJECTED_SLOT_TTL_MS
      ) continue
      const minimum = buildCanonicalAppointmentSlotOption(
        detail.minimumDisplayedStartTime,
        resolveTimezone(detail.timezone, timezone)
      )
      const maximum = buildCanonicalAppointmentSlotOption(
        detail.maximumDisplayedStartTime,
        resolveTimezone(detail.timezone, timezone)
      )
      if (!minimum?.localTime || !maximum?.localTime || minimum.localTime > maximum.localTime) continue
      candidates.push({
        kind: 'list',
        referenceAtMs: displayedAtMs,
        minimum: {
          startTime: minimum.startTime,
          localDate: minimum.localDate,
          localTime: minimum.localTime,
          timezone: minimum.timezone
        },
        maximum: {
          startTime: maximum.startTime,
          localDate: maximum.localDate,
          localTime: maximum.localTime,
          timezone: maximum.timezone
        }
      })
      continue
    }

    const status = String(detail.status || '')
    const resolution = String(detail.resolution || '')
    const resolvedAtMs = Date.parse(String(detail.resolvedAt || ''))
    const offeredAtMs = Date.parse(String(detail.offeredAt || ''))
    const rejectedForOtherOptions = Boolean(
      status === 'superseded' &&
      resolution === 'request_other_options' &&
      Number.isFinite(resolvedAtMs) &&
      resolvedAtMs <= now &&
      now - resolvedAtMs <= NATIVE_APPOINTMENT_REJECTED_SLOT_TTL_MS
    )
    if (
      row.event_type !== individualEventType ||
      !rejectedForOtherOptions ||
      nativeAppointmentEpochMinute(detail.startTime) === null
    ) continue
    const offerTimezone = resolveTimezone(detail.timezone, timezone)
    const canonical = buildCanonicalAppointmentSlotOption(detail.startTime, offerTimezone)
    if (!canonical?.localDate || !canonical?.localTime) continue
    candidates.push({
      kind: 'individual',
      referenceAtMs: rejectedForOtherOptions ? resolvedAtMs : offeredAtMs,
      startTime: canonical.startTime,
      localDate: canonical.localDate,
      localTime: canonical.localTime,
      timezone: canonical.timezone
    })
  }
  candidates.sort((left, right) => (
    right.referenceAtMs - left.referenceAtMs ||
    (left.kind === right.kind ? 0 : (left.kind === 'individual' ? -1 : 1))
  ))
  return candidates[0] || null
}

function nativeRejectedAppointmentStartTimesFromDetail(detail = {}, { preview = false } = {}) {
  const carried = Array.isArray(detail?.rejectedStartTimes) ? detail.rejectedStartTimes : []
  const resolvedAtMs = Date.parse(String(detail?.resolvedAt || ''))
  const recentRequestForOtherOptions = Boolean(
    String(detail?.status || '') === 'superseded' &&
    String(detail?.resolution || '') === 'request_other_options' &&
    Number.isFinite(resolvedAtMs) &&
    Date.now() - resolvedAtMs <= NATIVE_APPOINTMENT_REJECTED_SLOT_TTL_MS
  )
  return mergeNativeRejectedAppointmentStartTimes(
    preview || recentRequestForOtherOptions ? carried : [],
    recentRequestForOtherOptions ? [detail?.startTime] : []
  )
}

async function loadRecentNativeRejectedAppointmentStartTimes({ ctx, config, calendarId } = {}) {
  const contactId = String(ctx?.contactId || '').trim()
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const cleanCalendarId = String(calendarId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  if (!contactId || !agentId || !cleanCalendarId || (ctx?.dryRun && !previewScopeId)) return []

  const rows = previewScopeId
    ? [await db.get(
        `SELECT detail_json FROM conversational_agent_events
         WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = ?`,
        [
          buildConversationalAppointmentPreviewOfferEventId(previewScopeId),
          contactId,
          agentId,
          CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT
        ]
      )].filter(Boolean)
    : await db.all(
        `SELECT detail_json FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = ?
         ORDER BY created_at DESC, id DESC LIMIT 120`,
        [contactId, agentId, NATIVE_APPOINTMENT_OFFER_EVENT]
      )

  return mergeNativeRejectedAppointmentStartTimes(...(rows || []).flatMap((row) => {
    const detail = parseNativeEventDetail(row?.detail_json)
    if (
      String(detail?.calendarId || '') !== cleanCalendarId ||
      !nativeAppointmentEventMatchesChannel(detail, channel) ||
      (previewScopeId && String(detail?.previewScopeId || '') !== previewScopeId)
    ) return []
    return [nativeRejectedAppointmentStartTimesFromDetail(detail, { preview: Boolean(previewScopeId) })]
  }))
}

async function hydrateNativeRejectedAppointmentStartTimes({ ctx, config, calendarId } = {}) {
  const cleanCalendarId = String(calendarId || '').trim()
  if (
    ctx?.nativeRejectedAppointmentStartTimesHydrated === true &&
    String(ctx?.nativeRejectedAppointmentCalendarId || '') === cleanCalendarId
  ) return Array.isArray(ctx.rejectedAppointmentStartTimes) ? ctx.rejectedAppointmentStartTimes : []

  const durable = await loadRecentNativeRejectedAppointmentStartTimes({ ctx, config, calendarId: cleanCalendarId })
  ctx.rejectedAppointmentStartTimes = mergeNativeRejectedAppointmentStartTimes(
    ctx.rejectedAppointmentStartTimes,
    durable
  )
  ctx.nativeRejectedAppointmentStartTimesHydrated = true
  ctx.nativeRejectedAppointmentCalendarId = cleanCalendarId
  return ctx.rejectedAppointmentStartTimes
}

function appointmentSelectionError(message, code = 'appointment_selection_required') {
  return { ok: false, actionCompleted: false, confirmationRequired: true, code, error: message }
}

function appointmentAuthorityRevalidationUnavailable() {
  return {
    ok: false,
    actionCompleted: false,
    code: 'appointment_authority_revalidation_failed',
    statusCode: 503,
    retryable: true,
    appointmentOfferInvalidated: false,
    appointmentOfferRestoreSameDate: false,
    error: 'No se pudo comprobar de forma segura que la confirmación siga vigente. No se aplicó ningún cambio; vuelve a intentarlo en un momento.'
  }
}

async function lockNativeAppointmentPreviewAuthority({ ctx, config } = {}) {
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  const eventId = buildConversationalAppointmentPreviewAuthorityEventId(previewScopeId)
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  if (!eventId || !agentId || !contactId || !channel) {
    throw new Error('La sesión de prueba no conserva una identidad para serializar la agenda')
  }
  const detail = {
    schemaVersion: 1,
    agentId,
    contactId,
    channel,
    previewScopeId,
    expiresAt: new Date(Date.now() + NATIVE_APPOINTMENT_SELECTION_PROGRESS_TTL_MS).toISOString()
  }
  await db.run(
    `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    [eventId, contactId, agentId, CONVERSATIONAL_APPOINTMENT_PREVIEW_AUTHORITY_EVENT, JSON.stringify(detail)]
  )
  // En PostgreSQL, un INSERT concurrente sobre el mismo id espera al dueño de
  // la llave única. El FOR UPDATE mantiene después la exclusión hasta COMMIT.
  // Así también se serializa el primer turno, cuando todavía no hay offer ni
  // progress que pudieran servir como fila de candado.
  const row = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
    [eventId]
  )
  const stored = parseNativeEventDetail(row?.detail_json)
  if (
    row?.event_type !== CONVERSATIONAL_APPOINTMENT_PREVIEW_AUTHORITY_EVENT ||
    String(row?.contact_id || '') !== contactId ||
    String(row?.agent_id || '') !== agentId ||
    Number(stored.schemaVersion || 0) !== 1 ||
    String(stored.contactId || '') !== contactId ||
    String(stored.agentId || '') !== agentId ||
    String(stored.channel || '') !== channel ||
    String(stored.previewScopeId || '') !== previewScopeId
  ) {
    throw new Error('La autoridad de agenda del tester ya existe con otra identidad')
  }
  return { eventId, detail: stored }
}

async function lockAndDetectPendingNativeAppointmentOffer({ ctx, config } = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  if (!agentId || !contactId || !channel || (ctx?.dryRun && !previewScopeId)) {
    throw new Error('No se pudo identificar la autoridad vigente de la selección de cita')
  }

  if (previewScopeId) {
    await lockNativeAppointmentPreviewAuthority({ ctx, config })
  } else {
    const contactLock = await db.get(
      `SELECT id FROM contacts WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
      [contactId]
    )
    if (!contactLock?.id) throw new Error('El contacto dejó de existir antes de guardar la selección de cita')
  }

  const eventType = previewScopeId
    ? CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT
    : NATIVE_APPOINTMENT_OFFER_EVENT
  const rows = previewScopeId
    ? [await db.get(
        `SELECT id, contact_id, agent_id, event_type, detail_json
         FROM conversational_agent_events WHERE id = ?`,
        [buildConversationalAppointmentPreviewOfferEventId(previewScopeId)]
      )].filter(Boolean)
    : await db.all(
        `SELECT id, contact_id, agent_id, event_type, detail_json
         FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = ?`,
        [contactId, agentId, eventType]
      )

  return (rows || []).some((row) => {
    const detail = parseNativeEventDetail(row?.detail_json)
    return row?.event_type === eventType &&
      String(row?.contact_id || '') === contactId &&
      String(row?.agent_id || '') === agentId &&
      nativeAppointmentEventMatchesChannel(detail, channel) &&
      (!previewScopeId || String(detail.previewScopeId || '') === previewScopeId) &&
      ['active', 'resolving_handoff'].includes(String(detail.status || ''))
  })
}

async function refreshNativeAppointmentConversationAuthority({ ctx, config } = {}) {
  ctx.appointmentOfferDecision = null
  ctx.appointmentSelectionProgress = null
  ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({ ctx, config })
    .catch(() => null)
  if (!ctx.appointmentOfferDecision?.active) {
    ctx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({ ctx, config })
      .catch(() => null)
  }
  return {
    offer: ctx.appointmentOfferDecision,
    progress: ctx.appointmentSelectionProgress
  }
}

function appointmentAuthorityConflictTerminalResult({ ctx, fallback = '' } = {}) {
  const offer = ctx?.appointmentOfferDecision
  if (offer?.active) {
    return {
      ok: false,
      actionCompleted: false,
      terminal: true,
      code: offer.preview === true || ctx?.dryRun === true
        ? 'appointment_preview_offer_pending_decision'
        : 'appointment_offer_pending_decision',
      visibleReply: `ya tengo pendiente ${String(offer.localLabel || 'el horario que te mostré').slice(0, 240)}. ¿te funciona?`
    }
  }
  const progress = ctx?.appointmentSelectionProgress
  if (progress?.active) {
    const needsDate = String(progress.appointmentStatus || '') === 'collecting_date'
    const needsAvailabilityVerification = progress.availabilityVerificationRequired === true
    return {
      ok: false,
      actionCompleted: false,
      terminal: true,
      code: 'appointment_progress_state_conflict',
      visibleReply: needsDate
        ? 'la selección cambió mientras la guardaba. ¿qué día te gustaría revisar?'
        : needsAvailabilityVerification
          ? 'ya conservé ese día, pero todavía necesito revalidar la disponibilidad real antes de ofrecerte un horario'
          : 'ya conservé ese día. ¿qué hora te funciona?'
    }
  }
  return {
    ok: false,
    actionCompleted: false,
    terminal: true,
    code: 'appointment_progress_state_conflict',
    visibleReply: String(fallback || 'la selección cambió mientras la guardaba. dime qué hora te funciona y la reviso de nuevo')
  }
}

async function supersedeUnavailableNativeAppointmentOffer({
  ctx,
  config,
  candidate,
  expected,
  restoreSameDate = false,
  rejectStartTime = true,
  reason = 'slot_unavailable'
} = {}) {
  const offer = candidate?.offer
  const canonical = buildCanonicalAppointmentSlotOption(
    offer?.detail?.startTime,
    offer?.detail?.timezone
  )
  if (!offer?.id || !expected?.offerFingerprint) return false
  let resolved = false
  await db.transaction(async () => {
    const contactId = String(ctx?.contactId || '').trim()
    if (ctx?.dryRun) {
      await lockNativeAppointmentPreviewAuthority({ ctx, config })
    } else {
      const contactLock = await db.get(
        `SELECT id FROM contacts WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
        [contactId]
      )
      if (!contactLock?.id) return
    }
    const current = await db.get(
      `SELECT id, contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [offer.id]
    )
    const detail = parseNativeEventDetail(current?.detail_json)
    const fingerprint = createHash('sha256').update(String(current?.detail_json || '')).digest('hex')
    const activeMatches = String(detail.status || '') === 'active' &&
      fingerprint === String(expected.offerFingerprint || '')
    let acceptedSelection = null
    let acceptedSelectionDetail = null
    if (String(detail.status || '') === 'accepted' && detail.selectionEventId) {
      acceptedSelection = await db.get(
        `SELECT id, contact_id, agent_id, event_type, detail_json
         FROM conversational_agent_events WHERE id = ?`,
        [detail.selectionEventId]
      )
      acceptedSelectionDetail = parseNativeEventDetail(acceptedSelection?.detail_json)
    }
    const acceptedByThisExecution = Boolean(
      acceptedSelection?.event_type === NATIVE_APPOINTMENT_SELECTION_EVENT &&
      String(acceptedSelection?.contact_id || '') === contactId &&
      String(acceptedSelection?.agent_id || '') === String(config?.id || ctx?.agentId || '') &&
      String(acceptedSelectionDetail?.status || '') === 'active' &&
      String(acceptedSelectionDetail?.offerEventId || '') === String(current?.id || '') &&
      String(acceptedSelectionDetail?.executionId || '') === String(ctx?.executionId || '').trim()
    )
    if (
      current?.event_type !== offer.event_type ||
      String(current?.contact_id || '') !== contactId ||
      String(current?.agent_id || '') !== String(config?.id || ctx?.agentId || '') ||
      (!activeMatches && !acceptedByThisExecution)
    ) return
    const resolvedAt = new Date().toISOString()
    const nextDetail = {
      ...detail,
      status: 'superseded',
      phase: 'resolved',
      resolution: String(reason || 'slot_unavailable').slice(0, 120),
      resolvedAt,
      resolvedExecutionId: String(ctx?.executionId || '').trim(),
      ...(rejectStartTime
        ? {
            rejectedStartTimes: mergeNativeRejectedAppointmentStartTimes(
              detail.rejectedStartTimes,
              [detail.startTime]
            )
          }
        : {})
    }
    const update = await db.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND event_type = ? AND detail_json = ?`,
      [JSON.stringify(nextDetail), current.id, current.event_type, current.detail_json]
    )
    if (Number(update?.changes ?? update?.rowCount ?? 0) !== 1) return
    if (acceptedByThisExecution) {
      const selectionUpdate = await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND event_type = ? AND detail_json = ?`,
        [
          JSON.stringify({
            ...acceptedSelectionDetail,
            status: 'superseded',
            supersededAt: resolvedAt,
            supersededReason: String(reason || 'slot_unavailable').slice(0, 120)
          }),
          acceptedSelection.id,
          NATIVE_APPOINTMENT_SELECTION_EVENT,
          acceptedSelection.detail_json
        ]
      )
      if (Number(selectionUpdate?.changes ?? selectionUpdate?.rowCount ?? 0) !== 1) {
        throw new Error('La selección aceptada cambió antes de cerrar el horario inválido')
      }
    }
    if (restoreSameDate && canonical?.localDate) {
      await persistNativeAppointmentSelectionProgress({
        ctx,
        config,
        calendarId: detail.calendarId,
        purpose: detail.purpose,
        appointmentId: detail.appointmentId || '',
        timezone: detail.timezone,
        selectedDate: canonical.localDate,
        selectedTime: null,
        selectedStartTime: null,
        displayedRanges: [],
        availabilityCheckedAt: null,
        status: 'collecting_time'
      })
    }
    resolved = true
  })
  if (resolved) {
    ctx.appointmentOfferDecision = null
    if (rejectStartTime) {
      ctx.rejectedAppointmentStartTimes = mergeNativeRejectedAppointmentStartTimes(
        ctx.rejectedAppointmentStartTimes,
        [offer.detail.startTime]
      )
    }
    delete ctx.nativeAppointmentAvailability
    ctx.requireFreshAppointmentAvailability = true
  }
  return resolved
}

/**
 * Cierra únicamente la oferta que creó esta ejecución cuando sabemos que no
 * salió ni una parte de la respuesta. La fecha vuelve a collecting_time y el
 * horario no se marca como rechazado porque la persona nunca alcanzó a verlo.
 */
export async function supersedeUndeliveredConversationalAppointmentOffer({
  ctx,
  config,
  reason = 'offer_not_delivered'
} = {}) {
  if (ctx?.dryRun === true) return false
  const contactId = String(ctx?.contactId || '').trim()
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const action = [...(Array.isArray(ctx?.actions) ? ctx.actions : [])]
    .reverse()
    .find((item) => (
      item?.type === 'offer_appointment_slot' &&
      item?.outcome?.ok === true &&
      String(item?.outcome?.offerEventId || '').trim()
    ))
  const offerEventId = String(action?.outcome?.offerEventId || '').trim()
  if (!contactId || !agentId || !executionId || !channel || !offerEventId) return false

  const row = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [offerEventId]
  )
  const detail = parseNativeEventDetail(row?.detail_json)
  if (
    row?.event_type !== NATIVE_APPOINTMENT_OFFER_EVENT ||
    String(row?.contact_id || '') !== contactId ||
    String(row?.agent_id || '') !== agentId ||
    String(detail.status || '') !== 'active' ||
    String(detail.executionId || '') !== executionId ||
    !nativeAppointmentEventMatchesChannel(detail, channel, { allowLegacy: false })
  ) return false

  return supersedeUnavailableNativeAppointmentOffer({
    ctx,
    config,
    candidate: { offer: { ...row, detail } },
    expected: {
      offerFingerprint: createHash('sha256').update(String(row.detail_json || '')).digest('hex')
    },
    restoreSameDate: true,
    rejectStartTime: false,
    reason
  })
}

const NATIVE_APPOINTMENT_OFFER_COPY_VERSION = 2
const NATIVE_APPOINTMENT_OFFER_SELECTION_CONTEXTS = Object.freeze([
  'selected_from_options',
  'exact_preference',
  'replacement',
  'neutral'
])
const NATIVE_APPOINTMENT_OFFER_SELECTION_CONTEXT_SET = new Set(
  NATIVE_APPOINTMENT_OFFER_SELECTION_CONTEXTS
)

function normalizeNativeAppointmentOfferSelectionContext(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return NATIVE_APPOINTMENT_OFFER_SELECTION_CONTEXT_SET.has(normalized)
    ? normalized
    : 'neutral'
}

function nativeAppointmentOfferLegacyText(localLabel = '') {
  const label = String(localLabel || '').trim()
  const separator = /[.!?]$/u.test(label) ? ' ' : '. '
  return `Tengo disponible ${label}${separator}¿Te funciona ese horario?`
}

function nativeAppointmentOfferText({
  localLabel = '',
  selectionContext = 'neutral',
  purpose = 'book',
  bookingOwner = 'ai',
  depositRequired = false
} = {}) {
  const label = String(localLabel || '').trim()
  const sentenceLabel = /^(?:el|la|los|las)\s/iu.test(label) ? label : `el ${label}`
  const normalizedSelectionContext = normalizeNativeAppointmentOfferSelectionContext(selectionContext)
  const opening = {
    selected_from_options: 'Perfecto, elegiste ',
    exact_preference: 'Sí, el horario que me pediste está disponible: ',
    replacement: 'Va, la nueva opción sería ',
    neutral: 'Perfecto, entonces sería '
  }[normalizedSelectionContext]
  const separator = /[.!?]$/u.test(label) ? ' ' : '. '
  let confirmationQuestion = '¿Confirmas que te agende en ese horario?'

  if (purpose === 'reschedule') {
    confirmationQuestion = bookingOwner === 'human'
      ? '¿Confirmas que envíe al equipo la solicitud para cambiar tu cita a ese horario?'
      : '¿Confirmas que cambie tu cita a ese horario?'
  } else if (depositRequired && bookingOwner === 'human') {
    confirmationQuestion = '¿Confirmas que sigamos con el anticipo para después enviar la solicitud al equipo?'
  } else if (depositRequired) {
    confirmationQuestion = '¿Confirmas que sigamos con el anticipo para ese horario?'
  } else if (bookingOwner === 'human') {
    confirmationQuestion = '¿Confirmas que envíe al equipo la solicitud con ese horario?'
  }

  return `${opening}${sentenceLabel}${separator}${confirmationQuestion}`
}

function nativeAppointmentOfferCopyContractMatches(detail = {}, canonicalLocalLabel = '') {
  const persistedOfferText = String(detail?.offerText || '')
  if (!Object.hasOwn(detail || {}, 'offerCopyVersion')) {
    return persistedOfferText === nativeAppointmentOfferLegacyText(canonicalLocalLabel)
  }
  if (detail.offerCopyVersion !== NATIVE_APPOINTMENT_OFFER_COPY_VERSION) return false
  if (!NATIVE_APPOINTMENT_OFFER_SELECTION_CONTEXT_SET.has(detail.selectionContext)) return false
  if (typeof detail.depositRequiredAtOffer !== 'boolean') return false
  const purpose = detail.purpose === 'reschedule' ? 'reschedule' : 'book'
  if (purpose === 'reschedule' && detail.depositRequiredAtOffer !== false) return false
  const terminalBinding = readBoundNativeAppointmentTerminalBinding(detail)
  if (!terminalBinding) return false
  return persistedOfferText === nativeAppointmentOfferText({
    localLabel: canonicalLocalLabel,
    selectionContext: detail.selectionContext,
    purpose,
    bookingOwner: terminalBinding.bookingOwner,
    depositRequired: detail.depositRequiredAtOffer
  })
}

function nativeAppointmentOfferDepositRequirementChanged(detail = {}, ctx = {}, config = {}) {
  if (
    detail.offerCopyVersion !== NATIVE_APPOINTMENT_OFFER_COPY_VERSION ||
    typeof detail.depositRequiredAtOffer !== 'boolean'
  ) return false
  const purpose = detail.purpose === 'reschedule' ? 'reschedule' : 'book'
  const currentDepositRequired = purpose === 'book' && Boolean(
    getDepositRequirementForRuntime(ctx, config)
  )
  return detail.depositRequiredAtOffer !== currentDepositRequired
}

async function supersedeNativeAppointmentProgressForOffer({
  ctx,
  config,
  offerEventId,
  calendarId,
  purpose,
  appointmentId,
  startTime,
  timezone
} = {}) {
  const expected = ctx?.appointmentSelectionProgress
  const eventId = buildNativeAppointmentSelectionProgressEventId({ ctx, config })
  if (!eventId) return { ok: expected?.active !== true, changed: false }
  const row = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [eventId]
  )
  const detail = parseNativeEventDetail(row?.detail_json)
  const fingerprint = createHash('sha256').update(String(row?.detail_json || '')).digest('hex')
  const normalizedPurpose = purpose === 'reschedule' ? 'reschedule' : 'book'
  const normalizedAppointmentId = normalizedPurpose === 'reschedule'
    ? String(appointmentId || '').trim()
    : ''
  const canonical = buildCanonicalAppointmentSlotOption(startTime, timezone)
  const expiresAtMs = Date.parse(String(detail.expiresAt || ''))
  const availability = ctx?.nativeAppointmentAvailability
  const explicitlyReplacedDate = Boolean(
    availability?.progressDateAction === 'replace_selected_date' &&
    canonical?.localDate &&
    String(availability.startDate || '') === canonical.localDate &&
    String(availability.endDate || '') === canonical.localDate
  )
  if (expected?.active !== true) {
    const progressStatus = String(detail.appointmentStatus || '').trim()
    const knownProgressSchema = Number(detail.schemaVersion || 0) === 1
    const terminalProgressStatuses = new Set(['restarted', 'cancelled', 'superseded'])
    const knownNonTerminalStatuses = new Set(['browsing', 'collecting_date', 'collecting_time'])
    const sameAuthorityIdentity = Boolean(
      row?.event_type === NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT &&
      String(row?.contact_id || '') === String(ctx?.contactId || '').trim() &&
      String(row?.agent_id || '') === String(config?.id || ctx?.agentId || '').trim() &&
      String(detail.channel || '') === normalizeNativeAppointmentChannel(ctx?.channel) &&
      (ctx?.dryRun
        ? String(detail.previewScopeId || '') === String(ctx?.previewScopeId || '').trim()
        : !String(detail.previewScopeId || '').trim())
    )
    const expiryDoesNotProveInactive = !Number.isFinite(expiresAtMs) || expiresAtMs > Date.now()
    const statusCouldStillOwnSelection = Boolean(
      !terminalProgressStatuses.has(progressStatus) &&
      (
        !knownProgressSchema ||
        !knownNonTerminalStatuses.has(progressStatus) ||
        ['collecting_date', 'collecting_time'].includes(progressStatus)
      )
    )
    const serverStillHasActiveProgress = Boolean(
      sameAuthorityIdentity &&
      statusCouldStillOwnSelection &&
      expiryDoesNotProveInactive
    )
    // Un contexto que omitió hidratar una selección vigente no puede crear una
    // oferta en paralelo y dejar dos autoridades activas. Una versión futura o
    // una forma desconocida tampoco se interpreta como inactiva: sólo un estado
    // terminal conocido o un vencimiento comprobable liberan la autoridad.
    return { ok: !serverStillHasActiveProgress, changed: false }
  }
  const identityMatches = Boolean(
    eventId &&
    canonical?.localDate &&
    row?.event_type === NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT &&
    String(row?.contact_id || '') === String(ctx?.contactId || '').trim() &&
    String(row?.agent_id || '') === String(config?.id || ctx?.agentId || '').trim() &&
    String(detail.appointmentStatus || '') === 'collecting_time' &&
    String(detail.calendarId || '') === String(calendarId || '').trim() &&
    String(detail.selectedCalendar || '') === String(calendarId || '').trim() &&
    String(detail.purpose || '') === normalizedPurpose &&
    String(detail.appointmentId || '') === normalizedAppointmentId &&
    String(detail.selectedTimezone || '') === resolveTimezone(timezone) &&
    (
      String(detail.selectedDate || '') === canonical.localDate ||
      explicitlyReplacedDate
    ) &&
    String(expected.eventId || '') === eventId &&
    String(expected.stateFingerprint || '') === fingerprint &&
    String(expected.updatedAt || '') === String(detail.updatedAt || '') &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > Date.now()
  )
  if (!identityMatches) return { ok: false, changed: false }

  const supersededAt = new Date().toISOString()
  const nextDetail = {
    ...detail,
    selectedDate: canonical.localDate,
    selectedTime: canonical.localTime,
    selectedStartTime: String(startTime || '').trim(),
    appointmentStatus: 'superseded',
    missingFields: [],
    updatedAt: supersededAt,
    supersededAt,
    supersededByOfferEventId: String(offerEventId || '').trim()
  }
  const update = await db.run(
    `UPDATE conversational_agent_events SET detail_json = ?
     WHERE id = ? AND event_type = ? AND detail_json = ?`,
    [JSON.stringify(nextDetail), eventId, NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT, row.detail_json]
  )
  return {
    ok: Number(update?.changes ?? update?.rowCount ?? 0) === 1,
    changed: Number(update?.changes ?? update?.rowCount ?? 0) === 1,
    detail: nextDetail
  }
}

async function persistNativeAppointmentOffer({
  ctx,
  config,
  calendarId,
  startTime,
  localLabel,
  timezone,
  purpose = 'book',
  appointmentId = '',
  expectedStartTime = '',
  expectedEndTime = '',
  durationMs = NaN,
  selectionContext = 'neutral'
} = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const offerSourceMessage = [...(Array.isArray(ctx?.conversationMessages) ? ctx.conversationMessages : [])]
    .reverse()
    .find((message) => isCustomerAppointmentMessage(message) && appointmentMessageText(message))
  const offerSourceMessageId = String(offerSourceMessage?.id || executionId).trim()
  const offerSourceMessageQuote = appointmentMessageText(offerSourceMessage)
  const offerSourceMessageQuoteHash = offerSourceMessageQuote
    ? createHash('sha256').update(offerSourceMessageQuote).digest('hex')
    : ''
  const scheduleCapability = getNativeCapability(ctx, config, 'schedule_appointment')
  const terminalToolName = scheduleCapability?.bookingOwner === 'human'
    ? 'request_human_booking'
    : 'book_appointment'
  const terminalBinding = scheduleCapability
    ? buildNativeAppointmentTerminalBinding(scheduleCapability, terminalToolName)
    : null
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  if (ctx?.dryRun && !previewScopeId) {
    return appointmentSelectionError(
      'La sesión del tester no conserva una identidad segura para la oferta. Reinicia el chat de prueba.',
      'appointment_preview_scope_missing'
    )
  }
  const normalizedPurpose = purpose === 'reschedule' ? 'reschedule' : 'book'
  const normalizedAppointmentId = normalizedPurpose === 'reschedule' ? String(appointmentId || '').trim() : ''
  const normalizedExpectedStartTime = normalizedPurpose === 'reschedule'
    ? String(expectedStartTime || '').trim()
    : ''
  const normalizedExpectedEndTime = normalizedPurpose === 'reschedule'
    ? String(expectedEndTime || '').trim()
    : ''
  const normalizedDurationMs = normalizedPurpose === 'reschedule' && Number.isFinite(Number(durationMs))
    ? Number(durationMs)
    : 0
  const normalizedSelectionContext = normalizeNativeAppointmentOfferSelectionContext(selectionContext)
  const depositRequiredAtOffer = normalizedPurpose === 'book' && Boolean(
    getDepositRequirementForRuntime(ctx, config)
  )
  if (
    !agentId || !contactId || !executionId || !calendarId || !startTime || !localLabel || !terminalBinding ||
    (normalizedPurpose === 'reschedule' && (
      !normalizedAppointmentId || !normalizedExpectedStartTime || !normalizedExpectedEndTime || normalizedDurationMs <= 0
    ))
  ) {
    return appointmentSelectionError('No se pudo identificar la oferta de horario. No se mostró ningún horario.', 'appointment_offer_identity_missing')
  }
  const eventType = previewScopeId
    ? CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT
    : NATIVE_APPOINTMENT_OFFER_EVENT
  const eventId = previewScopeId
    ? buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
    : `cae_appointment_offer_${createHash('sha256').update([
        agentId, contactId, channel, calendarId, startTime, executionId, normalizedPurpose,
        normalizedAppointmentId, normalizedExpectedStartTime, normalizedExpectedEndTime, normalizedDurationMs
      ].join('\u0000')).digest('hex').slice(0, 48)}`
  const detail = {
    agentId,
    contactId,
    channel,
    calendarId,
    startTime,
    localLabel,
    timezone,
    executionId,
    offerSourceMessageId,
    offerSourceMessageQuoteHash,
    offerCopyVersion: NATIVE_APPOINTMENT_OFFER_COPY_VERSION,
    selectionContext: normalizedSelectionContext,
    depositRequiredAtOffer,
    offerText: nativeAppointmentOfferText({
      localLabel,
      selectionContext: normalizedSelectionContext,
      purpose: normalizedPurpose,
      bookingOwner: terminalBinding.bookingOwner,
      depositRequired: depositRequiredAtOffer
    }),
    purpose: normalizedPurpose,
    appointmentId: normalizedAppointmentId || null,
    expectedStartTime: normalizedExpectedStartTime || null,
    expectedEndTime: normalizedExpectedEndTime || null,
    durationMs: normalizedDurationMs || null,
    ...terminalBinding,
    status: 'active',
    phase: 'awaiting_decision',
    offeredAt: new Date().toISOString(),
    // Una oferta individual no vence por tiempo. Su horario siempre se vuelve
    // a comprobar contra el calendario justo antes de guardar la cita.
    expiresAt: null,
    ...(previewScopeId ? { previewScopeId } : {})
  }

  let transitionedProgressDetail = null
  const transitionProgress = async () => {
    const transition = await supersedeNativeAppointmentProgressForOffer({
      ctx,
      config,
      offerEventId: eventId,
      calendarId,
      purpose: normalizedPurpose,
      appointmentId: normalizedAppointmentId,
      startTime,
      timezone
    })
    if (!transition.ok) {
      throw Object.assign(
        new Error('La selección parcial cambió mientras se guardaba la oferta individual'),
        { code: 'appointment_progress_transition_conflict' }
      )
    }
    if (transition.changed) transitionedProgressDetail = transition.detail
  }

  try {
    if (previewScopeId) {
      let previewConflict = false
      await db.transaction(async () => {
        await lockNativeAppointmentPreviewAuthority({ ctx, config })
        const inserted = await db.run(
          `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          [eventId, contactId, agentId, eventType, JSON.stringify(detail)]
        )
        if (Number(inserted?.changes ?? inserted?.rowCount ?? 0) !== 1) {
          const current = await db.get(
            `SELECT contact_id, agent_id, event_type, detail_json
             FROM conversational_agent_events WHERE id = ?`,
            [eventId]
          )
          const currentDetail = parseNativeEventDetail(current?.detail_json)
          const currentStatus = String(currentDetail.status || '')
          const currentActive = currentStatus === 'active'
          const exactReplay = Boolean(
            currentActive &&
            String(currentDetail.executionId || '') === executionId &&
            String(currentDetail.calendarId || '') === String(calendarId) &&
            String(currentDetail.startTime || '') === String(startTime) &&
            String(currentDetail.localLabel || '') === String(localLabel) &&
            nativeAppointmentEventMatchesChannel(currentDetail, channel) &&
            String(currentDetail.purpose || 'book') === normalizedPurpose &&
            String(currentDetail.appointmentId || '') === normalizedAppointmentId &&
            String(currentDetail.expectedStartTime || '') === normalizedExpectedStartTime &&
            String(currentDetail.expectedEndTime || '') === normalizedExpectedEndTime &&
            Number(currentDetail.durationMs || 0) === normalizedDurationMs
          )
          if (!exactReplay) {
            if (
              current?.event_type !== eventType ||
              String(current?.contact_id || '') !== contactId ||
              String(current?.agent_id || '') !== agentId ||
              String(currentDetail.previewScopeId || '') !== previewScopeId ||
              (String(currentDetail.channel || '') && String(currentDetail.channel || '') !== String(detail.channel || '')) ||
              currentActive ||
              currentStatus === 'resolving_handoff' ||
              ['accepted', 'materializing', 'materialized'].includes(currentStatus)
            ) {
              previewConflict = true
              return
            }
            const carriedRejectedStartTimes = nativeRejectedAppointmentStartTimesFromDetail(currentDetail, { preview: true })
            const replacementDetail = carriedRejectedStartTimes.length
              ? { ...detail, rejectedStartTimes: carriedRejectedStartTimes }
              : detail
            const updated = await db.run(
              `UPDATE conversational_agent_events SET detail_json = ?
               WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = ? AND detail_json = ?`,
              [JSON.stringify(replacementDetail), eventId, contactId, agentId, eventType, current.detail_json]
            )
            if (Number(updated?.changes ?? updated?.rowCount ?? 0) !== 1) {
              previewConflict = true
              return
            }
          }
        }
        await transitionProgress()
      })
      if (previewConflict) {
        return appointmentSelectionError(
          'Ya hay un horario pendiente de respuesta en esta prueba. Resuelve esa oferta antes de consultar u ofrecer otra.',
          'appointment_preview_offer_pending_decision'
        )
      }
    } else {
      let liveConflict = false
      await db.transaction(async () => {
        const contactLock = await db.get(
          `SELECT id FROM contacts WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
          [contactId]
        )
        if (!contactLock?.id) throw new Error('El contacto dejó de existir antes de guardar la oferta')
        const priorRows = await db.all(
          `SELECT id, detail_json FROM conversational_agent_events
           WHERE contact_id = ? AND agent_id = ? AND event_type = ?`,
          [contactId, agentId, eventType]
        )
        const pendingOffer = (priorRows || []).find((row) => {
          const prior = parseNativeEventDetail(row.detail_json)
          return row.id !== eventId &&
            ['active', 'resolving_handoff'].includes(String(prior.status || '')) &&
            nativeAppointmentEventMatchesChannel(prior, channel)
        })
        if (pendingOffer) {
          liveConflict = true
          return
        }
        const inserted = await db.run(
          `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          [eventId, contactId, agentId, eventType, JSON.stringify(detail)]
        )
        if (Number(inserted?.changes ?? inserted?.rowCount ?? 0) !== 1) {
          const current = await db.get(
            `SELECT contact_id, agent_id, event_type, detail_json
             FROM conversational_agent_events WHERE id = ?`,
            [eventId]
          )
          const currentDetail = parseNativeEventDetail(current?.detail_json)
          const currentActive = String(currentDetail.status || '') === 'active'
          const exactReplay = Boolean(
            current?.event_type === eventType &&
            String(current?.contact_id || '') === contactId &&
            String(current?.agent_id || '') === agentId &&
            currentActive &&
            String(currentDetail.executionId || '') === executionId &&
            String(currentDetail.calendarId || '') === String(calendarId) &&
            String(currentDetail.startTime || '') === String(startTime) &&
            String(currentDetail.localLabel || '') === String(localLabel) &&
            nativeAppointmentEventMatchesChannel(currentDetail, channel) &&
            String(currentDetail.purpose || 'book') === normalizedPurpose &&
            String(currentDetail.appointmentId || '') === normalizedAppointmentId &&
            String(currentDetail.expectedStartTime || '') === normalizedExpectedStartTime &&
            String(currentDetail.expectedEndTime || '') === normalizedExpectedEndTime &&
            Number(currentDetail.durationMs || 0) === normalizedDurationMs
          )
          if (!exactReplay) {
            liveConflict = true
            return
          }
        } else {
          const rows = await db.all(
            `SELECT id, detail_json FROM conversational_agent_events
             WHERE contact_id = ? AND agent_id = ? AND event_type = ? AND id != ?`,
            [contactId, agentId, eventType, eventId]
          )
          const supersededAt = new Date().toISOString()
          for (const row of rows || []) {
            const prior = parseNativeEventDetail(row.detail_json)
            if (
              String(prior.status || '') !== 'active' ||
              !nativeAppointmentEventMatchesChannel(prior, channel)
            ) continue
            await db.run(
              'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
              [JSON.stringify({ ...prior, status: 'superseded', supersededAt, supersededByOfferEventId: eventId }), row.id, row.detail_json]
            )
          }
        }
        await transitionProgress()
      })
      if (liveConflict) {
        return appointmentSelectionError(
          'Ya hay un horario pendiente de respuesta. Resuelve esa oferta antes de consultar u ofrecer otra.',
          'appointment_offer_pending_decision'
        )
      }
    }
  } catch (error) {
    if (error?.code === 'appointment_progress_transition_conflict') {
      return appointmentSelectionError(
        'La fecha elegida cambió mientras preparaba el horario. Vuelve a consultar antes de mostrarlo.',
        'appointment_progress_transition_failed'
      )
    }
    throw error
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
    !nativeAppointmentEventMatchesChannel(storedDetail, channel) ||
    String(storedDetail.purpose || 'book') !== normalizedPurpose ||
    String(storedDetail.appointmentId || '') !== normalizedAppointmentId ||
    String(storedDetail.expectedStartTime || '') !== normalizedExpectedStartTime ||
    String(storedDetail.expectedEndTime || '') !== normalizedExpectedEndTime ||
    Number(storedDetail.durationMs || 0) !== normalizedDurationMs ||
    !nativeAppointmentOfferCopyContractMatches(storedDetail, localLabel) ||
    (previewScopeId && String(storedDetail.previewScopeId || '') !== previewScopeId)
  ) {
    return appointmentSelectionError('La oferta de horario ya fue reemplazada por otra. Vuelve a ofrecer un solo horario.', 'appointment_offer_superseded')
  }
  if (transitionedProgressDetail) {
    ctx.appointmentSelectionProgress = {
      active: false,
      ...transitionedProgressDetail,
      eventId: buildNativeAppointmentSelectionProgressEventId({ ctx, config }),
      stateFingerprint: createHash('sha256')
        .update(JSON.stringify(transitionedProgressDetail))
        .digest('hex')
    }
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
  const terminalBinding = readBoundNativeAppointmentTerminalBinding(detail)
  return Boolean(
    String(evidence.paymentMode || '').toLowerCase() === 'test' &&
    String(evidence.paymentPurpose || '') === 'appointment_deposit' &&
    String(evidence.previewScopeId || '') === String(ctx?.previewScopeId || '') &&
    String(evidence.previewScopeId || '') === String(detail?.previewScopeId || '') &&
    String(evidence.appointmentOfferEventId || '') === String(offer?.id || '') &&
    String(evidence.appointmentOfferFingerprint || '') === createHash('sha256').update(String(offer.detail_json)).digest('hex') &&
    String(evidence.calendarId || '') === String(detail?.calendarId || '') &&
    String(evidence.startTime || '') === String(detail?.startTime || '') &&
    terminalBinding &&
    String(evidence.bookingOwner || '') === terminalBinding.bookingOwner &&
    String(evidence.terminalToolName || '') === terminalBinding.terminalToolName &&
    String(evidence.testRunId || '').trim() &&
    String(evidence.testEffectId || '').trim()
  )
}

async function loadNativeAppointmentOfferCandidate({ ctx, config } = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
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
         ORDER BY created_at DESC, id DESC`,
        [contactId, agentId, eventType]
      )

  const eligible = []
  let sameExecution = false
  let unresolvedTransitionCount = 0
  for (const row of rows || []) {
    const detail = parseNativeEventDetail(row.detail_json)
    if (
      row.event_type !== eventType ||
      String(row.contact_id || '') !== contactId ||
      String(row.agent_id || '') !== agentId ||
      (previewScopeId && String(detail.previewScopeId || '') !== previewScopeId) ||
      !nativeAppointmentEventMatchesChannel(detail, channel)
    ) continue
    const status = String(detail.status || '')
    if (status === 'resolving_handoff') {
      unresolvedTransitionCount += 1
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
  if (eligible.length !== 1 || unresolvedTransitionCount > 0) {
    return {
      ...appointmentSelectionError(
      sameExecution
        ? 'La oferta necesita una respuesta nueva de la persona en otro turno antes de poder confirmarse.'
        : 'No hay una única oferta estructurada pendiente. Ofrece un solo horario con offer_appointment_slot.',
      sameExecution ? 'appointment_confirmation_turn_required' : 'appointment_offer_required'
      ),
      eligibleOfferCount: eligible.length,
      unresolvedTransitionCount
    }
  }
  return { ok: true, offer: eligible[0], preview: Boolean(previewScopeId) }
}

/**
 * Reconcilia el único hueco de compatibilidad con una instancia anterior al
 * progreso durable: ese binario podía guardar una oferta visible sin cerrar
 * appointment_selection_progress y sin ligar quién debía terminar la cita.
 *
 * La oferta sólo gana si demuestra que es posterior y pertenece exactamente
 * al mismo calendario, zona, propósito y fecha parcial. Cualquier duda deja
 * intacto el progreso y cierra la oferta por CAS; nunca seguimos con dos
 * autoridades activas.
 */
async function reconcileNativeAppointmentOfferWithSelectionProgress({
  ctx,
  config,
  candidate,
  terminalBinding,
  currentTimezone
} = {}) {
  const contactId = String(ctx?.contactId || '').trim()
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const previewScopeId = ctx?.dryRun && isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
    ? String(ctx.previewScopeId).trim()
    : ''
  const eventType = previewScopeId
    ? CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT
    : NATIVE_APPOINTMENT_OFFER_EVENT
  const offerEventId = String(candidate?.offer?.id || '').trim()
  const expectedOfferJson = String(candidate?.offer?.detail_json || '')
  const progressEventId = buildNativeAppointmentSelectionProgressEventId({ ctx, config })
  if (
    !contactId || !agentId || !channel || !offerEventId || !expectedOfferJson ||
    !progressEventId || !terminalBinding || (ctx?.dryRun && !previewScopeId)
  ) {
    throw Object.assign(
      new Error('La oferta no conserva identidad suficiente para reconciliar el progreso de la cita'),
      { code: 'appointment_offer_progress_identity_missing', statusCode: 409 }
    )
  }

  let outcome = null
  await db.transaction(async () => {
    if (previewScopeId) {
      await lockNativeAppointmentPreviewAuthority({ ctx, config })
    } else {
      const contactLock = await db.get(
        `SELECT id FROM contacts WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
        [contactId]
      )
      if (!contactLock?.id) throw new Error('El contacto dejó de existir antes de reconciliar la oferta')
    }

    const rowLock = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
    const currentOffer = await db.get(
      `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
       FROM conversational_agent_events WHERE id = ?${rowLock}`,
      [offerEventId]
    )
    if (
      currentOffer?.event_type !== eventType ||
      String(currentOffer?.contact_id || '') !== contactId ||
      String(currentOffer?.agent_id || '') !== agentId ||
      String(currentOffer?.detail_json || '') !== expectedOfferJson
    ) {
      throw Object.assign(
        new Error('La oferta cambió mientras se reconciliaba con la selección parcial'),
        { code: 'appointment_offer_progress_reconciliation_conflict', statusCode: 409 }
      )
    }

    const offerDetail = parseNativeEventDetail(currentOffer.detail_json)
    const offeredAtMs = Date.parse(String(offerDetail.offeredAt || ''))
    const startTimeMs = Date.parse(String(offerDetail.startTime || ''))
    const canonical = buildCanonicalAppointmentSlotOption(
      offerDetail.startTime,
      offerDetail.timezone
    )
    const offerPurpose = String(offerDetail.purpose || '').trim()
    const offerAppointmentId = String(offerDetail.appointmentId || '').trim()
    const expectedStartTime = String(offerDetail.expectedStartTime || '').trim()
    const expectedEndTime = String(offerDetail.expectedEndTime || '').trim()
    const expectedStartTimeMs = Date.parse(expectedStartTime)
    const expectedEndTimeMs = Date.parse(expectedEndTime)
    const offerDurationMs = Number(offerDetail.durationMs || 0)
    const offerPurposeShapeIsValid = offerPurpose === 'book'
      ? !offerAppointmentId && !expectedStartTime && !expectedEndTime && offerDurationMs === 0
      : offerPurpose === 'reschedule' && Boolean(
          offerAppointmentId &&
          Number.isFinite(expectedStartTimeMs) &&
          Number.isFinite(expectedEndTimeMs) &&
          expectedEndTimeMs > expectedStartTimeMs &&
          Number.isFinite(offerDurationMs) &&
          offerDurationMs > 0 &&
          expectedEndTimeMs - expectedStartTimeMs === offerDurationMs
        )
    const rawBookingOwner = String(offerDetail.bookingOwner || '').trim()
    const rawTerminalToolName = String(offerDetail.terminalToolName || '').trim()
    const bindingCompletelyAbsent = !rawBookingOwner && !rawTerminalToolName
    const storedTerminalBinding = readBoundNativeAppointmentTerminalBinding(offerDetail)
    const bindingMatches = Boolean(
      storedTerminalBinding &&
      storedTerminalBinding.bookingOwner === terminalBinding.bookingOwner &&
      storedTerminalBinding.terminalToolName === terminalBinding.terminalToolName
    )
    const offerIdentityIsValid = Boolean(
      String(offerDetail.status || '') === 'active' &&
      String(offerDetail.phase || '') === 'awaiting_decision' &&
      String(offerDetail.agentId || '') === agentId &&
      String(offerDetail.contactId || '') === contactId &&
      String(offerDetail.executionId || '').trim() &&
      nativeAppointmentEventMatchesChannel(offerDetail, channel, { allowLegacy: false }) &&
      (previewScopeId
        ? String(offerDetail.previewScopeId || '') === previewScopeId
        : !String(offerDetail.previewScopeId || '').trim()) &&
      String(offerDetail.calendarId || '').trim() &&
      String(offerDetail.startTime || '') === String(canonical?.startTime || '') &&
      String(offerDetail.localLabel || '') === String(canonical?.localLabel || '') &&
      nativeAppointmentOfferCopyContractMatches(offerDetail, canonical?.localLabel) &&
      offerPurposeShapeIsValid &&
      canonical?.localDate &&
      canonical.localDate >= businessTodayDateOnly(currentTimezone) &&
      canonical.timezone === currentTimezone &&
      Number.isFinite(startTimeMs) &&
      startTimeMs > Date.now() &&
      Number.isFinite(offeredAtMs)
    )

    const closeOfferForProgress = async ({ reason, blocked = false } = {}) => {
      const supersededAt = new Date().toISOString()
      const nextOfferDetail = {
        ...offerDetail,
        status: 'superseded',
        phase: 'closed',
        resolution: reason || 'progress_authority_conflict',
        supersededAt,
        supersededByProgressEventId: progressEventId
      }
      const updated = await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = ? AND detail_json = ?`,
        [
          JSON.stringify(nextOfferDetail),
          offerEventId,
          contactId,
          agentId,
          eventType,
          currentOffer.detail_json
        ]
      )
      if (Number(updated?.changes ?? updated?.rowCount ?? 0) !== 1) {
        throw Object.assign(
          new Error('La oferta cambió mientras se cerraba la autoridad duplicada'),
          { code: 'appointment_offer_progress_reconciliation_conflict', statusCode: 409 }
        )
      }
      outcome = { ok: false, progressWins: true, blocked, reason }
    }

    if (!offerIdentityIsValid || (!bindingCompletelyAbsent && !bindingMatches)) {
      await closeOfferForProgress({
        reason: !offerIdentityIsValid
          ? 'legacy_offer_contract_invalid'
          : 'legacy_offer_terminal_binding_invalid'
      })
      return
    }

    const progressRow = await db.get(
      `SELECT id, contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?${rowLock}`,
      [progressEventId]
    )
    const progressDetail = parseNativeEventDetail(progressRow?.detail_json)

    const migrateLegacyBinding = async () => {
      if (!bindingCompletelyAbsent) {
        outcome = { ok: true, offer: { ...currentOffer, detail: offerDetail } }
        return
      }
      const migratedDetail = {
        ...offerDetail,
        ...terminalBinding,
        legacyTerminalBindingMigratedAt: new Date().toISOString()
      }
      const migratedJson = JSON.stringify(migratedDetail)
      const updated = await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = ? AND detail_json = ?`,
        [migratedJson, offerEventId, contactId, agentId, eventType, currentOffer.detail_json]
      )
      if (Number(updated?.changes ?? updated?.rowCount ?? 0) !== 1) {
        throw Object.assign(
          new Error('La oferta cambió mientras se completaba su contrato de compatibilidad'),
          { code: 'appointment_offer_progress_reconciliation_conflict', statusCode: 409 }
        )
      }
      outcome = {
        ok: true,
        offer: { ...currentOffer, detail_json: migratedJson, detail: migratedDetail }
      }
    }

    if (!progressRow) {
      await migrateLegacyBinding()
      return
    }

    const progressIdentityMatches = Boolean(
      progressRow.event_type === NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT &&
      String(progressRow.contact_id || '') === contactId &&
      String(progressRow.agent_id || '') === agentId &&
      String(progressDetail.channel || '') === channel &&
      (previewScopeId
        ? String(progressDetail.previewScopeId || '') === previewScopeId
        : !String(progressDetail.previewScopeId || '').trim())
    )
    const knownProgressSchema = Number(progressDetail.schemaVersion || 0) === 1
    const progressStatus = String(progressDetail.appointmentStatus || '')
    const progressExpiresAtMs = Date.parse(String(progressDetail.expiresAt || ''))
    const progressUpdatedAtMs = Date.parse(String(progressDetail.updatedAt || ''))
    const progressTerminal = ['restarted', 'cancelled', 'superseded'].includes(progressStatus)
    const collectingProgress = ['collecting_date', 'collecting_time'].includes(progressStatus)
    const knownProgressStatus = progressTerminal || collectingProgress || progressStatus === 'browsing'
    const expiryProvesInactive = Number.isFinite(progressExpiresAtMs) && progressExpiresAtMs <= Date.now()
    if (!progressIdentityMatches || !knownProgressSchema || !knownProgressStatus) {
      await closeOfferForProgress({
        reason: 'progress_authority_unknown',
        blocked: true
      })
      return
    }
    if (progressTerminal || expiryProvesInactive || progressStatus === 'browsing') {
      await migrateLegacyBinding()
      return
    }

    const progressPurpose = String(progressDetail.purpose || '')
    const rawProgressAppointmentId = String(progressDetail.appointmentId || '').trim()
    const progressPurposeShapeIsValid = progressPurpose === 'book'
      ? !rawProgressAppointmentId
      : progressPurpose === 'reschedule' && Boolean(rawProgressAppointmentId)
    const progressAppointmentId = progressPurpose === 'reschedule'
      ? rawProgressAppointmentId
      : ''
    const progressSelectedDate = String(progressDetail.selectedDate || '').trim()
    const progressShapeMatches = progressStatus === 'collecting_time'
      ? Boolean(
          progressSelectedDate === canonical.localDate &&
          Array.isArray(progressDetail.missingFields) &&
          progressDetail.missingFields.length === 1 &&
          progressDetail.missingFields[0] === 'time'
        )
      : Boolean(
          !progressSelectedDate &&
          Array.isArray(progressDetail.missingFields) &&
          progressDetail.missingFields.length === 1 &&
          progressDetail.missingFields[0] === 'date'
        )
    const scopeMatches = Boolean(
      String(progressDetail.calendarId || '') === String(offerDetail.calendarId || '') &&
      String(progressDetail.selectedCalendar || '') === String(offerDetail.calendarId || '') &&
      String(progressDetail.selectedTimezone || '') === currentTimezone &&
      progressPurpose === offerPurpose &&
      progressPurposeShapeIsValid &&
      progressAppointmentId === offerAppointmentId &&
      (offerPurpose !== 'reschedule' || Boolean(offerAppointmentId)) &&
      progressShapeMatches &&
      Number.isFinite(progressExpiresAtMs) &&
      progressExpiresAtMs > Date.now() &&
      Number.isFinite(progressUpdatedAtMs) &&
      offeredAtMs >= progressUpdatedAtMs
    )
    if (!scopeMatches) {
      await closeOfferForProgress({ reason: 'progress_authority_newer_or_different_scope' })
      return
    }

    let reconciledOffer = { ...currentOffer, detail: offerDetail }
    if (bindingCompletelyAbsent) {
      const migratedDetail = {
        ...offerDetail,
        ...terminalBinding,
        legacyTerminalBindingMigratedAt: new Date().toISOString()
      }
      const migratedJson = JSON.stringify(migratedDetail)
      const migrated = await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = ? AND detail_json = ?`,
        [migratedJson, offerEventId, contactId, agentId, eventType, currentOffer.detail_json]
      )
      if (Number(migrated?.changes ?? migrated?.rowCount ?? 0) !== 1) {
        throw Object.assign(
          new Error('La oferta cambió mientras se reconciliaba su contrato legacy'),
          { code: 'appointment_offer_progress_reconciliation_conflict', statusCode: 409 }
        )
      }
      reconciledOffer = { ...currentOffer, detail_json: migratedJson, detail: migratedDetail }
    }

    const reconciledAt = new Date().toISOString()
    const nextProgressDetail = {
      ...progressDetail,
      selectedDate: canonical.localDate,
      selectedTime: canonical.localTime,
      selectedStartTime: String(offerDetail.startTime || '').trim(),
      appointmentStatus: 'superseded',
      missingFields: [],
      updatedAt: reconciledAt,
      supersededAt: reconciledAt,
      supersededByOfferEventId: offerEventId,
      reconciliationReason: 'legacy_offer_authority_reconciled'
    }
    const progressUpdated = await db.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = ? AND detail_json = ?`,
      [
        JSON.stringify(nextProgressDetail),
        progressEventId,
        contactId,
        agentId,
        NATIVE_APPOINTMENT_SELECTION_PROGRESS_EVENT,
        progressRow.detail_json
      ]
    )
    if (Number(progressUpdated?.changes ?? progressUpdated?.rowCount ?? 0) !== 1) {
      throw Object.assign(
        new Error('La selección parcial cambió mientras se reconciliaba la oferta legacy'),
        { code: 'appointment_offer_progress_reconciliation_conflict', statusCode: 409 }
      )
    }
    outcome = { ok: true, offer: reconciledOffer, progressSuperseded: true }
  })

  if (outcome?.blocked) {
    throw Object.assign(
      new Error('La oferta y la selección parcial tienen contratos incompatibles; se bloqueó el turno para no agendar con una autoridad ambigua.'),
      { code: 'appointment_offer_progress_authority_ambiguous', statusCode: 409 }
    )
  }
  return outcome || { ok: false, progressWins: true }
}

/**
 * Hidrata el hecho durable de que existe una oferta pendiente antes de llamar
 * al modelo. No interpreta el mensaje del cliente: comprueba identidad, canal,
 * y que calendario, zona y responsable sigan siendo los mismos.
 */
export async function loadConversationalAppointmentOfferDecisionContext({ ctx, config } = {}) {
  const candidate = await loadNativeAppointmentOfferCandidate({ ctx, config })
  if (!candidate?.ok) {
    if (Number(candidate?.unresolvedTransitionCount || 0) > 0) {
      throw Object.assign(
        new Error('La entrega de una oferta al equipo quedó en transición; se bloquearon las acciones para evitar una cita o cobro duplicado.'),
        { code: 'appointment_offer_resolution_in_progress', statusCode: 409 }
      )
    }
    if (Number(candidate?.eligibleOfferCount || 0) > 1) {
      throw Object.assign(
        new Error('Hay más de una oferta de horario vigente para el mismo hilo; se bloquearon las acciones hasta resolver el estado.'),
        { code: 'appointment_offer_state_ambiguous', statusCode: 409 }
      )
    }
    return null
  }
  if (String(candidate.offer?.detail?.status || '') !== 'active') return null
  let offerFingerprint = createHash('sha256').update(String(candidate.offer.detail_json || '')).digest('hex')
  const invalidateScopeChangedOffer = async (reason) => {
    await supersedeUnavailableNativeAppointmentOffer({
      ctx,
      config,
      candidate,
      expected: { offerFingerprint },
      restoreSameDate: false,
      reason
    })
    return null
  }

  const scheduleCapability = getNativeCapability(ctx, config, 'schedule_appointment')
  if (!scheduleCapability) {
    return invalidateScopeChangedOffer('schedule_capability_changed')
  }
  const terminalToolName = scheduleCapability.bookingOwner === 'human'
    ? 'request_human_booking'
    : 'book_appointment'
  const terminalBinding = buildNativeAppointmentTerminalBinding(scheduleCapability, terminalToolName)
  const currentCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
  const currentTimezone = resolveTimezone(await getAccountTimezone())
  const offerTimezone = String(candidate.offer.detail.timezone || '').trim()
  const storedTerminalBinding = readBoundNativeAppointmentTerminalBinding(candidate.offer.detail)
  let invalidationReason = ''
  if (
    !currentCalendar?.id ||
    String(candidate.offer.detail.calendarId || '') !== String(currentCalendar.id)
  ) {
    invalidationReason = 'calendar_changed'
  } else if (!offerTimezone || resolveTimezone(offerTimezone) !== currentTimezone) {
    invalidationReason = 'timezone_changed'
  } else if (!terminalBinding) {
    invalidationReason = 'booking_owner_changed'
  } else if (
    storedTerminalBinding &&
    (
      storedTerminalBinding.bookingOwner !== terminalBinding.bookingOwner ||
      storedTerminalBinding.terminalToolName !== terminalBinding.terminalToolName
    )
  ) {
    invalidationReason = 'booking_owner_changed'
  } else if (nativeAppointmentOfferDepositRequirementChanged(candidate.offer.detail, ctx, config)) {
    invalidationReason = 'appointment_deposit_requirement_changed'
  }
  if (invalidationReason) return invalidateScopeChangedOffer(invalidationReason)

  const reconciledAuthority = await reconcileNativeAppointmentOfferWithSelectionProgress({
    ctx,
    config,
    candidate,
    terminalBinding,
    currentTimezone
  })
  if (!reconciledAuthority?.ok) return null
  candidate.offer = reconciledAuthority.offer
  offerFingerprint = createHash('sha256')
    .update(String(candidate.offer.detail_json || ''))
    .digest('hex')

  return {
    active: true,
    offerEventId: String(candidate.offer.id || '').trim(),
    offerFingerprint,
    calendarId: String(candidate.offer.detail.calendarId || '').trim(),
    startTime: String(candidate.offer.detail.startTime || '').trim(),
    localLabel: String(candidate.offer.detail.localLabel || '').trim(),
    timezone: currentTimezone,
    purpose: String(candidate.offer.detail.purpose || 'book').trim() === 'reschedule' ? 'reschedule' : 'book',
    appointmentId: String(candidate.offer.detail.appointmentId || '').trim() || null,
    expectedStartTime: String(candidate.offer.detail.expectedStartTime || '').trim() || null,
    expectedEndTime: String(candidate.offer.detail.expectedEndTime || '').trim() || null,
    durationMs: Number(candidate.offer.detail.durationMs || 0) || null,
    preview: candidate.preview === true,
    allowHandoff: Boolean(getNativeCapability(ctx, config, 'handoff_human')),
    ...terminalBinding
  }
}

function normalizeNativeAppointmentOfferDeliveryText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

/**
 * Prueba live de que el texto canónico de una oferta salió por la entrega
 * durable correspondiente al mismo inbound. No sustituye el juicio semántico
 * del resolver ni la revalidación de calendario: sólo permite recuperar la
 * visibilidad factual cuando el sobre del modelo ya omitió ese turno antiguo.
 */
async function verifyNativeAppointmentOfferReplyDelivery({
  ctx,
  config,
  offer,
  evidence = null
} = {}) {
  if (ctx?.dryRun === true || ctx?.followUpMode === true || !offer?.detail) return null

  const contactId = String(ctx?.contactId || '').trim()
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const offerExecutionId = String(offer.detail.executionId || '').trim()
  const persistedSourceMessageId = String(offer.detail.offerSourceMessageId || '').trim()
  const sourceMessageId = persistedSourceMessageId || offerExecutionId
  const currentExecutionId = String(ctx?.executionId || '').trim()
  const expectedOfferText = String(offer.detail.offerText || '').trim()
  const expectedOfferTextNormalized = normalizeNativeAppointmentOfferDeliveryText(expectedOfferText)
  const expectedReplyHash = expectedOfferText
    ? createHash('sha256').update(expectedOfferText).digest('hex')
    : ''

  if (
    !contactId ||
    !agentId ||
    !channel ||
    !sourceMessageId ||
    !currentExecutionId ||
    currentExecutionId === sourceMessageId ||
    !expectedOfferTextNormalized ||
    !expectedReplyHash ||
    (persistedSourceMessageId && offerExecutionId && persistedSourceMessageId !== offerExecutionId) ||
    String(offer.contact_id || '') !== contactId ||
    String(offer.agent_id || '') !== agentId ||
    !nativeAppointmentEventMatchesChannel(offer.detail, channel, { allowLegacy: false })
  ) return null

  let plan = null
  try {
    plan = await getConversationalReplyDeliveryPlan({
      contactId,
      agentId,
      channel,
      sourceMessageId,
      externalIdPrefix: 'convagent'
    })
  } catch {
    // La ausencia, corrupción o colisión del ledger falla cerrado igual que una
    // oferta que nunca apareció en el transcript visible.
    return null
  }

  const part = Array.isArray(plan?.parts) && plan.parts.length === 1
    ? plan.parts[0]
    : null
  const completedAtMs = Date.parse(String(plan?.completedAt || ''))
  const partText = String(part?.text || '').trim()
  const partReplyHash = partText
    ? createHash('sha256').update(partText).digest('hex')
    : ''
  const offerMessageId = String(part?.providerMessageId || part?.externalId || '').trim()
  const offerTurnId = plan?.id ? `reply-delivery:${plan.id}` : ''
  const exactPlan = Boolean(
    plan?.eventType === CONVERSATIONAL_REPLY_DELIVERY_EVENT_TYPE &&
    String(plan?.contactId || '') === contactId &&
    String(plan?.agentId || '') === agentId &&
    normalizeNativeAppointmentChannel(plan?.channel) === channel &&
    String(plan?.sourceMessageId || '') === sourceMessageId &&
    String(plan?.externalIdPrefix || '') === 'convagent' &&
    String(plan?.status || '') === 'completed' &&
    Number.isFinite(completedAtMs) &&
    completedAtMs <= Date.now() + 60_000 &&
    part?.status === 'sent' &&
    offerMessageId &&
    String(plan?.replyHash || '') === expectedReplyHash &&
    partReplyHash === expectedReplyHash &&
    normalizeNativeAppointmentOfferDeliveryText(partText) === expectedOfferTextNormalized
  )
  if (!exactPlan) return null

  const expectedPlanId = String(evidence?.offerDeliveryPlanId || '').trim()
  const expectedEvidenceHash = String(evidence?.offerDeliveryReplyHash || '').trim()
  const expectedCompletedAt = String(evidence?.offerDeliveryCompletedAt || '').trim()
  const expectedMessageId = String(evidence?.offerMessageId || '').trim()
  const expectedTurnId = String(evidence?.offerTurnId || '').trim()
  const expectedTurnMessageIds = Array.isArray(evidence?.offerTurnMessageIds)
    ? evidence.offerTurnMessageIds.map((value) => String(value || '').trim()).filter(Boolean)
    : []
  const expectedEvidenceSource = String(evidence?.offerVisibilityEvidenceSource || '').trim()
  if (
    (expectedPlanId && expectedPlanId !== plan.id) ||
    (expectedEvidenceHash && expectedEvidenceHash !== plan.replyHash) ||
    (expectedCompletedAt && expectedCompletedAt !== plan.completedAt) ||
    (expectedMessageId && expectedMessageId !== offerMessageId) ||
    (expectedTurnId && expectedTurnId !== offerTurnId) ||
    (expectedTurnMessageIds.length && (
      expectedTurnMessageIds.length !== 1 || expectedTurnMessageIds[0] !== offerMessageId
    )) ||
    (expectedEvidenceSource && expectedEvidenceSource !== 'reply_delivery_ledger')
  ) return null

  return {
    offerMessageId,
    offerTurnId,
    offerTurnMessageIds: [offerMessageId],
    offerDeliveryPlanId: String(plan.id || '').trim(),
    offerDeliveryReplyHash: String(plan.replyHash || '').trim(),
    offerDeliveryCompletedAt: String(plan.completedAt || '').trim(),
    offerVisibilityEvidenceSource: 'reply_delivery_ledger',
    offerSourceMessageId: sourceMessageId
  }
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
  const durableOfferDelivery = evidence?.offerDeliveryPlanId
    ? await verifyNativeAppointmentOfferReplyDelivery({ ctx, config, offer, evidence })
    : null
  if (
    String(offer.detail.calendarId || '') !== String(calendarId || '') ||
    String(offer.detail.startTime || '') !== String(startTime || '') ||
    String(offer.detail.localLabel || '') !== String(evidence?.localLabel || '') ||
    (evidence?.offerEventId && String(evidence.offerEventId) !== String(offer.id)) ||
    offerTurnText !== expectedText && !durableOfferDelivery
  ) {
    return appointmentSelectionError('La respuesta no confirma la oferta estructurada vigente o el agente agregó otro horario. Reofrece uno solo.', 'appointment_offer_mismatch')
  }
  return { ok: true, offerEventId: offer.id, offerDetail: offer.detail }
}

async function validateNativeAppointmentOfferRuntimeScope({
  ctx,
  config,
  offerDetail,
  calendarId,
  timezone
} = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const previewRuntime = Boolean(
    ctx?.dryRun === true &&
    isConversationalAppointmentPreviewScopeId(ctx?.previewScopeId)
  )
  let persistedConfig = null
  if (!previewRuntime && agentId) {
    try {
      persistedConfig = nativeAppointmentRuntimeAgentLookupHookForTest
        ? await nativeAppointmentRuntimeAgentLookupHookForTest({ agentId })
        : await getConversationalAgent(agentId)
    } catch (error) {
      logger.warn(`[Agente conversacional] No se pudo revalidar el agente ${agentId} antes de cerrar la cita: ${error.message}`)
      return appointmentAuthorityRevalidationUnavailable()
    }
  }
  // Un preview puede probar un borrador que todavía no existe o está apagado.
  // En vivo no hay fallback: si el agente desapareció, se desactivó o la BD no
  // pudo confirmar su estado, el snapshot anterior del turno no tiene autoridad.
  const currentConfig = previewRuntime ? config : persistedConfig
  // El contexto del turno puede traer un snapshot anterior de capacidades. Si
  // ya existe configuración durable, la comprobación terminal debe leerla de
  // nuevo y no permitir que ese snapshot la tape.
  const currentCtx = previewRuntime
    ? ctx
    : { ...ctx, capabilitiesConfig: undefined }
  const scheduleCapability = getNativeCapability(currentCtx, currentConfig || {}, 'schedule_appointment')
  let currentCalendar = null
  let currentTimezone = ''
  try {
    currentCalendar = scheduleCapability
      ? await resolveNativeScheduleCalendar(scheduleCapability)
      : null
    currentTimezone = resolveTimezone(await getAccountTimezone({ forceRefresh: true, throwOnError: true }))
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo revalidar calendario y zona antes de cerrar la cita: ${error.message}`)
    return appointmentAuthorityRevalidationUnavailable()
  }
  const offeredTimezone = String(offerDetail?.timezone || '').trim()
  const offeredPurpose = String(offerDetail?.purpose || 'book').trim() === 'reschedule'
    ? 'reschedule'
    : 'book'
  const storedTerminalBinding = readBoundNativeAppointmentTerminalBinding(offerDetail)
  const configuredTerminalBinding = storedTerminalBinding && scheduleCapability
    ? buildNativeAppointmentTerminalBinding(scheduleCapability, storedTerminalBinding.terminalToolName)
    : null
  const depositRequirementChanged = nativeAppointmentOfferDepositRequirementChanged(
    offerDetail,
    currentCtx,
    currentConfig || {}
  )
  const scopeMatches = Boolean(
    (previewRuntime || currentConfig?.enabled === true) &&
    scheduleCapability &&
    currentCalendar?.id &&
    String(currentCalendar.id) === String(calendarId || '') &&
    String(currentCalendar.id) === String(offerDetail?.calendarId || '') &&
    offeredTimezone &&
    currentTimezone === resolveTimezone(timezone) &&
    currentTimezone === resolveTimezone(offeredTimezone) &&
    (offeredPurpose !== 'reschedule' || nativeCalendarPermissionEnabled(currentCalendar.allow_reschedule)) &&
    storedTerminalBinding &&
    configuredTerminalBinding &&
    configuredTerminalBinding.bookingOwner === storedTerminalBinding.bookingOwner &&
    configuredTerminalBinding.terminalToolName === storedTerminalBinding.terminalToolName &&
    !depositRequirementChanged
  )
  if (scopeMatches) {
    return {
      ok: true,
      scheduleCapability,
      calendar: currentCalendar,
      calendarFingerprint: nativeAppointmentCalendarFingerprint(currentCalendar),
      timezone: currentTimezone,
      capabilitiesFingerprint: nativeAppointmentCapabilitiesFingerprint(currentCtx, currentConfig || {})
    }
  }
  return {
    ...appointmentSelectionError(
      'La configuración de agenda cambió después de ofrecer ese horario. No se agendó nada; vuelve a consultar disponibilidad.',
      'appointment_offer_scope_changed'
    ),
    appointmentOfferInvalidated: true,
    appointmentOfferRestoreSameDate: false
  }
}

async function revalidateNativeAppointmentTerminalCommitAuthority({
  ctx,
  config,
  calendarId,
  timezone,
  confirmationEvidence,
  expectedCapabilitiesFingerprint = '',
  expectedCalendarFingerprint = '',
  lockForCommit = false
} = {}) {
  const offerEventId = String(confirmationEvidence?.offerEventId || '').trim()
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const startTime = String(confirmationEvidence?.selectedStartTime || '').trim()
  const validateInboundClaim = async ({ lock = false } = {}) => {
    const claimMessageId = String(ctx?.inboundClaim?.messageId || '').trim()
    const claimToken = String(ctx?.inboundClaim?.claimToken || '').trim()
    const executionId = String(ctx?.executionId || '').trim()
    if (!claimMessageId && !claimToken) return { ok: true, checked: false }
    if (!claimMessageId || !claimToken || claimMessageId !== executionId) {
      return { ok: false, checked: true }
    }
    const lockClause = lock && process.env.DATABASE_URL ? ' FOR UPDATE' : ''
    const row = await db.get(`
      SELECT status, signal, inbound_processing_message_id,
             inbound_processing_status, inbound_processing_claim_token,
             inbound_processing_lease_until_at
      FROM conversational_agent_state
      WHERE contact_id = ? AND agent_id = ?
        AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?
      LIMIT 1${lockClause}
    `, [ctx?.contactId, agentId, normalizeNativeAppointmentChannel(ctx?.channel) || 'whatsapp'])
    const leaseUntilMs = Date.parse(String(row?.inbound_processing_lease_until_at || ''))
    return {
      ok: Boolean(
        row?.status === 'active' &&
        !row?.signal &&
        String(row?.inbound_processing_message_id || '') === executionId &&
        row?.inbound_processing_status === 'processing' &&
        String(row?.inbound_processing_claim_token || '') === claimToken &&
        Number.isFinite(leaseUntilMs) &&
        leaseUntilMs > Date.now()
      ),
      checked: true
    }
  }
  try {
    if (!lockForCommit) {
      const claimAuthority = await validateInboundClaim()
      if (claimAuthority.checked && !claimAuthority.ok) {
        return {
          ...appointmentSelectionError(
            'La ejecución que confirmó la cita perdió su autoridad antes de guardar. No se creó nada; retoma el último mensaje válido.',
            'appointment_request_authority_lost'
          ),
          appointmentOfferInvalidated: true,
          appointmentOfferRestoreSameDate: true
        }
      }
    }
    if (lockForCommit) {
      // El controller invoca este fence dentro de la misma transacción que
      // persiste la cita. Todo writer inbound toma la misma llave antes de su
      // INSERT, así que la consulta canónica de abajo y el INSERT terminal son
      // una sola decisión lineal, sin ventana TOCTOU en PostgreSQL.
      await acquireConversationalInboundCommitLock({
        contactId: ctx?.contactId,
        channel: ctx?.channel || 'whatsapp',
        database: db
      })
    }
    if (!ctx?.dryRun) {
      const inboundAuthority = await findNewerSubstantiveConversationalInbound({
        contactId: ctx?.contactId,
        handledMessageId: ctx?.executionId,
        channel: ctx?.channel || 'whatsapp'
      })
      const inboundClaimExpected = Boolean(
        String(ctx?.inboundClaim?.messageId || '').trim() ||
        String(ctx?.inboundClaim?.claimToken || '').trim()
      )
      if (inboundClaimExpected && !inboundAuthority.checked) {
        return {
          ...appointmentSelectionError(
            'La confirmación perdió su fila canónica antes de guardar. No se creó nada; retoma el último mensaje válido.',
            'appointment_request_authority_lost'
          ),
          appointmentOfferInvalidated: true,
          appointmentOfferRestoreSameDate: true
        }
      }
      if (inboundAuthority.checked && inboundAuthority.newerMessage) {
        return {
          ...appointmentSelectionError(
            'Llegó un mensaje nuevo mientras se cerraba la cita. No se guardó el horario anterior; procesa primero la instrucción más reciente.',
            'appointment_request_superseded_by_newer_inbound'
          ),
          appointmentOfferInvalidated: true,
          appointmentOfferRestoreSameDate: true
        }
      }
    }
    if (lockForCommit) {
      const exclusiveLockClause = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
      const sharedLockClause = process.env.DATABASE_URL ? ' FOR SHARE' : ''
      // La fila vacía es un sentinel durable. Si todavía no había override, el
      // índice único serializa el primer INSERT del panel contra este commit;
      // NULL conserva exactamente el fallback HighLevel/default. En el camino
      // normal basta un lock compartido; sólo hacemos UPSERT si una instalación
      // legacy todavía no tiene el sentinel, evitando churn MVCC por cada cita.
      let timezoneLock = await db.get(
        `SELECT config_key FROM app_config WHERE config_key = ?${sharedLockClause}`,
        ['account_timezone']
      )
      if (!timezoneLock?.config_key) {
        await db.run(
          `INSERT INTO app_config (config_key, config_value, updated_at)
           VALUES (?, NULL, CURRENT_TIMESTAMP)
           ON CONFLICT(config_key) DO UPDATE SET
             config_key = excluded.config_key`,
          ['account_timezone']
        )
        timezoneLock = await db.get(
          `SELECT config_key FROM app_config WHERE config_key = ?${sharedLockClause}`,
          ['account_timezone']
        )
      }
      if (!timezoneLock?.config_key) throw new Error('No se pudo cercar la configuración de zona horaria')
      const offerLock = offerEventId
        ? await db.get(
            `SELECT id, detail_json FROM conversational_agent_events WHERE id = ?${exclusiveLockClause}`,
            [offerEventId]
          )
        : null
      const offerLockDetail = parseNativeEventDetail(offerLock?.detail_json)
      const selectionEventId = String(
        confirmationEvidence?.selectionEventId || offerLockDetail.selectionEventId || ''
      ).trim()
      if (selectionEventId) {
        await db.get(
          `SELECT id FROM conversational_agent_events WHERE id = ?${exclusiveLockClause}`,
          [selectionEventId]
        )
      }
      if (agentId) {
        await db.get(
          `SELECT id FROM conversational_agents WHERE id = ?${sharedLockClause}`,
          [agentId]
        )
      }
      await db.get(
        `SELECT id FROM calendars WHERE id = ? OR ghl_calendar_id = ? LIMIT 1${sharedLockClause}`,
        [calendarId, calendarId]
      )
      await db.get(`SELECT id FROM highlevel_config LIMIT 1${sharedLockClause}`)
      const claimAuthority = await validateInboundClaim({ lock: true })
      if (claimAuthority.checked && !claimAuthority.ok) {
        return {
          ...appointmentSelectionError(
            'La ejecución que confirmó la cita perdió su autoridad dentro del guardado. No se creó nada; retoma el último mensaje válido.',
            'appointment_request_authority_lost'
          ),
          appointmentOfferInvalidated: true,
          appointmentOfferRestoreSameDate: true
        }
      }
    }
    const offerAuthorization = await verifyNativeAppointmentOfferEvent({
      ctx,
      config,
      calendarId,
      startTime,
      evidence: confirmationEvidence
    })
    if (!offerAuthorization.ok) {
      return {
        ...offerAuthorization,
        appointmentOfferInvalidated: true,
        appointmentOfferRestoreSameDate: false
      }
    }
    const runtimeScope = await validateNativeAppointmentOfferRuntimeScope({
      ctx,
      config,
      offerDetail: offerAuthorization.offerDetail,
      calendarId,
      timezone
    })
    const capabilitiesChanged = Boolean(
      runtimeScope.ok &&
      expectedCapabilitiesFingerprint &&
      runtimeScope.capabilitiesFingerprint !== expectedCapabilitiesFingerprint
    )
    const calendarChanged = Boolean(
      runtimeScope.ok &&
      expectedCalendarFingerprint &&
      runtimeScope.calendarFingerprint !== expectedCalendarFingerprint
    )
    if (capabilitiesChanged || calendarChanged) {
      return {
        ...appointmentSelectionError(
          'La configuración de agenda cambió mientras se cerraba la cita. No se aplicó ningún cambio; vuelve a consultar disponibilidad.',
          'appointment_offer_scope_changed'
        ),
        appointmentOfferInvalidated: true,
        appointmentOfferRestoreSameDate: false
      }
    }
    return runtimeScope
  } catch (error) {
    logger.warn(`[Agente conversacional] La autoridad terminal de la cita no pudo cercarse: ${error.message}`)
    return appointmentAuthorityRevalidationUnavailable()
  }
}

function buildNativeAppointmentTerminalCommitFence(options = {}) {
  return async () => {
    const result = await revalidateNativeAppointmentTerminalCommitAuthority({
      ...options,
      lockForCommit: true
    })
    if (result.ok) return result
    const statusCode = Number(result.statusCode) >= 400 && Number(result.statusCode) <= 599
      ? Number(result.statusCode)
      : 409
    throw Object.assign(new Error(result.error || 'La autoridad de la cita cambió antes del guardado.'), {
      status: statusCode,
      statusCode,
      code: result.code || 'appointment_offer_scope_changed',
      conversationalAppointmentAuthorityFailure: true,
      retryable: result.retryable === true,
      appointmentOfferInvalidated: result.appointmentOfferInvalidated === true,
      appointmentOfferRestoreSameDate: result.appointmentOfferRestoreSameDate === true,
      data: {
        appointmentOfferInvalidated: result.appointmentOfferInvalidated === true,
        appointmentOfferRestoreSameDate: result.appointmentOfferRestoreSameDate === true
      }
    })
  }
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
      nativeAppointmentEventMatchesChannel(currentDetail, ctx?.channel) &&
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
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
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
  const offerVisibilityEvidenceSource = String(
    evidence?.offerVisibilityEvidenceSource || 'conversation_history'
  ).trim()
  const offerDeliveryPlanId = String(evidence?.offerDeliveryPlanId || '').trim()
  const offerDeliveryReplyHash = String(evidence?.offerDeliveryReplyHash || '').trim()
  const offerDeliveryCompletedAt = String(evidence?.offerDeliveryCompletedAt || '').trim()
  const hasAnyLedgerEvidence = Boolean(
    offerDeliveryPlanId || offerDeliveryReplyHash || offerDeliveryCompletedAt
  )
  const hasCompleteLedgerEvidence = Boolean(
    offerVisibilityEvidenceSource === 'reply_delivery_ledger' &&
    /^cae_reply_delivery_[a-f0-9]{48}$/u.test(offerDeliveryPlanId) &&
    /^[a-f0-9]{64}$/u.test(offerDeliveryReplyHash) &&
    Number.isFinite(Date.parse(offerDeliveryCompletedAt))
  )
  if (!agentId || !contactId || !calendarId || !startTime || !executionId || !customerMessageId || !latestCustomerMessageId || !offerMessageId || !offerTurnId || !offerEventId) {
    return appointmentSelectionError(
      'No se pudo identificar de forma durable la oferta y la respuesta que eligieron el horario. No se agendó nada.',
      'appointment_selection_identity_missing'
    )
  }
  if (
    !['conversation_history', 'reply_delivery_ledger'].includes(offerVisibilityEvidenceSource) ||
    (hasAnyLedgerEvidence && offerVisibilityEvidenceSource !== 'reply_delivery_ledger') ||
    (offerVisibilityEvidenceSource === 'reply_delivery_ledger' && !hasCompleteLedgerEvidence)
  ) {
    return appointmentSelectionError(
      'La evidencia durable de entrega de la oferta está incompleta o no coincide. No se agendó nada.',
      'appointment_selection_delivery_evidence_invalid'
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
    channel,
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
    channel,
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
    offerVisibilityEvidenceSource,
    offerDeliveryPlanId: hasCompleteLedgerEvidence ? offerDeliveryPlanId : null,
    offerDeliveryReplyHash: hasCompleteLedgerEvidence ? offerDeliveryReplyHash : null,
    offerDeliveryCompletedAt: hasCompleteLedgerEvidence ? offerDeliveryCompletedAt : null,
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
      !nativeAppointmentEventMatchesChannel(offerDetail, channel) ||
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
      const accepted = await db.run(
        'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
        [JSON.stringify({ ...offerDetail, status: 'accepted', acceptedAt: new Date().toISOString(), selectionEventId: eventId }), offerEventId, offer.detail_json]
      )
      if (Number(accepted?.changes ?? accepted?.rowCount ?? 0) !== 1) {
        throw new Error('La oferta cambió mientras se confirmaba; la selección se revirtió')
      }
    }
    const supersededAt = new Date().toISOString()
    const priorSelections = await db.all(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = ? AND id != ?`,
      [contactId, agentId, NATIVE_APPOINTMENT_SELECTION_EVENT, eventId]
    )
    for (const row of priorSelections || []) {
      const prior = parseNativeEventDetail(row.detail_json)
      if (
        String(prior.status || 'active') !== 'active' ||
        !nativeAppointmentEventMatchesChannel(prior, channel)
      ) continue
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
      if (
        String(prior.status || '') !== 'pending' ||
        String(prior.selectionEventId || '') === eventId ||
        !nativeAppointmentEventMatchesChannel(prior, channel)
      ) continue
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
    ['calendarId', 'startTime', 'channel', 'executionId', 'customerMessageId', 'customerMessageIdsHash', 'latestCustomerMessageId', 'offerMessageId', 'offerEventId', 'offerTurnId', 'offerTurnMessageIdsHash', 'offerVisibilityEvidenceSource', 'offerDeliveryPlanId', 'offerDeliveryReplyHash', 'offerDeliveryCompletedAt', 'localLabel', 'timezone', 'customerQuoteHash']
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

async function bindNativeAppointmentRequestDraft({
  ctx,
  config,
  confirmationEvidence,
  requestDraft,
  terminalBinding
} = {}) {
  const draft = normalizeNativeAppointmentRequestDraft(requestDraft)
  const draftHash = nativeAppointmentRequestDraftHash(draft)
  const normalizedTerminalBinding = normalizeNativeAppointmentTerminalBinding(terminalBinding)
  const preview = ctx?.dryRun === true
  const eventId = String(
    preview ? confirmationEvidence?.offerEventId : confirmationEvidence?.selectionEventId
  ).trim()
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const calendarId = String(confirmationEvidence?.calendarId || '').trim()
  const startTime = String(confirmationEvidence?.selectedStartTime || '').trim()
  const previewScopeId = preview ? String(ctx?.previewScopeId || '').trim() : ''
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  if (!draft || !draftHash || !normalizedTerminalBinding || !eventId || !agentId || !contactId || !executionId || !calendarId || !startTime) {
    return appointmentSelectionError(
      'No se pudo ligar de forma segura para quién es la cita y quién debe terminar de agendar antes de cobrar el anticipo. No se creó ningún cobro.',
      'appointment_request_contract_identity_missing'
    )
  }

  const eventType = preview
    ? CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT
    : NATIVE_APPOINTMENT_SELECTION_EVENT
  const identityMatches = (row, detail) => Boolean(
    row?.event_type === eventType &&
    String(row?.contact_id || '') === contactId &&
    String(row?.agent_id || '') === agentId &&
    String(detail?.status || '') === (preview ? 'accepted' : 'active') &&
    String(detail?.calendarId || '') === calendarId &&
    String(detail?.startTime || '') === startTime &&
    nativeAppointmentEventMatchesChannel(detail, channel) &&
    (
      preview
        ? String(detail?.previewScopeId || '') === previewScopeId &&
          String(detail?.acceptedExecutionId || '') === executionId
        : String(detail?.executionId || '') === executionId
    )
  )
  const exactDraftAlreadyBound = (detail) => {
    const storedDraft = readBoundNativeAppointmentRequestDraft(detail)
    const storedTerminalBinding = readBoundNativeAppointmentTerminalBinding(detail)
    return Boolean(
      storedDraft &&
      storedTerminalBinding &&
      String(detail?.appointmentRequestDraftHash || '') === draftHash &&
      JSON.stringify(storedDraft) === JSON.stringify(draft) &&
      storedTerminalBinding.bookingOwner === normalizedTerminalBinding.bookingOwner &&
      storedTerminalBinding.terminalToolName === normalizedTerminalBinding.terminalToolName
    )
  }

  const current = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [eventId]
  )
  const currentDetail = parseNativeEventDetail(current?.detail_json)
  if (!identityMatches(current, currentDetail)) {
    return appointmentSelectionError(
      'La selección cambió antes de ligar los datos de la cita al anticipo. No se creó ningún cobro.',
      'appointment_request_draft_selection_changed'
    )
  }
  if (currentDetail.appointmentRequestDraft || currentDetail.appointmentRequestDraftHash) {
    return exactDraftAlreadyBound(currentDetail)
      ? {
          ...confirmationEvidence,
          ok: true,
          appointmentRequestDraft: draft,
          appointmentRequestDraftHash: draftHash,
          ...normalizedTerminalBinding
        }
      : appointmentSelectionError(
          'Los datos o el responsable de la cita cambiaron después de aceptar el horario. No se creó otro cobro; vuelve a confirmar la cita.',
          'appointment_request_contract_conflict'
        )
  }
  const preboundTerminalBinding = readBoundNativeAppointmentTerminalBinding(currentDetail)
  if (
    (currentDetail.bookingOwner || currentDetail.terminalToolName) &&
    (
      !preboundTerminalBinding ||
      preboundTerminalBinding.bookingOwner !== normalizedTerminalBinding.bookingOwner ||
      preboundTerminalBinding.terminalToolName !== normalizedTerminalBinding.terminalToolName
    )
  ) {
    return appointmentSelectionError(
      'El responsable de la cita cambió después de ofrecer el horario. No se creó otro cobro; vuelve a confirmar la cita.',
      'appointment_request_contract_conflict'
    )
  }

  const nextDetail = {
    ...currentDetail,
    appointmentRequestDraft: draft,
    appointmentRequestDraftHash: draftHash,
    ...normalizedTerminalBinding,
    appointmentRequestDraftBoundAt: new Date().toISOString()
  }
  const updated = await db.run(
    `UPDATE conversational_agent_events SET detail_json = ?
     WHERE id = ? AND event_type = ? AND detail_json = ?`,
    [JSON.stringify(nextDetail), eventId, eventType, current.detail_json]
  )
  if (Number(updated?.changes ?? updated?.rowCount ?? 0) !== 1) {
    const replay = await db.get(
      `SELECT id, contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [eventId]
    )
    const replayDetail = parseNativeEventDetail(replay?.detail_json)
    if (!identityMatches(replay, replayDetail) || !exactDraftAlreadyBound(replayDetail)) {
      return appointmentSelectionError(
        'Otro proceso cambió los datos ligados a la cita mientras se preparaba el anticipo. No se creó ningún cobro.',
        'appointment_request_draft_race'
      )
    }
  }
  return {
    ...confirmationEvidence,
    ok: true,
    appointmentRequestDraft: draft,
    appointmentRequestDraftHash: draftHash,
    ...normalizedTerminalBinding
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
  const channel = normalizeNativeAppointmentChannel(selectionDetail?.channel || ctx?.channel)
  const selectionRequestDraft = readBoundNativeAppointmentRequestDraft(selectionDetail)
  const selectionTerminalBinding = readBoundNativeAppointmentTerminalBinding(selectionDetail)
  if (
    selection?.event_type !== NATIVE_APPOINTMENT_SELECTION_EVENT ||
    String(selection?.contact_id || '') !== contactId ||
    String(selection?.agent_id || '') !== agentId ||
    !nativeAppointmentEventMatchesChannel(selectionDetail, ctx?.channel) ||
    String(selectionDetail.status || '') !== 'active' ||
    String(selectionDetail.executionId || '') !== executionId ||
    !selectionRequestDraft ||
    !selectionTerminalBinding
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
    channel,
    selectionEventId,
    calendarId: selectionDetail.calendarId,
    startTime: selectionDetail.startTime,
    selectionVerifiedAt: selectionDetail.verifiedAt,
    selectionRequestDraftHash: selectionDetail.appointmentRequestDraftHash,
    selectionBookingOwner: selectionTerminalBinding.bookingOwner,
    selectionTerminalToolName: selectionTerminalBinding.terminalToolName,
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
    !nativeAppointmentEventMatchesChannel(storedDetail, channel) ||
    String(storedDetail.executionId || '') !== executionId ||
    String(storedDetail.calendarId || '') !== String(selectionDetail.calendarId || '') ||
    String(storedDetail.startTime || '') !== String(selectionDetail.startTime || '') ||
    String(storedDetail.selectionVerifiedAt || '') !== String(selectionDetail.verifiedAt || '') ||
    String(storedDetail.selectionRequestDraftHash || '') !== String(selectionDetail.appointmentRequestDraftHash || '') ||
    String(storedDetail.selectionBookingOwner || '') !== selectionTerminalBinding.bookingOwner ||
    String(storedDetail.selectionTerminalToolName || '') !== selectionTerminalBinding.terminalToolName ||
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

async function hasNativeAppointmentDepositCollectionScope({
  ctx,
  config,
  method = ''
} = {}) {
  if (ctx?.nativePaymentCollectionScope === 'appointment_deposit') return true
  if (ctx?.dryRun) return false
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const cleanMethod = String(method || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  if (!agentId || !contactId || !cleanMethod) return false
  const intents = await listNativeAppointmentDepositIntents({ agentId, contactId }).catch(() => [])
  return intents.some((intent) => {
    const detail = intent?.detail || {}
    if (!nativeAppointmentEventMatchesChannel(detail, channel)) return false
    const status = String(detail.status || '')
    const methodAllowed = cleanMethod === 'paymentLink'
      ? detail.methods?.paymentLink === true
      : detail.methods?.bankTransfer === true
    if (!methodAllowed) return false
    if (status === 'pending') return true
    if (status === 'collecting') return String(detail.collectionMethod || '') === cleanMethod
    if (status === 'source_bound') return String(detail.collectionMethod || '') === cleanMethod
    return false
  })
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
  enforceSourceBoundFreshness = false,
  expectedClaimKey = ''
} = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  const executionId = String(ctx?.executionId || '').trim()
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
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
    !nativeAppointmentEventMatchesChannel(detail, channel) ||
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
  const selectionRequestDraft = readBoundNativeAppointmentRequestDraft(selectionDetail)
  const selectionTerminalBinding = readBoundNativeAppointmentTerminalBinding(selectionDetail)
  const configuredCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
  const startMs = Date.parse(selectionDetail.startTime || '')
  const verifiedMs = Date.parse(selectionDetail.verifiedAt || '')
  if (
    selection?.event_type !== NATIVE_APPOINTMENT_SELECTION_EVENT ||
    String(selection?.contact_id || '') !== contactId ||
    String(selection?.agent_id || '') !== agentId ||
    !nativeAppointmentEventMatchesChannel(selectionDetail, channel) ||
    ((!sourceAlreadyBound || enforceSourceBoundFreshness) && String(selectionDetail.status || '') !== 'active') ||
    String(selectionDetail.calendarId || '') !== String(detail.calendarId || '') ||
    String(selectionDetail.startTime || '') !== String(detail.startTime || '') ||
    String(selectionDetail.verifiedAt || '') !== String(detail.selectionVerifiedAt || '') ||
    !selectionRequestDraft ||
    !selectionTerminalBinding ||
    String(selectionDetail.appointmentRequestDraftHash || '') !== String(detail.selectionRequestDraftHash || '') ||
    selectionTerminalBinding.bookingOwner !== String(detail.selectionBookingOwner || '') ||
    selectionTerminalBinding.terminalToolName !== String(detail.selectionTerminalToolName || '') ||
    ((!sourceAlreadyBound || enforceSourceBoundFreshness) && String(configuredCalendar?.id || '') !== String(detail.calendarId || '')) ||
    !Number.isFinite(startMs) ||
    ((!sourceAlreadyBound || enforceSourceBoundFreshness) && startMs <= now) ||
    (!sourceAlreadyBound && enforceSelectionCollectionTtl && (!Number.isFinite(verifiedMs) || now - verifiedMs > NATIVE_APPOINTMENT_SELECTION_COLLECTION_TTL_MS))
  ) {
    return appointmentSelectionError(
      'La selección ligada al anticipo está vencida, ya cambió o pertenece a otro calendario. No se creó ningún cobro.',
      'appointment_deposit_selection_stale'
    )
  }
  if (requireAvailableSlot && (!sourceAlreadyBound || enforceSourceBoundFreshness)) {
    const timezone = await getAccountTimezone()
    const slotValidation = await revalidateAppointmentSlot({
      calendarId: configuredCalendar.id,
      requestedStartTime: new Date(startMs).toISOString(),
      windowStart: normalizeDateOnlyInTimezone(new Date(startMs - 86400000).toISOString(), timezone),
      windowEnd: normalizeDateOnlyInTimezone(new Date(startMs + 86400000).toISOString(), timezone),
      lookupSlots: lookupVerifiedAppointmentSlots,
      ignoreAppointmentConflicts: nativeCalendarAllowsOverlaps(configuredCalendar)
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
  const channel = normalizeNativeAppointmentChannel(ctx?.channel)
  const intents = await listNativeAppointmentDepositIntents({ agentId, contactId })
  const matches = intents.filter((intent) => (
    nativeAppointmentEventMatchesChannel(intent.detail, channel) &&
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
    if (matches.length === 0) {
      const sourceBoundCandidates = intents.filter((intent) => (
        nativeAppointmentEventMatchesChannel(intent.detail, channel) &&
        String(intent.detail?.status || '') === 'source_bound' &&
        String(intent.detail?.collectionMethod || '') === 'paymentLink' &&
        Boolean(String(intent.detail?.sourceEventId || '').trim()) &&
        intent.detail?.methods?.paymentLink === true
      ))
      const reusableCandidates = []
      let singleCandidateError = null
      for (const candidate of sourceBoundCandidates) {
        const validated = await validateNativeAppointmentDepositIntent({
          ctx,
          config,
          scheduleCapability,
          intent: candidate,
          method: 'paymentLink',
          requireSameExecution: false,
          enforceSelectionCollectionTtl: false,
          enforceSourceBoundFreshness: true,
          expectedClaimKey: candidate.detail.sourceEventId
        })
        if (!validated.ok) {
          if (sourceBoundCandidates.length === 1) singleCandidateError = validated
          continue
        }
        reusableCandidates.push({ candidate, validated })
      }
      if (reusableCandidates.length === 1) {
        const { candidate, validated } = reusableCandidates[0]
        return {
          ...validated,
          reuseOnly: true,
          canonicalSourceEventId: String(candidate.detail.sourceEventId || '').trim(),
          canonicalClaimToken: String(candidate.detail.claimToken || '').trim() || null
        }
      }
      if (singleCandidateError) return singleCandidateError
    }
    return appointmentSelectionError(
      'No hay un único intento de anticipo vigente para este mensaje y horario. Vuelve a confirmar el horario.',
      'appointment_deposit_intent_required'
    )
  }
  const validated = await validateNativeAppointmentDepositIntent({
    ctx,
    config,
    scheduleCapability,
    intent: matches[0],
    method: 'paymentLink',
    requireSameExecution: true,
    enforceSelectionCollectionTtl: true,
    expectedClaimKey: cleanClaimKey
  })
  return validated.ok ? { ...validated, reuseOnly: false } : validated
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
      nativeAppointmentEventMatchesChannel(intent.detail, channel) &&
      intent.detail?.methods?.bankTransfer === true &&
      (Date.parse(intent.detail?.createdAt || intent.created_at || '') || 0) >= recentAfter &&
      (!Number.isFinite(receiptReceivedMs) || receiptReceivedMs >= (Date.parse(intent.detail?.createdAt || intent.created_at || '') || 0))
    ))
    const now = Date.now()
    const activeIntents = recent.filter((intent) => {
      const status = String(intent.detail?.status || '')
      if (Date.parse(intent.detail?.expiresAt || '') <= now) return false
      return status === 'pending' || (
        status === 'collecting' && String(intent.detail?.collectionMethod || '') === 'bankTransfer'
      )
    })
    const candidates = activeIntents.filter((intent) => (
      String(intent.detail?.status || '') === 'pending' ||
      String(intent.detail?.claimKey || '') === bindingEventId
    ))
    const conflictingClaim = activeIntents.some((intent) => (
      String(intent.detail?.status || '') === 'collecting' &&
      String(intent.detail?.claimKey || '') !== bindingEventId
    ))
    const intent = candidates.length === 1 && !conflictingClaim ? candidates[0] : null
    const ambiguousIntent = candidates.length > 1 || conflictingClaim
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
      selectionRequestDraftHash: intent?.detail?.selectionRequestDraftHash || null,
      selectionBookingOwner: intent?.detail?.selectionBookingOwner || null,
      selectionTerminalToolName: intent?.detail?.selectionTerminalToolName || null,
      ambiguousIntent,
      alternateSource: false,
      possibleDoublePayment: false,
      candidateIntentCount: activeIntents.length,
      needsHumanReview: ambiguousIntent,
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
    String(bindingDetail.channel || '') !== channel ||
    String(bindingDetail.receiptMessageId || '') !== cleanReceiptMessageId
  ) {
    return appointmentSelectionError('El comprobante ya quedó ligado a otro intento.', 'appointment_deposit_receipt_binding_conflict')
  }
  if (!bindingDetail.intentEventId) {
    return {
      ok: true,
      manualReviewOnly: true,
      needsHumanReview: bindingDetail.needsHumanReview === true,
      ambiguousIntent: bindingDetail.ambiguousIntent === true,
      candidateIntentCount: Number(bindingDetail.candidateIntentCount) || 0,
      staleReasons: bindingDetail.ambiguousIntent === true ? ['appointment_intent_ambiguous'] : [],
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
  const selectionTerminalBinding = readBoundNativeAppointmentTerminalBinding(selection?.detail)
  if (
    intent?.event_type !== NATIVE_APPOINTMENT_DEPOSIT_INTENT_EVENT ||
    String(intent?.contact_id || '') !== contactId ||
    String(intent?.agent_id || '') !== agentId ||
    !nativeAppointmentEventMatchesChannel(intent?.detail, channel) ||
    selection?.event_type !== NATIVE_APPOINTMENT_SELECTION_EVENT ||
    String(selection?.contact_id || '') !== contactId ||
    String(selection?.agent_id || '') !== agentId ||
    !nativeAppointmentEventMatchesChannel(selection?.detail, channel) ||
    String(selection?.id || '') !== String(bindingDetail.selectionEventId || '') ||
    !readBoundNativeAppointmentRequestDraft(selection?.detail) ||
    !selectionTerminalBinding ||
    String(selection?.detail?.appointmentRequestDraftHash || '') !== String(intent?.detail?.selectionRequestDraftHash || '') ||
    String(selection?.detail?.appointmentRequestDraftHash || '') !== String(bindingDetail.selectionRequestDraftHash || '') ||
    selectionTerminalBinding.bookingOwner !== String(intent?.detail?.selectionBookingOwner || '') ||
    selectionTerminalBinding.bookingOwner !== String(bindingDetail.selectionBookingOwner || '') ||
    selectionTerminalBinding.terminalToolName !== String(intent?.detail?.selectionTerminalToolName || '') ||
    selectionTerminalBinding.terminalToolName !== String(bindingDetail.selectionTerminalToolName || '')
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
    const expectedSourceEventId = buildNativeTransferProofBindingEventId({
      contactId,
      channel,
      receiptMessageId: cleanReceiptMessageId
    })
    if (expectedSourceEventId && String(intent.detail?.sourceEventId || '') === expectedSourceEventId) {
      const exactClaim = await claimNativeAppointmentDepositIntent({
        intent,
        selection,
        method: 'bankTransfer',
        claimKey: bindingEventId,
        allowStaleEvidence: true
      })
      if (exactClaim.ok) {
        return {
          ok: true,
          intent: exactClaim.intent,
          selection,
          claim: exactClaim,
          staleReasons: [],
          needsHumanReview: false,
          receiptIntentBindingEventId: bindingEventId
        }
      }
    }
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
  const configuredTerminalBinding = buildNativeAppointmentTerminalBinding(
    scheduleCapability,
    selectionTerminalBinding.terminalToolName
  )
  if (configuredTerminalBinding?.bookingOwner !== selectionTerminalBinding.bookingOwner) {
    staleReasons.push('booking_owner_changed')
  }
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
  const selectionTerminalBinding = readBoundNativeAppointmentTerminalBinding(selection?.detail)
  if (!selectionTerminalBinding) return { ok: false }
  return db.transaction(async () => {
    const current = await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [intent.id])
    const detail = parseNativeEventDetail(current?.detail_json)
    if (
      String(detail.status || '') === 'source_bound' &&
      String(detail.collectionMethod || '') === cleanMethod &&
      String(detail.sourceEventId || '') === cleanClaimKey &&
      String(detail.claimToken || '') === claimToken &&
      String(detail.selectionBookingOwner || '') === selectionTerminalBinding.bookingOwner &&
      String(detail.selectionTerminalToolName || '') === selectionTerminalBinding.terminalToolName
    ) {
      return { ok: true, claimToken, reused: true, sourceAlreadyBound: true, intent: { ...intent, detail } }
    }
    if (
      String(detail.status || '') === 'collecting' &&
      String(detail.claimToken || '') === claimToken &&
      String(detail.collectionMethod || '') === cleanMethod &&
      String(detail.claimKey || '') === cleanClaimKey &&
      String(detail.selectionBookingOwner || '') === selectionTerminalBinding.bookingOwner &&
      String(detail.selectionTerminalToolName || '') === selectionTerminalBinding.terminalToolName
    ) {
      return { ok: true, claimToken, reused: true, intent: { ...intent, detail } }
    }
    const claimableStatus = String(detail.status || '') === 'pending' || (
      allowStaleEvidence && String(detail.status || '') === 'superseded'
    )
    if (
      !claimableStatus ||
      String(detail.selectionEventId || '') !== String(selection.id) ||
      String(detail.selectionBookingOwner || '') !== selectionTerminalBinding.bookingOwner ||
      String(detail.selectionTerminalToolName || '') !== selectionTerminalBinding.terminalToolName
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
  const selectionTerminalBinding = readBoundNativeAppointmentTerminalBinding(selection?.detail)
  if (!selectionTerminalBinding) return false
  const current = await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [intent.id])
  const detail = parseNativeEventDetail(current?.detail_json)
  if (
    String(detail.status || '') === 'source_bound' &&
    String(detail.selectionEventId || '') === String(selection.id) &&
    String(detail.sourceEventId || '') === String(sourceEventId) &&
    String(detail.selectionBookingOwner || '') === selectionTerminalBinding.bookingOwner &&
    String(detail.selectionTerminalToolName || '') === selectionTerminalBinding.terminalToolName
  ) return true
  if (
    String(detail.status || '') !== 'collecting' ||
    String(detail.selectionEventId || '') !== String(selection.id) ||
    String(detail.claimToken || '') !== String(claimToken || '') ||
    String(detail.collectionMethod || '') !== String(method || '') ||
    String(detail.selectionBookingOwner || '') !== selectionTerminalBinding.bookingOwner ||
    String(detail.selectionTerminalToolName || '') !== selectionTerminalBinding.terminalToolName
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
  const terminalBinding = readBoundNativeAppointmentTerminalBinding(detail)
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
    String(sourceDetail.appointmentSelectionVerifiedAt || '') === String(detail.verifiedAt || '') &&
    String(sourceDetail.appointmentSelectionRequestDraftHash || '') === String(detail.appointmentRequestDraftHash || '') &&
    terminalBinding &&
    String(sourceDetail.appointmentSelectionBookingOwner || '') === terminalBinding.bookingOwner &&
    String(sourceDetail.appointmentSelectionTerminalToolName || '') === terminalBinding.terminalToolName &&
    String(reconciliationDetail.appointmentSelectionBookingOwner || '') === terminalBinding.bookingOwner &&
    String(reconciliationDetail.appointmentSelectionTerminalToolName || '') === terminalBinding.terminalToolName
  )
  if (!identityMatches) {
    return appointmentSelectionError(
      'La selección ligada al pago no coincide con agente, contacto, calendario y horario solicitados. No se agendó nada.',
      'payment_resume_selection_mismatch'
    )
  }
  const appointmentRequestDraft = readBoundNativeAppointmentRequestDraft(detail)
  if (!appointmentRequestDraft) {
    return appointmentSelectionError(
      'El anticipo sí está confirmado, pero el intento anterior no conserva de forma segura para quién era la cita. No se agendó nada; confirma de nuevo los asistentes o pasa el caso al equipo.',
      'payment_resume_appointment_request_draft_missing'
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
    appointmentRequestDraft,
    appointmentRequestDraftHash: String(detail.appointmentRequestDraftHash || '').trim(),
    bookingOwner: terminalBinding.bookingOwner,
    terminalToolName: terminalBinding.terminalToolName,
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
    if (!offerAuthorization.ok) return offerAuthorization
    const runtimeScope = await validateNativeAppointmentOfferRuntimeScope({
      ctx,
      config,
      offerDetail: offerAuthorization.offerDetail,
      calendarId,
      timezone
    })
    return runtimeScope.ok
      ? { ...paymentEvidence, offerEventId: offerAuthorization.offerEventId }
      : runtimeScope
  }
  const candidate = await loadNativeAppointmentOfferCandidate({ ctx, config })
  if (!candidate.ok) return candidate
  const startTime = String(candidate.offer?.detail?.startTime || '').trim()
  const offerTimezone = String(candidate.offer?.detail?.timezone || timezone || '').trim()
  const runtimeScope = await validateNativeAppointmentOfferRuntimeScope({
    ctx,
    config,
    offerDetail: candidate.offer?.detail,
    calendarId,
    timezone
  })
  if (!runtimeScope.ok) return runtimeScope
  if (candidate.offer.testPaymentResume === true) {
    // El webhook sandbox ya probó el hecho importante: el anticipo pagado está
    // ligado criptográficamente a esta oferta preview exacta. El mensaje que
    // reanuda el flujo puede ser el mismo transcript que creó el link y no debe
    // reinterpretarse como una segunda confirmación textual. La identidad, el
    // fingerprint, el calendario y el UTC ya fueron revalidados en el loader y
    // volverán a comprobarse al persistir/materializar el efecto temporal.
    const appointmentRequestDraft = readBoundNativeAppointmentRequestDraft(candidate.offer.detail)
    const terminalBinding = readBoundNativeAppointmentTerminalBinding(candidate.offer.detail)
    if (!appointmentRequestDraft || !terminalBinding) {
      return appointmentSelectionError(
        'El pago sandbox sí está confirmado, pero la prueba anterior no conserva de forma segura para quién era la cita o quién debía terminarla. Reinicia el tester y vuelve a intentarlo.',
        'appointment_test_payment_resume_contract_missing'
      )
    }
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
      appointmentRequestDraft,
      appointmentRequestDraftHash: String(candidate.offer.detail.appointmentRequestDraftHash || '').trim(),
      bookingOwner: terminalBinding.bookingOwner,
      terminalToolName: terminalBinding.terminalToolName,
      durable: true,
      preview: true,
      reusedForTestPaymentResume: true,
      testPaymentEffectId: String(ctx?.testVerifiedPaymentEvidence?.testEffectId || '').trim() || null,
      purpose: String(candidate.offer.detail.purpose || 'book') === 'reschedule' ? 'reschedule' : 'book',
      appointmentId: String(candidate.offer.detail.appointmentId || '').trim() || null
    }
  }
  const resolverAuthority = ctx?.appointmentOfferResolutionAuthority
  const resolverAuthorized = Boolean(
    resolverAuthority?.decision === 'accept' &&
    String(resolverAuthority.offerEventId || '') === String(candidate.offer.id || '') &&
    String(resolverAuthority.executionId || '') === executionId &&
    String(resolverAuthority.calendarId || '') === String(calendarId || '') &&
    String(resolverAuthority.startTime || '') === startTime &&
    String(resolverAuthority.terminalToolName || '') &&
    String(resolverAuthority.terminalToolName || '') === String(ctx?.appointmentOfferDecision?.terminalToolName || '')
  )
  if (resolverAuthorized) {
    const conversationMessages = ctx?.dryRun && Array.isArray(ctx?.appointmentTranscriptEvidenceMessages)
      ? ctx.appointmentTranscriptEvidenceMessages
      : (Array.isArray(ctx?.conversationMessages) ? ctx.conversationMessages : [])
    const offerSourceMessageId = String(candidate.offer.detail.offerSourceMessageId || '').trim()
    const legacyOfferSourceExecutionId = String(candidate.offer.detail.executionId || '').trim()
    const offerSourceMessageQuoteHash = String(candidate.offer.detail.offerSourceMessageQuoteHash || '').trim()
    let latestCustomerIndex = -1
    for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
      const message = conversationMessages[index]
      if (
        isCustomerAppointmentMessage(message) &&
        (ctx?.dryRun || String(message?.id || '').trim() === executionId) &&
        appointmentMessageText(message)
      ) {
        latestCustomerIndex = index
        break
      }
    }
    const expectedOfferText = String(candidate.offer.detail.offerText || '').replace(/\s+/g, ' ').trim()
    let visibleOfferMessage = null
    let visibleOfferIndex = -1
    for (let index = latestCustomerIndex - 1; index >= 0; index -= 1) {
      const message = conversationMessages[index]
      const messageText = appointmentMessageText(message).replace(/\s+/g, ' ').trim()
      if (String(message?.role || '').trim().toLowerCase() === 'assistant' && messageText === expectedOfferText) {
        visibleOfferMessage = message
        visibleOfferIndex = index
        break
      }
    }
    let offerSourceCustomerIndex = -1
    const sourceIdentity = offerSourceMessageId || legacyOfferSourceExecutionId
    for (let index = 0; index < visibleOfferIndex; index += 1) {
      const message = conversationMessages[index]
      if (
        isCustomerAppointmentMessage(message) &&
        String(message?.id || '').trim() === sourceIdentity &&
        appointmentMessageText(message)
      ) {
        offerSourceCustomerIndex = index
        break
      }
    }
    // Compatibilidad de despliegue: las ofertas preview creadas antes de que el
    // transcript tuviera identidad estable sólo guardaban el executionId del
    // request. En dry-run la oferta durable ya está ligada a scope, agente,
    // contacto, calendario y UTC; por eso podemos recuperar de forma segura el
    // último mensaje de cliente anterior a la burbuja exacta de esa oferta.
    if (offerSourceCustomerIndex < 0 && ctx?.dryRun && !offerSourceMessageId) {
      for (let index = visibleOfferIndex - 1; index >= 0; index -= 1) {
        const message = conversationMessages[index]
        if (isCustomerAppointmentMessage(message) && appointmentMessageText(message)) {
          offerSourceCustomerIndex = index
          break
        }
      }
    }
    const offerSourceCustomerMessage = offerSourceCustomerIndex >= 0
      ? conversationMessages[offerSourceCustomerIndex]
      : null
    const sourceQuote = appointmentMessageText(offerSourceCustomerMessage)
    const sourceQuoteMatches = !offerSourceMessageQuoteHash || (
      sourceQuote && createHash('sha256').update(sourceQuote).digest('hex') === offerSourceMessageQuoteHash
    )
    const latestCustomerMessage = latestCustomerIndex >= 0 ? conversationMessages[latestCustomerIndex] : null
    const customerQuote = appointmentMessageText(latestCustomerMessage)
    const visibleOfferMessageId = String(visibleOfferMessage?.id || '').trim()
    const historyOfferVisibilityVerified = Boolean(
      sourceIdentity &&
      offerSourceCustomerIndex >= 0 &&
      sourceQuoteMatches &&
      visibleOfferIndex > offerSourceCustomerIndex &&
      latestCustomerIndex > offerSourceCustomerIndex &&
      customerQuote &&
      visibleOfferMessageId &&
      expectedOfferText
    )
    const durableOfferDelivery = !historyOfferVisibilityVerified && customerQuote && expectedOfferText
      ? await verifyNativeAppointmentOfferReplyDelivery({ ctx, config, offer: candidate.offer })
      : null
    if (!historyOfferVisibilityVerified && !durableOfferDelivery) {
      return appointmentSelectionError(
        'La resolución nativa no puede demostrar que la persona vio esta oferta exacta antes de responder. No se agendó nada.',
        'appointment_resolver_visible_offer_missing'
      )
    }
    const offerVisibilityEvidence = historyOfferVisibilityVerified
      ? {
          offerMessageId: visibleOfferMessageId,
          offerTurnId: String(
            visibleOfferMessage?.turnId ||
            visibleOfferMessage?.turn_id ||
            visibleOfferMessage?.executionId ||
            visibleOfferMessage?.execution_id ||
            ''
          ).trim() || `assistant-turn:${visibleOfferMessageId}`,
          offerTurnMessageIds: [visibleOfferMessageId],
          offerVisibilityEvidenceSource: 'conversation_history',
          offerSourceMessageId: String(offerSourceCustomerMessage?.id || sourceIdentity).trim() || null
        }
      : durableOfferDelivery
    return {
      ok: true,
      evidenceVerified: true,
      nativeToolDecision: true,
      resolverDecision: true,
      selectionMode: 'accepted_prior_offer',
      selectedStartTime: startTime,
      customerQuote,
      customerMessageId: executionId,
      customerMessageIds: [executionId],
      latestCustomerMessageId: executionId,
      assistantOfferQuote: candidate.offer.detail.localLabel || null,
      localLabel: candidate.offer.detail.localLabel || null,
      timezone: offerTimezone || null,
      ...offerVisibilityEvidence,
      offerEventId: candidate.offer.id,
      purpose: String(candidate.offer.detail.purpose || 'book') === 'reschedule' ? 'reschedule' : 'book',
      appointmentId: String(candidate.offer.detail.appointmentId || '').trim() || null
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
    // En producción el id del mensaje inbound ES el executionId. En preview
    // son identidades separadas a propósito: executionId protege idempotencia
    // del request y el id estable del transcript prueba el orden visible.
    executionId: ctx?.dryRun ? '' : executionId,
    evidence: selectionEvidence
  })
  if (!verified.ok) return verified
  const evidence = {
    ...verified,
    offerEventId: candidate.offer.id,
    offerSourceMessageId: String(candidate.offer.detail.offerSourceMessageId || '').trim() || null
  }
  const offerAuthorization = await verifyNativeAppointmentOfferEvent({
    ctx,
    config,
    calendarId,
    startTime,
    evidence
  })
  return offerAuthorization.ok
    ? {
        ...evidence,
        offerEventId: offerAuthorization.offerEventId,
        purpose: String(candidate.offer.detail.purpose || 'book') === 'reschedule' ? 'reschedule' : 'book',
        appointmentId: String(candidate.offer.detail.appointmentId || '').trim() || null
      }
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
  if (capability?.collectionMethod === 'bank_transfer') {
    return { paymentLink: false, bankTransfer: true }
  }
  if (capability?.collectionMethod === 'payment_link') {
    return { paymentLink: true, bankTransfer: false }
  }
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
  // Esta función sólo se invoca desde el borde terminal de una cita cuya oferta
  // ya fue aceptada. A partir de aquí el cobro sí queda ligado a ese horario.
  const nativePaymentPurpose = 'appointment_deposit'
  ctx.nativePaymentCollectionScope = nativePaymentPurpose
  const executionId = String(ctx.executionId || '').trim()
  const reconciliationId = executionId.startsWith('payment-resume:')
    ? executionId.slice('payment-resume:'.length).trim()
    : ''
  const paymentLabel = getDepositRequirementLabel(ctx, config)
  if (ctx.dryRun && ctx.testVerifiedPaymentEvidence && typeof ctx.testVerifiedPaymentEvidence === 'object') {
    const evidence = ctx.testVerifiedPaymentEvidence
    const evidenceTerminalBinding = normalizeNativeAppointmentTerminalBinding(evidence)
    const configuredTerminalBinding = buildNativeAppointmentTerminalBinding(
      getNativeCapability(ctx, config, 'schedule_appointment'),
      evidenceTerminalBinding?.terminalToolName
    )
    const expectedCurrency = String(deposit.currency || accountLocale.currency || '').trim().toUpperCase()
    const testEvidenceMatches = Boolean(
      String(evidence.paymentMode || '').toLowerCase() === 'test' &&
      String(evidence.paymentPurpose || '') === 'appointment_deposit' &&
      String(evidence.previewScopeId || '') === String(ctx.previewScopeId || '') &&
      String(evidence.calendarId || '') === String(calendarId || '') &&
      String(evidence.startTime || '') === String(startTime || '') &&
      evidenceTerminalBinding &&
      configuredTerminalBinding &&
      configuredTerminalBinding.bookingOwner === evidenceTerminalBinding.bookingOwner &&
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
      appointmentRequestId,
      expectedReconciliationClaimToken: String(ctx.paymentResumeClaim?.claimToken || '').trim()
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

function receiptMediaFromMessage(message = {}, { fallbackMessageId = '', allowStoredMedia = true } = {}) {
  const messageId = String(message.id || message.messageId || fallbackMessageId || '').trim()
  if (!messageId) return null
  const receivedAt = message.messageTimestamp || message.message_timestamp || message.timestamp || message.createdAt || message.created_at || null
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  for (let attachmentIndex = attachments.length - 1; attachmentIndex >= 0; attachmentIndex -= 1) {
    const attachment = attachments[attachmentIndex] || {}
    const mimeType = String(attachment.mimeType || attachment.media_mime_type || '').trim().toLowerCase()
    const kind = String(attachment.kind || attachment.type || '').trim().toLowerCase()
    const mediaUrl = String(attachment.dataUrl || attachment.mediaUrl || attachment.media_url || '').trim()
    if (!mediaUrl || (!mimeType.startsWith('image/') && mimeType !== 'application/pdf' && !['image', 'pdf'].includes(kind))) continue
    return { messageId, mediaUrl, mimeType, receivedAt }
  }

  if (!allowStoredMedia) return null
  const storedMediaUrl = String(message.media_url || message.mediaUrl || '').trim()
  const storedMimeType = String(message.media_mime_type || message.mediaMimeType || '').trim().toLowerCase()
  if (storedMediaUrl && (storedMimeType.startsWith('image/') || storedMimeType === 'application/pdf')) {
    return { messageId, mediaUrl: storedMediaUrl, mimeType: storedMimeType, receivedAt }
  }
  return null
}

function receiptMediaIsInsideLiveWindow(receivedAt) {
  if (!receivedAt) return true
  const receivedMs = Date.parse(receivedAt)
  if (!Number.isFinite(receivedMs)) return false
  const now = Date.now()
  return receivedMs >= now - RECEIPT_MEDIA_WINDOW_HOURS * 60 * 60 * 1000 && receivedMs <= now + 5 * 60 * 1000
}

// En vivo un comprobante sólo puede venir del mensaje inbound que disparó ESTE
// turno. Nunca se rescata una imagen anterior del historial. En el tester sí se
// permite recorrer adjuntos explícitos porque no existe una fila inbound real.
async function findCurrentInboundReceiptMedia(ctx = {}) {
  const conversationMessages = Array.isArray(ctx.conversationMessages) ? ctx.conversationMessages : []
  if (ctx.dryRun) {
    for (let messageIndex = conversationMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = conversationMessages[messageIndex] || {}
      const role = String(message.role || '').trim().toLowerCase()
      if (!['user', 'customer', 'contact'].includes(role) || !Array.isArray(message.attachments) || !message.attachments.length) continue
      const receipt = receiptMediaFromMessage(message, {
        fallbackMessageId: `preview-receipt-${messageIndex}`,
        allowStoredMedia: false
      })
      if (receipt) return receipt
    }
    return null
  }

  const executionId = String(ctx.executionId || '').trim()
  const contactId = String(ctx.contactId || '').trim()
  if (!executionId || !contactId || executionId.startsWith('payment-resume:')) return null

  const currentMessage = [...conversationMessages].reverse().find((message) => {
    const role = String(message?.role || '').trim().toLowerCase()
    const messageId = String(message?.id || message?.messageId || '').trim()
    return ['user', 'customer', 'contact'].includes(role) && messageId === executionId
  })
  const currentReceipt = currentMessage ? receiptMediaFromMessage(currentMessage) : null
  if (currentReceipt && receiptMediaIsInsideLiveWindow(currentReceipt.receivedAt)) return currentReceipt

  const sinceIso = new Date(Date.now() - RECEIPT_MEDIA_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const mediaFilter = "(LOWER(COALESCE(media_mime_type, '')) LIKE 'image/%' OR LOWER(COALESCE(media_mime_type, '')) = 'application/pdf')"

  const [whatsappRow, metaRow] = await Promise.all([
    db.get(`
      SELECT id, media_url, media_mime_type, COALESCE(message_timestamp, created_at) AS media_at
      FROM whatsapp_api_messages
      WHERE id = ? AND contact_id = ? AND direction = 'inbound'
        AND COALESCE(media_url, '') != '' AND ${mediaFilter}
        AND COALESCE(message_timestamp, created_at) >= ?
      LIMIT 1
    `, [executionId, contactId, sinceIso]).catch(() => null),
    db.get(`
      SELECT id, media_url, media_mime_type, COALESCE(message_timestamp, created_at) AS media_at
      FROM meta_social_messages
      WHERE id = ? AND contact_id = ? AND direction = 'inbound'
        AND COALESCE(media_url, '') != '' AND ${mediaFilter}
        AND COALESCE(message_timestamp, created_at) >= ?
      LIMIT 1
    `, [executionId, contactId, sinceIso]).catch(() => null)
  ])

  const candidates = [whatsappRow, metaRow].filter((row) => row?.media_url)
  if (!candidates.length) return null
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
    executionId: String(ctx?.executionId || '').trim() || null,
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
  const storedExpectedPayment = storedDetail.expectedPayment || {}
  const currentExpectedPayment = detail.expectedPayment
  if (
    stored?.event_type !== 'payment_proof_manual_review_required' ||
    String(stored?.contact_id || '') !== contactId ||
    String(stored?.agent_id || '') !== agentId ||
    String(storedDetail.channel || '') !== channel ||
    String(storedDetail.mediaMessageId || '') !== mediaMessageId ||
    String(storedDetail.executionId || '') !== String(ctx?.executionId || '').trim() ||
    String(storedDetail.paymentPurpose || '') !== String(detail.paymentPurpose || '') ||
    String(storedExpectedPayment.mode || 'fixed') !== String(currentExpectedPayment.mode || 'fixed') ||
    (Number(storedExpectedPayment.amount) || null) !== (Number(currentExpectedPayment.amount) || null) ||
    (Number(storedExpectedPayment.minAmount) || null) !== (Number(currentExpectedPayment.minAmount) || null) ||
    (Number(storedExpectedPayment.maxAmount) || null) !== (Number(currentExpectedPayment.maxAmount) || null) ||
    String(storedExpectedPayment.currency || '').trim().toUpperCase() !== String(currentExpectedPayment.currency || '').trim().toUpperCase() ||
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

async function syncNativeAppointmentCompletion({
  ctx,
  config,
  appointment,
  calendarId,
  terminalAuthorityToken = '',
  authorityFence = null,
  beforeDurableCommit = null
}) {
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
  const cleanTerminalAuthorityToken = String(terminalAuthorityToken || '').trim()
  let eventAlreadyRecorded = false

  await db.transaction(async () => {
    if (typeof authorityFence === 'function') await authorityFence()
    eventAlreadyRecorded = Boolean(await db.get(
      'SELECT id FROM conversational_agent_events WHERE id = ?',
      [appointmentEventId]
    ))
    if (eventAlreadyRecorded) return
    if (typeof beforeDurableCommit === 'function') await beforeDurableCommit()
    if (cleanTerminalAuthorityToken) {
      await claimConversationalTerminalMutationAuthority({
        contactId: ctx.contactId,
        agentId,
        channel: ctx.channel || 'whatsapp',
        authorityToken: cleanTerminalAuthorityToken,
        database: db
      })
    }

    await setConversationSignal(ctx.contactId, 'appointment_booked', {
      reason: 'Cita agendada por el agente',
      actionSummarySource: technicalSummary,
      originalSummary: technicalSummary,
      status: 'completed',
      agentId,
      channel: ctx.channel,
      eventId: `cae_appointment_signal_${digest}`,
      strictEvent: true,
      expectedUpdatedBy: cleanTerminalAuthorityToken
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
  })

  if (eventAlreadyRecorded) return { completed: true, replayed: true }
  const paymentReconciliationId = String(ctx.paymentResumeClaim?.reconciliationId || '').trim()
  if (paymentReconciliationId) {
    await notifyConversationalAiBookingDeposit({
      reconciliationId: paymentReconciliationId,
      contactId: ctx.contactId,
      title,
      startTime
    })
  } else {
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
  const currentReconciliationClaimToken = String(ctx.paymentResumeClaim?.claimToken || '').trim()
  const currentReconciliationId = String(ctx.paymentResumeClaim?.reconciliationId || '').trim()
  if (currentReconciliationId && String(detail.reconciliationId || '') !== currentReconciliationId) {
    throw new Error('La cita pertenece a otra reconciliación de anticipo')
  }
  // Un consumo ya confirmado junto con esta misma cita es el efecto durable
  // que un claim nuevo debe recuperar tras un crash. El token viejo ya no
  // autoriza mutaciones, pero tampoco invalida una cita que sí quedó creada.
  if (detail.status === 'consumed' && detail.appointmentId === appointmentId) {
    return { consumed: true, replayed: true }
  }
  if (
    currentReconciliationClaimToken &&
    String(detail.reconciliationClaimToken || '') !== currentReconciliationClaimToken
  ) {
    throw new Error('La reserva de la cita pertenece a otro intento de reconciliación')
  }
  if (detail.status !== 'reserved') {
    throw new Error('La reserva del anticipo no coincide con la cita canónica')
  }
  return consumeConversationalAppointmentDepositEvidence({
    reconciliationId: detail.reconciliationId,
    contactId: ctx.contactId,
    agentId: config.id || ctx.agentId || '',
    paymentId: detail.ledgerPaymentId,
    reconciliationClaimToken: currentReconciliationClaimToken,
    reservationClaimToken: currentReconciliationClaimToken ? detail.claimToken : '',
    appointmentRequestId: request.client_request_id,
    appointmentId
  })
}

const NATIVE_APPOINTMENT_BINDING_EVENT = 'appointment_creation_binding_v2'
const NATIVE_APPOINTMENT_CREATION_RETRY_EVENT = 'appointment_creation_retry'

function freezeNativeAppointmentControllerValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const nested of Object.values(value)) {
    freezeNativeAppointmentControllerValue(nested, seen)
  }
  return Object.freeze(value)
}

async function recordNativeAppointmentCreationRetry({
  ctx,
  config,
  clientRequestId,
  calendarId,
  startTime,
  failure
} = {}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const cleanClientRequestId = String(clientRequestId || '').trim()
  if (!agentId || !ctx?.contactId || !cleanClientRequestId) return null
  const digest = createHash('sha256')
    .update([agentId, cleanClientRequestId, '2'].join('\u0000'))
    .digest('hex')
    .slice(0, 48)
  try {
    return await recordConversationalAgentEvent({
      eventId: `cae_appointment_retry_${digest}`,
      contactId: ctx.contactId,
      eventType: NATIVE_APPOINTMENT_CREATION_RETRY_EVENT,
      detail: {
        agentId,
        attempt: 2,
        statusCode: failure?.statusCode || null,
        code: String(failure?.code || 'controller_failure').slice(0, 120),
        calendarId: String(calendarId || '').trim() || null,
        startTime: String(startTime || '').trim() || null
      }
    })
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo auditar el retry de creación de cita: ${error.message}`)
    return null
  }
}

async function invokeNativeAppointmentCreateController(requestOptions, attempt) {
  const invoke = () => invokeController(createAppointment, requestOptions)
  if (!nativeAppointmentCreateControllerInvokeHookForTest) return invoke()
  return nativeAppointmentCreateControllerInvokeHookForTest({
    attempt,
    body: requestOptions.body,
    internalContext: requestOptions.internalContext,
    invoke
  })
}

function nativeAppointmentDepositContract(ctx, config) {
  const deposit = getDepositRequirementForRuntime(ctx, config)
  const methods = getDepositPaymentMethodsForRuntime(ctx, config)
  const currency = normalizeCurrencyCode(deposit?.currency || ctx?.accountLocale?.currency || '')
  const canonical = deposit
    ? {
        required: true,
        paymentPurpose: 'appointment_deposit',
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
  const normalizedCapabilitiesConfig = getConversationalCapabilitiesConfig(runtimeConfig)
  const nativeAppointmentExpectedCapabilitiesFingerprint = createHash('sha256')
    .update(JSON.stringify(normalizedCapabilitiesConfig))
    .digest('hex')
  const capabilityManifest = buildConversationalCapabilityManifest({
    capabilitiesConfig: normalizedCapabilitiesConfig
  })
  const availableCapabilityIds = new Set(
    capabilityManifest
      .filter((capability) => capability.enabled && capability.ready)
      .map((capability) => capability.id)
  )
  const availableCapability = (capabilityId) => availableCapabilityIds.has(capabilityId)
    ? normalizedCapabilitiesConfig.items.find((item) => item.id === capabilityId) || null
    : null
  const scheduleCapability = availableCapability('schedule_appointment')
  const paymentCapability = availableCapability('collect_payment')
  const linkCapability = availableCapability('send_link')
  const handoffCapability = availableCapability('handoff_human')
  const customCapability = availableCapability('custom_goal')
  const dataRequirements = buildEffectiveDataRequirements(normalizedCapabilitiesConfig, availableCapabilityIds)
  const safetyPolicy = normalizedCapabilitiesConfig.safetyPolicy || {}
  const baseNativePaymentPurpose = getNativePaymentPurpose(ctx, runtimeConfig)
  const appointmentOfferDecisionMode = ctx.appointmentOfferDecision?.active === true
  const appointmentSelectionProgressMode = !appointmentOfferDecisionMode &&
    ctx.appointmentSelectionProgress?.active === true
  const canResolveOfferWithHandoff = Boolean(handoffCapability)

  const verifiedRescheduleSlotLookup = ({ appointmentId, durationMs } = {}) => (
    calendarId,
    startDate,
    endDate,
    timezone,
    options = {}
  ) => lookupVerifiedAppointmentSlots(calendarId, startDate, endDate, timezone, {
    ...options,
    excludeAppointmentId: appointmentId,
    durationMinutes: Number(durationMs) / 60000
  })

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
    description: ctx.followUpMode
      ? 'Consulta de sólo lectura los datos reales del contacto y sus citas próximas para redactar un seguimiento coherente. En esta vuelta no activa reglas de traspaso ni autoriza acciones: espera una respuesta real de la persona.'
      : (handoffCapability?.pastClientsToHuman
          ? 'Consulta obligatoria antes de seguir: devuelve datos reales del contacto, citas próximas y evidencia factual de cliente previo. Si pastClientEvidence.isPastClient es true, usa send_to_human; no sigas vendiendo ni interrogando.'
          : 'Devuelve los datos reales del contacto con el que conversas (nombre, teléfono, email, datos personalizados) y sus citas próximas. Úsala para no pedir datos que ya existen y para saber si ya tiene cita agendada.'),
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
    description: dataRequirements?.updateContact?.enabled
      ? 'Guarda sólo datos que quien escribe confirmó como propios para el contacto de este mismo hilo. Nunca guarda aquí datos del titular distinto o invitados. No busca ni crea otra ficha; el servidor protege datos existentes y sólo reemplaza cuando la política lo permite.'
      : 'Conserva sólo durante esta vuelta los datos que quien escribe confirmó como propios y que hacen falta para la acción. No modifica la ficha, no busca otro contacto y nunca se usa para datos del titular distinto o invitados.',
    parameters: buildSaveContactDataParameters(dataRequirements.fields),
    execute: async ({ fullName, phone, alternatePhone, email, company, address, customValues } = {}) => {
      if (!Array.isArray(dataRequirements?.fields) || !dataRequirements.fields.length) {
        return { ok: false, actionCompleted: false, error: 'No hay datos de contacto autorizados en esta configuración.' }
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
      if (cleanFullName && isPlaceholderContactName(cleanFullName)) {
        return {
          ok: false,
          actionCompleted: false,
          error: 'El nombre confirmado debe parecer un nombre de persona; no puede ser sólo un teléfono, emojis, símbolos o una etiqueta genérica del canal.'
        }
      }
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
      if (dataRequirements?.updateContact?.enabled !== true) {
        const actionScopedCustomUpdates = []
        if (cleanAlternatePhone) actionScopedCustomUpdates.push({ key: 'alternate_phone', label: 'Teléfono alterno', value: cleanAlternatePhone })
        if (company) actionScopedCustomUpdates.push({ key: 'company', label: 'Empresa', value: cleanAppointmentText(company, 400) })
        if (address) actionScopedCustomUpdates.push({ key: 'address_1', label: 'Dirección', value: cleanAppointmentText(address, 800) })
        for (const item of Array.isArray(customValues) ? customValues : []) {
          const key = normalizeCustomKey(item?.key)
          if (key && allowedCustomFields.has(key)) {
            actionScopedCustomUpdates.push({ key, label: allowedCustomFields.get(key), value: cleanAppointmentText(item.value, 1000) })
          }
        }
        ctx.actionScopedContactData = {
          ...(ctx.actionScopedContactData || {}),
          ...(cleanFullName ? { full_name: cleanFullName } : {}),
          ...(cleanPhone ? { phone: cleanPhone } : {}),
          ...(cleanEmail ? { email: cleanEmail } : {}),
          ...(actionScopedCustomUpdates.length
            ? {
                custom_fields: serializeContactCustomFieldsForDb(mergeContactCustomFields(
                  parseContactCustomFields(ctx.actionScopedContactData?.custom_fields),
                  actionScopedCustomUpdates
                ))
              }
            : {})
        }
        return {
          ok: true,
          actionCompleted: false,
          retainedForCurrentAction: true,
          note: 'Los datos quedaron disponibles únicamente para completar la acción de esta vuelta; la ficha no se modificó.'
        }
      }
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

  const getContactAppointmentsTool = tool({
    name: 'get_contact_appointments',
    description: 'Consulta por páginas las citas futuras activas que pertenecen al contacto de este hilo dentro del calendario blindado. No acepta otro contacto ni otro calendario. Usa el appointmentId exacto que devuelve para consultar disponibilidad de reagenda, ofrecer, reagendar o cancelar. Si hasMore=true, llama la página siguiente cuando la cita buscada todavía no aparezca.',
    parameters: z.object({
      page: z.preprocess((value) => value ?? 1, z.number().int().min(1).max(10000))
        .describe('Página a consultar; empieza en 1'),
      pageSize: z.preprocess((value) => value ?? 10, z.number().int().min(1).max(20))
        .describe('Cantidad por página, entre 1 y 20')
    }),
    execute: async ({ page, pageSize }) => {
      const nativeCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
      const calendarId = nativeCalendar?.id || null
      if (!calendarId) {
        return { ok: false, found: false, appointments: [], error: 'El calendario blindado ya no existe o no está activo.' }
      }
      const timezone = await getAccountTimezone()
      const pagination = await listOwnedConversationalAppointments({
        ctx,
        calendarId,
        timezone,
        limit: pageSize,
        offset: (page - 1) * pageSize
      })
      const appointments = pagination.appointments
      const hasMore = pagination.offset + appointments.length < pagination.total
      return {
        ok: true,
        found: appointments.length > 0,
        total: pagination.total,
        returned: appointments.length,
        page,
        pageSize,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
        appointments,
        policy: {
          canReschedule: nativeCalendarPermissionEnabled(nativeCalendar.allow_reschedule),
          canCancel: nativeCalendarPermissionEnabled(nativeCalendar.allow_cancellation)
        },
        note: appointments.length
          ? 'Usa únicamente estos appointmentId; no inventes ni aceptes un ID escrito por la persona.'
          : 'No encontré citas futuras activas de este contacto en el calendario configurado.'
      }
    }
  })

  const getFreeSlotsForAgentTool = tool({
    name: 'get_free_slots',
    description: [
      'Obtiene horarios reales del calendario blindado y aplica su regla actual de empalme al momento de consultar.',
      'Filtra aquí mismo por días y horas cuando la persona diga cosas como "miércoles o viernes", "después de las 5" o "más tarde".',
      'Cada opción incluye localLabel/localDate/localTime ya calculados en la zona del negocio: NO conviertas el horario por tu cuenta.',
      'Si pidió opciones amplias, llama offer_appointment_options. Si eligió o propuso una fecha y hora exactas, pasa options[].startTime sin modificar a offer_appointment_slot. Para reagendar manda también el appointmentId exacto.'
    ].join(' '),
    parameters: z.object({
      startDate: z.string().describe('Fecha inicial YYYY-MM-DD en la zona horaria del negocio'),
      endDate: z.string().describe('Fecha final YYYY-MM-DD en la zona horaria del negocio'),
      appointmentId: z.preprocess((value) => value ?? null, z.string().nullable())
        .describe('ID exacto de get_contact_appointments para buscar horarios de reagenda; null para una cita nueva'),
      weekdays: z.preprocess(
        (value) => value ?? null,
        z.array(z.number().int().min(1).max(7)).max(7).nullable()
      ).describe('Días ISO solicitados: 1=lunes, 2=martes, ... 7=domingo; null cuando no restringió días'),
      earliestLocalTime: z.preprocess(
        (value) => value ?? null,
        z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable()
      ).describe('Hora local mínima inclusiva HH:mm, por ejemplo 17:00 para "después de las 5"; null si no aplica'),
      latestLocalTime: z.preprocess(
        (value) => value ?? null,
        z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable()
      ).describe('Hora local máxima inclusiva HH:mm; null si no aplica'),
      relativeToPreviousOffer: z.preprocess(
        (value) => value ?? null,
        z.enum(['later', 'earlier']).nullable()
      ).describe('later o earlier cuando pidió algo más tarde/temprano que la última lista mostrada o el horario individual rechazado; null en los demás casos'),
      progressDateAction: z.preprocess(
        (value) => value ?? 'keep_selected_date',
        z.enum(['keep_selected_date', 'replace_selected_date'])
      ).describe('Con fecha activa: keep_selected_date para una hora suelta y replace_selected_date sólo si cambió de día. Si falta fecha, replace_selected_date elige un día exacto y keep_selected_date sólo explora un rango.')
    }),
    execute: async ({
      startDate,
      endDate,
      appointmentId,
      weekdays,
      earliestLocalTime,
      latestLocalTime,
      relativeToPreviousOffer,
      progressDateAction
    }) => {
      delete ctx.nativeAppointmentAvailability
      const nativeCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
      const effectiveCalendarId = nativeCalendar?.id || null
      if (!effectiveCalendarId) {
        return { ok: false, total: 0, slots: [], error: 'El calendario blindado de la capacidad no existe o ya no está activo. Pasa la conversación a una persona.' }
      }
      await hydrateNativeRejectedAppointmentStartTimes({ ctx, config, calendarId: effectiveCalendarId })
      const overlapsAllowed = nativeCalendarAllowsOverlaps(nativeCalendar)
      const accountTimezone = await getAccountTimezone()
      const cleanEarliestLocalTime = normalizeNativeAvailabilityTime(earliestLocalTime)
      const cleanLatestLocalTime = normalizeNativeAvailabilityTime(latestLocalTime)
      if (
        (earliestLocalTime !== null && !cleanEarliestLocalTime) ||
        (latestLocalTime !== null && !cleanLatestLocalTime)
      ) {
        return {
          ok: false,
          total: 0,
          slots: [],
          error: 'La restricción de hora local no es válida. Vuelve a consultar con una hora real entre 00:00 y 23:59.'
        }
      }
      if (
        cleanEarliestLocalTime &&
        cleanLatestLocalTime &&
        nativeLocalTimeToMinutes(cleanEarliestLocalTime) > nativeLocalTimeToMinutes(cleanLatestLocalTime)
      ) {
        return {
          ok: false,
          total: 0,
          slots: [],
          error: 'El horario mínimo quedó después del máximo. Corrige el rango con base en lo que pidió la persona.'
        }
      }
      const requestedAppointmentId = String(appointmentId || '').trim()
      const progressScope = ctx.appointmentSelectionProgress?.active === true
        ? ctx.appointmentSelectionProgress
        : null
      const progressSelectedDate = String(progressScope?.selectedDate || '').trim()
      const progressNeedsDate = progressScope?.appointmentStatus === 'collecting_date'
      const normalizedProgressDateAction = progressDateAction === 'replace_selected_date'
        ? 'replace_selected_date'
        : 'keep_selected_date'
      const cleanStartDate = String(startDate || '').trim()
      const cleanEndDate = String(endDate || '').trim()
      const exactDateQuery = cleanStartDate === cleanEndDate
      const invalidProgressDateTransition = progressNeedsDate
        ? (
            (exactDateQuery && normalizedProgressDateAction !== 'replace_selected_date') ||
            (!exactDateQuery && normalizedProgressDateAction === 'replace_selected_date')
          )
        : Boolean(
            progressScope &&
            (cleanStartDate !== progressSelectedDate || cleanEndDate !== progressSelectedDate) &&
            (normalizedProgressDateAction !== 'replace_selected_date' || !exactDateQuery)
          )
      if (progressScope && invalidProgressDateTransition) {
        return {
          ok: false,
          total: 0,
          slots: [],
          code: 'appointment_progress_date_change_required',
          error: progressNeedsDate
            ? 'Esta selección todavía necesita fecha. Para elegir un día consulta exactamente esa fecha con replace_selected_date; para explorar varios días conserva keep_selected_date.'
            : `Ya está seleccionado el día ${progressSelectedDate}. Para interpretar una hora suelta conserva exactamente ese día; sólo usa replace_selected_date si la persona cambió explícitamente de fecha.`
        }
      }
      const progressAppointmentId = String(progressScope?.appointmentId || '').trim()
      let cleanAppointmentId = requestedAppointmentId
      if (progressScope?.purpose === 'reschedule') {
        if (!progressAppointmentId || (requestedAppointmentId && requestedAppointmentId !== progressAppointmentId)) {
          return {
            ok: false,
            total: 0,
            slots: [],
            code: 'appointment_progress_scope_mismatch',
            error: 'La selección parcial pertenece a otra cita. Reinicia la búsqueda antes de cambiar entre cita nueva y reagenda.'
          }
        }
        // El ID de la cita es un hecho durable del servidor; no dependemos de
        // que el modelo lo vuelva a copiar en cada mensaje.
        cleanAppointmentId = progressAppointmentId
      } else if (progressScope?.purpose === 'book' && requestedAppointmentId) {
        return {
          ok: false,
          total: 0,
          slots: [],
          code: 'appointment_progress_scope_mismatch',
          error: 'La selección parcial corresponde a una cita nueva. Reinicia la búsqueda antes de convertirla en reagenda.'
        }
      }
      let rescheduledAppointment = null
      let durationMs = NaN
      if (cleanAppointmentId) {
        if (!nativeCalendarPermissionEnabled(nativeCalendar.allow_reschedule)) {
          return { ok: false, total: 0, slots: [], error: 'Este calendario no permite reagendar citas. Pasa la conversación a una persona.' }
        }
        rescheduledAppointment = await loadOwnedConversationalAppointment({
          ctx,
          calendarId: effectiveCalendarId,
          appointmentId: cleanAppointmentId
        })
        if (!rescheduledAppointment || INACTIVE_APPOINTMENT_STATUSES.has(nativeAppointmentStatus(rescheduledAppointment))) {
          return { ok: false, total: 0, slots: [], error: 'No encontré una cita futura activa de este contacto que pueda cambiarse.' }
        }
        durationMs = nativeAppointmentDurationMs(rescheduledAppointment)
        if (!Number.isFinite(durationMs)) {
          return { ok: false, total: 0, slots: [], error: 'La cita no conserva una duración válida y no puede reagendarse automáticamente.' }
        }
      }
      const replacingSelectedDate = Boolean(
        progressScope &&
        normalizedProgressDateAction === 'replace_selected_date' &&
        exactDateQuery &&
        cleanStartDate !== progressSelectedDate
      )
      const selectingInitialExactDate = Boolean(
        !progressScope &&
        exactDateQuery
      )
      const revalidatingRetainedDate = Boolean(
        progressScope?.availabilityVerificationRequired === true &&
        normalizedProgressDateAction === 'keep_selected_date' &&
        exactDateQuery &&
        cleanStartDate === progressSelectedDate
      )
      const persistsExactDateState = selectingInitialExactDate ||
        replacingSelectedDate ||
        revalidatingRetainedDate
      const persistDateAvailabilityState = async (
        outcome,
        failure = null,
        { persistInitialAvailableDate = false } = {}
      ) => {
        if (!persistsExactDateState) return null
        // Una primera consulta exitosa conserva el flujo previo: la fecha se
        // vuelve durable cuando se presenta la lista/oferta. Sólo adelantamos
        // esta escritura si el lookup falló, probó que el día no tiene slots o
        // descartó únicamente la hora exacta solicitada. Así un runtime que no
        // hidrató un estado concurrente no intenta pisarlo salvo que necesitemos
        // conservar el día para buscar otra hora en ese mismo día.
        if (
          selectingInitialExactDate &&
          outcome === 'available' &&
          !persistInitialAvailableDate
        ) return null
        const verificationFailed = outcome === 'verification_failed'
        const hasBaseAvailability = outcome === 'available'
        try {
          await db.transaction(async () => {
            if (await lockAndDetectPendingNativeAppointmentOffer({ ctx, config })) {
              throw Object.assign(
                new Error('Ya existe una oferta individual vigente para esta conversación'),
                { code: 'appointment_offer_pending_decision' }
              )
            }
            await persistNativeAppointmentSelectionProgress({
              ctx,
              config,
              calendarId: effectiveCalendarId,
              purpose: rescheduledAppointment ? 'reschedule' : 'book',
              appointmentId: rescheduledAppointment?.id || '',
              timezone: accountTimezone,
              selectedDate: hasBaseAvailability || verificationFailed
                ? String(startDate).trim()
                : null,
              selectedTime: null,
              selectedStartTime: null,
              displayedRanges: [],
              availabilityCheckedAt: null,
              availabilityVerificationRequired: verificationFailed,
              lastError: verificationFailed
                ? {
                    code: String(
                      failure?.code ||
                      (Number(failure?.statusCode || failure?.status) || 0
                        ? `availability_http_${Number(failure?.statusCode || failure?.status)}`
                        : 'availability_check_failed')
                    )
                  }
                : null,
              status: hasBaseAvailability || verificationFailed ? 'collecting_time' : 'collecting_date',
              allowSelectedDateReplacement: replacingSelectedDate || !hasBaseAvailability
            })
          })
          return null
        } catch (error) {
          logger.error(`[Agente conversacional] No se pudo conservar el cambio explícito de fecha: ${error.message}`)
          await refreshNativeAppointmentConversationAuthority({ ctx, config })
          return appointmentAuthorityConflictTerminalResult({
            ctx,
            fallback: 'la fecha cambió mientras la guardaba. dime qué día y hora quieres revisar'
          })
        }
      }
      const availabilityOptions = {
        ignoreAppointmentConflicts: overlapsAllowed,
        allowDefaultOpenHours: false,
        durationMinutes: rescheduledAppointment
          ? durationMs / 60000
          : calendarDurationToMinutes(
              nativeCalendar.slot_duration,
              nativeCalendar.slot_duration_unit,
              60
            ),
        ...(rescheduledAppointment ? { excludeAppointmentId: rescheduledAppointment.id } : {})
      }
      let rawSlots
      try {
        rawSlots = await lookupVerifiedAppointmentSlots(
          effectiveCalendarId,
          startDate,
          endDate,
          accountTimezone,
          availabilityOptions
        )
      } catch (error) {
        const replacementConflict = await persistDateAvailabilityState('verification_failed', error)
        if (replacementConflict) return replacementConflict
        if (persistsExactDateState) {
          ctx.requireFreshAppointmentAvailability = true
        }
        return {
          ok: false,
          total: 0,
          slots: [],
          availabilityCheckFailed: true,
          transferRequired: Number(error?.statusCode || 0) >= 500,
          error: error?.message || 'No se pudo comprobar la disponibilidad real del calendario.',
          ...(selectingInitialExactDate || replacingSelectedDate
            ? {
                selectedDate: String(startDate).trim(),
                missingField: 'availability',
                availabilityVerificationRequired: true,
                note: `No se pudo verificar el día ${String(startDate).trim()}. Conservé esa fecha, pero todavía falta revalidar su disponibilidad; no pidas la fecha otra vez.`
              }
            : revalidatingRetainedDate
              ? {
                  selectedDate: String(startDate).trim(),
                  missingField: 'availability',
                  availabilityVerificationRequired: true,
                  note: `La disponibilidad del día ${String(startDate).trim()} sigue sin poder verificarse. Conserva esa fecha y vuelve a revalidarla; no pidas la fecha otra vez.`
              }
            : {})
        }
      }
      const baseSlotDays = buildNativeFreeSlotDays(rawSlots, accountTimezone)
      const replacementHasBaseAvailability = baseSlotDays.some((day) => (
        Array.isArray(day?.options) && day.options.length > 0
      ))
      const replacementConflict = await persistDateAvailabilityState(
        replacementHasBaseAvailability ? 'available' : 'unavailable'
      )
      if (replacementConflict) return replacementConflict

      let relativeReference = null
      if (relativeToPreviousOffer) {
        try {
          relativeReference = await loadNativeAppointmentRelativeReference({
            ctx,
            config,
            calendarId: effectiveCalendarId,
            purpose: rescheduledAppointment ? 'reschedule' : 'book',
            appointmentId: rescheduledAppointment?.id || null,
            timezone: accountTimezone
          })
        } catch (error) {
          return {
            ok: false,
            total: 0,
            slots: [],
            error: 'No pude recuperar con seguridad la lista u oferta anterior. Vuelve a consultar opciones sin compararlas.'
          }
        }
        if (!relativeReference) {
          return {
            ok: false,
            total: 0,
            slots: [],
            error: 'No hay una lista u oferta anterior vigente para saber qué significa más tarde o más temprano.'
          }
        }
      }
      const rejectedStartTimes = (Array.isArray(ctx.rejectedAppointmentStartTimes)
        ? ctx.rejectedAppointmentStartTimes
        : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
      const relativeBoundary = relativeReference?.kind === 'list'
        ? (relativeToPreviousOffer === 'later' ? relativeReference.maximum : relativeReference.minimum)
        : relativeReference
      const relativeToStartTime = relativeBoundary?.startTime || null
      const relativeToLocalTime = relativeBoundary?.localTime || null
      const relativeToLocalDate = relativeBoundary?.localDate || null
      const relativeToTimezone = relativeBoundary?.timezone || null
      const slots = filterNativeFreeSlotDays(
        baseSlotDays,
        {
          timezone: accountTimezone,
          weekdays,
          earliestLocalTime: cleanEarliestLocalTime,
          latestLocalTime: cleanLatestLocalTime,
          excludedStartTimes: rejectedStartTimes,
          relativeToStartTime,
          relativeToLocalTime,
          relativeToLocalDate,
          relativeToTimezone,
          relativeReferenceKind: relativeReference?.kind || 'individual',
          relativeDirection: relativeToPreviousOffer
        }
      )

      if (!Array.isArray(slots) || !slots.length) {
        if (selectingInitialExactDate && replacementHasBaseAvailability) {
          const initialDateConflict = await persistDateAvailabilityState(
            'available',
            null,
            { persistInitialAvailableDate: true }
          )
          if (initialDateConflict) return initialDateConflict
        }
        const exactDateStateWasPersisted = replacingSelectedDate ||
          revalidatingRetainedDate ||
          (selectingInitialExactDate && !replacementHasBaseAvailability)
        return {
          ok: true,
          total: 0,
          slots: [],
          ...((selectingInitialExactDate || replacingSelectedDate || revalidatingRetainedDate) && replacementHasBaseAvailability
            ? {
                selectedDate: String(startDate).trim(),
                missingField: 'time',
                nextStep: 'requery_same_date_without_time_filter',
                note: `La hora solicitada no está disponible, pero el día ${String(startDate).trim()} sí tiene otros horarios. Conservé esa fecha: reconsulta get_free_slots exactamente para el mismo día sin el filtro de hora y muestra alternativas con offer_appointment_options en modo collecting_time; no pidas la fecha otra vez.`
              }
            : exactDateStateWasPersisted
              ? {
                  selectedDate: null,
                  missingField: 'date',
                  note: `El día ${String(startDate).trim()} no tiene ningún horario disponible. La fecha anterior quedó descartada; pide otra fecha antes de interpretar una hora suelta.`
                }
              : { note: 'Sin horarios disponibles en ese rango (o el calendario no existe).' })
        }
      }

      const total = slots.reduce((sum, day) => sum + day.options.length, 0)
      const intervalMinutes = Math.max(1, calendarDurationToMinutes(
        nativeCalendar?.slot_interval,
        nativeCalendar?.slot_interval_unit,
        calendarDurationToMinutes(nativeCalendar?.slot_duration, nativeCalendar?.slot_duration_unit, 60)
      ))
      const offeredDurationMinutes = availabilityOptions.durationMinutes
      ctx.nativeAppointmentAvailability = {
        calendarId: effectiveCalendarId,
        purpose: rescheduledAppointment ? 'reschedule' : 'book',
        appointmentId: rescheduledAppointment?.id || null,
        timezone: accountTimezone,
        slots,
        total,
        intervalMinutes,
        durationMinutes: offeredDurationMinutes,
        startDate,
        endDate,
        progressDateAction: normalizedProgressDateAction
      }
      ctx.requireFreshAppointmentAvailability = false

      return {
        ok: true,
        total,
        overlapPolicy: overlapsAllowed ? 'allowed' : 'blocked',
        purpose: rescheduledAppointment ? 'reschedule' : 'book',
        appointmentId: rescheduledAppointment?.id || null,
        durationMinutes: offeredDurationMinutes,
        note: [
          overlapsAllowed
            ? 'Empalme permitido: estos horarios respetan horas de atención, pero pueden coincidir con citas existentes.'
            : 'Empalme bloqueado: estos horarios no tienen otra cita activa encima.',
          total === 1
            ? 'Sólo hay una opción: pásala sin modificar a offer_appointment_slot.'
            : 'Si la persona pidió fechas u opciones amplias, llama offer_appointment_options para que Ristak escriba una lista agrupada. Si ya eligió una fecha y hora exactas, usa offer_appointment_slot.'
        ].filter(Boolean).join(' '),
        slots
      }
    }
  })

  const offerAppointmentOptionsTool = tool({
    name: 'offer_appointment_options',
    description: [
      'Muestra varias opciones reales y cierra el turno con texto construido por Ristak.',
      'Usa selectionMode="collecting_time" y selectedLocalDate cuando la persona ya eligió un día pero todavía no una hora; Ristak conservará esa fecha y preguntará sólo la hora.',
      'Usa selectionMode="exploring" cuando todavía debe escoger día y hora. Esta lista no aparta ningún horario.'
    ].join(' '),
    parameters: z.object({
      maxDays: z.preprocess((value) => value ?? 3, z.number().int().min(1).max(3))
        .describe('Cantidad máxima de días a mostrar; normalmente 3'),
      selectionMode: z.preprocess(
        (value) => value ?? 'exploring',
        z.enum(['exploring', 'collecting_time'])
      ).describe('collecting_time si el día ya fue elegido; exploring si todavía faltan día y hora'),
      selectedLocalDate: z.preprocess(
        (value) => value ?? null,
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()
      ).describe('Fecha YYYY-MM-DD elegida en la zona del negocio para collecting_time; null en exploring')
    }),
    execute: async ({ maxDays, selectionMode, selectedLocalDate }) => {
      if (ctx.appointmentOfferDecision?.active === true) {
        return appointmentSelectionError(
          'Primero resuelve el horario individual pendiente antes de mostrar otras opciones.',
          'appointment_offer_resolution_required'
        )
      }
      const availability = ctx.nativeAppointmentAvailability
      const nativeCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
      const calendarId = nativeCalendar?.id || null
      if (
        !calendarId ||
        !availability ||
        String(availability.calendarId || '') !== String(calendarId) ||
        !Array.isArray(availability.slots)
      ) {
        return {
          ok: false,
          actionCompleted: false,
          error: 'Primero consulta get_free_slots en esta misma vuelta; no hay opciones verificadas para mostrar.'
        }
      }
      if (Number(availability.total || 0) < 2) {
        return {
          ok: false,
          actionCompleted: false,
          error: 'Sólo quedó un horario. Ofrécelo con offer_appointment_slot para conservar una confirmación exacta.'
        }
      }
      const availableDates = [...new Set(availability.slots
        .filter((day) => Array.isArray(day?.options) && day.options.length)
        .map((day) => String(day.localDate || '').trim())
        .filter(Boolean))]
      const requestedSelectedDate = String(selectedLocalDate || '').trim()
      if (
        selectionMode === 'collecting_time' &&
        (
          !requestedSelectedDate ||
          availableDates.length !== 1 ||
          availableDates[0] !== requestedSelectedDate
        )
      ) {
        return {
          ok: false,
          actionCompleted: false,
          code: 'appointment_progressive_date_mismatch',
          error: 'La fecha elegida no coincide con la consulta exacta de esta vuelta. Vuelve a consultar sólo ese día antes de pedir la hora.'
        }
      }
      const focusedLocalDate = selectionMode === 'collecting_time'
        ? requestedSelectedDate
        : (availableDates.length === 1 ? availableDates[0] : null)
      const collectingTime = Boolean(focusedLocalDate)
      const priorSelectedDate = ctx.appointmentSelectionProgress?.active === true
        ? String(ctx.appointmentSelectionProgress.selectedDate || '').trim()
        : ''
      const priorNeedsDate = ctx.appointmentSelectionProgress?.active === true &&
        ctx.appointmentSelectionProgress?.appointmentStatus === 'collecting_date'
      if (
        priorSelectedDate &&
        String(focusedLocalDate || '') !== priorSelectedDate &&
        availability.progressDateAction !== 'replace_selected_date'
      ) {
        return {
          ok: false,
          actionCompleted: false,
          code: 'appointment_progress_date_change_required',
          error: `Ya está seleccionado el día ${priorSelectedDate}. No se cambió la fecha porque la consulta no declaró un cambio explícito.`
        }
      }
      const presentation = buildNativeAppointmentAvailabilityPresentation(availability.slots, {
        timezone: availability.timezone,
        intervalMinutes: availability.intervalMinutes,
        maxDays,
        questionMode: collectingTime ? 'time_only' : 'date_and_time'
      })
      if (!presentation.visibleReply) {
        return {
          ok: false,
          actionCompleted: false,
          error: 'No se pudo construir una lista segura con los horarios verificados.'
        }
      }
      try {
        await db.transaction(async () => {
          if (await lockAndDetectPendingNativeAppointmentOffer({ ctx, config })) {
            throw Object.assign(
              new Error('Ya existe una oferta individual vigente para esta conversación'),
              { code: 'appointment_offer_pending_decision' }
            )
          }
          await persistNativeAppointmentOptionsReference({
            ctx,
            config,
            calendarId,
            purpose: availability.purpose,
            appointmentId: availability.appointmentId,
            timezone: availability.timezone,
            rangeStartDate: availability.startDate,
            rangeEndDate: availability.endDate,
            displayedStartTimes: presentation.displayedStartTimes
          })
          await persistNativeAppointmentSelectionProgress({
            ctx,
            config,
            calendarId,
            purpose: availability.purpose,
            appointmentId: availability.appointmentId,
            timezone: availability.timezone,
            selectedDate: focusedLocalDate,
            selectedTime: null,
            selectedStartTime: null,
            displayedRanges: collectingTime ? presentation.displayedRanges : [],
            availabilityCheckedAt: new Date().toISOString(),
            status: collectingTime ? 'collecting_time' : (priorNeedsDate ? 'collecting_date' : 'browsing'),
            allowSelectedDateReplacement: availability.progressDateAction === 'replace_selected_date'
          })
        })
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo conservar la referencia de la lista de horarios: ${error.message}`)
        await refreshNativeAppointmentConversationAuthority({ ctx, config })
        return appointmentAuthorityConflictTerminalResult({
          ctx,
          fallback: 'no pude guardar de forma segura esa selección. dime qué hora te funciona y la reviso de nuevo'
        })
      }
      const action = pushAction(ctx, 'offer_appointment_options', {
        purpose: availability.purpose,
        appointmentId: availability.appointmentId,
        displayedDays: presentation.displayedDays,
        displayedStartTimes: presentation.displayedStartTimes,
        selectedDate: focusedLocalDate,
        missingField: presentation.missingField,
        visibleReply: presentation.visibleReply,
        effect: { liveEffect: 'MOSTRARÍA varias opciones reales sin apartar ninguna', marksObjectiveCompleted: false }
      })
      settleAction(action, ctx.dryRun ? 'simulated' : 'ok', {
        terminal: true,
        actionCompleted: false,
        visibleReply: presentation.visibleReply
      })
      return {
        ok: true,
        ...(ctx.dryRun ? { simulated: true } : {}),
        actionCompleted: false,
        terminal: true,
        visibleReply: presentation.visibleReply,
        displayedDays: presentation.displayedDays,
        selectedDate: focusedLocalDate,
        missingField: presentation.missingField
      }
    }
  })

  const offerAppointmentSlotTool = tool({
    name: 'offer_appointment_slot',
    description: 'Ofrece UN solo slot real con texto construido por el servidor. Úsala después de get_free_slots; esta herramienta cierra el turno y su visibleReply no se puede mezclar con otro horario. selectionContext sólo indica cómo llegó la persona a ese horario y nunca controla fecha, acción ni hechos. Para cambiar una cita existente manda el appointmentId exacto devuelto por get_contact_appointments; null significa una cita nueva.',
    parameters: z.object({
      startTime: z.string().describe('options[].startTime exacto devuelto por get_free_slots'),
      appointmentId: z.preprocess(
        (value) => value ?? null,
        z.string().nullable()
      ).describe('ID exacto devuelto por get_contact_appointments cuando esta oferta es para reagendar; null para una cita nueva'),
      selectionContext: z.preprocess(
        (value) => value ?? null,
        z.enum(NATIVE_APPOINTMENT_OFFER_SELECTION_CONTEXTS).nullable()
      ).describe('Contexto conversacional cerrado: selected_from_options si eligió de una lista, exact_preference si pidió directamente fecha y hora, replacement si reemplazó una opción, neutral si no está claro; null equivale a neutral')
    }),
    execute: async ({ startTime, appointmentId, selectionContext }) => {
      if (ctx.appointmentOfferDecision?.active === true) {
        return appointmentSelectionError(
          'Primero resuelve el horario individual pendiente antes de ofrecer uno nuevo.',
          'appointment_offer_resolution_required'
        )
      }
      const requestedAppointmentId = String(appointmentId || '').trim()
      const progressiveAppointmentId = ctx.appointmentSelectionProgress?.active === true &&
        ctx.appointmentSelectionProgress?.purpose === 'reschedule'
        ? String(ctx.appointmentSelectionProgress.appointmentId || '').trim()
        : ''
      let cleanAppointmentId = requestedAppointmentId || progressiveAppointmentId
      if (
        progressiveAppointmentId &&
        requestedAppointmentId &&
        requestedAppointmentId !== progressiveAppointmentId
      ) {
        return appointmentSelectionError(
          'La selección parcial pertenece a otra cita. Reinicia la búsqueda antes de ofrecer este horario.',
          'appointment_progress_scope_mismatch'
        )
      }
      if (
        ctx.appointmentSelectionProgress?.active === true &&
        ctx.appointmentSelectionProgress?.purpose === 'book' &&
        requestedAppointmentId
      ) {
        return appointmentSelectionError(
          'La selección parcial corresponde a una cita nueva. Reinicia la búsqueda antes de convertirla en reagenda.',
          'appointment_progress_scope_mismatch'
        )
      }
      const currentAvailabilityAppointmentId = String(ctx.nativeAppointmentAvailability?.appointmentId || '').trim()
      const nativeCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
      const calendarId = nativeCalendar?.id || null
      let requestedStartTime = String(startTime || '').trim()
      let startMs = Date.parse(requestedStartTime)
      if (!calendarId || !Number.isFinite(startMs) || startMs <= Date.now()) {
        return { ok: false, actionCompleted: false, error: 'El horario ya no es válido o el calendario dejó de estar activo.' }
      }
      if (cleanAppointmentId && !nativeCalendarPermissionEnabled(nativeCalendar.allow_reschedule)) {
        return { ok: false, actionCompleted: false, error: 'Este calendario no permite reagendar citas. Pasa la conversación a una persona.' }
      }
      if (
        ctx.nativeAppointmentAvailability &&
        cleanAppointmentId &&
        cleanAppointmentId !== currentAvailabilityAppointmentId
      ) {
        return appointmentSelectionError(
          'La cita indicada no coincide con la disponibilidad verificada en esta vuelta.',
          'appointment_slot_not_in_current_availability'
        )
      }
      if (ctx.nativeAppointmentAvailability) cleanAppointmentId = currentAvailabilityAppointmentId
      if (cleanAppointmentId && !nativeCalendarPermissionEnabled(nativeCalendar.allow_reschedule)) {
        return { ok: false, actionCompleted: false, error: 'Este calendario no permite reagendar citas. Pasa la conversación a una persona.' }
      }
      if (!cleanAppointmentId && getDepositRequirementForRuntime(ctx, config)) {
        // Desde que esta tool intenta ofrecer una cita nueva, cualquier cobro
        // del mismo turno pertenece a ese intento. Si el slot falla o todavía
        // no existe selección durable, create_payment_link cerrará en vez de
        // degradarlo silenciosamente a un depósito independiente.
        ctx.nativePaymentCollectionScope = 'appointment_deposit'
      }
      const rejectedStartTimes = await hydrateNativeRejectedAppointmentStartTimes({ ctx, config, calendarId })
      const requestedEpochMinute = nativeAppointmentEpochMinute(requestedStartTime)
      const rejectedEpochMinutes = new Set(rejectedStartTimes
        .map(nativeAppointmentEpochMinute)
        .filter((value) => value !== null))
      if (requestedEpochMinute !== null && rejectedEpochMinutes.has(requestedEpochMinute)) {
        return appointmentSelectionError(
          'Ese horario ya fue rechazado o reemplazado en esta conversación. Consulta disponibilidad y ofrece otro.',
          'appointment_slot_previously_rejected'
        )
      }
      if (ctx.requireFreshAppointmentAvailability === true) {
        return appointmentSelectionError(
          'Después de cambiar la oferta debes consultar get_free_slots otra vez antes de mostrar un horario nuevo.',
          'appointment_fresh_availability_required'
        )
      }
      const currentAvailability = ctx.nativeAppointmentAvailability
      if (currentAvailability) {
        const expectedAppointmentId = String(currentAvailability.appointmentId || '').trim()
        const expectedPurpose = expectedAppointmentId ? 'reschedule' : 'book'
        const matchingOption = (Array.isArray(currentAvailability.slots) ? currentAvailability.slots : [])
          .flatMap((day) => (Array.isArray(day?.options) ? day.options : []))
          .find((option) => nativeAppointmentEpochMinute(option?.startTime) === requestedEpochMinute)
        if (
          String(currentAvailability.calendarId || '') !== String(calendarId) ||
          expectedAppointmentId !== cleanAppointmentId ||
          String(currentAvailability.purpose || expectedPurpose) !== expectedPurpose ||
          !matchingOption
        ) {
          return appointmentSelectionError(
            'El horario no pertenece exactamente a la última disponibilidad consultada para este calendario y esta cita.',
            'appointment_slot_not_in_current_availability'
          )
        }
        requestedStartTime = String(matchingOption.startTime || '').trim()
        startMs = Date.parse(requestedStartTime)
      }
      let rescheduledAppointment = null
      let rescheduleDurationMs = NaN
      if (cleanAppointmentId) {
        rescheduledAppointment = await loadOwnedConversationalAppointment({
          ctx,
          calendarId,
          appointmentId: cleanAppointmentId
        })
        if (!rescheduledAppointment || INACTIVE_APPOINTMENT_STATUSES.has(nativeAppointmentStatus(rescheduledAppointment))) {
          return { ok: false, actionCompleted: false, error: 'No encontré una cita futura activa de este contacto que pueda cambiarse.' }
        }
        rescheduleDurationMs = nativeAppointmentDurationMs(rescheduledAppointment)
        if (!Number.isFinite(rescheduleDurationMs)) {
          return { ok: false, actionCompleted: false, error: 'La cita no conserva una duración válida y no puede reagendarse automáticamente.' }
        }
      }
      const timezone = await getAccountTimezone()
      const verifiedSlotLookup = rescheduledAppointment
        ? verifiedRescheduleSlotLookup({
            appointmentId: rescheduledAppointment.id,
            durationMs: rescheduleDurationMs
          })
        : lookupVerifiedAppointmentSlots
      const slotValidation = await revalidateAppointmentSlot({
        calendarId,
        requestedStartTime: new Date(startMs).toISOString(),
        windowStart: normalizeDateOnlyInTimezone(new Date(startMs - 86400000).toISOString(), timezone),
        windowEnd: normalizeDateOnlyInTimezone(new Date(startMs + 86400000).toISOString(), timezone),
        lookupSlots: verifiedSlotLookup,
        ignoreAppointmentConflicts: nativeCalendarAllowsOverlaps(nativeCalendar)
      })
      if (!slotValidation.ok) return slotValidation
      const canonicalStartTime = new Date(slotValidation.matchedStartTime).toISOString()
      const canonical = buildCanonicalAppointmentSlotOption(canonicalStartTime, timezone)
      if (!canonical?.localLabel) {
        return { ok: false, actionCompleted: false, error: 'No se pudo construir la oferta canónica del horario.' }
      }
      const normalizedSelectionContext = normalizeNativeAppointmentOfferSelectionContext(selectionContext)
      const action = pushAction(ctx, 'offer_appointment_slot', {
        calendarId,
        startTime: canonicalStartTime,
        localLabel: canonical.localLabel,
        offerCopyVersion: NATIVE_APPOINTMENT_OFFER_COPY_VERSION,
        selectionContext: normalizedSelectionContext,
        purpose: rescheduledAppointment ? 'reschedule' : 'book',
        appointmentId: rescheduledAppointment?.id || null,
        expectedStartTime: rescheduledAppointment?.start_time || null,
        expectedEndTime: rescheduledAppointment?.end_time || null,
        durationMs: Number.isFinite(rescheduleDurationMs) ? rescheduleDurationMs : null,
        effect: { liveEffect: 'OFRECERÍA un solo horario real y esperaría confirmación', marksObjectiveCompleted: false }
      })
      const persisted = await persistNativeAppointmentOffer({
        ctx,
        config,
        calendarId,
        startTime: canonicalStartTime,
        localLabel: canonical.localLabel,
        timezone,
        purpose: rescheduledAppointment ? 'reschedule' : 'book',
        appointmentId: rescheduledAppointment?.id || '',
        expectedStartTime: rescheduledAppointment?.start_time || '',
        expectedEndTime: rescheduledAppointment?.end_time || '',
        durationMs: rescheduleDurationMs,
        selectionContext: normalizedSelectionContext
      })
      if (!persisted.ok) {
        settleAction(action, 'error', { error: persisted.error })
        if (new Set([
          'appointment_progress_transition_failed',
          'appointment_offer_pending_decision',
          'appointment_preview_offer_pending_decision'
        ]).has(persisted.code)) {
          await refreshNativeAppointmentConversationAuthority({ ctx, config })
          return appointmentAuthorityConflictTerminalResult({
            ctx,
            fallback: 'la fecha cambió mientras preparaba ese horario. dime qué hora te funciona y la reviso de nuevo'
          })
        }
        return persisted
      }
      const visibleReply = String(persisted.detail?.offerText || '').trim()
      action.visibleReply = visibleReply
      action.offerCopyVersion = persisted.detail?.offerCopyVersion ?? null
      action.selectionContext = persisted.detail?.selectionContext ?? null
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
      let {
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
      if (confirmationEvidence.purpose === 'reschedule') {
        return appointmentSelectionError(
          'Esta oferta pertenece a un reagendamiento. No se creó otra cita; usa reschedule_appointment sobre la cita original.',
          'appointment_reschedule_terminal_mismatch'
        )
      }
      if (appointmentResumeUsesBoundDraft(confirmationEvidence)) {
        const terminalBinding = normalizeNativeAppointmentTerminalBinding(confirmationEvidence)
        if (terminalBinding?.terminalToolName !== 'book_appointment') {
          return appointmentSelectionError(
            'El anticipo quedó ligado a otra forma de terminar la cita. No se agendó nada; el caso requiere revisión humana.',
            'payment_resume_terminal_tool_mismatch'
          )
        }
        const boundDraft = normalizeNativeAppointmentRequestDraft(confirmationEvidence.appointmentRequestDraft)
        if (!boundDraft) {
          return appointmentSelectionError(
            'El pago está confirmado, pero no se pudo recuperar de forma segura para quién era la cita. No se agendó nada; pasa el caso al equipo.',
            'payment_resume_appointment_request_draft_invalid'
          )
        }
        title = boundDraft.title
        notes = boundDraft.notes
        attendeeName = boundDraft.attendeeName
        attendeeContext = boundDraft.attendeeContext
        primaryAttendee = boundDraft.primaryAttendee
        guests = boundDraft.guests
      }
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
      const depositRequired = Boolean(getDepositRequirementForRuntime(ctx, config))
      const terminalBinding = buildNativeAppointmentTerminalBinding(scheduleCapability, 'book_appointment')
      const terminalAuthorityToken = ctx.paymentResumeClaim
        ? buildNativeTerminalAuthorityToken(ctx, config, 'book_appointment')
        : ''
      const appointmentRequestDraft = depositRequired
        ? buildValidatedNativeAppointmentRequestDraft({
            title,
            notes,
            attendeeName,
            attendeeContext,
            primaryAttendee,
            guests,
            participants
          })
        : null
      if (depositRequired && (!appointmentRequestDraft || !terminalBinding)) {
        return appointmentSelectionError(
          'No se pudieron fijar de forma segura los asistentes y el responsable antes de cobrar el anticipo. No se agendó ni se cobró nada; pasa el caso al equipo.',
          'appointment_request_contract_invalid'
        )
      }

      const nativeExecutionId = String(ctx.executionId || '').trim()
      const nativeOverlapsAllowed = nativeCalendarAllowsOverlaps(nativeCalendar)
      const nativeDurationMinutes = calendarDurationToMinutes(
        nativeCalendar?.slot_duration,
        nativeCalendar?.slot_duration_unit,
        60
      )
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
      const prepareEarlyTerminalCommitAuthority = async () => {
        const options = {
          ctx,
          config,
          calendarId,
          timezone: businessTimezone,
          confirmationEvidence,
          expectedCapabilitiesFingerprint: nativeAppointmentExpectedCapabilitiesFingerprint
        }
        const authority = await revalidateNativeAppointmentTerminalCommitAuthority(options)
        if (authority.ok) options.expectedCalendarFingerprint = authority.calendarFingerprint
        return { authority, options }
      }
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
          const replayCommitAuthority = await prepareEarlyTerminalCommitAuthority()
          if (!replayCommitAuthority.authority.ok) return replayCommitAuthority.authority
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
        const existingCommitAuthority = await prepareEarlyTerminalCommitAuthority()
        if (!existingCommitAuthority.authority.ok) return existingCommitAuthority.authority
        if (!boundExisting && !nativeOverlapsAllowed) {
          return {
            ok: false,
            actionCompleted: false,
            confirmationRequired: true,
            invalidSlot: true,
            appointmentOfferInvalidated: true,
            appointmentOfferRestoreSameDate: true,
            code: 'appointment_slot_unavailable',
            error: 'Ese horario ya está ocupado. No se creó ni se adoptó la cita existente; consulta otro horario del mismo día.'
          }
        }
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
        await runNativeAppointmentAfterPreCommitAuthorityHook({
          terminalToolName: 'book_appointment',
          purpose: 'book',
          ctx,
          config,
          calendarId,
          appointmentId: existing.id,
          preCommitAuthority: existingCommitAuthority.authority
        })
        let completionSyncWarning = false
        try {
          await syncNativeAppointmentCompletion({
            ctx,
            config,
            appointment: existing,
            calendarId: existing.calendar_id,
            terminalAuthorityToken,
            authorityFence: buildNativeAppointmentTerminalCommitFence(existingCommitAuthority.options),
            beforeDurableCommit: boundExisting.detail.depositRequired === true
              ? async () => {
                  try {
                    const depositConsumption = await consumeReservedDepositForExistingNativeAppointment({
                      ctx,
                      config,
                      appointment: existing
                    })
                    if (!depositConsumption?.consumed) {
                      throw new Error('La cita vinculada no conserva una reserva de anticipo válida')
                    }
                  } catch (error) {
                    error.code = 'existing_appointment_deposit_invalid'
                    throw error
                  }
                }
              : null
          })
        } catch (error) {
          if (error?.conversationalAppointmentAuthorityFailure === true) {
            const authorityError = {
              ok: false,
              actionCompleted: false,
              code: error.code || 'appointment_offer_scope_changed',
              statusCode: Number(error.statusCode || error.status) || 409,
              retryable: error.retryable === true,
              appointmentOfferInvalidated: error.appointmentOfferInvalidated === true,
              appointmentOfferRestoreSameDate: error.appointmentOfferRestoreSameDate === true,
              error: error.message
            }
            settleAction(existingAction, 'error', {
              appointmentCreated: false,
              verifiedExistingAction: true,
              code: authorityError.code,
              error: authorityError.error
            })
            return authorityError
          }
          if (error?.code === 'existing_appointment_deposit_invalid') {
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
          completionSyncWarning = true
          logger.error(`[Agente conversacional] La cita ${existing.id} ya existía, pero no se pudo reparar su cierre: ${error.message}`)
        }
        settleAction(existingAction, completionSyncWarning ? 'error' : 'ok', {
          appointmentId: existing.id,
          calendarId: existing.calendar_id,
          startTime: existing.start_time,
          appointmentCreated: false,
          verifiedExistingAction: true,
          objectiveCompleted: !completionSyncWarning,
          completionSyncWarning
        })
        return {
          ok: !completionSyncWarning,
          actionCompleted: !completionSyncWarning,
          durableEffectCommitted: true,
          alreadyBooked: true,
          verifiedExistingAction: true,
          appointment: {
            title: existing.title || 'Cita',
            startTime: existing.start_time,
            endTime: existing.end_time,
            status: existing.appointment_status || existing.status || 'confirmed'
          },
          ...(completionSyncWarning
            ? {
                completionSyncWarning: true,
                requiresRecovery: true,
                error: 'La cita real existe y no se duplicó, pero todavía no se confirmó el cierre interno. No envíes una confirmación; Ristak la recuperará de forma durable.'
              }
            : { note: 'La cita real ya existía y su cierre quedó confirmado; no crees otra.' })
        }
      }

      const calendar = nativeCalendar
      if (!calendar) return { ok: false, actionCompleted: false, error: 'Calendario no encontrado: usa list_calendars para obtener el ID real. No se agendó nada.' }

      const durationMinutes = calendarDurationToMinutes(
        calendar.slot_duration,
        calendar.slot_duration_unit,
        60
      )
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
        lookupSlots: lookupVerifiedAppointmentSlots,
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
        const boundDraft = await bindNativeAppointmentRequestDraft({
          ctx,
          config,
          confirmationEvidence: {
            ...confirmationEvidence,
            calendarId,
            selectedStartTime: start.toISOString()
          },
          requestDraft: appointmentRequestDraft,
          terminalBinding
        })
        if (!boundDraft.ok) return boundDraft
        confirmationEvidence = boundDraft
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
      const confirmedSlot = buildCanonicalAppointmentSlotOption(start.toISOString(), businessTimezone)

      // El controller debe recibir primero la llave durable: así un retry
      // idéntico reproduce la cita ya creada antes de volver a evaluar conflicto.
      // La primera creación sí vuelve a comprobar cupo dentro del lock transaccional.
      const finalTitle = participant.title
      const action = pushAction(ctx, 'book_appointment', {
        calendarId, startTime: start.toISOString(), endTime: end.toISOString(), title: finalTitle,
        localLabel: confirmedSlot?.localLabel || '',
        timezone: businessTimezone,
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
          startTime: start.toISOString(),
          localLabel: confirmedSlot?.localLabel || ''
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

      if (ctx.paymentResumeClaim && nativePaymentResumeBeforeTerminalCommitHookForTest) {
        await nativePaymentResumeBeforeTerminalCommitHookForTest({
          terminalToolName: 'book_appointment',
          contactId: ctx.contactId,
          agentId: config.id || ctx.agentId || '',
          channel: ctx.channel || 'whatsapp',
          reconciliationId: ctx.paymentResumeClaim.reconciliationId,
          reconciliationClaimToken: ctx.paymentResumeClaim.claimToken
        })
      }

      const terminalCommitFenceOptions = {
        ctx,
        config,
        calendarId,
        timezone: businessTimezone,
        confirmationEvidence,
        expectedCapabilitiesFingerprint: nativeAppointmentExpectedCapabilitiesFingerprint
      }
      const preCommitAuthority = await revalidateNativeAppointmentTerminalCommitAuthority(
        terminalCommitFenceOptions
      )
      if (!preCommitAuthority.ok) {
        settleAction(action, 'error', {
          error: preCommitAuthority.error,
          code: preCommitAuthority.code
        })
        return preCommitAuthority
      }
      terminalCommitFenceOptions.expectedCalendarFingerprint = preCommitAuthority.calendarFingerprint
      await runNativeAppointmentAfterPreCommitAuthorityHook({
        terminalToolName: 'book_appointment',
        purpose: 'book',
        ctx,
        config,
        calendarId,
        preCommitAuthority
      })
      const terminalCommitFence = buildNativeAppointmentTerminalCommitFence(
        terminalCommitFenceOptions
      )

      let depositReservation = null
      if (ctx.verifiedPaymentEvidence?.paymentPurpose === 'appointment_deposit') {
        try {
          depositReservation = await reserveConversationalAppointmentDepositEvidence({
            reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
            contactId: ctx.contactId,
            agentId: config.id || ctx.agentId || '',
            paymentId: ctx.verifiedPaymentEvidence.paymentId,
            reconciliationClaimToken: String(ctx.paymentResumeClaim?.claimToken || '').trim(),
            appointmentRequestId: clientRequestId,
            calendarId,
            startTime: start.toISOString(),
            selectionRequestDraftHash: confirmationEvidence.appointmentRequestDraftHash,
            bookingOwner: terminalBinding?.bookingOwner,
            terminalToolName: terminalBinding?.terminalToolName
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
        if (depositReservation?.consumed) {
          const consumedError = 'El anticipo ya quedó consumido por una cita anterior. No se creó otra cita; Ristak debe recuperar el efecto canónico o pasar el caso a una persona.'
          settleAction(action, 'error', {
            error: consumedError,
            transferRequired: true,
            durableEffectCommitted: true,
            appointmentId: depositReservation.appointmentId || null
          })
          return {
            ok: false,
            actionCompleted: false,
            durableEffectCommitted: true,
            requiresRecovery: true,
            transferRequired: true,
            error: consumedError
          }
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
          reservationClaimToken: depositReservation.claimToken,
          reconciliationClaimToken: String(ctx.paymentResumeClaim?.claimToken || '').trim(),
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
            reconciliationClaimToken: String(ctx.paymentResumeClaim?.claimToken || '').trim(),
            appointmentRequestId: clientRequestId,
            calendarId,
            startTime: start.toISOString(),
            selectionRequestDraftHash: confirmationEvidence.appointmentRequestDraftHash,
            bookingOwner: terminalBinding?.bookingOwner,
            terminalToolName: terminalBinding?.terminalToolName
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

      const appointmentControllerBody = freezeNativeAppointmentControllerValue({
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
              depositReservationAgentId: config.id || ctx.agentId || '',
              depositReservationRequestDraftHash: confirmationEvidence.appointmentRequestDraftHash
            }
          : {}),
        ...(terminalAuthorityToken
          ? {
              conversationTerminalAuthorityToken: terminalAuthorityToken,
              conversationTerminalAgentId: config.id || ctx.agentId || '',
              conversationTerminalChannel: ctx.channel || 'whatsapp'
            }
          : {})
      })
      const appointmentControllerInternalContext = Object.freeze({
        conversationalAgentAppointment: true,
        allowAppointmentOverlaps: overlapsAllowed,
        conversationalAppointmentAuthorityFence: terminalCommitFence
      })
      const appointmentControllerRequestOptions = Object.freeze({
        body: appointmentControllerBody,
        internalContext: appointmentControllerInternalContext
      })
      let controllerAttempts = 0
      let retriedController = false
      let firstControllerFailureCode = null
      const controllerOutcome = () => ({
        controllerAttempts,
        retried: retriedController,
        firstFailureCode: firstControllerFailureCode
      })
      let toolResult
      try {
        let execution
        try {
          execution = await runBoundedAppointmentControllerRequest({
            invoke: (attempt) => invokeNativeAppointmentCreateController(
              appointmentControllerRequestOptions,
              attempt
            ),
            onRetry: async ({ failure }) => {
              await recordNativeAppointmentCreationRetry({
                ctx,
                config,
                clientRequestId,
                calendarId,
                startTime: start.toISOString(),
                failure
              })
            }
          })
        } catch (error) {
          controllerAttempts = Number(error?.appointmentControllerAttempts) || 1
          retriedController = error?.appointmentControllerRetried === true
          firstControllerFailureCode = error?.appointmentControllerFirstFailure?.code || error?.code || null
          throw error
        }
        const result = execution.result
        controllerAttempts = execution.attempts
        retriedController = execution.retried
        firstControllerFailureCode = execution.firstFailure?.code || null
        if (!result || typeof result !== 'object') {
          throw Object.assign(new Error('El controller no devolvió una respuesta verificable.'), {
            code: 'appointment_controller_response_missing'
          })
        }
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
          const authorityFenceData = result.payload?.data && typeof result.payload.data === 'object'
            ? result.payload.data
            : {}
          const authorityFenceFailed = authorityFenceData.appointmentOfferInvalidated === true
          const errorResult = {
            ok: false,
            actionCompleted: false,
            transferRequired: result.statusCode >= 500,
            ...(authorityFenceFailed
              ? {
                  appointmentOfferInvalidated: true,
                  appointmentOfferRestoreSameDate: authorityFenceData.appointmentOfferRestoreSameDate === true
                }
              : (result.statusCode === 409
                  ? { appointmentOfferInvalidated: true, appointmentOfferRestoreSameDate: true }
                  : {})),
            ...(result.payload?.code
              ? { code: result.payload.code }
              : {}),
            ...(authorityFenceData.reason
              ? { availabilityReason: String(authorityFenceData.reason) }
              : {}),
            statusCode: result.statusCode,
            error: `No se pudo agendar la cita y no debes afirmar que quedó confirmada.${toolResult.error ? ` ${toolResult.error}` : ''}`
          }
          settleAction(action, 'error', {
            statusCode: result.statusCode,
            error: errorResult.error,
            transferRequired: errorResult.transferRequired,
            ...controllerOutcome()
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
                  reconciliationClaimToken: String(ctx.paymentResumeClaim?.claimToken || '').trim(),
                  reservationClaimToken: depositReservation.claimToken,
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
                calendarId: toolResult.data.calendarId,
                terminalAuthorityToken
              })
            } catch (error) {
              completionSyncWarning = true
              logger.error(`[Agente conversacional] La cita reprogramada ${toolResult.data.id} existe, pero falló su cierre durable: ${error.message}`)
            }
            settleAction(action, completionSyncWarning ? 'error' : 'ok', {
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
              },
              ...controllerOutcome()
            })
            return {
              ok: !completionSyncWarning,
              actionCompleted: !completionSyncWarning,
              durableEffectCommitted: true,
              alreadyBooked: true,
              appointmentRescheduled: true,
              appointment: {
                title: toolResult.data.title || finalTitle,
                startTime: toolResult.data.startTime || null,
                endTime: toolResult.data.endTime || null,
                status: toolResult.data.status || null
              },
              ...(completionSyncWarning
                ? {
                    requiresRecovery: true,
                    error: 'La cita canónica existe, pero todavía no se confirmó el cierre interno. No envíes una confirmación; Ristak la recuperará de forma durable.'
                  }
                : { note: 'La cita ya existía y fue reprogramada; confirma únicamente estos datos canónicos y no reserves el horario anterior.' })
            }
          }
          if (depositReservation?.reserved && ctx.verifiedPaymentEvidence) {
            await releaseConversationalAppointmentDepositEvidence({
              reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
              contactId: ctx.contactId,
              agentId: config.id || ctx.agentId || '',
              paymentId: ctx.verifiedPaymentEvidence.paymentId,
              reconciliationClaimToken: String(ctx.paymentResumeClaim?.claimToken || '').trim(),
              reservationClaimToken: depositReservation.claimToken,
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
            error: replayError,
            ...controllerOutcome()
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
        await releaseDepositReservationAfterDefinitiveFailure(
          `appointment_controller_${firstControllerFailureCode || error?.code || 'failed'}`
        )
        logger.error(`[Agente conversacional] Falló la creación real de la cita: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo crear la cita. No se agendó nada y no debes afirmar lo contrario; pasa la conversación a una persona.'
        }
        settleAction(action, 'error', {
          error: errorResult.error,
          transferRequired: true,
          ...controllerOutcome()
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
              reconciliationClaimToken: String(ctx.paymentResumeClaim?.claimToken || '').trim(),
              reservationClaimToken: depositReservation.claimToken,
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
            calendarId,
            terminalAuthorityToken
          })
        } catch (error) {
          completionSyncWarning = true
          logger.error(`[Agente conversacional] La cita ${toolResult.data?.id} sí se creó, pero falló la sincronización durable del cierre: ${error.message}`)
        }
      }
      settleAction(action, completionSyncWarning ? 'error' : 'ok', {
        appointmentId: toolResult.data?.id || null,
        calendarId,
        startTime: start.toISOString(),
        localLabel: confirmedSlot?.localLabel || '',
        appointmentCreated: true,
        objectiveCompleted: !completionSyncWarning,
        completionSyncWarning,
        ...controllerOutcome()
      })
      return {
        ok: !completionSyncWarning,
        actionCompleted: !completionSyncWarning,
        durableEffectCommitted: true,
        appointment: {
          title: toolResult.data?.title || finalTitle,
          startTime: toolResult.data?.startTime || start.toISOString(),
          endTime: toolResult.data?.endTime || end.toISOString(),
          status: toolResult.data?.status || 'confirmed'
        },
        ...(completionSyncWarning
          ? {
              completionSyncWarning: true,
              requiresRecovery: true,
              error: 'La cita sí fue creada y no debe repetirse, pero todavía no se confirmó el cierre interno. No envíes una confirmación; Ristak la recuperará de forma durable.'
            }
          : {})
      }
    }
  })

  const handOffConfirmedReschedule = async ({
    confirmationEvidence,
    nativeCalendar,
    calendarId,
    businessTimezone
  } = {}) => {
    const candidate = await loadNativeAppointmentOfferCandidate({ ctx, config })
    const offerDetail = candidate?.offer?.detail || {}
    const appointmentId = String(confirmationEvidence?.appointmentId || '').trim()
    if (
      !candidate?.ok ||
      String(offerDetail.purpose || '') !== 'reschedule' ||
      String(offerDetail.appointmentId || '') !== appointmentId
    ) {
      return appointmentSelectionError(
        'No hay una oferta vigente de cambio ligada a esa cita. Consulta la cita, busca disponibilidad y ofrece un horario nuevo.',
        'appointment_human_reschedule_offer_required'
      )
    }
    if (!nativeCalendarPermissionEnabled(nativeCalendar?.allow_reschedule)) {
      return { ok: false, actionCompleted: false, error: 'Este calendario no permite solicitar cambios de cita desde el chat. Pasa la conversación a una persona.' }
    }

    const appointment = await loadOwnedConversationalAppointment({
      ctx,
      calendarId,
      appointmentId
    })
    if (!appointment || INACTIVE_APPOINTMENT_STATUSES.has(nativeAppointmentStatus(appointment))) {
      return { ok: false, actionCompleted: false, error: 'La cita ya no está activa o no pertenece al contacto de este hilo.' }
    }

    const expectedStartMs = new Date(offerDetail.expectedStartTime || '').getTime()
    const expectedEndMs = new Date(offerDetail.expectedEndTime || '').getTime()
    const currentStartMs = new Date(appointment.start_time || '').getTime()
    const currentEndMs = new Date(appointment.end_time || '').getTime()
    const targetStartMs = new Date(confirmationEvidence?.selectedStartTime || '').getTime()
    const durationMs = Number(offerDetail.durationMs)
    if (
      !Number.isFinite(expectedStartMs) ||
      !Number.isFinite(expectedEndMs) ||
      !Number.isFinite(currentStartMs) ||
      !Number.isFinite(currentEndMs) ||
      !Number.isFinite(targetStartMs) ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs !== expectedEndMs - expectedStartMs ||
      durationMs !== currentEndMs - currentStartMs
    ) {
      return { ok: false, actionCompleted: false, error: 'La cita o la oferta cambió y ya no conserva un horario verificable. El equipo debe revisarla.' }
    }
    if (Math.abs(currentStartMs - targetStartMs) < 60000) {
      const action = pushAction(ctx, 'request_human_booking', {
        appointmentId: appointment.id,
        startTime: new Date(currentStartMs).toISOString(),
        replayed: true,
        effect: { liveEffect: 'CONFIRMARÍA que la cita ya tenía el horario solicitado sin repetir efectos', marksObjectiveCompleted: false }
      })
      const visibleReply = 'listo, esa cita ya tiene ese horario; no mandé otra solicitud ni repetí ningún cambio'
      settleAction(action, 'ok', {
        actionCompleted: true,
        appointmentRescheduled: true,
        alreadyRescheduled: true,
        replayed: true,
        visibleReply
      })
      return {
        ok: true,
        actionCompleted: true,
        appointmentRescheduled: true,
        alreadyRescheduled: true,
        replayed: true,
        visibleReply
      }
    }
    if (currentStartMs !== expectedStartMs || currentEndMs !== expectedEndMs) {
      return { ok: false, actionCompleted: false, error: 'La cita cambió desde que se ofreció el horario. Consulta su estado antes de volver a solicitar el cambio.' }
    }

    const slotValidation = await revalidateAppointmentSlot({
      calendarId,
      requestedStartTime: new Date(targetStartMs).toISOString(),
      windowStart: normalizeDateOnlyInTimezone(new Date(targetStartMs - 86400000).toISOString(), businessTimezone),
      windowEnd: normalizeDateOnlyInTimezone(new Date(targetStartMs + 86400000).toISOString(), businessTimezone),
      lookupSlots: verifiedRescheduleSlotLookup({ appointmentId: appointment.id, durationMs }),
      ignoreAppointmentConflicts: nativeCalendarAllowsOverlaps(nativeCalendar)
    })
    if (!slotValidation.ok) return slotValidation
    const canonicalStart = new Date(slotValidation.matchedStartTime).toISOString()
    const canonicalEnd = new Date(new Date(canonicalStart).getTime() + durationMs).toISOString()
    const persistedSelection = await persistNativeAppointmentSelection({
      ctx,
      config,
      calendarId,
      startTime: canonicalStart,
      evidence: confirmationEvidence
    })
    if (!persistedSelection.ok && persistedSelection.actionCompleted === false) return persistedSelection

    const action = pushAction(ctx, 'request_human_booking', {
      appointmentId: appointment.id,
      expectedStartTime: new Date(expectedStartMs).toISOString(),
      requestedStartTime: canonicalStart,
      requestedEndTime: canonicalEnd,
      confirmationEvidence: persistedSelection,
      effect: { liveEffect: 'ENTREGARÍA al equipo la cita original y el horario nuevo sin modificar el calendario', marksObjectiveCompleted: false }
    })
    if (ctx.dryRun) {
      settleAction(action, 'simulated', {
        actionCompleted: false,
        appointmentRescheduled: false,
        wouldTransferToHuman: true,
        wouldNotifyHuman: true,
        objectiveCompleted: false
      })
      return {
        ok: true,
        simulated: true,
        actionCompleted: false,
        appointmentRescheduled: false,
        wouldTransferToHuman: true,
        wouldNotifyHuman: true,
        requestedChange: { startTime: canonicalStart, endTime: canonicalEnd },
        note: 'Simulación: el horario nuevo sigue disponible. En vivo se entregaría la solicitud al equipo sin mover la cita.'
      }
    }

    const executionId = String(ctx.executionId || '').trim()
    const agentId = String(config.id || ctx.agentId || '').trim()
    if (!executionId || !agentId) {
      const error = 'No se pudo identificar de forma segura el mensaje que confirmó el cambio. No se modificó ni se entregó la cita.'
      settleAction(action, 'error', { actionCompleted: false, transferRequired: true, error })
      return { ok: false, actionCompleted: false, transferRequired: true, error }
    }

    const requestDigest = createHash('sha256')
      .update([
        agentId,
        ctx.contactId,
        calendarId,
        appointment.id,
        new Date(expectedStartMs).toISOString(),
        canonicalStart,
        executionId
      ].join('\u0000'))
      .digest('hex')
      .slice(0, 48)
    const evidenceEventId = `cae_human_reschedule_${requestDigest}`
    const terminalCommitFenceOptions = {
      ctx,
      config,
      calendarId,
      timezone: businessTimezone,
      confirmationEvidence: persistedSelection,
      expectedCapabilitiesFingerprint: nativeAppointmentExpectedCapabilitiesFingerprint
    }
    const preCommitAuthority = await revalidateNativeAppointmentTerminalCommitAuthority(
      terminalCommitFenceOptions
    )
    if (!preCommitAuthority.ok) {
      settleAction(action, 'error', {
        error: preCommitAuthority.error,
        code: preCommitAuthority.code
      })
      return preCommitAuthority
    }
    terminalCommitFenceOptions.expectedCalendarFingerprint = preCommitAuthority.calendarFingerprint
    await runNativeAppointmentAfterPreCommitAuthorityHook({
      terminalToolName: 'request_human_booking',
      purpose: 'reschedule',
      ctx,
      config,
      calendarId,
      appointmentId: appointment.id,
      preCommitAuthority
    })
    const assignmentCapability = {
      userId: preCommitAuthority.scheduleCapability?.handoffUserId || '',
      userName: preCommitAuthority.scheduleCapability?.handoffUserName || ''
    }
    const terminalCommitFence = buildNativeAppointmentTerminalCommitFence(
      terminalCommitFenceOptions
    )
    let assignment = { assigned: false, alreadyAssigned: false, userName: null }
    let evidenceInserted = true
    try {
      const committed = await commitNativeHandoff({
        ctx,
        config,
        capability: assignmentCapability,
        signal: 'ready_for_human',
        signalOptions: {
          reason: 'La persona eligió un horario nuevo y el equipo debe confirmar el cambio de la cita',
          summary: `${appointment.title || 'Cita'}: ${new Date(expectedStartMs).toISOString()} → ${canonicalStart}`,
          status: 'human'
        },
        assignmentEventSource: 'human_reschedule_requested',
        authorityFence: terminalCommitFence,
        evidenceEvent: {
          eventId: evidenceEventId,
          eventType: 'human_reschedule_requested',
          detail: {
            bookingOwner: 'human',
            terminalToolName: 'request_human_booking',
            calendarId,
            appointmentId: appointment.id,
            expectedStartTime: new Date(expectedStartMs).toISOString(),
            expectedEndTime: new Date(expectedEndMs).toISOString(),
            requestedStartTime: canonicalStart,
            requestedEndTime: canonicalEnd,
            appointmentRescheduled: false,
            objectiveCompleted: false,
            sourceMessageId: executionId
          }
        }
      })
      assignment = committed.assignment
      evidenceInserted = committed.evidenceInserted !== false
    } catch (error) {
      logger.error(`[Agente conversacional] No se pudo entregar la solicitud humana de cambio: ${error.message}`)
      const errorResult = {
        ok: false,
        actionCompleted: false,
        transferRequired: error?.appointmentOfferInvalidated !== true,
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.appointmentOfferInvalidated === true
          ? {
              appointmentOfferInvalidated: true,
              appointmentOfferRestoreSameDate: error.appointmentOfferRestoreSameDate === true
            }
          : {}),
        error: error?.appointmentOfferInvalidated === true
          ? error.message
          : 'No se pudo guardar y transferir la solicitud de cambio. La cita conserva su horario anterior y no debes afirmar lo contrario.'
      }
      settleAction(action, 'error', { actionCompleted: false, transferRequired: true, error: errorResult.error })
      return errorResult
    }

    let notificationWarning = false
    if (evidenceInserted) {
      try {
        await notifyHumanPriority(ctx, {
          reason: 'Cambio de cita pendiente de confirmación humana',
          summary: `${appointment.title || 'Cita'}: ${new Date(expectedStartMs).toISOString()} → ${canonicalStart}`,
          signal: 'ready_for_human'
        })
      } catch (error) {
        notificationWarning = true
        logger.warn(`[Agente conversacional] La solicitud humana de cambio quedó guardada, pero falló la notificación: ${error.message}`)
      }
    }

    settleAction(action, 'ok', {
      actionCompleted: true,
      transferredToHuman: true,
      appointmentRescheduled: false,
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
      appointmentRescheduled: false,
      requestedChange: {
        previousStartTime: new Date(expectedStartMs).toISOString(),
        startTime: canonicalStart,
        endTime: canonicalEnd
      },
      ...(assignment.assigned ? { assignedUserName: assignment.userName } : {}),
      note: 'El horario nuevo seguía disponible y la solicitud quedó en manos del equipo. La cita conserva el horario anterior hasta que una persona confirme el cambio; dilo claramente.'
    }
  }

  const requestHumanBookingTool = tool({
    name: 'request_human_booking',
    description: 'Revalida el horario y entrega el hilo al equipo sin crear una cita nueva ni modificar una existente. Sólo se usa cuando el cliente confirma en otro turno la última oferta estructurada creada por offer_appointment_slot, tanto para agendar como para cambiar una cita en modo humano. Querer agendar, querer ir o proponer una fecha/hora no autoriza transferir ese slot en el mismo turno. No recibe horarios: el servidor recupera el único slot ofrecido y comprueba la oferta, el orden de turnos y la disponibilidad.',
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
    execute: async (args = {}) => {
      let { title, notes, attendeeName, attendeeContext, primaryAttendee, guests } = args
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
      if (confirmationEvidence.purpose === 'reschedule') {
        return handOffConfirmedReschedule({
          confirmationEvidence,
          nativeCalendar,
          calendarId,
          businessTimezone
        })
      }
      if (appointmentResumeUsesBoundDraft(confirmationEvidence)) {
        const terminalBinding = normalizeNativeAppointmentTerminalBinding(confirmationEvidence)
        if (terminalBinding?.terminalToolName !== 'request_human_booking') {
          return appointmentSelectionError(
            'El anticipo quedó ligado a otra forma de terminar la cita. No se entregó nada; el caso requiere revisión humana.',
            'payment_resume_terminal_tool_mismatch'
          )
        }
        const boundDraft = normalizeNativeAppointmentRequestDraft(confirmationEvidence.appointmentRequestDraft)
        if (!boundDraft) {
          return appointmentSelectionError(
            'El pago está confirmado, pero no se pudo recuperar de forma segura para quién era la cita. No se entregó la solicitud; pasa el caso al equipo.',
            'payment_resume_appointment_request_draft_invalid'
          )
        }
        title = boundDraft.title
        notes = boundDraft.notes
        attendeeName = boundDraft.attendeeName
        attendeeContext = boundDraft.attendeeContext
        primaryAttendee = boundDraft.primaryAttendee
        guests = boundDraft.guests
      }
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
      const depositRequired = Boolean(getDepositRequirementForRuntime(ctx, config))
      const terminalBinding = buildNativeAppointmentTerminalBinding(scheduleCapability, 'request_human_booking')
      const appointmentRequestDraft = depositRequired
        ? buildValidatedNativeAppointmentRequestDraft({
            title,
            notes,
            attendeeName,
            attendeeContext,
            primaryAttendee,
            guests,
            participants
          })
        : null
      if (depositRequired && (!appointmentRequestDraft || !terminalBinding)) {
        return appointmentSelectionError(
          'No se pudieron fijar de forma segura los asistentes y el responsable antes de cobrar el anticipo. No se entregó ni se cobró nada; pasa el caso al equipo.',
          'appointment_request_contract_invalid'
        )
      }

      const durationMinutes = calendarDurationToMinutes(
        nativeCalendar.slot_duration,
        nativeCalendar.slot_duration_unit,
        60
      )
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
        lookupSlots: lookupVerifiedAppointmentSlots,
        ignoreAppointmentConflicts: nativeCalendarAllowsOverlaps(nativeCalendar)
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
      const depositError = await rejectMissingDepositIfNeeded(
        ctx,
        config,
        ctx.accountLocale,
        {
          calendarId,
          startTime: start.toISOString()
        }
      )
      if (depositError) {
        const boundDraft = await bindNativeAppointmentRequestDraft({
          ctx,
          config,
          confirmationEvidence: {
            ...confirmationEvidence,
            calendarId,
            selectedStartTime: start.toISOString()
          },
          requestDraft: appointmentRequestDraft,
          terminalBinding
        })
        if (!boundDraft.ok) return boundDraft
        confirmationEvidence = boundDraft
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
      const terminalAuthorityToken = buildNativeTerminalAuthorityToken(ctx, config, 'request_human_booking')
      const requestDigest = createHash('sha256')
        .update([agentId, ctx.contactId, calendarId, start.toISOString(), executionId].join('\u0000'))
        .digest('hex')
        .slice(0, 48)
      const evidenceEventId = `cae_human_booking_${requestDigest}`
      const verifiedDeposit = ctx.verifiedPaymentEvidence?.paymentPurpose === 'appointment_deposit'
        ? {
            reconciliationId: String(ctx.verifiedPaymentEvidence.reconciliationId || '').trim(),
            paymentId: String(ctx.verifiedPaymentEvidence.paymentId || '').trim(),
            reconciliationClaimToken: String(
              ctx.verifiedPaymentEvidence.reconciliationClaimToken || ctx.paymentResumeClaim?.claimToken || ''
            ).trim(),
            selectionRequestDraftHash: String(confirmationEvidence.appointmentRequestDraftHash || '').trim()
          }
        : null
      if (
        depositRequired &&
        (
          !verifiedDeposit?.reconciliationId ||
          !verifiedDeposit?.paymentId ||
          !verifiedDeposit?.reconciliationClaimToken ||
          !/^[a-f0-9]{64}$/i.test(verifiedDeposit.selectionRequestDraftHash)
        )
      ) {
        const error = 'El anticipo confirmado no conserva su vínculo exclusivo con la solicitud humana. No se entregó la conversación; requiere revisión.'
        settleAction(action, 'error', { transferRequired: true, error })
        return { ok: false, actionCompleted: false, transferRequired: true, error }
      }
      let assignment = { assigned: false, alreadyAssigned: false, userName: null }
      let evidenceInserted = true
      try {
        if (verifiedDeposit && nativePaymentResumeBeforeTerminalCommitHookForTest) {
          await nativePaymentResumeBeforeTerminalCommitHookForTest({
            terminalToolName: 'request_human_booking',
            contactId: ctx.contactId,
            agentId,
            channel: ctx.channel || 'whatsapp',
            reconciliationId: verifiedDeposit.reconciliationId,
            reconciliationClaimToken: verifiedDeposit.reconciliationClaimToken
          })
        }
        const terminalCommitFenceOptions = {
          ctx,
          config,
          calendarId,
          timezone: businessTimezone,
          confirmationEvidence,
          expectedCapabilitiesFingerprint: nativeAppointmentExpectedCapabilitiesFingerprint
        }
        const preCommitAuthority = await revalidateNativeAppointmentTerminalCommitAuthority(
          terminalCommitFenceOptions
        )
        if (!preCommitAuthority.ok) {
          throw Object.assign(new Error(preCommitAuthority.error), {
            status: 409,
            statusCode: 409,
            code: preCommitAuthority.code,
            appointmentOfferInvalidated: preCommitAuthority.appointmentOfferInvalidated === true,
            appointmentOfferRestoreSameDate: preCommitAuthority.appointmentOfferRestoreSameDate === true
          })
        }
        terminalCommitFenceOptions.expectedCalendarFingerprint = preCommitAuthority.calendarFingerprint
        await runNativeAppointmentAfterPreCommitAuthorityHook({
          terminalToolName: 'request_human_booking',
          purpose: 'book',
          ctx,
          config,
          calendarId,
          preCommitAuthority
        })
        const assignmentCapability = {
          userId: preCommitAuthority.scheduleCapability?.handoffUserId || '',
          userName: preCommitAuthority.scheduleCapability?.handoffUserName || ''
        }
        const committed = await commitNativeHandoff({
          ctx,
          config,
          capability: assignmentCapability,
          authorityFence: buildNativeAppointmentTerminalCommitFence(terminalCommitFenceOptions),
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
              terminalToolName: 'request_human_booking',
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
              sourceMessageId: executionId,
              ...(verifiedDeposit
                ? {
                    depositReconciliationId: verifiedDeposit.reconciliationId,
                    depositPaymentId: verifiedDeposit.paymentId,
                    selectionRequestDraftHash: verifiedDeposit.selectionRequestDraftHash
                  }
                : {})
            }
          },
          beforeAssignment: verifiedDeposit
            ? () => consumeConversationalAppointmentDepositForHumanBooking({
                reconciliationId: verifiedDeposit.reconciliationId,
                contactId: ctx.contactId,
                agentId,
                paymentId: verifiedDeposit.paymentId,
                reconciliationClaimToken: verifiedDeposit.reconciliationClaimToken,
                humanBookingEventId: evidenceEventId,
                calendarId,
                startTime: start.toISOString(),
                selectionRequestDraftHash: verifiedDeposit.selectionRequestDraftHash,
                sourceMessageId: executionId
              })
            : null,
          afterEvidence: verifiedDeposit
            ? () => assertNativeHumanBookingDepositEvent({
                eventId: evidenceEventId,
                contactId: ctx.contactId,
                agentId,
                reconciliationId: verifiedDeposit.reconciliationId,
                paymentId: verifiedDeposit.paymentId,
                calendarId,
                startTime: start.toISOString(),
                selectionRequestDraftHash: verifiedDeposit.selectionRequestDraftHash,
                sourceMessageId: executionId
              })
            : null,
          terminalAuthorityToken: verifiedDeposit ? terminalAuthorityToken : ''
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
          ...(error?.appointmentOfferInvalidated === true
            ? {
                appointmentOfferInvalidated: true,
                appointmentOfferRestoreSameDate: error.appointmentOfferRestoreSameDate === true,
                transferRequired: false
              }
            : {}),
          error: error?.code
            ? error.message
            : 'No se pudo guardar y transferir la solicitud de cita. No afirmes que el equipo la recibió ni que la cita quedó confirmada.'
        }
        settleAction(action, 'error', { transferRequired: true, error: errorResult.error })
        return errorResult
      }

      if (verifiedDeposit && nativeHumanBookingAfterCommitHookForTest) {
        await nativeHumanBookingAfterCommitHookForTest({
          reconciliationId: verifiedDeposit.reconciliationId,
          contactId: ctx.contactId,
          agentId,
          evidenceEventId,
          calendarId,
          startTime: start.toISOString()
        })
      }

      let notificationWarning = false
      if (verifiedDeposit || evidenceInserted) {
        try {
          if (verifiedDeposit) {
            await notifyConversationalHumanBookingDeposit({
              reconciliationId: verifiedDeposit.reconciliationId,
              contactId: ctx.contactId,
              title: participant.title,
              startTime: start.toISOString()
            })
          } else {
            await notifyHumanPriority(ctx, {
              reason: 'Horario elegido pendiente de confirmación humana',
              summary: `${participant.title}: ${start.toISOString()}`,
              signal: 'ready_for_human'
            })
          }
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
        depositConsumed: Boolean(verifiedDeposit),
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

  const cancelAppointmentTool = tool({
    name: 'cancel_appointment',
    description: 'Cancela de forma no destructiva una cita futura del contacto en el calendario blindado. Usa sólo un appointmentId exacto devuelto por get_contact_appointments y sólo cuando el criterio de la estrategia y la conversación indiquen que la persona realmente quiere cancelar esa cita.',
    parameters: z.object({
      appointmentId: z.string().describe('ID exacto devuelto por get_contact_appointments'),
      reason: z.string().nullable().describe('Motivo breve compartido por la persona; null si no lo explicó')
    }),
    execute: async ({ appointmentId, reason }) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const calendar = await resolveNativeScheduleCalendar(scheduleCapability)
      if (!calendar?.id) {
        return { ok: false, actionCompleted: false, error: 'El calendario blindado ya no existe o dejó de estar activo.' }
      }
      if (!nativeCalendarPermissionEnabled(calendar.allow_cancellation)) {
        return { ok: false, actionCompleted: false, error: 'Este calendario no permite cancelar citas desde el chat. Pasa la conversación a una persona.' }
      }
      const appointment = await loadOwnedConversationalAppointment({
        ctx,
        calendarId: calendar.id,
        appointmentId
      })
      if (!appointment) {
        return { ok: false, actionCompleted: false, error: 'No encontré una cita futura de este contacto que pueda cancelarse.' }
      }
      if (nativeAppointmentIsCancelled(appointment)) {
        const action = pushAction(ctx, 'cancel_appointment', {
          appointmentId: appointment.id,
          expectedStartTime: appointment.start_time,
          replayed: true,
          effect: { liveEffect: 'CONFIRMARÍA que la cita ya estaba cancelada sin repetir efectos', marksObjectiveCompleted: false }
        })
        await supersedeActiveRescheduleOffersForAppointment({
          ctx,
          config,
          appointmentId: appointment.id
        })
        const visibleReply = 'listo, esa cita ya estaba cancelada; no repetí ninguna acción'
        settleAction(action, 'ok', {
          actionCompleted: true,
          appointmentCancelled: true,
          alreadyCancelled: true,
          replayed: true,
          visibleReply
        })
        return {
          ok: true,
          actionCompleted: true,
          alreadyCancelled: true,
          appointment: { status: 'cancelled' },
          visibleReply,
          note: 'La cita ya estaba cancelada; no se repitió ninguna acción.'
        }
      }
      if (INACTIVE_APPOINTMENT_STATUSES.has(nativeAppointmentStatus(appointment))) {
        return { ok: false, actionCompleted: false, error: 'Esa cita ya no está activa y no puede cancelarse otra vez.' }
      }
      const action = pushAction(ctx, 'cancel_appointment', {
        appointmentId: appointment.id,
        expectedStartTime: appointment.start_time,
        reason: cleanAppointmentText(reason, 500) || null,
        effect: { liveEffect: 'CANCELARÍA la cita exacta sin borrar su historial', marksObjectiveCompleted: false }
      })
      if (ctx.dryRun) {
        await supersedeActiveRescheduleOffersForAppointment({
          ctx,
          config,
          appointmentId: appointment.id
        })
        settleAction(action, 'simulated', { actionCompleted: false, wouldCancelAppointment: true })
        return { ok: true, simulated: true, actionCompleted: false, wouldCancelAppointment: true }
      }
      const response = await invokeController(updateAppointment, {
        params: { id: appointment.id },
        body: {
          appointmentStatus: 'cancelled',
          status: 'cancelled',
          expectedStartTime: appointment.start_time,
          expectedEndTime: appointment.end_time,
          expectedAppointmentStatus: nativeAppointmentStatus(appointment),
          strictLifecycleMutation: 'cancel'
        }
      })
      const result = toToolResult(response, (data) => ({
        status: nativeAppointmentStatus(data),
        startTime: data?.startTime || data?.start_time || null,
        lifecycleReplay: data?.lifecycleReplay || null
      }))
      if (!result.ok || !['cancelled', 'canceled'].includes(String(result.data?.status || ''))) {
        const error = result.error || 'La cita no confirmó su cancelación y conserva su estado anterior.'
        settleAction(action, 'error', { actionCompleted: false, error })
        return { ok: false, actionCompleted: false, error }
      }
      const concurrentReplay = result.data?.lifecycleReplay === 'already_cancelled'
      await supersedeActiveRescheduleOffersForAppointment({
        ctx,
        config,
        appointmentId: appointment.id
      })
      const visibleReply = concurrentReplay
        ? 'listo, esa cita ya estaba cancelada; no repetí ninguna acción'
        : 'listo, la cita quedó cancelada'
      settleAction(action, 'ok', {
        actionCompleted: true,
        appointmentCancelled: true,
        alreadyCancelled: concurrentReplay,
        replayed: concurrentReplay,
        visibleReply
      })
      return {
        ok: true,
        actionCompleted: true,
        appointmentCancelled: true,
        ...(concurrentReplay ? { alreadyCancelled: true, replayed: true } : {}),
        appointment: result.data,
        visibleReply,
        note: 'La cita quedó cancelada de verdad y conservó su historial.'
      }
    }
  })

  const rescheduleAppointmentTool = tool({
    name: 'reschedule_appointment',
    description: 'Mueve una cita futura existente al único horario nuevo que ya fue ofrecido y confirmado. No recibe fecha ni hora: recupera la oferta durable purpose=reschedule ligada al appointmentId exacto y conserva la misma cita, duración y participantes.',
    parameters: z.object({
      appointmentId: z.string().describe('ID exacto devuelto por get_contact_appointments y ligado a la oferta de reagendamiento')
    }),
    execute: async ({ appointmentId }) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const calendar = await resolveNativeScheduleCalendar(scheduleCapability)
      if (!calendar?.id) {
        return { ok: false, actionCompleted: false, appointmentOfferInvalidated: true, error: 'El calendario blindado ya no existe o dejó de estar activo.' }
      }
      if (!nativeCalendarPermissionEnabled(calendar.allow_reschedule)) {
        return { ok: false, actionCompleted: false, appointmentOfferInvalidated: true, error: 'Este calendario no permite reagendar desde el chat. Pasa la conversación a una persona.' }
      }
      const candidate = await loadNativeAppointmentOfferCandidate({ ctx, config })
      const offerDetail = candidate?.offer?.detail || {}
      const cleanAppointmentId = String(appointmentId || '').trim()
      if (
        !candidate?.ok ||
        String(offerDetail.purpose || 'book') !== 'reschedule' ||
        String(offerDetail.appointmentId || '') !== cleanAppointmentId
      ) {
        return appointmentSelectionError(
          'No hay una oferta vigente de reagendamiento ligada a esa cita. Consulta la cita, busca disponibilidad y ofrece un horario nuevo.',
          'appointment_reschedule_offer_required'
        )
      }
      const timezone = await getAccountTimezone()
      let confirmationEvidence = await resolveNativeAppointmentSelection({
        ctx,
        config,
        calendarId: calendar.id,
        timezone
      })
      if (!confirmationEvidence.ok) return confirmationEvidence
      const appointment = await loadOwnedConversationalAppointment({
        ctx,
        calendarId: calendar.id,
        appointmentId: cleanAppointmentId
      })
      if (!appointment || INACTIVE_APPOINTMENT_STATUSES.has(nativeAppointmentStatus(appointment))) {
        return { ok: false, actionCompleted: false, appointmentOfferInvalidated: true, error: 'La cita ya no está activa o no pertenece al contacto de este hilo.' }
      }
      const expectedStartMs = new Date(offerDetail.expectedStartTime || '').getTime()
      const currentStartMs = new Date(appointment.start_time || '').getTime()
      const targetStartMs = new Date(offerDetail.startTime || '').getTime()
      if (!Number.isFinite(expectedStartMs) || !Number.isFinite(currentStartMs) || !Number.isFinite(targetStartMs)) {
        return { ok: false, actionCompleted: false, appointmentOfferInvalidated: true, error: 'La oferta de reagendamiento no conserva horarios válidos.' }
      }
      const selectedStartMs = new Date(confirmationEvidence.selectedStartTime || '').getTime()
      if (!Number.isFinite(selectedStartMs) || Math.abs(selectedStartMs - targetStartMs) >= 60000) {
        return appointmentSelectionError('La confirmación no corresponde al horario nuevo ligado a esta cita.', 'appointment_reschedule_selection_mismatch')
      }
      if (Math.abs(currentStartMs - targetStartMs) < 60000) {
        if (!confirmationEvidence.reusedForPaymentResume) {
          confirmationEvidence = await persistNativeAppointmentSelection({
            ctx,
            config,
            calendarId: calendar.id,
            startTime: new Date(targetStartMs).toISOString(),
            evidence: confirmationEvidence
          })
          if (!confirmationEvidence.ok && confirmationEvidence.actionCompleted === false) return confirmationEvidence
        }
        const action = pushAction(ctx, 'reschedule_appointment', {
          appointmentId: appointment.id,
          startTime: new Date(currentStartMs).toISOString(),
          endTime: new Date(appointment.end_time).toISOString(),
          replayed: true,
          effect: { liveEffect: 'CONFIRMARÍA que la cita ya tenía el horario nuevo sin repetir efectos', marksObjectiveCompleted: false }
        })
        const visibleReply = 'listo, esa misma cita ya tenía el horario nuevo; no repetí ninguna acción'
        settleAction(action, 'ok', {
          actionCompleted: true,
          appointmentRescheduled: true,
          alreadyRescheduled: true,
          replayed: true,
          visibleReply
        })
        return {
          ok: true,
          actionCompleted: true,
          alreadyRescheduled: true,
          appointment: {
            startTime: new Date(currentStartMs).toISOString(),
            endTime: new Date(appointment.end_time).toISOString(),
            status: nativeAppointmentStatus(appointment) || 'confirmed'
          },
          visibleReply,
          note: 'La cita ya conserva ese horario; no se repitió la mutación.'
        }
      }
      if (currentStartMs !== expectedStartMs) {
        return { ok: false, actionCompleted: false, appointmentOfferInvalidated: true, error: 'La cita cambió desde que se ofreció el nuevo horario. Consulta su estado antes de volver a moverla.' }
      }
      const currentEndMs = new Date(appointment.end_time).getTime()
      const expectedEndMs = new Date(offerDetail.expectedEndTime || '').getTime()
      const durationMs = Number(offerDetail.durationMs)
      if (!Number.isFinite(currentEndMs) || !Number.isFinite(expectedEndMs) || currentEndMs !== expectedEndMs) {
        return { ok: false, actionCompleted: false, appointmentOfferInvalidated: true, error: 'La duración de la cita cambió desde que se ofreció el horario. Consulta su estado antes de volver a moverla.' }
      }
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs !== currentEndMs - currentStartMs) {
        return { ok: false, actionCompleted: false, appointmentOfferInvalidated: true, error: 'La cita no conserva una duración válida y no puede reagendarse automáticamente.' }
      }
      const slotValidation = await revalidateAppointmentSlot({
        calendarId: calendar.id,
        requestedStartTime: new Date(targetStartMs).toISOString(),
        windowStart: normalizeDateOnlyInTimezone(new Date(targetStartMs - 86400000).toISOString(), timezone),
        windowEnd: normalizeDateOnlyInTimezone(new Date(targetStartMs + 86400000).toISOString(), timezone),
        lookupSlots: verifiedRescheduleSlotLookup({ appointmentId: appointment.id, durationMs }),
        ignoreAppointmentConflicts: nativeCalendarAllowsOverlaps(calendar)
      })
      if (!slotValidation.ok) return slotValidation
      const canonicalStart = new Date(slotValidation.matchedStartTime).toISOString()
      const canonicalEnd = new Date(new Date(canonicalStart).getTime() + durationMs).toISOString()
      if (!confirmationEvidence.reusedForPaymentResume) {
        confirmationEvidence = await persistNativeAppointmentSelection({
          ctx,
          config,
          calendarId: calendar.id,
          startTime: canonicalStart,
          evidence: confirmationEvidence
        })
        if (!confirmationEvidence.ok && confirmationEvidence.actionCompleted === false) return confirmationEvidence
      }
      const action = pushAction(ctx, 'reschedule_appointment', {
        appointmentId: appointment.id,
        expectedStartTime: new Date(expectedStartMs).toISOString(),
        startTime: canonicalStart,
        endTime: canonicalEnd,
        confirmationEvidence,
        effect: { liveEffect: 'REAGENDARÍA la misma cita sin crear otra', marksObjectiveCompleted: false }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', { actionCompleted: false, wouldRescheduleAppointment: true })
        return {
          ok: true,
          simulated: true,
          actionCompleted: false,
          wouldRescheduleAppointment: true,
          appointment: { startTime: canonicalStart, endTime: canonicalEnd }
        }
      }
      const terminalCommitFenceOptions = {
        ctx,
        config,
        calendarId: calendar.id,
        timezone,
        confirmationEvidence,
        expectedCapabilitiesFingerprint: nativeAppointmentExpectedCapabilitiesFingerprint
      }
      const preCommitAuthority = await revalidateNativeAppointmentTerminalCommitAuthority(
        terminalCommitFenceOptions
      )
      if (!preCommitAuthority.ok) {
        settleAction(action, 'error', {
          error: preCommitAuthority.error,
          code: preCommitAuthority.code
        })
        return preCommitAuthority
      }
      terminalCommitFenceOptions.expectedCalendarFingerprint = preCommitAuthority.calendarFingerprint
      await runNativeAppointmentAfterPreCommitAuthorityHook({
        terminalToolName: 'reschedule_appointment',
        purpose: 'reschedule',
        ctx,
        config,
        calendarId: calendar.id,
        appointmentId: appointment.id,
        preCommitAuthority
      })
      const currentOverlapsAllowed = nativeCalendarAllowsOverlaps(preCommitAuthority.calendar)
      const response = await invokeController(updateAppointment, {
        params: { id: appointment.id },
        body: {
          startTime: canonicalStart,
          endTime: canonicalEnd,
          expectedStartTime: new Date(expectedStartMs).toISOString(),
          expectedEndTime: new Date(expectedEndMs).toISOString(),
          expectedAppointmentStatus: nativeAppointmentStatus(appointment),
          strictAvailabilityCheck: true,
          strictLifecycleMutation: 'reschedule',
          ignoreAppointmentConflicts: currentOverlapsAllowed
        },
        internalContext: {
          conversationalAgentAppointment: true,
          allowAppointmentOverlaps: currentOverlapsAllowed,
          conversationalAppointmentAuthorityFence: buildNativeAppointmentTerminalCommitFence(
            terminalCommitFenceOptions
          )
        }
      })
      const result = toToolResult(response, (data) => ({
        startTime: data?.startTime || data?.start_time || null,
        endTime: data?.endTime || data?.end_time || null,
        status: nativeAppointmentStatus(data),
        syncStatus: data?.syncStatus || data?.sync_status || null,
        lifecycleReplay: data?.lifecycleReplay || null
      }))
      const resultStartMs = new Date(result.data?.startTime || '').getTime()
      if (
        !result.ok ||
        INACTIVE_APPOINTMENT_STATUSES.has(String(result.data?.status || '').trim().toLowerCase()) ||
        !Number.isFinite(resultStartMs) ||
        Math.abs(resultStartMs - new Date(canonicalStart).getTime()) >= 60000
      ) {
        const error = result.error || 'La cita no confirmó el nuevo horario y conserva su estado canónico.'
        settleAction(action, 'error', { actionCompleted: false, error })
        const statusCode = Number(response?.statusCode || 0)
        const definitiveLifecycleFailure = (
          (statusCode >= 400 && statusCode < 500) ||
          INACTIVE_APPOINTMENT_STATUSES.has(String(result.data?.status || '').trim().toLowerCase())
        )
        const authorityFenceData = response.payload?.data && typeof response.payload.data === 'object'
          ? response.payload.data
          : {}
        const authorityFenceFailed = authorityFenceData.appointmentOfferInvalidated === true
        return {
          ok: false,
          actionCompleted: false,
          ...(definitiveLifecycleFailure
            ? {
                appointmentOfferInvalidated: true,
                appointmentOfferRestoreSameDate: authorityFenceFailed
                  ? authorityFenceData.appointmentOfferRestoreSameDate === true
                  : statusCode === 409
              }
            : {}),
          ...(response.payload?.code ? { code: response.payload.code } : {}),
          error
        }
      }
      const concurrentReplay = result.data?.lifecycleReplay === 'already_rescheduled'
      const visibleReply = concurrentReplay
        ? 'listo, esa misma cita ya tenía el horario nuevo; no repetí ninguna acción'
        : 'listo, la misma cita quedó cambiada al horario nuevo'
      settleAction(action, 'ok', {
        actionCompleted: true,
        appointmentRescheduled: true,
        alreadyRescheduled: concurrentReplay,
        replayed: concurrentReplay,
        visibleReply
      })
      return {
        ok: true,
        actionCompleted: true,
        appointmentRescheduled: true,
        ...(concurrentReplay ? { alreadyRescheduled: true, replayed: true } : {}),
        appointment: result.data,
        visibleReply,
        note: 'La misma cita quedó reagendada; no se creó otra ni se repitió ningún cobro.'
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

  const getPaymentStatusTool = tool({
    name: 'get_payment_status',
    description: 'Consulta el estado real de los cobros que este mismo agente vinculó al contacto actual. No acepta IDs ni otro contacto, no confirma fondos por texto y no sustituye la reconciliación segura que autoriza una cita.',
    parameters: z.object({}),
    execute: async () => {
      const contactId = String(ctx.contactId || '').trim()
      const agentId = String(config.id || ctx.agentId || '').trim()
      if (!contactId || !agentId) {
        return { ok: false, found: false, payments: [], error: 'No se pudo identificar de forma segura este hilo.' }
      }
      let events
      try {
        events = await db.all(
          `SELECT id, event_type, detail_json, created_at
           FROM conversational_agent_events
           WHERE contact_id = ? AND agent_id = ?
             AND event_type IN ('payment_link_created', 'payment_link_reused', 'deposit_transfer_pending_review')
           ORDER BY created_at DESC, id DESC
           LIMIT 30`,
          [contactId, agentId]
        )
      } catch {
        return { ok: false, found: false, payments: [], error: 'No se pudo consultar el ledger real de cobros en este momento.' }
      }
      const seen = new Set()
      const payments = []
      for (const event of events || []) {
        const detail = parseNativeEventDetail(event.detail_json)
        const ledgerPaymentId = String(detail.ledgerPaymentId || '').trim()
        if (!ledgerPaymentId || seen.has(ledgerPaymentId)) continue
        seen.add(ledgerPaymentId)
        let ledger
        try {
          ledger = await db.get(
            `SELECT id, contact_id, amount, currency, status, payment_mode,
                    payment_provider, payment_url, due_date, paid_at, created_at,
                    metadata_json
             FROM payments WHERE id = ? AND contact_id = ? LIMIT 1`,
            [ledgerPaymentId, contactId]
          )
        } catch {
          return { ok: false, found: false, payments: [], error: 'No se pudo verificar uno de los cobros vinculados en este momento.' }
        }
        if (!ledger?.id) continue
        const currency = String(ledger.currency || '').trim().toUpperCase()
        const provider = String(ledger.payment_provider || '').trim().toLowerCase()
        const paymentMode = String(ledger.payment_mode || '').trim().toLowerCase()
        const status = String(ledger.status || '').trim().toLowerCase()
        const rawProviderStatus = getConversationalPaymentProviderRawStatus(ledger)
        const expectedCurrency = String(detail.currency || '').trim().toUpperCase()
        const expectedProvider = String(detail.paymentProvider || detail.provider || '').trim().toLowerCase()
        const expectedMinor = paymentAmountInMinorUnits(detail.amount, expectedCurrency)
        const ledgerMinor = paymentAmountInMinorUnits(ledger.amount, currency)
        const transferBinding = event.event_type === 'deposit_transfer_pending_review'
        const exactBinding = (
          expectedCurrency &&
          expectedCurrency === currency &&
          Number.isSafeInteger(expectedMinor) &&
          expectedMinor === ledgerMinor &&
          (transferBinding ? provider === 'manual' : Boolean(expectedProvider) && expectedProvider === provider)
        )
        if (!exactBinding) continue
        const negativeStatuses = new Set([
          'cancelled', 'canceled', 'cancelled_by_user', 'canceled_by_user', 'void', 'voided',
          'expired', 'incomplete_expired', 'abandoned', 'refunded', 'refund', 'partially_refunded',
          'chargeback', 'charged_back', 'failed', 'failure', 'error', 'declined', 'rejected',
          'payment_failed', 'payment_declined', 'card_declined', 'denied'
        ])
        const negativeStatus = negativeStatuses.has(rawProviderStatus)
          ? rawProviderStatus
          : (negativeStatuses.has(status) ? status : '')
        const effectiveStatus = negativeStatus || rawProviderStatus || status
        const fundsConfirmed = !negativeStatus && paymentMode === 'live' && (
          SUCCESS_PAYMENT_STATUSES.has(status) || SUCCESS_PAYMENT_STATUSES.has(effectiveStatus)
        )
        const dueValue = String(ledger.due_date || '').trim()
        const dueValid = dueValue
          ? await conversationalPaymentLinkIsStillValid(dueValue).catch(() => false)
          : false
        let state = status || 'pending'
        if (fundsConfirmed) state = 'confirmed'
        else if (status === 'pending_review' || paymentMode === 'manual_review') state = 'pending_review'
        else if (['cancelled', 'canceled', 'cancelled_by_user', 'canceled_by_user', 'void', 'voided'].includes(effectiveStatus)) state = 'cancelled'
        else if (['refunded', 'refund', 'partially_refunded', 'chargeback', 'charged_back'].includes(effectiveStatus)) state = 'refunded'
        else if (['failed', 'failure', 'error', 'declined', 'rejected', 'payment_failed', 'payment_declined', 'card_declined', 'denied'].includes(effectiveStatus)) state = 'failed'
        else if (['expired', 'incomplete_expired', 'abandoned'].includes(effectiveStatus) || !dueValid) state = 'expired'
        else if (paymentMode !== 'live' || !conversationalPaymentStatusIsReusable(status)) state = 'unknown'
        else state = 'pending'
        const paymentUrl = state === 'pending' && dueValid && paymentMode === 'live'
          ? String(ledger.payment_url || '').trim()
          : ''
        payments.push({
          state,
          fundsConfirmed,
          amount: Number(ledger.amount),
          currency,
          provider: provider || null,
          expiresAt: ledger.due_date || null,
          paidAt: ledger.paid_at || null,
          canReuseLink: Boolean(paymentUrl),
          ...(paymentUrl ? { paymentUrl } : {})
        })
        if (payments.length >= 5) break
      }
      return {
        ok: true,
        found: payments.length > 0,
        latest: payments[0] || null,
        payments,
        note: payments.length
          ? 'Sólo fundsConfirmed=true demuestra fondos reales. pending y pending_review no autorizan continuar como pagado.'
          : 'No encontré un cobro vinculado por este agente al contacto actual.'
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
      if (!(await hasFeature('payment_links'))) {
        return {
          ok: false,
          actionCompleted: false,
          code: 'feature_not_available',
          error: 'Los enlaces de pago están disponibles en el plan Profesional.'
        }
      }
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      if (paymentCapability?.collectionMethod !== 'payment_link') {
        return {
          ok: false,
          actionCompleted: false,
          error: 'Este cobro está configurado para transferencia o depósito. No se creó ningún enlace.'
        }
      }

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
      const nativePaymentPurpose = baseNativePaymentPurpose === 'deposit' && scheduleCapability && await hasNativeAppointmentDepositCollectionScope({
        ctx,
        config: runtimeConfig,
        method: 'paymentLink'
      })
        ? 'appointment_deposit'
        : baseNativePaymentPurpose
      let appointmentSelection = null
      let appointmentDepositIntent = null
      let appointmentDepositClaim = null
      let appointmentDepositReuseOnly = false
      let appointmentDepositCanonicalSourceEventId = null
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
        appointmentDepositReuseOnly = resolvedIntent.reuseOnly === true
        appointmentDepositCanonicalSourceEventId = appointmentDepositReuseOnly
          ? String(resolvedIntent.canonicalSourceEventId || '').trim()
          : null
        if (appointmentDepositReuseOnly) {
          appointmentDepositClaim = {
            ok: true,
            reused: true,
            sourceAlreadyBound: true,
            claimToken: resolvedIntent.canonicalClaimToken || appointmentDepositIntent?.detail?.claimToken || null,
            intent: appointmentDepositIntent
          }
        } else {
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
      }

      const action = pushAction(ctx, 'create_payment_link', {
        amount: trustedPayment.amount,
        unitAmount: trustedPayment.unitAmount || trustedPayment.amount,
        quantity: trustedPayment.quantity || 1,
        currency: trustedPayment.currency,
        concept: trustedPayment.concept,
        paymentPurpose: nativePaymentPurpose,
        afterPayment: paymentCapability?.afterPayment || 'continue',
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
              appointmentSelectionRequestDraftHash: appointmentSelection.detail.appointmentRequestDraftHash,
              appointmentSelectionBookingOwner: appointmentSelection.detail.bookingOwner,
              appointmentSelectionTerminalToolName: appointmentSelection.detail.terminalToolName,
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
          gateway: paymentCapability?.gateway || 'stripe',
          amount: trustedPayment.amount,
          currency: trustedPayment.currency,
          concept: trustedPayment.concept,
          installments: paymentCapability?.installments,
          expirationMinutes: paymentCapability?.expirationMinutes,
          afterPayment: paymentCapability?.afterPayment,
          channels: buildPaymentChannels(deliveryChannel),
          source: 'conversational_agent_v2',
          idempotencyKey: paymentIdempotencyKey,
          reuseOnly: appointmentDepositReuseOnly,
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
            appointmentSelectionRequestDraftHash: appointmentSelection?.detail?.appointmentRequestDraftHash || null,
            appointmentSelectionBookingOwner: appointmentSelection?.detail?.bookingOwner || null,
            appointmentSelectionTerminalToolName: appointmentSelection?.detail?.terminalToolName || null,
            appointmentDepositIntentEventId: appointmentDepositIntent?.id || null,
            appointmentDepositIntentClaimKey: appointmentDepositReuseOnly
              ? appointmentDepositCanonicalSourceEventId
              : (paymentSourceEventId || null),
            appointmentDepositIntentClaimToken: appointmentDepositClaim?.claimToken || null
          }
        })

        const crossTurnReuse = result?.crossTurnReuse === true
        const canonicalPaymentLinkRequestKey = crossTurnReuse
          ? String(result?.canonicalPaymentLinkRequestKey || '').trim()
          : paymentIdempotencyKey
        const canonicalBindingEventId = crossTurnReuse
          ? String(result?.canonicalBindingEventId || '').trim()
          : paymentSourceEventId
        const resultCurrency = String(result?.currency || '').trim().toUpperCase()
        const paymentLedger = result?.ledgerPaymentId
          ? await db.get(
              `SELECT id, contact_id, amount, currency, status, payment_mode, payment_provider,
                      ghl_invoice_id, public_payment_id, payment_link_request_key,
                      payment_url, due_date, metadata_json
               FROM payments
               WHERE contact_id = ? AND id = ? AND payment_link_request_key = ?
               LIMIT 1`,
              [ctx.contactId, result.ledgerPaymentId, canonicalPaymentLinkRequestKey]
            ).catch(() => null)
          : null
        const crossTurnAlias = crossTurnReuse
          ? await db.get(
              `SELECT contact_id, status, binding_event_id, binding_status
               FROM conversational_payment_link_requests
               WHERE idempotency_key = ?
               LIMIT 1`,
              [paymentIdempotencyKey]
            ).catch(() => null)
          : null
        const canonicalSourceEvent = crossTurnReuse && canonicalBindingEventId
          ? await db.get(
              `SELECT id, contact_id, agent_id, event_type, detail_json
               FROM conversational_agent_events
               WHERE id = ?
               LIMIT 1`,
              [canonicalBindingEventId]
            ).catch(() => null)
          : null
        const canonicalSourceDetail = parseNativeEventDetail(canonicalSourceEvent?.detail_json)
        const ledgerCurrency = String(paymentLedger?.currency || '').trim().toUpperCase()
        const ledgerAmount = Number(paymentLedger?.amount)
        const trustedAmountMinor = paymentAmountInMinorUnits(trustedPayment.amount, trustedPayment.currency)
        const ledgerAmountMinor = paymentAmountInMinorUnits(paymentLedger?.amount, ledgerCurrency)
        const resultAmountMinor = paymentAmountInMinorUnits(result?.amount, resultCurrency)
        const ledgerEnvironment = String(paymentLedger?.payment_mode || '').trim().toLowerCase()
        const ledgerProvider = String(paymentLedger?.payment_provider || '').trim().toLowerCase()
        const expectedProvider = String(paymentCapability?.gateway || 'stripe').trim().toLowerCase()
        const externalIdentityMatches = expectedProvider === 'highlevel'
          ? String(paymentLedger?.ghl_invoice_id || '').trim() === String(result?.invoiceId || '').trim()
          : String(paymentLedger?.public_payment_id || '').trim() === String(result?.publicPaymentId || '').trim()
        const crossTurnLedgerReusable = !crossTurnReuse || Boolean(
          conversationalPaymentStatusIsReusable(paymentLedger?.status) &&
          !conversationalPaymentProviderStatusIsClosed(paymentLedger) &&
          await conversationalPaymentLinkIsStillValid(paymentLedger?.due_date).catch(() => false)
        )
        const crossTurnBindingMatch = !crossTurnReuse || Boolean(
          canonicalPaymentLinkRequestKey &&
          canonicalPaymentLinkRequestKey !== paymentIdempotencyKey &&
          canonicalBindingEventId &&
          String(crossTurnAlias?.contact_id || '') === String(ctx.contactId || '') &&
          String(crossTurnAlias?.status || '') === 'completed' &&
          String(crossTurnAlias?.binding_status || '') === 'bound' &&
          String(crossTurnAlias?.binding_event_id || '') === canonicalBindingEventId &&
          String(canonicalSourceEvent?.id || '') === canonicalBindingEventId &&
          String(canonicalSourceEvent?.contact_id || '') === String(ctx.contactId || '') &&
          String(canonicalSourceEvent?.agent_id || '') === String(config.id || ctx.agentId || '') &&
          ['payment_link_created', 'payment_link_reused'].includes(String(canonicalSourceEvent?.event_type || '')) &&
          String(canonicalSourceDetail.ledgerPaymentId || '') === String(paymentLedger?.id || '') &&
          String(canonicalSourceDetail.paymentProvider || '').trim().toLowerCase() === expectedProvider &&
          String(canonicalSourceDetail.paymentEnvironment || '').trim().toLowerCase() === 'live' &&
          String(canonicalSourceDetail.paymentPurpose || '').trim().toLowerCase() === nativePaymentPurpose &&
          String(canonicalSourceDetail.afterPayment || 'continue').trim().toLowerCase() === String(paymentCapability?.afterPayment || 'continue').trim().toLowerCase() &&
          paymentAmountInMinorUnits(canonicalSourceDetail.amount, trustedPayment.currency) === trustedAmountMinor &&
          String(canonicalSourceDetail.currency || '').trim().toUpperCase() === trustedPayment.currency &&
          (!appointmentDepositReuseOnly || (
            canonicalBindingEventId === appointmentDepositCanonicalSourceEventId &&
            String(canonicalSourceDetail.appointmentDepositIntentEventId || '') === String(appointmentDepositIntent?.id || '') &&
            String(canonicalSourceDetail.appointmentSelectionEventId || '') === String(appointmentSelection?.id || '')
          ))
        )
        const ledgerCanonicalMatch = Boolean(
          paymentLedger?.id &&
          Number.isFinite(ledgerAmount) &&
          Number.isSafeInteger(trustedAmountMinor) &&
          ledgerAmountMinor === trustedAmountMinor &&
          ledgerCurrency === trustedPayment.currency &&
          ledgerEnvironment === 'live' &&
          ledgerProvider === expectedProvider &&
          externalIdentityMatches &&
          String(paymentLedger?.payment_url || '').trim() === String(result?.paymentLink || '').trim() &&
          String(result?.provider || '').trim().toLowerCase() === expectedProvider &&
          String(result?.paymentMode || '').trim().toLowerCase() === 'live'
        )
        const sent = Boolean(result?.invoiceId && result?.paymentLink && result?.sendMethod !== 'none' && result?.status !== 'draft')
        const prepared = Boolean(result?.invoiceId && result?.paymentLink && paymentLedger?.id)
        const canonicalMatch = resultAmountMinor === trustedAmountMinor && resultCurrency === trustedPayment.currency
        if (!prepared || !canonicalMatch || !ledgerCanonicalMatch || !crossTurnBindingMatch || !crossTurnLedgerReusable) {
          await recordConversationalAgentEvent({
            contactId: ctx.contactId,
            eventType: 'payment_link_failed',
            detail: {
              reason: !prepared
                ? 'link_not_prepared'
                : (!ledgerCanonicalMatch
                    ? 'payment_ledger_mismatch'
                    : (!crossTurnBindingMatch
                        ? 'cross_turn_binding_mismatch'
                        : (!crossTurnLedgerReusable ? 'cross_turn_link_no_longer_reusable' : 'canonical_payment_mismatch'))),
              invoiceId: result?.invoiceId || null,
              expectedAmount: trustedPayment.amount,
              expectedCurrency: trustedPayment.currency,
              actualAmount: result?.amount || null,
              actualCurrency: result?.currency || null,
              ledgerAmount: Number.isFinite(ledgerAmount) ? ledgerAmount : null,
              ledgerCurrency: ledgerCurrency || null,
              ledgerEnvironment: ledgerEnvironment || null,
              ledgerProvider: ledgerProvider || null,
              expectedProvider,
              crossTurnReuse,
              crossTurnBindingMatch,
              crossTurnLedgerReusable
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
            crossTurnBindingMatch,
            crossTurnLedgerReusable,
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
            appointmentSelectionRequestDraftHash: appointmentSelection?.detail?.appointmentRequestDraftHash || null,
            appointmentSelectionBookingOwner: appointmentSelection?.detail?.bookingOwner || null,
            appointmentSelectionTerminalToolName: appointmentSelection?.detail?.terminalToolName || null,
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
          if (!crossTurnReuse) {
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
          crossTurnReuse,
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

  const customGoalSendsVerifiedLink = Boolean(
    customCapability?.completion === 'send_link' &&
    linkCapability?.linkKind === 'verified_goal'
  )
  const customGoalContract = customGoalSendsVerifiedLink
    ? {
        description: String(customCapability?.description || '').trim(),
        completion: 'send_link'
      }
    : null
  const customGoalContractHash = customGoalContract
    ? createHash('sha256').update(JSON.stringify(customGoalContract)).digest('hex')
    : ''
  const linkToolParameters = z.object({
    intencionDetectada: z.string().nullable().describe('Qué quiere lograr la persona; null si no hace falta contexto extra'),
    resumen: z.string().nullable().describe('Resumen breve para auditoría; null si no hace falta contexto extra')
  })
  const sendTriggerLinkTool = tool({
    name: 'send_trigger_link',
    description: 'Entrega exclusivamente el enlace general configurado en Mandar enlace. No crea, prepara, completa ni rastrea un Objetivo propio, aunque esa otra capacidad también esté activada.',
    parameters: linkToolParameters,
    execute: async ({ intencionDetectada, resumen }) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const requiredDataError = await enforceRequiredContactData({ ctx, scope: 'link', dataRequirements })
      if (requiredDataError) return requiredDataError
      intencionDetectada = intencionDetectada || 'Solicitó el enlace general'
      resumen = resumen || ''

      let triggerLink = null
      let targetUrl = String(linkCapability?.url || '').trim()
      if (linkCapability?.linkKind === 'trigger' && linkCapability.triggerLinkId) {
        triggerLink = await getTriggerLink(linkCapability.triggerLinkId)
        if (!triggerLink || triggerLink.archived || !triggerLink.active) {
          return { ok: false, actionCompleted: false, transferRequired: true, error: 'El enlace configurado ya no existe o está apagado. No se envió nada; pasa la conversación a una persona.' }
        }
        targetUrl = String(triggerLink.destinationUrl || '').trim()
      }
      if (!isSafeConversationalHttpUrl(targetUrl)) {
        return { ok: false, actionCompleted: false, transferRequired: true, error: 'El destino configurado no es un enlace web seguro. No se envió nada; pasa la conversación a una persona.' }
      }

      const action = pushAction(ctx, 'send_trigger_link', {
        objective: 'send_link',
        intencionDetectada,
        targetUrl,
        triggerLinkId: triggerLink?.id || null,
        effect: { liveEffect: 'ENVIARÍA el destino general configurado sin identidad en la URL y sin crear una meta', marksObjectiveCompleted: false }
      })
      if (!ctx.dryRun) {
        await recordConversationalAgentEvent({
          contactId: ctx.contactId,
          eventType: 'safe_link_sent',
          detail: {
            agentId: config.id || ctx.agentId || null,
            triggerLinkId: triggerLink?.id || null,
            linkKind: linkCapability?.linkKind || 'verified_goal',
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
        note: 'Manda sentUrl visible en el chat. Esta herramienta sólo entrega el enlace general y nunca crea ni completa un Objetivo propio.'
      }
    }
  })
  const sendGoalUrlTool = tool({
    name: 'send_goal_url',
    description: `Prepara exclusivamente el enlace rastreable para este Objetivo propio: ${customGoalContract?.description || 'objetivo configurado'}. Crea una meta pendiente que sólo una confirmación autenticada puede completar. No la uses para mandar un enlace general.`,
    parameters: linkToolParameters,
    execute: async ({ intencionDetectada, resumen }) => {
      const safetyFence = await guardMutationAgainstPreventiveMeasure(ctx)
      if (safetyFence) return safetyFence
      const requiredDataError = await enforceRequiredContactData({ ctx, scope: 'link', dataRequirements })
      if (requiredDataError) return requiredDataError
      intencionDetectada = intencionDetectada || 'Solicitó el enlace'
      resumen = resumen || ''

      const goalConfig = {
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

      const targetUrl = goalConfig.url || ''
      const trackingParam = goalConfig.trackingParam || DEFAULT_GOAL_TRACKING_PARAM
      if (!targetUrl || !isSafeConversationalHttpUrl(targetUrl)) {
        return { ok: false, error: 'No hay enlace configurado para este objetivo. Manda a humano con send_to_human y avisa que falta configurar el enlace.' }
      }
      const linkContext = { linkParams: {}, expected: { capabilityId: 'custom_goal' } }

      const action = pushAction(ctx, 'send_goal_url', {
        objective: 'custom', intencionDetectada, targetUrl,
        customGoalContract,
        customGoalContractHash,
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
            customGoalContractHash,
            String(ctx.channel || '').trim().toLowerCase(),
            nativeExecutionId
          ].join('\u0000')).digest('hex')}`,
          metadata: {
            expected: linkContext.expected,
            customGoalContract,
            customGoalContractHash,
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
      if (paymentCapability?.collectionMethod !== 'bank_transfer') {
        return {
          ok: false,
          actionCompleted: false,
          error: 'Este cobro usa un enlace de pago y se confirma con la señal de la pasarela; no acepta comprobantes por imagen.'
        }
      }
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
      const explicitAppointmentDepositScope = ctx.nativePaymentCollectionScope === 'appointment_deposit'
      let nativePaymentPurpose = baseNativePaymentPurpose === 'deposit' && scheduleCapability && ctx.dryRun && explicitAppointmentDepositScope
        ? 'appointment_deposit'
        : baseNativePaymentPurpose
      let paymentLabel = nativePaymentPurpose === 'appointment_deposit' ? 'anticipo' : 'pago'
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
        amount: deposit.mode === 'fixed' ? Number(deposit.amount) || null : null,
        currency: String(deposit.currency || ctx.accountLocale?.currency || '').trim().toUpperCase(),
        paymentPurpose: nativePaymentPurpose,
        afterPayment: paymentCapability?.afterPayment || 'continue',
        effect: { liveEffect: `LEERÍA el comprobante y lo registraría como pendiente de revisión; no confirma el ${paymentLabel}`, marksObjectiveCompleted: false }
      })

      const accountCurrency = String(ctx.accountLocale?.currency || await getAccountCurrency().catch(() => '')).trim().toUpperCase()

      const receiptMedia = await findCurrentInboundReceiptMedia(ctx)
      if (!receiptMedia) {
        settleAction(action, 'error', { error: 'no_receipt_media' })
        return { ok: false, actionCompleted: false, error: 'El mensaje actual no trae una foto o PDF reciente del comprobante. Pide a la persona que lo adjunte en un mensaje nuevo y vuelve a intentar.' }
      }
      if (!ctx.dryRun && baseNativePaymentPurpose === 'deposit' && scheduleCapability) {
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
        const exactAppointmentBinding = Boolean(
          resolvedIntent.intent && resolvedIntent.selection && resolvedIntent.claim?.ok
        )
        if (exactAppointmentBinding || explicitAppointmentDepositScope) {
          nativePaymentPurpose = 'appointment_deposit'
          paymentLabel = 'anticipo'
        }
        appointmentDepositIntent = exactAppointmentBinding ? resolvedIntent.intent : null
        appointmentSelection = exactAppointmentBinding ? resolvedIntent.selection : null
        appointmentDepositClaim = exactAppointmentBinding ? resolvedIntent.claim : null
        receiptIntentBindingEventId = resolvedIntent.receiptIntentBindingEventId
        receiptNeedsHumanReview = resolvedIntent.needsHumanReview === true || (explicitAppointmentDepositScope && !exactAppointmentBinding)
        receiptStaleReasons = Array.isArray(resolvedIntent.staleReasons) ? resolvedIntent.staleReasons : []
        if (explicitAppointmentDepositScope && !exactAppointmentBinding && !receiptStaleReasons.length) {
          receiptStaleReasons = ['appointment_intent_required']
        }
        receiptPossibleDoublePayment = resolvedIntent.possibleDoublePayment === true
        action.paymentPurpose = nativePaymentPurpose
        action.effect = {
          liveEffect: `LEERÍA el comprobante y lo registraría como pendiente de revisión; no confirma el ${paymentLabel}`,
          marksObjectiveCompleted: false
        }
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
      if (ctx.dryRun) {
        const currencyMatches = !analysis?.currency || !accountCurrency || String(analysis.currency).trim().toUpperCase() === accountCurrency
        const amountMatches = Boolean(analysis?.amount) && depositRequirementAmountMatches(deposit, analysis.amount)
        const proofMatchesConfiguredPayment = Boolean(analysis?.ok && analysis?.isPaymentReceipt && currencyMatches && amountMatches)
        const manualReviewReason = !analysis?.ok
          ? (analysis?.reason || 'analysis_failed')
          : !analysis?.isPaymentReceipt
            ? 'receipt_not_recognized'
            : !analysis?.amount
              ? 'amount_missing'
              : !currencyMatches
                ? 'currency_mismatch'
                : !amountMatches
                  ? 'amount_mismatch'
                  : null
        const simulatedOutcome = {
          actionCompleted: false,
          wouldRegisterPayment: false,
          wouldRegisterPendingReview: true,
          paymentConfirmed: false,
          manualReviewRequired: true,
          proofMatchesConfiguredPayment,
          manualReviewReason,
          analysis,
          expectedMode: deposit.mode === 'range' ? 'range' : 'fixed',
          expectedAmount: deposit.mode === 'fixed' ? Number(deposit.amount) || null : null,
          expectedMinAmount: deposit.mode === 'range' ? Number(deposit.minAmount) || null : null,
          expectedMaxAmount: deposit.mode === 'range' ? Number(deposit.maxAmount) || null : null,
          expectedCurrency: accountCurrency,
          paymentPurpose: nativePaymentPurpose,
          afterPayment: paymentCapability?.afterPayment || 'continue'
        }
        settleAction(action, 'simulated', simulatedOutcome)
        return {
          ok: true,
          simulated: true,
          ...simulatedOutcome,
          note: proofMatchesConfiguredPayment
            ? `Prueba real de lectura: el comprobante coincide con ${expectedLabel}; en vivo quedaría pendiente de revisión, nunca confirmado sólo por la foto.`
            : `Prueba real de lectura: el comprobante requiere revisión (${manualReviewReason || 'datos_inciertos'}). No se marcó ningún pago.`
        }
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
            autoResumeAllowed: !receiptNeedsHumanReview && (
              nativePaymentPurpose !== 'appointment_deposit' || proofBoundToAppointmentIntent
            ),
            appointmentSelectionEventId: appointmentSelection?.id || null,
            appointmentSelectionCalendarId: appointmentSelection?.detail?.calendarId || null,
            appointmentSelectionStartTime: appointmentSelection?.detail?.startTime || null,
            appointmentSelectionVerifiedAt: appointmentSelection?.detail?.verifiedAt || null,
            appointmentSelectionRequestDraftHash: appointmentSelection?.detail?.appointmentRequestDraftHash || null,
            appointmentSelectionBookingOwner: appointmentSelection?.detail?.bookingOwner || null,
            appointmentSelectionTerminalToolName: appointmentSelection?.detail?.terminalToolName || null,
            appointmentDepositIntentEventId: appointmentDepositIntent?.id || null,
            appointmentDepositIntentClaimKey: receiptIntentBindingEventId,
            appointmentDepositIntentClaimToken: appointmentDepositClaim?.claimToken || null,
            receiptIntentBindingEventId,
            afterPayment: paymentCapability?.afterPayment || 'continue',
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
        manualReviewRequired: true,
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
        manualReviewRequired: true,
        transferredToHuman: receiptNeedsHumanReview,
        ...(receiptNeedsHumanReview ? { signal: 'ready_for_human' } : {}),
        note: 'Comprobante recibido y pendiente de revisión humana. No digas que el pago está confirmado y no continúes con una acción que exija fondos verificados.'
      }
    }
  })

  const resolveActiveAppointmentSelectionTool = tool({
    name: 'resolve_active_appointment_selection',
    description: [
      'Cierra la selección parcial en la que Ristak conserva el alcance de la cita y todavía falta fecha u hora.',
      'Usa decline sólo si la persona ya no quiere continuar con la cita y restart si pide empezar de nuevo sin conservar la selección.',
      'No la uses para cambiar a otra fecha u hora: una consulta nueva válida reemplaza el estado anterior. Si ya existe una oferta individual, usa resolve_active_appointment_offer.'
    ].join(' '),
    parameters: z.object({
      decision: z.enum(['decline', 'restart'])
    }),
    execute: async ({ decision }) => {
      const expected = ctx.appointmentSelectionProgress
      const current = await loadConversationalAppointmentSelectionProgressContext({ ctx, config })
      if (
        !expected?.active ||
        !current?.active ||
        String(current.eventId || '') !== String(expected.eventId || '') ||
        String(current.stateFingerprint || '') !== String(expected.stateFingerprint || '') ||
        String(current.updatedAt || '') !== String(expected.updatedAt || '') ||
        String(current.calendarId || '') !== String(expected.calendarId || '') ||
        String(current.selectedDate || '') !== String(expected.selectedDate || '')
      ) {
        await refreshNativeAppointmentConversationAuthority({ ctx, config })
        return appointmentAuthorityConflictTerminalResult({
          ctx,
          fallback: 'esa búsqueda de horario ya cambió. dime qué fecha u hora quieres revisar'
        })
      }
      const nextStatus = decision === 'restart' ? 'restarted' : 'cancelled'
      let next
      try {
        next = await persistNativeAppointmentSelectionProgress({
          ctx,
          config,
          calendarId: current.calendarId,
          purpose: current.purpose,
          appointmentId: current.appointmentId || '',
          timezone: current.selectedTimezone,
          selectedDate: null,
          selectedTime: null,
          selectedStartTime: null,
          displayedRanges: [],
          availabilityCheckedAt: current.availabilityCheckedAt || null,
          status: nextStatus
        })
      } catch (error) {
        logger.warn(`[Agente conversacional] La selección parcial cambió mientras se cerraba: ${error.message}`)
        await refreshNativeAppointmentConversationAuthority({ ctx, config })
        return appointmentAuthorityConflictTerminalResult({
          ctx,
          fallback: 'la búsqueda cambió mientras la cerraba. dime qué fecha u hora quieres revisar'
        })
      }
      const visibleReply = decision === 'restart'
        ? 'claro, empezamos de nuevo. ¿qué día te gustaría revisar?'
        : 'claro, dejamos la búsqueda de cita aquí. si después quieres retomarla, me dices'
      const action = pushAction(ctx, 'resolve_active_appointment_selection', {
        decision,
        previousSelectedDate: current.selectedDate,
        effect: { liveEffect: 'CERRARÍA la selección parcial sin crear ni cancelar una cita', marksObjectiveCompleted: false }
      })
      settleAction(action, ctx.dryRun ? 'simulated' : 'ok', {
        actionCompleted: true,
        terminal: true,
        visibleReply,
        appointmentStatus: next.appointmentStatus
      })
      return {
        ok: true,
        ...(ctx.dryRun ? { simulated: true } : {}),
        actionCompleted: true,
        terminal: true,
        visibleReply
      }
    }
  })

  const rawResolveActiveAppointmentOfferTool = tool({
    name: 'resolve_active_appointment_offer',
    description: [
      'Adjudica semánticamente la única oferta estructurada de horario que Ristak ya dejó pendiente. Cuando está disponible debe ser la primera herramienta del turno.',
      `La MISMA IA decide: accept si la persona acepta; request_other_options si rechaza ese horario pero quiere otro; decline si ya no quiere agendar; ${canResolveOfferWithHandoff ? 'handoff si pide explícitamente hablar con una persona; ' : ''}preserve si preguntó otra cosa o si no está claro qué quiso hacer con la oferta.`,
      'preserve no modifica ni cierra la oferta y permite continuar el turno para responder libremente o usar otra herramienta.',
      'Nunca uses accept por el simple hecho de que exista una oferta. No repitas ni reconstruyas fecha u hora; el servidor recupera el slot exacto y, si hay anticipo por link, prepara el enlace en este mismo flujo.'
    ].join(' '),
    parameters: z.object({
      decision: z.enum(canResolveOfferWithHandoff
        ? ['accept', 'request_other_options', 'decline', 'handoff', 'preserve']
        : ['accept', 'request_other_options', 'decline', 'preserve']),
      nextPreferenceScope: z.preprocess(
        (value) => value ?? null,
        z.enum(['same_date', 'different_date', 'open']).nullable()
      ).describe('Sólo para request_other_options: same_date si quiere otra hora del mismo día; different_date si cambió de día; open si ya no fijó fecha'),
      reply: z.string().nullable().describe('Sólo para handoff: resumen breve del pedido de ayuda; null para las demás decisiones'),
      title: z.string().nullable().describe('Sólo para accept: título corto de la cita; null usa el título seguro'),
      notes: z.string().nullable().describe('Sólo para accept: resumen breve; null usa una nota segura'),
      attendeeName: z.string().nullable().describe('Sólo para accept: nombre si asistirá alguien distinto al contacto; null si asiste quien escribe'),
      attendeeContext: z.string().nullable().describe('Sólo para accept: relación o contexto de la persona distinta; null cuando no aplica'),
      primaryAttendee: z.preprocess(
        (value) => value ?? null,
        appointmentPersonSchema.nullable()
      ).describe('Sólo para accept: titular real distinto al contacto; null usa el contacto del hilo'),
      guests: z.preprocess(
        (value) => value ?? null,
        z.array(appointmentPersonSchema).nullable()
      ).describe('Sólo para accept: invitados confirmados; null o [] si no hay'),
      agreedAmount: z.number().positive().nullable().describe('Sólo para accept con anticipo en rango: monto acordado; null cuando el anticipo es fijo')
    }),
    execute: async ({
      decision,
      nextPreferenceScope,
      reply,
      title,
      notes,
      attendeeName,
      attendeeContext,
      primaryAttendee,
      guests,
      agreedAmount
    }) => {
      const expected = ctx.appointmentOfferDecision
      const previousAdjudication = ctx.appointmentOfferAdjudication
      const effectiveContact = decision === 'accept'
        ? await getPaymentContact(ctx).catch(() => null)
        : null
      const preflightFingerprint = decision === 'accept'
        ? createHash('sha256').update(JSON.stringify({
            offerEventId: String(expected?.offerEventId || ''),
            decision,
            arguments: {
              title: title ?? null,
              notes: notes ?? null,
              attendeeName: attendeeName ?? null,
              attendeeContext: attendeeContext ?? null,
              primaryAttendee: primaryAttendee ?? null,
              guests: Array.isArray(guests) ? guests : [],
              agreedAmount: agreedAmount ?? null
            },
            contact: effectiveContact
              ? {
                  fullName: effectiveContact.full_name || effectiveContact.fullName || null,
                  firstName: effectiveContact.first_name || null,
                  lastName: effectiveContact.last_name || null,
                  phone: effectiveContact.phone || null,
                  email: effectiveContact.email || null,
                  customFields: effectiveContact.custom_fields || null
                }
              : null
          })).digest('hex')
        : null
      const recoverableAcceptRetry = Boolean(
        previousAdjudication?.completed === true &&
        previousAdjudication?.source === 'resolver_tool' &&
        previousAdjudication?.decision === 'accept' &&
        decision === 'accept' &&
        String(previousAdjudication?.offerEventId || '') === String(expected?.offerEventId || '') &&
        previousAdjudication?.output?.ok === false &&
        previousAdjudication?.output?.actionCompleted !== true &&
        previousAdjudication?.output?.needsData === true &&
        Number(previousAdjudication?.preflightRetryCount || 0) < 3 &&
        Boolean(previousAdjudication?.preflightFingerprint) &&
        previousAdjudication.preflightFingerprint !== preflightFingerprint
      )
      if (previousAdjudication?.completed === true && !recoverableAcceptRetry) {
        return {
          ok: false,
          actionCompleted: false,
          terminal: false,
          code: 'appointment_offer_already_adjudicated',
          visibleReply: null,
          continueWith: 'La oferta ya fue adjudicada en este turno. Continúa con la respuesta o con otra herramienta sin volver a resolverla.'
        }
      }
      if (decision === 'request_other_options' && !nextPreferenceScope) {
        return {
          ok: false,
          actionCompleted: false,
          terminal: false,
          code: 'appointment_next_preference_scope_required',
          visibleReply: null,
          continueWith: 'Corrige los argumentos y vuelve a llamar resolve_active_appointment_offer en este mismo turno: usa nextPreferenceScope="same_date" si sólo cambió la hora, "different_date" si cambió el día u "open" si dejó la fecha abierta. Esta invocación no adjudicó ni modificó la oferta.'
        }
      }
      ctx.appointmentOfferAdjudication = {
        completed: true,
        source: 'resolver_tool',
        decision,
        nextPreferenceScope: decision === 'request_other_options' ? nextPreferenceScope : null,
        offerEventId: String(expected?.offerEventId || ''),
        executionId: String(ctx.executionId || ''),
        ...(decision === 'accept'
          ? {
              preflightFingerprint,
              preflightRetryCount: recoverableAcceptRetry
                ? Number(previousAdjudication?.preflightRetryCount || 0) + 1
                : 0
            }
          : {})
      }

      if (decision === 'preserve') {
        const action = pushAction(ctx, 'resolve_active_appointment_offer', {
          decision: 'preserve',
          offerEventId: String(expected?.offerEventId || '')
        })
        settleAction(action, ctx.dryRun ? 'simulated' : 'ok', {
          actionCompleted: true,
          terminal: false,
          decision: 'preserve',
          appointmentOfferPreserved: true
        })
        return {
          ok: true,
          ...(ctx.dryRun ? { simulated: true } : {}),
          actionCompleted: true,
          terminal: false,
          decision: 'preserve',
          appointmentOfferPreserved: true,
          visibleReply: null,
          continueWith: 'La oferta sigue vigente. Responde el otro tema o usa otra herramienta sin volver a adjudicarla en este turno.'
        }
      }

      const currentAuthority = await loadConversationalAppointmentOfferDecisionContext({ ctx, config })
      if (
        !expected?.active ||
        !currentAuthority?.active ||
        String(currentAuthority.offerEventId || '') !== String(expected.offerEventId || '') ||
        String(currentAuthority.offerFingerprint || '') !== String(expected.offerFingerprint || '')
      ) {
        return {
          ok: false,
          actionCompleted: false,
          terminal: true,
          code: 'appointment_offer_scope_changed',
          visibleReply: 'ese horario ya no pertenece a la configuración actual de la agenda. dime qué fecha quieres revisar y consulto opciones nuevas'
        }
      }
      const candidate = await loadNativeAppointmentOfferCandidate({ ctx, config })
      const candidateFingerprint = createHash('sha256')
        .update(String(candidate?.offer?.detail_json || ''))
        .digest('hex')
      if (
        !expected?.active ||
        !candidate?.ok ||
        String(candidate.offer?.id || '') !== String(expected.offerEventId || '') ||
        candidateFingerprint !== String(expected.offerFingerprint || '') ||
        String(candidate.offer?.detail?.status || '') !== 'active' ||
        String(candidate.offer?.detail?.calendarId || '') !== String(expected.calendarId || '') ||
        String(candidate.offer?.detail?.startTime || '') !== String(expected.startTime || '') ||
        String(candidate.offer?.detail?.localLabel || '') !== String(expected.localLabel || '')
      ) {
        return {
          ok: false,
          actionCompleted: false,
          terminal: true,
          visibleReply: 'ese horario ya cambió o dejó de estar disponible. dime qué otro día te queda mejor'
        }
      }

      if (decision === 'handoff') {
        if (!canResolveOfferWithHandoff || expected.allowHandoff !== true) {
          return {
            ok: false,
            actionCompleted: false,
            terminal: true,
            visibleReply: 'en este momento no tengo habilitada la entrega directa al equipo. puedo conservar el horario mientras lo revisas'
          }
        }
        const handoffStartedAt = new Date().toISOString()
        const resolvingDetail = {
          ...candidate.offer.detail,
          status: 'resolving_handoff',
          phase: 'resolving',
          handoffExecutionId: String(ctx.executionId || '').trim(),
          handoffStartedAt
        }
        const resolvingJson = JSON.stringify(resolvingDetail)
        let handoffClaimed = false
        await db.transaction(async () => {
          const contactId = String(ctx.contactId || '').trim()
          if (!ctx.dryRun) {
            const contactLock = await db.get(
              `SELECT id FROM contacts WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
              [contactId]
            )
            if (!contactLock?.id) return
          }
          const current = await db.get(
            'SELECT detail_json FROM conversational_agent_events WHERE id = ? AND event_type = ?',
            [candidate.offer.id, candidate.offer.event_type]
          )
          const currentFingerprint = createHash('sha256').update(String(current?.detail_json || '')).digest('hex')
          if (currentFingerprint !== String(expected.offerFingerprint || '')) return
          const updated = await db.run(
            'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND event_type = ? AND detail_json = ?',
            [resolvingJson, candidate.offer.id, candidate.offer.event_type, current.detail_json]
          )
          handoffClaimed = Number(updated?.changes ?? updated?.rowCount ?? 0) === 1
        })
        if (!handoffClaimed) {
          return {
            ok: false,
            actionCompleted: false,
            terminal: true,
            visibleReply: 'ese horario cambió mientras entregaba el chat. necesito que el equipo lo revise antes de continuar'
          }
        }

        let handoffResult
        try {
          handoffResult = await sendToHumanTool.invoke(null, JSON.stringify({
            motivo: 'La persona pidió hablar con el equipo durante la selección de horario',
            resumen: cleanAppointmentText(reply, 500) || 'Solicitud explícita de atención humana'
          }))
        } catch (error) {
          await db.run(
            'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND event_type = ? AND detail_json = ?',
            [candidate.offer.detail_json, candidate.offer.id, candidate.offer.event_type, resolvingJson]
          ).catch(() => {})
          throw error
        }
        if (handoffResult?.ok) {
          const handedOffJson = JSON.stringify({
            ...resolvingDetail,
            status: 'handed_off',
            phase: 'resolved',
            resolvedAt: new Date().toISOString(),
            resolution: 'handoff'
          })
          const finalized = await db.run(
            'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND event_type = ? AND detail_json = ?',
            [handedOffJson, candidate.offer.id, candidate.offer.event_type, resolvingJson]
          )
          if (Number(finalized?.changes ?? finalized?.rowCount ?? 0) !== 1) {
            return {
              ok: false,
              actionCompleted: true,
              terminal: true,
              visibleReply: 'el equipo ya recibió el chat, pero necesito que revisen manualmente el horario antes de continuar'
            }
          }
          ctx.appointmentOfferDecision = null
        } else {
          await db.run(
            'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND event_type = ? AND detail_json = ?',
            [candidate.offer.detail_json, candidate.offer.id, candidate.offer.event_type, resolvingJson]
          ).catch(() => {})
        }
        return {
          ...handoffResult,
          terminal: true,
          visibleReply: handoffResult?.ok
            ? 'claro, dejo este caso con el equipo para que continúe contigo'
            : (requiredDataVisibleReply(handoffResult) || 'no pude entregar el chat al equipo en este momento. necesito que lo revisen manualmente')
        }
      }

      if (decision === 'request_other_options' || decision === 'decline') {
        const resolvedAt = new Date().toISOString()
        const priorCanonical = buildCanonicalAppointmentSlotOption(
          candidate.offer.detail.startTime,
          candidate.offer.detail.timezone
        )
        let resolved = false
        try {
          await db.transaction(async () => {
            const contactId = String(ctx.contactId || '').trim()
            if (!ctx.dryRun) {
              const contactLock = await db.get(
                `SELECT id FROM contacts WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
                [contactId]
              )
              if (!contactLock?.id) return
            }
            const current = await db.get(
              `SELECT id, contact_id, agent_id, event_type, detail_json
               FROM conversational_agent_events WHERE id = ?`,
              [candidate.offer.id]
            )
            const currentDetail = parseNativeEventDetail(current?.detail_json)
            const currentFingerprint = createHash('sha256').update(String(current?.detail_json || '')).digest('hex')
            if (
              current?.event_type !== candidate.offer.event_type ||
              String(current?.contact_id || '') !== contactId ||
              String(current?.agent_id || '') !== String(config?.id || ctx.agentId || '') ||
              currentFingerprint !== String(expected.offerFingerprint || '') ||
              String(currentDetail.status || '') !== 'active'
            ) return
            const nextDetail = {
              ...currentDetail,
              status: decision === 'request_other_options' ? 'superseded' : 'declined',
              phase: 'resolved',
              resolvedAt,
              resolvedExecutionId: String(ctx.executionId || '').trim(),
              resolution: decision,
              ...(decision === 'request_other_options'
                ? {
                    rejectedStartTimes: mergeNativeRejectedAppointmentStartTimes(
                      currentDetail.rejectedStartTimes,
                      [currentDetail.startTime]
                    )
                  }
                : {})
            }
            const updated = await db.run(
              `UPDATE conversational_agent_events SET detail_json = ?
               WHERE id = ? AND event_type = ? AND detail_json = ?`,
              [JSON.stringify(nextDetail), current.id, current.event_type, current.detail_json]
            )
            resolved = Number(updated?.changes ?? updated?.rowCount ?? 0) === 1
            if (!resolved) return
            await persistNativeAppointmentSelectionProgress({
              ctx,
              config,
              calendarId: candidate.offer.detail.calendarId,
              purpose: candidate.offer.detail.purpose,
              appointmentId: candidate.offer.detail.appointmentId || '',
              timezone: candidate.offer.detail.timezone,
              selectedDate: decision === 'request_other_options' && nextPreferenceScope === 'same_date'
                ? priorCanonical?.localDate
                : null,
              selectedTime: null,
              selectedStartTime: null,
              displayedRanges: [],
              availabilityCheckedAt: null,
              status: decision === 'request_other_options' && nextPreferenceScope === 'same_date' && priorCanonical?.localDate
                ? 'collecting_time'
                : (decision === 'request_other_options' ? 'collecting_date' : 'cancelled')
            })
          })
        } catch (error) {
          ctx.appointmentSelectionProgress = null
          logger.error(`[Agente conversacional] No se pudo resolver la oferta y conservar el siguiente alcance: ${error.message}`)
          return {
            ok: false,
            actionCompleted: false,
            terminal: true,
            visibleReply: 'no pude guardar de forma segura ese cambio de horario. el horario anterior sigue pendiente; intentemos otra vez'
          }
        }
        if (!resolved) {
          return {
            ok: false,
            actionCompleted: false,
            terminal: true,
            visibleReply: 'ese horario cambió mientras lo revisaba. dime qué otro día te queda mejor'
          }
        }
        if (decision === 'request_other_options') {
          ctx.rejectedAppointmentStartTimes = mergeNativeRejectedAppointmentStartTimes(
            ctx.rejectedAppointmentStartTimes,
            [candidate.offer.detail.startTime]
          )
          ctx.nativeRejectedAppointmentStartTimesHydrated = true
          ctx.nativeRejectedAppointmentCalendarId = String(candidate.offer.detail.calendarId || '').trim()
          ctx.appointmentOfferDecision = null
          delete ctx.nativeAppointmentAvailability
          ctx.requireFreshAppointmentAvailability = true
          return {
            ok: true,
            actionCompleted: true,
            terminal: false,
            visibleReply: null,
            continueWith: nextPreferenceScope === 'same_date' && priorCanonical?.localDate
              ? `Conserva la fecha ${priorCanonical.localDate}, consulta otra vez la hora que pidió y no repitas el horario rechazado.`
              : 'Consulta disponibilidad según la nueva preferencia sin conservar la fecha anterior. Si pidió algo amplio, muestra opciones; si dio fecha y hora exactas, ofrece sólo ese slot real.'
          }
        }
        ctx.appointmentOfferDecision = null
        return {
          ok: true,
          actionCompleted: true,
          terminal: true,
          visibleReply: 'claro, sin problema. si después quieres retomarlo, aquí estoy'
        }
      }

      const configuredDeposit = expected.purpose === 'reschedule'
        ? null
        : getDepositRequirementForRuntime(ctx, config)
      if (configuredDeposit) {
        const paymentContact = await getPaymentContact(ctx)
        const requiredPaymentData = await enforceRequiredContactData({
          ctx,
          scope: 'payment',
          dataRequirements,
          contact: paymentContact,
          facts: paymentRequirementFacts(paymentCapability)
        })
        if (requiredPaymentData) {
          return {
            ...requiredPaymentData,
            terminal: true,
            visibleReply: requiredDataVisibleReply(requiredPaymentData) || 'para continuar con el anticipo me falta un dato. me ayudas a completarlo?'
          }
        }

        const accountCurrency = String(
          ctx.accountLocale?.currency || await getAccountCurrency().catch(() => '')
        ).trim().toUpperCase()
        const paymentAuthority = await resolveNativePaymentAuthority({
          capability: paymentCapability,
          quantity: 1,
          agreedAmount: agreedAmount ?? null,
          accountCurrency
        })
        if (!paymentAuthority.ok) {
          const paymentQuestion = requiredDataVisibleReply(paymentAuthority)
          return {
            ...paymentAuthority,
            terminal: true,
            visibleReply: paymentQuestion || (
              paymentAuthority.amountMismatch
                ? 'el anticipo acordado no coincide con el configurado. qué monto vas a dejar?'
                : 'no pude validar el anticipo configurado. necesito que el equipo lo revise antes de apartar el horario'
            )
          }
        }
      }

      const terminalTool = expected.terminalToolName === 'request_human_booking'
        ? requestHumanBookingTool
        : (expected.purpose === 'reschedule'
            ? rescheduleAppointmentTool
            : bookAppointmentTool)
      ctx.appointmentOfferResolutionAuthority = {
        decision: 'accept',
        offerEventId: candidate.offer.id,
        executionId: String(ctx.executionId || '').trim(),
        calendarId: candidate.offer.detail.calendarId,
        startTime: candidate.offer.detail.startTime,
        terminalToolName: expected.terminalToolName
      }
      const terminalPayload = (
        expected.terminalToolName === 'request_human_booking' ||
        expected.purpose !== 'reschedule'
      )
        ? {
            title: title ?? null,
            notes: notes ?? null,
            attendeeName: attendeeName ?? null,
            attendeeContext: attendeeContext ?? null,
            primaryAttendee: primaryAttendee ?? null,
            guests: Array.isArray(guests) ? guests : []
          }
        : { appointmentId: expected.appointmentId }
      let bookingResult
      try {
        if (nativeAppointmentBeforeResolverTerminalHookForTest) {
          await nativeAppointmentBeforeResolverTerminalHookForTest({
            offerEventId: candidate.offer.id,
            executionId: String(ctx.executionId || '').trim(),
            terminalToolName: expected.terminalToolName,
            purpose: expected.purpose
          })
        }
        bookingResult = await terminalTool.invoke(null, JSON.stringify(terminalPayload))
      } finally {
        delete ctx.appointmentOfferResolutionAuthority
      }

      if (bookingResult?.paymentEvidenceRequired === true) {
        const methods = getDepositPaymentMethodsForRuntime(ctx, config)
        if (methods.paymentLink && paymentCapability?.collectionMethod === 'payment_link') {
          const paymentResult = await createPaymentLinkTool.invoke(null, JSON.stringify({
            quantity: 1,
            agreedAmount: agreedAmount ?? null
          }))
          if (paymentResult?.ok) {
            return {
              ...paymentResult,
              actionCompleted: paymentResult.actionCompleted === true,
              terminal: true,
              visibleReply: `listo, preparé el enlace de anticipo por ${paymentResult.amount || ''} ${paymentResult.currency || ''}`.trim()
            }
          }
          return {
            ...paymentResult,
            ok: false,
            actionCompleted: false,
            terminal: true,
            visibleReply: 'el horario sí quedó elegido, pero no pude preparar el enlace de anticipo. necesito que el equipo lo revise'
          }
        }
        if (methods.bankTransfer && paymentCapability?.collectionMethod === 'bank_transfer') {
          const transferDetails = cleanAppointmentText(paymentCapability?.bankTransfer?.details, 1200)
          return {
            ok: true,
            actionCompleted: false,
            terminal: true,
            visibleReply: transferDetails
              ? `para apartar ese horario, realiza el anticipo con estos datos: ${transferDetails}. después mándame la foto o captura del comprobante`
              : 'el horario quedó elegido, pero faltan los datos de transferencia. necesito que el equipo lo revise'
          }
        }
      }

      const bookingSucceeded = bookingResult?.ok === true && (
        bookingResult?.actionCompleted === true ||
        bookingResult?.simulated === true
      )
      if (!bookingSucceeded) {
        if (bookingResult?.code === 'appointment_resolver_visible_offer_missing') {
          let superseded = false
          try {
            superseded = await supersedeUnavailableNativeAppointmentOffer({
              ctx,
              config,
              candidate,
              expected,
              restoreSameDate: true,
              rejectStartTime: false,
              reason: 'offer_visibility_unverified'
            })
          } catch (error) {
            logger.error(`[Agente conversacional] No se pudo cerrar la oferta sin evidencia visible: ${error.message}`)
          }
          await refreshNativeAppointmentConversationAuthority({ ctx, config })
          if (!superseded) {
            return appointmentAuthorityConflictTerminalResult({
              ctx,
              fallback: 'no pude comprobar qué horario alcanzaste a ver. dime la hora otra vez y la reviso sin agendar nada todavía'
            })
          }
          return {
            ...bookingResult,
            ok: false,
            actionCompleted: false,
            terminal: true,
            code: 'appointment_offer_visibility_unverified',
            visibleReply: 'no pude comprobar que la oferta anterior sí te llegó. conservé el día; dime la hora otra vez y la reviso sin agendar nada todavía'
          }
        }
        const definitiveOfferFailure = bookingResult?.invalidSlot === true ||
          bookingResult?.appointmentOfferInvalidated === true
        if (definitiveOfferFailure) {
          const supersededByNewerInbound = bookingResult?.code === 'appointment_request_superseded_by_newer_inbound'
          const terminalAuthorityLost = bookingResult?.code === 'appointment_request_authority_lost'
          const terminalPreempted = supersededByNewerInbound || terminalAuthorityLost
          const slotBecameUnavailable = bookingResult?.invalidSlot === true ||
            bookingResult?.code === 'slot_unavailable' ||
            bookingResult?.code === 'appointment_slot_unavailable'
          const restoreSameDate = slotBecameUnavailable ||
            bookingResult?.appointmentOfferRestoreSameDate === true
          let superseded = false
          try {
            superseded = await supersedeUnavailableNativeAppointmentOffer({
              ctx,
              config,
              candidate,
              expected,
              restoreSameDate,
              reason: terminalPreempted
                ? (supersededByNewerInbound
                    ? 'newer_inbound_preempted_terminal_commit'
                    : 'inbound_claim_authority_lost')
                : (restoreSameDate ? 'slot_unavailable' : 'appointment_scope_changed')
            })
          } catch (error) {
            logger.error(`[Agente conversacional] No se pudo cerrar la oferta inválida: ${error.message}`)
          }
          await refreshNativeAppointmentConversationAuthority({ ctx, config })
          if (!superseded) {
            return appointmentAuthorityConflictTerminalResult({
              ctx,
              fallback: 'ese horario cambió mientras lo revisaba. dime qué fecha u hora quieres consultar'
            })
          }
          if (slotBecameUnavailable && !terminalPreempted) {
            return {
              ...bookingResult,
              ok: false,
              actionCompleted: false,
              terminal: false,
              code: 'appointment_offer_slot_unavailable',
              visibleReply: null,
              continueWith: bookingResult?.availabilityReason === 'slot_conflict'
                ? 'Alguien más ocupó el horario ofrecido y el calendario no permite empalmes. No le pidas al cliente que vuelva a elegir a ciegas: informa brevemente que ese espacio ya no está disponible, llama ahora get_free_slots para consultar disponibilidad fresca empezando por el día conservado y los días siguientes permitidos, y termina con offer_appointment_options mostrando alternativas reales. No vuelvas a ofrecer el horario rechazado.'
                : 'El horario ofrecido dejó de estar disponible según el calendario. No le pidas al cliente que vuelva a elegir a ciegas: informa brevemente que ya no está disponible, llama ahora get_free_slots para consultar disponibilidad fresca empezando por el día conservado y los días siguientes permitidos, y termina con offer_appointment_options mostrando alternativas reales. No vuelvas a ofrecer el horario rechazado.'
            }
          }
          return {
            ...bookingResult,
            ok: false,
            actionCompleted: false,
            terminal: true,
            code: terminalPreempted
              ? bookingResult.code
              : (restoreSameDate
                  ? 'appointment_offer_slot_unavailable'
                  : 'appointment_offer_scope_changed'),
            visibleReply: terminalPreempted
              ? (supersededByNewerInbound
                  ? 'vi que mandaste una instrucción más nueva mientras cerraba la cita. no guardé el horario anterior; conservé el día y voy con tu último mensaje'
                  : 'esa confirmación perdió su turno seguro antes de guardarse. no creé la cita; conservé el día y voy a retomar el mensaje vigente')
              : (restoreSameDate
                  ? 'ese horario ya no está disponible. ya conservé el día; ¿qué otra hora te funciona?'
                  : 'esa cita o la configuración cambió desde que ofrecí el horario. no repetí ningún cambio; necesito revisar opciones nuevas')
          }
        }
        const missingDataReply = requiredDataVisibleReply(bookingResult)
        return {
          ...bookingResult,
          terminal: true,
          visibleReply: missingDataReply || 'no pude terminar la cita con ese horario. necesito que el equipo lo revise antes de volver a intentarlo'
        }
      }
      ctx.appointmentOfferDecision = null
      const humanBooking = expected.terminalToolName === 'request_human_booking'
      const confirmedLocalLabel = cleanAppointmentText(
        expected.localLabel || buildCanonicalAppointmentSlotOption(expected.startTime, expected.timezone)?.localLabel,
        240
      )
      return {
        ...bookingResult,
        terminal: true,
        visibleReply: expected.purpose === 'reschedule'
          ? (humanBooking
              ? (bookingResult.transferredToHuman === true
                  ? 'el horario nuevo seguía disponible y ya quedó preparada la entrega al equipo; la cita conserva el horario anterior hasta que una persona confirme el cambio'
                  : (bookingResult.visibleReply || 'esa cita ya tiene el horario elegido; no mandé una solicitud ni repetí ningún cambio'))
              : (ctx.dryRun ? 'listo, la prueba conservaría la misma cita con el horario nuevo' : 'listo, la cita quedó cambiada al horario nuevo'))
          : (humanBooking
              ? 'el horario seguía disponible y ya quedó preparada la entrega al equipo para que confirme la cita'
              : (confirmedLocalLabel
                  ? (ctx.dryRun
                      ? `listo, la cita de prueba quedó confirmada para ${confirmedLocalLabel}`
                      : `listo, tu cita quedó confirmada para ${confirmedLocalLabel}`)
                  : (ctx.dryRun ? 'listo, la cita de prueba quedó confirmada' : 'listo, tu cita quedó confirmada')))
      }
    }
  })

  const resolveActiveAppointmentOfferInvoke = rawResolveActiveAppointmentOfferTool.invoke
    .bind(rawResolveActiveAppointmentOfferTool)
  const resolveActiveAppointmentOfferTool = {
    ...rawResolveActiveAppointmentOfferTool,
    invoke: async (...args) => {
      // El SDK no debe ejecutar esta adjudicación en paralelo. El claim se
      // instala antes del primer await y cubre también la publicación del
      // output canónico; así una segunda llamada no puede entrar al terminal ni
      // pegar su resultado sobre la adjudicación ganadora.
      if (ctx.appointmentOfferAdjudicationInFlight) {
        return {
          ok: false,
          actionCompleted: false,
          terminal: false,
          code: 'appointment_offer_already_adjudicated',
          visibleReply: null,
          continueWith: 'La oferta ya está siendo adjudicada en este turno. Continúa con el resultado de esa llamada sin volver a resolverla.'
        }
      }
      const invocationToken = {}
      ctx.appointmentOfferAdjudicationInFlight = invocationToken
      try {
        const output = await resolveActiveAppointmentOfferInvoke(...args)
        if (
          ctx.appointmentOfferAdjudication?.source === 'resolver_tool' &&
          !Object.hasOwn(ctx.appointmentOfferAdjudication, 'output')
        ) {
          ctx.appointmentOfferAdjudication.output = output
        }
        return output
      } finally {
        if (ctx.appointmentOfferAdjudicationInFlight === invocationToken) {
          delete ctx.appointmentOfferAdjudicationInFlight
        }
      }
    }
  }

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
  if (!ctx.followUpMode && Array.isArray(dataRequirements?.fields) && dataRequirements.fields.length) {
    nativeTools.push(saveContactDataTool)
  }
  if (
    !ctx.followUpMode &&
    (
      availableCapabilityIds.has('handoff_human')
    )
  ) {
    nativeTools.push(sendToHumanTool)
  }
  if (!ctx.followUpMode && availableCapabilityIds.has('schedule_appointment')) {
    nativeTools.push(getContactAppointmentsTool)
    nativeTools.push(getFreeSlotsForAgentTool)
    nativeTools.push(offerAppointmentOptionsTool)
    nativeTools.push(offerAppointmentSlotTool)
    // Con una oferta activa, la única entrada expuesta para aceptar/rechazar
    // es resolve_active_appointment_offer. Esa herramienta conserva el juicio
    // semántico del modelo y después invoca internamente la terminal correcta;
    // exponer ambas rutas permitía que un "sí" cayera en la tool equivocada.
    if (!appointmentOfferDecisionMode && !appointmentSelectionProgressMode) {
      nativeTools.push(
        scheduleCapability?.bookingOwner === 'human'
          ? requestHumanBookingTool
          : bookAppointmentTool
      )
    }
    // En agenda humana la IA puede consultar y ofrecer un nuevo horario, pero
    // la única terminal de una reagenda es request_human_booking. Retirar la
    // mutación evita que un prompt o una llamada directa mueva la cita por fuera
    // de la elección visible del dueño.
    if (
      !appointmentOfferDecisionMode &&
      !appointmentSelectionProgressMode &&
      scheduleCapability?.bookingOwner !== 'human'
    ) {
      nativeTools.push(rescheduleAppointmentTool)
    }
    nativeTools.push(cancelAppointmentTool)
    if (appointmentSelectionProgressMode) nativeTools.push(resolveActiveAppointmentSelectionTool)
    if (appointmentOfferDecisionMode) nativeTools.push(resolveActiveAppointmentOfferTool)
  }
  if (!ctx.followUpMode && availableCapabilityIds.has('collect_payment')) {
    nativeTools.push(getPaymentStatusTool)
    // Una reanudación nace de un pago que el ledger ya confirmó. Durante esa
    // vuelta se conserva la lectura de estado, pero se retiran físicamente las
    // mutaciones de cobro para que ni el modelo ni un prompt editable puedan
    // crear otro link o registrar otro comprobante por accidente.
    if (!ctx.paymentResumeClaim) {
      if (paymentCapability?.collectionMethod === 'payment_link') {
        nativeTools.push(createPaymentLinkTool)
      }
      if (paymentCapability?.collectionMethod === 'bank_transfer') {
        nativeTools.push(registerDepositProofTool)
      }
    }
  }
  if (!ctx.followUpMode && availableCapabilityIds.has('send_link')) {
    nativeTools.push(sendTriggerLinkTool)
  }
  if (
    !ctx.followUpMode &&
    customGoalSendsVerifiedLink &&
    availableCapabilityIds.has('custom_goal')
  ) {
    nativeTools.push(sendGoalUrlTool)
  }
  if (
    !ctx.followUpMode &&
    availableCapabilityIds.has('custom_goal') &&
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
  paymentRequirementFacts,
  persistNativeAppointmentOffer,
  hasNativeAppointmentDepositCollectionScope
})
