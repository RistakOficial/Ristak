import { normalizePhoneForStorage } from '../../../utils/phoneUtils.js'
import { WHATSAPP_PROVIDER_META_DIRECT } from './providerRegistry.js'

function clean(value) {
  return String(value ?? '').trim()
}

function messageBody(message = {}) {
  return message.text?.body ||
    message.button?.text ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    message.image?.caption ||
    message.document?.caption ||
    message.video?.caption ||
    ''
}

function findContact(value = {}, phone = '') {
  const canonicalPhone = normalizePhoneForStorage(phone) || clean(phone)
  return (Array.isArray(value.contacts) ? value.contacts : []).find(contact => {
    const candidate = normalizePhoneForStorage(contact?.wa_id || contact?.input) || clean(contact?.wa_id || contact?.input)
    return candidate && candidate === canonicalPhone
  }) || null
}

function profileFor(value = {}, phone = '') {
  const contact = findContact(value, phone)
  if (!contact) return null
  return {
    ...(contact.profile || {}),
    name: clean(contact.profile?.name),
    username: clean(contact.profile?.username || contact.username),
    whatsappUserId: clean(contact.wa_id || contact.user_id),
    parentWhatsAppUserId: clean(contact.parent_wa_id || contact.parent_user_id)
  }
}

function normalizeMessage({ message = {}, direction, field, value, entry, config, historyImport = false }) {
  const metadata = value.metadata || {}
  const businessPhone = normalizePhoneForStorage(metadata.display_phone_number || config.displayPhoneNumber) ||
    clean(metadata.display_phone_number || config.displayPhoneNumber)
  const customerPhone = direction === 'inbound'
    ? message.from
    : (message.to || message.recipient_id || message.from)
  const customerProfile = profileFor(value, customerPhone) || {}
  const body = messageBody(message)
  const id = clean(message.id || message.message_id)

  return {
    direction,
    historyImport,
    message: {
      ...message,
      id,
      wamid: id,
      metaMessageId: id,
      provider: WHATSAPP_PROVIDER_META_DIRECT,
      origin: field || (historyImport ? 'history' : 'messages'),
      wabaId: clean(entry.id || value.whatsapp_business_account_id || config.wabaId),
      from: direction === 'inbound' ? message.from : businessPhone,
      to: direction === 'inbound' ? businessPhone : customerPhone,
      type: clean(message.type) || 'unknown',
      status: direction === 'business_echo' ? (clean(message.status) || 'sent') : clean(message.status),
      sendTime: message.timestamp,
      text: body ? { body } : message.text,
      customerProfile: {
        ...customerProfile,
        whatsappUserId: clean(
          message.fromUserId || message.from_user_id || message.toUserId || message.to_user_id ||
          customerProfile.whatsappUserId
        ),
        parentWhatsAppUserId: clean(
          message.fromParentUserId || message.from_parent_user_id ||
          message.toParentUserId || message.to_parent_user_id ||
          customerProfile.parentWhatsAppUserId
        )
      },
      businessEcho: direction === 'business_echo',
      phoneNumberId: clean(metadata.phone_number_id || config.phoneNumberId),
      historyImport
    }
  }
}

function historyMessages(value = {}) {
  const history = Array.isArray(value.history) ? value.history : []
  const messages = []
  for (const chunk of history) {
    const threads = Array.isArray(chunk?.threads) ? chunk.threads : []
    for (const thread of threads) {
      for (const message of Array.isArray(thread?.messages) ? thread.messages : []) {
        messages.push({ ...message, thread_id: message.thread_id || thread.id })
      }
    }
  }
  return messages
}

export function normalizeMetaDirectWebhookPayload(payload = {}, config = {}) {
  const results = []
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const field = clean(change.field)
      const value = change.value || {}

      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        const direction = field === 'smb_message_echoes' || message.from_me || message.business_echo
          ? 'business_echo'
          : 'inbound'
        results.push(normalizeMessage({ message, direction, field, value, entry, config }))
      }

      const echoes = Array.isArray(value.smb_message_echoes)
        ? value.smb_message_echoes
        : (Array.isArray(value.message_echoes) ? value.message_echoes : [])
      for (const message of echoes) {
        results.push(normalizeMessage({ message, direction: 'business_echo', field: field || 'smb_message_echoes', value, entry, config }))
      }

      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        results.push(normalizeMessage({
          message: { ...status, id: status.id, recipient_id: status.recipient_id, type: 'status' },
          direction: 'outbound',
          field: field || 'statuses',
          value,
          entry,
          config
        }))
      }

      for (const message of historyMessages(value)) {
        const metadataPhone = normalizePhoneForStorage(value.metadata?.display_phone_number || config.displayPhoneNumber) ||
          clean(value.metadata?.display_phone_number || config.displayPhoneNumber)
        const from = normalizePhoneForStorage(message.from) || clean(message.from)
        const direction = message.from_me || message.business_echo || (metadataPhone && from === metadataPhone)
          ? 'business_echo'
          : 'inbound'
        results.push(normalizeMessage({ message, direction, field: field || 'history', value, entry, config, historyImport: true }))
      }
    }
  }
  return results
}
