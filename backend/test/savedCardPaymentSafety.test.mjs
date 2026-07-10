import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  createSavedCardProviderIdempotencyKey,
  runIdempotentSavedCardPayment
} from '../src/services/savedCardPaymentSafetyService.js'

function uniqueKey(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}_123456`
}

async function cleanup(key) {
  await db.run('DELETE FROM saved_card_payment_requests WHERE idempotency_key = ?', [key]).catch(() => {})
}

test('un cobro con la misma llave se ejecuta una vez y reproduce la respuesta durable', async () => {
  const key = uniqueKey('saved_card_replay')
  const payload = { contactId: 'contact_1', amount: 125.5, currency: 'MXN' }
  let executions = 0
  const create = async ({ providerIdempotencyKey }) => {
    executions += 1
    assert.equal(providerIdempotencyKey, createSavedCardProviderIdempotencyKey('stripe', key))
    return { payment: { id: 'payment_1', status: 'paid', amount: 125.5 } }
  }

  try {
    const first = await runIdempotentSavedCardPayment({
      provider: 'stripe',
      idempotencyKey: key,
      payload,
      create
    })
    const replay = await runIdempotentSavedCardPayment({
      provider: 'stripe',
      idempotencyKey: key,
      payload: { currency: 'MXN', amount: 125.5, contactId: 'contact_1' },
      create
    })

    assert.deepEqual(replay, first)
    assert.equal(executions, 1)
    const request = await db.get(
      'SELECT status, payment_id, response_json FROM saved_card_payment_requests WHERE provider = ? AND idempotency_key = ?',
      ['stripe', key]
    )
    assert.equal(request.status, 'completed')
    assert.equal(request.payment_id, 'payment_1')
    assert.deepEqual(JSON.parse(request.response_json), first)
  } finally {
    await cleanup(key)
  }
})

test('una llave inválida se rechaza antes de ejecutar el proveedor', async () => {
  let executions = 0
  await assert.rejects(
    () => runIdempotentSavedCardPayment({
      provider: 'stripe',
      idempotencyKey: 'corta',
      payload: { contactId: 'contact_1', amount: 100 },
      create: async () => {
        executions += 1
        return { payment: { id: 'should_not_exist' } }
      }
    }),
    (error) => error?.status === 400 && /llave de seguridad/i.test(error.message)
  )
  assert.equal(executions, 0)
})

test('la misma llave con datos distintos se rechaza sin ejecutar otro cargo', async () => {
  const key = uniqueKey('saved_card_conflict')
  let executions = 0
  const create = async () => ({ payment: { id: `payment_${++executions}`, status: 'paid' } })

  try {
    await runIdempotentSavedCardPayment({
      provider: 'conekta',
      idempotencyKey: key,
      payload: { contactId: 'contact_1', amount: 100, currency: 'MXN' },
      create
    })

    await assert.rejects(
      () => runIdempotentSavedCardPayment({
        provider: 'conekta',
        idempotencyKey: key,
        payload: { contactId: 'contact_1', amount: 200, currency: 'MXN' },
        create
      }),
      (error) => error?.status === 409 && /datos distintos/i.test(error.message)
    )
    assert.equal(executions, 1)
  } finally {
    await cleanup(key)
  }
})

test('dos requests simultáneos con la misma llave no ejecutan dos cobros', async () => {
  const key = uniqueKey('saved_card_concurrent')
  let executions = 0
  const create = async () => {
    executions += 1
    await new Promise((resolve) => setTimeout(resolve, 40))
    return { payment: { id: 'payment_concurrent', status: 'paid' } }
  }

  try {
    const args = {
      provider: 'rebill',
      idempotencyKey: key,
      payload: { contactId: 'contact_1', amount: 300, currency: 'MXN' },
      create
    }
    const results = await Promise.allSettled([
      runIdempotentSavedCardPayment(args),
      runIdempotentSavedCardPayment(args)
    ])

    assert.equal(executions, 1)
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejection = results.find((result) => result.status === 'rejected')
    assert.equal(rejection?.reason?.status, 409)
    assert.match(String(rejection?.reason?.message), /ya está en proceso/i)
  } finally {
    await cleanup(key)
  }
})

test('un resultado ambiguamente fallido queda bloqueado y no vuelve a cobrar', async () => {
  const key = uniqueKey('saved_card_failed')
  let executions = 0
  const create = async () => {
    executions += 1
    throw Object.assign(new Error('La respuesta de la pasarela se perdió.'), { status: 503 })
  }

  try {
    const args = {
      provider: 'stripe',
      idempotencyKey: key,
      payload: { contactId: 'contact_1', amount: 99, currency: 'MXN' },
      create
    }
    await assert.rejects(() => runIdempotentSavedCardPayment(args), /respuesta de la pasarela/i)
    await assert.rejects(
      () => runIdempotentSavedCardPayment(args),
      (error) => error?.status === 503 && /respuesta de la pasarela/i.test(error.message)
    )
    assert.equal(executions, 1)
    const request = await db.get(
      'SELECT status, error_status FROM saved_card_payment_requests WHERE provider = ? AND idempotency_key = ?',
      ['stripe', key]
    )
    assert.equal(request.status, 'failed')
    assert.equal(Number(request.error_status), 503)
  } finally {
    await cleanup(key)
  }
})

test('clientes legacy sin llave siguen funcionando durante el rollout', async () => {
  let executions = 0
  const create = async ({ providerIdempotencyKey }) => {
    executions += 1
    assert.equal(providerIdempotencyKey, '')
    return { payment: { id: `legacy_payment_${executions}` } }
  }

  const first = await runIdempotentSavedCardPayment({
    provider: 'stripe',
    payload: { contactId: 'legacy_contact', amount: 50 },
    create
  })
  const second = await runIdempotentSavedCardPayment({
    provider: 'stripe',
    payload: { contactId: 'legacy_contact', amount: 50 },
    create
  })

  assert.notEqual(first.payment.id, second.payment.id)
  assert.equal(executions, 2)
})
