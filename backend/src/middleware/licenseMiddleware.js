import { getLicenseState, hasFeature, isLicenseEnforced } from '../services/licenseService.js'
import { logger } from '../utils/logger.js'

/**
 * Bloquea el acceso si la licencia central no está activa.
 * Usa el token temporal cacheado; solo consulta al servidor central cuando expira.
 */
export async function requireActiveLicense(req, res, next) {
  try {
    if (!isLicenseEnforced()) return next()

    const state = await getLicenseState({ email: req.user?.email || null })

    if (!state.allowed) {
      return res.status(403).json({
        success: false,
        code: 'license_blocked',
        reason: state.reason,
        message: state.message || 'Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar.'
      })
    }

    req.license = state
    next()
  } catch (error) {
    logger.error('Error validando licencia:', error.message)
    return res.status(403).json({
      success: false,
      code: 'license_blocked',
      reason: 'license_check_failed',
      message: 'No se pudo validar tu licencia de Ristak. Intenta de nuevo en unos minutos.'
    })
  }
}

/**
 * Bloquea funciones premium que no estén incluidas en el plan del cliente.
 * Las validaciones se hacen en backend; ocultar botones en frontend no es suficiente.
 */
export function requireFeature(featureKey) {
  return async (req, res, next) => {
    try {
      if (!isLicenseEnforced()) return next()

      if (await hasFeature(featureKey)) return next()

      return res.status(403).json({
        success: false,
        code: 'feature_not_available',
        feature: featureKey,
        message: 'Esta función no está incluida en tu plan actual. Contacta al administrador para activarla.'
      })
    } catch (error) {
      logger.error(`Error validando feature ${featureKey}:`, error.message)
      return res.status(403).json({
        success: false,
        code: 'feature_not_available',
        feature: featureKey,
        message: 'No se pudo validar tu plan. Intenta de nuevo en unos minutos.'
      })
    }
  }
}
