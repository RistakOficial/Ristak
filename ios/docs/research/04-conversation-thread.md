# 04 — Conversation Thread (timeline de mensajes)

Spec exhaustiva del hilo de conversación (timeline de una conversación abierta) para la app
nativa SwiftUI. Fuentes:

- Backend: `backend/src/controllers/contactsController.js` (`getContactJourney`, línea 4913),
  `backend/src/controllers/whatsappApiController.js`, `backend/src/services/scheduledChatMessagesService.js`,
  `backend/src/routes/contacts.routes.js` (línea 83), `backend/src/routes/whatsappApi.routes.js`.
- RN (app Expo actual): `mobile/src/App.tsx` (pantalla de conversación ~línea 18600–21600),
  `mobile/src/format.ts` (`buildMessagesFromJourney` línea 942), `mobile/src/api.ts`, `mobile/src/types.ts`.
- Web móvil `/movil`: `frontend/src/pages/PhoneChat/PhoneChat.tsx` (parser `getJourneyMessage` línea 3590,
  render `renderMessages` línea 15641).
- Contrato documentado: `docs/MOBILE_APP.md` (líneas 918–1079).

Todo lo aquí descrito fue verificado contra el código. Lo ambiguo está marcado como **OPEN QUESTION**.

---

## 1. Cómo se carga el historial de una conversación

### 1.1 Endpoint principal: journey del contacto

```
GET /api/contacts/:id/journey
```

- Ruta: `backend/src/routes/contacts.routes.js:83` → `getContactJourney`
  (`contactsController.js:4913`). También expuesto en API externa:
  `GET /api/external/contacts/:id/journey` (`external.routes.js:1348`).
- Auth: sesión normal de la app (mismas cookies/token que el resto de `/api`).
- Si el contacto está oculto por filtros de "hidden contacts" → **404** como si no existiera.

**Query params** (todos opcionales; parsing en `contactsController.js:377–446`):

| Param | Alias aceptados | Tipo | Default | Semántica |
|---|---|---|---|---|
| `includeBusinessMessages` | — | string bool (`'true'` literal, case-insens.) | `false` | Si `true`, incluye mensajes salientes del negocio. Si `false` el journey solo trae acciones del contacto (los outbound se filtran). |
| `refreshExternalStatuses` | — | string bool; solo `'false'` lo apaga | `true` | Si `true`, antes de armar el journey el backend refresca contra HighLevel el `status` de los últimos mensajes salientes con transporte `ghl_*` (`refreshHighLevelConversationMessageStatuses`, línea 1428). Los clientes móviles mandan **siempre `false`** para velocidad. |
| `chatMessagesOnly` | `chatOnly`, `messagesOnly` | truthy (`1/true/yes/si/sí`) | `false` | Si `true`, la respuesta contiene SOLO eventos de mensajes (`whatsapp_message`, `meta_message`, `email_message`); omite sesiones web, contacto creado, citas, pagos, tarjetas de confirmación. Ordena asc y aplica `slice(-limit)` final. |
| `messageLimit` | `messagesLimit`, `conversationMessageLimit` | int 1..500 (`JOURNEY_MESSAGE_MAX_LIMIT = 500`) | sin límite | Limita cada fuente de mensajes (ver 1.3). |
| `beforeMessageDate` | `messageBeforeDate`, `beforeMessage` | timestamp parseable | — | Paginación hacia atrás: solo mensajes con fecha **estrictamente `<`** este valor. |

**Respuesta 200**:

```json
{ "success": true, "data": [ { "type": "...", "date": "...", "data": { ... } }, ... ] }
```

- `data` es un array de eventos ordenado **ascendente** por fecha.
- Cada evento: `{ type: string, date: string, data: object }`. `date` es el timestamp del
  evento (ISO o `YYYY-MM-DD HH:MM:SS`; parsear con tolerancia).

**Errores**:

- `404 { "success": false, "error": "Contacto no encontrado" }`
- `500 { "success": false, "error": "Error obteniendo journey del contacto" }`

### 1.2 Cómo lo llama cada cliente

RN (`mobile/src/api.ts:395–414`):

```ts
// Hilo de chat (página de mensajes):
getConversation(contactId, limit = 50, beforeMessageDate?) →
  GET /contacts/:id/journey?includeBusinessMessages=true&refreshExternalStatuses=false
      &chatMessagesOnly=true&messageLimit=<limit>[&beforeMessageDate=<iso>]

// Journey completo (markers de actividad + Info del contacto):
getContactJourney(contactId) →
  GET /contacts/:id/journey?includeBusinessMessages=true&refreshExternalStatuses=false
```

- RN usa `CHAT_CONVERSATION_MESSAGE_LIMIT = 100` (`App.tsx:734`).
- `/movil` usa `CHAT_CONVERSATION_MESSAGE_LIMIT = 50` (`PhoneChat.tsx:213`) con los mismos params.
- En `loadConversation` RN pide **en paralelo** (App.tsx:18809–18812):
  1. `getConversation(contact.id, 100)` → mensajes del hilo.
  2. `getContactJourney(contact.id)` → journey completo (para activity markers de pagos/citas y del panel Info).
  3. `getScheduledMessages(contact.id)` → mensajes programados pendientes.
- Tras cargar, marca leído: `POST /contacts/chats/:id/read` body `{}` (api.ts:416) y pone
  `unreadCount = 0` local.
- `/movil` además pide `conversationalAgentService.listCompletionEvents({ contactId, limit: 20 })`
  para las tarjetas de "completions" del agente (PhoneChat.tsx:7773) — RN no las pide en el hilo
  (usa `completionNotice` local, ver 7.4).

### 1.3 Paginación de mensajes antiguos

Semántica backend (importante para reimplementar):

- `messageLimit` se aplica con `LIMIT` **por fuente**: `whatsapp_attribution`,
  `whatsapp_api_messages`, `meta_social_messages`, `email_messages` — cada una devuelve hasta N
  filas más recientes (subquery DESC + reorder ASC). Con `chatMessagesOnly=true` el resultado
  combinado se ordena asc y se recorta con `journey.slice(-limit)` → la página final tiene
  **como máximo `messageLimit` eventos**, los más recientes anteriores a `beforeMessageDate`.
- `beforeMessageDate` filtra con `< valor` sobre `COALESCE(message_timestamp, created_at)`
  (para `whatsapp_attribution` usa `created_at`).

Cliente (RN, App.tsx:18860–18888; `/movil` PhoneChat.tsx:5706–5780):

1. Página inicial: `getConversation(id, LIMIT)`. Si el número de mensajes parseados `>= LIMIT`
   ⇒ `hasOlderMessages = true`; si no, se marca historial agotado para ese contacto.
2. Trigger de "cargar más": al hacer scroll cerca del tope. RN: `contentOffset.y <= 96`
   (`CHAT_CONVERSATION_OLDER_SCROLL_OFFSET = 96`, App.tsx:735). `/movil`: scroll top del pane.
3. `beforeMessageDate` = fecha del mensaje **más viejo ya cargado**, excluyendo mensajes
   programados y `direction === 'system'` (RN `getOldestNativeConversationMessageDate`,
   App.tsx:22641; `/movil` usa el journey crudo, PhoneChat.tsx:3127).
4. Respuesta: se parsea igual y se **mergea por id** con lo existente (prepend);
   si la página trae `< LIMIT` mensajes ⇒ historial agotado (no volver a pedir).
5. En error de red al paginar, RN deja `hasOlderMessages = true` para reintentar.
6. Mantener la posición de scroll al prepender (RN usa
   `maintainVisibleContentPosition={{ minIndexForVisible: 0 }}`; `/movil` restaura
   `scrollTop` manualmente). Loader: spinner pequeño como header de la lista
   (RN `olderMessagesLoader`); `/movil` muestra pill "Cargando mensajes anteriores".

### 1.4 Polling / refresco en vivo

- RN (App.tsx:18901–18915): `setInterval` cada **7000 ms** (`CONVERSATION_REFRESH_INTERVAL_MS = 7000`)
  llama `loadConversation(silent=true, background=true)`; también al volver la app a foreground
  (`AppState === 'active'`) y al recibir el evento interno `ristak:chat-refresh` (disparado por push).
  Un poll de fondo **nunca** muestra spinner ni Alert; si no hay cambios debe ser no-op de render
  (comparación por referencia/JSON, App.tsx:18817–18840).
- `/movil` (PhoneChat.tsx:9006–9021): reconciliación del hilo abierto cada **7 s** + al
  focus/visibilitychange; interval extra de 12 s solo si hay salientes con acuse pendiente.
- `/movil` además cachea la conversación por día del negocio en localStorage
  (`readPhoneDailyCache`/`writePhoneDailyCache`, PhoneChat.tsx:7729–7795, máx. 360k chars) y
  muestra pill "Mostrando lo guardado, actualizando conversación" mientras refresca.
  RN no cachea el hilo en disco. **Para iOS nativo: cache opcional; el patrón mínimo es el de RN.**
- Reconciliación de mensajes optimistas (RN, App.tsx:22675–22712): un envío optimista con id
  `local-*`/`template-*`/`clabe-*`/`location-*` se elimina cuando llega la copia del servidor con
  mismo texto (o ambos con attachment) en ventana de ±4 min (`NATIVE_OPTIMISTIC_RECONCILE_WINDOW_MS`).

---

## 2. Tipos de evento del journey (contrato exacto del backend)

`event.type` y su `event.data`. Campos exactos como los emite `contactsController.js`.

### 2.1 `whatsapp_message` — fuente A: `whatsapp_attribution` (líneas 5121–5170)

Mensajes históricos de atribución (entrantes; texto plano). `date = created_at`.

```jsonc
data: {
  "source": "WhatsApp",
  "phone": string,
  "message_text": string,
  "referral_source_url": string|null,
  "referral_source_type": string|null,
  "referral_source_id": string|null,       // o ad_id_thru_message
  "referral_headline": string|null,
  "referral_body": string|null,
  "referral_image_url": string|null,
  "referral_video_url": string|null,
  "referral_thumbnail_url": string|null,
  "referral_ctwa_clid": string|null,
  "attribution_source": "whatsapp_attribution",
  "attribution_record_id": number,          // INTEGER — id estable para el mensaje
  "ad_id_thru_message": string|null,
  "is_ad_attributed": boolean,
  "ad_platform": string|null                // solo si is_ad_attributed
}
```

Nota: NO trae `direction`, `status`, ni media. El cliente lo trata como inbound
(default de `normalizeDirection`).

### 2.2 `whatsapp_message` — fuente B: `whatsapp_api_messages` (líneas 5172–5300)

Mensajes reales del chat WhatsApp (API YCloud/Cloud y QR/Baileys). `date = message_timestamp || created_at`.

```jsonc
data: {
  "source": "WhatsApp",
  "phone": string, "from_phone": string|null, "to_phone": string|null,
  "business_phone": string|null,            // número del negocio
  "business_phone_number_id": string|null,
  "transport": string,                      // 'api' (default) | 'qr' | 'ghl_whatsapp' | 'ghl_sms' | ...
  "routing_reason": string|null,            // p.ej. "Capturado desde la sesión de WhatsApp Web."
  "message_text": string|null,
  "message_type": string|null,              // 'text'|'image'|'video'|'audio'|'document'|'sticker'|'location'|'reaction'|...
  // media (columnas de la fila, con fallback a raw_payload_json — ver getWhatsAppMediaFromPayload:1499):
  "media_url": string,                      // '' si no hay
  "media_id": string,
  "media_mime_type": string,
  "media_filename": string,
  "media_duration_ms": number|null,
  // ubicación (solo si el payload trae location — getWhatsAppLocationFromPayload:1602):
  "location_latitude": number,              // ausentes si no hay location
  "location_longitude": number,
  "location_name": string,
  "location_address": string,
  "location_url": string,                   // fallback: https://www.google.com/maps?q=lat,lng
  // atribución CTWA:
  "referral_source_url": string|null, "referral_source_type": string|null,
  "referral_ctwa_clid": string|null, "referral_source_id": string|null,
  "referral_headline": string|null, "referral_body": string|null,
  "referral_source_app": string|null, "referral_entry_point": string|null,
  "referral_conversion_data": string|null, "referral_ctwa_payload": string|null,
  "attribution_source": "whatsapp_api",
  "attribution_record_id": string|null,
  // identidad del mensaje:
  "whatsapp_api_message_id": string,        // id interno — PRIMER candidato de id del cliente
  "whatsapp_message_id": string|null,       // wamid || ycloud_message_id
  "provider_message_id": string|null,       // wamid || ycloud_message_id (para replies/reactions)
  // reply / reaction:
  "reply_to_provider_message_id": string,   // '' si no aplica; wamid citado (context.id/message_id/quotedMessageId/…)
  "reaction_emoji": string,                 // solo cuando message_type === 'reaction'
  "reaction_target_provider_message_id": string, // wamid del mensaje reaccionado (solo reaction)
  // estado:
  "direction": string,                      // 'inbound' default; salientes: ver lista abajo
  "status": string|null,                    // 'pending'|'sent'|'delivered'|'read'|'error'|'failed'|... (crudo del proveedor)
  "error_code": string|null,
  "error_message": string|null,
  "is_ad_attributed": boolean,
  "ad_platform": string|null,
  // enriquecido si hay atribución meta (enrichWhatsAppJourneyEventsWithMetaAds):
  "attribution_ad_id"?, "attribution_ad_name"?, "campaign_id"?, "campaign_name"?, "adset_id"?, "adset_name"?
}
```

Direcciones consideradas **outbound** (`OUTBOUND_JOURNEY_MESSAGE_DIRECTIONS`, línea 672):
`outbound, outgoing, sent, business, api, app, business_echo, smb_echo, echo, message_echo`.
Todo lo demás es inbound.

El match de contacto incluye teléfonos alternos del contacto y (para Meta) contactos sociales
enlazados por `(platform, meta_user_id)` — el backend ya junta DM + comentarios de la misma
persona aunque vivan como dos contactos (líneas 4967–4998).

### 2.3 `meta_message` — `meta_social_messages` (líneas 5305–5417)

DMs y comentarios de Facebook/Instagram. `date = message_timestamp || created_at`.

```jsonc
data: {
  "source": string,                 // 'Instagram DM' | 'Instagram' (comentario) | 'Messenger' | 'Facebook' (comentario)
  "social_platform": string,        // 'instagram' | 'facebook'
  "sender_id": string, "recipient_id": string,
  "page_id": string|null, "instagram_account_id": string|null,
  "profile_name": string|null, "username": string|null,
  "message_text": string,           // con fallback para comentarios (ver abajo)
  "message_type": string,           // 'text'|'image'|...|'reaction'|'comment'|'comment_reply_public'|'comment_reply_private'|'postback'
  "media_url": string|null, "media_mime_type": string|null,
  "postback_payload": string|null,
  "referral_json": string|null,
  "attribution_source": "meta_social",
  "meta_social_message_id": string, // id interno — candidato de id
  "meta_message_id": string|null,   // mid de Meta
  "provider_message_id": string|null, // = meta_message_id
  "reply_to_provider_message_id": string,       // mid citado (reply_to.mid)
  "reaction_emoji": string,                     // = message_text cuando type 'reaction'
  "reaction_target_provider_message_id": string, // mid objetivo (context.target_message_id / payload.message_id / reaction.mid)
  "direction": string,              // mismo set outbound que WhatsApp
  "status": string|null,
  "transport": string,              // 'instagram' | 'messenger'
  // contexto de comentario:
  "comment_id": string|null, "post_id": string|null, "media_id": string|null,
  "parent_comment_id": string|null, "permalink": string|null,
  "meta_user_id": string|null,
  // publicación comentada:
  "post_message": string|null,      // texto del post; 'Publicación eliminada' si post_type='deleted'
  "post_image_url": string|null,
  "post_permalink": string|null,
  "post_type": string|null,         // 'deleted' ⇒ post borrado
  "post_deleted": 0|1
}
```

Fallbacks de texto de comentario (backend, líneas 381–409; replicados en clientes):

- Status `removed/deleted/delete/remove/hide/hidden` o post borrado → `"Comentario eliminado"`.
- `comment_reply_public` sin texto → `"Respuesta pública al comentario"`.
- `comment_reply_private` sin texto → `"Respuesta por privado al comentario"`.
- `comment` sin texto → `"Comentario sin texto"`.

### 2.4 `email_message` — `email_messages` (líneas 5419–5484)

`date = message_timestamp || created_at`.

```jsonc
data: {
  "source": "Correo",
  "email_message_id": string,
  "smtp_message_id": string|null,
  "message_type": "email",
  "message_text": string,     // cuerpo plano ('' si solo hay HTML)
  "html_body": string,        // '' si no hay
  "subject": string,
  "to_email": string, "from_email": string, "reply_to": string,
  "direction": string,        // default 'outbound'
  "status": string|null,
  "error_message": string|null,
  "transport": string         // 'ghl_email' si provider highlevel, si no 'email'
}
```

### 2.5 `appointment_confirmation` (líneas 5595–5624)

Tarjeta de sistema "cita confirmada" generada por la ventana de confirmación del agente
(`appointment_confirmation_windows` con `status='done'`, `result='confirmed'`,
`confirmation_success_action='chat_card'`). **Solo aparece en el journey completo**, NO con
`chatMessagesOnly=true`.

```jsonc
data: {
  "id": string, "appointment_id": string,
  "title": string|null,
  "status": "confirmed",
  "start_time": string|null, "end_time": string|null,
  "result_detail": string|null
}
```

### 2.6 Tipos SOLO del journey completo (para activity markers / Info del contacto)

Con `chatMessagesOnly=false` además llegan (en orden cronológico mezclado):

| type | data relevante | Uso en el hilo |
|---|---|---|
| `page_visit` | sesión web resumida (url, utm, video adjunto…) | no se pinta en el hilo |
| `video_playback` | engagement de video standalone | no se pinta |
| `contact_created` | `name,email,phone,source,conversion_channel,attribution_*,campaign_*,adset_*` | no se pinta |
| `appointment` | `title,status,start_time,end_time,address,notes` | **activity marker** "Cita agendada" |
| `payment` | `amount,status,title,type,payment_provider` | **activity marker** "Pago completado" (solo `amount>0` y status en `succeeded/paid/completed/complete/fulfilled/success`) |

Regla backend: en el journey por defecto los eventos WhatsApp posteriores al **primer pago
exitoso** se ocultan salvo que tengan atribución de anuncio o sean mensajes de chat almacenados
(líneas 5015–5045). Con `includeBusinessMessages=true` los mensajes de chat siempre pasan.

---

## 3. Modelo de mensaje del cliente (`ChatMessage`)

`mobile/src/types.ts:160–220` (fuente de verdad para el modelo Swift):

```ts
ChatMessage {
  id: string                       // estable entre polls/páginas (ver 3.1)
  contactId: string
  date: string                     // ISO/parseable; clave de orden
  direction: 'inbound' | 'outbound' | 'system'
  text: string
  channel: string                  // transport || social_platform || source || event.type
  status?: string
  transport?: string               // igual que channel en el parser
  errorReason?: string
  providerMessageId?: string       // wamid / mid
  sentAt?: string; deliveredAt?: string; readAt?: string   // ISO (ver OPEN QUESTION §10)
  scheduledAt?: string; scheduledMessageId?: string
  messageType?: string
  businessPhone?: string; businessPhoneNumberId?: string
  routingReason?: string
  replyToMessageId?: string; replyToProviderMessageId?: string
  reactionEmoji?: string
  reactionTargetMessageId?: string; reactionTargetProviderMessageId?: string
  reactions?: { id: string; emoji: string; direction?: 'inbound'|'outbound'|'system' }[]
  attachment?: ChatAttachment
  location?: ChatLocation
  isComment?: boolean
  commentReplyMode?: 'public' | 'private'
  linkPreview? / paymentPreview?: { kind?, title?, subtitle?, amountLabel?, providerLabel?, url? }
  emailDetails?: { subject, fromEmail, toEmail, ccEmail?, bccEmail?, replyTo, status, transport, body, bodyHtml? }
  pending?: boolean; failed?: boolean     // solo mensajes optimistas locales
}

ChatAttachment { type: 'image'|'video'|'audio'|'document'|'file'; url?; dataUrl?; name?;
                 mimeType?; isGif?; durationMs?; size?; caption? }
ChatLocation   { latitude: number; longitude: number; name?; address?; url? }
```

### 3.1 Parser `buildMessagesFromJourney(contactId, events)` — `mobile/src/format.ts:942–1039`

Reglas exactas, por evento:

1. Descarta eventos sin `date`.
2. `appointment_confirmation` → mensaje `direction:'system'`, `status:'confirmed'`,
   `text: "Cita confirmada" + (title ? ": <title>" : "")`, `channel:'appointment_confirmation'`,
   id = `data.id || data.appointment_id` o sintético `appointment-confirmation-<date>-<hash(title)>`.
   (En `/movil` el copy es `"Cita confirmada por IA: <title> · <fecha>."`, PhoneChat.tsx:3590.)
3. Solo procesa `whatsapp_message`, `meta_message`, `email_message`; el resto → `null`.
4. Lecturas tolerantes (`readString` recorre alias): `messageType` de
   `message_type|messageType|type`; `status` de `status`.
5. **Email**: `emailDetails` de `buildJourneyEmailDetails` (format.ts:835) — subject/from/to/cc/bcc/
   replyTo/status/transport/body/bodyHtml con alias snake/camel; body plano se deriva del HTML si
   no hay texto (`htmlToPlainEmailText`, format.ts:809: quita style/script/tags, decodifica
   entidades básicas, colapsa espacios). `text` visible = `"<subject>\n<body>"` o el que exista o
   `"Correo electrónico"`.
6. **Attachment** (`getJourneyMediaAttachment`, format.ts:689): mezcla `data` con el primer objeto
   anidado en `media|attachment|file|document|image|video|audio`; toma `mimeType`
   (`media_mime_type|mediaMimeType|mimeType|mime_type|mimetype`), `name`
   (`media_filename|mediaFilename|filename|fileName|name`), `mediaId` (`media_id|mediaId|id`),
   `url` (larga lista `media_url … publicUrl`, format.ts:647). El tipo se infiere del probe
   `messageType+mime+name+url`: image (`image|photo|.png/.jpe?g/.webp/.gif`),
   video (`video|.mp4/.mov/.m4v/.webm`), audio (`audio|voice|.mp3/.m4a/.ogg/.wav/.aac`),
   document (`document|file|.pdf/.docx?/.xlsx?/.pptx?/.csv/.txt`). Requiere `url` o `mediaId`;
   si no hay tipo o identificador → sin attachment. `isGif` si el probe contiene `gif`.
   `durationMs` de `durationMs|duration_ms|audio_duration_ms`. Nombre fallback:
   `Foto|Video|Audio|Documento` (format.ts:670).
7. **Location** (`getJourneyLocation`, format.ts:733): primero campos directos
   `location_latitude/longitude/name/address/url` (+ alias), luego objetos anidados
   `location|locationMessage|whatsappMessage.location|...`. `url` fallback Google Maps.
8. **Texto**: `rawText` = email ? subject+body : primer no vacío de
   `message_text|message|text|body|subject|caption`. Limpiezas encadenadas:
   - `cleanAttachmentMessageText` (format.ts:770): si hay attachment y el texto es solo el nombre
     fallback (`foto|video|audio|documento|archivo`) → `''` (evita "Foto" duplicado bajo la imagen).
   - `cleanLocationMessageText` (format.ts:778): si hay location y el texto es
     `ubicacion|ubicación|location` → `''`.
   - `cleanRedundantRoutingMessageText` (format.ts:785): descarta literalmente
     `"capturado desde la sesión de whatsapp web."`, `"capturado desde la sesión api."`,
     `"capturado desde la api."`, `"capturado desde whatsapp api."` (con/sin acento).
   - Fallback: `getCommentFallbackText(messageType, status, postDeleted)` (los 4 copys de §2.3);
     `postDeleted` = truthy de `post_deleted|postDeleted|post_removed|postRemoved|post_unavailable|postUnavailable`.
   - Último fallback si no hay attachment/location: `getMediaFallback` (format.ts:759) →
     filename, o `Foto|Video|Audio|Documento` según type, o `"Mensaje"`.
9. Descarta el evento si no hay `text` NI `messageType` NI attachment NI location NI emailDetails.
10. `direction` = `normalizeDirection(data.direction)`: `outbound|sent`→outbound, `system`→system,
    resto→inbound. **Ojo**: el cliente solo reconoce `outbound|sent`; el backend ya normaliza sus
    variantes de echo a estos valores en el journey. (En `/movil`,
    `normalizeWhatsAppBusinessDirection` PhoneChat.tsx:2299 reconoce el set completo de echo.)
11. **id estable** (formato exacto, format.ts:993–1001):
    `whatsapp_api_message_id → whatsapp_message_id → meta_social_message_id → meta_message_id →
    email_message_id`, si no `attr-<attribution_record_id>` (los ids INTEGER se convierten a
    string), y como último recurso huella sintética
    `<type>-<date>-<direction>-<hash djb2 base36 de "text|attachmentUrlOName|messageType">`.
    Nunca usar el índice del array (rompe con paginación).
12. Campos restantes: `channel`/`transport` = `transport|social_platform|source` o `event.type`;
    `errorReason` de `error_reason|errorReason|error|message_error` (`/movil` además considera
    `error_message|failure_reason|reason|error_code`, PhoneChat.tsx:2730 — **incluir esa lista
    completa en iOS**); `providerMessageId` de
    `provider_message_id|providerMessageId|whatsapp_message_id|meta_message_id`;
    `sentAt` de `sent_at|sentAt|message_sent_at|messageSentAt|created_at|createdAt|timestamp`
    (fallback `event.date`); `deliveredAt` de `delivered_at|deliveredAt|delivery_at|deliveryAt|
    message_delivered_at|messageDeliveredAt`; `readAt` de `read_at|readAt|seen_at|seenAt|
    message_read_at|messageReadAt|played_at|playedAt`; los timestamps se normalizan a ISO y
    `/movil` también acepta epoch numérico (s o ms) (PhoneChat.tsx:2743).
13. `isComment` si `messageType ∈ {comment, comment_reply_public, comment_reply_private}`;
    `commentReplyMode` = `public|private` según el tipo.

### 3.2 Merge y reacciones (`mergeChatMessagesById`, format.ts:902–940)

- Dedup por `id` (último gana).
- **Reacciones**: un mensaje con `messageType === 'reaction'` y `reactionEmoji` NO se pinta como
  globo; se busca su objetivo por `reactionTargetMessageId` (id local) o
  `reactionTargetProviderMessageId` (comparado contra `providerMessageId || id` de los demás) y se
  agrega a `target.reactions` como `{ id, emoji, direction }` (reemplaza reacción previa con mismo id).
  Si el objetivo no está en la ventana cargada, el evento reaction **se pinta como mensaje normal**
  (globo con el emoji como texto).
- Orden final ascendente por `new Date(date).getTime()`.

---

## 4. Mensajes programados (scheduled)

### 4.1 Endpoints (`whatsappApi.routes.js:85–87`, controller líneas 743–800)

| Método | Path | Body/Query | Respuesta |
|---|---|---|---|
| GET | `/api/whatsapp-api/messages/scheduled?contactId=<id>` | — | `{ success, data: ScheduledChatMessage[] }` (solo status `scheduled|sending|error`, orden `scheduled_at` asc) |
| POST | `/api/whatsapp-api/messages/scheduled` | ver abajo | `{ success, data: ScheduledChatMessage }` |
| DELETE | `/api/whatsapp-api/messages/scheduled/:id` | body o query `{ contactId }` | `{ success, data: ScheduledChatMessage }` (status→`cancelled`) |

POST body (upsert; mandar `id` para **editar** una programación existente):

```jsonc
{
  "id"?: string,
  "contactId": string,                 // requerido
  "provider": "whatsapp_api"|"highlevel",
  "channel"?: "whatsapp_api"|"sms_qr"|"messenger"|"instagram",  // solo highlevel
  "transport"?: "qr"|"api",            // solo whatsapp_api
  "messageType": "text"|"template",
  "text": string,
  "templateId"?, "templateName"?, "templateLanguage"?, "templateComponents"?, "templateVariables"?,
  "toPhone"?: string, "fromPhone"?: string, "businessPhoneNumberId"?: string,
  "scheduledAt": string,               // UTC ISO; el backend valida futuro (≥ now+10s) en TZ del negocio
  "externalId"?: string
}
```

Errores de validación (400): `"Elige una fecha y hora válidas para programar el mensaje."`,
`"Elige una hora futura para programar el mensaje."`, `"Elige un contacto para programar el mensaje."`,
`"Contacto no encontrado."` (404), `"Elige el mensaje programado que quieres eliminar."`.

`ScheduledChatMessage` (shape exacto, `scheduledChatMessagesService.js:112–140`):

```jsonc
{
  "id": string, "contactId": string,
  "provider": "whatsapp_api"|"highlevel",
  "channel": string, "transport": string,   // whatsapp: 'api'|'qr'; highlevel: 'ghl_whatsapp'|'ghl_sms'|'ghl_messenger'|'ghl_instagram'
  "messageType": "text"|"template",
  "text": string,
  "templateId": string, "templateName": string, "templateLanguage": string,
  "templateComponents": any|null, "templateVariables": any|null,
  "toPhone": string, "fromPhone": string, "businessPhoneNumberId": string,
  "scheduledAt": string,                    // UTC ISO
  "status": string,                         // 'scheduled'|'sending'|'sent'|'error'|'cancelled'
  "externalId": string, "sentMessageId": string,
  "attempts": number, "errorMessage": string,
  "createdAt": string, "updatedAt": string, "sentAt": string
}
```

### 4.2 Burbujas programadas en el hilo

RN `buildScheduledMessages` (App.tsx:22614–22634): filtra items con `scheduledAt` y status NO en
`cancelled|canceled|sent|failed`, y construye:

```ts
{ id: `scheduled-${item.id||externalId}`, scheduledMessageId, providerMessageId: externalId,
  contactId, date: scheduledAt, scheduledAt, direction: 'outbound',
  text: item.text || '(mensaje programado)', channel: item.channel||item.transport||'whatsapp_api',
  transport: item.transport||'scheduled', status: 'scheduled' }
```

`isScheduledMessage` = tiene `scheduledAt` o `scheduledMessageId` o `status==='scheduled'`
(App.tsx:22772). El fetch de programados es autoritativo: en cada poll se retiran burbujas
`scheduled-*` que ya no existan en el servidor (App.tsx:18833–18837).

**Display** (App.tsx:21223–21308, docs/MOBILE_APP.md:950–965):

- El globo se posiciona en la fecha programada dentro del timeline (futuro ⇒ al final).
- Estilo: borde punteado (`messageBubbleScheduled`), icono reloj en la fila meta, SIN palomitas.
- Meta label: `"Programado para <hora>"` (`formatMessageTime` en TZ del negocio).
- A la izquierda del globo (fuera de él): timer flotante con reloj + countdown
  `formatNativeScheduledCountdown` (App.tsx:22915): `<60min → "Nm"`, `<24h → "Nh"`, si no `"Nd"`
  (ceil, mínimo 0). El countdown se refresca cada 30 s solo si hay programados visibles
  (App.tsx:19015–19020).
- **Tap o long-press** sobre un globo programado abre el menú con solo 2 acciones:
  `Editar programación` (abre el sheet de programar con texto/fecha precargados) y
  `Eliminar programación` (roja) → DELETE + remoción local optimista (App.tsx:19648–19682).
- `/movil` igual: `Editar programación` / `Eliminar mensaje programado` con spinner
  (PhoneChat.tsx:15427–15442). En `/movil` la burbuja programada usa `date = createdAt` y solo
  muestra `scheduledAt` en el meta (PhoneChat.tsx:3724–3746); RN la ordena por `scheduledAt`.
  **Para iOS seguir RN** (orden por scheduledAt) — es el comportamiento más nuevo.

Estados de un scheduled según `status`:

- `scheduled` → burbuja punteada + countdown.
- `sending` → sigue apareciendo (viene en el GET) — sin UI especial en clientes actuales.
- `error` → viene en GET con `errorMessage`; `/movil` lo muestra como failed (isMessageFailed
  incluye `errorReason`). **OPEN QUESTION:** RN no le da estilo especial (status `'error'` ⇒
  `getMessageReceiptStatus` = failed pero la rama scheduled pinta primero el punteado).
- `sent`/`cancelled` → desaparece de la lista; el mensaje real llega por el journey.

---

## 5. Reacciones (envío)

- Restricciones de cliente (RN App.tsx:19553–19607; `/movil` equivalente):
  - Solo se puede reaccionar a mensajes **inbound**. Copy si no:
    `"Solo mensajes recibidos" / "Las APIs oficiales reaccionan a mensajes que te mandó el contacto."`
  - Comentarios, transportes HighLevel (`ghl_*`, `sms_qr`) y email/SMS: sin reacción. Copy:
    `"Canal sin reacción nativa" / "Ese canal no expone una reacción real al globo desde su API."`
  - Meta (messenger/instagram): SOLO `❤️`. Copy: `"Reacción no disponible" /
    "Meta solo permite reaccionar con corazón desde la API."` En `/movil` el picker Meta solo
    muestra ❤️ (PhoneChat.tsx:15466).
  - Requiere `providerMessageId`. Copy: `"Falta ID del mensaje" / "Este mensaje no tiene el ID
    remoto necesario para reaccionar."`
  - Emojis del picker: `['❤️','👍','😂','😮','🙏']` (`MESSAGE_REACTION_EMOJIS`, PhoneChat.tsx:214;
    RN usa la misma tira en el overlay).
- Optimista: agrega `{ id: 'local-reaction-<ts>', emoji, direction:'outbound' }` reemplazando la
  reacción outbound previa; revierte si el POST falla y muestra Alert `"Reacción"`.
- Endpoints (api.ts:635–673; rutas whatsappApi.routes.js:65 y :89):

```
POST /api/whatsapp-api/messages/reaction              // WhatsApp API/QR
body { to, from?, contactId, targetMessageId, targetProviderMessageId?, emoji,
       externalId, transport: 'qr'|'api', phoneNumberId?, messageOrigin: 'native_mobile_chat' }

POST /api/whatsapp-api/meta/social/messages/reaction  // Messenger/Instagram
body { contactId, platform: 'messenger'|'instagram', emoji,
       targetMessageId, targetProviderMessageId?, externalId }
```

Ambas responden `{ success: true, data }` o `4xx { success:false, error }`.

**Display de reacciones**: chips de emoji pegados al borde inferior del globo objetivo, máximo
las **últimas 3** (`message.reactions.slice(-3)`), RN App.tsx:21310–21316, `/movil`
PhoneChat.tsx:14575–14587.

---

## 6. Construcción del timeline (lista de render)

RN (`conversationItems`, App.tsx:18959–18996). Items en orden:

```
ConversationListItem =
  | { type:'day', id:'day-<YYYY-MM-DD>', label }
  | { type:'activity', id, marker }          // pagos/citas
  | { type:'message', id, message }
  | { type:'completionNotice', id, notice }  // overlay temporal al final
```

1. Se mezclan `filteredMessages` (mensajes; si hay búsqueda activa, filtrados) y
   `filteredActivityMarkers` (vacíos durante búsqueda), ordenados asc por fecha.
2. **Separadores de día**: se insertan cuando cambia `getConversationDayKey(date, timezone)` —
   clave `YYYY-MM-DD` calculada en la **zona horaria del negocio** (format.ts:436; la TZ viene de
   la config de cuenta, no del dispositivo). Etiqueta `formatConversationDayLabel`
   (format.ts:411): `Hoy`, `Ayer`, día de semana en `es-MX` si <7 días (p.ej. "martes"),
   si no `dd MMM` (`02 jul`) y agrega año si es distinto al actual. Fechas inválidas → clave
   `'sin-fecha'` (en `/movil` ese grupo se pinta sin etiqueta).
3. **Activity markers** (App.tsx:23076–23111): del journey completo,
   - `payment` (solo exitosos, amount>0): título `"Pago completado"`, subtítulo el concepto
     (`title|description|concept|type` o `"Cobro registrado"`), `amountLabel` con
     `formatCurrency(amount, currency)` es-MX.
   - `appointment` / `appointment_confirmation`: título `"Cita agendada"` / `"Cita confirmada"`,
     subtítulo `"<título de la cita> · <día> · <hora>"`.
   - Dedup contra markers locales (creados al cobrar/agendar desde el chat): mismo id, o mismo
     kind con fecha a <2 min y mismo monto/subtitulo (App.tsx:23114–23130).
   - Render: fila centrada con línea horizontal + pill con icono (💲 CircleDollarSign /
     CalendarDays), título, `subtitle · hora` (App.tsx:21515–21536).
4. **Completion notice** (App.tsx:21507–21558): tarjeta flotante temporal (check verde + título +
   subtítulo) que aparece al completar un cobro/cita desde el chat; se auto-desvanece ~1.35 s.
   No proviene del backend.
5. `/movil` agrupa por día en `<section>` con `data-message-day-key` e intercala
   `agentCompletion` cards (eventos del agente IA vía
   `GET /conversational-agent/completions?contactId&limit=20`) en el timeline (PhoneChat.tsx:5880–5919).

Estados de pantalla:

- **Cargando** (primera carga): spinner centrado (RN `ActivityIndicator` accent).
- **Vacío**: icono MessageCircle + `"Aún no hay mensajes"` +
  `"Escribe el primer mensaje o usa + para tomar acciones."` (RN App.tsx:20286–20292). Con
  búsqueda activa: `"Sin resultados"` / `"Cambia la búsqueda para ver otros mensajes."`
  `/movil`: `"Elige un chat"`, `"Aún no hay mensajes"` / vista comentarios `"Sin comentarios"`.
- **Error de carga inicial**: RN muestra `Alert('Chat', message)`; el poll de fondo nunca alerta.
- **Pull-to-refresh**: RefreshControl → `loadConversation(silent=true)`.
- **Auto-scroll**: solo al último mensaje en carga inicial o si el usuario ya está abajo; nunca
  durante drag/scroll manual (App.tsx:19003–19013, docs/MOBILE_APP.md:939–942).
- **Búsqueda en el chat** (RN): barra "Buscar en este chat" filtra mensajes por
  `text+attachment.name+channel+transport+status`, muestra contador; los day separators se
  recalculan sobre los filtrados y los markers se ocultan.

---

## 7. Render de burbujas (reglas exactas)

RN `NativeMessageBubble` (App.tsx:21127–21322). Anatomía en orden vertical dentro del globo:

1. Quote (si `replyTarget`), 2. attachment, 3. location, 4. contexto de comentario,
5. email card, 6. texto formateado, 7. link preview, 8. flag "Destacado", 9. `routingReason`,
10. fila meta (chip transporte + hora + palomitas), 11. chips de reacciones.

### 7.1 Direcciones

- `system` → fila centrada, burbuja neutra solo texto (App.tsx:21211–21219). Sin gestos.
- `inbound` → alineado izquierda, fondo superficie (blanco/dark elevated).
- `outbound` → alineado derecha, fondo acento; texto y meta en variante "onAccent".
- `failed` (solo optimistas locales) → estilo failed + texto en tono error; meta muestra `· error`.
- No hay nombre de agente/remitente por burbuja en ningún cliente. La diferenciación de remitente
  outbound existe solo en notas de voz (avatar = foto del número del negocio en `/movil`;
  RN usa avatar del contacto — ver §7.5) y en el chip de transporte. **OPEN QUESTION:** mostrar
  qué usuario/agente envió cada mensaje no está soportado por el contrato actual (el journey no
  trae autor humano).

### 7.2 Meta, hora y palomitas (receipts)

- Hora: `formatMessageTime(date, timezone)` — `es-MX`, TZ del negocio, formato `h:mm` (format.ts:400).
- Meta label RN (App.tsx:21157–21159):
  scheduled → `Programado para <hora>`; normal → `<hora>` + `· enviando` si `pending` +
  `· error` si `failed`.
- Chip de transporte (solo si aplica, antes de la hora):
  - RN `getNativeMessageTransportBadge` (App.tsx:22430): probe `transport+channel` →
    `QR` (qr|baileys|web), `API` (whatsapp|api|native), `IG`, `FB`, `SMS`, `EMAIL`.
  - `/movil` `getMessageTransportBadge` (PhoneChat.tsx:4025): `Mail` (email), `GHL` (ghl_email),
    `IG`, `FB`, `QR` (sms_qr), `API` (whatsapp_api).
  - docs/MOBILE_APP.md:1037: micro-etiquetas sin contorno, abreviadas.
- **Palomitas (solo outbound, no scheduled)** — RN `getMessageReceiptStatus` (App.tsx:22463):

| Estado | Condición | Icono |
|---|---|---|
| `failed` | `message.failed` o `status=='error'` | X roja 13pt (`/movil`: botón ⚠ CircleAlert que abre la razón del error) |
| `pending` | `message.pending` o status ∈ `pending,queued,enviando,sending` | spinner pequeño (`/movil`: Loader2 girando) |
| `read` | `readAt` o `status=='read'` | doble check **color acento** |
| `delivered` | `deliveredAt` o `status=='delivered'` | doble check gris |
| `sent` | resto | check simple gris |

  `/movil` normaliza más estados: read ∈ `read,seen,opened,played`, delivered ∈
  `delivered,delivery_ack` (PhoneChat.tsx:2777; backend normaliza igual en
  `normalizeHighLevelConversationStatus`). Failed ∈ `error,failed,undelivered,rejected` o
  `errorReason` presente; pending ∈ `pending,scheduled,queued` o `enviando*` (PhoneChat.tsx:1292–1293).
  **iOS debe usar los sets de `/movil` (superset).** Labels de accesibilidad:
  `Enviado`/`Entregado`/`Leído`.
- **Error + retry**: en RN un mensaje optimista fallido muestra la X y el menú contextual agrega
  `Reintentar` (App.tsx:21096): repone texto/adjunto en el composer (App.tsx:19630–19646).
  En `/movil` el ⚠ abre toast/alert con `errorReason`. Mensajes fallidos del servidor
  (status error del journey) muestran X pero sin retry en RN (retry solo si `failed` local).

### 7.3 Texto con formato WhatsApp

`parseWhatsAppFormattedText` (App.tsx:22776+): interpreta `*negrita*`, `_itálica_`, `~tachado~`
y `` `mono` ``/``` ```bloque``` ``` respetando límites de palabra (no rompe URLs ni
`snake_case`); apertura válida solo tras espacio/`([{"'¿¡` y cierre antes de
espacio/puntuación. Los segmentos se pintan con bold/italic/strike/mono. `/movil` usa el
componente equivalente `WhatsAppFormattedText`.

### 7.4 Quote / responder (contexto de reply)

- Si el mensaje tiene `replyToMessageId`/`replyToProviderMessageId`, se busca el original en la
  ventana cargada: por id local, `providerMessageId` o `scheduledMessageId`
  (RN `findNativeReplyTarget`, App.tsx:23063; `/movil` PhoneChat.tsx:14550).
- Render: bloque superior dentro del globo con barra vertical + título
  (`Tú` si el original es outbound; si no, nombre del contacto) + preview 1 línea
  (`getMessagePreviewText`: texto, o etiqueta del adjunto `Foto|Video|Audio|Documento`, o
  `📍 Ubicación`, o `"Mensaje"`; `/movil` trunca a 120 chars).
- Si el target no está cargado, `/movil` pinta el quote con label del contacto y texto
  `"Mensaje"`; RN no pinta quote (replyTarget null). **No existe "tocar el quote salta al
  original" en ningún cliente** — no implementar salvo decisión nueva (el resaltado por scroll
  solo existe para resultados de búsqueda en `/movil` vía `data-chat-search-id`).
- Barra de composer `Respondiendo a ti/<nombre>` con preview y botón X para cancelar
  (App.tsx:20326–20338). Al enviar se mandan `replyToMessageId` y `replyToProviderMessageId`
  (payload `getNativeMessageReferencePayload`, App.tsx:23052; contrato en docs/MOBILE_APP.md:1050–1057:
  WhatsApp API `context.message_id`, QR `quoted`, Meta `reply_to.mid`).

### 7.5 Media

- **Imagen** (`NativeImageAttachment`, App.tsx:21647): tarjeta con tamaño acotado a proporción
  real (max width/height, `Image.getSize`), `resizeMode: contain`, tap abre la URL
  (**OPEN QUESTION:** RN abre con `Linking.openURL`; ideal en iOS: visor interno). GIF: en
  `/movil` los GIF llegados como video se reproducen `autoPlay/muted/loop` sin controles
  (PhoneChat.tsx:15837–15848).
- **Video** (`NativeVideoAttachment`, App.tsx:21678): player embebido con controles nativos +
  fila info (badge play, nombre o "Video", duración `m:ss` si `durationMs`).
- **Audio / nota de voz** (`NativeAudioAttachment`, App.tsx:21717–21873): burbuja compacta de
  dos filas: (1) avatar + botón play/pausa plano + waveform con progreso animado;
  (2) duración `m:ss` a la izquierda y meta (chip + hora + palomitas) a la derecha. El avatar
  (contacto en inbound a la derecha; en outbound a la izquierda — en `/movil` el avatar outbound
  es la foto del **número del negocio**) lleva mic superpuesto (SVG stroke color-globo + fill gris)
  y funciona como botón de **velocidad**: cicla `1x → 1.5x → 2x` en RN
  (`CONVERSATION_AUDIO_PLAYBACK_SPEEDS`; docs habla de 1x/2x/4x en `/movil`), con badge de
  velocidad cuando >1x y haptic selection. `durationMs` viene de `media_duration_ms` o del player.
  Sin URL reproducible → placeholder `Nota de voz` / `Nota de voz enviada` con icono mic
  (App.tsx:21875–21884). Formatos reproducibles preferidos: `audio/mp4|m4a|aac|mpeg|mp3|wav`
  (App.tsx:22255). El meta row general se omite (la fila 2 del audio ya lo incluye)
  (App.tsx:21302 condición `attachmentKind !== 'audio'`).
- **Documento/archivo** (`NativeDocumentAttachment`, App.tsx:21697): fila tocable con icono
  FileText, nombre (o `Documento`), subtítulo `"<TipoLegible> · <tamaño> [· duración]"` —
  tipo legible por MIME: PDF, Word, Excel, Imagen, Video, Audio o extensión en mayúsculas
  (App.tsx:22233); tamaño `B/KB/MB` (App.tsx:22223). Chevron derecha; tap abre URL.
  `/movil` distingue `document` vs `file` (zip/rar/txt…) — mismo render.
- **Ubicación** (`NativeMessageLocation`, App.tsx:22121–22153): mini-mapa embebido al ancho del
  globo hecho con tiles de **OpenStreetMap** zoom 16
  (`https://tile.openstreetmap.org/16/{x}/{y}.png`, grid 3×3 centrado, App.tsx:22880–22913),
  pin MapPin grande y badge `📍 Ubicación`; sin textos extra. Tap abre
  `location.url` o (iOS) `https://maps.apple.com/?ll=<lat>,<lng>&q=<nombre>` (App.tsx:22283).
  `/movil` añade atribución "© OpenStreetMap contributors" y muestra título/dirección/coords.
  En iOS nativo se puede usar MapKit snapshot en lugar de tiles (ver Gaps).
- **Link / payment preview** (App.tsx:22306–22440): si el mensaje tiene
  `paymentPreview|linkPreview` explícito o su texto contiene una URL, se extrae la primera URL,
  se remueve del texto visible y se pinta tarjeta: imagen OG (fetch de metadatos OG con timeout
  4.5 s, cacheado en memoria) o fallback icono+host; título (`Link de pago` si es URL de cobro:
  contiene `payment|checkout|invoice|pay.|/pay|stripe.com|conekta|mercadopago|clip.mx|rebill`),
  subtítulo (`Vista previa del cobro` / `Toca para abrir el enlace`), `amountLabel` si existe,
  host. Tap abre la URL.

### 7.6 Email (colapsable)

`NativeEmailMessageCard` (App.tsx:21347–21441); `/movil` `renderEmailMessage`
(PhoneChat.tsx:14631, con `<details>`):

- Cabecera SIEMPRE visible (tap alterna expandido): icono Mail, kicker
  `Correo enviado` (outbound) / `Correo recibido` (inbound) / `Correo electrónico` (system),
  asunto (o `"Sin asunto"`), línea de ruta (outbound → `toEmail||fromEmail`; inbound →
  `fromEmail||toEmail`), chevron que rota al abrir.
- Expandido: filas etiqueta:valor de `Asunto, Remitente, Destinatarios, CC, BCC, Responder a,
  Estado, Transporte` (solo las no vacías; `/movil` no muestra CC/BCC) y bloque
  `Cuerpo:` con el body plano (o `"Sin cuerpo"` / `/movil` `"Sin cuerpo visible"`).
- El globo NO repite el texto plano cuando hay emailDetails (App.tsx:21291 condición).
- El chip de canal es `EMAIL` (RN) / `Mail`/`GHL` (`/movil`).

### 7.7 Comentarios FB/IG

- Bloque de contexto dentro del globo: icono MessageCircle + label:
  inbound sin replyMode → `Comentó en tu publicación` (`/movil`; RN usa `Comentario`),
  `public` → `Respuesta pública al comentario`, `private` → `Respuesta por privado`
  (App.tsx:21275–21282; PhoneChat.tsx:15785–15794).
- `/movil` además pinta un chip de la **publicación comentada** con thumbnail
  (`post_image_url`), tipo (`Publicación` / `Publicación eliminada`), texto del post o
  `Ver publicación` / `Comentario conservado en Ristak`, link externo a `post_permalink`
  (PhoneChat.tsx:15795–15831). RN **no** pinta el chip del post (gap de paridad).
- `/movil`: los comentarios inbound sin reply muestran botón
  `Responder en la publicación` (inicia reply público; el composer por defecto responde privado y
  muestra hint `"Mensaje privado — para responder en la publicación usa “Responder” en el
  comentario."`, banner cancelable `Respondiendo público al comentario`). Endpoint:
  `POST /whatsapp-api/meta/social/messages/comment-reply`
  `{ contactId, platform, message, replyType:'public'|'private', commentId, postId, externalId }`.
- Vista "Comentarios" (lente `commentsView` en `/movil`): filtra el timeline a solo
  `message.isComment`.

### 7.8 Nota de ruteo

`routingReason` se muestra como nota pequeña bajo el contenido SOLO si sobrevive la limpieza:
RN la limpia con la misma lista de frases "Capturado desde…" (§3.1.8); `/movil` la oculta para
mensajes inbound y transporte QR y filtra `"Capturado desde la sesión de WhatsApp Web."`
(PhoneChat.tsx:4041–4048). Regla de producto: el chip API/QR ya comunica el canal
(docs/MOBILE_APP.md:1007–1010).

### 7.9 Destacar (star)

Flag visual dentro del globo (`Destacado` con estrella, RN App.tsx:21295; `/movil` badge estrella).
Estado **local**: `/movil` persiste ids en localStorage `ristak_phone_chat_starred_messages_v1`
(PhoneChat.tsx:201); RN solo en memoria. No hay endpoint backend.

---

## 8. Gestos y menú contextual del mensaje

### 8.1 RN nativo (App.tsx:19545–19692, 21042–21105)

- **Long-press (260 ms)** sobre cualquier globo no-system → haptic `Impact.Medium`, cierra
  teclado, abre **overlay estilo WhatsApp** (Modal, NO bottom sheet, docs/MOBILE_APP.md:980–987):
  fondo con capa de vidrio/dim, el globo seleccionado se re-renderiza centrado, arriba una tira
  flotante de reacciones (los 5 emojis; animación de "bombeo") y debajo un dropdown de acciones:
  - Mensaje normal: `Responder`, `Copiar`, `Destacar`/`Quitar destacado`, `Reenviar`,
    `Reintentar` (solo si failed), `Info del mensaje`.
  - Programado: `Editar programación`, `Eliminar programación` (danger).
- Acciones:
  - `Responder` → setea reply target y muestra barra en composer.
  - `Copiar` → clipboard con `getMessagePreviewText`.
  - `Reenviar` → **placeholder**: agrega el texto al draft del composer (App.tsx:19624). En
    `/movil` muestra toast `"Reenviar aún no está activo"` (PhoneChat.tsx:11110). No hay forward
    real todavía.
  - `Info del mensaje` → RN muestra un `Alert` con `Canal / Estado / Hora / Error?`
    (App.tsx:20547–20554). **`/movil` tiene pantalla completa** (ver 8.2).
- **Swipe horizontal para responder** (App.tsx:21173–21236, docs/MOBILE_APP.md:967–978):
  arrastre >4 px con dominancia horizontal; cue con icono forward en cápsula visible durante el
  gesto (inbound: cue a la izquierda; outbound: a la derecha); umbral de disparo |dx| > 38 px
  (clamp visual ±72 px) → haptic light + activa reply. Aplica a ambos sentidos en RN.

### 8.2 /movil (PhoneChat.tsx:10729–11330, 15211–15507)

- **Long-press 460 ms** (`MESSAGE_ACTION_LONG_PRESS_MS`) o click derecho (contextmenu) sobre el
  globo → overlay anclado a la posición del globo con preview del mensaje + menú:
  - Fila de reacciones (5 emojis; solo ❤️ para Meta).
  - `Responder`, `Reenviar`, `Copiar`, `Destacar`/`Quitar destacado`, `Más`, `Eliminar` (danger).
  - Submenú `Más`: `Fijar`, `Traducir`, `Eliminar`, `Más` (volver). `Fijar/Traducir/Eliminar`
    son placeholders → toast "aún no está activo".
- **Swipe sobre el globo**: hacia la **derecha** = responder (o reply público si es comentario);
  hacia la **izquierda** = abrir **Info del mensaje**. Activación ≥9 px, ancho de acción 46 px,
  umbral de apertura 38 px (constantes líneas 300–305). Cue: icono Reply o ReceiptText.
- **Pantalla `Info del mensaje`** (PhoneChat.tsx:15211–15313): pantalla completa con back,
  preview del globo y filas:
  - `Enviado`/`Recibido` + fecha-hora local (o `"Sin hora guardada"`).
  - Outbound: `Entregado` → `deliveredAt` formateado, o `"Confirmado, sin hora exacta"` si el
    status ya es delivered/read, `"No entregado"` si failed, `"Sin confirmación"` si no;
    `Leído` → `readAt`, o `"Leído, sin hora exacta"` si status read, o `"Aún no leído"`.
  - Inbound: `Leído por ti` → `readAt` o `"Sin registro guardado"`.
  - Si failed: fila roja `Error` con `errorReason` o
    `"No se guardó la razón exacta del error."`.

**Para iOS**: implementar el overlay estilo RN (context menu nativo puede mapear) + la pantalla
de Info de `/movil` (mejor que el Alert de RN).

---

## 9. Copys exactos (es) del módulo

| Contexto | Texto |
|---|---|
| Vacío | `Aún no hay mensajes` / `Escribe el primer mensaje o usa + para tomar acciones.` |
| Vacío búsqueda | `Sin resultados` / `Cambia la búsqueda para ver otros mensajes.` |
| Búsqueda placeholder | `Buscar en este chat` |
| Error carga | Alert título `Chat`, fallback `No se pudo cargar la conversación.` |
| Día | `Hoy`, `Ayer`, día semana es-MX, `dd MMM [yyyy]` |
| Meta programado | `Programado para <hora>` |
| Meta enviando/error | `· enviando`, `· error` |
| Receipts (a11y) | `Enviado`, `Entregado`, `Leído` |
| Info (RN alert) | `Canal: …` `Estado: … / sin estado` `Hora: …` `Error: …` |
| Info (/movil) | `Info del mensaje`, `Enviado/Recibido`, `Entregado`, `Leído`, `Leído por ti`, `Sin hora guardada`, `Confirmado, sin hora exacta`, `No entregado`, `Sin confirmación`, `Leído, sin hora exacta`, `Aún no leído`, `Sin registro guardado`, `No se guardó la razón exacta del error.` |
| Menú mensaje | `Responder`, `Copiar`, `Destacar`, `Quitar destacado`, `Reenviar`, `Reintentar`, `Info del mensaje`, `Editar programación`, `Eliminar programación` (RN) / `Eliminar mensaje programado`, `Fijar`, `Traducir`, `Eliminar`, `Más` (/movil) |
| Reply bar | `Respondiendo a ti` / `Respondiendo a <nombre>` (/movil: `Respondiendo`) |
| Reacciones bloqueadas | ver §5 (4 alerts) |
| Reacción fallida | Alert `Reacción` / `No se pudo mandar la reacción.` |
| Scheduled fallido | Alert `Programado` / `No se pudo cancelar el mensaje.` / `No encontré el ID de esta programación.` |
| Comentarios | `Comentario`, `Comentó en tu publicación`, `Respuesta pública al comentario`, `Respuesta por privado`, `Comentario eliminado`, `Comentario sin texto`, `Publicación eliminada`, `Ver publicación`, `Responder en la publicación`, `Comentario conservado en Ristak` |
| Email | `Correo enviado`, `Correo recibido`, `Correo electrónico`, `Sin asunto`, `Asunto`, `Remitente`, `Destinatarios`, `CC`, `BCC`, `Responder a`, `Estado`, `Transporte`, `Cuerpo:`, `Sin cuerpo` |
| Audio | `Nota de voz`, `Nota de voz enviada`, `Audio` |
| Adjuntos fallback | `Foto`, `Video`, `Audio`, `Documento`, `Mensaje`, `GIF enviado` (/movil) |
| Ubicación | `📍 Ubicación` |
| Link preview | `Link de pago`, `Vista previa del cobro`, `Toca para abrir el enlace` |
| Sistema | `Cita confirmada[: <título>]` (RN) / `Cita confirmada por IA: <título> · <fecha>.` (/movil) |
| Markers | `Pago completado`, `Cobro registrado`, `Cita agendada`, `Cita confirmada` |
| Destacado | `Destacado` |
| Paginación (/movil) | `Cargando mensajes anteriores`, `Mostrando lo guardado, actualizando conversación` |
| Scheduled placeholder | `(mensaje programado)` |

Haptics RN: long-press globo → `Impact.Medium`; swipe reply dispara → `Impact.Light`;
cambio velocidad audio → `selection` (fallback vibración 8 ms).

---

## 10. Gaps / riesgos para iOS nativo

1. **`deliveredAt`/`readAt` casi nunca existen.** Los parsers leen
   `delivered_at/read_at/seen_at/played_at`, pero `getContactJourney` NO emite esos campos para
   `whatsapp_message`/`meta_message` (solo `status`). Las palomitas funcionan por `status`; la
   pantalla Info casi siempre mostrará "Confirmado, sin hora exacta". No asumir timestamps.
   **OPEN QUESTION:** ¿agregar delivered/read timestamps al journey en backend?
2. **Receipts de HighLevel** solo se refrescan con `refreshExternalStatuses=true`, que los
   móviles apagan por latencia. Un hilo con transporte `ghl_*` puede quedar con status viejo
   hasta que alguien abra el chat en escritorio. **OPEN QUESTION:** ¿job de refresco o permitir
   `true` en un poll esporádico?
3. **Paginación con `<` estricto sobre fecha**: dos mensajes con timestamp idéntico en el borde
   de página pueden perderse u omitirse. Mitigación cliente: merge por id y tolerancia.
4. **`messageLimit` se aplica por fuente y luego `slice(-limit)`**: si un contacto tiene mucho
   email+whatsapp mezclado, una "página" puede contener solo la fuente más reciente; las páginas
   siguientes recuperan el resto. El merge por id lo hace consistente pero el conteo por página
   no es uniforme por canal.
5. **Reacciones a mensajes fuera de la ventana cargada** se pintan como globo de emoji suelto
   (el target no está para fusionar). Igual en RN/movil; aceptar el mismo comportamiento.
6. **"Reenviar" no existe realmente** (RN pega el texto al draft; /movil toast). No prometer
   forward multi-chat.
7. **Tap en quote NO salta al original** en ningún cliente. Si se implementa en iOS es mejora
   nueva, no paridad; requiere buscar/paginar hasta el mensaje citado.
8. **Starred/pins son locales** (localStorage en /movil, memoria en RN). Sin backend. Decidir
   persistencia local (UserDefaults) o pedir endpoint.
9. **`Fijar`, `Traducir`, `Eliminar` mensaje**: placeholders sin backend. No implementar como
   funcionales.
10. **OpenStreetMap tiles** para ubicación = dependencia externa sin API key ni atribución en RN
    (sí en /movil). En iOS usar MapKit (snapshot) y evitar el tema de uso de tiles OSM.
11. **Link previews**: RN hace fetch directo del HTML de la URL desde el dispositivo (privacidad/
    CSP/ATS). En iOS considerar `LPMetadataProvider` nativo (equivalente) — mismo trade-off.
12. **Realtime**: RN solo hace polling 7 s + push interno; `/movil` tiene SSE
    (`chatEvents.routes.js`) que RN no usa. Para iOS el mínimo de paridad nativa es polling 7 s +
    refresh al foreground + refresh al tocar push. SSE es mejora opcional.
13. **`attribution_record_id` INTEGER**: convertir a string con prefijo `attr-` para ids —
    puede chocar con ids numéricos de Meta si no se prefija (comentado en format.ts:989–992).
14. **`direction` del cliente RN solo reconoce `outbound|sent`**; el journey puede traer echo
    variants en teoría (hoy el backend los normaliza al almacenar). iOS debe usar el set completo
    outbound de `/movil` (PhoneChat.tsx:2299) por robustez.
15. **Timezone del negocio**: separadores de día, `Programado para`, countdowns y validación de
    programación usan la TZ de la cuenta (endpoint de settings), NUNCA la del dispositivo. Si la
    TZ no ha cargado, RN usa default del negocio (`DEFAULT_BUSINESS_TIMEZONE` en format.ts).
16. **Scheduled con status `error`**: llega en el GET pero ni RN ni /movil lo pintan distinto de
    un scheduled normal (RN) — **OPEN QUESTION:** cómo pintar el fallo de envío programado
    (existe `errorMessage` en el modelo).
17. **Chip de publicación comentada** (post_message/post_image_url/post_permalink) existe en
    /movil pero NO en RN. Para paridad completa iOS debería pintarlo (los datos ya vienen en el
    journey §2.3).
18. **Journey completo sin paginar**: `getContactJourney` (para markers/Info) devuelve TODO el
    historial de eventos no-mensaje + mensajes; en contactos muy activos puede ser pesado.
    RN lo pide en cada `loadConversation` (cada 7 s) — considerar throttle en iOS.
19. **Agent completions en el hilo**: /movil intercala tarjetas de
    `GET /api/conversational-agent/completions?contactId=&limit=20`; RN no. Decidir si iOS las
    incluye (los datos existen).
20. **`markChatRead`**: al abrir el hilo siempre `POST /contacts/chats/:id/read`; el acuse real
    al proveedor lo maneja el backend en background y respeta el setting
    `chat_send_read_receipts_enabled` (docs/MOBILE_APP.md:1063–1072). No bloquear la UI por esto.

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **CONFIRMADO — Gap 1 (`deliveredAt`/`readAt`):** grep de `delivered_at|read_at|deliveredAt|readAt`
   sobre `backend/src/controllers/contactsController.js` devuelve **cero** resultados en los
   emisores del journey: el backend NO emite timestamps de entrega/lectura para
   `whatsapp_message`/`meta_message`. Las palomitas de iOS deben derivarse SOLO de `status`
   (sets de `/movil` §7.2); la pantalla "Info del mensaje" mostrará casi siempre
   "Confirmado, sin hora exacta". Agregar los timestamps requiere cambio de backend
   (sigue abierto como backlog, no como incógnita).
2. **CONFIRMADO — realtime del hilo:** el único evento SSE de chat es `chat_message`
   (metadatos, sin texto) — verificado en `chatLiveEventsService.js`. El patrón correcto
   es refetch del journey al recibirlo (como /movil), más polling 7 s de reconciliación.
