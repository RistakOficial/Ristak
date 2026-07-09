import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import type { Notification, NotificationResponse } from 'expo-notifications';
import type { RistakApiClient } from './api';
import type { WebPushPublicConfig } from './types';

export type NativePushPermissionStatus = 'granted' | 'denied' | 'prompt' | 'unsupported';

export type NativePushSubscriptionResult =
  | { status: 'subscribed' }
  | { status: 'not_supported'; reason: string }
  | { status: 'not_configured'; reason: string }
  | { status: 'denied'; reason: string };

export type NativeNotificationIntent = {
  category: string;
  contactId: string;
  contactAvatarUrl: string;
  title: string;
  body: string;
  messageId: string;
  source: 'received' | 'action';
  url: string;
};

type NotificationData = Record<string, unknown>;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function isNativeMobilePlatform() {
  return Platform.OS === 'android';
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function normalizePermissionStatus(status: unknown, granted?: boolean): NativePushPermissionStatus {
  const clean = String(status || '').toLowerCase();
  if (granted || clean === 'granted') return 'granted';
  if (clean === 'denied') return 'denied';
  if (clean === 'undetermined' || clean === 'prompt' || clean === '') return 'prompt';
  return 'unsupported';
}

function getNativePushConfigurationError(config: WebPushPublicConfig | null) {
  if (Platform.OS === 'android' && !config?.androidConfigured) {
    return 'Las notificaciones de Android todavía no están preparadas para esta instalación.';
  }
  if (!config?.nativeConfigured) {
    return 'Las notificaciones de la app móvil todavía no están preparadas para esta instalación.';
  }
  return '';
}

function getNotificationPath(data: NotificationData) {
  return asString(data.url) || asString(data.route) || '/movil';
}

function getNotificationContactId(data: NotificationData, url: string) {
  const directContactId = asString(data.contactId) || asString(data.contact_id);
  if (directContactId) return directContactId;

  try {
    const parsed = new URL(url, 'https://ristak.local');
    return parsed.searchParams.get('contact') || parsed.searchParams.get('contactId') || '';
  } catch {
    return '';
  }
}

function getNotificationData(notification: Notification) {
  const contentData = (notification.request.content.data || {}) as NotificationData;
  const trigger = notification.request.trigger as {
    payload?: NotificationData;
    remoteMessage?: { data?: NotificationData };
  } | null;

  return {
    ...(trigger?.payload || {}),
    ...(trigger?.remoteMessage?.data || {}),
    ...contentData,
  };
}

function buildNotificationIntent(notification: Notification, source: NativeNotificationIntent['source']): NativeNotificationIntent {
  const data = getNotificationData(notification);
  const url = getNotificationPath(data);
  return {
    category: asString(data.category),
    contactId: getNotificationContactId(data, url),
    contactAvatarUrl: asString(data.contactAvatarUrl) || asString(data.senderAvatarUrl) || asString(data.notificationImageUrl),
    title: notification.request.content.title || asString(data.title),
    body: notification.request.content.body || asString(data.body),
    messageId: asString(data.messageId),
    source,
    url,
  };
}

export async function createAndroidNotificationChannels() {
  if (Platform.OS !== 'android') return;

  await Promise.all([
    Notifications.setNotificationChannelAsync('ristak_alerts', {
      name: 'Alertas con sonido y vibración',
      description: 'Mensajes, citas, pagos y avisos importantes',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    }),
    Notifications.setNotificationChannelAsync('ristak_sound', {
      name: 'Alertas con sonido',
      description: 'Notificaciones de Ristak con sonido y sin vibración',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      enableVibrate: false,
      enableLights: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    }),
    Notifications.setNotificationChannelAsync('ristak_vibrate', {
      name: 'Alertas con vibración',
      description: 'Notificaciones de Ristak con vibración y sin sonido',
      importance: Notifications.AndroidImportance.HIGH,
      sound: null,
      enableVibrate: true,
      enableLights: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    }),
    Notifications.setNotificationChannelAsync('ristak_silent', {
      name: 'Alertas silenciosas',
      description: 'Notificaciones de Ristak sin sonido ni vibración',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: null,
      enableVibrate: false,
      enableLights: false,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    }),
  ].map((task) => task.catch(() => undefined)));
}

export async function getNativePushPermissionStatus(): Promise<NativePushPermissionStatus> {
  if (!isNativeMobilePlatform()) return 'unsupported';

  try {
    const permission = await Notifications.getPermissionsAsync();
    return normalizePermissionStatus(permission.status, permission.granted);
  } catch {
    return 'unsupported';
  }
}

export function configureNativeNotificationListeners(
  onAction: (intent: NativeNotificationIntent) => void,
  onReceived?: (intent: NativeNotificationIntent) => void,
) {
  if (!isNativeMobilePlatform()) return () => undefined;

  const received = Notifications.addNotificationReceivedListener((notification) => {
    onReceived?.(buildNotificationIntent(notification, 'received'));
  });
  const response = Notifications.addNotificationResponseReceivedListener((event: NotificationResponse) => {
    onAction(buildNotificationIntent(event.notification, 'action'));
  });

  try {
    const lastResponse = Notifications.getLastNotificationResponse();
    if (lastResponse) {
      onAction(buildNotificationIntent(lastResponse.notification, 'action'));
      Notifications.clearLastNotificationResponse();
    }
  } catch {
    // Algunos runtimes no exponen last response; los listeners normales cubren el caso principal.
  }

  return () => {
    received.remove();
    response.remove();
  };
}

export async function subscribeToNativePushNotifications(
  api: RistakApiClient,
  { calendarIds = [] }: { calendarIds?: string[] } = {},
): Promise<NativePushSubscriptionResult> {
  if (!isNativeMobilePlatform() || !Device.isDevice) {
    return {
      status: 'not_supported',
      reason: 'Este entorno no puede registrar notificaciones nativas.',
    };
  }

  await createAndroidNotificationChannels();

  let config: WebPushPublicConfig | null = null;
  try {
    config = await api.getPushPublicConfig();
  } catch {
    return {
      status: 'not_configured',
      reason: 'No pude validar la configuración de notificaciones del servidor.',
    };
  }

  const configurationError = getNativePushConfigurationError(config);
  if (configurationError) {
    return {
      status: 'not_configured',
      reason: configurationError,
    };
  }

  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) {
    permission = await Notifications.requestPermissionsAsync();
  }

  if (!permission.granted) {
    return {
      status: 'denied',
      reason: 'Este celular no dio permiso para recibir notificaciones de Ristak.',
    };
  }

  try {
    const nativeToken = await Notifications.getDevicePushTokenAsync();
    const token = typeof nativeToken.data === 'string'
      ? nativeToken.data
      : JSON.stringify(nativeToken.data);

    await api.saveMobilePushDevice({
      token,
      platform: 'android',
      calendarIds,
      appVersion: '',
      appBuild: '',
      deviceModel: Device.modelName || Device.modelId || Device.brand || '',
      osVersion: Device.osVersion || '',
    });

    return { status: 'subscribed' };
  } catch (error) {
    return {
      status: 'denied',
      reason: error instanceof Error ? error.message : 'Este celular no pudo registrarse para alertas.',
    };
  }
}
