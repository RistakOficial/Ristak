import { db } from '../config/database.js'
import { createInternalNotification } from './notificationsService.js'
import {
  dispatchConversationalAgentPreventiveNotification,
  retryConversationalAgentPreventiveNotifications
} from './conversationalAgentSafetyService.js'

function clean(value) {
  return String(value || '').trim()
}

async function resolveRecipients({ contactId, audience, userId } = {}) {
  const recipients = new Set()
  if (clean(audience) === 'specific_user' && clean(userId)) {
    const selected = await db.get(
      'SELECT id FROM users WHERE CAST(id AS TEXT) = ? AND is_active = 1 LIMIT 1',
      [clean(userId)]
    )
    if (selected?.id) recipients.add(String(selected.id))
  }
  if (['assigned_user', 'human_review'].includes(clean(audience))) {
    const contact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
    if (contact?.assigned_user_id) recipients.add(String(contact.assigned_user_id))
  }
  if (recipients.size === 0 || ['account_admins', 'owner', 'human_review'].includes(clean(audience))) {
    const admins = await db.all("SELECT id FROM users WHERE is_active = 1 AND role = 'admin' ORDER BY id ASC")
    admins.forEach((user) => recipients.add(String(user.id)))
  }
  return [...recipients]
}

export async function sendConversationalAgentPreventiveNotification({ event, case: safetyCase, policy, dedupeKey } = {}) {
  const recipientUserIds = await resolveRecipients({
    contactId: event?.contactId,
    audience: policy?.notification?.audience,
    userId: policy?.notification?.userId
  })
  if (!recipientUserIds.length) {
    const error = new Error('No hay una persona activa para recibir la revisión preventiva.')
    error.code = 'preventive_notification_recipient_missing'
    throw error
  }
  return createInternalNotification({
    recipientUserIds,
    source: 'Agente conversacional',
    severity: event?.severity === 'critical' ? 'error' : 'warning',
    title: 'Revisión preventiva',
    message: `${clean(event?.category) || 'riesgo'}: ${clean(event?.reason) || 'Revisa esta conversación.'}`,
    actionUrl: `/contacts/all/all/${encodeURIComponent(clean(event?.contactId))}`,
    actionLabel: 'Revisar contacto',
    category: 'conversational_safety',
    contactId: clean(event?.contactId),
    metadata: {
      safetyCaseId: safetyCase?.id || '',
      safetyEventId: event?.id || '',
      dedupeKey: clean(dedupeKey)
    }
  })
}

export async function dispatchConversationalAgentSafetyNotification(eventId) {
  return dispatchConversationalAgentPreventiveNotification({
    eventId,
    notify: sendConversationalAgentPreventiveNotification
  })
}

export async function retryConversationalAgentSafetyNotifications({ limit = 20 } = {}) {
  return retryConversationalAgentPreventiveNotifications({
    limit,
    notify: sendConversationalAgentPreventiveNotification
  })
}
