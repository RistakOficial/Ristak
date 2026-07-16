import { parseSortableDateValue } from './format';
import type { ChatContact, ChatMessage } from './types';

export function contactSummaryExpectsMessages(contact: Pick<ChatContact,
  'lastMessageDate' | 'lastMessageText' | 'lastMessageType' | 'messageCount'
>) {
  return Number(contact.messageCount || 0) > 0
    || Boolean(String(contact.lastMessageDate || '').trim())
    || Boolean(String(contact.lastMessageText || '').trim())
    || Boolean(String(contact.lastMessageType || '').trim());
}

export function getLatestConversationMessageTime(messages: ChatMessage[]) {
  return messages.reduce((latest, message) => (
    Math.max(latest, parseSortableDateValue(message?.date))
  ), 0);
}

// An empty response is contradictory when the inbox still advertises a chat.
// If the cached window is already as recent as the inbox, keeping it is enough;
// otherwise the caller should try the legacy journey path once.
export function shouldRecoverEmptyConversation(
  contact: Pick<ChatContact, 'lastMessageDate' | 'lastMessageText' | 'lastMessageType' | 'messageCount'>,
  currentMessages: ChatMessage[],
  incomingMessages: ChatMessage[],
) {
  if (incomingMessages.length || !contactSummaryExpectsMessages(contact)) return false;
  if (!currentMessages.length) return true;
  const summaryTime = parseSortableDateValue(contact.lastMessageDate);
  if (!summaryTime) return false;
  return getLatestConversationMessageTime(currentMessages) < summaryTime;
}

export function shouldPreserveConversationSnapshot(
  _contact: Pick<ChatContact, 'lastMessageDate' | 'lastMessageText' | 'lastMessageType' | 'messageCount'>,
  currentMessages: ChatMessage[],
  incomingMessages: ChatMessage[],
) {
  return incomingMessages.length === 0
    && currentMessages.length > 0;
}

export async function loadConversationWithSuccessfulEmptyRecovery<T>(
  loadPrimary: () => Promise<T[]>,
  shouldRecoverSuccessfulResponse: (primary: T[]) => boolean,
  loadRecovery: () => Promise<T[]>,
) {
  // Deliberately no catch here: timeout, cancellation, auth rejection and any
  // other failed primary request propagate without multiplying endpoints.
  const primary = await loadPrimary();
  if (!shouldRecoverSuccessfulResponse(primary)) {
    return { items: primary, usedRecovery: false } as const;
  }
  const recovered = await loadRecovery();
  return { items: recovered, usedRecovery: true } as const;
}

// FlatList inverted uses offset 0 as the visual bottom. Consume exactly one
// initial anchor after real rows exist; later media reflows/history prepends must
// never drag an operator away from the message they are reading.
export class ConversationLatestAnchorGate {
  private pending = true;

  consume(itemCount: number) {
    if (!this.pending || itemCount <= 0) return false;
    this.pending = false;
    return true;
  }
}
