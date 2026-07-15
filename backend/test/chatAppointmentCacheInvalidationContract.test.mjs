import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')

test('confirmar o cancelar una cita publica invalidacion despues de escribir la base', async () => {
  const source = await readFile(
    join(repoRoot, 'backend/src/services/appointmentConfirmationService.js'),
    'utf8'
  )
  const affirmativeStart = source.indexOf('export async function maybeConfirmAppointmentFromReply')
  const affirmative = source.slice(affirmativeStart)

  assert.match(source, /publishChatDataChangedEvent/)
  assert.match(source, /domains: \['appointments'\]/)
  assert.match(affirmative, /UPDATE appointments[\s\S]*?publishAppointmentChanged\(id, pending\.appointment_id\)[\s\S]*?resyncAppointmentToGoogle/)
})
