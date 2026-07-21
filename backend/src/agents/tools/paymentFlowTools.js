import { tool } from '@openai/agents'
import { z } from 'zod'
import { db, getAppConfig, getHighLevelConfig } from '../../config/database.js'
import { listLocalProducts } from '../../services/localProductService.js'
import {
  createSinglePaymentLink,
  createInstallmentPaymentFlow,
  updateScheduledInstallmentPayment,
  cancelScheduledInstallmentPayment
} from '../../services/paymentFlowService.js'
import {
  createStripePaymentLink,
  createStripePaymentPlan,
  createStripeSavedCardPayment,
  getStripePaymentConfig,
  getStripeSavedPaymentMethods
} from '../../services/stripePaymentService.js'
import {
  createMercadoPagoPaymentLink,
  getMercadoPagoPaymentConfig
} from '../../services/mercadoPagoPaymentService.js'
import {
  createClipPaymentLink,
  getClipPaymentConfig
} from '../../services/clipPaymentService.js'
import {
  createRebillPaymentLink,
  createRebillPaymentPlan,
  getRebillPaymentConfig
} from '../../services/rebillPaymentService.js'
import {
  createConektaPaymentLink,
  createConektaPaymentPlan,
  createConektaSavedCardPayment,
  getConektaPaymentConfig,
  getConektaSavedPaymentSources
} from '../../services/conektaPaymentService.js'
import {
  createSubscription,
  listSubscriptions
} from '../../services/subscriptionsService.js'
import { hasFeature } from '../../services/licenseService.js'

/**
 * Herramientas avanzadas de cobro para el agente. Detectan las pasarelas
 * conectadas y sólo ejecutan escrituras cuando el usuario ya confirmó.
 */

const PAYMENT_GATEWAY_CAPABILITIES = {
  paymentLinks: 'links de pago',
  installmentPlans: 'planes de pago',
  subscriptions: 'suscripciones',
  savedCardCharges: 'cobros con tarjeta guardada'
}

const PAYMENT_GATEWAY_LABELS = {
  highlevel: 'GoHighLevel',
  stripe: 'Stripe',
  conekta: 'Conekta',
  mercadopago: 'Mercado Pago',
  clip: 'CLIP',
  rebill: 'Rebill'
}

async function unavailablePaymentFeature(featureKey) {
  if (await hasFeature(featureKey)) return null
  return {
    ok: false,
    code: 'feature_not_available',
    error: 'Los cobros por pasarela están disponibles en el plan Profesional.'
  }
}

const GATEWAY_PARAM = z.enum(['auto', 'highlevel', 'stripe', 'conekta', 'mercadopago', 'clip', 'rebill'])
  .nullable()
  .describe('Pasarela a usar: auto, highlevel, stripe, conekta, mercadopago, clip o rebill. Si hay varias conectadas, pregunta al usuario cuál prefiere antes de crear el cobro.')

const CHANNEL_PARAM = z.enum(['email', 'whatsapp', 'sms', 'all'])
  .describe('Canal por el que se envía el link cuando la pasarela requiere envío.')

const OPTIONAL_CHANNEL_PARAM = CHANNEL_PARAM
  .nullable()
  .describe('Canal de envío si la pasarela requiere entrega directa: email, whatsapp, sms o all. Para pasarelas que devuelven enlace público puede ser null.')

const FIRST_PAYMENT_METHOD_PARAM = z.enum([
  'cash',
  'bank_transfer',
  'transfer',
  'deposit',
  'card',
  'saved_card',
  'manual',
  'offline',
  'check',
  'other'
])
  .describe('Método del primer pago: card/saved_card para tarjeta, cash/transfer/deposit/bank_transfer/manual/offline/check/other para pagos manuales.')

const PAYMENT_FREQUENCY_PARAM = z.enum(['custom', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly'])
  .nullable()
  .describe('Cadencia semántica del pago. Usa custom cuando las fechas son irregulares, con meses saltados o montos distintos.')

async function getPaymentContact(contactId) {
  const row = await db.get('SELECT id, full_name, email, phone FROM contacts WHERE id = ?', [contactId])
  if (!row) return null
  return { id: row.id, name: row.full_name, email: row.email, phone: row.phone }
}

function buildChannels(channel) {
  const normalized = String(channel || '').toLowerCase()
  return {
    email: normalized === 'email' || normalized === 'all',
    whatsapp: normalized === 'whatsapp' || normalized === 'all',
    sms: normalized === 'sms' || normalized === 'all'
  }
}

function cleanString(value) {
  return String(value || '').trim()
}

function normalizeGatewayId(value) {
  const normalized = cleanString(value).toLowerCase().replace(/[\s_-]+/g, '')
  if (!normalized || normalized === 'auto') return 'auto'
  if (['ghl', 'gohighlevel', 'highlevel'].includes(normalized)) return 'highlevel'
  if (normalized === 'stripe') return 'stripe'
  if (normalized === 'conekta') return 'conekta'
  if (['mercadopago', 'mp', 'checkoutpro'].includes(normalized)) return 'mercadopago'
  if (normalized === 'clip') return 'clip'
  if (normalized === 'rebill') return 'rebill'
  return ''
}

function normalizeBaseUrl(value) {
  const clean = cleanString(value).replace(/\/+$/, '')
  if (!clean) return ''

  const withProtocol = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
  try {
    const parsed = new URL(withProtocol)
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

async function getPaymentBaseUrl() {
  const envUrl = normalizeBaseUrl(
    process.env.PUBLIC_APP_URL ||
    process.env.APP_PUBLIC_URL ||
    process.env.FRONTEND_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.APP_URL
  )
  if (envUrl) return envUrl

  const appDomain = normalizeBaseUrl(await getAppConfig('sites_app_domain'))
  const verified = ['1', 'true', 'yes'].includes(cleanString(await getAppConfig('sites_app_domain_verified')).toLowerCase())
  return verified ? appDomain : ''
}

function mapGatewayStatus({ id, connected, mode = null, accountLabel = '', issue = '' }) {
  const capabilities = {
    paymentLinks: id === 'highlevel' || id === 'stripe' || id === 'conekta' || id === 'mercadopago' || id === 'clip' || id === 'rebill',
    installmentPlans: id === 'highlevel' || id === 'stripe' || id === 'conekta' || id === 'rebill',
    subscriptions: id === 'stripe' || id === 'conekta' || id === 'mercadopago' || id === 'clip',
    savedCardCharges: id === 'stripe' || id === 'conekta'
  }

  return {
    id,
    label: PAYMENT_GATEWAY_LABELS[id] || id,
    connected: Boolean(connected),
    mode,
    accountLabel: accountLabel || '',
    capabilities,
    issue: issue || ''
  }
}

async function getPaymentGatewaySnapshot() {
  const [highLevelResult, stripeResult, conektaResult, mercadoPagoResult, clipResult, rebillResult] = await Promise.allSettled([
    getHighLevelConfig(),
    getStripePaymentConfig(),
    getConektaPaymentConfig(),
    getMercadoPagoPaymentConfig(),
    getClipPaymentConfig(),
    getRebillPaymentConfig()
  ])

  const highLevelConfig = highLevelResult.status === 'fulfilled' ? highLevelResult.value : null
  const stripeConfig = stripeResult.status === 'fulfilled' ? stripeResult.value : null
  const conektaConfig = conektaResult.status === 'fulfilled' ? conektaResult.value : null
  const mercadoPagoConfig = mercadoPagoResult.status === 'fulfilled' ? mercadoPagoResult.value : null
  const clipConfig = clipResult.status === 'fulfilled' ? clipResult.value : null
  const rebillConfig = rebillResult.status === 'fulfilled' ? rebillResult.value : null

  const gateways = [
    mapGatewayStatus({
      id: 'highlevel',
      connected: Boolean(highLevelConfig?.api_token && highLevelConfig?.location_id),
      mode: highLevelConfig?.ghl_invoice_mode || null,
      accountLabel: highLevelConfig?.location_id ? `Location ${highLevelConfig.location_id}` : '',
      issue: highLevelResult.status === 'rejected' ? highLevelResult.reason?.message : ''
    }),
    mapGatewayStatus({
      id: 'stripe',
      connected: Boolean(stripeConfig?.configured),
      mode: stripeConfig?.mode || null,
      accountLabel: stripeConfig?.accountLabel || '',
      issue: stripeResult.status === 'rejected' ? stripeResult.reason?.message : ''
    }),
    mapGatewayStatus({
      id: 'conekta',
      connected: Boolean(conektaConfig?.configured),
      mode: conektaConfig?.mode || null,
      accountLabel: conektaConfig?.accountLabel || '',
      issue: conektaResult.status === 'rejected' ? conektaResult.reason?.message : ''
    }),
    mapGatewayStatus({
      id: 'mercadopago',
      connected: Boolean(mercadoPagoConfig?.configured),
      mode: mercadoPagoConfig?.mode || null,
      accountLabel: mercadoPagoConfig?.accountLabel || mercadoPagoConfig?.userId || '',
      issue: mercadoPagoResult.status === 'rejected' ? mercadoPagoResult.reason?.message : ''
    }),
    mapGatewayStatus({
      id: 'clip',
      connected: Boolean(clipConfig?.configured),
      mode: clipConfig?.mode || null,
      accountLabel: clipConfig?.accountLabel || '',
      issue: clipResult.status === 'rejected' ? clipResult.reason?.message : ''
    }),
    mapGatewayStatus({
      id: 'rebill',
      connected: Boolean(rebillConfig?.configured),
      mode: rebillConfig?.mode || null,
      accountLabel: rebillConfig?.accountLabel || '',
      issue: rebillResult.status === 'rejected' ? rebillResult.reason?.message : ''
    })
  ]

  return {
    ok: true,
    gateways,
    connectedGateways: gateways.filter((gateway) => gateway.connected),
    byId: Object.fromEntries(gateways.map((gateway) => [gateway.id, gateway]))
  }
}

async function selectPaymentGateway(requestedGateway, capability) {
  const snapshot = await getPaymentGatewaySnapshot()
  const requested = normalizeGatewayId(requestedGateway)
  const capabilityLabel = PAYMENT_GATEWAY_CAPABILITIES[capability] || 'esta acción'

  if (requested && requested !== 'auto') {
    const gateway = snapshot.byId[requested]
    if (!gateway) {
      return { ok: false, error: 'Pasarela no reconocida. Usa Stripe, Conekta, Mercado Pago, CLIP, Rebill o GoHighLevel.', snapshot }
    }
    if (!gateway.capabilities[capability]) {
      return { ok: false, error: `${gateway.label} no soporta ${capabilityLabel} en Ristak todavía.`, snapshot }
    }
    if (!gateway.connected) {
      return { ok: false, error: `${gateway.label} no está conectada. Conéctala en Configuración > Pagos antes de usarla.`, snapshot }
    }
    return { ok: true, gateway, snapshot }
  }

  const eligible = snapshot.gateways.filter((gateway) => gateway.connected && gateway.capabilities[capability])
  if (eligible.length === 1) {
    return { ok: true, gateway: eligible[0], snapshot }
  }

  if (!eligible.length) {
    return {
      ok: false,
      error: `No hay pasarelas conectadas para ${capabilityLabel}. Conecta ${
        capability === 'installmentPlans'
          ? 'Stripe, Conekta, Rebill o GoHighLevel opcional'
          : capability === 'subscriptions'
            ? 'Stripe, Conekta, Mercado Pago o CLIP'
            : capability === 'savedCardCharges'
              ? 'Stripe o Conekta'
              : 'Stripe, Conekta, Mercado Pago, CLIP, Rebill o GoHighLevel opcional'
      } en Configuración > Pagos.`,
      snapshot
    }
  }

  return {
    ok: false,
    needsGatewaySelection: true,
    error: `Hay varias pasarelas conectadas para ${capabilityLabel}: ${eligible.map((gateway) => gateway.label).join(', ')}. Pregunta cuál quiere usar antes de ejecutar.`,
    options: eligible.map((gateway) => ({ id: gateway.id, label: gateway.label })),
    snapshot
  }
}

function buildGatewayPaymentPayload({ contact, amount, currency, concept, dueDate }) {
  return {
    contactId: contact.id,
    contactName: contact.name,
    email: contact.email || '',
    phone: contact.phone || '',
    amount,
    currency: currency || undefined,
    title: concept,
    description: concept,
    dueDate: dueDate || undefined,
    source: 'ai_agent'
  }
}

function normalizePositiveNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.round(number * 100) / 100
}

function normalizePercentage(value) {
  const percentage = Number(value)
  if (!Number.isFinite(percentage) || percentage <= 0) return null
  return Math.round(percentage * 100) / 100
}

function amountFromAmountOrPercentage({ amount, percentage, totalAmount }) {
  const explicitAmount = normalizePositiveNumber(amount)
  if (explicitAmount !== null) return explicitAmount

  const explicitPercentage = normalizePercentage(percentage)
  if (explicitPercentage === null) return null

  return Math.round((Number(totalAmount || 0) * explicitPercentage / 100) * 100) / 100
}

function normalizeFirstPaymentForPlan(firstPayment, totalAmount) {
  if (!firstPayment) return { enabled: false }

  const percentage = normalizePercentage(firstPayment.percentage)
  const amount = amountFromAmountOrPercentage({
    amount: firstPayment.amount,
    percentage,
    totalAmount
  })

  if (amount === null) return { enabled: false }

  return {
    enabled: true,
    amount,
    percentage,
    type: percentage !== null && (firstPayment.amount === null || firstPayment.amount === undefined) ? 'percentage' : (firstPayment.type || 'amount'),
    value: percentage !== null && (firstPayment.amount === null || firstPayment.amount === undefined) ? percentage : amount,
    date: firstPayment.date || undefined,
    method: firstPayment.method
  }
}

function normalizeRemainingPaymentForPlan(payment, index, totalAmount, remainingFrequency) {
  const percentage = normalizePercentage(payment.percentage)
  const amount = amountFromAmountOrPercentage({
    amount: payment.amount,
    percentage,
    totalAmount
  })

  if (amount === null) {
    throw new Error(`La parcialidad ${index + 1} necesita monto o porcentaje válido.`)
  }

  return {
    sequence: Number(payment.sequence || index + 1),
    amount,
    percentage,
    dueDate: payment.dueDate,
    frequency: payment.frequency || remainingFrequency || 'custom',
    ...(payment.paymentMethod ? { paymentMethod: payment.paymentMethod } : {}),
    ...(payment.notes ? { notes: payment.notes } : {})
  }
}

export function buildInstallmentPayload({ contact, totalAmount, currency, concept, firstPayment, remainingPayments, remainingFrequency = 'custom', paymentMethodId = null }) {
  const normalizedFirstPayment = normalizeFirstPaymentForPlan(firstPayment, totalAmount)

  return {
    contact,
    totalAmount,
    currency: currency || undefined,
    title: concept,
    description: concept,
    concept,
    firstPayment: normalizedFirstPayment,
    remainingPayments: remainingPayments.map((payment, index) => normalizeRemainingPaymentForPlan(payment, index, totalAmount, remainingFrequency)),
    remainingFrequency,
    paymentMethodId: paymentMethodId || undefined,
    source: 'ai_agent'
  }
}

export const listProductsTool = tool({
  name: 'list_products',
  description: 'Lista los productos del catálogo con sus precios (id, monto, moneda). Úsala para cobrar el precio correcto de un producto.',
  parameters: z.object({
    query: z.string().nullable().describe('Texto para filtrar por nombre o descripción'),
    limit: z.number().int().min(1).max(50).nullable().describe('Máximo de productos (default 20)')
  }),
  execute: async ({ query, limit }) => {
    const result = await listLocalProducts({ query: query || '', limit: limit || 20, includePrices: true })
    const products = (result?.products || result || []).map?.((product) => ({
      id: product.id,
      name: product.name,
      description: product.description || null,
      prices: (product.prices || []).map((price) => ({
        id: price.id,
        amount: Number(price.amount),
        currency: price.currency,
        name: price.name || null
      }))
    })) || []
    return { ok: true, total: products.length, products }
  }
})

export const getPaymentGatewaysTool = tool({
  name: 'get_payment_gateways',
  description: 'Detecta qué pasarelas de pago están conectadas en Ristak (Stripe, Conekta, Mercado Pago, CLIP, Rebill y GoHighLevel opcional) y qué puede hacer cada una: links, planes, suscripciones o cobros con tarjeta guardada. Úsala antes de crear cobros si el usuario no dijo pasarela.',
  parameters: z.object({}),
  execute: async () => {
    const unavailable = await unavailablePaymentFeature('payment_gateways')
    if (unavailable) return unavailable
    const snapshot = await getPaymentGatewaySnapshot()
    return {
      ok: true,
      gateways: snapshot.gateways,
      connectedGateways: snapshot.connectedGateways.map((gateway) => ({
        id: gateway.id,
        label: gateway.label,
        mode: gateway.mode,
        accountLabel: gateway.accountLabel,
        capabilities: gateway.capabilities
      }))
    }
  }
})

export const createPaymentLinkTool = tool({
  name: 'create_payment_link',
  description: 'Crea un link de pago único con la pasarela conectada correcta de Ristak (Stripe, Conekta, Mercado Pago, CLIP, Rebill o GoHighLevel opcional). Antes de llamarla: 1) identifica el contacto real, 2) si hay varias pasarelas conectadas pregunta cuál usar, 3) confirma monto, concepto y canal si aplica, 4) pasa confirm=true solo cuando el usuario ya aprobó el cobro.',
  parameters: z.object({
    contactId: z.string().describe('ID del contacto a cobrar (usa search_contacts)'),
    amount: z.number().positive().describe('Monto del cobro'),
    currency: z.string().nullable().describe('Moneda ISO (default: moneda de la cuenta)'),
    concept: z.string().describe('Concepto del cobro, ej. "Mensualidad junio"'),
    dueDate: z.string().nullable().describe('Fecha límite de pago YYYY-MM-DD (opcional)'),
    gateway: GATEWAY_PARAM,
    channel: OPTIONAL_CHANNEL_PARAM,
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente el cobro')
  }),
  execute: async ({ contactId, amount, currency, concept, dueDate, gateway, channel, confirm }) => {
    const unavailable = await unavailablePaymentFeature('payment_links')
    if (unavailable) return unavailable
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario. Resume el cobro (contacto, monto, concepto, pasarela y canal si aplica) y pide aprobación antes de crear el link.' }
    }
    const contact = await getPaymentContact(contactId)
    if (!contact) return { ok: false, error: 'Contacto no encontrado' }

    try {
      const selected = await selectPaymentGateway(gateway, 'paymentLinks')
      if (!selected.ok) return selected

      const paymentPayload = buildGatewayPaymentPayload({ contact, amount, currency, concept, dueDate })

      if (selected.gateway.id === 'stripe') {
        const result = await createStripePaymentLink(paymentPayload, { baseUrl: await getPaymentBaseUrl() })
        return {
          ok: true,
          gateway: selected.gateway.id,
          gatewayLabel: selected.gateway.label,
          paymentId: result.payment?.id || null,
          publicPaymentId: result.publicPaymentId || null,
          paymentLink: result.paymentUrl || result.payment?.paymentUrl || '',
          amount: result.payment?.amount || amount,
          currency: result.payment?.currency || currency || null,
          status: result.payment?.status || 'sent'
        }
      }

      if (selected.gateway.id === 'mercadopago') {
        const result = await createMercadoPagoPaymentLink(paymentPayload, { baseUrl: await getPaymentBaseUrl() })
        return {
          ok: true,
          gateway: selected.gateway.id,
          gatewayLabel: selected.gateway.label,
          paymentId: result.payment?.id || null,
          publicPaymentId: result.publicPaymentId || null,
          preferenceId: result.preferenceId || null,
          paymentLink: result.paymentUrl || result.payment?.paymentUrl || '',
          amount: result.payment?.amount || amount,
          currency: result.payment?.currency || currency || null,
          status: result.payment?.status || 'sent'
        }
      }

      if (selected.gateway.id === 'conekta') {
        const result = await createConektaPaymentLink(paymentPayload, { baseUrl: await getPaymentBaseUrl() })
        return {
          ok: true,
          gateway: selected.gateway.id,
          gatewayLabel: selected.gateway.label,
          paymentId: result.payment?.id || null,
          publicPaymentId: result.publicPaymentId || null,
          paymentLink: result.paymentUrl || result.payment?.paymentUrl || '',
          amount: result.payment?.amount || amount,
          currency: result.payment?.currency || currency || null,
          status: result.payment?.status || 'sent'
        }
      }

      if (selected.gateway.id === 'clip') {
        const result = await createClipPaymentLink(paymentPayload, { baseUrl: await getPaymentBaseUrl() })
        return {
          ok: true,
          gateway: selected.gateway.id,
          gatewayLabel: selected.gateway.label,
          paymentId: result.payment?.id || null,
          publicPaymentId: result.publicPaymentId || null,
          paymentLink: result.paymentUrl || result.payment?.paymentUrl || '',
          amount: result.payment?.amount || amount,
          currency: result.payment?.currency || currency || null,
          status: result.payment?.status || 'sent'
        }
      }

      if (selected.gateway.id === 'rebill') {
        const result = await createRebillPaymentLink(paymentPayload, { baseUrl: await getPaymentBaseUrl() })
        return {
          ok: true,
          gateway: selected.gateway.id,
          gatewayLabel: selected.gateway.label,
          paymentId: result.payment?.id || null,
          publicPaymentId: result.publicPaymentId || null,
          paymentLink: result.paymentUrl || result.payment?.paymentUrl || '',
          amount: result.payment?.amount || amount,
          currency: result.payment?.currency || currency || null,
          status: result.payment?.status || 'sent'
        }
      }

      if (!channel) {
        return { ok: false, error: 'Para enviar el link falta elegir canal: email, WhatsApp, SMS o todos.' }
      }
      const result = await createSinglePaymentLink({
        contact,
        amount,
        currency: currency || undefined,
        description: concept,
        concept,
        title: concept,
        dueDate: dueDate || undefined,
        channels: buildChannels(channel),
        source: 'ai_agent'
      })
      return {
        ok: true,
        gateway: selected.gateway.id,
        gatewayLabel: selected.gateway.label,
        invoiceId: result.invoiceId,
        paymentLink: result.paymentLink,
        sendMethod: result.sendMethod,
        amount: result.amount,
        currency: result.currency,
        status: result.status
      }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const createInstallmentPlanTool = tool({
  name: 'create_installment_plan',
  description: 'Crea un plan de pagos por parcialidades con las pasarelas conectadas compatibles de Ristak: Stripe, Conekta, Rebill o GoHighLevel opcional. En Rebill, Ristak mantiene el calendario; si ya hay tarjeta guardada cobra cada parcialidad con cardId y si falta tarjeta manda primer link o domiciliacion para autorizarla. Rebill no maneja el reloj del plan. Mercado Pago no soporta planes de pago en Ristak; úsalo sólo para links o suscripciones. La suma del primer pago y los restantes debe ser igual al total. Si hay varias pasarelas conectadas pregunta cuál usar. Confirma el plan completo y pasa confirm=true solo cuando ya aprobó.',
  parameters: z.object({
    contactId: z.string().describe('ID del contacto'),
    totalAmount: z.number().positive().describe('Total a cobrar (debe coincidir con la suma de los pagos)'),
    currency: z.string().nullable().describe('Moneda ISO (default: moneda de la cuenta)'),
    concept: z.string().describe('Concepto del plan, ej. "Programa de 3 meses"'),
    firstPayment: z.object({
      amount: z.number().positive().nullable().optional().describe('Monto del primer pago. Puede ser null si usas percentage.'),
      percentage: z.number().positive().max(100).nullable().optional().describe('Porcentaje del total para el primer pago. Úsalo cuando el usuario diga anticipo/enganche en %.'),
      date: z.string().nullable().optional().describe('Fecha del primer pago YYYY-MM-DD (default hoy)'),
      method: FIRST_PAYMENT_METHOD_PARAM
    }).nullable().describe('Primer pago inmediato; null si el plan no tiene primer pago'),
    remainingPayments: z.array(z.object({
      amount: z.number().positive().nullable().optional().describe('Monto de la parcialidad. Puede ser null si usas percentage.'),
      percentage: z.number().positive().max(100).nullable().optional().describe('Porcentaje del total para esta parcialidad. Úsalo para planes por porcentajes.'),
      dueDate: z.string().describe('Fecha exacta de cobro YYYY-MM-DD. Para "un mes sí y un mes no", NO crees pagos de 0: sólo incluye las fechas donde sí se cobra.'),
      frequency: PAYMENT_FREQUENCY_PARAM.optional(),
      paymentMethod: z.string().nullable().optional().describe('Método opcional de esa parcialidad: card, manual, bank_transfer, etc.'),
      notes: z.string().nullable().optional().describe('Nota opcional, por ejemplo "se saltó febrero"')
    })).min(1).describe('Pagos restantes programados. Incluye sólo cobros reales; los meses sin cobro se representan saltando la fecha, no con monto 0.'),
    remainingAutomatic: z.boolean().describe('true para cobrar automáticamente con tarjeta domiciliada; false para enviar invoices a pagar manualmente'),
    remainingFrequency: PAYMENT_FREQUENCY_PARAM.optional(),
    paymentMethodId: z.string().nullable().optional().describe('ID de tarjeta guardada de Stripe si el plan debe usar una tarjeta ya guardada. Usa list_saved_payment_methods antes si falta.'),
    gateway: GATEWAY_PARAM,
    channel: OPTIONAL_CHANNEL_PARAM,
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente el plan')
  }),
  execute: async ({ contactId, totalAmount, currency, concept, firstPayment, remainingPayments, remainingAutomatic, remainingFrequency, paymentMethodId, gateway, channel, confirm }) => {
    const unavailable = await unavailablePaymentFeature('payment_plans')
    if (unavailable) return unavailable
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario. Resume el plan (total, pasarela, primer pago, parcialidades con fechas y canal si aplica) y pide aprobación.' }
    }
    const contact = await getPaymentContact(contactId)
    if (!contact) return { ok: false, error: 'Contacto no encontrado' }

    try {
      const selected = await selectPaymentGateway(gateway, 'installmentPlans')
      if (!selected.ok) return selected

      const planPayload = buildInstallmentPayload({
        contact,
        totalAmount,
        currency,
        concept,
        firstPayment,
        remainingPayments,
        remainingFrequency: remainingFrequency || 'custom',
        paymentMethodId
      })

      if (selected.gateway.id === 'stripe') {
        const result = await createStripePaymentPlan(planPayload, { baseUrl: await getPaymentBaseUrl() })
        return { ok: true, gateway: selected.gateway.id, gatewayLabel: selected.gateway.label, flowId: result?.flowId || null, result }
      }

      if (selected.gateway.id === 'conekta') {
        const result = await createConektaPaymentPlan(planPayload, { baseUrl: await getPaymentBaseUrl() })
        return { ok: true, gateway: selected.gateway.id, gatewayLabel: selected.gateway.label, flowId: result?.flowId || null, result }
      }

      if (selected.gateway.id === 'rebill') {
        const result = await createRebillPaymentPlan(planPayload, { baseUrl: await getPaymentBaseUrl() })
        return { ok: true, gateway: selected.gateway.id, gatewayLabel: selected.gateway.label, flowId: result?.flowId || null, result }
      }

      if (!channel) {
        return { ok: false, error: 'Para enviar parcialidades falta elegir canal: email, WhatsApp, SMS o todos.' }
      }
      const result = await createInstallmentPaymentFlow({
        ...planPayload,
        remainingAutomatic,
        channels: buildChannels(channel),
        source: 'ai_agent'
      })
      return { ok: true, gateway: selected.gateway.id, gatewayLabel: selected.gateway.label, flowId: result?.flowId || result?.id || null, summary: result?.summary || null, result }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const listSavedPaymentMethodsTool = tool({
  name: 'list_saved_payment_methods',
  description: 'Lista tarjetas guardadas de Stripe o Conekta para un contacto. Úsala antes de cobrar una tarjeta guardada o activar una suscripción automática si el usuario no especificó paymentMethodId.',
  parameters: z.object({
    contactId: z.string().describe('ID del contacto'),
    gateway: GATEWAY_PARAM
  }),
  execute: async ({ contactId, gateway }) => {
    const unavailable = await unavailablePaymentFeature('saved_payment_methods')
    if (unavailable) return unavailable
    const selected = await selectPaymentGateway(gateway, 'savedCardCharges')
    if (!selected.ok) return selected

    try {
      if (selected.gateway.id === 'conekta') {
        const sources = await getConektaSavedPaymentSources(contactId)
        return {
          ok: true,
          gateway: selected.gateway.id,
          gatewayLabel: selected.gateway.label,
          total: sources.length,
          methods: sources.map((source) => ({
            id: source.id,
            paymentMethodId: source.conektaPaymentSourceId,
            brand: source.brand,
            last4: source.last4,
            expMonth: source.expMonth,
            expYear: source.expYear,
            isDefault: source.isDefault
          }))
        }
      }

      const methods = await getStripeSavedPaymentMethods(contactId)
      return {
        ok: true,
        gateway: selected.gateway.id,
        gatewayLabel: selected.gateway.label,
        total: methods.length,
        methods: methods.map((method) => ({
          id: method.id,
          paymentMethodId: method.stripePaymentMethodId,
          brand: method.brand,
          last4: method.last4,
          expMonth: method.expMonth,
          expYear: method.expYear,
          isDefault: method.isDefault
        }))
      }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const chargeSavedCardTool = tool({
  name: 'charge_saved_card',
  description: 'Cobra inmediatamente una tarjeta guardada de Stripe o Conekta. Antes de llamarla: identifica contacto, lista tarjetas si falta paymentMethodId, resume monto/concepto/tarjeta y pide aprobación. Pasa confirm=true solo cuando el usuario confirme.',
  parameters: z.object({
    contactId: z.string().describe('ID del contacto'),
    paymentMethodId: z.string().describe('ID de la tarjeta guardada (usa list_saved_payment_methods). Para Conekta puede ser payment_source_id.'),
    amount: z.number().positive().describe('Monto a cobrar'),
    concept: z.string().describe('Concepto del cobro'),
    dueDate: z.string().nullable().describe('Fecha relacionada YYYY-MM-DD (opcional)'),
    gateway: GATEWAY_PARAM,
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente el cargo')
  }),
  execute: async ({ contactId, paymentMethodId, amount, concept, dueDate, gateway, confirm }) => {
    const unavailable = await unavailablePaymentFeature('saved_payment_methods')
    if (unavailable) return unavailable
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario. Resume contacto, monto, concepto y tarjeta antes de cobrar.' }
    }
    const selected = await selectPaymentGateway(gateway, 'savedCardCharges')
    if (!selected.ok) return selected

    try {
      if (selected.gateway.id === 'conekta') {
        const result = await createConektaSavedCardPayment({
          contactId,
          paymentSourceId: paymentMethodId,
          amount,
          title: concept,
          description: concept,
          dueDate: dueDate || undefined,
          source: 'ai_agent_conekta_saved_card'
        })
        return {
          ok: true,
          gateway: selected.gateway.id,
          gatewayLabel: selected.gateway.label,
          payment: result.payment
        }
      }

      const result = await createStripeSavedCardPayment({
        contactId,
        paymentMethodId,
        amount,
        title: concept,
        description: concept,
        dueDate: dueDate || undefined,
        source: 'ai_agent_saved_card'
      })
      return {
        ok: true,
        gateway: selected.gateway.id,
        gatewayLabel: selected.gateway.label,
        payment: result.payment
      }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const listSubscriptionsTool = tool({
  name: 'list_subscriptions',
  description: 'Lista suscripciones registradas con resumen de MRR, activas, pausadas y vencidas. Úsala antes de pausar/cancelar o para reportes de suscripciones.',
  parameters: z.object({
    status: z.string().nullable().describe('Filtrar por estatus: all | active | paused | past_due | cancelled'),
    search: z.string().nullable().describe('Buscar por ID, nombre de suscripción, contacto, correo, teléfono o pasarela'),
    page: z.number().int().min(1).max(100000).nullable().describe('Página a consultar; empieza en 1'),
    cursor: z.string().nullable().describe('Cursor opaco devuelto como nextCursor por la página anterior; obligatorio después de la página 1'),
    limit: z.number().int().min(1).max(100).nullable().describe('Filas por página; default 20, máximo 100')
  }),
  execute: async ({ status, search, page, cursor, limit }) => {
    const unavailable = await unavailablePaymentFeature('subscriptions')
    if (unavailable) return unavailable
    try {
      const result = await listSubscriptions({
        status: status || 'all',
        search: search || '',
        page: page || 1,
        cursor: cursor || undefined,
        limit: limit || 20
      })
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const createSubscriptionTool = tool({
  name: 'create_subscription',
  description: 'Crea una suscripción recurrente. En Ristak las suscripciones automáticas por pasarela usan Stripe o Conekta con tarjeta guardada, o Mercado Pago con autorización/preapproval. CLIP sólo cobra el pago inicial y activa la suscripción interna de Ristak al confirmarse. Para Stripe/Conekta, si no hay tarjeta guardada, usa list_saved_payment_methods o pide conectar/guardar tarjeta. Confirma todo antes de llamar.',
  parameters: z.object({
    contactId: z.string().describe('ID del contacto'),
    name: z.string().describe('Nombre de la suscripción'),
    description: z.string().nullable().describe('Descripción opcional'),
    amount: z.number().positive().describe('Monto de cada ciclo'),
    intervalType: z.enum(['daily', 'weekly', 'monthly', 'yearly']).describe('Frecuencia de cobro'),
    intervalCount: z.number().int().min(1).max(24).nullable().describe('Cada cuántos intervalos se cobra (default 1)'),
    startDate: z.string().nullable().describe('Fecha de inicio ISO 8601 o YYYY-MM-DD (opcional)'),
    paymentMethodId: z.string().nullable().describe('ID de tarjeta guardada de Stripe/Conekta; para Mercado Pago puede ir null porque se genera autorización de suscripción.'),
    gateway: z.enum(['auto', 'stripe', 'conekta', 'mercadopago', 'clip']).nullable().describe('Pasarela para la suscripción: auto, stripe, conekta, mercadopago o clip.'),
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente la suscripción')
  }),
  execute: async ({ contactId, name, description, amount, intervalType, intervalCount, startDate, paymentMethodId, gateway, confirm }) => {
    const unavailable = await unavailablePaymentFeature('subscriptions')
    if (unavailable) return unavailable
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario. Resume contacto, monto, frecuencia, fecha inicial y tarjeta/pasarela antes de crear la suscripción.' }
    }

    const selected = await selectPaymentGateway(gateway || 'auto', 'subscriptions')
    if (!selected.ok) return selected

    try {
      const subscription = await createSubscription({
        contactId,
        name,
        description: description || '',
        amount,
        intervalType,
        intervalCount: intervalCount || 1,
        startDate: startDate || undefined,
        paymentProvider: selected.gateway.id,
        paymentMethod: selected.gateway.id === 'mercadopago'
          ? 'mercadopago_subscription'
          : selected.gateway.id === 'conekta'
            ? 'conekta_subscription'
            : selected.gateway.id === 'clip'
              ? 'clip_link'
              : 'stripe_saved_card',
        paymentMethodId: selected.gateway.id === 'stripe' ? paymentMethodId || undefined : undefined,
        stripePaymentMethodId: selected.gateway.id === 'stripe' ? paymentMethodId || undefined : undefined,
        conektaPaymentSourceId: selected.gateway.id === 'conekta' ? paymentMethodId || undefined : undefined,
        source: 'ai_agent'
      })
      return {
        ok: true,
        gateway: selected.gateway.id,
        gatewayLabel: selected.gateway.label,
        subscription
      }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const listScheduledPaymentsTool = tool({
  name: 'list_scheduled_payments',
  description: 'Lista los cobros programados (parcialidades) con su ID, contacto, monto, fecha y estatus. Úsala antes de reprogramar o cancelar un cobro.',
  parameters: z.object({
    contactId: z.string().nullable().describe('Filtrar por contacto'),
    status: z.string().nullable().describe('Filtrar por estatus, ej. scheduled | pending | paid | cancelled'),
    limit: z.number().int().min(1).max(50).nullable().describe('Máximo de cobros (default 20)')
  }),
  execute: async ({ contactId, status, limit }) => {
    const params = []
    let sql = `
      SELECT i.id, i.flow_id, i.sequence, i.amount, i.due_date, i.status, i.payment_method,
             f.contact_id, f.contact_name, f.currency, f.concept
      FROM installment_payments i
      JOIN payment_flows f ON f.id = i.flow_id
      WHERE 1 = 1`
    if (contactId) {
      sql += ' AND f.contact_id = ?'
      params.push(contactId)
    }
    if (status) {
      sql += ' AND i.status = ?'
      params.push(String(status).toLowerCase())
    }
    sql += ' ORDER BY i.due_date ASC LIMIT ?'
    params.push(limit || 20)

    const rows = await db.all(sql, params)
    return {
      ok: true,
      total: rows.length,
      scheduledPayments: rows.map((row) => ({
        installmentId: row.id,
        flowId: row.flow_id,
        sequence: row.sequence,
        amount: Number(row.amount),
        currency: row.currency,
        dueDate: row.due_date,
        status: row.status,
        contactId: row.contact_id,
        contactName: row.contact_name,
        concept: row.concept
      }))
    }
  }
})

export const rescheduleScheduledPaymentTool = tool({
  name: 'reschedule_scheduled_payment',
  description: 'Modifica un cobro programado: nueva fecha y/o nuevo monto. Usa list_scheduled_payments para obtener el installmentId. Confirma el cambio con el usuario y pasa confirm=true solo cuando ya aprobó.',
  parameters: z.object({
    installmentId: z.string().describe('ID del cobro programado'),
    newDueDate: z.string().nullable().describe('Nueva fecha de cobro YYYY-MM-DD'),
    newAmount: z.number().positive().nullable().describe('Nuevo monto del cobro'),
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente')
  }),
  execute: async ({ installmentId, newDueDate, newAmount, confirm }) => {
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario antes de modificar el cobro programado.' }
    }
    if (!newDueDate && !newAmount) {
      return { ok: false, error: 'Indica qué cambiar: nueva fecha (newDueDate) y/o nuevo monto (newAmount).' }
    }
    try {
      const result = await updateScheduledInstallmentPayment({
        installmentId,
        ...(newDueDate ? { newDueDate } : {}),
        ...(newAmount ? { amount: newAmount } : {})
      })
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const cancelScheduledPaymentTool = tool({
  name: 'cancel_scheduled_payment',
  description: 'Cancela un cobro programado (parcialidad). ACCIÓN DESTRUCTIVA: pide confirmación explícita al usuario y pasa confirm=true solo cuando ya confirmó.',
  parameters: z.object({
    installmentId: z.string().describe('ID del cobro programado a cancelar'),
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente')
  }),
  execute: async ({ installmentId, confirm }) => {
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario antes de cancelar el cobro programado.' }
    }
    try {
      const result = await cancelScheduledInstallmentPayment({ installmentId })
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const paymentFlowTools = [
  listProductsTool,
  getPaymentGatewaysTool,
  createPaymentLinkTool,
  createInstallmentPlanTool,
  listSavedPaymentMethodsTool,
  chargeSavedCardTool,
  listSubscriptionsTool,
  createSubscriptionTool,
  listScheduledPaymentsTool,
  rescheduleScheduledPaymentTool,
  cancelScheduledPaymentTool
]
