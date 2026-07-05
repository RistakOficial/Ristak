import * as SecureStore from 'expo-secure-store';

const API_BASE_URL_KEY = 'ristak.native.apiBaseUrl.v1';
const AUTH_TOKEN_KEY = 'ristak.native.authToken.v1';

export async function readApiBaseUrl() {
  return (await SecureStore.getItemAsync(API_BASE_URL_KEY)) || '';
}

export async function writeApiBaseUrl(value: string) {
  await SecureStore.setItemAsync(API_BASE_URL_KEY, value);
}

export async function readAuthToken() {
  return (await SecureStore.getItemAsync(AUTH_TOKEN_KEY)) || '';
}

export async function writeAuthToken(value: string) {
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, value);
}

export async function clearAuthToken() {
  await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
}

export async function clearRuntimeState() {
  await Promise.all([
    SecureStore.deleteItemAsync(API_BASE_URL_KEY),
    SecureStore.deleteItemAsync(AUTH_TOKEN_KEY),
  ]);
}

export async function readJsonValue<T>(key: string, fallback: T): Promise<T> {
  const raw = await SecureStore.getItemAsync(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonValue<T>(key: string, value: T): Promise<void> {
  await SecureStore.setItemAsync(key, JSON.stringify(value));
}
