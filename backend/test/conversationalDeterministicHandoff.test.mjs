import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { db, databaseReady } from '../src/config/database.js'
import {
  MANDATORY_HANDOFF_GATE_MAX_ATTEMPTS,
  MANDATORY_HANDOFF_ESCALATION_RETRY_MAX_DELAY_MS,
  adjudicateToolCallingV2VerifiedGoalHandoff,
  adjudicateToolCallingV2VerifiedPaymentHandoff,
  buildConversationalAuditEventId,
  buildToolCallingV2HandoffClassifierEvidence,
  buildToolCallingV2HistoryEnvelope,
  buildToolCallingV2MandatoryHandoffRuntimeFacts,
  buildToolCallingV2MandatoryHandoffRetryPlan,
  claimFreshToolCallingV2MandatoryHandoffRequiredDataPrompt,
  consumeScheduledPendingContactRerun,
  deliverVerifiedHandoffRequiredDataPrompt,
  executeToolCallingV2MandatoryHandoffEscalation,
  extractDeterministicToolCallingV2RequiredHandoffData,
  failInboundAndQueueMandatoryHandoffRetry,
  getPendingMandatoryHandoffEscalationReason,
  groundToolCallingV2RequiredHandoffData,
  handleInboundConversationalMessage,
  loadToolCallingV2MandatoryHandoffEvidence,
  loadToolCallingV2ConversationEnvelopeThroughMessage,
  loadToolCallingV2RuntimeDefaultsAfterInboundClaim,
  loadToolCallingV2VerifiedPaymentHandoffPolicy,
  messagesInsideHandoffScope,
  normalizeToolCallingV2HandoffNoMatchAudit,
  normalizeToolCallingV2MandatoryHandoffSafetyDecision,
  parseToolCallingV2ConfiguredHandoffRules,
  projectToolCallingV2RequiredHandoffData,
  recoverPreventiveMandatoryHandoffInbound,
  releaseAgentAfterToolCallingV2HandoffGate,
  resolveInboundAgentForContact,
  resolveToolCallingV2MandatoryHandoff,
  resolveToolCallingV2SynchronousTerminalHandoff,
  runToolCallingV2Turn,
  sendReplyParts,
  shouldRecoverPendingInbound,
  verifyToolCallingV2SynchronousTerminalAction
} from '../src/agents/conversational/runner.js'
import {
  buildConversationalPaymentConversationBinding,
  createConversationalTools
} from '../src/agents/conversational/tools.js'
import {
  buildConversationalCapabilityManifest,
  normalizeConversationalCapabilitiesConfig
} from '../src/agents/conversational/nativeRuntimeConfig.js'
import {
  buildHandoffRuleFingerprint,
  claimHandoffRuleLatch,
  commitHandoffRuleExecutionAuthority,
  hasVerifiedPastClientEvidence,
  isHandoffRuleLatchCompleted,
  loadActiveHandoffRuleLatch,
  loadHandoffConversationScope,
  markHandoffRuleLatchAwaitingData,
  settleHandoffRuleLatch,
  supersedeStaleHandoffRuleLatches,
  upsertHandoffRuleLatch
} from '../src/services/conversationalHandoffRuleService.js'
import {
  assignAgentToConversation,
  claimConversationInboundMessage,
  clearConversationSignal,
  completeConversationInboundMessage,
  ensureConversationState,
  getConversationalAgent,
  recoverPendingToolCallingV2VerifiedTerminalHandoffs,
  sealToolCallingV2VerifiedTerminalHandoffPending,
  releaseAgentFromConversation,
  setConversationalStateBeforeReactivationUpdateHookForTest,
  setConversationSignal,
  setConversationStatus
} from '../src/services/conversationalAgentService.js'

await databaseReady

function buildFixture({
  rules = '- cuando la persona ya haya elegido una fecha y una hora',
  pastClientsToHuman = false,
  extraCapabilities = [],
  sendResults = [{ ok: true, simulated: true, wouldNotifyHuman: true }],
  onSave = null,
  onSend = null
} = {}) {
  const actions = []
  const calls = []
  let sendIndex = 0
  const handoff = {
    id: 'handoff_human',
    enabled: true,
    rules,
    pastClientsToHuman
  }
  const built = {
    model: 'fake-model',
    capabilityManifest: [
      { id: 'handoff_human', enabled: true, ready: true },
      ...extraCapabilities.map((item) => ({ id: item.id, enabled: true, ready: true }))
    ],
    ctx: {
      config: { id: 'agent_handoff_test' },
      capabilitiesConfig: {
        items: [handoff, ...extraCapabilities]
      },
      actions,
      followUpMode: false,
      paymentResumeClaim: null
    },
    tools: [{
      name: 'save_contact_data',
      invoke: async (_context, payload) => {
        const values = JSON.parse(payload)
        calls.push({ tool: 'save_contact_data', values })
        built.ctx.actionScopedContactData = {
          ...(built.ctx.actionScopedContactData || {}),
          ...(values.fullName ? { full_name: values.fullName } : {}),
          ...(values.phone ? { phone: values.phone } : {}),
          ...(values.email ? { email: values.email } : {})
        }
        actions.push({
          type: 'save_contact_data',
          outcome: { status: 'simulated', ok: true, simulated: true }
        })
        await onSave?.(values)
        return { ok: true, simulated: true }
      }
    }, {
      name: 'send_to_human',
      invoke: async () => {
        await onSend?.(built.ctx)
        calls.push({ tool: 'send_to_human' })
        const result = sendResults[Math.min(sendIndex, sendResults.length - 1)]
        sendIndex += 1
        if (result?.ok) {
          actions.push({
            type: 'send_to_human',
            outcome: {
              status: 'simulated',
              ok: true,
              simulated: true,
              wouldNotifyHuman: true
            }
          })
        }
        return result
      }
    }]
  }
  return { built, calls, actions }
}

function buildVerifiedPaymentHandoffAgent({
  rules = '',
  pastClientsToHuman = false,
  userId = '',
  userName = '',
  dataRequirements = {},
  handoffEnabled = true,
  agentEnabled = true,
  updatedAt = '2026-07-30T10:15:00.000Z',
  model = 'fake-model',
  extraCapabilities = []
} = {}) {
  return {
    id: 'agent_verified_payment_handoff',
    enabled: agentEnabled,
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model,
    updatedAt,
    capabilitiesConfig: normalizeConversationalCapabilitiesConfig({
      dataRequirements,
      items: [{
        id: 'handoff_human',
        enabled: handoffEnabled,
        rules,
        pastClientsToHuman,
        userId,
        userName
      }, ...extraCapabilities]
    })
  }
}

function runGate(fixture, {
  messages = [
    { role: 'user', content: 'El lunes de la próxima semana' },
    { role: 'assistant', content: '¿A qué hora?' },
    { role: 'user', content: 'A las 11:00 am' }
  ],
  latestInbound = 'A las 11:00 am',
  adjudication = {
    decision: 'match',
    matchedRule: 'fecha y hora elegidas',
    reason: 'La persona eligió lunes a las 11:00',
    summary: 'Solicita valoración el lunes a las 11:00',
    modelCallCount: 1
  },
  noMatchAudit = null,
  noMatchAuditError = null,
  onAudit = null,
  extraction = { values: null, modelCallCount: 0 },
  findPastClientEvidence = async () => false,
  onAdjudicate = null,
  contactId = 'preview-contact',
  executionId = 'preview-execution',
  inboundClaim = null,
  dryRun = true,
  phase = 'pre',
  trustedRuntimeFacts = null,
  deliverRequiredDataPrompt = null,
  claimFreshRequiredDataPrompt = null,
  safetyAdjudication = {
    decision: 'clear',
    modelCallCount: 1,
    source: 'test_safety_preflight'
  }
} = {}) {
  return resolveToolCallingV2MandatoryHandoff({
    built: fixture.built,
    selectedMessages: messages,
    latestInbound,
    runtime: { modelProvider: { kind: 'fake' } },
    contactId,
    channel: 'whatsapp',
    executionId,
    inboundClaim,
    dryRun,
    phase,
    trustedRuntimeFacts
  }, {
    adjudicateHandoffRules: async (input) => {
      await onAdjudicate?.(input)
      return adjudication
    },
    auditHandoffNoMatch: async (input) => {
      await onAudit?.(input)
      if (noMatchAuditError) throw noMatchAuditError
      if (noMatchAudit) return noMatchAudit
      const ruleClauses = input.ruleClauses ||
        parseToolCallingV2ConfiguredHandoffRules(input.rules)
      return {
        decision: 'confirmed_no_match',
        ruleAssessments: ruleClauses.map((rule) => ({
          ruleId: rule.ruleId,
          verdict: 'not_satisfied',
          evidence: [`La evidencia revisada no completa: ${rule.text}`],
          reasoning: 'La condición sigue ausente.'
        })),
        reason: 'Todas las reglas fueron descartadas de forma independiente.',
        summary: 'No corresponde pasar a humano todavía.',
        modelCallCount: 1,
        source: 'test_independent_no_match_audit'
      }
    },
    adjudicateHandoffSafety: async () => safetyAdjudication,
    extractRequiredHandoffData: async () => extraction,
    findPastClientEvidence,
    ...(deliverRequiredDataPrompt
      ? { deliverRequiredDataPrompt }
      : {}),
    ...(claimFreshRequiredDataPrompt
      ? { claimFreshRequiredDataPrompt }
      : {})
  })
}

async function createLiveHandoffConversation({
  contactId,
  agentId,
  messageId = '',
  messageText = ''
} = {}) {
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Ángel Aarón Salinas', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, `+521${String(Date.now()).slice(-10)}`]
  )
  await ensureConversationState(contactId, { agentId, channel: 'whatsapp' })
  let inboundClaim = null
  if (messageId) {
    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', ?, CURRENT_TIMESTAMP)`,
      [messageId, contactId, messageText || 'El lunes a las 11:00 am']
    )
    const claim = await claimConversationInboundMessage(contactId, messageId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(claim.claimed, true)
    inboundClaim = { ...claim, messageId }
  }
  const scope = await loadHandoffConversationScope({
    contactId,
    agentId,
    channel: 'whatsapp'
  })
  assert.ok(scope?.conversationScopeId)
  return { scope, inboundClaim }
}

async function cleanupLiveHandoffConversation({ contactId, agentId } = {}) {
  await db.run(
    `DELETE FROM conversational_agent_safety_audit
     WHERE case_id IN (
       SELECT id FROM conversational_agent_safety_cases WHERE contact_id = ?
     )`,
    [contactId]
  ).catch(() => undefined)
  await db.run(
    'DELETE FROM conversational_agent_safety_events WHERE contact_id = ?',
    [contactId]
  ).catch(() => undefined)
  await db.run(
    'DELETE FROM conversational_agent_safety_cases WHERE contact_id = ?',
    [contactId]
  ).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM chat_delivery_outbox WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM ai_agent_pending_reruns WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  if (agentId) {
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
  }
}

test('la regla obligatoria recibe todo el historial disponible y un match termina en handoff silencioso', async () => {
  const fixture = buildFixture()
  const result = await runGate(fixture, {
    onAdjudicate: ({ messages, latestInbound }) => {
      assert.deepEqual(messages.map((message) => message.content), [
        'El lunes de la próxima semana',
        '¿A qué hora?',
        'A las 11:00 am'
      ])
      assert.equal(latestInbound, 'A las 11:00 am')
    }
  })

  assert.equal(result.handled, true)
  assert.equal(result.reply, '')
  assert.equal(result.mandatoryHandoff.status, 'completed')
  assert.deepEqual(fixture.calls.map((call) => call.tool), ['send_to_human'])
})

test('sin match conserva las demás capacidades y deja correr el agente normal', async () => {
  const fixture = buildFixture({
    extraCapabilities: [
      { id: 'schedule_appointment', enabled: true, calendarId: 'calendar_1' },
      { id: 'collect_payment', enabled: true },
      { id: 'send_link', enabled: true }
    ]
  })
  const result = await runGate(fixture, {
    adjudication: {
      decision: 'no_match',
      matchedRule: null,
      reason: null,
      summary: null,
      modelCallCount: 1
    }
  })

  assert.equal(result.handled, false)
  assert.equal(result.mandatoryHandoff.status, 'not_matched')
  assert.deepEqual(fixture.calls, [])
  assert.deepEqual(
    fixture.built.ctx.capabilitiesConfig.items.map((item) => item.id),
    ['handoff_human', 'schedule_appointment', 'collect_payment', 'send_link']
  )
})

test('la auditoría independiente sólo acepta no_match con cobertura y evidencia de cada regla', () => {
  const clauses = parseToolCallingV2ConfiguredHandoffRules(
    '- cuando el paciente elija fecha y hora - cuando pida atención urgente'
  )
  const accepted = normalizeToolCallingV2HandoffNoMatchAudit({
    decision: 'confirmed_no_match',
    ruleAssessments: clauses.map((rule) => ({
      ruleId: rule.ruleId,
      verdict: 'not_satisfied',
      evidence: [`Se revisó y sigue ausente: ${rule.text}`]
    }))
  }, { ruleClauses: clauses })
  assert.equal(accepted.acceptedNoMatch, true)

  const incomplete = normalizeToolCallingV2HandoffNoMatchAudit({
    decision: 'confirmed_no_match',
    ruleAssessments: [{
      ruleId: clauses[0].ruleId,
      verdict: 'not_satisfied',
      evidence: ['La primera condición no aparece.']
    }]
  }, { ruleClauses: clauses })
  assert.equal(incomplete.acceptedNoMatch, false)
  assert.equal(incomplete.decision, 'uncertain')
  assert.ok(incomplete.issues.includes(`rule_assessment_missing:${clauses[1].ruleId}`))
})

test('una condición al final de una regla larga llega íntegra a la auditoría y puede corregir el no_match', async () => {
  const marker = 'CONDICION_DECISIVA_AL_FINAL'
  const rules = `cuando se confirme el contexto ${'x'.repeat(3900)} ${marker}`.slice(0, 4000)
  assert.equal(rules.endsWith(marker), true)
  const fixture = buildFixture({ rules })
  let auditedRule = ''
  const result = await runGate(fixture, {
    adjudication: {
      decision: 'no_match',
      modelCallCount: 1
    },
    onAudit: ({ ruleClauses }) => {
      auditedRule = ruleClauses[0]?.text || ''
    },
    noMatchAudit: {
      decision: 'match',
      ruleAssessments: [{
        ruleId: 'rule_1',
        verdict: 'satisfied',
        evidence: [`El marcador ${marker} sí quedó cubierto.`],
        reasoning: 'La condición decisiva estaba al final.'
      }],
      matchedRule: rules,
      reason: 'La segunda revisión encontró la condición.',
      summary: 'Debe pasar a humano.',
      modelCallCount: 1,
      source: 'test_independent_no_match_audit'
    }
  })
  assert.equal(auditedRule.endsWith(marker), true)
  assert.equal(result.handled, true)
  assert.equal(result.mandatoryHandoff.status, 'completed')
})

test('desacuerdo, incertidumbre o error de la auditoría nunca devuelven el chat al bot', async () => {
  const cases = [{
    name: 'match',
    noMatchAudit: {
      decision: 'match',
      ruleAssessments: [{
        ruleId: 'rule_1',
        verdict: 'satisfied',
        evidence: ['La persona sí eligió lunes a las 11:00.']
      }],
      modelCallCount: 1
    }
  }, {
    name: 'uncertain',
    noMatchAudit: {
      decision: 'uncertain',
      ruleAssessments: [{
        ruleId: 'rule_1',
        verdict: 'uncertain',
        evidence: ['Hay fecha y hora, pero falta resolver una referencia.']
      }],
      modelCallCount: 1
    }
  }, {
    name: 'error',
    noMatchAuditError: new Error('auditor caído')
  }]
  for (const scenario of cases) {
    const fixture = buildFixture()
    const result = await runGate(fixture, {
      adjudication: {
        decision: 'no_match',
        modelCallCount: 1
      },
      noMatchAudit: scenario.noMatchAudit,
      noMatchAuditError: scenario.noMatchAuditError
    })
    assert.equal(result.handled, true, scenario.name)
    assert.equal(result.mandatoryHandoff.status, 'completed', scenario.name)
    assert.deepEqual(fixture.calls.map((call) => call.tool), ['send_to_human'], scenario.name)
  }
})

test('la auditoría durable de 20 reglas se guarda íntegra y legible antes de aceptar no_match', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_audit_contact_${suffix}`
  const agentId = `handoff_audit_agent_${suffix}`
  const messageId = `handoff_audit_message_${suffix}`
  const rules = Array.from(
    { length: 20 },
    (_, index) => `- regla ${index + 1}: condición específica ${'x'.repeat(60)}`
  ).join('\n')
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{ id: 'handoff_human', enabled: true, rules }]
  })
  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Auditoría íntegra', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(capabilitiesConfig)]
  )
  const { inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId,
    messageText: 'Todavía no cumplo ninguna condición'
  })
  const fixture = buildFixture({ rules })
  fixture.built.ctx.config.id = agentId
  try {
    const result = await runGate(fixture, {
      messages: [{
        id: messageId,
        role: 'user',
        content: 'Todavía no cumplo ninguna condición'
      }],
      latestInbound: 'Todavía no cumplo ninguna condición',
      adjudication: {
        decision: 'no_match',
        modelCallCount: 1
      },
      contactId,
      executionId: messageId,
      inboundClaim,
      dryRun: false
    })
    assert.equal(result.handled, false)
    const row = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ?
         AND event_type = 'mandatory_handoff_no_match_audited'`,
      [contactId, agentId]
    )
    assert.ok(row?.detail_json)
    assert.ok(row.detail_json.length < 4000)
    const detail = JSON.parse(row.detail_json)
    assert.equal(detail.schemaVersion, 1)
    assert.equal(detail.ruleAssessments.length, 20)
    assert.equal(detail.ruleAssessments.every((item) => /^[a-f0-9]{32}$/.test(item.evidenceHash)), true)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('una salida automática espera al handoff: un match gana y sólo no_match libera', async () => {
  const messages = [
    { role: 'user', content: 'El lunes de la próxima semana' },
    { role: 'assistant', content: '¿A qué hora?' },
    { role: 'user', content: 'A las 11:00 am' }
  ]
  const deferredAutomaticRelease = {
    reason: 'exit_rules',
    agentId: 'agent_handoff_test'
  }
  let mainCalls = 0
  let releaseCalls = 0
  const matchingFixture = buildFixture()
  const matchingTurn = await runToolCallingV2Turn({
    config: matchingFixture.built.ctx.config,
    runtime: { modelProvider: { kind: 'fake' } },
    messages,
    contactId: 'preview_contact',
    dryRun: true,
    channel: 'whatsapp',
    traceMessage: 'A las 11:00 am',
    executionId: 'preview_exit_and_handoff_match',
    deferredAutomaticRelease,
    applyDeferredAutomaticRelease: async () => {
      releaseCalls += 1
      return { applied: true, reason: 'exit_rules' }
    }
  }, {
    buildAgentForRun: async () => ({
      ...matchingFixture.built,
      agent: {},
      aiProvider: 'openai'
    }),
    executeAgent: async () => {
      mainCalls += 1
      return 'esta respuesta no debe generarse'
    },
    runInChannel: async (_channel, operation) => operation(),
    adjudicateHandoffRules: async () => ({
      decision: 'match',
      matchedRule: 'fecha y hora elegidas',
      reason: 'La persona eligió lunes a las 11:00',
      summary: 'Continuar con el equipo humano',
      modelCallCount: 1
    }),
    findPastClientEvidence: async () => false
  })
  assert.equal(matchingTurn.mandatoryHandoff.status, 'completed')
  assert.equal(mainCalls, 0)
  assert.equal(releaseCalls, 0)

  const noMatchFixture = buildFixture()
  const noMatchTurn = await runToolCallingV2Turn({
    config: noMatchFixture.built.ctx.config,
    runtime: { modelProvider: { kind: 'fake' } },
    messages,
    contactId: 'preview_contact',
    dryRun: true,
    channel: 'whatsapp',
    traceMessage: 'A las 11:00 am',
    executionId: 'preview_exit_without_handoff_match',
    deferredAutomaticRelease,
    applyDeferredAutomaticRelease: async () => {
      releaseCalls += 1
      return { applied: true, reason: 'exit_rules' }
    }
  }, {
    buildAgentForRun: async () => ({
      ...noMatchFixture.built,
      agent: {},
      aiProvider: 'openai'
    }),
    executeAgent: async () => {
      mainCalls += 1
      return 'borrador que debe descartarse al liberar'
    },
    runInChannel: async (_channel, operation) => operation(),
    adjudicateHandoffRules: async () => ({
      decision: 'no_match',
      matchedRule: null,
      reason: null,
      summary: null,
      modelCallCount: 1
    }),
    auditHandoffNoMatch: async ({ ruleClauses }) => ({
      decision: 'confirmed_no_match',
      ruleAssessments: ruleClauses.map((rule) => ({
        ruleId: rule.ruleId,
        verdict: 'not_satisfied',
        evidence: ['La persona todavía no eligió una fecha y hora.'],
        reasoning: 'Falta la selección completa.'
      })),
      modelCallCount: 1,
      source: 'test_independent_no_match_audit'
    }),
    findPastClientEvidence: async () => false
  })
  assert.equal(noMatchTurn.automaticRelease.applied, true)
  assert.equal(noMatchTurn.reply, '')
  assert.equal(mainCalls, 1)
  assert.equal(releaseCalls, 1)
})

test('una salida diferida permite pedir humano, pero cerca las demás mutaciones', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_deferred_tools_contact_${suffix}`
  const agentId = `handoff_deferred_tools_agent_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    dataRequirements: {
      fields: [{
        field: 'email',
        label: 'correo',
        level: 'required',
        scope: 'any_action'
      }]
    },
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: '- cuando la persona ya haya elegido una fecha y una hora'
    }, {
      id: 'schedule_appointment',
      enabled: true,
      calendarId: `calendar_deferred_tools_${suffix}`
    }]
  })
  await createLiveHandoffConversation({ contactId, agentId })
  const ctx = {
    config: { id: agentId, capabilitiesConfig },
    capabilitiesConfig,
    contactId,
    agentId,
    executionId: `handoff_deferred_tools_execution_${suffix}`,
    channel: 'whatsapp',
    dryRun: false,
    followUpMode: false,
    deferredAutomaticRelease: {
      reason: 'exit_rules',
      agentId
    },
    actions: []
  }

  try {
    const tools = createConversationalTools(ctx)
    const sendToHuman = tools.find((item) => item.name === 'send_to_human')
    const saveContactData = tools.find((item) => item.name === 'save_contact_data')
    assert.ok(sendToHuman)
    assert.ok(saveContactData)

    const handoff = await sendToHuman.invoke(null, JSON.stringify({
      motivo: 'La persona pidió atención humana',
      resumen: 'Continuar con el equipo'
    }))
    assert.equal(handoff.needsData, true)
    assert.equal(handoff.code, undefined)
    assert.equal(ctx.explicitHumanHandoffRequested, true)

    ctx.explicitHumanHandoffRequested = false
    const contactUpdate = await saveContactData.invoke(null, JSON.stringify({
      fullName: null,
      phone: null,
      email: 'no-debe-guardarse@example.com',
      company: null,
      customValues: null
    }))
    assert.equal(contactUpdate.code, 'automatic_release_waits_for_handoff_gate')
    assert.equal((await db.get('SELECT email FROM contacts WHERE id = ?', [contactId])).email, null)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('si falla el binding pre-turn con handoff obligatorio, ninguna terminal puede ejecutarse', async () => {
  const fixture = buildFixture({
    rules: '- cuando la cita quede agendada',
    extraCapabilities: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'calendar_pre_binding_failure'
    }]
  })
  let mainCalls = 0
  await assert.rejects(
    runToolCallingV2Turn({
      config: fixture.built.ctx.config,
      runtime: { modelProvider: { kind: 'fake' } },
      messages: [{ id: 'pre_binding_message', role: 'user', content: 'Confirma la cita' }],
      contactId: 'pre_binding_contact',
      channel: 'whatsapp',
      traceMessage: 'Confirma la cita',
      executionId: 'pre_binding_message',
      inboundClaim: {
        messageId: 'pre_binding_message',
        claimToken: 'pre_binding_claim',
        agentId: 'agent_handoff_test'
      },
      dryRun: false
    }, {
      buildAgentForRun: async () => ({
        ...fixture.built,
        agent: {},
        aiProvider: 'openai'
      }),
      loadHandoffConversationScope: async () => {
        throw new Error('scope storage unavailable')
      },
      executeAgent: async () => {
        mainCalls += 1
        return 'Nunca debe ejecutarse'
      },
      runInChannel: async (_channel, operation) => operation()
    }),
    (error) => {
      assert.equal(error.code, 'mandatory_handoff_pre_terminal_binding_failed')
      assert.equal(error.mandatoryHandoffGateRetryable, true)
      return true
    }
  )
  assert.equal(mainCalls, 0)
})

test('si falla la relectura post-terminal, el error queda marcado para recuperación y no se degrada a no_match', async () => {
  const fixture = buildFixture({
    rules: '- cuando la cita quede agendada',
    extraCapabilities: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'calendar_post_binding_failure'
    }]
  })
  let scopeLoads = 0
  let mainCalls = 0
  await assert.rejects(
    runToolCallingV2Turn({
      config: fixture.built.ctx.config,
      runtime: { modelProvider: { kind: 'fake' } },
      messages: [{ id: 'post_binding_message', role: 'user', content: 'Confirma la cita' }],
      contactId: 'post_binding_contact',
      channel: 'whatsapp',
      traceMessage: 'Confirma la cita',
      executionId: 'post_binding_message',
      inboundClaim: {
        messageId: 'post_binding_message',
        claimToken: 'post_binding_claim',
        agentId: 'agent_handoff_test'
      },
      dryRun: false
    }, {
      buildAgentForRun: async () => ({
        ...fixture.built,
        agent: {},
        aiProvider: 'openai'
      }),
      loadHandoffConversationScope: async () => {
        scopeLoads += 1
        if (scopeLoads > 1) throw new Error('post-terminal scope read failed')
        return {
          stateId: 'post_binding_state',
          activationCycleId: 'post_binding_cycle',
          conversationScopeId: 'post_binding_scope',
          cutoffIso: '2026-07-30T10:00:00.000Z',
          status: 'active',
          signal: null
        }
      },
      resolveMandatoryHandoff: async () => ({
        handled: false,
        modelCallCount: 0,
        mandatoryHandoff: { status: 'not_matched' }
      }),
      executeAgent: async () => {
        mainCalls += 1
        fixture.built.ctx.actions.push({
          type: 'book_appointment',
          outcome: {
            status: 'ok',
            ok: true,
            actionCompleted: true,
            objectiveCompleted: true,
            appointmentId: 'post_binding_appointment'
          }
        })
        return 'La cita quedó'
      },
      runInChannel: async (_channel, operation) => operation()
    }),
    (error) => {
      assert.equal(error.code, 'mandatory_handoff_post_terminal_binding_failed')
      assert.equal(error.mandatoryHandoffGateRetryable, true)
      assert.equal(error.mandatoryHandoffGatePhase, 'post')
      return true
    }
  )
  assert.equal(mainCalls, 1)
  assert.equal(scopeLoads, 2)
})

test('el runner resuelve el ledger terminal inmediato y no vuelve a adjudicar la cita por memoria', async () => {
  const fixture = buildFixture({
    rules: '- cuando la cita quede agendada',
    extraCapabilities: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'calendar_terminal_pending_immediate'
    }]
  })
  const pendingEventId = 'cae_terminal_pending_immediate'
  let scopeLoads = 0
  let pendingResolutions = 0
  let legacyPostGateCalls = 0
  const result = await runToolCallingV2Turn({
    config: fixture.built.ctx.config,
    runtime: { modelProvider: { kind: 'fake' } },
    messages: [{
      id: 'terminal_pending_immediate_message',
      role: 'user',
      content: 'Confirma la cita'
    }],
    contactId: 'terminal_pending_immediate_contact',
    channel: 'whatsapp',
    traceMessage: 'Confirma la cita',
    executionId: 'terminal_pending_immediate_message',
    inboundClaim: {
      messageId: 'terminal_pending_immediate_message',
      claimToken: 'terminal_pending_immediate_claim',
      agentId: 'agent_handoff_test'
    },
    dryRun: false
  }, {
    buildAgentForRun: async () => ({
      ...fixture.built,
      agent: {},
      aiProvider: 'openai'
    }),
    loadHandoffConversationScope: async () => {
      scopeLoads += 1
      return {
        stateId: 'terminal_pending_immediate_state',
        activationCycleId: 'terminal_pending_immediate_cycle',
        conversationScopeId: 'terminal_pending_immediate_scope',
        cutoffIso: '2026-07-30T10:00:00.000Z',
        status: 'active',
        signal: null
      }
    },
    resolveMandatoryHandoff: async ({ phase = 'pre' }) => {
      if (phase === 'post') legacyPostGateCalls += 1
      return {
        handled: false,
        modelCallCount: 0,
        mandatoryHandoff: { status: 'not_matched' }
      }
    },
    executeAgent: async () => {
      fixture.built.ctx.actions.push({
        type: 'book_appointment',
        outcome: {
          status: 'ok',
          ok: true,
          actionCompleted: true,
          objectiveCompleted: true,
          appointmentId: 'terminal_pending_immediate_appointment'
        }
      })
      fixture.built.ctx.synchronousTerminalHandoffPendingEventId = pendingEventId
      return 'La cita quedó agendada'
    },
    resolveVerifiedTerminalHandoffPending: async ({ pendingEventId: receivedId }) => {
      pendingResolutions += 1
      assert.equal(receivedId, pendingEventId)
      return {
        completed: true,
        decision: 'match',
        source: 'configured_rules',
        modelCallCount: 2,
        result: { applied: true, handoffCompleted: true }
      }
    },
    runInChannel: async (_channel, operation) => operation()
  })

  assert.equal(result.handled, true)
  assert.equal(result.reply, '')
  assert.equal(result.mandatoryHandoff.status, 'completed')
  assert.equal(result.mandatoryHandoff.latchId, pendingEventId)
  assert.equal(scopeLoads, 1)
  assert.equal(pendingResolutions, 1)
  assert.equal(legacyPostGateCalls, 0)
})

test('si la terminal delega datos obligatorios, el mismo turno pregunta y no afirma el handoff', async () => {
  const fixture = buildFixture({
    rules: '- cuando la cita quede agendada',
    extraCapabilities: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'calendar_terminal_pending_required_data'
    }]
  })
  const pendingEventId = 'cae_terminal_pending_required_data'
  const handoffLatchId = 'cae_handoff_rule_required_data'
  let terminalResolutionDependencies = null
  const result = await runToolCallingV2Turn({
    config: fixture.built.ctx.config,
    runtime: { modelProvider: { kind: 'fake' } },
    messages: [{
      id: 'terminal_pending_required_data_message',
      role: 'user',
      content: 'Confirma la cita'
    }],
    contactId: 'terminal_pending_required_data_contact',
    channel: 'whatsapp',
    traceMessage: 'Confirma la cita',
    executionId: 'terminal_pending_required_data_message',
    inboundClaim: {
      messageId: 'terminal_pending_required_data_message',
      claimToken: 'terminal_pending_required_data_claim',
      agentId: 'agent_handoff_test'
    },
    dryRun: false
  }, {
    buildAgentForRun: async () => ({
      ...fixture.built,
      agent: {},
      aiProvider: 'openai'
    }),
    loadHandoffConversationScope: async () => ({
      stateId: 'terminal_pending_required_data_state',
      activationCycleId: 'terminal_pending_required_data_cycle',
      conversationScopeId: 'terminal_pending_required_data_scope',
      cutoffIso: '2026-07-30T10:00:00.000Z',
      status: 'active',
      signal: null
    }),
    resolveMandatoryHandoff: async () => ({
      handled: false,
      modelCallCount: 0,
      mandatoryHandoff: { status: 'not_matched' }
    }),
    executeAgent: async () => {
      fixture.built.ctx.actions.push({
        type: 'book_appointment',
        outcome: {
          status: 'ok',
          ok: true,
          actionCompleted: true,
          objectiveCompleted: true,
          appointmentId: 'terminal_pending_required_data_appointment'
        }
      })
      fixture.built.ctx.synchronousTerminalHandoffPendingEventId = pendingEventId
      return 'La cita quedó agendada'
    },
    resolveVerifiedTerminalHandoffPending: async (_payload, dependencies) => {
      terminalResolutionDependencies = dependencies
      return {
        completed: true,
        decision: 'match',
        source: 'configured_rules',
        modelCallCount: 2,
        result: {
          applied: false,
          handoffCompleted: false,
          awaitingRequiredData: true,
          handoffLatchId,
          missingRequiredFields: [{
            field: 'full_name',
            label: 'nombre completo'
          }],
          requiredDataPromptDelivery: {
            settled: true,
            durableStatus: 'completed',
            reply: 'Tu cita ya quedó agendada. Antes de pasarte con el equipo, ¿me compartes tu nombre completo?'
          }
        }
      }
    },
    runInChannel: async (_channel, operation) => operation()
  })

  assert.equal(result.handled, true)
  assert.equal(result.mandatoryHandoff.status, 'awaiting_required_data')
  assert.equal(result.mandatoryHandoff.latchId, handoffLatchId)
  assert.deepEqual(result.mandatoryHandoff.requiredFields, [{
    field: 'full_name',
    label: 'nombre completo'
  }])
  assert.equal(result.reply, '')
  assert.notEqual(
    terminalResolutionDependencies?.deferRequiredDataPromptDelivery,
    true
  )
})

test('el plan terminal no_match ya entregado suprime la respuesta normal para no duplicar la cita', async () => {
  const fixture = buildFixture({
    rules: '- sólo si el paciente pide una persona',
    extraCapabilities: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'calendar_terminal_pending_no_match'
    }]
  })
  const pendingEventId = 'cae_terminal_pending_no_match'
  const result = await runToolCallingV2Turn({
    config: fixture.built.ctx.config,
    runtime: { modelProvider: { kind: 'fake' } },
    messages: [{
      id: 'terminal_pending_no_match_message',
      role: 'user',
      content: 'Confirma la cita'
    }],
    contactId: 'terminal_pending_no_match_contact',
    channel: 'whatsapp',
    traceMessage: 'Confirma la cita',
    executionId: 'terminal_pending_no_match_message',
    inboundClaim: {
      messageId: 'terminal_pending_no_match_message',
      claimToken: 'terminal_pending_no_match_claim',
      agentId: 'agent_handoff_test'
    },
    dryRun: false
  }, {
    buildAgentForRun: async () => ({
      ...fixture.built,
      agent: {},
      aiProvider: 'openai'
    }),
    loadHandoffConversationScope: async () => ({
      stateId: 'terminal_pending_no_match_state',
      activationCycleId: 'terminal_pending_no_match_cycle',
      conversationScopeId: 'terminal_pending_no_match_scope',
      cutoffIso: '2026-07-30T10:00:00.000Z',
      status: 'active',
      signal: null
    }),
    resolveMandatoryHandoff: async () => ({
      handled: false,
      modelCallCount: 0,
      mandatoryHandoff: { status: 'not_matched' }
    }),
    executeAgent: async () => {
      fixture.built.ctx.actions.push({
        type: 'book_appointment',
        outcome: {
          status: 'ok',
          ok: true,
          actionCompleted: true,
          objectiveCompleted: true,
          appointmentId: 'terminal_pending_no_match_appointment'
        }
      })
      fixture.built.ctx.synchronousTerminalHandoffPendingEventId = pendingEventId
      return 'La cita quedó agendada'
    },
    resolveVerifiedTerminalHandoffPending: async (_payload, dependencies) => {
      assert.notEqual(dependencies?.deferRequiredDataPromptDelivery, true)
      return {
        completed: true,
        decision: 'no_match',
        source: 'independent_no_match_audit',
        modelCallCount: 2,
        result: {
          applied: false,
          handoffCompleted: false,
          terminalMessageDelivery: {
            settled: true,
            durableStatus: 'completed',
            reply: 'Listo, tu cita ya quedó agendada.'
          }
        }
      }
    },
    runInChannel: async (_channel, operation) => operation()
  })

  assert.equal(result.handled, true)
  assert.equal(result.reply, '')
  assert.equal(result.mandatoryHandoff.status, 'terminal_preserved_no_match')
  assert.equal(result.mandatoryHandoff.latchId, pendingEventId)
})

test('evalúa completo el campo visible de reglas hasta 4000 caracteres', async () => {
  const marker = 'CONDICION_DEL_ULTIMO_CUARTO'
  const rules = `${'regla de contexto\n'.repeat(220)}\n- ${marker}`.slice(-4000)
  const fixture = buildFixture({ rules })
  const result = await runGate(fixture, {
    adjudication: {
      decision: 'no_match',
      matchedRule: null,
      reason: null,
      summary: null,
      modelCallCount: 1
    },
    onAdjudicate: ({ rules: receivedRules }) => {
      assert.equal(receivedRules, rules)
      assert.match(receivedRules, new RegExp(marker))
      assert.ok(receivedRules.length > 3000)
    }
  })

  assert.equal(result.handled, false)
})

test('proyecta server-side sólo los datos obligatorios solicitados y first_name acepta una palabra', () => {
  const projected = projectToolCallingV2RequiredHandoffData({
    fullName: 'Juan',
    phone: '+525511111111',
    email: 'no-solicitado@example.com',
    company: 'No solicitada',
    customValues: [
      { key: 'Número de póliza', value: 'POL-123' },
      { key: 'Secreto opcional', value: 'NO-GUARDAR' }
    ]
  }, [
    { field: 'first_name', label: 'nombre' },
    { field: 'phone', label: 'teléfono' },
    { field: 'custom', label: 'Número de póliza' }
  ])

  assert.deepEqual(projected, {
    fullName: 'Juan',
    phone: '+525511111111',
    customValues: [{ key: 'Número de póliza', value: 'POL-123' }]
  })
})

test('el recolector preventivo consume empresa y dirección una por una sin quedar en ciclo', () => {
  const requiredFields = [
    { field: 'company', label: 'empresa' },
    { field: 'address', label: 'dirección' }
  ]
  const company = extractDeterministicToolCallingV2RequiredHandoffData({
    requiredFields,
    latestInbound: 'Mi empresa es Órbita Médica'
  })
  assert.deepEqual(company.values, { company: 'Órbita Médica' })

  const address = extractDeterministicToolCallingV2RequiredHandoffData({
    requiredFields: requiredFields.slice(1),
    latestInbound: 'Mi dirección es Avenida Reforma 120'
  })
  assert.deepEqual(address.values, { address: 'Avenida Reforma 120' })
  assert.equal(company.modelCallCount + address.modelCallCount, 0)
})

test('un solo número nunca completa teléfono principal y alterno a la vez', () => {
  const extracted = extractDeterministicToolCallingV2RequiredHandoffData({
    requiredFields: [
      { field: 'phone', label: 'teléfono' },
      { field: 'alternate_phone', label: 'otro teléfono' }
    ],
    latestInbound: 'Mi teléfono es +52 55 1234 5678'
  })
  assert.deepEqual(extracted.values, { phone: '+52 55 1234 5678' })
  assert.equal(extracted.values.alternatePhone, undefined)
})

test('descarta nombre, correo y dato personalizado inventados por el extractor', async () => {
  const requiredFields = [
    { field: 'full_name', label: 'nombre completo' },
    { field: 'email', label: 'correo' },
    { field: 'custom', label: 'Número de póliza' }
  ]
  const invented = {
    fullName: 'Mariana López',
    email: 'mariana@example.com',
    customValues: [{ key: 'Número de póliza', value: 'POL-999' }]
  }
  const grounded = groundToolCallingV2RequiredHandoffData(
    invented,
    requiredFields,
    {
      messages: [{
        role: 'user',
        content: 'El lunes de la próxima semana a las 11:00 am'
      }],
      latestInbound: 'Sí, ese horario me funciona'
    }
  )
  assert.deepEqual(grounded, {})

  const missing = {
    ok: false,
    needsData: true,
    requiredFields
  }
  const fixture = buildFixture({
    sendResults: [missing, { ok: true, simulated: true }]
  })
  const result = await runGate(fixture, {
    latestInbound: 'Sí, ese horario me funciona',
    extraction: { values: invented, modelCallCount: 1 }
  })
  assert.equal(result.mandatoryHandoff.status, 'awaiting_required_data')
  assert.deepEqual(fixture.calls.map((call) => call.tool), ['send_to_human'])
})

test('acepta procedencia explícita aunque cambien mayúsculas, acentos, puntuación o espacios', () => {
  const requiredFields = [
    { field: 'full_name', label: 'nombre completo' },
    { field: 'phone', label: 'teléfono' },
    { field: 'email', label: 'correo' },
    { field: 'company', label: 'empresa' },
    { field: 'address', label: 'dirección' },
    { field: 'custom', label: 'Color preferido' }
  ]
  const grounded = groundToolCallingV2RequiredHandoffData({
    fullName: 'Ángel Aarón Salinas',
    phone: '+52 563 231 3412',
    email: 'angel.salinas@example.com',
    company: 'Órbita Médica S.A.',
    address: 'Av. de la República 120, Col. Centro',
    customValues: [{ key: 'Color preferido', value: 'Azul marino' }]
  }, requiredFields, {
    messages: [{
      role: 'assistant',
      content: 'El correo que imagino es falso@example.com'
    }, {
      role: 'user',
      content: [
        'Mi nombre es   Ángel Aarón Salinas.',
        'Teléfono: +52 (563) 231-3412.',
        'Correo: ANGEL.SALINAS@EXAMPLE.COM.',
        'Empresa: Orbita Médica, S.A.',
        'Dirección: Av. de la República #120, Col. Centro.',
        'Color preferido: azul   marino.'
      ].join(' ')
    }]
  })
  assert.deepEqual(grounded, {
    fullName: 'Ángel Aarón Salinas',
    phone: '+52 563 231 3412',
    email: 'angel.salinas@example.com',
    company: 'Órbita Médica S.A.',
    address: 'Av. de la República 120, Col. Centro',
    customValues: [{ key: 'Color preferido', value: 'Azul marino' }]
  })
})

test('un dato obligatorio explícito hace más de 20 mensajes sigue sirviendo en el ciclo', async () => {
  const missingName = {
    ok: false,
    needsData: true,
    requiredFields: [{ field: 'full_name', label: 'nombre completo' }]
  }
  const fixture = buildFixture({
    sendResults: [
      missingName,
      { ok: true, simulated: true, wouldNotifyHuman: true }
    ]
  })
  const messages = [{
    role: 'user',
    content: 'Mi nombre completo es Ángel Aarón Salinas'
  }]
  for (let index = 0; index < 25; index += 1) {
    messages.push({
      role: index % 2 ? 'assistant' : 'user',
      content: `Mensaje intermedio ${index + 1}`
    })
  }
  messages.push({ role: 'user', content: 'El lunes a las 11:00 am' })
  const result = await runGate(fixture, {
    messages,
    latestInbound: 'El lunes a las 11:00 am',
    extraction: {
      values: { fullName: 'Ángel Aarón Salinas' },
      modelCallCount: 1
    }
  })
  assert.equal(result.mandatoryHandoff.status, 'completed')
  assert.deepEqual(fixture.calls.map((call) => call.tool), [
    'send_to_human',
    'save_contact_data',
    'send_to_human'
  ])
})

test('la revisión posterior recibe sólo hechos mecánicos y puede activar una regla de falta de horarios', async () => {
  const fixture = buildFixture({
    rules: 'si no hay ningún horario disponible, pasar a humano'
  })
  const trustedRuntimeFacts = buildToolCallingV2MandatoryHandoffRuntimeFacts({
    appointmentReadActions: [{
      type: 'get_free_slots',
      total: 0,
      returned: 0,
      found: false,
      outcome: { status: 'ok', code: null }
    }]
  })
  const result = await runGate(fixture, {
    phase: 'post',
    trustedRuntimeFacts,
    adjudication: {
      decision: 'match',
      matchedRule: 'si no hay ningún horario disponible',
      reason: 'La consulta real devolvió cero horarios',
      summary: 'Se necesita apoyo para encontrar otro horario',
      modelCallCount: 1
    },
    onAdjudicate: ({ trustedRuntimeFacts: receivedFacts }) => {
      assert.deepEqual(receivedFacts, trustedRuntimeFacts)
      assert.deepEqual(receivedFacts.appointmentReads, [{
        tool: 'get_free_slots',
        status: 'ok',
        code: null,
        found: false,
        total: 0,
        returned: 0,
        availabilityVerificationRequired: false
      }])
    }
  })

  assert.equal(result.handled, true)
  assert.equal(result.mandatoryHandoff.status, 'completed')
})

test('si el mismo mensaje requiere revisión preventiva, aplica seguridad y después cumple el handoff', async () => {
  const fixture = buildFixture({
    rules: 'cuando pida hablar con una persona'
  })
  fixture.built.tools.unshift({
    name: 'apply_safety_measure',
    invoke: async (_context, payload) => {
      fixture.calls.push({ tool: 'apply_safety_measure', values: JSON.parse(payload) })
      fixture.actions.push({
        type: 'apply_safety_measure',
        suppressReply: true,
        terminal: true,
        outcome: {
          status: 'simulated',
          ok: true,
          suppressReply: true,
          terminal: true
        }
      })
      return { ok: true, simulated: true, wouldQuarantine: true }
    }
  })
  const result = await runGate(fixture, {
    adjudication: {
      decision: 'match',
      matchedRule: 'cuando pida hablar con una persona',
      reason: 'Pidió una persona',
      summary: 'Requiere atención humana',
      modelCallCount: 1
    },
    safetyAdjudication: {
      decision: 'apply',
      payload: {
        category: 'threat',
        severity: 'critical',
        confidence: 'certain',
        reason: 'Amenaza explícita y creíble',
        evidenceSummary: 'La persona formuló una amenaza directa.'
      },
      modelCallCount: 1,
      source: 'test_safety_preflight'
    }
  })

  assert.equal(result.handled, true)
  assert.equal(result.mandatoryHandoff.status, 'completed')
  assert.deepEqual(
    fixture.calls.map((call) => call.tool),
    ['apply_safety_measure', 'send_to_human']
  )
})

test('urgencia médica fuera de categorías preventivas nunca silencia un handoff obligatorio', () => {
  const decision = normalizeToolCallingV2MandatoryHandoffSafetyDecision({
    decision: 'apply',
    category: 'other',
    severity: 'high',
    confidence: 'high',
    reason: 'Urgencia médica con dolor y debilidad',
    evidenceSummary: 'Dolor lumbar, entumecimiento y debilidad'
  })

  assert.deepEqual(decision, {
    decision: 'clear',
    category: null,
    severity: null,
    confidence: null,
    reason: null,
    evidenceSummary: null
  })
})

test('una obligación con seguridad preventiva se transfiere una sola vez y cierra su latch', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_safety_latch_contact_${suffix}`
  const agentId = `handoff_safety_latch_agent_${suffix}`
  const messageId = `handoff_safety_latch_message_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: 'cuando pida hablar con una persona'
    }]
  })
  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente handoff con seguridad', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(capabilitiesConfig)]
  )
  const { inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId,
    messageText: 'Quiero hablar con una persona'
  })
  const fixture = buildFixture({
    rules: 'cuando pida hablar con una persona',
    onSend: async (ctx) => {
      await ctx.mandatoryHandoffAuthorityFence()
    }
  })
  fixture.built.ctx.config = await getConversationalAgent(agentId)
  fixture.built.ctx.capabilitiesConfig = capabilitiesConfig
  fixture.built.capabilityManifest = buildConversationalCapabilityManifest(
    fixture.built.ctx.config
  )
  fixture.built.tools.unshift({
    name: 'apply_safety_measure',
    invoke: async (_context, payload) => {
      fixture.calls.push({ tool: 'apply_safety_measure', values: JSON.parse(payload) })
      return { ok: true, suppressReply: true, terminal: true }
    }
  })
  let adjudicatorCalls = 0
  const safetyAdjudication = {
    decision: 'apply',
    payload: {
      category: 'threat',
      severity: 'critical',
      confidence: 'certain',
      reason: 'Amenaza explícita y creíble',
      evidenceSummary: 'La persona formuló una amenaza directa.'
    },
    modelCallCount: 1,
    source: 'test_safety_preflight'
  }

  try {
    const first = await runGate(fixture, {
      messages: [{ id: messageId, role: 'user', content: 'Quiero hablar con una persona' }],
      latestInbound: 'Quiero hablar con una persona',
      contactId,
      executionId: messageId,
      inboundClaim,
      dryRun: false,
      safetyAdjudication,
      onAdjudicate: () => { adjudicatorCalls += 1 }
    })
    assert.equal(first.mandatoryHandoff.status, 'completed')
    assert.equal(adjudicatorCalls, 1)

    const second = await runGate(fixture, {
      messages: [{ id: messageId, role: 'user', content: 'Quiero hablar con una persona' }],
      latestInbound: 'Quiero hablar con una persona',
      contactId,
      executionId: messageId,
      inboundClaim,
      dryRun: false,
      safetyAdjudication,
      adjudication: {
        decision: 'no_match',
        matchedRule: null,
        reason: null,
        summary: null,
        modelCallCount: 1
      },
      onAdjudicate: () => { adjudicatorCalls += 1 }
    })
    assert.equal(second.mandatoryHandoff.status, 'not_matched')
    assert.equal(adjudicatorCalls, 2, 'el latch completado ya no se considera vigente')
    assert.deepEqual(
      fixture.calls.map((call) => call.tool),
      ['apply_safety_measure', 'send_to_human']
    )
    const latch = await db.get(
      `SELECT detail_json
       FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'handoff_rule_pending'`,
      [contactId, agentId]
    )
    assert.equal(JSON.parse(latch.detail_json).status, 'completed')
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('un fallo transitorio bajo cuarentena reencola el mismo inbound y el retry lo completa', async () => {
  const agentId = 'agent_preventive_retry'
  const contactId = 'contact_preventive_retry'
  const messageId = 'message_preventive_retry'
  const agentConfig = {
    id: agentId,
    enabled: true,
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig: normalizeConversationalCapabilitiesConfig({
      items: [{
        id: 'handoff_human',
        enabled: true,
        rules: 'cuando la persona pida atención humana'
      }]
    })
  }
  let resolutionAttempt = 0
  let queuedInput = null
  let fallbackFailureCount = 0
  const completedMessages = []
  const dependencies = {
    getAgent: async () => agentConfig,
    loadConversationScope: async () => ({
      status: 'active',
      signal: null,
      conversationScopeId: 'scope_preventive_retry'
    }),
    loadActiveLatch: async () => ({ id: 'latch_preventive_retry' }),
    loadInbound: async () => ({
      id: messageId,
      message_text: 'Sí, quiero que me atienda una persona'
    }),
    claimInbound: async () => ({
      claimed: true,
      claimToken: `claim_preventive_retry_${resolutionAttempt + 1}`,
      state: { inboundProcessingAttemptCount: resolutionAttempt + 1 }
    }),
    resolveMandatoryHandoff: async () => {
      resolutionAttempt += 1
      if (resolutionAttempt === 1) {
        throw Object.assign(new Error('bloqueo transitorio'), {
          code: 'SQLITE_BUSY'
        })
      }
      return {
        handled: true,
        modelCallCount: 0,
        mandatoryHandoff: {
          status: 'completed',
          latchId: 'latch_preventive_retry'
        }
      }
    },
    failAndQueueRetry: async (input) => {
      queuedInput = input
      return { queued: true }
    },
    failInbound: async () => {
      fallbackFailureCount += 1
      return { failed: true }
    },
    completeInbound: async (_contactId, completedMessageId) => {
      completedMessages.push(completedMessageId)
      return { completed: true }
    },
    recordEvent: async () => ({ recorded: true })
  }
  const request = {
    contactId,
    phone: '+525512345678',
    messageId,
    channel: 'whatsapp',
    preventiveMeasure: {
      id: 'safety_preventive_retry',
      latestAgentId: agentId
    }
  }

  const first = await recoverPreventiveMandatoryHandoffInbound(
    request,
    dependencies
  )
  assert.equal(first.handled, true)
  assert.equal(first.failed, true)
  assert.equal(first.retryQueued, true)
  assert.equal(queuedInput.claim.messageId, messageId)
  assert.equal(queuedInput.plan.retry, true)
  assert.equal(queuedInput.plan.stage, 'preventive_handoff_recovery')
  assert.equal(fallbackFailureCount, 0)

  const retry = await recoverPreventiveMandatoryHandoffInbound(
    request,
    dependencies
  )
  assert.equal(retry.handled, true)
  assert.equal(retry.consumed, true)
  assert.equal(retry.result.mandatoryHandoff.status, 'completed')
  assert.deepEqual(completedMessages, [messageId])
  assert.equal(resolutionAttempt, 2)
})

test('tres fallos consecutivos al reclamar bajo cuarentena escalan con contador durable', async () => {
  const suffix = randomUUID()
  const contactId = `contact_preventive_unclaimed_${suffix}`
  const messageId = `message_preventive_unclaimed_${suffix}`
  const agentId = `agent_preventive_unclaimed_${suffix}`
  const agentConfig = {
    id: agentId,
    enabled: true,
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig: normalizeConversationalCapabilitiesConfig({
      items: [{
        id: 'handoff_human',
        enabled: true,
        rules: 'cuando la persona pida atención humana'
      }]
    })
  }
  await db.run(`
    CREATE TABLE IF NOT EXISTS ai_agent_pending_reruns (
      run_key TEXT PRIMARY KEY,
      contact_id TEXT,
      channel TEXT,
      scheduled_for TEXT,
      payload TEXT,
      created_at TEXT
    )
  `)
  try {
    for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
      const result = await recoverPreventiveMandatoryHandoffInbound({
        contactId,
        phone: '+525512345670',
        messageId,
        channel: 'whatsapp',
        preventiveMeasure: {
          id: `safety_unclaimed_${suffix}`,
          latestAgentId: agentId
        }
      }, {
        getAgent: async () => agentConfig,
        loadConversationScope: async () => ({
          status: 'active',
          signal: null,
          conversationScopeId: `scope_unclaimed_${suffix}`
        }),
        loadActiveLatch: async () => ({
          id: `latch_unclaimed_${suffix}`
        }),
        claimInbound: async () => {
          throw Object.assign(new Error('claim transitorio'), {
            code: 'SQLITE_BUSY'
          })
        },
        scheduleRerun: () => undefined,
        recordEvent: async () => ({ recorded: true })
      })
      const pending = await db.get(
        `SELECT payload FROM ai_agent_pending_reruns
         WHERE contact_id = ? AND channel = 'whatsapp'`,
        [contactId]
      )
      const retry = JSON.parse(pending.payload).mandatoryHandoffRetry
      assert.equal(result.handled, true)
      assert.equal(result.failed, true)
      assert.equal(result.retryQueued, true)
      assert.equal(retry.attemptCount, expectedAttempt)
      assert.equal(
        retry.escalation,
        expectedAttempt >= MANDATORY_HANDOFF_GATE_MAX_ATTEMPTS
      )
    }
  } finally {
    await db.run(
      'DELETE FROM ai_agent_pending_reruns WHERE contact_id = ?',
      [contactId]
    ).catch(() => undefined)
  }
})

test('el tercer claim bajo cuarentena entra a la escalación canónica fail-closed', async () => {
  const agentId = 'agent_preventive_escalation'
  const contactId = 'contact_preventive_escalation'
  const messageId = 'message_preventive_escalation'
  let receivedClaim = null
  const completed = []
  const result = await recoverPreventiveMandatoryHandoffInbound({
    contactId,
    messageId,
    channel: 'whatsapp',
    preventiveMeasure: {
      id: 'safety_preventive_escalation',
      latestAgentId: agentId
    }
  }, {
    getAgent: async () => ({
      id: agentId,
      enabled: true,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: normalizeConversationalCapabilitiesConfig({
        items: [{
          id: 'handoff_human',
          enabled: true,
          rules: 'cuando la persona pida atención humana'
        }]
      })
    }),
    loadConversationScope: async () => ({
      status: 'active',
      signal: null,
      conversationScopeId: 'scope_preventive_escalation'
    }),
    loadActiveLatch: async () => ({ id: 'latch_preventive_escalation' }),
    claimInbound: async () => ({
      claimed: true,
      claimToken: 'claim_preventive_escalation',
      state: {
        inboundProcessingAttemptCount:
          MANDATORY_HANDOFF_GATE_MAX_ATTEMPTS
      }
    }),
    loadInbound: async () => ({
      id: messageId,
      message_text: 'Necesito atención humana'
    }),
    resolveMandatoryHandoff: async (input) => {
      receivedClaim = input.inboundClaim
      return {
        handled: true,
        modelCallCount: 0,
        mandatoryHandoff: {
          status: 'completed',
          latchId: 'latch_preventive_escalation'
        }
      }
    },
    completeInbound: async (_contactId, completedMessageId) => {
      completed.push(completedMessageId)
      return { completed: true }
    },
    recordEvent: async () => ({ recorded: true })
  })

  assert.equal(result.consumed, true)
  assert.equal(
    receivedClaim.attemptCount,
    MANDATORY_HANDOFF_GATE_MAX_ATTEMPTS
  )
  assert.equal(receivedClaim.mandatoryHandoffEscalationRequired, true)
  assert.equal(
    receivedClaim.mandatoryHandoffEscalationReason.marker,
    'mandatory_handoff_attempt_threshold'
  )
  assert.deepEqual(completed, [messageId])
})

test('si falla el lookup preventivo inicial, persiste el mismo inbound y después lo recupera', async () => {
  const suffix = randomUUID()
  const contactId = `contact_preventive_lookup_${suffix}`
  const messageId = `message_preventive_lookup_${suffix}`
  const agentId = `agent_preventive_lookup_${suffix}`
  await db.run(`
    CREATE TABLE IF NOT EXISTS ai_agent_pending_reruns (
      run_key TEXT PRIMARY KEY,
      contact_id TEXT,
      channel TEXT,
      scheduled_for TEXT,
      payload TEXT,
      created_at TEXT
    )
  `)
  try {
    await handleInboundConversationalMessage({
      contactId,
      phone: '+525512345671',
      messageId,
      channel: 'whatsapp'
    }, {
      loadPreventiveMeasure: async () => {
        throw Object.assign(new Error('lookup preventivo transitorio'), {
          code: 'SQLITE_BUSY'
        })
      },
      scheduleRerun: () => undefined
    })
    const pending = await db.get(
      `SELECT payload FROM ai_agent_pending_reruns
       WHERE contact_id = ? AND channel = 'whatsapp'`,
      [contactId]
    )
    const payload = JSON.parse(pending.payload)
    assert.equal(payload.messageId, messageId)
    assert.equal(
      payload.mandatoryHandoffRetry.stage,
      'preventive_measure_load'
    )
    assert.equal(payload.mandatoryHandoffRetry.attemptCount, 1)

    const completed = []
    const recovered = await recoverPreventiveMandatoryHandoffInbound({
      contactId,
      messageId,
      channel: 'whatsapp',
      preventiveMeasure: {
        id: `safety_preventive_lookup_${suffix}`,
        latestAgentId: agentId
      }
    }, {
      getAgent: async () => ({
        id: agentId,
        enabled: true,
        runtimeMode: 'tool_calling_v2',
        capabilitiesConfig: normalizeConversationalCapabilitiesConfig({
          items: [{
            id: 'handoff_human',
            enabled: true,
            rules: 'cuando la persona pida atención humana'
          }]
        })
      }),
      loadConversationScope: async () => ({
        status: 'active',
        signal: null,
        conversationScopeId: `scope_preventive_lookup_${suffix}`
      }),
      loadActiveLatch: async () => ({
        id: `latch_preventive_lookup_${suffix}`
      }),
      claimInbound: async () => ({
        claimed: true,
        claimToken: `claim_preventive_lookup_${suffix}`,
        state: { inboundProcessingAttemptCount: 1 }
      }),
      loadInbound: async () => ({
        id: messageId,
        message_text: 'Tania Salinas'
      }),
      resolveMandatoryHandoff: async (input) => ({
        handled: true,
        modelCallCount: 0,
        mandatoryHandoff: {
          status: 'completed',
          latchId: `latch_preventive_lookup_${suffix}`
        },
        ctx: input.built.ctx
      }),
      completeInbound: async (_contactId, completedMessageId) => {
        completed.push(completedMessageId)
        return { completed: true }
      },
      recordEvent: async () => ({ recorded: true })
    })
    assert.equal(recovered.consumed, true)
    assert.deepEqual(completed, [messageId])
  } finally {
    await db.run(
      'DELETE FROM ai_agent_pending_reruns WHERE contact_id = ?',
      [contactId]
    ).catch(() => undefined)
  }
})

test('seguridad preventiva y handoff reales cierran estado, latch y outbox en un solo commit terminal', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_live_safety_contact_${suffix}`
  const agentId = `handoff_live_safety_agent_${suffix}`
  const messageId = `handoff_live_safety_message_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    safetyPolicy: {
      enabled: true,
      action: 'stop_and_review',
      durationMinutes: 60,
      notify: false
    },
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: 'cuando pida hablar con una persona'
    }]
  })
  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente handoff safety real', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(capabilitiesConfig)]
  )
  const { inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId,
    messageText: 'Quiero hablar con una persona y voy a hacerles daño'
  })
  const config = await getConversationalAgent(agentId)
  const ctx = {
    config,
    capabilitiesConfig,
    contactId,
    agentId,
    executionId: messageId,
    inboundClaim,
    channel: 'whatsapp',
    dryRun: false,
    followUpMode: false,
    actions: []
  }
  const built = {
    model: 'fake-model',
    capabilityManifest: buildConversationalCapabilityManifest(config),
    ctx,
    tools: createConversationalTools(ctx)
  }
  const gateInput = {
    built,
    selectedMessages: [{
      id: messageId,
      role: 'user',
      content: 'Quiero hablar con una persona y voy a hacerles daño'
    }],
    latestInbound: 'Quiero hablar con una persona y voy a hacerles daño',
    runtime: { modelProvider: { kind: 'fake' } },
    contactId,
    channel: 'whatsapp',
    executionId: messageId,
    inboundClaim,
    dryRun: false
  }
  const gateDependencies = {
    adjudicateHandoffRules: async () => ({
      decision: 'match',
      matchedRule: 'cuando pida hablar con una persona',
      reason: 'Pidió atención humana',
      summary: 'El equipo debe continuar la conversación',
      modelCallCount: 1
    }),
    adjudicateHandoffSafety: async () => ({
      decision: 'apply',
      payload: {
        category: 'threat',
        severity: 'critical',
        confidence: 'certain',
        reason: 'Amenaza explícita y creíble contra el equipo.',
        evidenceSummary: 'La persona afirmó que hará daño y pidió atención humana.'
      },
      modelCallCount: 1,
      source: 'test_live_safety_preflight'
    }),
    extractRequiredHandoffData: async () => ({ values: null, modelCallCount: 0 }),
    findPastClientEvidence: async () => false
  }

  try {
    const result = await resolveToolCallingV2MandatoryHandoff(
      gateInput,
      gateDependencies
    )
    const state = await db.get(
      `SELECT status, signal
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agentId]
    )
    const latch = await db.get(
      `SELECT detail_json
       FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'handoff_rule_pending'`,
      [contactId, agentId]
    )
    const safetyCase = await db.get(
      `SELECT status, latest_source_message_id
       FROM conversational_agent_safety_cases
       WHERE contact_id = ? AND channel = 'whatsapp'`,
      [contactId]
    )
    const priorityJobs = await db.all(
      `SELECT message_id, payload_json
       FROM chat_delivery_outbox
       WHERE contact_id = ? AND provider = 'conversational_agent_priority'`,
      [contactId]
    )

    assert.equal(result.mandatoryHandoff.status, 'completed')
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
    assert.equal(JSON.parse(latch.detail_json).status, 'completed')
    assert.equal(safetyCase.status, 'active')
    assert.equal(safetyCase.latest_source_message_id, messageId)
    assert.equal(priorityJobs.length, 1)
    assert.equal(
      JSON.parse(priorityJobs[0].payload_json).handoffLatchId,
      result.mandatoryHandoff.latchId
    )

    await assert.rejects(
      resolveToolCallingV2MandatoryHandoff(gateInput, gateDependencies),
      (error) => error?.code === 'handoff_rule_conversation_scope_unavailable'
    )
    const priorityJobCount = await db.get(
      `SELECT COUNT(*) AS total
       FROM chat_delivery_outbox
       WHERE contact_id = ? AND provider = 'conversational_agent_priority'`,
      [contactId]
    )
    assert.equal(Number(priorityJobCount.total), 1)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('bajo cuarentena recolecta nombre y correo por etapas y completa el mismo latch sin modelo', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_safety_required_contact_${suffix}`
  const agentId = `handoff_safety_required_agent_${suffix}`
  const firstMessageId = `handoff_safety_required_message_1_${suffix}`
  const secondMessageId = `handoff_safety_required_message_2_${suffix}`
  const thirdMessageId = `handoff_safety_required_message_3_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    safetyPolicy: {
      enabled: true,
      action: 'stop_and_review',
      durationMinutes: 60,
      notify: false
    },
    dataRequirements: {
      enabled: true,
      fields: [
        {
          field: 'full_name',
          label: 'nombre completo',
          level: 'required',
          scope: 'any_action'
        },
        {
          field: 'email',
          label: 'correo',
          level: 'required',
          scope: 'any_action'
        }
      ],
      updateContact: {
        enabled: true,
        policy: 'replace_placeholders'
      }
    },
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: 'cuando pida hablar con una persona'
    }]
  })
  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente handoff safety con nombre', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(capabilitiesConfig)]
  )
  const { inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId: firstMessageId,
    messageText: 'Quiero hablar con una persona y voy a hacerles daño'
  })
  await db.run(
    `UPDATE contacts
     SET full_name = NULL, email = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [contactId]
  )
  await db.run(
    `UPDATE whatsapp_api_messages
     SET message_timestamp = '2026-07-30T10:00:00.000Z'
     WHERE id = ?`,
    [firstMessageId]
  )
  const config = await getConversationalAgent(agentId)
  const deliveredPrompts = []
  const deterministicExtractions = []
  const extractRequiredHandoffData = (input) => {
    const extracted = extractDeterministicToolCallingV2RequiredHandoffData(input)
    deterministicExtractions.push({
      latestInbound: input.latestInbound,
      requiredFields: input.requiredFields.map((item) => item.field),
      extracted
    })
    return extracted
  }
  const deliverRequiredDataPrompt = (payload) => (
    deliverVerifiedHandoffRequiredDataPrompt(payload, {
      deliverReply: async (deliveryInput) => {
        assert.equal(
          await deliveryInput.dependencies.loadPreventiveMeasure(),
          null,
          'sólo el helper canónico desactiva el bloqueo de entrega preventiva'
        )
        deliveredPrompts.push({
          reply: deliveryInput.reply,
          sourceMessageId: deliveryInput.latest.id,
          externalIdPrefix: deliveryInput.externalIdPrefix,
          missingFields: payload.missingFields.map((item) => item.field)
        })
        return {
          parts: [deliveryInput.reply],
          sentParts: 1,
          interruptedBy: null,
          durableStatus: 'completed'
        }
      }
    })
  )
  const firstCtx = {
    config,
    capabilitiesConfig,
    contactId,
    agentId,
    executionId: firstMessageId,
    inboundClaim,
    channel: 'whatsapp',
    dryRun: false,
    followUpMode: false,
    actions: []
  }
  const firstBuilt = {
    model: 'fake-model',
    capabilityManifest: buildConversationalCapabilityManifest(config),
    ctx: firstCtx,
    tools: createConversationalTools(firstCtx)
  }

  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_agent_pending_reruns (
        run_key TEXT PRIMARY KEY,
        contact_id TEXT,
        channel TEXT,
        scheduled_for TEXT,
        payload TEXT,
        created_at TEXT
      )
    `)
    const first = await resolveToolCallingV2MandatoryHandoff({
      built: firstBuilt,
      selectedMessages: [{
        id: firstMessageId,
        role: 'user',
        content: 'Quiero hablar con una persona y voy a hacerles daño'
      }],
      latestInbound: 'Quiero hablar con una persona y voy a hacerles daño',
      runtime: { modelProvider: { kind: 'fake' } },
      contactId,
      channel: 'whatsapp',
      executionId: firstMessageId,
      inboundClaim,
      dryRun: false
    }, {
      adjudicateHandoffRules: async () => ({
        decision: 'match',
        matchedRule: 'cuando pida hablar con una persona',
        reason: 'Pidió atención humana',
        summary: 'El equipo debe continuar la conversación',
        modelCallCount: 1
      }),
      adjudicateHandoffSafety: async () => ({
        decision: 'apply',
        payload: {
          category: 'threat',
          severity: 'critical',
          confidence: 'certain',
          reason: 'Amenaza explícita y creíble contra el equipo.',
          evidenceSummary: 'La persona afirmó que hará daño y pidió atención humana.'
        },
        modelCallCount: 1,
        source: 'test_live_safety_preflight'
      }),
      extractRequiredHandoffData: async () => ({
        values: null,
        modelCallCount: 0,
        source: 'test_no_name_yet'
      }),
      findPastClientEvidence: async () => false,
      deliverRequiredDataPrompt
    })
    assert.equal(first.mandatoryHandoff.status, 'awaiting_required_data')
    assert.equal(first.reply, '')
    assert.equal(deliveredPrompts.length, 1)
    assert.match(deliveredPrompts[0].reply, /nombre completo/i)
    assert.doesNotMatch(deliveredPrompts[0].reply, /correo/i)
    assert.match(
      deliveredPrompts[0].sourceMessageId,
      /^handoff-terminal:handoff-required:[a-f0-9]{48}:required_data$/
    )
    assert.deepEqual(deliveredPrompts[0].missingFields, ['full_name'])
    assert.equal(
      deliveredPrompts[0].externalIdPrefix,
      'convagent_handoff_terminal'
    )
    const completedFirstInbound = await completeConversationInboundMessage(
      contactId,
      firstMessageId,
      {
        agentId,
        channel: 'whatsapp',
        claimToken: inboundClaim.claimToken,
        answered: true
      }
    )
    assert.equal(completedFirstInbound.completed, true)

    const awaitingState = await db.get(
      `SELECT status, signal
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agentId]
    )
    const awaitingLatch = await db.get(
      `SELECT detail_json
       FROM conversational_agent_events
       WHERE id = ? AND event_type = 'handoff_rule_pending'`,
      [first.mandatoryHandoff.latchId]
    )
    assert.equal(awaitingState.status, 'active')
    assert.equal(awaitingState.signal, null)
    assert.equal(JSON.parse(awaitingLatch.detail_json).status, 'awaiting_required_data')

    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', 'Me llamo Tania Salinas', '2026-07-30T10:01:00.000Z')`,
      [secondMessageId, contactId]
    )
    const failedPreflight = await recoverPreventiveMandatoryHandoffInbound({
      contactId,
      messageId: secondMessageId,
      channel: 'whatsapp',
      preventiveMeasure: {
        id: `safety_${suffix}`,
        latestAgentId: agentId
      }
    }, {
      getAgent: async () => {
        throw Object.assign(new Error('lectura transitoria de agente'), {
          code: 'SQLITE_BUSY'
        })
      },
      failAndQueueRetry: (input) => (
        failInboundAndQueueMandatoryHandoffRetry(input, {
          scheduleRerun: () => undefined
        })
      ),
      recordEvent: async () => ({ recorded: true })
    })
    const failedPreflightState = await db.get(
      `SELECT inbound_processing_message_id, inbound_processing_status,
              inbound_processing_attempt_count
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agentId]
    )
    const queuedPreflight = await db.get(
      `SELECT payload
       FROM ai_agent_pending_reruns
       WHERE contact_id = ? AND channel = 'whatsapp'`,
      [contactId]
    )
    assert.equal(failedPreflight.handled, true)
    assert.equal(failedPreflight.failed, true)
    assert.equal(failedPreflight.retryQueued, true)
    assert.equal(
      failedPreflightState.inbound_processing_message_id,
      secondMessageId
    )
    assert.equal(failedPreflightState.inbound_processing_status, 'failed')
    assert.equal(failedPreflightState.inbound_processing_attempt_count, 1)
    assert.equal(
      JSON.parse(queuedPreflight.payload).messageId,
      secondMessageId
    )

    const nameRecovery = await recoverPreventiveMandatoryHandoffInbound({
      contactId,
      messageId: secondMessageId,
      channel: 'whatsapp',
      preventiveMeasure: {
        id: `safety_${suffix}`,
        latestAgentId: agentId
      }
    }, {
      deliverRequiredDataPrompt,
      extractRequiredHandoffData
    })
    const partialState = await db.get(
      `SELECT status, signal, last_answered_inbound_message_id
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agentId]
    )
    const partialLatch = await db.get(
      `SELECT detail_json
       FROM conversational_agent_events
       WHERE id = ? AND event_type = 'handoff_rule_pending'`,
      [first.mandatoryHandoff.latchId]
    )
    const partialContact = await db.get(
      'SELECT full_name, email FROM contacts WHERE id = ?',
      [contactId]
    )
    assert.equal(nameRecovery.handled, true)
    assert.equal(
      nameRecovery.consumed,
      true,
      JSON.stringify({
        reason: nameRecovery.reason,
        errorCode: nameRecovery.error?.code,
        errorMessage: nameRecovery.error?.message,
        status: nameRecovery.result?.mandatoryHandoff?.status
      })
    )
    assert.equal(nameRecovery.result.mandatoryHandoff.status, 'awaiting_required_data')
    assert.equal(nameRecovery.result.mandatoryHandoff.latchId, first.mandatoryHandoff.latchId)
    assert.equal(nameRecovery.result.modelCallCount, 0)
    assert.equal(partialState.status, 'active')
    assert.equal(partialState.signal, null)
    assert.equal(partialState.last_answered_inbound_message_id, secondMessageId)
    assert.equal(JSON.parse(partialLatch.detail_json).status, 'awaiting_required_data')
    assert.equal(
      partialContact.full_name,
      'Tania Salinas',
      JSON.stringify({
        actions: nameRecovery.result?.ctx?.actions || [],
        tools: nameRecovery.result?.tools?.map((item) => item.name) || [],
        updateContact: config.capabilitiesConfig?.dataRequirements?.updateContact,
        actionScoped: nameRecovery.result?.ctx?.actionScopedContactData,
        deterministicExtractions
      })
    )
    assert.equal(partialContact.email, null)
    assert.equal(deliveredPrompts.length, 2)
    assert.deepEqual(deliveredPrompts[1].missingFields, ['email'])
    assert.match(deliveredPrompts[1].reply, /correo/i)
    assert.notEqual(
      deliveredPrompts[1].sourceMessageId,
      deliveredPrompts[0].sourceMessageId
    )

    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', 'tania@example.com', '2026-07-30T10:02:00.000Z')`,
      [thirdMessageId, contactId]
    )
    const recovery = await recoverPreventiveMandatoryHandoffInbound({
      contactId,
      messageId: thirdMessageId,
      channel: 'whatsapp',
      preventiveMeasure: {
        id: `safety_${suffix}`,
        latestAgentId: agentId
      }
    }, {
      deliverRequiredDataPrompt,
      extractRequiredHandoffData
    })
    const finalState = await db.get(
      `SELECT status, signal, last_answered_inbound_message_id
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agentId]
    )
    const finalLatch = await db.get(
      `SELECT detail_json
       FROM conversational_agent_events
       WHERE id = ? AND event_type = 'handoff_rule_pending'`,
      [first.mandatoryHandoff.latchId]
    )
    const contact = await db.get(
      'SELECT full_name, email FROM contacts WHERE id = ?',
      [contactId]
    )
    const latchCount = await db.get(
      `SELECT COUNT(*) AS total
       FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'handoff_rule_pending'`,
      [contactId, agentId]
    )
    const priorityJobCount = await db.get(
      `SELECT COUNT(*) AS total
       FROM chat_delivery_outbox
       WHERE contact_id = ? AND provider = 'conversational_agent_priority'`,
      [contactId]
    )

    assert.equal(recovery.handled, true)
    assert.equal(recovery.consumed, true)
    assert.equal(recovery.result.mandatoryHandoff.status, 'completed')
    assert.equal(recovery.result.mandatoryHandoff.latchId, first.mandatoryHandoff.latchId)
    assert.equal(recovery.result.modelCallCount, 0)
    assert.equal(finalState.status, 'human')
    assert.equal(finalState.signal, 'ready_for_human')
    assert.equal(finalState.last_answered_inbound_message_id, secondMessageId)
    assert.equal(JSON.parse(finalLatch.detail_json).status, 'completed')
    assert.equal(contact.full_name, 'Tania Salinas')
    assert.equal(contact.email, 'tania@example.com')
    assert.equal(Number(latchCount.total), 1)
    assert.equal(Number(priorityJobCount.total), 1)
    assert.equal(deliveredPrompts.length, 2)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('un dato confirmado completa el handoff aunque la ficha conserve un primario legacy inválido', async (t) => {
  const scenarios = [{
    name: 'nombre placeholder Contacto',
    field: 'full_name',
    label: 'nombre completo',
    initial: {
      fullName: 'Contacto',
      firstName: null,
      lastName: null
    },
    reply: 'Me llamo Tania Salinas',
    expectedScopedField: 'full_name',
    expectedScopedValue: 'Tania Salinas',
    expectedStoredField: 'full_name',
    expectedStoredValue: 'Tania Salinas'
  }, {
    name: 'placeholder real Contacto WhatsApp_API',
    field: 'full_name',
    label: 'nombre completo',
    initial: {
      fullName: 'Contacto WhatsApp_API',
      firstName: 'Contacto WhatsApp_API',
      lastName: null
    },
    reply: 'Me llamo Tania Salinas',
    expectedScopedField: 'full_name',
    expectedScopedValue: 'Tania Salinas',
    expectedStoredField: 'full_name',
    expectedStoredValue: 'Tania Salinas'
  }, {
    name: 'nombre legacy de una sola palabra',
    field: 'full_name',
    label: 'nombre completo',
    initial: {
      fullName: 'Juan',
      firstName: 'Juan',
      lastName: null
    },
    reply: 'Me llamo Tania Salinas',
    expectedScopedField: 'full_name',
    expectedScopedValue: 'Tania Salinas',
    expectedStoredField: 'full_name',
    expectedStoredValue: 'Juan'
  }, {
    name: 'nombre sintético de Rebill derivado del correo',
    field: 'full_name',
    label: 'nombre completo',
    initial: {
      fullName: 'Ana Maria Ristak',
      firstName: null,
      lastName: null,
      email: 'ana.maria25@example.com'
    },
    reply: 'Me llamo Tania Salinas',
    expectedScopedField: 'full_name',
    expectedScopedValue: 'Tania Salinas',
    expectedStoredField: 'full_name',
    expectedStoredValue: 'Tania Salinas'
  }, {
    name: 'teléfono legacy inválido',
    field: 'phone',
    label: 'teléfono',
    initial: {
      fullName: 'Tania Salinas',
      firstName: 'Tania',
      lastName: 'Salinas',
      phone: '1234567890123456'
    },
    reply: '+52 55 1234 5678',
    expectedScopedField: 'phone',
    expectedScopedValue: '+525512345678',
    expectedStoredField: 'phone',
    expectedStoredValue: '1234567890123456'
  }, {
    name: 'correo legacy inválido',
    field: 'email',
    label: 'correo',
    initial: {
      fullName: 'Tania Salinas',
      firstName: 'Tania',
      lastName: 'Salinas',
      email: 'correo-invalido'
    },
    reply: 'tania.salinas@example.com',
    expectedScopedField: 'email',
    expectedScopedValue: 'tania.salinas@example.com',
    expectedStoredField: 'email',
    expectedStoredValue: 'correo-invalido'
  }]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const suffix = randomUUID()
      const contactId = `handoff_required_overlay_contact_${suffix}`
      const agentId = `handoff_required_overlay_agent_${suffix}`
      const firstMessageId = `handoff_required_overlay_1_${suffix}`
      const secondMessageId = `handoff_required_overlay_2_${suffix}`
      const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
        dataRequirements: {
          enabled: true,
          fields: [{
            field: scenario.field,
            label: scenario.label,
            level: 'required',
            scope: 'handoff'
          }],
          updateContact: {
            enabled: true,
            policy: 'replace_placeholders'
          }
        },
        items: [{
          id: 'handoff_human',
          enabled: true,
          rules: 'cuando la persona pida atención humana'
        }]
      })
      await db.run(
        `INSERT INTO conversational_agents
          (id, name, enabled, runtime_mode, capabilities_config)
         VALUES (?, 'Agente overlay de datos confirmados', 1, 'tool_calling_v2', ?)`,
        [agentId, JSON.stringify(capabilitiesConfig)]
      )
      const { inboundClaim: firstInboundClaim } =
        await createLiveHandoffConversation({
          contactId,
          agentId,
          messageId: firstMessageId,
          messageText: 'Quiero que me atienda una persona'
        })
      const originalContact = await db.get(
        'SELECT phone FROM contacts WHERE id = ?',
        [contactId]
      )
      await db.run(
        `UPDATE contacts
         SET full_name = ?, first_name = ?, last_name = ?,
             phone = ?, email = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          scenario.initial.fullName,
          scenario.initial.firstName,
          scenario.initial.lastName,
          scenario.initial.phone ?? originalContact.phone,
          scenario.initial.email ?? null,
          contactId
        ]
      )
      await db.run(
        `UPDATE whatsapp_api_messages
         SET message_timestamp = '2026-07-30T10:00:00.000Z'
         WHERE id = ?`,
        [firstMessageId]
      )
      const config = await getConversationalAgent(agentId)
      const deliveredPrompts = []
      const deliverRequiredDataPrompt = (payload) => (
        deliverVerifiedHandoffRequiredDataPrompt(payload, {
          deliverReply: async (deliveryInput) => {
            deliveredPrompts.push({
              reply: deliveryInput.reply,
              missingFields: payload.missingFields.map((item) => item.field)
            })
            return {
              parts: [deliveryInput.reply],
              sentParts: 1,
              interruptedBy: null,
              durableStatus: 'completed'
            }
          }
        })
      )
      const dependencies = {
        adjudicateHandoffRules: async () => ({
          decision: 'match',
          matchedRule: 'cuando la persona pida atención humana',
          reason: 'Pidió atención humana',
          summary: 'El equipo debe continuar la conversación',
          modelCallCount: 1
        }),
        adjudicateHandoffSafety: async () => ({
          decision: 'clear',
          modelCallCount: 0,
          source: 'test_required_overlay'
        }),
        findPastClientEvidence: async () => false,
        deliverRequiredDataPrompt
      }
      const firstCtx = {
        config,
        capabilitiesConfig,
        contactId,
        agentId,
        executionId: firstMessageId,
        inboundClaim: firstInboundClaim,
        channel: 'whatsapp',
        dryRun: false,
        followUpMode: false,
        actions: []
      }

      try {
        const first = await resolveToolCallingV2MandatoryHandoff({
          built: {
            model: 'fake-model',
            capabilityManifest: buildConversationalCapabilityManifest(config),
            ctx: firstCtx,
            tools: createConversationalTools(firstCtx)
          },
          selectedMessages: [{
            id: firstMessageId,
            role: 'user',
            content: 'Quiero que me atienda una persona'
          }],
          latestInbound: 'Quiero que me atienda una persona',
          runtime: { modelProvider: { kind: 'fake' } },
          contactId,
          channel: 'whatsapp',
          executionId: firstMessageId,
          inboundClaim: firstInboundClaim,
          dryRun: false
        }, {
          ...dependencies,
          extractRequiredHandoffData: async () => ({
            values: null,
            modelCallCount: 0,
            source: 'test_required_data_absent'
          })
        })
        assert.equal(first.mandatoryHandoff.status, 'awaiting_required_data')
        assert.equal(deliveredPrompts.length, 1)
        assert.deepEqual(deliveredPrompts[0].missingFields, [scenario.field])

        const completedFirst = await completeConversationInboundMessage(
          contactId,
          firstMessageId,
          {
            agentId,
            channel: 'whatsapp',
            claimToken: firstInboundClaim.claimToken,
            answered: true
          }
        )
        assert.equal(completedFirst.completed, true)

        await db.run(
          `INSERT INTO whatsapp_api_messages
            (id, contact_id, direction, message_type, message_text, message_timestamp)
           VALUES (?, ?, 'inbound', 'text', ?, '2026-07-30T10:01:00.000Z')`,
          [secondMessageId, contactId, scenario.reply]
        )
        const secondClaim = await claimConversationInboundMessage(
          contactId,
          secondMessageId,
          { agentId, channel: 'whatsapp' }
        )
        assert.equal(secondClaim.claimed, true)
        const secondInboundClaim = {
          ...secondClaim,
          messageId: secondMessageId
        }
        const secondCtx = {
          config,
          capabilitiesConfig,
          contactId,
          agentId,
          executionId: secondMessageId,
          inboundClaim: secondInboundClaim,
          channel: 'whatsapp',
          dryRun: false,
          followUpMode: false,
          actions: []
        }
        const second = await resolveToolCallingV2MandatoryHandoff({
          built: {
            model: 'fake-model',
            capabilityManifest:
              buildConversationalCapabilityManifest(config),
            ctx: secondCtx,
            tools: createConversationalTools(secondCtx)
          },
          selectedMessages: [{
            id: firstMessageId,
            role: 'user',
            content: 'Quiero que me atienda una persona'
          }, {
            id: secondMessageId,
            role: 'user',
            content: scenario.reply
          }],
          latestInbound: scenario.reply,
          runtime: { modelProvider: { kind: 'fake' } },
          contactId,
          channel: 'whatsapp',
          executionId: secondMessageId,
          inboundClaim: secondInboundClaim,
          dryRun: false
        }, {
          ...dependencies,
          extractRequiredHandoffData:
            extractDeterministicToolCallingV2RequiredHandoffData
        })
        const finalState = await db.get(
          `SELECT status, signal
           FROM conversational_agent_state
           WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
          [contactId, agentId]
        )
        const storedContact = await db.get(
          `SELECT full_name, phone, email
           FROM contacts WHERE id = ?`,
          [contactId]
        )

        assert.equal(second.mandatoryHandoff.status, 'completed')
        assert.equal(finalState.status, 'human')
        assert.equal(finalState.signal, 'ready_for_human')
        assert.equal(
          second.ctx.actionScopedContactData[scenario.expectedScopedField],
          scenario.expectedScopedValue
        )
        assert.equal(
          storedContact[scenario.expectedStoredField],
          scenario.expectedStoredValue
        )
        assert.equal(
          deliveredPrompts.length,
          1,
          'la respuesta confirmada debe completar el mismo latch sin repetir la pregunta'
        )
      } finally {
        await cleanupLiveHandoffConversation({ contactId, agentId })
      }
    })
  }
})

test('la pregunta obligatoria se cancela si cambian la política o el control del chat justo antes de enviarla', async (t) => {
  const scenarios = [{
    name: 'policy drift',
    expectedReason: 'handoff_rule_configuration_changed',
    mutate: async ({ agentId, capabilitiesConfig }) => {
      const changed = normalizeConversationalCapabilitiesConfig({
        ...capabilitiesConfig,
        items: [{
          id: 'handoff_human',
          enabled: true,
          rules: 'una regla distinta que todavía no fue adjudicada'
        }]
      })
      await db.run(
        `UPDATE conversational_agents
         SET capabilities_config = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(changed), agentId]
      )
    }
  }, {
    name: 'takeover humano',
    expectedReason: 'handoff_conversation_taken_over',
    mutate: async ({ contactId, agentId }) => {
      await db.run(
        `UPDATE conversational_agent_state
         SET status = 'human', signal = 'ready_for_human',
             updated_by = 'human', updated_at = CURRENT_TIMESTAMP
         WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
        [contactId, agentId]
      )
    }
  }]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const suffix = randomUUID()
      const contactId = `handoff_prompt_fresh_contact_${suffix}`
      const agentId = `handoff_prompt_fresh_agent_${suffix}`
      const messageId = `handoff_prompt_fresh_message_${suffix}`
      const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
        dataRequirements: {
          enabled: true,
          fields: [{
            field: 'full_name',
            label: 'nombre completo',
            level: 'required',
            scope: 'handoff'
          }],
          updateContact: {
            enabled: false,
            policy: 'replace_placeholders'
          }
        },
        items: [{
          id: 'handoff_human',
          enabled: true,
          rules: 'cuando la persona pida atención humana'
        }]
      })
      await db.run(
        `INSERT INTO conversational_agents
          (id, name, enabled, runtime_mode, capabilities_config)
         VALUES (?, 'Agente freshness de pregunta', 1, 'tool_calling_v2', ?)`,
        [agentId, JSON.stringify(capabilitiesConfig)]
      )
      const { inboundClaim } = await createLiveHandoffConversation({
        contactId,
        agentId,
        messageId,
        messageText: 'Quiero que me atienda una persona'
      })
      await db.run(
        `UPDATE contacts
         SET full_name = NULL, first_name = NULL, last_name = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [contactId]
      )
      const storedAgent = await getConversationalAgent(agentId)
      const missingName = {
        ok: false,
        needsData: true,
        requiredFields: [{
          field: 'full_name',
          label: 'nombre completo'
        }]
      }
      const fixture = buildFixture({
        rules: 'cuando la persona pida atención humana',
        sendResults: [missingName]
      })
      fixture.built.ctx.config = storedAgent
      fixture.built.ctx.capabilitiesConfig = storedAgent.capabilitiesConfig
      fixture.built.capabilityManifest =
        buildConversationalCapabilityManifest(storedAgent)
      fixture.built.ctx.contactId = contactId
      fixture.built.ctx.agentId = agentId
      fixture.built.ctx.channel = 'whatsapp'
      fixture.built.ctx.executionId = messageId
      fixture.built.ctx.inboundClaim = inboundClaim
      let providerSendCalls = 0

      try {
        const result = await runGate(fixture, {
          messages: [{
            id: messageId,
            role: 'user',
            content: 'Quiero que me atienda una persona'
          }],
          latestInbound: 'Quiero que me atienda una persona',
          extraction: { values: null, modelCallCount: 0 },
          contactId,
          executionId: messageId,
          inboundClaim,
          dryRun: false,
          deliverRequiredDataPrompt: async (payload) => {
            // La primera freshness ya ganó. La mutación ocurre exactamente
            // después, dentro de la ventana previa al efecto externo; el fence
            // interno de sendReplyParts debe volver a comprobarla.
            await scenario.mutate({
              contactId,
              agentId,
              capabilitiesConfig
            })
            return deliverVerifiedHandoffRequiredDataPrompt(payload, {
              deliveryDependencies: {
                sendTextMessage: async () => {
                  providerSendCalls += 1
                  return { id: 'provider_message_should_not_exist' }
                }
              }
            })
          }
        })
        assert.equal(result.handled, true)
        assert.equal(result.reply, '')
        assert.equal(result.mandatoryHandoff.status, 'superseded')
        assert.equal(providerSendCalls, 0)
        const latch = await db.get(
          `SELECT detail_json
           FROM conversational_agent_events
           WHERE id = ? AND event_type = 'handoff_rule_pending'`,
          [result.mandatoryHandoff.latchId]
        )
        const detail = JSON.parse(latch.detail_json)
        assert.equal(detail.status, 'superseded')
        assert.equal(detail.supersededReason, scenario.expectedReason)
      } finally {
        await cleanupLiveHandoffConversation({ contactId, agentId })
      }
    })
  }
})

test('si otro proceso completa el campo antes de cualquiera de los dos fences, recalcula el mismo inbound y transfiere', async (t) => {
  for (const racePoint of ['primer freshness', 'fence final']) {
    await t.test(racePoint, async () => {
      const suffix = randomUUID()
      const contactId = `handoff_prompt_refresh_contact_${suffix}`
      const agentId = `handoff_prompt_refresh_agent_${suffix}`
      const messageId = `handoff_prompt_refresh_message_${suffix}`
      const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
        dataRequirements: {
          enabled: true,
          fields: [{
            field: 'full_name',
            label: 'nombre completo',
            level: 'required',
            scope: 'handoff'
          }],
          updateContact: {
            enabled: false,
            policy: 'replace_placeholders'
          }
        },
        items: [{
          id: 'handoff_human',
          enabled: true,
          rules: 'cuando la persona pida atención humana'
        }]
      })
      await db.run(`
        CREATE TABLE IF NOT EXISTS ai_agent_pending_reruns (
          run_key TEXT PRIMARY KEY,
          contact_id TEXT,
          channel TEXT,
          scheduled_for TEXT,
          payload TEXT,
          created_at TEXT
        )
      `)
      await db.run(
        `INSERT INTO conversational_agents
          (id, name, enabled, runtime_mode, capabilities_config)
         VALUES (?, 'Agente refresh de pregunta', 1, 'tool_calling_v2', ?)`,
        [agentId, JSON.stringify(capabilitiesConfig)]
      )
      const { inboundClaim } = await createLiveHandoffConversation({
        contactId,
        agentId,
        messageId,
        messageText: 'Quiero que me atienda una persona'
      })
      await db.run(
        `UPDATE contacts
         SET full_name = NULL, first_name = NULL, last_name = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [contactId]
      )
      const storedAgent = await getConversationalAgent(agentId)
      const fixture = buildFixture({
        rules: 'cuando la persona pida atención humana',
        sendResults: [{
          ok: false,
          needsData: true,
          requiredFields: [{
            field: 'full_name',
            label: 'nombre completo'
          }]
        }]
      })
      fixture.built.ctx.config = storedAgent
      fixture.built.ctx.capabilitiesConfig = storedAgent.capabilitiesConfig
      fixture.built.capabilityManifest =
        buildConversationalCapabilityManifest(storedAgent)
      Object.assign(fixture.built.ctx, {
        contactId,
        agentId,
        channel: 'whatsapp',
        executionId: messageId,
        inboundClaim
      })
      let providerCalls = 0
      let fieldCompleted = false
      const completeField = async () => {
        if (fieldCompleted) return
        fieldCompleted = true
        await db.run(
          `UPDATE contacts
           SET full_name = 'Tania Salinas', first_name = 'Tania',
               last_name = 'Salinas', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [contactId]
        )
      }

      try {
        let refreshError = null
        try {
          await runGate(fixture, {
            messages: [{
              id: messageId,
              role: 'user',
              content: 'Quiero que me atienda una persona'
            }],
            latestInbound: 'Quiero que me atienda una persona',
            contactId,
            executionId: messageId,
            inboundClaim,
            dryRun: false,
            extraction: { values: null, modelCallCount: 0 },
            ...(racePoint === 'primer freshness'
              ? {
                  claimFreshRequiredDataPrompt: async (payload, deps) => {
                    await completeField()
                    return claimFreshToolCallingV2MandatoryHandoffRequiredDataPrompt(
                      payload,
                      deps
                    )
                  }
                }
              : {
                  deliverRequiredDataPrompt: async (payload) => {
                    await completeField()
                    return deliverVerifiedHandoffRequiredDataPrompt(payload, {
                      deliveryDependencies: {
                        sendTextMessage: async () => {
                          providerCalls += 1
                          return { id: 'provider_should_not_receive_stale_prompt' }
                        }
                      }
                    })
                  }
                })
          })
        } catch (error) {
          refreshError = error
        }
        assert.equal(
          refreshError?.code,
          'handoff_required_data_prompt_refresh_required'
        )
        assert.equal(
          refreshError?.mandatoryHandoffGateStage,
          'required_data_freshness_refresh'
        )
        assert.equal(providerCalls, 0)

        const retryPlan = buildToolCallingV2MandatoryHandoffRetryPlan(
          refreshError,
          {
            attemptCount:
              inboundClaim.state?.inboundProcessingAttemptCount || 1
          }
        )
        const queued = await failInboundAndQueueMandatoryHandoffRetry({
          contactId,
          phone: '+525512345672',
          claim: {
            ...inboundClaim,
            messageId,
            agentId,
            channel: 'whatsapp',
            attemptCount:
              inboundClaim.state?.inboundProcessingAttemptCount || 1
          },
          error: refreshError,
          plan: retryPlan
        }, {
          scheduleRerun: () => undefined
        })
        assert.equal(queued.queued, true)

        const reclaimed = await claimConversationInboundMessage(
          contactId,
          messageId,
          { agentId, channel: 'whatsapp' }
        )
        assert.equal(reclaimed.claimed, true)
        const retryClaim = {
          ...reclaimed,
          messageId,
          agentId,
          channel: 'whatsapp',
          attemptCount:
            reclaimed.state?.inboundProcessingAttemptCount || 2
        }
        const retryAgent = await getConversationalAgent(agentId)
        const retryCtx = {
          config: retryAgent,
          capabilitiesConfig: retryAgent.capabilitiesConfig,
          contactId,
          agentId,
          executionId: messageId,
          inboundClaim: retryClaim,
          channel: 'whatsapp',
          dryRun: false,
          runtimeMode: 'tool_calling_v2',
          followUpMode: false,
          paymentResumeClaim: null,
          actions: []
        }
        const retryResult = await resolveToolCallingV2MandatoryHandoff({
          built: {
            model: retryAgent.model || 'fake-model',
            ctx: retryCtx,
            capabilityManifest:
              buildConversationalCapabilityManifest(retryAgent),
            tools: createConversationalTools(retryCtx)
          },
          selectedMessages: [{
            id: messageId,
            role: 'user',
            content: 'Quiero que me atienda una persona'
          }],
          latestInbound: 'Quiero que me atienda una persona',
          runtime: null,
          contactId,
          channel: 'whatsapp',
          executionId: messageId,
          inboundClaim: retryClaim,
          dryRun: false,
          phase: 'pre'
        }, {
          adjudicateHandoffRules: async () => {
            throw new Error('el latch vigente no debe readjudicarse')
          },
          adjudicateHandoffSafety: async () => ({
            decision: 'clear',
            modelCallCount: 0,
            source: 'test_refresh_retry'
          }),
          findPastClientEvidence: async () => false
        })
        const state = await db.get(
          `SELECT status, signal
           FROM conversational_agent_state
           WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
          [contactId, agentId]
        )
        const latch = await db.get(
          `SELECT detail_json
           FROM conversational_agent_events
           WHERE id = ? AND event_type = 'handoff_rule_pending'`,
          [retryResult.mandatoryHandoff.latchId]
        )
        assert.equal(retryResult.mandatoryHandoff.status, 'completed')
        assert.equal(state.status, 'human')
        assert.equal(state.signal, 'ready_for_human')
        assert.equal(JSON.parse(latch.detail_json).status, 'completed')
      } finally {
        await cleanupLiveHandoffConversation({ contactId, agentId })
      }
    })
  }
})

test('si falla el commit después de aceptar el proveedor, el ledger queda ambiguo y nunca reenvía', async () => {
  let providerCalls = 0
  let plan = null
  const ledger = {
    get: async () => plan,
    create: async (_identity, candidate) => {
      plan = {
        id: 'reply_plan_commit_failure',
        status: 'pending',
        claimToken: null,
        parts: candidate.parts.map((text, index) => ({
          text,
          status: 'pending',
          externalId: `reply_commit_failure_${index + 1}`
        })),
        delaySchedule: candidate.delaySchedule,
        splitterMeta: candidate.splitterMeta
      }
      return { plan, candidateDiscarded: false }
    },
    claim: async () => {
      if (plan.status === 'ambiguous') {
        return {
          claimed: false,
          ambiguous: true,
          reason: 'already_ambiguous',
          plan
        }
      }
      plan = {
        ...plan,
        status: 'processing',
        claimToken: 'reply_claim_commit_failure'
      }
      return {
        claimed: true,
        claimToken: plan.claimToken,
        plan
      }
    },
    checkpoint: async (_planId, _claimToken, checkpoint) => {
      plan = {
        ...plan,
        parts: plan.parts.map((part, index) => (
          index === checkpoint.partIndex
            ? {
                ...part,
                status: checkpoint.status,
                providerMessageId: checkpoint.providerMessageId || null
              }
            : part
        ))
      }
      return { plan }
    },
    settle: async (_planId, _claimToken, settlement) => {
      plan = {
        ...plan,
        status: settlement.status,
        claimToken: null,
        ambiguousReason: settlement.error || null
      }
      return {
        settled: true,
        status: plan.status,
        plan
      }
    }
  }
  const input = {
    contactId: 'contact_reply_commit_failure',
    phone: '+525500000001',
    latest: {
      id: 'message_reply_commit_failure',
      phone: '+525500000001',
      channel: 'whatsapp'
    },
    agentConfig: {
      id: 'agent_reply_commit_failure',
      replyDelivery: { splitMessagesEnabled: false }
    },
    reply: '¿Me compartes tu nombre completo?',
    channel: 'whatsapp',
    dependencies: {
      forceSingleMessage: true,
      replyDeliveryLedger: ledger,
      loadNewerInbound: async () => null,
      loadPreventiveMeasure: async () => null,
      withSafetyDeliveryLock: async (callback) => callback(),
      recordEvent: async () => ({ recorded: true }),
      markReplyComplete: async () => undefined,
      sendTextMessage: async () => {
        providerCalls += 1
        return { id: 'provider_accepted_commit_failure' }
      },
      beforeSendFence: async ({ send }) => {
        await send()
        throw Object.assign(new Error('commit falló después del provider'), {
          code: 'SIMULATED_COMMIT_FAILURE'
        })
      }
    }
  }

  await assert.rejects(
    sendReplyParts(input),
    (error) => (
      error?.code === 'SIMULATED_COMMIT_FAILURE' &&
      error?.conversationalReplyDelivery?.durableStatus === 'ambiguous' &&
      error?.conversationalReplyDelivery?.providerSendAttempted === true &&
      error?.conversationalReplyDelivery?.providerSendReturned === true
    )
  )
  assert.equal(providerCalls, 1)
  assert.equal(plan.status, 'ambiguous')

  const replay = await sendReplyParts(input)
  assert.equal(replay.durableStatus, 'ambiguous')
  assert.equal(replay.resumed, true)
  assert.equal(providerCalls, 1)
})

test('un fence que frena o falla antes del proveedor nunca fabrica una entrega ambigua', async (t) => {
  const makeLedger = () => {
    let plan = null
    const settlements = []
    return {
      settlements,
      get plan() {
        return plan
      },
      ledger: {
        get: async () => plan,
        create: async (_identity, candidate) => {
          plan = {
            id: `reply_plan_pre_provider_${randomUUID()}`,
            status: 'pending',
            claimToken: null,
            parts: candidate.parts.map((text, index) => ({
              text,
              status: 'pending',
              externalId: `reply_pre_provider_${index + 1}`
            })),
            delaySchedule: candidate.delaySchedule,
            splitterMeta: candidate.splitterMeta
          }
          return { plan, candidateDiscarded: false }
        },
        claim: async () => {
          if (plan.status === 'interrupted') {
            return {
              claimed: false,
              interrupted: true,
              reason: 'already_interrupted',
              plan
            }
          }
          plan = {
            ...plan,
            status: 'processing',
            claimToken: 'reply_claim_pre_provider'
          }
          return {
            claimed: true,
            claimToken: plan.claimToken,
            plan
          }
        },
        checkpoint: async (_planId, _claimToken, checkpoint) => {
          plan = {
            ...plan,
            parts: plan.parts.map((part, index) => (
              index === checkpoint.partIndex
                ? {
                    ...part,
                    status: checkpoint.status,
                    providerMessageId: checkpoint.providerMessageId || null
                  }
                : part
            ))
          }
          return { plan }
        },
        settle: async (_planId, _claimToken, settlement) => {
          settlements.push(settlement)
          plan = {
            ...plan,
            status: settlement.status,
            claimToken: null,
            interruptedByMessageId:
              settlement.interruptedByMessageId || null,
            parts: settlement.providerAttempted === false
              ? plan.parts.map((part) => (
                  part.status === 'sending'
                    ? { ...part, status: 'pending' }
                    : part
                ))
              : plan.parts
          }
          return { settled: true, status: plan.status, plan }
        }
      }
    }
  }
  const baseInput = (ledger, sendTextMessage, beforeSendFence) => ({
    contactId: 'contact_reply_pre_provider',
    phone: '+525500000002',
    latest: {
      id: `message_reply_pre_provider_${randomUUID()}`,
      phone: '+525500000002',
      channel: 'whatsapp'
    },
    agentConfig: {
      id: 'agent_reply_pre_provider',
      replyDelivery: { splitMessagesEnabled: false }
    },
    reply: '¿Me compartes tu nombre completo?',
    channel: 'whatsapp',
    dependencies: {
      forceSingleMessage: true,
      replyDeliveryLedger: ledger,
      loadNewerInbound: async () => null,
      loadPreventiveMeasure: async () => null,
      withSafetyDeliveryLock: async (callback) => callback(),
      recordEvent: async () => ({ recorded: true }),
      markReplyComplete: async () => undefined,
      sendTextMessage,
      beforeSendFence
    }
  })

  await t.test('fence denegado', async () => {
    const state = makeLedger()
    let providerCalls = 0
    const input = baseInput(
      state.ledger,
      async () => {
        providerCalls += 1
        return { id: 'provider_should_not_run' }
      },
      async () => ({
        allowed: false,
        reason: 'handoff_conversation_taken_over'
      })
    )
    const result = await sendReplyParts(input)
    assert.equal(result.suppressedByDeliveryFence, true)
    assert.equal(result.durableStatus, 'interrupted')
    assert.equal(providerCalls, 0)
    assert.equal(state.plan.status, 'interrupted')
    assert.notEqual(state.plan.status, 'ambiguous')
    assert.equal(state.settlements.at(-1).providerAttempted, false)
  })

  await t.test('error del fence antes del send', async () => {
    const state = makeLedger()
    let providerCalls = 0
    let failBeforeSend = true
    const input = baseInput(
      state.ledger,
      async () => {
        providerCalls += 1
        return { id: 'provider_after_retry' }
      },
      async ({ send }) => {
        if (failBeforeSend) {
          failBeforeSend = false
          throw Object.assign(new Error('freshness transitorio'), {
            code: 'FRESHNESS_TRANSIENT'
          })
        }
        return {
          allowed: true,
          sent: true,
          deliveryResult: await send()
        }
      }
    )
    await assert.rejects(
      sendReplyParts(input),
      (error) => (
        error?.code === 'FRESHNESS_TRANSIENT' &&
        error?.conversationalReplyDelivery?.durableStatus === 'pending'
      )
    )
    assert.equal(providerCalls, 0)
    assert.equal(state.plan.status, 'pending')
    assert.notEqual(state.plan.status, 'ambiguous')
    assert.equal(state.settlements.at(-1).providerAttempted, false)

    const replay = await sendReplyParts(input)
    assert.equal(replay.sentParts, 1)
    assert.equal(providerCalls, 1)
  })
})

test('si falta nombre completo sólo recolecta ese dato y transfiere en la misma vuelta', async () => {
  const missingName = {
    ok: false,
    needsData: true,
    requiredFields: [{ field: 'full_name', label: 'nombre completo' }]
  }
  const fixture = buildFixture({
    sendResults: [
      missingName,
      { ok: true, simulated: true, wouldNotifyHuman: true }
    ]
  })
  const result = await runGate(fixture, {
    latestInbound: 'Me llamo Ángel Aarón Salinas',
    extraction: {
      values: {
        fullName: 'Ángel Aarón Salinas',
        phone: null,
        alternatePhone: null,
        email: null,
        company: null,
        address: null,
        customValues: null
      },
      modelCallCount: 1
    }
  })

  assert.equal(result.handled, true)
  assert.equal(result.reply, '')
  assert.deepEqual(fixture.calls.map((call) => call.tool), [
    'send_to_human',
    'save_contact_data',
    'send_to_human'
  ])
})

test('caso Tania: tres reglas en una línea, fecha y hora elegidas piden nombre y luego transfieren', async () => {
  const rules = [
    '- cuando el paciente ya haya elegido una fecha y hora',
    '- cuando el paciente tenga algún dato de alarma y quiera atención urgente',
    '- Si ningún horario le queda al paciente comenta que lo revisarás con la doctora'
  ].join(' ')
  assert.equal(parseToolCallingV2ConfiguredHandoffRules(rules).length, 3)
  const messages = [{
    role: 'user',
    content: 'Sería el día Lunes de la próxima semana'
  }, {
    role: 'assistant',
    content: '¿A qué hora exacta te sirve?'
  }, {
    role: 'user',
    content: '11:00am'
  }]
  const missingName = {
    ok: false,
    needsData: true,
    requiredFields: [{ field: 'full_name', label: 'nombre completo' }]
  }
  const firstFixture = buildFixture({
    rules,
    sendResults: [missingName]
  })
  const first = await runGate(firstFixture, {
    messages,
    latestInbound: '11:00am',
    adjudication: {
      decision: 'match',
      matchedRule: 'cuando el paciente ya haya elegido una fecha y hora',
      reason: 'La fecha y la hora ya quedaron elegidas.',
      summary: 'Lunes próximo a las 11:00 am.',
      modelCallCount: 1
    },
    extraction: { values: null, modelCallCount: 1 }
  })
  assert.equal(first.mandatoryHandoff.status, 'awaiting_required_data')
  assert.equal(first.reply, 'para continuar me falta nombre completo. me pasas ese dato?')
  assert.deepEqual(firstFixture.calls.map((call) => call.tool), ['send_to_human'])

  const secondFixture = buildFixture({
    rules,
    sendResults: [
      missingName,
      { ok: true, simulated: true, wouldNotifyHuman: true }
    ]
  })
  const second = await runGate(secondFixture, {
    messages: [
      ...messages,
      { role: 'user', content: 'Mi nombre completo es Carlos Hernández Ruiz' }
    ],
    latestInbound: 'Mi nombre completo es Carlos Hernández Ruiz',
    adjudication: {
      decision: 'match',
      matchedRule: 'cuando el paciente ya haya elegido una fecha y hora',
      reason: 'La fecha y la hora ya quedaron elegidas.',
      summary: 'Lunes próximo a las 11:00 am.',
      modelCallCount: 1
    },
    extraction: {
      values: { fullName: 'Carlos Hernández Ruiz' },
      modelCallCount: 1
    }
  })
  assert.equal(second.handled, true)
  assert.equal(second.reply, '')
  assert.equal(second.mandatoryHandoff.status, 'completed')
  assert.deepEqual(secondFixture.calls.map((call) => call.tool), [
    'send_to_human',
    'save_contact_data',
    'send_to_human'
  ])
})

test('con herramientas reales, nombre provisional con emoji y no actualizar ficha se resuelven en la misma vuelta', async () => {
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    dataRequirements: {
      fields: [{
        field: 'full_name',
        label: 'nombre completo',
        level: 'required',
        scope: 'any_action'
      }],
      updateContact: { enabled: false, policy: 'replace_placeholders' }
    },
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: 'cuando la persona ya haya elegido fecha y hora'
    }]
  })
  const ctx = {
    config: { id: 'agent_real_tools', capabilitiesConfig },
    capabilitiesConfig,
    contactId: 'virtual_real_tools_contact',
    agentId: 'agent_real_tools',
    executionId: 'preview_real_tools_execution',
    channel: 'whatsapp',
    dryRun: true,
    followUpMode: false,
    actions: [],
    virtualContact: {
      id: 'virtual_real_tools_contact',
      fullName: 'Angel Aaron 🤠'
    }
  }
  const fixture = {
    built: {
      model: 'fake-model',
      ctx,
      capabilityManifest: buildConversationalCapabilityManifest({ capabilitiesConfig }),
      tools: createConversationalTools(ctx)
    }
  }
  const result = await runGate(fixture, {
    latestInbound: 'Mi nombre completo es Ángel Aarón Salinas',
    extraction: {
      values: {
        fullName: 'Ángel Aarón Salinas',
        phone: null,
        alternatePhone: null,
        email: null,
        company: null,
        address: null,
        customValues: null
      },
      modelCallCount: 1
    }
  })

  assert.equal(result.handled, true)
  assert.equal(result.reply, '')
  assert.equal(result.mandatoryHandoff.status, 'completed')
  assert.equal(ctx.actionScopedContactData.full_name, 'Ángel Aarón Salinas')
  assert.equal(ctx.virtualContact.fullName, 'Angel Aaron 🤠')
  assert.deepEqual(ctx.actions.map((action) => action.type), ['send_to_human'])
})

test('si el dato obligatorio sigue ausente reemplaza cualquier cortesía por la pregunta canónica', async () => {
  const missingName = {
    ok: false,
    needsData: true,
    requiredFields: [{ field: 'full_name', label: 'nombre completo' }]
  }
  const fixture = buildFixture({ sendResults: [missingName] })
  const result = await runGate(fixture, {
    latestInbound: 'Gracias 💬',
    extraction: {
      values: {
        fullName: null,
        phone: null,
        alternatePhone: null,
        email: null,
        company: null,
        address: null,
        customValues: null
      },
      modelCallCount: 1
    }
  })

  assert.equal(result.handled, true)
  assert.equal(result.mandatoryHandoff.status, 'awaiting_required_data')
  assert.equal(result.reply, 'para continuar me falta nombre completo. me pasas ese dato?')
  assert.deepEqual(fixture.calls.map((call) => call.tool), ['send_to_human'])
})

test('una regla de salida no libera al agente antes de revisar un handoff todavía no detectado', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_deferred_exit_contact_${suffix}`
  const agentId = `handoff_deferred_exit_agent_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: '- cuando la persona ya haya elegido una fecha y una hora'
    }]
  })
  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config, entry_filters)
     VALUES (?, 'Agente con salida diferida', 1, 'tool_calling_v2', ?, ?)`,
    [
      agentId,
      JSON.stringify(capabilitiesConfig),
      JSON.stringify({
        entry: { groups: [] },
        exit: {
          groups: [{
            conditions: [{
              category: 'contact',
              params: [{ field: 'source', operator: 'is', value: 'exit-now' }]
            }]
          }]
        }
      })
    ]
  )
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, source, created_at, updated_at)
     VALUES (?, 'Paciente con salida diferida', ?, 'normal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, `+523${String(Date.now()).slice(-10)}`]
  )

  try {
    await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      assignmentSource: 'automatic',
      updatedBy: 'agent',
      channel: 'whatsapp'
    })
    const latchCount = await db.get(
      `SELECT COUNT(*) AS total
       FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'handoff_rule_pending'`,
      [contactId]
    )
    assert.equal(Number(latchCount?.total || 0), 0)

    const resolved = await resolveInboundAgentForContact({
      contactId,
      channel: 'whatsapp',
      ruleContext: {
        channel: 'whatsapp',
        tags: [],
        contactInfo: { source: 'exit-now' }
      }
    })
    assert.equal(resolved.agentConfig?.id, agentId)
    assert.equal(resolved.state?.agentId, agentId)
    assert.equal(resolved.deferredAutomaticRelease?.reason, 'exit_rules')
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('los datos obligatorios temporales sobreviven entre mensajes sin actualizar la ficha', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_multiturn_contact_${suffix}`
  const agentId = `handoff_multiturn_agent_${suffix}`
  const firstMessageId = `handoff_multiturn_message_1_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: '- cuando la persona ya haya elegido una fecha y una hora'
    }]
  })
  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config, entry_filters)
     VALUES (?, 'Agente handoff multivuelta', 1, 'tool_calling_v2', ?, ?)`,
    [
      agentId,
      JSON.stringify(capabilitiesConfig),
      JSON.stringify({
        entry: { groups: [] },
        exit: {
          groups: [{
            conditions: [{
              category: 'contact',
              params: [{ field: 'source', operator: 'is', value: 'exit-now' }]
            }]
          }]
        }
      })
    ]
  )
  const storedAgent = await getConversationalAgent(agentId)
  const firstLive = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId: firstMessageId,
    messageText: 'Mi nombre es Ángel Aarón Salinas'
  })
  await db.run(
    `UPDATE whatsapp_api_messages
     SET message_timestamp = '2026-07-30T10:00:00.000Z'
     WHERE id = ?`,
    [firstMessageId]
  )
  const missingBoth = {
    ok: false,
    needsData: true,
    requiredFields: [
      { field: 'full_name', label: 'nombre completo' },
      { field: 'email', label: 'correo' }
    ]
  }
  const missingEmail = {
    ok: false,
    needsData: true,
    requiredFields: [{ field: 'email', label: 'correo' }]
  }
  const firstFixture = buildFixture({
    sendResults: [missingBoth, missingEmail]
  })
  const deliverRequiredDataPrompt = async ({ obligationId }) => ({
    settled: true,
    sent: true,
    ambiguous: false,
    durableStatus: 'completed',
    sourceMessageId: `handoff-terminal:${obligationId}:required_data`
  })
  firstFixture.built.ctx.config = storedAgent
  firstFixture.built.ctx.capabilitiesConfig = storedAgent.capabilitiesConfig
  firstFixture.built.capabilityManifest = buildConversationalCapabilityManifest(storedAgent)

  try {
    const firstResult = await runGate(firstFixture, {
      messages: [{
        id: firstMessageId,
        role: 'user',
        content: 'Mi nombre es Ángel Aarón Salinas'
      }],
      latestInbound: 'Mi nombre es Ángel Aarón Salinas',
      extraction: {
        values: {
          fullName: 'Ángel Aarón Salinas',
          email: null
        },
        modelCallCount: 1
      },
      contactId,
      executionId: firstMessageId,
      inboundClaim: firstLive.inboundClaim,
      dryRun: false,
      deliverRequiredDataPrompt
    })
    assert.equal(firstResult.mandatoryHandoff.status, 'awaiting_required_data')
    assert.equal(firstFixture.built.ctx.actionScopedContactData.full_name, 'Ángel Aarón Salinas')

    const firstCompleted = await completeConversationInboundMessage(contactId, firstMessageId, {
      agentId,
      channel: 'whatsapp',
      claimToken: firstLive.inboundClaim.claimToken,
      answered: true
    })
    assert.equal(firstCompleted.completed, true)

    await db.run(
      `UPDATE contacts
       SET source = 'exit-now', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [contactId]
    )
    const resolvedWithPendingHandoff = await resolveInboundAgentForContact({
      contactId,
      channel: 'whatsapp',
      ruleContext: {
        channel: 'whatsapp',
        tags: [],
        contactInfo: { source: 'exit-now' }
      }
    })
    assert.equal(resolvedWithPendingHandoff.agentConfig?.id, agentId)
    assert.equal(resolvedWithPendingHandoff.state?.agentId, agentId)
    assert.equal(
      resolvedWithPendingHandoff.deferredAutomaticRelease?.reason,
      'assignment_not_applicable'
    )

    const secondMessageId = `handoff_multiturn_message_2_${suffix}`
    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', 'Mi correo es angel@example.com', '2026-07-30T10:01:00.000Z')`,
      [secondMessageId, contactId]
    )
    const secondClaim = await claimConversationInboundMessage(contactId, secondMessageId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(secondClaim.claimed, true)
    secondClaim.messageId = secondMessageId

    let scopedNameSeen = null
    const secondFixture = buildFixture({
      sendResults: [missingEmail],
      onSend: (ctx) => {
        scopedNameSeen = ctx.actionScopedContactData?.full_name || null
      }
    })
    secondFixture.built.ctx.config = storedAgent
    secondFixture.built.ctx.capabilitiesConfig = storedAgent.capabilitiesConfig
    secondFixture.built.capabilityManifest = buildConversationalCapabilityManifest(storedAgent)
    const secondResult = await runGate(secondFixture, {
      messages: [
        { id: firstMessageId, role: 'user', content: 'Mi nombre es Ángel Aarón Salinas' },
        { id: secondMessageId, role: 'user', content: 'Mi correo es angel@example.com' }
      ],
      latestInbound: 'Mi correo es angel@example.com',
      extraction: { values: null, modelCallCount: 0 },
      contactId,
      executionId: secondMessageId,
      inboundClaim: secondClaim,
      dryRun: false,
      deliverRequiredDataPrompt,
      onAdjudicate: () => {
        assert.fail('El latch activo debía evitar volver a adjudicar la misma regla')
      }
    })

    assert.equal(secondResult.mandatoryHandoff.status, 'awaiting_required_data')
    assert.equal(scopedNameSeen, 'Ángel Aarón Salinas')
    assert.equal(secondResult.mandatoryHandoff.latchId, firstResult.mandatoryHandoff.latchId)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('el primer inbound del ciclo sigue visible cuando la asignación ocurrió después de recibirlo', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_cycle_anchor_contact_${suffix}`
  const agentId = `handoff_cycle_anchor_agent_${suffix}`
  const firstMessageId = `handoff_cycle_anchor_message_1_${suffix}`
  const secondMessageId = `handoff_cycle_anchor_message_2_${suffix}`
  const firstMessageTimestamp = '2020-01-02T10:00:00.000Z'
  const secondMessageTimestamp = '2020-01-02T10:01:00.000Z'
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: '- cuando la persona ya haya elegido una fecha y una hora'
    }]
  })

  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente con ancla de ciclo', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(capabilitiesConfig)]
  )
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Paciente de ancla', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, `+522${String(Date.now()).slice(-10)}`]
  )
  await db.run(
    `INSERT INTO whatsapp_api_messages
      (id, contact_id, direction, message_type, message_text, message_timestamp)
     VALUES (?, ?, 'inbound', 'text', 'El lunes de la próxima semana', ?)`,
    [firstMessageId, contactId, firstMessageTimestamp]
  )
  await db.run(
    `INSERT INTO whatsapp_api_messages
      (id, contact_id, direction, message_type, message_text, message_timestamp)
     VALUES (?, ?, 'inbound', 'text', 'A las 11:00 am', ?)`,
    [secondMessageId, contactId, secondMessageTimestamp]
  )

  try {
    // A y B ya existen antes de asignar: reproduce la ráfaga absorbida durante
    // el debounce. El webhook original sigue siendo A aunque `latest` ya sea B.
    await ensureConversationState(contactId, { agentId, channel: 'whatsapp' })
    const resolved = await resolveInboundAgentForContact({
      contactId,
      channel: 'whatsapp',
      activationMessageId: firstMessageId,
      ruleContext: {
        channel: 'whatsapp',
        tags: [],
        contactInfo: {}
      }
    })
    assert.equal(resolved.agentConfig?.id, agentId)
    const scope = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(scope.activationCycleStartedMessageId, firstMessageId)
    assert.ok(Date.parse(firstMessageTimestamp) < Date.parse(scope.cutoffIso))
    assert.ok(Date.parse(secondMessageTimestamp) < Date.parse(scope.cutoffIso))
    const secondClaim = await claimConversationInboundMessage(contactId, secondMessageId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(secondClaim.claimed, true)
    secondClaim.messageId = secondMessageId

    const storedAgent = await getConversationalAgent(agentId)
    const fixture = buildFixture()
    fixture.built.ctx.config = storedAgent
    fixture.built.ctx.capabilitiesConfig = storedAgent.capabilitiesConfig
    fixture.built.capabilityManifest = buildConversationalCapabilityManifest(storedAgent)
    const result = await runGate(fixture, {
      messages: [
        {
          id: firstMessageId,
          role: 'user',
          content: 'El lunes de la próxima semana',
          messageTimestamp: firstMessageTimestamp
        },
        {
          id: secondMessageId,
          role: 'user',
          content: 'A las 11:00 am',
          messageTimestamp: secondMessageTimestamp
        }
      ],
      latestInbound: 'A las 11:00 am',
      adjudication: {
        decision: 'no_match',
        matchedRule: null,
        reason: null,
        summary: null,
        modelCallCount: 1
      },
      onAdjudicate: ({ messages }) => {
        assert.deepEqual(
          messages.map((message) => message.content),
          ['El lunes de la próxima semana', 'A las 11:00 am']
        )
      },
      contactId,
      executionId: secondMessageId,
      inboundClaim: secondClaim,
      dryRun: false
    })
    assert.equal(result.handled, false)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('un writer viejo después de migrar obtiene o repara un ciclo activo una sola vez', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_rolling_writer_contact_${suffix}`
  const agentId = `handoff_rolling_writer_agent_${suffix}`
  const stateId = `handoff_rolling_writer_state_${suffix}`
  const inboundMessageId = `handoff_rolling_writer_message_${suffix}`

  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente rolling legacy', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify({
      schemaVersion: 3,
      items: [{
        id: 'handoff_human',
        enabled: true,
        rules: '- cuando la persona ya eligió fecha y hora'
      }]
    })]
  )
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Paciente rolling legacy', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, `+524${String(Date.now()).slice(-10)}`]
  )
  await db.run(
    `INSERT INTO whatsapp_api_messages
      (id, contact_id, direction, message_type, message_text, message_timestamp)
     VALUES (?, ?, 'inbound', 'text', 'El lunes a las 11:00',
       CURRENT_TIMESTAMP)`,
    [inboundMessageId, contactId]
  )

  try {
    // Reproduce el INSERT de la versión anterior: conoce el estado y el inbound,
    // pero omite por completo las tres columnas del ciclo introducidas por 141.
    await db.run(
      `INSERT INTO conversational_agent_state (
         id, contact_id, agent_id, channel, status,
         last_inbound_message_id, assignment_source,
         assigned_at, assigned_by, activated_at,
         activation_source, activated_by, created_at, updated_at
       ) VALUES (
         ?, ?, ?, 'whatsapp', 'active', ?, 'automatic',
         CURRENT_TIMESTAMP, 'agent', CURRENT_TIMESTAMP,
         'automatic', 'agent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`,
      [stateId, contactId, agentId, inboundMessageId]
    )

    const loadedStates = await Promise.all([
      ensureConversationState(contactId, { agentId, channel: 'whatsapp' }),
      ensureConversationState(contactId, { agentId, channel: 'whatsapp' }),
      ensureConversationState(contactId, { agentId, channel: 'whatsapp' })
    ])
    const cycleIds = new Set(loadedStates.map((state) => state?.activationCycleId))
    assert.equal(cycleIds.size, 1)
    const [cycleId] = cycleIds
    assert.match(cycleId, /^cac_[a-z0-9-]+$/i)
    assert.ok(loadedStates.every((state) => state?.activationCycleStartedAt))
    assert.ok(loadedStates.every(
      (state) => state?.activationCycleStartedMessageId === inboundMessageId
    ))

    const persisted = await db.get(
      `SELECT status, activation_cycle_id, activation_cycle_started_at,
              activation_cycle_started_message_id
       FROM conversational_agent_state WHERE id = ?`,
      [stateId]
    )
    assert.equal(persisted.activation_cycle_id, cycleId)
    assert.ok(persisted.activation_cycle_started_at)
    assert.equal(
      persisted.activation_cycle_started_message_id,
      inboundMessageId
    )

    const stable = await ensureConversationState(contactId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(stable.activationCycleId, cycleId)

    // La reparación es exclusiva de estados activos. Una toma humana concurrente
    // nunca se reapropia ni recibe un ciclo nuevo por una lectura posterior.
    await db.run(
      `UPDATE conversational_agent_state
       SET status = 'human', activation_cycle_id = ''
       WHERE id = ?`,
      [stateId]
    )
    const terminal = await ensureConversationState(contactId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(terminal.status, 'human')
    assert.equal(terminal.activationCycleId, null)
    assert.equal((await db.get(
      'SELECT activation_cycle_id FROM conversational_agent_state WHERE id = ?',
      [stateId]
    )).activation_cycle_id, '')
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('el default de rolling conserva como ancla el primer inbound escrito por la versión vieja', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_rolling_anchor_contact_${suffix}`
  const agentId = `handoff_rolling_anchor_agent_${suffix}`
  const stateId = `handoff_rolling_anchor_state_${suffix}`
  const inboundMessageId = `handoff_rolling_anchor_message_${suffix}`
  const defaultCycleId = `cac_legacy_insert_${suffix.replaceAll('-', '')}`

  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente rolling anchor', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify({
      schemaVersion: 3,
      items: [{
        id: 'handoff_human',
        enabled: true,
        rules: '- cuando la persona ya eligió fecha y hora'
      }]
    })]
  )
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Paciente rolling anchor', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, `+525${String(Date.now()).slice(-10)}`]
  )
  await db.run(
    `INSERT INTO whatsapp_api_messages
      (id, contact_id, direction, message_type, message_text, message_timestamp)
     VALUES (?, ?, 'inbound', 'text', 'El lunes',
       CURRENT_TIMESTAMP)`,
    [inboundMessageId, contactId]
  )

  try {
    // SQLite materializa aquí el resultado que producirían los defaults de
    // PostgreSQL cuando el INSERT viejo omite las columnas nuevas: ciclo e
    // instante existen, pero el writer aún no conoce el ancla del mensaje.
    await db.run(
      `INSERT INTO conversational_agent_state (
         id, contact_id, agent_id, channel, status,
         last_inbound_message_id, assignment_source,
         assigned_at, assigned_by, activated_at,
         activation_source, activated_by,
         activation_cycle_id, activation_cycle_started_at,
         created_at, updated_at
       ) VALUES (
         ?, ?, ?, 'whatsapp', 'active', ?, 'automatic',
         CURRENT_TIMESTAMP, 'agent', CURRENT_TIMESTAMP,
         'automatic', 'agent', ?, CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`,
      [stateId, contactId, agentId, inboundMessageId, defaultCycleId]
    )

    const loadedStates = await Promise.all([
      ensureConversationState(contactId, { agentId, channel: 'whatsapp' }),
      ensureConversationState(contactId, { agentId, channel: 'whatsapp' }),
      ensureConversationState(contactId, { agentId, channel: 'whatsapp' })
    ])
    assert.ok(loadedStates.every(
      (state) => state?.activationCycleId === defaultCycleId
    ))
    assert.ok(loadedStates.every(
      (state) => state?.activationCycleStartedMessageId === inboundMessageId
    ))

    const persisted = await db.get(
      `SELECT activation_cycle_id, activation_cycle_started_message_id
       FROM conversational_agent_state WHERE id = ?`,
      [stateId]
    )
    assert.equal(persisted.activation_cycle_id, defaultCycleId)
    assert.equal(
      persisted.activation_cycle_started_message_id,
      inboundMessageId
    )
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('un backfill legacy sin frontera exacta conserva lunes + hora pero jamás libera no_match', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_legacy_backfill_contact_${suffix}`
  const agentId = `handoff_legacy_backfill_agent_${suffix}`
  const stateId = `handoff_legacy_backfill_state_${suffix}`
  const firstMessageId = `handoff_legacy_backfill_m1_${suffix}`
  const secondMessageId = `handoff_legacy_backfill_m2_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: '- cuando la persona ya haya elegido una fecha y una hora'
    }]
  })

  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente backfill legacy', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(capabilitiesConfig)]
  )
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Paciente backfill legacy', ?,
       '2026-07-30T08:00:00.000Z', '2026-07-30T08:00:00.000Z')`,
    [contactId, `+527${String(Date.now()).slice(-10)}`]
  )
  await db.run(
    `INSERT INTO whatsapp_api_messages
      (id, contact_id, direction, message_type, message_text, message_timestamp)
     VALUES (?, ?, 'inbound', 'text', 'El lunes',
       '2026-07-30T10:00:00.000Z')`,
    [firstMessageId, contactId]
  )

  try {
    // Reproduce una fila que ya estaba activa cuando entró 141a: el borrador
    // anterior usaba id como ciclo y no conocía el primer inbound exacto.
    await db.run(
      `INSERT INTO conversational_agent_state (
         id, contact_id, agent_id, channel, status,
         last_inbound_message_id, last_answered_inbound_message_id,
         inbound_processing_message_id, inbound_processing_status,
         activation_cycle_id, activation_cycle_started_at,
         activation_cycle_started_message_id,
         created_at, updated_at
       ) VALUES (
         ?, ?, ?, 'whatsapp', 'active',
         ?, ?, ?, 'completed',
         ?, '2026-07-30T09:00:00.000Z', NULL,
         '2026-07-30T08:00:00.000Z', '2026-07-30T10:30:00.000Z'
       )`,
      [
        stateId,
        contactId,
        agentId,
        firstMessageId,
        firstMessageId,
        firstMessageId,
        stateId
      ]
    )
    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', '11:00',
         '2026-07-30T11:00:00.000Z')`,
      [secondMessageId, contactId]
    )
    const claim = await claimConversationInboundMessage(
      contactId,
      secondMessageId,
      { agentId, channel: 'whatsapp' }
    )
    assert.equal(claim.claimed, true)

    let scope = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    assert.match(scope.activationCycleId, /^cac_legacy_backfill_/)
    assert.equal(scope.activationCycleStartedMessageId, null)
    assert.equal(scope.activationCycleBoundaryExact, false)

    // También cubre una instalación alcanzada por el borrador defectuoso antes
    // de este fix: aunque ya hubiera copiado m2 como ancla, el marcador de
    // backfill domina y esa frontera jamás se considera exacta.
    await db.run(
      `UPDATE conversational_agent_state
       SET activation_cycle_started_message_id = ?
       WHERE id = ?`,
      [secondMessageId, stateId]
    )
    scope = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(scope.activationCycleStartedMessageId, secondMessageId)
    assert.equal(scope.activationCycleBoundaryExact, false)

    const evidence = await loadToolCallingV2MandatoryHandoffEvidence({
      selectedMessages: [{
        id: firstMessageId,
        role: 'user',
        content: 'El lunes',
        messageTimestamp: '2026-07-30T10:00:00.000Z'
      }, {
        id: secondMessageId,
        role: 'user',
        content: '11:00',
        messageTimestamp: '2026-07-30T11:00:00.000Z'
      }],
      conversationScope: scope,
      triggerMessageId: secondMessageId,
      dryRun: false
    })
    assert.deepEqual(
      evidence.messages.map((message) => message.id),
      [firstMessageId, secondMessageId]
    )
    assert.equal(evidence.coverage.complete, false)
    assert.deepEqual(
      evidence.coverage.issues,
      ['legacy_activation_boundary_inexact']
    )

    const storedAgent = await getConversationalAgent(agentId)
    const fixture = buildFixture({
      onSend: async (ctx) => {
        await ctx.mandatoryHandoffAuthorityFence()
      }
    })
    fixture.built.ctx.config = storedAgent
    fixture.built.ctx.capabilitiesConfig = storedAgent.capabilitiesConfig
    fixture.built.capabilityManifest =
      buildConversationalCapabilityManifest(storedAgent)
    let auditCalls = 0
    let reviewedMessages = []
    const result = await runGate(fixture, {
      messages: [{
        id: firstMessageId,
        role: 'user',
        content: 'El lunes',
        messageTimestamp: '2026-07-30T10:00:00.000Z'
      }, {
        id: secondMessageId,
        role: 'user',
        content: '11:00',
        messageTimestamp: '2026-07-30T11:00:00.000Z'
      }],
      latestInbound: '11:00',
      adjudication: {
        decision: 'no_match',
        modelCallCount: 1
      },
      onAdjudicate: ({ messages }) => {
        reviewedMessages = messages.map((message) => message.id)
      },
      onAudit: () => {
        auditCalls += 1
      },
      contactId,
      executionId: secondMessageId,
      inboundClaim: { ...claim, messageId: secondMessageId },
      dryRun: false
    })

    assert.deepEqual(reviewedMessages, [firstMessageId, secondMessageId])
    assert.equal(auditCalls, 0)
    assert.equal(result.handled, true)
    assert.equal(result.mandatoryHandoff.status, 'completed')
    assert.deepEqual(
      fixture.calls.map((call) => call.tool),
      ['send_to_human']
    )
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('una reactivación de writer viejo inicia otro ciclo y ancla sólo sus inbounds nuevos', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_rolling_reactivation_contact_${suffix}`
  const agentId = `handoff_rolling_reactivation_agent_${suffix}`
  const stateId = `handoff_rolling_reactivation_state_${suffix}`
  const oldMessageId = `handoff_rolling_reactivation_old_${suffix}`
  const firstMessageId = `handoff_rolling_reactivation_first_${suffix}`
  const secondMessageId = `handoff_rolling_reactivation_second_${suffix}`
  const oldCycleId = `cac_old_${suffix}`
  const reactivatedCycleId =
    `cac_legacy_reactivation_${suffix.replaceAll('-', '')}`

  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente rolling reactivation', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify({
      schemaVersion: 3,
      items: [{
        id: 'handoff_human',
        enabled: true,
        rules: '- cuando la persona ya eligió fecha y hora'
      }]
    })]
  )
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Paciente rolling reactivation', ?,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, `+526${String(Date.now()).slice(-10)}`]
  )
  await db.run(
    `INSERT INTO whatsapp_api_messages
      (id, contact_id, direction, message_type, message_text, message_timestamp)
     VALUES (?, ?, 'inbound', 'text', 'Mensaje del ciclo ya entregado',
       '2026-07-30T08:00:00.000Z')`,
    [oldMessageId, contactId]
  )
  await db.run(
    `INSERT INTO conversational_agent_state (
       id, contact_id, agent_id, channel, status,
       signal, last_inbound_message_id,
       activation_cycle_id, activation_cycle_started_at,
       activation_cycle_started_message_id,
       created_at, updated_at
     ) VALUES (
       ?, ?, ?, 'whatsapp', 'human',
       'ready_for_human', ?, ?, '2026-07-30T08:00:00.000Z', ?,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )`,
    [stateId, contactId, agentId, oldMessageId, oldCycleId, oldMessageId]
  )

  try {
    // Materializa en SQLite el resultado del trigger 141a: el UPDATE del pod
    // viejo sólo cambió terminal→active, así que PostgreSQL rotó el ciclo y
    // limpió el ancla sin copiar last_inbound del ciclo anterior.
    await db.run(
      `UPDATE conversational_agent_state
       SET status = 'active',
           signal = NULL,
           activation_cycle_id = ?,
           activation_cycle_started_at = CURRENT_TIMESTAMP,
           activation_cycle_started_message_id = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reactivatedCycleId, stateId]
    )

    const beforeFirstInbound = await ensureConversationState(contactId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(beforeFirstInbound.activationCycleId, reactivatedCycleId)
    assert.equal(beforeFirstInbound.activationCycleStartedMessageId, null)
    assert.equal(beforeFirstInbound.lastInboundMessageId, oldMessageId)

    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', 'El lunes',
         '2026-07-30T09:00:00.000Z')`,
      [firstMessageId, contactId]
    )
    const firstClaim = await claimConversationInboundMessage(
      contactId,
      firstMessageId,
      { agentId, channel: 'whatsapp' }
    )
    assert.equal(firstClaim.claimed, true)
    assert.equal(
      firstClaim.state.activationCycleStartedMessageId,
      firstMessageId
    )
    await completeConversationInboundMessage(contactId, firstMessageId, {
      agentId,
      channel: 'whatsapp',
      claimToken: firstClaim.claimToken,
      answered: true
    })

    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', 'A las 11:00',
         '2026-07-30T09:01:00.000Z')`,
      [secondMessageId, contactId]
    )
    const secondClaim = await claimConversationInboundMessage(
      contactId,
      secondMessageId,
      { agentId, channel: 'whatsapp' }
    )
    assert.equal(secondClaim.claimed, true)
    assert.equal(secondClaim.state.activationCycleId, reactivatedCycleId)
    assert.equal(
      secondClaim.state.activationCycleStartedMessageId,
      firstMessageId
    )

    const scope = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(scope.activationCycleId, reactivatedCycleId)
    assert.equal(scope.activationCycleStartedMessageId, firstMessageId)
    assert.deepEqual(
      messagesInsideHandoffScope([
        { id: oldMessageId, role: 'user', content: 'Mensaje viejo' },
        { id: firstMessageId, role: 'user', content: 'El lunes' },
        { id: secondMessageId, role: 'user', content: 'A las 11:00' }
      ], scope, secondMessageId).map((message) => message.id),
      [firstMessageId, secondMessageId]
    )
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('cerrar y reabrir en el mismo segundo usa el ID del nuevo ciclo y excluye mensajes anteriores', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_same_second_contact_${suffix}`
  const agentId = `handoff_same_second_agent_${suffix}`
  const oldMessageId = `handoff_same_second_old_${suffix}`
  const newMessageId = `handoff_same_second_new_${suffix}`
  const sameTimestamp = '2026-07-30T10:00:00.000Z'
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: '- cuando la persona ya haya elegido una fecha y una hora'
    }]
  })
  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Ciclo en el mismo segundo', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(capabilitiesConfig)]
  )
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Paciente mismo segundo', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, `+523${String(Date.now()).slice(-10)}`]
  )
  await ensureConversationState(contactId, { agentId, channel: 'whatsapp' })
  const firstPaymentBinding = await buildConversationalPaymentConversationBinding({
    contactId,
    agentId,
    channel: 'whatsapp',
    sourceEventId: `payment_source_old_${suffix}`
  })
  assert.equal(firstPaymentBinding.status, 'bound')
  assert.equal(firstPaymentBinding.sourceEventId, `payment_source_old_${suffix}`)
  await db.run(
    `INSERT INTO whatsapp_api_messages
      (id, contact_id, direction, message_type, message_text, message_timestamp)
     VALUES (?, ?, 'inbound', 'text', 'Mensaje del ciclo anterior', ?)`,
    [oldMessageId, contactId, sameTimestamp]
  )
  try {
    await setConversationSignal(contactId, 'ready_for_human', {
      reason: 'Cierre del primer ciclo',
      summary: 'Ciclo anterior cerrado',
      status: 'human',
      agentId,
      channel: 'whatsapp'
    })
    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', 'A las 11:00 am', ?)`,
      [newMessageId, contactId, sameTimestamp]
    )
    const reopened = await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'system',
      channel: 'whatsapp',
      activationMessageId: newMessageId
    })
    assert.equal(reopened.status, 'active')
    assert.equal(reopened.activationCycleStartedMessageId, newMessageId)
    const reopenedPaymentBinding = await buildConversationalPaymentConversationBinding({
      contactId,
      agentId,
      channel: 'whatsapp',
      sourceEventId: `payment_source_new_${suffix}`
    })
    assert.equal(reopenedPaymentBinding.stateId, firstPaymentBinding.stateId)
    assert.notEqual(
      reopenedPaymentBinding.activationCycleId,
      firstPaymentBinding.activationCycleId
    )
    assert.notEqual(
      reopenedPaymentBinding.conversationScopeId,
      firstPaymentBinding.conversationScopeId
    )
    const scope = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    const messages = [{
      id: oldMessageId,
      role: 'user',
      content: 'Mensaje del ciclo anterior',
      messageTimestamp: sameTimestamp
    }, {
      id: newMessageId,
      role: 'user',
      content: 'A las 11:00 am',
      messageTimestamp: sameTimestamp
    }]
    assert.deepEqual(
      messagesInsideHandoffScope(messages, scope, newMessageId)
        .map((message) => message.id),
      [newMessageId]
    )

    const claim = await claimConversationInboundMessage(contactId, newMessageId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(claim.claimed, true)
    const storedAgent = await getConversationalAgent(agentId)
    const fixture = buildFixture()
    fixture.built.ctx.config = storedAgent
    fixture.built.ctx.capabilitiesConfig = storedAgent.capabilitiesConfig
    fixture.built.capabilityManifest = buildConversationalCapabilityManifest(storedAgent)
    let reviewedIds = []
    const result = await runGate(fixture, {
      messages,
      latestInbound: 'A las 11:00 am',
      adjudication: {
        decision: 'no_match',
        modelCallCount: 1
      },
      onAdjudicate: ({ messages: reviewedMessages }) => {
        reviewedIds = reviewedMessages.map((message) => message.id)
      },
      contactId,
      executionId: newMessageId,
      inboundClaim: { ...claim, messageId: newMessageId },
      dryRun: false
    })
    assert.equal(result.handled, false)
    assert.deepEqual(reviewedIds, [newMessageId])
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('si el ancla quedó fuera del tail conserva todo el contexto reciente usando cutoff estricto', () => {
  const scoped = messagesInsideHandoffScope([{
    id: 'same_second_old',
    role: 'user',
    content: 'Ciclo anterior ambiguo',
    messageTimestamp: '2026-07-30T10:00:00.000Z'
  }, {
    id: 'recent_date',
    role: 'user',
    content: 'El lunes de la próxima semana',
    messageTimestamp: '2026-07-30T10:01:00.000Z'
  }, {
    id: 'recent_question',
    role: 'assistant',
    content: '¿A qué hora?',
    messageTimestamp: '2026-07-30T10:02:00.000Z'
  }, {
    id: 'current_hour',
    role: 'user',
    content: 'A las 11:00 am',
    messageTimestamp: '2026-07-30T10:03:00.000Z'
  }], {
    activationCycleStartedMessageId: 'anchor_omitted_from_64kb_tail',
    cutoffIso: '2026-07-30T10:00:00.000Z'
  }, 'current_hour')
  assert.deepEqual(
    scoped.map((message) => message.id),
    ['recent_date', 'recent_question', 'current_hour']
  )
})

test('reconstruye por páginas una fecha antigua y una hora actual aunque el ciclo exceda 64 KiB', async () => {
  const messages = [{
    id: 'long_cycle_anchor',
    role: 'user',
    content: 'Quiero el lunes de la próxima semana',
    messageTimestamp: '2026-07-30T10:00:00.000Z'
  }]
  for (let index = 0; index < 90; index += 1) {
    messages.push({
      id: `long_cycle_filler_${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `Contexto ${index} ${'x'.repeat(1000)}`,
      messageTimestamp: `2026-07-30T10:${String(index % 60).padStart(2, '0')}:10.000Z`
    })
  }
  messages.push({
    id: 'long_cycle_hour',
    role: 'user',
    content: 'A las 11:00 am',
    messageTimestamp: '2026-07-30T12:00:00.000Z'
  })
  const envelope = buildToolCallingV2HistoryEnvelope(messages)
  assert.ok(envelope.telemetry.omittedMessages > 0)
  assert.equal(envelope.messages.some((message) => message.id === 'long_cycle_anchor'), false)

  const evidence = await loadToolCallingV2MandatoryHandoffEvidence({
    selectedMessages: envelope.messages,
    conversationScope: {
      activationCycleStartedMessageId: 'long_cycle_anchor',
      cutoffIso: '2026-07-30T10:00:00.000Z'
    },
    triggerMessageId: 'long_cycle_hour',
    historyContext: envelope,
    dryRun: false
  })
  assert.equal(evidence.coverage.complete, true)
  assert.equal(evidence.messages.at(0).id, 'long_cycle_anchor')
  assert.equal(evidence.messages.at(-1).id, 'long_cycle_hour')
  assert.match(evidence.messages.at(0).content, /lunes de la próxima semana/)
  assert.match(evidence.messages.at(-1).content, /11:00 am/)
})

test('el recovery terminal corta por ID: mensajes posteriores no crean ni niegan un match retroactivo', async (t) => {
  const makeCanonicalRows = ({ boundaryMatches }) => {
    const rows = []
    for (let index = 1; index <= 150; index += 1) {
      let marker = `contexto_${index}`
      if (index === 100 && boundaryMatches) marker = 'CONDICION_TERMINAL'
      if (index === 130) {
        marker = boundaryMatches
          ? 'NEGAR_CONDICION_TERMINAL'
          : 'CONDICION_TERMINAL'
      }
      rows.push({
        id: `terminal_boundary_${boundaryMatches ? 'deny' : 'create'}_${index}`,
        role: index % 2 ? 'user' : 'assistant',
        content: `${marker} ${'x'.repeat(1000)}`,
        messageTimestamp: new Date(
          Date.parse('2026-07-30T10:00:00.000Z') + index * 1000
        ).toISOString()
      })
    }
    return rows
  }

  for (const scenario of [{
    name: 'un mensaje posterior no crea el match',
    boundaryMatches: false,
    expectedDecision: 'no_match'
  }, {
    name: 'un mensaje posterior no niega el match',
    boundaryMatches: true,
    expectedDecision: 'match'
  }]) {
    await t.test(scenario.name, async () => {
      const rows = makeCanonicalRows(scenario)
      const terminalSourceMessageId =
        `terminal_boundary_${scenario.boundaryMatches ? 'deny' : 'create'}_100`
      let concurrentMessageInserted = false
      const rowsThrough = (throughMessage = null) => {
        const boundaryId = String(
          throughMessage?.id || throughMessage?.messageId || ''
        ).trim()
        if (!boundaryId) return rows
        const boundaryIndex = rows.findIndex((message) => message.id === boundaryId)
        return boundaryIndex >= 0 ? rows.slice(0, boundaryIndex + 1) : []
      }
      const loadRows = async (_contactId, _channel, {
        limit,
        offset,
        throughMessage
      } = {}) => {
        if (!concurrentMessageInserted) {
          concurrentMessageInserted = true
          rows.push({
            id: `terminal_boundary_concurrent_${scenario.boundaryMatches ? 'deny' : 'create'}`,
            role: 'user',
            content: `CONDICION_TERMINAL NEGAR_CONDICION_TERMINAL ${'y'.repeat(1000)}`,
            messageTimestamp: '2026-07-30T11:00:00.000Z'
          })
        }
        return [...rowsThrough(throughMessage)]
          .reverse()
          .slice(offset, offset + limit)
          .reverse()
      }
      const envelope =
        await loadToolCallingV2ConversationEnvelopeThroughMessage({
          contactId: 'terminal_boundary_contact',
          channel: 'whatsapp',
          terminalSourceMessageId,
          pageSize: 10
        }, {
          loadRows,
          countRows: async (_contactId, _channel, { throughMessage } = {}) => (
            rowsThrough(throughMessage).length
          ),
          searchRows: async () => [],
          loadBoundaryMessage: async () => (
            rows.find((message) => message.id === terminalSourceMessageId)
          )
        })
      assert.equal(envelope.telemetry.terminalBoundaryVerified, true)
      assert.equal(envelope.messages.at(-1).id, terminalSourceMessageId)
      assert.ok(envelope.telemetry.omittedMessages > 0)
      assert.equal(
        envelope.messages.some((message) => message.id.startsWith('terminal_boundary_concurrent_')),
        false
      )

      let reviewedIds = []
      const agent = buildVerifiedPaymentHandoffAgent({
        rules: '- cuando aparezca CONDICION_TERMINAL'
      })
      const result = await adjudicateToolCallingV2VerifiedPaymentHandoff({
        contactId: 'terminal_boundary_contact',
        agentId: agent.id,
        channel: 'whatsapp',
        payment: {},
        appointmentTerminal: {
          completed: true,
          bookingOwner: 'ai',
          terminalToolName: 'book_appointment'
        }
      }, {
        trustedRuntimeFactsOverride: {
          phase: 'after_main_agent_tools',
          actions: [{
            tool: 'book_appointment',
            status: 'ok',
            code: null,
            ok: true,
            actionCompleted: true,
            terminal: true,
            needsData: false
          }],
          appointmentReads: []
        },
        getAgent: async () => agent,
        loadConversationScope: async () => ({
          stateId: 'terminal_boundary_state',
          activationCycleId: 'terminal_boundary_cycle',
          activationCycleStartedMessageId: rows[0].id,
          conversationScopeId: 'terminal_boundary_scope',
          cutoffIso: rows[0].messageTimestamp,
          status: 'completed',
          signal: 'appointment_booked'
        }),
        getHistoryEnvelope: async () => envelope,
        getRuntimeConfig: async () => ({
          aiProvider: 'openai',
          model: 'fake-model'
        }),
        resolveRuntime: async () => ({
          modelProvider: { kind: 'fake' }
        }),
        adjudicateHandoffRules: async ({ messages }) => {
          reviewedIds = messages.map((message) => message.id)
          const transcript = messages.map((message) => message.content).join('\n')
          const denied = transcript.includes('NEGAR_CONDICION_TERMINAL')
          const matched = transcript.includes('CONDICION_TERMINAL') && !denied
          return {
            decision: matched ? 'match' : 'no_match',
            matchedRule: matched ? 'CONDICION_TERMINAL' : null,
            reason: matched ? 'La condición estaba en el turno terminal.' : null,
            summary: matched ? 'Debe pasar a humano.' : null,
            modelCallCount: 1
          }
        },
        auditHandoffNoMatch: async ({ ruleClauses }) => ({
          decision: 'confirmed_no_match',
          ruleAssessments: ruleClauses.map((rule) => ({
            ruleId: rule.ruleId,
            verdict: 'not_satisfied',
            evidence: ['La condición no apareció antes de cerrar la cita.'],
            reasoning: 'El mensaje posterior quedó fuera de la frontera.'
          })),
          reason: 'No hubo match dentro de la frontera durable.',
          summary: 'La cita conserva su cierre normal.',
          modelCallCount: 1,
          source: 'test_terminal_boundary_audit'
        }),
        findPastClientEvidence: async () => false
      })
      assert.equal(result.decision, scenario.expectedDecision)
      assert.equal(reviewedIds.at(-1), terminalSourceMessageId)
      assert.equal(reviewedIds.some((id) => id.endsWith('_130')), false)
    })
  }
})

test('la frontera SQL usa timestamp más ID y excluye un inbound posterior del mismo segundo', async () => {
  const suffix = randomUUID()
  const contactId = `terminal_sql_boundary_contact_${suffix}`
  const boundaryId = `terminal_sql_boundary_m_${suffix}`
  const sameSecondOlderId = `terminal_sql_boundary_a_${suffix}`
  const sameSecondNewerId = `terminal_sql_boundary_z_${suffix}`
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto frontera terminal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    for (const [id, text] of [
      [sameSecondOlderId, 'evidencia anterior'],
      [boundaryId, 'mensaje que confirmó la cita'],
      [sameSecondNewerId, 'CONDICION_POSTERIOR_QUE_NO_DEBE_ENTRAR']
    ]) {
      await db.run(
        `INSERT INTO whatsapp_api_messages
          (id, contact_id, direction, message_type, message_text, message_timestamp)
         VALUES (?, ?, 'inbound', 'text', ?, '2026-07-30T10:00:00.000Z')`,
        [id, contactId, text]
      )
    }

    const envelope = await loadToolCallingV2ConversationEnvelopeThroughMessage({
      contactId,
      channel: 'whatsapp',
      terminalSourceMessageId: boundaryId
    })
    assert.deepEqual(
      envelope.messages.map((message) => message.id),
      [sameSecondOlderId, boundaryId]
    )
    assert.equal(envelope.telemetry.terminalBoundaryVerified, true)
  } finally {
    await db.run(
      'DELETE FROM whatsapp_api_messages WHERE contact_id = ?',
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('la condición al final de un mensaje mayor a 6000 caracteres no se recorta', () => {
  const marker = 'CONDICIÓN DECISIVA: PASAR A HUMANO AHORA'
  const content = `${'x'.repeat(7_500)} ${marker}`
  const evidence = buildToolCallingV2HandoffClassifierEvidence([{
    id: 'message_over_6000',
    role: 'user',
    content
  }], {
    latestInbound: content
  })
  assert.equal(evidence.complete, true)
  assert.match(evidence.transcript[0].content, new RegExp(marker))
  assert.equal(evidence.transcript[0].content, content)
})

test('si el historial omitido no puede cargarse, un no_match nunca devuelve el chat al bot', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_incomplete_history_contact_${suffix}`
  const agentId = `handoff_incomplete_history_agent_${suffix}`
  const messageId = `handoff_incomplete_history_message_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: '- cuando la persona ya haya elegido una fecha y hora'
    }]
  })
  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente historial incompleto', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(capabilitiesConfig)]
  )
  const { inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId,
    messageText: 'A las 11:00 am'
  })
  await db.run(
    `UPDATE conversational_agent_state
     SET activation_cycle_started_message_id = ?
     WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
    [`missing_cycle_anchor_${suffix}`, contactId, agentId]
  )

  try {
    const config = await getConversationalAgent(agentId)
    const ctx = {
      config,
      capabilitiesConfig: config.capabilitiesConfig,
      contactId,
      agentId,
      executionId: messageId,
      channel: 'whatsapp',
      dryRun: false,
      followUpMode: false,
      actions: [],
      historyContext: {
        telemetry: {
          totalMessages: 50,
          includedMessages: 1,
          omittedMessages: 49,
          historyComplete: false
        },
        loadOlderPage: async () => {
          throw new Error('storage temporarily unavailable')
        }
      }
    }
    const built = {
      model: 'fake-model',
      ctx,
      capabilityManifest: buildConversationalCapabilityManifest(config),
      tools: createConversationalTools(ctx)
    }
    let auditCalls = 0
    let gateError = null
    await assert.rejects(
      resolveToolCallingV2MandatoryHandoff({
        built,
        selectedMessages: [{
          id: messageId,
          role: 'user',
          content: 'A las 11:00 am',
          messageTimestamp: '2026-07-30T12:00:00.000Z'
        }],
        latestInbound: 'A las 11:00 am',
        runtime: { modelProvider: { kind: 'fake' } },
        contactId,
        channel: 'whatsapp',
        executionId: messageId,
        inboundClaim,
        dryRun: false
      }, {
        adjudicateHandoffRules: async () => ({
          decision: 'no_match',
          modelCallCount: 1
        }),
        auditHandoffNoMatch: async () => {
          auditCalls += 1
          return null
        },
        adjudicateHandoffSafety: async () => ({
          decision: 'clear',
          modelCallCount: 0
        }),
        findPastClientEvidence: async () => false
      }),
      (error) => {
        gateError = error
        return error?.code === 'handoff_rule_history_coverage_incomplete'
      }
    )
    const retryPlan = buildToolCallingV2MandatoryHandoffRetryPlan(gateError, {
      attemptCount: inboundClaim.state?.inboundProcessingAttemptCount || 1
    })
    let persistedRerun = null
    const queued = await failInboundAndQueueMandatoryHandoffRetry({
      contactId,
      phone: (await db.get('SELECT phone FROM contacts WHERE id = ?', [contactId])).phone,
      claim: {
        ...inboundClaim,
        messageId,
        agentId,
        channel: 'whatsapp',
        attemptCount: inboundClaim.state?.inboundProcessingAttemptCount || 1
      },
      error: gateError,
      plan: retryPlan
    }, {
      persistRerun: async (_runKey, entry) => {
        persistedRerun = entry
        return true
      },
      scheduleRerun: () => {}
    })
    const state = await db.get(
      `SELECT status, signal, inbound_processing_status,
              inbound_processing_last_error
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agentId]
    )
    assert.equal(auditCalls, 0)
    assert.equal(queued.queued, true)
    assert.equal(state.status, 'active')
    assert.equal(state.signal, null)
    assert.equal(state.inbound_processing_status, 'failed')
    assert.match(state.inbound_processing_last_error, /handoff_rule_history_coverage_incomplete/)
    assert.equal(persistedRerun.contactId, contactId)
    assert.equal(
      persistedRerun.mandatoryHandoffRetry.stage,
      'history_load'
    )
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('el scope rota sólo al reabrir un cierre real y no por una pausa temporal', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_cycle_contact_${suffix}`
  const agentId = `handoff_cycle_agent_${suffix}`
  const { scope: initialScope } = await createLiveHandoffConversation({ contactId, agentId })

  try {
    await setConversationStatus(contactId, 'paused', {
      agentId,
      channel: 'whatsapp',
      updatedBy: 'user'
    })
    await setConversationStatus(contactId, 'active', {
      agentId,
      channel: 'whatsapp',
      updatedBy: 'user'
    })
    const afterPause = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(afterPause.conversationScopeId, initialScope.conversationScopeId)

    await setConversationSignal(contactId, 'ready_for_human', {
      reason: 'Prueba de cierre',
      summary: 'Cierre humano',
      status: 'human',
      agentId,
      channel: 'whatsapp'
    })
    await clearConversationSignal(contactId, {
      agentId,
      channel: 'whatsapp',
      updatedBy: 'user'
    })
    const reopened = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    assert.notEqual(reopened.conversationScopeId, initialScope.conversationScopeId)
    assert.notEqual(reopened.activationCycleId, initialScope.activationCycleId)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('liberar y readoptar un agente inicia un ciclo nuevo y no revive su latch anterior', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_release_scope_contact_${suffix}`
  const agentId = `handoff_release_scope_agent_${suffix}`
  await createLiveHandoffConversation({ contactId, agentId })
  const firstScope = await loadHandoffConversationScope({
    contactId,
    agentId,
    channel: 'whatsapp'
  })
  const ruleFingerprint = buildHandoffRuleFingerprint({ rules: 'cuando elija fecha y hora' })
  const latch = await upsertHandoffRuleLatch({
    contactId,
    agentId,
    channel: 'whatsapp',
    ruleFingerprint,
    conversationScopeId: firstScope.conversationScopeId,
    triggerMessageId: `release_scope_message_${suffix}`
  })

  try {
    await releaseAgentFromConversation(contactId, agentId, {
      updatedBy: 'test',
      channel: 'whatsapp'
    })
    const readopted = await ensureConversationState(contactId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(readopted.agentId, agentId)

    const nextScope = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    assert.notEqual(nextScope.activationCycleId, firstScope.activationCycleId)
    assert.notEqual(nextScope.conversationScopeId, firstScope.conversationScopeId)

    await supersedeStaleHandoffRuleLatches({
      contactId,
      agentId,
      channel: 'whatsapp',
      ruleFingerprint,
      conversationScopeId: nextScope.conversationScopeId
    })
    const oldRow = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [latch.id]
    )
    assert.equal(JSON.parse(oldRow.detail_json).status, 'superseded')
    assert.equal(await loadActiveHandoffRuleLatch({
      contactId,
      agentId,
      channel: 'whatsapp',
      ruleFingerprint,
      conversationScopeId: nextScope.conversationScopeId
    }), null)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('una liberación tardía nunca despega al agente después de que el handoff ya ganó', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_release_race_contact_${suffix}`
  const agentId = `handoff_release_race_agent_${suffix}`
  await createLiveHandoffConversation({ contactId, agentId })
  let injectedHandoff = false

  try {
    setConversationalStateBeforeReactivationUpdateHookForTest(async ({ operation, stateId }) => {
      if (operation !== 'release_agent' || injectedHandoff) return
      injectedHandoff = true
      await db.run(
        `UPDATE conversational_agent_state
         SET status = 'human',
             signal = 'ready_for_human',
             signal_reason = 'handoff_rule',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [stateId]
      )
    })

    const stateAfterRelease = await releaseAgentFromConversation(contactId, agentId, {
      updatedBy: 'agent',
      channel: 'whatsapp'
    })
    assert.equal(injectedHandoff, true)
    assert.equal(stateAfterRelease.agentId, agentId)
    assert.equal(stateAfterRelease.status, 'human')
    assert.equal(stateAfterRelease.signal, 'ready_for_human')

    const persisted = await db.get(
      `SELECT agent_id, status, signal
       FROM conversational_agent_state
       WHERE id = ?`,
      [stateAfterRelease.id]
    )
    assert.equal(persisted.agent_id, agentId)
    assert.equal(persisted.status, 'human')
    assert.equal(persisted.signal, 'ready_for_human')
  } finally {
    setConversationalStateBeforeReactivationUpdateHookForTest(null)
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('una liberación pierde el CAS desde que otro proceso reclama el inbound del handoff', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_release_claim_race_contact_${suffix}`
  const agentId = `handoff_release_claim_race_agent_${suffix}`
  const processingMessageId = `handoff_release_claim_race_message_${suffix}`
  const processingClaimToken = `handoff_release_claim_race_token_${suffix}`
  await createLiveHandoffConversation({ contactId, agentId })
  let injectedClaim = false

  try {
    setConversationalStateBeforeReactivationUpdateHookForTest(async ({ operation, stateId }) => {
      if (operation !== 'release_agent' || injectedClaim) return
      injectedClaim = true
      await db.run(
        `UPDATE conversational_agent_state
         SET inbound_processing_message_id = ?,
             inbound_processing_status = 'processing',
             inbound_processing_claim_token = ?,
             inbound_processing_lease_until_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          processingMessageId,
          processingClaimToken,
          new Date(Date.now() + 60_000).toISOString(),
          stateId
        ]
      )
    })

    const stateAfterRelease = await releaseAgentFromConversation(contactId, agentId, {
      updatedBy: 'agent',
      channel: 'whatsapp'
    })
    assert.equal(injectedClaim, true)
    assert.equal(stateAfterRelease.agentId, agentId)
    assert.equal(stateAfterRelease.status, 'active')
    assert.equal(stateAfterRelease.inboundProcessingMessageId, processingMessageId)
    assert.equal(stateAfterRelease.inboundProcessingStatus, 'processing')
    assert.equal(stateAfterRelease.inboundProcessingClaimToken, processingClaimToken)
  } finally {
    setConversationalStateBeforeReactivationUpdateHookForTest(null)
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('no_match completa el claim y libera al agente con un solo CAS', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_deferred_release_contact_${suffix}`
  const agentId = `handoff_deferred_release_agent_${suffix}`
  const messageId = `handoff_deferred_release_message_${suffix}`
  const { inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId,
    messageText: 'Este mensaje no cumple la regla'
  })

  try {
    const release = await releaseAgentAfterToolCallingV2HandoffGate({
      contactId,
      agentId,
      updatedBy: 'agent',
      channel: 'whatsapp',
      inboundClaim
    })
    const released = release.state
    assert.equal(release.applied, true)
    assert.equal(released.agentId, null)
    assert.equal(released.status, 'active')
    assert.equal(released.inboundProcessingMessageId, messageId)
    assert.equal(released.inboundProcessingStatus, 'completed')
    assert.equal(released.inboundProcessingClaimToken, null)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('un inbound más nuevo gana el commit lock y cancela la liberación posterior al no_match', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_deferred_newer_contact_${suffix}`
  const agentId = `handoff_deferred_newer_agent_${suffix}`
  const firstMessageId = `handoff_deferred_newer_message_1_${suffix}`
  const newerMessageId = `handoff_deferred_newer_message_2_${suffix}`
  const { inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId: firstMessageId,
    messageText: 'Todavía no cumplo la regla'
  })

  try {
    await db.run(
      `UPDATE whatsapp_api_messages
       SET message_timestamp = '2026-07-30T10:00:00.000Z'
       WHERE id = ?`,
      [firstMessageId]
    )
    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', 'El lunes a las 11:00 am', '2026-07-30T10:01:00.000Z')`,
      [newerMessageId, contactId]
    )

    const release = await releaseAgentAfterToolCallingV2HandoffGate({
      contactId,
      agentId,
      updatedBy: 'agent',
      channel: 'whatsapp',
      inboundClaim
    })
    const state = await db.get(
      `SELECT agent_id, status, inbound_processing_message_id,
              inbound_processing_status, inbound_processing_claim_token
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = ?`,
      [contactId, agentId, 'whatsapp']
    )

    assert.equal(release.applied, false)
    assert.equal(release.reason, 'automatic_release_superseded_by_newer_inbound')
    assert.equal(release.newerMessage?.id, newerMessageId)
    assert.equal(state.agent_id, agentId)
    assert.equal(state.status, 'active')
    assert.equal(state.inbound_processing_message_id, firstMessageId)
    assert.equal(state.inbound_processing_status, 'processing')
    assert.equal(state.inbound_processing_claim_token, inboundClaim.claimToken)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('un claim vencido no puede liberar al agente después del no_match', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_deferred_expired_contact_${suffix}`
  const agentId = `handoff_deferred_expired_agent_${suffix}`
  const messageId = `handoff_deferred_expired_message_${suffix}`
  const { inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId,
    messageText: 'Todavía no cumplo la regla'
  })

  try {
    await db.run(
      `UPDATE conversational_agent_state
       SET inbound_processing_lease_until_at = '2020-01-01T00:00:00.000Z'
       WHERE contact_id = ? AND agent_id = ? AND channel = ?`,
      [contactId, agentId, 'whatsapp']
    )

    const release = await releaseAgentAfterToolCallingV2HandoffGate({
      contactId,
      agentId,
      updatedBy: 'agent',
      channel: 'whatsapp',
      inboundClaim
    })
    const state = await db.get(
      `SELECT agent_id, status, inbound_processing_message_id,
              inbound_processing_status, inbound_processing_claim_token
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = ?`,
      [contactId, agentId, 'whatsapp']
    )

    assert.equal(release.applied, false)
    assert.equal(release.reason, 'automatic_release_race_lost')
    assert.equal(state.agent_id, agentId)
    assert.equal(state.status, 'active')
    assert.equal(state.inbound_processing_message_id, messageId)
    assert.equal(state.inbound_processing_status, 'processing')
    assert.equal(state.inbound_processing_claim_token, inboundClaim.claimToken)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('la reactivación decide el ciclo con el status vigente aunque un handoff gane la carrera', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_reactivation_race_contact_${suffix}`
  const agentId = `handoff_reactivation_race_agent_${suffix}`
  await createLiveHandoffConversation({ contactId, agentId })
  let expectedOperation = ''

  try {
    setConversationalStateBeforeReactivationUpdateHookForTest(async ({ operation, stateId }) => {
      if (operation !== expectedOperation) return
      expectedOperation = ''
      await db.run(
        `UPDATE conversational_agent_state
         SET status = 'human',
             signal = 'ready_for_human',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [stateId]
      )
    })

    let previousScope = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    expectedOperation = 'set_status'
    const statusReactivated = await setConversationStatus(contactId, 'active', {
      updatedBy: 'user',
      clearSignal: true,
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(statusReactivated.status, 'active')
    assert.equal(statusReactivated.signal, null)
    assert.notEqual(statusReactivated.activationCycleId, previousScope.activationCycleId)

    previousScope = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    expectedOperation = 'assign_agent'
    const assigned = await assignAgentToConversation(contactId, agentId, {
      updatedBy: 'system',
      channel: 'whatsapp'
    })
    assert.equal(assigned.status, 'active')
    assert.notEqual(assigned.activationCycleId, previousScope.activationCycleId)

    previousScope = await loadHandoffConversationScope({
      contactId,
      agentId,
      channel: 'whatsapp'
    })
    expectedOperation = 'clear_signal'
    const cleared = await clearConversationSignal(contactId, {
      updatedBy: 'user',
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(cleared.status, 'active')
    assert.equal(cleared.signal, null)
    assert.notEqual(cleared.activationCycleId, previousScope.activationCycleId)
    assert.equal(expectedOperation, '')
  } finally {
    setConversationalStateBeforeReactivationUpdateHookForTest(null)
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('la verificación automática de una asignación nunca reactiva un handoff concurrente', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_assignment_race_contact_${suffix}`
  const agentId = `handoff_assignment_race_agent_${suffix}`
  const messageId = `handoff_assignment_race_message_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: '- cuando la persona ya haya elegido una fecha y una hora'
    }]
  })
  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente con carrera de asignación', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(capabilitiesConfig)]
  )
  await createLiveHandoffConversation({ contactId, agentId })

  try {
    setConversationalStateBeforeReactivationUpdateHookForTest(async ({ operation, stateId }) => {
      if (operation !== 'assign_agent') return
      await db.run(
        `UPDATE conversational_agent_state
         SET status = 'human',
             signal = 'ready_for_human',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [stateId]
      )
    })

    const resolved = await resolveInboundAgentForContact({
      contactId,
      channel: 'whatsapp',
      activationMessageId: messageId,
      ruleContext: {
        channel: 'whatsapp',
        tags: [],
        contactInfo: {}
      }
    })
    const state = await db.get(
      `SELECT status, signal, agent_id
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = ?`,
      [contactId, agentId, 'whatsapp']
    )

    assert.equal(resolved.agentConfig, null)
    assert.equal(resolved.state?.status, 'human')
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
    assert.equal(state.agent_id, agentId)
  } finally {
    setConversationalStateBeforeReactivationUpdateHookForTest(null)
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('la regla y cliente previo usan sólo el ciclo vigente, no hechos creados dentro del chat', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_scope_evidence_contact_${suffix}`
  const agentId = `handoff_scope_evidence_agent_${suffix}`
  const messageId = `handoff_scope_evidence_message_${suffix}`
  const { scope, inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId,
    messageText: 'A las 11:00 am'
  })
  const fixture = buildFixture()
  fixture.built.ctx.config.id = agentId
  let adjudicatedMessages = null

  try {
    const result = await runGate(fixture, {
      messages: [
        {
          id: `old_message_${suffix}`,
          role: 'user',
          content: 'El lunes de la próxima semana',
          messageTimestamp: '2000-01-01T00:00:00.000Z'
        },
        {
          id: messageId,
          role: 'user',
          content: 'A las 11:00 am'
        }
      ],
      latestInbound: 'A las 11:00 am',
      adjudication: {
        decision: 'no_match',
        matchedRule: null,
        reason: null,
        summary: null,
        modelCallCount: 1
      },
      onAdjudicate: ({ messages }) => {
        adjudicatedMessages = messages
      },
      contactId,
      executionId: messageId,
      inboundClaim,
      dryRun: false
    })
    assert.equal(result.handled, false)
    assert.deepEqual(adjudicatedMessages.map((message) => message.id), [messageId])

    const pastFixture = buildFixture({ rules: '', pastClientsToHuman: true })
    pastFixture.built.ctx.config.id = agentId
    let receivedCutoff = null
    const pastResult = await runGate(pastFixture, {
      messages: [{ id: messageId, role: 'user', content: 'A las 11:00 am' }],
      latestInbound: 'A las 11:00 am',
      contactId,
      executionId: messageId,
      inboundClaim,
      dryRun: false,
      findPastClientEvidence: async ({ beforeIso }) => {
        receivedCutoff = beforeIso
        return false
      }
    })
    assert.equal(pastResult.handled, false)
    assert.equal(receivedCutoff, scope.cutoffIso)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('la post-compuerta no rompe una capacidad que ya cerró normalmente la conversación', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_post_terminal_contact_${suffix}`
  const agentId = `handoff_post_terminal_agent_${suffix}`
  const { scope } = await createLiveHandoffConversation({ contactId, agentId })
  await setConversationSignal(contactId, 'appointment_booked', {
    reason: 'Cita creada',
    summary: 'La cita ya quedó',
    status: 'completed',
    agentId,
    channel: 'whatsapp'
  })
  const fixture = buildFixture()
  fixture.built.ctx.config.id = agentId

  try {
    const result = await runGate(fixture, {
      contactId,
      executionId: `post_terminal_${suffix}`,
      inboundClaim: null,
      dryRun: false,
      phase: 'post',
      trustedRuntimeFacts: {
        phase: 'after_main_agent_tools',
        actions: [{ tool: 'book_appointment', status: 'ok', ok: true }],
        appointmentReads: []
      },
      onAdjudicate: () => {
        assert.fail('Una conversación terminal no debe volver a adjudicarse')
      }
    })
    assert.equal(result.handled, false)
    assert.equal(result.mandatoryHandoff.status, 'conversation_no_longer_active')
    const currentScope = await loadHandoffConversationScope({ contactId, agentId, channel: 'whatsapp' })
    assert.equal(currentScope.conversationScopeId, scope.conversationScopeId)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('una cita sólo habilita el handoff terminal con acción y evento durable del mismo ciclo', async () => {
  const suffix = randomUUID()
  const contactId = `terminal_owned_contact_${suffix}`
  const agentId = `terminal_owned_agent_${suffix}`
  const appointmentId = `terminal_owned_appointment_${suffix}`
  const binding = {
    stateId: `terminal_owned_state_${suffix}`,
    activationCycleId: `terminal_owned_cycle_${suffix}`,
    conversationScopeId: `terminal_owned_scope_${suffix}`
  }
  const eventId = `cae_appointment_booked_${createHash('sha256')
    .update([contactId, agentId, appointmentId].join('\u0000'))
    .digest('hex')
    .slice(0, 48)}`
  await db.run(
    `INSERT INTO conversational_agent_events
      (id, contact_id, agent_id, event_type, detail_json)
     VALUES (?, ?, ?, 'appointment_booked', ?)`,
    [
      eventId,
      contactId,
      agentId,
      JSON.stringify({
        agentId,
        appointmentId,
        terminalHandoffBinding: binding
      })
    ]
  )
  try {
    const terminalScope = {
      ...binding,
      status: 'completed',
      signal: 'appointment_booked',
      cutoffIso: '2026-07-30T10:00:00.000Z'
    }
    const actions = [{
      type: 'book_appointment',
      outcome: {
        status: 'ok',
        ok: true,
        actionCompleted: true,
        objectiveCompleted: true,
        appointmentId
      }
    }]
    const proof = await verifyToolCallingV2SynchronousTerminalAction({
      actions,
      contactId,
      agentId,
      preTurnBinding: binding,
      terminalScope
    })
    assert.equal(proof.verified, true)
    assert.equal(proof.sourceEventId, eventId)

    const built = {
      model: 'fake-model',
      ctx: {
        config: { id: agentId },
        actions,
        actionScopedContactData: {}
      }
    }
    let appliedPayload = null
    const resolved = await resolveToolCallingV2SynchronousTerminalHandoff({
      built,
      selectedMessages: [{
        id: `terminal_owned_message_${suffix}`,
        role: 'user',
        content: 'Sí, confirma la cita'
      }],
      runtime: { modelProvider: { kind: 'fake' } },
      contactId,
      channel: 'whatsapp',
      executionId: `terminal_owned_message_${suffix}`,
      preTurnBinding: binding,
      terminalScope,
      trustedRuntimeFacts: {
        phase: 'after_main_agent_tools',
        actions: [{ tool: 'book_appointment', status: 'ok', ok: true }]
      },
      terminalProof: proof
    }, {
      adjudicateVerifiedTerminalHandoff: async () => ({
        decision: 'match',
        source: 'configured_rules',
        configRevision: 'revision_1',
        policyFingerprint: 'fingerprint_1',
        matchedRule: 'cuando la cita quede agendada',
        reason: 'La cita quedó agendada.',
        summary: 'Continuar con el equipo.',
        conversationScopeId: binding.conversationScopeId,
        modelCallCount: 1
      }),
      applyVerifiedTerminalHandoff: async (payload) => {
        appliedPayload = payload
        return { applied: true, handoffCompleted: true }
      }
    })
    assert.equal(resolved.handled, true)
    assert.equal(resolved.mandatoryHandoff.status, 'completed')
    assert.equal(appliedPayload.sourceEventId, eventId)
    assert.deepEqual(appliedPayload.binding, binding)
  } finally {
    await db.run(
      'DELETE FROM conversational_agent_events WHERE id = ?',
      [eventId]
    )
  }
})

test('no_match después de la cita conserva completed y un cierre externo jamás se atribuye a la tool', async () => {
  const binding = {
    stateId: 'terminal_preserve_state',
    activationCycleId: 'terminal_preserve_cycle',
    conversationScopeId: 'terminal_preserve_scope'
  }
  const terminalScope = {
    ...binding,
    status: 'completed',
    signal: 'appointment_booked',
    cutoffIso: '2026-07-30T10:00:00.000Z'
  }
  const built = {
    model: 'fake-model',
    ctx: {
      config: { id: 'terminal_preserve_agent' },
      actions: [],
      actionScopedContactData: {}
    }
  }
  let applications = 0
  const preserved = await resolveToolCallingV2SynchronousTerminalHandoff({
    built,
    selectedMessages: [{ role: 'user', content: 'Gracias' }],
    contactId: 'terminal_preserve_contact',
    channel: 'whatsapp',
    preTurnBinding: binding,
    terminalScope,
    trustedRuntimeFacts: {},
    terminalProof: {
      verified: true,
      signal: 'appointment_booked',
      sourceEventId: 'cae_terminal_preserve_source'
    }
  }, {
    adjudicateVerifiedTerminalHandoff: async () => ({
      decision: 'no_match',
      source: 'independent_no_match_audit',
      modelCallCount: 2
    }),
    applyVerifiedTerminalHandoff: async () => {
      applications += 1
      return null
    }
  })
  assert.equal(preserved.handled, false)
  assert.equal(preserved.mandatoryHandoff.status, 'terminal_preserved_no_match')
  assert.equal(applications, 0)
  assert.equal(terminalScope.status, 'completed')
  assert.equal(terminalScope.signal, 'appointment_booked')

  const external = await resolveToolCallingV2SynchronousTerminalHandoff({
    built,
    selectedMessages: [{ role: 'user', content: 'Gracias' }],
    contactId: 'terminal_preserve_contact',
    channel: 'whatsapp',
    preTurnBinding: binding,
    terminalScope,
    trustedRuntimeFacts: {},
    terminalProof: null
  }, {
    adjudicateVerifiedTerminalHandoff: async () => {
      assert.fail('Un cierre externo no debe adjudicarse como acción de esta vuelta')
    }
  })
  assert.equal(external.handled, false)
  assert.equal(external.mandatoryHandoff.status, 'terminal_binding_not_applicable')
})

test('sin reglas ni clientes previos no enciende la compuerta obligatoria', async () => {
  const fixture = buildFixture({ rules: '', pastClientsToHuman: false })
  let adjudicatorCalled = false
  const result = await runGate(fixture, {
    onAdjudicate: () => {
      adjudicatorCalled = true
    }
  })

  assert.equal(result.handled, false)
  assert.equal(adjudicatorCalled, false)
  assert.deepEqual(fixture.calls, [])
})

test('el handoff posterior al pago carga una política versionada y no llama al modelo sin criterios', async () => {
  const agent = buildVerifiedPaymentHandoffAgent()
  const getAgent = async () => agent
  const policy = await loadToolCallingV2VerifiedPaymentHandoffPolicy({
    agentId: agent.id
  }, { getAgent })
  let adjudicatorCalls = 0
  let scopeLoads = 0

  const result = await adjudicateToolCallingV2VerifiedPaymentHandoff({
    contactId: 'contact_verified_payment_no_rules',
    agentId: agent.id,
    channel: 'whatsapp',
    payment: {
      verified: true,
      purpose: 'appointment_deposit',
      amount: 100,
      currency: 'mxn',
      environment: 'live'
    },
    appointmentTerminal: {
      completed: true,
      bookingOwner: 'ai',
      terminalToolName: 'book_appointment'
    }
  }, {
    getAgent,
    loadConversationScope: async () => {
      scopeLoads += 1
      return null
    },
    adjudicateHandoffRules: async () => {
      adjudicatorCalls += 1
      return null
    }
  })

  assert.equal(policy.enabled, true)
  assert.equal(policy.criteriaConfigured, false)
  assert.match(policy.policyFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(
    policy.configRevision,
    `handoff_contract_v1:${policy.policyFingerprint}`
  )
  assert.equal(result.decision, 'no_match')
  assert.equal(result.source, 'no_configured_criteria')
  assert.equal(result.configRevision, policy.configRevision)
  assert.equal(result.policyFingerprint, policy.policyFingerprint)
  assert.equal(result.modelCallCount, 0)
  assert.equal(scopeLoads, 0)
  assert.equal(adjudicatorCalls, 0)
})

test('la revisión de handoff ignora ediciones ajenas y cambia con cada parte efectiva del contrato', async () => {
  const common = {
    rules: '- cuando la persona ya haya elegido fecha y hora',
    userId: 'user_tania',
    userName: 'Tania Salinas',
    dataRequirements: {
      fields: [{
        field: 'full_name',
        level: 'required',
        scope: 'any_action'
      }]
    }
  }
  const baselineAgent = buildVerifiedPaymentHandoffAgent({
    ...common,
    extraCapabilities: [{
      id: 'schedule_appointment',
      enabled: false,
      calendarId: 'calendar_before'
    }]
  })
  const unrelatedEditAgent = {
    ...buildVerifiedPaymentHandoffAgent({
      ...common,
      updatedAt: '2026-07-30T12:30:00.000Z',
      model: 'another-model',
      extraCapabilities: [{
        id: 'schedule_appointment',
        enabled: false,
        calendarId: 'calendar_after'
      }]
    }),
    name: 'Nombre y personalidad editados'
  }
  const loadPolicy = (agent) => loadToolCallingV2VerifiedPaymentHandoffPolicy(
    { agentId: agent.id },
    { getAgent: async () => agent }
  )
  const baseline = await loadPolicy(baselineAgent)
  const unrelatedEdit = await loadPolicy(unrelatedEditAgent)

  assert.equal(unrelatedEdit.policyFingerprint, baseline.policyFingerprint)
  assert.equal(unrelatedEdit.configRevision, baseline.configRevision)

  const relevantEdits = [
    buildVerifiedPaymentHandoffAgent({
      ...common,
      rules: '- cuando la persona confirme explícitamente fecha y hora'
    }),
    buildVerifiedPaymentHandoffAgent({
      ...common,
      userId: 'user_otro'
    }),
    buildVerifiedPaymentHandoffAgent({
      ...common,
      dataRequirements: {
        fields: [{
          field: 'phone',
          level: 'required',
          scope: 'any_action'
        }]
      }
    }),
    buildVerifiedPaymentHandoffAgent({
      ...common,
      handoffEnabled: false
    })
  ]
  for (const editedAgent of relevantEdits) {
    const edited = await loadPolicy(editedAgent)
    assert.notEqual(edited.policyFingerprint, baseline.policyFingerprint)
    assert.notEqual(edited.configRevision, baseline.configRevision)
  }
})

test('el adjudicador posterior al pago rechaza sandbox antes de leer política o historial', async () => {
  let agentLoads = 0
  await assert.rejects(
    adjudicateToolCallingV2VerifiedPaymentHandoff({
      contactId: 'contact_verified_payment_sandbox',
      agentId: 'agent_verified_payment_sandbox',
      channel: 'whatsapp',
      payment: {
        verified: true,
        purpose: 'appointment_deposit',
        amount: 100,
        currency: 'MXN',
        environment: 'sandbox'
      },
      appointmentTerminal: {
        completed: true,
        bookingOwner: 'ai',
        terminalToolName: 'book_appointment'
      }
    }, {
      getAgent: async () => {
        agentLoads += 1
        return buildVerifiedPaymentHandoffAgent()
      }
    }),
    (error) => error?.code === 'verified_payment_handoff_environment_not_live'
  )
  assert.equal(agentLoads, 0)
})

test('el handoff posterior al pago adjudica reglas con historial real, hechos confiables y configuración vigente', async () => {
  const configuredRule = '- cuando la persona ya haya elegido una fecha y hora'
  const agent = buildVerifiedPaymentHandoffAgent({
    rules: configuredRule,
    userId: 'user_tania',
    userName: 'Tania Salinas',
    dataRequirements: {
      fields: [{
        field: 'full_name',
        level: 'required',
        scope: 'any_action'
      }]
    }
  })
  const cutoffIso = '2026-07-30T10:00:00.000Z'
  let adjudicatorInput = null
  const result = await adjudicateToolCallingV2VerifiedPaymentHandoff({
    contactId: 'contact_verified_payment_rules',
    agentId: agent.id,
    channel: 'whatsapp',
    payment: {
      verified: true,
      purpose: 'appointment_deposit',
      amount: 100,
      currency: 'mxn',
      environment: 'live'
    },
    appointmentTerminal: {
      completed: true,
      bookingOwner: 'ai',
      terminalToolName: 'book_appointment'
    }
  }, {
    getAgent: async () => agent,
    loadConversationScope: async () => ({
      conversationScopeId: 'scope_verified_payment_rules',
      cutoffIso
    }),
    getHistoryEnvelope: async () => ({
      messages: [{
        id: 'old_user',
        role: 'user',
        content: 'Otro caso anterior',
        messageTimestamp: '2026-07-29T10:00:00.000Z'
      }, {
        id: 'current_user',
        role: 'user',
        content: 'El lunes a las 11:00 am',
        messageTimestamp: '2026-07-30T10:05:00.000Z'
      }, {
        id: 'current_assistant',
        role: 'assistant',
        content: 'Voy a procesar el anticipo.',
        messageTimestamp: '2026-07-30T10:06:00.000Z'
      }]
    }),
    getRuntimeConfig: async () => ({
      aiProvider: 'openai',
      model: 'fake-model'
    }),
    resolveRuntime: async () => ({
      modelProvider: { kind: 'fake-provider' }
    }),
    adjudicateHandoffRules: async (input) => {
      adjudicatorInput = input
      return {
        decision: 'match',
        matchedRule: 'fecha y hora elegidas',
        reason: 'La selección quedó corroborada por la terminal.',
        summary: 'La persona eligió lunes a las 11:00 am.',
        modelCallCount: 1
      }
    }
  })

  assert.equal(result.decision, 'match')
  assert.equal(result.source, 'configured_rules')
  assert.equal(
    result.configRevision,
    `handoff_contract_v1:${result.policyFingerprint}`
  )
  assert.equal(result.assignedUserId, 'user_tania')
  assert.equal(result.assignedUserName, 'Tania Salinas')
  assert.deepEqual(result.assignedUser, { id: 'user_tania', name: 'Tania Salinas' })
  assert.equal(result.dataRequirements.enabled, true)
  assert.equal(result.dataRequirements.fields[0].field, 'full_name')
  assert.equal(result.conversationScopeId, 'scope_verified_payment_rules')
  assert.equal(result.cutoffIso, cutoffIso)
  assert.equal(result.modelCallCount, 1)
  assert.equal(adjudicatorInput.rules, configuredRule)
  assert.deepEqual(
    adjudicatorInput.messages.map((message) => message.id),
    ['current_user', 'current_assistant']
  )
  assert.equal(adjudicatorInput.latestInbound, 'El lunes a las 11:00 am')
  assert.deepEqual(adjudicatorInput.trustedRuntimeFacts, {
    phase: 'after_verified_payment_terminal',
    payment: {
      verified: true,
      purpose: 'appointment_deposit',
      amount: 100,
      currency: 'MXN',
      environment: 'live'
    },
    appointmentTerminal: {
      completed: true,
      bookingOwner: 'ai',
      terminalToolName: 'book_appointment'
    }
  })
  assert.equal(
    adjudicatorInput.messages.some((message) => /ledger real|pago verificado/i.test(message.content)),
    false
  )
})

test('un no_match posterior al pago sólo libera con auditoría independiente completa', async () => {
  const agent = buildVerifiedPaymentHandoffAgent({
    rules: '- cuando la persona ya haya elegido una fecha y hora'
  })
  const baseDependencies = {
    getAgent: async () => agent,
    loadConversationScope: async () => ({
      conversationScopeId: 'scope_verified_payment_audit',
      cutoffIso: '2026-07-30T10:00:00.000Z'
    }),
    getHistoryEnvelope: async () => ({
      messages: [{
        id: 'current_user',
        role: 'user',
        content: 'El lunes a las 11:00 am',
        messageTimestamp: '2026-07-30T10:05:00.000Z'
      }]
    }),
    getRuntimeConfig: async () => ({
      aiProvider: 'openai',
      model: 'fake-model'
    }),
    resolveRuntime: async () => ({
      modelProvider: { kind: 'fake-provider' }
    }),
    adjudicateHandoffRules: async () => ({
      decision: 'no_match',
      modelCallCount: 1
    })
  }
  const payload = {
    contactId: 'contact_verified_payment_audit',
    agentId: agent.id,
    channel: 'whatsapp',
    payment: {
      verified: true,
      purpose: 'appointment_deposit',
      amount: 100,
      currency: 'MXN',
      environment: 'live'
    },
    appointmentTerminal: {
      completed: true,
      bookingOwner: 'ai',
      terminalToolName: 'book_appointment'
    }
  }
  const uncertain = await adjudicateToolCallingV2VerifiedPaymentHandoff(
    payload,
    {
      ...baseDependencies,
      auditHandoffNoMatch: async () => ({
        decision: 'uncertain',
        ruleAssessments: [{
          ruleId: 'rule_1',
          verdict: 'uncertain',
          evidence: ['La selección parece completa, pero el clasificador discrepó.']
        }],
        modelCallCount: 1
      })
    }
  )
  assert.equal(uncertain.decision, 'match')
  assert.equal(uncertain.source, 'configured_rules_fail_closed_review')
  assert.equal(uncertain.modelCallCount, 2)
  assert.equal(uncertain.noMatchAudit.acceptedNoMatch, false)

  const confirmed = await adjudicateToolCallingV2VerifiedPaymentHandoff(
    payload,
    {
      ...baseDependencies,
      auditHandoffNoMatch: async () => ({
        decision: 'confirmed_no_match',
        ruleAssessments: [{
          ruleId: 'rule_1',
          verdict: 'not_satisfied',
          evidence: ['Se revisó el ciclo completo y no hay fecha ni hora elegidas.']
        }],
        modelCallCount: 1,
        source: 'test_verified_payment_independent_audit'
      })
    }
  )
  assert.equal(confirmed.decision, 'no_match')
  assert.equal(confirmed.source, 'test_verified_payment_independent_audit')
  assert.equal(confirmed.modelCallCount, 2)
  assert.equal(confirmed.noMatchAudit.acceptedNoMatch, true)
})

test('el objetivo verificado adjudica read-only con hechos post-terminal y la misma política vigente', async () => {
  const agent = buildVerifiedPaymentHandoffAgent({
    rules: '- cuando el objetivo externo quede confirmado'
  })
  let facts = null
  const result = await adjudicateToolCallingV2VerifiedGoalHandoff({
    contactId: 'contact_verified_goal',
    agentId: agent.id,
    channel: 'whatsapp',
    goal: {
      verified: true,
      goalId: 'goal_verified_1',
      objective: 'registro completado',
      externalSource: 'trusted_webhook',
      externalObjectId: 'registration_1',
      externalStatus: 'completed'
    }
  }, {
    getAgent: async () => agent,
    loadConversationScope: async () => ({
      conversationScopeId: 'scope_verified_goal',
      cutoffIso: '2026-07-30T10:00:00.000Z'
    }),
    getHistoryEnvelope: async () => ({
      messages: [{
        id: 'goal_user',
        role: 'user',
        content: 'Ya terminé el registro',
        messageTimestamp: '2026-07-30T10:05:00.000Z'
      }]
    }),
    getRuntimeConfig: async () => ({
      aiProvider: 'openai',
      model: 'fake-model'
    }),
    resolveRuntime: async () => ({
      modelProvider: { kind: 'fake-provider' }
    }),
    adjudicateHandoffRules: async (input) => {
      facts = input.trustedRuntimeFacts
      return {
        decision: 'match',
        matchedRule: 'objetivo externo confirmado',
        reason: 'La terminal verificada confirmó el registro.',
        summary: 'El equipo debe continuar.',
        modelCallCount: 1
      }
    }
  })
  assert.equal(result.decision, 'match')
  assert.equal(result.conversationScopeId, 'scope_verified_goal')
  assert.deepEqual(facts, {
    phase: 'after_verified_goal_terminal',
    goal: {
      verified: true,
      goalId: 'goal_verified_1',
      objective: 'registro completado',
      status: 'completed',
      sourceEventId: null,
      externalSource: 'trusted_webhook',
      externalObjectId: 'registration_1'
    }
  })
})

test('el handoff posterior al pago usa evidencia histórica verificada sin llamar al modelo', async () => {
  const agent = buildVerifiedPaymentHandoffAgent({
    pastClientsToHuman: true
  })
  const cutoffIso = '2026-07-30T10:00:00.000Z'
  let beforeIso = null
  let adjudicatorCalls = 0
  const result = await adjudicateToolCallingV2VerifiedPaymentHandoff({
    contactId: 'contact_verified_payment_past_client',
    agentId: agent.id,
    channel: 'whatsapp',
    payment: {
      verified: true,
      purpose: 'appointment_deposit',
      amount: 100,
      currency: 'MXN',
      environment: 'live'
    },
    appointmentTerminal: {
      completed: true,
      bookingOwner: 'ai',
      terminalToolName: 'book_appointment'
    }
  }, {
    getAgent: async () => agent,
    loadConversationScope: async () => ({
      conversationScopeId: 'scope_verified_payment_past_client',
      cutoffIso
    }),
    findPastClientEvidence: async (input) => {
      beforeIso = input.beforeIso
      return true
    },
    adjudicateHandoffRules: async () => {
      adjudicatorCalls += 1
      return null
    }
  })

  assert.equal(result.decision, 'match')
  assert.equal(result.source, 'verified_past_client')
  assert.equal(result.modelCallCount, 0)
  assert.equal(beforeIso, cutoffIso)
  assert.equal(adjudicatorCalls, 0)
})

test('si falla el adjudicador posterior al pago, propaga un error tipado para recuperación', async () => {
  const agent = buildVerifiedPaymentHandoffAgent({
    rules: '- cuando la persona ya haya elegido una fecha y hora'
  })
  await assert.rejects(
    adjudicateToolCallingV2VerifiedPaymentHandoff({
      contactId: 'contact_verified_payment_failure',
      agentId: agent.id,
      channel: 'whatsapp',
      payment: {
        verified: true,
        purpose: 'appointment_deposit',
        amount: 100,
        currency: 'MXN',
        environment: 'live'
      },
      appointmentTerminal: {
        completed: true,
        bookingOwner: 'ai',
        terminalToolName: 'book_appointment'
      }
    }, {
      getAgent: async () => agent,
      loadConversationScope: async () => ({
        conversationScopeId: 'scope_verified_payment_failure',
        cutoffIso: '2026-07-30T10:00:00.000Z'
      }),
      getHistoryEnvelope: async () => ({
        messages: [{
          id: 'current_user',
          role: 'user',
          content: 'El lunes a las 11:00 am',
          messageTimestamp: '2026-07-30T10:05:00.000Z'
        }]
      }),
      getRuntimeConfig: async () => ({
        aiProvider: 'openai',
        model: 'fake-model'
      }),
      resolveRuntime: async () => ({
        modelProvider: { kind: 'fake-provider' }
      }),
      adjudicateHandoffRules: async () => {
        throw Object.assign(new Error('timeout simulado'), {
          code: 'handoff_rule_adjudication_timeout'
        })
      }
    }),
    (error) => (
      error?.code === 'verified_payment_handoff_adjudication_failed' &&
      error?.causeCode === 'handoff_rule_adjudication_timeout'
    )
  )
})

test('la evidencia verificada de cliente previo transfiere sin consultar el adjudicador semántico', async () => {
  const fixture = buildFixture({
    rules: 'cuando la persona elija fecha y hora',
    pastClientsToHuman: true
  })
  let adjudicatorCalled = false
  const result = await runGate(fixture, {
    findPastClientEvidence: async () => true,
    onAdjudicate: () => {
      adjudicatorCalled = true
    }
  })

  assert.equal(result.handled, true)
  assert.equal(result.reply, '')
  assert.equal(result.mandatoryHandoff.status, 'completed')
  assert.equal(adjudicatorCalled, false)
  assert.deepEqual(fixture.calls.map((call) => call.tool), ['send_to_human'])
})

test('cliente previo usa instantes portables y excluye citas/pagos de prueba', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_past_client_${suffix}`
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Cliente previo', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, `+522${String(Date.now()).slice(-10)}`]
  )
  const cutoff = '2026-07-30T11:00:00.000Z'

  try {
    await db.run(
      `INSERT INTO appointments
        (id, contact_id, status, appointment_status, start_time, date_added, is_test)
       VALUES (?, ?, 'confirmed', 'confirmed', '2026-07-30 20:00:00', '2026-07-29 10:00:00', 0)`,
      [`appointment_future_${suffix}`, contactId]
    )
    await db.run(
      `INSERT INTO appointments
        (id, contact_id, status, appointment_status, start_time, date_added, is_test)
       VALUES (?, ?, 'confirmed', 'confirmed', '2026-07-30 10:00:00', '2026-07-29 10:00:00', 1)`,
      [`appointment_test_${suffix}`, contactId]
    )
    assert.equal(await hasVerifiedPastClientEvidence({ contactId, beforeIso: cutoff }), false)

    await db.run(
      `INSERT INTO appointments
        (id, contact_id, status, appointment_status, start_time, date_added, is_test)
       VALUES (?, ?, 'confirmed', 'confirmed', '2026-07-30 10:00:00', '2026-07-29 10:00:00', 0)`,
      [`appointment_real_${suffix}`, contactId]
    )
    assert.equal(await hasVerifiedPastClientEvidence({ contactId, beforeIso: cutoff }), true)

    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId])
    await db.run(
      `INSERT INTO payments
        (id, contact_id, amount, currency, status, payment_mode, paid_at, conversational_test_effect_id)
       VALUES (?, ?, 100, 'MXN', 'paid', 'sandbox', '2026-07-30 10:00:00', ?)`,
      [`payment_test_${suffix}`, contactId, `effect_${suffix}`]
    )
    assert.equal(await hasVerifiedPastClientEvidence({ contactId, beforeIso: cutoff }), false)

    await db.run(
      `INSERT INTO payments
        (id, contact_id, amount, currency, status, payment_mode, paid_at)
       VALUES (?, ?, 100, 'MXN', 'succeeded', 'live', '2026-07-30 10:00:00')`,
      [`payment_real_${suffix}`, contactId]
    )
    assert.equal(await hasVerifiedPastClientEvidence({ contactId, beforeIso: cutoff }), true)
  } finally {
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('si el adjudicador obligatorio falla, no deja correr al agente normal', async () => {
  const fixture = buildFixture()
  let capturedError = null

  await assert.rejects(
    resolveToolCallingV2MandatoryHandoff({
      built: fixture.built,
      selectedMessages: [{ role: 'user', content: 'El lunes a las 11:00 am' }],
      latestInbound: 'El lunes a las 11:00 am',
      runtime: { modelProvider: { kind: 'fake' } },
      contactId: 'preview-contact',
      channel: 'whatsapp',
      executionId: 'preview-execution',
      dryRun: true
    }, {
      adjudicateHandoffRules: async () => {
        throw new Error('timeout simulado')
      },
      extractRequiredHandoffData: async () => ({ values: null, modelCallCount: 0 }),
      findPastClientEvidence: async () => false
    }),
    (error) => {
      capturedError = error
      return /No se pudo comprobar la regla obligatoria de traspaso/.test(error.message)
    }
  )
  assert.equal(capturedError.code, 'handoff_rule_adjudication_failed')
  assert.equal(capturedError.mandatoryHandoffGateRetryable, true)
  assert.equal(capturedError.mandatoryHandoffGateStage, 'adjudication')
  assert.equal(capturedError.mandatoryHandoffGatePhase, 'pre')
  assert.deepEqual(fixture.calls, [])
})

test('la configuración global que falla se carga después del claim y entra al retry obligatorio', async () => {
  let calls = 0
  const inboundClaim = {
    messageId: 'runtime_defaults_message',
    claimToken: 'runtime_defaults_claim',
    agentId: 'runtime_defaults_agent',
    attemptCount: 1
  }
  await assert.rejects(
    loadToolCallingV2RuntimeDefaultsAfterInboundClaim({
      inboundClaim,
      mandatoryHandoffPolicyConfigured: true
    }, {
      getRuntimeConfig: async () => {
        calls += 1
        throw Object.assign(new Error('config storage unavailable'), {
          code: 'runtime_config_storage_unavailable'
        })
      }
    }),
    (error) => {
      assert.equal(error.mandatoryHandoffGateRetryable, true)
      assert.equal(error.mandatoryHandoffGateStage, 'pre_gate_infrastructure')
      const plan = buildToolCallingV2MandatoryHandoffRetryPlan(error, {
        attemptCount: inboundClaim.attemptCount,
        nowMs: Date.parse('2026-07-30T10:00:00.000Z')
      })
      assert.equal(plan.retry, true)
      assert.equal(plan.nextAttempt, 2)
      return true
    }
  )
  assert.equal(calls, 1)
  await assert.rejects(
    loadToolCallingV2RuntimeDefaultsAfterInboundClaim({
      inboundClaim: null,
      mandatoryHandoffPolicyConfigured: true
    }, {
      getRuntimeConfig: async () => ({})
    }),
    (error) => error?.code === 'conversational_runtime_defaults_before_inbound_claim'
  )
})

test('los fallos DB previos a descartar el handoff siempre quedan tipados para retry durable', async (t) => {
  const baseScope = {
    stateId: 'raw_failure_state',
    activationCycleId: 'raw_failure_cycle',
    activationCycleStartedMessageId: 'raw_failure_message',
    conversationScopeId: 'raw_failure_scope',
    cutoffIso: '2026-07-30T10:00:00.000Z',
    status: 'active',
    signal: null
  }
  const cases = [{
    name: 'scope',
    expectedStage: 'scope_load',
    dependencies: {
      loadConversationScope: async () => {
        throw new Error('scope DB unavailable')
      }
    }
  }, {
    name: 'supersede latch',
    expectedStage: 'latch_reconciliation',
    dependencies: {
      supersedeStaleHandoffRuleLatches: async () => {
        throw new Error('latch reconciliation DB unavailable')
      }
    }
  }, {
    name: 'load latch',
    expectedStage: 'latch_load',
    dependencies: {
      loadActiveHandoffRuleLatch: async () => {
        throw new Error('latch DB unavailable')
      }
    }
  }, {
    name: 'past client',
    expectedStage: 'past_client_lookup',
    pastClientsToHuman: true,
    dependencies: {
      findPastClientEvidence: async () => {
        throw new Error('past-client DB unavailable')
      }
    }
  }]

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = buildFixture({
        pastClientsToHuman: scenario.pastClientsToHuman === true
      })
      fixture.built.ctx.config.id = 'raw_failure_agent'
      let captured = null
      await assert.rejects(
        resolveToolCallingV2MandatoryHandoff({
          built: fixture.built,
          selectedMessages: [{
            id: 'raw_failure_message',
            role: 'user',
            content: 'El lunes a las 11:00 am'
          }],
          latestInbound: 'El lunes a las 11:00 am',
          runtime: { modelProvider: { kind: 'fake' } },
          contactId: 'raw_failure_contact',
          channel: 'whatsapp',
          executionId: 'raw_failure_message',
          inboundClaim: {
            messageId: 'raw_failure_message',
            claimToken: 'raw_failure_claim',
            agentId: 'raw_failure_agent',
            attemptCount: 1
          },
          dryRun: false
        }, {
          loadConversationScope: async () => baseScope,
          supersedeStaleHandoffRuleLatches: async () => {},
          loadActiveHandoffRuleLatch: async () => null,
          findPastClientEvidence: async () => false,
          ...scenario.dependencies
        }),
        (error) => {
          captured = error
          return error?.mandatoryHandoffGateStage === scenario.expectedStage
        }
      )
      assert.equal(captured.mandatoryHandoffGateRetryable, true)
      assert.equal(
        buildToolCallingV2MandatoryHandoffRetryPlan(captured, {
          attemptCount: 1
        }).retry,
        true
      )
    })
  }
})

test('el retry del gate obligatorio conserva la obligación con backoff acotado', () => {
  const failure = Object.assign(new Error('timeout simulado'), {
    code: 'handoff_rule_adjudication_failed',
    mandatoryHandoffGateRetryable: true,
    mandatoryHandoffGateStage: 'adjudication',
    mandatoryHandoffGatePhase: 'pre',
    mandatoryHandoffLatchPersisted: false
  })
  const first = buildToolCallingV2MandatoryHandoffRetryPlan(failure, {
    attemptCount: 1,
    nowMs: Date.parse('2026-07-30T10:00:00.000Z')
  })
  assert.equal(first.retry, true)
  assert.equal(first.nextAttempt, 2)
  assert.equal(first.delayMs, 1_000)
  assert.equal(first.scheduledFor, '2026-07-30T10:00:01.000Z')

  const second = buildToolCallingV2MandatoryHandoffRetryPlan(failure, {
    attemptCount: 2,
    nowMs: Date.parse('2026-07-30T10:00:00.000Z')
  })
  assert.equal(second.retry, true)
  assert.equal(second.nextAttempt, 3)
  assert.equal(second.delayMs, 5_000)

  const escalation = buildToolCallingV2MandatoryHandoffRetryPlan(failure, {
    attemptCount: MANDATORY_HANDOFF_GATE_MAX_ATTEMPTS
  })
  assert.equal(escalation.retry, true)
  assert.equal(escalation.escalation, true)
  assert.equal(escalation.exhausted, false)
  assert.equal(escalation.reason, 'mandatory_handoff_gate_escalation')
  assert.equal(escalation.delayMs, 30_000)

  const laterEscalation = buildToolCallingV2MandatoryHandoffRetryPlan(failure, {
    attemptCount: MANDATORY_HANDOFF_GATE_MAX_ATTEMPTS + 2,
    nowMs: Date.parse('2026-07-30T10:00:00.000Z')
  })
  assert.equal(laterEscalation.delayMs, 120_000)

  const longRunningEscalation = buildToolCallingV2MandatoryHandoffRetryPlan(failure, {
    attemptCount: 35_000,
    nowMs: Date.parse('2026-07-30T10:00:00.000Z')
  })
  assert.equal(
    longRunningEscalation.delayMs,
    MANDATORY_HANDOFF_ESCALATION_RETRY_MAX_DELAY_MS
  )
  assert.equal(shouldRecoverPendingInbound(
    {
      id: 'message-exhausted',
      message_timestamp: '2026-07-30T10:00:00.000Z'
    },
    {
      status: 'active',
      inboundProcessingMessageId: 'message-exhausted',
      inboundProcessingStatus: 'failed',
      inboundProcessingLastError: 'mandatory_handoff_retry_exhausted:handoff_rule_adjudication_failed'
    },
    { nowMs: Date.parse('2026-07-30T10:00:10.000Z') }
  ), true)

  const unsafePostFailure = buildToolCallingV2MandatoryHandoffRetryPlan(
    Object.assign(new Error('post gate'), {
      ...failure,
      mandatoryHandoffGatePhase: 'post',
      mandatoryHandoffLatchPersisted: false
    }),
    { attemptCount: 1 }
  )
  assert.equal(unsafePostFailure.retry, true)
  assert.equal(unsafePostFailure.escalation, true)
  assert.equal(unsafePostFailure.reason, 'mandatory_handoff_post_gate_escalation')
  assert.equal(shouldRecoverPendingInbound(
    {
      id: 'message-post-gate',
      message_timestamp: '2026-07-30T10:00:00.000Z'
    },
    {
      status: 'active',
      inboundProcessingMessageId: 'message-post-gate',
      inboundProcessingStatus: 'failed',
      inboundProcessingLastError: 'mandatory_handoff_retry_blocked_post_gate:handoff_rule_adjudication_failed'
    },
    { nowMs: Date.parse('2026-07-30T10:00:10.000Z') }
  ), true)
})

test('el timer consume sólo su propia entrada pendiente y conserva un inbound más nuevo', () => {
  const runKey = 'whatsapp:contact-rerun'
  const scheduled = { messageId: 'message-old' }
  const pending = new Map([[runKey, scheduled]])

  assert.equal(
    consumeScheduledPendingContactRerun(pending, runKey, scheduled),
    true
  )
  assert.equal(pending.has(runKey), false)

  const newer = { messageId: 'message-new' }
  pending.set(runKey, newer)
  assert.equal(
    consumeScheduledPendingContactRerun(pending, runKey, scheduled),
    false
  )
  assert.equal(pending.get(runKey), newer)
})

test('la auditoría repetible usa una identidad estable por mensaje y causa', () => {
  const base = {
    contactId: 'contact-audit',
    messageId: 'message-audit',
    channel: 'WhatsApp',
    qualifier: 'agent-not-matched'
  }
  const first = buildConversationalAuditEventId('agent_not_matched', base)
  const repeated = buildConversationalAuditEventId('agent_not_matched', base)
  const anotherMessage = buildConversationalAuditEventId('agent_not_matched', {
    ...base,
    messageId: 'message-audit-2'
  })

  assert.match(first, /^cae_audit_[a-f0-9]{64}$/)
  assert.equal(repeated, first)
  assert.notEqual(anotherMessage, first)
})

test('un crash después del claim conserva el marker y el tercer intento escala sin depender de IA', async () => {
  const suffix = randomUUID()
  const contactId = `contact_handoff_crash_recovery_${suffix}`
  const agentId = `agent_handoff_crash_recovery_${suffix}`
  const messageId = `message_handoff_crash_recovery_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    dataRequirements: {
      updateContact: false,
      fields: [{
        field: 'email',
        label: 'correo',
        level: 'required',
        scope: 'any_action'
      }]
    },
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: '- cuando la compuerta de atención humana lo requiera',
      userId: `inactive_user_${suffix}`,
      userName: 'Responsable desactivado'
    }]
  })
  try {
    await db.run(
      `INSERT INTO conversational_agents
        (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Recovery sin IA', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify(capabilitiesConfig)]
    )
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Recovery sin correo', '+5215550000011', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await ensureConversationState(contactId, { agentId, channel: 'whatsapp' })
    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', 'Necesito continuar', CURRENT_TIMESTAMP)`,
      [messageId, contactId]
    )
    await db.run(
      `UPDATE conversational_agent_state
       SET last_inbound_message_id = ?,
           inbound_processing_message_id = ?,
           inbound_processing_status = 'failed',
           inbound_processing_claim_token = NULL,
           inbound_processing_lease_until_at = NULL,
           inbound_processing_attempt_count = 2,
           inbound_processing_last_error =
             'mandatory_handoff_escalation_pending:provider_unavailable'
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [messageId, messageId, contactId, agentId]
    )
    const claim = await claimConversationInboundMessage(contactId, messageId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(claim.claimed, true)
    assert.equal(claim.state.inboundProcessingAttemptCount, 3)
    assert.equal(
      claim.state.inboundProcessingLastError,
      'mandatory_handoff_escalation_pending:provider_unavailable'
    )

    const agentConfig = await getConversationalAgent(agentId)
    let requiredDataPrompt = null
    const escalated = await executeToolCallingV2MandatoryHandoffEscalation({
      contactId,
      agentConfig,
      channel: 'whatsapp',
      executionId: messageId,
      inboundClaim: {
        messageId,
        claimToken: claim.claimToken,
        attemptCount: 3,
        mandatoryHandoffEscalationRequired: true,
        mandatoryHandoffEscalationReason: {
          marker: 'mandatory_handoff_escalation_pending',
          errorCode: 'provider_unavailable'
        }
      },
      latestInbound: 'Necesito continuar'
    }, {
      deliverRequiredDataPrompt: async (payload) => {
        requiredDataPrompt = payload
        return {
          settled: true,
          sent: true,
          ambiguous: false,
          durableStatus: 'completed',
          sourceMessageId:
            `handoff-terminal:${payload.obligationId}:required_data`
        }
      }
    })
    assert.equal(escalated.mandatoryHandoff.status, 'awaiting_required_data')
    assert.deepEqual(
      escalated.mandatoryHandoff.requiredFields.map((item) => item.field),
      ['email']
    )
    const waitingState = await db.get(
      `SELECT status, signal, inbound_processing_last_error
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agentId]
    )
    assert.equal(waitingState.status, 'active')
    assert.equal(waitingState.signal, null)
    assert.equal(
      waitingState.inbound_processing_last_error,
      'mandatory_handoff_escalation_pending:provider_unavailable'
    )
    assert.equal(requiredDataPrompt.latchId, escalated.mandatoryHandoff.latchId)
    assert.match(
      requiredDataPrompt.obligationId,
      /^handoff-required:[a-f0-9]{48}$/
    )
    assert.notEqual(
      requiredDataPrompt.obligationId,
      escalated.mandatoryHandoff.latchId
    )
    assert.equal(requiredDataPrompt.handledMessageId, messageId)
    assert.deepEqual(
      requiredDataPrompt.missingFields.map((item) => item.field),
      ['email']
    )
    const completed = await completeConversationInboundMessage(contactId, messageId, {
      agentId,
      channel: 'whatsapp',
      claimToken: claim.claimToken,
      answered: false
    })
    assert.equal(completed.completed, true)
    assert.equal(completed.state.inboundProcessingLastError, null)
    const contact = await db.get(
      'SELECT email, assigned_user_id FROM contacts WHERE id = ?',
      [contactId]
    )
    assert.equal(contact.email, null)
    assert.equal(contact.assigned_user_id, null)
    const durableLatch = await db.get(
      `SELECT detail_json
       FROM conversational_agent_events
       WHERE id = ? AND contact_id = ? AND agent_id = ?
         AND event_type = 'handoff_rule_pending'`,
      [escalated.mandatoryHandoff.latchId, contactId, agentId]
    )
    const durableLatchDetail = JSON.parse(durableLatch?.detail_json || '{}')
    assert.equal(durableLatchDetail.status, 'awaiting_required_data')
    assert.deepEqual(
      durableLatchDetail.requiredFields.map((item) => item.field),
      ['email']
    )
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total
       FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'signal_set'`,
      [contactId]
    )).total), 0)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('fallar el claim y conservar el retry obligatorio ocurre en un solo commit durable', async () => {
  const suffix = randomUUID()
  const contactId = `contact_handoff_retry_${suffix}`
  const agentId = `agent_handoff_retry_${suffix}`
  const messageId = `message_handoff_retry_${suffix}`
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_agent_pending_reruns (
        run_key TEXT PRIMARY KEY,
        contact_id TEXT,
        channel TEXT,
        scheduled_for TEXT,
        payload TEXT,
        created_at TEXT
      )
    `)
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Retry handoff', '+5215550000000', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agents
        (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Retry handoff', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify({ schemaVersion: 3, items: [] })]
    )
    await ensureConversationState(contactId, { agentId, channel: 'whatsapp' })
    await db.run(
      `INSERT INTO whatsapp_api_messages
        (id, contact_id, direction, message_type, message_text, message_timestamp)
       VALUES (?, ?, 'inbound', 'text', 'mensaje retry', CURRENT_TIMESTAMP)`,
      [messageId, contactId]
    )
    const claim = await claimConversationInboundMessage(contactId, messageId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(claim.claimed, true)
    const failure = Object.assign(new Error('timeout simulado'), {
      code: 'handoff_rule_adjudication_failed',
      mandatoryHandoffGateRetryable: true,
      mandatoryHandoffGateStage: 'adjudication',
      mandatoryHandoffGatePhase: 'pre'
    })
    const plan = buildToolCallingV2MandatoryHandoffRetryPlan(failure, {
      attemptCount: claim.state.inboundProcessingAttemptCount,
      nowMs: Date.parse('2026-07-30T10:00:00.000Z')
    })
    let scheduled = null
    const queued = await failInboundAndQueueMandatoryHandoffRetry({
      contactId,
      phone: '+5215550000000',
      claim: {
        messageId,
        agentId,
        channel: 'whatsapp',
        claimToken: claim.claimToken
      },
      error: failure,
      plan
    }, {
      scheduleRerun: (entry) => {
        scheduled = entry
      }
    })
    assert.equal(queued.queued, true)
    assert.equal(scheduled.scheduledFor, '2026-07-30T10:00:01.000Z')

    const [state, pending] = await Promise.all([
      db.get(
        `SELECT inbound_processing_status, inbound_processing_claim_token,
                inbound_processing_attempt_count
         FROM conversational_agent_state
         WHERE contact_id = ? AND agent_id = ?`,
        [contactId, agentId]
      ),
      db.get(
        `SELECT scheduled_for, payload
         FROM ai_agent_pending_reruns
         WHERE contact_id = ?`,
        [contactId]
      )
    ])
    assert.equal(state.inbound_processing_status, 'failed')
    assert.equal(state.inbound_processing_claim_token, null)
    assert.equal(Number(state.inbound_processing_attempt_count), 1)
    assert.equal(pending.scheduled_for, '2026-07-30T10:00:01.000Z')
    const payload = JSON.parse(pending.payload)
    assert.equal(payload.messageId, messageId)
    assert.equal(payload.mandatoryHandoffRetry.stage, 'adjudication')
    assert.equal(payload.mandatoryHandoffRetry.attemptCount, 1)
    assert.equal(payload.mandatoryHandoffRetry.maxAttempts, MANDATORY_HANDOFF_GATE_MAX_ATTEMPTS)

    await db.run('DELETE FROM ai_agent_pending_reruns WHERE contact_id = ?', [contactId])
    const secondClaim = await claimConversationInboundMessage(contactId, messageId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(secondClaim.claimed, true)
    const secondPlan = buildToolCallingV2MandatoryHandoffRetryPlan(failure, {
      attemptCount: secondClaim.state.inboundProcessingAttemptCount,
      nowMs: Date.parse('2026-07-30T10:00:00.000Z')
    })
    await assert.rejects(
      failInboundAndQueueMandatoryHandoffRetry({
        contactId,
        phone: '+5215550000000',
        claim: {
          messageId,
          agentId,
          channel: 'whatsapp',
          claimToken: secondClaim.claimToken
        },
        error: failure,
        plan: secondPlan
      }, {
        persistRerun: async () => {
          throw new Error('persistencia caída')
        },
        scheduleRerun: () => {
          throw new Error('no debe programar sin commit')
        }
      }),
      /persistencia caída/
    )
    const rolledBackState = await db.get(
      `SELECT inbound_processing_status, inbound_processing_claim_token
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ?`,
      [contactId, agentId]
    )
    assert.equal(rolledBackState.inbound_processing_status, 'processing')
    assert.equal(rolledBackState.inbound_processing_claim_token, secondClaim.claimToken)
  } finally {
    await db.run('DELETE FROM ai_agent_pending_reruns WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('la revisión de reglas cambia cuando cambia la política configurada', () => {
  const original = buildHandoffRuleFingerprint({
    rules: 'cuando el paciente elija fecha y hora',
    pastClientsToHuman: false
  })
  const changedRule = buildHandoffRuleFingerprint({
    rules: 'cuando el paciente pida atención urgente',
    pastClientsToHuman: false
  })
  const changedPastClientPolicy = buildHandoffRuleFingerprint({
    rules: 'cuando el paciente elija fecha y hora',
    pastClientsToHuman: true
  })
  const changedRequiredData = buildHandoffRuleFingerprint({
    rules: 'cuando el paciente elija fecha y hora',
    pastClientsToHuman: false,
    dataRequirements: {
      enabled: true,
      fields: [{ field: 'full_name', level: 'required', scope: 'any_action' }],
      updateContact: { enabled: false, policy: 'replace_placeholders' }
    }
  })
  const changedAssignee = buildHandoffRuleFingerprint({
    rules: 'cuando el paciente elija fecha y hora',
    pastClientsToHuman: false,
    assignedUserId: 'user_2'
  })
  const longRules = `${'x'.repeat(3500)}A`
  const changedLastQuarter = `${'x'.repeat(3500)}B`

  assert.notEqual(original, changedRule)
  assert.notEqual(original, changedPastClientPolicy)
  assert.notEqual(original, changedRequiredData)
  assert.notEqual(original, changedAssignee)
  assert.notEqual(
    buildHandoffRuleFingerprint({ rules: longRules }),
    buildHandoffRuleFingerprint({ rules: changedLastQuarter })
  )
})

test('la obligación durable admite un solo ejecutor y sobrevive hasta quedar completada', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_contact_${suffix}`
  const agentId = `handoff_agent_${suffix}`
  const { scope } = await createLiveHandoffConversation({ contactId, agentId })
  const ruleFingerprint = buildHandoffRuleFingerprint({
    rules: 'cuando ya eligió fecha y hora',
    pastClientsToHuman: false
  })
  const latch = await upsertHandoffRuleLatch({
    contactId,
    agentId,
    channel: 'whatsapp',
    ruleFingerprint,
    conversationScopeId: scope.conversationScopeId,
    triggerMessageId: `message_${suffix}`,
    reason: 'Fecha y hora elegidas',
    summary: 'Lunes a las 11:00'
  })

  try {
    assert.ok(latch?.id)
    const loaded = await loadActiveHandoffRuleLatch({
      contactId,
      agentId,
      channel: 'whatsapp',
      ruleFingerprint,
      conversationScopeId: scope.conversationScopeId
    })
    assert.equal(loaded?.id, latch.id)

    const claims = await Promise.all([
      claimHandoffRuleLatch({
        eventId: latch.id,
        ruleFingerprint,
        conversationScopeId: scope.conversationScopeId,
        executionId: `execution_a_${suffix}`
      }),
      claimHandoffRuleLatch({
        eventId: latch.id,
        ruleFingerprint,
        conversationScopeId: scope.conversationScopeId,
        executionId: `execution_b_${suffix}`
      })
    ])
    const winner = claims.find((claim) => claim.claimed)
    const loser = claims.find((claim) => !claim.claimed)
    assert.ok(winner)
    assert.ok(loser)
    assert.ok(['busy', 'race_lost'].includes(loser.reason))

    const completed = await settleHandoffRuleLatch({
      eventId: latch.id,
      executionToken: winner.executionToken,
      status: 'completed'
    })
    assert.equal(completed, true)
    const noLongerPending = await loadActiveHandoffRuleLatch({
      contactId,
      agentId,
      channel: 'whatsapp',
      ruleFingerprint,
      conversationScopeId: scope.conversationScopeId
    })
    assert.equal(noLongerPending, null)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('un waiting externo no puede robar el token de un latch que ya está ejecutándose', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_no_preempt_contact_${suffix}`
  const agentId = `handoff_no_preempt_agent_${suffix}`
  const { scope } = await createLiveHandoffConversation({ contactId, agentId })
  const ruleFingerprint = buildHandoffRuleFingerprint({ rules: 'cuando corresponda' })
  const latch = await upsertHandoffRuleLatch({
    contactId,
    agentId,
    channel: 'whatsapp',
    ruleFingerprint,
    conversationScopeId: scope.conversationScopeId,
    triggerMessageId: `message_${suffix}`
  })

  try {
    const claim = await claimHandoffRuleLatch({
      eventId: latch.id,
      ruleFingerprint,
      conversationScopeId: scope.conversationScopeId,
      executionId: `execution_${suffix}`
    })
    assert.equal(claim.claimed, true)
    const stolen = await markHandoffRuleLatchAwaitingData({
      eventId: latch.id,
      ruleFingerprint,
      requiredFields: [{ field: 'email', label: 'correo' }]
    })
    assert.equal(stolen, null)
    const row = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [latch.id]
    )
    const detail = JSON.parse(row.detail_json)
    assert.equal(detail.status, 'executing')
    assert.equal(detail.executionToken, claim.executionToken)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('un ejecutor con lease vencido queda cercado antes del efecto si otro proceso reclamó el latch', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_fence_contact_${suffix}`
  const agentId = `handoff_fence_agent_${suffix}`
  const messageId = `handoff_fence_message_${suffix}`
  const { scope, inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId,
    messageText: 'El lunes a las 11:00'
  })
  const ruleFingerprint = buildHandoffRuleFingerprint({ rules: 'cuando elija fecha y hora' })
  const latch = await upsertHandoffRuleLatch({
    contactId,
    agentId,
    channel: 'whatsapp',
    ruleFingerprint,
    conversationScopeId: scope.conversationScopeId,
    triggerMessageId: messageId
  })

  try {
    const firstClaim = await claimHandoffRuleLatch({
      eventId: latch.id,
      ruleFingerprint,
      conversationScopeId: scope.conversationScopeId,
      executionId: `execution_old_${suffix}`
    })
    assert.equal(firstClaim.claimed, true)
    await db.run(
      `UPDATE conversational_agent_state
       SET inbound_processing_lease_until_at = ?
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      ['2000-01-01T00:00:00.000Z', contactId, agentId]
    )
    await assert.rejects(
      db.transaction(() => commitHandoffRuleExecutionAuthority({
        eventId: latch.id,
        executionToken: firstClaim.executionToken,
        ruleFingerprint,
        conversationScopeId: scope.conversationScopeId,
        contactId,
        agentId,
        channel: 'whatsapp',
        processingMessageId: messageId,
        inboundClaimToken: inboundClaim.claimToken
      })),
      (error) => error?.code === 'handoff_rule_inbound_authority_lost'
    )
    await db.run(
      `UPDATE conversational_agent_state
       SET inbound_processing_lease_until_at = ?
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [new Date(Date.now() + 5 * 60_000).toISOString(), contactId, agentId]
    )
    const row = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [latch.id]
    )
    const expired = {
      ...JSON.parse(row.detail_json),
      executionStartedAt: '2000-01-01T00:00:00.000Z'
    }
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify(expired), latch.id]
    )
    await assert.rejects(
      db.transaction(() => commitHandoffRuleExecutionAuthority({
        eventId: latch.id,
        executionToken: firstClaim.executionToken,
        ruleFingerprint,
        conversationScopeId: scope.conversationScopeId,
        contactId,
        agentId,
        channel: 'whatsapp',
        processingMessageId: messageId,
        inboundClaimToken: inboundClaim.claimToken
      })),
      (error) => error?.code === 'handoff_rule_execution_authority_lost'
    )
    const secondClaim = await claimHandoffRuleLatch({
      eventId: latch.id,
      ruleFingerprint,
      conversationScopeId: scope.conversationScopeId,
      executionId: `execution_new_${suffix}`
    })
    assert.equal(secondClaim.claimed, true)

    await assert.rejects(
      db.transaction(() => commitHandoffRuleExecutionAuthority({
        eventId: latch.id,
        executionToken: firstClaim.executionToken,
        ruleFingerprint,
        conversationScopeId: scope.conversationScopeId,
        contactId,
        agentId,
        channel: 'whatsapp',
        processingMessageId: messageId,
        inboundClaimToken: inboundClaim.claimToken
      })),
      (error) => error?.code === 'handoff_rule_execution_authority_lost'
    )
    const stillOwnedByNew = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [latch.id]
    )
    assert.equal(JSON.parse(stillOwnedByNew.detail_json).executionToken, secondClaim.executionToken)

    const committed = await db.transaction(() => commitHandoffRuleExecutionAuthority({
      eventId: latch.id,
      executionToken: secondClaim.executionToken,
      ruleFingerprint,
      conversationScopeId: scope.conversationScopeId,
      contactId,
      agentId,
      channel: 'whatsapp',
      processingMessageId: messageId,
      inboundClaimToken: inboundClaim.claimToken
    }))
    assert.equal(committed.completed, true)
    assert.equal(await isHandoffRuleLatchCompleted({
      eventId: latch.id,
      ruleFingerprint,
      conversationScopeId: scope.conversationScopeId
    }), true)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('rechaza un estado mal escrito en vez de envenenar para siempre la obligación', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_invalid_status_contact_${suffix}`
  const agentId = `handoff_invalid_status_agent_${suffix}`
  const { scope } = await createLiveHandoffConversation({ contactId, agentId })
  const ruleFingerprint = buildHandoffRuleFingerprint({ rules: 'cuando corresponda' })
  const latch = await upsertHandoffRuleLatch({
    contactId,
    agentId,
    channel: 'whatsapp',
    ruleFingerprint,
    conversationScopeId: scope.conversationScopeId,
    triggerMessageId: `message_${suffix}`
  })

  try {
    const claim = await claimHandoffRuleLatch({
      eventId: latch.id,
      ruleFingerprint,
      conversationScopeId: scope.conversationScopeId,
      executionId: `execution_${suffix}`
    })
    await assert.rejects(
      settleHandoffRuleLatch({
        eventId: latch.id,
        executionToken: claim.executionToken,
        status: 'compeleted'
      }),
      (error) => error?.code === 'handoff_rule_invalid_settlement'
    )
    const row = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [latch.id]
    )
    assert.equal(JSON.parse(row.detail_json).status, 'executing')
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('encuentra un latch activo aunque existan más de 40 eventos posteriores', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_paged_contact_${suffix}`
  const agentId = `handoff_paged_agent_${suffix}`
  const conversationScopeId = `handoff_scope_${suffix}`
  const ruleFingerprint = buildHandoffRuleFingerprint({ rules: 'cuando corresponda' })
  const activeId = `cae_handoff_rule_active_${suffix}`
  const activeDetail = {
    schemaVersion: 2,
    agentId,
    channel: 'whatsapp',
    ruleFingerprint,
    conversationScopeId,
    status: 'ready',
    requiredFields: [],
    actionScopedContactData: {}
  }
  await db.run(
    `INSERT INTO conversational_agent_events
      (id, contact_id, agent_id, event_type, detail_json, created_at)
     VALUES (?, ?, ?, 'handoff_rule_pending', ?, '2000-01-01 00:00:00')`,
    [activeId, contactId, agentId, JSON.stringify(activeDetail)]
  )
  for (let index = 0; index < 450; index += 1) {
    await db.run(
      `INSERT INTO conversational_agent_events
        (id, contact_id, agent_id, event_type, detail_json, created_at)
       VALUES (?, ?, ?, 'handoff_rule_pending', ?, CURRENT_TIMESTAMP)`,
      [
        `cae_handoff_rule_terminal_${suffix}_${String(index).padStart(4, '0')}`,
        contactId,
        agentId,
        JSON.stringify({
          ...activeDetail,
          status: 'completed',
          conversationScopeId: `${conversationScopeId}_${index}`
        })
      ]
    )
  }

  try {
    const loaded = await loadActiveHandoffRuleLatch({
      contactId,
      agentId,
      channel: 'whatsapp',
      ruleFingerprint,
      conversationScopeId
    })
    assert.equal(loaded?.id, activeId)
  } finally {
    await db.run(
      'DELETE FROM conversational_agent_events WHERE contact_id = ? AND agent_id = ?',
      [contactId, agentId]
    )
  }
})

test('cambiar las reglas invalida una obligación anterior sin ejecutarla', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_contact_${suffix}`
  const agentId = `handoff_agent_${suffix}`
  const { scope } = await createLiveHandoffConversation({ contactId, agentId })
  const originalFingerprint = buildHandoffRuleFingerprint({
    rules: 'cuando ya eligió fecha y hora',
    pastClientsToHuman: false
  })
  const changedFingerprint = buildHandoffRuleFingerprint({
    rules: 'cuando solicite atención urgente',
    pastClientsToHuman: false
  })
  const latch = await upsertHandoffRuleLatch({
    contactId,
    agentId,
    channel: 'whatsapp',
    ruleFingerprint: originalFingerprint,
    conversationScopeId: scope.conversationScopeId,
    triggerMessageId: `message_${suffix}`
  })

  try {
    await supersedeStaleHandoffRuleLatches({
      contactId,
      agentId,
      channel: 'whatsapp',
      ruleFingerprint: changedFingerprint,
      conversationScopeId: scope.conversationScopeId
    })
    const row = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [latch.id]
    )
    const detail = JSON.parse(row.detail_json)
    assert.equal(detail.status, 'superseded')
    assert.equal(detail.supersededReason, 'handoff_rule_configuration_changed')
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('guarda íntegro un contrato grande sin truncar ni romper el JSON del latch', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_large_json_contact_${suffix}`
  const agentId = `handoff_large_json_agent_${suffix}`
  const { scope } = await createLiveHandoffConversation({ contactId, agentId })
  const ruleFingerprint = buildHandoffRuleFingerprint({ rules: 'cuando corresponda' })
  const matchedRule = `"condición con comillas" ${'á\\b'.repeat(1200)}`.slice(0, 4000)

  try {
    const latch = await upsertHandoffRuleLatch({
      contactId,
      agentId,
      channel: 'whatsapp',
      ruleFingerprint,
      conversationScopeId: scope.conversationScopeId,
      triggerMessageId: `message_${suffix}`,
      matchedRule,
      reason: 'R'.repeat(800),
      summary: 'S'.repeat(1000)
    })
    const row = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [latch.id]
    )
    assert.ok(row.detail_json.length > 4000)
    const parsed = JSON.parse(row.detail_json)
    assert.equal(parsed.matchedRule, matchedRule)
    assert.equal(parsed.reason.length, 800)
    assert.equal(parsed.summary.length, 1000)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('el flujo live adjudica, cerca y confirma el handoff en una sola transacción', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_live_contact_${suffix}`
  const agentId = `handoff_live_agent_${suffix}`
  const messageId = `handoff_live_message_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: 'cuando la persona ya eligió fecha y hora',
      userId: `inactive_user_${suffix}`,
      userName: 'Usuario que ya no está activo'
    }]
  })
  await db.run(
    `INSERT INTO conversational_agents
      (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente handoff live', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(capabilitiesConfig)]
  )
  const { inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId,
    messageText: 'El lunes a las 11:00 am'
  })

  try {
    const config = await getConversationalAgent(agentId)
    const ctx = {
      config,
      capabilitiesConfig: config.capabilitiesConfig,
      contactId,
      agentId,
      executionId: messageId,
      channel: 'whatsapp',
      dryRun: false,
      followUpMode: false,
      actions: []
    }
    const built = {
      model: 'fake-model',
      ctx,
      capabilityManifest: buildConversationalCapabilityManifest(config),
      tools: createConversationalTools(ctx)
    }
    const result = await resolveToolCallingV2MandatoryHandoff({
      built,
      selectedMessages: [{
        id: messageId,
        role: 'user',
        content: 'El lunes a las 11:00 am',
        messageTimestamp: '2026-07-30T10:00:00.000Z'
      }],
      latestInbound: 'El lunes a las 11:00 am',
      runtime: { modelProvider: { kind: 'fake' } },
      contactId,
      channel: 'whatsapp',
      executionId: messageId,
      inboundClaim,
      dryRun: false
    }, {
      adjudicateHandoffRules: async () => ({
        decision: 'match',
        matchedRule: 'fecha y hora elegidas',
        reason: 'La persona eligió lunes a las 11:00',
        summary: 'Requiere valoración el lunes a las 11:00',
        modelCallCount: 1
      }),
      adjudicateHandoffSafety: async () => ({
        decision: 'clear',
        modelCallCount: 1,
        source: 'test_safety_preflight'
      }),
      extractRequiredHandoffData: async () => ({ values: null, modelCallCount: 0 }),
      findPastClientEvidence: async () => false
    })
    const state = await db.get(
      `SELECT status, signal
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agentId]
    )
    const latch = await db.get(
      `SELECT detail_json
       FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'handoff_rule_pending'`,
      [contactId, agentId]
    )
    const notificationJobs = await db.all(
      `SELECT job_kind, message_id, contact_id, provider, payload_json
       FROM chat_delivery_outbox
       WHERE contact_id = ? AND provider = 'conversational_agent_priority'`,
      [contactId]
    )

    assert.equal(result.handled, true)
    assert.equal(result.reply, '')
    assert.equal(result.mandatoryHandoff.status, 'completed')
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
    assert.equal(JSON.parse(latch.detail_json).status, 'completed')
    assert.equal(notificationJobs.length, 1)
    assert.equal(notificationJobs[0].job_kind, 'push')
    assert.equal(notificationJobs[0].contact_id, contactId)
    assert.equal(JSON.parse(notificationJobs[0].payload_json).handoffLatchId, result.mandatoryHandoff.latchId)
    assert.equal(ctx.actions.at(-1)?.type, 'send_to_human')
    assert.equal(ctx.actions.at(-1)?.outcome?.transferredToHuman, true)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})

test('si el usuario configurado quedó inactivo, el handoff obligatorio cae al equipo general', async () => {
  const suffix = randomUUID()
  const contactId = `handoff_fallback_contact_${suffix}`
  const agentId = `handoff_fallback_agent_${suffix}`
  const capabilitiesConfig = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'handoff_human',
      enabled: true,
      rules: 'cuando corresponda',
      userId: `inactive_user_${suffix}`,
      userName: 'Usuario desactivado'
    }]
  })
  const messageId = `handoff_fallback_message_${suffix}`
  const { inboundClaim } = await createLiveHandoffConversation({
    contactId,
    agentId,
    messageId,
    messageText: 'Quiero que me atienda una persona'
  })
  await db.run(
    `UPDATE contacts
     SET assigned_user_id = ?
     WHERE id = ?`,
    [`inactive_existing_assignment_${suffix}`, contactId]
  )
  const ctx = {
    config: { id: agentId, capabilitiesConfig },
    capabilitiesConfig,
    contactId,
    agentId,
    executionId: messageId,
    channel: 'whatsapp',
    dryRun: false,
    followUpMode: false,
    mandatoryHandoffActive: true,
    mandatoryHandoffAuthorityFence: async () => ({ authorized: true }),
    mandatoryHandoffTerminalAuthorityToken: inboundClaim.claimToken,
    actions: []
  }

  try {
    const handoffTool = createConversationalTools(ctx)
      .find((item) => item.name === 'send_to_human')
    const result = await handoffTool.invoke(null, JSON.stringify({
      motivo: 'Condición obligatoria cumplida',
      resumen: 'El equipo debe continuar el chat'
    }))
    const state = await db.get(
      `SELECT status, signal
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = ?`,
      [contactId, agentId, 'whatsapp']
    )
    const contact = await db.get(
      'SELECT assigned_user_id FROM contacts WHERE id = ?',
      [contactId]
    )

    assert.equal(result.ok, true)
    assert.equal(result.assignmentFallback, 'general_team')
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
    assert.equal(contact.assigned_user_id, null)
  } finally {
    await cleanupLiveHandoffConversation({ contactId, agentId })
  }
})
