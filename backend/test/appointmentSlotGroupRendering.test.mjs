import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
}

function extractBetween(source, start, end) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `No se encontró el inicio: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `No se encontró el final: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('AppointmentModal no ofrece días cerrados como fechas seleccionables', () => {
  const modal = readRepositoryFile('frontend/src/components/common/AppointmentModal/AppointmentModal.tsx')
  const normalizer = extractBetween(
    modal,
    'export const normalizeAvailableSlotGroups',
    '/**\n * Formatea slot completo con duración'
  )
  const loader = extractBetween(
    modal,
    'const loadFreeSlots = async () => {',
    '\n  const loadUsers = async () => {'
  )
  const defaultSchedule = extractBetween(
    modal,
    "{scheduleMode === 'default' ? (",
    '/* Modo Personalizado: en celular fecha + hora + duración; en web DateTimePicker libre */'
  )
  const saveFlow = extractBetween(
    modal,
    'const handleSave = async () => {',
    '\n  const handleDeleteClick = () => {'
  )

  assert.match(normalizer, /normalizedSlots\.length === 0\) continue/)
  assert.match(normalizer, /slotsByDate\.set\(date, current\)/)
  assert.match(loader, /const availableSlotGroups = normalizeAvailableSlotGroups\(slots\)/)
  assert.match(loader, /setFreeSlots\(availableSlotGroups\)/)
  assert.match(defaultSchedule, /freeSlots\.length === 0/)
  assert.match(defaultSchedule, /No hay horarios disponibles en los próximos 30 días/)
  assert.match(defaultSchedule, /\.\.\.freeSlots\.map\(\(slot\) =>/)
  assert.match(saveFlow, /scheduleMode === 'default' && !selectedSlot/)
  assert.match(saveFlow, /Selecciona uno de los horarios disponibles del calendario/)
})
