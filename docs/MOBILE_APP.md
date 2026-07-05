# Ristak Mobile App

Ristak tiene dos superficies moviles que deben mantenerse coordinadas:

- Produccion actual: shell Capacitor bajo `/movil`, construido desde
  `frontend/`, `frontend/ios/App` y `frontend/android`. Este sigue usando el
  bundle/package de tienda `com.ristak.app`.
- Cliente nativo nuevo: app React Native/Expo en `mobile/`. No carga el CRM
  completo en un WebView; habla directo con el backend de Ristak por API. Durante
  la migracion usa bundle/package separado `com.ristak.native` para poder
  convivir con la app publicada. Solo debe tomar `com.ristak.app` cuando se haya
  validado en iPhone/Android reales y se decida reemplazar el binario de tienda.

Regla obligatoria de mantenimiento: cualquier cambio de producto movil, chat,
login, permisos, push, pagos, agenda, filtros, labels visibles o contrato de API
debe revisarse tanto en `/movil` como en `mobile/`. Si el cambio aplica a las dos
apps, se implementa en las dos. Si aplica solo a una, el resumen del cambio debe
decir por que y esta guia debe actualizarse cuando cambie el comportamiento
visible.

Contrato de paridad nativa: `mobile/` puede usar React Native, Expo y componentes
nativos diferentes, pero el resultado para el usuario debe ser identico a
`/movil`: mismas secciones, orden de navegacion, nombres visibles, jerarquia
visual, flujos, permisos y estados. No se permite redisenar, simplificar o
"mejorar" una pantalla nativa dejando atras funcionalidad existente de `/movil`
sin documentar explicitamente la decision y su motivo.

En la bandeja de chats nativa, los bottom sheets reutilizables (`Mas`, `+` /
nuevo chat y selector posterior a camara) deben atenuar el fondo con fade
independiente y mover solo el panel. No metas el scrim oscuro dentro de una
animacion `slide`: se ve como un bloque sombreado subiendo. El cierre debe
mantener el contenido vivo hasta terminar la animacion para poder reabrir el
mismo sheet/contacto sin que se trabe.

El sheet nativo `Mas acciones` debe mantenerse como espejo operativo del sheet
de `PhoneChat`: agendar cita, registrar pagos, programar mensaje, agregar
etiqueta, silenciar/quitar silencio y controles del agente. Si una accion aun
no tiene formulario nativo completo, debe navegar a la seccion nativa
correspondiente o dejar documentada la brecha en
`docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`; no debe desaparecer del menu.

El avance por fases de esa paridad vive en
`docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`. Antes de retomar la migracion nativa,
lee ese checklist para saber que ya quedo, que sigue pendiente y que fuentes del
codigo original deben revisarse.

## Shell Capacitor `/movil`

Ristak ya puede compilarse como app nativa iOS/Android con Capacitor. La app usa
las mismas pantallas moviles bajo `/movil`, pero dentro de un contenedor nativo
con camara, fotos y notificaciones push del celular. Las rutas legacy `/phone/*`
redirigen a `/movil/*`.

En iOS el contenedor nativo está configurado como app de iPhone/iPad enfocada en `/movil`. Al abrir desde Xcode o desde el icono del celular, primero resuelve la empresa contra el portal central, guarda la URL pública de la instalación del cliente y después arranca el login/chat móvil contra ese Render.

El bundle iOS principal debe declarar español como region de desarrollo y
localizacion soportada (`CFBundleDevelopmentRegion=es` y
`CFBundleLocalizations=[es]`) para que controles nativos como la camara de
Capacitor muestren acciones del sistema en español en vez de `Retake` /
`Use Photo`.

Orientación: iPhone usa portrait; iPad usa landscape para que la lista de chats y la conversación se vean completas. En web/PWA, si una tablet abre el chat en portrait, la pantalla muestra un aviso para girarla.

Zoom: las rutas moviles (`/movil/*` y legacy `/phone/*`) bloquean zoom accidental
en el WebView para evitar que la app quede atorada ampliada. El candado vive en
tres capas: viewport `user-scalable=no` solo mientras la ruta movil esta activa,
bloqueo de gestos pinch/doble tap/trackpad dentro del shell movil y ajustes
nativos en iOS/Android para mantener el WebView en escala `1.0`. Los inputs de la
app movil deben conservar fuente de al menos `16px` para evitar el zoom de foco
de iOS.

Teclado movil: en iOS el shell usa `Keyboard.resize = none` para desactivar el
resize tardio del plugin de Capacitor. El `MainViewController.swift` lee del
evento nativo del teclado la altura, duracion y curva reales, y publica
`--phone-kb`, `--phone-kb-dur` y `--phone-kb-ease` una vez por evento. El chat
mueve la superficie de conversacion completa (`messagesPane` + `composerShell`)
con un `transform` GPU; no se debe mover solo el composer ni redimensionar el
`WKWebView`. `PhoneChat` no inventa alturas, duraciones, curvas ni estados de
apertura desde `touchstart`, `focusin`, `focusout`, `localStorage` o
`visualViewport`; solo desenfoca el composer al tocar fuera y estabiliza el
scroll. `data-phone-chat-keyboard` tambien lo controla el bridge nativo: se
activa al abrir y se retira despues de la duracion real de cierre para que el
fondo detras del teclado conserve el mismo color del panel del composer durante
toda la animacion. No uses `visualViewport` con `transition: none` para mover el
chat: en iOS puede llegar en bloque y hacer que el composer desaparezca hasta la
posicion final. El shell iOS recibe el `--phone-chat-composer-bg` computado del
root del chat para pintar la `UIWindow` detras del teclado con el mismo color
real del panel del composer, sin dejar esquinas ni cortes de otro color. En
Android, `resizeOnFullScreen` y
`android:windowSoftInputMode="adjustResize"` mantienen el ajuste nativo del IME.
El contenedor Android tambien publica los insets reales de status/navigation bar
desde `MainActivity.java` hacia el WebView como
`--phone-native-safe-area-top/right/bottom/left`; `frontend/src/styles/index.css`
los normaliza en las variables globales `--phone-safe-area-top/right/bottom/left`.
Todas las pantallas y componentes del shell `/movil` deben consumir esas
variables globales, no `env(safe-area-inset-*)` directo, para que Chat, Ajustes,
Calendario, Pagos, Analiticas, login, sheets y modales compartan el mismo
contrato. Android WebView puede reportar `env(safe-area-inset-*)` en cero aunque
`StatusBar.overlaysWebView` este activo. Esos insets nativos llegan en pixeles
fisicos de Android y deben convertirse a pixeles CSS antes de publicarse; si se
pasan crudos, el header superior de `/movil` queda inflado en pantallas con
densidad alta y desperdicia espacio util.
No vuelvas a meter `scrollTo(0,0)` por frame desde `visualViewport.scroll`: eso
mete lag al scroll del chat y pelea con el dedo del usuario.

El selector de destinatarios que aparece al tomar foto/video desde la bandeja de
`/movil` tambien debe participar en este contrato: su composer debe estar marcado
con `data-phone-chat-composer="true"` y el footer debe subir con `--phone-kb`
cuando el teclado iOS abre, sin desplazar la ventana completa ni inventar una
altura fija de teclado.

Formularios moviles y login: fuera del composer del chat, el guardian global
`keyboardFocusScroll` debe seguir activo aunque el bridge nativo haya marcado
`data-phone-chat-keyboard`. Los campos de texto dentro de superficies marcadas
con `data-phone-scrollable="true"` se desplazan dentro de su scroller local para
quedar por encima del teclado, usando `visualViewport` y
`--phone-keyboard-inset`; no se debe desplazar la ventana completa ni bloquear el
scroll local del formulario. Si una pantalla movil necesita que el teclado iOS
siga el color real de su fondo, marca la superficie con
`data-phone-keyboard-theme-surface="true"` y sincroniza el shell con
`mobileAppService.syncShellBackgroundFromElement(...)`. El servicio calcula la
luminancia del fondo computado y aplica `KeyboardStyle.Dark` o
`KeyboardStyle.Light`, ademas de status bar y fondo nativo de la ventana, para
evitar teclados claros sobre pantallas oscuras o cortes de color detras del IME.

## Requisitos

- Node 22 o superior para usar Capacitor 8.
- Node 22.x o superior para la app React Native/Expo en `mobile/`. La toolchain
  de Expo SDK 57 / React Native 0.86 no debe validarse con Node 20.18.
- Android: JDK instalado para poder correr Gradle/Android Studio.
- iOS: Xcode completo, no solo Command Line Tools.
- Web/Android de una sola instalación: `VITE_API_URL` apuntando al backend público HTTPS antes de construir el binario.
- iOS multi-cliente: `VITE_INSTALLER_API_URL` puede apuntar al portal central; si falta usa `https://www.ristak.com`.
- Android: `frontend/android/app/google-services.json` del proyecto Firebase.
  Este archivo vive fuera de Git y debe pertenecer al paquete `com.ristak.app`.
- iOS: activar la capability Push Notifications en Xcode y configurar APNs.

## Comandos

Desde la raiz del repo para el cliente React Native nuevo:

```bash
npm run mobile:native:start
npm run mobile:native:ios
npm run mobile:native:android
npm run mobile:native:prebuild
npm run mobile:native:typecheck
```

`mobile/ios` y `mobile/android` son generados por Expo Continuous Native
Generation con `npm run mobile:native:prebuild`. Deben tratarse como
descartables salvo que una personalizacion nativa se promueva deliberadamente a
codigo versionado.

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
  Las notificaciones Android usan `@drawable/ic_stat_ristak` como small icon
  del sistema. El backend FCM no debe mandar un bloque visual `notification`
  para Android: debe mandar data-only para que `RistakFirebaseMessagingService`
  pinte el avatar, logo y previews con el renderer nativo propio.
- Web/PWA general: `frontend/public/ristak-icon-192.png`,
  `frontend/public/ristak-icon-512.png`, `frontend/public/apple-touch-icon.png`
  y las variantes transparentes `frontend/public/ristak-app-mark-*.webp` usadas
  por login y pantallas de carga.
- Web/PWA móvil: `frontend/public/ristak-chat-icon-*`,
  `frontend/public/ristak-chat-home-icon-*` y los `apple-touch-icon` móviles.

Las push de mensajes, citas y pagos deben intentar mostrar el avatar del
contacto cuando el payload pertenece a exactamente un contacto y existe una foto
publica. El avatar del contacto viaja solo en `contactAvatarUrl` y
`senderAvatarUrl`; no debe copiarse a `notificationImageUrl`. Si no hay foto,
son varios contactos o la alerta es general, se usa el isotipo de Ristak.

`notificationImageUrl` y `notificationAttachmentUrl` quedan reservados para
contenido multimedia real del mensaje, por ejemplo una foto, video o gif que el
contacto mando. En ese caso iOS puede mostrar el preview como attachment de la
notificacion y, al mismo tiempo, mostrar el avatar del contacto como remitente.
No uses esos campos para avatares: iOS los pinta como miniatura lateral de
media, no como foto del contacto.

Para fotos entrantes del chat, si el proveedor manda texto generico como `Foto`,
`Image` o `Imagen`, la push debe reemplazarlo por `📷 Envió una foto.` y mandar la
foto real en `notificationImageUrl`/`notificationAttachmentUrl` para que iOS la
muestre como preview lateral, estilo WhatsApp. Si el mensaje trae caption real,
se respeta ese texto como cuerpo de la notificacion y la imagen sigue viajando
como attachment.

Para notas de voz y documentos entrantes, la push tampoco debe quedarse en
`Audio` o `Documento`: si hay duracion debe mostrar `🎤 Mensaje de voz (0:02)`,
y si hay nombre de archivo debe mostrar `📄 <archivo.ext>` con conteo de paginas
cuando el proveedor lo mande. Estos casos no usan `notificationImageUrl` porque
no son previews laterales de imagen/video.

Para ubicaciones entrantes, la push debe mostrar `📍 Ubicación` y no debe usar
`notificationImageUrl` / `notificationAttachmentUrl`; la ubicación no es media
lateral. En el chat móvil, los mensajes `location` se renderizan como una
tarjeta tipo mapa con pin y enlace a Google Maps usando las coordenadas
guardadas en el payload del proveedor. El preview visual usa tiles HTTPS de
OpenStreetMap (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`) solo para las
tarjetas visibles y debe mantener atribucion `© OpenStreetMap contributors`; no
debe hacer prefetch masivo, descargas offline ni scraping. No uses
Nominatim/reverse geocoding publico como buscador generico o enriquecedor
automatico desde el cliente: si algun dia se necesita direccion enriquecida,
debe pasar por un proveedor/servicio propio con cache y politica de uso
revisada. El botón `+ > Ubicación` comparte la ubicación actual del dispositivo:
por WhatsApp API oficial o QR se manda como mensaje nativo de ubicación; por
Messenger, Instagram o HighLevel se manda como texto con link de mapa cuando no
exista soporte nativo verificado. iOS requiere
`NSLocationWhenInUseUsageDescription` en `frontend/ios/App/App/Info.plist`.

En Android el small icon del sistema sigue siendo `ic_stat_ristak` porque
Android exige un icono monocromatico de la app. El payload FCM de Android debe
ser data-only: `title`, `body`, `contactAvatarUrl`/`senderAvatarUrl`,
`notificationImageUrl`/`notificationAttachmentUrl`, `threadId`, `messageId`,
`url` y `androidChannelId` viajan en `message.data`. El servicio nativo
`frontend/android/app/src/main/java/com/ristak/app/RistakFirebaseMessagingService.java`
reemplaza el `MessagingService` generico de Capacitor, conserva el registro de
token llamando a `PushNotificationsPlugin.onNewToken(...)` y renderiza las push
con `MessagingStyle`, `largeIcon` circular del avatar cuando existe y AppIcon de
Ristak cuando no hay avatar. Si llega media real, la muestra con
`BigPictureStyle` y mantiene el avatar/logo como large icon. No vuelvas a usar
`message.notification` ni `android.notification.image` para Android porque el
sistema/Firebase toma el control visual y se pierden avatar, logo correcto y
estilo de conversación.

En iOS/APNs el payload incluye `mutable-content` cuando existe
`contactAvatarUrl`/`senderAvatarUrl` o media real. La extension
`RistakNotificationService` usa Communication Notifications con
`INSendMessageIntent` para que el avatar sea la identidad del remitente, y solo
adjunta `notificationImageUrl` / `notificationAttachmentUrl` como media del
mensaje. La app principal debe tener el entitlement
`com.apple.developer.usernotifications.communication` y los perfiles de firma
deben incluir esa capability. Si el avatar no existe, la descarga falla, hay
varios contactos o la alerta es general, iOS muestra el AppIcon instalado de
`frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/`.

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
(`--phone-channel-whatsapp`, `PhoneMessageChannelIcon`, iconos/canal WhatsApp) o
para estados semánticos de éxito. Botones, tabs, badges, loaders, inputs,
gráficas y defaults visuales de la app deben usar el azul/cian de Ristak.
Las acciones laterales por swipe y los menús/bottom sheets móviles también deben
usar `--phone-chat-primary`, `--phone-chat-text-on-primary`,
`--phone-chat-surface`, `--phone-chat-panel`, `--phone-chat-border` y
`--phone-chat-sheet-shadow`; no uses verdes heredados ni fondos beige/verdosos
fijos para paneles como "Agendar con".

## Lista de chats nativa

En `mobile/`, la lista de chats debe mantener paridad visual y tactil con
`/movil`: los filtros horizontales arrancan pegados al margen util de la
pantalla y no deben auto-centrarse dejando chips cortados en los laterales. Las
filas deben ser suficientemente altas para lectura tactil, con avatar grande y
acciones laterales del mismo alto real de la fila.

El swipe de una fila debe responder con umbral bajo: un arrastre corto hacia la
izquierda abre `Mas` y `Archivar/Restaurar`; si la fila ya esta abierta, un
arrastre corto hacia la derecha la cierra. La animacion debe ser suave y no debe
rebotar a abierto/cerrado por un umbral grande despues de soltar.

Las fechas de la lista de chats se formatean con la zona horaria del negocio:
`Hoy`, `Ayer`, dia de la semana para los ultimos 2 a 6 dias, y despues fecha
corta como `04-jul`. No uses una fecha fija para mensajes de hoy.

## Remitente de WhatsApp en chat movil

En `/movil`, el boton de canal del composer debe listar cada WhatsApp conectado
como opcion separada cuando la cuenta tiene mas de un remitente. Elegir
`WhatsApp · <nombre/numero>` cambia el envio puntual del chat abierto y el
mensaje sale con ese `phoneNumberId`; no debe obligar al usuario a ir al
desktop para elegir entre WhatsApp 1, WhatsApp 2, etc.

La info del contacto muestra "Contactando desde". Ese sheet es el control
persistente del contacto: `Automatico` limpia `preferred_whatsapp_phone_number_id`
para usar el numero por donde llego la conversacion o el principal actual; elegir
un numero fijo guarda `preferred_whatsapp_phone_number_id` en el contacto. Si el
numero mostrado por automatico coincide con el que el usuario toca, igual debe
guardarse como fijo; no cierres el sheet solo porque visualmente ya era el
numero activo.

## Agenda de citas desde el chat movil

El sheet de `Agendar cita` dentro de una conversacion puede abrirse en dos modos:
formulario completo o calendario mensual. El boton de calendario del encabezado
del sheet cambia entre ambos modos y guarda la preferencia por usuario en
`user_config.mobile_chat_appointment_entry_mode`, con valores `form` o
`calendar`.

El modo calendario solo aparece cuando hay un contacto activo bloqueado para la
cita. Mantiene el selector de calendario arriba, pinta una vista mensual unica
sin semana/dia/anio, permite cambiar de mes con flechas o swipe horizontal y
despues pide hora, duracion, ubicacion e invitados. La fecha y hora se convierten
a UTC usando la zona horaria de la cuenta; no debe depender de la zona horaria
del navegador. Al guardar usa el mismo endpoint de citas que el formulario
normal y respeta bloqueos nativos del calendario antes de crear la cita.

## Filtros de la bandeja del chat movil

La bandeja de `/movil` no debe volver a mostrar el dropdown `Numero / Ver todos`
ni el ajuste separado de "Números de WhatsApp". La fuente visible para filtrar la
lista son los chips bajo el buscador. El chip `+` abre una biblioteca de filtros:
tocar `Agregar` manda ese filtro a la fila principal de rapidos y lo guarda de
inmediato en `app_config.mobile_chat_filter_chip_ids`; tocar `Quitar` lo elimina
de esa fila. `Todos` queda fijo.

Esa biblioteca debe incluir los filtros rapidos del chat movil, la entrada de
`Comentarios`, cada WhatsApp conectado cuando hay mas de un numero y las familias
avanzadas equivalentes a desktop: canal, origen, red social, etapa y actividad.
Los filtros por numero simples siguen usando `mobile_chat_selected_whatsapp_phone_id`
y mandando `businessPhoneNumberId`/`businessPhone` a `/contacts/chats`; solo
cambio la superficie de control. El chip `Comentarios` va separado de
`Interesados` con una linea divisoria, igual que la bandeja desktop separa
comentarios de filtros normales.

El administrador tambien permite crear filtros condicionales guardados. Esos
presets viven en `app_config.mobile_chat_custom_filter_presets`, aparecen como
chips normales al guardarlos y pueden editarse o eliminarse desde el mismo panel.
Cada filtro condicional define si deben coincidir todas las reglas o cualquiera
de ellas, y puede combinar segmento del chat, numero de WhatsApp, canal, origen,
red social, etapa, actividad, etiquetas y campos personalizados. Las condiciones
usan operadores compatibles con Contactos/Automatizaciones cuando aplican:
contiene, no contiene, es igual, no es igual, vacio/no vacio, si/no y
comparaciones numericas para campos numericos.

Los avatares de contacto son parte de la identidad de Ristak: si el contacto
tiene foto real de la red social, se respeta esa foto; si no tiene foto, el
fallback muestra iniciales sobre `--phone-chat-avatar-fill` azul/cian Ristak. El
origen social del contacto sólo debe vivir en el aro exterior del avatar
(`--avatar-ring-color`) y en el badge/icono de canal (`.avatarChannelBadge*`).
No vuelvas a usar verde WhatsApp, rosa Instagram o azul Messenger como relleno
completo del avatar de iniciales.

La bandeja nativa en `mobile/src/App.tsx` debe seguir esta misma regla de paridad:
header de chats con acciones superiores, buscador tipo pill, chips horizontales
(`Todos`, `No leídos`, `Citas`, `Clientes`, `Leads`, `Comentarios`, `+`) y filas
planas con separador desde el bloque de texto. Los filtros se calculan con los
mismos campos que `/movil` recibe de `/api/contacts/chats`: `unreadCount`,
`status`, `purchases`/`ltv`, `hasAppointments`/`nextAppointmentDate`,
`lastMessageType`, `hasCommentMessage`, `lastMessageChannel`,
`lastMessageTransport` y señales de origen. El preview debe respetar el texto del
último mensaje, caer a labels de media (`Foto`, `Video`, `Audio`, `Documento`,
`Ubicación`, `Comentario`) y prefijar mensajes salientes con `Tú:` en la
superficie final. El avatar nativo debe mantener iniciales/foto en relleno
Ristak y reservar el color de red social para aro/badge, igual que
`PhoneChat.module.css`.

La lista de chats nativa tambien debe replicar los gestos principales de
`PhoneChat`: deslizar una fila hacia la izquierda revela `Mas` y
`Archivar`/`Restaurar`; mantener presionada una fila entra en seleccion
multiple; durante seleccion se ocultan los chips de filtro, aparece un panel con
conteo, `Seleccionar visibles`, cancelar y `Mas acciones`; y las acciones
masivas minimas son marcar como leidos via `/contacts/chats/read` y
archivar/restaurar la seleccion. Si `Mas` aun usa un menu nativo temporal en
`mobile/`, el sheet completo de `/movil` debe quedar registrado como brecha en
`docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`.

El cliente React Native debe usar bottom sheets nativos para acciones de bandeja,
no `Alert.alert`, cuando el flujo existe como sheet en `/movil`: `Mas` de la
fila, `+` de nuevo chat y selector de destinatarios despues de tomar foto. La
camara nativa usa `expo-image-picker`, requiere `NSCameraUsageDescription` y
debe abrir una pantalla/sheet de destinatarios antes de enviar; si el envio
multimedia todavia no esta conectado al composer/canal, esa brecha debe quedar
en `docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`.

La conversacion nativa en `mobile/src/App.tsx` debe cargar el mismo journey
recortado que `/movil` (`/contacts/:id/journey` con `chatMessagesOnly` y
`messageLimit`), agrupar mensajes por dia usando la zona horaria del negocio,
mostrar avatar/badge de canal en el header y exponer acciones equivalentes por
bottom sheet: adjuntos/camara, agendar cita, registrar pagos, programar mensaje,
agregar etiqueta, silenciar, archivar/restaurar y controles de agente. El
composer nativo manda texto por `/whatsapp-api/messages/text` y fotos por
`/whatsapp-api/messages/image`; cualquier canal pendiente (QR, HighLevel,
Messenger, Instagram, email/SMS, audio/video/documentos completos) debe quedar
marcado como brecha en `docs/MOBILE_NATIVE_PARITY_CHECKLIST.md` hasta que use el
mismo contrato que `/movil`.

En la conversación móvil no uses rails/barras verticales pegadas al lado
izquierdo como indicador visual de foco, comentario o chat no leído. Los estados
de no leído/activo deben resolverse con fondo, tipografía y badge, no con una
franja lateral. Las etiquetas de canal dentro de los globos (`messageTransport`)
son micro-etiquetas sin contorno y con abreviaturas: `IG`, `FB`, `API` y `QR`.
El globo de texto del agente IA (`agentStatusBubble`) conserva su forma, pero su
color debe salir de `--phone-chat-primary`/`--phone-chat-accent`, no de verdes
tipo estado o WhatsApp.

Los correos que llegan a `email_messages` tambien deben aparecer en `/movil`
como globos desplegables de correo. El mapper del journey movil debe aceptar
eventos `email_message` y conservar asunto, remitente, destinatarios, responder
a, estado, transporte y cuerpo. No los conviertas a texto plano de WhatsApp ni
los ocultes de la conversacion movil; el usuario debe poder abrir el detalle del
correo desde el celular.

En `/movil`, responder un globo normal se activa con el mismo gesto de la
conversacion: deslizar el globo hacia la derecha abre la barra/cajita de
respuesta del composer y selecciona ese mensaje como quote. Al enviar, debe
mandarse una respuesta nativa cuando el canal lo soporte: WhatsApp API/YCloud
con `context.message_id`, WhatsApp QR/Baileys con `quoted`,
Messenger/Instagram con `reply_to.mid`. La UI debe mostrar el quote dentro del
globo enviado y debe bloquear respuestas con media/ubicacion hasta que esos
canales tengan soporte nativo completo. Las reacciones se muestran como chips
pegados al globo original: WhatsApp acepta emoji, Meta solo debe
ofrecer/aceptar corazon (`love`) por contrato, y HighLevel/email/comentarios
deben avisar que no hay reaccion nativa en vez de crear un mensaje falso.

El feedback haptico de interaccion movil vive en `mobileAppService`. Al dejar
pulsado un chat, `/movil` debe disparar haptic cuando entra a seleccion; al
dejar pulsado un globo, debe dispararlo cuando abre el menu de acciones. Este
feedback no depende de `push_notification_vibration_enabled`, porque esa
preferencia controla alertas/notificaciones, no la respuesta tactil de la UI.

## Variables de servidor

Web/PWA:

Estas llaves son opcionales. Si faltan, el servidor crea un par estable una sola vez y lo guarda en la base de datos para que los celulares puedan registrarse desde la versión web/PWA.

```bash
WEB_PUSH_PUBLIC_KEY=
WEB_PUSH_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:soporte@ristak.com
```

Android nativo:

En produccion managed, la ruta recomendada es que Ristak Installer concentre las
credenciales de envio FCM y reporte `androidConfigured=true` en
`/api/license/mobile-push/status`; entonces la instalacion cliente registra el
token del celular y delega el envio al portal central. Si una instalacion
standalone necesita enviar Android sin Installer, debe configurar FCM localmente
en su backend.

```bash
FCM_PROJECT_ID=
FCM_SERVICE_ACCOUNT_JSON=
```

`FCM_SERVICE_ACCOUNT_JSON` es secreto de servidor y nunca debe commitearse. El
`google-services.json` de Android tampoco se commitea en este repo; se coloca en
`frontend/android/app/google-services.json` antes de compilar el binario de
tienda.

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
- **Las publicaciones FB/IG dentro de globos de comentario no deben ensanchar el
  chat.** Las tarjetas que muestran la publicación comentada viven dentro del
  ancho del globo y del panel de mensajes; usa limites relativos al contenedor
  (`max-width: 100%`, `min-width: 0`, `box-sizing: border-box`) y evita minimos
  basados en `vw` que puedan sumar padding/bordes y abrir scroll horizontal en
  respuestas salientes.
- **Swipe de comentarios en el chat móvil:** deslizar un comentario FB/IG hacia
  la derecha debe activar la misma respuesta publica al comentario que el boton
  "Responder en la publicacion". El swipe hacia la izquierda conserva la ficha de
  info del mensaje; no cruces ambos comportamientos ni uses ese gesto para mandar
  DM privado.
- **Swipe de mensajes en el chat móvil:** deslizar un globo normal hacia la
  derecha debe abrir la cajita de respuesta del composer para contestar ese
  globo especifico. El mismo gesto no debe abrir el menu largo; el menu puede
  quedar como fallback, pero el flujo primario debe ser el swipe.
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

**2. Icono de WhatsApp de los avatares** (badge en la esquina inferior del avatar, en la lista de chats y en el header).

- Componente: `PhoneMessageChannelIcon` (`frontend/src/components/phone/PhoneMessageChannelIcon.tsx`).
- Se usa en `renderChannelBadgeIcon` dentro de `PhoneChat.tsx`; el badge recibe
  `avatarChannelBadgeWhatsapp`.
- El relleno del avatar no debe ser verde. El verde vive sólo en el aro social
  (`avatarWhatsapp` -> `--avatar-ring-color`) y en el badge de canal.

Perillas (todas con sus valores actuales):

| Qué quieres cambiar | Dónde | Valor actual |
|---|---|---|
| **Tamaño del glifo en la lista** | `.phoneChatPage[data-phone-chat-device="phone"] .chatItem > .avatar .avatarChannelBadgeWhatsapp .channelIconGlyph` en `PhoneChat.module.css` | `14px` |
| **Tamaño del glifo en el header** | `.conversationHeader .avatar .avatarChannelBadgeWhatsapp .channelIconGlyph` en `PhoneChat.module.css` | `13px` |
| **Verde del canal** | `--phone-channel-whatsapp` en `PhoneChat.module.css` / tokens globales móviles | `#25d366` |
| **Aro del avatar WhatsApp** | `.avatarWhatsapp` en `PhoneChat.module.css` | `--avatar-ring-color: var(--phone-channel-whatsapp)` |

Reglas al tocarlo:

- El tamaño necesita selectores más específicos por dispositivo/header porque
  `.avatarChannelBadge svg` define el tamaño base.
- El badge de WhatsApp conserva color de canal; el relleno del avatar conserva
  identidad Ristak.
- Verifícalo corriendo la app en la **lista de chats** (no solo el header: el header
  no tiene las reglas por dispositivo, así que puede engañar). Si la lista local está
  vacía, revisa al menos el header + los tamaños computados.
