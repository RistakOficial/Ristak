export const CONVERSATIONAL_AGENT_COMPLETION_SIGNAL_VALUES = Object.freeze([
  'ready_for_human',
  'ready_to_schedule',
  'ready_to_buy',
  'appointment_booked',
  'purchase_completed',
  'link_sent'
])

export const CONVERSATIONAL_AGENT_COMPLETION_SIGNALS = new Set(
  CONVERSATIONAL_AGENT_COMPLETION_SIGNAL_VALUES
)
