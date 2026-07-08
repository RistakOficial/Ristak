# 10 — Módulo Ajustes (Settings)

> Spec de investigación para la app nativa SwiftUI (iPhone/iPad, iOS 26).
> Fuentes: `backend/src/routes/config.routes.js`, `backend/src/controllers/configController.js`,
> `backend/src/routes/userConfig.routes.js`, `backend/src/controllers/userConfigController.js`,
> `backend/src/routes/settings.routes.js`, `backend/src/controllers/settingsController.js`,
> `backend/src/routes/aiAgent.routes.js`, `backend/src/controllers/aiAgentController.js`,
> `backend/src/services/aiAgentService.js`, `backend/src/routes/whatsappApi.routes.js`,
> `backend/src/controllers/whatsappApiController.js`, `backend/src/services/whatsappApiService.js`,
> `backend/src/controllers/pushController.js`, `backend/src/config/database.js`,
> `backend/src/middleware/userAccessMiddleware.js`, `backend/src/middleware/openAIConfigMiddleware.js`,
> `frontend/src/pages/PhoneSettings/PhoneSettings.tsx`, `frontend/src/hooks/useAppConfig.ts`,
> `frontend/src/hooks/useUserConfig.ts`, `frontend/src/hooks/usePhoneTheme.ts`,
> `frontend/src/hooks/useAIAgentAvailability.ts`, `mobile/src/App.tsx` (SettingsScreen),
> `mobile/src/api.ts`, `mobile/src/notifications.ts`, `mobile/src/types.ts`, `docs/MOBILE_APP.md`.
> Todo lo no confirmado en código se marca **OPEN QUESTION**.

---

## 1. Resumen ejecutivo

- Ajustes móvil = una pantalla raíz con lista de secciones + paneles hijos. La app RN nativa (referencia principal para iOS) tiene **8 paneles + Cerrar sesión**: `Números de WhatsApp`, `Plantillas`, `Asistente Personal AI`, `Lista de chat`, `Campos personalizados`, `Apariencia`, `Privacidad`, `Notificaciones` (`mobile/src/App.tsx:11828-11889`). El /movil web tiene 6 (sin `Números de WhatsApp` ni `Privacidad`) (`PhoneSettings.tsx:583-627`).
- Dos almacenes de preferencias:
  - **`/api/config`** (tabla `app_config`, **global del tenant**, compartido por todos los usuarios): tema, orden de chats, archivados, vista previa, no leídos, agente en chat, sugerencias IA, número WhatsApp seleccionado, vistos (read receipts), `account_currency`, etc.
  - **`/api/user-config`** (tabla `user_app_config`, **por usuario**, con *fallback* al global): las 7 preferencias de notificaciones push + `mobile_chat_appointment_entry_mode`. Whitelist estricta en backend.
- Valores de config se guardan como **string** (o `null`): el que escribe serializa no-strings con `JSON.stringify`; el que lee parsea booleanos con `['1','true','yes','on']` (`useAppConfig.ts:14-49`, `App.tsx:11258-11282`, `database.js normalizeAppConfigValue:6149`).
- Escribir `/api/config` requiere permiso de módulo **`settings_account` (write)**; leerlo solo requiere sesión. `/api/user-config` self solo requiere sesión (a propósito, para que empleados guarden lo suyo).
- El agente AI (`/api/ai-agent/*`) exige módulo **`ai_agent`**; dictado y pulido de "Descripción del negocio" exigen además OpenAI conectado (409 `needsOpenAIConfig`/`needsReconnect`).
- Números y plantillas de WhatsApp se leen de `/api/whatsapp-api/status` y `/api/whatsapp-api/templates`; el número "Principal" se cambia con `POST /api/whatsapp-api/phone-numbers/default`.
- Zona horaria de cuenta: `GET/POST /api/settings/timezone` (IANA, gate `settings_account`).

---

## 2. Endpoints

Convención: éxito `{ "success": true, ... }`; error `{ "success": false, "error": "<mensaje ES>" }` (+ `code` en gates). El cliente RN desenvuelve `{success, data}` automáticamente.

### 2.1 Configuración global — `/api/config`

Todas con `Authorization: Bearer <jwt>` (`config.routes.js:15`).

| Método | Path | Gate | Descripción |
|---|---|---|---|
| GET | `/api/config` | solo auth | Toda la config o keys específicas |
| GET | `/api/config?keys=k1,k2` | solo auth | Solo esas keys (separadas por coma) |
| POST | `/api/config` | `settings_account` write | Guarda 1 o N keys |
| DELETE | `/api/config?keys=k1,k2` | `settings_account` write | Borra keys |

**GET** respuesta (`configController.js:37-76`):
```json
{ "success": true, "config": { "mobile_chat_sort_mode": "recent", "mobile_chat_theme_preference": "dark" } }
```
- Cada valor es `string | null`. Keys pedidas que no existen vienen como `null`.
- Keys **sensibles** (regex `/(private_key|secret|password|api_token|access_token|refresh_token|service_account|client_secret|webhook_secret)/i`) siempre devuelven `null` (`configController.js:4,24-26`).

**POST** body — dos modos (`configController.js:113-157`):
```json
{ "key": "mobile_chat_sort_mode", "value": "unread" }
```
```json
{ "config": { "mobile_chat_show_archived": "true", "mobile_chat_sort_mode": "recent" } }
```
- Respuesta: `{ "success": true, "message": "Configuración guardada exitosamente", "socialHistoryBackfill": { "syncStarted": false, "started": [], "skipped": [] } }` (el campo `socialHistoryBackfill` existe porque activar `meta_messenger_messaging_enabled` / `meta_instagram_messaging_enabled` dispara backfill de historial Meta — irrelevante para Ajustes móvil pero presente en la respuesta).
- 400 si no llega ni `key`+`value` ni `config`: `{"success":false,"error":"Se requiere \"key\" y \"value\", o \"config\" con un objeto"}`.
- **IMPORTANTE**: `value` se guarda tal cual llega. El cliente debe serializar: strings sin tocar, booleanos/objetos/arrays como `JSON.stringify(value)` (el hook web manda `"true"`/`"false"`; el RN manda booleanos crudos que el backend `JSON.stringify`-ea a `"true"`; ambos parsean igual al leer).
- Side effect: guardar `meta_test_event_code` estampa también `meta_test_event_code_set_at` (`configController.js:87-92`).

**DELETE** respuesta: `{ "success": true, "message": "Configuraciones eliminadas exitosamente" }`; 400 sin `keys`.

### 2.2 Configuración por usuario — `/api/user-config`

(`userConfig.routes.js`, `userConfigController.js`) — MOB-006.

| Método | Path | Gate | Descripción |
|---|---|---|---|
| GET | `/api/user-config` `?keys=k1,k2` | solo auth (self) | Lee las claves del propio usuario con fallback al global |
| POST | `/api/user-config` | solo auth (self) | Guarda claves propias (whitelist) |
| GET | `/api/user-config/admin` `?userId=` | `requireAdmin` | Config efectiva de todo el equipo |
| PATCH | `/api/user-config/admin/:userId` | `requireAdmin` | Admin escribe/limpia overrides de otro usuario |

**Whitelist exacta** (`userConfigController.js:19-28`) — cualquier otra clave da 400 `Clave no permitida: <key>`:
1. `calendar_push_notifications_enabled`
2. `appointment_confirmation_push_notifications_enabled`
3. `chat_push_notifications_enabled`
4. `payment_push_notifications_enabled`
5. `push_notification_sound_enabled`
6. `push_notification_vibration_enabled`
7. `calendar_push_notification_calendar_ids` (JSON array de strings serializado)
8. `mobile_chat_appointment_entry_mode` (valores `form` | `calendar`; lo escribe el sheet de citas del chat, no la pantalla Ajustes)

- **GET self**: sin `?keys` devuelve toda la whitelist. No-admin solo recibe claves whitelisteadas aunque pida otras. Respuesta `{ "success": true, "config": { "<key>": "<string|null>" } }`. **Fallback**: si el usuario no tiene fila propia, devuelve el valor global de `app_config` (`database.js getUserAppConfig:6162-6174`).
- **POST self**: mismos 2 modos que `/api/config` (`{key,value}` o `{config:{...}}`). SIEMPRE escribe con `req.user.userId`; nunca acepta `user_id` del body. Respuesta `{ "success": true, "message": "Preferencia guardada" }` (o "Preferencias guardadas").
- **GET admin** respuesta: `{ success, globals: { "<key>": valor }, users: [{ userId: "3", username, fullName, email, role, config: { "<key>": { value, isOverride } } }] }`. `calendar_push_notification_calendar_ids` viene parseada como array.
- **PATCH admin** body `{ "config": { "<key>": valor | null } }` — `null` borra el override (vuelve a heredar el global). Respuesta `{ success, config: { "<key>": { value, isOverride } } }`. 400 `userId inválido`, 404 `Usuario no encontrado`.

### 2.3 Zona horaria — `/api/settings/timezone`

(`settings.routes.js:64-67`, `settingsController.js:24-98`). Gate `settings_account` (GET=read, POST=write).

- **GET** → `{ "success": true, "timezone": "America/Mexico_City", "source": "ristak" | "highlevel" }`. Prioridad: override en `app_config.account_timezone` > HighLevel > default `America/Mexico_City` (`dateUtils.js:6,14`).
- **POST** body `{ "timezone": "America/Monterrey" }` → valida IANA con `Intl.DateTimeFormat`; 400 `Zona horaria inválida: <tz>`. Enviar `null`/`""`/omitir limpia el override y responde con la zona resuelta y `source: "highlevel"`.
- El cliente RN la lee vía `api.getTimezone()` (`mobile/src/api.ts:1062-1064`) para formateo de fechas; no hay UI para cambiarla en Ajustes móvil.

### 2.4 Campos personalizados (solo lectura en móvil)

El móvil (RN y /movil) usa el endpoint de contactos, **no** el de `/api/settings`:

| Método | Path | Gate | Uso móvil |
|---|---|---|---|
| GET | `/api/contacts/custom-fields?includeArchived=true` | auth (módulo contactos) | Sí — lista catálogo (`mobile/src/api.ts:1096-1102`, `contactsService.ts:436`) |
| GET | `/api/settings/custom-fields?includeArchived=true` | `settings_custom_fields` | Solo desktop; devuelve `{ data: { folders, fields } }` |
| POST/PUT/DELETE | `/api/settings/custom-fields*`, `/custom-field-folders*` | `settings_custom_fields` | Solo desktop (crear/editar) |

**GET /api/contacts/custom-fields** (`contactsController.js:2114-2133`): query `includeArchived` (`'true'` literal). Respuesta `{ "success": true, "data": [ContactCustomFieldDefinition] }`.

`ContactCustomFieldDefinition` (shape completo del backend, `contactCustomFieldDefinitionsService.js mapDefinition:213-251`):

| Campo | Tipo | Notas |
|---|---|---|
| `definitionId` | string | id fila |
| `key`, `fieldKey` | string | mismo valor (`field_key`) |
| `label`, `name` | string | mismo valor |
| `description` | string | puede ser `''` |
| `dataType` | string | default `'text'` (otros: number, date, select, etc.) |
| `options` | array | parseado de JSON, default `[]` |
| `folderId` | string | `''` si no hay |
| `folderName` | string | `''` si no hay; la UI agrupa por esto con fallback "Campos personalizados" |
| `fieldGroup` | string | default `'general'` |
| `syncTarget` | string | `'none'` (system) / `'local'` / ... |
| `sourceType` | string | `'system'` / `'manual'` / ... |
| `sourceId..sourceLabel`, `sourceContext` | string/null | metadatos de origen |
| `ownerUserId` | number\|null | |
| `archived` | boolean | la UI móvil filtra `!archived` |
| `system`, `systemManaged`, `locked` | boolean | campos de sistema no editables |
| `editable`, `deletable` | boolean | |
| `sources` | array | (en algunas respuestas) |
| `createdAt`, `updatedAt` | string\|null | |

El tipo RN reducido usa solo: `definitionId?, key?, fieldKey?, label?, name?, dataType?, folderName?, archived?` (`mobile/src/types.ts:857-866`) — suficiente para la pantalla.

### 2.5 Agente AI — `/api/ai-agent`

(`aiAgent.routes.js`). Gates: `requireAuth` + `requireModuleAccess('ai_agent')` en TODO el router; además `requireOpenAIConfigured` en `business-context-answer`, `transcribe`, `chat`, `agents`, `runs`.

| Método | Path | Extra | Descripción |
|---|---|---|---|
| GET | `/api/ai-agent/config` | — | Estado/config del agente |
| POST | `/api/ai-agent/config` | — | Guarda API key OpenAI y/o contexto |
| DELETE | `/api/ai-agent/config/token` | — | Borra solo el token OpenAI |
| DELETE | `/api/ai-agent/config` | — | Borra toda la config del agente |
| POST | `/api/ai-agent/business-context-answer` | OpenAI | Pulir + guardar contexto de negocio |
| POST | `/api/ai-agent/transcribe` | OpenAI | Transcribir audio (voz→texto) |
| POST | `/api/ai-agent/chat` | OpenAI | Chat con el agente (spec del módulo chat) |
| GET | `/api/ai-agent/agents` | OpenAI | Categorías de agentes |
| GET | `/api/ai-agent/runs/:traceId` | OpenAI | Rastro de ejecución |

**GET /config** → `{ success, data: AIAgentConfigStatus }` (`aiAgentService.js getAIAgentStatus:17390-17443`):

| Campo | Tipo | Notas |
|---|---|---|
| `configured` | boolean | true si hay API key desencriptable |
| `credentialStatus` | `'missing' \| 'ready' \| 'reconnect_required'` | |
| `needsReconnect` | boolean | true si el token guardado no se puede desencriptar |
| `connectionIssue` | string\|null | mensaje |
| `connectionIssueCode` | string\|null | ej. código de reconexión |
| `model` | string | modelo normalizado |
| `tokenPreview` | string\|null | key enmascarada, o `'Requiere reconexión'` |
| `businessContext` | string | contexto unificado; **sentinela de vacío**: `"No se proporcionaron detalles del negocio."` — la UI lo mapea a `''` (`PhoneSettings.tsx:66-79`, `App.tsx:6816-6819`) |
| `businessProfile` | object? | `{ configured?, status?, extractionStatus?, extractionError?, summary?, businessName?, industry?, businessType?, profile?, promptParameters?, updatedAt? }` |
| `marketContext`, `idealCustomer`, `locationContext`, `competitorsContext`, `brandVoice`, `actionCustomizations` | string | siempre `''` en el estado actual (legacy unificado en `businessContext`) |
| `researchDomains` | string | |
| `responseStyle` | `'direct' \| 'balanced' \| 'advisor'` | |
| `recommendationMode` | `'on_request' \| 'when_useful' \| 'proactive'` | |
| `webSearchEnabled` | boolean | |
| `updatedAt` | string\|null | |

**POST /config** body (todos opcionales; el móvil solo manda `{ apiKey }` para conectar OpenAI — `App.tsx:11527-11538`, `api.ts:1108-1113`):
`{ apiKey?, model?, businessContext?, marketContext?, idealCustomer?, locationContext?, competitorsContext?, brandVoice?, actionCustomizations?, researchDomains?, responseStyle?, recommendationMode?, webSearchEnabled? }`
- Validación: si `apiKey` viene y no empieza con `sk-` → 400 `El API Token de OpenAI no tiene un formato válido`. Si viene, se verifica contra OpenAI; inválida → 400 `API Token de OpenAI inválido` (`aiAgentController.js:59-79`).
- Respuesta: `{ success, message: "Agente AI configurado correctamente", data: AIAgentConfigStatus }`.

**POST /business-context-answer** body:
```json
{ "field": "businessContext", "answer": "<texto crudo del usuario>" }
```
- `field` ∈ `businessContext | marketContext | idealCustomer | locationContext | competitorsContext | brandVoice` (`aiAgentService.js:17295-17327`); el móvil siempre usa `businessContext`.
- El backend refina el texto con OpenAI (instrucciones de editor, máx 900 tokens de salida); si OpenAI falla, guarda el texto crudo limpio (límite 50 000 chars). Respuesta: `{ success, message: "Contexto del negocio redactado y guardado", data: { field, text, status: AIAgentConfigStatus } }`.
- Errores: 409 con `needsOpenAIConfig: true` (falta API key) o `needsReconnect: true` (credencial rota); 400 `Escribe una respuesta para guardar el contexto` / `Campo de contexto del negocio no válido`.

**POST /transcribe** — dos formas de body (`aiAgent.routes.js:9-36`):
1. `multipart/form-data` con campo `audio` (límite 25 MB → 413 `El audio es demasiado pesado.`).
2. **Raw binary** con `Content-Type: audio/*` (o `video/webm`, `application/octet-stream`), límite `25mb`. La app RN usa esta forma: sube el m4a con `Content-Type: audio/m4a` como cuerpo binario (`api.ts:1136-1174`). **Recomendada para iOS nativo.**
- Backend manda a OpenAI `audio/transcriptions` con `language=es` y prompt de negocio mexicano (`aiAgentService.js:17742-17788`).
- Respuesta: `{ success, data: { text: string, model: string } }`. Errores: 400 `Envía audio para transcribir`, `No se detectó texto...` viene del cliente; `OpenAI no devolvió texto para este audio.` del backend; 409 OpenAI (ver arriba).

**DELETE /config/token** → `{ success, message: "Token de OpenAI eliminado correctamente", data: AIAgentConfigStatus }`.
**DELETE /config** → `{ success, message: "Agente AI desconectado correctamente" }` (borra `ai_agent_config`, `ai_business_profile` y preferencias del usuario).

### 2.6 WhatsApp: estado, números y plantillas — `/api/whatsapp-api`

(`whatsappApi.routes.js`). Todo tras `requireAuth`; **sin gate de módulo** (excepto `POST /contacts/profile-pictures/backfill` que exige `settings_whatsapp`).

| Método | Path | Uso en Ajustes |
|---|---|---|
| GET | `/api/whatsapp-api/status` | Números + estado conexión (panel Números; también fallback de plantillas en /movil) |
| POST | `/api/whatsapp-api/refresh` | Botón "Actualizar" del panel Números (re-sincroniza con YCloud y devuelve status) |
| POST | `/api/whatsapp-api/phone-numbers/default` | "Hacer principal" |
| GET | `/api/whatsapp-api/templates?status=&limit=` | Panel Plantillas |

**GET /status** → `{ success, data: WhatsAppApiStatus }` (`whatsappApiService.js:3771-3919`). Campos relevantes para Ajustes:

| Campo | Tipo | Notas |
|---|---|---|
| `provider` | `'ycloud'` | fijo |
| `activeProvider` | `'ycloud' \| 'meta_direct'` | |
| `source` | `'WhatsApp_API'` | |
| `connected` | boolean | `enabled && hasApiKey` |
| `configured` | boolean | `hasApiKey` |
| `requiresPhoneSelection` | boolean | siempre `false` hoy |
| `status` | `'connected' \| 'needs_phone' \| 'disabled' \| 'disconnected'` | |
| `credentials` | `{ apiKeyMasked: '••••••••'\|'' , hasApiKey: bool }` | |
| `sender` | `{ phone, phoneNumberId, wabaId }` (strings, `''` si vacío) | remitente default |
| `webhook` | `{ id, url, status, enabledEvents: string[] }` | |
| `phoneNumbers` | `WhatsAppApiPhoneNumber[]` | ver abajo; orden: default primero, luego `updated_at` desc |
| `selectedPhone` | `WhatsAppApiPhoneNumber \| null` | resuelto por configId → senderPhone → default → primero |
| `needsDefaultSelection` | boolean | true si hay >1 número y ninguno default |
| `pendingRestores` | `[{ phoneNumberId, phone, verifiedName, contactCount }]` | contingencia QR |
| `balance` | `{ amount: number, currency?, updated_at? }` | saldo YCloud |
| `templates` | `{ total, approved, blocked, items: WhatsAppApiTemplate[] }` | items limit 12 |
| `alerts` | `{ total, critical, highestSeverity, items: WhatsAppApiAlert[] }` | |
| `qr` | `{ consentText, sessions, drip }` | respaldo WhatsApp Web |
| `metaDirect` | objeto grande | conexión directa Meta (no usado en Ajustes móvil) |
| `stats`, `timestamps`, `lastError` | | |

**`WhatsAppApiPhoneNumber`** (fila DB en snake_case + `availability` calculada; `whatsappApiService.js getPhoneNumbersFromDb:3334-3345`, `:3794-3809`; tipo TS `frontend/src/services/whatsappApiService.ts:3-27`):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | phoneNumberId (YCloud/Meta) o hash `waqr_phone` |
| `waba_id` | string\|null | |
| `phone_number` | string\|null | E.164 normalizado |
| `display_phone_number` | string\|null | |
| `verified_name` | string\|null | |
| `provider` | `'ycloud' \| 'meta_direct' \| 'qr'` | |
| `profile_picture_url` | string\|null | |
| `business_profile_json` | string\|null | JSON serializado |
| `quality_rating` | string\|null | |
| `messaging_limit` | string\|null | |
| `status` | string\|null | ej. `CONNECTED`, `QR_ONLY` |
| `label` | string\|null | alias editable |
| `is_default_sender` | 0/1 (número) | la UI lo trata como truthy |
| `api_send_enabled`, `qr_send_enabled` | 0/1 | |
| `qr_consent_accepted_at`, `qr_consent_accepted_by` | string\|null | |
| `qr_status` | string\|null | `connected`, `disconnected`, ... |
| `qr_connected_phone` | string\|null | |
| `qr_last_connected_at`, `qr_last_disconnected_at`, `qr_last_error` | string\|null | |
| `updated_at` | string | |
| `availability` | `{ apiAvailable: bool, apiReason: string, qrReady: bool, available: bool }` | calculado por request |

**POST /phone-numbers/default** body `{ "phoneNumberId": "<id>" }` → devuelve `{ success, data: WhatsAppApiStatus }` completo (útil para refrescar la pantalla). Errores 400: `Elige el número que quieres dejar como principal`, `Ese número de WhatsApp no está conectado`. Side effects: marca `is_default_sender` exclusivo y actualiza `app_config` sender (`whatsappApiService.js:2572-2600`).

**GET /templates** query: `status` (opcional, se normaliza a MAYÚSCULAS; ej. `APPROVED`), `limit` (1–200, default 100). La pantalla Ajustes llama **sin** `status` (RN pasa `null` → param omitido) para ver todas; el composer de chat usa `status=APPROVED`. Antes de responder ejecuta `ensureDefaultTemplatesForWhatsAppApi` (best-effort). Respuesta:
```json
{ "success": true, "data": { "total": 8, "approved": 5, "blocked": 3, "items": [WhatsAppApiTemplate] } }
```

**`WhatsAppApiTemplate`** (`whatsappApiService.js mapTemplateRow:3455-3481`):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | id YCloud |
| `official_template_id` | string\|null | |
| `waba_id` | string\|null | |
| `name` | string | nombre para mostrar (prefiere el local) |
| `official_name` | string | nombre real en Meta |
| `local_template_id` | string\|null | id de plantilla local vinculada |
| `language` | string | ej. `es_MX` |
| `category`, `sub_category`, `previous_category` | string\|null | |
| `message_send_ttl_seconds` | number\|null | |
| `status` | string\|null | `APPROVED`, `PENDING`, `IN_REVIEW`, `IN_APPEAL`, `REJECTED`, `PAUSED`, `DISABLED`, ... |
| `quality_rating` | string\|null | |
| `reason` | string\|null | motivo de rechazo/bloqueo |
| `status_update_event` | string\|null | |
| `disable_date` | string\|null | |
| `components` | `Array<{type, text, ...}>` | parseado de JSON; el preview de UI toma el componente `type==='BODY'`.`text` |
| `ycloud_create_time`, `ycloud_update_time`, `created_at`, `updated_at` | string\|null | |

Nota: el CRUD de plantillas (crear, editar, enviar a revisión, sync) vive en `/api/settings/message-templates*` con gate `settings_whatsapp` (`settings.routes.js:100-118`) — **solo desktop**; el móvil es solo lectura de estados.

### 2.7 Push nativo — `/api/push` (lo que usa el botón "Activar")

| Método | Path | Gate | Descripción |
|---|---|---|---|
| GET | `/api/push/public-key` | público | Config pública de push |
| POST | `/api/push/mobile-devices` | auth | Registra token APNs/FCM del dispositivo |
| DELETE | `/api/push/mobile-devices` | auth | Apaga el dispositivo (`{token}`); 403 `FORBIDDEN` si el token es de otro usuario |

- **GET /public-key** → `{ success, data: { configured: bool, publicKey: string, nativeConfigured?: bool, androidConfigured?: bool, iosConfigured?: bool } }`. En iOS, si `iosConfigured !== true` la app muestra "Las notificaciones de iPhone todavía no están preparadas para esta instalación." (`mobile/src/notifications.ts:54-65`).
- **POST /mobile-devices** body (`mobile/src/types.ts:960-968`): `{ token: string, platform: 'ios'|'android', calendarIds?: string[], appVersion?: string, appBuild?: string, deviceModel?: string, osVersion?: string }` → `201 { success, data: { id?, enabled?, calendarIds? } }`; 400 con mensaje si es rechazado.
- Flujo de suscripción nativa (`notifications.ts subscribeToNativePushNotifications:195-267`): (1) leer public-key y validar `iosConfigured`; (2) pedir permiso al SO (alert+badge+sound); (3) obtener **device push token nativo** (APNs, no Expo token); (4) `POST /push/mobile-devices` con `calendarIds` = `calendar_push_notification_calendar_ids` si `calendar_push_notifications_enabled`, si no `[]`. Resultados: `subscribed | not_supported | not_configured | denied` con `reason` en español.
- El filtrado real (qué push llega según toggles chat/citas/pagos, sonido, vibración) lo hace el backend leyendo el user-config; el detalle es del módulo push/realtime.

---

## 3. Catálogo exacto de claves de configuración

### 3.1 `app_config` (global, `/api/config`) — leídas/escritas por Ajustes

| Key | Tipo lógico | Default UI | Quién la usa |
|---|---|---|---|
| `mobile_chat_ai_agent_enabled` | bool | `true` | Toggle "Mostrar como primer chat" (agente fijo arriba de la bandeja) |
| `mobile_chat_ai_reply_suggestions_enabled` | bool | `false` | Toggle "Sugerir respuestas" |
| `mobile_chat_show_archived` | bool | `true` | Toggle "Mostrar archivados" |
| `mobile_chat_sort_mode` | `'recent' \| 'unread'` | `'recent'` | Segmented "Ordenar conversaciones" |
| `mobile_chat_show_last_preview` | bool | `true` | Toggle "Vista previa" |
| `mobile_chat_show_unread_indicators` | bool | `true` | Toggle "Indicadores de no leídos" |
| `mobile_chat_theme_preference` | `'system' \| 'light' \| 'dark' \| 'auto'` | `'system'` | Panel Apariencia |
| `mobile_chat_selected_whatsapp_phone_id` | string (`'all'` o phoneNumberId) | `'all'` | Panel Números: bandeja "Juntos"/"Separado" (solo RN nativo) |
| `chat_send_read_receipts_enabled` | bool | `true` | Panel Privacidad (solo RN nativo): vistos externos |
| `default_calendar_id` | string | `''` | Solo lectura en /movil para ordenar la lista de calendarios |
| `account_currency` | string ISO-4217 | `'MXN'` | Moneda de cuenta (leída por Pagos/Analíticas; editable solo en desktop) |
| `account_timezone` | string IANA | — | NO se lee directo: usar `/api/settings/timezone` |

Claves relacionadas del módulo chats (mismas tablas, documentadas aquí por completitud): `mobile_chat_filter_chip_ids`, `mobile_chat_custom_filter_presets` (docs/MOBILE_APP.md:726,745).

### 3.2 `user_app_config` (por usuario, `/api/user-config`)

| Key | Tipo lógico | Default UI | Control |
|---|---|---|---|
| `chat_push_notifications_enabled` | bool | `true` | Toggle "Mensajes del chat" |
| `calendar_push_notifications_enabled` | bool | `false` | Toggle "Citas agendadas" |
| `appointment_confirmation_push_notifications_enabled` | bool | `true` | Toggle "Citas confirmadas" |
| `payment_push_notifications_enabled` | bool | `true` | Toggle "Pagos" |
| `push_notification_sound_enabled` | bool | `true` | Toggle "Timbre de notificación" |
| `push_notification_vibration_enabled` | bool | `true` | Toggle "Vibración de notificación" |
| `calendar_push_notification_calendar_ids` | string[] (JSON) | `[]` (= todos) | Chips "Calendarios con alertas"; `[]` significa **Todos** |
| `mobile_chat_appointment_entry_mode` | `'form' \| 'calendar'` | `'form'` | Escrito por el sheet de citas del chat (no en Ajustes) |

**Los defaults son del cliente**: el backend devuelve `null` si nadie ha guardado nada (ni override ni global); el cliente aplica el fallback local. Los defaults de arriba son los que usan idéntico /movil (`PhoneSettings.tsx:131-144`) y RN (`App.tsx:11665-11680`).

### 3.3 Parseo de valores (regla obligatoria para Swift)

- Al **leer**: todo llega como `String?`. Booleano verdadero si lowercase ∈ `{"1","true","yes","on"}`; falso si ∈ `{"0","false","no","off",""}`; si `null`/ausente → default (`useAppConfig.ts:33-37`, `App.tsx:11258-11266`). Arrays: `JSON.parse` del string, filtrando no-strings; si falla → default.
- Al **escribir**: mandar strings tal cual; booleans/arrays como JSON (`"true"`, `"[\"id1\"]"`). El backend guarda `null` o string (`normalizeAppConfigValue`, `database.js:6149-6155`).
- Escrituras en la UI son **optimistas con rollback**: RN actualiza el estado local, hace el POST, y si falla revierte al valor previo y muestra `Alert('No se guardó el ajuste', <msg|'Intenta otra vez.'>)` (`App.tsx:11632-11662`). /movil muestra toast `('error','No se guardó el ajuste','Intenta otra vez.')`.
- Mientras se guarda una key, su control se deshabilita (`savingKey === key` en RN).

---

## 4. Reglas de negocio, validaciones y permisos

1. **Gate de escritura global**: `POST/DELETE /api/config` exige módulo `settings_account` nivel write; un empleado sin ese permiso recibe 403 `{ success:false, code:'write_access_required', module:'settings_account', error:'No tienes permiso para cambiar información en esta sección.' }` (`userAccessMiddleware.js:15-32`). GET solo requiere sesión. Implicación UX: los toggles "globales" (lista de chat, tema, agente, privacidad, número seleccionado) pueden fallar con 403 para empleados — hoy la UI solo muestra el alert genérico de rollback. Los permisos efectivos del usuario llegan en el login/access (ver spec 02).
2. **User-config self sin gate**: cualquier usuario autenticado guarda SUS claves de notificaciones (whitelist). Claves fuera de whitelist → 400 `Clave no permitida: <key>`.
3. **Herencia**: valor efectivo por usuario = override propio ?? global ?? default de cliente. El admin puede fijar/limpiar overrides de terceros vía PATCH admin.
4. **Agente AI**: todo `/api/ai-agent` exige módulo `ai_agent` (403 igual que arriba). `transcribe`/`business-context-answer` devuelven 409 con `needsOpenAIConfig: true` (code `OPENAI_*`) si no hay API key o `needsReconnect: true` (code `OPENAI_CREDENTIAL_RECONNECT_REQUIRED`) si el token guardado ya no desencripta (`openAIConfigMiddleware.js`, `aiAgentController.js:17-43`).
5. **AI "listo"**: la UI considera el agente usable con `configured === true && !needsReconnect`. Con `needsReconnect` los textos cambian a "Reconecta OpenAI…". Los toggles de agente se muestran **apagados y deshabilitados** si no está listo (checked = `aiReady && flag`).
6. **Toggle dependiente**: "Sugerir respuestas" se deshabilita si el agente no está listo **o** si "Mostrar como primer chat" está apagado (`PhoneSettings.tsx:751`, `App.tsx:12531`).
7. **Citas agendadas + un solo calendario**: al encender `calendar_push_notifications_enabled`, si hay exactamente 1 calendario activo y `calendar_push_notification_calendar_ids` está vacío, se auto-selecciona ese calendario (`PhoneSettings.tsx:340-345`, `App.tsx:11757-11765`).
8. **Chips de calendario**: tocar un chip agrega/quita su id del array; "Todos los calendarios" escribe `[]`. El contador muestra `N seleccionados` si hay selección explícita, si no `Todos`. Solo calendarios con `isActive !== false` (vía `GET /api/calendars`, spec del módulo calendarios).
9. **Plantillas**: estados bloqueados = `{REJECTED, PAUSED, DISABLED}`. Etiquetas ES: `APPROVED`→"Aprobada", `PENDING`/`IN_REVIEW`→"En revisión", `REJECTED`→"Rechazada", `PAUSED`/`DISABLED`→"Bloqueada", `UNKNOWN`→"Sin estado", otro→literal. Preview = texto del componente `BODY`, si no `reason`, si no "Sin vista previa.". Si bloqueada, muestra `reason || status_update_event || 'Meta no permite usar esta plantilla por ahora.'`.
10. **Plantillas fallback**: si `GET /templates` devuelve 0 items, la UI usa `status.templates.items` del payload de `/status` (limit 12). En /movil ambos requests van en paralelo; en RN el fallback usa el status ya cargado (`PhoneSettings.tsx:278-295`, `App.tsx:11540-11558`).
    - OJO paridad: /movil llama `whatsappApiService.getTemplates()` cuyo **default es `status=APPROVED`** (`whatsappApiService.ts:647`); RN llama con `null` (todas). Para iOS conviene replicar RN (`null`) que es lo que hace útil el contador de "necesitan revisión".
11. **Número principal**: el botón "Hacer principal" se deshabilita si ya es default o mientras hay un cambio en curso; al éxito se reemplaza todo el `whatsappStatus` con la respuesta.
12. **Bandeja Juntos/Separado (solo RN)**: "Juntos" escribe `mobile_chat_selected_whatsapp_phone_id='all'`; "Separado" escribe el id del número ya seleccionado o el default; si no hay número → `Alert('Números de WhatsApp','No hay un número disponible para separar la bandeja.')`. El botón "Usar"/"En chats" de cada fila selecciona ese número para la bandeja.
13. **Privacidad / vistos** (`chat_send_read_receipts_enabled`, solo RN): apagarlo hace que Ristak limpie no-leídos internamente pero **no** envíe read receipts/mark-seen a WhatsApp API, WhatsApp QR, Messenger o Instagram (docs/MOBILE_APP.md:1069-1072).
14. **Descripción del negocio**: botón "Guardar" habilitado solo si `aiReady && !busy && !recording && draftTrim != savedTrim && draftTrim != ''`. Guardar siempre pasa por `business-context-answer` (pulido IA); el texto devuelto reemplaza el draft y el guardado. El sentinela `"No se proporcionaron detalles del negocio."` nunca debe mostrarse como texto editable.
15. **Dictado por voz**: requiere `aiReady`, permiso de micrófono y estado `idle`. Flujo: grabar (m4a en RN vía expo-audio HIGH_QUALITY) → detener → `POST /transcribe` (binario `audio/m4a`) → si `text` no vacío → `business-context-answer` con el transcript → actualizar draft/saved. Mensajes de estado en orden: `'Grabando... toca detener cuando termines.'` → `'Transcribiendo audio...'` (RN) / `'Preparando audio...'`+`'Transcribiendo audio...'` (/movil) → `'Puliendo y guardando...'` → `'Guardado.'`. Errores: `'No se detectó texto en el audio.'`, `'No pude transcribir el audio.'`, `'Micrófono bloqueado'`, `'Este celular no permitió usar el micrófono.'`.
16. **Conectar OpenAI desde el móvil** (solo RN): si `!aiReady`, el panel Agente muestra un TextInput seguro "Pega tu API key de OpenAI (sk-...)" + botón "Conectar OpenAI"/"Conectando…" que hace `POST /ai-agent/config {apiKey}` y refresca el estado; error → `Alert('OpenAI', msg)` (`App.tsx:12302-12316,12454-12471`).
17. **Tema**: resolución de tono: `light`/`dark` literal; `auto` = oscuro si hora local ≥ 19 o < 6; `system` = apariencia del SO (fallback a horario si no legible, caso web). Meta-etiqueta de la fila Apariencia: `'Claro'`, `'Noche'`, `'Horario: <Claro|Noche>'`, `'Sistema: <Claro|Noche>'`. Al cambiar, el shell nativo re-renderiza colores, fondo de sistema y barra de estado inmediatamente (`App.tsx:11305-11352`, `usePhoneTheme.ts`). Valor inválido en config → tratar como `system`.
18. **Logout**: /movil usa confirm modal ("Cerrar sesión" / "¿Seguro que quieres cerrar tu sesión en este dispositivo?" / botones "Cerrar sesión"+"Cancelar"); RN usa Alert con 3 acciones: `Cancelar`, `Cambiar app` (cambia de tenant/servidor), `Cerrar sesión` (destructive), y el mensaje incluye `<nombre> · <baseUrl>` (`App.tsx:11707-11717`).
19. **Claves sensibles**: aunque un GET general de `/api/config` regrese todo el tenant, las keys que matchean el patrón sensible llegan `null`. No usar `/api/config` para leer secretos.

---

## 5. Inventario UX

### 5.1 App nativa RN (`mobile/src/App.tsx` SettingsScreen:11429-12264) — referencia para iOS

**Carga inicial** (al montar la pestaña Ajustes): en paralelo `GET /api/config?keys=<SETTINGS_APP_CONFIG_KEYS>` y `GET /api/user-config?keys=<SETTINGS_USER_CONFIG_KEYS>` (listas exactas en `App.tsx:885-904`); además `GET /ai-agent/config`, `GET /calendars`, `GET /whatsapp-api/status` y permiso push nativo. Estado de pantalla: `SectionState` con spinner / error + botón reintentar; el contenido solo se pinta sin loading ni error.

**Header**: kicker "Ristak" + título grande = nombre del panel activo o "Ajustes". Si hay panel activo, botón atrás pill con chevron + texto "Ajustes". Subtítulos de header solo en `custom-fields` ("Elige qué datos quieres ver en la info de cada contacto.") y `privacy` ("Ajustes que afectan lo que tus clientes pueden saber de tu lectura.").

**Lista principal** (filas: icono con tono, título, descripción, meta + chevron):

| id | Título | Descripción | Meta | Icono/tono |
|---|---|---|---|---|
| `numbers` | Números de WhatsApp | Principal y bandejas por remitente. | `<n>` o "Revisar" | Smartphone / green |
| `templates` | Plantillas | Crear y revisar estados de Meta. | `<n> guardadas` o "Revisar" | FileText / black |
| `agent` | Asistente Personal AI | Chat fijo y sugerencias. | "Activo" / "Apagado" / "Sin OpenAI" | Bot / neutral |
| `chats` | Lista de chat | Orden, archivados y vista previa. | "Recientes" / "No leídas" | MessageCircle / green |
| `custom-fields` | Campos personalizados | Datos visibles en cada contacto. | `<n>` o "Todos" | ListChecks / gold |
| `appearance` | Apariencia | Claro, noche, sistema u horario. | meta de tema (§4.17) | Sun / neutral |
| `privacy` | Privacidad | Controla vistos de WhatsApp, Messenger e Instagram. | "Vistos activos" / "Vistos apagados" | CheckCheck / neutral |
| `notifications` | Notificaciones | Mensajes, citas, sonido y vibración. | "Activo" / "Bloqueado" / "No soportado" / "Activar" | Bell / red |
| — | **Cerrar sesión** | Salir de este dispositivo. | (chevron) | LogOut / red |

Nota de diseño (docs/MOBILE_APP.md:150): en la lista principal los iconos son glyph-only (sin fondo de color salvo rojo para logout/notifications).

**Panel Números de WhatsApp** (`renderNumbers`, solo RN):
- Action card: icono Smartphone, "Números de WhatsApp", subtítulo "Administra remitentes conectados." (conectado) o "Conecta WhatsApp para enviar desde la app móvil." (no), botón "Actualizar" (spinner) → `POST /whatsapp-api/refresh`.
- Error → alert box; loading → "Cargando números...".
- Card "Bandeja de chats": hint "Usa todos juntos para ver la bandeja completa o separa por un remitente cuando necesites trabajar sólo un número." + segmented **Juntos | Separado**; si hay número separado, hint "Separado por `<label · número>`.".
- Lista de números: avatar con 2 iniciales del label, título = `label || verified_name || número || 'WhatsApp'`, subtítulo = `<número || 'Sin número visible'> · <estado>` donde estado = availability.apiReason si no disponible / "Respaldo QR" / "QR listo" / "Principal" / `status` / "Disponible" (`App.tsx:11369-11375`). Dos pills por fila: **"Usar"/"En chats"** (selección de bandeja) y **"Hacer principal"/"Principal"** (default sender; spinner mientras).
- Vacío: "Todavía no hay números de WhatsApp conectados.".

**Panel Plantillas** (`renderTemplates`):
- Action card "Plantillas de WhatsApp", subtítulo `"<n> necesitan revisión."` o "Revisa estados y aprobaciones de Meta.", botón "Actualizar" → recarga `GET /whatsapp-api/templates`.
- Fila por plantilla: icono FileText, nombre (1 línea), preview BODY (2 líneas), razón de bloqueo en énfasis si aplica, badge de estado a color (aprobada verde / bloqueada roja / resto pendiente).
- Estados: loading "Cargando plantillas...", error alert, vacío "Todavía no hay plantillas guardadas.".

**Panel Asistente Personal AI** (`SettingsAgentPanel:12266-12536`):
- Si `!aiReady`: empty state "Conecta OpenAI para activar el agente en este celular." (o "Reconecta OpenAI…" si `needsReconnect`) + input seguro para API key + botón "Conectar OpenAI".
- Card "Descripción del negocio" (icono Sparkles): subtítulo "Dicta tu giro, servicios y clientes; la IA lo pule y lo guarda aquí."
  - Textarea multiline, placeholder "Ejemplo: Somos una clínica dental en Ciudad Juárez, atendemos familias..." (el /movil tiene la versión larga: "...vendemos tratamientos de ortodoncia y queremos responder con tono cercano...").
  - Botón mic flotante: "Dictar" / "Detener" (con cuadrado) / "Procesando" (spinner). Deshabilitado si `!aiReady || guardando || cargando || procesando`.
  - Línea de estado: mensajes de §4.15, o por defecto "El dictado se guarda automático al terminar." (aiReady) / "OpenAI debe estar conectado para dictar y pulir." (no).
  - Botón "Guardar" (icono Save, spinner al guardar) con las condiciones de §4.14.
- Toggle "Mostrar como primer chat" — "El agente aparece fijo arriba de tus conversaciones." → `mobile_chat_ai_agent_enabled`.
- Toggle "Sugerir respuestas" — "El agente puede preparar un texto para responder en chats reales." → `mobile_chat_ai_reply_suggestions_enabled` (dependencias §4.6).

**Panel Lista de chat** (`renderChats`):
- Card "Ordenar conversaciones": segmented **Más recientes | No leídas** → `mobile_chat_sort_mode` (`recent`/`unread`).
- Toggle "Mostrar archivados" — "Deja visible el acceso a chats archivados." → `mobile_chat_show_archived`.
- Toggle "Vista previa" — "Muestra un resumen debajo del nombre del contacto." → `mobile_chat_show_last_preview`.
- Toggle "Indicadores de no leídos" — "Muestra el contador cuando hay mensajes nuevos." (en /movil: "…el contador verde…") → `mobile_chat_show_unread_indicators`.

**Panel Campos personalizados** (`renderCustomFields`):
- Solo lectura. Card "Todos aparecen en la info del contacto" + hint "El chat móvil muestra el catálogo completo, agrupado por carpeta, y cada campo se edita desde la ficha del contacto.".
- Agrupado por `folderName` (fallback "Campos personalizados"); cada fila: label + `dataType` (fallback `text`) + check acento. (/movil no agrupa con headers, muestra `<folderName> · <dataType>` por fila.)
- Estados: loading "Cargando campos...", error alert, vacío "Todavía no hay campos personalizados guardados.".

**Panel Apariencia** (`renderAppearance`):
- Card "Color del chat" — "Elige cómo quieres ver esta app en este celular." Radio-list de 4 opciones (`PHONE_CHAT_THEME_OPTIONS`, `App.tsx:906-916`):
  - `system` "Sistema" — "Usa el modo que tiene tu celular." (icono Smartphone). En /movil la descripción es dinámica: "Sigue el modo de `<iPhone|iPad|Android|este equipo>`." o "Si no se puede leer el modo del equipo, usa el horario.".
  - `light` "Claro" — "Mantiene la app con fondo claro." (Sun)
  - `dark` "Noche" — "Mantiene la app oscura todo el tiempo." (Moon)
  - `auto` "Horario" — "Claro de día y noche después de las 7 PM." (Clock)
- Hint final RN: "Ahorita la app se ve en modo `<meta minúsculas>` y el fondo nativo del celular ya sigue esa preferencia." (/movil: "Ahorita el chat se ve en modo `<claro|noche>`.").
- Selección escribe `mobile_chat_theme_preference` y aplica el tema al instante.

**Panel Privacidad** (`renderPrivacy`, solo RN):
- Card "Vistos de chat" — "Decide si Ristak le avisa al proveedor cuando ya viste un mensaje."
- Toggle "Marcar mensajes como leídos o vistos" — "Envía el visto real al abrir o marcar leído un chat." → `chat_send_read_receipts_enabled`.
- Hint: "Si lo apagas, Ristak limpia los no leídos dentro de la app, pero no manda doble check, mark seen ni acuse externo a WhatsApp API, WhatsApp QR, Messenger o Instagram."

**Panel Notificaciones** (`renderNotifications`):
- Card de permiso: si `granted` → check verde + "Alertas activas en este celular · `<n>` tipos prendidos."; si no → campana + "Permiso nativo: `<Activar|Bloqueado|No soportado>`." Debajo, mensaje de estado del último intento (`pushStatusMessage`). Botón **"Activar"** (o **"Actualizar"** si ya granted) → flujo §2.7; textos: "Activando alertas en este celular...", éxito "Alertas activas en este celular.", fallos con Alert "Falta preparar alertas"/"No se activaron"/"No se activaron las alertas".
  - (/movil: card "Este celular" con estado "Activo en este celular"/"Bloqueado por el celular"/"Falta activar"/"No disponible"/"Revisando", botón "Activar"; si ya hay permiso, card verde "Este celular ya tiene permiso para recibir notificaciones.")
- Toggle "Mensajes del chat" — "Avísame cuando llegue un WhatsApp nuevo." → `chat_push_notifications_enabled`.
- Toggle "Citas agendadas" — "Avísame cuando alguien reserve una cita nueva." → `calendar_push_notifications_enabled` (+ regla §4.7).
- Si citas ON → card "Calendarios con alertas" con contador (`N seleccionados` / `Todos`), chip "Todos los calendarios" (escribe `[]`), grid de chips por calendario con punto de color (`eventColor || color || acento`) y nombre; loading "Cargando calendarios..."; vacío "No hay calendarios activos para elegir.".
- Toggle "Citas confirmadas" — "Avísame cuando un cliente confirme que sí asistirá." → `appointment_confirmation_push_notifications_enabled`.
- Toggle "Pagos" — "Avísame cuando se registre un pago." → `payment_push_notifications_enabled`.
- Card "Sonido y vibración" — "Controla cómo se sienten las alertas en este celular." con toggles embebidos:
  - "Timbre de notificación" — "Hace sonar el celular cuando llegue una alerta." → `push_notification_sound_enabled`.
  - "Vibración de notificación" — "Vibra cuando entren mensajes, citas, confirmaciones o pagos." → `push_notification_vibration_enabled`.

**Gestos/interacciones**: todo son taps (Pressable con estado pressed); no hay swipes ni haptics explícitos en Ajustes. El scroll es un ScrollView simple; en /movil el botón "‹ Ajustes" se colapsa al scrollear hacia abajo y reaparece al subir (umbral ±4px, top ≤8px siempre visible, `PhoneSettings.tsx:206-223`).

### 5.2 Diferencias /movil (PhoneSettings.tsx) vs RN nativo — decisiones para iOS

| Aspecto | /movil web | RN nativo (a replicar) |
|---|---|---|
| Números de WhatsApp | ❌ no existe | ✅ panel completo (bandeja + principal) |
| Privacidad (read receipts) | ❌ | ✅ |
| Conectar token OpenAI in-app | ❌ (solo mensaje "Conecta OpenAI…") | ✅ input + botón |
| Templates fetch | `getTemplates()` con default `status=APPROVED` + fallback status | `getTemplates(null)` (todas) + fallback status |
| Config load | 1 request por key (hook) con cache localStorage | batch `?keys=` + estado en memoria |
| Logout | confirm modal, redirige a login | Alert 3 botones incl. "Cambiar app" |
| Permiso push | Notification API / puente Capacitor, labels "Activo en este celular"… | expo-notifications, labels "Activo/Bloqueado/No soportado/Activar" |
| Título sección chats | "Lista de chats" (desktop) / "Lista de chat" (mobile) | "Lista de chat" |

---

## 6. Gaps / riesgos para iOS nativo

1. **Toggles "globales" editables por cualquier usuario con permiso**: `mobile_chat_*` y `chat_send_read_receipts_enabled` viven en `app_config` global — un empleado con `settings_account` write cambia el tema/orden/vistos de TODOS los usuarios del tenant. Solo las 8 claves de user-config son por usuario. Para iOS: considerar cache local por dispositivo del tema, pero la fuente de verdad seguirá siendo global (paridad con RN).
2. **403 sin manejo específico**: si un empleado sin `settings_account` write toca un toggle global, recibe 403 `write_access_required`; la UI actual solo muestra "No se guardó el ajuste / Intenta otra vez." Sería mejor detectar `code` y explicar el permiso. OPEN QUESTION: ¿ocultar los paneles globales según `user.access` (spec 02) como hace el desktop?
3. **No hay endpoint batch para user-config admin en móvil** ni UI móvil de administración del equipo (existe solo GET/PATCH `/api/user-config/admin` para el desktop). Fuera de alcance iOS v1.
4. **Sin DELETE self en user-config**: un usuario no puede borrar su propio override para volver a heredar el global (solo el admin vía PATCH con `null`). El cliente siempre sobreescribe valores.
5. **`/api/config` GET sin keys devuelve TODO el tenant** (config de integraciones incluida, con secretos nulos). Usar siempre `?keys=` explícito como hace RN.
6. **Push iOS depende del Installer**: `iosConfigured` en `/push/public-key` debe ser true para la instalación; el token que se registra es el **device token APNs crudo** (no Expo). La app SwiftUI mandará su token APNs hex a `POST /push/mobile-devices` con `platform:'ios'`. OPEN QUESTION: formato exacto esperado del token en backend (RN manda `nativeToken.data` tal cual; verificar en spec del módulo push si el backend distingue hex/base64).
7. **Sonido/vibración son server-side**: los toggles de sonido/vibración cambian cómo el backend construye el push (canales Android / flags APNs). En iOS no hay canales; hay que verificar en el módulo push cómo se aplica `push_notification_sound_enabled` a APNs (probablemente omite `sound`). No hay nada que hacer client-side salvo guardar la preferencia.
8. **Carrera del fallback de plantillas en RN**: `loadTemplates` depende de `whatsappStatus` ya cargado; si el status aún no llegó, el fallback es `[]`. Aceptable (igual a RN), pero iOS puede await-ear ambos.
9. **`refresh` de WhatsApp puede ser lento/fallar por YCloud**: `POST /whatsapp-api/refresh` habla con YCloud; usar timeout generoso y mantener el status previo si falla (RN limpia el status y muestra error — decidir si replicar).
10. **`mobile_chat_selected_whatsapp_phone_id` afecta la bandeja del módulo Chats**: al cambiarlo en Ajustes, la bandeja debe refiltrarse (en RN el `onAppConfigPatch` propaga el cambio al estado global de la app). iOS necesita el mismo canal interno de sincronización.
11. **Tema `auto` con reloj local**: umbrales fijos 19:00/06:00 hora del dispositivo (no de la cuenta). Replicar exactamente; recalcular al cruzar el umbral (el web programa un timer al próximo cambio).
12. **`account_currency`/`account_timezone` no editables en móvil**: solo lectura. La edición vive en el desktop (Ajustes de cuenta). No inventar UI de edición.
13. **Sentinela de contexto vacío**: comparar contra el string exacto `"No se proporcionaron detalles del negocio."`; si el backend cambia el copy, el draft mostraría basura. Riesgo bajo pero real.
14. **Dictado**: el límite de 25 MB aplica a ambos formatos; grabaciones largas en HIGH_QUALITY m4a pueden acercarse. Considerar límite de duración en el cliente. OPEN QUESTION: no hay límite de duración definido en producto.
15. **`DELETE /api/ai-agent/config` y `/config/token` no tienen UI móvil** (desconexión de OpenAI solo en desktop). Si iOS agrega "Desconectar OpenAI", los endpoints ya existen.
16. **Módulo `settings_whatsapp` NO gatea `/api/whatsapp-api/status|templates|phone-numbers/default`** (solo auth). Cualquier usuario autenticado puede cambiar el número principal desde el móvil. Es el comportamiento actual (¿intencional?). OPEN QUESTION para producto/seguridad.

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **RESUELTO — Gap 6 (formato del token push):** `saveMobilePushDevice`
   (`pushNotificationsService.js:1665-1724`) guarda el token con solo `String(token).trim()`
   — sin validación de formato — y el envío APNs lo usa **tal cual** en la ruta HTTP/2
   `:path: /3/device/${row.token}` (línea 1921). Por lo tanto la app iOS debe mandar el
   **device token APNs en hex** (`deviceToken.map { String(format: "%02x", $0) }.joined()`),
   nunca base64: cualquier otro formato se registraría sin error pero APNs devolvería
   `BadDeviceToken` y el device quedaría `enabled=0`.
2. **RESUELTO — Gap 7 (sonido/vibración en APNs):** verificado en
   `pushNotificationsService.js:1905-1907`: `aps.sound = 'default'` SOLO si el usuario
   destinatario tiene `push_notification_sound_enabled`; si está OFF el push llega
   silencioso. `push_notification_vibration_enabled` solo elige canal en Android
   (líneas 1564-1567) — en iOS no tiene efecto; mostrar el toggle por paridad.
3. **CONFIRMADO — Gap 16:** en `whatsappApi.routes.js`, `/status` (línea 58),
   `/phone-numbers/default` (72) y `/templates` (96) NO llevan gate de módulo (solo el
   backfill de fotos exige `settings_whatsapp`); el mount agrega únicamente
   `requireFeature('whatsapp')`. Cualquier usuario autenticado puede cambiar el número
   principal. Sigue abierta la pregunta de producto/seguridad, pero el comportamiento
   está confirmado en código.
