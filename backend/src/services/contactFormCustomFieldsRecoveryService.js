import {
  databaseDialect,
  db,
  getAppConfig,
  setAppConfig
} from '../config/database.js'
import { BACKFILL_JOB_PRIORITY } from '../jobs/backfillJobCoordinator.js'
import { scheduleProjectionBackfillJob } from '../jobs/projectionBackfillScheduler.js'
import { parseJsonSafe } from '../utils/contactCustomFields.js'
import { logger } from '../utils/logger.js'
import {
  listContactCustomFieldDefinitions,
  normalizeContactCustomFieldKey,
  prepareContactCustomFieldsForStorage
} from './contactCustomFieldDefinitionsService.js'
import { mutateAndPersistContactCustomFields } from './contactCustomFieldsPersistenceService.js'

const RECOVERY_CONFIG_KEY = 'contact_form_custom_fields_recovery_version'
const RECOVERY_VERSION = '2026-08-04-v1'
const RECOVERY_JOB_KEY = 'contact-form-custom-fields-recovery'
const DEFAULT_BATCH_SIZE = 200

const cleanString = value => String(value || '').trim()

function isEmptyAnswer(value) {
  if (Array.isArray(value)) return value.length === 0
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

function mappedAnswerSections(row = {}) {
  const mapped = parseJsonSafe(row.mapped_fields_json, {})
  if (!mapped || typeof mapped !== 'object' || Array.isArray(mapped)) return []

  return [
    ['custom', mapped.custom],
    ['system', mapped.system]
  ].flatMap(([section, values]) => {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return []
    return Object.entries(values).map(([key, value]) => ({ section, key, value }))
  })
}

function buildRecoveryField({ answer, row, definitionsByKey }) {
  const fieldKey = normalizeContactCustomFieldKey(answer.key, '')
  if (!fieldKey || isEmptyAnswer(answer.value)) return null

  const definition = definitionsByKey.get(fieldKey) || null
  const isSystem = answer.section === 'system'
  return {
    id: definition?.definitionId || definition?.id || fieldKey,
    definitionId: definition?.definitionId || definition?.id || '',
    key: fieldKey,
    fieldKey,
    label: definition?.label || fieldKey,
    name: definition?.name || definition?.label || fieldKey,
    dataType: definition?.dataType || (Array.isArray(answer.value) ? 'multiselect' : 'text'),
    options: definition?.options || [],
    value: answer.value,
    syncTarget: definition?.syncTarget || (isSystem ? 'none' : 'local'),
    sourceType: definition?.sourceType || (isSystem ? 'system' : 'submission_recovery'),
    sourceSiteId: definition?.sourceSiteId || cleanString(row.site_id),
    sourceFormId: definition?.sourceFormId || cleanString(row.form_site_id || row.site_id),
    sourceContext: {
      ...(definition?.sourceContext && typeof definition.sourceContext === 'object'
        ? definition.sourceContext
        : {}),
      recoveredFromSubmission: true
    }
  }
}

function latestRecoveryFieldsForContact(rows = [], definitionsByKey = new Map()) {
  const latestByKey = new Map()

  // La consulta llega newest-first. La primera respuesta no vacía por llave es
  // la última confirmada por esa persona y ninguna submission vieja la pisa.
  for (const row of rows) {
    for (const answer of mappedAnswerSections(row)) {
      const field = buildRecoveryField({ answer, row, definitionsByKey })
      if (!field || latestByKey.has(field.fieldKey)) continue
      latestByKey.set(field.fieldKey, field)
    }
  }

  return [...latestByKey.values()]
}

async function prepareRecoveryFields(recoveryFields, definitionsByKey) {
  const ready = []
  const missingDefinitions = []

  for (const field of recoveryFields) {
    if (definitionsByKey.has(field.fieldKey)) ready.push(field)
    else missingDefinitions.push(field)
  }

  if (missingDefinitions.length === 0) return ready

  const materialized = await prepareContactCustomFieldsForStorage(missingDefinitions, {
    sourceType: 'submission_recovery',
    syncTarget: 'local',
    allowSystemContactCustomFields: true
  })
  for (const field of materialized) {
    const fieldKey = normalizeContactCustomFieldKey(field.fieldKey || field.key, '')
    if (fieldKey) definitionsByKey.set(fieldKey, field)
  }
  return [...ready, ...materialized]
}

export async function runContactFormCustomFieldsRecovery({
  batchSize = DEFAULT_BATCH_SIZE,
  contactIds = null,
  force = false,
  markComplete = true
} = {}) {
  const safeBatchSize = Math.max(1, Math.min(1000, Number(batchSize) || DEFAULT_BATCH_SIZE))
  const requestedContactIds = Array.isArray(contactIds)
    ? [...new Set(contactIds.map(cleanString).filter(Boolean))].slice(0, 1000)
    : null
  const appliedVersion = await getAppConfig(RECOVERY_CONFIG_KEY).catch(() => '')
  if (!force && appliedVersion === RECOVERY_VERSION) {
    return { skipped: true, version: RECOVERY_VERSION }
  }

  const definitions = await listContactCustomFieldDefinitions()
  const definitionsByKey = new Map(
    definitions
      .map(definition => [normalizeContactCustomFieldKey(definition.fieldKey || definition.key, ''), definition])
      .filter(([key]) => Boolean(key))
  )
  let cursor = ''
  let contactsScanned = 0
  let contactsChanged = 0
  let fieldsRecovered = 0
  let scopedBatchProcessed = false

  while (true) {
    const contacts = requestedContactIds
      ? (scopedBatchProcessed
          ? []
          : requestedContactIds.map(contactId => ({ contact_id: contactId })))
      : await db.all(`
        SELECT DISTINCT contact_id
        FROM public_site_submissions
        WHERE contact_id IS NOT NULL
          AND contact_id > ?
          AND mapped_fields_json IS NOT NULL
        ORDER BY contact_id ASC
        LIMIT ?
      `, [cursor, safeBatchSize])
    if (!contacts.length) break
    scopedBatchProcessed = Boolean(requestedContactIds)

    const contactIds = contacts.map(row => cleanString(row.contact_id)).filter(Boolean)
    const placeholders = contactIds.map(() => '?').join(', ')
    const submissions = await db.all(`
      SELECT id, contact_id, site_id, form_site_id, mapped_fields_json, created_at
      FROM public_site_submissions
      WHERE contact_id IN (${placeholders})
        AND mapped_fields_json IS NOT NULL
      ORDER BY contact_id ASC, created_at DESC, id DESC
    `, contactIds)
    const rowsByContact = new Map()
    for (const row of submissions) {
      const list = rowsByContact.get(row.contact_id) || []
      list.push(row)
      rowsByContact.set(row.contact_id, list)
    }

    for (const contactId of contactIds) {
      contactsScanned += 1
      const recoveryFields = latestRecoveryFieldsForContact(
        rowsByContact.get(contactId) || [],
        definitionsByKey
      )
      if (!recoveryFields.length) continue

      const prepared = await prepareRecoveryFields(recoveryFields, definitionsByKey)
      const result = await mutateAndPersistContactCustomFields({
        contactId,
        updates: prepared,
        onlyIfMissing: true,
        normalizeExisting: true,
        dialect: databaseDialect
      })
      if (result?.changed) contactsChanged += 1
      fieldsRecovered += Number(result?.appliedUpdates || 0)
    }

    cursor = contactIds.at(-1) || cursor
    if (requestedContactIds || contacts.length < safeBatchSize) break
  }

  if (markComplete) await setAppConfig(RECOVERY_CONFIG_KEY, RECOVERY_VERSION)
  if (contactsChanged > 0) {
    logger.success(
      `[Formularios] Recuperación histórica: ${fieldsRecovered} campo(s) restaurado(s) ` +
      `en ${contactsChanged} contacto(s) de ${contactsScanned} revisado(s).`
    )
  } else {
    logger.info(`[Formularios] Recuperación histórica revisó ${contactsScanned} contacto(s); no faltaban respuestas.`)
  }

  return {
    skipped: false,
    version: RECOVERY_VERSION,
    contactsScanned,
    contactsChanged,
    fieldsRecovered
  }
}

export function scheduleContactFormCustomFieldsRecovery() {
  return scheduleProjectionBackfillJob({
    key: RECOVERY_JOB_KEY,
    priority: BACKFILL_JOB_PRIORITY.HIGH,
    run: runContactFormCustomFieldsRecovery,
    onError: error => logger.warn(`[Formularios] No se pudo recuperar campos históricos: ${error.message}`)
  })
}

export const contactFormCustomFieldsRecoveryInternals = Object.freeze({
  RECOVERY_CONFIG_KEY,
  RECOVERY_VERSION,
  latestRecoveryFieldsForContact,
  mappedAnswerSections,
  prepareRecoveryFields
})
