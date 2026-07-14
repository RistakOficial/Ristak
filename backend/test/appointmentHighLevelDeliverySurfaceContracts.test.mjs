import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (relativePath) => readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8')

test('las superficies de chat mandan un calendario al endpoint canónico de citas', async () => {
  const [appointmentModal, desktopChat, nativeMobile] = await Promise.all([
    read('frontend/src/components/common/AppointmentModal/AppointmentModal.tsx'),
    read('frontend/src/pages/DesktopChat/DesktopChat.tsx'),
    read('mobile/src/App.tsx')
  ])

  assert.match(
    appointmentModal,
    /const payload: CreateAppointmentPayload = \{\s*calendarId: calendar\.id,[\s\S]*?contactId: formData\.contactId/
  )
  assert.match(
    desktopChat,
    /calendarsService\.createAppointment\(eventIdOrPayload, accessToken \|\| undefined\)/
  )
  assert.match(
    nativeMobile,
    /const createAppointmentForContact = async \(\) => \{[\s\S]*?api\.getConfig\(\['default_calendar_id'\]\)[\s\S]*?calendarId: appointmentCalendarId,[\s\S]*?api\.createAppointment\(payload, intent\.clientRequestId\)/
  )
})

test('el backend conserva cita local y exige calendario para poder entregar a integraciones', async () => {
  const controller = await read('backend/src/controllers/calendarsController.js')

  assert.match(controller, /code: 'appointment_calendar_required'/)
  assert.match(controller, /createLocalAppointment\([\s\S]*?if \(isHighLevelConfigured\(context\)\)/)
  assert.match(controller, /prepareHighLevelAppointmentMirrorIntent\([\s\S]*?calendarService\.createAppointment\(/)
  assert.match(controller, /Cita local confirmada; espejo GHL pendiente\/error/)
})
