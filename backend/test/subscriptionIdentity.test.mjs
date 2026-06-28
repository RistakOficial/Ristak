import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { db } from '../src/config/database.js'
import {
  createSubscription,
  listSubscriptions
} from '../src/services/subscriptionsService.js'

function uniqueSuffix(label = 'subscription_identity') {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

async function cleanup({ contactId, subscriptionIds = [] }) {
  for (const subscriptionId of subscriptionIds) {
    await db.run('DELETE FROM subscriptions WHERE id = ?', [subscriptionId]).catch(() => undefined)
  }
  await db.run('DELETE FROM subscriptions WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('suscripciones: dos filas del mismo contacto conservan identidad independiente', async () => {
  const suffix = uniqueSuffix()
  const contactId = `contact_${suffix}`
  const phone = '+5215557778899'
  const email = `${contactId}@example.test`
  const subscriptionIds = []

  await cleanup({ contactId })

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente con varias suscripciones', email, phone]
    )

    const first = await createSubscription({
      contactId,
      name: 'Membresia principal',
      amount: 1000,
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: '2099-01-01',
      nextRunAt: '2099-01-01',
      paymentMethod: 'manual',
      paymentProvider: 'manual'
    })
    const second = await createSubscription({
      contactId,
      name: 'Soporte adicional',
      amount: 500,
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: '2099-01-01',
      nextRunAt: '2099-01-01',
      paymentMethod: 'manual',
      paymentProvider: 'manual'
    })
    subscriptionIds.push(first.id, second.id)

    const result = await listSubscriptions()
    const createdRows = result.subscriptions
      .filter((subscription) => subscriptionIds.includes(subscription.id))
      .sort((left, right) => left.name.localeCompare(right.name))

    assert.equal(createdRows.length, 2)
    assert.deepEqual(createdRows.map((subscription) => subscription.contactId), [contactId, contactId])
    assert.notEqual(createdRows[0].id, createdRows[1].id)
    assert.deepEqual(createdRows.map((subscription) => subscription.name), ['Membresia principal', 'Soporte adicional'])
  } finally {
    await cleanup({ contactId, subscriptionIds })
  }
})

test('frontend: apiClient no deduplica payloads completos por telefono o email', () => {
  const frontendSrcPath = fileURLToPath(new URL('../../frontend/src', import.meta.url))
  const contactDedupPath = fileURLToPath(new URL('../../frontend/src/utils/contactDedup.ts', import.meta.url))
  const apiClientSource = readFileSync(
    fileURLToPath(new URL('../../frontend/src/services/apiClient.ts', import.meta.url)),
    'utf8'
  )

  function readFrontendSources(dir) {
    const sources = []
    for (const entry of readdirSync(dir)) {
      const path = `${dir}/${entry}`
      const stats = statSync(path)
      if (stats.isDirectory()) {
        sources.push(...readFrontendSources(path))
        continue
      }
      if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
        sources.push(readFileSync(path, 'utf8'))
      }
    }
    return sources
  }

  assert.doesNotMatch(apiClientSource, /dedupeContactsPayload/)
  assert.equal(existsSync(contactDedupPath), false)
  assert.equal(readFrontendSources(frontendSrcPath).some((source) => /contactDedup/.test(source)), false)
})
