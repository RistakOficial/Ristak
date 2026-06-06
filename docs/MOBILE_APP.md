# Ristak Mobile App

Ristak ya puede compilarse como app nativa iOS/Android con Capacitor. La app usa las mismas pantallas `/phone/*`, pero dentro de un contenedor nativo con cámara, fotos y notificaciones push del celular.

## Requisitos

- Node 22 o superior para usar Capacitor 8.
- Android: JDK instalado para poder correr Gradle/Android Studio.
- iOS: Xcode completo, no solo Command Line Tools.
- `VITE_API_URL` apuntando al backend público HTTPS antes de construir el binario.
- Android: `frontend/android/app/google-services.json` del proyecto Firebase.
- iOS: activar la capability Push Notifications en Xcode y configurar APNs.

## Comandos

Desde `frontend/`:

```bash
npm run mobile:sync
npm run mobile:open:android
npm run mobile:open:ios
```

Si tu terminal sigue en Node 20, usa Node 22 temporal:

```bash
npx -p node@22 -p @capacitor/cli@8.4.0 cap sync
```

## Variables de servidor

Web/PWA:

Estas llaves son opcionales. Si faltan, el servidor crea un par estable una sola vez y lo guarda en la base de datos para que los celulares puedan registrarse desde la versión web/PWA.

```bash
WEB_PUSH_PUBLIC_KEY=
WEB_PUSH_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:soporte@ristak.com
```

Android nativo:

```bash
FCM_PROJECT_ID=
FCM_SERVICE_ACCOUNT_JSON=
```

iOS nativo:

```bash
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_BUNDLE_ID=com.ristak.app
APNS_PRIVATE_KEY=
APNS_ENV=production
```

Para enviar fotos por WhatsApp, el backend debe estar publicado en HTTPS porque WhatsApp/YCloud necesita descargar la imagen desde una URL pública.
