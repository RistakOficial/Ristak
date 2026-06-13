import { hasUserAccess } from '../utils/userAccess.js'

export function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') {
    return next()
  }

  return res.status(403).json({
    success: false,
    code: 'admin_required',
    error: 'Solo un administrador puede hacer esto.'
  })
}

export function requireModuleAccess(moduleKey) {
  return (req, res, next) => {
    const requiredLevel = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write'

    if (hasUserAccess(req.user, moduleKey, requiredLevel)) {
      return next()
    }

    return res.status(403).json({
      success: false,
      code: requiredLevel === 'write' ? 'write_access_required' : 'read_access_required',
      module: moduleKey,
      error: requiredLevel === 'write'
        ? 'No tienes permiso para cambiar información en esta sección.'
        : 'No tienes acceso a esta sección.'
    })
  }
}
