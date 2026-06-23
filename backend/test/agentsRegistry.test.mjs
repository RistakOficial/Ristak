import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_CATEGORIES, getAgentCategory, listAgentCategories } from '../src/agents/registry.js'
import { invokeController, toToolResult } from '../src/agents/invokeController.js'
import { buildInputItems, inferAgentCategoryFromMessage, resolveAgentRouting } from '../src/agents/runner.js'

const EXPECTED_CATEGORIES = ['citas', 'pagos', 'redes', 'anuncios', 'contactos', 'costos', 'general']

test('el registro tiene las 7 especialidades esperadas', () => {
  assert.deepEqual(AGENT_CATEGORIES.map((category) => category.id), EXPECTED_CATEGORIES)
})

test('cada especialidad define label, descripción, instrucciones y herramientas', () => {
  for (const category of AGENT_CATEGORIES) {
    assert.ok(category.label, `${category.id} sin label`)
    assert.ok(category.description, `${category.id} sin descripción`)
    assert.ok(typeof category.instructions === 'string' && category.instructions.length > 50, `${category.id} sin instrucciones`)
    assert.ok(Array.isArray(category.tools) && category.tools.length > 0, `${category.id} sin herramientas`)
  }
})

test('las herramientas de cada especialidad tienen nombres únicos', () => {
  for (const category of AGENT_CATEGORIES) {
    const names = category.tools.map((tool) => tool.name)
    assert.equal(new Set(names).size, names.length, `Herramientas duplicadas en ${category.id}: ${names.join(', ')}`)
  }
})

test('cada especialidad tiene memoria propia (save_memory y forget_memory)', () => {
  for (const category of AGENT_CATEGORIES) {
    const names = category.tools.map((tool) => tool.name)
    assert.ok(names.includes('save_memory'), `${category.id} sin save_memory`)
    assert.ok(names.includes('forget_memory'), `${category.id} sin forget_memory`)
  }
})

test('los agentes especializados NO mezclan herramientas de otros dominios', () => {
  const toolNames = (id) => getAgentCategory(id).tools.map((tool) => tool.name)

  assert.ok(!toolNames('citas').includes('record_payment'), 'citas no debe registrar pagos')
  assert.ok(!toolNames('citas').includes('create_cost'), 'citas no debe tocar costos')
  assert.ok(!toolNames('pagos').includes('create_appointment'), 'pagos no debe agendar citas')
  assert.ok(!toolNames('anuncios').includes('delete_contact'), 'anuncios no debe borrar contactos')
  assert.ok(!toolNames('costos').includes('search_contacts'), 'costos no necesita contactos')
  assert.ok(!toolNames('contactos').includes('get_ads_metrics'), 'contactos no debe ver métricas de ads')
})

test('el agente general sí tiene acceso a todos los dominios', () => {
  const names = getAgentCategory('general').tools.map((tool) => tool.name)
  for (const required of ['create_appointment', 'record_payment', 'create_contact', 'add_contact_phone', 'create_cost', 'set_manual_business_expense', 'get_ads_metrics', 'search_ads', 'list_social_profiles', 'list_inbox_messages', 'create_payment_link', 'create_subscription', 'get_payment_gateways', 'get_free_slots']) {
    assert.ok(names.includes(required), `general sin ${required}`)
  }
})

test('pagos incluye los cobros avanzados portados del agente original', () => {
  const names = getAgentCategory('pagos').tools.map((tool) => tool.name)
  for (const required of ['list_products', 'get_payment_gateways', 'create_payment_link', 'create_installment_plan', 'list_saved_payment_methods', 'charge_saved_card', 'list_subscriptions', 'create_subscription', 'list_scheduled_payments', 'reschedule_scheduled_payment', 'cancel_scheduled_payment']) {
    assert.ok(names.includes(required), `pagos sin ${required}`)
  }
})

test('ningún agente tiene herramientas de creación de anuncios en Meta (retiradas a propósito)', () => {
  for (const category of AGENT_CATEGORIES) {
    const names = category.tools.map((tool) => tool.name)
    for (const removed of ['create_campaign', 'create_ad_set', 'create_ad', 'create_custom_audience']) {
      assert.ok(!names.includes(removed), `${category.id} no debe incluir ${removed}`)
    }
  }
  assert.equal(getAgentCategory('publicidad'), null, 'la categoría publicidad ya no existe')
})

test('citas incluye disponibilidad de horarios (get_free_slots)', () => {
  const names = getAgentCategory('citas').tools.map((tool) => tool.name)
  assert.ok(names.includes('get_free_slots'))
})

test('contactos, anuncios, redes y costos incluyen herramientas operativas esperadas', () => {
  assert.ok(getAgentCategory('contactos').tools.map((tool) => tool.name).includes('add_contact_phone'))
  assert.ok(getAgentCategory('contactos').tools.map((tool) => tool.name).includes('list_inbox_messages'))
  assert.ok(getAgentCategory('anuncios').tools.map((tool) => tool.name).includes('search_ads'))
  assert.ok(getAgentCategory('redes').tools.map((tool) => tool.name).includes('list_inbox_messages'))
  assert.ok(getAgentCategory('costos').tools.map((tool) => tool.name).includes('list_manual_business_expenses'))
  assert.ok(getAgentCategory('costos').tools.map((tool) => tool.name).includes('set_manual_business_expense'))
})

test('costos guía gastos de reportes con lenguaje de usuario final', () => {
  const instructions = getAgentCategory('costos').instructions

  assert.match(instructions, /gastos del negocio escritos/i)
  assert.match(instructions, /nuevo total del mes/i)
  assert.match(instructions, /agrego encima/i)
  assert.match(instructions, /ponlo en 0/i)
  assert.match(instructions, /guarda \$0 como total del periodo/i)
  assert.match(instructions, /No digas "gasto manual"/i)
})

test('getAgentCategory normaliza y rechaza categorías inválidas', () => {
  assert.equal(getAgentCategory('  CITAS  ').id, 'citas')
  assert.equal(getAgentCategory('inexistente'), null)
  assert.equal(getAgentCategory(''), null)
  assert.equal(getAgentCategory(null), null)
})

test('listAgentCategories expone solo los campos públicos', () => {
  for (const category of listAgentCategories()) {
    assert.deepEqual(Object.keys(category).sort(), ['description', 'icon', 'id', 'label'])
  }
})

test('el ruteo inicial detecta la especialidad desde el primer mensaje', () => {
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Mide resultados de campaña y dime el retorno real' }),
    'anuncios'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Dame reporte de anuncios comparado contra pagos y ventas atribuidas' }),
    'anuncios'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Revisa los anuncios de esta categoría y dime el ROI con pagos atribuidos' }),
    'anuncios'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Busca el anuncio de webinar avanzado y compara su retorno' }),
    'anuncios'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Cóbrale 500 a Juan con link de pago' }),
    'pagos'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Crea un enlace de pago con Mercado Pago para Ana' }),
    'pagos'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Hazle un plan de pagos en Stripe por 3 meses' }),
    'pagos'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Crea una suscripción mensual para Luis' }),
    'pagos'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Agenda una cita mañana a las 4' }),
    'citas'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Busca el contacto de Ana y actualiza su correo' }),
    'contactos'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Cámbiale el nombre al contacto de Luis y agrégale este número' }),
    'contactos'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Revisa los DMs de Instagram de la bandeja social' }),
    'redes'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: '¿Quién me mandó mensaje nuevo y cuál fue el último mensaje?' }),
    'redes'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Configura costos variables y comisiones por venta' }),
    'costos'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Este mes gasté 5000, súmalo a los costos variables del mes' }),
    'costos'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Dime las citas de hoy, confirma una y cancela la otra' }),
    'citas'
  )
  assert.equal(
    inferAgentCategoryFromMessage({ latestUserMessage: 'Hola' }),
    null
  )
})

test('la categoría explícita no se sobrescribe con inferencia del primer mensaje', () => {
  assert.deepEqual(
    resolveAgentRouting({ categoryId: 'anuncios', inferredCategoryId: 'pagos' }),
    {
      explicitAuto: false,
      requestedCategoryId: 'anuncios',
      inferredCategoryId: 'pagos',
      entryCategory: 'anuncios',
      entryAgentName: 'anuncios'
    }
  )

  assert.deepEqual(
    resolveAgentRouting({ categoryId: 'general', inferredCategoryId: 'anuncios' }),
    {
      explicitAuto: false,
      requestedCategoryId: 'general',
      inferredCategoryId: 'anuncios',
      entryCategory: 'general',
      entryAgentName: 'general'
    }
  )

  assert.equal(
    resolveAgentRouting({ categoryId: 'auto', inferredCategoryId: 'anuncios' }).entryAgentName,
    'anuncios'
  )
})

test('invokeController captura status y payload del controller', async () => {
  const fakeHandler = async (req, res) => {
    if (!req.body.name) {
      return res.status(400).json({ success: false, error: 'Falta nombre' })
    }
    res.status(201).json({ success: true, data: { id: 'x1', name: req.body.name } })
  }

  const okResult = await invokeController(fakeHandler, { body: { name: 'Ana' } })
  assert.equal(okResult.statusCode, 201)
  assert.deepEqual(toToolResult(okResult), { ok: true, statusCode: 201, data: { id: 'x1', name: 'Ana' } })

  const errorResult = await invokeController(fakeHandler, { body: {} })
  assert.equal(errorResult.statusCode, 400)
  assert.deepEqual(toToolResult(errorResult), { ok: false, statusCode: 400, error: 'Falta nombre' })
})

test('buildInputItems convierte adjuntos a partes del protocolo del SDK', () => {
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
  const pdf = 'data:application/pdf;base64,JVBERi0xLjQ='
  const items = buildInputItems([
    { role: 'user', content: 'Hola' },
    { role: 'assistant', content: 'Hola, ¿en qué ayudo?' },
    {
      role: 'user',
      content: 'Analiza esto',
      attachments: [
        { kind: 'image', name: 'foto.png', mimeType: 'image/png', dataUrl: pixel },
        { kind: 'pdf', name: 'contrato.pdf', mimeType: 'application/pdf', dataUrl: pdf },
        { kind: 'text', name: 'notas.txt', mimeType: 'text/plain', text: 'contenido extraído' }
      ]
    }
  ])

  assert.equal(items.length, 3)
  const last = items[2]
  assert.equal(last.role, 'user')
  assert.ok(Array.isArray(last.content))
  const types = last.content.map((part) => part.type)
  assert.deepEqual(types, ['input_text', 'input_image', 'input_file', 'input_text'])
  assert.equal(last.content[1].image, pixel)
  assert.equal(last.content[2].file, pdf)
  assert.equal(last.content[2].filename, 'contrato.pdf')
  assert.ok(last.content[3].text.includes('contenido extraído'))
})

test('buildInputItems limita el historial y conserva la opción de aclaración', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))
  many.push({ role: 'user', content: 'final', selectedClarificationOption: { label: 'Opción A', value: 'opcion_a' } })
  const items = buildInputItems(many)
  assert.equal(items.length, 12)
  const lastContent = items[items.length - 1].content
  const text = Array.isArray(lastContent) ? lastContent[0].text : lastContent
  assert.ok(String(text).includes('opcion_a'))
})

test('invokeController propaga excepciones del controller', async () => {
  const throwingHandler = async () => {
    throw new Error('boom')
  }
  await assert.rejects(() => invokeController(throwingHandler), /boom/)
})
