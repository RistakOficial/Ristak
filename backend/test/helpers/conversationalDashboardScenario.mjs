import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function verifyConversationalDashboardHistory(database) {
  const [{ buildConversationalAgentMetrics }, { loadConversationalAgentMetricAggregates }] = await Promise.all([
    import('../../src/services/conversationalAgentService.js'),
    import('../../src/services/conversationalAgentMetricsProjectionService.js')
  ])
  const prefix = `activity_${randomUUID()}_`
  const [sales, support, unpublished] = ['sales', 'support', 'draft'].map(name => prefix + name)
  const agents = [sales, support, unpublished].map((id, index) => ({ id, name: id, enabled: index < 2 }))
  const metrics = async () => buildConversationalAgentMetrics({
    agents,
    ...await loadConversationalAgentMetricAggregates(database)
  })
  const chat = prefix + 'chat'
  const interrupted = prefix + 'interrupted'
  const payment = prefix + 'payment'
  const unanswered = prefix + 'unanswered'
  const event = (id, contactId, agentId, type, detail = {}) => database.run(`
    INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
    VALUES (?, ?, ?, ?, ?)
  `, [prefix + id, contactId, agentId, type, JSON.stringify({ agentId, ...detail })])
  const linkSignal = { signal: 'link_sent', status: 'completed', objectiveCompleted: true, channel: 'whatsapp' }
  try {
    for (const id of [chat, interrupted, payment, unanswered]) {
      await database.run('INSERT INTO contacts (id, full_name) VALUES (?, ?)', [id, 'Métricas de Chatbot'])
    }
    await database.run(`
      INSERT INTO conversational_agent_state (id, contact_id, agent_id, status, channel)
      VALUES (?, ?, ?, 'active', 'whatsapp')
    `, [prefix + 'state', chat, sales])
    const initial = await metrics()
    assert.equal(initial.activeAgents, 2)
    assert.equal(initial.agentsWithAssignedConversations, 1)
    assert.equal(initial.assignedConversations, 1)
    assert.equal(initial.answeredConversations, 0)
    assert.equal(initial.successfulAnsweredConversations, 0)

    // Un turno con dos globos y su acuse final sigue siendo un solo chat.
    await event('part1', chat, sales, 'reply_part_sent', { partIndex: 1, partCount: 2, channel: 'whatsapp' })
    await event('part2', chat, sales, 'reply_part_sent', { partIndex: 2, partCount: 2, channel: 'whatsapp' })
    await event('reply', chat, sales, 'reply_sent', { channel: 'whatsapp' })
    await event('link', chat, sales, 'signal_set', linkSignal)
    await database.run(`UPDATE conversational_agent_state SET signal = 'link_sent', status = 'completed' WHERE id = ?`, [prefix + 'state'])
    assert.equal((await metrics()).completedConversations, 1)
    await event('clear', chat, sales, 'signal_cleared', { updatedBy: 'user', reactivated: true })
    await database.run(`UPDATE conversational_agent_state SET signal = NULL, status = 'active', agent_id = ? WHERE id = ?`, [support, prefix + 'state'])

    // Reasignación en WhatsApp y atención independiente en Instagram al mismo contacto.
    await event('takeover', chat, support, 'reply_single_sent', { channel: 'whatsapp' })
    await event('instagram', chat, support, 'reply_sent', { channel: 'instagram' })
    await database.run('UPDATE conversational_agent_state SET agent_id = NULL WHERE id = ?', [prefix + 'state'])
    // Un globo llegó antes de que interrumpieran el turno; nunca se escribió reply_sent.
    await event('interrupted', interrupted, sales, 'reply_part_sent', { partIndex: 1, partCount: 2, channel: 'whatsapp' })
    await event('resume', payment, support, 'payment_resume_reply_sent', { channel: 'wa' })
    await event('followup', payment, support, 'follow_up_sent', { channel: 'whatsapp' })
    await event('purchase', payment, support, 'signal_set', { ...linkSignal, signal: 'purchase_completed' })
    await event('paymentConfirmed', payment, support, 'payment_link_goal_completed', { signal: 'purchase_completed' })
    await event('goalConfirmed', payment, support, 'goal_url_completed', { signal: 'purchase_completed' })
    await event('manual', interrupted, sales, 'signal_set', { ...linkSignal, objectiveCompleted: false })
    await database.run(`
      INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
      VALUES (?, ?, ?, 'signal_set', ?)
    `, [prefix + 'invalid', chat, sales, '{"signal":'])
    await event('handoff', interrupted, sales, 'signal_set', { signal: 'ready_for_human', status: 'human', objectiveCompleted: false })
    await event('secondCycle', payment, support, 'signal_set', linkSignal)
    await event('otherAgentGoal', interrupted, support, 'signal_set', linkSignal)
    await event('unansweredGoal', unanswered, sales, 'signal_set', linkSignal)
    // Una meta histórica sin canal sigue siendo una meta, pero no prueba qué chat la logró.
    await event('legacyGoal', chat, support, 'signal_set', { ...linkSignal, channel: undefined })
    await event('testReply', unanswered, sales, 'reply_sent', { channel: 'whatsapp', mode: 'test' })
    await event('previewGoal', chat, sales, 'signal_set', { ...linkSignal, mode: 'preview' })
    await event('testError', chat, support, 'custom_tool_failed_runtime', { dryRun: true })
    await event('agentError', chat, sales, 'custom_tool_failed_runtime')
    await event('systemError', null, null, 'calendar_sync_error')

    const result = await metrics()
    const byAgent = id => result.byAgent.find(row => row.agentId === id)
    assert.equal(result.agentsWithAssignedConversations, 0)
    assert.equal(result.assignedConversations, 0)
    assert.equal(result.answeredConversations, 4)
    assert.equal(byAgent(sales).answeredConversations, 2)
    assert.equal(byAgent(support).answeredConversations, 3)
    assert.equal(byAgent(unpublished).answeredConversations, 0)
    assert.equal(result.completedConversations, 6)
    assert.equal(byAgent(sales).completedConversations, 2)
    assert.equal(byAgent(support).completedConversations, 4)
    assert.equal(result.errorEvents, 2)
    assert.equal(byAgent(sales).errorEvents, 1)
    assert.equal(byAgent(support).errorEvents, 0)
    assert.equal(result.successfulAnsweredConversations, 3)
    assert.equal(result.successRate, 75)
    assert.equal(byAgent(sales).successfulAnsweredConversations, 1)
    assert.equal(byAgent(support).successfulAnsweredConversations, 1)
    assert.equal(byAgent(sales).successRate, 50)
    assert.equal(byAgent(support).successRate, 33)

    // Corregir el canal de un evento mueve un chat; retirar una evidencia duplicada no borra la atención.
    await database.run(`UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?`, [
      JSON.stringify({ agentId: support, channel: 'whatsapp' }), prefix + 'instagram'
    ])
    await database.run('DELETE FROM conversational_agent_events WHERE id IN (?, ?)', [prefix + 'reply', prefix + 'part2'])
    const corrected = await metrics()
    assert.equal(corrected.answeredConversations, 3)
    assert.equal(corrected.byAgent.find(row => row.agentId === support).answeredConversations, 2)
    assert.equal(corrected.byAgent.find(row => row.agentId === sales).answeredConversations, 2)
  } finally {
    await database.run('DELETE FROM conversational_agent_events WHERE id LIKE ?', [prefix + '%'])
    await database.run('DELETE FROM conversational_agent_state WHERE id LIKE ?', [prefix + '%'])
    await database.run('DELETE FROM contacts WHERE id LIKE ?', [prefix + '%'])
  }
}
