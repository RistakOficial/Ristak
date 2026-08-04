import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

const utilityUrl = new URL('../src/utils/desktopChatContentCache.ts', import.meta.url)
const utilitySource = await readFile(utilityUrl, 'utf8')
const compiledUtility = await transform(utilitySource, {
  loader: 'ts',
  format: 'esm',
  target: 'es2020'
})
const utilityModuleUrl = `data:text/javascript;base64,${Buffer.from(compiledUtility.code).toString('base64')}`
const { clearRetiredDesktopChatContentCaches } = await import(utilityModuleUrl)

class MemoryStorage {
  constructor(entries) {
    this.entries = new Map(entries)
  }

  get length() {
    return this.entries.size
  }

  key(index) {
    return [...this.entries.keys()][index] ?? null
  }

  removeItem(key) {
    this.entries.delete(key)
  }
}

const storage = new MemoryStorage([
  ['ristak_desktop_chat_list_cache_v1', 'legacy'],
  ['ristak_desktop_chat_list_cache_v1:p2:account', 'scoped-list'],
  ['ristak_desktop_chat_conversation_cache_v1:p2:account:contact', 'scoped-thread'],
  ['ristak_phone_chat_archived_state_v1:p2:account', 'archive-preference'],
  ['auth_token', 'session']
])

clearRetiredDesktopChatContentCaches(storage)

assert.deepEqual(
  [...storage.entries.keys()],
  ['ristak_phone_chat_archived_state_v1:p2:account', 'auth_token'],
  'la limpieza sólo debe retirar contenido cacheado del chat'
)

const desktopChatSource = await readFile(
  new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url),
  'utf8'
)

assert.match(
  desktopChatSource,
  /const \[chats, setChats\] = useState<DesktopChatContact\[]>\(\[\]\)/,
  'la bandeja debe iniciar vacía y esperar la primera página autoritativa'
)
assert.match(
  desktopChatSource,
  /const \[chatsLoading, setChatsLoading\] = useState\(true\)/,
  'la bandeja debe mostrar carga mientras llega el servidor'
)
assert.doesNotMatch(
  desktopChatSource,
  /readCachedChatList|writeCachedChatList|readCachedConversation|writeCachedConversation/,
  'Desktop Chat no debe leer ni escribir snapshots de conversaciones en localStorage'
)
assert.match(
  desktopChatSource,
  /useLayoutEffect\(\(\) => \{\s+if \(!activeContactId\)/,
  'cambiar de contacto debe limpiar el hilo anterior antes del siguiente paint'
)

console.log('Desktop Chat live-first paint contract OK')
