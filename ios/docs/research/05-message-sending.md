# 05 — Envío de mensajes (message-sending)

Spec exhaustiva para la app nativa SwiftUI (iPhone/iPad, iOS 26). Cubre TODOS los
tipos de envío de mensajes salientes: WhatsApp API oficial (YCloud), WhatsApp QR
(Baileys), Meta directo, Messenger/Instagram nativo (Meta Graph), HighLevel
Conversations, correo SMTP, plantillas, mensajes programados, reacciones,
ubicación, y los controles del agente conversacional que se cruzan con el envío.

Fuentes principales (con líneas):

- Rutas: `backend/src/routes/whatsappApi.routes.js` (montado en `/api/whatsapp-api`,
  ver `backend/src/server.js:341`; requiere auth + feature `whatsapp`).
- Controlador: `backend/src/controllers/whatsappApiController.js`.
- Servicio: `backend/src/services/whatsappApiService.js` (~10.9k líneas).
- QR/Baileys: `backend/src/services/whatsappQrService.js`.
- Programados: `backend/src/services/scheduledChatMessagesService.js`.
- Meta social: `backend/src/services/metaSocialMessagingService.js`.
- HighLevel: `backend/src/controllers/highlevelController.js` (montado en `/api/highlevel`, `server.js:295`).
- Email: `backend/src/routes/email.routes.js` + `backend/src/services/emailService.js` (montado `/api/email`, feature `email`).
- Agente conversacional: `backend/src/routes/conversationalAgent.routes.js` (montado
  `/api/conversational-agent`, `server.js:337`; requiere auth + feature `conversational_ai` +
  módulo `ai_agent` + OpenAI configurado).
- Frontend /movil: `frontend/src/pages/PhoneChat/PhoneChat.tsx` (~22.2k líneas) y
  `frontend/src/services/whatsappApiService.ts` (tipos exactos de payloads).
- Cliente RN: `mobile/src/api.ts`, `mobile/src/types.ts`.

Convenciones globales de respuesta del backend:

```json
// Éxito
{ "success": true, "data": { ... } }
// Error
{ "success": false, "error": "Mensaje en español para el usuario" }
```

Todos los endpoints de este módulo (salvo los webhooks) requieren la sesión
autenticada (cookie/token del login Ristak). Los errores de envío WhatsApp
devuelven HTTP 400 en general; Meta social usa `error.statusCode` (400/404/409/422);
programados usan `error.statusCode` (400/404); email usa 400/409/500.

---

## 1. WhatsApp — arquitectura de transportes

Un mismo número de negocio puede tener hasta 3 rutas de salida:

1. **`api`** — WhatsApp API oficial vía YCloud (proveedor default, `provider: 'ycloud'`).
2. **`meta_direct`** — WhatsApp Cloud API directo de Meta (si `config.provider === 'meta_direct'`;
   el backend redirige automáticamente, el cliente NO manda nada distinto).
3. **`qr`** — sesión Baileys ligada por QR (campo `transport: 'qr'` en el body).

El cliente elige `transport: 'api' | 'qr'` (default `'api'`). Si se pide `api`, el
backend puede hacer **fallback automático a QR** (ver §1.2). La respuesta indica el
transporte real usado.

### 1.1 Regla de ventana de 24 horas (customer service window)

`whatsappApiService.js:92-94`:

- `WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS = 24h`.
- Razón "cerrada": `"La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas."`
- Razón "desconocida": `"No hay una respuesta reciente del cliente registrada; WhatsApp API solo permite mensajes libres dentro de la ventana de 24 horas."`

Preflight backend (`getOfficialApiClosedReplyWindowReason`, líneas 2708-2755): busca el
último mensaje `inbound` en `whatsapp_api_messages` filtrando por `contact_id`/teléfonos
del contacto y por número del negocio (`business_phone`/`business_phone_number_id`).
Si no hay inbound o tiene ≥24h, la ventana se considera cerrada.

Decisión (`getOfficialApiFallbackDecision`, líneas 2892-2923) para cada envío `api`
de tipo libre (texto, reacción, ubicación, imagen, doc, video, audio, interactivo —
NO plantillas, que solo evalúan restricciones de cuenta):

- Si hay razón de bloqueo (ventana cerrada, número BANNED/BLOCKED/RESTRICTED/
  RATE_LIMITED/DISCONNECTED/MIGRATED, `api_send_enabled=0`, alerta crítica activa
  <6h de antigüedad, error 429/patrones de restricción) **y existe** un número QR
  conectado de respaldo → envía por QR (`shouldFallback`).
- Si la ventana está cerrada y **no hay** QR → lanza error 400 con el texto de la
  razón (`throwIfOfficialApiBlockedByReplyWindow`, línea 2925). El cliente debe
  entonces ofrecer plantillas.
- Códigos de error Meta tratados como "de conversación" (no marcan la cuenta):
  `131047`, `131026`, `131021`, `470` (línea 2862).
- Si el envío API falla en vivo, se reintenta la decisión con el error y puede caer
  a QR; si tampoco hay QR, el saliente fallido se persiste igual
  (`persistFailedOutboundApiMessage`, línea 6207) y el error se propaga (HTTP 400).

Frontend /movil replica el preflight localmente (`PhoneChat.tsx:6559-6574`):
`apiReplyWindowOpen = isInsideReplyWindow(lastInboundForSelectedPhone?.date)` usando
los mensajes cargados, filtrando por el número de negocio seleccionado. Lógica de
resolución de transporte al enviar (`PhoneChat.tsx:12960-12977`):

```
resolvedTransport = selectedQrReady && (transportPedido=='qr' || !apiReplyWindowOpen || !whatsappConnected || apiUnavailableForSelected) ? 'qr' : 'api'
si resolvedTransport=='api' && !whatsappConnected  → toast "WhatsApp no está conectado"
si !apiReplyWindowOpen && !selectedQrReady          → abre el sheet de Plantillas (forzar plantilla)
si resolvedTransport=='qr' && !selectedQrReady      → toast "QR no está conectado" / "Conecta este número por QR en Configuración > WhatsApp."
```

### 1.2 Fallback QR y respuesta decorada

Cuando el backend cae a QR, la respuesta lleva (`decorateQrFallbackResponse`, línea 9010):

```json
{
  "transport": "qr",
  "fallback": true,
  "fallbackFrom": "api",
  "fallbackReason": "<razón en español>",
  "routingReason": "<misma razón>"
}
```

El /movil muestra `routingReason || fallbackReason` como metadata del globo y en
plantillas muestra toast «Plantilla enviada por QR».

### 1.3 Protección anti-bloqueo QR (drip)

`whatsappQrService.js:2975-2992` — todo envío QR espera un slot del "drip"
(`waitForWhatsAppQrDripSlot`) **salvo** que el request venga con
`messageOrigin: 'manual_chat'` (el controller lo convierte en
`skipQrSendProtection: true`, `whatsappApiController.js:102-104`). Es decir: los envíos
manuales del chat NO se retrasan; automatizaciones sí. **La app nativa debe mandar
siempre `messageOrigin: 'manual_chat'`** en envíos manuales de texto/imagen/video/
audio/documento/ubicación/reacción (el /movil lo hace en todos).

Config del drip: `GET/PUT /api/whatsapp-api/qr/drip-settings` con
`{ enabled: boolean, delaySeconds: number, delayUnit: 'seconds'|'minutes' }`.

Validaciones QR duras (`sendWhatsAppQrTextMessage`, `whatsappQrService.js:2994+`):
- Auth caducada → error `"El QR necesita reconectarse. Abre Configuración > WhatsApp y genera un QR nuevo."`
- `qr_send_enabled !== 1` → `"Ese número no tiene el envío por QR activado"`.

### 1.4 Selección de remitente

Cada payload de envío WhatsApp acepta:

- `from` (string, teléfono del negocio; si falta usa `config.senderPhone` default).
- `phoneNumberId` (string, id interno del número de negocio — recomendado; es la
  clave que resuelve QR y disponibilidad).

El /movil siempre manda ambos: `from: selectedBusinessPhoneValue`,
`phoneNumberId: selectedBusinessPhone?.id`.

### 1.5 Variables de plantilla en texto libre

`renderTemplateVariables` se aplica server-side a `text` y `caption` (texto, imagen,
documento, video, interactivo): sintaxis `{{contact.name}}` etc. La app puede mandar
el texto tal cual escrito; el backend resuelve variables con
`contactId` + `phone` + `userId`.

---

## 2. Endpoints de envío WhatsApp (base `/api/whatsapp-api`)

Respuesta común de éxito de todos los envíos (campos principales; el objeto es el
mensaje del proveedor + extras):

```json
{
  "success": true,
  "data": {
    "id": "<id proveedor>",          // opcional
    "wamid": "<wamid>",              // en QR y algunos casos
    "localMessageId": "<id fila whatsapp_api_messages>", // usar para reconciliar el globo optimista
    "status": "sent|accepted|...",
    "transport": "api" | "qr",
    "fallback": true, "fallbackFrom": "api", "fallbackReason": "...", "routingReason": "...", // solo si hubo fallback
    "image|video|audio|document|location|template|text": { ... } // eco del contenido enviado
  }
}
```

Tipo TS de referencia: `WhatsAppApiSendResponse` en
`frontend/src/services/whatsappApiService.ts:435-498` (incluye subobjetos `audio`
`{link,url,mimeType,mimetype,durationMs,ptt,voice}`, `localMedia`
`{publicUrl,publicPath,mimeType,filename}`, `image/video/document` con
`link,url,mimeType,mimetype,filename,fileName,caption`, `location`
`{latitude,longitude,name,address,url}`).

### 2.1 `POST /messages/text`

Body (`whatsappApiController.js:639-655` + tipos frontend 281-292):

```json
{
  "to": "5215512345678",            // requerido. Teléfono destino (se normaliza server-side)
  "from": "5215598765432",          // opcional (default: número principal)
  "contactId": "rstk_...",          // recomendado (ventana 24h, takeover, persistencia)
  "text": "Hola {{contact.first_name}}",  // requerido
  "externalId": "local-1751879000000",     // opcional. Id idempotente generado por el cliente
  "transport": "api",               // 'api' | 'qr' (default 'api')
  "phoneNumberId": "wapn_...",      // opcional pero recomendado
  "replyToMessageId": "...",        // opcional: id LOCAL del mensaje citado
  "replyToProviderMessageId": "...",// opcional: wamid/id proveedor del citado
  "messageOrigin": "manual_chat"    // SIEMPRE en envíos manuales
}
```

Validaciones backend: falta `to` → `"Falta el número destino"`; falta `text` →
`"Falta el texto del mensaje"`; API no conectada → `"WhatsApp_API no está conectado"`;
falta emisor → `"Falta el número emisor de WhatsApp_API"`. Reply: el backend resuelve
la referencia contra `whatsapp_api_messages` (id local, `ycloud_message_id`,
`meta_message_id` o `wamid`; `whatsappApiService.js:4405-4499`) y agrega
`context: { message_id }` al proveedor. Efecto lateral: marca "toma humana" del
agente conversacional si estaba activo (§8.3).

### 2.2 `POST /messages/reaction`

```json
{
  "to": "...", "from": "...", "contactId": "...",
  "emoji": "❤️",                       // requerido, no vacío
  "targetMessageId": "<id local>",      // o "messageId" (alias)
  "targetProviderMessageId": "<wamid>", // o "providerMessageId" (alias)
  "externalId": "local-reaction-...",
  "transport": "api" | "qr",
  "phoneNumberId": "...",
  "messageOrigin": "manual_chat"
}
```

Errores: `"Falta la reacción"`, `"No encontramos el mensaje original para reaccionar"`.
Reglas de UI /movil (`PhoneChat.tsx:11030-11106`):

- Emojis disponibles: `['❤️','👍','😂','😮','🙏']` (línea 214). Para mensajes de
  Messenger/Instagram solo `['❤️']`.
- Solo se puede reaccionar a mensajes **inbound** («Las APIs oficiales reaccionan a
  mensajes que te mandó el contacto.»). Mensajes de comentario, HighLevel o email →
  toast «Canal sin reacción nativa».
- Requiere `providerMessageId` del globo; si falta → «Falta ID del mensaje».
- `transport` se toma del transporte del mensaje objetivo (`'qr'` si el globo llegó
  por QR); `from` = `message.businessPhone || selectedBusinessPhoneValue`.
- Optimista: agrega la reacción outbound reemplazando cualquier reacción outbound
  previa (cambiar reacción = mandar otra). **No hay UI de "quitar reacción"** en
  /movil (WhatsApp lo hace mandando emoji vacío, pero el backend rechaza emoji
  vacío → OPEN QUESTION §10).

### 2.3 `POST /messages/location`

```json
{
  "to": "...", "from": "...", "contactId": "...",
  "latitude": 19.4326,   // requerido, número finito
  "longitude": -99.1332, // requerido, número finito
  "name": "Oficina",     // opcional
  "address": "CDMX",     // opcional
  "externalId": "...", "transport": "api", "phoneNumberId": "...",
  "messageOrigin": "manual_chat"
}
```

Error: `"Faltan coordenadas válidas para la ubicación"`. El backend agrega
`url: "https://www.google.com/maps?q=<lat>,<lng>"` y responde `location` normalizada.
Flujo /movil (`handleShareLocation`, 13258-13298): botón `+ > Ubicación` toma la
ubicación ACTUAL del dispositivo (`getCurrentGeolocationPosition`); errores:
permiso denegado → «Ubicación bloqueada / Permite ubicación para Ristak desde
ajustes del celular y vuelve a intentar.» Para Messenger/Instagram/HighLevel la
ubicación se manda como TEXTO con link de mapa (fallback `buildLocationFallbackText`).
No se permite compartir ubicación si hay adjuntos/nota de voz pendientes
(«Termina el adjunto») ni en respuestas a comentarios.

### 2.4 `POST /messages/image`

```json
{
  "to": "...", "from": "...", "contactId": "...",
  "imageDataUrl": "data:image/jpeg;base64,...", // opción A (recomendada desde móvil)
  "imageUrl": "https://...",                    // opción B: link público HTTPS
  "caption": "texto opcional",                  // se recorta a 1024 chars, admite {{variables}}
  "externalId": "...", "transport": "api", "phoneNumberId": "...",
  "messageOrigin": "manual_chat"
}
```

**Codificación de media: SIEMPRE data URL base64 en JSON. No hay multipart.**

Reglas de imagen (`whatsappApiService.js:633-696`):
- MIME aceptados: `image/jpeg|jpg|png|webp`. Error: `"La foto debe ser JPG, PNG o WebP."`
- Máx entrada 25 MB; máx tras compresión 5 MB. El backend re-encoda con sharp a
  JPEG ≤1600px, calidad 82, fondo blanco.
- Si se manda `imageUrl` por transporte `api`, debe ser `https://` (error:
  `"La foto necesita un enlace público HTTPS para poder enviarse por WhatsApp."`).
- Para `api`, el binario se sube a YCloud (`image: { id }`); además se guarda un
  preview local público para el chat.

### 2.5 `POST /messages/document`

```json
{
  "to": "...", "from": "...", "contactId": "...",
  "documentDataUrl": "data:application/pdf;base64,...",
  "documentUrl": "https://...",       // alternativa
  "filename": "contrato.pdf",        // se sanitiza; extensión inferida del MIME si falta
  "mimeType": "application/pdf",
  "caption": "opcional (1024 máx)",
  "externalId": "...", "transport": "api", "phoneNumberId": "...",
  "messageOrigin": "manual_chat"
}
```

MIME de documento aceptados (líneas 135-145): pdf, doc, docx, xls, xlsx, ppt, pptx,
txt, csv (más audio/video compatibles al mandarse "como documento"). Máx 20 MB
(error: `"El documento pesa demasiado. Elige uno de menos de 20 MB..."`).

### 2.6 `POST /messages/video`

```json
{
  "to": "...", "from": "...", "contactId": "...",
  "videoDataUrl": "data:video/mp4;base64,...",
  "videoUrl": "https://...",
  "caption": "opcional",
  "externalId": "...", "transport": "api", "phoneNumberId": "...",
  "messageOrigin": "manual_chat"
}
```

MIME: `video/mp4`, `video/quicktime` (MOV), `video/webm`, `video/3gpp`. Máx entrada
25 MB; el backend transcodifica a MP4 ≤16 MB (ffmpeg). Error de formato: `"El video
debe ser MP4, MOV, WebM o 3GP para poder prepararlo para WhatsApp."`

### 2.7 `POST /messages/audio` (notas de voz)

```json
{
  "to": "...", "from": "...",
  "audioDataUrl": "data:audio/mp4;base64,...",  // o audioUrl https
  "audioUrl": "https://...",
  "durationMs": 5230,        // duración medida por el cliente (se ecoa en la respuesta)
  "voice": true,             // true = nota de voz (PTT). Si se omite: true cuando hay audioDataUrl
  "externalId": "local-...-audio",
  "transport": "api", "phoneNumberId": "...",
  "messageOrigin": "manual_chat"
}
```

Sin `contactId` en el tipo frontend del audio (el backend igual lo acepta y el
controller lo pasa; el /movil no lo manda — mandar `contactId` es seguro y
recomendable). MIME de audio aceptados (líneas 114-127): aac, amr, m4a
(`audio/mp4`), mp3, ogg, webm, wav (+`video/mp4` de Safari, que se transcodifica).
Máx 16 MB. Si no es `audio/ogg;codecs=opus` se transcodifica server-side a
OGG/Opus para el proveedor cuando WhatsApp lo requiere. La respuesta y el
mensaje persistido deben incluir `audio: { link/url público, mimeType,
durationMs, voice }` apuntando a la copia reproducible de Ristak (`audio/mp4` /
M4A cuando haga falta), no solo al `media_id` del proveedor, para pintar y
reproducir el player despues de recargar.

### 2.8 `POST /messages/interactive` (botones)

```json
{
  "to": "...", "from": "...", "contactId": "...",
  "body": "Texto del mensaje",       // o "text"
  "buttons": [ { "id": "opt1", "title": "Sí" } ],  // máx 3, título máx 20 chars, id máx 256
  "urlButton": { "title": "Abrir", "url": "https://..." },
  "externalId": "...", "transport": "api", "phoneNumberId": "..."
}
```

No lo usa el composer de /movil (lo usan automatizaciones); paridad opcional en
nativo. Con `transport: 'qr'` o fallback se degrada a texto plano
(`interactivePayload.fallbackText`).

### 2.9 Plantillas

`GET /api/whatsapp-api/templates?status=&limit=` →
`{ success, data: { total, items: WhatsAppApiTemplate[] } }` (el controller además
auto-crea plantillas default). Modelo `WhatsAppApiTemplate`
(`frontend/src/services/whatsappApiService.ts:49-69`):

```
id: string, official_template_id?, waba_id?, name: string, language: string,
category?, sub_category?, previous_category?, message_send_ttl_seconds?,
status?: 'APPROVED'|'PENDING'|'REJECTED'|..., quality_rating?, reason?,
status_update_event?, disable_date?, components?: object[],
ycloud_create_time?, ycloud_update_time?, created_at?, updated_at?
```

Solo `status === 'APPROVED'` se puede enviar.

`POST /api/whatsapp-api/templates/send`:

```json
{
  "to": "...", "from": "...", "contactId": "...",
  "templateId": "...",         // o
  "templateName": "...",       // al menos uno de los dos
  "language": "es_MX",
  "variables": { "1": "Juan" } | ["Juan"],   // opcional
  "components": [ ... ],                      // opcional (formato Meta components)
  "externalId": "template-...",
  "phoneNumberId": "..."
}
```

Si no mandas `variables` ni `components`, el backend construye los components
default de la plantilla con variables del contacto
(`buildDefaultMessageTemplateSendComponents`, `whatsappApiController.js:932-955`).
Validaciones (`whatsappApiService.js:8550-8598`): `"Elige una plantilla"`,
`"Falta el idioma de la plantilla"`, plantilla no sincronizada → `"La plantilla X
(lang) no está sincronizada; sincroniza las plantillas y verifica que esté APPROVED
antes de enviar"`, no aprobada → `"La plantilla X está <STATUS>; solo se pueden
enviar plantillas APPROVED"`. Las plantillas NO validan ventana de 24h (son la
forma de reabrirla). Fallback QR: manda el TEXTO renderizado de la plantilla como
mensaje de texto QR (error si la plantilla no tiene texto guardado).

### 2.10 Mensajes programados

`GET /api/whatsapp-api/messages/scheduled?contactId=<id>` →
`{ success, data: ScheduledChatMessage[] }` (solo estados `scheduled|sending|error`,
orden `scheduled_at ASC`). Sin `contactId` devuelve `[]`.

`POST /api/whatsapp-api/messages/scheduled` (crear **y editar** — mismo endpoint,
upsert por `id`):

```json
{
  "id": "scheduled_chat_...",       // opcional; mándalo para EDITAR uno existente
  "contactId": "rstk_...",          // requerido
  "provider": "whatsapp_api" | "highlevel",
  "channel": "whatsapp_api|sms_qr|messenger|instagram",  // solo provider=highlevel
  "transport": "api" | "qr",        // solo provider=whatsapp_api
  "messageType": "text" | "template",
  "text": "mensaje",                // requerido si messageType=text
  "templateId": "...", "templateName": "...", "templateLanguage": "es_MX",
  "templateComponents": [...], "templateVariables": {...},   // opcionales
  "toPhone": "...",                 // default: contact.phone
  "fromPhone": "...",               // requerido si provider=whatsapp_api
  "businessPhoneNumberId": "...",
  "scheduledAt": "2026-07-08T15:00:00.000Z",  // ISO; si viene sin zona se interpreta en account_timezone
  "externalId": "..."               // default = id
}
```

Respuesta: la fila normalizada `ScheduledChatMessage`:

```
id, contactId, provider ('whatsapp_api'|'highlevel'), channel, transport,
messageType ('text'|'template'), text, templateId, templateName, templateLanguage,
templateComponents (array|null), templateVariables (any|null), toPhone, fromPhone,
businessPhoneNumberId, scheduledAt (ISO UTC), status
('scheduled'|'sending'|'sent'|'error'|'cancelled'), externalId, sentMessageId,
attempts (number), errorMessage, createdAt, updatedAt, sentAt
```

Validaciones (`scheduledChatMessagesService.js:158-217`):
- Fecha inválida → `"Elige una fecha y hora válidas para programar el mensaje."`
- Debe ser ≥ ahora + **10 segundos** → `"Elige una hora futura para programar el mensaje."`
  La zona: `normalizeToUtcIso(value, account_timezone)` — si el cliente manda ISO
  con `Z` se usa tal cual; **manda siempre UTC ISO** (el /movil manda `.toISOString()`).
- Texto vacío → `"Escribe el mensaje que quieres programar."`
- Plantilla con provider≠whatsapp_api → `"Las plantillas programadas sólo se pueden enviar por WhatsApp API."`
- Plantilla sin id/nombre → `"Elige la plantilla que quieres programar."`; sin idioma → `"Falta el idioma de la plantilla."`
- Contacto inexistente → 404 `"Contacto no encontrado."`
- WhatsApp sin teléfono destino → `"Este contacto necesita teléfono para programar el mensaje."`
- WhatsApp sin `fromPhone` → `"Elige el WhatsApp del negocio que mandará el mensaje."`
- HighLevel canal whatsapp/sms sin teléfono → `"Este contacto necesita teléfono para programar por WhatsApp o SMS."`

`DELETE /api/whatsapp-api/messages/scheduled/:id` (cancelar; query o body
`contactId` opcional como guard). Solo cancela estados `scheduled|error`; si no
existe → 404 `"No se encontró un mensaje programado que se pueda eliminar."`.
Respuesta: la fila con `status:'cancelled'`.

Dispatcher (cron backend): reclama por lote de 20; un envío atorado >10 min en
`sending` pasa a `error` con mensaje `"El envío quedó interrumpido y no se pudo
confirmar si el mensaje llegó. Revísalo y reenvíalo manualmente si es necesario."`
Al enviar usa exactamente los mismos servicios de envío (texto/plantilla/HighLevel)
SIN marcar takeover del agente.

Validaciones frontend adicionales del sheet Programar (`PhoneChat.tsx:12197-12300`):
- Solo texto o plantilla (adjuntos/nota de voz → `"Por ahora sólo se pueden programar mensajes escritos."`).
- Meta social nativo no programable → `"La programación para Messenger e Instagram todavía no está disponible en Meta nativo. Puedes enviarlo al momento desde Ristak."`
- WhatsApp API sin QR y hora programada > lastInbound+24h → `"Para esa hora WhatsApp ya no dejará responder así. Usa una plantilla o QR."`
- Ventana cerrada sin QR → `"Para este chat necesitas mandar una plantilla antes de programar un mensaje libre."`
- El globo programado se pinta en el hilo con estado propio; editar reabre el sheet
  con `scheduleEditingMessageId` y guarda con el MISMO `id` + `externalId`.

---

## 3. Messenger / Instagram nativo (Meta Graph) — base `/api/whatsapp-api/meta/social`

Aplica cuando la integración Meta correspondiente está conectada y el contacto tiene
perfil social enlazado (`meta_social_contacts`). El backend usa Graph API con el
token de página / Instagram.

### 3.1 `POST /meta/social/messages/text`

```json
{
  "contactId": "rstk_...",              // requerido
  "platform": "messenger" | "instagram", // cualquier otro valor → 'messenger'
  "message": "texto",                    // requerido (alias "text")
  "externalId": "local-meta-...",
  "replyToMessageId": "...",             // opcional (id local)
  "replyToProviderMessageId": "..."      // opcional (mid de Meta)
}
```

Errores exactos (`metaSocialMessagingService.js:1919-2007`):
- 400 `"Falta el contacto"` / `"Falta el texto del mensaje"`.
- 409 `"Activa <Messenger|Instagram> en Configuración > Meta Ads > Redes sociales para responder por este canal."`
- 409 `"Agrega el Instagram API token en Configuración > Meta Ads > Redes sociales para responder por Instagram."` /
  `"Conecta Meta Ads para responder por Messenger."`
- 404 `"Este contacto no tiene <plataforma> enlazado."`
- 409 `"Falta seleccionar la cuenta de Instagram en Meta Ads."` / `"Falta seleccionar la página de Facebook en Meta Ads."`

Respuesta: `{ success, data: { id, remoteMessageId?, localMessageId?, platform, provider:'meta', data:{...} } }`.
Efecto: takeover del agente (§8.3). Texto y audio tienen rutas nativas de Meta;
otros adjuntos siguen bloqueados en Meta nativo y deben viajar por HighLevel
cuando esa integracion esta disponible. Ubicacion se degrada a texto+link.

### 3.2 `POST /meta/social/messages/audio`

```json
{
  "contactId": "rstk_...",
  "platform": "messenger" | "instagram",
  "audioDataUrl": "data:audio/mp4;base64,...",  // o audioUrl https
  "audioUrl": "https://...",
  "durationMs": 1800,
  "externalId": "local-meta-audio-...",
  "replyToMessageId": "...",
  "replyToProviderMessageId": "..."
}
```

Contrato: el backend guarda `audioDataUrl` en `media_assets` como copia publica
reproducible de Ristak, arma una URL HTTPS via `/media/assets/:id/file` y manda a
Meta Graph `message.attachment.type='audio'` con `payload.url`. Messenger usa Page
token y `messaging_type:'RESPONSE'`; Instagram usa el Instagram API token directo.
El mensaje local se persiste como `message_type='audio'`, `message_text=''`,
`media_url`, `media_mime_type` y `context.audio` para que `/chat`, `/movil` y la
app nativa puedan reproducirlo despues de recargar. Meta nativo no combina texto
y audio en el mismo envio desde el composer.

### 3.3 `POST /meta/social/messages/reaction`

```json
{
  "contactId": "...", "platform": "messenger|instagram",
  "emoji": "❤️",                     // SOLO corazón; otro valor → 400 "Meta solo permite reaccionar con corazón en este canal."
  "targetMessageId": "...",          // alias messageId
  "targetProviderMessageId": "...",  // alias providerMessageId
  "externalId": "..."
}
```

### 3.3 `POST /meta/social/comments/reply`

Responder comentarios de FB/IG (tarjeta de comentario en el chat):

```json
{
  "contactId": "...",
  "platform": "messenger" | "instagram",
  "message": "texto",                 // requerido si no hay attachment
  "replyType": "public" | "private",  // default 'private'
  "commentId": "...",                 // opcional: default = último comentario inbound del contacto
  "postId": "...",                    // opcional
  "externalId": "..."
}
```

Reglas: público en Instagram = SOLO texto (422 `"Instagram no permite adjuntos en
respuestas públicas; responde por privado (DM)."`); público en Facebook admite una
imagen (422 si otro tipo). 404 `"No se encontró el comentario al que responder."`.
UX /movil (`PhoneChat.tsx:12559-12654`): botón «Responder» sobre la tarjeta del
comentario → respuesta **pública** a ese `commentId`; si el contacto SOLO comentó
(sin DM), la barra normal manda respuesta **privada** (inicia el DM). Solo texto
(«Las respuestas a comentarios son solo de texto por ahora.», ubicación:
«Las respuestas a comentarios no aceptan ubicación por ahora.»). Toast de éxito:
«Respuesta enviada — Se envió por privado. / Se publicó en el comentario.»

### 3.4 `GET /meta/social/posts?platform=&search=&limit=&offset=&refresh=`

Lista publicaciones para selectores. Respuesta:
`{ success, posts: MetaSocialPost[], total, hasMore }` con
`MetaSocialPost = { id, platform:'facebook'|'instagram', type, message, imageUrl, permalink, postedAt }`.

---

## 4. HighLevel Conversations — `POST /api/highlevel/conversations/messages`

Canal de respaldo cuando: el contacto es de SMS, Meta no está nativa, o WhatsApp no
está conectado y HighLevel sí (`sendingThroughHighLevel`, `PhoneChat.tsx:6594-6599`).
También sigue siendo la vía para mandar **adjuntos no-audio** a
Messenger/Instagram (`sendAttachmentsThroughHighLevel`); las notas de voz ya
tienen ruta Meta nativa (`/meta/social/messages/audio`).

Body (`sendHighLevelConversationMessageCore`, `highlevelController.js:2645-2848`):

```json
{
  "contactId": "rstk_...",             // requerido (contacto local Ristak)
  "channel": "whatsapp_api" | "sms_qr" | "messenger" | "instagram" | "email" | "webchat",
  "message": "texto",                   // opcional si hay adjuntos
  "attachments": ["https://..."],       // URLs públicas ya hospedadas
  "attachmentDataUrls": [                // el backend las hospeda y las convierte a URL pública
    { "dataUrl": "data:...;base64,...", "filename": "foto.jpg", "mimeType": "image/jpeg", "kind": "image|video|audio|document" }
  ],
  "audioDataUrl": "data:audio/...;base64,...",  // nota de voz
  "audioUrl": "https://...",
  "durationMs": 4200,
  "fromNumber": "...", "toNumber": "...",
  "conversationProviderId": "...",      // opcional
  "externalId": "local-ghl-...",
  "subject": "...", "html": "..."       // solo channel=email
}
```

Aliases de canal aceptados (líneas 158-188): `whatsapp|whatsappapi|ghl_whatsapp →
whatsapp_api`; `sms|qr|mms|baileys|whatsapp_qr|ghl_sms → sms_qr`; `fb|facebook →
messenger`; `ig → instagram`; `correo|mail → email`; `web_chat|... → webchat`.

Errores: `"Ese canal no está permitido para enviar desde el chat."`, `"Escribe un
mensaje o graba una nota de voz antes de enviarlo."`, `"HighLevel solo acepta
archivos publicados como enlaces."`, 404 `"Contacto no encontrado."`, `"Este
contacto necesita teléfono para enviar por WhatsApp API o SMS/QR."`, email:
`"Este contacto necesita un correo válido para enviar por HighLevel."` / `"El correo
necesita un asunto."`. Status HTTP de fallo: `error.statusCode || 502`.

**Fallback WhatsApp→SMS de HighLevel** (líneas 622-678): si `channel='whatsapp_api'`
y no hay inbound WhatsApp en 24h (verifica local y luego el export de HighLevel),
el mensaje sale por `sms_qr`. La respuesta lo reporta:

```json
{
  "channel": "sms_qr", "requestedChannel": "whatsapp_api",
  "channelLabel": "SMS", "requestedChannelLabel": "WhatsApp API",
  "type": "SMS", "transport": "ghl_sms",
  "contactId": "...", "highLevelContactId": "...",
  "localMessageId": "...", "status": "pending",
  "fallbackApplied": true, "fallbackReason": "outside_24h" | "reply_window_unknown",
  "replyWindowOpen": false, "replyWindowSource": "none" | "highlevel_unavailable" | "local" | "highlevel",
  "lastInboundAt": null,
  "audio": { ... }, "localMedia": { ... }, "localAttachments": [ ... ]
}
```

Transportes persistidos: `ghl_whatsapp`, `ghl_sms`, `ghl_messenger`,
`ghl_instagram`, `ghl_email`, `ghl_webchat`. HighLevel NO soporta citar globos
(reply): /movil bloquea con «HighLevel no cita globos».

---

## 5. Correo — `POST /api/email/send` (SMTP propio)

```json
{
  "contactId": "rstk_...",     // o "to" con el correo directo
  "to": "cliente@x.com",
  "subject": "Asunto",          // requerido
  "text": "cuerpo texto",
  "html": "<p>cuerpo</p>",     // opcional; default: text → html
  "replyTo": "ventas@x.com",   // opcional
  "externalId": "...",
  "includeSignature": true      // default true
}
```

Errores: 409 `"El correo no está conectado. Configúralo en Configuración > Correos"`,
400 `"El contacto no tiene un correo válido"`, `"El correo necesita un asunto"`,
`"El correo necesita contenido"`, `"El correo de respuestas no es válido"`.
Persistencia en `email_messages` (status `sending`→`sent`) y evento realtime de chat
`channel:'email'`. **El composer de /movil NO envía correos**: la opción «Correo
electrónico» del selector de canal está deshabilitada con texto «Disponible desde la
vista completa de chats.» (toast: «Para enviar correos usa la vista completa de
chats.»). Paridad nativa: replicar el bloqueo (o decidir habilitarlo — ver §10).

No existe envío de SMS propio fuera de HighLevel (`sms_qr`). No hay endpoint SMS
dedicado.

---

## 6. Controles del agente conversacional en el envío

Base `/api/conversational-agent` (requiere módulo `ai_agent` y feature
`conversational_ai`; si el usuario no tiene acceso, la app no debe mostrar los
controles).

### 6.1 `GET /states/:contactId`

- `?includeAll=1` → `{ success, data: ConversationAgentState[] }` (todos los agentes
  del contacto). El backend colapsa las asignaciones activas/pausadas por
  `agentId`; iPhone vuelve a agruparlas como defensa ante caché o servidores
  anteriores y cuenta/muestra una sola asignación por agente.
- Sin query → estado primario. `?agentId=` opcional.

`ConversationAgentState` (frontend `conversationalAgentService.ts:324-351`):

```
id?, contactId, agentId (string|null), agentName?, status:
'active'|'paused'|'human'|'skipped'|'completed'|'discarded',
pausedUntilAt?, signal (string|null), signalReason, signalSummary, signalAt,
lastInboundMessageId, lastAnsweredInboundMessageId, lastReplyAt,
followUpBaseMessageId?, followUpSentCount?, followUpLastSentAt?,
activatedAt?, activationSource? ('manual'|'automatic'), activatedBy?,
updatedBy, agentEnabled?, agentHideAttendedNotifications?,
closingContext?, updatedAt, contactName?, contactPhone?
```

### 6.2 `POST /states/:contactId`

```json
{ "action": "pause" | "resume" | "take_over" | "skip" | "activate" | "clear_signal",
  "agentId": "...",            // opcional (multi-agente)
  "pausedUntilAt": "ISO..."    // opcional
}
```

Mapeo (`conversationalAgentController.js:246-252`): `pause→paused`, `resume→active`,
`take_over→human`, `skip→skipped`, `activate→active` (+limpia señal; valida agente
existente/habilitado/negocio configurado — 409
`CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY`). Acción inválida → 400
`"Acción inválida: <action>"`. Respuesta: `{ success, data: ConversationAgentState }`.

### 6.3 Confirmación "pausar y enviar" del composer

Si el agente está activo en el chat y el usuario manda un mensaje manual
(`PhoneChat.tsx:12544-12557` y 13300-13351):

1. El envío se detiene y se abre un diálogo de confirmación:
   - Mensaje: `"Si envías este mensaje, <NombreAgente> dejará de responder este chat.
     Elige si quieres pausarlo 24 horas o quitar este contacto del agente hasta que
     lo reactives."`
   - Botón primario: **«Pausar 24h y enviar»** (action `pause`).
   - Alternativa: omitir (action `skip`).
2. Al confirmar: `POST /states/:contactId {action}` para CADA `agentId` activo y
   único del contacto, toast «Agente pausado 24 horas» (`"<Agente> no responderá este chat
   durante 24 horas."`) o «Contacto omitido del agente», y LUEGO se ejecuta el envío
   pendiente con `skipAgentInterruptionConfirm`.
3. Si el POST falla: toast «No se pudo pausar el agente — El mensaje no se envió.
   Intenta otra vez.» y NO se envía.

Además, **todo envío manual exitoso** dispara server-side
`markHumanTakeoverIfActive(contactId)` (status → `human`) sin que el cliente haga
nada (`whatsappApiController.js:61-70`); no pisa estados `paused/skipped` ya puestos
por la UI.

### 6.4 Sheet «Más acciones» → «Acciones del agente conversacional»

(`PhoneChat.tsx:18806-18930`.) Banner de estado con textos exactos:

```
active:    "El agente atiende este chat."
paused:    "Agente pausado por 24hrs en este chat."
human:     "Conversación tomada por un humano."
skipped:   "Agente omitido en este chat."
completed: "El agente ya cumplió el objetivo aquí."
discarded: "Conversación descartada por el agente."
multi:     "N agentes asignados"
```

Acciones por agente único (no por fila/canal; una acción sin `channel` se aplica
server-side a todas las filas de ese `agentId`) con descripciones exactas:
- `Tomar <Agente>` — «Solo este agente deja de responder y tú sigues el chat.» → `take_over`.
- `Pausar <Agente>` — «Detiene solo este agente durante 24 horas.» → `pause`.
  Toast: `"<Agente> quedó pausado por 24hrs en este chat."`
- `Omitir <Agente>` — «Solo este agente no volverá a tomar este chat.» → `skip`.
  Toast: `"<Agente> quedó omitido en este chat."`
- Si no está activo: `Reactivar <Agente>` → `activate`. Toast: `"<Agente> volvió a atender este chat."`

El sheet «Más acciones» normal además lista: Agendar cita, Registrar pagos
(«Elegir pago único, plan o suscripción.» / «Guardar un pago único.»), Agregar
etiqueta («Clasificar este chat con una etiqueta.»), Silenciar/Quitar silencio.

---

## 7. UX completa del composer /movil (paridad nativa)

### 7.1 Elementos del composer

De izquierda a derecha (`PhoneChat.tsx`, render del composer ~16150+):

1. **Botón de canal** (`composerChannelButton`): glifo del canal activo (WhatsApp =
   FaWhatsapp fino, sin disco), `aria-label "Canal de envío: <label>"`. Abre dropdown
   `Elegir canal de envío` con opciones:
   - Un item por CADA número de WhatsApp conectado:
     `WhatsApp · <etiqueta|Número N>` + descripción = número/verified_name.
     (Si no hay números: item único `WhatsApp` — «Mensaje por WhatsApp conectado.»)
   - `Correo electrónico` — «Disponible desde la vista completa de chats.» (siempre
     deshabilitado en móvil; solo visible con acceso email).
   - `Messenger` — «Responde por Facebook Messenger.»
   - `Instagram DM` — «Responde por Instagram Direct.»
   Razones de deshabilitado exactas en `getComposerMessageChannelDisabledReason`
   (16084-16110): «Abre un chat para elegir canal.», «Este contacto no tiene
   teléfono guardado.», «Ese número de WhatsApp ya no está disponible.», «Ese
   WhatsApp todavía no tiene número detectado.», «Conecta WhatsApp API o QR para
   responder.», «Activa una integración con SMS para usar este canal.», «Activa
   Messenger/Instagram en Configuración > Meta Ads para responder desde Ristak.»
   Elegir un `whatsapp:<phoneId>` guarda
   `preferred_whatsapp_phone_number_id` PARA ESE CONTACTO mediante
   `PATCH /api/contacts/:id`; no cambia el default global. Desktop, `/movil`,
   React Native Android e iOS comparten esa preferencia y restauran el número
   anterior si el guardado falla. En iOS este botón también vive antes de `+` en
   el panel inferior; la ficha del contacto abre el mismo selector persistente.
2. **Botón `+`** (`composerPlus`) — abre el sheet de adjuntos anclado
   (`attachmentSheetAnchor` con posición left/bottom del botón).
3. **Campo de texto** multilinea (contentEditable en web; en nativo: TextField
   multilinea), placeholder, autocorrección y capitalización de oraciones. Enter
   envía (Shift+Enter = salto de línea) en teclado físico; en móvil el envío es por
   botón.
4. **Cámara** (solo móvil angosto) — `handlePickPhoto('camera')`.
5. **Mic / Enviar**: si no hay contenido muestra micrófono (mantener presionado para
   grabar); con contenido muestra flecha de enviar.

Barra de sugerencia IA encima del composer (si `aiReplySuggestionsEnabled`):
«✨ El agente puede ayudarte a contestar» + botón **«Sugerir»** →
`handleSuggestReply` (13689-13723): construye prompt con los últimos 10 mensajes
(`Negocio:`/`Cliente:`/`Sistema:`) y llama `POST /api/ai-agent/chat`
(`aiAgentService.sendMessage`); la respuesta se coloca EN el campo de texto (no se
envía sola). Toasts: «Sugerencia lista — Revisa el texto antes de enviarlo.» /
«No se pudo sugerir». Si OpenAI no está configurado: «OpenAI no está listo».

### 7.2 Sheet de adjuntos (`+`)

Grid de acciones (`renderAttachmentsSheet`, 18383-18411):

- **Plantillas** → sheet de plantillas (enviar o programar según `templatePickIntent`).
- **Fotos** → galería (`handlePickPhoto('photos')`, acepta imagen y video).
- **Cámara** (solo en teléfono, no iPad/wide) → cámara nativa.
- **Documentos** → picker de archivos (`handlePickDocument`).
- **Ubicación** → comparte ubicación actual (§2.3).
- **CLABE** → sheet de cuentas bancarias; elegir una manda un TEXTO con los datos
  vía `handleSendMessage('api', { textOverride, preserveComposer: true })`.

(En el chat del Asistente Personal AI el grid se reduce a Fotos/Cámara/Documentos.)
Los adjuntos elegidos quedan como **borradores** (chips de preview encima del
composer) y se envían junto con el texto al tocar enviar; el texto viaja como
`caption` del PRIMER adjunto. Límites frontend: media 16 MB (`MAX_MEDIA_MESSAGE_BYTES`),
documentos 20 MB (`MAX_DOCUMENT_ATTACHMENT_BYTES`); imágenes >16 MB se degradan a
documento. Nota: el sheet de `Más acciones` (long-press o menú) contiene
Agendar cita / Registrar pagos / **Programar mensaje** / Etiqueta / Silenciar +
acciones del agente (§6.4); el reloj para programar también vive como icono en el
composer/wide (`aria-label "Programar mensaje"` / `"Programar plantilla"`).

### 7.3 Grabación de nota de voz (existe en /movil)

(`PhoneChat.tsx:9405-9520`.) Mantener el mic (pointerdown) inicia; requiere permiso
de micrófono. Reglas:

- No se puede grabar si hay texto o adjuntos pendientes: «Manda primero lo que ya
  tienes».
- Sin contacto con teléfono: «Falta el teléfono».
- MIME preferidos en orden: `audio/mp4`, `audio/webm;codecs=opus`, `audio/webm`
  (nativo iOS: grabar AAC/m4a `audio/mp4` es lo ideal — el backend lo transcodifica
  a OGG/Opus).
- Duración mínima 600 ms («Audio muy corto — Graba un poquito más para poder
  enviarlo.»); máximo 16 MB («Audio muy pesado»).
- Al soltar se crea `voiceDraft { id, name: nota-voz-<ts>.<ext>, type, dataUrl,
  size, durationMs }` con panel de preview (play/pausa con barras de onda, borrar,
  botón enviar). Soltar deslizando a enviar manda directo (`voiceSendAfterStopRef`).
- Envío: `POST /messages/audio` con `audioDataUrl`, `durationMs`, `voice: true`,
  `externalId: <optimisticId>-audio`, `transport` resuelto, `messageOrigin:'manual_chat'`.
- En canal HighLevel la voz viaja como `audioDataUrl` del endpoint HighLevel; en
  Messenger/Instagram nativo viaja por `/meta/social/messages/audio`.

### 7.4 Flujo de cámara

`handlePickPhoto('camera')` abre la cámara (input capture / plugin nativo). La
foto/video tomado entra como borrador de adjunto. Desde la BANDEJA también existe el
flujo «tomar foto → elegir destinatarios» (camera share) que usa el número
`cameraShareBusinessPhone` y transporte `cameraShareTransport` (QR si API no
disponible, `PhoneChat.tsx:6546-6558`).

### 7.5 Responder (reply/quote)

Swipe o menú del globo → `setReplyingToMessageId`. Barra de "respondiendo a" encima
del composer con botón cancelar. Reglas:
- Solo TEXTO puede citar: con voz/adjuntos/ubicación → toast «Respuesta solo con
  texto — Para contestar un globo específico, manda texto. Para archivos o
  ubicación, cancela la respuesta primero.»
- WhatsApp: manda `replyToMessageId` (id local) y/o `replyToProviderMessageId`
  (wamid) en `/messages/text`.
- Meta social: mismos campos en `/meta/social/messages/text`.
- HighLevel: NO soporta (toast «HighLevel no cita globos»).

### 7.6 Estados del mensaje optimista y reintento

Al enviar se pinta el globo con status `'enviando'` (o `'enviando por QR'`);
al responder el backend se actualiza a `result.status || 'sent'` + `transport` +
`routingReason`. En error: status `'error'` + `errorReason` (el globo muestra
indicador rojo; tocarlo → toast con `errorReason` o `"WhatsApp no entregó la razón
exacta. Intenta reenviar o revisa el estado de la conexión."`,
`handleShowMessageError` 11945-11948). El texto/adjuntos se RESTAURAN al composer
para reintentar manualmente (no hay botón "Reintentar" dedicado; reintento = volver
a enviar). Tras éxito siempre se recargan conversación y bandeja
(`loadConversation` + `loadChats` silenciosos).

Ids optimistas usados como `externalId` (útiles para idempotencia/reconciliación):
`local-<ts>`, `local-<ts>-audio`, `local-<ts>-attachment-<i>`, `template-<ts>`,
`local-meta-<ts>`, `local-ghl-<ts>`, `local-comment-<ts>`, `local-reaction-<ts>`,
`native-scheduled-<ts>` (RN).

### 7.7 Errores/validaciones previas al envío (copys exactos)

- «Falta el teléfono — Guarda el número del contacto antes de escribir por WhatsApp.»
- «Falta el WhatsApp del negocio — Configura el número conectado para responder este chat.»
- Número emisor no disponible → abre sheet "problema del número" con alternativas
  (otros números disponibles) en vez de fallar.
- API caída pero QR listo sin riesgo aceptado → sheet de aceptar riesgo QR
  (`qrRiskPhone`) antes de enviar.
- «Escribe o adjunta algo — Manda texto, una nota de voz o un archivo desde este chat.» (HighLevel)
- «Escribe algo — Manda un mensaje escrito desde este chat.» (Meta social)
- Toast global de fallo: «No se envió el mensaje» + mensaje del backend.

---

## 8. Reglas de negocio transversales

1. **Idempotencia**: `externalId` se propaga al proveedor y a la fila local; reusar
   el mismo `externalId` en un reintento evita duplicados en la persistencia local.
2. **Normalización de teléfonos**: server-side (`normalizePhoneForStorage`); la app
   puede mandar el teléfono como esté guardado en el contacto.
3. **Persistencia**: todo saliente (incluso fallido sin fallback) se guarda en
   `whatsapp_api_messages` / `meta_social_messages` / `email_messages` / espejo
   HighLevel; el hilo del chat se refresca vía GET de conversación + eventos
   realtime (`/api/chat-events`, módulo aparte).
4. **Takeover humano**: implícito en todo envío manual (§6.3); scheduled dispatch NO
   lo dispara.
5. **Selección de ruta por chat**: el override de canal es local, pero elegir un
   número de WhatsApp desde el composer o desde `Contactando desde` es POR CONTACTO
   (`preferred_whatsapp_phone_number_id` persistido vía
   `PATCH /api/contacts/:id` con `{ preferredWhatsAppPhoneNumberId, routingSource:
   'manual', routingReason }`).
6. **Permisos**: los envíos WhatsApp requieren solo sesión + feature de licencia
   `whatsapp`; email feature `email`; agente conversacional módulo `ai_agent` (los
   usuarios restringidos por `requireModuleAccess` no ven esos controles).
7. **Zona horaria**: `scheduledAt` se guarda en UTC; la UI de programar muestra la
   fecha en `account_timezone`, y el mínimo es +10 s.

---

## 9. Tabla resumen de endpoints

| # | Método | Path | Uso |
|---|--------|------|-----|
| 1 | POST | `/api/whatsapp-api/messages/text` | Texto WhatsApp (api/qr/meta_direct) |
| 2 | POST | `/api/whatsapp-api/messages/reaction` | Reacción WhatsApp |
| 3 | POST | `/api/whatsapp-api/messages/location` | Ubicación WhatsApp |
| 4 | POST | `/api/whatsapp-api/messages/image` | Imagen (dataURL o URL https) |
| 5 | POST | `/api/whatsapp-api/messages/document` | Documento |
| 6 | POST | `/api/whatsapp-api/messages/video` | Video |
| 7 | POST | `/api/whatsapp-api/messages/audio` | Audio / nota de voz |
| 8 | POST | `/api/whatsapp-api/messages/interactive` | Botones (no en composer móvil) |
| 9 | GET | `/api/whatsapp-api/templates` | Listar plantillas |
| 10 | POST | `/api/whatsapp-api/templates/send` | Enviar plantilla |
| 11 | GET | `/api/whatsapp-api/messages/scheduled?contactId=` | Listar programados |
| 12 | POST | `/api/whatsapp-api/messages/scheduled` | Crear/editar programado |
| 13 | DELETE | `/api/whatsapp-api/messages/scheduled/:id` | Cancelar programado |
| 14 | POST | `/api/whatsapp-api/meta/social/messages/text` | DM Messenger/IG |
| 15 | POST | `/api/whatsapp-api/meta/social/messages/audio` | Audio DM Messenger/IG |
| 16 | POST | `/api/whatsapp-api/meta/social/messages/reaction` | Reacción ❤️ Messenger/IG |
| 17 | POST | `/api/whatsapp-api/meta/social/comments/reply` | Responder comentario FB/IG |
| 18 | GET | `/api/whatsapp-api/meta/social/posts` | Publicaciones FB/IG |
| 19 | POST | `/api/highlevel/conversations/messages` | Envío por HighLevel (WA/SMS/FB/IG/Email/Webchat) |
| 20 | POST | `/api/email/send` | Correo SMTP propio |
| 21 | GET | `/api/conversational-agent/states/:contactId?includeAll=1` | Estados del agente |
| 22 | POST | `/api/conversational-agent/states/:contactId` | pause/resume/take_over/skip/activate/clear_signal |
| 23 | GET/PUT | `/api/whatsapp-api/qr/drip-settings` | Config anti-bloqueo QR |
| 24 | POST | `/api/whatsapp-api/meta/messages/test` | Prueba Meta directo (`{to,text}`, solo settings) |

---

## 10. Gaps / riesgos para iOS nativo (OPEN QUESTIONS incluidas)

1. **Media como base64 en JSON**: no hay multipart ni upload por streaming. Videos
   de hasta 25 MB viajan como data URL (~33% overhead) en un solo POST JSON. En
   iOS: comprimir/transcodificar ANTES (HEVC→H.264 MP4, HEIC→JPEG) y subir con
   timeout largo; riesgo de memoria si se arma el data URL en RAM sin streaming.
2. **HEIC/HEIF y H.265 no están soportados** por los parsers backend (solo
   JPG/PNG/WebP; MP4/MOV/WebM/3GP). La app DEBE convertir HEIC→JPEG y grabar video
   compatible.
3. **Quitar una reacción**: el backend exige `emoji` no vacío; no hay endpoint para
   retirar reacciones. OPEN QUESTION: ¿se implementará emoji vacío tipo WhatsApp?
   Paridad /movil: no ofrecer "quitar", solo cambiar.
4. **Progreso de subida**: no hay reporting de progreso por chunk; la UI /movil solo
   muestra spinner "enviando". Para archivos grandes considerar `URLSession`
   uploadTask con progreso local.
5. **Ventana 24h en cliente**: el preflight nativo depende de calcular
   `apiReplyWindowOpen` con los mensajes cargados (paginados). Si la página cargada
   no incluye el último inbound, el cliente puede equivocarse; el backend corrige
   (fallback/plantilla), pero la UX debe manejar el error 400 con la razón textual.
6. **Programados**: no se pueden programar adjuntos/voz/ubicación (solo texto y
   plantillas). No hay endpoint PATCH: editar = POST con el mismo `id`.
7. **Email desde el chat móvil está bloqueado** («vista completa de chats»). OPEN
   QUESTION: ¿el iPad nativo (layout wide) debe habilitar el correo como el desktop?
8. **Interactive messages** (`/messages/interactive`): sin UI en /movil; decidir si
   la app nativa lo expone (probablemente no, paridad).
9. **Reenviar mensaje**: el menú lo muestra pero es placeholder («Reenviar aún no
   está activo»). No implementar envío real.
10. **`voice` default sutil**: en `/messages/audio`, si se omite `voice`, es nota de
    voz solo cuando mandas `audioDataUrl` (no con `audioUrl`). Mandar `voice: true`
    explícito para notas de voz.
11. **Multi-agente**: la confirmación pausar-y-enviar debe agrupar estados activos
    por `agentId` y hacer un POST por agente único, como /movil. Repetir el mismo
    `agentId` por WhatsApp/SMS no representa dos agentes.
12. **Errores heterogéneos**: algunos endpoints devuelven objetos de fallback QR
    combinados; el cliente debe leer `transport`, `fallback`, `routingReason` para
    el subtítulo del globo («se mandó como texto por el respaldo QR», etc.).
13. **`filterUnsubscribed`/`filterBlocked`**: el backend los fija en `true` para
    media/plantillas — un destinatario dado de baja puede resultar en "aceptado pero
    no entregado". El status real llega después por webhook/refresh de conversación.
14. **Rate limit QR (drip)**: si la app manda envíos automatizados (p. ej. reglas
    futuras), debe omitir `messageOrigin:'manual_chat'` para respetar el drip.
15. **`durationMs` de audio**: el backend no lo calcula; si el cliente no lo manda,
    el player del receptor local no muestra duración. Medirla en la grabación.
16. **Comentarios**: la respuesta pública vs privada depende del estado del hilo
    (contacto solo-comentario vs DM existente); la app nativa necesita el flag
    `isComment`/`commentId` de los mensajes del módulo de conversación (doc 04).
