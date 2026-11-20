import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createMagnetismoPaymentVerificationClient } from '../src/services/magnetismoPaymentVerificationClient.js'

const env = { MDP_PAYMENTS_MCP_URL: 'https://courses.example.test/mcp', MDP_PAYMENTS_MCP_TOKEN: 'existing-test-mcp-key' }
const enrollment = {
  id: 'enrollment-1', userId: 'student-1', programId: 'program-1', status: 'paused',
  startAt: '2026-01-01T00:00:00.000Z', endAt: '2026-02-01T00:00:00.000Z',
  hasAccess: false, programTitle: 'Programa', source: 'manual', externalRef: null
}
const student = () => ({
  student: { id: 'student-1', email: 'student@example.test', role: 'student', active: true, notes: 'private notes' },
  access: [{ ...enrollment, notes: 'private enrollment notes' }], accessEvents: [{ meta: 'private event' }]
})
const summary = { completed: 1, total: 3, avgWatchPct: 42, videosStarted: 2, videosCompleted: 1, videosTotal: 3, watchedSeconds: 120, videoSeconds: 300 }
const step = {
  lessonId: 'lesson-1', title: 'Paso', completed: false, watchPct: 40,
  watchedSeconds: 40, videoSeconds: 100, lastPositionSeconds: 45, lastWatchedAt: '2026-01-02T00:00:00.000Z', stepNumber: 1
}
const progress = () => ({ studentId: 'student-1', program: { id: 'program-1', title: 'Programa' }, summary: { ...summary }, lastWatched: { ...step }, nextIncompleteStep: null, assistantWork: [{ body: 'private work' }], lessons: ['not exposed'] })
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8' } })
function fixture(dataFor) {
  const calls = []
  const client = createMagnetismoPaymentVerificationClient({ env, fetchImpl: async (url, options) => {
    const rpc = JSON.parse(options.body)
    calls.push({ url, options, rpc })
    const data = typeof dataFor === 'function' ? dataFor(rpc) : dataFor
    return json({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }], isError: false } })
  } })
  return { client, calls }
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code && !error.message.includes(env.MDP_PAYMENTS_MCP_TOKEN) && !error.message.includes(env.MDP_PAYMENTS_MCP_URL))

test('configuration requires a separate existing key and a fixed HTTPS /mcp endpoint', () => {
  for (const config of [{}, { MDP_PROGRAM_API_URL: env.MDP_PAYMENTS_MCP_URL, MDP_PROGRAM_BRIDGE_SECRET: env.MDP_PAYMENTS_MCP_TOKEN }, { MDP_PAYMENTS_MCP_URL: env.MDP_PAYMENTS_MCP_URL }]) {
    assert.throws(() => createMagnetismoPaymentVerificationClient({ env: config }), { code: 'target_not_configured' })
  }
  for (const url of ['http://courses.example.test/mcp', 'https://user:password@courses.example.test/mcp', 'https://courses.example.test/mcp?token=x', 'https://courses.example.test/mcp#x', 'https://courses.example.test/mcp?', 'https://courses.example.test/mcp#', 'https://courses.example.test/mcp/key', 'https://courses.example.test/admin-mcp', 'https://courses.example.test/mcp/', 'invalid']) {
    assert.throws(() => createMagnetismoPaymentVerificationClient({ env: { ...env, MDP_PAYMENTS_MCP_URL: url } }), { code: 'target_configuration_invalid' })
  }
  assert.throws(() => createMagnetismoPaymentVerificationClient({ env: { ...env, MDP_PAYMENTS_MCP_TOKEN: 'bad\nkey' } }), { code: 'target_configuration_invalid' })
  assert.throws(() => createMagnetismoPaymentVerificationClient({ env: { ...env, MDP_PAYMENTS_MCP_TOKEN: 'x'.repeat(513) } }), { code: 'target_configuration_invalid' })
  const first = createMagnetismoPaymentVerificationClient({ env })
  const rotated = createMagnetismoPaymentVerificationClient({ env: { ...env, MDP_PAYMENTS_MCP_TOKEN: 'rotated-existing-key' } })
  const other = createMagnetismoPaymentVerificationClient({ env: { ...env, MDP_PAYMENTS_MCP_URL: 'https://other.example.test/mcp' } })
  assert.equal(first.targetKey, createHash('sha256').update(env.MDP_PAYMENTS_MCP_URL).digest('hex'))
  assert.equal(first.targetKey, rotated.targetKey)
  assert.notEqual(first.targetKey, other.targetKey)
  assert.deepEqual(Object.keys(first).sort(), ['getProgram', 'getProgress', 'getStudent', 'targetKey'])
})

test('read-only calls authenticate with Bearer and normalize only permitted fields', async () => {
  const { client, calls } = fixture(rpc => rpc.params.name === 'get_course_tree' ? { program: { id: 'program-1', title: 'Programa', secret: 'omit' }, tree: [] } : rpc.params.name === 'get_student' ? student() : progress())
  assert.deepEqual(await client.getProgram('program-1'), { id: 'program-1', title: 'Programa' })
  assert.deepEqual(await client.getStudent(' STUDENT@EXAMPLE.TEST '), { id: 'student-1', email: 'student@example.test', active: true, enrollments: [enrollment] })
  assert.deepEqual(await client.getProgress('student-1', 'program-1'), { studentId: 'student-1', program: { id: 'program-1', title: 'Programa' }, summary, lastWatched: step, nextIncompleteStep: null })
  assert.deepEqual(calls.map(call => call.rpc.params), [
    { name: 'get_course_tree', arguments: { programId: 'program-1' } },
    { name: 'get_student', arguments: { email: 'student@example.test' } },
    { name: 'get_student_progress', arguments: { studentId: 'student-1', programId: 'program-1' } }
  ])
  assert.equal(new Set(calls.map(call => call.rpc.id)).size, 3)
  for (const { url, options, rpc } of calls) {
    assert.equal(url, env.MDP_PAYMENTS_MCP_URL)
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.headers.Authorization, `Bearer ${env.MDP_PAYMENTS_MCP_TOKEN}`)
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.equal(options.headers.Accept, 'application/json')
    assert.equal(rpc.method, 'tools/call')
    assert.equal(rpc.jsonrpc, '2.0')
    assert.ok(options.signal instanceof AbortSignal)
  }
})

test('unregistered access and inactive accounts are preserved without inventing access', async () => {
  const data = student()
  data.student.active = false
  data.access = []
  assert.deepEqual(await fixture(data).client.getStudent('student@example.test'), { id: 'student-1', email: 'student@example.test', active: false, enrollments: [] })
  for (const status of ['active', 'expired', 'paused', 'cancelled', 'extended']) {
    data.access = [{ ...enrollment, status }]
    assert.equal((await fixture(data).client.getStudent('student@example.test')).enrollments[0].status, status)
  }
  data.access = [{ ...enrollment }, { ...enrollment, id: 'historical-enrollment' }]
  assert.equal((await fixture(data).client.getStudent('student@example.test')).enrollments.length, 2)
})

test('malformed student, enrollment, program and progress data fail closed', async () => {
  const cases = [
    data => { delete data.student.active }, data => { data.student.active = 'true' },
    data => { data.student.role = 'admin' }, data => { data.access = null },
    data => { data.access[0].status = 'paid' }, data => { delete data.access[0].endAt },
    data => { data.access[0].startAt = '2026-01-01' }, data => { data.access[0].hasAccess = 'yes' },
    data => { data.access.push({ ...data.access[0] }) }
  ]
  for (const mutate of cases) {
    const data = student(); mutate(data)
    await rejectsCode(fixture(data).client.getStudent('student@example.test'), 'target_protocol_error')
  }
  for (const mutate of [data => { data.student.email = 'other@example.test' }, data => { data.access[0].userId = 'other-student' }]) {
    const data = student(); mutate(data)
    await rejectsCode(fixture(data).client.getStudent('student@example.test'), 'target_identity_mismatch')
  }
  await rejectsCode(fixture({ program: { id: 'other-program', title: 'Programa' } }).client.getProgram('program-1'), 'target_identity_mismatch')
  await rejectsCode(fixture({ program: { id: 'program-1' } }).client.getProgram('program-1'), 'target_protocol_error')
  for (const mutate of [data => { data.summary.avgWatchPct = 101 }, data => { delete data.summary.completed }, data => { data.summary.completed = '1' }, data => { data.lastWatched.lastPositionSeconds = -1 }, data => { delete data.nextIncompleteStep }]) {
    const data = progress(); mutate(data)
    await rejectsCode(fixture(data).client.getProgress('student-1', 'program-1'), 'target_protocol_error')
  }
  const other = progress(); other.studentId = 'other-student'
  await rejectsCode(fixture(other).client.getProgress('student-1', 'program-1'), 'target_identity_mismatch')
})

test('invalid selectors never send requests or fall back to a default program', async () => {
  const { client, calls } = fixture({})
  for (const action of [() => client.getProgram(), () => client.getProgram(''), () => client.getStudent('invalid'), () => client.getStudent('a@b'), () => client.getStudent('a@b/c'), () => client.getProgress('student-1'), () => client.getProgress('', 'program-1')]) await rejectsCode(action(), 'target_invalid_request')
  assert.equal(calls.length, 0)
})

test('HTTP and network errors do not expose remote bodies, URLs or secrets', async () => {
  for (const [status, code] of [[401, 'target_auth_failed'], [403, 'target_auth_failed'], [429, 'target_rate_limited'], [500, 'target_http_error'], [302, 'target_http_error']]) {
    const client = createMagnetismoPaymentVerificationClient({ env, fetchImpl: async () => new Response(`private ${env.MDP_PAYMENTS_MCP_TOKEN}`, { status }) })
    await rejectsCode(client.getStudent('student@example.test'), code)
  }
  const client = createMagnetismoPaymentVerificationClient({ env, fetchImpl: async () => { throw new Error(`${env.MDP_PAYMENTS_MCP_URL} ${env.MDP_PAYMENTS_MCP_TOKEN}`) } })
  await rejectsCode(client.getStudent('student@example.test'), 'target_unavailable')
})

test('both JSON-RPC and tool-level errors are handled without leaking tool messages', async () => {
  const make = responseFor => createMagnetismoPaymentVerificationClient({ env, fetchImpl: async (url, options) => json(responseFor(JSON.parse(options.body))) })
  for (const responseFor of [
    rpc => ({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: env.MDP_PAYMENTS_MCP_TOKEN } }),
    rpc => ({ jsonrpc: '2.0', id: 'other-id', result: { structuredContent: student() } }),
    rpc => ({ jsonrpc: '1.0', id: rpc.id, result: { structuredContent: student() } }),
    rpc => ({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(student()) }] } }),
    rpc => ({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: student(), isError: 'false' } })
  ]) await rejectsCode(make(responseFor).getStudent('student@example.test'), 'target_protocol_error')
  for (const [message, code] of [['Alumno no encontrado', 'target_student_not_found'], [env.MDP_PAYMENTS_MCP_TOKEN, 'target_tool_error']]) {
    await rejectsCode(make(rpc => ({ jsonrpc: '2.0', id: rpc.id, result: { isError: true, structuredContent: { error: message } } })).getStudent('student@example.test'), code)
  }
  await rejectsCode(make(rpc => ({ jsonrpc: '2.0', id: rpc.id, result: { isError: true, structuredContent: { error: 'Programa no encontrado' } } })).getProgram('program-1'), 'target_program_not_found')
})

test('unexpected redirects, non-JSON, malformed JSON and oversized responses are rejected', async () => {
  for (const createResponse of [
    () => { const response = json({}); Object.defineProperty(response, 'redirected', { value: true }); return response },
    () => { const response = json({}); Object.defineProperty(response, 'url', { value: 'https://other.example.test/mcp' }); return response },
    () => new Response('event: message\ndata: {}', { headers: { 'Content-Type': 'text/event-stream' } }),
    () => new Response('{invalid', { headers: { 'Content-Type': 'application/json' } })
  ]) {
    const client = createMagnetismoPaymentVerificationClient({ env, fetchImpl: async () => createResponse() })
    await rejectsCode(client.getStudent('student@example.test'), 'target_protocol_error')
  }
  for (const createResponse of [
    () => new Response('small', { headers: { 'Content-Type': 'application/json', 'Content-Length': '3000000' } }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })
  ]) {
    const client = createMagnetismoPaymentVerificationClient({ env, fetchImpl: async () => createResponse() })
    await rejectsCode(client.getStudent('student@example.test'), 'target_response_too_large')
  }
})

test('the deadline aborts a stalled request and returns a safe timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const client = createMagnetismoPaymentVerificationClient({ env, fetchImpl: (url, options) => {
    signal = options.signal
    return new Promise(() => {})
  } })
  const check = rejectsCode(client.getStudent('student@example.test'), 'target_timeout')
  t.mock.timers.tick(8000)
  await check
  assert.equal(signal.aborted, true)
})

test('the same deadline bounds and cancels a stalled response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const client = createMagnetismoPaymentVerificationClient({ env, fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }) })
  const check = rejectsCode(client.getStudent('student@example.test'), 'target_timeout')
  await Promise.resolve()
  assert.equal(body.locked, true)
  t.mock.timers.tick(8000)
  await check
  assert.equal(cancelled, true)
})
