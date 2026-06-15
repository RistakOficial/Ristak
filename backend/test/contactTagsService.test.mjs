import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import {
  createContactTag,
  listContactTags,
  resolveTagIds
} from '../src/services/contactTagsService.js'

const cleanupTag = async (id) => {
  await db.run('DELETE FROM contact_tags WHERE id = ?', [id]).catch(() => undefined)
}

test('el catálogo normal no expone estados internos del contacto', async () => {
  await cleanupTag('cliente')
  await cleanupTag('prospecto')
  await cleanupTag('cita_agendada')

  await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', ['cliente', 'Cliente'])
  await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', ['prospecto', 'Prospecto'])
  await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', ['cita_agendada', 'Cita agendada'])

  const editableTags = await listContactTags()
  assert.equal(editableTags.some((tag) => ['cliente', 'prospecto', 'cita_agendada'].includes(tag.id)), false)
  assert.equal(editableTags.some((tag) => tag.isSystem), false)

  const withSystem = await listContactTags({ includeSystem: true })
  assert.ok(withSystem.some((tag) => tag.id === 'client' && tag.isSystem))
  assert.ok(withSystem.some((tag) => tag.id === 'booked' && tag.isSystem))
  assert.ok(withSystem.some((tag) => tag.id === 'lead' && tag.isSystem))

  await cleanupTag('cliente')
  await cleanupTag('prospecto')
  await cleanupTag('cita_agendada')
})

test('no permite crear etiquetas con nombres reservados del sistema', async () => {
  await assert.rejects(() => createContactTag('Cliente'), /reservado/)
  await assert.rejects(() => createContactTag('Prospecto'), /reservado/)
  await assert.rejects(() => createContactTag('Cita agendada'), /reservado/)
})

test('resolveTagIds ignora estados internos y sólo guarda etiquetas editables', async () => {
  const name = `Etiqueta prueba ${randomUUID().slice(0, 8)}`
  const resolved = await resolveTagIds(['Cliente', 'cliente', 'Prospecto', 'cita_agendada', name], { createMissing: true })

  assert.equal(resolved.length, 1)
  const [createdId] = resolved
  assert.ok(createdId)
  assert.notEqual(createdId, 'cliente')
  assert.notEqual(createdId, 'prospecto')
  assert.notEqual(createdId, 'cita_agendada')

  await cleanupTag(createdId)
})
