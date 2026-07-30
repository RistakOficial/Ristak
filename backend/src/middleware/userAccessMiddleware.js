import { hasUserAccess } from '../utils/userAccess.js'
import { getModuleFeatureKeys, hasModuleFeature, isLicenseEnforced } from '../services/licenseService.js'
import { logger } from '../utils/logger.js'

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
  return async (req, res, next) => {
    const requiredLevel = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write'

    try {
      // Contrato de seguridad: requireModuleAccess siempre debe pasar por hasModuleFeature(moduleKey).
      // El segundo argumento evita mezclar el cache de licencia entre usuarios concurrentes.
      if (isLicenseEnforced() && !(await hasModuleFeature(moduleKey, {
        state: req.license || null,
        email: req.user?.email || req.user?.username || null
      }))) {
        return res.status(403).json({
          success: false,
          code: 'feature_not_available',
          feature: getModuleFeatureKeys(moduleKey)[0] || moduleKey,
          module: moduleKey,
          message: 'Esta sección no está incluida en tu plan actual. Contacta al administrador para activarla.'
        })
      }
    } catch (error) {
      logger.error(`Error validando feature del módulo ${moduleKey}:`, error.message)
      return res.status(403).json({
        success: false,
        code: 'feature_not_available',
        feature: getModuleFeatureKeys(moduleKey)[0] || moduleKey,
        module: moduleKey,
        message: 'No se pudo validar tu plan. Intenta de nuevo en unos minutos.'
      })
    }

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

export function requireAnyModuleAccess(moduleKeys = []) {
  const normalizedModuleKeys = [...new Set(moduleKeys.map((key) => String(key || '').trim()).filter(Boolean))]

  return async (req, res, next) => {
    const requiredLevel = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write'
    let hasLicensedModule = !isLicenseEnforced()

    for (const moduleKey of normalizedModuleKeys) {
      try {
        const licensed = !isLicenseEnforced() || await hasModuleFeature(moduleKey, {
          state: req.license || null,
          email: req.user?.email || req.user?.username || null
        })
        if (!licensed) continue
        hasLicensedModule = true

        if (hasUserAccess(req.user, moduleKey, requiredLevel)) {
          return next()
        }
      } catch (error) {
        logger.error(`Error validando feature del módulo ${moduleKey}:`, error.message)
      }
    }

    if (!hasLicensedModule) {
      return res.status(403).json({
        success: false,
        code: 'feature_not_available',
        modules: normalizedModuleKeys,
        message: 'Esta función no está incluida en tu plan actual.'
      })
    }

    return res.status(403).json({
      success: false,
      code: requiredLevel === 'write' ? 'write_access_required' : 'read_access_required',
      modules: normalizedModuleKeys,
      error: requiredLevel === 'write'
        ? 'No tienes permiso para usar esta función.'
        : 'No tienes acceso a esta función.'
    })
  }
}
