import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { getContactLabels, setContactLabels } from '../src/controllers/settingsController.js'
import {
  CRM_LABELS_CONFIG_KEY,
  getCrmLabels,
  normalizeCrmLabels,
  setCrmLabels
} from '../src/services/crmLabelsService.js'
import { getSystemTagDefinitions } from '../src/services/contactTagsService.js'

let previousAppConfig = null
let previousLegacyRows = []

function mockResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

before(async () => {
  previousAppConfig = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [CRM_LABELS_CONFIG_KEY]
  )
  previousLegacyRows = await db.all('SELECT id, custom_labels FROM highlevel_config ORDER BY id')
  await db.run('DELETE FROM app_config WHERE config_key = ?', [CRM_LABELS_CONFIG_KEY])
})

after(async () => {
  await db.run('DELETE FROM app_config WHERE config_key = ?', [CRM_LABELS_CONFIG_KEY])
  if (previousAppConfig) {
    await db.run(
      `INSERT INTO app_config (config_key, config_value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [CRM_LABELS_CONFIG_KEY, previousAppConfig.config_value]
    )
  }

  const previousIds = new Set(previousLegacyRows.map((row) => Number(row.id)))
  const currentRows = await db.all('SELECT id FROM highlevel_config ORDER BY id')
  for (const row of currentRows) {
    if (!previousIds.has(Number(row.id))) {
      await db.run('DELETE FROM highlevel_config WHERE id = ?', [row.id])
    }
  }
  for (const row of previousLegacyRows) {
    await db.run(
      'UPDATE highlevel_config SET custom_labels = ? WHERE id = ?',
      [row.custom_labels, row.id]
    )
  }
})

test('normaliza nombres y deriva plurales cuando el cliente no los manda', () => {
  assert.deepEqual(normalizeCrmLabels({ customer: '  Paciente ', lead: ' Consulta ' }), {
    customer: 'Paciente',
    customers: 'Pacientes',
    lead: 'Consulta',
    leads: 'Consultas'
  })
})

test('guarda los nombres en app_config y las etiquetas internas leen la misma fuente', async () => {
  const expected = {
    customer: 'Paciente',
    customers: 'Pacientes',
    lead: 'Consulta',
    leads: 'Consultas'
  }

  await setCrmLabels(expected)

  const stored = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [CRM_LABELS_CONFIG_KEY]
  )
  assert.deepEqual(JSON.parse(stored.config_value), expected)
  assert.deepEqual(await getCrmLabels(), expected)

  const systemTags = await getSystemTagDefinitions()
  assert.equal(systemTags.find((tag) => tag.id === 'client')?.name, 'Paciente')
  assert.equal(systemTags.find((tag) => tag.id === 'lead')?.name, 'Consulta')
})

test('los endpoints generales devuelven el valor persistido y no simulan éxito', async () => {
  const saved = mockResponse()
  await setContactLabels({ body: { customer: 'Alumno', lead: 'Prospecto' } }, saved)

  assert.equal(saved.statusCode, 200)
  assert.deepEqual(saved.payload?.data, {
    customer: 'Alumno',
    customers: 'Alumnos',
    lead: 'Prospecto',
    leads: 'Prospectos'
  })

  const loaded = mockResponse()
  await getContactLabels({}, loaded)
  assert.equal(loaded.statusCode, 200)
  assert.deepEqual(loaded.payload?.data, saved.payload?.data)
})

test('migra automáticamente el valor histórico de HighLevel', async () => {
  const legacyLabels = {
    customer: 'Miembro',
    customers: 'Miembros',
    lead: 'Mensaje',
    leads: 'Mensajes'
  }

  await db.run('DELETE FROM app_config WHERE config_key = ?', [CRM_LABELS_CONFIG_KEY])
  const existing = await db.get('SELECT id FROM highlevel_config LIMIT 1')
  if (existing) {
    await db.run(
      'UPDATE highlevel_config SET custom_labels = ?',
      [JSON.stringify(legacyLabels)]
    )
  } else {
    await db.run(
      'INSERT INTO highlevel_config (location_id, api_token, custom_labels) VALUES (?, ?, ?)',
      [`crm-labels-test-${Date.now()}`, null, JSON.stringify(legacyLabels)]
    )
  }

  assert.deepEqual(await getCrmLabels({ migrateLegacy: true }), legacyLabels)
  const migrated = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [CRM_LABELS_CONFIG_KEY]
  )
  assert.deepEqual(JSON.parse(migrated.config_value), legacyLabels)
})
