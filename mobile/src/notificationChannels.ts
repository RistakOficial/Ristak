import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

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
