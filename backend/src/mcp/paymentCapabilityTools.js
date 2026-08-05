import * as transactionsController from '../controllers/transactionsController.js'
import * as offlinePaymentsController from '../controllers/offlinePaymentsController.js'
import * as stripePaymentsController from '../controllers/stripePaymentsController.js'
import * as conektaPaymentsController from '../controllers/conektaPaymentsController.js'
import * as mercadoPagoPaymentsController from '../controllers/mercadoPagoPaymentsController.js'
import * as rebillPaymentsController from '../controllers/rebillPaymentsController.js'
import * as clipPaymentsController from '../controllers/clipPaymentsController.js'
import * as highlevelController from '../controllers/highlevelController.js'

const MAX_ARGUMENT_BYTES = 768 * 1024
const ID = { type: 'string', minLength: 1, maxLength: 300 }
const SHORT_TEXT = { type: 'string', maxLength: 500 }
const REQUIRED_SHORT_TEXT = { type: 'string', minLength: 1, maxLength: 500 }
const LONG_TEXT = { type: 'string', maxLength: 50000 }
const EMAIL = { type: 'string', maxLength: 320 }
const PHONE = { type: 'string', maxLength: 80 }
const AMOUNT = { type: 'number', exclusiveMinimum: 0 }
const CURRENCY = {
  type: 'string',
  pattern: '^[A-Za-z]{3}$',
  description: 'Moneda ISO de tres letras. Si se omite, el backend usa la moneda configurada en la cuenta.'
}
const DATE = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'Fecha de calendario YYYY-MM-DD interpretada en la zona horaria del negocio.'
}
const BUSINESS_DATE_TIME = {
  type: 'string',
  minLength: 10,
  maxLength: 80,
  description: 'Fecha de calendario o instante que Ristak interpreta con la zona horaria del negocio.'
}
const IDEMPOTENCY_KEY = {
  type: 'string',
  minLength: 8,
  maxLength: 180,
  pattern: '^[A-Za-z0-9._:-]+$'
}
const OBJECT = { type: 'object', maxProperties: 150, additionalProperties: true }
const FREQUENCY = {
  type: 'string',
  enum: ['scheduled_time', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom']
}

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function compactDefined(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function cleanControls(value = {}) {
  const cleaned = { ...value }
  delete cleaned.idempotencyKey
  return compactDefined(cleaned)
}

function mutationSchema(inputSchema = schema()) {
  return {
    ...inputSchema,
    properties: { ...(inputSchema.properties || {}), idempotencyKey: IDEMPOTENCY_KEY },
    required: [...new Set([...(inputSchema.required || []), 'idempotencyKey'])]
  }
}

function assertArgumentBudget(args) {
  let size = 0
  try {
    size = Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8')
  } catch {
    const error = new Error('Los argumentos de pago no se pueden serializar.')
    error.status = 400
    error.code = 'invalid_arguments'
    throw error
  }
  if (size <= MAX_ARGUMENT_BYTES) return
  const error = new Error('Los argumentos superan el límite de 768 KB para una llamada MCP.')
  error.status = 413
  error.code = 'payload_too_large'
  throw error
}

function controllerTool({
  handler,
  method = 'GET',
  params = () => ({}),
  query = () => ({}),
  body = () => ({}),
  ...definition
}) {
  const mutation = definition.access === 'write'
  return Object.freeze({
    featureKeys: [],
    additionalModules: [],
    connectionPrerequisites: [],
    adminOnly: false,
    confirmRequired: false,
    idempotencyRequired: mutation,
    ...definition,
    inputSchema: mutation
      ? mutationSchema(definition.inputSchema || schema())
      : (definition.inputSchema || schema()),
    async execute(context, args = {}) {
      assertArgumentBudget(args)
      return context.invoke(handler, {
        method,
        params: params(args),
        query: query(args),
        body: body(args),
        ...(mutation ? { headers: { 'idempotency-key': args.idempotencyKey } } : {})
      })
    }
  })
}

function readTool(definition) {
  return controllerTool({ access: 'read', scope: 'ristak.read', risk: 'low', ...definition })
}

function executeTool(definition) {
  return controllerTool({
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    openWorld: true,
    method: 'POST',
    ...definition
  })
}

function destructiveTool(definition) {
  return controllerTool({
    access: 'write',
    scope: 'ristak.destructive',
    risk: 'critical',
    method: 'DELETE',
    ...definition
  })
}

const CONTACT = schema({
  id: ID,
  name: SHORT_TEXT,
  email: EMAIL,
  phone: PHONE
}, ['id'])

const LINE_ITEM = schema({
  name: REQUIRED_SHORT_TEXT,
  description: LONG_TEXT,
  amount: AMOUNT,
  qty: { type: 'number', exclusiveMinimum: 0 },
  currency: CURRENCY,
  priceId: ID,
  productId: ID
}, ['name', 'amount'])

const FIRST_PAYMENT = schema({
  enabled: { type: 'boolean' },
  amount: { type: 'number', minimum: 0 },
  date: BUSINESS_DATE_TIME,
  frequency: FREQUENCY,
  method: { type: 'string', maxLength: 80 }
})

const REMAINING_PAYMENT = schema({
  sequence: { type: 'integer', minimum: 1, maximum: 1000 },
  type: { type: 'string', enum: ['amount', 'percentage'] },
  value: { type: 'number', minimum: 0 },
  amount: AMOUNT,
  percentage: { type: ['number', 'null'], minimum: 0, maximum: 100 },
  dueDate: BUSINESS_DATE_TIME,
  frequency: FREQUENCY,
  paymentMethod: { type: 'string', maxLength: 80 }
}, ['amount', 'dueDate'])

const PLAN_PROPERTIES = {
  contact: CONTACT,
  totalAmount: AMOUNT,
  currency: CURRENCY,
  title: REQUIRED_SHORT_TEXT,
  description: LONG_TEXT,
  firstPayment: FIRST_PAYMENT,
  remainingFrequency: FREQUENCY,
  remainingPayments: {
    type: 'array',
    minItems: 1,
    maxItems: 1000,
    items: REMAINING_PAYMENT
  },
  paymentMethodId: ID,
  cardSetupAmount: AMOUNT,
  lineItems: { type: 'array', maxItems: 500, items: LINE_ITEM },
  invoicePayload: OBJECT,
  source: SHORT_TEXT
}

const LINK_PROPERTIES = {
  contactId: ID,
  contactName: SHORT_TEXT,
  email: EMAIL,
  phone: PHONE,
  amount: AMOUNT,
  currency: CURRENCY,
  title: REQUIRED_SHORT_TEXT,
  description: LONG_TEXT,
  dueDate: BUSINESS_DATE_TIME,
  applyTax: { type: 'boolean' },
  taxCalculationMode: { type: 'string', enum: ['exclusive', 'inclusive'] },
  installments: schema({
    enabled: { type: 'boolean' },
    maxInstallments: { type: 'integer', minimum: 1, maximum: 60 }
  }),
  lineItems: { type: 'array', maxItems: 500, items: LINE_ITEM },
  metadata: OBJECT,
  source: SHORT_TEXT
}

const SAVED_CARD_PROPERTIES = {
  contactId: ID,
  paymentMethodId: ID,
  paymentSourceId: ID,
  amount: AMOUNT,
  currency: CURRENCY,
  title: REQUIRED_SHORT_TEXT,
  description: LONG_TEXT,
  dueDate: BUSINESS_DATE_TIME,
  contactName: SHORT_TEXT,
  email: EMAIL,
  phone: PHONE,
  applyTax: { type: 'boolean' },
  taxCalculationMode: { type: 'string', enum: ['exclusive', 'inclusive'] },
  installments: schema({
    enabled: { type: 'boolean' },
    maxInstallments: { type: 'integer', minimum: 1, maximum: 60 }
  }),
  lineItems: { type: 'array', maxItems: 500, items: LINE_ITEM },
  source: SHORT_TEXT
}

function planTool({ name, provider, handler, description }) {
  return executeTool({
    name,
    title: `Crear plan de pagos ${provider}`,
    description,
    module: 'payments',
    featureKeys: ['payment_plans'],
    connectionPrerequisites: provider === 'offline' ? [] : [provider],
    handler,
    inputSchema: schema(PLAN_PROPERTIES, ['contact', 'totalAmount', 'title', 'remainingPayments']),
    body: args => ({ ...cleanControls(args), source: args.source || `ristak_mcp_${provider}_plan` })
  })
}

function linkTool({ name, provider, handler, description }) {
  return executeTool({
    name,
    title: `Crear link de pago ${provider}`,
    description,
    module: 'payments',
    featureKeys: ['payment_links'],
    connectionPrerequisites: [provider],
    handler,
    inputSchema: schema(LINK_PROPERTIES, ['amount']),
    body: args => ({ ...cleanControls(args), source: args.source || `ristak_mcp_${provider}_link` })
  })
}

function savedMethodsTool({ name, provider, handler, description }) {
  return readTool({
    name,
    description,
    module: 'payments',
    featureKeys: ['saved_payment_methods'],
    connectionPrerequisites: [provider],
    handler,
    inputSchema: schema({ contactId: ID }, ['contactId']),
    params: args => ({ contactId: args.contactId })
  })
}

function savedCardTool({ name, provider, handler, source, sourceField = 'paymentMethodId', description }) {
  return executeTool({
    name,
    description,
    module: 'payments',
    featureKeys: ['saved_payment_methods'],
    connectionPrerequisites: [provider],
    handler,
    inputSchema: schema(SAVED_CARD_PROPERTIES, ['contactId', sourceField, 'amount']),
    body: args => ({ ...cleanControls(args), source: args.source || source })
  })
}

const transactionInsightTools = [
  readTool({
    name: 'payments_get_stats',
    description: 'Obtiene métricas agregadas de pagos usando los filtros y la moneda de la cuenta.',
    module: 'payments',
    handler: transactionsController.getTransactionStats,
    inputSchema: schema({
      startDate: DATE,
      endDate: DATE
    }),
    query: compactDefined
  }),
  readTool({
    name: 'payments_get_summary',
    description: 'Resume los pagos por estado, proveedor y periodo sin alterar transacciones.',
    module: 'payments',
    handler: transactionsController.getTransactionSummary,
    inputSchema: schema({
      startDate: DATE,
      endDate: DATE,
      status: SHORT_TEXT,
      search: SHORT_TEXT
    }),
    query: compactDefined
  }),
  readTool({
    name: 'payments_get_facets',
    description: 'Obtiene los valores disponibles para filtrar la tabla de pagos.',
    module: 'payments',
    handler: transactionsController.getTransactionFacets,
    inputSchema: schema({ startDate: DATE, endDate: DATE, search: SHORT_TEXT }),
    query: compactDefined
  }),
  executeTool({
    name: 'payments_sync_transactions',
    description: 'Sincroniza los invoices de HighLevel con la tabla local de pagos mediante el flujo canónico del backend.',
    module: 'payments',
    featureKeys: ['highlevel_integration'],
    connectionPrerequisites: ['highlevel'],
    handler: transactionsController.syncTransactions,
    inputSchema: schema(),
    body: () => ({ source: 'ristak_mcp' })
  }),
  destructiveTool({
    name: 'payments_delete_transaction',
    description: 'Elimina una transacción sólo cuando las reglas canónicas permiten borrarla; pagos con actividad protegida se conservan.',
    module: 'payments',
    handler: transactionsController.deleteTransaction,
    inputSchema: schema({ paymentId: ID }, ['paymentId']),
    params: args => ({ id: args.paymentId })
  })
]

const planTools = [
  planTool({
    name: 'payments_create_offline_plan',
    provider: 'offline',
    handler: offlinePaymentsController.createOfflinePaymentPlanView,
    description: 'Crea un plan offline: registra las cuotas, envía los recordatorios configurados cuando vencen y deja el pago para registro manual.'
  }),
  planTool({
    name: 'payments_create_stripe_plan',
    provider: 'stripe',
    handler: stripePaymentsController.createStripePaymentPlanView,
    description: 'Crea un plan Stripe con primer pago, tarjeta guardada o enlace de domiciliación y cobros futuros programados.'
  }),
  planTool({
    name: 'payments_create_conekta_plan',
    provider: 'conekta',
    handler: conektaPaymentsController.createConektaPaymentPlanView,
    description: 'Crea un plan Conekta con tarjeta guardada o autorización inicial y parcialidades futuras.'
  }),
  planTool({
    name: 'payments_create_rebill_plan',
    provider: 'rebill',
    handler: rebillPaymentsController.createRebillPaymentPlanView,
    description: 'Crea un plan Rebill con fuente guardada o checkout de autorización y parcialidades futuras.'
  })
]

const linkTools = [
  linkTool({ name: 'payments_create_stripe_link', provider: 'stripe', handler: stripePaymentsController.createStripePaymentLinkView, description: 'Crea un link hospedado de cobro Stripe.' }),
  linkTool({ name: 'payments_create_conekta_link', provider: 'conekta', handler: conektaPaymentsController.createConektaPaymentLinkView, description: 'Crea un link hospedado de cobro Conekta.' }),
  linkTool({ name: 'payments_create_mercadopago_link', provider: 'mercadopago', handler: mercadoPagoPaymentsController.createMercadoPagoPaymentLinkView, description: 'Crea un link hospedado de cobro Mercado Pago.' }),
  linkTool({ name: 'payments_create_rebill_link', provider: 'rebill', handler: rebillPaymentsController.createRebillPaymentLinkView, description: 'Crea un link hospedado de cobro Rebill.' }),
  linkTool({ name: 'payments_create_clip_link', provider: 'clip', handler: clipPaymentsController.createClipPaymentLinkView, description: 'Crea un link hospedado de cobro CLIP; CLIP requiere email y teléfono del contacto.' })
]

const savedPaymentMethodTools = [
  savedMethodsTool({ name: 'payments_list_stripe_saved_methods', provider: 'stripe', handler: stripePaymentsController.getStripeSavedPaymentMethodsView, description: 'Lista las tarjetas Stripe guardadas del contacto sin exponer datos sensibles.' }),
  executeTool({
    name: 'payments_refresh_stripe_saved_methods',
    description: 'Sincroniza desde Stripe las tarjetas guardadas de un contacto.',
    module: 'payments',
    featureKeys: ['saved_payment_methods'],
    connectionPrerequisites: ['stripe'],
    handler: stripePaymentsController.refreshStripeSavedPaymentMethodsView,
    inputSchema: schema({ contactId: ID }, ['contactId']),
    params: args => ({ contactId: args.contactId })
  }),
  savedMethodsTool({ name: 'payments_list_conekta_saved_sources', provider: 'conekta', handler: conektaPaymentsController.getConektaSavedPaymentSourcesView, description: 'Lista las tarjetas Conekta guardadas del contacto sin exponer datos sensibles.' }),
  savedMethodsTool({ name: 'payments_list_rebill_saved_sources', provider: 'rebill', handler: rebillPaymentsController.getRebillSavedPaymentSourcesView, description: 'Lista las fuentes Rebill guardadas del contacto sin exponer datos sensibles.' }),
  savedCardTool({ name: 'payments_charge_stripe_saved_card', provider: 'stripe', handler: stripePaymentsController.createStripeSavedCardPaymentView, source: 'ristak_mcp_stripe_saved_card', description: 'Cobra una tarjeta Stripe ya guardada del contacto y registra el resultado.' }),
  savedCardTool({ name: 'payments_charge_conekta_saved_card', provider: 'conekta', handler: conektaPaymentsController.createConektaSavedCardPaymentView, source: 'ristak_mcp_conekta_saved_card', sourceField: 'paymentSourceId', description: 'Cobra una tarjeta Conekta ya guardada del contacto y registra el resultado.' }),
  savedCardTool({ name: 'payments_charge_rebill_saved_card', provider: 'rebill', handler: rebillPaymentsController.createRebillSavedCardPaymentView, source: 'ristak_mcp_rebill_saved_card', sourceField: 'paymentSourceId', description: 'Cobra una fuente Rebill ya guardada del contacto y registra el resultado.' })
]

const HIGHLEVEL_FEATURES = ['highlevel_integration']
const HIGHLEVEL_CONNECTION = ['highlevel']

const highLevelPaymentTools = [
  executeTool({
    name: 'payments_create_highlevel_invoice',
    description: 'Crea un invoice en HighLevel, lo refleja en Ristak y usa la moneda configurada por la cuenta.',
    module: 'payments',
    featureKeys: HIGHLEVEL_FEATURES,
    connectionPrerequisites: HIGHLEVEL_CONNECTION,
    handler: highlevelController.createInvoice,
    inputSchema: schema({
      name: REQUIRED_SHORT_TEXT,
      title: SHORT_TEXT,
      businessDetails: OBJECT,
      contactDetails: schema({ id: ID, name: SHORT_TEXT, email: EMAIL, phoneNo: PHONE }, ['id']),
      items: { type: 'array', minItems: 1, maxItems: 500, items: LINE_ITEM },
      issueDate: DATE,
      dueDate: DATE,
      termsNotes: LONG_TEXT,
      tax: OBJECT,
      metadata: OBJECT
    }, ['name', 'contactDetails', 'items', 'issueDate', 'dueDate']),
    body: args => cleanControls(args)
  }),
  executeTool({
    name: 'payments_send_highlevel_invoice',
    description: 'Envía un invoice existente por email, SMS/WhatsApp o ambos mediante HighLevel.',
    module: 'payments',
    featureKeys: [...HIGHLEVEL_FEATURES, 'payment_links'],
    connectionPrerequisites: HIGHLEVEL_CONNECTION,
    handler: highlevelController.sendInvoice,
    inputSchema: schema({ invoiceId: ID, sendMethod: { type: 'string', enum: ['email', 'sms', 'both', 'none'] } }, ['invoiceId']),
    params: args => ({ invoiceId: args.invoiceId }),
    body: args => ({ sendMethod: args.sendMethod || 'email' })
  }),
  executeTool({
    name: 'payments_record_highlevel_invoice_payment',
    description: 'Registra manualmente en HighLevel el pago de un invoice y reconcilia el registro local.',
    module: 'payments',
    featureKeys: HIGHLEVEL_FEATURES,
    connectionPrerequisites: HIGHLEVEL_CONNECTION,
    handler: highlevelController.recordPayment,
    inputSchema: schema({
      invoiceId: ID,
      amount: AMOUNT,
      currency: CURRENCY,
      paymentDate: BUSINESS_DATE_TIME,
      paymentMethod: { type: 'string', enum: ['cash', 'transfer', 'bank_transfer', 'check', 'card', 'other'] },
      reference: SHORT_TEXT,
      notes: LONG_TEXT
    }, ['invoiceId', 'amount']),
    params: args => ({ invoiceId: args.invoiceId }),
    body: args => cleanControls(compactDefined({
      amount: args.amount,
      currency: args.currency,
      paymentDate: args.paymentDate,
      paymentMethod: args.paymentMethod,
      reference: args.reference,
      notes: args.notes
    }))
  }),
  executeTool({
    name: 'payments_sync_highlevel_invoice',
    description: 'Sincroniza un invoice específico de HighLevel con el registro local de Ristak.',
    module: 'payments',
    featureKeys: HIGHLEVEL_FEATURES,
    connectionPrerequisites: HIGHLEVEL_CONNECTION,
    handler: highlevelController.syncInvoice,
    inputSchema: schema({ invoiceId: ID }, ['invoiceId']),
    params: args => ({ invoiceId: args.invoiceId })
  }),
  executeTool({
    name: 'payments_send_highlevel_text2pay',
    description: 'Crea y envía un link rápido Text2Pay por HighLevel al contacto.',
    module: 'payments',
    featureKeys: [...HIGHLEVEL_FEATURES, 'payment_links'],
    connectionPrerequisites: HIGHLEVEL_CONNECTION,
    handler: highlevelController.text2Pay,
    inputSchema: schema({ contactId: ID, amount: AMOUNT, currency: CURRENCY, message: LONG_TEXT }, ['contactId', 'amount']),
    body: args => cleanControls(args)
  })
]

export const paymentCapabilityToolSpecs = Object.freeze([
  ...transactionInsightTools,
  ...planTools,
  ...linkTools,
  ...savedPaymentMethodTools,
  ...highLevelPaymentTools
])
