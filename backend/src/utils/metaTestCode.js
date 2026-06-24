import { getAppConfig, setAppConfig } from '../config/database.js'

// El código de Test Events de Meta es global (por pixel) y se pone desde Ajustes
// → Meta. Para que el usuario no lo olvide encendido al lanzar publicidad (lo que
// mandaría conversiones reales al panel de prueba en vez de registrarlas), expira
// solo 30 min después de haberse puesto.
export const META_TEST_CODE_KEY = 'meta_test_event_code'
export const META_TEST_CODE_SET_AT_KEY = 'meta_test_event_code_set_at'
export const META_TEST_CODE_TTL_MS = 30 * 60 * 1000

const trim = (value) => String(value ?? '').trim()

/**
 * Devuelve el código de Test Events ACTIVO, o '' si no hay / expiró.
 * - El código guardado solo cuenta durante META_TEST_CODE_TTL_MS desde que se puso.
 * - Si expiró, se limpia de la config (auto-apagado).
 * - process.env.META_TEST_EVENT_CODE es un override permanente para dev/ops.
 */
export async function getActiveMetaTestEventCode() {
  const stored = trim(await getAppConfig(META_TEST_CODE_KEY).catch(() => ''))
  if (stored) {
    const setAt = Number(await getAppConfig(META_TEST_CODE_SET_AT_KEY).catch(() => 0)) || 0
    // Sin timestamp (código legacy) lo tratamos como activo; con timestamp, expira a los 30 min.
    if (!setAt || Date.now() - setAt <= META_TEST_CODE_TTL_MS) {
      return stored
    }
    await setAppConfig(META_TEST_CODE_KEY, '').catch(() => {})
    await setAppConfig(META_TEST_CODE_SET_AT_KEY, '').catch(() => {})
  }
  return trim(process.env.META_TEST_EVENT_CODE)
}

/** true si hay un código de Test Events activo (modo test). */
export async function isMetaTestModeActive() {
  return Boolean(await getActiveMetaTestEventCode())
}

/** Milisegundos que le quedan al código de test activo (0 si no hay / expiró / es override de env). */
export async function getMetaTestEventCodeRemainingMs() {
  const stored = trim(await getAppConfig(META_TEST_CODE_KEY).catch(() => ''))
  if (!stored) return 0
  const setAt = Number(await getAppConfig(META_TEST_CODE_SET_AT_KEY).catch(() => 0)) || 0
  if (!setAt) return 0
  return Math.max(0, META_TEST_CODE_TTL_MS - (Date.now() - setAt))
}
