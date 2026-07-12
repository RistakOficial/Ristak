import { db } from '../config/database.js'
import {
  createPaymentGateLink,
  getPaymentGateCheckoutKeys,
  normalizePaymentGateConfig
} from './publicPaymentGateService.js'
import {
  createSinglePaymentLink,
  getHighLevelPaymentLinkMode,
  runIdempotentConversationalPaymentLinkCreation
} from './paymentFlowService.js'
import { msiEligibility } from '../../../shared/sites/paymentGateContract.js'

const LIVE_GATEWAYS = new Set(['highlevel', 'stripe', 'conekta', 'mercadopago', 'clip', 'rebill'])
const COMPLETED_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'success', 'fulfilled'])

function serviceError(message, status = 409, code = 'conversational_live_payment_invalid') {
  const error = new Error(message)
  error.status = status
  error.statusCode = status
  error.code = code
  return error
}

function cleanString(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function normalizeCurrency(value) {
  const currency = cleanString(value, 3).toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw serviceError('La moneda autorizada para este cobro no es válida.', 409, 'live_payment_currency_invalid')
  }
  return currency
}

function currencyFractionDigits(currency) {
  try {
    const digits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency
    }).resolvedOptions().maximumFractionDigits
    return Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 2
  } catch {
    return 2
  }
}

function moneyToMinorUnits(value, currency) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * (10 ** currencyFractionDigits(currency)))
}

function normalizeAmount(value, currency) {
  const minor = moneyToMinorUnits(value, currency)
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw serviceError('El monto autorizado para este cobro no es válido.', 409, 'live_payment_amount_invalid')
  }
  const normalized = minor / (10 ** currencyFractionDigits(currency))
  if (moneyToMinorUnits(Math.fround(normalized), currency) !== minor) {
    throw serviceError(
      'El monto es demasiado grande para conservar todos sus decimales de forma segura. Usa un importe menor o pasa el cobro a revisión humana.',
      409,
      'live_payment_amount_precision_unsafe'
    )
  }
  return normalized
}

function normalizeInstallments(value = {}) {
  const enabled = value?.enabled === true
  const maxInstallments = Math.trunc(Number(value?.maxInstallments || 0))
  if (!enabled || maxInstallments <= 1) return { enabled: false, maxInstallments: 0 }
  if (![3, 6, 9, 12, 18, 24].includes(maxInstallments)) {
    throw serviceError('La configuración de meses sin intereses no es válida.', 409, 'live_payment_installments_invalid')
  }
  return { enabled: true, maxInstallments }
}

function normalizeExpirationMinutes(value) {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed) || parsed < 5 || parsed > 7 * 24 * 60) {
    throw serviceError('La vigencia configurada para el enlace no es válida.', 409, 'live_payment_expiration_invalid')
  }
  return parsed
}

function buildExpirationIso(expirationMinutes, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  if (!Number.isFinite(nowMs)) {
    throw serviceError('No se pudo calcular la vigencia segura del enlace.', 500, 'live_payment_clock_invalid')
  }
  return new Date(nowMs + expirationMinutes * 60 * 1000).toISOString()
}

async function loadExactPaymentLedger({
  contactId,
  gateway,
  idempotencyKey,
  result
} = {}) {
  const cleanContactId = cleanString(contactId, 180)
  const cleanRequestKey = cleanString(idempotencyKey, 180)
  if (gateway === 'highlevel') {
    const invoiceId = cleanString(result?.invoiceId, 180)
    if (!invoiceId) return null
    return db.get(
      `SELECT id, contact_id, amount, currency, status, payment_mode, payment_provider,
              ghl_invoice_id, public_payment_id, payment_url, payment_link_request_key,
              due_date, sent_at
       FROM payments
       WHERE contact_id = ?
         AND payment_link_request_key = ?
         AND (id = ? OR ghl_invoice_id = ?)
       LIMIT 1`,
      [cleanContactId, cleanRequestKey, invoiceId, invoiceId]
    )
  }

  const publicPaymentId = cleanString(result?.publicPaymentId || result?.payment?.publicPaymentId, 180)
  if (!publicPaymentId) return null
  return db.get(
    `SELECT id, contact_id, amount, currency, status, payment_mode, payment_provider,
            ghl_invoice_id, public_payment_id, payment_url, payment_link_request_key,
            due_date, sent_at
     FROM payments
     WHERE contact_id = ?
       AND payment_link_request_key = ?
       AND public_payment_id = ?
     LIMIT 1`,
    [cleanContactId, cleanRequestKey, publicPaymentId]
  )
}

let dependencies = {
  createPaymentGateLink,
  getPaymentGateCheckoutKeys,
  normalizePaymentGateConfig,
  createSinglePaymentLink,
  getHighLevelPaymentLinkMode,
  runIdempotentConversationalPaymentLinkCreation,
  loadExactPaymentLedger
}

function assertExactLiveLedger({
  ledger,
  result,
  contactId,
  gateway,
  amount,
  currency,
  idempotencyKey,
  expiresAt
} = {}) {
  if (!ledger?.id) {
    throw serviceError(
      'El proveedor respondió, pero no existe el registro exacto del cobro. No se entregará el enlace.',
      503,
      'live_payment_ledger_missing'
    )
  }

  const resultPaymentId = cleanString(result?.payment?.id, 180)
  const resultPublicPaymentId = cleanString(result?.publicPaymentId || result?.payment?.publicPaymentId, 180)
  const ledgerProvider = cleanString(ledger.payment_provider, 80).toLowerCase()
  const ledgerCurrency = cleanString(ledger.currency, 3).toUpperCase()
  const ledgerMode = cleanString(ledger.payment_mode, 40).toLowerCase()
  const expectedMinor = moneyToMinorUnits(amount, currency)
  const ledgerMinor = moneyToMinorUnits(ledger.amount, ledgerCurrency)
  const expirationMatches = gateway === 'highlevel'
    ? Boolean(cleanString(ledger.due_date, 80)) && Number.isFinite(Date.parse(ledger.due_date))
    : Number.isFinite(Date.parse(ledger.due_date)) && Date.parse(ledger.due_date) === Date.parse(expiresAt)
  const exact = Boolean(
    cleanString(ledger.contact_id, 180) === cleanString(contactId, 180) &&
    cleanString(ledger.payment_link_request_key, 180) === cleanString(idempotencyKey, 180) &&
    ledgerProvider === gateway &&
    ledgerCurrency === currency &&
    Number.isSafeInteger(expectedMinor) &&
    ledgerMinor === expectedMinor &&
    ledgerMode === 'live' &&
    cleanString(ledger.payment_url, 2000) &&
    expirationMatches &&
    (!resultPaymentId || resultPaymentId === cleanString(ledger.id, 180)) &&
    (gateway === 'highlevel'
      ? cleanString(result?.invoiceId, 180) === cleanString(ledger.ghl_invoice_id || ledger.id, 180)
      : resultPublicPaymentId && resultPublicPaymentId === cleanString(ledger.public_payment_id, 180))
  )

  if (!exact) {
    throw serviceError(
      'El registro creado no coincide exactamente con la pasarela, monto, moneda o modo en vivo autorizados. No se entregará el enlace.',
      503,
      'live_payment_ledger_mismatch'
    )
  }

  return {
    ledgerPaymentId: cleanString(ledger.id, 180),
    invoiceId: gateway === 'highlevel'
      ? cleanString(ledger.ghl_invoice_id || ledger.id, 180)
      : cleanString(ledger.public_payment_id, 180),
    publicPaymentId: cleanString(ledger.public_payment_id, 180) || null,
    paymentLink: cleanString(ledger.payment_url, 2000),
    amount: Number(ledger.amount),
    currency: ledgerCurrency,
    status: cleanString(ledger.status, 40).toLowerCase() || 'sent',
    provider: ledgerProvider,
    paymentMode: ledgerMode,
    expiresAt: gateway === 'highlevel' ? cleanString(ledger.due_date, 80) || expiresAt : expiresAt,
    sendMethod: gateway === 'highlevel'
      ? (cleanString(result?.sendMethod, 40) || 'none')
      : 'chat_reply',
    paymentConfirmed: COMPLETED_PAYMENT_STATUSES.has(cleanString(ledger.status, 40).toLowerCase())
  }
}

async function assertGatewayReadyForLive(gateway) {
  if (gateway === 'highlevel') {
    const mode = cleanString(await dependencies.getHighLevelPaymentLinkMode(), 40).toLowerCase()
    if (mode !== 'live') {
      throw serviceError(
        'HighLevel está en modo prueba. El agente en vivo no puede crear ni entregar ese cobro.',
        409,
        'live_payment_gateway_not_live'
      )
    }
    return
  }

  const config = await dependencies.getPaymentGateCheckoutKeys(gateway)
  if (cleanString(config?.provider, 80).toLowerCase() !== gateway) {
    throw serviceError('La pasarela respondió con otra identidad. No se creó ningún cobro.', 503, 'live_payment_gateway_identity_mismatch')
  }
  if (!config?.configured) {
    throw serviceError('La pasarela elegida no está conectada. No se creó ningún cobro.', 409, 'live_payment_gateway_not_configured')
  }
  if (cleanString(config?.paymentMode, 40).toLowerCase() !== 'live') {
    throw serviceError(
      'La pasarela elegida está en modo prueba. El agente en vivo no puede crear ni entregar ese cobro.',
      409,
      'live_payment_gateway_not_live'
    )
  }
}

export async function createConversationalAgentLivePaymentLink({
  contact = {},
  gateway,
  amount,
  currency,
  concept = 'Pago',
  installments = {},
  expirationMinutes = 60,
  afterPayment = 'continue',
  idempotencyKey,
  idempotencyPayload = {},
  source = 'conversational_agent_v2',
  channels = {},
  now = Date.now()
} = {}) {
  const selectedGateway = cleanString(gateway, 80).toLowerCase()
  if (!LIVE_GATEWAYS.has(selectedGateway)) {
    throw serviceError('La pasarela seleccionada no es compatible con el cobro del agente.', 409, 'live_payment_gateway_invalid')
  }
  const contactId = cleanString(contact?.id, 180)
  if (!contactId) {
    throw serviceError('No existe el contacto interno del chat para crear el cobro.', 409, 'live_payment_contact_missing')
  }
  const normalizedCurrency = normalizeCurrency(currency)
  const normalizedAmount = normalizeAmount(amount, normalizedCurrency)
  const normalizedInstallments = normalizeInstallments(installments)
  const normalizedExpirationMinutes = normalizeExpirationMinutes(expirationMinutes)
  // HighLevel necesita la fecha antes de entrar a su flujo propio. Para las
  // demás pasarelas, sólo el ganador de la reserva idempotente la calcula; los
  // reintentos recuperan el vencimiento canónico ya guardado en el resultado.
  const expiresAt = selectedGateway === 'highlevel'
    ? buildExpirationIso(normalizedExpirationMinutes, now)
    : null
  const requestKey = cleanString(idempotencyKey, 180)
  if (!requestKey) {
    throw serviceError('Falta la llave durable de este cobro.', 400, 'live_payment_idempotency_missing')
  }

  if (selectedGateway === 'highlevel' && normalizedInstallments.enabled) {
    throw serviceError(
      'HighLevel no permite fijar un máximo real de meses sin intereses en su API de invoices. Elige otra pasarela o desactiva MSI antes de cobrar.',
      409,
      'live_payment_highlevel_msi_unsupported'
    )
  }
  if (selectedGateway === 'highlevel' && normalizedExpirationMinutes < 24 * 60) {
    throw serviceError(
      'HighLevel maneja el vencimiento por fecha. Configura al menos 24 horas antes de crear la invoice.',
      409,
      'live_payment_highlevel_expiration_unsupported'
    )
  }
  if (selectedGateway !== 'highlevel' && normalizedInstallments.enabled) {
    const eligibility = msiEligibility({
      gateway: selectedGateway,
      currency: normalizedCurrency,
      amount: normalizedAmount,
      msi: normalizedInstallments
    })
    const supported = Boolean(
      eligibility.insideElement ||
      eligibility.insideBrick ||
      eligibility.hostedRedirect ||
      eligibility.standaloneMonths?.length
    ) && (
      selectedGateway !== 'conekta' ||
      eligibility.standaloneMonths?.includes(normalizedInstallments.maxInstallments)
    )
    if (!supported) {
      throw serviceError(
        'La pasarela, moneda o monto elegidos no permiten los meses configurados. No se creará un link sin MSI en silencio.',
        409,
        'live_payment_msi_not_eligible'
      )
    }
  }

  await assertGatewayReadyForLive(selectedGateway)

  const durablePayload = {
    ...idempotencyPayload,
    contactId,
    gateway: selectedGateway,
    amount: normalizedAmount,
    currency: normalizedCurrency,
    concept: cleanString(concept, 300) || 'Pago',
    installments: normalizedInstallments,
    expirationMinutes: normalizedExpirationMinutes,
    afterPayment: afterPayment === 'handoff' ? 'handoff' : 'continue'
  }

  let result
  if (selectedGateway === 'highlevel') {
    result = await dependencies.createSinglePaymentLink({
      contact,
      amount: normalizedAmount,
      currency: normalizedCurrency,
      description: durablePayload.concept,
      concept: durablePayload.concept,
      title: durablePayload.concept,
      dueDate: expiresAt,
      channels,
      source,
      idempotencyKey: requestKey,
      idempotencyPayload: durablePayload
    })
  } else {
    result = await dependencies.runIdempotentConversationalPaymentLinkCreation({
      idempotencyKey: requestKey,
      payload: durablePayload,
      create: async () => {
        const canonicalExpiresAt = buildExpirationIso(normalizedExpirationMinutes, now)
        const gateConfig = dependencies.normalizePaymentGateConfig({
          enabled: true,
          gateway: selectedGateway,
          billingType: 'single',
          amount: normalizedAmount,
          currency: normalizedCurrency,
          productName: durablePayload.concept,
          description: durablePayload.concept,
          mode: 'inherit',
          msi: normalizedInstallments
        })
        if (gateConfig.gateway !== selectedGateway || gateConfig.billingType !== 'single') {
          throw serviceError('La pasarela normalizada no coincide con la autorizada.', 503, 'live_payment_gateway_normalization_mismatch')
        }
        const created = await dependencies.createPaymentGateLink(gateConfig, {
          contact: {
            id: contactId,
            contactId,
            name: cleanString(contact.name || contact.full_name, 180),
            contactName: cleanString(contact.name || contact.full_name, 180),
            email: cleanString(contact.email, 180),
            phone: cleanString(contact.phone, 80)
          },
          source,
          applyTax: false,
          paymentLinkRequestKey: requestKey,
          expiresAt: canonicalExpiresAt,
          metadata: {
            paymentMode: 'live',
            conversationalAgent: {
              idempotencyKey: requestKey,
              afterPayment: durablePayload.afterPayment,
              expiresAt: canonicalExpiresAt
            }
          }
        })
        const publicPaymentId = cleanString(created?.publicPaymentId || created?.payment?.publicPaymentId, 180)
        return {
          ...created,
          invoiceId: publicPaymentId,
          ledgerPaymentId: cleanString(created?.payment?.id, 180) || null,
          provider: selectedGateway,
          paymentMode: cleanString(created?.payment?.paymentMode, 40).toLowerCase(),
          amount: Number(created?.payment?.amount),
          currency: cleanString(created?.payment?.currency, 3).toUpperCase(),
          expiresAt: canonicalExpiresAt
        }
      }
    })
  }

  const ledger = await dependencies.loadExactPaymentLedger({
    contactId,
    gateway: selectedGateway,
    idempotencyKey: requestKey,
    result
  })
  const replayExpiresAt = Number.isFinite(Date.parse(result?.expiresAt || ''))
    ? result.expiresAt
    : expiresAt
  return {
    ...assertExactLiveLedger({
      ledger,
      result,
      contactId,
      gateway: selectedGateway,
      amount: normalizedAmount,
      currency: normalizedCurrency,
      idempotencyKey: requestKey,
      expiresAt: replayExpiresAt
    }),
    reused: result?.reused === true,
    durableReplay: result?.durableReplay === true,
    expirationMinutes: normalizedExpirationMinutes,
    installments: normalizedInstallments,
    afterPayment: durablePayload.afterPayment
  }
}

export function setConversationalAgentLivePaymentDependenciesForTests(overrides = null) {
  dependencies = overrides
    ? { ...dependencies, ...overrides }
    : {
        createPaymentGateLink,
        getPaymentGateCheckoutKeys,
        normalizePaymentGateConfig,
        createSinglePaymentLink,
        getHighLevelPaymentLinkMode,
        runIdempotentConversationalPaymentLinkCreation,
        loadExactPaymentLedger
      }
}

export const __conversationalAgentLivePaymentTestHooks = Object.freeze({
  assertExactLiveLedger,
  buildExpirationIso
})
