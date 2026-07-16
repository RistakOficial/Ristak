# Mobile Native Parity Checklist

Este documento es el autoprompt persistente para mantener `mobile/` como cliente
React Native/Expo Android sin perder paridad con `/movil`. Si el contexto del
chat se compacta o se pierde, el siguiente agente debe leer este archivo antes
de tocar codigo movil.

## Autoprompt obligatorio

Eres el agente encargado de recrear en `mobile/` la experiencia movil publicada
de Ristak bajo `/movil` para Android/Google. No redisenes, no simplifiques y no
inventes flujos. Tu tarea es copiar el resultado final de usuario usando React Native: misma
jerarquia, textos visibles, iconografia, colores, estados, acciones, filtros,
permisos, errores, vacios, loading, gestos y comportamiento.

Antes de implementar cualquier pantalla o subfuncion:

1. Lee la implementacion original relevante en `frontend/src/pages/PhoneChat/`,
   `frontend/src/components/phone/`, servicios usados y CSS asociado.
2. Enumera los elementos visibles, estados y acciones de esa superficie.
3. Implementa el equivalente nativo en `mobile/src/`.
4. Valida typecheck y, cuando aplique, instala en Android real.
5. Actualiza este checklist con lo terminado, lo pendiente y cualquier brecha
   temporal documentada.

Si dudas si algo debe existir, vuelve al codigo original. No confies en memoria.

## Fuentes de verdad

- Chat movil original: `frontend/src/pages/PhoneChat/PhoneChat.tsx`.
- Estilos de chat original: `frontend/src/pages/PhoneChat/PhoneChat.module.css`.
- Analiticas moviles originales: `frontend/src/pages/PhoneAnalytics/PhoneAnalytics.tsx`
  y `frontend/src/pages/PhoneAnalytics/PhoneAnalytics.module.css`.
- Servicios de analiticas moviles: `frontend/src/services/dashboardService.ts`
  y `frontend/src/services/whatsappApiService.ts`.
- Navegacion movil original: `frontend/src/components/phone/phoneNavigation.ts`.
- Pagos movil original: `frontend/src/pages/PhonePayments/PhonePayments.tsx`.
- Estilos de pagos original: `frontend/src/pages/PhonePayments/PhonePayments.module.css`.
- Formularios de cobro original: `frontend/src/components/common/RecordPaymentModal/`
  y `frontend/src/components/phone/PhoneSubscriptionForm.tsx`.
- Chips/filtros moviles: `frontend/src/components/phone/ui/PhoneFilterChips.tsx`
  y la configuracion en `PhoneChat.tsx`.
- Ajustes moviles originales: `frontend/src/pages/PhoneSettings/PhoneSettings.tsx`
  y `frontend/src/pages/PhoneSettings/PhoneSettings.module.css`.
- Iconos de canal: `frontend/src/components/phone/PhoneMessageChannelIcon.tsx`.
- App nativa nueva: `mobile/src/App.tsx`, `mobile/src/api.ts`,
  `mobile/src/types.ts`.
- Contrato movil: `docs/MOBILE_APP.md`.
- Manual maestro: `docs/RISTAK_MASTER_MANUAL.md`.

## Estado general

- [x] Crear app React Native/Expo en `mobile/`.
- [x] Separar rutas moviles: `/movil` para web, `mobile/` para Android/Google y
      `ios/app` para la app nativa Apple de iPhone/iPad.
- [x] Login por correo + contrasena con resolucion automatica de tenant, igual que `/movil/login`.
- [x] Shell inicial con Chat, Citas, Pagos, Analiticas y Ajustes.
- [x] Primer pase de lista de chats con API real, filtros basicos y filas planas.
- [x] Suprimir avisos intrusivos moviles de acciones exitosas.
  - Avance: en `mobile/` y `/movil`, registrar pagos, programar mensajes y
    crear/editar citas ya no deben mostrar popups/toasts de exito; la
    confirmacion vive en el cierre del sheet, actualizacion de lista o estado
    visible. Errores, permisos, validaciones bloqueantes y confirmaciones
    destructivas se mantienen.
- [x] Consolidar worktrees nativos en una sola app bajo `mobile/`.
  - Avance: los pases de Chat/lista, Conversacion, Citas, Pagos, Analiticas,
    Ajustes, dock inferior, login y notificaciones ya conviven en el mismo
    `mobile/src/App.tsx`, `mobile/src/api.ts`, `mobile/src/types.ts` y helpers.
    No retomes worktrees antiguos como fuente activa sin comparar contra esta
    carpeta unificada.
- [x] Dock inferior nativo.
  - Avance: `mobile/` ya replica la navegacion inferior de `/movil` con
    Ajustes, Chats, Citas, Pagos y Analiticas como iconos sin texto visible,
    indicador animado que persigue la coordenada real del dedo durante el swipe
    horizontal entre tabs, supresion del tap fantasma despues de arrastrar, badge
    de no leidos en Chats y espacio inferior reservado para que las listas no se
    corten detras del panel. Si cambia
    `frontend/src/components/phone/PhoneEcosystemNav.*`, revisar tambien
    `mobile/src/App.tsx`.
- [x] Transiciones nativas entre pantallas.
  - Avance: las secciones principales del shell usan transicion direccional con
    `transform`/`opacity`; abrir una conversacion desde la bandeja monta el chat
    como una capa animada encima de la lista y volver espera a que termine la
    salida antes de desmontar. `BottomActionSheet` centraliza la expansion y
    contraccion suave de sheets/dropdowns para no duplicar animaciones por flujo.
- [ ] Paridad completa de Chat.
- [ ] Paridad completa de Citas.
  - Avance: `mobile/` ya reemplaza el placeholder generico de Citas por una
    pantalla nativa con header movil tipo `/movil`: pastilla de periodo con
    anio, capsula `Hoy` / calendario / `+`, titulo grande del mes, grilla
    mensual amplia, agenda del dia, pull to refresh y sheet de detalles. Los
    eventos se agrupan con `account_timezone` y `calendarId`, no con la zona
    horaria del telefono. El boton `+` busca contactos y abre un formulario
    nativo que crea citas reales en `/api/calendars/appointments`; el detalle
    permite editar y eliminar contra los endpoints reales. El formulario ya
    cubre titulo, estado, fecha, hora, duracion, direccion, notas y conversion a
    UTC con zona del negocio.
  - Corregido 2026-07-05: la vista Hoy/Semana ya abre seleccion de horario con
    long-press/tap sobre el timeline, sin cancelar el gesto por micro-movimiento
    vertical; las tarjetas de eventos usan texto mas compacto; la agenda deja de
    repetir el anio debajo del mes; la fila de dias vive en una sola banda
    horizontal; el separador de fecha queda mas pegado al calendario; el titulo
    del mes se desplaza con el mismo `Animated.Value` que la grilla mensual; y el
    formulario nativo se compacto para parecerse mas al `AppointmentModal` movil
    original.
  - Corregido 2026-07-05, segunda pasada: la grilla mensual ya no vive dentro de
    un contenedor visual completo; solo la fila de dias de la semana mantiene una
    capsula. Las capsulas superiores de anio/Hoy/calendario/+ son mas compactas,
    la separacion entre calendario y resumen del dia queda al minimo, las tarjetas
    de citas del resumen son mas bajas, y la seleccion por long-press del timeline
    dispara haptic y bloquea el scroll mientras se estira el rango hacia arriba o
    hacia abajo.
  - Corregido 2026-07-05, tercera pasada: el alto del mes visible ahora depende
    de sus semanas reales para que meses de cinco filas no dejen huecos antes del
    resumen del dia; el reset del swipe mensual se hace antes del pintado para
    evitar parpadeos al cambiar de mes; y el picker de contactos de `Nueva cita`
    ya no muestra icono de enviar mensaje.
  - Corregido 2026-07-05, cuarta pasada: la grilla mensual usa texto mas chico
    manteniendo una bolita de seleccion grande; las pastillas superiores de anio
    y acciones ya no se estiran hacia el centro; y el formulario de `Nueva cita`
    vuelve al orden visual del original movil con contacto, estado, selector
    fecha/hora, fecha, hora, duracion, resumen, zona horaria, direccion, notas y
    CTA `Crear cita`.
  - Corregido 2026-07-05, quinta pasada: la fila de dias de la semana del mes
    ya no vive dentro de una capsula; queda libre sobre la grilla como en el
    calendario movil original. Cuando el dia seleccionado no tiene citas, la
    lista inferior ahora muestra el estado vacio con icono de calendario y copy
    `No hay citas este dia`.
  - Corregido 2026-07-05, sexta pasada: el sheet `Nueva cita` abre con
    `Por defecto` seleccionado. Ese modo solo muestra fechas disponibles,
    horarios disponibles, invitados, notas y CTA; oculta fecha, hora, duracion,
    zona horaria y direccion. `Personalizado` concentra los selectores internos
    de dia/mes/anio, hora/minutos/AM-PM y duracion por horas + minutos. El
    carrusel de fechas deja un pequeno indicio lateral cuando hay fechas previas.
    `Invitados` queda antes de `Notas`, permite buscar contactos existentes,
    agregarlos sin icono de enviar mensaje, crear contactos nuevos dentro del
    mismo sheet y guardar la lista en notas con bloque `Invitados:` para mantener
    compatibilidad con el backend actual.
  - Confiabilidad 2026-07-10: rangos, slots y usuarios usan cancelacion y
    generacion; una respuesta vieja no reemplaza el calendario actual. Sin cache,
    un fallo de `/calendars` o `account_timezone` es error visible; con cache se
    conserva la agenda con aviso. Crear/editar/guardar queda bloqueado sin zona
    horaria confirmada, sin slot vigente o durante un doble tap.
  - Brechas pendientes: replicar validacion avanzada de slots/bloqueos y usuarios
    Round Robin del modal original de `/movil`.
- [ ] Paridad completa de Pagos.
  - Avance: la pantalla nativa de Pagos ya dejó de ser un resumen recortado.
    Ahora replica el flujo principal de `/movil/payments`: selector de tipo de
    pago, bottom-sheet de contacto antes de configurar el cobro, últimos pagos recibidos con
    periodos Hoy/7 días/30 días/90 días, detalle seleccionable, productos /
    precios guardados con crear/editar/eliminar, pago único manual, liga de
    pasarela con MSI basico, plan de
    parcialidades y suscripción con contacto requerido. Los cobros usan
    `account_currency` y `account_timezone` desde `/api/config`; si no se puede
    leer moneda o zona horaria de cuenta, los formularios no crean pagos ni
    programan fechas con defaults. Los links externos
    se abren con `Linking` desde un sheet nativo de "link listo". Si HighLevel
    está conectado, el pago manual crea invoice y registra pago offline en GHL;
    si no, guarda una transacción local.
  - Brecha pendiente: el formulario nativo no copia todo el `RecordPaymentModal`
    web de escritorio; implementa componentes nativos propios basados en la
    estructura de `/movil`. Aun faltan opciones avanzadas de impuestos, validaciones MSI,
    tarjetas guardadas, selector visual de fecha nativo y envío directo del link
    por WhatsApp/email/SMS desde la pantalla de link listo.
- [ ] Paridad completa de Analiticas.
- [ ] Paridad completa de Ajustes.
  - Avance: Ajustes nativo ya incluye la lista principal, numeros de WhatsApp,
    selector de numero para chats, plantillas, agente, lista de chats, campos
    personalizados, apariencia, notificaciones, dictado de contexto de negocio
    y registro de push nativo. Sigue pendiente la comparacion visual final contra
    `/movil/settings` y cualquier microinteraccion que Raul marque diferente.
- [ ] Push/permisos Android listos para Play/Google.
  - Avance: `mobile/` registra token FCM nativo con `expo-notifications` en
    `/api/push/mobile-devices`, crea canales Android, atiende taps de push para
    abrir el chat por `contactId`/`url`, y el backend genera avatar PNG de
    iniciales cuando el contacto no tiene foto publica. Falta generar/tracked
    `mobile/android` y portar el renderer `RistakFirebaseMessagingService` para
    paridad Android data-only completa.

## Fase Chat

### 1. Bandeja de chats

- [x] Consumir `/api/contacts/chats`.
- [x] Remover layout tipo card en filas.
- [x] Agregar buscador y chips visibles.
- [x] Agregar avatar con foto/inicial sin aro de canal y badge inferior derecho
  con asset nativo.
- [x] Quitar elementos que no existen en `/movil`, como mostrar el correo de
  sesion debajo de `Chats`.
- [x] Usar iconos equivalentes a `/movil` en acciones superiores, buscador,
  chips, vacios, canales y dock.
- [ ] Replicar `PhoneFilterChips`: opciones visibles, conteos, separadores,
  estado activo, chip `+` y comportamiento de manager.
  - Avance: el manager nativo ya abre desde `+`, lista filtros por seccion y
    permite agregar/quitar filtros visibles. Los filtros visibles ya persisten
    localmente en el dispositivo. Falta persistir en `app_config` y conectar
    numeros WhatsApp/presets personalizados reales.
- [ ] Replicar filtros reales: todos, no leidos, citas, clientes, leads,
  comentarios, agente, archivados, numeros WhatsApp y presets personalizados.
- [ ] Replicar fila de archivados y vista de archivados.
  - Avance: `mobile/` ya guarda archivados localmente, oculta esos chats de la
    bandeja normal, muestra fila `Archivados`, permite entrar/salir de la vista
    y restaurar desde acciones del chat. Falta sincronizar con cualquier
    almacenamiento backend si se decide que archivados sea multi-dispositivo.
- [ ] Replicar chat fijo de `Asistente Personal AI`.
  - Avance: la bandeja nativa ya muestra la fila fija `Asistente Personal AI`
    antes de `Archivados` y abre una pantalla nativa placeholder. La fila usa
    la estructura de la fila original: avatar de 48px dentro de slot de 52px,
    texto centrado, meta `Fijo` independiente y separador inferior de ancho
    completo. Falta conectar el historial/proveedor real del asistente de
    `/movil`.
- [ ] Replicar estados de agente: prioridad humana, agente activo/inactivo,
  hub de agente y badges.
  - Avance: Android ya selecciona el estado primario con prioridad similar a
    `/movil`/`ios/app`, muestra el robot dentro de la capsula del header justo a
    la izquierda del calendario, banner cuando hay senal o estado no activo, y
    sheet dedicado con `pause`, `take_over`, `skip`, `resume`, `activate` y
    `clear_signal`. La bandeja ya abre el Hub global desde el robot superior
    izquierdo: lista agentes, permite encender/pausar por agente, reiniciar
    omisiones y editar nombre, identidad, proveedor/modelo, tono, objetivo,
    reglas principales y alcance. Falta portar al editor Android el constructor
    avanzado de condiciones y todos los subflujos de objetivo de iOS.
- [x] Reemplazar swipe lateral por acciones con long press.
  - Avance: por decision de producto, `mobile/` ya no muestra `Mas` ni
    `Archivar/Restaurar` como botones laterales por swipe. Tocar una fila abre
    el chat; mantenerla presionada abre el bottom sheet `Mas acciones` con
    feedback haptico. El sheet conserva archivar/restaurar, marcar leido y las
    herramientas del contacto, y `Seleccionar` va como primera accion para entrar
    a seleccion multiple. Los separadores de chats deben seguir saliendo del borde
    inferior real de la fila y las filas base deben conservar altura tactil amplia
    y avatar grande.
- [x] Replicar filtros horizontales de chat.
  - Avance: los chips de filtros en `mobile/` usan todo el ancho util y arrancan
    al margen izquierdo de la pantalla; no deben quedar centrados con `Todos` o
    cualquier chip lateral cortado al cambiar de filtro.
- [x] Replicar fechas relativas de la lista.
  - Avance: la lista nativa formatea con zona horaria del negocio: hora exacta
    para mensajes de hoy, `Ayer`, dia de semana para 2 a 6 dias y fecha corta
    despues de una semana.
- [x] Cargar la bandeja por lotes.
  - Avance: `mobile/` pide `/contacts/chats` con `limit`/`offset`, muestra el
    primer lote de 50 conversaciones y agrega mas al llegar al final del scroll
    sin duplicar contactos ni perder avatares hidratados.
- [x] Replicar seleccion multiple.
  - Avance: `Mas acciones` > `Seleccionar` entra en seleccion multiple, muestra
    check circular, oculta filtros, permite seleccionar visibles o literalmente
    todas las conversaciones del inbox aunque no esten cargadas, cancelar,
    marcar como leidos via API y archivar/restaurar seleccionados. iOS y Android
    consumen el mismo universo ligero de ids y conservan la seleccion fuera de
    pantalla al ejecutar las acciones masivas.
- [x] Replicar pull to refresh y copy visible.
  - Avance: la lista nativa ya usa pull to refresh, textos de loading/error y
    vacios equivalentes de primer pase. La bandeja hidrata el snapshot
    precargado y revalida sin borrar filas; una respuesta corta o vacia sigue
    siendo autoritativa para retirar fantasmas.
- [x] Replicar recepcion viva de chat.
  - Avance: `mobile/` escucha `/api/chat-events/stream` con bearer, aplica el
    timestamp/direccion/canal/unread y promueve la fila local antes del REST;
    despues reconcilia sin calentamiento de avatares, con timeout, abort y
    coalescing. Tras un gap real, Android e iOS emiten un unico nudge canonico al
    reconectar; el primer `connected` no se trata como reconexion ni duplica el
    bootstrap. iOS permite una recuperacion silenciosa si su GET inicial fallo con
    el stream sano. Una rafaga usa maximo dos GET inmediatos y, si el segundo se
    ensucia, un trailing unico a 500 ms. El polling es adaptativo, no el loop fijo
    anterior de 12 s/4 s. El backend guarda unread antes de publicar el evento.
- [x] Replicar empty/loading/cache-refresh states.
  - Avance: una falla silenciosa conserva filas cacheadas; una respuesta fresca
    corta o vacia retira fantasmas, y la cache canonica no se contamina con una
    busqueda o bandeja filtrada por numero.
  - Primer arranque sin cache: Android muestra progreso reducido a cuenta,
    conversaciones y copia local; un timeout sale en modo degradado y reintenta
    sin secuestrar la app. iOS nunca muestra overlay ni spinner de bootstrap:
    conserva el shell montado y carga inbox/directorio en paralelo. Con snapshot,
    ambas apps pintan inmediatamente y revalidan en silencio.
- [ ] Validar visualmente contra `/movil` en telefono.

### 2. Conversacion

- [ ] Header de conversacion con avatar/canal/estado como `/movil`.
  - Avance: `mobile/` ya abre `NativeConversationScreen` desde la bandeja, usa
    avatar/foto/inicial sin aro de canal, badge nativo, nombre del contacto,
    detalle principal y acciones de agente, etiqueta y busqueda en el header. El
    agente conversacional ya tiene boton compacto, alerta visual y banner de
    estado cuando aplica. El selector inferior ya replica cada WhatsApp nativo,
    `WhatsApp · HighLevel` y cada remitente SMS activo de HighLevel; falta
    replicar el estado online exacto.
- [ ] Timeline con globos inbound/outbound, email desplegable, media, ubicacion,
  notas de voz, documentos y comentarios FB/IG.
  - Avance: el parser nativo de `buildMessagesFromJourney` ya entiende
    `whatsapp_message`, `meta_message`, `email_message`,
    `appointment_confirmation`, adjuntos basicos, ubicacion, comentarios,
    estados, timestamps de lectura/entrega, reacciones y mensajes de sistema.
    La UI nativa ya agrupa por dia con zona horaria del negocio, pinta globos
    inbound/outbound, media imagen, tarjetas de archivo/ubicacion, contexto de
    comentario, receipts y errores. Falta correo desplegable completo, player
    real de audio/video, documentos abribles y carga incremental de mensajes
    anteriores.
- [ ] Composer completo: texto, adjuntos, camara, ubicacion, sugerencia IA,
  voice note, reply/reactions y teclado.
  - Avance: el composer nativo ya muestra boton de canal, `+`, texto multilinea,
    reloj para programar cuando hay texto, camara cuando esta vacio, preview de
    respuesta, tira de fotos preparadas y boton enviar/mic visual. El `+` abre
    sheet con tomar foto, elegir foto, cita, pagos, programar, etiqueta y mas
    acciones; cuando el chat tiene agente realmente asignado (`active` o
    `paused`), los controles del agente aparecen arriba para pausar, tomar,
    omitir o continuar. Un estado `paused` muestra robot + pausa; `human`,
    `skipped`, `completed` y `discarded` salen de esos controles y no dejan el
    robot visible. Para devolverlos al agente se usa la asignacion explicita.
    Una senal terminal pendiente se conserva como alerta humana, nunca como bot.
    Los estados asignados pueden limpiar avisos con `clear_signal`.
    Enviar manualmente con agente activo abre confirmacion para pausar 24h y
    enviar, quitar del agente y enviar o cancelar. Falta voice note real,
    ubicacion, sugerencia IA, plantillas, picker avanzado de fecha/hora y
    soporte de video/audio/documento desde el picker.
- [x] Envio por canal correcto: WhatsApp API, QR, HighLevel, Messenger,
  Instagram, email/SMS cuando aplique.
  - Avance: el composer separa WhatsApp API/QR, HighLevel WhatsApp, cada número
    SMS de HighLevel y Messenger/Instagram; texto, media, ubicación y programación
    conservan la ruta elegida. WhatsApp nativo mantiene su ventana de 24 horas y
    plantillas, mientras WhatsApp HighLevel se liga al ultimo `business_phone`
    inbound verificado y SMS HighLevel pasa el `fromNumber` seleccionado del
    catalogo LC Phone, que nunca se trata como inventario WhatsApp. Android
    conserva juntos `phoneNumberId + fromPhone +
    transport` tambien en plantillas; la seleccion inicial prioriza ultimo
    inbound del mismo numero. Un fallo al persistir preferencia no revierte el
    canal util de la sesion y un fallo transitorio de catalogo conserva el ultimo
    snapshot valido con un solo retry local.
- [ ] Info de mensaje, receipts, errores, pendientes y reintentos.
  - Avance: long press sobre globo abre bottom sheet con preview, reacciones
    rapidas, responder e informacion de canal/estado/hora. Los globos muestran
    pending/error y ticks sent/delivered/read. El outbox conserva pendientes o
    fallidos siete dias, reconcilia acuses al abrir y ofrece reintento real sin
    duplicar un envio que siga activo. Falta pantalla completa de info del
    mensaje y acciones especiales de programados.
- [x] Realtime del hilo disponible durante bootstrap.
  - Avance: iOS abre SSE antes del fetch inicial y conserva un nudge durante
    bootstrap sin duplicar el GET con el primer `connected`. iOS y Android
    detectan un gap real y emiten un unico nudge canonico al reconectar. Inbox e
    hilo usan maximo dos GET inmediatos por rafaga; actividad durante el segundo
    produce un trailing unico a 500 ms. El polling queda como respaldo adaptativo,
    nunca como loop fijo de 12 s/4 s; ninguna superficie sondea Meta para
    refrescar el hilo.
- [ ] Contact info/modal movil y campos personalizados.
- [ ] Agenda desde chat.
- [x] Aislar y aligerar sincronizacion de conversaciones.
  - Avance: cada contacto remonta su pantalla; la cache queda aislada por cliente
    API, conserva los 150 mensajes mas recientes sin base64 y tiene limite LRU.
    El poll de fondo ya no descarga journey completo, no marca leido sin un
    entrante nuevo y consulta programados como maximo cada 30 segundos. La carga
    fria pinta primero los ultimos mensajes y deja journey/programados como
    solicitudes secundarias que no retienen el spinner.
- [ ] Validar en Android real.

### 3. Menus y sheets

- [ ] Nuevo chat / selector de contacto.
  - Avance: el boton `+` ya abre bottom sheet nativo reusable, busca contactos
    via `/contacts/search`, mezcla resultados con chats recientes y abre la
    conversacion al tocar cualquier punto de la fila, sin boton/avion de enviar
    por contacto. Falta crear contacto nuevo si no existe y replicar todos los
    estados del sheet original.
- [x] Selector de destinatarios despues de foto/video para WhatsApp.
  - Avance: el boton de camara ya pide permiso, abre camara nativa con
    `expo-image-picker`, permite tomar foto o grabar video, muestra preview,
    bloquea doble envio, convierte el archivo local a data URL con
    `expo-file-system` y envia por `/whatsapp-api/messages/image` o
    `/whatsapp-api/messages/video` al contacto seleccionado. Pendiente extender
    esta accion a canales no WhatsApp si el contacto no tiene telefono.
- [x] Menu de agentes.
  - Avance: la bandeja Android ya tiene botón robot en la esquina superior
    izquierda y abre un Hub nativo conectado a `/conversational-agent/agents`.
    Permite encender/pausar cada agente directamente,
    reiniciar omisiones y entrar a su editor; no muestra controles globales
    `Todos`/`Apagar todos`.
- [ ] Administrador de filtros.
- [ ] Mas acciones de chat.
  - Avance: `mobile/` ya usa bottom sheet desde long press de fila, no
    `Alert.alert`. Incluye seleccionar como primera accion, agendar cita,
    registrar pagos, programar mensaje, agregar etiqueta, silenciar/quitar
    silencio, controles del agente arriba cuando existen, marcar leido y
    archivar/restaurar. `Agregar etiqueta` usa las APIs reales de
    `/contact-tags` y `/contacts/bulk/tags`; `Programar mensaje` usa
    `/whatsapp-api/messages/scheduled` con envio en 1 hora; las acciones del
    agente usan `/conversational-agent/states/:contactId`. El sheet conserva el
    contacto hasta terminar el cierre para poder abrir/cerrar/reabrir sobre el
    mismo chat sin quedarse atorado. El fondo debe atenuarse con fade
    independiente mientras solo el panel se desliza; no debe aparecer un bloque
    oscuro subiendo junto con el sheet. Falta replicar formularios nativos
    completos para crear cita/pago dentro del sheet y selector de fecha/hora
    avanzado para programacion.
- [ ] Sheets de configuracion movil relevantes.

## Fase Pagos

- [x] Primer viewport nativo sin header generico de usuario.
- [x] Selector con las mismas opciones principales de `/movil/payments`:
  `Registrar pago unico`, `Planes de pago`, `Suscripcion` y `Precios Guardados`.
- [x] Panel desplegable de ultimos pagos con periodos `Hoy`, `7 dias`,
  `30 dias` y `90 dias`, consumiendo `/api/transactions` con rango de negocio.
- [x] Moneda y fechas visibles tomadas de `account_currency` y
  `account_timezone` resueltos por `/api/config`.
  - Confiabilidad: si cualquiera falta o no se puede leer, la pantalla y
    el registro directo desde chat bloquean la creacion; no inventan MXN ni una
    zona horaria de Mexico. Basic,
    mapa de licencia incompleto o falta de pasarela mantienen los flujos premium
    apagados.
- [x] Vista nativa de `Precios Guardados` con cargar, refrescar, crear, editar y
  eliminar productos via `/api/products`.
- [x] Formulario nativo funcional para registrar pago unico manual via
  `/api/transactions`.
- [x] Bottom-sheet de contacto antes de configurar pago unico, plan o
  suscripcion, reutilizando el patron de `Nueva cita`.
- [x] Wizard nativo de pago unico con opcion manual o link de pasarela y MSI
  basico contra `/api/*/payment-links`.
- [x] Primer formulario nativo de parcialidades contra
  `/api/transactions/payment-flows/installments`.
- [x] Primer formulario nativo de suscripcion contra `/api/subscriptions`.
- [ ] Portar paridad completa de `RecordPaymentModal`: busqueda/seleccion de
  productos, impuestos, tarjetas guardadas, validaciones avanzadas de
  Stripe/Conekta/Mercado Pago/CLIP/Rebill, estados de link listo,
  copia/compartir y errores especificos de pasarela.
- [ ] Portar paridad completa de `PhoneSubscriptionForm`: selector de proveedor
  segun capacidades reales, autorizacion/copia de link, contactos bloqueados y
  validaciones especificas por proveedor.
- [ ] Validar visualmente contra `/movil/payments` en Android real.

## Fase Ajustes

- [x] Separar `Ajustes` del header generico nativo para que no muestre el
  correo/usuario debajo del titulo.
- [x] Replicar la lista principal de `/movil`: Plantillas, Asistente Personal
  AI, Lista de chat, Campos personalizados, Apariencia, Notificaciones y
  `Cerrar sesion`, con iconos, metas y navegacion interna.
- [x] Conectar lectura/escritura de preferencias reales:
  - Globales via `/api/config`: agente en chat, sugerencias IA, archivados,
    orden, preview, no leidos y tema.
  - Por usuario via `/api/user-config`: push de chat/citas/confirmaciones/pagos,
    sonido, vibracion y calendarios con alerta.
- [x] Conectar subpantallas de lectura real:
  - Plantillas desde `/api/whatsapp-api/templates`.
  - Campos personalizados desde `/api/contacts/custom-fields`.
  - Calendarios desde `/api/calendars`.
  - Estado/contexto del agente desde `/api/ai-agent/config`.
- [x] Agregar edicion de la descripcion del negocio del Asistente Personal AI
  usando `/api/ai-agent/business-context-answer` cuando OpenAI esta conectado.
- [x] Replicar dictado de voz nativo de la descripcion del negocio.
  - Avance: el boton `Dictar` usa `expo-audio`, pide microfono, graba en el
    celular, manda el audio a `/api/ai-agent/transcribe` y guarda la respuesta
    pulida con `/api/ai-agent/business-context-answer`.
- [x] Replicar activacion real de permisos push del celular.
  - Avance: Ajustes consulta el permiso nativo, pide permiso con
    `expo-notifications`, registra el token FCM en
    `/api/push/mobile-devices`, respeta calendarios seleccionados y muestra
    estado accionable si falta configurar FCM en el servidor.
- [x] Replicar gestion basica de numeros de WhatsApp en Ajustes.
  - Avance: la subpantalla `Numeros de WhatsApp` lee `/api/whatsapp-api/status`,
    permite refrescar, elegir si la bandeja junta o separa numeros, seleccionar
    el numero usado en chats y marcar un numero como principal via
    `/api/whatsapp-api/phone-numbers/default`.
- [ ] Aplicar visualmente el tema claro/noche al resto de `mobile/`. Avance:
  `mobile_chat_theme_preference` ya se guarda, Ajustes calcula sistema/horario,
  actualiza `StatusBar` y el fondo nativo con `expo-system-ui`; falta que todos
  los componentes centrales de Chat/Citas/Pagos/Analiticas consuman una paleta
  clara completa en vez de depender de la paleta oscura base. Dock inferior ya
  usa capsula opaca de paleta activa, indicador primario solido e iconos muted /
  blancos recalculados al cambiar sistema/claro/noche.
- [ ] Validar visualmente contra `/movil` en Android real y corregir diferencias
  finas de espaciado/tipografia.

## Fase Analiticas

- [x] Consumir los endpoints reales de `/movil/analytics`: metricas,
  `financial-overview`, series de visitantes/leads/citas/asistencias/ventas,
  embudo, distribucion de origen, estado de WhatsApp y labels personalizados.
- [x] Calcular rangos `30d`, `60d`, `180d`, `year` y `custom` con fecha de
  negocio usando `account_timezone` en vez de depender del reloj local del
  dispositivo.
- [x] Formatear importes con `account_currency`, no con una moneda hardcodeada
  como default de negocio.
- [x] Replicar estructura visible de `PhoneAnalytics`: encabezado `Analiticas`,
  selector de periodo, 8 tarjetas KPI, grafica principal con chips, scope
  financiero, leyenda, embudo con scopes, fuentes y origen por numero de
  WhatsApp.
- [x] Agregar estados de loading, error, vacio y pull to refresh nativos.
- [x] Respetar `web_analytics`.
  - Sin feature, Android no pide visitantes, manda `includeWeb=0` en embudo y
    origen, y oculta `Visitantes`/`Trafico` igual que `/movil`.
- [x] Alinear el ACL de Analiticas con sus APIs de Dashboard.
  - Android y `/movil/analytics` requieren lectura de `dashboard`; el modo
    tablet aplica el mismo guard aunque renderice la pantalla dentro de Chat.
  - `analytics` sigue reservado para sesiones, visitantes y conversiones web y
    no concede por si solo acceso al resumen operativo/financiero movil.
- [ ] Validar visualmente contra `/movil/analytics` en Android real y ajustar
  proporciones finas de tipografia, espaciado, iconos o animacion si Raúl detecta
  diferencias.
- [ ] Extraer componentes nativos reutilizables de analiticas cuando la app deje
  de vivir centralizada en `mobile/src/App.tsx`.

## Validacion minima por fase

- `npm run mobile:native:typecheck`.
- `cd mobile && npm run test:chat-reliability` para fechas UTC, ACL offline,
  promocion/reconexion SSE, recuperacion del bootstrap, backpressure con trailing,
  cache por lotes resistente a carreras, merges autoritativos, slots de
  calendario e intentos de pago.
- `git diff --check`.
- Instalar Release en Android fisico cuando cambie UI principal:
  `npm run mobile:native:android`.
- Lanzar la build instalada sin Metro para confirmar bundle embebido.
- Comparar contra `/movil` abierto localmente o contra el codigo fuente original
  si no hay screenshot disponible.
