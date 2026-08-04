export const DEFAULT_APPOINTMENT_CONFIRMATION_REPLY_TEXT =
  '¡Perfecto! Te esperamos en tu cita. Nos vemos pronto.'

interface ConfirmationReplyToggleInput {
  enabled: boolean
  isNewReminder: boolean
  wasInitialized: boolean
  confirmationReplyText: string
}

interface ConfirmationReplyToggleState {
  confirmationReplyText: string
  wasInitialized: boolean
}

/**
 * Precarga la cortesía una sola vez por cada borrador nuevo.
 * Después de la primera activación, el texto queda completamente bajo control
 * del usuario, incluso si lo borra o apaga y vuelve a encender la confirmación.
 */
export const resolveConfirmationReplyToggle = ({
  enabled,
  isNewReminder,
  wasInitialized,
  confirmationReplyText
}: ConfirmationReplyToggleInput): ConfirmationReplyToggleState => {
  const shouldInitialize = enabled && isNewReminder && !wasInitialized

  return {
    confirmationReplyText: shouldInitialize && !confirmationReplyText
      ? DEFAULT_APPOINTMENT_CONFIRMATION_REPLY_TEXT
      : confirmationReplyText,
    wasInitialized: wasInitialized || shouldInitialize
  }
}
