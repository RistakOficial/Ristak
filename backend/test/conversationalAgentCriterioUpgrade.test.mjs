import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'

import {
  buildConversationalInstructions,
  buildPriceInsistenceSection,
  countPriceInsistence,
  getDepositPaymentMethods,
  messageAsksForPrice,
  PRICE_INSISTENCE_HARD_THRESHOLD,
  DEFAULT_CLOSING_STRATEGY
} from '../src/agents/conversational/prompt.js'
import { rewritePrematurePriceDisclosure } from '../src/agents/conversational/runner.js'
import { createConversationalTools } from '../src/agents/conversational/tools.js'
import { depositRequirementAmountMatches } from '../src/agents/conversational/actionEvidence.js'
import { compileConversationalAgentPolicy } from '../src/agents/conversational/intelligence/configCompiler.js'
import {
  assertAgentGoalRequirements,
  createConversationalAgent,
  normalizeAgentGoalWorkflow
} from '../src/services/conversationalAgentService.js'
import { db } from '../src/config/database.js'

const BASE_PROMPT_CONTEXT = {
  businessContext: 'Clinica de fisioterapia.',
  brandVoice: '',
  businessName: 'Clinica Criterio',
  timezone: 'America/Mexico_City',
  nowIso: 'miércoles, 17 de junio de 2026, 14:00',
  contactName: 'Ana',
  channel: 'whatsapp',
  accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
}

function buildCitasConfig(overrides = {}) {
  return {
    objective: 'citas',
    customObjective: '',
    successAction: 'book_appointment',
    requiredData: '',
    handoffRules: '',
    extraInstructions: '',
    allowEmojis: false,
    closingStrategyMode: 'system',
    closingStrategyCustom: '',
    persuasionLevel: 'high',
    languageLevel: 'intermediate',
    goalWorkflow: {
      appointments: { owner: 'ai', calendarId: 'cal_criterio_test' }
    },
    ...overrides
  }
}

test('countPriceInsistence cuenta solo mensajes entrantes que piden precio', () => {
  assert.equal(messageAsksForPrice('hola, cuánto cuesta la consulta?'), true)
  assert.equal(messageAsksForPrice('precio porfa'), true)
  assert.equal(messageAsksForPrice('me interesa saber más'), false)

  const messages = [
    { role: 'user', content: 'hola, info' },
    { role: 'assistant', content: 'claro, de qué te gustaría saber?' },
    { role: 'user', content: 'cuánto cuesta?' },
    { role: 'assistant', content: 'el precio es de $500' }, // el agente hablando de precio NO cuenta
    { role: 'user', content: 'sí, el costo porfa' },
    { role: 'user', content: '[Contexto interno de Ristak: precio pendiente]' }, // contexto interno NO cuenta
    { role: 'user', content: 'ya dime el precio' }
  ]
  assert.equal(countPriceInsistence(messages), 3)
  assert.equal(countPriceInsistence([]), 0)
})

test('la sección de insistencia de precio escala: nada, aviso y regla dura', () => {
  assert.equal(buildPriceInsistenceSection(0), '')
  assert.equal(buildPriceInsistenceSection(1), '')
  assert.match(buildPriceInsistenceSection(2), /Insistencia de precio detectada/)
  assert.match(buildPriceInsistenceSection(2), /NO rebotes una tercera vez/)
  assert.match(buildPriceInsistenceSection(3), /REGLA DURA: suelta el precio/)
  assert.match(buildPriceInsistenceSection(3), /manda sobre cualquier estrategia de apertura/)
  assert.equal(PRICE_INSISTENCE_HARD_THRESHOLD, 3)
})

test('las instrucciones inyectan la regla de insistencia solo cuando aplica', () => {
  const withoutInsistence = buildConversationalInstructions({
    config: buildCitasConfig(),
    ...BASE_PROMPT_CONTEXT,
    priceInsistenceCount: 1
  })
  assert.doesNotMatch(withoutInsistence, /REGLA DURA: suelta el precio/)

  const withHardRule = buildConversationalInstructions({
    config: buildCitasConfig(),
    ...BASE_PROMPT_CONTEXT,
    priceInsistenceCount: 3
  })
  assert.match(withHardRule, /REGLA DURA: suelta el precio \(3 peticiones\)/)

  // En modo seguimiento no se inyecta (no hay respuesta a insistencia ahí).
  const followUp = buildConversationalInstructions({
    config: buildCitasConfig(),
    ...BASE_PROMPT_CONTEXT,
    followUpContext: { index: 1, strategy: 'Retoma con contexto.' },
    priceInsistenceCount: 4
  })
  assert.doesNotMatch(followUp, /REGLA DURA: suelta el precio/)
})

test('el price guard del runtime deja pasar el precio tras la tercera insistencia', () => {
  const config = buildCitasConfig({
    extraInstructions: 'No des precios hasta que la persona diga qué molestia tiene.'
  })
  const reply = 'La valoración cuesta $500, cuéntame qué estás buscando resolver?'

  const rewritten = rewritePrematurePriceDisclosure(reply, config, { priceInsistenceCount: 0 })
  assert.notEqual(rewritten, reply)

  const allowed = rewritePrematurePriceDisclosure(reply, config, { priceInsistenceCount: 3 })
  assert.equal(allowed, reply)
})

test('el guion de fábrica con criterio es la base default y renderiza en las instrucciones', () => {
  const instructions = buildConversationalInstructions({
    config: buildCitasConfig(),
    ...BASE_PROMPT_CONTEXT
  })
  assert.match(instructions, /AGENTE CONVERSACIONAL DE CIERRE, VERSIÓN CON CRITERIO/)
  assert.match(instructions, /Puro PULL, nunca push/)
  // El contrato de tools quedó rellenado con la tool real del objetivo.
  assert.match(instructions, /book_appointment/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /\[HERRAMIENTA_INTERNA_DE_AVANCE\]/)
})

test('normalizeAgentGoalWorkflow agrega métodos de anticipo con defaults compatibles', () => {
  const legacy = normalizeAgentGoalWorkflow({
    deposit: { enabled: true, mode: 'fixed', amount: 500, currency: 'MXN' }
  })
  assert.deepEqual(legacy.deposit.methods, { paymentLink: true, bankTransfer: false })
  assert.equal(legacy.deposit.bankTransferDetails, '')

  const withTransfer = normalizeAgentGoalWorkflow({
    deposit: {
      enabled: true,
      mode: 'fixed',
      amount: 500,
      methods: { paymentLink: false, bankTransfer: true },
      bankTransferDetails: '  BBVA · CLABE 012345678901234567 · Titular: Clinica  '
    }
  })
  assert.deepEqual(withTransfer.deposit.methods, { paymentLink: false, bankTransfer: true })
  assert.equal(withTransfer.deposit.bankTransferDetails, 'BBVA · CLABE 012345678901234567 · Titular: Clinica')
})

test('assertAgentGoalRequirements exige calendario y datos de transferencia al publicar', () => {
  // Borrador apagado: se puede guardar incompleto.
  assert.doesNotThrow(() => assertAgentGoalRequirements({
    enabled: false,
    objective: 'citas',
    goalWorkflow: normalizeAgentGoalWorkflow({})
  }))

  // Publicado sin calendario: bloqueado.
  assert.throws(
    () => assertAgentGoalRequirements({
      enabled: true,
      objective: 'citas',
      defaultCalendarId: null,
      goalWorkflow: normalizeAgentGoalWorkflow({})
    }),
    (error) => error.code === 'CONVERSATIONAL_AGENT_CALENDAR_REQUIRED'
  )

  // Con calendario pasa.
  assert.doesNotThrow(() => assertAgentGoalRequirements({
    enabled: true,
    objective: 'citas',
    defaultCalendarId: 'cal_ok',
    goalWorkflow: normalizeAgentGoalWorkflow({})
  }))

  // Anticipo por transferencia sin datos bancarios: bloqueado.
  assert.throws(
    () => assertAgentGoalRequirements({
      enabled: true,
      objective: 'citas',
      defaultCalendarId: 'cal_ok',
      goalWorkflow: normalizeAgentGoalWorkflow({
        deposit: { enabled: true, mode: 'fixed', amount: 500, methods: { paymentLink: false, bankTransfer: true } }
      })
    }),
    (error) => error.code === 'CONVERSATIONAL_AGENT_TRANSFER_DETAILS_REQUIRED'
  )

  // Anticipo sin ningún método: bloqueado.
  assert.throws(
    () => assertAgentGoalRequirements({
      enabled: true,
      objective: 'citas',
      defaultCalendarId: 'cal_ok',
      goalWorkflow: normalizeAgentGoalWorkflow({
        deposit: { enabled: true, mode: 'fixed', amount: 500, methods: { paymentLink: false, bankTransfer: false } }
      })
    }),
    (error) => error.code === 'CONVERSATIONAL_AGENT_DEPOSIT_METHOD_REQUIRED'
  )
})

test('crear un agente de citas publicado sin calendario se rechaza de raíz', async () => {
  await assert.rejects(
    createConversationalAgent({
      name: 'Agente sin calendario',
      enabled: true,
      objective: 'citas'
    }),
    (error) => error.code === 'CONVERSATIONAL_AGENT_CALENDAR_REQUIRED'
  )

  let agent = null
  try {
    agent = await createConversationalAgent({
      name: 'Agente con calendario',
      enabled: true,
      objective: 'citas',
      defaultCalendarId: 'cal_criterio_create'
    })
    assert.equal(agent.enabled, true)
    assert.equal(agent.defaultCalendarId, 'cal_criterio_create')
  } finally {
    if (agent?.id) await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
  }
})

test('el compilador marca como error un agente de citas sin calendario y transferencia sin datos', () => {
  const noCalendar = compileConversationalAgentPolicy(buildCitasConfig({
    goalWorkflow: { appointments: { owner: 'human' } }
  }))
  assert.ok(noCalendar.validation.errors.some((issue) => issue.code === 'missing_calendar'))

  const withCalendar = compileConversationalAgentPolicy(buildCitasConfig())
  assert.ok(!withCalendar.validation.errors.some((issue) => issue.code === 'missing_calendar'))

  const transferNoDetails = compileConversationalAgentPolicy(buildCitasConfig({
    goalWorkflow: {
      appointments: { owner: 'ai', calendarId: 'cal_criterio_test' },
      deposit: { enabled: true, mode: 'fixed', amount: 300, methods: { paymentLink: false, bankTransfer: true } }
    }
  }))
  assert.ok(transferNoDetails.validation.errors.some((issue) => issue.code === 'missing_transfer_details'))
})

test('get_free_slots y book_appointment obedecen el calendario configurado, no al modelo', async () => {
  const configuredCalendarId = `cal_criterio_${randomUUID()}`
  const ctx = {
    contactId: null,
    dryRun: true,
    accountLocale: { currency: 'MXN' },
    actions: [],
    suppressReply: false,
    config: buildCitasConfig({
      goalWorkflow: { appointments: { owner: 'ai', calendarId: configuredCalendarId } }
    })
  }
  const tools = createConversationalTools(ctx)
  const freeSlots = tools.find((item) => item.name === 'get_free_slots')

  const result = await freeSlots.invoke(null, JSON.stringify({
    calendarId: 'cal_del_modelo_que_no_va',
    startDate: '2099-01-01',
    endDate: '2099-01-02'
  }))
  assert.equal(result.calendarId, configuredCalendarId)

  const withNull = await freeSlots.invoke(null, JSON.stringify({
    calendarId: null,
    startDate: '2099-01-01',
    endDate: '2099-01-02'
  }))
  assert.equal(withNull.calendarId, configuredCalendarId)
})

test('las tools de anticipo se exponen según los métodos configurados', () => {
  const baseCtx = { contactId: null, dryRun: true, accountLocale: { currency: 'MXN' }, actions: [], suppressReply: false }

  // Citas con anticipo por transferencia: aparece la tool del comprobante y el link.
  const transferTools = createConversationalTools({
    ...baseCtx,
    config: buildCitasConfig({
      goalWorkflow: {
        appointments: { owner: 'ai', calendarId: 'cal_criterio_test' },
        deposit: {
          enabled: true,
          mode: 'fixed',
          amount: 500,
          methods: { paymentLink: true, bankTransfer: true },
          bankTransferDetails: 'BBVA · CLABE 012345678901234567'
        }
      }
    })
  }).map((item) => item.name)
  assert.ok(transferTools.includes('register_deposit_payment_proof'))
  assert.ok(transferTools.includes('create_payment_link'))
  assert.ok(transferTools.includes('book_appointment'))

  // Sin transferencia habilitada: la tool del comprobante NO existe.
  const linkOnlyTools = createConversationalTools({
    ...baseCtx,
    config: buildCitasConfig({
      goalWorkflow: {
        appointments: { owner: 'ai', calendarId: 'cal_criterio_test' },
        deposit: { enabled: true, mode: 'fixed', amount: 500, methods: { paymentLink: true, bankTransfer: false } }
      }
    })
  }).map((item) => item.name)
  assert.ok(!linkOnlyTools.includes('register_deposit_payment_proof'))
  assert.ok(linkOnlyTools.includes('create_payment_link'))

  // Sin anticipo: ninguna tool de cobro extra para citas.
  const noDepositTools = createConversationalTools({
    ...baseCtx,
    config: buildCitasConfig()
  }).map((item) => item.name)
  assert.ok(!noDepositTools.includes('register_deposit_payment_proof'))
  assert.ok(!noDepositTools.includes('create_payment_link'))
})

test('register_deposit_payment_proof simula en dryRun y exige transferencia habilitada', async () => {
  const baseCtx = { contactId: null, dryRun: true, accountLocale: { currency: 'MXN' }, actions: [], suppressReply: false }
  const configWithTransfer = buildCitasConfig({
    goalWorkflow: {
      appointments: { owner: 'ai', calendarId: 'cal_criterio_test' },
      deposit: {
        enabled: true,
        mode: 'fixed',
        amount: 500,
        methods: { paymentLink: false, bankTransfer: true },
        bankTransferDetails: 'BBVA · CLABE 012345678901234567'
      }
    }
  })
  const ctx = { ...baseCtx, config: configWithTransfer }
  const tool = createConversationalTools(ctx).find((item) => item.name === 'register_deposit_payment_proof')
  assert.ok(tool)

  const simulated = await tool.invoke(null, JSON.stringify({ montoIndicado: 500, referencia: null }))
  assert.equal(simulated.ok, true)
  assert.equal(simulated.simulated, true)
  assert.equal(simulated.wouldRegisterPayment, true)
  assert.ok(ctx.actions.some((action) => action.type === 'register_deposit_payment_proof'))
})

test('depositRequirementAmountMatches respeta fijo exacto y rango', () => {
  assert.equal(depositRequirementAmountMatches({ mode: 'fixed', amount: 500 }, 500), true)
  assert.equal(depositRequirementAmountMatches({ mode: 'fixed', amount: 500 }, 499), false)
  assert.equal(depositRequirementAmountMatches({ mode: 'range', minAmount: 200, maxAmount: 900 }, 500), true)
  assert.equal(depositRequirementAmountMatches({ mode: 'range', minAmount: 200, maxAmount: 900 }, 100), false)
  assert.equal(depositRequirementAmountMatches({ mode: 'range', minAmount: 200, maxAmount: 900 }, null), false)
})

test('getDepositPaymentMethods trata configs previas como link de pago activo', () => {
  assert.deepEqual(
    getDepositPaymentMethods({ goalWorkflow: { deposit: { enabled: true } } }),
    { paymentLink: true, bankTransfer: false, bankTransferDetails: '' }
  )
  const configured = getDepositPaymentMethods({
    goalWorkflow: {
      deposit: {
        enabled: true,
        methods: { paymentLink: false, bankTransfer: true },
        bankTransferDetails: ' CLABE 012 '
      }
    }
  })
  assert.equal(configured.paymentLink, false)
  assert.equal(configured.bankTransfer, true)
  assert.equal(configured.bankTransferDetails, 'CLABE 012')
})
