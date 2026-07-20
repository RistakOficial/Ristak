const normalizeCalendarIds = (calendarIds: string[]) => (
  [...new Set(calendarIds.map(calendarId => calendarId.trim()).filter(Boolean))]
)

/**
 * Una selección vacía es el valor canónico para incluir todos los calendarios,
 * también los que se creen o sincronicen después.
 */
export const isCalendarIncludedInCommercialReports = (
  selectedCalendarIds: string[],
  calendarId: string
) => selectedCalendarIds.length === 0 || selectedCalendarIds.includes(calendarId)

/**
 * Convierte el estado implícito "todos" en una selección explícita al excluir
 * un calendario. Volver a una lista vacía restaura el estado "todos".
 */
export const getNextCommercialReportCalendarIds = (
  selectedCalendarIds: string[],
  calendarId: string,
  availableCalendarIds: string[]
) => {
  const normalizedSelection = normalizeCalendarIds(selectedCalendarIds)
  const normalizedCalendarId = calendarId.trim()

  if (!normalizedCalendarId) return normalizedSelection

  if (normalizedSelection.length === 0) {
    return normalizeCalendarIds(availableCalendarIds)
      .filter(availableCalendarId => availableCalendarId !== normalizedCalendarId)
  }

  if (normalizedSelection.includes(normalizedCalendarId)) {
    return normalizedSelection.filter(selectedCalendarId => selectedCalendarId !== normalizedCalendarId)
  }

  return [...normalizedSelection, normalizedCalendarId]
}
