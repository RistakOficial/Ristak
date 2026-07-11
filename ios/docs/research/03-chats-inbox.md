# 03 — Chats: Bandeja de conversaciones (Inbox)

> Spec de investigación para la app nativa SwiftUI (iPhone + iPad, iOS 26).
> Fuentes: backend Node (`backend/src/...`), web móvil `/movil`
> (`frontend/src/pages/PhoneChat/PhoneChat.tsx`, 22.184 líneas) y cliente RN
> (`mobile/src/App.tsx`, `mobile/src/api.ts`, `mobile/src/types.ts`).
> Este documento es autosuficiente: los agentes Swift NO releerán el código TS/JS.

---

## 0. Convenciones generales

- Todos los endpoints cuelgan de `/api` (p. ej. `GET /api/contacts/chats`).
- Autenticación: header `Authorization: Bearer <token>` (JWT emitido por `/api/auth/login`).
- Envelope de respuesta estándar: `{ "success": true, "data": ... }`. En error:
  `{ "success": false, "error": "<mensaje en español>" }` con status HTTP 4xx/5xx.
  Los clientes (web y RN) desempaquetan y usan solo `data`.
- ACL por módulo: todas las rutas de `/api/contacts/*` exigen sesión +
  `requireModuleAccess('contacts')`; las rutas de chat (`/chats*`,
  `/:id/linked-social`) exigen ADEMÁS `requireModuleAccess('chat')`
  (`backend/src/routes/contacts.routes.js:47-57,89`). Un empleado con
  `chat:'none'` recibe 403 aunque tenga `contacts:'read'`.
- Zona horaria de negocio: `app_config.account_timezone` (leer vía
  `GET /api/config?keys=account_timezone`). TODO el formateo de fechas de la
  bandeja usa esa zona, nunca la del dispositivo.

---

## 1. Endpoints del módulo

### 1.1 `GET /api/contacts/chats` — lista de conversaciones

Fuente: `backend/src/controllers/contactsController.js:2190-2640`.

| Query param | Tipo | Default | Notas |
|---|---|---|---|
| `q` | string | `''` | Búsqueda de contactos (nombre plegado sin acentos, nombre+apellido, email, dígitos de teléfono —incluye teléfonos secundarios de `contact_phone_numbers`—, id). Ver `backend/src/utils/searchText.js:258-280`. |
| `limit` | number | `50` | Clamp a `1..100` (`CHAT_CONTACTS_DEFAULT_LIMIT=50`, `CHAT_CONTACTS_MAX_LIMIT=100`, líneas 1893-1894, 2199). |
| `offset` | number | `0` | `max(floor(n),0)`. Paginación pura por offset; NO devuelve total ni `hasMore` — el cliente infiere "hay más" si `data.length >= limit`. |
| `businessPhoneNumberId` | string | `''` | Filtra mensajes WhatsApp por id de número de negocio (`whatsapp_api_phone_numbers.id`). El backend expande a números "relacionados" (mismo teléfono en varias filas: `phone_number`, `display_phone_number`, `qr_connected_phone`; líneas 204-241). |
| `businessPhone` | string | `''` | Alternativa/complemento por valor de teléfono (se normaliza y expande a candidatos). Los clientes mandan AMBOS cuando el filtro por número está activo (`PhoneChat.tsx:7133-7138`). |
| `warmProfilePictures` (alias `warmProfiles`) | `'true'\|'1'\|'yes'\|'si'\|'sí'` | off | Si truthy, el backend refresca fotos de perfil WhatsApp (API limit 60, QR limit 24) antes de responder. Ambos clientes lo mandan `'true'` en la bandeja. |

Comportamiento clave del query SQL:

- Una "conversación" = un contacto con ≥1 mensaje en `whatsapp_api_messages`
  (por `contact_id` directo o por match de teléfono contra
  `contacts.phone`/`contact_phone_numbers`), y —solo cuando NO hay filtro de
  número— también `meta_social_messages` (Messenger/Instagram/comentarios) y
  `email_messages` (líneas 2214, 2279-2298). Es decir: con filtro de número
  activo, los chats de solo-Meta o solo-email desaparecen de la lista.
- Orden: `last_message_date DESC, contact_id DESC` (fecha del mensaje más
  reciente entre todos los canales).
- Excluye contactos ocultos (sección 1.6) aplicando `NOT(...)` sobre
  nombre/email/teléfono/id.
- El texto del último mensaje aplica fallbacks para comentarios Meta:
  `'Comentario eliminado'` (status removed/deleted/hidden o post `deleted`),
  `'Comentario sin texto'`, `'Respuesta pública al comentario'`,
  `'Respuesta por privado al comentario'` (líneas 2350-2362). Para email:
  `subject · message_text` (o solo uno de ambos, línea 2384-2386).
- `unread_count` NO sale del SQL: se resuelve por usuario contra
  `chat_read_states` (sección 1.2) y se inyecta por fila (líneas 2621-2631).

**Respuesta** `{ success: true, data: ChatContact[] }`. Cada fila
(`mapChatContactRowForResponse`, `contactsController.js:1831-1891`):

| Campo JSON | Tipo | Descripción |
|---|---|---|
| `id` | string | Id del contacto. |
| `createdAt` | string (ISO/SQL timestamp) | `contacts.created_at`. |
| `name` | string | Nombre para mostrar ya resuelto por backend (full_name → nombre de perfil WhatsApp/Meta → teléfono...). |
| `email` | string | `''` si null. |
| `phone` | string | Teléfono principal, `''` si null. |
| `ltv` | number | Suma de pagos exitosos no-test (float). |
| `status` | `'lead' \| 'appointment' \| 'customer'` | `customer` si `customer_payments_count>0`; si no `appointment` si tiene citas activas o `appointment_date`; si no `lead`. |
| `lastPurchase` | string \| null | Fecha del último pago exitoso. |
| `purchases` | number | Conteo de pagos exitosos. |
| `successfulPaymentsCount` | number | Igual que `purchases`. |
| `hasAppointments` | boolean | Tiene cita cuyo estado NO está en {cancelled, canceled, no_show, noshow, invalid, failed, missed, deleted, void, voided}. |
| `hasShowedAppointment` / `hasAttendedAppointment` | boolean | Asistió (status en {showed, attended, completed, complete}) o tiene pagos o señales de asistencia. |
| `hasUpcomingConfirmedAppointmentBadge` | boolean | `confirmation_badge_until > now`. |
| `source` | string \| null | Fuente del contacto. |
| `profilePhotoUrl` | string \| null | Foto: WhatsApp API contact → Meta social contact (precedencia interna del backend). |
| `ad_name`, `ad_id` | string \| null | Atribución de anuncio. |
| `preferredWhatsAppPhoneNumberId` / `preferred_whatsapp_phone_number_id` | string | Número fijado por el usuario para "Contactando desde" (`''` si none). |
| `phones` / `phoneNumbers` | array | Teléfonos secundarios: `{ id, phone, label, isPrimary, is_primary, source, createdAt, updatedAt }`. |
| `customFields` | array | Campos personalizados parseados. |
| `socialProfileName` | string \| null | Nombre del perfil Meta. |
| `socialUsername` | string \| null | Username Meta sin `@`. |
| `notes` | string | Siempre `''`. |
| `lastMessageText` | string | Texto del último mensaje (con fallbacks de comentario/email arriba). `''` si none. |
| `lastMessageType` | string | Ej. `text`, `image`, `video`, `audio`, `document`, `location`, `comment`, `comment_reply_public`, `comment_reply_private`, `email`, `reaction`, `postback`... |
| `lastMessageChannel` | string | `'whatsapp'` \| plataforma Meta (`'messenger'`/`'instagram'`/valor de `meta_social_messages.platform`) \| `'email'`. |
| `lastMessageDate` | string | Timestamp del último mensaje; fallback `createdAt`. |
| `lastMessageDirection` | string | `'inbound'` \| `'outbound'` (u otros valores del proveedor: `sent`, `business_echo`... el cliente normaliza, ver §4.6). |
| `lastBusinessPhone` / `lastBusinessPhoneNumberId` | string | Número de negocio del último mensaje WhatsApp (`''` para Meta/email). |
| `lastInboundBusinessPhone` / `lastInboundBusinessPhoneNumberId` | string | Del último mensaje ENTRANTE con número de negocio. |
| `firstInboundBusinessPhone` / `firstInboundBusinessPhoneNumberId` | string | Del primer mensaje entrante. |
| `lastMessageTransport` | string | `'api'` \| `'qr'` (WhatsApp), `'smtp'`/`'ghl_email'` (email), `''` para Meta. |
| `messageCount` | number | Total de mensajes del contacto (todas las fuentes incluidas en el query). |
| `unreadCount` | number | No leídos PARA EL USUARIO autenticado (≥0). |
| `hasCommentMessage` | boolean | El contacto tiene ≥1 comentario FB/IG (a nivel mensaje). |
| `hasPrivateDm` | boolean | El contacto tiene ≥1 DM Meta real (no comentario). |

Error: `500 { success:false, error:'Error obteniendo chats' }`.

### 1.2 Marcar leído

Estado por usuario en tabla `chat_read_states (user_id, contact_id, unread_count, last_read_at, last_unread_at)` — `backend/src/services/chatReadStateService.js`.

**`POST /api/contacts/chats/:id/read`** (`contactsController.js:2642-2701`)
- Body: `{}` (el id va en la URL; también acepta `{ contactId }` en body).
- Efecto: upsert `unread_count=0, last_read_at=now` para (usuario, contacto). Después, si
  `app_config.chat_send_read_receipts_enabled` no está en
  {`0,false,no,off,disabled`}, encola EN BACKGROUND el "visto" real del
  proveedor (YCloud markAsRead, Baileys readMessages, Meta `mark_seen`;
  timeout 3.5 s por proveedor, no bloquea la respuesta).
- Respuesta: `{ success:true, data:{ contactId, unreadCount:0, lastReadAt }, providerRead:{ enabled:true, queued:true } }`
  o `providerRead:{ enabled:false, reason:'read_receipts_disabled' }`.
- Errores: 401 `'Usuario no autenticado'`, 400 `'Contacto inválido'`, 500.

**`POST /api/contacts/chats/read`** (bulk, `contactsController.js:2703-2736`)
- Body: `{ "contactIds": ["ct_1","ct_2"] }` (alias aceptado: `ids`).
- Respuesta: `{ success:true, data:{ updated:<n>, contactIds:[...], lastReadAt } }`.
- Errores: 401, 400 `'Selecciona al menos un chat'`, 500.
- NOTA: el bulk NO dispara vistos de proveedor (solo el endpoint individual).

Los no-leídos suben cuando llega un inbound (`recordInboundChatUnread`): +1 por
cada usuario activo cuyo `last_read_at` sea anterior al mensaje.

### 1.3 `GET /api/contacts/search` — búsqueda de contactos (sin mensajes)

Fuente: `contactsController.js:3530-3677`. Usada por la bandeja cuando la
búsqueda no encuentra chats (sugerencias "Contactos encontrados") y por el
flujo "Nuevo chat".

- Query: `q` (string, requerido; si falta → `{success:true,data:[]}`).
- Máx 20 resultados, ordenados por ranking de relevancia (match exacto de
  nombre 1200 > prefijo 800 > email/tel exacto 650 > contains 450...,
  `searchText.js:190-256`).
- Excluye ocultos y `deleted_at IS NULL`.
- Respuesta `data[]`: igual a `ChatContact` pero SIN los campos `lastMessage*`,
  `messageCount`, `unreadCount`, `hasCommentMessage`, `hasPrivateDm`,
  `customFields`, `socialProfileName`/`socialUsername`,
  `preferredWhatsAppPhoneNumberId` (sí trae: `id, createdAt, name, email,
  phone, ltv, status, lastPurchase, purchases, successfulPaymentsCount,
  hasAppointments, hasShowedAppointment, hasAttendedAppointment,
  hasUpcomingConfirmedAppointmentBadge, source, ad_name, ad_id,
  profilePhotoUrl, phones, phoneNumbers, notes:''`).
- Modo ligero iOS `picker=true`: no calcula LTV, pagos, citas ni calienta
  avatares, pero sí devuelve `phones`, `matchedPhone` y señales mínimas del
  último mensaje (`lastMessageChannel`, `lastMessageType`,
  `lastMessageTransport`, `lastMessageDate`) para que Nuevo chat, Nueva cita y
  Pagos pinten el badge de canal sin pedir `/contacts/chats`.

### 1.4 `GET /api/search/global` — búsqueda global (referencia)

`backend/src/routes/search.routes.js` + `searchController.js:74+`. Solo
requiere sesión (sin gate de módulo). `q` obligatorio; devuelve
`{ success:true, data:{ categories:[...], total } }` con hasta 6 filas por
categoría (contactos, citas, pagos, planes, automatizaciones, calendarios,
usuarios, campañas/adsets/ads). La bandeja móvil NO la usa (usa
`/contacts/search`); se documenta por si el iPad quiere búsqueda global.

### 1.5 Etiquetas (`/api/contact-tags`) y bulk tags

Rutas: `backend/src/routes/contactTags.routes.js` (sesión +
`requireModuleAccess('contacts')`). Servicio: `contactTagsService.js`.

| Método/Ruta | Body / Query | Respuesta `data` |
|---|---|---|
| `GET /api/contact-tags` | `?includeSystem=true` opc., `?includeUsage=true` opc. | `Tag[]` — `{ id, name, folderId:string\|null, isSystem:false, createdAt, updatedAt, usageCount? }`. Con `includeSystem`, antepone las internas `{ id:'client'\|'booked'\|'lead', name, isSystem:true }` (nombres personalizables vía custom labels; defaults `Cliente`, `Cita agendada`, `Prospecto`). |
| `GET /api/contact-tags/system` | — | Solo internas. |
| `GET /api/contact-tags/catalog` | `?includeSystem=true` opc. | `{ tags:[...con usageCount], folders:[{id,name,description,createdAt,updatedAt}] }`. |
| `POST /api/contact-tags` | `{ name, folderId? }` | 201 con la etiqueta creada; si ya existe una con el mismo nombre normalizado devuelve la existente. Errores 400: nombre vacío / nombre reservado de etiqueta interna. `name` se recorta a 60 chars. Id generado tipo `tag_...`. |
| `PUT /api/contact-tags/:id` | `{ name?, folderId? }` | Etiqueta actualizada. 400 internas no editables / nombre vacío / reservado; 404 no existe; 409 nombre duplicado. |
| `DELETE /api/contact-tags/:id` | — | `{ success:true }`; la quita del catálogo y de todos los contactos. 400 interna, 404. |
| `POST /api/contact-tags/folders` | `{ name, description? }` | 201 carpeta. 400 vacío, 409 duplicado. |
| `DELETE /api/contact-tags/folders/:id` | — | `{ success:true }`; las etiquetas quedan sin carpeta. |

**`POST /api/contacts/bulk/tags`** (`contactsController.js:4442-4509`)
- Body: `{ "contactIds": string[] (1..1000), "addTagIds": string[], "removeTagIds": string[] }`.
  `addTagIds` acepta ids O nombres (crea la etiqueta si no existe,
  `createMissing:true`); las etiquetas internas se ignoran (no se guardan en
  `contacts.tags`).
- Respuesta: `{ success:true, data:{ updated:<n>, total:<n> } }`.
- Errores 400: `'Selecciona al menos un contacto'`, `'Máximo 1000 contactos por operación'`, `'Selecciona al menos una etiqueta'`.
- Dispara automatizaciones `tag-changed`.
- El sheet móvil "Agregar etiqueta" usa este endpoint con un solo contactId
  (`PhoneChat.tsx:10031`; RN `api.bulkUpdateTags` equivalente).

`contacts.tags` es un JSON array de tag IDs en el contacto; en la respuesta de
chats viaja ya parseado en `tags: string[]`.

### 1.6 Contactos ocultos (`/api/hidden-contacts`)

`backend/src/routes/hiddenContacts.routes.js` + `hiddenContactsController.js`.
GET requiere solo sesión; POST/DELETE requieren admin (ACL-003).

- `GET /api/hidden-contacts` → `data:[{ id:string, filterText:string, matchType:'contains'\|'exact', createdAt }]`.
- `POST /api/hidden-contacts` body `{ filterText:string, matchType?:'contains'\|'exact' }` → 400 texto requerido / matchType inválido; 409 `'Este filtro ya existe'`.
- `DELETE /api/hidden-contacts/:id` → 404 si no existe.

Efecto en la bandeja: el backend excluye de `/contacts/chats`, `/contacts/search`
y búsqueda global cualquier contacto cuyo nombre/email/teléfono/id haga match
(`utils/hiddenContactsFilter.js`). El cliente NO gestiona esto en la bandeja;
es transparente (se administra desde Configuración de escritorio).

### 1.7 Configuración compartida (`/api/config`) — persistencia de preferencias

`backend/src/routes/config.routes.js` + `configController.js`.
- `GET /api/config` o `GET /api/config?keys=k1,k2` → `{ success:true, config:{ k: v|null } }`.
  Los valores se guardan como texto (JSON serializado para arrays/objetos).
  Claves sensibles (regex private_key|secret|password|token...) devuelven null.
- `POST /api/config` guarda una o varias claves (requiere acceso de escritura de config).

El hook web `useAppConfig` (`frontend/src/hooks/useAppConfig.ts`) es un híbrido
localStorage-cache + DB source-of-truth. Claves usadas por la bandeja:

| Clave `app_config` | Tipo | Default | Uso |
|---|---|---|---|
| `mobile_chat_filter_chip_ids` | `string[]` | `['all','unread','appointments','customers','leads','comments']` | Chips visibles bajo el buscador. `'all'` siempre presente/forzado al inicio. |
| `mobile_chat_custom_filter_presets` | `PresetCondicional[]` | `[]` | Filtros condicionales guardados (ver §3.4). |
| `mobile_chat_selected_whatsapp_phone_id` | string | `'all'` | Número WhatsApp activo como filtro de bandeja. |
| `mobile_chat_ai_agent_enabled` | boolean | `true` | Muestra la fila fija "Asistente Personal AI". |
| `mobile_chat_show_archived` | boolean | `true` | Muestra la fila "Archivados". |
| `mobile_chat_sort_mode` | `'recent' \| 'unread'` | `'recent'` | Orden de la lista (unread primero, con fecha como desempate). |
| `mobile_chat_show_last_preview` | boolean | `true` | Subtítulo de fila = preview del último mensaje vs. detalle del contacto. |
| `mobile_chat_show_unread_indicators` | boolean | `true` | Muestra badge/estilo de no leídos. |
| `chat_send_read_receipts_enabled` | boolean-ish | on | (Backend) apaga el visto externo al proveedor. |
| `account_timezone` | string IANA | `America/Mexico_City` (fallback) | Formateo de fechas de la bandeja. |

⚠️ En el cliente RN actual, `mobile_chat_filter_chip_ids`, archivados y
silenciados se persisten LOCALMENTE (AsyncStorage:
`ristak.native.chat.archivedIds.v1`, `ristak.native.chat.mutedIds.v1`,
`CHAT_FILTERS_STORAGE_KEY`) — el checklist de paridad marca pendiente moverlos
a `app_config` (`docs/MOBILE_NATIVE_PARITY_CHECKLIST.md:195-207`). En `/movil`
los chips y presets SÍ van a `app_config`; archivados/silenciados viven en
localStorage (`ristak_phone_chat_archived_state_v1`,
`ristak_phone_chat_muted_state_v1`, `PhoneChat.tsx:199-200`). **Archivar y
silenciar NO tienen endpoint backend: son estado 100% local por dispositivo.**

### 1.8 Endpoints satélite que la bandeja consume

- `GET /api/whatsapp-api/status` → estado + `phoneNumbers[]` (cada uno con
  `id, label, verified_name, phone_number, display_phone_number,
  qr_connected_phone, profile_picture_url, business_profile_json,
  is_default_sender, qr_send_enabled, qr_status ...`). Necesario para chips por
  número y para resolver el filtro de número.
- `GET /api/contacts/custom-fields` → definiciones de campos personalizados
  (para el builder de filtros condicionales; se excluyen `archived`).
- `GET /api/highlevel/custom-labels` → labels personalizables
  (`customer/customers/lead/leads`) que renombran los chips `Clientes`/`Leads`
  y las etiquetas internas.
- Agente conversacional (`/api/conversational-agent/...`): estados por contacto
  que alimentan el badge de robot, filas prioritarias y el hub del agente.
  (Detallado en el doc del módulo de agente; aquí solo afecta presentación.)
- `POST /api/contacts/bulk/custom-fields` — body
  `{ contactIds (1..1000), customFields:[...] }` → `data:{ updated, total, customFields }`
  (existe para acciones masivas; la bandeja móvil actual no lo expone).

---

## 2. Modelo de datos para Swift

```swift
// Fila de conversación (respuesta de GET /contacts/chats)
struct ChatContact: Decodable, Identifiable {
  let id: String
  let createdAt: String?
  let name: String
  let email: String
  let phone: String
  let ltv: Double
  let status: String            // "lead" | "appointment" | "customer"
  let lastPurchase: String?
  let purchases: Int
  let hasAppointments: Bool
  let hasShowedAppointment: Bool
  let hasUpcomingConfirmedAppointmentBadge: Bool
  let source: String?
  let profilePhotoUrl: String?
  let adName: String?           // "ad_name"
  let adId: String?             // "ad_id"
  let preferredWhatsAppPhoneNumberId: String
  let phones: [ContactPhoneNumber]
  let customFields: [ContactCustomFieldValue]
  let socialProfileName: String?
  let socialUsername: String?
  let lastMessageText: String
  let lastMessageType: String
  let lastMessageChannel: String
  let lastMessageDate: String?
  let lastMessageDirection: String
  let lastBusinessPhone: String
  let lastBusinessPhoneNumberId: String
  let lastInboundBusinessPhone: String
  let lastInboundBusinessPhoneNumberId: String
  let firstInboundBusinessPhone: String
  let firstInboundBusinessPhoneNumberId: String
  let lastMessageTransport: String   // "api" | "qr" | "smtp" | "ghl_email" | ""
  let messageCount: Int
  let unreadCount: Int
  let hasCommentMessage: Bool
  let hasPrivateDm: Bool
}

struct ContactPhoneNumber: Decodable { let id: String?; let phone: String; let label: String; let isPrimary: Bool; let source: String; let createdAt: String?; let updatedAt: String? }
struct ContactTag: Decodable { let id: String; let name: String; let folderId: String?; let isSystem: Bool; let createdAt: String?; let updatedAt: String? }
struct HiddenContactFilter: Decodable { let id: String; let filterText: String; let matchType: String; let createdAt: String? }
```

Los timestamps llegan como strings ISO-8601 o `YYYY-MM-DD HH:MM:SS` (SQLite);
parsear con tolerancia y comparar por epoch.

---

## 3. Filtros de la bandeja (catálogo completo)

Fuente: `PhoneChat.tsx:507-712, 6187-6458, 8061-8257` y RN
`mobile/src/App.tsx:1061-1113, 17445-17473`.

### 3.1 Rápidos (sección «Rápidos»)

| id | Chip | Regla de coincidencia (client-side) |
|---|---|---|
| `all` | `Todos` (bloqueado, no removible) | Sin filtro. Descripción: «Muestra todas las conversaciones activas.» |
| `unread` | `No leídos` (con contador `unreadTotal`, `99+` si >99) | `unreadCount > 0`. En RN además se fuerza 0 si el último mensaje es saliente (§4.6). «Sólo conversaciones con mensajes pendientes.» |
| `appointments` | `Agendados` | `status=='appointment' \|\| hasAppointments` (RN añade `nextAppointmentDate`). «Contactos con cita guardada.» |
| `customers` | `Clientes` (label custom `customersLabel`) | `status=='customer' \|\| purchases>0` (RN añade `ltv>0`). «Contactos marcados como clientes o con compras.» |
| `leads` | `Leads`/`Interesados` (label custom) | No es customer ni appointment y `status=='lead'`. «Contactos interesados que todavía no son clientes ni citados.» |
| `comments` | `Comentarios` (separador visual antes; tono `info`) | Activa la "lente de comentarios": muestra contactos con `hasCommentMessage` (aunque tengan DM); dentro se sub-filtra por plataforma `Todas/Facebook/Instagram`. Solo visible si comentarios FB o IG están habilitados. |

Regla comentario vs. DM (crítica): un chat "de solo comentarios"
(`hasCommentMessage && !hasPrivateDm`) NUNCA aparece en la vista normal de
mensajes; solo bajo la lente `Comentarios`. Fallback si faltan flags:
`lastMessageType` empieza con `comment` (`PhoneChat.tsx:3945-3963`).

### 3.2 Números de WhatsApp (sección «Números»)

- Solo existen cuando hay >1 número conectado (`chatPhoneFilterEnabled`,
  `PhoneChat.tsx:6187`). Id de chip: `phone:<phoneNumberId>`; label
  `Número: <label|verified_name|teléfono>`.
- Al tocar: guarda `mobile_chat_selected_whatsapp_phone_id=<id>`; tocar
  `Todos`/cualquier filtro no-numérico lo regresa a `'all'`.
- Con filtro activo la carga manda `businessPhoneNumberId` + `businessPhone`
  al backend ANTES de paginar (no filtrar solo localmente), y además aplica un
  filtro local (lastBusinessPhoneNumberId == id o teléfono se parece).
- Si el número guardado ya no existe o solo hay un número → caer a `Todos`
  (evitar bandeja vacía por filtro invisible).

### 3.3 Avanzados (chips `advanced:<grupo>:<valor>`)

Evaluación client-side sobre los campos de la fila
(`contactMatchesPhoneAdvancedFilters`, `PhoneChat.tsx:1585-1600`; heurísticas
de detección en 1499-1575):

| Grupo (sección) | Valores (label) |
|---|---|
| `channel` (Canal) | `whatsapp` WhatsApp · `messenger` Messenger · `instagram` Instagram Direct · `webchat` Webchat / sitio · `sms` SMS · `email` Email |
| `origin` (Origen) | `meta` Meta / red social · `site` Sitio o formulario · `organic` Orgánico / directo · `trigger` Enlace de disparo · `unknown` Sin origen |
| `social` (Red social) | `facebook` · `instagram` · `messenger` · `whatsapp` · `google` · `unknown` Sin red detectada |
| `stage` (Etapa) | `lead` Interesados · `appointment` Con cita · `customer` Clientes (compara contra `status`) |
| `activity` (Actividad) | `payments` Con pagos · `appointments` Con citas · `with_source` Con origen detectado · `no_phone` Sin teléfono |

Solo puede haber UN filtro avanzado activo a la vez (activar uno resetea el
resto a `all`).

### 3.4 Presets condicionales (chips `custom:<filterId>`, sección «Condicionales»)

Guardados en `app_config.mobile_chat_custom_filter_presets`:

```json
[{ "id": "filter_<uuid>", "label": "Mi filtro", "match": "all" | "any",
   "rules": [{ "id": "rule_x", "field": "<key>", "operator": "<op>",
               "value": <string|string[]>, "valueTo": "<string>" }] }]
```

Campos disponibles (`PhoneChat.tsx:6247-6300`): grupo **Chat**
(`chat_segment` select {customers,leads,appointments,unread,comments} ·
`business_phone` select por número · `channel` · `origin` · `social` ·
`activity`), grupo **Contacto** (`full_name`, `phone`, `email`, `status`
select {lead,appointment,customer}, `source`, `unread` boolean), grupo
**Etiquetas y campos** (`tags` tipo tags + cada campo personalizado activo con
key `custom:<identidad>`; number/boolean/select según `dataType`).

Operadores admitidos (`PhoneChat.tsx:537-563`): `is, is_not, contains,
not_contains, starts_with, ends_with, empty, not_empty, eq, neq, gt, lt, gte,
lte, between, before, after, on, last_days, older_days, yes, no, any, all,
none`. Comparaciones de texto con normalización sin acentos; arrays con
any/all/none; números con eq/neq/gt/gte/lt/lte/between (semántica en
`PhoneChat.tsx:1644-1853`). Los presets se evalúan client-side contra la fila.

### 3.5 Estado activo y manager («+»)

- El chip `+` (icono Plus, aria «Más filtros», valor sentinel `__filters_more__`)
  abre el sheet «Filtros» / biblioteca: lista por secciones (Rápidos,
  Números, Canal, Origen, Red social, Etapa, Actividad, Condicionales) con
  botones `Agregar`/`Quitar` que actualizan de inmediato
  `mobile_chat_filter_chip_ids`; permite crear/editar/borrar presets
  condicionales y `Restaurar filtros base`.
- Id de preset activo (`activeChatFilterPresetId`, `PhoneChat.tsx:6452-6458`):
  prioridad `comments` → preset custom → `phone:<id>` → avanzado → quick.
- Al quitar de rápidos el chip activo, o guardar una lista que no lo incluye,
  todo se resetea a `Todos` (incl. número a `'all'`).
- Filtro `agent` existe como valor legacy de `ChatFilter` pero se auto-resetea
  a `'all'` (`PhoneChat.tsx:6852-6856`); las vistas de agente van por otra ruta
  (hub / vista prioritaria).

---

## 4. UX de la bandeja en `/movil` (fuente de verdad) + paridad RN

### 4.1 Estructura de pantalla

1. **Fila de acciones superior** (solo teléfono): botón robot del agente
   (activo si `agentEnabled`) + burbuja de estado del agente (frases rotando
   cada pocos segundos) + acciones del header (nuevo chat `+`, cámara).
   El header de chats NO muestra botón robot duplicado si la fila fija del
   asistente está visible (regla en `docs/MOBILE_APP.md:810-811`).
2. **Título** `Chats` (h1; en iPad/wide puede cambiar según modo lateral).
3. **Buscador** pill: icono lupa, placeholder de búsqueda, botón `X` para
   limpiar. Al escribir ≥1 char los chips se ocultan (`sidebarSearchExpanded`).
4. **Chips de filtros** (`PhoneFilterChips`): scroll horizontal, arrancan al
   margen izquierdo (nunca centrados/cortados), separador vertical antes de
   `Comentarios`, chip activo resaltado, contador en `No leídos`, chip `+` al
   final. En modo lente de comentarios los chips cambian a:
   `Comentarios (tono info, tap = salir)` · `Todas` · `Facebook` · `Instagram` · `+`.
   Ocultos durante selección múltiple.
5. **Lista** con scroll infinito (page size 50; prefetch al acercarse al fondo
   — web: gap 900 px o 3 viewports, `PhoneChat.tsx:206-210,7314-7326`). Footer
   «Cargando más chats…» con spinner mientras pagina.

### 4.2 Orden de filas dentro de la lista

1. Píldora de cache-refresh (si aplica): «Mostrando lo guardado, actualizando
   chats» con spinner.
2. Barra de selección múltiple (si hay selección).
3. **Fila fija `Asistente Personal AI`** — visible si OpenAI configurado +
   `mobile_chat_ai_agent_enabled` + sin selección + sin vista archivados +
   filtro `all` + (sin búsqueda o la búsqueda matchea "asistente personal ai").
   Avatar = isotipo Ristak (`/ristak-icon-192.png`), título
   `Asistente Personal AI`, subtítulo = preview del último mensaje AI (prefijo
   `Tú: ` si fue del usuario; placeholder «Pregúntame lo que necesites de
   Ristak.») o subtítulo fijo si preview apagado; meta = hora + pill `Fijo`.
   Tap → abre el chat del asistente (`/api/ai-agent/chat`). No archivable, no
   seleccionable, sin swipe/long-press.
4. **Filas prioritarias del agente** (`agentPriorityChatRows`): chats con
   `signal` pendiente (status ∉ {human,skipped,discarded}) suben arriba,
   ordenados por `signalAt` desc; solo en filtro `all`, sin archivados abiertos.
   Muestran badge robot en el avatar.
5. **Fila `Archivados`**: visible si `mobile_chat_show_archived` + sin
   selección + no en vista archivados + filtro `all` (web exige además sin
   agentPriorityView; RN exige además sin búsqueda) + (hay chats o archivados).
   Icono archivo + `Archivados` + contador. Tap → vista archivados. Dentro de
   la vista archivados la fila se convierte en `‹ Archivados n` (tap = volver).
6. **Filas de chat** filtradas (§3) y ordenadas: por defecto orden del server
   (fecha último mensaje desc); si `mobile_chat_sort_mode=='unread'`, no leídos
   primero (desc por unreadCount) y fecha como desempate.

### 4.3 Anatomía de la fila de chat

- **Avatar** 48 px (slot 52): foto (`profilePhotoUrl` → `avatarUrl` → `photoUrl`
  → `pictureUrl` → `profile_picture_url`) o iniciales (2 letras: primera de
  nombre y apellido; fallback 2 primeras del label) sobre superficie neutral
  (NUNCA relleno de color de red social). Badge compacto de canal en esquina
  inferior: WhatsApp/Messenger/Instagram/FB-comment/IG-comment/email/sms
  (assets nativos en `mobile/assets/channel-badges/*.webp`; colores de marca:
  whatsapp `#25d366`/`#22c55e`, messenger/fb `#1877f2`, instagram `#d62976`,
  email `#8b5cf6`, sms `#0ea5e9`). Detección del canal: comentario primero,
  luego probe sobre `lastMessageChannel/lastMessageTransport/
  whatsappAttributionPlatform/attribution_session_source/source`
  (`PhoneChat.tsx:3966-4001`; RN `getContactChannelKind`, App.tsx:15751-15762).
  Badge extra de robot si el agente pide acción.
- **Columna principal**: nombre (strong; fallback email → teléfono → «Contacto
  sin nombre») y subtítulo: preview del último mensaje si
  `mobile_chat_show_last_preview`, si no, detalle de contacto (teléfono →
  `@username` → email → «Sin datos de contacto»).
- **Preview** (`getChatPreview`, `PhoneChat.tsx:4689-4699`): texto del último
  mensaje; si vacío, label por tipo: `GIF`, `Foto`, `Video`, `Mensaje de voz`,
  `Documento`, `Ubicación`, `Respuesta rápida`, `Reacción`; fallback por canal
  `Mensaje de Instagram` / `Mensaje de Messenger` / `Mensaje de WhatsApp`.
  Prefijo `Tú: ` si dirección saliente (normalización §4.6).
- **Meta (derecha)**: fecha relativa (§4.5; resaltada si hay no leídos), icono
  campana tachada si silenciado, badge circular de no leídos (`9+` si >9),
  todo omitido si `mobile_chat_show_unread_indicators` off.
- Separador hairline que arranca donde inicia el bloque de texto (no full-bleed
  desde el avatar). Altura táctil amplia. Fila activa resaltada en iPad/wide.

### 4.4 Gestos y acciones de fila

`/movil` (web): swipe izquierda revela `Más` (⋯) y `Archivar/Restaurar`
(ancho fijo, umbrales de apertura/cierre); long-press (contextmenu/touch
~500 ms) entra a selección múltiple con háptico.
**RN/nativo (decisión de producto vigente — usar esta para iOS):** SIN swipe
lateral. Tap abre el chat; long-press dispara háptico y abre el bottom sheet
`Más acciones` (`docs/MOBILE_APP.md:534-539`, checklist L217-225).

**Sheet «Más acciones»** (RN `ChatMoreSheet`, App.tsx:13711-13866; título
`Más acciones`, subtítulo = nombre del contacto):
- Sección `Agente conversacional` (si hay estado/carga de agente):
  `Continuar agente`/`Pausar agente` («El agente vuelve a atender este chat.» /
  «Detiene el agente durante 24 horas.»), y si activo además `Tomar chat`
  («Detiene al agente y deja esta conversación en humano.») y `Omitir agente`
  (destructivo, «El agente no vuelve a tomar este chat hasta reactivarlo.»).
- Sección `Chat`: **`Seleccionar`** (SIEMPRE primera acción de chat; «Activa
  selección múltiple desde esta conversación.») · `Agendar cita` («Crear una
  cita para este contacto.») · `Registrar pagos` («Registrar un cobro para este
  contacto.»; web varía subtítulo si hay pagos avanzados: «Elegir pago único,
  plan o suscripción.» / «Guardar un pago único.») · `Programar mensaje`
  («Elige fecha y hora exacta de envío.») · `Agregar etiqueta` («Clasificar
  este chat con una etiqueta.») · `Silenciar`/`Quitar silencio` («Marca este
  chat como silenciado.» / «Quita la marca de silencio de este chat.»).
- Sección `Bandeja`: `Marcar como leído` (solo si `unread>0`; «Quita los
  pendientes de esta conversación.») · `Archivar chat`/`Restaurar chat`
  («Mueve la conversación a Archivados.» / «Devuelve la conversación a la
  bandeja principal.»).
- El sheet se cierra arrastrando hacia abajo desde la manija/header; el scrim
  hace fade independiente del panel.

**Sheet «Agregar etiqueta»**: buscador «Buscar o crear etiqueta», lista de
etiquetas (GET /contact-tags), fila «Crear "<texto>"» si no existe exacta;
aplicar = `POST /contacts/bulk/tags` con un contacto. Si ya la tiene: aviso
informativo «Etiqueta ya agregada».

### 4.5 Fechas relativas (zona de negocio)

`frontend/src/utils/chatTimestamps.ts` — regla exacta para la lista
(`formatChatListTimestamp`):
- Mismo día de negocio → hora `h:mm a.m./p.m.` (12h, ej. `7:47 p.m.`). NUNCA
  «Hoy» en filas.
- Día anterior → `Ayer`.
- 2–6 días atrás → día de semana capitalizado (`Miércoles`).
- ≥7 días → `4 de julio` (añade ` de 2025` si el año difiere del actual).
  (El RN actual usa formato corto tipo `04-jul` según `docs/MOBILE_APP.md:541-546`;
  el formateador web produce `d de <mes>`. OPEN QUESTION §6-Q8.)

### 4.6 No leídos — reglas de presentación

- El backend manda `unreadCount` por usuario. Regla nativa obligatoria
  (`docs/MOBILE_APP.md:805-807`, RN `getUnreadCount` App.tsx:15727-15730): si
  `lastMessageDirection` es saliente (`outbound, outgoing, sent, business,
  api, app, business_echo, smb_echo, echo, message_echo`), mostrar 0 aunque el
  backend mande >0.
- Al abrir un chat: poner `unreadCount=0` optimista local + `POST
  /contacts/chats/:id/read` (silencioso; si falla no bloquear — el backend
  registra).
- `unreadTotal` (suma de no leídos de chats NO archivados) alimenta el badge
  del dock/tab de Chats.
- Web además mantiene un baseline local (`ristak_phone_chat_read_state_v1`) para
  filas sin `unreadCount` del server — con el backend actual siempre viene, así
  que el cliente nativo puede confiar en el server + regla outbound.

### 4.7 Selección múltiple

Entrada: long-press en fila (háptico) o `Más acciones > Seleccionar`. Durante
selección: chips ocultos; check circular a la izquierda de cada fila; el panel
compacto de selección reemplaza la fila `Archivados` (debajo del asistente).
Controles: conteo seleccionados, `Cancelar`, `Seleccionar visibles` /
`Deseleccionar visibles`, y menú `Más acciones` con:
- `Marcar como leídos` — «Quita pendientes de los chats seleccionados.» → optimista + `POST /contacts/chats/read {contactIds}`.
- `Archivar chats` / `Restaurar chats` — «Mándalos fuera de la bandeja principal.» / «Devuelve estos chats a conversaciones.» (local).
- `Silenciar chats` / `Quitar silencio` (local).
- `Mandar a agente conversacional` → lista de agentes publicados; por cada
  seleccionado `conversational-agent updateState('activate',{agentId})`;
  subtítulo «Atenderá todos los seleccionados.».
El asistente AI y las filas no-chat no son seleccionables. Tap en fila durante
selección = toggle (no abre chat).

### 4.8 Archivados y silenciados

- **Locales al dispositivo** (sin backend). Archivar quita la fila de la
  bandeja normal y del `unreadTotal`; la vista Archivados lista solo esos y ahí
  los filtros rápidos se ignoran (se listan todos los archivados; RN usa filtro
  `all` dentro). Archivar el chat activo cierra su conversación.
- Silenciar solo pinta el icono de campana tachada en la fila (es una marca
  visual; no bloquea push hoy).

### 4.9 Estados de carga / vacío / error / cache

- **Cargando** (sin nada que mostrar): spinner centrado, aria «Cargando chats».
- **Error**: «No se pudieron cargar los chats.» + botón «Intentar otra vez».
- **Búsqueda sin chats** (≥2 chars): spinner «Buscando contactos...» →
  grupo «Contactos encontrados» con resultados de `/contacts/search` (tap crea
  /abre conversación) — filas sin botón de enviar.
- **Vacío total**: icono WhatsApp, «Aún no hay chats», «Toca el botón verde
  para buscar un contacto e iniciar una conversación.», botón `+ Nuevo chat`.
- **Vacío por filtro**: icono burbuja, «No hay chats en este filtro» + «Cambia
  el filtro o busca un contacto para iniciar una conversación.»; variantes:
  archivados «No hay chats archivados»/«Cuando archives una conversación,
  aparecerá en esta sección.» (RN: «No hay nada archivado»/«Los chats que
  archives aparecerán aquí.»), prioritarias «Sin conversaciones prioritarias»,
  general «Cuando llegue un mensaje de WhatsApp, Messenger o Instagram
  aparecerá aquí.».
- **Cache-first (web MOB-007)**: pinta cache diario por
  (tenant, número, tz) al instante + snapshot "fast start" (300 filas máx), y
  dispara UNA recarga silenciosa fusionada; píldora «Mostrando lo guardado,
  actualizando chats». RN aún no replica el estado cache-refresh exacto
  (checklist L242-246).
- **Refresco vivo**: web repolling silencioso (~20 s) fusionando la primera
  página sobre la cola ya cargada (sin colapsar profundidad de scroll);
  RN: intervalo + al volver a foreground + evento de push; pull-to-refresh
  nativo (`RefreshControl`) — en web /movil no hay pull-to-refresh.
- **Paginación**: append por `offset` real de servidor; deduplicar por
  `contact.id` conservando avatares ya hidratados; `hasMore =
  page.length >= 50`; descartar lotes si una recarga movió el offset mientras
  tanto.

### 4.10 Hápticos

- Long-press que entra a selección → háptico de interacción.
- Long-press de globo (conversación) → háptico.
- Independiente de la preferencia de vibración de notificaciones
  (`docs/MOBILE_APP.md:1074-1078`).

---

## 5. Reglas de negocio resumidas (checklist para Swift)

1. Paginación 50; clamp servidor ≤100; sin total: `hasMore = count == limit`.
2. Mandar `warmProfilePictures=true` en la bandeja.
3. Filtro por número: mandar `businessPhoneNumberId` **y** `businessPhone`;
   con filtro activo desaparecen chats Meta/email (así se comporta el backend).
4. Chats de solo-comentario nunca en la vista normal; lente `Comentarios`
   muestra a cualquier contacto con `hasCommentMessage`.
5. `unreadCount` visible = 0 si el último mensaje es saliente.
6. Abrir chat ⇒ optimista a 0 + `POST /chats/:id/read`; masivo ⇒ `POST /chats/read`.
7. Archivar/silenciar = estado local (persistir en el dispositivo, p. ej.
   UserDefaults/SwiftData) — hoy no hay sync backend.
8. Chips visibles y presets condicionales = `app_config`
   (`mobile_chat_filter_chip_ids`, `mobile_chat_custom_filter_presets`);
   número seleccionado = `mobile_chat_selected_whatsapp_phone_id` (regresar a
   `'all'` al tocar filtros no numéricos o si el número ya no existe).
9. Preferencias de bandeja (`mobile_chat_*`) deben afectar la lista viva sin
   reiniciar la app.
10. Fechas SIEMPRE con `account_timezone`.
11. Labels `Clientes`/`Leads`/etiquetas internas se renombran con
    `GET /api/highlevel/custom-labels`.
12. Etiquetas internas (`client/booked/lead`) no se guardan en `contacts.tags`
    ni se pueden crear/editar/borrar (400 del backend).
13. Toda mutación exitosa se confirma con cambio visible en pantalla, no con
    alertas (regla móvil de avisos).
14. Acciones destructivas o errores sí pueden usar alerta.

---

## 6. Gaps / riesgos para iOS nativo

1. **Archivados/silenciados sin backend**: no hay endpoint; multi-dispositivo
   no sincroniza (checklist L203-207 lo deja abierto). Riesgo: iPhone/iPad del
   mismo usuario verán archivados distintos. Decisión pendiente de producto.
2. **RN aún no persiste chips en `app_config`** (usa AsyncStorage). La app
   SwiftUI debería ir directo a `app_config` (`mobile_chat_filter_chip_ids`)
   para paridad con `/movil` — confirmado como objetivo en checklist L195-200.
3. **`/contacts/chats` no devuelve total ni cursores**; con offsets y orden por
   último mensaje, un mensaje nuevo entre páginas puede duplicar/saltar filas.
   Mitigación cliente obligatoria: dedupe por id + merge de página fresca.
4. **Sin realtime push de bandeja**: la lista vive de polling (web ~20 s) +
   evento de push + foreground refresh. Existe `chatEvents.routes.js`
   (SSE/eventos de chat) — evaluar suscripción para la conversación; la bandeja
   hoy no lo usa. OPEN QUESTION: ¿usar SSE para refrescar bandeja en nativo?
5. **Filtros avanzados/custom se evalúan client-side sobre filas ya cargadas**:
   con paginación, un filtro puede mostrar pocos resultados aunque haya más en
   páginas no cargadas (el backend solo filtra `q` y número). Riesgo UX: listas
   "incompletas" — igual que /movil; no inventar filtro server-side.
6. **`nextAppointmentDate` y `firstSession`/`payments[]`** se usan en reglas de
   filtros del cliente pero NO vienen en `/contacts/chats` (solo en
   `/contacts/:id`). En la práctica los filtros caen a `hasAppointments`,
   `ltv`, `purchases`, `source`, `attribution_session_source` que sí vienen.
7. **`hasPrivateDm`/`hasCommentMessage`** solo aplican a Meta; si en el futuro
   hay comentarios de otras redes el flag no distingue plataforma (se infiere
   de `lastMessageChannel`).
8. **OPEN QUESTION formato de fecha ≥7 días**: `chatTimestamps.ts` produce
   `4 de julio`, mientras `docs/MOBILE_APP.md:546` pide `04-jul` para nativo.
   El RN implementa lo segundo. Confirmar cuál quiere Raúl para SwiftUI
   (recomendado: seguir el doc nativo `04-jul`).
9. **OPEN QUESTION silenciar**: hoy es solo marca visual local; no suprime
   push ni unread. ¿Debe la app nativa respetarlo en notificaciones locales?
10. **Vistos externos**: `POST /chats/:id/read` puede tardar por proveedores;
    el cliente no debe esperar (fire-and-forget). El toggle
    `chat_send_read_receipts_enabled` vive en Ajustes > Privacidad.
11. **Comentarios habilitados**: la visibilidad del chip `Comentarios` depende
    de flags de mensajería Meta (`facebookCommentsEnabled` /
    `instagramCommentsEnabled` vía config/estado Meta). En nativo, leer los
    mismos flags (`meta_messenger_messaging_enabled`,
    `meta_instagram_messaging_enabled` en app_config + estado de integración)
    antes de mostrar el chip.
12. **Swipe lateral**: existe en `/movil` web pero fue REMOVIDO por producto en
    nativo; iOS debe usar tap/long-press/sheet, no `swipeActions` de SwiftUI
    para Más/Archivar (regla dura de `docs/MOBILE_APP.md:534-539`).
13. **Bulk read no manda vistos al proveedor** (solo el read individual):
    documentado arriba; no es bug del cliente.
14. **`GET /api/hidden-contacts` POST/DELETE son admin-only**: si la app expone
    gestión de ocultos, gatear por rol; la bandeja solo necesita saber que el
    server ya excluye.

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **RESUELTO — OPEN QUESTION 8 (formato de fecha ≥7 días):** `docs/MOBILE_APP.md:559-560`
   es normativo para nativo y pide fecha corta **`04-jul`** (hoy→hora, ayer→`Ayer`,
   <7 días→día de semana). El formateador web (`frontend/src/utils/chatTimestamps.ts:46-50`)
   produce `4 de julio` deliberadamente distinto para /movil web. La app iOS debe usar
   **`04-jul`** (paridad con RN `format.ts formatChatListDate`).
2. **RESUELTO (hechos) — OPEN QUESTION 4 (SSE para bandeja):** el stream
   `GET /api/chat-events/stream` emite solo `connected` y `chat_message` (verificado en
   `chatLiveEventsService.js`); `/movil` lo usa exactamente para disparar
   `refreshChatInboxNow({contactId})` (recarga REST coalescida), no para pintar datos.
   Precedente claro: iOS puede/debe usar SSE como "nudge" + mantener el polling de 20 s
   como red de seguridad (el stream no tiene replay). Ver doc 11 §2.
3. **CONFIRMADO — §0 (ACL):** `backend/src/routes/contacts.routes.js:47-57` exige
   `contacts` (router.use) **y además** `chat` en `/chats*` y `/:id/linked-social`.
   Un usuario con `chat:'read'` pero `contacts:'none'` recibe 403 también en la bandeja
   (la tabla del doc 13 §3.3 que sugiere "override" está corregida en su propio
   Audit resolutions).
