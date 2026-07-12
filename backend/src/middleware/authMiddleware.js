import { verifyToken } from '../utils/auth.js'
import { db } from '../config/database.js'
import { getLicenseState, isLicenseEnforced } from '../services/licenseService.js'

export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Token no proporcionado'
      })
    }

    const payload = verifyToken(authHeader.substring(7))

    if (!payload) {
      return res.status(401).json({
        success: false,
        error: 'Token inválido o expirado'
      })
    }

    const user = await db.get(
      'SELECT id, username, email, role, access_config, token_version FROM users WHERE id = ? AND is_active = 1',
      [payload.userId]
    )

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Usuario no encontrado o inactivo'
      })
    }

    // (AUTH-003) Las sesiones normales se revocan al cambiar token_version. La
    // sesión global de soporte no depende de la contraseña del cliente y se
    // conserva hasta logout, borrado local, usuario inactivo o licencia bloqueada.
    if (payload.supportAccess !== true && (payload.tokenVersion ?? 0) !== (user.token_version ?? 0)) {
      return res.status(401).json({
        success: false,
        code: 'token_revoked',
        error: 'Tu sesión ya no es válida (la contraseña cambió). Inicia sesión de nuevo.'
      })
    }

    req.user = {
      ...payload,
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      access_config: user.access_config
    }

    // Identidad local válida no basta: la licencia central debe estar activa.
    if (isLicenseEnforced()) {
      const license = await getLicenseState({ email: user.email || user.username })

      if (!license.allowed) {
        return res.status(403).json({
          success: false,
          code: 'license_blocked',
          reason: license.reason,
          message: license.message || 'Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar.'
        })
      }

      req.license = license
    }

    next()
  } catch (error) {
    next(error)
  }
}
