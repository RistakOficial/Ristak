interface IdentifiedChat {
  id: string
}

// Un contacto abierto desde Chatbot puede no tener mensajes ni pertenecer a la
// página del historial. La selección sigue siendo válida mientras esa página
// carga; si el servidor ya trae el contacto, su versión tiene prioridad.
export function includeSelectedChat<T extends IdentifiedChat>(rows: T[], selected: T | null | undefined): T[] {
  if (!selected || rows.some((row) => row.id === selected.id)) return rows
  return [...rows, selected]
}

export function preserveSelectedChat<T extends IdentifiedChat>(
  rows: T[],
  current: T[],
  selectedId: string | null,
  matchesScope: (contact: T) => boolean = () => true
): T[] {
  const selected = current.find((contact) => contact.id === selectedId)
  return includeSelectedChat(rows, selected && matchesScope(selected) ? selected : null)
}

interface ChatAgentStateIdentity {
  id?: string | null
  contactId: string
  agentId?: string | null
}

// Una respuesta confirmada reemplaza la versión anterior del mismo estado.
// Comparar ambas por prioridad haría ganar al viejo "activo" sobre "pausado".
export function upsertChatAgentState<T extends ChatAgentStateIdentity>(current: T[] = [], state: T): T[] {
  const sameState = (item: T) => (
    item.id && state.id
      ? item.id === state.id
      : item.contactId === state.contactId && (item.agentId || '') === (state.agentId || '')
  )
  return [state, ...current.filter((item) => !sameState(item))]
}
