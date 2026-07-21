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

La auditoria del 2026-07-09 encontro cinco valores unicos `com.ristak.*` en el
repo (excluyendo dependencias y builds generados). El numero de menciones puede
cambiar cuando se edita documentacion; la fuente de verdad es esta tabla de
proposito:

| Identificador | Uso correcto | Estado |
| --- | --- | --- |
| `com.ristak.app` | App nativa Apple oficial de App Store en `ios/app` y topic APNs default historico. | Activo iOS oficial |
| `com.ristak.app.NotificationService` | Notification Service Extension embebida en la app Apple oficial para avatar/media de push iOS. | Activo iOS oficial |
| `com.ristak.android` | Paquete Android de `mobile/` React Native/Expo. | Activo Android |
| `com.ristak.native` | Nombre viejo invalido para Android; no debe usarse porque `native` es palabra reservada de Java y rompe Gradle. | Prohibido |
| `com.ristak.chats` | Identificador interno de UI/navegacion, no bundle id ni package id de app. | Interno |

Regla practica: para builds nuevos usa `com.ristak.android` en Android,
`com.ristak.app` en la app SwiftUI Apple de `ios/app`. No regreses la app Apple
oficial al bundle temporal anterior; ese namespace ya no es el objetivo de
tienda.

En Configuracion > Aplicacion movil, la accion principal de iOS debe mandar al
App Store oficial de Ristak:
`https://apps.apple.com/us/app/ristak/id6782473900`. El enlace web interno de
Chat puede mantenerse como respaldo PWA/navegador, pero iPhone y iPad no deben
seguir guiando al usuario a instalar desde Safari cuando se ofrece la app nativa.

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
real debe entrar por Chats con la lista en su posicion nativa inicial y el campo
`Buscar chats` visible. En esta raiz, `searchable` usa
`navigationBarDrawer(displayMode: .always)`: el modo automatico de iOS arranca
con el drawer colapsado y produce la falsa impresion de que la pantalla ya fue
desplazada. No uses `ScrollViewReader.scrollTo` contra la primera fila de la
`List`: con `navigationTitle` grande y `searchable`, esa fila vive debajo del
header/search y forzarla como ancla hace que la pantalla abra visualmente mas
abajo. Si hay que reiniciar la bandeja, remonta la `List` con una identidad nueva
y deja que iOS coloque el tope real.

Cada fila real de las bandejas `/movil`, `mobile/` e `ios/app` comparte el mismo
contrato: al deslizar hacia la izquierda aparecen, en ese orden, **Más** y
**Archivar** (o **Restaurar** dentro de Archivados); al deslizar hacia la derecha
aparecen **No leído** y **Fijar/Desfijar**. No se ejecuta una acción completa por
accidente y el gesto desaparece durante selección múltiple. Los fijados quedan
arriba y tanto ese estado como el pendiente manual persisten localmente por
dispositivo; abrir o marcar leído un chat elimina el pendiente manual.

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
`maintainVisibleContentPosition {minIndexForVisible: 0, autoscrollToTopThreshold}`
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
llegar sin reemplazar su `id`: la identidad persistida vive en
`serverMessageId`, el estado remoto se fusiona dentro del mismo objeto y el
preview local (`dataUrl`/archivo) se conserva mientras el hilo siga montado.
Así el poll no desmonta la fila, no vuelve a descargar la foto ni altera su
altura. Las filas (`NativeMessageBubble`, `ChatRow`) van en `React.memo` con
callbacks de identidad estable. Cada intento conserva un `externalId` estable
al reintentar despues de timeout/ACK perdido. Los adjuntos se leen y envian uno
por uno; si falla solo una parte, no se reenvian los archivos ya confirmados.

La unica excepcion de apertura es un gate de una sola ejecucion: cuando aparecen
las primeras filas reales, `onContentSizeChange` lleva el offset invertido a
cero exactamente una vez. Ese gate no vuelve a reaccionar a imagenes, prepends o
polls y por eso no pelea con el dedo del usuario. La lista no rebota ni aplica
overscroll; el mensaje mas reciente queda junto al composer. Antes de montar un
hilo, Android precarga solo su archivo de cache si existe para que el primer
frame ya tenga mensajes. Un timeout o `5xx` sin snapshot produce error inline,
sin abrir `/journey` ni iniciar reintentos ocultos, y deja un boton manual;
nunca se presenta como `Aun no hay mensajes`. Un `200 []` contradictorio con el
preview/conteo del inbox intenta una sola recuperacion por journey y jamas borra
un snapshot visible.

Recepcion viva del chat nativo: `mobile/` debe suscribirse a
`/api/chat-events/stream` con la misma sesion bearer que usa para REST. Cada
`chat_message` aplica inmediatamente sus metadatos a la fila existente
(`contactId`, instante, direccion, canal, transporte y tipo), actualiza el no
leido entrante y promueve la conversacion antes de esperar otra llamada de red.
Despues hace un refetch silencioso y coalescido como reconciliacion canonica; ese
refetch no calienta avatares externos, tiene timeout/cancelacion y solo refresca
el hilo si el `contactId` coincide con la conversacion abierta. El backend
persiste el incremento de `chat_read_states` antes de publicar el evento para que
la reconciliacion no observe un contador viejo. El polling sigue existiendo como
respaldo adaptativo, no como ruta normal: Android reconcilia bandeja e hilo cada
30 s mientras SSE esta desconectado y cada 2 min con el stream sano; iOS usa 25 s
durante la desconexion, 2 min para la bandeja conectada y no mantiene polling
periodico del hilo conectado. Tras una desconexion real, ambos clientes hacen
una reconciliacion canonica al reconectar. La primera conexion no se trata como
reconexion ni duplica el bootstrap; en iOS, si el GET inicial fallo con el stream
sano, se permite una sola recuperacion silenciosa. Ningun cliente vuelve al poll
fijo de 12 s/4 s.

Los nudges de SSE, push y polling comparten backpressure. Una rafaga admite como
maximo dos GET inmediatos: la solicitud actual/primaria y un follow-up. Si llega
actividad despues de iniciar ese follow-up, conserva un dirty bit y agenda un
unico trailing refresh tras 500 ms; todos los nudges del cooldown se pliegan en
esa misma lectura. Timers, gates y resultados viejos se invalidan al desmontar,
cambiar contacto, API, sesion o cuenta. Todo refresh es silencioso, conserva
cache/scroll y no calienta avatares externos. El hilo no vuelve a descargar el
journey completo ni manda `mark-read` si no aparecio un entrante nuevo; los
programados se reconcilian con una frecuencia menor.

Crear, editar, cancelar, enviar o marcar con error un mensaje programado publica
`chat_data_changed` con el dominio `scheduled_messages` despues de persistir el
estado. `/movil`, `mobile/` e `ios/app` deben tratarlo como una invalidacion del
contacto: descartar la lectura cacheada de programados y pedir de inmediato la
lista canonica, incluso si el poll normal de Android todavia esta dentro de su
limite de 30 segundos. El evento no promueve la fila, no incrementa no leidos y
no finge que el mensaje ya fue enviado.

Al abrir una conversacion, `/contacts/:id/conversation` es la ruta critica y sus
ultimos mensajes se pintan en cuanto responde. El journey completo y los
mensajes programados cargan despues con cancelacion/generacion propia; nunca
deben retener el spinner del hilo.
Cuando `chat_message_activity` esta `ready`, el backend selecciona primero los
IDs exactos de WhatsApp, Meta y email en orden global `(message_sort, cursorKey)`
y despues hidrata solo esas filas. Si la proyeccion aun no esta lista conserva el
fallback compatible por identidad/telefono, siempre con deadline de 8 s y
cancelacion real al cerrar el cliente. Las ramas auxiliares de atribucion de
WhatsApp y confirmacion de cita siguen entrando al merge final.
La paginacion historica de esa ruta usa un cursor keyset compuesto:
`beforeMessageDate` + `beforeMessageCursor`. Cada evento de chat devuelve un
`cursorKey` estable y el backend ordena por `(instante, cursorKey)`; asi, si
varios canales guardaron mensajes en el mismo instante, el limite no omite ni
repite filas. `beforeMessageDate` sin cursor conserva compatibilidad estricta
con clientes anteriores. `mobile/` guarda el limite de la pagina cruda que
respondio el servidor —incluidas reacciones o tarjetas que no generan una
burbuja normal— y no lo vuelve a calcular desde los mensajes visibles. Un poll
de la ventana reciente tampoco debe reemplazar el limite historico que el
usuario ya alcanzo.

El outbox local conserva durante siete dias solo mensajes salientes locales que
sigan pendientes o hayan fallado. Al reabrir un hilo, un pendiente sin acuse ni
copia reconciliada del servidor se convierte en fallido y ofrece `Reintentar`;
si el envio original sigue activo no se habilita el segundo intento. Una
respuesta canonica exitosa fusiona la copia remota con el mensaje optimista y
limpia su estado fallido. La cache del hilo no se escribe antes de terminar la
hidratacion inicial, pero despues de hidratarse una respuesta autoritativa vacia
si debe persistir `[]` para retirar mensajes fantasma.

Arranque offline-first de Android: antes de pedir datos frescos al servidor,
`mobile/` precarga solamente los cinco snapshots necesarios para la primera
pintura (bandeja, marca de first sync, configuracion/labels del shell y catalogo
de filtros), con presupuesto total de 4 MiB, y entonces expone el shell. La
precarga general del namespace se difiere hasta despues de las interacciones y
enumera metadata, lee y limpia en lotes de cuatro, cediendo el hilo JS despues
de cada lote; sigue acotada a 180 archivos, 32 MiB y 45 dias. Entre lotes valida
namespace y epoch: un cambio de cuenta cancela el resultado y una escritura
foreground ya presente en RAM siempre gana sobre el snapshot viejo de disco.
Una entrada corrupta o vencida se descarta sin impedir abrir la app. Esa copia
general cubre configuracion y labels del shell,
bandeja y conversaciones, bootstrap/rangos de calendario, catalogos del chat,
capacidad de Pagos (plan, pasarelas y HighLevel), productos, pagos recientes,
impuestos, Analiticas (KPIs, grafica, embudo, origen y numeros) y paneles de
Ajustes. Cada pantalla pinta el ultimo estado correspondiente a su rango o
scope exacto y lo revalida en segundo plano; un timeout no la vacia ni oculta
flujos que ya estaban verificados. Una respuesta fresca exitosa, incluso `[]`,
es autoritativa y reemplaza el snapshot. Esa copia vive en `expo-file-system`
bajo el namespace del servidor/cuenta conectada; `SecureStore` queda solo para
token/base URL y preferencias chicas. El primer render no debe mostrar un
spinner circular ni vaciar la pantalla si ya hay datos guardados. El task
`ristak-inbox-refresh` refresca la bandeja y, con concurrencia dos, hasta seis
hilos recientes ausentes o atrasados cuando Android concede una ventana. El
task headless `ristak-chat-notification-refresh-v1` hace una ruta distinta y
acotada: da al hilo del `contactId` un presupuesto maximo de 1.8 s, confirma su
escritura si alcanza, publica una sola alerta local deduplicada y despues
refresca una pagina de inbox. Si vence el presupuesto aborta ese GET y alerta de
inmediato. La precarga exclusiva no puede persistir despues del abort; un warmup
compartido o commit atomico que ya empezo puede concluir solo en su namespace
capturado y revalida la sesion, sin contaminar otra cuenta. Nunca pide journey ni
hace fan-out de recientes dentro de un push. Ambos son best-effort:
Doze, ahorro de bateria o cierre forzado pueden posponerlos, y la fuente de
verdad sigue siendo el backend al reconectar. Antes de escribir vuelven a
verificar namespace y credenciales para que un logout/cambio de cuenta descarte
respuestas viejas. Si el refresh del inbox responde correctamente con cero chats, tambien persiste `[]` como
resultado autoritativo para no revivir filas viejas en el siguiente arranque
offline. Los catalogos y eventos de calendario tambien viven en
esa cache de archivos; no se guardan arreglos grandes dentro de `SecureStore`.
La ultima identidad verificada y su ACL se conserva en un registro pequeno
en `SecureStore`, ligado al servidor y token de esa sesion sin guardar el bearer
dentro del namespace. En arranque offline solo esa ACL conocida puede habilitar
secciones; sin usuario verificado la navegacion falla cerrada. Con licencia
aplicada, una fuente de features invalida o una llave de modulo ausente tampoco
concede acceso por default. La app revalida al volver a estado activo y cada 30 s
mientras esta en foreground: solo un `401` o `license_blocked` definitivo elimina
sesion/cache; timeout, offline y `5xx` conservan temporalmente la ultima ACL
valida.

Cuando una cuenta todavia no tiene snapshot local de bandeja ni marca de
bootstrap completado, Android muestra progreso solo para cuenta, primera pagina
de conversaciones y copia local. Pide el inbox primero y deja
configuracion/directorio a sus cargas de fondo normales. Si esa pagina sufre
timeout, termina como arranque degradado, abre el producto y reintenta por
SSE/polling; no queda encerrado en una etapa satelite.

iOS nunca cubre el shell con un overlay de bootstrap: mantiene navegacion,
buscador y chrome montados desde el primer frame. Pinta cualquier snapshot de
inmediato o conserva un vacio silencioso mientras inbox y directorio cargan en
paralelo. Numeros, labels, integraciones, flags y etiquetas llegan despues en una
tarea satelite cuyo snapshot puro solo puede aplicarse si siguen coincidiendo
task ID, namespace, generacion y sesion, y si la tarea no fue cancelada.

Al completar o entrar en modo degradado, Android guarda
`mobile:first-sync:completed` dentro del namespace de esa cuenta, por lo que los
siguientes arranques pintan cache y revalidan en silencio. Una cuenta con cero
chats tambien puede completar. iOS guarda la misma marca cuando obtiene estado
primario utilizable de inbox o directorio. Logout o cambio de cuenta limpia la
marca junto con sus snapshots.

Android e iOS precalientan un lote acotado de hasta seis conversaciones recientes
y priorizan el hilo señalado por SSE/push; iOS tambien puede precalentar el
directorio. Ninguno descarga todos los mensajes de todos los hilos.
El historial detallado se pagina al abrir cada chat, como exige el limite de
almacenamiento y privacidad.
Las listas nunca esperan consultas externas de fotos: devuelven inmediatamente
el avatar ya cacheado y el backend encola faltantes en tandas pequeñas para un
refresh posterior.

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

En `ios/app`, Pagos mantiene el SSE solo mientras la app esta activa. Tanto un
evento de cambio como `connected` disparan una reconciliacion REST con debounce,
porque el stream no tiene replay; al volver a foreground tambien se refrescan
las vistas. Pagos recientes pide `statuses=paid,partial` al backend antes de
paginar. Un precio de catalogo con moneda distinta a `account_currency` bloquea
el cobro. Si una tarjeta guardada pierde la respuesta por red, decoding o error
transitorio del servidor, la app marca el resultado como incierto, no permite
reintentar a ciegas y pide revisar el historial para evitar un doble cargo. Un
fallo al consultar tarjetas debe verse como error con reintento, nunca como
"este contacto no tiene tarjetas". Cada cobro con tarjeta guardada manda un
`clientRequestId` persistente por intento; backend y pasarela reservan esa llave,
reproducen la misma respuesta y bloquean un proceso ambiguo en vez de generar un
segundo cargo.

El cliente nativo consolidado en `mobile/` ya agrupa los pases hechos en los
worktrees de Chat, Conversacion, Citas, Pagos, Analiticas, Ajustes, dock inferior,
login y notificaciones. Antes de crear otro worktree movil, parte de esta carpeta
unificada y revisa el checklist de paridad. Ajustes nativo ya incluye numeros de
WhatsApp, selector de numero para la bandeja, dictado de la descripcion del
agente con `expo-audio` y `/api/ai-agent/transcribe`, activacion de push nativo
con `expo-notifications`, y Ajustes reales de apariencia/chat. La preferencia
`mobile_chat_theme_preference` soporta sistema, claro, noche y horario; el shell
nativo debe aplicarla como paleta global, no solo como fondo de `StatusBar`.
La preferencia tambien se persiste localmente en el dispositivo para que
`BootScreen` y el login arranquen con el mismo claro/noche/sistema/horario antes
de que exista sesion o antes de que llegue `app_config`; no deben volver al tema
del sistema por defecto si el usuario ya eligio otro modo desde Ajustes.
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
asistente personal. En `mobile/`, el composer del asistente mantiene `+` para
enviar fotos y documentos como attachments al agente; los videos se bloquean en
movil hasta que la app genere miniatura/contenido visual legible para el backend.
En `ios/app`, la fila ya no abre un placeholder: conserva hasta 24 mensajes de
contexto por request, mantiene la categoria en las continuaciones, presenta
fuentes y opciones aclaratorias accionables, y explica dentro del chat si OpenAI
falta o requiere reconexion. En ambos clientes el microfono graba nota de voz, la
transcribe con `/api/ai-agent/transcribe` y manda el texto resultante al mismo
chat. Las burbujas del asistente nativo deben renderizar el formato basico que ya
usa el asistente de escritorio: negritas, italicas,
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

En `ios/app`, los hitos de cita y pago dentro del timeline se presentan como
tarjetas centradas con superficie real, borde semantico azul/verde y divisores
laterales. La tarjeta acepta el ancho disponible hasta un maximo compacto, nunca
usa tamaño horizontal fijo y permite que el detalle ocupe dos lineas; nombres,
conceptos, horarios o montos largos no pueden salir de los bordes del chat.

En listas y headers de chat, el avatar del contacto no lleva aro ni contorno por
canal. El canal se identifica con un badge inferior derecho usando los assets
WebP nativos de `mobile/assets/channel-badges/` y
`ios/app/Ristak/Resources/channel-badges/`, sin disco, fondo, borde ni brillo
extra alrededor.

Los envios manuales desde la conversacion nativa deben tener un candado
sincronico antes de cualquier validacion async del agente o del canal: un doble
tap no puede crear dos requests API. Cuando el backend responde con
`localMessageId`, el globo optimista debe conservar su ID visible y guardar el
ID real en `serverMessageId`. El refresh silencioso empareja ambos IDs y absorbe
la copia persistida dentro del globo existente; nunca debe borrar el optimista
para insertar otra fila.

El botón de canal del composer inferior mantiene el mismo catálogo en `/movil`,
React Native Android e iOS: cada WhatsApp nativo, `WhatsApp · HighLevel` y cada
número SMS activo de HighLevel aparecen como rutas independientes. Seleccionar un
WhatsApp HighLevel liga la ruta al `business_phone` del ultimo inbound
`ghl_whatsapp` verificado; seleccionar un SMS pasa el `fromNumber` del inventario
LC Phone en texto, archivos, audio, ubicación y programación. El catalogo
`/api/highlevel/phone-numbers` declara `source=lc_phone` y `channels=['sms']`: no
es inventario WhatsApp y nunca se reutiliza como tal. La ventana WhatsApp
HighLevel solo usa el inbound dirigido a ese mismo numero; no toma prestada una
respuesta de Meta Direct, YCloud, QR ni otro remitente y nunca cambia a SMS en
silencio. Si
el token HighLevel no permite leer números, el fallback `SMS · HighLevel` sigue
operativo con el remitente predeterminado de la cuenta. Ninguna ruta HighLevel
puede heredar el `phoneNumberId` de un WhatsApp nativo.

La aceptacion HighLevel sin recibo durable, incluida `sent/pending/queued`, se conserva como pendiente en el globo
hasta recibir `sent/delivered/read/failed` por webhook o sync. El `messageId`
remoto y `localMessageId` enlazan el optimista con ese estado durable; si falla,
la app muestra el motivo guardado y no una palomita anticipada.

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

El fondo de la conversacion nativa usa una textura sutil detras de los globos.
La app Android de Play usa esa textura de forma estatica y no incluye
`expo-sensors`/`DeviceMotion`, porque esos modulos agregan
`android.permission.ACTIVITY_RECOGNITION` aunque la app no tenga funciones de
salud. El manifest Android tambien bloquea explicitamente ese permiso con
`android.blockedPermissions`; no lo quites salvo que Ristak agregue una funcion
real de salud/actividad fisica y se complete la declaracion de salud en Google
Play. Los mensajes, header y composer no deben moverse ni redimensionarse.

El avance por fases de esa paridad vive en
`docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`. Antes de retomar la migracion nativa,
lee ese checklist para saber que ya quedo, que sigue pendiente y que fuentes del
codigo original deben revisarse.

## Shell web `/movil`

`/movil` es la experiencia movil web de Ristak. Usa las mismas pantallas moviles
del frontend y es la referencia funcional que deben mirar `mobile/` e `ios/app`
cuando una feature exista en varias superficies. Las rutas legacy `/phone/*`
redirigen a `/movil/*`.

En iOS la app SwiftUI de `ios/app` es la ruta oficial de iPhone/iPad para App
Store. Al abrir desde Xcode o desde el icono del celular, el login muestra la
marca Ristak, pide correo y contraseña, resuelve la empresa contra el portal
central y autentica contra la instalación pública correspondiente. La app no
debe mostrar configuración avanzada ni campos manuales de servidor en login.

En la app Apple nativa de `ios/app`, la bandeja de chats no debe mostrar textos
de refresco como `Actualizando...` debajo del titulo principal; los refrescos en
segundo plano son silenciosos y el subtitulo se reserva para informacion util
como no leidos. El sheet de `Agente conversacional` tampoco debe pintar
placeholders, rails o barras durante la carga: si todavia no hay datos, el
espacio queda limpio hasta que aparezca el contenido real. El editor nativo del
agente debe mantener paridad con el formulario web de Configuracion > Agente
conversacional, en este orden: Personalidad e instrucciones, Operacion tecnica
del chat, Objetivo y cierre, Reglas de atencion, Entrada y salida. La app puede
usar controles nativos, pero debe preservar y editar las mismas familias de
opciones: proveedor/modelo de IA, identidad, tono, idioma, instrucciones,
demoras, entrega de mensajes, notificaciones, follow-up, objetivo, acciones de
cierre, flujos de cita/venta/datos/filtro/link/anticipo, acciones extra, datos
obligatorios, reglas de handoff, alcance y filtros.
En esa misma bandeja, enviar o recibir actividad de una conversacion mueve su
fila al inicio inmediatamente, antes de esperar la reconciliacion REST. El hilo
notifica esa actividad a la bandeja aunque la cubra en iPhone, y SSE aplica el
mismo cambio con deduplicacion para no inflar no leidos. REST conserva la
autoridad sobre texto, perfil y contadores. Los refresh por SSE, polling o
foreground usan `/api/contacts/chats?warmProfilePictures=false` y conservan los
avatares ya hidratados; la precarga remota de fotos se reserva para arranque frio
y paginacion para que no convierta cada tick en una consulta lenta.
El hilo iOS abre `/api/chat-events/stream` antes de esperar conversacion, journey,
contacto y catalogos. Un evento recibido durante el bootstrap queda como nudge
pendiente y dispara una sola reconciliacion REST coalescida al terminar la carga
base. Status WhatsApp e inventario HighLevel se leen desde Ristak en paralelo,
con un retry corto y conservando el ultimo snapshot valido; no se consulta Meta
ni HighLevel en un loop.
Los selectores de `Nuevo chat`, `Nueva cita` y contacto para pagos comparten el
directorio ligero `/api/contacts/search?picker=true`: al abrir pintan primero el
ultimo snapshot de esa cuenta, revalidan en segundo plano y buscan en servidor
despues de un debounce corto. No deben recargar la bandeja de chats para obtener
contactos. El resultado fresco es autoritativo sobre contactos borrados u
ocultos y debe incluir todos sus telefonos para no iniciar la conversacion con
un numero distinto al que hizo match. El backend incluye la foto de perfil de
WhatsApp o Meta que ya este persistida, sin consultar proveedores al abrir el
selector; iOS conserva ademas el ultimo avatar valido del snapshot de la bandeja
cuando una respuesta ligera no trae foto. Asi `Nueva cita` y pagos muestran el
mismo avatar disponible en `Nuevo chat`, en lugar de degradarlo a iniciales.
`matchedPhone` solo se usa cuando el texto
es realmente un telefono; cifras dentro de un nombre no pueden cambiar el
destinatario, y la eleccion explicita se conserva por contacto y cuenta para que
cerrar/reabrir el hilo no regrese silenciosamente al telefono principal. Antes
de reutilizar una eleccion restaurada se valida contra `phone + phones` frescos;
si el inventario aun es solo cache, el composer no puede enviar por ese destino,
y si el numero fue eliminado se borra la seleccion local. El
primer envio a un contacto elegido desde el directorio inserta su fila arriba
aunque aun no exista en la primera pagina REST. Si un SSE entrante pertenece a
un chat fuera de las paginas cargadas, primero usa el indice ligero en RAM; si no
existe, coalesce la rafaga y pide solo
`/contacts/search?picker=true&contactId=<id>&limit=1`, sin bloquear el stream ni
mostrar spinner. El refresh de la primera pagina queda como respaldo y el piso
de no leidos evita perder o duplicar eventos cuando ambas respuestas compiten.
Una fila REST solo reconoce eventos cuya fecha/identidad ya contiene; una pagina
vieja no puede tragarse el delta nuevo. Si bandeja e hilo reciben el mismo SSE,
`conversationIsVisible=true` gana y no enciende un no-leido falso.
El snapshot solo se habilita cuando existe
un usuario verificado; nunca se persiste bajo un namespace compartido de
`sin-usuario`, y las consultas exactas viven en un LRU temporal de memoria.
Los encodes detached del hilo capturan ademas una generacion de sesion: si el
usuario cambia de cuenta antes de terminar, la escritura se descarta. Precarga y
commit final a disco comparan la misma generacion, incluso tras salir y volver a
entrar a la misma cuenta.

El hilo pide primero `/api/contacts/:id/conversation` y presenta los mensajes en
cuanto llega ese bloque primario; estado del agente, programados y otros datos
secundarios no pueden mantener un spinner encima de un historial ya disponible.
Para instalaciones anteriores conserva fallback a `/journey`, y los pickers
conservan fallback al listado historico mientras termina un despliegue gradual.

La preparacion de fotos, videos, audios y documentos corre fuera del hilo visual.
Mientras se prepara, el composer muestra estado y bloquea otro envio/adjunto;
mantiene el maximo de 4 archivos y un tope acumulado de 40 MB binarios. La app
sube el multipart desde un archivo temporal a `/api/media/upload` y manda al
proveedor la referencia del asset/CDN; no duplica el body completo en RAM ni
guarda el preview optimista como base64. Un backend legacy puede recibir data URL
como fallback, pero esa conversion tambien ocurre fuera del `MainActor` y no se
persiste en el snapshot local. Al llegar el eco con URL remota, la burbuja libera
el binario local de la foto para evitar acumulacion de memoria en hilos largos;
un `data:` base64 no cuenta como URL remota y se elimina de `url` y `dataUrl` en
el DTO persistido. Si ya existe CDN, tampoco se conserva una copia base64
paralela en RAM.

La app registra intervalos cerrados de arranque, bandeja, directorio, hilo,
agenda, pagos, analiticas y media con el handle de `MetricKit` y `mxSignpost`,
por lo que siguen visibles en Instruments y se agregan como `MXSignpostMetric`.
Tambien registra hitos cerrados de APNs/registro/recepcion con `OSLog`, y se
suscribe a `MetricKit` para contar hangs, crashes y excepciones sin guardar nombres,
telefonos, mensajes, URLs ni tokens. Un ring buffer local acotado conserva solo
categorias y numeros sanitizados. `RistakTests` valida orden/promocion y estados
iniciales, incluida la logica real de promocion 250 veces sobre 10,000 filas;
`RistakUITests` cubre arranque, busqueda, historial, cita y nuevo chat;
`scripts/run-ios-chat-soak.sh` estresa 10,000-50,000 filas de un harness sintetico y
`scripts/run-ios-live-smoke.sh` abre las superficies reales de forma opt-in.
El login nativo de `ios/app` debe conservar logo/colores de Ristak y no debe
mostrar configuraciones tecnicas de servidor; al capturar el correo, la app
detecta automaticamente la instalacion correcta antes de autenticar.
Cada request nativo conserva el tenant, token y generacion con los que inicio:
una respuesta tardia de otra cuenta no puede desloguear ni hidratar la sesion
actual. Los 503 solo se reintentan automaticamente en `GET`/`HEAD`, nunca en
acciones que puedan duplicar mensajes, citas o cobros. Mientras el usuario aun
se resuelve, el shell puede mantener sus secciones; una vez resuelto, si no tiene
acceso a ningun modulo, muestra unicamente Ajustes para explicar la situacion y
permitir cerrar sesion, no todos los modulos por fallback.

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
- App Apple nativa en `ios/app`: el login de `com.ristak.app` muestra marca
  Ristak, solo pide correo y contraseña, no expone servidor manual y resuelve la
  cuenta por correo vía `https://www.ristak.com/api/mobile/resolve`.
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
hardcodeada como fuente de verdad de negocio. Si cualquiera de esos valores no
se puede confirmar, la pantalla muestra reintento y no renderiza cifras con un
fallback inventado. El rango personalizado usa fechas
`YYYY-MM-DD` y debe aplicar el mismo rango a metricas, grafica, embudo y origen.

La pantalla nativa debe conservar la estructura de `PhoneAnalytics`: encabezado
`Analiticas`, selector de periodo, 8 KPIs, grafica principal con chips, scopes
financieros, embudo con scopes, origen por fuente y origen por numero de
WhatsApp cuando existan varios numeros detectados.

En `ios/app`, todos los carruseles horizontales de filtros de Analiticas llegan
sin margen al borde interior de su tarjeta, pero su viewport se recorta en ese
borde: ningun chip puede dibujarse sobre el fondo de la pantalla. La grafica de
doble serie reserva un techo visual del 20 % sobre el valor maximo —el dato mas
alto ocupa como maximo 80 % del plot— y cada linea lleva un relleno degradado
sutil hacia la base sin modificar los valores ni los callouts.

En `ios/app`, una revalidacion solo se considera fresca cuando completaron
metricas, grafica, embudo y origen. Si alguno falla, se conservan los snapshots
disponibles pero la pantalla muestra que no todo pudo actualizarse, y al volver a
foreground vuelve a intentar. La consulta de numeros de WhatsApp corre aparte de
Origen: un fallo de telefonos no bloquea ese panel ni borra los numeros
cacheados; la cache secundaria solo se reemplaza tras una respuesta exitosa.

La licencia `web_analytics` se respeta igual que en `/movil`: sin esa feature no
se pide la serie de visitantes, `funnel` y `origin-distribution` mandan
`includeWeb=0`, y la UI oculta `Visitantes`/`Trafico` en vez de convertir un 403
silencioso en ceros falsos.

En Android, contexto de cuenta, resumen/KPIs, grafica, embudo y origen conservan
estado de carga y error independiente. Si falla una de esas consultas, su panel
muestra el error con `Reintentar` y no lo convierte en cero ni en `Sin datos`;
los paneles que si respondieron permanecen utilizables.

El acceso a esta pantalla usa el modulo ACL `dashboard` tanto en Android como en
`/movil`, porque su contrato principal son los endpoints `/api/dashboard/*` y el
resumen operativo/financiero del negocio. El modulo ACL `analytics` conserva su
significado de sesiones, visitantes y conversiones web en la superficie de
escritorio; no debe usarse como atajo para abrir datos del Dashboard. En tablet,
el panel embebido dentro de Chat repite el mismo guard y no puede saltarse el
`AccessRoute` de `/movil/analytics`.

## Icono de instalación

El icono público de la app móvil usa el isotipo de Ristak. iOS usa variantes
nativas por apariencia: `AppIcon-light-1024.png` para modo claro,
`AppIcon-dark-1024.png` para modo oscuro y `AppIcon-tinted-1024.png` alineado al
icono claro mientras no exista un asset tinted dedicado. Android muestra siempre
el isotipo claro oficial en el launcher, independiente del modo del sistema: el
tema de la app se decide al abrir Ristak y no debe cambiar su identidad en la
pantalla de inicio. El nombre visible de la app Android es exactamente
`Ristak`, nunca `Ristak Native`.

Los assets nativos y PWA deben mantenerse sincronizados para que el icono sea
consistente en App Store, Play Store, Android launcher y "Agregar a pantalla de
inicio":

- iOS: `ios/app/Ristak/Assets.xcassets/AppIcon.appiconset/`.
- Android: `frontend/android/app/src/main/res/mipmap-*/ic_launcher*.png`,
  `frontend/android/app/src/main/res/mipmap-night-*/ic_launcher*.png` y los
  fondos adaptive en `frontend/android/app/src/main/res/values*/ic_launcher_background.xml`.
  Las notificaciones Android usan `@drawable/ic_stat_ristak` como small icon
  del sistema. Para el Android legacy Capacitor, el backend FCM no debe mandar
  un bloque visual `notification`: debe mandar data-only para que
  `RistakFirebaseMessagingService` pinte el avatar, logo y previews con el
  renderer nativo propio. Android Expo conserva alerta remota en clientes
  `expo`; solo chat con capacidad `expo_background_v1` cambia a data-only y
  genera su alerta local despues de precargar, como define la seccion de push.
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
  Android. El launcher adaptativo y el splash inicial usan el asset claro; la
  pantalla `BootScreen` y el login nativo usan los WebP
  transparentes `mobile/assets/ristak-*-mode-sin-fondo.webp`, generados desde
  los logos oficiales de modo claro/noche. En `mobile/` si debe verse marca al
  cargar; en `/movil` la carga web sigue sin logo ni nombre visible.

Solo las push de mensajes reales de chat deben mostrar identidad de contacto
como remitente. Si existe una foto publica, esa foto viaja en
`contactAvatarUrl` y `senderAvatarUrl`. Si no existe foto, el backend debe
generar un PNG publico de iniciales en `/api/push/contact-avatar/:contactId` con
firma en querystring y usar esa URL en los mismos campos.
En iOS, el target `ios/app/RistakNotificationService` (`com.ristak.app.NotificationService`)
procesa ese payload con `mutable-content`, pinta el avatar como remitente con
Communication Notifications y adjunta media real cuando venga separada del
avatar. La extension debe aplicar `INSendMessageIntent` exclusivamente cuando
`category=chat`; una cita, pago, prioridad de agente u otro evento nunca puede
convertirse en Communication Notification porque iOS reemplazaria el titulo del
evento por el nombre del contacto.

Las push de eventos usan titulo semantico y cuerpo compacto. Una cita nueva se
muestra como `📅 Nueva Cita` y `Contacto - 28 Mayo, 11:00 AM`, usando la zona
horaria de la cuenta. Un pago exitoso se muestra como `💸 Nuevo Pago` y
`Contacto ($20,000)`, usando la moneda del pago o, si no viene, la moneda de la
cuenta. Estados como pago rechazado, pendiente, reembolso, cita confirmada o
cancelada conservan su titulo especifico. Los eventos no deben recibir
`contactAvatarUrl`/`senderAvatarUrl`, aunque pertenezcan a un solo contacto.

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
`NSLocationWhenInUseUsageDescription` en `ios/app/Support/Info.plist`.

En QR, YCloud y Meta Direct, mensaje, unread y SSE quedan confirmados antes de
esperar la red push. QR y YCloud disparan la notificacion best-effort fuera de su
ruta critica. Meta Direct inserta un job `push` en
`chat_delivery_outbox` dentro de la misma transaccion que reclama el inbound y
despierta al worker despues del commit; el ACK del relay no espera APNs, FCM ni
Installer.

Los requests locales a APNs, FCM y OAuth FCM tienen presupuesto end-to-end de
8 s, incluida la lectura del response body; Web Push usa el mismo timeout.
Installer central conserva su propio presupuesto end-to-end de 5 s en
`licenseService`. Un token se invalida solo por razones permanentes explicitas
del proveedor, no por cualquier `400`. Un fallo transitorio total o parcial deja
el job pendiente y restringe el siguiente intento a los IDs exactos de
suscripcion/device que fallaron. Cuando el evento ya conoce destinatarios,
`push_subscriptions` y `mobile_push_devices` se filtran por `enabled + user_id`
en SQL, no cargando todos los dispositivos de la cuenta en memoria. Un
`apns_not_configured`/`fcm_not_configured` del broker tambien es transitorio: no
se acepta como entrega. Si falla la comprobacion de contactos ocultos, la ruta
durable reintenta; las llamadas best-effort conservan el fail-closed para no
filtrar contenido sensible.

Meta Direct encola `push` y `meta_enrichment` como trabajos independientes con
unicidad `(job_kind, message_id)`, lease, heartbeat y backoff. Push y
`meta_enrichment` tienen lanes/locks separados, por lo que Graph, descarga o
Storage nunca bloquean la notificacion. Push admite hasta 20 intentos con
backoff acotado a 5 min. `meta_enrichment` usa hasta 2,016 intentos,
aproximadamente siete dias con ese backoff, para tolerar caidas largas de Graph
o Storage. Al agotar su politica queda `failed`/dead-letter con `failed_at`; un
replay real del mismo webhook puede revivir solo el enrichment con payload nuevo,
nunca una push terminal. El enriquecimiento actualiza la misma fila y publica
`isNew=false` para que el cliente reconcilie el adjunto sin otra burbuja ni otro
no-leido; si la media ya esta hidratada termina como no-op. Un fallo reintenta el
job, no el relay ni el unread.

La ejecucion es at-least-once, no exactly-once: un crash despues de que el
proveedor acepta la entrega y antes de completar el job puede repetir una
notificacion. `messageId`, tag y collapse permanecen estables para reducir
duplicados donde el proveedor o sistema operativo lo soporte. Al completar o
entrar en dead-letter, `payload_json` se reemplaza inmediatamente por `{}`; solo
queda metadata operativa durante 7 dias para `completed` y 30 dias para `failed`.
Los jobs pending/reintentables siguen durables.

La limpieza terminal no corre en cada tick de entrega: se intenta como maximo
una vez por hora y procesa lotes de hasta 500 filas por categoria. Asi el scrub
defensivo de payloads legacy y la retencion no convierten la tabla historica en
un scan repetido cada 10 s.

Las lanes de `push` y limpieza forman parte de la infraestructura del sistema y
permanecen siempre activas,
incluso si Meta Direct se desconecta despues de confirmar el inbound. Solo la
lane `meta_enrichment` se registra como cron de integracion y se enciende mientras
Meta Direct siga conectado localmente; no depende de que sea el provider de envio
activo. Los avatares inbound tambien se rehospedan despues de la primera
persistencia. Citas, automatizaciones y agente corren post-ACK como best-effort
registrado en deploy drain; un crash abrupto aun puede cortar esos side effects
sin deshacer el mensaje confirmado.

En Android hay dos contratos de push y no se deben mezclar:

- Android legacy Capacitor (`frontend/android`, paquete `com.ristak.app`) usa
  `RistakFirebaseMessagingService` y debe recibir FCM data-only. En ese caso
  `title`, `body`, `contactAvatarUrl`/`senderAvatarUrl`,
  `notificationImageUrl`/`notificationAttachmentUrl`, `threadId`, `messageId`,
  `url` y `androidChannelId` viajan en `message.data`; no debe mandarse
  `message.notification` porque Firebase tomaria el control visual y se pierde
  el renderer custom.
- Android Play/Expo (`mobile/`, paquete `com.ristak.android`) registra el token
  legacy con `clientType=expo`; ese cliente conserva `message.notification`
  visible mas toda la navegacion en `message.data`. El binario con precarga
  headless registra `clientType=expo_background_v1` solo despues de confirmar el
  task nativo: exclusivamente para push de chat con esa capacidad FCM manda
  data-only, sin las llaves reservadas `title`/`body`/`message`; titulo y cuerpo
  viajan como `ristakRelayTitle`/`ristakRelayBody`. El task actualiza cache y
  agenda una sola alerta local marcada `ristakBackgroundRelay=1`; el handler de
  foreground oculta solo la remota headless y conserva visible ese relay. Citas,
  pagos y otros eventos siguen usando alerta remota visible. No cambies por
  paquete solamente ni retires el bloque visible a builds `expo` anteriores,
  porque dejarian de alertar con la app cerrada.

En Android Play/Expo, permiso del sistema y registro del token en
`mobile_push_devices` son estados distintos. La app solo puede mostrar
`Alertas activas` cuando `POST /api/push/mobile-devices` confirme un registro
habilitado con id; un permiso concedido por si solo no prueba entrega. Si falla
la obtencion o persistencia del token, el resultado es `failed`, no `denied`, y
la app reintenta a los 5/15/60/300 segundos y al volver a foreground. La
renovacion del token usa el mismo backoff. Ajustes revalida el registro de forma
idempotente y muestra que falta completar el registro cuando el permiso existe
pero el backend aun no reconoce el celular.

En ambos casos el small icon del sistema sigue siendo el icono monocromatico de
la app y los canales Android oficiales son `ristak_alerts`, `ristak_sound`,
`ristak_vibrate` y `ristak_silent`.

En iOS/APNs, cualquier payload, extension de notificaciones, capability o perfil
de firma pertenece a la app Apple bajo `ios/app`, no a `mobile/`. Si hace falta
mantener Communication Notifications, avatars o attachments en iPhone/iPad,
documentalo y desarrollalo en la ruta Apple nativa.

Las push APNs de `category=chat` combinan alerta visible,
`mutable-content=1` y `content-available=1`. La app principal usa esa ventana
para precargar inbox y el hilo señalado y no completa el fetch hasta vaciar las
escrituras pendientes. `BGAppRefreshTask` y el tiempo residual al entrar en
background mantienen un lote reciente como respaldo oportunista. Todo resultado
queda atado al token de namespace/generacion y a un permiso monotónico por hilo
reservado antes del GET; una sesion que cambio o una respuesta vieja no puede
contaminar ni atrasar la cache nueva. El single-flight usa leases cancelables:
al expirar la ventana de iOS reporta completion una sola vez y cancela la red si
ya no existe otro consumidor. La extension de notificaciones descarga avatar y
media en paralelo y entrega el texto en un maximo interno de 1.8 s aunque esos
adornos sigan lentos.

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
contornos duros y elevaciones pesadas: los controles flotantes e iconograficos
usan superficies neutrales, borde sutil y sombra ligera. El dock inferior no
debe depender de una capa tipo liquid glass/translucida que se pierda sobre el
fondo: la capsula base debe tener color real desde la paleta activa y el
indicador seleccionado debe ser una capsula solida de la paleta primaria, con
icono blanco y contraste claro. Los iconos no seleccionados usan el tono muted
del tema activo. No pintes rellenos azules o cian para simular material; los
estados seleccionados de tablists, filtros y segmented controls se leen por
superficie neutral, sombra, contraste y texto. Los iconos de navegacion y
toolbar deben mantenerse finos (`strokeWidth` aproximado 1.75-2.0); reserva
trazos mas gruesos solo para badges o estados muy pequenos donde la legibilidad
lo exija. El indicador activo del dock se mueve con `translateX` siguiendo el
dedo y debe recalcular sus colores cuando cambie `mobile_chat_theme_preference`
o el tema de sistema.

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

La bandeja nativa usa swipe horizontal con el contrato compartido descrito
arriba. Tocar una fila abre el chat; mantenerla presionada abre el sheet `Mas
acciones` con feedback haptico. En ese sheet, `Seleccionar` debe ser la primera
accion, antes de agendar, registrar pagos o cualquier otra herramienta. Al tocar
`Seleccionar`, la lista entra en seleccion multiple y desde ahi se pueden marcar
leidos, archivar/restaurar, seleccionar visibles o seleccionar todas las
conversaciones reales de la bandeja, aunque todavia no esten cargadas en
pantalla. `Seleccionar todos` no respeta el filtro visual actual: su contrato es
literalmente todo el inbox seleccionable; el asistente AI y filas no-chat quedan
fuera.

Las fechas de la lista de chats se formatean con la zona horaria del negocio:
los mensajes del dia actual muestran la hora exacta (`7:47 p.m.`), los del dia
anterior muestran `Ayer`, del anteayer hasta antes de una semana muestran el dia
de la semana, y despues fecha corta como `04-jul`. No uses `Hoy` en filas de
chat con mensaje del dia actual.

La bandeja nativa no debe quedarse limitada al primer bloque de conversaciones.
`mobile/` consume `/contacts/chats` con `limit`, carga el primer lote de 50 chats
y al llegar al final pide el siguiente bloque con cursor estable
`beforeMessageDate` + `beforeContactId` (y `offset` solo como compatibilidad si no
existe borde util). Los lotes se fusionan por `contact.id` para evitar duplicados
y preservar avatares ya hidratados. El primer lote fresco es autoritativo cuando
trae menos de 50 filas:
debe retirar chats eliminados/ocultos en vez de conservar fantasmas de cache. Si
la pagina viene llena, solo conserva la cola ya cargada que sea realmente mas
antigua que el borde fresco. Para ordenar, los timestamps SQLite
`YYYY-MM-DD HH:mm:ss` se interpretan como UTC igual que los ISO; Android/Hermes no
debe decidir la zona del instante.

Para entrantes de WhatsApp, Messenger, Instagram y comentarios Meta, el backend
reserva `channel + message_id` en `chat_inbound_message_claims`. El claim y el
incremento de `chat_read_states` ocurren juntos; solo el proceso ganador publica
el SSE y activa los efectos de mensaje nuevo. Los imports historicos reservan la
misma llave sin crear no leidos, para que un webhook repetido no reviva historial
viejo ni duplique la fila.

## Remitente de WhatsApp en chat movil

En `/movil`, el boton de canal del composer debe listar cada WhatsApp conectado
como opcion separada cuando la cuenta tiene mas de un remitente. Elegir
`WhatsApp · <nombre/numero>` cambia el remitente del chat abierto, guarda ese
`phoneNumberId` como `preferred_whatsapp_phone_number_id` del contacto y lo
mantiene al reabrirlo desde cualquier superficie; no debe obligar al usuario a
ir al desktop o a la ficha para elegir entre WhatsApp 1, WhatsApp 2, etc. Guardar
esa preferencia es best-effort: si el contacto responde `404` o hay una falla
transitoria, la seleccion de la sesion sigue activa y el envio no regresa al
remitente anterior.
La conversacion nativa en `mobile/` debe aplicar el mismo contrato: el selector
del composer solo muestra rutas realmente conectadas para ese chat, lista cada
numero de WhatsApp disponible por separado y agrega Messenger/Instagram solo si
la integracion Meta correspondiente esta conectada y el contacto pertenece a
ese canal. `ios/app` conserva ese mismo boton de canal en el panel inferior,
antes del boton `+`, y comparte la preferencia persistente con `/movil`, Android
y la ficha `Contactando desde`.

El remitente automatico sigue la misma prioridad en las tres superficies:
`preferred_whatsapp_phone_number_id`, ultimo `lastInboundBusinessPhone*`, ultimo
`lastBusinessPhone*` y finalmente el default conectado. Cada request nativo
conserva juntos `phoneNumberId`, `fromPhone` y `transport`; texto, media,
ubicacion, plantilla y programacion no pueden mezclar el ID elegido con el
telefono de otro mensaje.

La selección de transporte es idéntica en `/movil`, React Native Android y iOS:
si la fila elegida tiene API disponible, el envío usa `transport=api` aunque el
mismo número tenga QR conectado. Una ventana cerrada abre/solicita plantillas y
nunca cambia a QR. `transport=qr` sólo se resuelve cuando la API de esa fila está
indisponible o el número es QR standalone. La UI no debe pintar un globo QR
optimista para después ocultarlo: el transporte se decide antes del request y el
backend vuelve a validarlo.

Con Coexistence y API operativa, Baileys no aporta tráfico vivo al historial;
el webhook oficial es la única fuente. Esto evita el globo transitorio duplicado
en iOS/Android sin usar deduplicación por texto o tiempo. HistorySync QR sí puede
importar mensajes antiguos por identidad exacta.

La info del contacto muestra "Contactando desde". Ese sheet y el boton de canal
inferior son controles persistentes del mismo contacto: `Automatico` limpia
`preferred_whatsapp_phone_number_id`
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

La ficha revalida en segundo plano sin mostrar una pastilla o spinner de
`Actualizando datos` encima del avatar. `Campos personalizados` usa como fuente
autoritaria las definiciones activas creadas por el usuario: valores huérfanos,
campos `system/systemManaged/locked` y metadatos de integraciones como
`meta_social_*` nunca se convierten en filas visibles. `business_name`,
`business.name` y “Nombre del negocio” pertenecen al perfil de la cuenta y se
ocultan tanto en Info del contacto como en Ajustes, incluso si una instalación
legacy los entrega sin banderas de sistema. La sección `Etiquetas`
permite buscar o crear una etiqueta y coloca inmediatamente debajo la acción
`Meter a una automatización`, limitada a automatizaciones publicadas. En Ajustes
móviles, `Campos personalizados` y `Etiquetas` permiten crear y eliminar sus
catálogos; eliminar una definición o etiqueta aplica el contrato destructivo del
backend para todos los contactos.

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
hereda del calendario. `Crear cita` queda bloqueado hasta que el usuario toque un
slot real; la hora precargada del borrador no cuenta como seleccion. Al cambiar a
`Personalizado`, aparecen selectores internos
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
red, cada cambio de rango cancela la solicitud anterior y solo la generacion mas
reciente puede reemplazar `events`; una respuesta lenta de junio no puede pintar
encima de julio. La cache por calendario/zona/rango vive en `expo-file-system`. En
un arranque sin cache, fallar `/calendars` o `account_timezone` muestra error y
reintento; no se convierte en un calendario vacio exitoso. Con cache valida se
conserva la ultima agenda y se muestra un aviso no bloqueante. Crear, editar o
guardar fechas queda bloqueado hasta confirmar una zona horaria valida. En
Android, un deep link `open=appointment&id=...` se encola hasta que ese bootstrap
de zona horaria y lista de calendarios sea utilizable; solo entonces se consulta
y se marca como atendido una vez, evitando abrir la cita con la zona fallback o
perder la seleccion de su calendario. Cada cita creada desde Agenda o desde el
chat manda un `clientRequestId` estable durante timeout/reintento. El backend
reserva esa llave en `appointment_creation_requests`, reproduce la respuesta ya
completada y bloquea intentos simultaneos, ambiguos o reutilizados con otro
payload para no duplicar la cita ni sus efectos externos.
En el sheet `Nueva cita`, la lista de contactos no debe mostrar icono de enviar
mensaje porque la accion es agendar, no mandar chat.
En `ios/app`, la cache de citas se separa por calendario y mes
(`calendarID + yyyy-MM`). Cambiar de calendario limpia primero las filas del
anterior e hidrata solo el snapshot de la nueva seleccion; volver a foreground
fuerza una revalidacion para no dejar una agenda vieja despues de varias horas
en background.
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
acciones`. Tambien muestra `Seleccionar todos`, que obtiene del backend el
universo completo de ids de conversaciones mediante
`GET /contacts/chats?idsOnly=true`, sin quedar limitado por la paginacion, la
busqueda o los filtros visibles; las acciones masivas deben usar esos ids aunque
las filas no esten montadas. Las acciones masivas minimas son marcar como leidos via
`/contacts/chats/read` y archivar/restaurar la seleccion. El sheet completo debe
mantener agendar cita, registrar pagos, programar mensaje, agregar etiqueta,
silenciar/quitar silencio, controles del agente, marcar como leido y
archivar/restaurar. El swipe lateral conserva solo las cuatro acciones rápidas
del contrato común: Más, Archivar/Restaurar, No leído y Fijar/Desfijar.

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
definir capacidades: los planes `basic` y `medium` solo muestran pago único
offline aunque una licencia vieja marque pasarelas o links como activos. En
Profesional, una cuenta sin Stripe,
Conekta, Mercado Pago, CLIP o Rebill conectado también queda en modo pago único
offline. `Planes de pago` y `Suscripcion` solo aparecen cuando
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
El mismo intento de cobro con tarjeta guardada o alta de suscripcion debe
conservar un `Idempotency-Key`/`clientRequestId` estable aunque la app reciba un
timeout y el usuario pulse reintentar. El backend reserva ese intento antes de
crear cargos, planes, links o suscripciones remotas. Si ya termino, reproduce la
respuesta guardada; si sigue procesando o termino de forma ambigua, lo bloquea
para revision en vez de repetir dinero o crear otra suscripcion a ciegas.
La misma regla aplica al registro manual iniciado desde el chat: Android manda
un identificador estable por intento; `PhoneChat` pasa un scope estable a
`RecordPaymentModal`, y el modal genera y conserva el `Idempotency-Key`. Cambiar
los datos o completar/cerrar el flujo crea un intento nuevo; un timeout por si
solo no lo rota.

Pagos debe confirmar juntos `account_currency` y `account_timezone` antes de
habilitar productos, cobros o fechas programadas; nunca usa la zona por defecto
del telefono o de Mexico como sustituto silencioso. `Registrar pago unico`
manual no debe preguntar estado: al registrar
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

La conversacion nativa en `mobile/src/App.tsx` debe cargar el mismo historial
recortado que `/movil` usando `/contacts/:id/conversation` con `messageLimit`,
agrupar mensajes por dia usando la zona horaria del negocio, mostrar
avatar/badge de canal en el header y exponer acciones equivalentes por bottom
sheet: adjuntos/camara, ubicacion, agendar cita, registrar pagos, programar
mensaje, agregar etiqueta, silenciar, archivar/restaurar y controles de agente.
Cuando el agente conversacional este activo en el chat, enviar un
mensaje manual desde `mobile/` debe abrir una confirmacion antes de mandar: el
usuario elige pausar el agente por 24 horas y enviar, quitar el contacto del
agente y enviar, o cancelar. El boton `+` de la conversacion debe priorizar los
controles del agente arriba del sheet cuando haya estado de agente asignado, con
acciones rapidas para pausar, tomar/continuar u omitir segun el estado. Ademas,
la conversacion Android debe exponer un control visible del agente en el header:
boton compacto con `Bot`/alerta y sheet dedicado `Agente conversacional`. Solo
`active` y `paused` son estados asignados: `paused` mantiene el robot con una
marca de pausa y permite `resume`; `human`, `skipped`, `completed` y `discarded`
son historial terminal, por lo que salen de controles/listas de asignados y no
pueden dejar un robot visible en el avatar, banner o header. Para devolver uno de
esos chats al agente se usa el flujo explicito de asignacion (`activate`), no un
control que finja que el agente sigue ligado. Una senal terminal pendiente puede
seguir mostrandose como alerta humana y descartarse, siempre sin robot. En
`/movil`, `ios/app` y `mobile/`,
los banners y acciones tambien deben exigir que el `agent_id` pertenezca a un
agente configurado actualmente; los estados historicos o cacheados de agentes
eliminados no deben mostrarse como "agentes asignados" ni habilitar acciones. El
hub del agente en `/movil` e `ios/app` no debe exponer un
control "Todos"/"Apagar todos": el usuario controla solo el agente individual
seleccionado. No existe una segunda llave global que pueda impedir su activacion. El
hub global de Android también se abre desde el botón de robot en la esquina
superior izquierda de Chats, igual que `ios/app`. Consume
`/api/conversational-agent/agents`, lista cada agente real y permite
encenderlo o pausarlo individualmente, reiniciar sus contactos omitidos y editar
su configuracion nativa sin salir del celular. Encenderlo publica directamente ese
agente; no hay un switch oculto ni una reversa secundaria. El editor compacto
guarda el prompt editable y muestra las capacidades blindadas activas. Dentro de
una conversación con agente asignado, el robot —con pausa superpuesta cuando el
estado es `paused`— vive dentro de
la cápsula de acciones del header inmediatamente a la izquierda del calendario
y abre el control por contacto; no debe duplicarse fuera de esa cápsula.

El composer nativo manda texto por `/whatsapp-api/messages/text`,
fotos por `/whatsapp-api/messages/image`, videos por
`/whatsapp-api/messages/video`, documentos por
`/whatsapp-api/messages/document`, notas de voz por
`/whatsapp-api/messages/audio` y ubicacion por
`/whatsapp-api/messages/location`. Al elegir una foto, `/movil`, `mobile/` e
`ios/app` la reducen a un maximo de 1600 px y JPEG de calidad de chat antes de
convertirla a data URL; el backend normaliza otra vez como respaldo. El globo
optimista usa la copia local de inmediato y no debe
esperar la subida ni el ACK QR. Cuando Baileys acepta el mensaje con `key.id`, la
UI recibe `sent`; `delivered`/`read` se reconcilian despues en background sobre
el mismo globo. La URL CDN puede guardarse para reaperturas futuras, pero no
reemplaza el preview local en una conversacion ya abierta ni dispara un refetch
bloqueante al terminar el POST.
Las previews nativas deben diferenciar cada
tipo como `/movil`: fotos con proporcion real y `contain` sin marco fijo,
video reproducible, waveform de nota de voz con avatar/microfono/progreso,
tarjeta abrible para documento y mini-mapa con tiles de OpenStreetMap para
ubicaciones. El auto-scroll de la conversacion solo debe llevar al ultimo
mensaje durante la carga inicial o cuando el usuario ya esta abajo; si el
usuario esta arrastrando o navegando el historial, ningun recalculo de contenido
debe devolverlo forzosamente al ultimo mensaje.
En iOS, durante la apertura el ancla inferior observa el timeline completo y la
altura del contenido: vuelve a reafirmar el ultimo mensaje mientras se asienta la
carga primaria y se detiene en cuanto termina esa fase o el usuario inicia su
primer gesto vertical. Después conserva la posicion del usuario. Al abrir,
cerrar o redimensionar el teclado, la conversación captura si el usuario estaba
abajo antes del relayout y reafirma el centinela inferior al inicio y al final de
la animación reportada por UIKit. Así el `LazyVStack` conserva materializadas las
burbujas visibles; nunca debe quedar el fondo vacío hasta cerrar y volver a abrir
el teclado.
Las fotos, videos, documentos, archivos y enlaces tocados desde el hilo o desde
`Archivos del chat` no deben abrir Safari/Chrome en el primer tap: deben abrir el
modal de enfoque propio de Ristak. Imagenes y videos se presentan dentro del
modal; documentos/enlaces muestran una ficha interna y dejan `Abrir fuera` como
accion secundaria. Ubicaciones y links de pago quedan fuera de esta regla porque
su flujo natural requiere Maps o checkout externo.
Los enlaces genericos recibidos no deben hacer una visita automatica desde el
telefono solo por renderizar el globo: muestran host/copy local y cargan el
destino cuando el usuario toca. Los links enviados por el negocio y los de pago
pueden enriquecer metadata con timeout, abort, limite de HTML y cache acotada.
ubicacion. Los globos de texto y el preview de la bandeja de la app nativa Apple
deben interpretar la misma sintaxis que escritorio: `*negrita*`, `_italica_`,
`~tachado~`, inline code con un backtick, monospace con triple backtick, listas
con `- ` o `* `, listas numeradas con `1. ` y citas con `> `. Los marcadores
validos se ocultan solo al pintar; el mensaje almacenado y copiado conserva el
texto original. Delimitadores incompletos, URLs e identificadores como
`folio_123` permanecen literales. Cualquier canal pendiente
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
En nativo, WhatsApp programado manda `provider='whatsapp_api'`. Conserva
`transport='api'` mientras la API esté disponible; si la hora futura queda fuera
de la ventana, exige una plantilla oficial aunque exista QR. Sólo un número QR
standalone o una API ya indisponible puede guardar `transport='qr'`. SMS
programado manda `provider='highlevel'` y `channel='sms_qr'`. Messenger,
Instagram y correo no tienen programacion movil activa todavia: la UI debe
avisar que se pueden enviar al momento, pero no programar.

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
`API`/`QR`/`IG`/`FB`, hora y palomitas. Cuando el mensaje lo envio el agente
conversacional, el icono de robot vive fuera del globo como marcador lateral
segun la direccion del mensaje. Las notas de voz
deben verse dentro de burbujas compactas y legibles en claro y oscuro, con play
plano gris relleno sin círculo, waveform gris sin contorno azul, punto de
progreso con acento funcional, textos de duración/hora del mismo tamaño que la meta de
mensajes, composición de dos filas como la web original, avatar en el lado que
corresponda segun direccion y micrófono solido pequeño superpuesto, sin badge
circular, usando el mismo SVG/path para el contorno y el relleno: primero stroke
del color del globo y encima fill gris, como la web original; nunca recortes la
foto del avatar. Si el audio trae origen `API`, `QR`, `IG` o `FB`,
la etiqueta debe mostrarse junto a la hora; si fue enviado por el agente
conversacional, el robot se pinta fuera del globo igual que en los mensajes de
texto. Todo queda alineado al extremo derecho del
globo, mientras la duracion queda debajo del inicio de la waveform. Tocar el
avatar de la nota de voz alterna velocidad `1x`/`2x`/`4x` y muestra el badge de
velocidad sobre el avatar; en movil el motor nativo puede capar la velocidad
real al maximo soportado por la plataforma.

El color del globo sigue direccion, canal real y modo visual en `/movil`, React
Native Android e iOS. En claro, todo mensaje entrante es blanco, aunque venga de
WhatsApp, Messenger o Instagram, y solo los salientes usan color: WhatsApp API
es verde claro, WhatsApp QR usa un verde apenas mas oscuro, Messenger/Facebook
es azul e Instagram morado rosita. En oscuro, los entrantes usan carbon, los
salientes usan equivalentes profundos por canal y texto, hora y estados cambian
a tonos claros de contraste. Correo, SMS y canal desconocido conservan el fondo
neutral del modo activo. La plataforma social tiene prioridad sobre transportes
genericos como `api`; API/QR solo separa los dos verdes de WhatsApp. Los
programados conservan el borde punteado y un mensaje fallido siempre usa el
estado de error por encima del color del canal.

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
deben pintar un icono de robot fuera del globo como marcador lateral, no como
texto visible ni dentro de la meta interna.
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
YCloud `markAsRead`, WhatsApp API/Meta directo Graph
`PUT /{PHONE_NUMBER_ID}/messages` con `status=read`, QR/Baileys `readMessages`
y Meta Messenger/Instagram `sender_action='mark_seen'`. Correo queda fuera
porque no es chat. Si el
proveedor se tarda o falla, la UI local no debe esperarlo ni trabarse; el backend
debe registrar el fallo. El switch Ajustes moviles > Privacidad, Ajustes
nativos > Privacidad y Configuracion > Cuenta > Privacidad >
`chat_send_read_receipts_enabled` permite apagar solo el acuse externo: el chat
se limpia como leido dentro de Ristak, pero no se manda visto al proveedor.
Cuando el mismo número tiene API oficial activa y QR de respaldo, el backend
manda el visto únicamente por la API; Baileys no participa.

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
`google-services.json` de Android tampoco se commitea en este repo. Para la app
Play/Expo, Ristak Installer lo guarda cifrado como
`mobile_android_google_services_json` y el workflow de tienda lo escribe
temporalmente en `mobile/google-services.json` antes de `expo prebuild`. Para el
Android legacy Capacitor, el archivo local historico vive fuera de Git en
`frontend/android/app/google-services.json`.

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
Para iOS oficial, el broker acepta como configuracion valida unicamente el topic
exacto `com.ristak.app`; un bundle legacy o el paquete Android no debe reportar
`iosConfigured=true`. `ios/app` registra cada token con `platform=ios`,
`clientType=native` y `appPackage=com.ristak.app` para que el backend/Installer
no lo clasifique como Expo o Android.
El permiso de notificaciones y el registro confirmado en backend son estados
distintos. Ajustes solo muestra alertas activas cuando ambos estan listos; el
registro se serializa, reintenta fallos temporales a 5/15/60/300 segundos y se
revalida al volver a foreground si la confirmacion tiene 6 horas. Logout llama
`DELETE /api/push/mobile-devices` best-effort y limpia APNs local incluso cuando
un 401 o una licencia revocada ya impiden usar la sesion.
El archive de App Store firma dos targets: `com.ristak.app` y
`com.ristak.app.NotificationService`. Ambos perfiles se validan y refrescan
desde Ristak Installer antes de disparar el workflow `mobile-store-release`.
La Notification Service Extension serializa su estado para entregar una sola
vez el mejor contenido disponible, cancela al expirar y descarga avatar/media
en paralelo con un presupuesto visual total de 1.8 s. Limita avatar a 5 MB y
media adjunta a 12 MB. Si un recurso excede esos limites o no llega a tiempo, la
notificacion se entrega sin ese enriquecimiento en vez de atorarse.

Solo una instalacion standalone que de verdad no use Installer debe configurar
APNs localmente:

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
