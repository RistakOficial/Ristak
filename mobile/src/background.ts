// Background refresh (iOS Background App Refresh via BGTaskScheduler). When iOS
// grants a background window, this refreshes the inbox into the same disk cache
// the app hydrates from on launch — so opening the app shows fresher data even
// before the foreground fetch completes. iOS controls the cadence (opportunistic,
// typically minutes-to-hours apart, more often for frequently-used apps); this is
// best-effort freshness, not a live stream. Real-time updates still come from the
// existing push notifications and the foreground refresh.
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { readApiBaseUrl, readAuthToken } from './storage';
import { RistakApiClient } from './api';
import { setCacheNamespace, writeCacheNow } from './cache';

export const INBOX_BACKGROUND_TASK = 'ristak-inbox-refresh';

// Must match the inbox cache contract in App.tsx.
const NATIVE_INBOX_CACHE_KEY = 'chats';
const NATIVE_INBOX_CACHE_LIMIT = 200;
const CHAT_LIST_PAGE_SIZE = 50;

// Defined at module scope so iOS can invoke it headlessly on a cold background
// launch (this file is imported from index.ts before the app renders).
TaskManager.defineTask(INBOX_BACKGROUND_TASK, async () => {
  try {
    const [baseUrl, token] = await Promise.all([readApiBaseUrl(), readAuthToken()]);
    if (!baseUrl || !token) return BackgroundTask.BackgroundTaskResult.Success;
    setCacheNamespace(baseUrl);
    const api = new RistakApiClient(baseUrl, token);
    const data = await api.getChats('', 0, CHAT_LIST_PAGE_SIZE);
    const chats = Array.isArray(data) ? data : [];
    if (chats.length) {
      // Immediate write: the JS runtime is suspended as soon as we resolve.
      await writeCacheNow(NATIVE_INBOX_CACHE_KEY, chats.slice(0, NATIVE_INBOX_CACHE_LIMIT));
    }
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
      // minimumInterval is a floor; iOS decides the real cadence.
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
