import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('AppointmentModal convierte slotDuration con su unidad antes de mostrar o calcular el fin', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, 'frontend/src/components/common/AppointmentModal/AppointmentModal.tsx'),
    'utf8'
  )

  assert.match(source, /import \{ calendarDurationToMinutes \} from '\.\.\/WeeklyAvailabilityEditor';/)
  assert.match(
    source,
    /const configuredDurationMinutes = calendarDurationToMinutes\(\s*calendar\?\.slotDuration \?\? 60,\s*calendar\?\.slotDurationUnit \?\? 'mins'\s*\);/
  )
  assert.match(source, /formatSlotWithDuration\(timeSlot, configuredDurationMinutes, accountTimezone\)/)
  assert.ok(
    (source.match(/configuredDurationMinutes \* 60 \* 1000/g) || []).length >= 3,
    'todos los cálculos de fin deben usar la duración ya convertida a minutos'
  )
  assert.doesNotMatch(source, /calendar\?\.slotDuration \|\| 60/)
})
