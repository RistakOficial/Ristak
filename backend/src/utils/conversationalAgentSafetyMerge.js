const SAFETY_REFERENCE_TABLES = new Set([
  'conversational_agent_safety_cases',
  'conversational_agent_safety_events'
])

function cleanString(value) {
  return String(value ?? '').trim()
}

function parseInstant(value) {
  if (value instanceof Date) return value.getTime()
  const text = cleanString(value)
  if (!text) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text
  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? timestamp : null
}

function isActive(caseRow, nowMs) {
  if (!caseRow || caseRow.status !== 'active') return false
  if (caseRow.block_mode === 'indefinite') return true
  const blockedUntil = parseInstant(caseRow.blocked_until)
  return blockedUntil === null || blockedUntil > nowMs
}

function pickLatest(rows = []) {
  return [...rows].sort((left, right) => (
    (parseInstant(right?.updated_at) || parseInstant(right?.created_at) || 0) -
    (parseInstant(left?.updated_at) || parseInstant(left?.created_at) || 0)
  ))[0] || null
}

function pickOperationalAuthority(rows = [], nowMs) {
  const active = rows.filter(row => isActive(row, nowMs))
  if (!active.length) return pickLatest(rows)

  return [...active].sort((left, right) => {
    const modeDifference = Number(right.block_mode === 'indefinite') - Number(left.block_mode === 'indefinite')
    if (modeDifference !== 0) return modeDifference
    const severityDifference = Number(right.severity === 'critical') - Number(left.severity === 'critical')
    if (severityDifference !== 0) return severityDifference
    return (parseInstant(right.blocked_until) || Number.MAX_SAFE_INTEGER) -
      (parseInstant(left.blocked_until) || Number.MAX_SAFE_INTEGER)
  })[0]
}

function earliestOpenedAt(rows = [], fallback = null) {
  const values = rows
    .map(row => ({ value: row?.opened_at, timestamp: parseInstant(row?.opened_at) }))
    .filter(item => item.timestamp !== null)
    .sort((left, right) => left.timestamp - right.timestamp)
  return values[0]?.value || fallback
}

export function isConversationalAgentSafetyReferenceTable(tableName) {
  return SAFETY_REFERENCE_TABLES.has(cleanString(tableName))
}

/**
 * Consolida la cuarentena antes de fusionar dos contactos. Un UPDATE genérico
 * no sirve porque safety_cases es UNIQUE(contact_id, channel): si ambos IDs ya
 * tienen caso, la actualización falla y el bloqueo puede quedarse en el ID que
 * será borrado. Esta rutina conserva el bloqueo activo más fuerte y repunta
 * eventos/auditoría dentro de una sola transacción.
 */
export async function mergeConversationalAgentSafetyContactReferences({
  connection,
  fromContactId,
  toContactId,
  now = Date.now(),
  usePostgres = Boolean(process.env.DATABASE_URL)
} = {}) {
  const fromId = cleanString(fromContactId)
  const toId = cleanString(toContactId)
  if (!connection || !fromId || !toId || fromId === toId) {
    return { merged: 0, skipped: true }
  }

  const existingSourceCases = await connection.all(
    'SELECT id FROM conversational_agent_safety_cases WHERE contact_id = ?',
    [fromId]
  ).catch(() => null)
  if (!existingSourceCases) return { merged: 0, unavailable: true }
  if (!existingSourceCases.length) return { merged: 0 }

  const execute = async (tx) => {
    const lockSuffix = usePostgres ? ' FOR UPDATE' : ''
    // Bloquear ambos lados en orden estable evita deadlocks si dos procesos
    // intentan fusionar el mismo par en sentidos opuestos.
    const lockedCases = await tx.all(
      `SELECT * FROM conversational_agent_safety_cases
       WHERE contact_id IN (?, ?)
       ORDER BY contact_id ASC, channel ASC, id ASC${lockSuffix}`,
      [fromId, toId]
    )
    const sourceCases = lockedCases.filter(row => cleanString(row.contact_id) === fromId)
    let merged = 0

    for (const sourceCase of sourceCases) {
      const targetCase = lockedCases.find(
        row => cleanString(row.contact_id) === toId && row.channel === sourceCase.channel
      )
      const survivorCaseId = targetCase?.id || sourceCase.id
      const sourceEvents = await tx.all(
        `SELECT * FROM conversational_agent_safety_events
         WHERE case_id = ? ORDER BY created_at ASC, id ASC`,
        [sourceCase.id]
      )

      for (const event of sourceEvents) {
        const duplicate = await tx.get(
          `SELECT id, case_id FROM conversational_agent_safety_events
           WHERE agent_id = ? AND contact_id = ? AND channel = ? AND source_message_id = ?
             AND id != ?
           LIMIT 1`,
          [event.agent_id, toId, event.channel, event.source_message_id, event.id]
        )
        if (duplicate) {
          await tx.run(
            `UPDATE conversational_agent_safety_audit
             SET case_id = ?, event_id = ?
             WHERE event_id = ?`,
            [duplicate.case_id, duplicate.id, event.id]
          )
          await tx.run('DELETE FROM conversational_agent_safety_events WHERE id = ?', [event.id])
          continue
        }

        await tx.run(
          `UPDATE conversational_agent_safety_events
           SET case_id = ?, contact_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [survivorCaseId, toId, event.id]
        )
      }

      if (!targetCase) {
        await tx.run(
          `UPDATE conversational_agent_safety_cases
           SET contact_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [toId, sourceCase.id]
        )
        merged += 1
        continue
      }

      await tx.run(
        `UPDATE conversational_agent_safety_audit
         SET case_id = ? WHERE case_id = ?`,
        [targetCase.id, sourceCase.id]
      )

      const cases = [targetCase, sourceCase]
      const authority = pickOperationalAuthority(cases, Number(now instanceof Date ? now.getTime() : now)) || targetCase
      const activeCases = cases.filter(row => isActive(row, Number(now instanceof Date ? now.getTime() : now)))
      const hasActive = activeCases.length > 0
      const hasIndefinite = activeCases.some(row => row.block_mode === 'indefinite')
      const latestEvent = await tx.get(
        `SELECT id, agent_id, source_message_id, reason
         FROM conversational_agent_safety_events
         WHERE case_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        [targetCase.id]
      )
      const eventCount = await tx.get(
        'SELECT COUNT(*) AS total FROM conversational_agent_safety_events WHERE case_id = ?',
        [targetCase.id]
      )
      const activeCritical = activeCases.find(row => row.severity === 'critical')

      await tx.run(
        `UPDATE conversational_agent_safety_cases
         SET status = ?, category = ?, severity = ?, block_mode = ?, blocked_until = ?,
             policy_json = ?, event_count = ?, opened_at = ?, latest_event_id = ?,
             latest_agent_id = ?, latest_source_message_id = ?, latest_reason = ?,
             resolved_at = ?, resolved_by = ?, resolution_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          hasActive ? 'active' : authority.status,
          activeCritical?.category || authority.category,
          activeCritical ? 'critical' : authority.severity,
          hasIndefinite ? 'indefinite' : authority.block_mode,
          hasIndefinite ? null : authority.blocked_until,
          authority.policy_json,
          Number(eventCount?.total || 0),
          earliestOpenedAt(cases, authority.opened_at),
          latestEvent?.id || authority.latest_event_id || null,
          latestEvent?.agent_id || authority.latest_agent_id || null,
          latestEvent?.source_message_id || authority.latest_source_message_id || null,
          latestEvent?.reason || authority.latest_reason || null,
          hasActive ? null : authority.resolved_at,
          hasActive ? null : authority.resolved_by,
          hasActive ? null : authority.resolution_reason,
          targetCase.id
        ]
      )
      await tx.run('DELETE FROM conversational_agent_safety_cases WHERE id = ?', [sourceCase.id])
      merged += 1
    }

    return { merged }
  }

  return typeof connection.transaction === 'function'
    ? connection.transaction(execute)
    : execute(connection)
}
