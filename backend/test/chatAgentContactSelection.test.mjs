import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const requireFromFrontend = createRequire(new URL('../../frontend/package.json', import.meta.url))
const typescript = requireFromFrontend('typescript')
const source = await readFile(new URL('../../frontend/src/utils/chatSelection.ts', import.meta.url), 'utf8')
const compiled = typescript.transpileModule(source, {
  compilerOptions: { module: typescript.ModuleKind.ES2022, target: typescript.ScriptTarget.ES2022 }
}).outputText
const { includeSelectedChat, preserveSelectedChat } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
)

test('un contacto asignado al robot sin historial puede abrirse y soporta la respuesta tardía de la búsqueda', () => {
  const selected = { id: 'agent-only', name: 'Prueba soporte', messageCount: 0, unreadCount: 0 }
  const history = [{ id: 'existing-chat', name: 'Otro contacto', messageCount: 4 }]
  const opened = includeSelectedChat(history, selected)
  assert.equal(opened.find((row) => row.id === selected.id), selected)

  const refreshed = preserveSelectedChat([], opened, selected.id, (contact) => contact.name.includes('Prueba'))
  assert.deepEqual(refreshed, [selected])
  assert.equal(refreshed.find((row) => row.id === selected.id)?.name, 'Prueba soporte')
  assert.deepEqual(history.map((row) => row.id), ['existing-chat'])
})

test('la página real hidrata el contacto seleccionado sin duplicarlo ni conservar datos viejos', () => {
  const fallback = { id: 'agent-only', name: 'Nombre anterior', messageCount: 0 }
  const canonical = { id: 'agent-only', name: 'Nombre confirmado', messageCount: 1 }
  const page = [canonical]
  assert.equal(includeSelectedChat(page, fallback), page)
  assert.equal(preserveSelectedChat(page, [fallback], fallback.id), page)
  assert.equal(page[0].name, 'Nombre confirmado')
})

test('el refresco conserva sólo la selección actual y respeta cambios de búsqueda o eliminación', () => {
  const old = { id: 'old', name: 'Anterior', removed: false }
  const latest = { id: 'latest', name: 'Actual', removed: false }
  const current = [old, latest]
  assert.deepEqual(preserveSelectedChat([], current, latest.id), [latest])
  assert.deepEqual(preserveSelectedChat([], current, latest.id, (row) => row.name === 'Anterior'), [])
  assert.deepEqual(preserveSelectedChat([], [{ ...latest, removed: true }], latest.id, (row) => !row.removed), [])
  assert.deepEqual(preserveSelectedChat([], current, null), [])
  assert.deepEqual(includeSelectedChat([], null), [])
})

test('desktop y móvil hidratan la selección de Chatbot y la conservan frente a páginas sin mensajes', async () => {
  const [desktop, phone] = await Promise.all([
    readFile(new URL('../../frontend/src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/pages/PhoneChat/PhoneChat.tsx', import.meta.url), 'utf8')
  ])
  assert.match(desktop, /const handleSelectChat[\s\S]*?chatsRef\.current = includeSelectedChat\(chatsRef\.current, contact\)/)
  assert.match(desktop, /const searchRows = preserveSelectedChat\(/)
  assert.match(phone, /const handleSelectContact[\s\S]*?chatsRef\.current = includeSelectedChat\(chatsRef\.current, selectedChat\)/)
  assert.match(phone, /const applyLoadedChats[\s\S]*?preserveSelectedChat\(loadedChats, chatsRef\.current, activeContactIdRef\.current/)
})
