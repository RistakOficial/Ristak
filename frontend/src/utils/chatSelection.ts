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
