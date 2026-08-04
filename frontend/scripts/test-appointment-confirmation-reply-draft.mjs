import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_APPOINTMENT_CONFIRMATION_REPLY_TEXT,
  resolveConfirmationReplyToggle
} from '../src/utils/appointmentConfirmationReply.ts'

test('la primera activación de confirmación escribe una respuesta real en un borrador nuevo', () => {
  const result = resolveConfirmationReplyToggle({
    enabled: true,
    isNewReminder: true,
    wasInitialized: false,
    confirmationReplyText: ''
  })

  assert.equal(
    result.confirmationReplyText,
    '¡Perfecto! Te esperamos en tu cita. Nos vemos pronto.'
  )
  assert.equal(result.confirmationReplyText, DEFAULT_APPOINTMENT_CONFIRMATION_REPLY_TEXT)
  assert.equal(result.wasInitialized, true)
})

test('borrar el texto y reactivar el switch en el mismo borrador conserva el campo vacío', () => {
  const disabledAfterClearing = resolveConfirmationReplyToggle({
    enabled: false,
    isNewReminder: true,
    wasInitialized: true,
    confirmationReplyText: ''
  })
  const enabledAgain = resolveConfirmationReplyToggle({
    enabled: true,
    isNewReminder: true,
    wasInitialized: disabledAfterClearing.wasInitialized,
    confirmationReplyText: disabledAfterClearing.confirmationReplyText
  })

  assert.equal(enabledAgain.confirmationReplyText, '')
  assert.equal(enabledAgain.wasInitialized, true)
})

test('un intento nuevo vuelve a precargar el texto y una regla existente nunca se rellena', () => {
  const reopenedDraft = resolveConfirmationReplyToggle({
    enabled: true,
    isNewReminder: true,
    wasInitialized: false,
    confirmationReplyText: ''
  })
  const existingReminder = resolveConfirmationReplyToggle({
    enabled: true,
    isNewReminder: false,
    wasInitialized: false,
    confirmationReplyText: ''
  })

  assert.equal(reopenedDraft.confirmationReplyText, DEFAULT_APPOINTMENT_CONFIRMATION_REPLY_TEXT)
  assert.equal(existingReminder.confirmationReplyText, '')
})

test('la primera activación respeta cualquier texto que ya tuviera el borrador', () => {
  const result = resolveConfirmationReplyToggle({
    enabled: true,
    isNewReminder: true,
    wasInitialized: false,
    confirmationReplyText: 'Gracias por confirmar.'
  })

  assert.equal(result.confirmationReplyText, 'Gracias por confirmar.')
  assert.equal(result.wasInitialized, true)
})
