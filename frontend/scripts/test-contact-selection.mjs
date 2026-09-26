import assert from 'node:assert/strict'
import test from 'node:test'
import { collectContactSelection } from '../src/services/collectContactSelection.ts'

test('selecciona todas las paginas, incluso mas de 100, sin duplicados', async () => {
  const result = await collectContactSelection(async (page, cursor) => {
    assert.equal(cursor, page === 1 ? null : `cursor-${page - 1}`)
    return { contacts: [{ id: 'shared' }, { id: String(page) }], pagination: {
      hasNext: page < 105, nextCursor: page < 105 ? `cursor-${page}` : null
    } }
  })
  assert.equal(result.length, 106)
  assert.equal(result.at(-1).id, '105')
})

test('un fallo no devuelve una seleccion parcial', async () => {
  await assert.rejects(collectContactSelection(async page => {
    if (page === 2) throw new Error('Network error')
    return { contacts: [{ id: 'first' }], pagination: { hasNext: true, nextCursor: 'next' } }
  }), /Network error/)
})

for (const problem of ['missing', 'repeated', 'empty']) {
  test(`rechaza paginacion incompleta: ${problem}`, async () => {
    await assert.rejects(collectContactSelection(async () => ({
      contacts: problem === 'empty' ? [] : [{ id: 'first' }],
      pagination: { hasNext: true, nextCursor: problem === 'missing' ? null : 'same' }
    })), /No se pudo completar/)
  })
}

test('cancelar evita publicar resultados incluso si la peticion ya respondio', async () => {
  const controller = new AbortController()
  await assert.rejects(collectContactSelection(async () => {
    controller.abort()
    return { contacts: [{ id: 'first' }], pagination: { hasNext: false, nextCursor: null } }
  }, controller.signal), { name: 'AbortError' })
})

test('una seleccion cancelada no inicia peticiones', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(collectContactSelection(async () => {
    assert.fail('No debe cargar')
  }, controller.signal), { name: 'AbortError' })
})
