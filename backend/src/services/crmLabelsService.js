import { db, setAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'

export const CRM_LABELS_CONFIG_KEY = 'crm_labels'

export const DEFAULT_CRM_LABELS = Object.freeze({
  customer: 'Cliente',
  customers: 'Clientes',
  lead: 'Interesado',
  leads: 'Interesados'
})

const MAX_LABEL_LENGTH = 80

function cleanLabel(value, fallback) {
  const cleaned = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LENGTH)
  return cleaned || fallback
}

function pluralizeLabel(value, fallback) {
  const singular = cleanLabel(value, fallback)
  if (/z$/i.test(singular)) return `${singular.slice(0, -1)}ces`
  if (/[sS]$/.test(singular)) return singular
  return `${singular}s`
}

function parseLabels(value) {
  if (!value) return null

  try {
    const parsed = typeof value === 'object' ? value : JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null
  } catch {
    return null
  }
}

export function normalizeCrmLabels(value = {}) {
  const parsed = parseLabels(value) || {}
  const customer = cleanLabel(parsed.customer, DEFAULT_CRM_LABELS.customer)
  const lead = cleanLabel(parsed.lead, DEFAULT_CRM_LABELS.lead)

  return {
    customer,
    customers: cleanLabel(
      parsed.customers,
      pluralizeLabel(customer, DEFAULT_CRM_LABELS.customers)
    ),
    lead,
    leads: cleanLabel(
      parsed.leads,
      pluralizeLabel(lead, DEFAULT_CRM_LABELS.leads)
    )
  }
}

async function readLegacyHighLevelLabels({ signal } = {}) {
  const options = signal ? { signal } : undefined
  const row = await db.get(
    'SELECT custom_labels FROM highlevel_config WHERE custom_labels IS NOT NULL LIMIT 1',
    [],
    options
  ).catch((error) => {
    logger.warn(`No se pudieron leer los nombres legacy de contactos: ${error.message}`)
    return null
  })
  return parseLabels(row?.custom_labels)
}

async function readStoredCrmLabels({ signal } = {}) {
  const options = signal ? { signal } : undefined
  const row = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [CRM_LABELS_CONFIG_KEY],
    options
  )
  return parseLabels(row?.config_value)
}

/**
 * Lee los nombres de CRM desde la configuración general de la cuenta.
 * Puede migrar el valor histórico de HighLevel cuando una lectura explícita de
 * Configuración lo solicita. Los consumidores pasivos se mantienen read-only.
 */
export async function getCrmLabels({ signal, migrateLegacy = false } = {}) {
  const stored = await readStoredCrmLabels({ signal })
  if (stored) return normalizeCrmLabels(stored)

  const legacy = await readLegacyHighLevelLabels({ signal })
  if (!legacy) return { ...DEFAULT_CRM_LABELS }

  const labels = normalizeCrmLabels(legacy)
  if (migrateLegacy) {
    await setAppConfig(CRM_LABELS_CONFIG_KEY, labels).catch((error) => {
      logger.warn(`No se pudieron migrar los nombres de contactos a app_config: ${error.message}`)
    })
  }
  return labels
}

/** Guarda la fuente de verdad general y sincroniza la fila legacy si existe. */
export async function setCrmLabels(value) {
  const labels = normalizeCrmLabels(value)
  await setAppConfig(CRM_LABELS_CONFIG_KEY, labels)

  await db.run(
    'UPDATE highlevel_config SET custom_labels = ?',
    [JSON.stringify(labels)]
  ).catch((error) => {
    logger.warn(`No se pudo sincronizar la copia legacy de nombres de contactos: ${error.message}`)
  })

  return labels
}
