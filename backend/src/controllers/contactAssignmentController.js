import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

// Asignación de un contacto a un usuario (responsable). Se usa para enrutar las
// notificaciones de chat al asignado (además de quien esté configurado), y para
// mostrar/editar el responsable en el panel del contacto.

function userDisplayName(row) {
  const full = String(row.full_name || '').trim()
  if (full) return full
  const composed = [row.first_name, row.last_name].map((v) => String(v || '').trim()).filter(Boolean).join(' ')
  if (composed) return composed
  return String(row.username || row.email || `Usuario ${row.id}`).trim()
}

// GET /api/contacts/assignable-users — usuarios activos que pueden ser responsables.
export const getAssignableUsers = async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT id, username, email, first_name, last_name, full_name, role
       FROM users
       WHERE is_active = 1
       ORDER BY full_name ASC, username ASC`
    )
    res.json({
      success: true,
      users: rows.map((row) => ({
        id: String(row.id),
        name: userDisplayName(row),
        role: row.role || null
      }))
    })
  } catch (error) {
    logger.error('Error listando usuarios asignables:', error)
    res.status(500).json({ success: false, error: 'No se pudieron cargar los usuarios' })
  }
}

// GET /api/contacts/:id/assignment — responsable actual del contacto.
export const getContactAssignment = async (req, res) => {
  try {
    const contactId = String(req.params.id || '').trim()
    if (!contactId) return res.status(400).json({ success: false, error: 'Falta el contacto' })
    const row = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
    if (!row) return res.status(404).json({ success: false, error: 'Contacto no encontrado' })
    res.json({ success: true, assignedUserId: row.assigned_user_id ? String(row.assigned_user_id) : null })
  } catch (error) {
    logger.error('Error leyendo asignación de contacto:', error)
    res.status(500).json({ success: false, error: 'No se pudo leer la asignación' })
  }
}

// PUT /api/contacts/:id/assignment { userId } — asigna (o desasigna con null/'').
export const setContactAssignment = async (req, res) => {
  try {
    const contactId = String(req.params.id || '').trim()
    if (!contactId) return res.status(400).json({ success: false, error: 'Falta el contacto' })

    const rawUserId = req.body?.userId
    const userId = rawUserId === null || rawUserId === undefined ? '' : String(rawUserId).trim()

    const contact = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId])
    if (!contact) return res.status(404).json({ success: false, error: 'Contacto no encontrado' })

    if (userId) {
      const user = await db.get('SELECT id FROM users WHERE id = ? AND is_active = 1', [userId])
      if (!user) return res.status(400).json({ success: false, error: 'Usuario no válido' })
    }

    await db.run(
      `UPDATE contacts
       SET assigned_user_id = ?, assignment_test_effect_id = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [userId || null, contactId]
    )
    res.json({ success: true, assignedUserId: userId || null })
  } catch (error) {
    logger.error('Error asignando contacto:', error)
    res.status(500).json({ success: false, error: 'No se pudo asignar el contacto' })
  }
}
