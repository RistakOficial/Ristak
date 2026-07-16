import {
  getOutboundMessageChannelFamily,
  getOutboundSendResultState,
} from './chatRouting';
import {
  isNativeLocalMessageId,
  makeUnreconciledNativePendingMessagesRetryable,
} from './conversationReliability';
import { parseSortableDateValue, resolveChatMessageReactions } from './format';
import type { ChatAttachment, ChatMessage } from './types';

const NATIVE_OPTIMISTIC_RECONCILE_FORWARD_MS = 4 * 60 * 1000;
const NATIVE_OPTIMISTIC_RECONCILE_BACKWARD_MS = 60 * 1000;

function isSameNativeChatMessage(left: ChatMessage, right: ChatMessage) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function stripNativeMessageTransientCacheData(message: ChatMessage): ChatMessage {
  if (!message.attachment?.dataUrl) return message;
  const { dataUrl: _dataUrl, ...attachment } = message.attachment;
  return { ...message, attachment };
}

export function hasNewInboundNativeMessage(current: ChatMessage[], incoming: ChatMessage[]) {
  const knownIds = new Set(current
    .filter((message) => message.direction === 'inbound')
    .map((message) => message.id));
  return incoming.some((message) => message.direction === 'inbound' && !knownIds.has(message.id));
}

function isScheduledMessage(message: ChatMessage) {
  return Boolean(
    message.scheduledAt
    || message.scheduledMessageId
    || message.id.startsWith('scheduled-')
    || String(message.status || '').trim().toLowerCase() === 'scheduled'
  );
}

function mergeNativeServerMessageIntoOptimistic(localRow: ChatMessage, serverRow: ChatMessage): ChatMessage {
  const localAttachment = localRow.attachment;
  const serverAttachment = serverRow.attachment;
  const attachment: ChatAttachment | undefined = serverAttachment
    ? {
      ...localAttachment,
      ...serverAttachment,
      // Keep the already-painted local preview to avoid a second media load and
      // preserve the bubble dimensions while the canonical row is reconciled.
      ...(localAttachment?.dataUrl ? { dataUrl: localAttachment.dataUrl } : {}),
      ...(localAttachment?.url && !serverAttachment?.url ? { url: localAttachment.url } : {}),
    }
    : localAttachment;

  const serverState = getOutboundSendResultState(serverRow);
  return {
    ...localRow,
    ...serverRow,
    id: localRow.id,
    optimisticId: localRow.optimisticId || localRow.id,
    serverMessageId: serverRow.serverMessageId || localRow.serverMessageId || serverRow.id,
    providerMessageId: serverRow.providerMessageId || localRow.providerMessageId,
    date: localRow.date || serverRow.date,
    text: serverRow.text || localRow.text,
    pending: serverRow.pending ?? serverState.pending,
    failed: serverRow.failed ?? serverState.failed,
    errorReason: serverRow.errorReason || serverState.errorReason,
    ...(attachment ? { attachment } : {}),
  };
}

function reconcileNativeOptimisticMessages(
  byId: Map<string, ChatMessage>,
  includeUnsettledLocal = false,
) {
  const localRows: ChatMessage[] = [];
  const serverRows: ChatMessage[] = [];
  byId.forEach((message) => {
    if (message.direction !== 'outbound' || message.reactionEmoji || isScheduledMessage(message)) return;
    if (message.optimisticId || isNativeLocalMessageId(message.id)) {
      if (includeUnsettledLocal || (!message.failed && !message.pending)) localRows.push(message);
    } else {
      serverRows.push(message);
    }
  });
  if (!localRows.length || !serverRows.length) return;

  const consumedServerIds = new Set<string>();
  localRows
    .sort((left, right) => parseSortableDateValue(left.date) - parseSortableDateValue(right.date))
    .forEach((localRow) => {
      const localTime = parseSortableDateValue(localRow.date);
      const localText = String(localRow.text || '').trim();
      const localFamily = getOutboundMessageChannelFamily(localRow);
      let match: ChatMessage | null = null;
      let matchDistance = Number.POSITIVE_INFINITY;
      serverRows.forEach((serverRow) => {
        if (consumedServerIds.has(serverRow.id)) return;
        const exactServerId = Boolean(localRow.serverMessageId)
          && (serverRow.id === localRow.serverMessageId || serverRow.serverMessageId === localRow.serverMessageId);
        const exactOptimisticId = Boolean(localRow.optimisticId)
          && serverRow.optimisticId === localRow.optimisticId;
        const exactProviderId = Boolean(localRow.providerMessageId)
          && serverRow.providerMessageId === localRow.providerMessageId;
        if (exactServerId || exactOptimisticId || exactProviderId) {
          match = serverRow;
          matchDistance = -1;
          return;
        }
        if (matchDistance < 0) return;
        const serverTime = parseSortableDateValue(serverRow.date);
        if (serverTime < localTime - NATIVE_OPTIMISTIC_RECONCILE_BACKWARD_MS) return;
        const distance = Math.abs(serverTime - localTime);
        if (distance > NATIVE_OPTIMISTIC_RECONCILE_FORWARD_MS || distance >= matchDistance) return;
        const serverFamily = getOutboundMessageChannelFamily(serverRow);
        if (localFamily !== 'other' && serverFamily !== 'other' && localFamily !== serverFamily) return;
        const serverText = String(serverRow.text || '').trim();
        const textMatches = Boolean(localText) && localText === serverText;
        const attachmentMatches = Boolean(localRow.attachment) && Boolean(serverRow.attachment)
          && String(localRow.attachment?.type || '').toLowerCase() === String(serverRow.attachment?.type || '').toLowerCase()
          && (!localText || localText === serverText);
        const locationMatches = Boolean(localRow.location) && Boolean(serverRow.location)
          && !localText && !localRow.attachment;
        if (!textMatches && !attachmentMatches && !locationMatches) return;
        match = serverRow;
        matchDistance = distance;
      });
      if (!match) return;
      const serverMatch = match as ChatMessage;
      consumedServerIds.add(serverMatch.id);
      byId.delete(serverMatch.id);
      byId.set(localRow.id, mergeNativeServerMessageIntoOptimistic(localRow, serverMatch));
    });
}

function mergeNativeChatMessageGroups(groups: ChatMessage[][], includeUnsettledLocal = false) {
  const byId = new Map<string, ChatMessage>();
  groups.forEach((group) => {
    group.forEach((message) => {
      if (!message?.id) return;
      const existing = byId.get(message.id);
      if (!existing) {
        byId.set(message.id, message);
        return;
      }
      if (existing === message) return;
      const merged = { ...existing, ...message };
      byId.set(message.id, isSameNativeChatMessage(existing, merged) ? existing : merged);
    });
  });
  reconcileNativeOptimisticMessages(byId, includeUnsettledLocal);
  return resolveChatMessageReactions(Array.from(byId.values()));
}

export function mergeNativeChatMessages(...groups: ChatMessage[][]) {
  return mergeNativeChatMessageGroups(groups);
}

export function mergeNativeChatMessagesAuthoritatively(
  makePendingRetryable: boolean,
  ...groups: ChatMessage[][]
) {
  const reconciled = mergeNativeChatMessageGroups(groups, true);
  return makeUnreconciledNativePendingMessagesRetryable(reconciled, makePendingRetryable);
}

export function areNativeMessageArraysIdentical(left: ChatMessage[], right: ChatMessage[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
