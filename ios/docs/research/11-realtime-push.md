# 11 — Realtime sync + Push notifications (spec para app nativa iOS)

> Módulo de investigación: `realtime-push`. Fuentes: backend Node
> (`backend/src/routes/chatEvents.routes.js`, `paymentEvents.routes.js`,
> `push.routes.js`, `controllers/pushController.js`,
> `controllers/notificationsController.js`,
> `services/chatLiveEventsService.js`, `services/paymentLiveEventsService.js`,
> `services/presenceService.js`, `services/pushNotificationsService.js`,
> `services/notificationPreferencesService.js`, `services/notificationsService.js`,
> `services/licenseService.js`), frontend `/movil`
> (`frontend/src/services/chatLiveEventsService.ts`,
> `paymentLiveEventsService.ts`, `pushNotificationsService.ts`,
> `mobileAppService.ts`, `frontend/public/sw.js`,
> `frontend/src/pages/PhoneChat/PhoneChat.tsx`), app RN
> (`mobile/src/notifications.ts`, `mobile/src/App.tsx`, `mobile/src/api.ts`),
> extensión iOS (`ios/app/RistakNotificationService/NotificationService.swift`)
> y docs (`docs/MOBILE_APP.md`, `docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`).
>
> Todo lo aquí descrito fue verificado contra el código. Lo ambiguo está marcado
> como **OPEN QUESTION**.

---

## 1. Estrategia realtime global (resumen que la app nativa debe implementar)

Ristak NO usa WebSockets. La estrategia de sincronización en vivo tiene 4 capas
complementarias, y la app nativa iOS debe implementar las cuatro:

| Capa | Mecanismo | Qué cubre |
|---|---|---|
| 1. SSE de chat | `GET /api/chat-events/stream` (Server-Sent Events) | Aviso instantáneo de mensajes de chat nuevos/actualizados (evento `chat_message`). Es solo un "nudge": el cliente re-consulta la bandeja/hilo por REST. |
| 2. SSE de pagos | `GET /api/payment-events/stream` | Aviso de cambios de pagos/suscripciones (`payment_changed`, `subscription_changed`) para refrescar listas de transacciones, planes y suscripciones. |
| 3. Polling de reconciliación | REST periódico | Red de seguridad si se pierde un frame SSE: iOS nativo usa bandeja cada **12 s**, hilo abierto cada **4 s** y acuses cada **12 s**; /movil conserva 20 s/7 s/12 s. El poll debe ser no-op visual si no hay cambios. |
| 4. Push APNs | `/api/push/mobile-devices` + APNs | Notificaciones con la app cerrada/fondo + "nudge" en foreground para refrescar al instante. |

Además hay un canal de **presencia** (`POST /api/chat-events/viewing`) con el
que el cliente informa qué chat tiene abierto: el backend NO manda push del chat
que el usuario ya está viendo y le marca ese chat como leído automáticamente.

Los eventos realtime existentes son exactamente estos (no hay más):

- `chat_message` (SSE chat): mensaje nuevo o actualizado en un contacto.
- `payment_changed` y `subscription_changed` (SSE pagos).
- Push de: mensaje de chat, prioridad del agente conversacional, cita
  agendada/reprogramada/cancelada/no-show, cita confirmada, resultado de
  confirmación IA de cita, pago (todos los estados), notificaciones internas de
  automatizaciones.

**No existe evento realtime** para: cambio de estado leído/no-leído entre
dispositivos, asignación de contacto, tags, edición de contacto, ni typing.
Todo eso se recoge por el polling de reconciliación (el payload de
`GET /api/whatsapp-api/conversations` ya trae `unreadCount`, asignado, tags,
etc.). Ver sección "Gaps".

---

## 2. SSE de chat — `GET /api/chat-events/stream`

Fuente: `backend/src/routes/chatEvents.routes.js:11-13`,
`backend/src/services/chatLiveEventsService.js`.

### 2.1 Request

- Método: `GET /api/chat-events/stream`
- Auth: `Authorization: Bearer <jwt>` **obligatorio** (`requireAuth`). No hay
  soporte de token por query string (`authMiddleware.js:7-14` solo lee el
  header). En Swift usar `URLSession` con header, no `EventSource` de terceros
  sin headers.
- Permiso: `requireModuleAccess('chat')` — usuario con módulo `chat` en nivel
  ≥ `read`. Si no: `403 { success:false, code:'read_access_required', module:'chat', error:'No tienes acceso a esta sección.' }`
  (`userAccessMiddleware.js:15-32`).
- Header recomendado por el cliente web: `Accept: text/event-stream`
  (`frontend/src/services/chatLiveEventsService.ts:58-70`).

### 2.2 Response (protocolo)

- `200` con headers:
  `Content-Type: text/event-stream; charset=utf-8`,
  `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
  `X-Accel-Buffering: no` (`chatLiveEventsService.js:54-61`).
- Formato de cada evento (`writeSseEvent`, líneas 26-33):

```
id: <entero incremental por proceso>
event: <nombre>
data: <JSON en una línea>
<línea en blanco>
```

- **Heartbeat**: comentario `: heartbeat <epoch_ms>` cada **25 000 ms**
  (`HEARTBEAT_INTERVAL_MS`, línea 4). Sirve para detectar conexión muerta: si
  no llega nada en ~30-40 s, reconectar.
- **El `id` NO permite replay**: es un contador en memoria del proceso; el
  backend ignora `Last-Event-ID`. Eventos perdidos durante una desconexión NO
  se re-entregan — por eso existe el polling de reconciliación.

### 2.3 Eventos

**`connected`** — inmediato al suscribirse (líneas 72-75):

```json
{ "connected": true, "serverTime": "2026-07-07T18:00:00.000Z" }
```

**`chat_message`** — broadcast a TODOS los clientes conectados (no se filtra
por usuario ni por permisos de contacto; líneas 84-109):

```json
{
  "type": "chat_message",
  "contactId": "string (siempre presente, no vacío)",
  "messageId": "string (puede ser '')",
  "channel": "string",
  "provider": "string",
  "transport": "string",
  "direction": "string",
  "messageType": "string",
  "messageTimestamp": "string (ISO o '')",
  "isNew": true,
  "receivedAt": "ISO string (hora del servidor al publicar)"
}
```

Todos los campos son strings "limpiados" (trim); `isNew` es boolean
(`input.isNew !== false`, default `true`).

Valores observados en los publishers:

- `channel`: `whatsapp` (`whatsappApiService.js:3137-3147, 6146, 6338`),
  `email` (`emailService.js:1184-1194`, `highlevelConversationsSyncService.js:838-847`),
  plataformas Meta: `messenger` / `instagram` / `facebook_comment` /
  `instagram_comment` (`metaSocialMessagingService.js:1255-1264, 1897-1906, 2936-2945, 3089-3097` — usa `platform` tal cual),
  y plataformas HighLevel (`highlevelConversationsSyncService.js:966-975`).
- `provider`: `whatsapp_api`-style (PROVIDER_NAME de WhatsApp), `imap`, `meta`,
  `highlevel`.
- `transport`: `api`, `qr`, `imap`, `ghl_email`, `ghl_<platform>`, o el nombre
  de la plataforma Meta.
- `direction`: `inbound` | `outbound`.
- `isNew: false` cuando es una actualización de un mensaje existente (p. ej.
  fallback API→QR de WhatsApp).

### 2.4 Semántica de consumo (cómo lo usa /movil — replicar)

`frontend/src/pages/PhoneChat/PhoneChat.tsx:8884-8892`: al recibir
`chat_message` **no** se pinta el mensaje del payload (no trae texto); se llama
`refreshChatInboxNow({ contactId })`, que:

- recarga la bandeja (`loadChats silent`) + datos del agente,
- si la conversación abierta es ese contacto (o el evento no trae contacto),
  recarga también el hilo abierto (`loadConversation(openId, {silent:true})`),
- si ya hay un refresh en vuelo, **encola** uno más con el último `contactId`
  (no descartar eventos; `PhoneChat.tsx:7875-7919`),
- dedup de la lista por `id` de contacto (`dedupeChatsById`,
  `PhoneChat.tsx:2014`) y no-op de React si los mensajes son equivalentes
  (`areMessagesEquivalent`).

`ios/app` agrega una capa inmediata antes de esa consulta: con los metadatos del
SSE (o el mensaje optimista local) actualiza el preview disponible y promueve la
fila del contacto. Conserva un overlay pendiente por contacto para que una
respuesta REST iniciada antes del evento no vuelva a bajar la fila; deduplica por
mensaje, no vuelve a sumar no leidos al reaplicar y retira el overlay cuando REST
confirma el contenido o vence el TTL de seguridad. El hilo reenvia actividad de
todos los contactos a la bandeja aunque la cubra en iPhone; solo refresca su
timeline cuando `contactId` coincide. REST sigue siendo la fuente autoritativa.

### 2.5 Reconexión (cliente)

Implementación de referencia `frontend/src/services/chatLiveEventsService.ts:129-186`:

- Conectar con `fetch` streaming + `AbortController`.
- Al cortarse (error, `!response.ok`, fin de stream): reintentar con backoff
  exponencial: inicia en **1 000 ms**, duplica cada intento, tope **15 000 ms**
  (`INITIAL_RECONNECT_MS`/`MAX_RECONNECT_MS`, líneas 29-30).
- Al conectar con éxito, resetear el backoff a 1 s.
- Parser tolerante: separar frames por `\r?\n\r?\n`, campos `event:`/`data:`
  (múltiples `data:` se unen con `\n`), ignorar líneas comentario `:`.
- Ignorar frames cuyo `event` no sea `chat_message` o cuyo JSON no tenga
  `type === 'chat_message'` y `contactId` string no vacío.

---

## 3. Presencia — `POST /api/chat-events/viewing`

Fuente: `chatEvents.routes.js:18-24`, `presenceService.js`.

- Método: `POST /api/chat-events/viewing`
- Auth: Bearer + módulo `chat` (write no aplica: es POST ⇒ requiere nivel
  `write` de `chat` según `requireModuleAccess`; un usuario con chat solo-read
  recibiría 403 `write_access_required`). **OPEN QUESTION:** ¿es intencional que
  presencia exija `chat:write`? El código actual lo exige (método POST).
- Body JSON: `{ "contactId": "<id o ''>", "foreground": true|false }`
  - `contactId` vacío **o** `foreground:false` ⇒ borra la presencia (deja de
    suprimir push de inmediato).
- Response: `204` sin body. Best-effort: el cliente nunca debe fallar por esto.

Semántica servidor (`presenceService.js`):

- TTL de la presencia: **45 000 ms** (`PRESENCE_TTL_MS`).
- Un solo registro por usuario (`userId → {contactId, foreground, expiresAt}`).
- `sendChatMessageNotification` consulta `getViewingUserIds(contactId)`: a esos
  usuarios NO les manda push y además les marca el chat como leído
  (`markChatContactReadForUser`, `pushNotificationsService.js:2347-2366`).
- Si se cae la conexión SSE del usuario y no tiene otra pestaña, el backend
  limpia su presencia (`chatLiveEventsService.js:35-48`).

Cadencia del cliente (/movil, `PhoneChat.tsx:8894-8922` — replicar en iOS):

- Reportar al abrir/cambiar/cerrar conversación.
- Reportar `foreground:true/false` al ganar/perder primer plano
  (scenePhase active/background en SwiftUI).
- Keep-alive cada **20 s** mientras el chat esté abierto y la app al frente
  (el TTL es 45 s, así que 20 s da margen).
- Al salir del chat o desmontar: `reportViewing(null, false)`.
- La app RN `mobile/` **no** reporta presencia hoy (gap conocido; la app nativa
  iOS SÍ debe hacerlo para paridad con /movil).

---

## 4. SSE de pagos — `GET /api/payment-events/stream`

Fuente: `paymentEvents.routes.js`, `paymentLiveEventsService.js`,
montaje en `server.js:331`:
`app.use('/api/payment-events', requireAuth, requireFeature('payments'), paymentEventsRoutes)`.

### 4.1 Request

- `GET /api/payment-events/stream`
- Auth: Bearer (`requireAuth`) + feature de licencia `payments`
  (`requireFeature('payments')`) + módulo `payments` ≥ read
  (`requireModuleAccess('payments')`).

### 4.2 Protocolo

Idéntico al de chat: mismos headers, heartbeat cada 25 s, evento `connected`
inicial, `id` incremental sin replay (`paymentLiveEventsService.js:153-185`).

### 4.3 Eventos

**`payment_changed`** (`paymentLiveEventsService.js:187-211`):

```json
{
  "type": "payment_changed",
  "scopes": ["transactions", "payment_plans", "subscriptions"],
  "paymentId": "string",
  "publicPaymentId": "string",
  "contactId": "string",
  "status": "string lowercase (paid|pending|failed|refunded|void|...)",
  "previousStatus": "string lowercase",
  "provider": "string (stripe|conekta|mercadopago|clip|rebill|manual|...)",
  "method": "string",
  "receivedAt": "ISO string"
}
```

- `scopes` siempre incluye `transactions`; añade `payment_plans` si el pago
  pertenece a un plan/parcialidad y `subscriptions` si viene de suscripción
  (heurística `derivePaymentScopes`, líneas 57-139).
- Strings acotados a 240 chars (`firstClean`).

**`subscription_changed`** (líneas 213-227):

```json
{
  "type": "subscription_changed",
  "scopes": ["subscriptions"],
  "subscriptionId": "string",
  "contactId": "string",
  "status": "string lowercase",
  "previousStatus": "string lowercase",
  "provider": "string",
  "receivedAt": "ISO string"
}
```

### 4.4 Consumo

Cliente de referencia `frontend/src/services/paymentLiveEventsService.ts`
(mismo backoff 1 s→15 s). Lo usan Desktop `Transactions.tsx`,
`PaymentSubscriptions.tsx` y `ContactDetailsModal.tsx` para recargar la lista
correspondiente filtrando por `scopes`. **Ni `/movil` (PhonePayments) ni la app
RN lo consumen hoy** — la pantalla de pagos móvil se refresca por pull-to-refresh
y por navegación. Para iOS nativo: conectarlo cuando la pantalla Pagos esté
visible es lo deseable (paridad desktop), pero no es requisito de paridad móvil.

`publishPaymentChangedEvent` se dispara además de forma implícita en cada
`sendPaymentNotification` (`pushNotificationsService.js:2476-2477`), o directo
desde los servicios de Stripe/Conekta/MercadoPago/Clip/Rebill/subscripciones.

---

## 5. Push — registro de dispositivos y endpoints

Fuente: `push.routes.js`, `pushController.js`, `pushNotificationsService.js`.

### 5.1 `GET /api/push/public-key` (sin auth)

Respuesta (`pushController.js:13-26` + `getPublicPushConfig`,
`pushNotificationsService.js:1602-1611`):

```json
{
  "success": true,
  "data": {
    "configured": true,          // Web Push (VAPID) disponible
    "publicKey": "B...",         // llave pública VAPID ('' si no hay)
    "nativeConfigured": true,     // hay transporte nativo (local FCM/APNs o broker central)
    "androidConfigured": false,
    "iosConfigured": true
  }
}
```

Error: `500 { success:false, error:'No se pudo leer la configuración de notificaciones' }`.

La app nativa DEBE consultar esto antes de pedir permiso: si
`iosConfigured !== true`, mostrar el copy de "no preparado" (ver §10.2) y no
registrar (`mobile/src/notifications.ts:54-65, 208-224`).

### 5.2 `POST /api/push/mobile-devices` (Bearer requerido; sin gate de módulo)

Registra/reactiva el token APNs del dispositivo. Body exacto
(`pushController.js:102-126` + `saveMobilePushDevice`,
`pushNotificationsService.js:1665-1724`):

```json
{
  "token": "hex APNs device token",         // requerido, trim
  "platform": "ios",                        // requerido: 'ios' | 'android'
  "calendarIds": ["cal_1", "cal_2"],        // opcional; [] = todos los calendarios
  "appVersion": "1.0.0",                    // opcional string
  "appBuild": "42",                         // opcional string
  "deviceModel": "iPhone17,1",              // opcional string
  "osVersion": "26.0",                      // opcional string
  "clientType": "native",                   // iOS SwiftUI, no Expo
  "appPackage": "com.ristak.app"            // bundle que genero el token
}
```

- El `user_id` del device se toma del JWT (`req.user.userId`), no del body.
- Upsert por `token` (UNIQUE): re-registrar reactiva (`enabled=1`), actualiza
  metadata y limpia `last_error`. Cambiar de cuenta en el mismo device
  reasigna `user_id` (`COALESCE(excluded.user_id, ...)` — solo si el nuevo no
  es null).
- `id` interno: `native_push_` + sha256(`${platform}:${token}`).
- Éxito: `201 { "success": true, "data": { "id": "native_push_…", "platform": "ios", "enabled": true, "calendarIds": [] } }`
- Errores `400 { success:false, error: <msg> }`:
  - `"Falta la llave de notificaciones del celular"` (token vacío)
  - `"Este tipo de celular no está soportado para notificaciones"` (platform
    distinto de ios/android)

### 5.3 `DELETE /api/push/mobile-devices` (Bearer)

Body: `{ "token": "<device token>" }`. Marca `enabled=0` (no borra fila).

- Éxito: `200 { "success": true, "data": { "disabled": true } }`
- Si el token pertenece a otro usuario:
  `403 { success:false, code:'FORBIDDEN', error:'No puedes apagar este celular' }`
  (`pushController.js:128-160`). Filas sin dueño sí pueden apagarse.
- Otros errores: `400 { success:false, error:'No se pudo apagar este celular' }`.
- /movil y RN legacy no llaman hoy este DELETE. `ios/app` si lo llama en logout:
  primero invalida/cancela y espera cualquier registro en vuelo, luego desactiva
  el token remoto y finalmente limpia APNs local. En 401/licencia revocada, donde
  el DELETE autenticado puede ser imposible, corta de inmediato el registro local.

### 5.4 Web PWA (referencia, no aplica a iOS nativo)

- `POST /api/push/subscriptions` body `{ subscription: <PushSubscription JSON>, calendarIds: [] }` → `201 { success, data:{ id:'push_<sha256(endpoint)>', enabled:true, calendarIds } }`.
- `DELETE /api/push/subscriptions` body `{ endpoint }` (mismas reglas 403).

### 5.5 `GET /api/push/contact-avatar/:contactId?i=<iniciales>&c=<colorIndex>&s=<firma>` (sin auth)

Devuelve un PNG 512×512 de iniciales (círculo de color + 2 letras) firmado con
HMAC; `Cache-Control: public, max-age=31536000, immutable`. Firma inválida ⇒
`404` texto `Not found` (`pushController.js:28-43`,
`renderNotificationInitialsAvatarPng`, `pushNotificationsService.js:953-988`).
El backend genera estas URLs él mismo para el campo `contactAvatarUrl` de los
push cuando el contacto no tiene foto pública
(`buildNotificationInitialsAvatarUrl`, líneas 842-855; requiere que el server
conozca su URL pública vía `PUBLIC_APP_URL`/`APP_PUBLIC_URL`/`FRONTEND_URL`/…,
líneas 617-632). El cliente iOS solo la consume (descarga en el NSE).

### 5.6 Modelos de datos (tablas)

`mobile_push_devices` (ver INSERT en `pushNotificationsService.js:1689-1716`):

| columna | tipo | notas |
|---|---|---|
| `id` | TEXT PK | `native_push_<sha256>` |
| `user_id` | TEXT nullable | dueño (JWT) |
| `platform` | TEXT | `ios` \| `android` |
| `token` | TEXT UNIQUE | token APNs/FCM |
| `calendar_ids_json` | TEXT JSON array | `[]` = todos |
| `enabled` | INTEGER 0/1 | auto-0 si APNs 400/404/410, `BadDeviceToken`, `Unregistered` (`markMobileDeviceError`, líneas 1796-1812) |
| `app_version`, `app_build`, `device_model`, `os_version` | TEXT | metadata |
| `last_error` | TEXT nullable | último error de envío |
| `created_at`, `updated_at` | TIMESTAMP | |

`push_subscriptions` análogo para web (endpoint, subscription_json,
calendar_ids_json, enabled, user_agent, last_error).

---

## 6. Payload de push APNs (contrato exacto que la app iOS recibirá)

Fuente: `sendApnsNotification` (`pushNotificationsService.js:1882-1962`) y
`getNotificationData` (líneas 515-539).

### 6.1 Envío

- HTTP/2 POST `https://api.push.apple.com/3/device/<token>` (sandbox si
  `APNS_ENV` ∈ {development, sandbox}).
- Headers: `apns-topic: <APNS_BUNDLE_ID>` (default `com.ristak.app`),
  `apns-push-type: alert`, `apns-priority: 10`, JWT ES256 (`kid=APNS_KEY_ID`,
  `iss=APNS_TEAM_ID`), cacheado 50 min.

### 6.2 Cuerpo JSON

```json
{
  "aps": {
    "alert": { "title": "<título>", "body": "<cuerpo>" },
    "thread-id": "<threadId>",
    "category": "<CATEGORY_APNS>",
    "mutable-content": 1,        // SOLO si hay contactAvatarUrl o media
    "sound": "default",          // SOLO si el usuario destinatario tiene sonido ON
    "badge": 0                   // SOLO si payload.badge es numérico — HOY NUNCA SE MANDA (ningún emisor setea badge)
  },
  "title": "…", "body": "…",
  "url": "/movil?contact=abc",           // deep-link interno (path web /movil)
  "category": "chat",                     // categoría cruda lowercase
  "tag": "chat-<messageId>",
  "threadId": "chat-<contactId>",
  "eventKey": "",                         // '' | 'payments' | 'appointment_*'
  "messageId": "…",
  "contactId": "…",
  "contactName": "…",
  "contactAvatarUrl": "https://…",        // foto real o PNG de iniciales firmado
  "senderAvatarUrl": "https://…",         // duplicado de contactAvatarUrl
  "notificationImageUrl": "https://…",    // SOLO media real del mensaje (foto/video/gif)
  "notificationAttachmentUrl": "https://…" // duplicado de notificationImageUrl
}
```

Notas duras:

- Todos los campos custom son **strings** (se castean con `String(value||'')`,
  línea 537); los ausentes viajan como `""`.
- `aps.category` es la categoría "APNs-izada": mayúsculas, no-alfanuméricos →
  `_` (`getApnsCategory`, líneas 1581-1587). Valores posibles: `CHAT`,
  `PAYMENT`, `APPOINTMENT_BOOKED`, `APPOINTMENT_CONFIRMED`,
  `APPOINTMENT_CANCELLED`, `APPOINTMENT_RESCHEDULED`, `APPOINTMENT_NO_SHOW`,
  `RISTAK` (fallback) y categorías libres de notificaciones internas de
  automatizaciones (p. ej. `AUTOMATION`).
- `thread-id` = `threadId` = `chat-<contactId>` (chat), `calendar-<calendarId>`
  (citas), `payment-<contactId>` o `payments` (pagos), fallback `ristak`
  (`getNotificationThreadId`, líneas 1576-1579; máx 64 chars).
- `mutable-content: 1` va cuando existe avatar o media
  (`shouldUseNotificationServiceExtension`, líneas 664-666) → dispara la
  Notification Service Extension.
- El título/cuerpo pasan por saneo: se quita el nombre de la app
  ("de Ristak", "Ristak:") y textos que solo digan "Ristak"; fallbacks
  `Mensaje nuevo` (chat) / `Notificación nueva` / `Tienes una notificación
  nueva.`; a títulos conocidos se les antepone emoji (líneas 130-255, 563-593).

### 6.3 Catálogo de pushes por evento

| Evento | `category` / `eventKey` | `title` | `body` | `tag` | `threadId` | `url` | Fuente |
|---|---|---|---|---|---|---|---|
| Mensaje de chat entrante | `chat` / — | Nombre del contacto (o teléfono; fallback `Mensaje nuevo`) | Texto del mensaje, o por tipo: `📷 Envió una foto.`, `🎥 Envió un video.`, `🎤 Mensaje de voz (m:ss)`, `📄 <archivo.ext> (N páginas)`, `📍 Ubicación`, `Sticker`, `GIF`, `Contacto`, `Reacción`, `Respuesta`, fallback `Mensaje` (máx 220 chars) | `chat-<messageId>` | `chat-<contactId>` | `/movil?contact=<contactId>` | `sendChatMessageNotification`, `pushNotificationsService.js:2306-2410`; cuerpos: 1253-1286 |
| Prioridad del agente IA ("pasar a humano") | `chat` / — | `Pasar a un humano` | `<Contacto>: <razón>` o `<Contacto>: el agente lo dejó en prioridad para humano.` | `agent-priority-<contactId>` | `chat-<contactId>` | `/movil?contact=<contactId>` | líneas 2412-2459 |
| Cita agendada (booked/scheduled/created) | `appointment_booked` (= eventKey) | `📅 Cita agendada` | `<contacto> · <título> · <07 jul, 5:30 p.m.> · <calendario>` (máx 220) | `calendar-<calendarId>` | `calendar-<calendarId>` | `/movil/calendar?open=appointment&id=<id>` | `sendCalendarAppointmentNotification`, 2159-2198 |
| Cambio de estado de cita (rescheduled/cancelled/no_show) | `appointment_<estado>` | `↩️ Cita reprogramada` / `❌ Cita cancelada` / `⚠️ Cita sin asistencia` | igual formato + detalle | `appointment-<estado>-<appointmentId>` | `calendar-<calendarId>` | `/movil/calendar?open=appointment&id=<id>` | `sendAppointmentStatusNotification`, 2200-2243 |
| Cita confirmada por el cliente | `appointment_confirmed` | `✅ Cita confirmada` | igual formato + detalle | `appointment-confirmed-<appointmentId>` | `calendar-<calendarId>` (o `appointment-<id>`) | `/movil/calendar?open=appointment&id=<id>` | 2269-2304 |
| Resultado confirmación IA (reagendar/cancelar/ambiguo/humano) | sin category (→ `ristak`) | `Confirmación de cita: <contacto> <label>` | `<contacto> respondió sobre "<título>". <detalle>` (160) | `conf-<appointmentId>` | (tag) | `/movil/calendar?open=appointment&id=<id>` | `appointmentConfirmationService.js:339-359` |
| Pago (cualquier transición) | `payment` / `payments` | `💸 Pago completado`, `❌ Pago rechazado`, `⏳ Pago pendiente`, `⚠️ Pago requiere atención`, `🧾 Pago parcial`, `⏰ Pago vencido`, `↩️ Pago reembolsado`, `❌ Pago cancelado`, `📅 Pago programado`, `📤 Pago enviado`, `🧾 Pago creado`, `💳 Pago actualizado` (mapa de estados, líneas 179-244) | `<estado> · <Cliente> · $1,234.56 · <concepto> · <detalle de error>` (220) | `payment-<paymentId|contactId|ristak>` | `payment-<contactId>` o `payments` | `/movil/transactions` | `buildPaymentNotificationPayload`/`sendPaymentNotification`, 2461-2493 |
| Notificación interna (automatizaciones) | category libre (default `automation`) | título de la automatización | mensaje | id interno | — | `actionUrl` o `/movil` | `notificationsService.js:201-216` |

Montos: `Intl.NumberFormat('es-MX', {style:'currency'})` (línea 1431-1445).
Fechas de cita: `es-MX`, `dd MMM, h:mm a.m./p.m.` (líneas 1417-1429).

### 6.4 Reglas de avatar/media (crítico para Communication Notifications)

`docs/MOBILE_APP.md:396-431` + `enrichNotificationPayloadForDelivery`
(`pushNotificationsService.js:990-1015`):

- Si el payload pertenece a **exactamente un contacto**, el backend garantiza
  `contactAvatarUrl`/`senderAvatarUrl`: foto pública de WhatsApp/Meta si
  existe; si no, el PNG de iniciales firmado (§5.5).
- `notificationImageUrl`/`notificationAttachmentUrl` SOLO llevan multimedia
  real del mensaje (foto/video/gif entrante); nunca el avatar. Audio, documento
  y ubicación NO usan estos campos.
- Varios contactos o alerta general ⇒ sin avatar ⇒ iOS muestra el AppIcon.

---

## 7. Reglas de negocio del envío (quién recibe qué)

Pipeline en `sendAppNotificationPayload` (`pushNotificationsService.js:2083-2157`).
Un device del usuario U recibe el push si TODAS estas pasan:

1. **Transporte disponible**: VAPID (web) o APNs/FCM local **o broker central**
   (`getEffectivePushTransportStatus`, líneas 326-335; estado central cacheado
   60 s, líneas 293-324).
2. **Matriz de preferencias** (`notification_preferences_matrix` en app-config;
   `notificationPreferencesService.js`): filas `all` | `admins` | `user:<id>`
   por evento normalizado (`conversations`, `appointments`,
   `appointment_booked`, `appointment_confirmed`, `appointment_reminders`,
   `payments`, `automation_internal`, `agent_priority`, `system`); el canal
   debe ser `push`/`app_push`/`all`. Sin matriz configurada ⇒ todos.
   Config "nadie" apaga el evento… con excepción de chat (punto 4).
3. **Override por usuario** (7 claves en `/api/user-config`, ver §10.1): el
   `enabledKey` del evento se resuelve por usuario destinatario con fallback al
   valor global (`filterRowsByUserPreference`, líneas 2063-2079). Devices sin
   `user_id` respetan solo el kill-switch global.
4. **Chat — asignación**: el usuario asignado al contacto
   (`contacts.assigned_user_id`) SIEMPRE se suma a los destinatarios aunque la
   matriz diga "nadie" (líneas 2327-2343, 2394-2403).
5. **Chat — presencia**: usuarios viendo ese chat se excluyen y se les marca
   leído (líneas 2347-2366, `excludeUserIds` 2109-2128). Fail-open.
6. **Chat — contacto oculto**: si el contacto matchea los filtros de "contactos
   ocultos" NO se envía nada (fail-safe: ante error se asume oculto;
   `notificationPreferencesService.js:148-177`).
7. **Chat — agente conversacional**: si el agente IA está atendiendo ese
   contacto y su config dice suprimir, no se envía
   (`shouldSuppressChatNotificationForConversationalAgent`, líneas 2310-2316).
8. **Citas — filtro de calendarios**: global
   (`calendar_push_notification_calendar_ids` app-config, `[]`=todos) y por
   usuario (misma clave en user-config; `isCalendarAllowedForUser`, 1385-1394)
   además del filtro por device (`calendar_ids_json`).
9. **Sonido/vibración por usuario destinatario**: `push_notification_sound_enabled`
   controla si el APNs lleva `aps.sound='default'` (silencioso si OFF);
   la vibración solo afecta Android (canales) — en iOS no hay campo equivalente
   (líneas 1357-1372, 1905-1907).

Resultado del dispatcher: `{ sent, webSent, nativeSent, skipped, reason }` con
`reason` ∈ `not_configured` | `missing_recipients` | `no_subscriptions` |
`disabled_by_preferences` | `hidden_contact` |
`conversational_agent_attending` | `calendar_filtered` | `missing_calendar` |
`missing_appointment` | `missing_contact` (solo relevante para logs).

---

## 8. Credenciales APNs y broker central (Ristak Installer)

`docs/MOBILE_APP.md:1095-1147`, `pushNotificationsService.js:28-36, 271-341,
2001-2056`, `licenseService.js:717-733`:

- Modo recomendado (managed): la instalación cliente **no** tiene `.p8`. El
  portal central "Ristak Installer" guarda las credenciales APNs cifradas
  (`mobile_apns_key_id`, `mobile_apns_team_id`, `mobile_apns_bundle_id`,
  `mobile_apns_private_key_p8`, `mobile_apns_environment`) y reporta
  `iosConfigured=true` vía `GET /api/license/mobile-push/status` (consultado
  server-to-server con `callLicenseServer`). El backend cliente registra los
  tokens localmente y delega el envío:
  `POST <installer>/api/license/mobile-push/send` con
  `{ devices: [{ id, platform, token, experience:{soundEnabled,vibrationEnabled} }], payload }`;
  respuesta `{ sent, results: [{ id, success, skipped, statusCode, reason, error }] }`.
  El broker reintenta el ambiente APNs alterno cuando recibe `BadDeviceToken`
  (cubre builds sandbox y producción sin duplicar secretos).
- Modo standalone: variables de entorno del backend
  `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` (default `com.ristak.app`),
  `APNS_PRIVATE_KEY` o `APNS_PRIVATE_KEY_FILE`, `APNS_ENV`
  (`production` default; `development`/`sandbox` → host sandbox).
- **Implicación clave para `ios/app`**: el `apns-topic` que usa el
  broker/backend debe coincidir con el bundle id de la app instalada. El
  Installer solo considera APNs configurado cuando el topic es exactamente
  `com.ristak.app` y rechaza otro valor al guardar. La app SwiftUI Apple usa
  `com.ristak.app`, la app RN Android usa
  `com.ristak.android` y el NSE reservado es
  `com.ristak.app.NotificationService` (`docs/MOBILE_APP.md`, parity checklist).
- FCM (Android, referencia): `FCM_PROJECT_ID` + `FCM_SERVICE_ACCOUNT_JSON`.
- Web Push: llaves VAPID por env o autogeneradas y persistidas en DB (con
  warning NOTI-009 de no usarlas autogeneradas en producción).

---

## 9. Notification Service Extension (Communication Notifications)

Swift implementado en:
`ios/app/RistakNotificationService/NotificationService.swift`. Comportamiento
exacto:

1. `didReceive` copia el contenido mutable; si falla, entrega el original.
2. **Media**: busca la primera URL http(s) en
   `notificationAttachmentUrl`, `notification_attachment_url`,
   `notificationImageUrl`, `notification_image_url`, `mediaAttachmentUrl`,
   `media_attachment_url`, `mediaUrl`, `media_url`, `image`,
   `fcm_options.image`, `aps.image` — **saltando** la que sea igual al avatar
   (líneas 192-219). La descarga y adjunta como `UNNotificationAttachment`
   id `message-media`; extensiones permitidas: jpg/jpeg/png/gif/heic/heif/
   mp4/mov/m4v (fallback `jpg`).
3. **Communication sender** (iOS 15+): si hay nombre
   (`contactName`/`contact_name`/`senderName`/`sender_name`/título) y
   `contactAvatarUrl`/`contact_avatar_url`/`senderAvatarUrl`/`sender_avatar_url`:
   descarga el avatar (valida `mimeType image/*`), crea `INPerson`
   (handle/customIdentifier = `contactId` → `threadId` → `messageId` → UUID),
   `INSendMessageIntent` con `conversationIdentifier` = `threadId` →
   `contactId` (fallback persona), `serviceName: "Ristak"`, dona la
   `INInteraction` (direction `.incoming`) y entrega
   `content.updating(from: intent)`. Si algo falla, entrega el contenido con
   solo la media.
4. `serviceExtensionTimeWillExpire`: cancela descargas y entrega el mejor
   intento.
5. Estado, tareas y callback final se serializan; cada request termina una sola
   vez. Los timeouts son 6–7 s. Avatar tiene tope 5 MB y media 12 MB; ambas se
   descargan primero a archivo temporal y se valida tamaño antes de llevar datos
   a memoria, evitando jetsam de la extensión.

Requisitos de proyecto:

- Entitlement en la app principal:
  `com.apple.developer.usernotifications.communication = true`
  (ver `mobile/app.json:24-27`) y `aps-environment`.
- Target NSE `RistakNotificationService` con bundle
  `com.ristak.app.NotificationService`, embebido en `Ristak.app`.
- El backend ya manda `mutable-content:1` solo cuando hay algo que hacer.

---

## 10. Cliente móvil: comportamiento existente a replicar

### 10.1 Registro y preferencias (app RN `mobile/` — paridad objetivo)

Flujo de registro (`mobile/src/notifications.ts:195-267`,
`mobile/src/App.tsx:1446-1466`):

1. **Auto-registro tras login** (una vez por `baseUrl:userId`): si el permiso
   nativo es `granted` o `prompt`, llama `subscribeToNativePushNotifications`.
2. Ese método: valida `GET /push/public-key` → si `iosConfigured` falso,
   devuelve `not_configured` con copy
   `"Las notificaciones de iPhone todavía no están preparadas para esta instalación."`;
   pide permisos (`allowAlert/allowBadge/allowSound`); si deniegan →
   `denied` con `"Este celular no dio permiso para recibir notificaciones de Ristak."`;
   obtiene el device token APNs nativo y hace
   `POST /push/mobile-devices` con
   `{ token, platform:'ios', calendarIds, appVersion:'', appBuild:'', deviceModel,
   osVersion, clientType:'native', appPackage:'com.ristak.app' }`.
   `ios/app` separa permiso del sistema de registro confirmado en backend,
   serializa activaciones, reintenta 5/15/60/300 s y revalida en foreground si
   la confirmacion supera 6 h. Cada activacion queda ligada a un epoch de sesion.
3. Reintento manual desde Ajustes → Notificaciones (botón `Activar`/
   `Actualizar`), pasando `calendarIds` = selección actual si
   `calendar_push_notifications_enabled` (App.tsx:11800-11826).

Preferencias por usuario — leídas/escritas vía `GET/POST /api/user-config`
(`mobile/src/api.ts:1073-1086`; montado en `server.js:333`). Claves y defaults
de UI (`App.tsx:897-903, 11674-11679`):

| Clave | Default UI | Controla |
|---|---|---|
| `chat_push_notifications_enabled` | `true` | push de mensajes + prioridad del agente |
| `calendar_push_notifications_enabled` | `false` | push de citas agendadas/estado |
| `appointment_confirmation_push_notifications_enabled` | `true` | push de citas confirmadas |
| `payment_push_notifications_enabled` | `true` | push de pagos |
| `push_notification_sound_enabled` | `true` | `aps.sound` |
| `push_notification_vibration_enabled` | `true` | solo Android; en iOS no tiene efecto en el sistema |
| `calendar_push_notification_calendar_ids` | `[]` (=todos) | filtro de calendarios por usuario |

### 10.2 UX — Ajustes → Notificaciones (app RN; textos exactos en español)

`mobile/src/App.tsx:11828-11845 (lista), 12157-12228 (panel)`:

- Ítem de lista: título **"Notificaciones"**, descripción
  **"Mensajes, citas, sonido y vibración."**, meta = estado del permiso:
  `Activo` | `Bloqueado` | `No soportado` | `Activar`
  (`getPushPermissionLabel`, 11377-11382). Icono campana, tono rojo.
- Card de estado: en `ios/app` solo dice
  **"Alertas activas en este celular · N tipos prendidos."** cuando permiso y
  registro backend estan confirmados; permiso `granted` sin backend se presenta
  como pendiente/fallido, nunca como activo. Si no →
  **"Permiso nativo: <label>."** + mensaje de estado
  (p. ej. "Activando alertas en este celular...", "Alertas activas en este
  celular.", o la razón de fallo). Botón con spinner:
  **"Activar"** / **"Actualizar"**. Alert de error:
  título "Falta preparar alertas" (not_configured) o "No se activaron".
- Toggles (título / descripción):
  - **Mensajes del chat** — "Avísame cuando llegue un WhatsApp nuevo."
  - **Citas agendadas** — "Avísame cuando alguien reserve una cita nueva."
    - Si ON, card **"Calendarios con alertas"** con chip
      **"Todos los calendarios"** + chips por calendario (dot de color),
      contador "N seleccionados"/"Todos"; loading
      "Cargando calendarios..."; vacío "No hay calendarios activos para elegir."
  - **Citas confirmadas** — "Avísame cuando un cliente confirme que sí asistirá."
  - **Pagos** — "Avísame cuando se registre un pago."
  - Card **"Sonido y vibración"** — "Controla cómo se sienten las alertas en
    este celular.": **Timbre de notificación** — "Hace sonar el celular cuando
    llegue una alerta." / **Vibración de notificación** — "Vibra cuando entren
    mensajes, citas, confirmaciones o pagos."
- Cada toggle se deshabilita mientras guarda (`savingKey`).

### 10.3 Recepción y deep-link (app RN — replicar en SwiftUI)

`mobile/src/notifications.ts:83-193`, `mobile/src/App.tsx:643-656, 735-737,
1431-1444, 2419-2434, 2744-2788, 18909-18921`:

- **Foreground**: el handler muestra banner+lista+sonido, **sin badge**
  (`shouldSetBadge:false`, notifications.ts:29-36) y además emite un evento
  interno (`CHAT_REFRESH_EVENT = 'ristak:chat-refresh'`) que fuerza refresh
  inmediato de bandeja y del hilo abierto. En iOS nativo:
  `userNotificationCenter(_:willPresent:)` → `.banner .list .sound` + refrescar.
- **Tap (background o cold start)**: construir un "intent" desde
  `userInfo`: `url` = `data.url` || `data.route` || `/movil`;
  `contactId` = `data.contactId` || `data.contact_id` || query `contact`/
  `contactId` de la URL; `category`. Router
  (`getPhoneSectionFromNotification`): URL/category conteniendo
  `/calendar|appointment|cita` → sección Citas; `/transactions|/payments|
  payment|pago` → Pagos; `analytic` → Analíticas; `setting|ajuste` → Ajustes;
  `contactId` presente o `chat|message|mensaje` → Chats.
- Si hay `contactId`: abrir Chats, cerrar sheets/selección/búsqueda, buscar el
  contacto en la bandeja cargada; si no está, `GET /contacts/:id`, inyectarlo
  arriba de la lista y abrir la conversación. Error → Alert "Notificación" /
  "No pude abrir este chat.".
- Cold start: procesar la última respuesta de notificación al lanzar
  (equivalente a `getLastNotificationResponse`; en iOS nativo usar
  `didFinishLaunching` + delegate).
- **Polling**: RN usa bandeja cada **20 s** e hilo cada **7 s**. `ios/app` usa
  **12 s** y **4 s**, respectivamente, mas foreground + push/SSE; los acuses
  salientes conservan **12 s**.
  Un poll sin cambios debe ser no-op de render (mismas referencias).
- La app RN hoy **no** abre SSE ni reporta presencia (solo polling+push). La
  app iOS nativa debe además implementar SSE+presencia como /movil (§2-§3).

### 10.4 /movil (PWA/Capacitor — referencia de paridad)

- SSE chat + presencia como §2-§3 (`PhoneChat.tsx:8884-8922`).
- Polling: bandeja 20 s (visible y sin búsqueda activa; 8836-8841), hilo
  abierto 7 s (9006-9021), acuses pendientes 12 s (8987-8997), mensajes
  programados: intervalo dinámico 15 s–5 min (8963-8974).
- Service worker (`frontend/public/sw.js:236-300`): en `push` muestra SIEMPRE
  la notificación (tag fijo `ristak-latest-notification`, `renotify:true` — en
  web solo se conserva la última) y postea
  `{ type:'ristak:push-notification', payload }` a las ventanas abiertas;
  PhoneChat usa ese mensaje para inyectar un preview optimista del mensaje en
  la bandeja/hilo (`applyRealtimePreviewMessage`, 7815-7873; descarta previews
  viejos con `isRecentRealtimePreviewMessage`, dedup por `message.id`) y
  refrescar. `notificationclick` enfoca/navega la ventana al `url` del payload
  o abre una nueva.
- Shell Capacitor (`mobileAppService.ts:466-478, 380-404`): listeners
  `pushNotificationReceived`/`pushNotificationActionPerformed` → dispara
  `CustomEvent 'ristak:mobile-notification'` y en tap navega con
  `openInternalPath(url)`.

### 10.5 Vista "campana" de notificaciones del sistema (no-push)

`GET /api/settings/notifications?liveMetaCheck=1&limit=30` (Bearer;
`settings.routes.js:93`, `notificationsController.js:4-18`,
`notificationsService.js:1237-1273`). Respuesta:

```json
{
  "success": true,
  "data": {
    "summary": { "total": 3, "critical": 1, "warning": 2, "info": 0, "highestSeverity": "critical" },
    "items": [
      {
        "id": "meta:token-expiry",
        "source": "Meta Ads | WhatsApp Business | Sistema | Dominios | Automatizaciones | Agente AI | Ristak",
        "severity": "critical | warning | info",
        "title": "…", "message": "…",
        "createdAt": "ISO", "updatedAt": "ISO",
        "actionUrl": "/settings/meta-ads", "actionLabel": "Revisar Meta"
      }
    ],
    "generatedAt": "ISO"
  }
}
```

Incluye notificaciones internas por usuario (broadcast + dirigidas). Es la
campana del header desktop; ni /movil ni la app RN la muestran hoy.
`liveMetaCheck=0` evita los chequeos vivos contra Meta (cacheados 5 min).

---

## 11. Especificación de implementación iOS (síntesis normativa)

1. **SSEClient** (actor): conexión `URLSession` streaming con
   `Authorization: Bearer`, `Accept: text/event-stream`; parser de frames;
   watchdog de heartbeat (~40 s sin datos ⇒ reconectar); backoff 1 s ×2 hasta
   15 s, reset al conectar; suspender en background, reconectar en foreground.
   Dos streams: chat (siempre que haya sesión y módulo chat) y pagos (al menos
   mientras Pagos esté visible).
2. **Dedup/reconciliación**: aplicar primero la actividad minima para promover la
   fila, luego disparar `refresh` coalescido (si hay uno en vuelo, encolar otro).
   Mantener overlay transitorio para que REST viejo no deshaga la promocion. El
   estado de verdad viene de REST; merge por id de mensaje/contacto; no-op si igual.
3. **Presencia**: reportar `viewing` al abrir/cerrar chat, en cambios de
   scenePhase y keep-alive cada 20 s; `{contactId:'', foreground:false}` al
   salir.
4. **Push**: pedir permiso tras login (auto si `prompt`), registrar token en
   `POST /api/push/mobile-devices` con `platform:'ios'`, `clientType:'native'` y
   `appPackage:'com.ristak.app'`; reintentar en cada arranque/cambio de token
   (`didRegisterForRemoteNotificationsWithDeviceToken`). El permiso no basta:
   activo exige ACK del backend. Registro/retry/logout validan epoch de sesion.
   Respetar `iosConfigured` del public-key. Categorías UNNotification a
   registrar (para futuras acciones): al menos `CHAT`, `PAYMENT`,
   `APPOINTMENT_BOOKED`, `APPOINTMENT_CONFIRMED`, `RISTAK` (hoy sin acciones).
5. **Foreground push**: presentar `.banner .list .sound` y disparar refresh de
   bandeja/hilo. La supresión del chat visible la hace el servidor vía
   presencia (si la presencia funciona, no llegará push del chat abierto).
6. **Tap/deep-link**: usar `userInfo.url`/`contactId` con el router de §10.3.
7. **NSE**: portar `NotificationService.swift` (§9) con bundle
   `<bundleId>.NotificationService` y entitlement de Communication
   Notifications en la app.
8. **Badge de ícono**: no llega del servidor. Opcional local: usar el total de
   no leídos de la bandeja (la app RN muestra ese total como badge del dock de
   Chats — `badges={{ chat: chatUnreadTotal }}`, App.tsx:1379) con
   `UNUserNotificationCenter.setBadgeCount`. Documentar que se desincroniza con
   la app cerrada (ver gap).

---

## 12. Gaps / riesgos para iOS nativo y OPEN QUESTIONS

1. **`aps.badge` nunca se envía**: `sendApnsNotification` lo soporta
   (`payload.badge`), pero ningún emisor lo setea. El ícono de la app no puede
   reflejar no-leídos con la app cerrada. Si se quiere, falta backend (contador
   de no-leídos por usuario en cada push de chat).
2. **SSE sin replay**: `id` incremental sin `Last-Event-ID`; eventos perdidos
   en reconexión no se recuperan ⇒ el polling de 20 s/7 s NO es opcional.
3. **SSE de chat es broadcast global**: cualquier usuario con módulo `chat`
   recibe eventos de TODOS los contactos (solo metadatos, sin texto). No
   filtrar UI con él más allá de disparar refresh.
4. **`POST /api/chat-events/viewing` exige `chat:write`** (por ser POST bajo
   `requireModuleAccess`). Un usuario read-only de chat no puede suprimir sus
   push ni auto-marcar leído. **OPEN QUESTION:** ¿bug o intencional?
5. **RESUELTO — Bundle id / topic APNs**: `ios/app` y el topic oficial usan
   `com.ristak.app`; el Installer rechaza otro valor al guardar y no reporta
   `iosConfigured=true` con un topic heredado/Android.
6. **RESUELTO EN iOS — unregister en logout**: `ios/app` invalida registros en
   vuelo, espera su cierre, llama `DELETE /api/push/mobile-devices` y limpia APNs
   local. RN/PWA legacy conservan su comportamiento anterior.
7. **No hay eventos realtime de leído/asignación/tags/citas** (solo push para
   citas/pagos y SSE para mensajes/pagos). El estado leído entre dispositivos
   solo converge por polling (el backend sí marca leído por presencia).
8. **`push_notification_vibration_enabled` no tiene efecto en iOS** (solo
   canales Android). Mostrar el toggle igualmente por paridad de UI.
9. **Payments SSE requiere feature de licencia `payments`**: manejar 403
   `license/feature` sin romper la pantalla.
10. **NSE oficial en `ios/app`**: `mobile/ios` está gitignored; la app Apple
    oficial compila `ios/app/RistakNotificationService/NotificationService.swift`.
    El archivo legacy bajo `frontend/ios/App/...` queda solo como referencia
    histórica y no debe ser el target de App Store.
11. **Avatar de iniciales requiere URL pública configurada**
    (`PUBLIC_APP_URL` etc.): en instalaciones sin ella, los push llegan sin
    avatar; el NSE ya lo tolera (muestra AppIcon).
12. **`connected` y heartbeats no traen datos de negocio**: no usarlos como
    señal de "hay novedades".
13. **Dedup de push en foreground vs SSE vs polling**: pueden llegar los tres
    para el mismo mensaje; la única clave estable de dedup es el `messageId`
    del payload REST (los previews optimistas de /movil se reemplazan cuando el
    poll trae el mensaje real). Diseñar el merge por id, no por conteo.
14. **OPEN QUESTION — `calendar_push_notifications_enabled` default**: la UI
    móvil lo muestra OFF por defecto (App.tsx:11675), pero el fallback del
    dispatcher por usuario es `true` con herencia del global
    (`pushNotificationsService.js:1374-1380`); el gate real de citas es la
    config global `calendar_push_notifications_enabled` + matriz. Ante duda,
    replicar defaults de UI de la app RN.

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **CORRECCIÓN — §1 (endpoint de reconciliación):** `GET /api/whatsapp-api/conversations`
   **no existe** (verificado: `whatsappApi.routes.js` no define ninguna ruta
   `/conversations`). El payload de reconciliación que trae `unreadCount`, asignado, tags,
   etc. es `GET /api/contacts/chats` (doc 03 §1.1). Sustituir la referencia.
2. **CONFIRMADO — OPEN QUESTION §12.4 (presencia exige `chat:write`):**
   `chatEvents.routes.js:18` aplica `requireModuleAccess('chat')` al POST `/viewing` y
   `userAccessMiddleware.js:17` deriva `write` para todo método ≠ GET/HEAD. Un usuario
   con `chat:'read'` recibe 403 `write_access_required` al reportar presencia. Si es
   intencional sigue siendo pregunta de producto, pero la app iOS DEBE tratar el
   `reportViewing` como best-effort silencioso (tragarse el 403) para no romper la UX de
   usuarios read-only.
3. **RESUELTO — §12.5 (bundle id):** `ios/app/Ristak.xcodeproj` usa
   `PRODUCT_BUNDLE_IDENTIFIER = com.ristak.app`, alineado con el topic APNs por
   defecto (`APNS_BUNDLE_ID=com.ristak.app`) y con la identidad de App Store. El
   perfil App Store de la app principal debe conservar Push Notifications y
   Communication Notifications; `com.ristak.app.NotificationService` es el
   bundle activo de la Notification Service Extension.
4. **CONFIRMADO — §6.2:** `aps.sound` solo se incluye si el destinatario tiene sonido ON
   (`pushNotificationsService.js:1905-1907`) y `aps.badge` nunca se manda hoy (ningún
   emisor setea `payload.badge`), tal como documenta §12.1.

## Audit resolutions (2026-07-10, hardening iOS de produccion)

1. La bandeja aplica actividad inmediata con dedup y overlay pendiente; una
   respuesta REST vieja ya no puede deshacer el orden/preview, y el hilo abierto
   reenvia eventos de otros contactos.
2. El registro APNs reporta `clientType=native` y `appPackage=com.ristak.app`;
   permiso y ACK backend son estados distintos. Reintentos y logout estan
   ligados a la generacion de sesion para no revivir el token de otra cuenta.
3. El Installer exige topic exacto `com.ristak.app`. El host productivo
   `raulgomez.onrender.com` reporta `iosConfigured=true`; `app.ristak.com` es
   standalone y no sirve para validar el broker nativo.
4. El NSE serializa finalizacion, usa timeouts acotados y valida tamaño desde
   archivo temporal (5 MB avatar, 12 MB media) antes de cargar bytes.
