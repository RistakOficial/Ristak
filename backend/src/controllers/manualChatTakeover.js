import {
  markHumanTakeoverByPhone,
  markHumanTakeoverIfActive
} from '../services/conversationalAgentService.js'

/**
 * Un envío manual y la pausa del agente forman una sola decisión ordenada:
 * primero se confirma la toma humana y sólo después se permite tocar al
 * proveedor. Si no puede confirmarse, el envío se bloquea para evitar que una
 * persona y la IA respondan al mismo tiempo.
 */
export async function runManualChatSendAfterHumanTakeover({
  contactId = '',
  toPhone = '',
  send
} = {}, dependencies = {}) {
  if (typeof send !== 'function') {
    throw new TypeError('El envío manual necesita una operación de entrega.')
  }

  const cleanContactId = String(contactId || '').trim()
  const cleanToPhone = String(toPhone || '').trim()
  const markByContact =
    dependencies.markByContact || markHumanTakeoverIfActive
  const markByPhone =
    dependencies.markByPhone || markHumanTakeoverByPhone

  if (cleanContactId) {
    await markByContact(cleanContactId, { updatedBy: 'human' })
  } else if (cleanToPhone) {
    await markByPhone(cleanToPhone, { updatedBy: 'human' })
  }

  return send()
}
