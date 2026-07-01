// Presencia de chat en memoria: qué usuario tiene ABIERTO (y al frente) qué
// contacto AHORA MISMO. Sirve para no mandar push a quien ya está viendo el chat
// (como WhatsApp/Messenger), y solo a ese usuario — los demás sí reciben.
//
// Es process-local a propósito: la presencia es efímera y va atada a una sesión
// viva; no necesita tabla ni sobrevivir a reinicios. Si algún día el backend
// corre multi-instancia, este Map se cambia por Redis sin tocar los call sites.

const PRESENCE_TTL_MS = 45_000

function cleanId(value) {
  return String(value ?? '').trim()
}

// userId -> { contactId, foreground, expiresAt }
const presenceByUser = new Map()

function isFresh(entry) {
  return Boolean(entry) && entry.expiresAt > Date.now()
}

/**
 * Registra/renueva que un usuario está viendo un contacto al frente.
 * Si contactId viene vacío o foreground=false, se limpia (dejó de mirar / se fue
 * a 2º plano) para que deje de suprimir de inmediato.
 */
export function touchPresence(userId, { contactId = '', foreground = true } = {}) {
  const user = cleanId(userId)
  if (!user) return
  const contact = cleanId(contactId)

  if (!contact || foreground === false) {
    presenceByUser.delete(user)
    return
  }

  presenceByUser.set(user, {
    contactId: contact,
    foreground: true,
    expiresAt: Date.now() + PRESENCE_TTL_MS
  })
}

/** Limpia toda la presencia de un usuario (p. ej. al cerrarse su conexión SSE). */
export function clearPresence(userId) {
  const user = cleanId(userId)
  if (user) presenceByUser.delete(user)
}

/** ¿Este usuario está viendo (al frente y fresco) este contacto? */
export function isViewing(userId, contactId) {
  const user = cleanId(userId)
  const contact = cleanId(contactId)
  if (!user || !contact) return false
  const entry = presenceByUser.get(user)
  if (!isFresh(entry)) {
    if (entry) presenceByUser.delete(user)
    return false
  }
  return entry.foreground === true && entry.contactId === contact
}

/** Lista de userIds que están viendo (al frente y fresco) un contacto. */
export function getViewingUserIds(contactId) {
  const contact = cleanId(contactId)
  if (!contact) return []
  const now = Date.now()
  const viewers = []
  for (const [user, entry] of presenceByUser.entries()) {
    if (entry.expiresAt <= now) {
      presenceByUser.delete(user)
      continue
    }
    if (entry.foreground === true && entry.contactId === contact) {
      viewers.push(user)
    }
  }
  return viewers
}

export function getPresenceTtlMs() {
  return PRESENCE_TTL_MS
}
