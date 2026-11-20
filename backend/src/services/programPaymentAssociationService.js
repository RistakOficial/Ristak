import { createHash, randomUUID } from 'node:crypto'
import { loadProgramPaymentSource, listProgramPaymentSources } from './programPaymentSourceService.js'

const ENROLLMENT_STATUSES = new Set(['active', 'expired', 'paused', 'cancelled', 'extended'])
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = value => String(value ?? '').trim()
const email = value => text(value).toLowerCase()
const insertedRow = result => Number(result?.changes ?? result?.rowCount) === 1

function fail(code, message, status = 409) {
  const error = new Error(message)
  Object.assign(error, { code, status })
  throw error
}

function actor(context) {
  if (!context?.user?.id) fail('actor_required', 'Falta el usuario autenticado.', 401)
  return String(context.user.id)
}

function reason(value) {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 500) {
    fail('decision_reason_required', 'Describe la decisión explícita en 8 a 500 caracteres.', 400)
  }
  return value.trim()
}

function sameLink(existing, candidate) {
  return ['source_type', 'source_id', 'contact_id', 'email', 'product_id', 'target_key',
    'program_id', 'student_id', 'enrollment_id'].every(key => existing[key] === candidate[key])
}

function sameDestination(existing, candidate) {
  return ['product_id', 'target_key', 'program_id', 'student_id', 'enrollment_id', 'contact_id', 'email']
    .every(key => existing[key] === candidate[key])
}

function publicLink(row) {
  if (!row) return null
  return {
    id: row.id, sourceType: row.source_type, sourceId: row.source_id,
    contactId: row.contact_id, productId: row.product_id,
    programId: row.program_id, studentId: row.student_id, enrollmentId: row.enrollment_id,
    classification: row.classification, createdBy: row.created_by
  }
}

function enrollmentSnapshot(student, access) {
  return {
    studentId: student.id, email: email(student.email), active: student.active,
    enrollmentId: access.id, userId: access.userId, programId: access.programId,
    status: access.status, startAt: access.startAt ?? null, endAt: access.endAt ?? null
  }
}

function exactStudent(student, sourceEmail) {
  if (!student?.id || email(student.email) !== sourceEmail || student.active !== true) {
    fail('student_identity_unverified', 'No se pudo verificar un alumno activo con el mismo correo exacto.')
  }
}

function selectEnrollment(student, programId, enrollmentId) {
  const matching = (student.enrollments || []).filter(access => (
    access.programId === programId && access.userId === student.id
    && (!enrollmentId || access.id === enrollmentId)
  ))
  if (matching.length !== 1 || !matching[0].id || !ENROLLMENT_STATUSES.has(matching[0].status)) {
    fail('enrollment_unverified', 'La inscripción existente falta, es ambigua o tiene un estado desconocido. Indica su ID si hay varias.')
  }
  return matching[0]
}

/** target only exposes read methods. This service never grants/suspends access. */
export function createProgramPaymentAssociationService({ db, target, dialect = 'sqlite', loadSource = loadProgramPaymentSource }) {
  const findLink = (conn, sourceType, sourceId) => conn.get(
    'SELECT * FROM program_payment_associations WHERE source_type = ? AND source_id = ?', [sourceType, sourceId]
  )

  async function mappingFor(conn, productId) {
    return conn.get('SELECT * FROM program_payment_product_mappings WHERE product_id = ?', [productId])
  }

  async function assertRelatedLinks(conn, source, candidate) {
    // Parent plan and its canonical payments must describe the same purchase.
    // Never infer these relationships merely from contact, amount or date.
    const refs = source.relatedSources || []
    for (const type of ['payment', 'plan']) {
      const ids = [...new Set(refs.filter(ref => ref.sourceType === type).map(ref => ref.sourceId))]
      for (let start = 0; start < ids.length; start += 100) {
        const chunk = ids.slice(start, start + 100)
        const linked = await conn.all(`SELECT * FROM program_payment_associations
          WHERE source_type = ? AND source_id IN (${chunk.map(() => '?').join(', ')})`, [type, ...chunk])
        if (linked.some(row => !sameDestination(row, candidate))) {
          fail('related_association_conflict', 'El plan o un pago relacionado ya tiene otro producto, alumno o inscripción. Requiere revisión.')
        }
      }
    }
  }

  async function classify(source, decision) {
    if (source.blockedReason) return { state: 'blocked', reason: source.blockedReason }
    if (decision && (decision.confirmed !== true || !text(decision.productId))) {
      fail('invalid_decision', 'La decisión necesita confirmed=true y el ID local del producto.', 400)
    }
    if (decision) reason(decision.reason)
    if (source.productIds.length > 1) return { state: 'blocked', reason: 'mixed_products' }
    if (source.productIds.length && decision && decision.productId !== source.productIds[0]) {
      return { state: 'blocked', reason: 'product_decision_conflict' }
    }
    const description = String(source.description || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const separateService = /\bconsulta\b|\basesoria individual\b|\bsesion individual\b/.test(description)
    if ((!source.productIds.length || separateService) && !decision) {
      return { state: 'needs_decision', reason: separateService ? 'separate_service_description' : 'missing_product_reference' }
    }
    const productId = source.productIds[0] || decision.productId
    const mapping = await mappingFor(db, productId)
    if (!mapping) return { state: 'needs_decision', reason: 'product_not_mapped', productId }
    const product = await db.get('SELECT id, is_active FROM products WHERE id = ?', [productId])
    if (!product || ![true, 1].includes(product.is_active)) return { state: 'blocked', reason: 'product_inactive' }
    return { state: 'ready', productId, mapping, classification: decision ? 'user_decision' : 'explicit_product' }
  }

  async function createMapping(context, args) {
    const actorId = actor(context)
    const decisionReason = reason(args.reason)
    const product = await db.get('SELECT id, name, is_active FROM products WHERE id = ?', [args.productId])
    if (!product || ![true, 1].includes(product.is_active)) fail('product_not_found', 'El ID debe ser de un producto local activo.', 404)
    const program = await target.getProgram(args.programId)
    if (program?.id !== args.programId) fail('program_unverified', 'El programa remoto no coincide con el ID solicitado.')
    const candidate = {
      product_id: product.id, target_key: target.targetKey, program_id: program.id, program_title: program.title
    }
    const existing = await mappingFor(db, product.id)
    if (existing && (existing.target_key !== candidate.target_key || existing.program_id !== candidate.program_id)) {
      fail('mapping_conflict', 'Este producto ya apunta a otro programa o cuenta. No se reasigna automáticamente.')
    }
    const result = { success: true, productId: product.id, productName: product.name, programId: program.id, programTitle: program.title }
    if (args.dryRun !== false) return { ...result, state: existing ? 'already_mapped' : 'preview', dryRun: true }
    return db.transaction(async tx => {
      const freshProduct = await tx.get(`SELECT id, is_active FROM products WHERE id = ?${dialect === 'postgres' ? ' FOR UPDATE' : ''}`, [product.id])
      if (!freshProduct || ![true, 1].includes(freshProduct.is_active)) fail('product_inactive', 'El producto dejó de estar activo.')
      const insert = await tx.run(
        `INSERT INTO program_payment_product_mappings
         (product_id, target_key, program_id, program_title, created_by)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (product_id) DO NOTHING`,
        [product.id, target.targetKey, program.id, program.title, actorId]
      )
      const saved = await mappingFor(tx, product.id)
      if (saved.target_key !== target.targetKey || saved.program_id !== program.id) fail('mapping_conflict', 'Otra asociación fue guardada para este producto.')
      if (insertedRow(insert)) await tx.run(
        `INSERT INTO program_payment_association_events
         (id, event_type, product_id, actor_id, reason, fingerprint) VALUES (?, 'mapping_created', ?, ?, ?, ?)`,
        [randomUUID(), product.id, actorId, decisionReason, hash(candidate)]
      )
      return { ...result, state: insertedRow(insert) ? 'mapped' : 'already_mapped', dryRun: false }
    })
  }

  async function preview(args) {
    const source = await loadSource(db, args)
    const classified = await classify(source, args.decision)
    const existing = await findLink(db, args.sourceType, args.sourceId)
    const base = { success: true, source: source.summary, sourceRevision: source.revision, existing: publicLink(existing) }
    if (classified.state !== 'ready') return { ...base, ...classified, accessAction: 'none' }
    if (classified.mapping.target_key !== target.targetKey) fail('target_account_changed', 'La conexión Magnetismo no coincide con la cuenta del vínculo de producto.')
    const program = await target.getProgram(classified.mapping.program_id)
    if (program?.id !== classified.mapping.program_id) fail('program_unverified', 'El programa remoto ya no coincide.')
    const student = await target.getStudent(source.email)
    exactStudent(student, source.email)
    const access = selectEnrollment(student, program.id, args.enrollmentId)
    const verified = enrollmentSnapshot(student, access)
    const row = {
      source_type: source.sourceType, source_id: source.sourceId,
      contact_id: source.contactId, email: source.email, product_id: classified.productId,
      target_key: target.targetKey, program_id: program.id,
      student_id: student.id, enrollment_id: access.id,
      source_revision: source.revision, classification: classified.classification
    }
    if (existing && !sameLink(existing, row)) fail('association_conflict', 'La fuente ya está vinculada a otra identidad o inscripción. No se reasigna automáticamente.')
    await assertRelatedLinks(db, source, row)
    const fingerprint = hash({ row, verified, decisionReason: args.decision?.reason?.trim() || null })
    return { ...base, state: existing ? 'already_linked' : 'ready', fingerprint,
      productId: classified.productId, programId: program.id,
      studentId: student.id, enrollmentId: access.id, access: verified,
      classification: classified.classification, accessAction: 'none', _row: row }
  }

  async function link(context, args) {
    const actorId = actor(context)
    const prepared = await preview(args)
    const { _row: candidate, ...result } = prepared
    if (args.dryRun !== false || !candidate) return { ...result, dryRun: true }
    if (!args.expectedFingerprint || prepared.fingerprint !== args.expectedFingerprint) {
      fail('stale_association_preview', 'La fuente o inscripción cambió. Revisa una nueva vista previa antes de asociar.')
    }
    return db.transaction(async tx => {
      if (dialect === 'postgres') {
        // Include predicate reads (duplicate emails/catalog aliases and plan
        // children) in one serializable snapshot. Serialization failure aborts
        // the association; it never authorizes a stale or partial write.
        await tx.run('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
        const table = args.sourceType === 'payment' ? 'payments' : 'payment_flows'
        await tx.get(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [args.sourceId])
        await tx.get('SELECT id FROM contacts WHERE id = ? FOR UPDATE', [candidate.contact_id])
      }
      const current = await loadSource(tx, args)
      if (current.revision !== candidate.source_revision || current.blockedReason) {
        fail('source_changed', 'La fuente cambió durante la verificación. Revisa de nuevo.')
      }
      await assertRelatedLinks(tx, current, candidate)
      const mapping = await mappingFor(tx, candidate.product_id)
      if (!mapping || mapping.target_key !== candidate.target_key || mapping.program_id !== candidate.program_id) {
        fail('mapping_changed', 'El vínculo de producto cambió durante la verificación.')
      }
      const product = await tx.get(`SELECT id, is_active FROM products WHERE id = ?${dialect === 'postgres' ? ' FOR UPDATE' : ''}`, [candidate.product_id])
      if (!product || ![true, 1].includes(product.is_active)) fail('product_inactive', 'El producto dejó de estar activo.')
      const id = randomUUID()
      const insert = await tx.run(
        `INSERT INTO program_payment_associations
         (id, source_type, source_id, contact_id, email, product_id, target_key, program_id,
          student_id, enrollment_id, source_revision, fingerprint, classification, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_type, source_id) DO NOTHING`,
        [id, candidate.source_type, candidate.source_id, candidate.contact_id, candidate.email,
          candidate.product_id, candidate.target_key, candidate.program_id, candidate.student_id,
          candidate.enrollment_id, candidate.source_revision, prepared.fingerprint, candidate.classification, actorId]
      )
      const saved = await findLink(tx, args.sourceType, args.sourceId)
      if (!sameLink(saved, candidate)) fail('association_conflict', 'Otra identidad o inscripción fue asociada concurrentemente.')
      if (insertedRow(insert)) await tx.run(
        `INSERT INTO program_payment_association_events
         (id, event_type, association_id, product_id, source_type, source_id, actor_id, reason, fingerprint)
         VALUES (?, 'association_created', ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), saved.id, candidate.product_id, candidate.source_type, candidate.source_id,
          actorId, args.decision ? reason(args.decision.reason) : 'Referencia explícita de producto verificada.', prepared.fingerprint]
      )
      return { ...result, existing: publicLink(saved), state: insertedRow(insert) ? 'linked' : 'already_linked', dryRun: false }
    })
  }

  async function review(args) {
    const page = await listProgramPaymentSources(db, args)
    const items = []
    for (const ref of page.items) {
      const source = await loadSource(db, ref)
      const classification = await classify(source)
      const existing = await findLink(db, ref.sourceType, ref.sourceId)
      items.push({ ...ref, source: source.summary, sourceRevision: source.revision,
        state: existing ? 'linked_review_context' : classification.state,
        reason: classification.reason || null, productId: classification.productId || null,
        existing: publicLink(existing), accessAction: 'none' })
    }
    return { success: true, ...page, items, targetVerificationRequired: true }
  }

  async function context(args) {
    const existing = await findLink(db, args.sourceType, args.sourceId)
    if (!existing) fail('association_not_found', 'La fuente aún no está asociada.', 404)
    const source = await loadSource(db, args)
    const result = { success: true, association: publicLink(existing), source: source.summary,
      sourceChanged: source.revision !== existing.source_revision, reviewReason: source.blockedReason, accessAction: 'none' }
    if (source.contactId !== existing.contact_id || source.email !== existing.email) {
      return { ...result, reviewReason: 'source_identity_changed', targetVerified: false }
    }
    if (existing.target_key !== target.targetKey) fail('target_account_changed', 'La conexión Magnetismo cambió de cuenta.')
    const student = await target.getStudent(source.email)
    exactStudent(student, source.email)
    if (student.id !== existing.student_id) fail('student_identity_changed', 'El mismo correo ahora pertenece a otro alumno.')
    const access = selectEnrollment(student, existing.program_id, existing.enrollment_id)
    const progress = args.includeProgress === true ? await target.getProgress(student.id, existing.program_id) : undefined
    return { ...result, targetVerified: true, access: enrollmentSnapshot(student, access), ...(progress ? { progress } : {}) }
  }

  async function list({ kind, afterId = '', limit = 50 }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_limit', 'El límite debe ser de 1 a 100.', 400)
    const mappings = kind === 'mappings'
    const key = mappings ? 'product_id' : 'id'
    const table = mappings ? 'program_payment_product_mappings' : 'program_payment_associations'
    let targetKey = null
    let connectionError = null
    if (mappings) {
      try { targetKey = target.targetKey } catch (error) {
        if (!['target_not_configured', 'target_configuration_invalid'].includes(error.code)) throw error
        connectionError = error.code
      }
    }
    const rows = await db.all(`SELECT * FROM ${table} WHERE ${key} > ? ORDER BY ${key} ASC LIMIT ?`, [afterId, limit + 1])
    const page = rows.slice(0, limit)
    return { success: true, items: page.map(row => mappings ? {
      productId: row.product_id, programId: row.program_id, programTitle: row.program_title,
      targetConfiguredMatches: row.target_key === targetKey, createdBy: row.created_by
    } : publicLink(row)), hasMore: rows.length > limit, nextAfterId: rows.length > limit ? page.at(-1)[key] : null,
      ...(connectionError ? { connectionError } : {}) }
  }

  return { createMapping, link, review, context, list,
    async preview(args) { const { _row, ...result } = await preview(args); return result } }
}
