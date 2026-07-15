import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readRepositoryFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
const requireFromFrontend = createRequire(new URL('../../frontend/package.json', import.meta.url))
const typescript = requireFromFrontend('typescript')

async function importConversationRequestCoordinator() {
  const source = await readRepositoryFile('frontend/src/services/desktopChatConversationRequest.ts')
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2022,
      target: typescript.ScriptTarget.ES2022
    }
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

function abortableGate(signal) {
  let resolve
  const promise = new Promise((nextResolve, reject) => {
    resolve = nextResolve
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  return { promise, resolve }
}

test('Chat ejecuta una sola carga concurrente por contacto', async () => {
  const { createDesktopChatConversationRequestCoordinator } = await importConversationRequestCoordinator()
  const coordinator = createDesktopChatConversationRequestCoordinator()
  let calls = 0
  let gate

  const execute = (signal) => {
    calls += 1
    gate = abortableGate(signal)
    return gate.promise
  }

  const first = coordinator.run('contact-1', 'foreground', execute)
  const duplicate = coordinator.run('contact-1', 'background', execute)

  assert.strictEqual(duplicate, first)
  assert.equal(calls, 1)
  gate.resolve()
  await first
})

test('Chat conserva el singleflight durante el replay de efectos y cancela físicamente al desmontar', async () => {
  const { createDesktopChatConversationRequestCoordinator } = await importConversationRequestCoordinator()
  const coordinator = createDesktopChatConversationRequestCoordinator()
  let calls = 0
  let activeSignal
  let gate

  const execute = (signal) => {
    calls += 1
    activeSignal = signal
    gate = abortableGate(signal)
    return gate.promise
  }

  const first = coordinator.run('contact-1', 'foreground', execute)
  coordinator.scheduleAbort('contact-1')
  const replay = coordinator.run('contact-1', 'foreground', execute)
  await new Promise((resolve) => queueMicrotask(resolve))

  assert.strictEqual(replay, first)
  assert.equal(calls, 1)
  assert.equal(activeSignal.aborted, false)
  gate.resolve()
  await first

  const leavingChat = coordinator.run('contact-2', 'foreground', execute)
  coordinator.scheduleAbort('contact-2')
  await assert.rejects(leavingChat, (error) => error?.name === 'AbortError')
  assert.equal(activeSignal.aborted, true)
})

test('Chat cancela el contacto anterior antes de transportar el siguiente', async () => {
  const { createDesktopChatConversationRequestCoordinator } = await importConversationRequestCoordinator()
  const coordinator = createDesktopChatConversationRequestCoordinator()
  const signals = []
  const gates = []

  const execute = (signal) => {
    signals.push(signal)
    const gate = abortableGate(signal)
    gates.push(gate)
    return gate.promise
  }

  const first = coordinator.run('contact-1', 'foreground', execute)
  const second = coordinator.run('contact-2', 'foreground', execute)

  await assert.rejects(first, (error) => error?.name === 'AbortError')
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  gates[1].resolve()
  await second
})

test('DesktopChat conecta la señal a toda la hidratación y no marca leído desde cada refetch', async () => {
  const [desktop, whatsapp, agent] = await Promise.all([
    readRepositoryFile('frontend/src/pages/DesktopChat/DesktopChat.tsx'),
    readRepositoryFile('frontend/src/services/whatsappApiService.ts'),
    readRepositoryFile('frontend/src/services/conversationalAgentService.ts')
  ])
  const loadStart = desktop.indexOf('const loadConversation = useCallback')
  const loadEnd = desktop.indexOf('const loadOlderConversationMessages = useCallback', loadStart)
  const loadConversation = desktop.slice(loadStart, loadEnd)

  assert.ok(loadStart >= 0 && loadEnd > loadStart)
  assert.match(loadConversation, /conversationRequestCoordinator\.run\(/)
  assert.match(loadConversation, /getContactConversation\(contactId,[\s\S]{0,260}signal/)
  assert.match(loadConversation, /getContactJourney\(contactId,[\s\S]{0,260}signal/)
  assert.match(loadConversation, /getContactDetails\(contactId,[\s\S]{0,260}signal/)
  assert.match(loadConversation, /getScheduledMessages\(contactId, \{ signal \}\)/)
  assert.match(loadConversation, /getStates\(contactId, \{ signal \}\)/)
  assert.match(loadConversation, /listCompletionEvents\(\{ contactId, limit: 20 \}, \{ signal \}\)/)
  assert.doesNotMatch(loadConversation, /markChatRead/)
  assert.equal((desktop.match(/contactsService\.markChatRead\(/g) || []).length, 1)
  assert.match(desktop, /return \(\) => conversationRequestCoordinator\.scheduleAbort\(activeContactId\)/)
  assert.match(desktop, /conversationRequestCoordinator\.scheduleAbort\(\)/)
  assert.match(whatsapp, /getScheduledMessages: \(contactId: string, options: \{ signal\?: AbortSignal \} = \{\}\)/)
  assert.match(agent, /getStates\(contactId: string, options: \{ signal\?: AbortSignal \} = \{\}\)/)
  assert.match(agent, /listCompletionEvents\([\s\S]{0,260}options: \{ signal\?: AbortSignal \} = \{\}/)
})
