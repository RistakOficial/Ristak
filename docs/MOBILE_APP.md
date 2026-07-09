# Ristak Mobile App

Ristak tiene tres rutas moviles activas y no deben mezclarse:

1. `/movil`: experiencia movil web dentro de `frontend/`. Es la ruta usada para
   web/PWA y para el shell web movil.
2. `mobile/`: cliente React Native/Expo para dispositivos Android y el camino
   futuro de Google/Play. No debe contener configuracion, scripts, entitlements,
   APNs, targets, extensiones ni codigo nativo Apple. Si alguien necesita correr
   Apple, esa ruta no es `mobile/`. Su paquete Android es `com.ristak.android`;
   no uses `com.ristak.native` porque `native` es palabra reservada de Java y
   rompe el build Android.
3. `ios/app`: app nativa Apple en SwiftUI para iPhone y iPad. Esta es la unica
   carpeta propietaria de la experiencia nativa Apple.

## Identificadores `com.ristak.*`

La auditoria del 2026-07-09 encontro siete valores unicos `com.ristak.*` en el
repo (excluyendo dependencias y builds generados). El numero de menciones puede
cambiar cuando se edita documentacion; la fuente de verdad es esta tabla de
proposito:

| Identificador | Uso correcto | Estado |
| --- | --- | --- |
| `com.ristak.app` | App legacy/de tienda basada en `frontend/` Capacitor y topic APNs default historico. | Activo legacy |
| `com.ristak.app.NotificationService` | Extension legacy de notificaciones para la app Apple de tienda. | Activo legacy |
| `com.ristak.ios` | App nativa Apple nueva en `ios/app` para iPhone/iPad. | Activo nativo Apple |
| `com.ristak.ios.NotificationService` | Topic/extension esperada si la app SwiftUI conserva `com.ristak.ios` y agrega Notification Service Extension. | Reservado/documentado |
| `com.ristak.android` | Paquete Android de `mobile/` React Native/Expo. | Activo Android |
| `com.ristak.native` | Nombre viejo invalido para Android; no debe usarse porque `native` es palabra reservada de Java y rompe Gradle. | Prohibido |
| `com.ristak.chats` | Identificador interno de UI/navegacion, no bundle id ni package id de app. | Interno |

Regla practica: para builds nuevos usa `com.ristak.android` en Android,
`com.ristak.ios` en la app SwiftUI y solo toca `com.ristak.app` cuando estes
manteniendo la app Capacitor legacy o sus perfiles de tienda existentes.

Regla obligatoria de mantenimiento: cualquier cambio de producto movil, chat,
login, permisos, push, pagos, agenda, filtros, labels visibles o contrato de API
debe revisarse en las superficies que apliquen: `/movil` para web, `mobile/`
para Android/Google y `ios/app` para iPhone/iPad. Si aplica solo a una, el
resumen del cambio debe decir por que y esta guia debe actualizarse cuando
cambie el comportamiento visible.

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

En la bandeja de chats de `ios/app`, cada arranque o regreso desde background
real debe entrar por Chats con la lista en su posicion nativa inicial. No uses
`ScrollViewReader.scrollTo` contra la primera fila de la `List`: con
`navigationTitle` grande y `searchable`, esa fila vive debajo del header/search y
forzarla como ancla hace que la pantalla abra visualmente mas abajo. Si hay que
reiniciar la bandeja, remonta la `List` con una identidad nueva y deja que iOS
coloque el tope real.

Los bottom sheets nativos que contienen formularios, pickers o contenido con
boton final deben reservar un margen inferior de seguridad dentro del contenido
scrollable para que el ultimo control quede visible por encima del area inferior
del dispositivo Android. Esta regla no aplica a sheets de lista pura
(`contactos`, `calendarios`, `Mas acciones`, listas de filas): esas filas deben
mantenerse full-bleed, con separadores y estados seleccionados llegando al borde
del sheet y sin safe-zone lateral falsa.

Todos los bottom sheets nativos que usen `BottomActionSheet` deben poder cerrarse
arrastrando hacia abajo desde la zona superior del sheet (la manija y el header).
Ese gesto debe seguir el dedo, rebotar si el arrastre es corto y cerrar con la
misma animacion del sheet si el usuario baja lo suficiente o hace un flick hacia
abajo. No implementes este comportamiento por sheet individual. La familia de
menus inferiores en `mobile/` debe ser una sola: filtros, acciones, selectores
simples y sheets de informacion deben colgar de `BottomActionSheet`; no agregues
modales `slide`/`fade` caseros para paneles que nacen desde abajo.

Regla movil de movimiento: la navegacion entre pantallas nativas no debe
aparecer/desaparecer en seco. Las secciones principales de `mobile/` usan una
transicion direccional corta con `transform`/`opacity`; entrar a una conversacion
desde la bandeja de chats monta la conversacion como capa superior y la desliza
desde la derecha, y volver mantiene la capa viva hasta que termina la salida.
Los dropdowns, bottom sheets y pickers reutilizables deben expandirse/contraerse
con la primitiva compartida, no con animaciones locales por pantalla. Mantén las
duraciones alrededor de 220-300 ms, con entrada ease-out y salida ligeramente más
rapida para que se sienta nativo e interruptible.

Regla global de teclado en `mobile/`: cualquier pantalla, panel, submenu,
bottom-sheet o modal que permita escribir texto debe quedar visualmente por
encima del teclado al enfocar un campo. Las pantallas normales deben vivir dentro
de `AppFrame` con avoidance activo y los paneles deben usar `BottomActionSheet`,
que extiende el fondo del sheet detras del teclado y agrega padding interno con
la altura real del teclado. No uses `marginBottom` para separar el sheet del
teclado: crea un corte visual entre panel y teclado. No crees formularios con
`TextInput` fuera de esas primitivas salvo que implementen el mismo contrato de
keyboard avoidance local y continuidad visual.

En conversaciones nativas de `mobile/`, el composer vive dentro del `AppFrame` y
toda la pantalla comparte una sola superficie: el `AppFrame` de la conversacion
usa siempre el mismo fondo que el composer, sin cambiar de color al enfocar. No
pintes fondos falsos detras del teclado ni agregues rellenos extra que corten la
continuidad visual. Lo que se ve detras y alrededor del teclado debe ser el
mismo fondo del composer, igual que en las demas pantallas con avoidance
(buscador de chats, paneles de analiticas).

Arquitectura del hilo de conversacion nativo: el FlatList del hilo es
INVERTIDO (data[0] = mensaje mas reciente, `inverted` +
`maintainVisibleContentPosition {minIndexForVisible: 1, autoscrollToTopThreshold}`
+ `onEndReached` para cargar historial, spinner de historial en
`ListFooterComponent`). El anclaje al ultimo mensaje y la compensacion al
recibir mensajes lo hace el nativo; NO reintroduzcas coreografia JS de scroll
(`scrollToEnd` desde `onContentSizeChange`, umbrales "atLatest", guards de
drag con timers): en Fabric esa combinacion esta rota por bugs abiertos del
core y produce brincos y regresos de posicion. Ademas: las keys de mensaje
deben ser estables entre polls y paginas (ids de proveedor o huella de
contenido, nunca el indice), los merges deben preservar identidad de objetos
cuando nada cambio (un poll sin novedades debe ser un no-op de React), los
mensajes optimistas `local-*` se reconcilian con la copia del servidor al
llegar, y las filas (`NativeMessageBubble`, `ChatRow`) van en `React.memo` con
callbacks de identidad estable.

Recepcion viva del chat nativo: `mobile/` debe suscribirse a
`/api/chat-events/stream` con la misma sesion bearer que usa para REST. Cada
`chat_message` se trata como nudge local: refresca la bandeja y solo refresca el
hilo si el `contactId` coincide con la conversacion abierta. Ese refresh debe ir
coalescido para no disparar varias cargas simultaneas cuando llegan mensajes en
rafaga. El polling sigue existiendo como reconciliacion de respaldo: bandeja cada
12 s e hilo abierto cada 4 s, sin spinner, sin borrar cache visible y sin mover
el scroll si no hubo cambios reales.

Regla de dueño unico del teclado: en cada ruta visible solo puede haber UN
keyboard avoider habilitado. Dos `KeyboardAvoidingView` apilados (p. ej. el
`AppFrame` de una pantalla host mas el `AppFrame` de una ruta overlay montada
dentro, como la conversacion sobre la bandeja de chats) reciben el mismo evento
de teclado con frames obsoletos, se compensan doble y dejan una franja entre el
composer y el teclado que ningun padding, color ni safe-area puede corregir.
`AppFrame` monta siempre su `KeyboardAvoidingView` y lo activa/desactiva con la
prop `keyboardAvoiding` (via `enabled`, sin desmontar el subarbol): la pantalla
host debe pasar `keyboardAvoiding={false}` mientras su overlay este abierto
(ChatScreen lo hace con `keyboardAvoiding={!selected}`), de modo que el frame de
la ruta overlay — con el fondo del composer — sea el unico dueño del teclado,
igual que el Asistente Personal AI, que reemplaza el arbol completo. Al abrir
una conversacion tambien se cierra el teclado pendiente (`Keyboard.dismiss()`)
antes de traspasar la propiedad.

Regla movil de avisos: las acciones exitosas normales no deben abrir
`Alert.alert`, `window.alert`, toasts ni popups flotantes en `/movil` ni en
`mobile/`. Registrar pagos, crear/editar citas, programar o cancelar mensajes,
archivar/restaurar chats, copiar contenido, crear etiquetas o cambiar estados
del agente deben confirmarse con el cambio visible en la pantalla: cierre del
sheet, actualizacion de lista, estado inline o nuevo contenido renderizado. Solo
se permiten avisos intrusivos para errores, permisos del sistema, validaciones
que bloquean continuar y confirmaciones destructivas.

El sheet nativo `Mas acciones` debe mantenerse como espejo operativo del sheet
de `PhoneChat`: agendar cita, registrar pagos, programar mensaje, agregar
etiqueta, silenciar/quitar silencio y controles del agente. Si una accion aun
no tiene formulario nativo completo, debe navegar a la seccion nativa
correspondiente o dejar documentada la brecha en
`docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`; no debe desaparecer del menu.

La seccion nativa `Pagos` debe mantenerse alineada con `/movil/payments`, no con
un dashboard resumido: selector de tipo de pago, pagos recientes por periodo,
productos/precios guardados, cobro unico manual o por liga, planes de
parcialidades y suscripciones deben usar componentes nativos propios y endpoints
tipados. La moneda de creacion sale de `account_currency` y la zona para rangos
y fechas sale de `account_timezone`; si no se puede leer la moneda de cuenta, la
app no debe crear registros de dinero. Pago unico debe soportar invoice de
HighLevel cuando la integracion este conectada, pago manual con record-payment
de HighLevel cuando exista invoice, y fallback local solo cuando no exista
HighLevel o no se haya podido crear invoice. Cuando una pasarela devuelve un
checkout externo, el cliente nativo debe abrirlo con `Linking` o browser nativo y
dejar la brecha documentada si aun no envia el link por WhatsApp/email/SMS desde
el sheet.

El cliente nativo consolidado en `mobile/` ya agrupa los pases hechos en los
worktrees de Chat, Conversacion, Citas, Pagos, Analiticas, Ajustes, dock inferior,
login y notificaciones. Antes de crear otro worktree movil, parte de esta carpeta
unificada y revisa el checklist de paridad. Ajustes nativo ya incluye numeros de
WhatsApp, selector de numero para la bandeja, dictado de la descripcion del
agente con `expo-audio` y `/api/ai-agent/transcribe`, activacion de push nativo
con `expo-notifications`, y Ajustes reales de apariencia/chat. La preferencia
`mobile_chat_theme_preference` soporta sistema, claro, noche y horario; el shell
nativo debe aplicarla como paleta global, no solo como fondo de `StatusBar`.
Los botones flotantes, dock inferior, burbujas de chat, composer e iconos de
Ajustes deben tomar colores desde la paleta activa (`COLORS`) y no desde azules
nocturnos hardcodeados. La pantalla de Ajustes debe forzar un render del shell
cuando cambia `mobile_chat_theme_preference`. En la lista principal de Ajustes,
los iconos de filas son glyph-only: no llevan circulo, fondo ni color por
categoria; todos usan el mismo tono neutral de la paleta activa y solo `Cerrar
sesion` puede usar rojo destructivo. Los iconos de cards y opciones de
apariencia siguen usando colores semanticos de la paleta activa con contraste
real en claro y noche.
Las preferencias de chat guardadas en `app_config` (`mobile_chat_ai_agent_enabled`,
`mobile_chat_show_archived`, `mobile_chat_sort_mode`,
`mobile_chat_show_last_preview`, `mobile_chat_show_unread_indicators` y
`mobile_chat_selected_whatsapp_phone_id`) deben afectar la bandeja viva sin
reiniciar la app. Si una funcion se cambia en `/movil`, valida si tambien debe
cambiar en `mobile/` en la misma rama.
Cuando `mobile_chat_ai_agent_enabled` esta activo, la fila fija `Asistente
Personal AI` abre un chat nativo real conectado a `/api/ai-agent/chat` con el
mismo proveedor/configuracion del asistente de escritorio. Ese chat usa el layout
de conversacion nativa, pero no muestra acciones de contacto: no agenda citas,
no registra pagos y no permite acciones de WhatsApp; solo conversa con el
asistente personal. El composer del asistente mantiene `+` para enviar fotos y
documentos como attachments al agente; los videos se bloquean en movil hasta que
la app genere miniatura/contenido visual legible para el backend. El microfono
graba nota de voz, la transcribe con `/api/ai-agent/transcribe` y manda el texto
resultante al mismo chat. Las burbujas del asistente nativo deben renderizar el
formato basico que ya usa el asistente de escritorio: negritas, italicas,
tachado, codigo inline, links y listas no deben mostrar delimitadores crudos como
`**`, `_`, `~` o marcadores Markdown; la UI interpreta el formato y conserva una
burbuja legible.

En la conversacion nativa, el composer inferior debe replicar la referencia
visual de la app original: panel azul muy claro, campo de texto blanco,
iconos de canal/adjuntos/camara/microfono sin disco ni fondo propio, avatar del
contacto compacto para no comerse el nombre, y acciones de calendario/cobro del
header fusionadas dentro de una sola capsula compacta. El boton de canal puede
colorear el glifo segun el canal, pero no debe volver a meterlo en un circulo
solido.

En listas y headers de chat, el avatar del contacto no lleva aro ni contorno por
canal. El canal se identifica con un badge inferior derecho usando los assets
WebP nativos de `mobile/assets/channel-badges/` y
`ios/app/Ristak/Resources/channel-badges/`, sin disco, fondo, borde ni brillo
extra alrededor.

Los envios manuales desde la conversacion nativa deben tener un candado
sincronico antes de cualquier validacion async del agente o del canal: un doble
tap no puede crear dos requests API. Cuando el backend responde con
`localMessageId`, el globo optimista debe adoptar ese ID real antes de refrescar
el historial; si conserva el ID local temporal, el merge de conversacion puede
mostrar el optimista y el mensaje persistido como dos burbujas.

Los comentarios de Facebook e Instagram en la conversacion nativa deben mantener
la misma paridad que escritorio y `/movil`: el globo muestra si fue comentario,
respuesta publica o respuesta privada, y cuando el backend entrega contexto de
la publicacion comentada (`post_message`, `post_image_url`, `post_permalink` o
`post_deleted`) se renderiza una ficha compacta de esa publicacion dentro del
mismo globo. Si hay link, la ficha abre la publicacion; si Meta marca el post
como eliminado, debe mostrarse como `Publicacion eliminada` sin perder el
comentario conservado en Ristak.

El canal de respuesta de comentarios tambien debe mantenerse en paridad. Un
contacto creado desde comentario debe abrir el composer en `Comentario de
Facebook` o `Comentario de Instagram` y publicar la respuesta en la publicacion.
Si el usuario cambia el canal a Messenger/Instagram DM, la respuesta se manda por
privado usando el comentario como origen. Si el contacto ya tenia una conversacion
privada y luego comenta una publicacion, el chat sigue en el canal privado; el
canal publico solo puede usarse automaticamente mientras ese comentario siga
siendo el ultimo mensaje entrante del contacto. Si despues llega un DM, responder
en la publicacion requiere tocar `Responder en la publicacion` dentro del globo
del comentario exacto.

El fondo de la conversacion nativa usa una textura sutil detras de los globos y
un parallax real con `expo-sensors`/`DeviceMotion`: la inclinacion del iPhone
desplaza solo la textura unos pixeles; los mensajes, header y composer no deben
moverse ni redimensionarse.

El avance por fases de esa paridad vive en
`docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`. Antes de retomar la migracion nativa,
lee ese checklist para saber que ya quedo, que sigue pendiente y que fuentes del
codigo original deben revisarse.

## Shell web `/movil`

`/movil` es la experiencia movil web de Ristak. Usa las mismas pantallas moviles
del frontend y es la referencia funcional que deben mirar `mobile/` e `ios/app`
cuando una feature exista en varias superficies. Las rutas legacy `/phone/*`
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
- iOS multi-cliente del shell `/movil`: `VITE_INSTALLER_API_URL` puede apuntar al portal central; si falta usa `https://www.ristak.com`.
- App React Native en `mobile/`: el login no pide URL. Resuelve el tenant con
  `/api/mobile/resolve` usando `EXPO_PUBLIC_INSTALLER_API_URL` si existe; si no,
  usa `https://www.ristak.com`.
- Android legacy Capacitor: `frontend/android/app/google-services.json` del
  proyecto Firebase vive fuera de Git y debe pertenecer al paquete
  `com.ristak.app`.
- Android nativo React Native/Expo: el target de Play Store vive en `mobile/`,
  genera `mobile/android` en CI y usa el paquete `com.ristak.android`.
- iOS nativo: usar `ios/app` y sus documentos. No agregues APNs ni Xcode config
  dentro de `mobile/`.

## Comandos

Desde la raiz del repo para el cliente React Native nuevo:

```bash
npm run mobile:native:start
npm run mobile:native:android
npm run mobile:native:prebuild
npm run mobile:native:typecheck
```

`mobile/android` puede generarse por Expo Continuous Native Generation con
`npm run mobile:native:prebuild`. Si Expo vuelve a generar `mobile/ios`, esa
salida es basura local: se borra y no se promueve. La ruta Apple real es
`ios/app`.

Desde `frontend/`:

```bash
npm run mobile:sync
npm run mobile:open:android
```

Para preparar, probar o publicar la app Apple nativa, usa `ios/app` y
`ios/README.md`.

Si tu terminal sigue en Node 20, usa Node 22 temporal:

```bash
npx -p node@22 -p @capacitor/cli@8.4.0 cap sync
```

## Analiticas nativas

`/movil/analytics` es la fuente de verdad visual y funcional para la pantalla de
analiticas en `mobile/`. El cliente nativo debe consumir las mismas APIs que la
pantalla web movil:

- `/api/dashboard/metrics`
- `/api/dashboard/financial-overview`
- `/api/dashboard/visitors`, `/leads`, `/appointments`, `/attendances` y
  `/sales`
- `/api/dashboard/funnel`
- `/api/dashboard/origin-distribution`
- `/api/whatsapp-api/status`
- `/api/highlevel/custom-labels`

Los rangos visibles `30d`, `60d`, `180d`, `year` y `custom` deben calcularse con
la zona horaria de negocio (`account_timezone`) y los importes deben formatearse
con `account_currency`. No uses la zona local del dispositivo ni una moneda
hardcodeada como fuente de verdad de negocio. El rango personalizado usa fechas
`YYYY-MM-DD` y debe aplicar el mismo rango a metricas, grafica, embudo y origen.

La pantalla nativa debe conservar la estructura de `PhoneAnalytics`: encabezado
`Analiticas`, selector de periodo, 8 KPIs, grafica principal con chips, scopes
financieros, embudo con scopes, origen por fuente y origen por numero de
WhatsApp cuando existan varios numeros detectados.

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
  por login y superficies de marca explicitas. Las pantallas de carga inicial no
  muestran logo ni nombre visible.
- Web/PWA móvil: `frontend/public/ristak-chat-icon-*`,
  `frontend/public/ristak-chat-home-icon-*` y los `apple-touch-icon` móviles.
- App nativa Android Expo (`mobile/`): `mobile/assets/ristak-light-mode-icon.png`,
  `mobile/assets/ristak-night-mode-icon.png` y
  `mobile/assets/ristak-monochrome-icon.png` alimentan `mobile/app.json` para
  Android. La pantalla `BootScreen` y el login nativo usan los WebP
  transparentes `mobile/assets/ristak-*-mode-sin-fondo.webp`, generados desde
  los logos oficiales de modo claro/noche. En `mobile/` si debe verse marca al
  cargar; en `/movil` la carga web sigue sin logo ni nombre visible.

Las push de mensajes, citas y pagos deben mostrar identidad de contacto cuando
el payload pertenece a exactamente un contacto. Si existe una foto publica, esa
foto viaja en `contactAvatarUrl` y `senderAvatarUrl`. Si no existe foto, el
backend debe generar un PNG publico de iniciales en
`/api/push/contact-avatar/:contactId` con firma en querystring y usar esa URL en
los mismos campos. Solo cuando son varios contactos o la alerta es general se
usa el isotipo de Ristak.

El avatar del contacto, sea foto real o iniciales generadas, no debe copiarse a
`notificationImageUrl`. `notificationImageUrl` y `notificationAttachmentUrl`
son exclusivamente para multimedia real del mensaje.

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
Ristak solo cuando la alerta no pertenece a un contacto unico. Si llega media real, la muestra con
`BigPictureStyle` y mantiene el avatar/logo como large icon. No vuelvas a usar
`message.notification` ni `android.notification.image` para Android porque el
sistema/Firebase toma el control visual y se pierden avatar, logo correcto y
estilo de conversación.

En `mobile/`, la app React Native registra el token nativo con
`expo-notifications` contra `/api/push/mobile-devices`, crea los mismos canales
Android (`ristak_alerts`, `ristak_sound`, `ristak_vibrate`, `ristak_silent`) y
abre el chat correcto al tocar una push usando `contactId` o `url`. Mientras el
proyecto `mobile/android` no este generado/tracked, la paridad Android del
renderer `RistakFirebaseMessagingService` sigue pendiente; no sustituye todavia
al renderer Android de `frontend/android`.

En iOS/APNs, cualquier payload, extension de notificaciones, capability o perfil
de firma pertenece a la app Apple bajo `ios/app`, no a `mobile/`. Si hace falta
mantener Communication Notifications, avatars o attachments en iPhone/iPad,
documentalo y desarrollalo en la ruta Apple nativa.

## Tema visual móvil

La app nativa en `mobile/` debe sentirse como una experiencia Android premium,
neutral y limpia, no como una piel azul encima de React Native. La base visual
usa superficies claras/grises en claro y negros/grises profundos en oscuro. El
azul queda reservado para acentos funcionales puntuales: CTA principal, badges,
links, checks, puntos de calendario o estados que realmente necesitan destacar.
No uses azul/cian como relleno de navegacion, tabs, chips, filtros, icon
buttons, bottom sheets ni segmented controls. El verde ya no debe usarse como
acento global de la app porque hace que la experiencia se sienta como WhatsApp.

Tokens principales:

- Base global: `frontend/src/styles/index.css` bajo
  `data-phone-chat-theme='active'`.
- Chat móvil: `frontend/src/pages/PhoneChat/PhoneChat.module.css`.
- Componentes compartidos móviles: `frontend/src/components/phone/` y
  `frontend/src/components/phone/ui/` deben heredar `--phone-chat-accent` y
  `--phone-chat-primary`.

El dock inferior nativo en `mobile/src/App.tsx` debe mantenerse en paridad con
`frontend/src/components/phone/PhoneEcosystemNav.*`: mismos items, orden,
sin texto visible bajo los iconos, gesto horizontal entre secciones, indicador
animado que persigue la coordenada real del dedo, badge de Chats y espacio
inferior reservado para que las listas no queden cortadas detras del panel. El
dock se compacta suavemente al hacer scroll hacia abajo y vuelve a su tamano
normal al subir, sin perder el centrado de iconos ni del indicador. Evita
contornos duros, rellenos opacos y elevaciones pesadas: los controles flotantes e
iconograficos usan superficies neutrales, borde sutil y sombra ligera. No pintes
rellenos azules o cian para simular material; los estados seleccionados de
tablists, filtros y segmented controls se leen por superficie neutral, sombra,
contraste y texto. Los iconos de navegacion y toolbar deben mantenerse finos
(`strokeWidth` aproximado 1.75-2.0); reserva trazos mas gruesos solo para badges
o estados muy pequenos donde la legibilidad lo exija. El indicador activo del
dock es una unica capsula neutral que se mueve con `translateX` siguiendo el
dedo; no debe convertirse en un circulo solido azul. En tema claro, los iconos
del dock son negros; en tema oscuro, claros.

Regla de criterio: el verde se reserva para marca WhatsApp
(`--phone-channel-whatsapp`, `PhoneMessageChannelIcon`, iconos/canal WhatsApp) o
para estados semánticos de éxito. Botones secundarios, tabs, filtros, inputs,
menus y defaults visuales de la app deben heredar la paleta neutral activa.
Badges, loaders, gráficas, links y CTAs principales pueden usar el azul de
sistema cuando aporten jerarquia funcional, pero nunca como relleno decorativo
global.
Las acciones contextuales, menús y bottom sheets móviles también deben
usar `--phone-chat-primary`, `--phone-chat-text-on-primary`,
`--phone-chat-surface`, `--phone-chat-panel`, `--phone-chat-border` y
`--phone-chat-sheet-shadow`; no uses verdes heredados ni fondos beige/verdosos
fijos para paneles como "Agendar con".

## Lista de chats nativa

En `mobile/`, la lista de chats debe mantener paridad visual y tactil con
`/movil`: los filtros horizontales arrancan pegados al margen util de la
pantalla y no deben auto-centrarse dejando chips cortados en los laterales. Las
filas deben ser suficientemente altas para lectura tactil, con avatar grande y
separadores/alineacion propios de la fila.

La bandeja nativa ya no usa swipe horizontal para acciones de fila. Tocar una
fila abre el chat; mantenerla presionada abre el sheet `Mas acciones` con feedback
haptico. En ese sheet, `Seleccionar` debe ser la primera accion, antes de
agendar, registrar pagos o cualquier otra herramienta. Al tocar `Seleccionar`,
la lista entra en seleccion multiple y desde ahi se pueden marcar leidos,
archivar/restaurar o seleccionar visibles. No reintroduzcas `Mas`/`Archivar`
como botones laterales por swipe.

Las fechas de la lista de chats se formatean con la zona horaria del negocio:
los mensajes del dia actual muestran la hora exacta (`7:47 p.m.`), los del dia
anterior muestran `Ayer`, del anteayer hasta antes de una semana muestran el dia
de la semana, y despues fecha corta como `04-jul`. No uses `Hoy` en filas de
chat con mensaje del dia actual.

La bandeja nativa no debe quedarse limitada al primer bloque de conversaciones.
`mobile/` consume `/contacts/chats` con `limit`/`offset`, carga el primer lote de
50 chats y al llegar al final del scroll pide el siguiente bloque. Los lotes se
fusionan por `contact.id` para evitar duplicados y preservar avatares ya
hidratados.

## Remitente de WhatsApp en chat movil

En `/movil`, el boton de canal del composer debe listar cada WhatsApp conectado
como opcion separada cuando la cuenta tiene mas de un remitente. Elegir
`WhatsApp · <nombre/numero>` cambia el envio puntual del chat abierto y el
mensaje sale con ese `phoneNumberId`; no debe obligar al usuario a ir al
desktop para elegir entre WhatsApp 1, WhatsApp 2, etc.
La conversacion nativa en `mobile/` debe aplicar el mismo contrato: el selector
del composer solo muestra rutas realmente conectadas para ese chat, lista cada
numero de WhatsApp disponible por separado y agrega Messenger/Instagram solo si
la integracion Meta correspondiente esta conectada y el contacto pertenece a
ese canal.

La info del contacto muestra "Contactando desde". Ese sheet es el control
persistente del contacto: `Automatico` limpia `preferred_whatsapp_phone_number_id`
para usar el numero por donde llego la conversacion o el principal actual; elegir
un numero fijo guarda `preferred_whatsapp_phone_number_id` en el contacto. Si el
numero mostrado por automatico coincide con el que el usuario toca, igual debe
guardarse como fijo; no cierres el sheet solo porque visualmente ya era el
numero activo.

## Info del contacto nativa

La pantalla `Info del contacto` en `mobile/` debe mantenerse como espejo de la
pantalla web movil de `/movil` en estructura y comportamiento, pero dentro del
tema nativo oscuro de Ristak: avatar, nombre editable, telefono/estado, selector
`Contactando desde`, busqueda dentro del chat, resumen de pagos/citas, archivos
del chat, datos principales, origen y conversion, seguimiento, historial del
agente, campos personalizados e integracion. No debe introducir una paleta clara
local ni colores hardcodeados fuera de los tokens moviles compartidos.

Esta pantalla usa una escala compacta comun para textos, iconos, filas, tabs,
metricas y sheets. Si se ajusta el tamano visual, modifica la escala o los tokens
compartidos de esta familia de componentes; no agrandes cada elemento por
separado ni permitas que iOS Dynamic Type infle la pantalla hasta romper la
paridad visual de la app Apple. En `mobile/`, la escala debe controlarse desde
tokens/estilos React Native propios.

Las filas de `Info del contacto` pueden usar separadores sutiles, pero solo si
son parte real del componente de fila. La linea debe quedar al fondo de la fila y
arrancar donde inicia el bloque de texto, no desde el borde completo ni como
hairline decorativo flotante. Las filas normales y las filas resumen usan insets
distintos porque sus iconos tienen tamanos distintos.

Las secciones de `Info del contacto` deben verse como categorias reales, no como
una pagina blanca/plana con filas acumuladas. Cada bloque principal (`Chat`,
metricas, `Archivos del chat`, `Datos principales`, `Origen y conversion`,
`Seguimiento`, `Historial del agente`, `Campos personalizados` e `Integracion`)
usa su propio contenedor sutil con margen horizontal, radio, borde de tema y
fondo tokenizado. El fondo exterior de la pantalla y el fondo interior de las
secciones no deben ser el mismo color: en tema claro el exterior usa la superficie
suave y las secciones quedan sobre superficie principal; en tema oscuro el
exterior conserva el fondo profundo y las secciones usan superficie elevada. No
elimines esa separación ni la sustituyas por espaciado decorativo sin contenedor.
El selector `Contactando desde` debe compartir el mismo tipo de borde y
superficie que estas secciones.

El fondo exterior de `Info del contacto` debe cubrir toda la ventana nativa,
incluida la zona detras de la hora, Wi-Fi y bateria. El contenido superior sigue
respetando el inset del status bar, pero el fondo full-bleed se pinta desde el
root de `AppFrame` con `CONTACT_INFO_THEME.conversationBg`; no metas el safe area
en la misma vista que pinta el fondo.

El avatar de `Info del contacto` usa aro exterior separado del recorte de imagen:
el contenedor exterior pinta el borde/aro y el contenedor interior redondo hace
el clipping de la foto o iniciales. No mezcles borde y `overflow: hidden` en la
misma capa porque la foto puede verse recortada como cuadro o no llegar bien al
circulo.

El bloque `Viaje de cliente` de `Info del contacto` no debe renderizar el
historial de chat crudo. La app nativa debe pedir el journey completo del
contacto y aplicar las mismas reglas de escritorio/web movil antes de pintar:
filtrar mensajes salientes del negocio, agrupar eventos diarios por la zona
horaria del negocio, elegir el evento de WhatsApp/Meta con mas metadata util y
ocultar conversaciones directas de WhatsApp posteriores al primer pago exitoso
salvo que tengan atribucion de anuncio. Los mensajes individuales siguen
perteneciendo a la conversacion; el viaje muestra hitos del cliente.

La pagina nativa `Viaje de cliente` debe mostrarse como timeline conectado: cada
evento tiene el mismo estilo de icono que las filas de `Info del contacto` y una
linea vertical de tema une el centro de los iconos. La linea no debe empezar
antes del primer evento ni continuar despues del ultimo.
El timeline completo vive dentro de un contenedor de superficie elevada, con
encabezado compacto, resumen de cantidad de eventos y separacion interior real.
No debe pintarse directo sobre el fondo exterior porque la pagina pierde
jerarquia visual y se siente como una sabana plana de color.
Las filas del timeline no deben mostrar cuerpos de mensajes de chat como
descripcion principal. Para WhatsApp directo basta canal y fecha; si hay
atribucion, muestra fuente/campana/anuncio. Para web muestra pagina o URL limpia;
para pagos muestra monto/estado; para citas muestra titulo/estado y fecha.

Los bloques `Total`, `Citas`, `Archivos del chat`, `Viaje de cliente` e
`Historial del agente` abren paginas nativas propias con boton de regreso, no
alertas ni modales genericos. `Archivos del chat` separa `Fotos y videos`,
`Documentos` y `Enlaces`; las fotos/videos se muestran como grid y los
documentos/enlaces como filas tocables. `Contactando desde` abre un sheet con
`Automatico` y todos los numeros de WhatsApp disponibles; elegir una opcion debe
guardar la preferencia del contacto igual que `/movil`.

## Agenda de citas desde el chat movil

El sheet de `Agendar cita` dentro de una conversacion puede abrirse en dos modos:
formulario completo o calendario mensual. El boton de calendario del encabezado
del sheet cambia entre ambos modos y guarda la preferencia por usuario en
`user_config.mobile_chat_appointment_entry_mode`, con valores `form` o
`calendar`.
El acceso rapido de calendario del header del chat ya no abre una accion aislada:
redirige a la pagina nativa de Agenda y abre el formulario de nueva cita con el
contacto de esa conversacion precargado y bloqueado.
Dentro del formulario completo, el selector de calendario debe abrir una subvista
del mismo bottom sheet, no un segundo modal encima: iOS puede bloquear o esconder
modales apilados y el usuario termina tocando un dropdown que no muestra nada.

El modo calendario solo aparece cuando hay un contacto activo bloqueado para la
cita. Mantiene el selector de calendario arriba, pinta una vista mensual unica
sin semana/dia/anio, permite cambiar de mes con flechas o swipe horizontal y
despues pide hora, duracion, ubicacion e invitados. La fecha y hora se convierten
a UTC usando la zona horaria de la cuenta; no debe depender de la zona horaria
del navegador. Al guardar usa el mismo endpoint de citas que el formulario
normal y respeta bloqueos nativos del calendario antes de crear la cita.

## Pagina de Citas nativa

La seccion `Citas` de `mobile/` debe recrear la pagina movil original de
`frontend/src/pages/PhoneCalendar/PhoneCalendar.tsx`, no el placeholder generico
de bloques. La pantalla nativa usa el header movil original: pastilla de periodo
con chevron y anio, capsula de acciones `Hoy` / calendario / `+`, titulo grande
del mes, grilla mensual amplia, agenda del dia y sheet de detalles de cita. El
selector de calendario vive en el icono de calendario de la capsula, no como fila
permanente debajo del titulo. Todas las agrupaciones de eventos se calculan con
la zona horaria de la cuenta (`account_timezone`), no con la zona horaria del
telefono.

El boton `+` abre un bottom sheet nativo para buscar contactos y despues muestra
el formulario de cita. El formulario abre por defecto en modo `Por defecto`, con
flujo rapido: fechas disponibles, horarios disponibles, invitados, notas y CTA
de crear cita. En ese modo no se muestran fecha, hora, duracion, zona horaria ni
direccion porque la fecha y el horario salen de los slots superiores y la zona se
hereda del calendario. Al cambiar a `Personalizado`, aparecen selectores internos
separados para dia/mes/anio, hora/minutos/AM-PM y duracion por horas mas minutos.
El formulario mantiene `Invitados` antes de `Notas`: busca contactos existentes,
permite agregarlos sin icono de enviar mensaje, crea contactos nuevos dentro del
mismo sheet cuando no existen y guarda la lista en notas con el bloque
`Invitados:` hasta que el backend tenga un campo estructurado de asistentes.
Guardar crea contra `/api/calendars/appointments`;
editar y eliminar usan los endpoints reales de citas/eventos. La fecha y hora
del formulario se interpretan en `account_timezone` y se mandan al backend como
instantes UTC. En la vista Hoy/Semana, tocar o mantener presionado un horario del
timeline debe abrir la creacion de cita en ese rango, manteniendo tolerancia a
micro-movimientos verticales del dedo. La grilla mensual y el titulo del mes se
desplazan sincronizados; la agenda no repite el anio debajo del mes porque el
anio ya vive en la pastilla superior. La grilla mensual debe quedar libre sobre
el fondo de la pantalla y su alto se calcula con las semanas reales del mes
visible para que el resumen del dia quede pegado aunque el mes tenga menos filas;
la fila Domingo-Sabado queda libre sobre la grilla, sin capsula visual. Los
numeros de la grilla mensual deben mantenerse compactos respecto a la bolita de
seleccion; la bolita puede conservar mayor presencia que el texto. El swipe
entre meses no debe mostrar de regreso el mes anterior en frames intermedios. En
el sheet `Nueva cita`, la lista de contactos no debe mostrar icono de enviar
mensaje porque la accion es agendar, no mandar chat.
En la vista Hoy/Semana, las tarjetas de citas del timeline usan un solo campo
suave con borde tenue; no deben agregar una franja ni borde izquierdo intenso por
calendario.
Al aparecer la seleccion del timeline, la app dispara haptic y bloquea el scroll
del listado hasta soltar el dedo para que el rango se estire verticalmente sin
mezclarse con el desplazamiento. Brecha pendiente: replicar validacion avanzada
de slots/bloqueos y usuarios Round Robin del modal web original.

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
Los filtros por numero simples solo deben activarse cuando hay mas de un
WhatsApp conectado y el numero guardado existe. En `/movil` y en la app nativa,
tocar un chip de numero debe actualizar `mobile_chat_selected_whatsapp_phone_id`
y tocar `Todos` o cualquier filtro no numerico debe regresar ese valor a `all`.
Si solo hay un numero, o si `mobile_chat_selected_whatsapp_phone_id` apunta a un
numero ya inexistente, la bandeja debe caer a `Todos` para no vaciar los chats
por un filtro invisible. Cuando aplica, ambas superficies deben mandar
`businessPhoneNumberId`/`businessPhone` a `/contacts/chats` antes de paginar; no
se debe depender de filtrar localmente una pagina global. El chip `Comentarios`
va separado de `Interesados` con una linea divisoria, igual que la bandeja
desktop separa comentarios de filtros normales.

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
fallback muestra iniciales sobre una superficie gris del tema, no sobre azul/cian
Ristak. El
origen social del contacto no debe vivir en un aro, contorno ni relleno del
avatar; debe mostrarse únicamente como badge compacto de canal
(`.avatarChannelBadge*` o el equivalente nativo).
No vuelvas a usar verde WhatsApp, rosa Instagram o azul Messenger como relleno
completo del avatar de iniciales.
En la app nativa (`mobile/src/App.tsx`), las filas de chat, cabeceras y modales
de contacto no usan aro exterior de canal: el avatar se muestra limpio y el
origen queda únicamente en el badge de red social. Ese badge debe salir de los
assets recortados y optimizados en `mobile/assets/channel-badges/`: WebP
transparente, 72x72, con el logo de marca ya relleno. No uses iconos outline
transparentes sobre el avatar porque pierden contraste. Cuando no hay foto, las
iniciales deben intentar usar nombre
y apellido (`Raul Gomez` -> `RG`); si solo
hay una palabra o identificador, usa hasta dos caracteres utiles.
Las iniciales deben elegir color por contraste contra el relleno del avatar: si
el fondo es oscuro/azul, el texto va claro; si el fondo es claro, el texto va
navy oscuro. Los botones de accion de la app nativa Android (camara, crear,
volver, cerrar, agendar, cobrar y menus de mas acciones) deben usar la capa comun
de superficie neutral: borde hairline, brillo superior y sombra externa ligera.
No uses relleno azul en estos botones salvo que sean CTA primario o estado
seleccionado real. El tinte debe contrastar con el fondo visible y el icono o
texto siempre debe renderizar encima de la superficie para no verse opaco.

La bandeja nativa en `mobile/src/App.tsx` debe seguir esta misma regla de paridad:
header de chats con acciones superiores, buscador tipo pill, chips horizontales
(`Todos`, `No leídos`, `Citas`, `Clientes`, `Leads`, `Comentarios`, `+`) y filas
planas con separador desde el bloque de texto. La tira de filtros no debe quedar
encerrada en un panel de fondo ni vivir como banda flotante entre buscador y
filas: debe renderizarse dentro del `ListHeaderComponent` de la lista, sin fondo,
sombra, elevacion ni margen negativo; solo los chips individuales pueden tener
superficie propia. En tema claro, la paleta nativa usa base neutral: fondo
blanco, superficies gris muy claro, texto navy/negro de alta legibilidad, bordes
grises suaves y tipografia del sistema Android, no familias custom como Avenir.
La jerarquia de grosor debe ser corta:
solo los titulos principales de pantalla o seccion (`Chats`, `Ajustes`, meses
de calendario, `Analiticas`, `Elige como quieres pagar`) usan peso pesado;
subtitulos/labels van en semibold y texto normal va delgado. No uses negrita
pesada en previews, fechas, contadores secundarios ni copys de fila. Los
filtros se calculan con los mismos campos que `/movil` recibe de
`/api/contacts/chats`: `unreadCount`,
`status`, `purchases`/`ltv`, `hasAppointments`/`nextAppointmentDate`,
`lastMessageType`, `hasCommentMessage`, `lastMessageChannel`,
`lastMessageTransport` y señales de origen. El preview debe respetar el texto del
último mensaje, caer a labels de media (`Foto`, `Video`, `Audio`, `Documento`,
`Ubicación`, `Comentario`) y prefijar mensajes salientes con `Tú:` en la
superficie final. El badge y filtro de `No leídos` solo deben activarse para
mensajes entrantes pendientes; si el ultimo mensaje es saliente, aunque el
backend mande `unreadCount`, la UI nativa no debe mostrarlo como notificacion.
El avatar nativo debe mantener iniciales/foto en relleno
Ristak y reservar el color de red social para aro/badge, igual que
`PhoneChat.module.css`. El asistente personal AI se abre desde su fila fija en
la bandeja; el header de chats no debe mostrar un icono/boton de robot duplicado.

La lista de chats nativa usa una interaccion simplificada respecto a `PhoneChat`:
mantener presionada una fila abre `Mas acciones` con feedback haptico. La primera
accion del sheet es `Seleccionar`, que activa seleccion multiple y debe quedarse
activa al soltar/cerrar el sheet. Durante seleccion se ocultan los chips de filtro
y el control compacto de seleccion reemplaza la fila de `Archivados`, debajo del
asistente personal AI, con conteo, cancelar, `Seleccionar visibles` y `Mas
acciones`; las acciones masivas minimas son marcar como leidos via
`/contacts/chats/read` y archivar/restaurar la seleccion. El sheet completo debe
mantener agendar cita, registrar pagos, programar mensaje, agregar etiqueta,
silenciar/quitar silencio, controles del agente, marcar como leido y
archivar/restaurar. No debe existir swipe lateral de fila para estas acciones.

El cliente React Native debe usar bottom sheets nativos para acciones de bandeja,
no `Alert.alert`, cuando el flujo existe como sheet en `/movil`: `Mas` de la
fila, `+` de nuevo chat y selector de destinatarios despues de tomar foto o
video. En `Nuevo chat`, la lista de contactos no debe mostrar un boton/avion de
enviar por fila: tocar cualquier punto de la fila abre o crea la conversacion
directamente. La camara nativa usa `expo-image-picker`, requiere
`NSCameraUsageDescription` y `NSMicrophoneUsageDescription`, permite tomar foto o
video corto y abre una pantalla completa de envio: la previsualizacion real del
contenido queda arriba en una tarjeta compacta con imagen/video completo sin
recorte, y abajo queda la busqueda de contactos con checklist multi-seleccion.
El composer inferior replica el chat: campo de caption opcional y flecha circular
de envio a la derecha; no debe mostrarse un boton grande de "Selecciona
destinatarios". Las listas de seleccion que salgan desde estos sheets/pantallas deben
ocultar la barra desplazadora y pintar las filas seleccionadas a todo el ancho,
sin recortes laterales. Para
WhatsApp, `mobile/` convierte el archivo local a data URL con `expo-file-system`
y envia por `/api/whatsapp-api/messages/image` o
`/api/whatsapp-api/messages/video`; si algun contacto no tiene telefono o se debe
enviar por otro canal, esa brecha debe quedar en
`docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`.

La pagina nativa de Pagos vive en `mobile/src/App.tsx` (`PaymentsSection`) y debe
mantener paridad visual con `frontend/src/pages/PhonePayments/PhonePayments.tsx`:
primer viewport sin header generico de usuario, titulo `Elige como quieres
pagar`, opciones segun licencia y pasarelas disponibles, seccion fija `Pagos`
con chips horizontales `Hoy`, `7 dias`, `30 dias`, `90 dias` y `Personalizado`
separado visualmente al final; el
rango personalizado captura `startDate/endDate` en formato `YYYY-MM-DD` y filtra
por `/api/transactions`. Tambien incluye vista de productos con crear/editar/eliminar. La
app nativa lee `account_currency` via `/api/config`, zona horaria via
`/api/settings/timezone`, transacciones via `/api/transactions` con
`startDate/endDate` y productos via `/api/products`; cualquier importe visible
debe formatearse con la moneda del registro o de la cuenta, no con una moneda
hardcodeada. La app lee `/api/license/status` e `/api/integrations/status` para
definir capacidades: plan `basic` solo muestra pago unico offline, y cualquier
plan sin Stripe, Conekta, Mercado Pago, CLIP o Rebill conectado tambien queda en
modo pago unico offline. `Planes de pago` y `Suscripcion` solo aparecen cuando
la licencia permite `payment_plans`/`subscriptions` y existe al menos una
pasarela conectada. Si Pagos se abre desde el boton de cobro del header de una
conversacion y la cuenta esta en modo offline, salta directo al wizard de pago
unico con ese contacto precargado. En cuentas con pagos avanzados, la pagina
muestra el contacto asignado y `Registrar pago unico`, `Planes de pago` o
`Suscripcion` saltan directo al wizard de cobro con ese contacto precargado. Al
tocar `Registrar pago unico`, `Planes de pago` o `Suscripcion`
desde Pagos sin contexto de chat,
la app nativa debe abrir primero el mismo bottom-sheet de seleccion de contacto
que Calendario usa para `Nueva cita`; despues de elegir contacto abre el wizard
del cobro con ese contacto precargado. El wizard nativo cubre datos base,
registro manual, link de pago con pasarela/MSI basico, parcialidades y
suscripciones contra los endpoints existentes. En el wizard, los tres tipos de
cobro deben permitir elegir entre `Precio personalizado` y `Producto guardado`;
si se elige producto, el monto, moneda y `lineItems` salen del precio guardado
pero el monto puede ajustarse antes de cobrar. El selector `Precio personalizado`
/ `Producto guardado` debe ser un tab list; al elegir producto, la seleccion de
producto y precio se hace con campos desplegables, no con una lista abierta.
Cuando una suscripcion se crea por autorizacion/link de pasarela y el backend
devuelve `subscriptionStartUrl`, `stripeCheckoutUrl`, `conektaCheckoutUrl`,
`mercadoPagoInitPoint`, `mercadoPagoSandboxInitPoint`, `rebillPaymentLinkUrl` o
`rebillCheckoutUrl`, el movil debe regresar al chat del contacto con el preview
del link preparado en el composer. Cuando la suscripcion se activa con tarjeta
guardada, debe regresar al chat con el marcador/notificacion de cobro completado
cuando aplique, sin inventar un link.
Para suscripciones por autorizacion, el movil debe enviar `paymentMethod`
`stripe_link` en Stripe y `conekta_link` en Conekta; para tarjeta guardada debe
enviar `stripe_saved_card`, `conekta_subscription` o `rebill_subscription` segun
la tarjeta seleccionada.
permanente. `Registrar pago unico` manual no debe preguntar estado: al registrar
un pago recibido, el estado se manda siempre como `paid`/confirmado. Cuando
`Registrar pago unico` crea un link de pago, la app nativa debe abrir la
conversacion del contacto usando por default el ultimo canal disponible del
contacto. El campo de texto debe quedar vacio para que el usuario escriba su
mensaje libremente, pero encima del campo debe mostrar una tarjeta local de vista
previa del link con titulo, monto, pasarela y dominio para que el usuario vea que
esta enviando un cobro, no un URL pelon. Si el usuario no escribe texto, el envio
usa la URL del link como texto minimo. El usuario revisa el texto y lo envia
manualmente desde el chat; la app no debe auto-enviar links de cobro sin
confirmacion humana. El boton final del wizard debe nombrar la accion real:
`Registrar pago` para pagos offline recibidos, `Enviar enlace de pago` para
links o domiciliacion, y `Cobrar tarjeta` para cobros directos con tarjeta
guardada.
Los planes de pago deben agrupar el primer pago en su propio bloque con monto,
fecha y metodo; los pagos restantes solo capturan monto y fecha, porque la
domiciliacion o tarjeta guardada define como se cobran los futuros cargos. La
app nativa debe permitir link de domiciliacion por pasarela o cobro directo con
tarjeta guardada cuando el contacto tenga una disponible. Toda fecha especifica
del wizard movil debe abrir el calendario nativo compartido y mostrar una fecha
legible, no un campo crudo `YYYY-MM-DD`. Las suscripciones deben pedir inicio,
pasarela, frecuencia y cada cuantos periodos, usando el mismo monto/producto
seleccionado. Si se porta el flujo completo de
tarjetas guardadas, impuestos, validaciones avanzadas de MSI o todos los caminos
de `RecordPaymentModal`, esa brecha debe cerrarse tambien en `mobile/` y
registrarse en `docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`.

La conversacion nativa en `mobile/src/App.tsx` debe cargar el mismo journey
recortado que `/movil` (`/contacts/:id/journey` con `chatMessagesOnly` y
`messageLimit`), agrupar mensajes por dia usando la zona horaria del negocio,
mostrar avatar/badge de canal en el header y exponer acciones equivalentes por
bottom sheet: adjuntos/camara, ubicacion, agendar cita, registrar pagos,
programar mensaje, agregar etiqueta, silenciar, archivar/restaurar y controles
de agente. Cuando el agente conversacional este activo en el chat, enviar un
mensaje manual desde `mobile/` debe abrir una confirmacion antes de mandar: el
usuario elige pausar el agente por 24 horas y enviar, quitar el contacto del
agente y enviar, o cancelar. El boton `+` de la conversacion debe priorizar los
controles del agente arriba del sheet cuando haya estado de agente asignado, con
acciones rapidas para pausar, tomar/continuar u omitir segun el estado. En
`/movil`/`ios/app`, los banners y acciones de agente deben contar solo estados
cuyo `agent_id` pertenezca a un agente configurado actualmente; los estados
historicos o cacheados de agentes eliminados no deben mostrarse como "agentes
asignados" ni habilitar acciones. El
composer nativo manda texto por `/whatsapp-api/messages/text`,
fotos por `/whatsapp-api/messages/image`, videos por
`/whatsapp-api/messages/video`, documentos por
`/whatsapp-api/messages/document`, notas de voz por
`/whatsapp-api/messages/audio` y ubicacion por
`/whatsapp-api/messages/location`. Las previews nativas deben diferenciar cada
tipo como `/movil`: fotos con proporcion real y `contain` sin marco fijo,
video reproducible, waveform de nota de voz con avatar/microfono/progreso,
tarjeta abrible para documento y mini-mapa con tiles de OpenStreetMap para
ubicaciones. El auto-scroll de la conversacion solo debe llevar al ultimo
mensaje durante la carga inicial o cuando el usuario ya esta abajo; si el
usuario esta arrastrando o navegando el historial, ningun recalculo de contenido
debe devolverlo forzosamente al ultimo mensaje.
Las fotos, videos, documentos, archivos y enlaces tocados desde el hilo o desde
`Archivos del chat` no deben abrir Safari/Chrome en el primer tap: deben abrir el
modal de enfoque propio de Ristak. Imagenes y videos se presentan dentro del
modal; documentos/enlaces muestran una ficha interna y dejan `Abrir fuera` como
accion secundaria. Ubicaciones y links de pago quedan fuera de esta regla porque
su flujo natural requiere Maps o checkout externo.
ubicacion. Los globos de texto deben interpretar el formato estilo WhatsApp
(`*negrita*`, `_italica_`, `~tachado~` y monospace con backticks) sin romper URLs
ni identificadores con guion bajo. Cualquier canal pendiente
(QR, HighLevel, Messenger, Instagram, email/SMS) debe quedar marcado como brecha
en `docs/MOBILE_NATIVE_PARITY_CHECKLIST.md` hasta que use el mismo contrato que
`/movil`.

El sheet nativo de `Programar mensaje` debe mantener paridad con `/movil`: no
programa automaticamente a una hora fija, sino que pide texto, fecha,
hora, minuto y AM/PM. La fecha/hora se interpreta en la zona horaria del negocio,
se valida como futura y se envia al backend como `scheduledAt` UTC usando el
endpoint `/whatsapp-api/messages/scheduled`. La fecha se elige desde un mini
calendario modal dentro del sheet; en la conversacion, los mensajes programados
se pintan con borde punteado, reloj, countdown lateral y meta `Programado para`,
no como mensajes enviados normales con palomitas. Al tocar o mantener presionado
un globo programado, las acciones deben permitir editar la programacion o
eliminarla antes del envio. El calendario no debe permitir seleccionar dias ya
vencidos y debe cerrar al elegir fecha para evitar capas/gestos trabados en iOS.
En nativo, WhatsApp programado debe mandar `provider='whatsapp_api'` y
`transport='api'`; SMS programado debe mandar `provider='highlevel'` y
`channel='sms_qr'`. Messenger, Instagram y correo no tienen programacion movil
activa todavia: la UI debe avisar que se pueden enviar al momento, pero no
programar.

Los globos de la conversacion nativa pueden deslizarse a la derecha para activar
`Responder` cuando son entrantes y a la izquierda cuando son salientes. En
entrantes, el cue de respuesta aparece a la izquierda del globo y apunta hacia la
izquierda; en salientes, aparece a la derecha y apunta hacia la derecha. El cue
usa el icono visual de reenviar/forward dentro de una capsula suave y solo
aparece durante el gesto, desde que el dedo empieza a arrastrar, no despues de
soltar. El composer muestra la barra `Respondiendo a...` y el envio de texto
manda `replyToMessageId`/`replyToProviderMessageId` al backend para que
WhatsApp/Messenger/Instagram conserven la referencia real. No prometas respuesta
contextual para adjuntos, ubicacion, notas de voz o SMS si el proveedor no lo
soporta; en esos casos el usuario debe cancelar la respuesta activa antes de
enviar ese tipo de contenido.

Al dejar presionado un globo, la conversacion nativa debe disparar haptic y abrir
acciones estilo WhatsApp: el fondo se atenúa/vidria, el globo seleccionado se
presenta centrado para dejar espacio, las reacciones quedan en una tira separada
y las acciones aparecen como dropdown debajo del globo. La entrada debe sentirse
inmediata: el conjunto sube desde abajo hacia el centro y las reacciones hacen
un bombeo corto. El globo enfocado debe contener todo su contenido, incluidos
adjuntos, notas de voz, ubicacion, meta y reacciones, sin desbordar por los
lados. No uses bottom sheet para acciones de mensaje.

Los globos nativos deben conservar el estilo de la app original y responder al
modo claro/oscuro: inbound/outbound, programados, fallidos, audio, ubicacion y
adjuntos deben tener fondo, texto, meta y controles legibles para el tema
activo, con sombra mínima, radios compactos, meta alineada con chip
`API`/`QR`/`IG`/`FB`, icono de robot cuando el mensaje lo envio el agente
conversacional, hora y palomitas. Las notas de voz
deben verse dentro de burbujas compactas y legibles en claro y oscuro, con play
plano gris relleno sin círculo, waveform gris sin contorno azul, punto de
progreso con acento funcional, textos de duración/hora del mismo tamaño que la meta de
mensajes, composición de dos filas como la web original, avatar en el lado que
corresponda segun direccion y micrófono solido pequeño superpuesto, sin badge
circular, usando el mismo SVG/path para el contorno y el relleno: primero stroke
del color del globo y encima fill gris, como la web original; nunca recortes la
foto del avatar. Si el audio trae origen `API`, `QR`, `IG` o `FB`,
la etiqueta debe mostrarse junto a la hora; si fue enviado por el agente
conversacional, el icono de robot debe vivir en esa misma meta row. Todo queda alineado al extremo derecho del
globo, mientras la duracion queda debajo del inicio de la waveform. Tocar el
avatar de la nota de voz alterna velocidad `1x`/`2x`/`4x` y muestra el badge de
velocidad sobre el avatar; en movil el motor nativo puede capar la velocidad
real al maximo soportado por la plataforma.
Las razones tecnicas de ruteo como `Capturado desde la sesión de WhatsApp Web.`
o `Capturado desde la sesión API.` no deben renderizarse como texto ni como nota
del globo, porque el canal visible ya vive en el chip `API`/`QR` junto a la
hora.

Los mensajes de ubicacion en la conversacion nativa deben renderizarse como un
embebido de mapa dentro del globo, contenido al ancho del bubble, con un badge
compacto `📍 Ubicación` que marque claramente el tipo de mensaje y sin paneles de
texto, subtitulos o botones adicionales. El mapa debe responder al tema
claro/oscuro y nunca salirse del borde del globo.

Las notas de voz grabadas desde el composer nativo no deben caer como archivo
generico en la bandeja de adjuntos. Mientras se graba, el composer debe mostrar
una barra compacta al mismo nivel del panel inferior: papelera sin fondo,
waveform dentro del campo, contador, pausar/reanudar y enviar. La waveform de
grabacion debe sentirse como entrada suave y lenta de derecha a izquierda, con
barras finas y sin saltos tipo frame por frame. El boton de enviar del composer
de texto y de voz usa la misma flecha simple hacia la derecha; no debe cambiar a
avion de papel en uno y flecha en otro. Al detener la grabacion, el preview conserva
el mismo alto compacto con waveform, contador, papelera, reproducir/pausar y
enviar; el audio se envia como payload compatible de WhatsApp (`audio/mp4`) y
las burbujas de audio deben poder reproducirse con progreso suave tanto en
claro como en oscuro. La respuesta del backend y el mensaje recargado del
historial deben conservar `media_url`/`audio.link` reproducible para audios
salientes, no solo `media_id` del proveedor ni un archivo generico; esto aplica a
WhatsApp API/QR, a Messenger/Instagram nativo de Meta y a Messenger/Instagram
cuando viajan por HighLevel. En Meta nativo el audio se envia sin texto como
attachment `audio` con URL HTTPS publica de Ristak; otros archivos de
Messenger/Instagram siguen requiriendo HighLevel. Cuando el
teclado esta abierto, el composer debe sentirse
pegado al teclado como una sola superficie inferior: mismo tono base del teclado,
sin borde rectangular superior y con esquinas superiores redondeadas tipo sheet,
no como una franja externa que empuja visualmente el chat.

En la conversación móvil no uses rails/barras verticales pegadas al lado
izquierdo como indicador visual de foco, comentario o chat no leído. Los estados
de no leído/activo deben resolverse con fondo, tipografía y badge, no con una
franja lateral. Las etiquetas de canal dentro de los globos (`messageTransport`)
son micro-etiquetas sin contorno y con abreviaturas: `IG`, `FB`, `API` y `QR`.
Cuando el backend entregue `sent_by_agent`/`agent_id`, `/movil`, `mobile/` y iOS
deben pintar un icono de robot como micro-marcador de meta del globo, no como
texto visible ni como badge grande.
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
pegados al globo original: WhatsApp API/YCloud y WhatsApp QR/Baileys aceptan
emoji, Meta Messenger/Instagram solo debe ofrecer/aceptar corazon (`love`) por
contrato, y HighLevel/email/comentarios deben avisar que no hay reaccion nativa
en vez de crear un mensaje falso. El cliente nativo debe mandar reacciones Meta
a `/whatsapp-api/meta/social/messages/reaction`, no al endpoint de WhatsApp.
Al abrir o marcar como leido un chat, el cliente nativo debe usar
`/contacts/chats/:id/read`; el backend actualiza el unread local y, segun el
ultimo inbound pendiente, encola en background el visto real del proveedor:
YCloud `markAsRead`, QR/Baileys `readMessages` y Meta Messenger/Instagram
`sender_action='mark_seen'`. Correo queda fuera porque no es chat. Si el
proveedor se tarda o falla, la UI local no debe esperarlo ni trabarse; el backend
debe registrar el fallo. El switch Ajustes moviles > Privacidad, Ajustes
nativos > Privacidad y Configuracion > Cuenta > Privacidad >
`chat_send_read_receipts_enabled` permite apagar solo el acuse externo: el chat
se limpia como leido dentro de Ristak, pero no se manda visto al proveedor.

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

iOS nativo (`ios/app`):

En produccion managed, la ruta recomendada es que Ristak Installer concentre las
credenciales APNs cifradas en su base (`mobile_apns_key_id`,
`mobile_apns_team_id`, `mobile_apns_bundle_id`, `mobile_apns_private_key_p8`,
`mobile_apns_environment`) y reporte `iosConfigured=true` en
`/api/license/mobile-push/status`. La instalacion cliente registra el token APNs
en `/api/push/mobile-devices` y delega el envio al portal central. El broker
central intenta el ambiente configurado y reintenta el alterno cuando APNs
responde `BadDeviceToken`, cubriendo builds de desarrollo/sandbox y
produccion sin duplicar secretos por cliente.

Solo una instalacion standalone que de verdad no use Installer debe configurar
APNs localmente:

```bash
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_BUNDLE_ID=com.ristak.ios
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

**2. Icono de WhatsApp de los avatares** (asset optimizado en la esquina inferior del avatar, en la lista de chats y en el header).

- Componente: `PhoneMessageChannelIcon` (`frontend/src/components/phone/PhoneMessageChannelIcon.tsx`).
- Se usa en `renderChannelBadgeIcon` dentro de `PhoneChat.tsx`; el icono recibe
  `avatarChannelBadgeWhatsapp`.
- El relleno del avatar no debe ser verde. El verde vive sólo en el aro social
  (`avatarWhatsapp` -> `--avatar-ring-color`) y en el badge compacto de canal.
- En la app nativa, el badge de avatar debe usar
  `mobile/assets/channel-badges/whatsapp.webp`, recortado por transparencia y
  reducido para pesar unos pocos KB. No uses un glifo transparente/outline
  directo sobre el avatar: se pierde en avatares claros, fotos y fondos cian.

Perillas (todas con sus valores actuales):

| Qué quieres cambiar | Dónde | Valor actual |
|---|---|---|
| **Tamaño del glifo en la lista** | `.phoneChatPage[data-phone-chat-device="phone"] .chatItem > .avatar .avatarChannelBadgeWhatsapp .channelIconGlyph` en `PhoneChat.module.css` | `14px` |
| **Tamaño del glifo en el header** | `.conversationHeader .avatar .avatarChannelBadgeWhatsapp .channelIconGlyph` en `PhoneChat.module.css` | `13px` |
| **Verde del canal** | `--phone-channel-whatsapp` en `PhoneChat.module.css` / tokens globales móviles | `#25d366` |
| **Aro del avatar WhatsApp** | `.avatarWhatsapp` en `PhoneChat.module.css` | `--avatar-ring-color: var(--phone-channel-whatsapp)` |

Reglas al tocarlo:

- En `mobile/src/App.tsx`, `ChannelAvatarBadgeIcon` es el renderer de assets para
  avatares. `ChannelBadgeIcon` queda para composer/sheets, donde conviene seguir
  usando iconografía vectorial simple.
- El badge de WhatsApp conserva el logo de canal; el relleno del avatar conserva
  identidad Ristak. El badge no debe tener sombra pesada ni cambiar el color del
  avatar completo.
- Verifícalo corriendo la app en la **lista de chats** (no solo el header: el header
  no tiene las reglas por dispositivo, así que puede engañar). Si la lista local está
  vacía, revisa al menos el header + los tamaños computados.
