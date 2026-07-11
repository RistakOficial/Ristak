import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MESSAGE_SPLITTER_MAX_BUBBLES,
  MESSAGE_SPLITTER_MODEL,
  splitMessageIntoBubbles
} from '../src/agents/conversational/messageSplitter.js'

const enabledSettings = {
  mode: 'split',
  splitMessagesEnabled: true,
  minMessageLengthToSplit: 120,
  minBubbleLength: 20,
  maxBubbleLength: 350,
  maxBubbles: 6
}
const alwaysSplitSettings = { ...enabledSettings, minMessageLengthToSplit: 0 }

test('usa gpt-5-nano con salida estructurada, una vuelta y sin herramientas', async () => {
  const first = 'Va, reviso el dato real con el sistema antes de prometerte algo.'
  const second = 'Te confirmo en un momento con la información completa y sin hacerte perder tiempo.'
  const original = `${first} ${second}`
  let request = null
  const openAIClient = {
    responses: {
      parse: async (body) => {
        request = body
        return { output_parsed: { messages: [first, second] } }
      }
    }
  }

  const result = await splitMessageIntoBubbles({
    text: original,
    settings: enabledSettings,
    openAIClient
  })

  assert.equal(MESSAGE_SPLITTER_MODEL, 'gpt-5-nano')
  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, [first, second])
  assert.equal(request.model, MESSAGE_SPLITTER_MODEL)
  assert.deepEqual(request.reasoning, { effort: 'minimal' })
  assert.equal(request.store, false)
  assert.equal(request.text.verbosity, 'low')
  assert.equal(request.text.format.type, 'json_schema')
  assert.equal(request.text.format.schema.properties.messages.minItems, 2)
  assert.equal(request.text.format.schema.properties.messages.maxItems, MESSAGE_SPLITTER_MAX_BUBBLES)
  assert.match(request.instructions, /entre 2 y 6 mensajes/)
  assert.equal(Object.hasOwn(request, 'tools'), false)
})

test('debajo del umbral manda un solo globo y no cobra otra llamada', async () => {
  const original = 'Va, déjame revisarlo. Te digo en un momento.'
  let calls = 0
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: enabledSettings,
    aiSplitter: async ({ model }) => {
      calls += 1
      assert.equal(model, MESSAGE_SPLITTER_MODEL)
      return { messages: ['Va, déjame revisarlo.', 'Te digo en un momento.'] }
    }
  })

  assert.equal(calls, 0)
  assert.equal(result.source, 'threshold')
  assert.deepEqual(result.messages, [original])
})

test('el umbral es inclusivo: 119 no llama y 120 sí llama', async () => {
  let calls = 0
  const under = 'a'.repeat(119)
  const atFirst = 'a'.repeat(59)
  const atSecond = 'b'.repeat(60)
  const at = `${atFirst} ${atSecond}`

  const underResult = await splitMessageIntoBubbles({
    text: under,
    settings: enabledSettings,
    aiSplitter: async () => { calls += 1; return { messages: [under] } }
  })
  const atResult = await splitMessageIntoBubbles({
    text: at,
    settings: enabledSettings,
    aiSplitter: async () => { calls += 1; return { messages: [atFirst, atSecond] } }
  })

  assert.equal(underResult.source, 'threshold')
  assert.equal(atResult.source, 'ai')
  assert.equal(calls, 1)
})

test('switch apagado nunca llama a la mini-IA', async () => {
  let calls = 0
  const result = await splitMessageIntoBubbles({
    text: 'Una respuesta que debe salir completa.',
    settings: { ...enabledSettings, splitMessagesEnabled: false, mode: 'single' },
    aiSplitter: async () => {
      calls += 1
      throw new Error('no debe ejecutarse')
    }
  })

  assert.equal(calls, 0)
  assert.equal(result.source, 'disabled')
  assert.deepEqual(result.messages, ['Una respuesta que debe salir completa.'])
})

test('sin llave OpenAI responde completo en vez de quedarse mudo', async () => {
  const original = 'Primera idea con suficiente explicación para superar el umbral configurado. Segunda idea con toda la información restante para el cliente.'
  const result = await splitMessageIntoBubbles({ text: original, settings: enabledSettings })

  assert.equal(result.source, 'fallback')
  assert.equal(result.reason, 'missing_openai_api_key')
  assert.deepEqual(result.messages, [original])
})

test('conserva exactamente precios, fechas, horas, enlaces, teléfonos y correos', async () => {
  const first = 'El anticipo es $1,250 MXN para el martes 4:00 pm.'
  const second = 'Paga en https://ristak.test/p/ABC-123 o escribe a pagos@example.com y +52 656 123 4567.'
  const original = `${first} ${second}`
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: enabledSettings,
    aiSplitter: async () => ({ messages: [first, second] })
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, [first, second])
  assert.equal(result.messages.join(' '), original)
})

test('conserva dobles espacios y saltos internos de forma literal', async () => {
  const first = 'Código: AB  123 y referencia: X  Y.'
  const second = 'Siguiente paso:\n\n\nConserva también estos saltos sin limpiarlos.'
  const original = `${first}\n\n${second}`
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: alwaysSplitSettings,
    aiSplitter: async () => ({ messages: [first, second] })
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, [first, second])
  assert.equal(result.messages[0].includes('AB  123'), true)
  assert.equal(result.messages[1].includes('\n\n\n'), true)
})

test('un texto largo no acepta un solo globo aunque el modelo lo proponga', async () => {
  const original = 'Esta es una respuesta deliberadamente larga que supera el umbral de división. Incluye otra idea completa para que deba salir en más de un globo.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: enabledSettings,
    aiSplitter: async () => ({ messages: [original] })
  })

  assert.equal(result.source, 'fallback')
  assert.equal(result.reason, 'insufficient_messages')
  assert.deepEqual(result.messages, [original])
})

test('rechaza un globo que rebasa el máximo cuando sí puede cortarse', async () => {
  const first = 'A'.repeat(50) + ' ' + 'B'.repeat(50)
  const second = 'C'.repeat(50) + ' ' + 'D'.repeat(50)
  const original = `${first} ${second}`
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { ...alwaysSplitSettings, maxBubbleLength: 80 },
    aiSplitter: async () => ({ messages: [first, second] })
  })

  assert.equal(result.source, 'fallback')
  assert.equal(result.reason, 'message_too_long')
  assert.deepEqual(result.messages, [original])
})

test('nunca permite cortar por la mitad una URL, correo o código sin espacios', async () => {
  const token = 'https://pagos.ristak.test/ABC-1234567890'
  const first = token.slice(0, 24)
  const second = token.slice(24)
  const result = await splitMessageIntoBubbles({
    text: token,
    settings: alwaysSplitSettings,
    aiSplitter: async () => ({ messages: [first, second] })
  })

  assert.equal(result.source, 'fallback')
  assert.equal(result.reason, 'unsafe_cut_boundary')
  assert.deepEqual(result.messages, [token])
})

test('rechaza cualquier reescritura, marcador, vacío o exceso de globos', async (t) => {
  const original = 'Primera idea exacta. Segunda idea exacta.'
  const cases = [
    ['cambia una letra', { messages: ['primera idea exacta.', 'Segunda idea exacta.'] }, 'content_changed'],
    ['agrega marcador', { messages: ['Primera idea exacta. [BREAK]', 'Segunda idea exacta.'] }, 'content_changed'],
    ['devuelve vacío', { messages: [] }, 'empty_messages'],
    ['devuelve objeto vacío', {}, 'empty_messages'],
    ['supera el máximo configurado', { messages: ['Primera', 'idea', 'exacta.', 'Segunda idea exacta.'] }, 'too_many_messages']
  ]

  for (const [name, raw, reason] of cases) {
    await t.test(name, async () => {
      const result = await splitMessageIntoBubbles({
        text: original,
        settings: { ...alwaysSplitSettings, maxBubbles: name.includes('máximo') ? 3 : 6 },
        aiSplitter: async () => raw
      })
      assert.equal(result.source, 'fallback')
      assert.equal(result.reason, reason)
      assert.deepEqual(result.messages, [original])
    })
  }
})

test('error o timeout de la mini-IA manda el texto original completo', async (t) => {
  const original = 'Primera idea. Segunda idea.'
  const log = { warn() {} }

  await t.test('error', async () => {
    const result = await splitMessageIntoBubbles({
      text: original,
      settings: alwaysSplitSettings,
      aiSplitter: async () => { throw new Error('rate_limited') },
      log
    })
    assert.equal(result.reason, 'rate_limited')
    assert.deepEqual(result.messages, [original])
  })

  await t.test('timeout', async () => {
    const result = await splitMessageIntoBubbles({
      text: original,
      settings: alwaysSplitSettings,
      aiSplitter: async () => new Promise(() => {}),
      timeoutMs: 5,
      log
    })
    assert.equal(result.reason, 'splitter_timeout')
    assert.deepEqual(result.messages, [original])
  })
})
