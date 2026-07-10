import { parseSortableDateValue } from './format';
import type { ChatContact } from './types';

export type ChatLiveEventLike = {
  type?: string;
  contactId?: string;
  channel?: string;
  transport?: string;
  direction?: string;
  messageType?: string;
  messageTimestamp?: string;
  receivedAt?: string;
  isNew?: boolean;
};

const CHAT_AVATAR_KEYS = ['profilePhotoUrl', 'avatarUrl', 'photoUrl', 'pictureUrl'] as const;

export function mergeChatContact(base: ChatContact, patch: Partial<ChatContact>) {
  const merged: ChatContact = { ...base, ...patch };
  CHAT_AVATAR_KEYS.forEach((key) => {
    const patchValue = String(patch[key] || '').trim();
    const baseValue = String(base[key] || '').trim();
    if (patchValue) merged[key] = patch[key];
    else if (baseValue) merged[key] = base[key];
  });

  try {
    if (JSON.stringify(base) === JSON.stringify(merged)) return base;
  } catch {
    // A non-serializable contact is replaced instead of breaking the inbox.
  }
  return merged;
}

export function patchChatContactList(
  current: ChatContact[],
  contactId: string,
  patch: Partial<ChatContact>,
  promote = false,
) {
  const index = current.findIndex((contact) => contact.id === contactId);
  if (index < 0) return current;
  const nextContact = mergeChatContact(current[index], patch);
  if (!promote) {
    if (nextContact === current[index]) return current;
    const next = current.slice();
    next[index] = nextContact;
    return next;
  }
  if (index === 0 && nextContact === current[0]) return current;
  return [nextContact, ...current.slice(0, index), ...current.slice(index + 1)];
}

export function applyChatLiveEvent(
  current: ChatContact[],
  event?: ChatLiveEventLike | null,
  openContactId = '',
) {
  const contactId = String(event?.contactId || '').trim();
  if (!contactId || event?.type !== 'chat_message' || event.isNew === false) return current;
  const existing = current.find((contact) => contact.id === contactId);
  if (!existing) return current;

  const eventTimestamp = String(event.messageTimestamp || event.receivedAt || '').trim();
  const eventTime = parseSortableDateValue(eventTimestamp);
  const currentTime = parseSortableDateValue(existing.lastMessageDate || existing.createdAt);
  if (!eventTime || (currentTime && eventTime < currentTime)) return current;

  const direction = String(event.direction || '').trim();
  const inboundUnread = direction === 'inbound' && openContactId !== contactId;
  const patch: Partial<ChatContact> = {
    lastMessageDate: eventTimestamp,
    messageCount: Number(existing.messageCount || 0) + 1,
    ...(direction ? { lastMessageDirection: direction } : {}),
    ...(event.channel ? { lastMessageChannel: event.channel } : {}),
    ...(event.transport ? { lastMessageTransport: event.transport } : {}),
    ...(event.messageType ? { lastMessageType: event.messageType } : {}),
    ...(inboundUnread ? { unreadCount: Number(existing.unreadCount || 0) + 1 } : {}),
  };
  return patchChatContactList(current, contactId, patch, true);
}

export function mergeChatContactPages(current: ChatContact[], incoming: ChatContact[]) {
  if (!incoming.length) return current;
  const merged = [...current];
  const indexById = new Map(merged.map((contact, index) => [contact.id, index]));
  incoming.forEach((contact) => {
    if (!contact?.id) return;
    const existingIndex = indexById.get(contact.id);
    if (existingIndex === undefined) {
      indexById.set(contact.id, merged.length);
      merged.push(contact);
      return;
    }
    merged[existingIndex] = mergeChatContact(merged[existingIndex], contact);
  });
  if (merged.length === current.length && merged.every((contact, index) => contact === current[index])) {
    return current;
  }
  return merged;
}

// Page zero is authoritative for recent ordering. A short page is the complete
// result, while a full page keeps only the already-loaded tail older than its
// boundary. This prevents deleted/hidden or newly-filtered stale rows from
// surviving forever in the offline-first inbox.
export function mergeFreshChatPage(fresh: ChatContact[], previous: ChatContact[], pageSize: number) {
  const seen = new Set<string>();
  const uniqueFresh = fresh.filter((contact) => {
    if (!contact?.id || seen.has(contact.id)) return false;
    seen.add(contact.id);
    return true;
  });
  const previousById = new Map(previous.map((contact) => [contact.id, contact]));
  const mergedFresh = uniqueFresh.map((contact) => {
    const prior = previousById.get(contact.id);
    return prior ? mergeChatContact(prior, contact) : contact;
  });

  let tail: ChatContact[] = [];
  if (fresh.length >= pageSize && mergedFresh.length) {
    const boundary = mergedFresh[mergedFresh.length - 1];
    const boundaryTime = parseSortableDateValue(boundary.lastMessageDate || boundary.createdAt);
    const boundaryId = String(boundary.id || '');
    tail = previous.filter((contact) => (
      !seen.has(contact.id)
      && (
        !boundaryTime
        || parseSortableDateValue(contact.lastMessageDate || contact.createdAt) < boundaryTime
        || (
          parseSortableDateValue(contact.lastMessageDate || contact.createdAt) === boundaryTime
          && String(contact.id || '') < boundaryId
        )
      )
    ));
  }

  const merged = [...mergedFresh, ...tail];
  if (merged.length === previous.length && merged.every((contact, index) => contact === previous[index])) {
    return previous;
  }
  return merged;
}

export function sortChatContactsByRecency(chats: ChatContact[]) {
  return chats.slice().sort((left, right) => (
    parseSortableDateValue(right.lastMessageDate || right.createdAt)
    - parseSortableDateValue(left.lastMessageDate || left.createdAt)
  ));
}
