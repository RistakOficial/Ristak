import { parseSortableDateValue } from './format';
import { mergeNativeChatMessagesAuthoritatively } from './chatMessageMerge';
import type { ChatContact, ChatMessage } from './types';

export const BACKGROUND_RECENT_CONVERSATION_LIMIT = 6;
export const BACKGROUND_CONVERSATION_CONCURRENCY = 2;
export const BACKGROUND_NOTIFICATION_RECEIPT_LIMIT = 80;
export const BACKGROUND_PUSH_CONVERSATION_TARGET_LIMIT = 1;
export const BACKGROUND_PUSH_TARGET_BUDGET_MS = 1_800;

export function selectRecentConversationContactIds(
  chats: ChatContact[],
  preferredContactIds: string[] = [],
  limit = BACKGROUND_RECENT_CONVERSATION_LIMIT,
  excludedContactIds: string[] = [],
) {
  const safeLimit = Math.max(0, Math.floor(limit));
  const selected: string[] = [];
  const seen = new Set<string>();
  const excluded = new Set(excludedContactIds.map((id) => String(id || '').trim()).filter(Boolean));
  const add = (value: unknown) => {
    const id = String(value || '').trim();
    if (!id || excluded.has(id) || seen.has(id) || selected.length >= safeLimit) return;
    seen.add(id);
    selected.push(id);
  };

  preferredContactIds.forEach(add);
  [...chats]
    .filter((chat) => Boolean(chat?.id))
    .sort((left, right) => (
      parseSortableDateValue(right.lastMessageDate) - parseSortableDateValue(left.lastMessageDate)
    ))
    .forEach((chat) => add(chat.id));

  return selected;
}

export function shouldRefreshConversationSnapshot(
  contact: ChatContact | undefined,
  cachedMessages: ChatMessage[],
  preferred = false,
) {
  if (preferred || !cachedMessages.length) return true;
  const inboxTime = parseSortableDateValue(contact?.lastMessageDate);
  if (!inboxTime) return false;
  const cachedTime = cachedMessages.reduce((latest, message) => (
    Math.max(latest, parseSortableDateValue(message?.date))
  ), 0);
  return cachedTime < inboxTime;
}

export function mergeBackgroundConversationSnapshot(
  cachedMessages: ChatMessage[],
  incomingMessages: ChatMessage[],
  limit: number,
) {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (!safeLimit) return [];
  if (!incomingMessages.length) return cachedMessages.slice(-safeLimit);
  // Use the same canonical/optimistic identity reconciliation as the visible
  // conversation. A headless refresh must not persist two bubbles merely
  // because the server replaced a local id with its canonical/provider id.
  return mergeNativeChatMessagesAuthoritatively(false, cachedMessages, incomingMessages)
    .sort((left, right) => parseSortableDateValue(left.date) - parseSortableDateValue(right.date))
    .slice(-safeLimit);
}

export async function runBoundedPushChatWork({
  contactId,
  persistTarget,
  relayNotification,
  refreshInbox,
  targetBudgetMs = BACKGROUND_PUSH_TARGET_BUDGET_MS,
}: {
  contactId: string;
  persistTarget: (contactId: string, signal: AbortSignal) => Promise<boolean>;
  relayNotification: () => Promise<boolean>;
  refreshInbox: () => Promise<boolean>;
  targetBudgetMs?: number;
}) {
  const boundedTargets = [String(contactId || '').trim()]
    .filter(Boolean)
    .slice(0, BACKGROUND_PUSH_CONVERSATION_TARGET_LIMIT);
  let targetPersisted = false;
  let targetTimedOut = false;
  for (const targetId of boundedTargets) {
    const controller = new AbortController();
    const safeBudgetMs = Number.isFinite(targetBudgetMs) && targetBudgetMs >= 0
      ? targetBudgetMs
      : BACKGROUND_PUSH_TARGET_BUDGET_MS;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const targetWork = persistTarget(targetId, controller.signal)
      .then((persisted) => ({ kind: 'settled' as const, persisted: Boolean(persisted) }))
      .catch(() => ({ kind: 'settled' as const, persisted: false }));
    const deadline = new Promise<{ kind: 'timeout'; persisted: false }>((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ kind: 'timeout', persisted: false }), safeBudgetMs);
    });
    const outcome = await Promise.race([targetWork, deadline]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (outcome.kind === 'timeout') {
      targetTimedOut = true;
      controller.abort();
      // The rejection/settlement remains handled. An exclusive push lease
      // stops before writing; pre-existing shared work or an atomic commit that
      // already started may finish safely in its captured session namespace.
      void targetWork;
    } else {
      targetPersisted = outcome.persisted || targetPersisted;
    }
  }
  // The target snapshot is fully awaited only inside the short budget. Once it
  // expires, Android gets the alert immediately. No stale result can enter the
  // active namespace; a safe shared/atomic commit may still conclude in its
  // captured namespace. Inbox reconciliation remains one request afterward;
  // the six-thread fan-out belongs exclusively to foreground/periodic work.
  const relayed = await relayNotification();
  const inboxRefreshed = await refreshInbox();
  return { targetPersisted, targetTimedOut, relayed, inboxRefreshed };
}

const NOTIFICATION_STRING_KEYS = new Set([
  'androidChannelId',
  'category',
  'channelId',
  'contactId',
  'contact_id',
  'messageId',
  'message_id',
  'ristakRelayBody',
  'ristakRelayTitle',
  'ristakBackgroundRelay',
  'soundEnabled',
  'url',
  'vibrationEnabled',
]);

export function flattenBackgroundNotificationData(input: unknown) {
  const output: Record<string, string> = {};
  const visited = new Set<object>();

  const visit = (value: unknown, depth: number) => {
    if (depth > 7 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const clean = value.trim();
      if (!clean || (!clean.startsWith('{') && !clean.startsWith('['))) return;
      try {
        visit(JSON.parse(clean), depth + 1);
      } catch {
        // Not JSON; ordinary strings are collected from their owning key.
      }
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }

    Object.entries(value as Record<string, unknown>).forEach(([key, nested]) => {
      if (NOTIFICATION_STRING_KEYS.has(key) && nested !== null && nested !== undefined) {
        const clean = String(nested).trim();
        if (clean && !output[key]) output[key] = clean;
      }
      if (key === 'dataString' || typeof nested === 'object') visit(nested, depth + 1);
      else if (typeof nested === 'string' && nested.trim().startsWith('{')) visit(nested, depth + 1);
    });
  };

  visit(input, 0);
  return output;
}

export function getBackgroundNotificationContactId(data: Record<string, string>) {
  return String(data.contactId || data.contact_id || '').trim();
}

export function isChatBackgroundNotification(data: Record<string, string>) {
  return String(data.category || '').trim().toLowerCase() === 'chat';
}

// Expo Android treats generic data.title/data.body/data.message as presentation
// hints even on a data-only FCM. Only private Ristak keys are eligible for the
// explicit local relay, otherwise Android could display the same alert twice.
export function getBackgroundNotificationRelayContent(data: Record<string, string>) {
  return {
    title: String(data.ristakRelayTitle || '').trim(),
    body: String(data.ristakRelayBody || '').trim(),
  };
}

export function shouldSuppressHeadlessRemoteNotification(input: unknown) {
  const data = flattenBackgroundNotificationData(input);
  const { title, body } = getBackgroundNotificationRelayContent(data);
  return isChatBackgroundNotification(data)
    && data.ristakBackgroundRelay !== '1'
    && Boolean(title || body);
}

export function getBackgroundNotificationReceiptKey(data: Record<string, string>) {
  const messageId = String(data.messageId || data.message_id || '').trim();
  if (messageId) return `message:${messageId}`;
  const fallback = [
    data.category,
    getBackgroundNotificationContactId(data),
    data.ristakRelayTitle,
    data.ristakRelayBody,
  ].map((value) => String(value || '').trim()).join('|');
  return fallback.replace(/\s+/g, ' ').slice(0, 420);
}

export function appendBackgroundNotificationReceipt(receipts: string[], receiptKey: string) {
  const cleanKey = String(receiptKey || '').trim();
  if (!cleanKey) return receipts.slice(-BACKGROUND_NOTIFICATION_RECEIPT_LIMIT);
  return [...receipts.filter((item) => item !== cleanKey), cleanKey]
    .slice(-BACKGROUND_NOTIFICATION_RECEIPT_LIMIT);
}

export async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
) {
  let cursor = 0;
  const runnerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: runnerCount }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await worker(values[index], index);
    }
  }));
}
