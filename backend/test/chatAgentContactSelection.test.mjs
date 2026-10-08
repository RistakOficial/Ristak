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
const { includeSelectedChat, preserveSelectedChat, upsertChatAgentState } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
)

async function importPrimaryStateSelector(path) {
  const text = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
  const parsed = typescript.createSourceFile(path, text, typescript.ScriptTarget.ES2022, true, typescript.ScriptKind.TSX)
  const selector = parsed.statements.find((node) => typescript.isFunctionDeclaration(node) && node.name?.text === 'selectPrimaryAgentState')
  assert.ok(selector, 'La superficie debe exponer su selección de estado principal')
  const code = typescript.transpileModule(`
    const parseSortableDateValue = (value) => Date.parse(value || '') || 0;
    ${selector.getText(parsed)}
    export { selectPrimaryAgentState };
  `, { compilerOptions: { module: typescript.ModuleKind.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

async function importDesktopComposerMenuAction() {
  const path = 'frontend/src/pages/DesktopChat/DesktopChat.tsx'
  const text = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
  const parsed = typescript.createSourceFile(path, text, typescript.ScriptTarget.ES2022, true, typescript.ScriptKind.TSX)
  let declaration
  const visit = (node) => {
    if (typescript.isVariableDeclaration(node) && node.name.getText(parsed) === 'handleOpenComposerAgentMenu') declaration = node
    typescript.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(declaration, 'Debe existir el control real del menú del compositor')
  const code = typescript.transpileModule(`
    export function openMenu(states, menuOpen = false) {
      const activeContact = { id: 'contact-1' };
      const activeContactAgentStates = states;
      const conversationAgentState = states[0] || null;
      const conversationAgentActive = states.some((state) => state.status === 'active');
      const conversationAgentBusy = false;
      const closeTemplatePanel = () => {};
      const setComposerMenuOpen = () => {};
      let pickerOpen = null;
      const setAgentPickerOpen = (value) => { pickerOpen = value; };
      const setAgentComposerMenuOpen = (update) => { menuOpen = update(menuOpen); };
      const useCallback = (fn) => fn;
      const ${declaration.getText(parsed)};
      handleOpenComposerAgentMenu();
      return { menuOpen, pickerOpen };
    }
  `, { compilerOptions: { module: typescript.ModuleKind.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

test('el control real abre Reactivar para un agente pausado y sólo pide asignar cuando no hay ninguno', async () => {
  const { openMenu } = await importDesktopComposerMenuAction()
  const paused = { id: 'state-1', contactId: 'contact-1', agentId: 'agent-1', status: 'paused' }
  assert.deepEqual(openMenu([paused]), { menuOpen: true, pickerOpen: false })
  assert.deepEqual(openMenu([{ ...paused, status: 'active' }]), { menuOpen: true, pickerOpen: false })
  assert.deepEqual(openMenu([]), { menuOpen: true, pickerOpen: true })
  assert.deepEqual(openMenu([paused], true), { menuOpen: false, pickerOpen: false })
})

for (const [label, path] of [
  ['escritorio', 'frontend/src/pages/DesktopChat/DesktopChat.tsx'],
  ['móvil', 'frontend/src/pages/PhoneChat/PhoneChat.tsx']
]) {
  test(`${label}: pausar, tomar u omitir reemplaza el activo anterior y reactivar restaura el menú`, async () => {
    const { selectPrimaryAgentState } = await importPrimaryStateSelector(path)
    let current = [{ id: 'state-1', contactId: 'contact-1', agentId: 'agent-1', status: 'active', signal: null,
      updatedAt: '2026-10-07T23:00:00.000Z' }]
    for (const status of ['paused', 'active', 'human', 'active', 'skipped', 'active']) {
      const confirmed = { ...current[0], status, updatedAt: '2026-10-07T23:00:01.000Z' }
      current = upsertChatAgentState(current, confirmed)
      assert.equal(current.length, 1)
      assert.equal(selectPrimaryAgentState(current)?.status, status)
      assert.equal(selectPrimaryAgentState(current), confirmed)
    }
  })
}

test('actualizar un estado no reemplaza los de otro agente, contacto o canal', () => {
  const old = { id: 'whatsapp-1', contactId: 'contact-1', agentId: 'agent-1', status: 'active' }
  const others = [
    { id: 'sms-1', contactId: 'contact-1', agentId: 'agent-1', status: 'active' },
    { id: 'whatsapp-2', contactId: 'contact-1', agentId: 'agent-2', status: 'active' },
    { id: 'whatsapp-3', contactId: 'contact-2', agentId: 'agent-1', status: 'active' }
  ]
  const paused = { ...old, status: 'paused' }
  assert.deepEqual(upsertChatAgentState([old, ...others], paused), [paused, ...others])
  assert.deepEqual(upsertChatAgentState([{ contactId: 'legacy', agentId: 'agent-1', status: 'active' }],
    { contactId: 'legacy', agentId: 'agent-1', status: 'paused' }),
    [{ contactId: 'legacy', agentId: 'agent-1', status: 'paused' }])
})

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
