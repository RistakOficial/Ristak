import { addContactBlock, listContactBlocks, removeContactBlock } from '../services/contactBlockService.js'
import { recordAudit } from '../utils/auditLog.js'

// Also enforce the administrative gate for internal/MCP controller invocation.
function requireAdministrator(req, res) {
  if (req.user?.role === 'admin') return true
  res.status(403).json({ success: false, code: 'admin_required', error: 'Solo un administrador puede administrar los bloqueos.' })
  return false
}

function sendError(res, error) {
  const status = Number(error.status || 500)
  return res.status(status).json({ success: false, error: status === 500 ? 'No se pudo administrar el bloqueo.' : error.message, ...(error.code ? { code: error.code } : {}) })
}

export async function getContactBlocks(req, res) {
  if (!requireAdministrator(req, res)) return
  try {
    res.json({ success: true, data: await listContactBlocks(req.query) })
  } catch (error) { sendError(res, error) }
}

export async function createContactBlock(req, res) {
  if (!requireAdministrator(req, res)) return
  try {
    const rule = await addContactBlock({ ...req.body, actorId: req.user.userId || req.user.id })
    await recordAudit({ entityType: 'contact_block', entityId: rule.id, action: 'block', actor: req.user, details: { identityType: rule.identity_type } })
    res.status(201).json({ success: true, data: rule })
  } catch (error) { sendError(res, error) }
}

export async function deleteContactBlock(req, res) {
  if (!requireAdministrator(req, res)) return
  try {
    const result = await removeContactBlock(req.params.id)
    if (!result.changes) return res.status(404).json({ success: false, error: 'Bloqueo no encontrado.' })
    await recordAudit({ entityType: 'contact_block', entityId: req.params.id, action: 'unblock', actor: req.user })
    res.json({ success: true })
  } catch (error) { sendError(res, error) }
}
