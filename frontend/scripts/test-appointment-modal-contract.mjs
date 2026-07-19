import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const modalSource = await readFile(
  new URL('../src/components/common/AppointmentModal/AppointmentModal.tsx', import.meta.url),
  'utf8'
)
const appointmentsSource = await readFile(
  new URL('../src/pages/Appointments/Appointments.tsx', import.meta.url),
  'utf8'
)
const desktopChatSource = await readFile(
  new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url),
  'utf8'
)

assert.match(
  modalSource,
  /const shouldInlineGuests = showGuestsSection;/,
  'los invitados deben vivir dentro del formulario compartido, no en el panel lateral'
)

const appointmentContentStart = modalSource.indexOf('const appointmentContent =')
const appointmentContentEnd = modalSource.indexOf('if (isEmbedded)', appointmentContentStart)
assert.ok(appointmentContentStart >= 0 && appointmentContentEnd > appointmentContentStart)
const appointmentContent = modalSource.slice(appointmentContentStart, appointmentContentEnd)

const locationPosition = appointmentContent.indexOf('htmlFor="address"')
const guestsPosition = appointmentContent.indexOf('{renderInlineGuestsSection()}')
const notesPosition = appointmentContent.indexOf('htmlFor="notes"', guestsPosition)
assert.ok(
  locationPosition >= 0 && guestsPosition > locationPosition && notesPosition > guestsPosition,
  'Invitados debe renderizarse después de Ubicación y justo antes de Notas'
)

const assignmentPanelStart = appointmentContent.indexOf('<aside className={styles.assignmentPanel}>')
const assignmentPanelEnd = appointmentContent.indexOf('</aside>', assignmentPanelStart)
const assignmentPanel = appointmentContent.slice(assignmentPanelStart, assignmentPanelEnd)
assert.doesNotMatch(
  assignmentPanel,
  /renderGuestsSection/,
  'el panel lateral no debe volver a apropiarse de Invitados'
)

assert.match(
  modalSource,
  /participants:\s*AppointmentParticipant\[\]/,
  'el modal debe guardar participantes estructurados'
)
assert.doesNotMatch(
  modalSource,
  /guestsNotes/,
  'los invitados no deben pegarse como texto dentro de Notas'
)

for (const [surface, source] of [
  ['Citas', appointmentsSource],
  ['Chat', desktopChatSource]
]) {
  assert.match(source, /AppointmentModal/, `${surface} debe consumir el AppointmentModal compartido`)
  assert.match(source, /enableGuests/, `${surface} debe activar invitados al crear una cita`)
}

console.log('Appointment modal shared contract OK')
