# Ristak Mobile App

Ristak ya puede compilarse como app nativa iOS/Android con Capacitor. La app usa las mismas pantallas móviles bajo `/movil`, pero dentro de un contenedor nativo con cámara, fotos y notificaciones push del celular. Las rutas legacy `/phone/*` redirigen a `/movil/*`.

En iOS el contenedor nativo está configurado como app de iPhone/iPad enfocada en `/movil`. Al abrir desde Xcode o desde el icono del celular, primero resuelve la empresa contra el portal central, guarda la URL pública de la instalación del cliente y después arranca el login/chat móvil contra ese Render.

Orientación: iPhone usa portrait; iPad usa landscape para que la lista de chats y la conversación se vean completas. En web/PWA, si una tablet abre el chat en portrait, la pantalla muestra un aviso para girarla.

Zoom: las rutas moviles (`/movil/*` y legacy `/phone/*`) bloquean zoom accidental
en el WebView para evitar que la app quede atorada ampliada. El candado vive en
tres capas: viewport `user-scalable=no` solo mientras la ruta movil esta activa,
bloqueo de gestos pinch/doble tap/trackpad dentro del shell movil y ajustes
nativos en iOS/Android para mantener el WebView en escala `1.0`. Los inputs de la
app movil deben conservar fuente de al menos `16px` para evitar el zoom de foco
de iOS.

## Requisitos

- Node 22 o superior para usar Capacitor 8.
- Android: JDK instalado para poder correr Gradle/Android Studio.
- iOS: Xcode completo, no solo Command Line Tools.
- Web/Android de una sola instalación: `VITE_API_URL` apuntando al backend público HTTPS antes de construir el binario.
- iOS multi-cliente: `VITE_INSTALLER_API_URL` puede apuntar al portal central; si falta usa `https://www.ristak.com`.
- Android: `frontend/android/app/google-services.json` del proyecto Firebase.
- iOS: activar la capability Push Notifications en Xcode y configurar APNs.

## Comandos

Desde `frontend/`:

```bash
npm run mobile:sync
npm run mobile:open:android
npm run mobile:open:ios
```

Para preparar y subir a App Store Connect el shell iOS enfocado en `/movil`, usa la guía específica en `docs/APP_STORE_IOS.md`.

Si tu terminal sigue en Node 20, usa Node 22 temporal:

```bash
npx -p node@22 -p @capacitor/cli@8.4.0 cap sync
```

## Icono de instalación

El icono público de la app móvil usa el isotipo de Ristak. iOS usa variantes
nativas por apariencia: `AppIcon-light-1024.png` para modo claro,
`AppIcon-dark-1024.png` para modo oscuro y `AppIcon-tinted-1024.png` alineado al
icono claro mientras no exista un asset tinted dedicado. Android usa el icono
claro como launcher base y mantiene recursos `mipmap-night-*` para el icono
oscuro cuando el sistema/launcher respeta recursos nocturnos.

Los assets nativos y PWA deben mantenerse sincronizados para que el icono sea
consistente en App Store, Play Store, Android launcher y "Agregar a pantalla de
inicio":

- iOS: `frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/`.
- Android: `frontend/android/app/src/main/res/mipmap-*/ic_launcher*.png`,
  `frontend/android/app/src/main/res/mipmap-night-*/ic_launcher*.png` y los
  fondos adaptive en `frontend/android/app/src/main/res/values*/ic_launcher_background.xml`.
- Web/PWA móvil: `frontend/public/ristak-chat-icon-*`,
  `frontend/public/ristak-chat-home-icon-*` y los `apple-touch-icon` móviles.

## Tema visual móvil

El tema de producto de `/movil` usa la paleta del isotipo móvil de Ristak: azul
profundo para modo oscuro, azul Ristak como primario y cian como acento. El verde
ya no debe usarse como acento global de la app porque hace que la experiencia se
sienta como WhatsApp.

Tokens principales:

- Base global: `frontend/src/styles/index.css` bajo
  `data-phone-chat-theme='active'`.
- Chat móvil: `frontend/src/pages/PhoneChat/PhoneChat.module.css`.
- Componentes compartidos móviles: `frontend/src/components/phone/` y
  `frontend/src/components/phone/ui/` deben heredar `--phone-chat-accent` y
  `--phone-chat-primary`.

Regla de criterio: el verde se reserva para marca WhatsApp
(`--phone-channel-whatsapp`, `WhatsAppBrandLogo`, iconos/canal WhatsApp) o para
estados semánticos de éxito. Botones, tabs, badges, loaders, inputs, gráficas y
defaults visuales de la app deben usar el azul/cian de Ristak.

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

## Gotchas (no repetir)

- **Íconos de marca rellenos + `stroke-width` = contorno grueso / "pixelado".**
  Los íconos de `react-icons` (`FaWhatsapp`, `SiWhatsapp`, `FaFacebookMessenger`,
  `FaInstagram`, `Ri*Fill`…) se renderizan con `stroke="currentColor"`. Una regla
  de contenedor como `.composerChannelButton svg { stroke-width: N }` o
  `.avatarChannelBadge svg { stroke-width: N }` les pinta un **contorno encima del
  relleno** y el glifo se ve grueso/pixelado. Pasó con el WhatsApp del composer y
  de los avatares al "adelgazar" los íconos del chat: el `stroke-width` se filtró
  a los glifos de marca. El `stroke-width` va **solo** en íconos de línea
  (lucide/feather, `fill:none`), nunca en un `svg` contenedor que también cacha
  glifos de marca. Detalle y regla en `docs/DESIGN_SYSTEM.md` §5 (#12).
- **Verifica cambios de UI móvil corriendo la app real, no con renders SVG
  aislados.** Un SVG suelto se ve bien porque no arrastra la cascada del
  contenedor (tamaño, stroke, disco); el bug solo aparece dentro del chat. Levanta
  el front (`/movil`) y míralo.
- **"No cambió nada" casi siempre es el build/deploy, no el código.** `/movil`
  corre un **build estático**: la web la sirve Render tras `push → workflow
  docker-image → deploy` (~2–3 min, ver `docs/DEPLOY-RENDER.md`), y la app nativa
  empaqueta `frontend/dist` al compilar. Un `git push` **no** actualiza nada hasta
  que ese build termina. Para comprobar la web recarga en **pestaña privada**
  (evita caché); la **app instalada** no se actualiza con el push — hay que
  recompilarla (`docs/MOBILE_STORE_RELEASES.md`).

## Íconos de WhatsApp en el chat (`/movil`) — dónde ajustar

Hay **dos** íconos de WhatsApp distintos, con estilos separados. No los confundas.

**1. Ícono del composer** (botón de canal, abajo, junto al `+`, donde se escribe).

- Se dibuja en `renderComposerMessageChannelIcon` (`frontend/src/pages/PhoneChat/PhoneChat.tsx`) con `<FaWhatsapp>`: glifo **fino, plano, verde, sin relleno ni disco**.
- Color: lo pone el contenedor `.composerChannelButton[data-channel="whatsapp_api"]` (verde).
- Tamaño: `.composerChannelButton .channelIconGlyph` en `PhoneChat.module.css` (20px).
- ⚠️ **NO** le pongas `stroke-width` en `.composerChannelButton svg`: engrosa el contorno del glifo relleno y se ve "ancho/pixelado" (ver `docs/DESIGN_SYSTEM.md` §5 #12).

**2. Logo de WhatsApp de los avatares** (badge en la esquina inferior del avatar, en la lista de chats y en el header). Es el **logo oficial a 3 tonos** armado a mano.

- Componente: `WhatsAppBrandLogo` (cerca del inicio de `PhoneChat.tsx`). Dos paths:
  `WHATSAPP_LOGO_BUBBLE_PATH` (burbuja) y `WHATSAPP_LOGO_HANDSET_PATH` (auricular).
- Se usa en `renderChannelBadgeIcon` (rama `kind === 'whatsapp'`), con la clase `avatarWhatsappLogo`.

Perillas (todas con sus valores actuales):

| Qué quieres cambiar | Dónde | Valor actual |
|---|---|---|
| **Tamaño del logo** | `.avatarChannelBadge .avatarWhatsappLogo` en `PhoneChat.module.css` → `width`/`height` (% del badge, **con `!important`**) | `90%` (~17px) |
| **Grosor del contorno/borde blanco** | `WhatsAppBrandLogo` en `PhoneChat.tsx` → `strokeWidth` del path de la **burbuja** | `5.3` |
| **Grosor del auricular (el "tel" de adentro)** | `WhatsAppBrandLogo` → `strokeWidth` del path del **auricular** | `0.5` |
| **Verde / blanco** | `WhatsAppBrandLogo` → `fill`/`stroke` | `#25D366` / `#ffffff` |

Reglas al tocarlo:

- El tamaño **necesita `!important`**: hay reglas por dispositivo
  (`.phoneChatPage[data-phone-chat-device="phone"] .chatItem > .avatar .avatarChannelBadge svg { width: 11px }`, etc.)
  que le ganan en especificidad y lo encogen en la **lista de chats** si no.
- El badge de WhatsApp va **sin fondo** (transparente, sin círculo verde ni sombra):
  clase `.avatarChannelBadgeWhatsappLogo`, asignada en `getAvatarChannelBadgeClass`.
  El borde blanco del propio logo es lo que lo separa del avatar.
- Verifícalo corriendo la app en la **lista de chats** (no solo el header: el header
  no tiene las reglas por dispositivo, así que puede engañar). Si la lista local está
  vacía, revisa al menos el header + los tamaños computados.
