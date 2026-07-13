type PreviewAction = {
  type?: string
}

const PREVIEW_ACTION_MESSAGES: Record<string, string> = {
  book_appointment: 'Prueba interna: la cita se agendaría en el calendario configurado.',
  create_payment_link: 'Prueba interna: se prepararía el cobro con el importe real configurado.',
  register_deposit_payment_proof: 'Prueba interna: el comprobante quedaría enviado a revisión.',
  send_goal_url: 'Prueba interna: se mandaría el enlace configurado.',
  send_trigger_link: 'Prueba interna: se mandaría el enlace configurado.',
  send_to_human: 'Prueba interna: la conversación pasaría a la persona configurada.',
  mark_ready_to_advance: 'Prueba interna: el objetivo propio quedaría completado.'
}

export function describeConversationalPreviewAction(action: PreviewAction): string | null {
  const actionType = String(action?.type || '').trim()

  if (actionType === 'offer_appointment_slot' || actionType === 'offer_appointment_options') {
    return null
  }

  return PREVIEW_ACTION_MESSAGES[actionType]
    || 'Prueba interna: la capacidad configurada se ejecutaría aquí.'
}
