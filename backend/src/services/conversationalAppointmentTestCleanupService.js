import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import * as googleCalendarService from './googleCalendarService.js'
import * as highlevelCalendarService from './highlevelCalendarService.js'
import * as localCalendarService from './localCalendarService.js'
import { withConversationalAgentTestMutationLock } from './conversationalAgentTestMutationLockService.js'

const TEST_APPOINTMENT_CLEANUP_LIMIT = 100
const TEST_APPOINTMENT_CLEANUP_LEASE_MS = 2 * 60 * 1000

let deleteConversationalTestGoogleEventFromReceiptImpl =
  googleCalendarService.deleteConversationalTestGoogleEventFromReceipt
let deleteHighLevelEventImpl = highlevelCalendarService.deleteEvent
let getHighLevelCalendarEventsImpl = highlevelCalendarService.getCalendarEvents
let getHighLevelAccessTokenImpl = async () => {
  const config = await db.get('SELECT api_token FROM highlevel_config LIMIT 1').catch(() => null)
  return cleanString(config?.api_token)
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function mutationCount(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

function cleanupError(message, code, status = 409) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

async function getTestAppointmentRow(appointmentId) {
  return db.get(`
    SELECT id, calendar_id, is_test, test_run_id, test_effect_id, test_expires_at,
      ghl_appointment_id, google_event_id, contact_id, sync_status, deleted_at
    FROM appointments
    WHERE id = ?
    LIMIT 1
  `, [appointmentId])
}

async function getTestEffect(effectId) {
  return db.get(`
    SELECT e.id, e.run_id, e.effect_type, e.entity_id, e.cleanup_status,
      r.contact_id, r.agent_id, r.requested_by_user_id
    FROM conversational_agent_test_effects e
    INNER JOIN conversational_agent_test_runs r ON r.id = e.run_id
    WHERE e.id = ?
    LIMIT 1
  `, [effectId])
}

async function getProviderReceipts(effectId) {
  return db.all(`
    SELECT *
    FROM conversational_appointment_test_provider_receipts
    WHERE test_effect_id = ?
    ORDER BY created_at ASC, id ASC
  `, [effectId])
}

async function markProviderReceiptCleanup(receiptId, status, errorMessage = null) {
  await db.run(`
    UPDATE conversational_appointment_test_provider_receipts
    SET cleanup_status = ?, cleanup_error = ?,
        cleanup_attempt_count = cleanup_attempt_count + 1,
        cleaned_at = CASE WHEN ? = 'cleaned' THEN CURRENT_TIMESTAMP ELSE cleaned_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [status, errorMessage ? cleanString(errorMessage).slice(0, 1200) : null, status, receiptId])
}

async function markEffectCleanup(effectId, status, errorMessage = null) {
  if (!effectId) return
  const cleanedAt = status === 'cleaned' ? new Date().toISOString() : null
  let payloadJson = null
  if (cleanedAt) {
    const [row, auditRows] = await Promise.all([
      db.get(
        'SELECT payload_json FROM conversational_agent_test_effects WHERE id = ?',
        [effectId]
      ),
      db.all(`
        SELECT status, COUNT(*) AS total
        FROM conversational_appointment_test_automation_receipts
        WHERE test_effect_id = ?
        GROUP BY status
      `, [effectId]).catch(() => [])
    ])
    const payload = parseJsonObject(row?.payload_json)
    const automationAudit = Object.fromEntries(
      (auditRows || []).map((auditRow) => [cleanString(auditRow.status), Number(auditRow.total || 0)])
    )
    payloadJson = JSON.stringify({
      ...payload,
      appointmentCreated: false,
      appointmentCleaned: true,
      cleanupStatus: 'cleaned',
      cleanedAt,
      automationAudit: {
        total: Object.values(automationAudit).reduce((sum, count) => sum + Number(count || 0), 0),
        ...automationAudit
      },
      summary: 'La cita temporal de prueba ya fue eliminada.'
    })
  }
  await db.run(`
    UPDATE conversational_agent_test_effects
    SET cleanup_status = ?, cleanup_error = ?,
        lease_until_at = NULL,
        status = CASE WHEN ? = 'cleaned' THEN 'cleaned' ELSE status END,
        payload_json = CASE WHEN ? = 'cleaned' THEN ? ELSE payload_json END,
        cleaned_at = CASE WHEN ? = 'cleaned' THEN CURRENT_TIMESTAMP ELSE cleaned_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    status,
    errorMessage ? cleanString(errorMessage).slice(0, 1200) : null,
    status,
    status,
    payloadJson,
    status,
    effectId
  ])
}

async function markRunCleanedWhenComplete(runId) {
  if (!runId) return
  const outstanding = await db.get(`
    SELECT COUNT(*) AS total
    FROM conversational_agent_test_effects
    WHERE run_id = ?
      AND COALESCE(cleanup_status, '') != 'cleaned'
  `, [runId])
  if (Number(outstanding?.total || 0) > 0) return

  await db.run(`
    UPDATE conversational_agent_test_runs
    SET status = 'cleaned', cleaned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status != 'cleaned'
  `, [runId])
}

async function clearAppointmentConversationArtifacts(appointmentId) {
  await db.transaction(async () => {
    await db.run(
      'DELETE FROM appointment_confirmation_windows WHERE appointment_id = ?',
      [appointmentId]
    )
    await db.run(
      'DELETE FROM appointment_reminder_sends WHERE appointment_id = ?',
      [appointmentId]
    )
  })
}

async function finalizeAmbiguousTestAutomationReceipts(testEffectId) {
  await db.run(`
    UPDATE conversational_appointment_test_automation_receipts
    SET status = 'outcome_unknown',
        detail = COALESCE(detail, 'El proceso terminó sin confirmar si el efecto externo respondió.'),
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE test_effect_id = ? AND status = 'dispatching'
  `, [testEffectId]).catch(() => undefined)
}

async function deleteRemoteGoogleAppointment({ receiptId, testEffectId } = {}) {
  if (!receiptId || !testEffectId) {
    return {
      status: 'failed',
      provider: 'google',
      message: 'Falta el receipt durable que autoriza borrar el evento Google de prueba.'
    }
  }
  try {
    // El receipt conserva el provider original aunque el calendario local se
    // haya religado. Google vuelve a comprobar receipt/effect/run e ID
    // determinista antes de emitir este DELETE exclusivamente remoto.
    const result = await deleteConversationalTestGoogleEventFromReceiptImpl({
      receiptId,
      testEffectId
    })
    if (result?.enabled === false) {
      return { status: 'pending', provider: 'google', message: 'Google Calendar no está conectado para borrar el evento de prueba.' }
    }
    return null
  } catch (error) {
    return { status: 'failed', provider: 'google', message: error.message }
  }
}

async function deleteRemoteHighLevelAppointment(appointment) {
  if (!appointment.ghlAppointmentId) return null
  const accessToken = cleanString(await getHighLevelAccessTokenImpl())
  if (!accessToken) {
    return { status: 'pending', provider: 'highlevel', message: 'HighLevel no tiene una credencial disponible para borrar la cita de prueba.' }
  }

  try {
    await deleteHighLevelEventImpl(appointment.ghlAppointmentId, accessToken)
    await db.run(`
      UPDATE appointments
      SET ghl_appointment_id = NULL, synced_at = CURRENT_TIMESTAMP, date_updated = CURRENT_TIMESTAMP
      WHERE id = ? AND is_test = 1
    `, [appointment.id])
    return null
  } catch (error) {
    if (/\b(?:404|410)\b/.test(cleanString(error.message))) {
      await db.run(`
        UPDATE appointments
        SET ghl_appointment_id = NULL, synced_at = CURRENT_TIMESTAMP, date_updated = CURRENT_TIMESTAMP
        WHERE id = ? AND is_test = 1
      `, [appointment.id])
      return null
    }
    return { status: 'failed', provider: 'highlevel', message: error.message }
  }
}

async function reconcileUnknownHighLevelReceipt(receipt) {
  const accessToken = cleanString(await getHighLevelAccessTokenImpl())
  if (!accessToken) {
    return { failure: { status: 'pending', provider: 'highlevel', message: 'HighLevel no tiene credencial para reconciliar el comando remoto incierto.' } }
  }
  const command = parseJsonObject(receipt.command_json)
  const startMs = new Date(command.startTime).getTime()
  const endMs = new Date(command.endTime).getTime()
  if (
    !cleanString(command.marker) || !cleanString(command.locationId) ||
    !cleanString(command.calendarId) || !cleanString(command.contactId) ||
    !Number.isFinite(startMs) || !Number.isFinite(endMs)
  ) {
    return { failure: { status: 'failed', provider: 'highlevel', message: 'El outbox HighLevel no conserva identidad suficiente para reconciliar sin riesgo.' } }
  }

  let events
  try {
    events = await getHighLevelCalendarEventsImpl(
      command.locationId,
      startMs - 5 * 60_000,
      endMs + 5 * 60_000,
      accessToken,
      command.calendarId
    )
  } catch (error) {
    await localCalendarService.markConversationalTestAppointmentProviderRemoteStatus({
      receiptId: receipt.id,
      remoteStatus: 'remote_outcome_unknown',
      remoteError: `Cleanup reconcile: ${error.message}`,
      reconciled: true
    }).catch(() => undefined)
    return { failure: { status: 'pending', provider: 'highlevel', message: `No se pudo reconciliar el evento incierto: ${error.message}` } }
  }

  const remote = highlevelCalendarService.findHighLevelTestAppointmentByCommand(events, command)
  if (!remote?.id) {
    await localCalendarService.markConversationalTestAppointmentProviderRemoteStatus({
      receiptId: receipt.id,
      remoteStatus: 'absent',
      remoteError: null,
      reconciled: true
    })
    return { absent: true }
  }
  const updated = await localCalendarService.markConversationalTestAppointmentProviderRemoteStatus({
    receiptId: receipt.id,
    externalId: remote.id,
    remoteStatus: 'created',
    remoteError: null,
    reconciled: true
  })
  return { externalId: remote.id, receipt: updated }
}

async function cleanupRemoteProviderReceipts({ row, receipts }) {
  const failures = []
  const artifacts = []
  const byKey = new Map()
  const addArtifact = (provider, externalId, receipt = null) => {
    const cleanProvider = cleanString(provider).toLowerCase()
    const cleanExternalId = cleanString(externalId)
    const key = `${cleanProvider}:${cleanExternalId}`
    if (!cleanExternalId) return
    const existing = byKey.get(key)
    if (existing) {
      if (receipt && !existing.receipt) existing.receipt = receipt
      return
    }
    const artifact = { provider: cleanProvider, externalId: cleanExternalId, receipt }
    byKey.set(key, artifact)
    artifacts.push(artifact)
  }

  addArtifact('google', row?.google_event_id)
  addArtifact('highlevel', row?.ghl_appointment_id)
  for (const receipt of receipts || []) {
    addArtifact(receipt.provider, receipt.external_id, receipt)
  }

  for (const artifact of artifacts) {
    // Si el DELETE remoto ya quedó durablemente limpio pero el proceso cayó
    // antes de cerrar cita/efecto, no necesita tocar otra vez al proveedor.
    if (artifact.receipt?.cleanup_status === 'cleaned') continue
    let activeArtifact = artifact
    if (
      artifact.provider === 'highlevel' && artifact.receipt &&
      (
        ['command_pending', 'posting', 'remote_outcome_unknown'].includes(cleanString(artifact.receipt.remote_status)) ||
        cleanString(artifact.externalId).startsWith('outbox')
      )
    ) {
      const reconciliation = await reconcileUnknownHighLevelReceipt(artifact.receipt)
      if (reconciliation.failure) {
        failures.push(reconciliation.failure)
        await markProviderReceiptCleanup(
          artifact.receipt.id,
          reconciliation.failure.status === 'pending' ? 'pending' : 'failed',
          reconciliation.failure.message
        )
        continue
      }
      if (reconciliation.absent) {
        await markProviderReceiptCleanup(artifact.receipt.id, 'cleaned')
        continue
      }
      activeArtifact = {
        ...artifact,
        externalId: reconciliation.externalId,
        receipt: reconciliation.receipt || artifact.receipt
      }
    } else if (
      artifact.provider === 'highlevel' && artifact.receipt &&
      ['absent', 'failed'].includes(cleanString(artifact.receipt.remote_status)) &&
      cleanString(artifact.externalId).startsWith('outbox')
    ) {
      await markProviderReceiptCleanup(artifact.receipt.id, 'cleaned')
      continue
    }

    const baseAppointment = {
      id: row?.id || activeArtifact.receipt?.appointment_id,
      calendarId: row?.calendar_id || activeArtifact.receipt?.calendar_id,
      participants: []
    }
    const failure = activeArtifact.provider === 'google'
      ? await deleteRemoteGoogleAppointment({
          receiptId: activeArtifact.receipt?.id,
          testEffectId: activeArtifact.receipt?.test_effect_id
        })
      : activeArtifact.provider === 'highlevel'
        ? await deleteRemoteHighLevelAppointment({ ...baseAppointment, ghlAppointmentId: activeArtifact.externalId })
        : { status: 'failed', provider: activeArtifact.provider || 'unknown', message: 'Proveedor de recibo no soportado.' }

    if (failure) {
      failures.push(failure)
      if (activeArtifact.receipt?.id) {
        await markProviderReceiptCleanup(activeArtifact.receipt.id, failure.status === 'pending' ? 'pending' : 'failed', failure.message)
      }
    } else if (activeArtifact.receipt?.id) {
      await markProviderReceiptCleanup(activeArtifact.receipt.id, 'cleaned')
    }
  }
  return failures
}

async function markAppointmentPendingDelete(appointmentId, reason) {
  await db.run(`
    UPDATE appointments
    SET status = 'cancelled', appointment_status = 'cancelled',
        sync_status = 'pending_delete', sync_error = ?,
        deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP),
        date_updated = CURRENT_TIMESTAMP
    WHERE id = ? AND is_test = 1
  `, [cleanString(reason).slice(0, 1200), appointmentId])
}

/**
 * Borra una cita de prueba únicamente cuando appointment.id y test_effect_id
 * coinciden. Es idempotente y nunca acepta un id de cita sin su identidad de efecto.
 */
export async function cleanupConversationalTestAppointment({
  appointmentId,
  testEffectId,
  mutationLockHeld = false
} = {}) {
  const cleanAppointmentId = cleanString(appointmentId)
  const cleanEffectId = cleanString(testEffectId)
  if (!cleanAppointmentId || !cleanEffectId) {
    throw cleanupError('La limpieza requiere appointmentId y testEffectId.', 'test_cleanup_identity_required', 400)
  }

  if (!mutationLockHeld) {
    const lockAuthority = await getTestEffect(cleanEffectId)
    if (!lockAuthority?.agent_id) {
      throw cleanupError('Falta el agente durable que autoriza limpiar esta cita.', 'test_cleanup_ledger_required', 403)
    }
    return withConversationalAgentTestMutationLock({
      agentId: lockAuthority.agent_id,
      purpose: `test_appointment_cleanup:${cleanEffectId}`
    }, () => cleanupConversationalTestAppointment({
      appointmentId: cleanAppointmentId,
      testEffectId: cleanEffectId,
      mutationLockHeld: true
    }))
  }

  const [row, effect, receipts] = await Promise.all([
    getTestAppointmentRow(cleanAppointmentId),
    getTestEffect(cleanEffectId),
    getProviderReceipts(cleanEffectId)
  ])
  // El ledger es obligatorio: una bandera is_test enviada por request nunca es
  // autoridad suficiente para borrar una cita o un evento externo.
  if (!effect || cleanString(effect.effect_type) !== 'appointment') {
    throw cleanupError('Falta el efecto durable que autoriza limpiar esta cita.', 'test_cleanup_ledger_required', 403)
  }
  if (effect.entity_id && cleanString(effect.entity_id) !== cleanAppointmentId) {
    throw cleanupError('El efecto durable apunta a otra entidad.', 'test_cleanup_entity_mismatch')
  }

  if (row) {
    if (Number(row.is_test || 0) !== 1) {
      throw cleanupError('La cita indicada no es de prueba y no se puede borrar con este proceso.', 'test_cleanup_real_appointment_refused')
    }
    if (
      cleanString(row.test_effect_id) !== cleanEffectId ||
      cleanString(row.test_run_id) !== cleanString(effect.run_id) ||
      cleanString(row.contact_id) !== cleanString(effect.contact_id)
    ) {
      throw cleanupError('La cita no coincide con el efecto, la sesión o el contacto durable.', 'test_cleanup_ledger_mismatch')
    }
  }
  for (const receipt of receipts || []) {
    if (
      cleanString(receipt.test_effect_id) !== cleanEffectId ||
      cleanString(receipt.test_run_id) !== cleanString(effect.run_id) ||
      cleanString(receipt.appointment_id) !== cleanAppointmentId
    ) {
      throw cleanupError('Un recibo externo pertenece a otra cita o sesión.', 'test_cleanup_receipt_mismatch')
    }
  }
  if (!row && !effect.entity_id && !(receipts || []).length) {
    throw cleanupError(
      'No existe una cita ni un recibo durable que demuestre qué entidad debe limpiarse.',
      'test_cleanup_entity_authority_required',
      403
    )
  }

  const claimedAt = new Date().toISOString()
  const leaseUntil = new Date(Date.now() + TEST_APPOINTMENT_CLEANUP_LEASE_MS).toISOString()
  const claimed = effect.cleanup_status === 'cleaned'
    ? await db.run(`
        UPDATE conversational_agent_test_effects
        SET cleanup_status = 'processing', cleanup_error = NULL,
            lease_until_at = ?, updated_at = ?
        WHERE id = ? AND cleanup_status = 'cleaned'
      `, [leaseUntil, claimedAt, effect.id])
    : await db.run(`
        UPDATE conversational_agent_test_effects
        SET cleanup_status = 'processing', cleanup_error = NULL,
            lease_until_at = ?, updated_at = ?
        WHERE id = ?
          AND (
            COALESCE(cleanup_status, '') IN ('', 'pending', 'failed')
            OR (cleanup_status = 'processing' AND (lease_until_at IS NULL OR lease_until_at <= ?))
          )
      `, [leaseUntil, claimedAt, effect.id, claimedAt])
  if (mutationCount(claimed) === 0) {
    const current = await getTestEffect(effect.id)
    return {
      status: 'pending',
      appointmentId: cleanAppointmentId,
      testEffectId: cleanEffectId,
      reason: current?.cleanup_status === 'processing' ? 'cleanup_in_progress' : 'cleanup_not_claimed'
    }
  }
  if (effect.cleanup_status === 'cleaned') {
    logger.warn(`[Tester agente] El efecto ${effect.id} estaba limpio, pero conservaba una cita o recibo externo; se repara.`)
  }

  const failures = await cleanupRemoteProviderReceipts({ row, receipts })

  // Al vencer una prueba se apagan inmediatamente recordatorios y ventanas IA,
  // incluso si un proveedor externo necesita reintento.
  await clearAppointmentConversationArtifacts(cleanAppointmentId)
  // Un webhook o push puede haber quedado en vuelo durante una caída. Nunca se
  // reenvía a ciegas; al expirar la cita se cierra como resultado incierto para
  // que la bitácora sea terminal y auditable.
  await finalizeAmbiguousTestAutomationReceipts(cleanEffectId)

  if (failures.length) {
    const retryable = failures.some(failure => failure.status === 'pending')
    const status = retryable ? 'pending' : 'failed'
    const detail = failures.map(failure => `${failure.provider}: ${failure.message}`).join(' | ')
    if (row) await markAppointmentPendingDelete(row.id, detail)
    await markEffectCleanup(cleanEffectId, status, detail)
    return {
      status,
      appointmentId: cleanAppointmentId,
      testEffectId: cleanEffectId,
      failures
    }
  }

  // Borrar la fila local y apagar el hecho conversacional es una sola unidad.
  // Si el proceso cae, nunca puede quedar "cita ausente / efecto todavía creado".
  await db.transaction(async () => {
    if (row) await localCalendarService.deleteLocalAppointment(row.id)
    await markEffectCleanup(cleanEffectId, 'cleaned')
    await markRunCleanedWhenComplete(effect.run_id)
  })
  return {
    status: 'cleaned',
    appointmentId: cleanAppointmentId,
    testEffectId: cleanEffectId,
    deleted: Boolean(row),
    alreadyAbsent: !row
  }
}

export async function cleanupExpiredConversationalTestAppointments({
  now = new Date(),
  limit = TEST_APPOINTMENT_CLEANUP_LIMIT
} = {}) {
  const cutoff = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(cutoff.getTime())) {
    throw cleanupError('La fecha de corte de limpieza no es válida.', 'invalid_test_cleanup_cutoff', 400)
  }

  const safeLimit = Math.min(Math.max(Number(limit) || TEST_APPOINTMENT_CLEANUP_LIMIT, 1), 500)
  const rows = await db.all(`
    SELECT appointment_id AS id, test_effect_id, MIN(cleanup_due_at) AS cleanup_due_at
    FROM (
      SELECT id AS appointment_id, test_effect_id, test_expires_at AS cleanup_due_at
      FROM appointments
      WHERE is_test = 1
        AND test_expires_at IS NOT NULL
        AND test_expires_at <= ?
      UNION ALL
      SELECT appointment_id, test_effect_id, cleanup_due_at
      FROM conversational_appointment_test_provider_receipts
      WHERE cleanup_status != 'cleaned'
        AND cleanup_due_at <= ?
    ) due_test_appointments
    GROUP BY appointment_id, test_effect_id
    ORDER BY MIN(cleanup_due_at) ASC, appointment_id ASC
    LIMIT ?
  `, [cutoff.toISOString(), cutoff.toISOString(), safeLimit])

  // Fuente de reparación independiente de appointments/receipts. Si una versión
  // anterior cayó después de borrar la cita pero antes de sellar el efecto, el
  // payload conserva appointmentId+cleanupDueAt y permite terminar el cleanup.
  if (rows.length < safeLimit) {
    const repairCandidates = await db.all(`
      SELECT id, entity_id, payload_json
      FROM conversational_agent_test_effects
      WHERE effect_type = 'appointment'
        AND status != 'cleaned'
        AND COALESCE(cleanup_status, '') != 'cleaned'
      ORDER BY created_at ASC
      LIMIT ?
    `, [Math.min(500, safeLimit * 3)])
    const known = new Set(rows.map((row) => `${cleanString(row.id)}\u0000${cleanString(row.test_effect_id)}`))
    for (const effect of repairCandidates) {
      if (rows.length >= safeLimit) break
      const payload = parseJsonObject(effect.payload_json)
      const dueAt = cleanString(payload.cleanupDueAt || payload.testExpiresAt)
      const appointmentId = cleanString(effect.entity_id || payload.appointmentId)
      if (!appointmentId || !dueAt || !Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) > cutoff.getTime()) continue
      const key = `${appointmentId}\u0000${cleanString(effect.id)}`
      if (known.has(key)) continue
      known.add(key)
      rows.push({ id: appointmentId, test_effect_id: effect.id, cleanup_due_at: dueAt })
    }
  }

  const results = []
  for (const row of rows) {
    try {
      results.push(await cleanupConversationalTestAppointment({
        appointmentId: row.id,
        testEffectId: row.test_effect_id
      }))
    } catch (error) {
      const effectId = cleanString(row.test_effect_id)
      if (error?.code === 'test_mutation_lock_busy') {
        results.push({ status: 'pending', appointmentId: row.id, error: error.message })
        continue
      }
      if (effectId) await markEffectCleanup(effectId, 'failed', error.message).catch(() => undefined)
      logger.error(`[Tester agente] No se pudo limpiar la cita de prueba ${row.id}: ${error.message}`)
      results.push({ status: 'failed', appointmentId: row.id, error: error.message })
    }
  }

  return {
    processed: results.length,
    cleaned: results.filter(result => result.status === 'cleaned').length,
    pending: results.filter(result => result.status === 'pending').length,
    failed: results.filter(result => result.status === 'failed').length,
    results
  }
}

export function setConversationalAppointmentTestCleanupDependenciesForTests(overrides = null) {
  deleteConversationalTestGoogleEventFromReceiptImpl =
    overrides?.deleteConversationalTestGoogleEventFromReceipt ||
    googleCalendarService.deleteConversationalTestGoogleEventFromReceipt
  deleteHighLevelEventImpl = overrides?.deleteHighLevelEvent || highlevelCalendarService.deleteEvent
  getHighLevelCalendarEventsImpl = overrides?.getHighLevelCalendarEvents || highlevelCalendarService.getCalendarEvents
  getHighLevelAccessTokenImpl = overrides?.getHighLevelAccessToken || (async () => {
    const config = await db.get('SELECT api_token FROM highlevel_config LIMIT 1').catch(() => null)
    return cleanString(config?.api_token)
  })
}
