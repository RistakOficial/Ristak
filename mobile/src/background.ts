// Android background/headless chat cache. WorkManager periodically refreshes a
// bounded recent window; data-only FCM wakes the notification task and puts the
// target conversation first. Neither path assumes a permanent background
// process: Android owns the execution windows.
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { RistakApiClient } from './api';
import {
  appendBackgroundNotificationReceipt,
  BACKGROUND_CONVERSATION_CONCURRENCY,
  flattenBackgroundNotificationData,
  getBackgroundNotificationContactId,
  getBackgroundNotificationReceiptKey,
  getBackgroundNotificationRelayContent,
  isChatBackgroundNotification,
  mapWithConcurrency,
  mergeBackgroundConversationSnapshot,
  runBoundedPushChatWork,
  selectRecentConversationContactIds,
  shouldRefreshConversationSnapshot,
} from './backgroundChatPolicy';
import { readCacheForNamespace, writeCacheNow } from './cache';
import {
  CHAT_LIST_PAGE_SIZE,
  CONVERSATION_MESSAGE_CACHE_LIMIT,
  conversationCacheKey,
  NATIVE_INBOX_CACHE_KEY,
  NATIVE_INBOX_CACHE_LIMIT,
} from './cacheKeys';
import { buildMessagesFromJourney } from './format';
import { createAndroidNotificationChannels } from './notificationChannels';
import { getSessionCacheNamespace, isCurrentSessionCacheNamespace } from './sessionAccess';
import { readApiBaseUrl, readAuthToken } from './storage';
import type { ChatContact, ChatMessage } from './types';

export const INBOX_BACKGROUND_TASK = 'ristak-inbox-refresh';
export const CHAT_NOTIFICATION_BACKGROUND_TASK = 'ristak-chat-notification-refresh-v1';
const BACKGROUND_NOTIFICATION_RECEIPTS_CACHE_KEY = 'chat:background-notification-receipts';
const LOCAL_NOTIFICATION_RELAY_MARKER = 'ristakBackgroundRelay';
const notificationRelayInFlight = new Set<string>();

type BackgroundSession = {
  api: RistakApiClient;
  baseUrl: string;
  namespace: string;
  token: string;
};

async function readBackgroundSession(): Promise<BackgroundSession | null> {
  const [baseUrl, token] = await Promise.all([readApiBaseUrl(), readAuthToken()]);
  const namespace = getSessionCacheNamespace(baseUrl, token);
  if (!baseUrl || !token || !namespace) return null;
  return {
    api: new RistakApiClient(baseUrl, token),
    baseUrl,
    namespace,
    token,
  };
}

async function backgroundSessionIsCurrent(session: BackgroundSession) {
  const [currentBaseUrl, currentToken] = await Promise.all([readApiBaseUrl(), readAuthToken()]);
  return isCurrentSessionCacheNamespace(session.namespace, currentBaseUrl, currentToken);
}

const conversationWarmups = new Map<string, Promise<boolean>>();

async function warmConversationSnapshot(
  session: BackgroundSession,
  contactId: string,
  contact: ChatContact | undefined,
  preferred: boolean,
  signal?: AbortSignal,
) {
  const warmupKey = `${session.namespace}:${contactId}`;
  const inFlight = conversationWarmups.get(warmupKey);
  // Reuse work that another foreground/periodic consumer already owns, but do
  // not attach the push deadline's AbortSignal to it. A push may stop waiting;
  // it must never cancel a legitimate shared warmup.
  if (inFlight) return inFlight;

  // Signal-bearing work is an exclusive push lease and is intentionally not
  // published in the shared map. A later foreground consumer starts its own
  // request instead of becoming collateral damage when the 1.8 s lease ends.
  const sharedWarmup = !signal;
  const warmup = (async () => {
    if (signal?.aborted) return false;
    const cacheKey = conversationCacheKey(contactId);
    const cached = await readCacheForNamespace<ChatMessage[]>(cacheKey, [], session.namespace);
    if (signal?.aborted) return false;
    if (!shouldRefreshConversationSnapshot(contact, cached, preferred)) return false;

    const journey = await session.api.getConversation(
      contactId,
      CHAT_LIST_PAGE_SIZE,
      { signal },
    );
    if (signal?.aborted) return false;
    const incoming = buildMessagesFromJourney(contactId, journey, session.baseUrl);
    // Headless work stays strictly bounded to the optimized 50-message route.
    // The interactive screen owns the full-journey recovery for a successful,
    // contradictory empty response; a background task must never fetch an
    // unbounded journey or multiply endpoints before presenting the alert.
    if (!incoming.length && !cached.length) return false;
    if (signal?.aborted) return false;
    if (!await backgroundSessionIsCurrent(session)) return false;
    if (signal?.aborted) return false;

    await writeCacheNow(
      cacheKey,
      mergeBackgroundConversationSnapshot(cached, incoming, CONVERSATION_MESSAGE_CACHE_LIMIT),
      session.namespace,
    );
    // AsyncStorage's setItem may already be committing when the deadline fires.
    // That atomic write is safe because it is pinned to the captured namespace;
    // never report it as current if the lease/session changed meanwhile.
    if (signal?.aborted) return false;
    return backgroundSessionIsCurrent(session);
  })().catch(() => false).finally(() => {
    if (sharedWarmup && conversationWarmups.get(warmupKey) === warmup) {
      conversationWarmups.delete(warmupKey);
    }
  });

  if (sharedWarmup) conversationWarmups.set(warmupKey, warmup);
  return warmup;
}

async function warmConversationSnapshots(
  session: BackgroundSession,
  chats: ChatContact[],
  preferredContactIds: string[] = [],
  excludedContactIds: string[] = [],
) {
  const preferred = new Set(preferredContactIds.map((id) => String(id || '').trim()).filter(Boolean));
  const contactIds = selectRecentConversationContactIds(
    chats,
    [...preferred],
    undefined,
    excludedContactIds,
  );
  const chatsById = new Map(chats.map((chat) => [chat.id, chat]));
  let updated = false;
  await mapWithConcurrency(contactIds, BACKGROUND_CONVERSATION_CONCURRENCY, async (contactId) => {
    if (await warmConversationSnapshot(
      session,
      contactId,
      chatsById.get(contactId),
      preferred.has(contactId),
    )) updated = true;
  });
  return updated;
}

async function refreshInboxSnapshot(session: BackgroundSession) {
  const data = await session.api.getChats('', 0, CHAT_LIST_PAGE_SIZE, { warmProfilePictures: false });
  const chats = Array.isArray(data) ? data : [];
  if (!await backgroundSessionIsCurrent(session)) return null;

  // Persist the inbox before the thread fan-out. If Android expires the worker,
  // the next launch still gets the newest ordering and previews.
  await writeCacheNow(
    NATIVE_INBOX_CACHE_KEY,
    chats.slice(0, NATIVE_INBOX_CACHE_LIMIT),
    session.namespace,
  );
  return chats;
}

async function syncBackgroundChats() {
  const session = await readBackgroundSession();
  if (!session) return false;
  const chats = await refreshInboxSnapshot(session);
  if (!chats) return false;
  await warmConversationSnapshots(session, chats);
  return true;
}

// Foreground inbox reconciliation also warms missing/stale recent threads. It
// uses the same bounded concurrency and cache contracts as the headless worker,
// so tapping a row usually opens from RAM/disk instead of starting a request.
export async function prefetchRecentConversationCaches(
  chats: ChatContact[],
  preferredContactIds: string[] = [],
  excludedContactIds: string[] = [],
) {
  const session = await readBackgroundSession();
  if (!session || !await backgroundSessionIsCurrent(session)) return false;
  return warmConversationSnapshots(session, chats, preferredContactIds, excludedContactIds);
}

async function relayLocalNotificationOnce(
  session: BackgroundSession,
  data: Record<string, string>,
) {
  if (data[LOCAL_NOTIFICATION_RELAY_MARKER] === '1') return false;
  const { title, body } = getBackgroundNotificationRelayContent(data);
  const receiptKey = getBackgroundNotificationReceiptKey(data);
  if ((!title && !body) || !receiptKey) return false;
  if (notificationRelayInFlight.has(receiptKey)) return false;

  notificationRelayInFlight.add(receiptKey);
  try {
    const receipts = await readCacheForNamespace<string[]>(
      BACKGROUND_NOTIFICATION_RECEIPTS_CACHE_KEY,
      [],
      session.namespace,
    );
    if (receipts.includes(receiptKey)) return false;
    if (!await backgroundSessionIsCurrent(session)) return false;

    await createAndroidNotificationChannels();
    if (!await backgroundSessionIsCurrent(session)) return false;
    const channelId = String(data.androidChannelId || data.channelId || 'ristak_alerts').trim();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: title || 'Ristak',
        body,
        data: {
          ...data,
          [LOCAL_NOTIFICATION_RELAY_MARKER]: '1',
        },
        sound: data.soundEnabled === 'false' ? false : 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 1,
        channelId,
      },
    });
    await writeCacheNow(
      BACKGROUND_NOTIFICATION_RECEIPTS_CACHE_KEY,
      appendBackgroundNotificationReceipt(receipts, receiptKey),
      session.namespace,
    );
    return true;
  } finally {
    notificationRelayInFlight.delete(receiptKey);
  }
}

// Defined at module scope so both tasks exist before React mounts and can run
// inside a cold headless JS runtime.
TaskManager.defineTask(INBOX_BACKGROUND_TASK, async () => {
  try {
    await syncBackgroundChats();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

TaskManager.defineTask(CHAT_NOTIFICATION_BACKGROUND_TASK, async ({ data, error }) => {
  if (error) return Notifications.BackgroundNotificationTaskResult.Failed;
  const notificationData = flattenBackgroundNotificationData(data);
  if (!isChatBackgroundNotification(notificationData)) {
    return Notifications.BackgroundNotificationTaskResult.NoData;
  }
  if (notificationData[LOCAL_NOTIFICATION_RELAY_MARKER] === '1') {
    return Notifications.BackgroundNotificationTaskResult.NoData;
  }

  const session = await readBackgroundSession();
  if (!session) return Notifications.BackgroundNotificationTaskResult.NoData;
  try {
    const contactId = getBackgroundNotificationContactId(notificationData);
    const result = await runBoundedPushChatWork({
      contactId,
      persistTarget: (targetId, signal) => warmConversationSnapshot(
        session,
        targetId,
        undefined,
        true,
        signal,
      ),
      relayNotification: () => relayLocalNotificationOnce(session, notificationData),
      refreshInbox: async () => Boolean(await refreshInboxSnapshot(session)),
    });
    return result.targetPersisted || result.relayed || result.inboxRefreshed
      ? Notifications.BackgroundNotificationTaskResult.NewData
      : Notifications.BackgroundNotificationTaskResult.NoData;
  } catch {
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
});

// Capability registration is intentionally module-scoped. Token registration
// awaits this result, so the broker only sends data-only FCM after Android has
// actually accepted the headless task for this installed binary.
export const chatNotificationBackgroundTaskReady: Promise<boolean> = Notifications
  .registerTaskAsync(CHAT_NOTIFICATION_BACKGROUND_TASK)
  .then(() => true)
  .catch(() => false);

// Idempotent: safe to call on every launch once the user is signed in.
export async function registerInboxBackgroundTask(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    const registered = await TaskManager.isTaskRegisteredAsync(INBOX_BACKGROUND_TASK);
    if (!registered) {
      // Minutes, not seconds. Android WorkManager enforces a 15 minute floor
      // and may run later depending on battery/network/vendor restrictions.
      await BackgroundTask.registerTaskAsync(INBOX_BACKGROUND_TASK, { minimumInterval: 15 });
    }
  } catch {
    // Best-effort: never block startup on background scheduling.
  }
}

export async function unregisterInboxBackgroundTask(): Promise<void> {
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(INBOX_BACKGROUND_TASK);
    if (registered) await BackgroundTask.unregisterTaskAsync(INBOX_BACKGROUND_TASK);
  } catch {
    // The notification task remains registered; without credentials it is a
    // no-op, and keeping it registered allows the next login to work headlessly.
  }
}
