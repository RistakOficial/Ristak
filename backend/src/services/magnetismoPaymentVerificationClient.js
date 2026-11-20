import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

const REQUEST_TIMEOUT_MS = 8000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const READ_TOOLS = new Set(['get_course_tree', 'get_student', 'get_student_progress'])
const ENROLLMENT_STATUSES = new Set(['active', 'expired', 'paused', 'cancelled', 'extended'])
const SOURCE_TYPES = new Set(['manual', 'webhook', 'auto', 'import'])
const EMAIL_SCHEMA = z.string().email()
const MESSAGES = {
  target_not_configured: 'La verificación de Magnetismo no está configurada.',
  target_configuration_invalid: 'La configuración de verificación de Magnetismo no es válida.',
  target_invalid_request: 'Los datos para verificar Magnetismo no son válidos.',
  target_auth_failed: 'Magnetismo rechazó la autorización de consulta.',
  target_rate_limited: 'Magnetismo alcanzó su límite de consultas. Intenta más tarde.',
  target_http_error: 'Magnetismo no pudo atender la consulta.',
  target_unavailable: 'No se pudo consultar Magnetismo.',
  target_timeout: 'Magnetismo tardó demasiado en responder.',
  target_response_too_large: 'La respuesta de Magnetismo excede el tamaño permitido.',
  target_protocol_error: 'Magnetismo devolvió una respuesta de consulta no válida.',
  target_identity_mismatch: 'La identidad devuelta por Magnetismo no coincide con la consulta.',
  target_student_not_found: 'No existe un alumno con ese correo en Magnetismo.',
  target_program_not_found: 'El programa no existe en Magnetismo.',
  target_tool_error: 'Magnetismo no pudo completar la verificación.'
}

class VerificationError extends Error {
  constructor(code) {
    super(MESSAGES[code])
    this.name = 'MagnetismoPaymentVerificationError'
    this.code = code
    this.status = code === 'target_invalid_request' ? 400 : code === 'target_timeout' ? 504 : 502
  }
}

const fail = (code = 'target_protocol_error') => { throw new VerificationError(code) }
const record = value => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value)
const emailAddress = value => text(value, 254) && EMAIL_SCHEMA.safeParse(value).success
const timestamp = value => text(value, 64) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const percentage = value => nonnegative(value) && value <= 100

function requireId(value) {
  if (!text(value, 200)) fail('target_invalid_request')
  return value
}

function normalizeProgram(program, expectedId) {
  if (!record(program) || !text(program.id, 200) || !text(program.title, 1000)) fail()
  if (program.id !== expectedId) fail('target_identity_mismatch')
  return { id: program.id, title: program.title }
}

function normalizeStudent(data, expectedEmail) {
  const student = data.student
  if (!record(student) || !text(student.id, 200) || !emailAddress(student.email) ||
      student.role !== 'student' || typeof student.active !== 'boolean' || !Array.isArray(data.access)) fail()
  const email = student.email.toLowerCase()
  if (email !== expectedEmail) fail('target_identity_mismatch')
  const enrollmentIds = new Set()
  const enrollments = data.access.map(item => {
    if (!record(item) || !text(item.id, 200) || !text(item.userId, 200) || !text(item.programId, 200) ||
        !ENROLLMENT_STATUSES.has(item.status) || !timestamp(item.startAt) ||
        !(item.endAt === null || timestamp(item.endAt)) || enrollmentIds.has(item.id)) fail()
    if (item.userId !== student.id) fail('target_identity_mismatch')
    enrollmentIds.add(item.id)
    const enrollment = {
      id: item.id, userId: item.userId, programId: item.programId,
      status: item.status, startAt: item.startAt, endAt: item.endAt
    }
    if (item.hasAccess !== undefined) {
      if (typeof item.hasAccess !== 'boolean') fail()
      enrollment.hasAccess = item.hasAccess
    }
    if (item.programTitle !== undefined) {
      if (!text(item.programTitle, 1000)) fail()
      enrollment.programTitle = item.programTitle
    }
    if (item.source !== undefined) {
      if (!SOURCE_TYPES.has(item.source)) fail()
      enrollment.source = item.source
    }
    if (item.externalRef !== undefined) {
      if (item.externalRef !== null && !text(item.externalRef, 1000)) fail()
      enrollment.externalRef = item.externalRef
    }
    return enrollment
  })
  return { id: student.id, email, active: student.active, enrollments }
}

function normalizeProgressStep(step) {
  if (step === null) return null
  if (!record(step) || !text(step.lessonId, 200) || !text(step.title, 1000) ||
      typeof step.completed !== 'boolean' || !percentage(step.watchPct) ||
      !nonnegative(step.watchedSeconds) || !nonnegative(step.videoSeconds) ||
      !nonnegative(step.lastPositionSeconds) || !(step.lastWatchedAt === null || timestamp(step.lastWatchedAt))) fail()
  const result = {
    lessonId: step.lessonId, title: step.title, completed: step.completed,
    watchPct: step.watchPct, watchedSeconds: step.watchedSeconds,
    videoSeconds: step.videoSeconds, lastPositionSeconds: step.lastPositionSeconds,
    lastWatchedAt: step.lastWatchedAt
  }
  if (step.stepNumber !== undefined) {
    if (!Number.isInteger(step.stepNumber) || step.stepNumber < 1) fail()
    result.stepNumber = step.stepNumber
  }
  return result
}

function normalizeProgress(data, studentId, programId) {
  if (!text(data.studentId, 200)) fail()
  if (data.studentId !== studentId) fail('target_identity_mismatch')
  const program = normalizeProgram(data.program, programId)
  if (!record(data.summary)) fail()
  const summary = {}
  for (const key of ['completed', 'total', 'avgWatchPct', 'videosStarted', 'videosCompleted', 'videosTotal', 'watchedSeconds', 'videoSeconds']) {
    const value = data.summary[key]
    if (!nonnegative(value) || (key === 'avgWatchPct' && !percentage(value)) ||
        (!['avgWatchPct', 'watchedSeconds', 'videoSeconds'].includes(key) && !Number.isInteger(value))) fail()
    summary[key] = value
  }
  if (summary.completed > summary.total || summary.videosCompleted > summary.videosStarted || summary.videosStarted > summary.videosTotal) fail()
  return {
    studentId, program, summary,
    lastWatched: normalizeProgressStep(data.lastWatched),
    nextIncompleteStep: normalizeProgressStep(data.nextIncompleteStep)
  }
}

function discardBody(response) {
  try { Promise.resolve(response.body?.cancel()).catch(() => {}) } catch { /* No remote body is included in errors. */ }
}

async function readJson(response, signal) {
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    discardBody(response)
    fail('target_response_too_large')
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body?.getReader) {
    discardBody(response)
    fail()
  }
  const reader = response.body.getReader()
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        Promise.resolve(reader.cancel()).catch(() => {})
        fail('target_response_too_large')
      }
      chunks.push(Buffer.from(value))
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) } catch { fail() }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** A separate, read-only connection to an existing Magnetismo MCP key. */
export function createMagnetismoPaymentVerificationClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const rawUrl = typeof env.MDP_PAYMENTS_MCP_URL === 'string' ? env.MDP_PAYMENTS_MCP_URL.trim() : ''
  const token = typeof env.MDP_PAYMENTS_MCP_TOKEN === 'string' ? env.MDP_PAYMENTS_MCP_TOKEN.trim() : ''
  if (!rawUrl || !token) fail('target_not_configured')
  let endpoint
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.href !== `${url.origin}/mcp`) fail('target_configuration_invalid')
    endpoint = url.href
  } catch { fail('target_configuration_invalid') }
  if (token.length > 512 || /[\s\x00-\x1f\x7f]/.test(token) || typeof fetchImpl !== 'function') fail('target_configuration_invalid')
  const targetKey = createHash('sha256').update(endpoint).digest('hex')

  async function callTool(name, args) {
    if (!READ_TOOLS.has(name)) fail('target_invalid_request')
    const controller = new AbortController()
    let timedOut = false
    let timer
    const id = randomUUID()
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new VerificationError('target_timeout'))
      }, REQUEST_TIMEOUT_MS)
    })
    const request = async () => {
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
      })
      if (response.redirected || (response.url && response.url !== endpoint)) { discardBody(response); fail() }
      if (!response.ok) {
        discardBody(response)
        fail(response.status === 401 || response.status === 403 ? 'target_auth_failed' : response.status === 429 ? 'target_rate_limited' : 'target_http_error')
      }
      const rpc = await readJson(response, controller.signal)
      if (!record(rpc) || rpc.jsonrpc !== '2.0' || rpc.id !== id || rpc.error !== undefined || !record(rpc.result)) fail()
      const result = rpc.result
      if (result.isError !== undefined && typeof result.isError !== 'boolean') fail()
      if (!record(result.structuredContent)) fail()
      if (result.isError || result.structuredContent.error !== undefined) {
        const message = result.structuredContent.error
        if (name === 'get_student' && message === 'Alumno no encontrado') fail('target_student_not_found')
        if ((name === 'get_course_tree' || name === 'get_student_progress') && message === 'Programa no encontrado') fail('target_program_not_found')
        fail('target_tool_error')
      }
      return result.structuredContent
    }
    try { return await Promise.race([request(), deadline]) } catch (error) {
      if (timedOut) fail('target_timeout')
      if (error instanceof VerificationError) throw error
      fail('target_unavailable')
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  return Object.freeze({
    targetKey,
    async getProgram(programId) {
      const id = requireId(programId)
      const data = await callTool('get_course_tree', { programId: id })
      return normalizeProgram(data.program, id)
    },
    async getStudent(email) {
      const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
      if (!emailAddress(normalizedEmail)) fail('target_invalid_request')
      return normalizeStudent(await callTool('get_student', { email: normalizedEmail }), normalizedEmail)
    },
    async getProgress(studentId, programId) {
      const id = requireId(studentId)
      const program = requireId(programId)
      return normalizeProgress(await callTool('get_student_progress', { studentId: id, programId: program }), id, program)
    }
  })
}
