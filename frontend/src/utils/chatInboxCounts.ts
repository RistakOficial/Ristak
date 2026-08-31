export type ChatInboxCountRow = {
  id: string
}

/**
 * El chip `No leidos` describe cuantas conversaciones abrira el filtro. El
 * total de mensajes pendientes pertenece al badge global y es otra metrica.
 */
export function countUnreadChatConversations<T extends ChatInboxCountRow>(
  chats: T[],
  archivedChatIds: ReadonlySet<string>,
  getUnreadCount: (contact: T) => number,
  isVisibleInFilter: (contact: T) => boolean = () => true
): number {
  return chats.reduce((total, contact) => (
    archivedChatIds.has(contact.id)
      || !isVisibleInFilter(contact)
      || getUnreadCount(contact) <= 0
      ? total
      : total + 1
  ), 0)
}

/**
 * Los flags locales pueden sobrevivir a un contacto eliminado u oculto. El
 * contador visible solo incluye conversaciones que la lista puede renderizar.
 */
export function countLoadedArchivedChatConversations<T extends ChatInboxCountRow>(
  chats: T[],
  archivedChatIds: ReadonlySet<string>,
  isVisibleInFilter: (contact: T) => boolean = () => true
): number {
  return chats.reduce((total, contact) => (
    archivedChatIds.has(contact.id) && isVisibleInFilter(contact)
      ? total + 1
      : total
  ), 0)
}
