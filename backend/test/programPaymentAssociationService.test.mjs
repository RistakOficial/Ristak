import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import sqlite3 from 'sqlite3'
import { createProgramPaymentAssociationService } from '../src/services/programPaymentAssociationService.js'

const actor = { user: { id: 'admin-fixture' } }
const args = { sourceType: 'payment', sourceId: 'payment-1' }

async function fixture(t) {
  const sqlite = new sqlite3.Database(':memory:')
  const db = {
    run: (sql, params = []) => new Promise((resolve, reject) => sqlite.run(sql, params, function (err) { err ? reject(err) : resolve({ changes: this.changes }) })),
    get: (sql, params = []) => new Promise((resolve, reject) => sqlite.get(sql, params, (err, row) => err ? reject(err) : resolve(row))),
    all: (sql, params = []) => new Promise((resolve, reject) => sqlite.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows))),
    exec: sql => new Promise((resolve, reject) => sqlite.exec(sql, err => err ? reject(err) : resolve())),
    async transaction(fn) {
      await db.exec('BEGIN IMMEDIATE')
      try { const result = await fn(db); await db.exec('COMMIT'); return result }
      catch (err) { await db.exec('ROLLBACK'); throw err }
    }
  }
  t.after(() => new Promise((resolve, reject) => sqlite.close(err => err ? reject(err) : resolve())))
  await db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, is_active INTEGER);
    CREATE TABLE payments (id TEXT PRIMARY KEY);
    CREATE TABLE installment_payments (id TEXT PRIMARY KEY, payment_id TEXT, flow_id TEXT);
    INSERT INTO products VALUES ('product-1', 'Programa fixture', 1), ('product-2', 'Otro programa', 1);
    INSERT INTO payments VALUES ('payment-1'), ('payment-2'), ('payment-3');`)
  await db.exec(await readFile(new URL('../migrations/versioned/170_program_payment_associations.sql', import.meta.url), 'utf8'))
  const source = {
    ...args, contactId: 'contact-1', email: 'alumno@example.test',
    productIds: ['product-1'], blockedReason: null, description: 'Magnetismo pacientes tres meses', revision: 'revision-1',
    summary: { status: 'paid', paymentMode: 'live', currency: 'EUR', amount: '100.00', dueDate: '2026-11-05T15:00:00.000Z' }
  }
  const student = { id: 'student-1', email: 'alumno@example.test', active: true, enrollments: [
    { id: 'enrollment-1', userId: 'student-1', programId: 'program-1', status: 'expired', startAt: '2026-05-01', endAt: '2026-08-01' }
  ] }
  const calls = []
  const target = {
    targetKey: 'configured-account-fixture',
    async getProgram(id) { calls.push('program'); return { id, title: 'Programa fixture' } },
    async getStudent(email) { calls.push(['student', email]); return structuredClone(student) },
    async getProgress() { calls.push('progress'); return { summary: { avgWatchPct: 40 } } }
  }
  const s = createProgramPaymentAssociationService({ db, target, loadSource: async (_db, ref) => ({ ...structuredClone(source), sourceType: ref.sourceType, sourceId: ref.sourceId }) })
  async function map(productId = 'product-1', programId = 'program-1') {
    return s.createMapping(actor, { productId, programId, reason: 'Decisión del administrador fixture.', dryRun: false })
  }
  return { s, db, source, student, calls, target, map }
}

test('mapping validates exact program, defaults to preview and is durable/idempotent with one audit', async t => {
  const { s, db, map, target } = await fixture(t)
  const mappingArgs = { productId: 'product-1', programId: 'program-1', reason: 'Vincular producto aprobado.' }
  assert.equal((await s.createMapping(actor, mappingArgs)).state, 'preview')
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM program_payment_product_mappings')).n, 0)
  assert.equal((await map()).state, 'mapped')
  assert.equal((await map()).state, 'already_mapped')
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM program_payment_association_events')).n, 1)
  await assert.rejects(map('product-1', 'program-other'), { code: 'mapping_conflict' })
  target.getProgram = async () => ({ id: 'wrong-program', title: 'wrong' })
  await assert.rejects(map('product-2'), { code: 'program_unverified' })
})

test('preview/apply links existing expired access without mutating payment, dates, or student', async t => {
  const { s, db, student, map } = await fixture(t)
  await map()
  const before = structuredClone(student)
  const preview = await s.preview(args)
  assert.equal(preview.state, 'ready')
  assert.equal(preview._row, undefined)
  assert.equal(preview.access.status, 'expired')
  assert.equal(preview.accessAction, 'none')
  assert.equal((await s.link(actor, args)).dryRun, true)
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM program_payment_associations')).n, 0)
  const applyArgs = { ...args, dryRun: false, expectedFingerprint: preview.fingerprint }
  assert.equal((await s.link(actor, applyArgs)).state, 'linked')
  assert.equal((await s.link(actor, applyArgs)).state, 'already_linked')
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM program_payment_associations')).n, 1)
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM program_payment_association_events WHERE event_type = 'association_created'")).n, 1)
  assert.deepEqual(student, before)
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM payments')).n, 3)
})

test('Marco consultation and description-only program require decision before any student read', async t => {
  const { s, source, calls, map } = await fixture(t)
  await map()
  calls.length = 0
  source.description = 'Consulta individual de Marco'
  assert.equal((await s.preview(args)).reason, 'separate_service_description')
  source.description = 'Magnetismo pacientes plan total cuatro meses'
  source.productIds = []
  assert.equal((await s.preview(args)).reason, 'missing_product_reference')
  assert.equal((await s.link(actor, { ...args, dryRun: false })).state, 'needs_decision')
  assert.deepEqual(calls, [])
})

test('manual decision is explicit, bound into preview and cannot override another explicit product', async t => {
  const { s, source, map } = await fixture(t)
  await map()
  source.productIds = []
  const decision = { confirmed: true, productId: 'product-1', reason: 'El administrador confirma que esta fuente es del programa.' }
  const preview = await s.preview({ ...args, decision })
  assert.equal(preview.classification, 'user_decision')
  assert.equal((await s.link(actor, { ...args, decision, dryRun: false, expectedFingerprint: preview.fingerprint })).state, 'linked')
  const different = { ...decision, reason: 'Otra decisión distinta para la fuente.' }
  await assert.rejects(s.link(actor, { ...args, decision: different, dryRun: false, expectedFingerprint: preview.fingerprint }), { code: 'stale_association_preview' })
  source.productIds = ['product-2']
  assert.equal((await s.preview({ ...args, decision })).reason, 'product_decision_conflict')
  await assert.rejects(s.preview({ ...args, decision: { ...decision, confirmed: false } }), { code: 'invalid_decision' })
})

test('failed/unknown/test source and mixed products never fall through to a link', async t => {
  const { s, source, db, map } = await fixture(t)
  await map()
  for (const blockedReason of ['payment_not_successful', 'payment_mode_unknown', 'payment_mode_test', 'contact_email_ambiguous']) {
    source.blockedReason = blockedReason
    assert.equal((await s.link(actor, { ...args, dryRun: false })).reason, blockedReason)
  }
  source.blockedReason = null
  source.productIds = ['product-1', 'product-2']
  assert.equal((await s.preview(args)).reason, 'mixed_products')
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM program_payment_associations')).n, 0)
})

test('exact verified active identity and one known existing enrollment are required', async t => {
  const { s, student, map } = await fixture(t)
  await map()
  student.email = 'homonym@example.test'
  await assert.rejects(s.preview(args), { code: 'student_identity_unverified' })
  student.email = 'alumno@example.test'
  student.active = false
  await assert.rejects(s.preview(args), { code: 'student_identity_unverified' })
  student.active = true
  const access = student.enrollments[0]
  access.status = 'surprise'
  await assert.rejects(s.preview(args), { code: 'enrollment_unverified' })
  access.status = 'paused'
  student.enrollments.push({ ...access, id: 'second-enrollment' })
  await assert.rejects(s.preview(args), { code: 'enrollment_unverified' })
  assert.equal((await s.preview({ ...args, enrollmentId: 'second-enrollment' })).enrollmentId, 'second-enrollment')
  student.enrollments = []
  await assert.rejects(s.preview(args), { code: 'enrollment_unverified' })
})

test('apply detects stale source/remote snapshot and refuses automatic re-assignment', async t => {
  const { s, source, student, db, map } = await fixture(t)
  await map()
  const preview = await s.preview(args)
  source.revision = 'new-source-revision'
  await assert.rejects(s.link(actor, { ...args, dryRun: false, expectedFingerprint: preview.fingerprint }), { code: 'stale_association_preview' })
  source.revision = 'revision-1'
  student.enrollments[0].endAt = '2026-09-01'
  await assert.rejects(s.link(actor, { ...args, dryRun: false, expectedFingerprint: preview.fingerprint }), { code: 'stale_association_preview' })
  const fresh = await s.preview(args)
  await s.link(actor, { ...args, dryRun: false, expectedFingerprint: fresh.fingerprint })
  student.id = 'student-new'
  student.enrollments[0].userId = student.id
  await assert.rejects(s.preview(args), { code: 'association_conflict' })
  assert.equal((await db.get('SELECT student_id FROM program_payment_associations')).student_id, 'student-1')
})

test('context preserves financial/access dates separately and flags current source state', async t => {
  const { s, source, map, calls } = await fixture(t)
  await map()
  const preview = await s.preview(args)
  await s.link(actor, { ...args, dryRun: false, expectedFingerprint: preview.fingerprint })
  source.revision = 'refunded-source'
  source.blockedReason = 'payment_not_successful'
  const result = await s.context({ ...args, includeProgress: true })
  assert.equal(result.sourceChanged, true)
  assert.equal(result.reviewReason, 'payment_not_successful')
  assert.equal(result.source.dueDate, '2026-11-05T15:00:00.000Z')
  assert.equal(result.access.endAt, '2026-08-01')
  assert.equal(result.progress.summary.avgWatchPct, 40)
  assert.equal(result.accessAction, 'none')
  calls.length = 0
  source.email = 'changed@example.test'
  assert.equal((await s.context(args)).reviewReason, 'source_identity_changed')
  assert.deepEqual(calls, [])
})

test('target endpoint is pinned, pagination is stable and local worklist needs no remote read', async t => {
  const { s, target, calls, map } = await fixture(t)
  await map()
  calls.length = 0
  const review = await s.review({ sourceType: 'payment', limit: 2 })
  assert.equal(review.hasMore, true)
  assert.equal(review.nextAfterId, 'payment-2')
  assert.equal(review.items[0].state, 'ready')
  const final = await s.review({ sourceType: 'payment', afterId: review.nextAfterId, limit: 2 })
  assert.deepEqual(final.items.map(item => item.sourceId), ['payment-3'])
  assert.equal(final.hasMore, false)
  assert.deepEqual(calls, [])
  target.targetKey = 'other-account'
  await assert.rejects(s.preview(args), { code: 'target_account_changed' })
  assert.equal((await s.list({ kind: 'mappings' })).items[0].targetConfiguredMatches, false)
})

test('source races are rejected and a missing audit rolls back the entire association', async t => {
  const { s, db, source, map } = await fixture(t)
  await map()
  const preview = await s.preview(args)
  const originalTransaction = db.transaction
  db.transaction = async fn => {
    source.revision = 'changed-after-remote-read'
    return originalTransaction(fn)
  }
  await assert.rejects(s.link(actor, { ...args, dryRun: false, expectedFingerprint: preview.fingerprint }), { code: 'source_changed' })
  db.transaction = originalTransaction
  source.revision = 'revision-1'
  await db.exec(`CREATE TRIGGER fail_association_audit BEFORE INSERT ON program_payment_association_events
    WHEN NEW.event_type = 'association_created' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`)
  await assert.rejects(s.link(actor, { ...args, dryRun: false, expectedFingerprint: preview.fingerprint }), /audit unavailable/)
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM program_payment_associations')).n, 0)
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM program_payment_association_events WHERE event_type = 'association_created'")).n, 0)
})

test('a plan and its canonical payments cannot point to different enrollments', async t => {
  const { s, source, student, map } = await fixture(t)
  await map()
  source.relatedSources = [{ sourceType: 'plan', sourceId: 'plan-1' }]
  const preview = await s.preview(args)
  await s.link(actor, { ...args, dryRun: false, expectedFingerprint: preview.fingerprint })
  source.relatedSources = [{ sourceType: 'payment', sourceId: 'payment-1' }]
  student.enrollments.push({ ...student.enrollments[0], id: 'enrollment-2' })
  await assert.rejects(s.preview({ sourceType: 'plan', sourceId: 'plan-1', enrollmentId: 'enrollment-2' }), { code: 'related_association_conflict' })
  const same = await s.preview({ sourceType: 'plan', sourceId: 'plan-1', enrollmentId: 'enrollment-1' })
  assert.equal(same.state, 'ready')
})

test('historical mapping does not prevent existing catalog mirror pruning', async t => {
  const { s, db, map } = await fixture(t)
  await map()
  await db.run('DELETE FROM products WHERE id = ?', ['product-1'])
  assert.equal((await s.list({ kind: 'mappings' })).items.length, 1)
  assert.equal((await s.preview(args)).reason, 'product_inactive')
})
