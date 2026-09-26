// Resolve every cursor page atomically: callers must never apply a partial selection.
export async function collectContactSelection<T extends { id: string }>(
  loadPage: (page: number, cursor: string | null) => Promise<{
    contacts: T[]
    pagination: { hasNext: boolean; nextCursor: string | null }
  }>,
  signal?: AbortSignal
): Promise<T[]> {
  const contacts = new Map<string, T>()
  const cursors = new Set<string>()
  let page = 1
  let cursor: string | null = null
  while (true) {
    signal?.throwIfAborted()
    const result = await loadPage(page, cursor)
    signal?.throwIfAborted()
    for (const contact of result.contacts) contacts.set(contact.id, contact)
    if (!result.pagination.hasNext) return [...contacts.values()]
    const next = result.pagination.nextCursor
    if (!next || cursors.has(next) || result.contacts.length === 0) {
      throw new Error('No se pudo completar la selección de contactos. Intenta nuevamente.')
    }
    cursors.add(next)
    cursor = next
    page += 1
  }
}
