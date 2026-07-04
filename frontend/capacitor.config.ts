/// <reference types="@capacitor/push-notifications" />

import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.ristak.app',
  appName: 'Ristak',
  webDir: 'dist',
  bundledWebRuntime: false,
  // Fondo del WebView. Sin esto usa `UIColor.systemBackground` (negro en modo
  // oscuro del sistema). Lo fijamos al fondo claro del chat para que cualquier
  // borde/carga combine con la app en vez de verse negro.
  ios: {
    backgroundColor: '#eef6ff'
  },
  server: {
    androidScheme: 'https'
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'banner', 'list', 'alert']
    },
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#ffffff',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#ffffff',
      overlaysWebView: true
    },
    Keyboard: {
      // 'none': desactiva el resize tardio del plugin; MainViewController publica
      // la altura real del teclado y el chat empuja su superficie con transform.
      resize: 'none',
      style: 'light',
      resizeOnFullScreen: true
    }
  }
}

export default config
