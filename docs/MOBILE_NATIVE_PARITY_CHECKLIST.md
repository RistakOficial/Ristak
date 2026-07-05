# Mobile Native Parity Checklist

Este documento es el autoprompt persistente para migrar `mobile/` a React
Native sin perder paridad con `/movil`. Si el contexto del chat se compacta o se
pierde, el siguiente agente debe leer este archivo antes de tocar codigo movil.

## Autoprompt obligatorio

Eres el agente encargado de recrear en `mobile/` la experiencia movil publicada
de Ristak bajo `/movil`. No redisenes, no simplifiques y no inventes flujos. Tu
tarea es copiar el resultado final de usuario usando React Native: misma
jerarquia, textos visibles, iconografia, colores, estados, acciones, filtros,
permisos, errores, vacios, loading, gestos y comportamiento.

Antes de implementar cualquier pantalla o subfuncion:

1. Lee la implementacion original relevante en `frontend/src/pages/PhoneChat/`,
   `frontend/src/components/phone/`, servicios usados y CSS asociado.
2. Enumera los elementos visibles, estados y acciones de esa superficie.
3. Implementa el equivalente nativo en `mobile/src/`.
4. Valida typecheck y, cuando aplique, instala en iPhone/Android real.
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
- [x] Separar bundle nativo para pruebas visuales lado a lado. La app nativa
      default se instala como `com.ristak.native`; `com.ristak.app` y
      `com.ristak.app.NotificationService` quedan reservados para la app
      Capacitor de tienda hasta que la migracion nativa reemplace ese paquete de
      forma explicita.
- [x] Login por correo + contrasena con resolucion automatica de tenant, igual que `/movil/login`.
- [x] Shell inicial con Chat, Citas, Pagos, Analiticas y Ajustes.
- [x] Primer pase de lista de chats con API real, filtros basicos y filas planas.
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
  - Brechas pendientes: replicar validacion avanzada de slots/bloqueos,
    invitados, usuarios Round Robin y el selector visual completo de fecha/hora
    del modal original de `/movil`.
- [ ] Paridad completa de Pagos.
  - Avance: la pantalla nativa de Pagos ya dejó de ser un resumen recortado.
    Ahora replica el flujo principal de `/movil/payments`: selector de tipo de
    pago, gating por `/api/integrations/status`, últimos pagos recibidos con
    periodos Hoy/7 días/30 días/90 días, detalle seleccionable, productos /
    precios guardados con crear/editar/eliminar, pago único manual, invoice de
    HighLevel por email/WhatsApp-SMS/both, liga de pasarela, plan de
    parcialidades y suscripción con contacto requerido. Los cobros usan
    `account_currency` y `account_timezone` desde `/api/config`; si no se puede
    leer la moneda de cuenta, los formularios no crean pagos. Los links externos
    se abren con `Linking` desde un sheet nativo de "link listo". Si HighLevel
    está conectado, el pago manual crea invoice y registra pago offline en GHL;
    si no, guarda una transacción local.
  - Brecha pendiente: el formulario nativo no copia todo el `RecordPaymentModal`
    web de escritorio; implementa componentes nativos propios basados en la
    estructura de `/movil`. Aun faltan opciones avanzadas de impuestos, MSI,
    tarjetas guardadas, selector visual de fecha nativo y envío directo del link
    por WhatsApp/email/SMS desde la pantalla de link listo.
- [ ] Paridad completa de Analiticas.
- [ ] Paridad completa de Ajustes.
  - Avance: Ajustes nativo ya incluye la lista principal, numeros de WhatsApp,
    selector de numero para chats, plantillas, agente, lista de chats, campos
    personalizados, apariencia, notificaciones, dictado de contexto de negocio
    y registro de push nativo. Sigue pendiente la comparacion visual final contra
    `/movil/settings` y cualquier microinteraccion que Raul marque diferente.
- [ ] Push/permisos/entitlements nativos listos para reemplazar `com.ristak.app`.
  - Avance: `mobile/` ya registra token APNs/FCM nativo con
    `expo-notifications` en `/api/push/mobile-devices`, crea canales Android,
    atiende taps de push para abrir el chat por `contactId`/`url`, y el backend
    genera avatar PNG de iniciales cuando el contacto no tiene foto publica. En
    iOS local se porto `RistakNotificationService` a `mobile/ios/` para usar
    Communication Notifications con `contactAvatarUrl`. Las credenciales APNs se
    mantienen en Ristak Installer como broker central; el cliente no debe cargar
    `.p8` salvo modo standalone real. Falta decidir si
    `mobile/ios` se trackea en Git o se convierte en config plugin estable; hoy
    `mobile/ios` esta ignorado por `mobile/.gitignore` y la extension vive en
    el proyecto local instalado al iPhone. Falta generar/tracked `mobile/android`
    y portar el renderer `RistakFirebaseMessagingService` para paridad Android
    data-only completa.

## Fase Chat

### 1. Bandeja de chats

- [x] Consumir `/api/contacts/chats`.
- [x] Remover layout tipo card en filas.
- [x] Agregar buscador y chips visibles.
- [x] Agregar avatar con foto/inicial y badge de canal.
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
- [x] Replicar swipe de fila: Mas, Archivar/Restaurar.
  - Avance: `mobile/` ya desplaza la fila a la izquierda con acciones `Mas` y
    `Archivar/Restaurar`. `Mas` abre un bottom sheet nativo con marcar leido,
    archivar/restaurar y seleccionar; el sheet exacto completo de `/movil`
    queda pendiente en "Mas acciones de chat". El swipe debe mantener la fila
    abierta despues de soltar, mostrar las acciones con alto/ancho alineados a la
    fila, permitir tocar `Mas`/`Archivar` sin que la fila animada tape los
    botones y cerrarse al tocar otra fila o empezar scroll. La apertura no debe
    rebotar/cerrarse por umbral alto ni por cancelacion del responder horizontal:
    un arrastre corto a la izquierda abre y, una vez abierta, un arrastre corto a
    la derecha cierra. Los separadores de chats deben salir del borde inferior
    del area estirada de la fila, no de una linea falsa con padding debajo del
    texto. Las filas base deben conservar altura tactil amplia y avatar grande.
- [x] Replicar filtros horizontales de chat.
  - Avance: los chips de filtros en `mobile/` usan todo el ancho util y arrancan
    al margen izquierdo de la pantalla; no deben quedar centrados con `Todos` o
    cualquier chip lateral cortado al cambiar de filtro.
- [x] Replicar fechas relativas de la lista.
  - Avance: la lista nativa formatea con zona horaria del negocio: `Hoy`,
    `Ayer`, dia de semana para 2 a 6 dias y fecha corta despues de una semana.
- [x] Replicar long press/seleccion multiple.
  - Avance: mantener presionada una fila entra en seleccion multiple, muestra
    check circular, oculta filtros, permite seleccionar visibles, cancelar,
    marcar como leidos via API y archivar/restaurar seleccionados.
- [x] Replicar pull to refresh y copy visible.
  - Avance: la lista nativa ya usa pull to refresh, textos de loading/error y
    vacios equivalentes de primer pase. Aun falta el estado cache-refresh exacto
    de `/movil` cuando se muestra cache y actualiza en segundo plano.
- [ ] Replicar empty/loading/cache-refresh states.
- [ ] Validar visualmente contra `/movil` en telefono.

### 2. Conversacion

- [ ] Header de conversacion con avatar/canal/estado como `/movil`.
  - Avance: `mobile/` ya abre `NativeConversationScreen` desde la bandeja, usa
    avatar/foto/inicial, aro/badge de canal, nombre del contacto, detalle
    principal y acciones de agente, etiqueta y busqueda en el header. Falta
    replicar estado online/agente exacto y selector de numero/remitente de
    `/movil`.
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
    acciones. Falta voice note real, ubicacion, sugerencia IA, plantillas,
    picker avanzado de fecha/hora y soporte de video/audio/documento desde el
    picker.
- [ ] Envio por canal correcto: WhatsApp API, QR, HighLevel, Messenger,
  Instagram, email/SMS cuando aplique.
  - Avance: texto nativo usa `/whatsapp-api/messages/text`; fotos del composer
    usan `/whatsapp-api/messages/image`; programacion usa
    `/whatsapp-api/messages/scheduled`; reacciones intentan
    `/whatsapp-api/messages/reaction`. Falta rutas QR/Baileys, HighLevel,
    Messenger/Instagram Meta nativo, email/SMS y fallback por ventana de 24h
    como en `/movil`.
- [ ] Info de mensaje, receipts, errores, pendientes y reintentos.
  - Avance: long press sobre globo abre bottom sheet con preview, reacciones
    rapidas, responder e informacion de canal/estado/hora. Los globos muestran
    pending/error y ticks sent/delivered/read. Falta reintento real, pantalla
    completa de info del mensaje y acciones especiales de programados.
- [ ] Contact info/modal movil y campos personalizados.
- [ ] Agenda desde chat.
- [ ] Validar en iPhone real.

### 3. Menus y sheets

- [ ] Nuevo chat / selector de contacto.
  - Avance: el boton `+` ya abre bottom sheet nativo reusable, busca contactos
    via `/contacts/search`, mezcla resultados con chats recientes y abre la
    conversacion seleccionada. Falta crear contacto nuevo si no existe y replicar
    todos los estados del sheet original.
- [x] Selector de destinatarios despues de foto/video para WhatsApp.
  - Avance: el boton de camara ya pide permiso, abre camara nativa con
    `expo-image-picker`, permite tomar foto o grabar video, muestra preview,
    bloquea doble envio, convierte el archivo local a data URL con
    `expo-file-system` y envia por `/whatsapp-api/messages/image` o
    `/whatsapp-api/messages/video` al contacto seleccionado. Pendiente extender
    esta accion a canales no WhatsApp si el contacto no tiene telefono.
- [ ] Menu global de agente.
- [ ] Administrador de filtros.
- [ ] Mas acciones de chat.
  - Avance: `mobile/` ya usa bottom sheet desde swipe `Mas`, no `Alert.alert`.
    Incluye agendar cita, registrar pagos, programar mensaje, agregar etiqueta,
    silenciar/quitar silencio, controles del agente, marcar leido,
    archivar/restaurar y seleccionar. `Agregar etiqueta` usa las APIs reales de
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
- [x] Moneda visible tomada de `account_currency` y fecha/rangos desde
  `/api/settings/timezone`.
- [x] Vista nativa de `Precios Guardados` con cargar, refrescar, crear, editar y
  eliminar productos via `/api/products`.
- [x] Formulario nativo funcional para registrar pago unico manual via
  `/api/transactions`.
- [x] Primer formulario nativo de parcialidades contra
  `/api/transactions/payment-flows/installments`.
- [x] Primer formulario nativo de suscripcion contra `/api/subscriptions`.
- [ ] Portar paridad completa de `RecordPaymentModal`: busqueda/seleccion de
  productos, impuestos, links de pago, tarjetas guardadas, Stripe/Conekta/
  Mercado Pago/CLIP, MSI, transferencias, estados de link listo, copia/compartir
  y errores especificos de pasarela.
- [ ] Portar paridad completa de `PhoneSubscriptionForm`: selector de proveedor
  segun capacidades reales, autorizacion/copia de link, contactos bloqueados y
  validaciones especificas por proveedor.
- [ ] Validar visualmente contra `/movil/payments` en iPhone real.

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
    `expo-notifications`, registra el token APNs/FCM en
    `/api/push/mobile-devices`, respeta calendarios seleccionados y muestra
    estado accionable si falta configurar APNs/FCM en el servidor.
- [x] Replicar gestion basica de numeros de WhatsApp en Ajustes.
  - Avance: la subpantalla `Numeros de WhatsApp` lee `/api/whatsapp-api/status`,
    permite refrescar, elegir si la bandeja junta o separa numeros, seleccionar
    el numero usado en chats y marcar un numero como principal via
    `/api/whatsapp-api/phone-numbers/default`.
- [ ] Aplicar visualmente el tema claro/noche al resto de `mobile/`. Avance:
  `mobile_chat_theme_preference` ya se guarda, Ajustes calcula sistema/horario,
  actualiza `StatusBar` y el fondo nativo con `expo-system-ui`; falta que todos
  los componentes centrales de Chat/Citas/Pagos/Analiticas consuman una paleta
  clara completa en vez de depender de la paleta oscura base.
- [ ] Validar visualmente contra `/movil` en iPhone real y corregir diferencias
  finas de espaciado/tipografia.

## Fase Analiticas

- [x] Consumir los endpoints reales de `/movil/analytics`: metricas,
  `financial-overview`, series de visitantes/leads/citas/asistencias/ventas,
  embudo, distribucion de origen, estado de WhatsApp y labels personalizados.
- [x] Calcular rangos `30d`, `60d`, `180d`, `year` y `custom` con fecha de
  negocio usando `account_timezone` en vez de depender del reloj local del
  iPhone.
- [x] Formatear importes con `account_currency`, no con una moneda hardcodeada
  como default de negocio.
- [x] Replicar estructura visible de `PhoneAnalytics`: encabezado `Analiticas`,
  selector de periodo, 8 tarjetas KPI, grafica principal con chips, scope
  financiero, leyenda, embudo con scopes, fuentes y origen por numero de
  WhatsApp.
- [x] Agregar estados de loading, error, vacio y pull to refresh nativos.
- [ ] Validar visualmente contra `/movil/analytics` en iPhone real y ajustar
  proporciones finas de tipografia, espaciado, iconos o animacion si Raúl detecta
  diferencias.
- [ ] Extraer componentes nativos reutilizables de analiticas cuando la app deje
  de vivir centralizada en `mobile/src/App.tsx`.

## Validacion minima por fase

- `npm run mobile:native:typecheck`.
- `git diff --check`.
- Instalar Release en iPhone fisico cuando cambie UI principal:
  `npx expo run:ios --device "iPhone Pro de Raúl" --configuration Release`.
- Lanzar la build instalada sin Metro para confirmar bundle embebido.
- Comparar contra `/movil` abierto localmente o contra el codigo fuente original
  si no hay screenshot disponible.
