export const DEFAULT_APPOINTMENT_NOTICE_HEADER_TEXT =
  '🗓️ Cita programada para el {{1}}'

export const DEFAULT_APPOINTMENT_NOTICE_BODY_TEXT =
  '🔔 *Importante:* Te llegarán varios recordatorios para *NO* olvidar que tienes una cita programada.\n\n' +
  'Te pedimos de la manera más atenta que *respondas* los mensajes cuando se te solicite, para mantener una comunicación clara y evitar cualquier confusión con las citas.\n\n' +
  '¡Gracias!'

export const DEFAULT_APPOINTMENT_NOTICE_FOOTER_TEXT =
  'Este es un mensaje AUTOMÁTICO'

export const DEFAULT_APPOINTMENT_NOTICE_TEXT =
  `*🗓️ Cita programada para el {{cita.fecha_hora}}*\n\n${DEFAULT_APPOINTMENT_NOTICE_BODY_TEXT}\n\n${DEFAULT_APPOINTMENT_NOTICE_FOOTER_TEXT}`

export const LEGACY_DEFAULT_APPOINTMENT_NOTICE_TEXT =
  'Hola {{contact.first_name}}, tu cita quedó agendada para el {{cita.fecha}} a las {{cita.hora}}. Te esperamos.\n\nEsto es un mensaje automático'

export const DEFAULT_ONE_HOUR_REMINDER_TEMPLATE_BODY_TEXT =
  'Hola {{1}}, solo es un recordatorio de que tu cita es dentro de una hora, para que estés al pendiente.'

export const DEFAULT_ONE_HOUR_REMINDER_TEXT =
  'Hola {{contact.first_name}}, solo es un recordatorio de que tu cita es dentro de una hora, para que estés al pendiente.'
