import { assessConversationDeterministically, mergeConversationAssessment } from './assessment.js'
import { applyStrategyPlan, planConversationStrategy } from './strategyPlanner.js'

function expectationResult(name, expected, actual) {
  const pass = Array.isArray(expected) ? expected.includes(actual) : expected === actual
  return { name, pass, expected, actual }
}
export function evaluateIntelligenceExpectation(state = {}, expected = {}) {
  const checks = []
  if (expected.stage) checks.push(expectationResult('stage', expected.stage, state.stage))
  if (expected.temperature) checks.push(expectationResult('temperature', expected.temperature, state.temperature))
  if (expected.action) checks.push(expectationResult('action', expected.action, state.strategy?.action))
  if (expected.tool) checks.push(expectationResult('tool', expected.tool, state.strategy?.tool))
  if (expected.qualification) checks.push(expectationResult('qualification', expected.qualification, state.qualification?.status))
  if (expected.handoff !== undefined) checks.push(expectationResult('handoff', expected.handoff, state.handoff?.recommended === true))
  if (expected.followUpStop !== undefined) checks.push(expectationResult('followUpStop', expected.followUpStop, state.followUp?.stop === true))
  if (expected.maxHypotheses !== undefined) {
    const actual = state.story?.hypotheses?.length || 0
    checks.push({ name: 'maxHypotheses', pass: actual <= expected.maxHypotheses, expected: `<=${expected.maxHypotheses}`, actual })
  }
  return {
    passed: checks.every((check) => check.pass),
    checks
  }
}

export function runDeterministicConversationScenario({
  turns = [],
  policy = {},
  initialState = null,
  channel = 'chat',
  followUpMode = false,
  now = new Date('2026-01-01T12:00:00.000Z')
} = {}) {
  let state = initialState
  const messages = []
  const trace = []

  turns.forEach((turn, index) => {
    const role = turn?.role === 'assistant' ? 'assistant' : 'user'
    messages.push({ id: turn?.id || `turn_${index + 1}`, role, content: String(turn?.content || '') })
    if (role !== 'user') return

    const assessment = assessConversationDeterministically({ messages, policy, previousState: state, followUpMode })
    state = mergeConversationAssessment({
      previousState: state,
      assessment,
      policy,
      channel,
      now: new Date(now.getTime() + index * 1000)
    })
    const strategy = planConversationStrategy({
      intelligenceState: state,
      policy,
      latestMessage: turn.content,
      followUpMode
    })
    state = applyStrategyPlan(state, strategy)
    trace.push({ turnId: turn?.id || `turn_${index + 1}`, state })
  })

  return { state, trace, messages }
}
