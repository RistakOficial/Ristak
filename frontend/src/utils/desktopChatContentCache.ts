const RETIRED_DESKTOP_CHAT_CONTENT_CACHE_PREFIXES = [
  'ristak_desktop_chat_list_cache_v1',
  'ristak_desktop_chat_conversation_cache_v1'
] as const

type ChatContentStorage = Pick<Storage, 'length' | 'key' | 'removeItem'>

function getBrowserStorage(): ChatContentStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * El contenido del Chat desktop dejó de persistirse en el navegador. Esta
 * limpieza retira snapshots de versiones anteriores sin tocar preferencias
 * funcionales como archivados u ocultos.
 */
export function clearRetiredDesktopChatContentCaches(
  storage: ChatContentStorage | null = getBrowserStorage()
) {
  if (!storage) return

  try {
    const keys = Array.from(
      { length: storage.length },
      (_, index) => storage.key(index)
    ).filter((key): key is string => Boolean(key))

    keys.forEach((key) => {
      if (RETIRED_DESKTOP_CHAT_CONTENT_CACHE_PREFIXES.some(
        (prefix) => key === prefix || key.startsWith(`${prefix}:`)
      )) {
        storage.removeItem(key)
      }
    })
  } catch {
    // Best-effort: la red sigue siendo la única fuente visible del chat.
  }
}
