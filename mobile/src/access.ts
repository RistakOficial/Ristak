import type { NativeAccessLevel, PhoneSection, RistakUser } from './types';

// Native port of frontend/src/utils/accessControl.ts, reduced to the module keys
// reachable from the mobile shell. The backend already returns a fully
// normalized `accessConfig` (all keys present, admin => everything 'write',
// employee => defaults + overrides, chat inheriting contacts) plus the license
// feature map, so this helper only has to read those values, not re-normalize.

type NativeModuleKey =
  | 'chat'
  | 'appointments'
  | 'payments'
  | 'analytics'
  | 'contacts'
  | 'ai_agent'
  | 'settings_mobile'
  | 'dashboard';

type LicenseFeatureRule = { primary: string; legacy?: readonly string[] };

const LICENSE_FEATURES_BY_MODULE: Record<NativeModuleKey, LicenseFeatureRule> = {
  chat: { primary: 'chat', legacy: ['whatsapp'] },
  appointments: { primary: 'appointments', legacy: ['google_calendar'] },
  payments: { primary: 'payments' },
  analytics: { primary: 'analytics' },
  contacts: { primary: 'contacts' },
  ai_agent: { primary: 'ai_agent', legacy: ['app_assistant_ai', 'conversational_ai', 'ai'] },
  settings_mobile: { primary: 'mobile_app', legacy: ['settings_mobile'] },
  dashboard: { primary: 'dashboard' },
};

// Same section -> module mapping the web app uses to gate the /movil routes.
export const PHONE_SECTION_MODULE: Record<PhoneSection, NativeModuleKey> = {
  chat: 'chat',
  calendar: 'appointments',
  payments: 'payments',
  // La pantalla movil de Analiticas es el resumen operativo del negocio y
  // consume /api/dashboard/*. El permiso `analytics` corresponde al modulo
  // web de sesiones/visitantes; `web_analytics` sigue controlando esas series
  // dentro de esta pantalla.
  analytics: 'dashboard',
  settings: 'settings_mobile',
};

function isAdmin(user?: RistakUser | null) {
  return String(user?.role || '') === 'admin';
}

export function hasLicenseFeature(
  user: RistakUser | null | undefined,
  featureKeys: readonly string[],
) {
  if (!user?.licenseEnforced) return true;
  if (user.licenseFeaturesSourceValid === false) return false;
  const features = user.licenseFeatures || {};
  return featureKeys.some((featureKey) => features[featureKey] === true);
}

export function hasProfessionalPlan(plan?: string | null) {
  const normalized = String(plan || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (!normalized) return false;
  if (['pro', 'professional', 'profesional', 'premium'].includes(normalized)) return true;

  return normalized.endsWith('_pro') ||
    normalized.endsWith('_professional') ||
    normalized.endsWith('_profesional') ||
    normalized.endsWith('_premium');
}

export function hasProfessionalFeatureAccess(
  user: RistakUser | null | undefined,
  featureKeys: readonly string[],
) {
  if (!user?.licenseEnforced) return true;
  if (user.licenseFeaturesSourceValid === false) return false;

  return hasProfessionalPlan(user.licensePlan) && hasLicenseFeature(user, featureKeys);
}

export function hasWebAnalyticsAccess(user: RistakUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['web_analytics']);
}

export function hasPaymentGatewaysAccess(user: RistakUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['payment_gateways']);
}

export function hasPaymentLinksAccess(user: RistakUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['payment_links']);
}

function hasLicenseFeatureAccess(user: RistakUser | null | undefined, moduleKey: NativeModuleKey) {
  if (!user?.licenseEnforced) return true;
  if (user.licenseFeaturesSourceValid === false) return false;

  const rule = LICENSE_FEATURES_BY_MODULE[moduleKey];
  if (!rule) return true;

  const features = user.licenseFeatures || {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(features, key);

  if (has(moduleKey)) return features[moduleKey] === true;
  if (has(rule.primary)) return features[rule.primary] === true;
  if (rule.legacy?.length) return rule.legacy.some((key) => features[key] === true);

  // El backend entrega un mapa normalizado. Si una respuesta legacy/incompleta
  // no trae la llave, no podemos asumir que el plan la incluye.
  return false;
}

export function hasModuleAccess(
  user: RistakUser | null | undefined,
  moduleKey: NativeModuleKey,
  requiredLevel: 'read' | 'write' = 'read',
) {
  if (!hasLicenseFeatureAccess(user, moduleKey)) return false;
  if (isAdmin(user)) return true;

  const config = (user?.accessConfig || {}) as Record<string, NativeAccessLevel>;
  let level = config[moduleKey];
  // Backwards compat: the Chat module used to inherit the Contacts permission
  // when a stored config predates the dedicated `chat` key.
  if (moduleKey === 'chat' && level === undefined) level = config.contacts;

  const resolved = level || 'none';
  return requiredLevel === 'write' ? resolved === 'write' : resolved === 'read' || resolved === 'write';
}

export function hasPhoneSectionAccess(user: RistakUser | null | undefined, section: PhoneSection) {
  // Unknown permissions must never unlock the native shell. Offline startup
  // hydrates the last user verified for this exact server/session namespace;
  // without that evidence we fail closed until verification succeeds.
  if (!user) return false;
  return hasModuleAccess(user, PHONE_SECTION_MODULE[section], 'read');
}
