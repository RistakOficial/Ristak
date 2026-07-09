# 12 — Media / Archivos (spec para la app nativa iOS)

> Investigación exhaustiva del subsistema de media de Ristak: almacenamiento
> (Bunny CDN + fallback local), envío de media por chat (WhatsApp API/QR),
> servido/autenticación de URLs, generación de avatares PNG por iniciales,
> límites por tipo, y el inventario UX de `/movil` (`PhoneChat.tsx`) y de la app
> React Native (`mobile/src/App.tsx`). Los agentes Swift deben poder implementar
> el módulo SOLO con este documento.
>
> Fuentes: `backend/src/routes/media.routes.js`, `backend/src/controllers/mediaController.js`,
> `backend/src/services/mediaStorageService.js` (3234 líneas),
> `backend/src/services/mediaCompressionService.js`,
> `backend/src/services/whatsappApiService.js` (líneas citadas),
> `backend/src/routes/internalStorage.routes.js`, `backend/src/routes/push.routes.js`,
> `backend/src/services/pushNotificationsService.js`, `backend/src/controllers/contactsController.js`,
> `docs/MEDIA_STORAGE_BUNNY.md`, `docs/MOBILE_APP.md`,
> `frontend/src/pages/PhoneChat/PhoneChat.tsx`, `mobile/src/App.tsx`, `mobile/src/api.ts`,
> `mobile/src/format.ts`, `mobile/src/types.ts`.

---

## 1. Arquitectura general

Hay **dos planos de media** distintos que la app nativa debe conocer:

1. **Biblioteca de medios central (`media_assets`)** — servicio
   `mediaStorageService` + Bunny Storage/CDN (o fallback a disco local del
   servidor). Se usa para: previews de media de chat, media entrante rehospedada,
   avatares de contactos rehospedados, assets de sitios/formularios/cursos, etc.
   Endpoints en `/api/media/*` (autenticados, con licencia `settings_media`) y
   servido público en `/media/assets/:id/file`.

2. **Envío de media por chat** — la app **NO sube archivos a `/api/media/upload`
   para chatear**. El cliente (web `/movil` y RN) convierte el archivo a
   **data URL base64** y lo manda dentro del JSON de
   `POST /api/whatsapp-api/messages/{image|video|audio|document}`. El backend:
   - valida MIME y tamaño,
   - lo recomprime al formato que WhatsApp exige (JPEG/MP4/OGG-Opus),
   - lo sube al proveedor (YCloud) para el envío API **y** guarda una copia
     pública en `media_assets` (módulo `chat`) para que el bubble del chat tenga
     una URL de preview permanente; en audios salientes esa copia debe ser
     reproducible por la app (`audio/mp4`/M4A si el original no lo era),
   - persiste el mensaje con la metadata de media.

**Cadena de autenticación de URLs de media en mensajes: NO HAY AUTH.** Las URLs
que llegan en el journey (`media_url`) son:
- URL pública del CDN de Bunny (`BUNNY_CDN_BASE_URL/...`), cacheable para
  siempre, o
- `https://<app>/media/assets/:id/file` — ruta **pública sin sesión** que
  redirige 302 al CDN de Bunny o sirve el archivo local
  (`media.routes.js:67-72`, comentario: "Público: Bunny/CDN redirige; fallback
  local sirve el archivo sin sesión"), o
- `https://<app>/uploads/whatsapp-*/...` (fallback local legacy, estático
  Express con `maxAge 7d`, `server.js:228`).

La app nativa puede cargar estas URLs con `URLSession`/`AsyncImage` sin headers.

---

## 2. Endpoints — Biblioteca de medios (`/api/media/*`)

Montaje: `app.use('/media', mediaRoutes)` y `app.use('/api/media', mediaRoutes)`
(`server.js:278,289`). Todas las rutas excepto las de servido requieren:
- `requireAuth` (JWT Bearer),
- `requireFeature('settings_media')` (licencia),
- `requireModuleAccess('settings_media')` (permiso por usuario).

Formato de error uniforme (`mediaController.js:31-38`):
```json
{ "success": false, "error": "<mensaje humano en español>", "code": "<opcional>" }
```

### 2.1 `POST /api/media/upload` — subir archivo

Dos modos (`mediaController.js:129-178`):

**A. Multipart** (`multer`, campo `file`, límite `MEDIA_MAX_UPLOAD_BYTES` env o
**600 MB**; 413 con code `media_upload_too_large` y mensaje
`"El archivo pesa demasiado. Límite máximo: 600 MB."` — `media.routes.js:28-65`).
Campos extra de formulario (todos opcionales):

| Campo | Tipo | Notas |
|---|---|---|
| `file` | binario multipart | requerido en este modo |
| `businessId` / `business_id` | string | default `'default'` |
| `clientAccountId` (alias `client_account_id`, `accountId`, `account_id`, `locationId`, `location_id`) | string | contexto multi-cuenta |
| `module` | string | uno de: `chat, products, sites, forms, courses, appointments, landing, business_settings, documents, automations, whatsapp, avatars, ad_creatives, other` (`mediaStorageService.js:79-94`); cualquier otro → `other` |
| `moduleEntityId` / `module_entity_id` | string | id de la entidad dueña |
| `isPublic` / `is_public` | bool-ish (`1/true/yes/si/on`) | default `true` |
| `deferStreamSync` / `defer_stream_sync` | bool-ish | default `true`; solo aplica a video de módulos `sites/forms/landing` |
| `clientUploadId` (alias `client_upload_id`, `uploadSessionId`, `upload_session_id`, o header `x-ristak-upload-id`) | string | **idempotencia**: si ya existe un asset con ese id, se devuelve el existente sin re-subir (`mediaStorageService.js:1950-1954`) |

**B. JSON data URL** (sin `file`): body JSON con
`fileBase64` (alias `file_base64`, `dataUrl`, `content`) = `data:<mime>;base64,<...>`
y `filename` (alias `fileName`, `originalFilename`; default `'archivo'`).
Regex de parseo: `^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$` — si no matchea:
400 `invalid_data_url` `"Archivo inválido: envía un data URL en base64."`
⚠️ El body JSON global de Express está capado a **35 MB** (`server.js:221-227`),
así que en la práctica el modo data URL tope ≈26 MB de binario.

**Validación** (`mediaStorageService.js:1610-1619`):
- MIME permitido (allowlist `MIME_EXTENSION`, `mediaStorageService.js:96-124`):
  imágenes `jpeg/png/webp/gif/avif/svg+xml`, video `mp4/quicktime/webm`, audio
  `mpeg/mp4/aac/ogg/webm/wav/x-wav`, documentos `pdf/doc/docx/xls/xlsx/ppt/pptx/
  txt/csv/json/zip`. El MIME se detecta por magic bytes (`file-type`), con
  fallback a declarado/extensión. No permitido → **415** `unsupported_media_type`
  `"Tipo de archivo no permitido para almacenamiento multimedia."`
- Tamaño por `media_type` (de `storage_settings`, defaults
  `mediaStorageService.js:591-594`): imagen **25 MB**, video **512 MB**, audio
  **100 MB**, documento **50 MB**. Exceso → **413** `media_too_large`
  `"El archivo pesa demasiado. Límite para <tipo>: N MB."`
- Cuota: **403** `storage_disabled` si `storage_enabled=false`; **413**
  `storage_quota_exceeded` `"No hay espacio suficiente para subir este archivo..."`
  (`mediaStorageService.js:1746-1760`). Cuota default 5 GB por negocio.
- Storage global deshabilitado → **503** `storage_disabled`.
- Bunny requerido pero mal configurado → **503** `bunny_not_configured`.

**Procesamiento** (`processMedia` + `mediaCompressionService.js`), salvo
`skipCompression`:
- Imagen → WebP máx 1600 px, calidad 80 (solo si pesa menos que el original);
  GIF y SVG se conservan. Thumbnail WebP 480 px, calidad 76 (no para GIF/SVG).
- Audio → Ogg Opus mono 48 kHz 32k (`audio/ogg; codecs=opus`).
- Video → **streaming a Bunny sin recompresión** cuando llega por multipart
  (siempre para video, y para cualquier archivo > `MEDIA_STREAMING_THRESHOLD_BYTES`
  = 48 MB default) — `mediaStorageService.js:1965-1985`.
- Si ffmpeg falta o falla, se guarda el original.

**Respuesta**: `201 { "success": true, "data": <MediaAsset> }` (modelo §5.1).

### 2.2 `GET /api/media/assets` — listar

Query params: `businessId` (default `default`), `module`, `mediaType`
(alias `media_type`; valores `image|video|audio|document|other`), `status`,
`limit` (1–250, default 100), `offset` (default 0). Orden `created_at DESC`.
Respuesta: `{ "success": true, "data": [MediaAsset, ...] }`. **Paginación por
offset**, sin cursor ni total (`mediaStorageService.js:2727-2753`).

### 2.3 `GET /api/media/storage/usage` — cuota

Query: `businessId`. Respuesta `{ success, data }` con (snake_case,
`mediaStorageService.js:2811-2828`):

| Campo | Tipo |
|---|---|
| `business_id` | string |
| `business_name` | string |
| `storage_provider` | `"bunny"` u otro |
| `storage_status` | `"configured" \| "not_configured" \| "local_fallback" \| "disabled"` |
| `quota_gb` | number |
| `quota_bytes` | number (incluida + extra) |
| `included_quota_bytes` | number |
| `extra_quota_gb` | number |
| `used_bytes` | number |
| `available_bytes` | number |
| `usage_percent` | number (2 decimales) |
| `files_count` | number |
| `by_media_type` | `{ images, videos, audio, documents, other }` bytes |
| `by_module` | `{ [module]: bytes }` |
| `storage_enabled` | boolean |
| `last_calculated_at` | ISO string |

### 2.4 `GET /api/media/assets/:assetId/url`

Respuesta `data`: `{ id, url, publicUrl, privateUrl, status, mimeType, mediaType }`
(`url` == `publicUrl`). 404 `media_not_found` si borrado/inexistente.

### 2.5 `GET /api/media/assets/:assetId/download`

Descarga binaria autenticada: headers `Content-Type`, `Content-Length`,
`Cache-Control: private, no-store`, `Content-Disposition: attachment;
filename="..."; filename*=UTF-8''...`. El backend baja el archivo de Bunny si no
hay copia local (`getMediaAssetBuffer`). 502 `media_fetch_failed` si Bunny falla.

### 2.6 `POST /api/media/assets/download` — ZIP múltiple

Body: `{ "entries": [{ "id": "...", "path": "carpeta/nombre.ext" }, ...] }` o
`{ "assetIds": ["...", ...] }`, opcional `"filename": "algo.zip"`.
Máx `MEDIA_MAX_ARCHIVE_DOWNLOAD_ITEMS` (default **500**) → 413
`media_archive_too_large`. Vacío → 400 `invalid_media_download`
`"Selecciona al menos un archivo para descargar."` Respuesta: binario
`application/zip` attachment.

### 2.7 `POST /api/media/assets/move`

Body: `{ businessId?, entries?: [{ id, targetFolderPath? }], assetIds?: [...],
targetFolderPath?: "" }`. Mueve el objeto en Bunny/disco a otra subcarpeta
lógica y reescribe `public_url`. Respuesta `data`: array de MediaAsset movidos.
400 `invalid_media_move` si no hay entradas.

### 2.8 `DELETE /api/media/assets/:assetId`

Soft delete (`status='deleted'`, `deleted_at`), borra el binario de
Bunny/disco y el video de Bunny Stream si existía, recalcula cuota. Respuesta:
`{ success: true, data: { id, deleted: true } }`.

### 2.9 `PUT /api/media/assets/:assetId/replace`

Mismo input que upload (multipart o data URL). Sube el nuevo asset heredando
`module`/`moduleEntityId`/`isPublic`/cuenta del anterior y soft-borra el viejo.
Respuesta `data`: `{ previousId: "<id viejo>", asset: <MediaAsset nuevo> }`.

### 2.10 `POST /api/media/assets/:assetId/retry`

Si `status != 'failed'`: `{ id, status, retried: false, message: "El archivo no
está fallido; no requiere reintento." }`. Si `failed`: **409**
`media_retry_not_available` (no conserva temporal; hay que re-subir).

### 2.11 `POST /api/media/assets/:assetId/stream/sync` y `GET .../stream/analytics`

Solo videos de módulos `sites|forms|landing` (Bunny Stream). Analytics query:
`dateFrom`/`date_from`, `dateTo`/`date_to`, `hourly` (bool-ish). Respuesta con
`summary { views, watchTime, averageWatchTime, engagementScore, topCountry }`,
`viewsChart`, `watchTimeChart`, `countries`, `heatmap`, `video`, `stream`.
400 `bunny_stream_not_video` para no-videos. **Irrelevante para chat iOS** —
solo si se porta la biblioteca de medios de Ajustes.

### 2.12 `GET /api/media/diagnostics`

Respuesta `data` (snake_case): `storage_provider, storage_status,
storage_enabled, db_settings_installed, missing_environment[],
bunny_storage_zone, bunny_storage_region, bunny_cdn_base_url,
bunny_stream_enabled, bunny_stream_status, bunny_stream_library_id,
bunny_stream_collection_id, bunny_stream_collection_name,
bunny_stream_missing_environment[], compression_enabled, quota_ready,
usage (§2.3), bunny_write_delete_test { ok, path?/error? }`.

### 2.13 Servido público (SIN auth)

| Método/Ruta | Comportamiento |
|---|---|
| `GET /media/assets/:assetId/file` (también `/api/media/assets/:assetId/file`) | Si el asset vive en Bunny → **302 redirect** a `publicUrl` del CDN. Si es local → stream con `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`; `Content-Disposition: inline` solo para tipos seguros (imagen raster, video, audio, PDF), **attachment** para SVG/HTML/XML/JS (SEC-010, `mediaController.js:380-406`). 404 JSON si no existe. |
| `GET /media/assets/:assetId/thumbnail` | igual pero para la variante thumbnail WebP (si no hay, cae al original). |
| `GET /uploads/...` | estáticos legacy (whatsapp-images/audio/documents/videos), `maxAge 7d immutable`. |

Formato de id de asset: `media_*` o `rstk_media_*`
(regex `extractMediaAssetIdFromUrl`, `mediaStorageService.js:3178-3181`).

### 2.14 Endpoints internos instalador (no son para la app)

`GET /internal/storage/usage` y `GET /internal/storage/diagnostics`
(también bajo `/api/internal/...`) con header
`Authorization: Bearer <INTERNAL_INSTALLER_TOKEN>` o
`x-internal-installer-token`. 503 si no hay token configurado, 401 si no
coincide (`internalStorage.routes.js`). Respuesta **sin** wrapper `success`.

---

## 3. Endpoints — Envío de media por chat (`/api/whatsapp-api/messages/*`)

Montados con `requireAuth` (sin gate de licencia/módulo extra —
`whatsappApi.routes.js:56,88-95`). Todos devuelven en error:
`400 { success: false, error: "<mensaje>" }`. En éxito:
`{ success: true, data: {...} }` donde `data` es la respuesta del proveedor
enriquecida (incluye `id` del proveedor, `status`, `localMessageId` (id del
mensaje persistido, puede ser null), y el objeto de media (`image|video|audio|
document`) con `link`/`mediaId`/`mimeType`/`filename`/`size`/`mediaUrl`...).
Si el envío cayó al fallback QR, `data` incluye además `transport: 'qr'` y
`fallbackReason`/`routingReason` (la RN los lee como `response.transport`,
`response.routingReason || response.fallbackReason` — `App.tsx:19497-19508`,
`types.ts:222-229 SendTextResponse`).

Campos comunes a los 4 endpoints (body JSON):

| Campo | Tipo | Req | Notas |
|---|---|---|---|
| `to` | string teléfono | ✔ | destino; se normaliza |
| `from` | string teléfono | – | default: número emisor configurado |
| `contactId` | string | – | liga el mensaje al contacto y dispara "human takeover" |
| `externalId` | string | – | id idempotente del cliente; RN manda `native-image-<ts>` etc. |
| `phoneNumberId` | string | – | id del número de negocio a usar |
| `transport` | `'api'` \| `'qr'` | – | default `'api'`; con `'qr'` fuerza envío por sesión QR |
| `messageOrigin` | string | – | RN manda `'native_mobile_chat'`; `/movil` manda origen manual → `skipQrSendProtection=true` |

Regla dura para todos (transporte API): sin `imageDataUrl`/... el `link` que se
mande debe ser HTTPS; si no, error
`"La foto/El video/El audio/El documento necesita un enlace público HTTPS para poder enviarse por WhatsApp."`
Además la **ventana de 24 h**: si no hay respuesta reciente del cliente y no hay
número QR listo, el backend lanza error con el texto de
`WHATSAPP_REPLY_WINDOW_CLOSED_REASON` (`whatsappApiService.js:93-94`); el
cliente debe dirigir a plantillas (la RN lo pre-resuelve, ver §7.3).

### 3.1 `POST /api/whatsapp-api/messages/image`

Body extra: `imageDataUrl` (data URL) **o** `imageUrl` (HTTPS), `caption`
(string, se renderizan variables de plantilla y se recorta a **1024 chars**).

Validación de `imageDataUrl` (`parseImageDataUrl`, `whatsappApiService.js:633-655`):
- Regex estricta `^data:(image\/(?:jpeg|jpg|png|webp));base64,(...)$` — **solo
  JPG, PNG o WebP**. Otro → `"La foto debe ser JPG, PNG o WebP."`
- Vacía → `"La foto está vacía."`
- **Entrada máx 25 MB** (`MAX_WHATSAPP_IMAGE_INPUT_BYTES`) →
  `"La foto pesa demasiado. Toma otra foto más ligera o recórtala antes de enviarla."`

Procesado servidor (`prepareWhatsAppApiImageBuffer`): sharp → rotate EXIF,
resize `1600×1600 fit inside`, fondo blanco, JPEG q82 mozjpeg. **Salida máx
5 MB** (`MAX_WHATSAPP_IMAGE_OUTPUT_BYTES`) →
`"La foto sigue pesando demasiado para WhatsApp después de comprimirla."`
Luego: sube a YCloud (media id del proveedor con expiración) **y** guarda copia
de preview en `media_assets` módulo `chat` (URL pública permanente que se
persiste en el mensaje como `image.mediaUrl/publicUrl/url/link`).

### 3.2 `POST /api/whatsapp-api/messages/video`

Body extra: `videoDataUrl` **o** `videoUrl`, `caption` (≤1024).
Validación (`parseVideoDataUrl`, líneas 773-795): MIME del data URL debe estar
en `video/mp4, video/quicktime, video/webm, video/3gpp, video/3gp` →
`"El video debe ser MP4, MOV, WebM o 3GP para poder prepararlo para WhatsApp."`
**Entrada máx 25 MB** → `"El video pesa demasiado. Graba uno más corto..."`.
Procesado: ffmpeg H.264 baseline 3.1 + AAC 44.1 kHz, intentos escalonados
1280/crf28 → 960/crf32 → 720/crf35 → 480/crf38 hasta quedar **≤16 MB**
(`MAX_WHATSAPP_VIDEO_OUTPUT_BYTES`); si ninguno cabe →
`"El video sigue pesando más de 16 MB después de comprimirlo..."`
(`convertVideoToWhatsAppMp4`, líneas 839-908). MIME final `video/mp4`.

### 3.3 `POST /api/whatsapp-api/messages/audio`

Body extra: `audioDataUrl` **o** `audioUrl`, `durationMs` (number, se persiste
en el mensaje para pintar duración), `voice` (bool; default: `true` si hay
`audioDataUrl` — nota de voz).
Validación (`parseAudioDataUrl`, líneas 698-721): MIME permitido
`audio/aac, audio/amr, audio/mp4, audio/mpeg, audio/ogg, audio/webm, audio/wav,
audio/x-wav` **y `video/mp4`** (Safari/iOS envuelve grabaciones de micrófono en
contenedor MP4 y las etiqueta `video/mp4`; el backend lo acepta y transcodifica
— comentario líneas 123-126). Otro MIME →
`"WhatsApp no acepta este formato de audio. Graba otra vez o usa un audio compatible."`
**Máx 16 MB** (`MAX_WHATSAPP_AUDIO_BYTES`) →
`"El audio pesa demasiado. Graba uno más corto para poder enviarlo por WhatsApp."`
Procesado para proveedor: si no es ya `audio/ogg;codecs=opus`, ffmpeg → Ogg Opus
mono 48 kHz 48k. MIME final enviado al proveedor `audio/ogg; codecs=opus`.
Procesado para historial: cuando el envío nace en Ristak, el backend guarda una
copia publica en `media_assets` con URL en `media_url`; si el formato no es
reproducible por iOS/RN/web, esa copia se convierte a M4A (`audio/mp4`).
👉 **La app nativa debe grabar AAC/M4A y mandar el data URL como `audio/mp4`**
(igual que RN, ver §7.3): el backend transcodifica.

### 3.4 `POST /api/whatsapp-api/messages/document`

Body extra: `documentDataUrl` **o** `documentUrl`, `filename` (string),
`mimeType` (string), `caption` (≤1024).
Validación (`parseDocumentDataUrl`, líneas 737-771): el MIME se resuelve por
prioridad `mimeType` explícito → MIME del data URL → extensión del `filename`,
contra los mapas de documento **+ video + audio** (un video >16 MB puede
mandarse como documento). MIME de documento permitidos: `application/pdf`,
`application/msword`, `.docx`, `application/vnd.ms-excel`, `.xlsx`,
`application/vnd.ms-powerpoint`, `.pptx`, `text/plain`, `text/csv`.
Sin match → `"El archivo debe ser PDF, Word, Excel, PowerPoint, TXT, CSV, audio o video compatible."`
**Máx 20 MB** (`MAX_WHATSAPP_DOCUMENT_BYTES`) →
`"El documento pesa demasiado. Elige uno de menos de 20 MB para poder enviarlo por WhatsApp."`
El filename se sanitiza (sin control chars ni `<>:"/\|?*`, máx 180 chars, se
garantiza extensión) — `sanitizeDocumentFilename` líneas 728-735.
No se recomprime; se sube tal cual al proveedor.

### 3.5 Fallback QR y persistencia

Cada endpoint decide (`getOfficialApiFallbackDecision`): si el número API está
`BANNED/BLOCKED/RESTRICTED/RATE_LIMITED/DISCONNECTED/MIGRATED` o la ventana de
24 h está cerrada y hay número QR conectado → manda por QR
(`send*ViaQrFallback`) usando el **mismo data URL**. Si falla API sin fallback,
el mensaje saliente fallido igual se persiste (WA-009) para que aparezca en el
chat con estado de error. Media entrante (proveedor Meta directo) se descarga y
rehospeda en `media_assets` módulo `chat` con límites de entrada: audio 16 MB,
imagen/sticker 25 MB, documento 20 MB, **video 64 MB**
(`getInboundMediaLimitBytes`, líneas 4642-4649).

### 3.6 Límite global de payload JSON

`express.json({ limit: '35mb' })` (`server.js:221`). Un data URL de 25 MB de
binario ≈ 33.4 MB de base64 + JSON: **cabe justo**. La app nativa no debe
intentar mandar binarios mayores a los límites de §3.1-3.4 porque el 413 del
body-parser devuelve HTML/texto genérico, no el error amable del endpoint.

---

## 4. Avatar PNG por iniciales (notificaciones)

`GET /api/push/contact-avatar/:contactId?i=<iniciales>&c=<colorIndex>&s=<firma>`
— **pública pero firmada** (`push.routes.js:15`, `pushController.js:28-43`,
`pushNotificationsService.js:953-988`).

- `i`: 1–2 caracteres de iniciales; `c`: índice 0–7 de la paleta
  `['#0ea5e9','#2563eb','#7c3aed','#db2777','#059669','#0891b2','#4f46e5','#be123c']`;
  `s`: HMAC-SHA256 base64url (36 chars) calculado por el servidor con secreto
  interno.
- **La app no puede generar estas URLs** (no conoce el secreto): solo debe
  cargar las URLs que llegan armadas en los payloads de push
  (`contactAvatarUrl` / `senderAvatarUrl`, ver `docs/MOBILE_APP.md:397-406`).
  Firma inválida → 404 `Not found` texto plano.
- Respuesta: `image/png` 512×512 circular con iniciales,
  `Cache-Control: public, max-age=31536000, immutable`.
- Regla de push (MOBILE_APP.md): el avatar (foto o iniciales) NUNCA va en
  `notificationImageUrl`/`notificationAttachmentUrl`; esos campos son solo para
  media real del mensaje (foto/video del contacto). iOS los adjunta con la
  Notification Service Extension.
- Avatares de contactos en el CRM: el backend rehospeda las fotos de perfil de
  WhatsApp/Meta en Bunny (módulo `avatars`, subcarpeta por canal, refresco cada
  7 días — `resolveAvatarForPersist`, `mediaStorageService.js:2438-2486`). El
  cliente recibe la URL final en el contacto (`profile_picture_url`), pública.

---

## 5. Modelos de datos

### 5.1 MediaAsset (respuesta de `/api/media/*`, camelCase — `mapAssetRow`, `mediaStorageService.js:519-551`)

| Campo | Tipo | Null | Notas |
|---|---|---|---|
| `id` | string | no | `media_*` / `rstk_media_*` |
| `businessId` | string | no | default `'default'` |
| `userId` | string | sí | |
| `originalFilename` | string | no (puede ser `''`) | |
| `storedFilename` | string | no | `<id>-<base>.<ext>` |
| `bunnyPath` | string | no | ruta objeto: `accounts/<slug>/<módulo o `<tipo>s`>/<subFolder?>/<YYYY/MM/DD>/<archivo>` |
| `publicUrl` | string | no | CDN Bunny o `/media/assets/:id/file` |
| `privateUrl` | string | no (`''`) | igual a publicUrl si `isPublic=false`, si no vacío |
| `mimeType` | string | no | default `application/octet-stream` |
| `mediaType` | enum | no | `image \| video \| audio \| document \| other` |
| `extension` | string | no | |
| `sizeOriginal` | number | no | bytes |
| `sizeProcessed` | number | no | bytes tras compresión |
| `quotaSize` | number | no | bytes que cuentan a cuota |
| `width`, `height` | number | sí | solo imágenes/algunos videos |
| `duration` | number | sí | segundos (videos Stream) |
| `status` | string | no | `'ready'` (default), `'deleted'`, `'failed'` |
| `storageProvider` | string | no | `'bunny'` \| `'local'` \| `'unknown'` |
| `storageZone` | string | no (`''`) | |
| `cdnBaseUrl` | string | no (`''`) | |
| `module` | string | no | ver lista §2.1 |
| `moduleEntityId` | string | sí | |
| `isPublic` | boolean | no | |
| `metadata` | objeto | no (`{}`) | incluye `variants.thumbnail { path, publicUrl?, localPath?, mimeType, sizeBytes }`, `stream {...}`, `clientUploadId`, `compression`, `localFallback`, `clientAccount` |
| `createdAt`, `updatedAt`, `deletedAt` | string \| null | | SQLite `CURRENT_TIMESTAMP` |

### 5.2 Media en mensajes del journey (`GET /api/contacts/:id/journey`)

Eventos `whatsapp_message` (`contactsController.js:5245-5298`) traen en `data`:

| Campo | Tipo | Notas |
|---|---|---|
| `message_type` | string | `text, image, video, audio, voice, document, sticker, location, reaction, ...` |
| `media_url` | string | URL pública (CDN/`/media/assets/.../file`/`/uploads/...`); en media saliente nueva de Ristak debe existir aunque el proveedor use media ID; solo puede faltar en histórico legado o media expirada del proveedor |
| `media_id` | string | id de media del proveedor (fallback cuando no hay URL) |
| `media_mime_type` | string | |
| `media_filename` | string | |
| `media_duration_ms` | number \| null | audio |
| `location_latitude`, `location_longitude` | number | mensajes location |
| `location_name`, `location_address`, `location_url` | string | `location_url` cae a Google Maps `https://www.google.com/maps?q=lat,lng` |

Eventos `meta_message` (líneas 5373-5416): `media_url`, `media_mime_type`,
`media_id`, `message_type`, más contexto de comentario (`comment_id`,
`post_image_url`, `permalink`, ...).

El mapper del cliente RN (`format.ts:689-708`) resuelve el tipo del attachment
con la sonda `[message_type, mimeType, filename, url]` (image/video/audio/
document) y exige `url || media_id` para crear `ChatAttachment`. Modelo cliente
(`mobile/src/types.ts:134-144`):
```ts
ChatAttachment = { type: 'image'|'video'|'audio'|'document'|'file';
  url?; dataUrl?; name?; mimeType?; isGif?; durationMs?; size?; caption? }
```
`isGif` = probe contiene `gif`. Nombre fallback: `Foto`/`Video`/`Audio`/`Documento`.
Texto del mensaje: si es igual al label genérico (`foto`, `video`, `audio`,
`documento`, `archivo`) se vacía para no duplicar (`cleanAttachmentMessageText`,
`format.ts:770-776`). Las razones de ruteo
`"Capturado desde la sesión de WhatsApp Web."` / `"...sesión API."` se filtran
(`format.ts:785-799`).

---

## 6. Reglas de negocio y permisos (resumen)

| Regla | Detalle |
|---|---|
| Licencia/módulo biblioteca | `/api/media/*` exige feature + módulo `settings_media`. Los envíos de chat NO. |
| Cuota | 5 GB default (`DEFAULT_STORAGE_QUOTA_GB`), recalculada de `media_assets` activos. |
| HTTPS obligatorio | Media por WhatsApp API oficial requiere URL pública HTTPS; instalaciones sin Bunny y sin URL pública solo pueden enviar media por QR (error accionable WA-006, `whatsappApiService.js:603-616`). |
| Ventana 24 h | Media libre solo dentro de ventana o vía QR; fuera → plantillas. |
| Dedup subida | `clientUploadId` (header `x-ristak-upload-id`) evita duplicados al reintentar. |
| Caption | Máx 1024 chars, admite variables de plantilla (`{{...}}` renderizadas server-side). |
| Media entrante | El backend la rehospeda (módulo `chat`); la app solo pinta `media_url`. |
| Seguridad de servido | nosniff + inline solo para raster/video/audio/PDF; SVG/HTML → descarga. |

---

## 7. Inventario UX

### 7.1 `/movil` — PhoneChat.tsx (referencia de paridad)

Constantes (`PhoneChat.tsx:307-393`): `MAX_VOICE_MESSAGE_BYTES` 16 MB,
`MAX_MEDIA_MESSAGE_BYTES` 16 MB, `MAX_DOCUMENT_ATTACHMENT_BYTES` 20 MB,
`MAX_VIDEO_ATTACHMENT_BYTES` 25 MB, `MAX_DRAFT_ATTACHMENTS` **4**,
`CAMERA_ATTACHMENT_ACCEPT='image/*,video/*'`, `DOCUMENT_ATTACHMENT_ACCEPT`
(pdf/doc/docx/xls/xlsx/ppt/pptx/txt/csv + audio), grabación de voz: mín 600 ms,
máx 3 min, MIME candidatos `audio/ogg;codecs=opus → audio/mp4 →
audio/webm;codecs=opus → audio/webm`, velocidades de audio `1 / 1.5 / 2`.

- **Sheet de adjuntos** del composer (`ActionSheet 'attachments'`): opciones
  cámara/fotos/documento. Al elegir archivos (`addFilesToDraft`,
  líneas 11401-11502):
  - Sin chat abierto → toast `warning` "Abre un chat / Selecciona una
    conversación antes de agregar archivos."
  - Canal email → toast `info` "Los adjuntos de correo se manejan desde la
    vista completa de chats."
  - Nota de voz en progreso → toast "Termina o elimina la nota de voz antes de
    agregar archivos."
  - Tope 4 → "Puedes mandar hasta 4 adjuntos por mensaje." /
    "El mensaje admite 4 adjuntos."
  - Imagen > **8 MB** → "La foto pesa demasiado / Elige una foto de menos de 8 MB."
  - Video no MP4/MOV/WebM/3GP → "Video no válido / Usa MP4, MOV, WebM o 3GP.";
    > 25 MB → "Video muy pesado / El video debe pesar menos de 25 MB para que
    Ristak lo pueda preparar."; entre 16 y 20 MB se manda como **documento**;
    ≤16 MB pregunta modo de entrega (media vs documento, `askMediaDeliveryMode`).
  - Audio no soportado → "Audio no válido / Usa MP3, M4A, OGG, WAV, AAC, AMR o
    WebM."; > 20 MB → "Audio muy pesado / ... menos de 20 MB..."; ≤16 MB
    pregunta nota de voz vs documento.
  - Documento no soportado → "Archivo no válido / Elige un PDF, Word, Excel,
    PowerPoint, TXT o CSV."; > 20 MB → "Archivo muy pesado / Elige un documento
    de menos de 20 MB."
  - Lectura como data URL con `FileReader.readAsDataURL`.
- **Cámara** (`readCameraMediaFile`, 11541-11604): foto >8 MB rechazada
  ("...para poder enviarla por WhatsApp"), video >25 MB → "Graba uno más corto.
  Ristak lo comprimirá para WhatsApp, pero la captura inicial debe pesar menos
  de 25 MB." Desde la bandeja abre **selector de destinatarios** (camera share)
  con multi-selección, caption y envío masivo.
- **Render de burbujas**:
  - Imagen: `<img class=messageImage>` con `dataUrl || url` — **no hay visor
    zoom en `/movil`**; la imagen se muestra inline (líneas 15834-15836).
  - Video: `<video controls playsInline preload=metadata>`; GIF (video isGif) →
    autoplay muted loop sin controles (15837-15849).
  - Audio: reproductor propio (14740-14831): `<audio>` oculto + botón
    play/pausa (spinner al cargar), waveform de 32 barras con progreso CSS,
    avatar del emisor (contacto o número de negocio) con badge de micrófono,
    botón de velocidad 1×/1.5×/2× (visible al reproducir en inbound), duración
    `formatVoiceDuration`, meta con hora/palomitas. Audio sin URL → cápsula
    "Nota de voz" / "Nota de voz enviada" (14833-14842).
  - Documento: tarjeta `<a target=_blank>` con icono FileText, nombre y MIME
    legible; sin URL → misma tarjeta deshabilitada (14900-14928).
  - Ubicación: `<a>` con mini-mapa de tiles OpenStreetMap (zoom 16), pin, "©
    OpenStreetMap contributors", título/subtítulo/coordenadas y acción "Abrir"
    (Google/Apple Maps) (14844-14898).
- **Info del contacto → Archivos del chat**: tabs `Fotos y videos` (grid de
  tiles `<a target=_blank>`), `Documentos` y `Enlaces` (filas tocables)
  (14930-14990, MOBILE_APP.md:661-663).
- **Grabación de voz**: barra compacta con papelera, waveform en vivo (54
  barras, muestreo 64 ms), contador, pausar/reanudar, preview reproducible y
  enviar; blob >16 MB rechazado (9489).

### 7.2 App RN (`mobile/src/App.tsx`) — comportamiento actual a igualar

Constantes (líneas 802-817, 751-762):
`MEDIA_ATTACHMENT_MAX_BYTES` 16 MB (imagen y audio),
`DOCUMENT_ATTACHMENT_MAX_BYTES` 20 MB, `VIDEO_ATTACHMENT_MAX_BYTES` 25 MB,
`CONVERSATION_ATTACHMENT_LIMIT` 4, `CAMERA_SHARE_VIDEO_MAX_DURATION_SECONDS` 60,
`MESSAGE_IMAGE_MAX_WIDTH/HEIGHT` 252/318 pt, velocidades audio `1/2/4` (cap
real móvil 2×, `CONVERSATION_AUDIO_MAX_MOBILE_RATE`), mapa ubicación: tiles OSM
zoom 16, 270×124 pt, pin `#ff5d7e`.

- **Preparación de adjuntos** (22546-22595): `expo-image-picker` /
  `expo-document-picker`; el archivo local se lee con
  `FileSystem.readAsStringAsync(uri, { encoding: Base64 })` y se arma
  `data:<mime>;base64,...` (`readFileAsDataUrl`, 22511-22514). Validación de
  tamaño con `FileSystem.getInfoAsync` (`assertAttachmentSize`):
  `"<Label> pesa X.X MB. El máximo permitido aquí es N MB."`; si el tamaño no
  se puede leer y es obligatorio:
  `"No pude validar el tamaño de <label>. Intenta con otro archivo."`
  MIME por defecto: imagen `image/jpeg`, video `video/mp4`, documento
  `application/octet-stream`, voz `audio/mp4` (archivo `nota-de-voz.m4a`).
- **Envío** (`sendDraftAttachment`, 22597-22609 + `api.ts:545-614`): mapea kind →
  `api.sendImage/sendVideo/sendAudio/sendDocument`, con
  `to=contact.phone`, `from=contact.lastBusinessPhone`,
  `phoneNumberId=contact.lastBusinessPhoneNumberId`, caption solo en el primer
  adjunto, `voice:true` y `durationMs` para audio, transporte resuelto
  (`'qr'|'api'`) según ventana 24 h + números QR. Optimista: burbujas locales
  `local-<ts>-attachment-<i>` con `status:'enviando'`, `pending:true`; al
  responder el backend se actualiza `status/transport`; error → `failed:true`,
  `status:'error'`, `errorReason`, restaura draft y `Alert` "No se envió".
  Adjuntos solo por WhatsApp: si el canal es otro →
  `"Los adjuntos nativos se envían por WhatsApp API/QR. Cambia el canal a WhatsApp para mandar este archivo."`
  Con respuesta activa (reply) → bloquea adjuntos:
  `"Para contestar un globo específico, manda texto. Para archivos, ubicación o notas de voz, cancela la respuesta primero."`
- **Pickers** (19150-19203): cámara/galería `mediaTypes:['images','videos']`,
  `quality:0.86`, multi-selección hasta el cupo restante; documentos
  `DocumentPicker.getDocumentAsync` con types pdf/text/word/excel,
  `copyToCacheDirectory:true`. Permisos denegados → Alert "Necesito permiso...".
- **Cámara global (bandeja)** (3270-3362): `launchCameraAsync` foto o video ≤60 s
  → pantalla completa `cameraShare` ("Enviar media"): preview arriba (imagen o
  video con `expo-video`), búsqueda + checklist multi-contacto, caption
  opcional y flecha de envío. Contactos sin teléfono → Alert
  `"Por ahora la cámara global envía por WhatsApp. Revisa el teléfono de <nombres>."`
  Envío `Promise.allSettled` por contacto; parcial → Alert
  `"Se envió a N contacto(s), pero falló en M."`
- **Render de burbujas** (21605-21904):
  - Imagen: tarjeta con tamaño medido y cacheado (`Image.getSize`, máx 252×318,
    `resizeMode:contain`); **tap = `Linking.openURL(uri)`** (abre el navegador;
    ⚠️ NO existe visor interno con zoom en RN hoy — la app iOS nativa debería
    mejorar esto con un visor full-screen, ver Gaps).
  - Video: `expo-video` `VideoView` con `nativeControls`, badge play + nombre +
    duración.
  - Audio: `expo-audio` `useAudioPlayer` (`updateInterval` 80 ms), tarjeta
    compacta de dos filas: play/pausa plano, waveform con progreso, avatar del
    lado correspondiente con badge de micrófono (SVG stroke del color del globo
    + fill gris), tap en avatar cicla velocidad 1×/2×/4× con badge y haptic
    (`Haptics.selectionAsync`), footer con duración a la izquierda y meta
    (chip `API/QR/IG/FB`, hora, palomitas) a la derecha. `playsInSilentMode`.
    Sin URL reproducible → cápsula "Nota de voz (enviada)". Para elegir la URL
    reproducible prefiere `dataUrl` sobre `url` y candidatos
    mp4/m4a/aac/mp3/wav (22277-22292); ogg/opus inbound se reproduce igual vía
    el player nativo (candidato fallback).
  - Documento: tarjeta con FileText, nombre, subtítulo `"PDF · 1.2 MB"`
    (`getNativeAttachmentSubtitle`), chevron; tap = `Linking.openURL`.
  - Ubicación: mini-mapa tiles OSM dentro del globo con badge `📍 Ubicación`;
    tap abre Apple Maps (`https://maps.apple.com/?ll=...&q=...` en iOS).
- **Nota de voz** (19293-19357): `expo-audio` recorder; permiso denegado →
  `"Necesito permiso de micrófono para grabar notas de voz."`; UI de grabación
  compacta (papelera, waveform animada, contador, pausar/reanudar, enviar); al
  terminar se convierte a attachment `audio/mp4` con `durationMs` y viaja por
  el mismo pipeline. Envío como payload WhatsApp `voice:true`.
- **Asistente IA** (referencia): adjuntos directos máx 8 MB c/u, 16 MB total,
  texto máx 1.5 MB / 18 000 chars (752-755); transcripción de audio vía
  `POST /api/ai-agent/transcribe` con `FileSystem.uploadAsync` **binario crudo**
  (`Content-Type: audio/m4a`, no data URL) — único upload binario directo del
  cliente RN (`api.ts:1136-1174`).
- **Preview de bandeja**: si el último mensaje es media sin texto, label
  `Foto`/`Video`/`Audio`/`Documento`/`Adjunto` (`getAttachmentLabel`).

### 7.3 Resolución de transporte al enviar media (RN, portar tal cual)

`nativeMessageOpensReplyWindow`/`getNativeApiReplyWindowOpen`
(22611-22634): ventana abierta = existe mensaje inbound WhatsApp (no
sms/messenger/instagram/email) con < 24 h. Si ventana cerrada y sin QR listo →
en vez de fallar, abre el sheet de plantillas. `transport` va `undefined`
(API decide) o `'qr'`.

---

## 8. Gaps / riesgos para iOS nativo

1. **Sin visor de imagen con zoom**: ni `/movil` (imagen inline `<img>`) ni la
   RN (tap → `Linking.openURL`, abre Safari) tienen visor full-screen con
   pinch-zoom. El prompt del proyecto lo pide para iOS: hay que construirlo
   nuevo (descargar la URL pública y presentarla en un visor con zoom/compartir).
   No requiere backend nuevo.
2. **Subida por data URL en JSON**: obliga a cargar el archivo completo (+33%
   base64) en memoria y depende del límite `express.json 35mb`. No hay endpoint
   multipart para media de chat (solo `/api/media/upload`, que exige licencia
   `settings_media` y NO envía el mensaje). Para archivos al límite (video
   25 MB) puede haber presión de memoria y 413 opaco del body-parser.
   OPEN QUESTION: ¿conviene agregar al backend un flujo "sube a
   `/api/media/upload` → manda `imageUrl/videoUrl...`"? Hoy los endpoints ya
   aceptan `imageUrl`/`videoUrl`/`audioUrl`/`documentUrl` HTTPS, así que la
   alternativa existe si la cuenta tiene `settings_media`, pero ningún cliente
   la usa para chat.
3. **Sin progreso de subida**: al ser un POST JSON único no hay progreso por
   chunks; con `URLSession` se puede reportar progreso del body upload, pero el
   servidor tarda además en transcodificar (video con ffmpeg puede tomar >10 s;
   ajustar timeouts del cliente; `/movil` y RN usan requests sin timeout corto).
4. **`media_url` puede faltar en legado**: mensajes antiguos con solo `media_id`
   del proveedor (histórico QR o media expirada) no tienen URL descargable; la
   RN muestra cápsula "Nota de voz"/tarjeta deshabilitada. En envíos nuevos desde
   Ristak, audio/imagen/video deben persistir URL interna de preview; esto
   incluye audio de Messenger/Instagram nativo de Meta, que manda a Graph una
   URL HTTPS de Ristak y conserva `media_url` local.
5. **URLs públicas sin auth**: cualquier persona con la URL del CDN puede ver
   el archivo (por diseño, WhatsApp lo necesita). No enviar estas URLs a logs
   de terceros.
6. **Audio inbound `audio/ogg;codecs=opus`**: `AVPlayer`/`AVAudioPlayer` de iOS
   **no reproducen OGG/Opus nativamente**. La RN depende del player de expo
   (que en iOS también tiene esta limitante — por eso su heurística
   `isNativePlayableAudioCandidate` prefiere mp4/m4a/aac/mp3/wav). Las notas de
   voz salientes se guardan como preview en `media_assets` con formato
   reproducible (`audio/mp4`/M4A cuando hace falta), aunque WhatsApp reciba
   OGG/Opus o Meta Graph reciba una URL de attachment. OPEN QUESTION: verificar
   en dispositivo si las notas de voz
   entrantes (ogg) se reproducen; si no, la app iOS necesitará un decodificador
   (p. ej. libopus/ogg) o pedir al backend un transcode a m4a.
7. **Tamaños dispares cliente/servidor**: el cliente valida imagen ≤16 MB (RN)
   u 8 MB (`/movil` cámara) pero el backend acepta hasta 25 MB de entrada. Para
   paridad usar los límites RN (§7.2); mensajes de error del backend ya vienen
   en español listos para mostrar.
8. **`GET /api/media/*` requiere licencia `settings_media`**: si la app iOS
   quiere una biblioteca de medios o el uso de almacenamiento en Ajustes, debe
   manejar 403 de licencia/módulo con estado vacío elegante.
9. **Avatar de iniciales**: la URL firmada solo llega en payloads de push; para
   avatares en la UI la app debe generar iniciales localmente (como hace RN)
   usando la misma paleta de 8 colores si quiere consistencia visual con las
   notificaciones.
10. **Descarga de documentos**: RN abre el documento en el navegador
    (`Linking.openURL`). En iOS nativo lo correcto es `QLPreviewController` /
    descargar a tmp y compartir; no hay endpoint de descarga autenticado para
    media de chat (usar la URL pública directa).
11. **`retryMediaAsset` es un stub**: siempre 409 para assets fallidos; no
    diseñar UI de "reintentar" alrededor de él.
12. **GIFs**: llegan como `image` con `isGif` heurístico o como video corto;
    `/movil` los reproduce como `<video autoplay loop muted>`. En iOS usar
    reproducción loop silenciosa cuando el probe contenga `gif`.

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **CORRECCIÓN — §3 (gating de los envíos de chat):** el encabezado "montados con
   `requireAuth` (sin gate de licencia/módulo extra)" es impreciso: el mount
   `app.use('/api/whatsapp-api', requireAuth, requireFeature('whatsapp'), ...)`
   (`server.js:341`) SÍ exige la **feature de licencia `whatsapp`**. Es correcto que no
   hay gate de módulo (`accessConfig`) en `/messages/*`. Con plan sin `whatsapp`, todo
   envío de media devuelve 403 `feature_not_available` (alertar: los envíos son POST).
2. **CONFIRMADO — §4 (avatar de iniciales):** la URL firmada solo puede generarla el
   backend; el cliente únicamente la consume desde payloads push (verificado
   `pushController.js:28-43`).
