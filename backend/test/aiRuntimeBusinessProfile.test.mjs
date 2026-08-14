import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  buildBusinessProfileExtractionContext,
  getAIRuntimeStatus,
  saveAIRuntimeBusinessProfile,
  syncBusinessProfileFromContext
} from '../src/services/aiRuntimeService.js'

async function getStoredBusinessProfileRow() {
  return db.get('SELECT * FROM ai_business_profile WHERE id = 1').catch(() => null)
}

async function restoreBusinessProfileRow(row) {
  await db.run('DELETE FROM ai_business_profile WHERE id = 1').catch(() => undefined)
  if (!row) return

  const columns = Object.keys(row)
  const placeholders = columns.map(() => '?').join(', ')
  await db.run(
    `INSERT INTO ai_business_profile (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => row[column])
  )
}

async function getStoredAIRuntimeConfigRow() {
  return db.get('SELECT * FROM ai_agent_config WHERE id = 1').catch(() => null)
}

async function restoreAIRuntimeConfigRow(row) {
  await db.run('DELETE FROM ai_agent_config WHERE id = 1').catch(() => undefined)
  if (!row) return

  const columns = Object.keys(row)
  const placeholders = columns.map(() => '?').join(', ')
  await db.run(
    `INSERT INTO ai_agent_config (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => row[column])
  )
}

test('compacta descripciones enormes sin perder inicio, medio y final', () => {
  const longContext = [
    'INICIO Clinica Aurora vende programas de recuperacion fisica premium para pacientes postoperatorios.',
    'relleno operativo '.repeat(350),
    'MEDIO El ticket principal es de 15000 MXN, incluye valoracion, sesiones semanales, seguimiento por WhatsApp y facturacion.',
    'mas detalles comerciales '.repeat(350),
    'FINAL Atiende de lunes a sabado en Ciudad Juarez y evita prometer resultados garantizados.'
  ].join(' ')

  const compacted = buildBusinessProfileExtractionContext(longContext, 3000)

  assert.ok(compacted.length <= 3000)
  assert.match(compacted, /extracto representativo/i)
  assert.match(compacted, /INICIO Clinica Aurora/)
  assert.match(compacted, /MEDIO El ticket principal/)
  assert.match(compacted, /FINAL Atiende/)
})

test('prepara perfil usable cuando la extraccion IA aborta con descripcion larga', async () => {
  const previousBusinessProfile = await getStoredBusinessProfileRow()
  const longContext = [
    'Clinica Rescate vende rehabilitacion deportiva, fisioterapia postoperatoria y seguimiento para atletas amateurs.',
    'El cliente ideal llega con dolor, miedo a recaer, poca claridad de tiempos y necesita que le expliquen el plan sin presion.',
    'detalle clinico '.repeat(1200),
    'Los precios van desde 1200 MXN por valoracion y paquetes mensuales desde 9000 MXN.',
    'detalle operativo '.repeat(1200),
    'La clinica atiende en Ciudad Juarez, factura, acepta tarjeta y transferencia, y no promete curas garantizadas.'
  ].join(' ')

  try {
    const result = await syncBusinessProfileFromContext({
      businessContext: longContext,
      model: 'gpt-5.4-mini',
      apiKey: 'sk-test-long-description',
      extractor: async ({ businessContext }) => {
        assert.ok(businessContext.length <= 16_000)
        const error = new Error('This operation was aborted')
        error.name = 'AbortError'
        throw error
      }
    })

    assert.equal(result.configured, true)
    assert.equal(result.extractionStatus, 'ready')
    assert.equal(result.extractionError, null)
    assert.match(result.summary, /Clinica Rescate/)
    assert.ok(result.promptParameters.INFO_GENERAL_DEL_NEGOCIO)
  } finally {
    await restoreBusinessProfileRow(previousBusinessProfile)
  }
})

test('guarda y elimina la descripcion global que consumen los agentes conversacionales', async () => {
  const previousConfig = await getStoredAIRuntimeConfigRow()
  const previousBusinessProfile = await getStoredBusinessProfileRow()
  const businessContext = [
    'Clínica Horizonte ofrece fisioterapia y rehabilitación deportiva en Ciudad Juárez.',
    'Atiende de lunes a sábado, acepta tarjeta y transferencia, y nunca promete resultados garantizados.'
  ].join(' ')

  try {
    await db.run('DELETE FROM ai_agent_config WHERE id = 1')
    await db.run('DELETE FROM ai_business_profile WHERE id = 1')

    const saved = await saveAIRuntimeBusinessProfile({
      userId: 1,
      businessContext
    })

    assert.equal(saved.businessContext, businessContext)
    assert.equal(saved.businessProfile.configured, true)
    assert.equal(saved.businessProfile.sourceContext, businessContext)
    assert.match(saved.businessProfile.summary, /Clínica Horizonte/)

    const reloaded = await getAIRuntimeStatus({ userId: 1 })
    assert.equal(reloaded.businessContext, businessContext)
    assert.equal(reloaded.businessProfile.configured, true)

    const cleared = await saveAIRuntimeBusinessProfile({
      userId: 1,
      businessContext: ''
    })

    assert.equal(cleared.businessContext, '')
    assert.equal(cleared.businessProfile.configured, false)
  } finally {
    await restoreAIRuntimeConfigRow(previousConfig)
    await restoreBusinessProfileRow(previousBusinessProfile)
  }
})
