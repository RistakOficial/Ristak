import { parseSortableDateValue } from './format';
import type { ChatMessage, ConversationHistoryCursor, JourneyEvent } from './types';

// Failed outbox rows must survive a normal reopen, but not become permanent
// ghosts when the backend never persisted them. Seven days gives an operator a
// useful retry window across weekends while keeping the cache self-cleaning.
export const NATIVE_LOCAL_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NATIVE_LOCAL_OUTBOX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const NATIVE_LOCAL_MESSAGE_ID_PREFIXES = ['local-', 'template-', 'clabe-', 'location-'];
const NATIVE_PENDING_STATUSES = new Set(['pending', 'sending', 'enviando']);
const NATIVE_FAILED_STATUSES = new Set(['error', 'failed']);

export function getOldestConversationHistoryCursor(
  events: JourneyEvent[],
): ConversationHistoryCursor | null {
  let oldest: ConversationHistoryCursor | null = null;
  let oldestTimestamp = Number.POSITIVE_INFINITY;

  events.forEach((event) => {
    const beforeMessageDate = String(event?.date || '').trim();
    const timestamp = parseSortableDateValue(beforeMessageDate);
    if (!beforeMessageDate || !Number.isFinite(timestamp) || timestamp <= 0) return;
    const beforeMessageCursor = String(event?.cursorKey || '').trim() || undefined;

    if (timestamp < oldestTimestamp) {
      oldestTimestamp = timestamp;
      oldest = { beforeMessageDate, beforeMessageCursor };
      return;
    }
    if (timestamp !== oldestTimestamp || !oldest) return;

    // El backend ordena los empates por identidad ascendente. El primer par
    // (fecha, cursor) de la pagina es exactamente el limite para pedir la previa.
    const currentCursor = oldest.beforeMessageCursor;
    if (beforeMessageCursor && (!currentCursor || beforeMessageCursor < currentCursor)) {
      oldest = { beforeMessageDate, beforeMessageCursor };
    }
  });

  return oldest;
}

export function isConversationHistoryCursorOlder(
  candidate: ConversationHistoryCursor | null,
  boundary: ConversationHistoryCursor | null,
) {
  if (!candidate?.beforeMessageDate || !boundary?.beforeMessageDate) return false;
  const candidateTimestamp = parseSortableDateValue(candidate.beforeMessageDate);
  const boundaryTimestamp = parseSortableDateValue(boundary.beforeMessageDate);
  if (!candidateTimestamp || !boundaryTimestamp) return false;
  if (candidateTimestamp !== boundaryTimestamp) return candidateTimestamp < boundaryTimestamp;

  const candidateCursor = String(candidate.beforeMessageCursor || '').trim();
  const boundaryCursor = String(boundary.beforeMessageCursor || '').trim();
  if (!candidateCursor || !boundaryCursor || candidateCursor === boundaryCursor) return false;
  return candidateCursor < boundaryCursor;
}

export function hasNewRenderableConversationHistoryMessage(
  current: ChatMessage[],
  incoming: ChatMessage[],
) {
  const currentIds = new Set(current.map((message) => message.id));
  return incoming.some((message) => (
    Boolean(message?.id)
    && !currentIds.has(message.id)
    && !message.reactionEmoji
  ));
}

export function isNativeLocalMessageId(id: string) {
  return NATIVE_LOCAL_MESSAGE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function isScheduledNativeMessage(message: ChatMessage) {
  return Boolean(
    message.scheduledAt
    || message.scheduledMessageId
    || message.id.startsWith('scheduled-')
    || String(message.status || '').trim().toLowerCase() === 'scheduled'
  );
}

export function isNativePendingLocalMessage(message: ChatMessage) {
  if (message.direction !== 'outbound' || isScheduledNativeMessage(message)) return false;
  if (!message.optimisticId && !isNativeLocalMessageId(message.id)) return false;
  const status = String(message.status || '').trim().toLowerCase();
  return Boolean(message.pending) || NATIVE_PENDING_STATUSES.has(status);
}

export function isNativeUnsettledLocalMessage(message: ChatMessage) {
  if (message.direction !== 'outbound' || isScheduledNativeMessage(message)) return false;
  if (!message.optimisticId && !isNativeLocalMessageId(message.id)) return false;
  const status = String(message.status || '').trim().toLowerCase();
  return Boolean(message.failed) || isNativePendingLocalMessage(message) || NATIVE_FAILED_STATUSES.has(status);
}

export function retainNativeLocalOutboxMessages(
  messages: ChatMessage[],
  now = Date.now(),
  retentionMs = NATIVE_LOCAL_OUTBOX_RETENTION_MS,
) {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeRetentionMs = Number.isFinite(retentionMs) && retentionMs >= 0
    ? retentionMs
    : NATIVE_LOCAL_OUTBOX_RETENTION_MS;

  return messages.filter((message) => {
    if (!isNativeUnsettledLocalMessage(message)) return false;
    const timestamp = parseSortableDateValue(message.date);
    if (!timestamp || timestamp > safeNow + NATIVE_LOCAL_OUTBOX_FUTURE_SKEW_MS) return false;
    return safeNow - timestamp <= safeRetentionMs;
  });
}

export function makeUnreconciledNativePendingMessagesRetryable(
  messages: ChatMessage[],
  conversionAllowed = true,
) {
  if (!conversionAllowed) return messages;
  let changed = false;
  const next = messages.map((message) => {
    // An acknowledged row can legitimately remain "pending" at the provider.
    // Only a purely local row with no canonical/provider identity is orphaned.
    if (
      !isNativePendingLocalMessage(message)
      || message.serverMessageId
      || message.providerMessageId
    ) return message;
    changed = true;
    return {
      ...message,
      pending: false,
      failed: true,
      status: 'error',
      errorReason: message.errorReason || 'No pudimos confirmar el envío. Toca el mensaje para reintentar.',
    };
  });
  return changed ? next : messages;
}
