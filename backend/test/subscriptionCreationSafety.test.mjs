import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { runIdempotentSubscriptionCreation } from '../src/services/subscriptionCreationSafetyService.js'

function uniqueKey(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}_123456`
}

async function cleanup(key) {
  await db.run('DELETE FROM subscription_creation_requests WHERE idempotency_key = ?', [key]).catch(() => {})
}

test('la misma creación de suscripción se ejecuta una vez y reproduce la respuesta durable', async () => {
  const key = uniqueKey('subscription_replay')
  const payload = {
    id: 'subscription_mobile_1',
    contactId: 'contact_1',
    paymentProvider: 'stripe',
    amount: 499,
    currency: 'MXN'
  }
  let executions = 0
  const create = async () => {
    executions += 1
    return { id: 'subscription_mobile_1', status: 'active', amount: 499, currency: 'MXN' }
  }

  try {
    const first = await runIdempotentSubscriptionCreation({
      provider: 'stripe',
      idempotencyKey: key,
      payload,
      create
    })
    const replay = await runIdempotentSubscriptionCreation({
      provider: 'stripe',
      idempotencyKey: key,
      payload: {
        currency: 'MXN',
        amount: 499,
        paymentProvider: 'stripe',
        contactId: 'contact_1',
        id: 'subscription_mobile_1',
        clientRequestId: `${key}:body-copy`
      },
      create
    })

    assert.deepEqual(replay, first)
    assert.equal(executions, 1)
    const request = await db.get(
      'SELECT status, subscription_id, response_json FROM subscription_creation_requests WHERE idempotency_key = ?',
      [key]
    )
    assert.equal(request.status, 'completed')
    assert.equal(request.subscription_id, 'subscription_mobile_1')
    assert.deepEqual(JSON.parse(request.response_json), first)
  } finally {
    await cleanup(key)
  }
})

test('dos requests simultáneos con la misma llave no crean dos suscripciones', async () => {
  const key = uniqueKey('subscription_concurrent')
  let executions = 0
  const create = async () => {
    executions += 1
    await new Promise((resolve) => setTimeout(resolve, 40))
    return { id: 'subscription_concurrent_1', status: 'active' }
  }
  const args = {
    provider: 'conekta',
    idempotencyKey: key,
    payload: { id: 'subscription_concurrent_1', paymentProvider: 'conekta', amount: 300 },
    create
  }

  try {
    const results = await Promise.allSettled([
      runIdempotentSubscriptionCreation(args),
      runIdempotentSubscriptionCreation(args)
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

test('una llave reutilizada con datos distintos se rechaza antes de crear', async () => {
  const key = uniqueKey('subscription_mismatch')
  let executions = 0
  const create = async () => ({ id: `subscription_${++executions}`, status: 'active' })

  try {
    await runIdempotentSubscriptionCreation({
      provider: 'rebill',
      idempotencyKey: key,
      payload: { id: 'subscription_1', paymentProvider: 'rebill', amount: 100 },
      create
    })

    await assert.rejects(
      () => runIdempotentSubscriptionCreation({
        provider: 'rebill',
        idempotencyKey: key,
        payload: { id: 'subscription_1', paymentProvider: 'rebill', amount: 200 },
        create
      }),
      (error) => error?.status === 409 && /datos distintos/i.test(error.message)
    )
    assert.equal(executions, 1)
  } finally {
    await cleanup(key)
  }
})

test('un resultado ambiguo queda bloqueado y nunca vuelve a crear a ciegas', async () => {
  const key = uniqueKey('subscription_ambiguous')
  let executions = 0
  const create = async () => {
    executions += 1
    throw Object.assign(new Error('La pasarela alcanzó a responder, pero la conexión se perdió.'), { status: 503 })
  }
  const args = {
    provider: 'stripe',
    idempotencyKey: key,
    payload: { id: 'subscription_ambiguous_1', paymentProvider: 'stripe', amount: 99 },
    create
  }

  try {
    await assert.rejects(() => runIdempotentSubscriptionCreation(args), /conexión se perdió/i)
    await assert.rejects(
      () => runIdempotentSubscriptionCreation(args),
      (error) => error?.status === 503 && /conexión se perdió/i.test(error.message)
    )
    assert.equal(executions, 1)
    const request = await db.get(
      'SELECT status, error_status FROM subscription_creation_requests WHERE idempotency_key = ?',
      [key]
    )
    assert.equal(request.status, 'failed')
    assert.equal(Number(request.error_status), 503)
  } finally {
    await cleanup(key)
  }
})

test('un statusCode ambiguo del proveedor se conserva como status para no rotar la llave', async () => {
  const key = uniqueKey('subscription_provider_status_code')

  try {
    await assert.rejects(
      () => runIdempotentSubscriptionCreation({
        provider: 'stripe',
        idempotencyKey: key,
        payload: { id: 'subscription_status_code_1', paymentProvider: 'stripe', amount: 99 },
        create: async () => {
          throw Object.assign(new Error('Stripe no confirmó el resultado.'), { statusCode: 503 })
        }
      }),
      (error) => error?.status === 503 && error?.statusCode === 503
    )

    const request = await db.get(
      'SELECT status, error_status FROM subscription_creation_requests WHERE idempotency_key = ?',
      [key]
    )
    assert.equal(request.status, 'failed')
    assert.equal(Number(request.error_status), 503)
  } finally {
    await cleanup(key)
  }
})
