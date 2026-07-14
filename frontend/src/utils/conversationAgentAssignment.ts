import type { ConversationAgentState } from '@/services/conversationalAgentService'

export type ConversationAgentAssignmentStatus = 'active' | 'paused'

/**
 * Un agente sigue asignado a la conversacion solo mientras puede atenderla o
 * esta pausado temporalmente. Los estados terminales conservan historial, pero
 * ya no representan una asignacion viva.
 */
export function getConversationAgentAssignmentStatus(
  state: ConversationAgentState | null | undefined
): ConversationAgentAssignmentStatus | null {
  if (!String(state?.agentId || '').trim()) return null
  const status = String(state?.status || '').trim().toLowerCase()
  return status === 'active' || status === 'paused' ? status : null
}

export function isConversationAgentAssigned(
  state: ConversationAgentState | null | undefined
) {
  return getConversationAgentAssignmentStatus(state) !== null
}

export function getAssignedConversationAgentStates(
  states: ConversationAgentState[] = []
) {
  return states.filter(isConversationAgentAssigned)
}
