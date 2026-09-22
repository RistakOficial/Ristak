import { ACCESS_MODULES, normalizeAccessConfig } from '../utils/userAccess.js'
import { getLicenseState, hasModuleFeature } from './licenseService.js'

/** User grants can narrow the account license, never extend it. */
export async function constrainUserAccessToLicense(value, role, suppliedState = null) {
  const state = suppliedState || await getLicenseState()
  if (!state.allowed || state.featuresSourceValid === false) {
    throw Object.assign(new Error('No se pudo validar el plan de esta cuenta. Intenta de nuevo.'), {
      status: 403, code: 'user_access_license_blocked'
    })
  }
  const access = normalizeAccessConfig(value, role)
  for (const moduleKey of ACCESS_MODULES) {
    if (!await hasModuleFeature(moduleKey, { state })) access[moduleKey] = 'none'
  }
  return access
}
