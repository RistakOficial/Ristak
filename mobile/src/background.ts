// Background refresh for the Android client. When the OS grants a background
// window, this refreshes the inbox into the same disk cache the app hydrates
// from on launch. This is best-effort freshness, not a live stream.
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { readApiBaseUrl, readAuthToken } from './storage';
import { RistakApiClient } from './api';
import { writeCacheNow } from './cache';
import { CHAT_LIST_PAGE_SIZE, NATIVE_INBOX_CACHE_KEY, NATIVE_INBOX_CACHE_LIMIT } from './cacheKeys';
import { getSessionCacheNamespace, isCurrentSessionCacheNamespace } from './sessionAccess';

export const INBOX_BACKGROUND_TASK = 'ristak-inbox-refresh';

// Defined at module scope so the task can run headlessly on a cold background
// launch (this file is imported from index.ts before the app renders).
TaskManager.defineTask(INBOX_BACKGROUND_TASK, async () => {
  try {
    const [baseUrl, token] = await Promise.all([readApiBaseUrl(), readAuthToken()]);
    if (!baseUrl || !token) return BackgroundTask.BackgroundTaskResult.Success;
    const sessionNamespace = getSessionCacheNamespace(baseUrl, token);
    if (!sessionNamespace) return BackgroundTask.BackgroundTaskResult.Success;
    const api = new RistakApiClient(baseUrl, token);
    const data = await api.getChats('', 0, CHAT_LIST_PAGE_SIZE);
    const chats = Array.isArray(data) ? data : [];
    // The request may have started before logout or an account switch. Re-read
    // the durable session; changing it makes this old result a no-op. The write
    // below is explicitly scoped and never changes the foreground app's active
    // namespace, even if both runtimes overlap during an account switch.
    const [currentBaseUrl, currentToken] = await Promise.all([readApiBaseUrl(), readAuthToken()]);
    if (!isCurrentSessionCacheNamespace(sessionNamespace, currentBaseUrl, currentToken)) {
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    // Empty is authoritative too: otherwise a successful zero-chat refresh
    // leaves a stale inbox on the next offline launch.
    await writeCacheNow(
      NATIVE_INBOX_CACHE_KEY,
      chats.slice(0, NATIVE_INBOX_CACHE_LIMIT),
      sessionNamespace,
    );
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// Idempotent: safe to call on every launch once the user is signed in.
export async function registerInboxBackgroundTask(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    const registered = await TaskManager.isTaskRegisteredAsync(INBOX_BACKGROUND_TASK);
    if (!registered) {
      // minimumInterval is a floor; the OS decides the real cadence.
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
    // ignore
  }
}
