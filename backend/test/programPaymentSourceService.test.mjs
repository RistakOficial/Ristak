import assert from 'node:assert/strict'
import test from 'node:test'
import sqlite3 from 'sqlite3'

import {
  listProgramPaymentSources,
  loadProgramPaymentSource
} from '../src/services/programPaymentSourceService.js'

function memoryDatabase() {
  const connection = new sqlite3.Database(':memory:')
  return {
    exec(sql) {
      return new Promise((resolve, reject) => {
        connection.exec(sql, error => error ? reject(error) : resolve())
      })
    },
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.run(sql, params, function (error) {
          if (error) reject(error)
          else resolve({ changes: this.changes, lastID: this.lastID })
        })
      })
    },
    get(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row))
      })
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows))
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        connection.close(error => error ? reject(error) : resolve())
      })
    }
  }
}

async function insert(db, table, values) {
  const columns = Object.keys(values)
  await db.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map(column => values[column])
  )
}

async function fixture(t) {
  const db = memoryDatabase()
  t.after(() => db.close())
  // Amounts intentionally use TEXT: PostgreSQL numeric values arrive as strings,
  // and the source snapshot must preserve their exact representation.
  await db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, email TEXT, full_name TEXT, deleted_at TEXT,
      archived_at TEXT, is_archived INTEGER DEFAULT 0, status TEXT,
      updated_at TEXT
    );
    CREATE TABLE products (
      id TEXT PRIMARY KEY, ghl_product_id TEXT, name TEXT, is_active INTEGER DEFAULT 1,
      updated_at TEXT
    );
    CREATE TABLE product_prices (
      id TEXT PRIMARY KEY, product_id TEXT, ghl_price_id TEXT, ghl_product_id TEXT,
      sku TEXT, amount TEXT, updated_at TEXT
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY, contact_id TEXT, status TEXT, payment_mode TEXT,
      currency TEXT, amount TEXT, title TEXT, description TEXT, paid_at TEXT,
      due_date TEXT, metadata_json TEXT, updated_at TEXT
    );
    CREATE TABLE payment_flows (
      id TEXT PRIMARY KEY, contact_id TEXT, contact_email TEXT, current_state TEXT,
      currency TEXT, total_amount TEXT, concept TEXT, first_payment_amount TEXT,
      first_payment_status TEXT, first_payment_date TEXT, first_payment_invoice_id TEXT,
      payment_provider TEXT, ghl_payment_live_mode INTEGER, metadata TEXT,
      updated_at TEXT
    );
    CREATE TABLE installment_payments (
      id TEXT PRIMARY KEY, flow_id TEXT, sequence INTEGER, payment_id TEXT,
      status TEXT, amount TEXT, due_date TEXT, updated_at TEXT
    );
  `)
  await insert(db, 'contacts', { id: 'contact_one', email: 'student@example.test', full_name: 'Alumno de prueba' })
  await insert(db, 'contacts', { id: 'contact_other', email: 'other@example.test', full_name: 'Otro alumno' })
  await insert(db, 'products', { id: 'product_one', ghl_product_id: 'ghl_product_one', name: 'Programa principal' })
  await insert(db, 'products', { id: 'product_other', ghl_product_id: 'ghl_product_other', name: 'Otro programa' })
  await insert(db, 'product_prices', {
    id: 'price_one', product_id: 'product_one', ghl_price_id: 'ghl_price_one',
    ghl_product_id: 'ghl_product_one', sku: null, amount: '1234.5600'
  })
  await insert(db, 'product_prices', {
    id: 'price_other', product_id: 'product_other', ghl_price_id: 'ghl_price_other',
    ghl_product_id: 'ghl_product_other', sku: 'OTHER', amount: '500.00'
  })
  await insert(db, 'payments', payment())
  await insert(db, 'payment_flows', plan())
  return db
}

function payment(overrides = {}) {
  return {
    id: 'payment_one', contact_id: 'contact_one', status: 'paid', payment_mode: 'live',
    currency: 'EUR', amount: '1234.5600', title: 'Concepto del pago',
    description: 'Descripción canónica', paid_at: '2026-11-04 23:30:45',
    due_date: '2026-11-05',
    metadata_json: JSON.stringify({ lineItems: [{ productId: 'product_one', priceId: 'price_one' }] }),
    ...overrides
  }
}

function plan(overrides = {}) {
  return {
    id: 'plan_one', contact_id: 'contact_one', contact_email: 'student@example.test',
    current_state: 'active', currency: 'EUR', total_amount: '3000.0000',
    concept: 'Programa en parcialidades', first_payment_amount: '1000.0000',
    first_payment_status: 'pending', first_payment_date: '2026-11-04 23:30:45',
    first_payment_invoice_id: null, payment_provider: 'stripe',
    metadata: JSON.stringify({ paymentMode: 'live', lineItems: [{ productId: 'product_one' }] }),
    ...overrides
  }
}

function load(db, sourceType = 'payment', sourceId = sourceType === 'payment' ? 'payment_one' : 'plan_one') {
  return loadProgramPaymentSource(db, { sourceType, sourceId })
}

function assertAllowed(source) {
  assert.equal(source.blockedReason, null)
  assert.match(source.revision, /^[a-f0-9]{64}$/)
}

function assertBlocked(source) {
  assert.equal(typeof source.blockedReason, 'string')
  assert.ok(source.blockedReason.length > 0)
}

async function relatedPlanFixture(t) {
  const db = await fixture(t)
  await db.run('UPDATE payment_flows SET first_payment_invoice_id = ?, first_payment_status = ? WHERE id = ?', ['payment_one', 'paid', 'plan_one'])
  for (const id of ['sibling_z', 'sibling_a', 'unrelated_payment']) {
    await insert(db, 'payments', payment({ id, metadata_json: '{}' }))
  }
  for (const [sequence, paymentId] of [[3, 'sibling_z'], [1, 'payment_one'], [2, 'sibling_a']]) {
    await insert(db, 'installment_payments', {
      id: `relation_${sequence}`, flow_id: 'plan_one', sequence, payment_id: paymentId,
      status: 'paid', amount: '1000.00', due_date: '2026-12-05'
    })
  }
  return db
}

function assertRelated(source, expected) {
  assert.deepEqual(source.relatedSources, expected)
  assert.equal(new Set(source.relatedSources.map(item => `${item.sourceType}:${item.sourceId}`)).size, expected.length)
}

test('carga exclusivamente el pago solicitado y la identidad canónica por contact_id', async t => {
  const db = await fixture(t)
  await insert(db, 'payments', payment({
    id: 'payment_other', contact_id: 'contact_other', amount: '99.00',
    metadata_json: JSON.stringify({ productId: 'product_other' })
  }))
  const source = await load(db)
  assertAllowed(source)
  assert.equal(source.sourceType, 'payment')
  assert.equal(source.sourceId, 'payment_one')
  assert.equal(source.contactId, 'contact_one')
  assert.equal(source.email, 'student@example.test')
  assert.deepEqual(source.productIds, ['product_one'])
  assert.equal(source.summary.amount, '1234.5600')
  assert.match(source.description, /Concepto del pago/)
  assert.match(source.description, /Descripción canónica/)

  const other = await load(db, 'payment', 'payment_other')
  assertAllowed(other)
  assert.equal(other.contactId, 'contact_other')
  assert.equal(other.email, 'other@example.test')
  assert.deepEqual(other.productIds, ['product_other'])
})

test('el correo debe identificar exactamente un contacto activo sin distinguir mayúsculas', async t => {
  const db = await fixture(t)
  await db.run('UPDATE contacts SET email = ? WHERE id = ?', [' Student@Example.Test ', 'contact_one'])
  assertAllowed(await load(db))
  assert.equal((await load(db)).email, 'student@example.test')

  await insert(db, 'contacts', { id: 'duplicate', email: 'STUDENT@example.test' })
  assertBlocked(await load(db))
  await db.run('UPDATE contacts SET deleted_at = ? WHERE id = ?', ['2026-11-03 10:00:00', 'duplicate'])
  assertAllowed(await load(db))
})

test('un contacto archivado, inexistente o sin correo no puede preparar una inscripción', async t => {
  const db = await fixture(t)
  await db.run('UPDATE contacts SET deleted_at = ? WHERE id = ?', ['2026-11-03 10:00:00', 'contact_one'])
  assertBlocked(await load(db))
  await db.run('UPDATE contacts SET deleted_at = NULL, email = NULL WHERE id = ?', ['contact_one'])
  assertBlocked(await load(db))
  await db.run('UPDATE payments SET contact_id = ? WHERE id = ?', ['missing_contact', 'payment_one'])
  assertBlocked(await load(db))
})

test('todas las marcas explícitas de archivo o eliminación bloquean al contacto', async t => {
  const db = await fixture(t)
  for (const archive of [
    { archived_at: '2026-11-03 10:00:00' },
    { is_archived: 1 },
    { status: 'archived' },
    { status: 'deleted' }
  ]) {
    await db.run('UPDATE contacts SET archived_at = NULL, is_archived = 0, status = NULL WHERE id = ?', ['contact_one'])
    const [column, value] = Object.entries(archive)[0]
    await db.run(`UPDATE contacts SET ${column} = ? WHERE id = ?`, [value, 'contact_one'])
    assertBlocked(await load(db))
    assertBlocked(await load(db, 'plan'))
  }
})

test('el correo del plan debe coincidir con el contacto real, sin reasignarlo por email', async t => {
  const db = await fixture(t)
  await db.run('UPDATE payment_flows SET contact_email = ? WHERE id = ?', [' STUDENT@EXAMPLE.TEST ', 'plan_one'])
  assertAllowed(await load(db, 'plan'))
  await db.run('UPDATE payment_flows SET contact_email = ? WHERE id = ?', ['other@example.test', 'plan_one'])
  assertBlocked(await load(db, 'plan'))
  await db.run('UPDATE payment_flows SET contact_id = ? WHERE id = ?', ['missing_contact', 'plan_one'])
  assertBlocked(await load(db, 'plan'))
})

test('los pagos requieren modo live probado y un estado de éxito real', async t => {
  const db = await fixture(t)
  for (const mode of [null, '', 'unknown', 'manual_review', 'test', 'sandbox']) {
    await db.run('UPDATE payments SET payment_mode = ? WHERE id = ?', [mode, 'payment_one'])
    assertBlocked(await load(db))
  }
  await db.run('UPDATE payments SET payment_mode = ? WHERE id = ?', ['live', 'payment_one'])
  for (const status of ['pending', 'processing', 'failed', 'cancelled', 'refunded']) {
    await db.run('UPDATE payments SET status = ? WHERE id = ?', [status, 'payment_one'])
    assertBlocked(await load(db))
  }
  for (const status of ['paid', 'succeeded', 'completed']) {
    await db.run('UPDATE payments SET status = ? WHERE id = ?', [status, 'payment_one'])
    assertAllowed(await load(db))
  }
})

test('el modo de los planes proviene de evidencia guardada, sin default productivo', async t => {
  const db = await fixture(t)
  for (const metadata of [{ paymentMode: 'live' }, { stripeMode: 'live' }]) {
    await db.run('UPDATE payment_flows SET metadata = ? WHERE id = ?', [JSON.stringify(metadata), 'plan_one'])
    assertAllowed(await load(db, 'plan'))
    assert.equal((await load(db, 'plan')).summary.paymentMode, 'live')
  }
  for (const metadata of [null, {}, { paymentMode: null }, { paymentMode: 'unknown' }, { paymentMode: 'test' }, { stripeMode: 'test' }, { paymentMode: 'live', stripeMode: 'test' }]) {
    await db.run('UPDATE payment_flows SET metadata = ? WHERE id = ?', [metadata === null ? null : JSON.stringify(metadata), 'plan_one'])
    assertBlocked(await load(db, 'plan'))
  }
})

test('los modos booleanos rechazan miembros heredados, objetos y valores desconocidos', async t => {
  const db = await fixture(t)
  const malformed = [
    'constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty',
    {}, [], [true], { valueOf: true }, { toString: 'true' },
    'unknown', 'yes', '', null, 2, -1
  ]
  for (const field of ['liveMode', 'testMode', 'isLiveMode', 'isTestMode']) {
    for (const value of malformed) {
      const metadata = JSON.stringify({ [field]: value })
      await db.run('UPDATE payment_flows SET metadata = ? WHERE id = ?', [metadata, 'plan_one'])
      assertBlocked(await load(db, 'plan'))
      await db.run('UPDATE payments SET metadata_json = ? WHERE id = ?', [metadata, 'payment_one'])
      assertBlocked(await load(db))
    }
  }
})

test('los modos booleanos legítimos conservan la semántica live y test', async t => {
  const db = await fixture(t)
  for (const field of ['liveMode', 'testMode', 'isLiveMode', 'isTestMode']) {
    const inverse = ['testMode', 'isTestMode'].includes(field)
    for (const [value, boolean] of [
      [true, true], [false, false], ['true', true], ['false', false],
      [1, true], [0, false], ['1', true], ['0', false]
    ]) {
      await db.run('UPDATE payment_flows SET metadata = ? WHERE id = ?', [JSON.stringify({ [field]: value }), 'plan_one'])
      const source = await load(db, 'plan')
      const mode = boolean !== inverse ? 'live' : 'test'
      assert.equal(source.summary.paymentMode, mode)
      if (mode === 'live') assertAllowed(source)
      else assertBlocked(source)
    }
  }
})

test('el plan conserva concepto, título y descripción para la revisión comercial', async t => {
  const db = await fixture(t)
  await db.run('UPDATE payment_flows SET metadata = ? WHERE id = ?', [JSON.stringify({
    paymentMode: 'live', title: 'Título canónico del plan', description: 'Descripción comercial del plan'
  }), 'plan_one'])
  const source = await load(db, 'plan')
  assertAllowed(source)
  assert.match(source.description, /Programa en parcialidades/)
  assert.match(source.description, /Título canónico del plan/)
  assert.match(source.description, /Descripción comercial del plan/)
})

test('estados de plan o cuotas desconocidos bloquean y pausa o atraso conservan información', async t => {
  const db = await fixture(t)
  for (const status of [null, '', 'unknown', 'draft', 'cancelled']) {
    await db.run('UPDATE payment_flows SET current_state = ? WHERE id = ?', [status, 'plan_one'])
    assertBlocked(await load(db, 'plan'))
  }
  for (const status of ['active', 'paused', 'overdue']) {
    await db.run('UPDATE payment_flows SET current_state = ? WHERE id = ?', [status, 'plan_one'])
    const source = await load(db, 'plan')
    assertAllowed(source)
    assert.equal(source.summary.status, status)
    assert.equal(source.summary.totalAmount, '3000.0000')
  }
  await insert(db, 'installment_payments', {
    id: 'installment_unknown', flow_id: 'plan_one', sequence: 1,
    amount: '2000.00', status: 'pending', due_date: '2026-12-05'
  })
  assertAllowed(await load(db, 'plan'))
  for (const status of [null, '', 'unknown']) {
    await db.run('UPDATE installment_payments SET status = ? WHERE id = ?', [status, 'installment_unknown'])
    assertBlocked(await load(db, 'plan'))
  }
})

test('resuelve referencias explícitas locales y HighLevel del producto y precio, aunque no haya SKU', async t => {
  const db = await fixture(t)
  const references = [
    { productId: 'product_one' }, { product_id: 'product_one' },
    { localProductId: 'product_one' }, { local_product_id: 'product_one' },
    { ghlProductId: 'ghl_product_one' }, { ghl_product_id: 'ghl_product_one' },
    { priceId: 'price_one' }, { price_id: 'price_one' },
    { localPriceId: 'price_one' }, { local_price_id: 'price_one' },
    { ghlPriceId: 'ghl_price_one' }, { ghl_price_id: 'ghl_price_one' },
    { productIds: ['product_one'] }, { priceIds: ['ghl_price_one'] },
    { product: { id: 'ghl_product_one' } }, { price: { id: 'price_one' } }
  ]
  for (const reference of references) {
    for (const metadata of [reference, { lineItems: [reference] }, { line_items: [reference] }]) {
      await db.run('UPDATE payments SET metadata_json = ? WHERE id = ?', [JSON.stringify(metadata), 'payment_one'])
      const source = await load(db)
      assertAllowed(source)
      assert.deepEqual(source.productIds, ['product_one'])
    }
  }
})

test('bloquea producto y precio incompatibles, referencias desconocidas y productos mezclados', async t => {
  const db = await fixture(t)
  const invalidMetadata = [
    { lineItems: [{ productId: 'product_one', priceId: 'price_other' }] },
    { productId: 'does_not_exist' },
    { priceId: 'does_not_exist' },
    { lineItems: [{ productId: 'product_one' }, { productId: 'product_other' }] },
    { productId: 'product_one', lineItems: [{ productId: 'product_other' }] },
    { productId: 'product_one', localProductId: 'product_other' }
  ]
  for (const metadata of invalidMetadata) {
    await db.run('UPDATE payments SET metadata_json = ? WHERE id = ?', [JSON.stringify(metadata), 'payment_one'])
    assertBlocked(await load(db))
  }
})

test('un alias que identifica dos productos distintos es ambiguo y no elige la primera fila', async t => {
  const db = await fixture(t)
  await db.run('UPDATE products SET ghl_product_id = ? WHERE id = ?', ['product_one', 'product_other'])
  assertBlocked(await load(db))
})

test('sin referencias conserva productos vacíos y nunca los infiere por nombre, importe o SKU', async t => {
  const db = await fixture(t)
  await db.run('UPDATE payments SET title = ?, description = ?, metadata_json = ? WHERE id = ?', [
    'Programa principal', 'ghl_product_one price_one OTHER',
    JSON.stringify({ SKU: 'OTHER', product_name: 'Programa principal', amount: '1234.5600' }), 'payment_one'
  ])
  const source = await load(db)
  assertAllowed(source)
  assert.deepEqual(source.productIds, [])
})

test('el resumen conserva moneda histórica, importes originales y fechas UTC de SQLite', async t => {
  const db = await fixture(t)
  const source = await load(db)
  assertAllowed(source)
  assert.equal(source.summary.currency, 'EUR')
  assert.equal(source.summary.amount, '1234.5600')
  assert.equal(source.summary.paidAt, '2026-11-04T23:30:45.000Z')
  assert.equal(source.summary.dueDate, '2026-11-05')
  assert.equal(source.summary.dueDateKind, 'business_date')
})

test('los vencimientos de calendario conservan su día y los instantes su zona UTC explícita', async t => {
  const db = await fixture(t)
  await db.run('UPDATE payments SET paid_at = ?, due_date = ? WHERE id = ?', [
    '2026-11-05T00:30:00-06:00', '2026-11-05', 'payment_one'
  ])
  const calendar = await load(db)
  assertAllowed(calendar)
  assert.equal(calendar.summary.paidAt, '2026-11-05T06:30:00.000Z')
  assert.equal(calendar.summary.dueDate, '2026-11-05')
  assert.equal(calendar.summary.dueDateKind, 'business_date')
  await db.run('UPDATE payments SET due_date = ? WHERE id = ?', ['2026-11-05 00:30:00', 'payment_one'])
  const instant = await load(db)
  assertAllowed(instant)
  assert.equal(instant.summary.dueDate, '2026-11-05T00:30:00.000Z')
  assert.equal(instant.summary.dueDateKind, 'utc_instant')
  const dateDb = {
    ...db,
    async get(sql, params) {
      const row = await db.get(sql, params)
      return row?.due_date ? { ...row, due_date: new Date('2026-11-05T00:30:00.000Z') } : row
    }
  }
  const dateSource = await load(dateDb)
  assertAllowed(dateSource)
  assert.equal(dateSource.summary.dueDate, instant.summary.dueDate)
  assert.equal(dateSource.summary.dueDateKind, 'utc_instant')
  assert.equal(dateSource.revision, instant.revision)
  await db.run('UPDATE payments SET due_date = NULL WHERE id = ?', ['payment_one'])
  const absent = await load(db)
  assert.equal(absent.summary.dueDate, null)
  assert.equal(absent.summary.dueDateKind, null)
})

test('fechas de calendario imposibles y paidAt sin hora se bloquean', async t => {
  const db = await fixture(t)
  for (const dueDate of ['2026-02-30', '2026-13-01', '2026-00-05']) {
    await db.run('UPDATE payments SET due_date = ? WHERE id = ?', [dueDate, 'payment_one'])
    assertBlocked(await load(db))
  }
  await db.run('UPDATE payments SET due_date = ?, paid_at = ? WHERE id = ?', ['2026-11-05', '2026-11-04', 'payment_one'])
  assertBlocked(await load(db))
})

test('el plan resume cuotas canónicas en orden sin sumar pagos ni intentos duplicados', async t => {
  const db = await fixture(t)
  await db.run('UPDATE payment_flows SET first_payment_invoice_id = ?, first_payment_status = ? WHERE id = ?', ['payment_first', 'paid', 'plan_one'])
  await insert(db, 'payments', payment({ id: 'payment_first', amount: '1000.0000' }))
  await insert(db, 'payments', payment({ id: 'payment_second', amount: '1000.00' }))
  // An additional ledger attempt is not an installment and cannot increase totals.
  await insert(db, 'payments', payment({
    id: 'unlinked_attempt', amount: '999999.00', status: 'failed',
    metadata_json: JSON.stringify({ flowId: 'plan_one' })
  }))
  await insert(db, 'installment_payments', {
    id: 'installment_three', flow_id: 'plan_one', sequence: 3, payment_id: null,
    status: 'pending', amount: '1000.000', due_date: '2027-01-05'
  })
  await insert(db, 'installment_payments', {
    id: 'installment_two', flow_id: 'plan_one', sequence: 2, payment_id: 'payment_second',
    status: 'paid', amount: '1000.00', due_date: '2026-12-05 16:00:00'
  })
  const source = await load(db, 'plan')
  assertAllowed(source)
  assert.equal(source.summary.totalAmount, '3000.0000')
  assert.equal(source.summary.firstPayment.paymentId, 'payment_first')
  assert.equal(source.summary.firstPayment.amount, '1000.0000')
  assert.equal(source.summary.firstPayment.dueDate, '2026-11-04T23:30:45.000Z')
  assert.equal(source.summary.firstPayment.dueDateKind, 'utc_instant')
  assert.deepEqual(source.summary.installments.map(row => ({
    id: row.id, sequence: row.sequence, amount: row.amount,
    paymentId: row.paymentId, status: row.status, dueDate: row.dueDate, dueDateKind: row.dueDateKind
  })), [
    { id: 'installment_two', sequence: 2, amount: '1000.00', paymentId: 'payment_second', status: 'paid', dueDate: '2026-12-05T16:00:00.000Z', dueDateKind: 'utc_instant' },
    { id: 'installment_three', sequence: 3, amount: '1000.000', paymentId: null, status: 'pending', dueDate: '2027-01-05', dueDateKind: 'business_date' }
  ])
})

test('pagos vinculados a un plan deben conservar contacto, moneda, modo e identidad de cuota', async t => {
  const db = await fixture(t)
  await insert(db, 'payments', payment({ id: 'linked_payment' }))
  await insert(db, 'installment_payments', {
    id: 'linked_installment', flow_id: 'plan_one', sequence: 1,
    payment_id: 'linked_payment', status: 'paid', amount: '1234.5600', due_date: '2026-12-05'
  })
  assertAllowed(await load(db, 'plan'))
  for (const changes of [
    { contact_id: 'contact_other' },
    { currency: 'JPY' },
    { payment_mode: 'test' },
    { metadata_json: JSON.stringify({ paymentPlan: { flowId: 'another_plan' } }) },
    { metadata_json: JSON.stringify({ paymentPlan: { flowId: 'plan_one', installmentId: 'another_installment' } }) }
  ]) {
    await db.run('UPDATE payments SET contact_id = ?, currency = ?, payment_mode = ?, metadata_json = ? WHERE id = ?', [
      'contact_one', 'EUR', 'live', '{}', 'linked_payment'
    ])
    const [column, value] = Object.entries(changes)[0]
    await db.run(`UPDATE payments SET ${column} = ? WHERE id = ?`, [value, 'linked_payment'])
    assertBlocked(await load(db, 'plan'))
  }
})

test('el plan relaciona sólo pagos locales existentes y elimina duplicados al ordenar', async t => {
  const db = await relatedPlanFixture(t)
  const expected = [
    { sourceType: 'payment', sourceId: 'payment_one' },
    { sourceType: 'payment', sourceId: 'sibling_a' },
    { sourceType: 'payment', sourceId: 'sibling_z' }
  ]
  const source = await load(db, 'plan')
  assertAllowed(source)
  assertRelated(source, expected)
  assert.equal(source.parentSource, null)
  await insert(db, 'installment_payments', {
    id: 'missing_relation', flow_id: 'plan_one', sequence: 4,
    payment_id: 'missing_local_payment', status: 'pending', amount: '100.00'
  })
  const missing = await load(db, 'plan')
  assertBlocked(missing)
  assertRelated(missing, expected)
})

test('un pago hereda evidencia de un padre canónico y relaciona a sus hermanos sin incluirse', async t => {
  const db = await relatedPlanFixture(t)
  await db.run('UPDATE payments SET metadata_json = ? WHERE id = ?', ['{}', 'payment_one'])
  const source = await load(db)
  assertAllowed(source)
  assert.deepEqual(source.productIds, ['product_one'])
  assert.deepEqual(source.parentSource, { sourceType: 'plan', sourceId: 'plan_one' })
  assertRelated(source, [
    { sourceType: 'payment', sourceId: 'sibling_a' },
    { sourceType: 'payment', sourceId: 'sibling_z' },
    { sourceType: 'plan', sourceId: 'plan_one' }
  ])
  assert.match(source.description, /Programa en parcialidades/)
  assert.equal(source.summary.amount, '1234.5600')
  assert.equal(source.summary.paymentMode, 'live')
  assert.equal(source.contactId, 'contact_one')
  assert.equal(source.email, 'student@example.test')
})

test('la coincidencia por contacto, correo o metadata no inventa un padre', async t => {
  const db = await fixture(t)
  await db.run('UPDATE payments SET metadata_json = ? WHERE id = ?', [
    JSON.stringify({ paymentPlan: { flowId: 'plan_one' } }), 'payment_one'
  ])
  await db.run('UPDATE payment_flows SET current_state = ?, metadata = ? WHERE id = ?', [
    'cancelled', JSON.stringify({ paymentMode: 'test', productId: 'product_other' }), 'plan_one'
  ])
  const source = await load(db)
  assertAllowed(source)
  assert.deepEqual(source.productIds, [])
  assert.equal(source.parentSource, null)
  assertRelated(source, [])
  await db.run('UPDATE payment_flows SET concept = ? WHERE id = ?', ['Un plan ajeno cambió', 'plan_one'])
  assert.equal((await load(db)).revision, source.revision)
})

test('un padre repetido como primer pago y cuota sigue siendo un único padre', async t => {
  const db = await relatedPlanFixture(t)
  await insert(db, 'installment_payments', {
    id: 'duplicate_same_parent', flow_id: 'plan_one', sequence: 4,
    payment_id: 'payment_one', status: 'paid', amount: '1000.00'
  })
  const source = await load(db)
  assertAllowed(source)
  assert.deepEqual(source.parentSource, { sourceType: 'plan', sourceId: 'plan_one' })
  assert.equal(source.relatedSources.filter(row => row.sourceType === 'plan').length, 1)
})

test('el padre live nunca rescata un pago sin modo probado o sin éxito', async t => {
  const db = await relatedPlanFixture(t)
  for (const mode of [null, 'test', 'unknown']) {
    await db.run('UPDATE payments SET payment_mode = ? WHERE id = ?', [mode, 'payment_one'])
    assertBlocked(await load(db))
  }
  await db.run('UPDATE payments SET payment_mode = ? WHERE id = ?', ['live', 'payment_one'])
  for (const status of ['pending', 'failed', 'refunded']) {
    await db.run('UPDATE payments SET status = ? WHERE id = ?', [status, 'payment_one'])
    assertBlocked(await load(db))
  }
})

test('un padre bloqueado o con identidad, moneda o productos incompatibles bloquea también al hijo', async t => {
  const db = await relatedPlanFixture(t)
  const changes = [
    { current_state: 'cancelled' }, { current_state: 'unknown' }, { current_state: null },
    { metadata: JSON.stringify({ paymentMode: 'test' }) },
    { metadata: JSON.stringify({ paymentMode: 'unknown' }) },
    { metadata: JSON.stringify({ paymentMode: 'live', lineItems: [{ productId: 'product_one' }, { productId: 'product_other' }] }) },
    { metadata: JSON.stringify({ paymentMode: 'live', productId: 'product_other' }) },
    { contact_id: 'contact_other' }, { contact_email: 'other@example.test' }, { currency: 'JPY' }
  ]
  for (const change of changes) {
    await db.run('UPDATE payment_flows SET current_state = ?, metadata = ?, contact_id = ?, contact_email = ?, currency = ? WHERE id = ?', [
      'active', JSON.stringify({ paymentMode: 'live', productId: 'product_one' }),
      'contact_one', 'student@example.test', 'EUR', 'plan_one'
    ])
    const [column, value] = Object.entries(change)[0]
    await db.run(`UPDATE payment_flows SET ${column} = ? WHERE id = ?`, [value, 'plan_one'])
    const source = await load(db)
    assert.equal(source.blockedReason, 'parent_plan_unverified')
  }
})

test('dos padres por primer pago y cuota bloquean el pago y ambos planes', async t => {
  const db = await fixture(t)
  await db.run('UPDATE payment_flows SET first_payment_invoice_id = ? WHERE id = ?', ['payment_one', 'plan_one'])
  await insert(db, 'payment_flows', plan({ id: 'plan_two' }))
  await insert(db, 'installment_payments', {
    id: 'other_parent_installment', flow_id: 'plan_two', sequence: 1,
    payment_id: 'payment_one', status: 'paid', amount: '1234.5600'
  })
  for (const [sourceType, sourceId] of [['payment', 'payment_one'], ['plan', 'plan_one'], ['plan', 'plan_two']]) {
    assert.equal((await load(db, sourceType, sourceId)).blockedReason, 'payment_plan_ambiguous')
  }
})

test('dos padres por cuotas distintas no se resuelven eligiendo una fila conveniente', async t => {
  const db = await fixture(t)
  await insert(db, 'payment_flows', plan({ id: 'plan_two' }))
  for (const flowId of ['plan_one', 'plan_two']) {
    await insert(db, 'installment_payments', {
      id: `installment_${flowId}`, flow_id: flowId, sequence: 1,
      payment_id: 'payment_one', status: 'paid', amount: '1234.5600'
    })
  }
  assert.equal((await load(db)).blockedReason, 'payment_plan_ambiguous')
  assert.equal((await load(db, 'plan')).blockedReason, 'payment_plan_ambiguous')
})

test('la revisión del hijo incluye al padre y sus cuotas pero excluye pagos ajenos', async t => {
  const db = await relatedPlanFixture(t)
  const source = await load(db)
  assertAllowed(source)
  await db.run('UPDATE payment_flows SET concept = ? WHERE id = ?', ['Concepto actualizado del padre', 'plan_one'])
  const changedParent = await load(db)
  assertAllowed(changedParent)
  assert.notEqual(changedParent.revision, source.revision)
  await db.run('UPDATE installment_payments SET due_date = ? WHERE id = ?', ['2027-02-06', 'relation_2'])
  const changedInstallment = await load(db)
  assertAllowed(changedInstallment)
  assert.notEqual(changedInstallment.revision, changedParent.revision)
  await db.run('UPDATE payments SET amount = ? WHERE id = ?', ['9000000.00', 'unrelated_payment'])
  assert.equal((await load(db)).revision, changedInstallment.revision)
})

test('las relaciones y la evidencia se pueden cargar con un adaptador exclusivamente de lectura', async t => {
  const db = await relatedPlanFixture(t)
  const readOnlyDb = { get: db.get, all: db.all }
  assertAllowed(await load(readOnlyDb))
  assertAllowed(await load(readOnlyDb, 'plan'))
})

test('Date de PostgreSQL y texto UTC de SQLite producen el mismo instante y revisión', async t => {
  const db = await fixture(t)
  const sqliteSource = await load(db)
  const postgresLikeDb = {
    ...db,
    async get(sql, params) {
      const row = await db.get(sql, params)
      if (!row || !row.paid_at) return row
      return { ...row, paid_at: new Date('2026-11-04T23:30:45.000Z') }
    }
  }
  const postgresSource = await load(postgresLikeDb)
  assertAllowed(postgresSource)
  assert.equal(postgresSource.summary.paidAt, sqliteSource.summary.paidAt)
  assert.equal(postgresSource.revision, sqliteSource.revision)
})

test('el resumen no publica metadata, credenciales ni payloads internos de pasarelas', async t => {
  const db = await fixture(t)
  const metadata = {
    lineItems: [{ productId: 'product_one' }],
    secret: 'do-not-expose-source-secret',
    stripePaymentMethodId: 'do-not-expose-card-reference',
    rawPayload: { authorization: 'do-not-expose-authorization' }
  }
  await db.run('UPDATE payments SET metadata_json = ? WHERE id = ?', [JSON.stringify(metadata), 'payment_one'])
  const source = await load(db)
  assertAllowed(source)
  const summary = JSON.stringify(source.summary)
  assert.doesNotMatch(summary, /do-not-expose|metadata|rawPayload|stripePaymentMethodId|authorization/)
})

test('la revisión es estable al ordenar llaves JSON y cambia cuando cambia contacto o producto', async t => {
  const db = await fixture(t)
  const first = await load(db)
  await db.run('UPDATE payments SET metadata_json = ? WHERE id = ?', [
    JSON.stringify({ lineItems: [{ priceId: 'price_one', productId: 'product_one' }] }), 'payment_one'
  ])
  assert.equal((await load(db)).revision, first.revision)
  await db.run('UPDATE contacts SET email = ? WHERE id = ?', ['updated@example.test', 'contact_one'])
  const changedContact = await load(db)
  assertAllowed(changedContact)
  assert.notEqual(changedContact.revision, first.revision)
  await db.run('UPDATE payments SET metadata_json = ? WHERE id = ?', [
    JSON.stringify({ lineItems: [{ productId: 'product_other' }] }), 'payment_one'
  ])
  const changedProduct = await load(db)
  assertAllowed(changedProduct)
  assert.notEqual(changedProduct.revision, changedContact.revision)
  await db.run('UPDATE products SET name = ? WHERE id = ?', ['Programa con nombre actualizado', 'product_other'])
  assert.notEqual((await load(db)).revision, changedProduct.revision)
})

test('la revisión del plan cambia al editar una cuota sin depender de intentos ajenos', async t => {
  const db = await fixture(t)
  await insert(db, 'installment_payments', {
    id: 'installment_one', flow_id: 'plan_one', sequence: 1,
    status: 'pending', amount: '2000.00', due_date: '2026-12-05'
  })
  const first = await load(db, 'plan')
  await db.run('UPDATE installment_payments SET due_date = ? WHERE id = ?', ['2026-12-06', 'installment_one'])
  const changed = await load(db, 'plan')
  assert.notEqual(changed.revision, first.revision)
  await insert(db, 'payments', payment({ id: 'unrelated_attempt', amount: '4000.00', status: 'failed' }))
  assert.equal((await load(db, 'plan')).revision, changed.revision)
})

test('la revisión distingue fecha de negocio de un instante UTC de medianoche', async t => {
  const db = await fixture(t)
  const calendar = await load(db)
  await db.run('UPDATE payments SET due_date = ? WHERE id = ?', ['2026-11-05 00:00:00', 'payment_one'])
  const instant = await load(db)
  assert.equal(calendar.summary.dueDateKind, 'business_date')
  assert.equal(instant.summary.dueDateKind, 'utc_instant')
  assert.notEqual(instant.revision, calendar.revision)
})

test('acepta JSON ya decodificado del adaptador sin cambiar el snapshot', async t => {
  const db = await fixture(t)
  const expected = await load(db)
  const decodedDb = {
    ...db,
    async get(sql, params) {
      const row = await db.get(sql, params)
      if (!row) return row
      return {
        ...row,
        ...(row.metadata_json ? { metadata_json: JSON.parse(row.metadata_json) } : {}),
        ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {})
      }
    }
  }
  assert.deepEqual(await load(decodedDb), expected)
  assert.deepEqual(await load(decodedDb, 'plan'), await load(db, 'plan'))
})

test('una fuente inexistente devuelve un bloqueo y nunca usa otra fila como sustituto', async t => {
  const db = await fixture(t)
  for (const sourceType of ['payment', 'plan']) {
    const source = await load(db, sourceType, 'missing_source')
    assertBlocked(source)
    assert.equal(source.sourceType, sourceType)
    assert.equal(source.sourceId, 'missing_source')
    assert.deepEqual(source.summary, {})
    assertRelated(source, [])
    assert.equal(source.parentSource, null)
  }
})

test('lista fuentes por cursor de ID sin mezclar tipos ni hidratar datos privados', async t => {
  const db = await fixture(t)
  for (const id of ['payment_a', 'payment_c', 'payment_b']) {
    await insert(db, 'payments', payment({ id }))
  }
  const page = await listProgramPaymentSources(db, { sourceType: 'payment', limit: 2 })
  assert.deepEqual(page.items, [
    { sourceType: 'payment', sourceId: 'payment_a' },
    { sourceType: 'payment', sourceId: 'payment_b' }
  ])
  assert.equal(page.hasMore, true)
  assert.equal(page.nextAfterId, 'payment_b')
  const next = await listProgramPaymentSources(db, {
    sourceType: 'payment', afterId: page.nextAfterId, limit: 2
  })
  assert.deepEqual(next.items, [
    { sourceType: 'payment', sourceId: 'payment_c' },
    { sourceType: 'payment', sourceId: 'payment_one' }
  ])
  assert.equal(next.hasMore, false)
  const plans = await listProgramPaymentSources(db, { sourceType: 'plan', limit: 2 })
  assert.deepEqual(plans.items, [{ sourceType: 'plan', sourceId: 'plan_one' }])
  assert.equal(plans.hasMore, false)
})

test('la lista limita cada página a cien fuentes y detecta la fila adicional', async t => {
  const db = await fixture(t)
  for (let index = 0; index < 101; index += 1) {
    await insert(db, 'payments', payment({ id: `batch_${String(index).padStart(3, '0')}` }))
  }
  const page = await listProgramPaymentSources(db, { sourceType: 'payment', limit: 100 })
  assert.equal(page.items.length, 100)
  assert.equal(page.hasMore, true)
  assert.equal(page.nextAfterId, page.items.at(-1).sourceId)
  const tail = await listProgramPaymentSources(db, {
    sourceType: 'payment', afterId: page.nextAfterId, limit: 100
  })
  assert.equal(tail.items.length, 2)
  assert.equal(tail.hasMore, false)
  assert.equal(new Set([...page.items, ...tail.items].map(item => item.sourceId)).size, 102)
})

test('rechaza tipos de fuente, IDs y límites inválidos antes de consultar fuentes', async t => {
  const db = await fixture(t)
  for (const sourceType of [undefined, 'subscription', 'payments']) {
    await assert.rejects(loadProgramPaymentSource(db, { sourceType, sourceId: 'payment_one' }))
    await assert.rejects(listProgramPaymentSources(db, { sourceType, limit: 10 }))
  }
  for (const sourceId of [undefined, null, '', '   ']) {
    await assert.rejects(loadProgramPaymentSource(db, { sourceType: 'payment', sourceId }))
  }
  for (const limit of [0, -1, 1.5, 101, 1000]) {
    await assert.rejects(listProgramPaymentSources(db, { sourceType: 'payment', limit }))
  }
})
