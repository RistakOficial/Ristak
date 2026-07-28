export const CONFIRMATION_SUCCESS_ACTIONS = Object.freeze([
  'chat_card',
  'notify_push',
  'chat_badge',
  'mark_confirmed'
])

export const DEFAULT_CONFIRMATION_SUCCESS_ACTIONS = Object.freeze([
  ...CONFIRMATION_SUCCESS_ACTIONS
])

export const LEGACY_CONFIRMATION_SUCCESS_ACTIONS = Object.freeze([
  'chat_card',
  'mark_confirmed'
])

const CONFIRMATION_SUCCESS_ACTION_SET = new Set(CONFIRMATION_SUCCESS_ACTIONS)

function parseStoredActions(value) {
  if (Array.isArray(value)) return value

  const clean = String(value || '').trim()
  if (!clean) return []
  if (!clean.startsWith('[')) return [clean]

  try {
    const parsed = JSON.parse(clean)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function normalizeConfirmationSuccessActions(
  value,
  fallback = LEGACY_CONFIRMATION_SUCCESS_ACTIONS
) {
  const parsed = parseStoredActions(value)
  const fallbackValues = parseStoredActions(fallback)
  const validValues = parsed.length ? parsed : fallbackValues
  const selected = new Set(
    validValues
      .map(action => String(action || '').trim())
      .filter(action => CONFIRMATION_SUCCESS_ACTION_SET.has(action))
  )

  // Confirmar el estado real de la cita no es un aviso opcional: es el resultado
  // base del modo confirmación y debe permanecer activo aunque un cliente viejo
  // mande únicamente la acción adicional que conocía.
  selected.add('mark_confirmed')

  return CONFIRMATION_SUCCESS_ACTIONS.filter(action => selected.has(action))
}

export function serializeConfirmationSuccessActions(
  value,
  fallback = DEFAULT_CONFIRMATION_SUCCESS_ACTIONS
) {
  return JSON.stringify(normalizeConfirmationSuccessActions(value, fallback))
}

export function confirmationSuccessActionSqlContains(columnExpression, action) {
  const cleanAction = String(action || '').trim()
  if (!CONFIRMATION_SUCCESS_ACTION_SET.has(cleanAction)) {
    throw new Error(`Acción de confirmación no soportada: ${cleanAction || '(vacía)'}`)
  }

  // La columna histórica aceptaba un valor escalar. El formato nuevo guarda un
  // arreglo JSON compacto; esta condición funciona igual en SQLite y PostgreSQL
  // sin castear texto histórico que podría no ser JSON.
  return `(
    COALESCE(${columnExpression}, 'chat_card') = '${cleanAction}'
    OR COALESCE(${columnExpression}, '') LIKE '%"${cleanAction}"%'
  )`
}
