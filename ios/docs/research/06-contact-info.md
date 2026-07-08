# 06 — Contact Info (Contacto: entidad, ficha, custom fields, etiquetas, asignación, ocultos, avatar)

> Spec de investigación para la app nativa iOS (SwiftUI). Fuente de verdad: backend Node
> (`backend/src/controllers/contactsController.js`, `contactTagsController.js`,
> `contactAssignmentController.js`, `contactSocialProfileController.js`,
> `hiddenContactsController.js`, `pushController.js`) y las superficies móviles existentes
> (`frontend/src/pages/PhoneChat/PhoneChat.tsx` para `/movil` y `mobile/src/App.tsx` para la
> app Expo). Los agentes Swift NO deben re-leer los fuentes TS/JS: este documento es
> autosuficiente. Todo lo que no está claro se marca como **OPEN QUESTION**.

---

## 0. Convenciones generales de la API

- Base: `/api`. Autenticación: `Authorization: Bearer <token JWT>` (middleware `requireAuth`).
- Envelope estándar: `{ "success": true, "data": ... }`. El cliente web (`frontend/src/services/apiClient.ts:122-125`)
  desempaqueta `data` **solo si existen ambas claves** `success` y `data`. Varios endpoints de este
  módulo NO usan la clave `data` (asignación, linked-social, papelera) — ver cada endpoint.
- Errores: `{ "success": false, "error": "<mensaje en español>" }` + HTTP status. Algunos añaden
  `code` (`merge_confirmation_required`, `duplicate_email`) y `conflict`.
- Permisos (middleware `requireModuleAccess`, `backend/src/routes/contacts.routes.js`):
  - Todo `/api/contacts/*` y `/api/contact-tags/*` exige módulo **`contacts`**.
  - `/api/contacts/chats*` y `/api/contacts/:id/linked-social` exigen **además** módulo **`chat`** (ACL-001).
  - `/api/hidden-contacts` GET: cualquier usuario autenticado; POST/DELETE: **solo admin** (ACL-003).
  - `/api/settings/custom-fields*` exige módulo **`settings_custom_fields`** (`settings.routes.js:55`).

---

## 1. Modelo de datos

### 1.1 Contact — respuesta de `GET /api/contacts/:id` (forma "mapeada")

Construida en `contactsController.js:3447-3511` (`mappedContact`). Campos exactos:

| Campo JSON | Tipo | Nulabilidad | Notas |
|---|---|---|---|
| `id` | string | nunca null | IDs `rstk_contact_<20 alfanum>`; legacy: `waapi_contact_*`, `manual_contact_*`, `meta_social_contact_*`, `site_contact_*`, o IDs crudos de HighLevel (`contactIdentityService.js:33-50`) |
| `createdAt` | string (timestamp ISO o SQL) | puede venir null | `contacts.created_at` |
| `name` | string | `''` si vacío | **Derivado** — ver §5.2 (no es `full_name` crudo) |
| `email` | string | `''` si vacío | |
| `phone` | string | `''` si vacío | E.164 normalizado (`+52...`) — ver §5.1 |
| `ltv` | number | 0 | Suma de pagos exitosos no-test (`total_paid`) |
| `status` | string enum | nunca null | `'lead' \| 'appointment' \| 'customer'` — derivado, ver §5.3 |
| `lastPurchase` | string \| null | | `last_customer_payment_date \|\| last_purchase_date` |
| `purchases` | number | 0 | count de pagos exitosos (incluye test en `customer_payments_count`) |
| `successfulPaymentsCount` | number | 0 | igual a `purchases` |
| `source` | string \| null | | ej. `ristak_manual`, `whatsapp_api`, `gohighlevel`… texto libre |
| `ad_name`, `ad_id` | string \| `''` | | resueltos vía atribución Meta (`buildResolvedMetaAdFields`) |
| `campaign_id`, `campaign_name`, `adset_id`, `adset_name` | string \| `''`/null | | solo en GET /:id |
| `preferredWhatsAppPhoneNumberId` | string | `''` | número de negocio fijado para este chat |
| `preferred_whatsapp_phone_number_id` | string | `''` | duplicado snake_case (mismo valor) |
| `profilePhotoUrl` | string \| null | | ver orden de resolución §5.4 |
| `phones` | `ContactPhoneNumber[]` | `[]` | ver 1.2; el principal primero |
| `phoneNumbers` | `ContactPhoneNumber[]` | `[]` | alias idéntico a `phones` |
| `customFields` | `ContactCustomField[]` | `[]` | ver 1.3 (valores normalizados) |
| `tags` | `string[]` | `[]` | **IDs** de etiqueta del catálogo (no nombres) |
| `notes` | string | siempre `''` | placeholder, no existe backend de notas |
| `payments` | `Payment[]` (filas crudas snake_case de tabla `payments`) | `[]` | excluye `status='deleted'` y checkouts de sitio no completados; orden fecha DESC (`:3197-3208`) |
| `appointments` | `Appointment[]` (filas crudas snake_case) | `[]` | DB local + fallback en vivo a HighLevel (cachea); incluye citas de contactos con mismo teléfono; dedupe por id; orden `start_time` DESC (`:3216-3381`) |
| `firstAppointmentDate` | string \| null | | primera cita por `start_time` |
| `nextAppointmentDate` | string \| null | | próxima cita futura no cancelada |
| `hasAppointments` | boolean | | citas activas (status no cancelado) |
| `hasShowedAppointment` | boolean | | asistió (status showed/attended/completed o señal de asistencia o pagó) |
| `hasAttendedAppointment` | boolean | | alias de `hasShowedAppointment` |
| `hasUpcomingConfirmedAppointmentBadge` | boolean | | `confirmation_badge_until > now` |
| `attribution_url` | string \| null | | |
| `attribution_session_source` | string \| null | | |
| `attribution_medium` | string \| null | | |
| `attribution_ctwa_clid` | string \| null | | Click-to-WhatsApp CLID |
| `whatsappAttributionPlatform` | string \| null | | ej. `facebook`/`instagram` normalizado |
| `metaAttribution` | object \| null | | `{ source, matchType, campaignId, campaignName, adsetId, adsetName, adId, adName, creativeThumbnailUrl, creativeImageUrl, creativeVideoUrl, creativePreviewUrl, date }` (ver `frontend/src/types/index.ts:47-61`) |
| `firstSession` | object \| null | | primera sesión de tracking: `{ started_at, page_url, landing_page, referrer_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, source_platform, site_source_name, campaign_name, adset_name, ad_name, ad_id, device_type, browser, os, placement, geo_city, geo_region, geo_country }` (`:3487-3510`) |

Query params de `GET /api/contacts/:id`:

| Param | Tipo | Default | Efecto |
|---|---|---|---|
| `warmProfilePictures` (alias `warmProfiles`, `hydrateProfilePictures`) | `'false'\|'0'\|'no'\|'off'` para apagar | on | refresca foto de perfil WhatsApp API/QR antes de responder |
| `refreshExternalAppointments` (alias `refreshAppointments`) | idem | on | consulta citas en HighLevel en vivo (lento); el chat pasa `false` |

Errores: `404 {success:false, error:'Contacto no encontrado'}` (también si el contacto cae bajo un
filtro de ocultos o está en papelera — SEC-005/ACL-002), `500 'Error obteniendo contacto'`.

### 1.2 ContactPhoneNumber (`buildContactPhonesForResponse`, `contactsController.js:1737-1782`)

```json
{
  "id": "rstk_contact_phone_... | <phone> | '<contactId>-primary-phone'",
  "phone": "+5215512345678",
  "label": "Principal" | "Adicional" | "<texto libre>",
  "isPrimary": true,
  "is_primary": true,
  "source": "manual" | "merge" | "" | ...,
  "createdAt": "…"|null,
  "updatedAt": "…"|null
}
```
- El teléfono principal (`contacts.phone`) siempre aparece primero con `label:"Principal"`.
- Los adicionales vienen de tabla `contact_phone_numbers` (se llenan al fusionar o registrar).
- Dedupe por valor de teléfono.

### 1.3 ContactCustomField (valor en un contacto)

Forma normalizada devuelta en `customFields` (`backend/src/utils/contactCustomFields.js:149-196`):

```json
{
  "id": "", "definitionId": "rstk_contact_field_...", "key": "presupuesto",
  "fieldKey": "presupuesto", "label": "Presupuesto", "name": "Presupuesto",
  "dataType": "currency" | null,
  "value": <string|number|boolean|array|object|null>,
  "options": [{"label":"A","value":"A"}],
  "model": "contact",
  "syncTarget": "local"|"highlevel"|"none"|null,
  "sourceType": "manual"|"system"|"site_form"|...|null,
  "sourceId": null, "sourceSiteId": null, "sourcePageId": null,
  "sourceFormId": null, "sourceFormName": null, "sourceFieldId": null,
  "sourceFieldName": null, "sourceLabel": null, "sourceContext": null
}
```
- Se filtran entradas sin `id` ni `key` ni `label`.
- Al hacer PUT, el backend acepta claves alternativas (`field_value`, `fieldValue`, `value`, `val`
  para el valor; `key`/`fieldKey`/`field_key`/`name`/`label` para la identidad) — pero el cliente
  nativo debe mandar la forma canónica: `{ key, fieldKey, label, dataType, value }` (+
  `definitionId` si se conoce).

### 1.4 ContactCustomFieldDefinition (`contactCustomFieldDefinitionsService.js:213-251`)

```json
{
  "definitionId": "rstk_contact_field_...",
  "key": "presupuesto", "fieldKey": "presupuesto",
  "label": "Presupuesto", "name": "Presupuesto",
  "description": "",
  "dataType": "text",
  "options": [{"label":"...","value":"..."}],
  "folderId": "" , "folderName": "",
  "fieldGroup": "general",
  "syncTarget": "local" | "highlevel" | "none",
  "sourceType": "manual" | "system" | "...",
  "sourceId": "", "sourceSiteId": "", "sourcePageId": "", "sourceFormId": "",
  "sourceFormName": "", "sourceFieldId": "", "sourceFieldName": "", "sourceLabel": "",
  "sourceContext": null,
  "ownerUserId": 3 | null,
  "archived": false,
  "system": false, "systemManaged": false, "locked": false,
  "editable": true, "deletable": true,
  "createdAt": "…", "updatedAt": "…",
  "sources": [ { "id", "definitionId", "sourceType", "sourceId", "sourceSiteId",
                 "sourcePageId", "sourceFormId", "sourceFormName", "sourceFieldId",
                 "sourceFieldName", "sourceLabel", "sourceContext",
                 "occurrenceCount": 1, "firstSeenAt", "lastSeenAt" } ]
}
```

**Tipos de dato válidos** (`DATA_TYPES`, `:60-80`): `text, textarea, number, currency, dropdown,
radio, checkboxes, date, datetime, time, email, phone, select, multiselect, checkbox, boolean,
url, file, json`. Aliases normalizados: `string/short_text/plain_text→text`,
`long_text/paragraph→textarea`, `select→dropdown`, `multiselect→checkboxes`. Tipos con opciones
(`CHOICE_DATA_TYPES`): `dropdown, radio, checkboxes, select, multiselect, checkbox`.

**Claves reservadas** (no pueden ser custom field): `full_name, first_name, last_name, phone,
email, message`. **Claves de sistema** (solo escribibles por el sistema; visibles como
`system:true, locked:true`): `city, company, address_1, whatsapp_api_provider,
whatsapp_api_first_message, whatsapp_api_source_id, whatsapp_api_ctwa_clid,
whatsapp_api_source_url` (`:8-58`).

**Reglas de edición de definiciones** (`:746-833`):
- `key` y `dataType` son **inmutables** tras crear (400: "El ID del campo no se puede cambiar…",
  "El tipo del campo no se puede cambiar después de crearlo.").
- Campos de sistema: 403 "Este campo lo crea Ristak para datos internos del sistema…".
- `options` solo editable si el tipo es de opciones (400 "Este tipo de campo no usa opciones.").
- Los custom fields son **compartidos por todo el equipo** (CNT-009): la búsqueda por key no
  filtra por owner; `ownerUserId` es solo metadato.

**Folder de custom fields** (`mapFolder`): `{ id, name, description, sortOrder, archived, createdAt, updatedAt }`.

### 1.5 ContactTag y carpetas (`contactTagsService.js`)

```json
// etiqueta de usuario
{ "id": "rstk_tag_...", "name": "VIP", "folderId": null, "isSystem": false,
  "createdAt": "…", "updatedAt": "…", "usageCount": 12 }   // usageCount solo con includeUsage/catalog
// etiqueta interna (calculada, no editable, NO se guarda en contacts.tags)
{ "id": "client" | "booked" | "lead", "name": "Cliente" | "Cita agendada" | "Prospecto", "isSystem": true }
// carpeta
{ "id": "rstk_tag_folder_...", "name": "...", "description": "", "createdAt": "…", "updatedAt": "…" }
```
- `contacts.tags` almacena SOLO IDs de etiquetas de usuario (JSON array). Las 3 internas se
  calculan por actividad (`computeSystemTagIds`: pagó→`client`; cita activa→`booked`; si no→`lead`).
- Aliases legacy aceptados en entrada: `tag_sys_customer→client`, `tag_sys_appointment→booked`,
  `tag_sys_lead→lead`, `cliente`, `customer`, `cita`, `appointment`, `prospecto`, `lead`…
- Nombres de las internas son personalizables por cuenta (`highlevel_config.custom_labels`).

### 1.6 Asignación (responsable) — `contactAssignmentController.js`

- Usuario asignable: `{ "id": "3", "name": "Raúl Gómez", "role": "admin" | null }`.
- Asignación: `contacts.assigned_user_id` (string id de `users`). Se usa para enrutar
  notificaciones de chat al responsable.

### 1.7 Perfil social vinculado — `contactSocialProfileController.js`

```json
{
  "success": true,
  "profiles": [ { "platform": "instagram"|"messenger"|"facebook",
                  "platformLabel": "Instagram"|"Facebook"|"Meta",
                  "kind": "dm"|"comment",
                  "name": "…"|null, "username": "usuario_sin_@"|null,
                  "photo": "https://…"|null, "metaUserId": "…"|null } ],
  "linked":   [ { "contactId": "…", "platform", "platformLabel", "kind",
                  "name": "…"|null, "username": "…"|null, "photo": "…"|null } ]
}
```
- `kind='comment'` si `sender_id` empieza con `fb_comment:`/`ig_comment:`; si no, `dm`.
- `linked` = otros contactos (misma persona: mismo `platform`+`meta_user_id`) no fusionados.
- **Sin clave `data`** — decodificar el objeto completo.

### 1.8 Filtro de contactos ocultos — `hiddenContactsController.js`

```json
{ "id": "12", "filterText": "test", "matchType": "contains" | "exact", "createdAt": "…" }
```
Comportamiento (`backend/src/utils/hiddenContactsFilter.js:54-92`): cualquier contacto cuyo
`full_name`, `email`, `phone` o `id` coincida (contains = LIKE %…%, exact = igualdad
case-insensitive) queda EXCLUIDO de lista, búsqueda, chats **y detalle por ID (404)**. No es un
"bloqueo" por contacto: es un filtro global por texto.

### 1.9 Papelera (soft-delete)

Fila de `GET /api/contacts/trash`: `{ id, full_name, email, phone, source, deleted_at,
total_paid, purchases_count }` (snake_case, envuelto en `{ success:true, contacts:[...] }` —
**clave `contacts`, no `data`**).

---

## 2. Endpoints

### 2.1 Contacto: CRUD y detalle

| Método | Path | Descripción |
|---|---|---|
| GET | `/api/contacts` | Lista paginada (módulo Contactos de escritorio) |
| GET | `/api/contacts/search?q=` | Búsqueda rápida (máx 20) |
| GET | `/api/contacts/:id` | Detalle completo (§1.1) |
| POST | `/api/contacts` | Crear contacto manual |
| PUT | `/api/contacts/:id` | Actualizar (campos, tags, custom fields, número preferido) |
| DELETE | `/api/contacts/:id` | Soft-delete → papelera |
| GET | `/api/contacts/trash?limit=` | Lista papelera (limit 1–500, default 100) |
| POST | `/api/contacts/:id/restore` | Restaurar de papelera |
| DELETE | `/api/contacts/:id/permanent` | Borrado definitivo (pagos se conservan desacoplados) |
| GET | `/api/contacts/:id/journey` | Timeline/journey (documentado en el módulo de chat) |
| GET | `/api/contacts/:id/payment-link-delivery-options` | Canales para enviar link de cobro |
| GET | `/api/contacts/:id/whatsapp-routing-events` | Historial de cambios de número preferido |

#### GET `/api/contacts` (lista, `contactsController.js:2741-3078`)

Query: `page` (1), `limit` (50, máx 500), `search`, `sortBy` (`created_at` default; whitelist en
`contactListFilterService`), `sortOrder` (`ASC|DESC`), `startDate`, `endDate` (ISO; interpretados
en TZ de la cuenta), `filter` (quick filter: `all` default; valores como `customers`… ver
`normalizeContactListQuickFilter`), `trackingFilters` (JSON string), `advancedFilters` (JSON
string), `warmProfilePictures` (`true` para hidratar fotos). Respuesta:

```json
{ "success": true, "data": [ <contacto mapeado tipo lista> ],
  "pagination": { "page":1, "limit":50, "total":123, "totalPages":3, "hasNext":true, "hasPrev":false } }
```
El contacto "tipo lista" = §1.1 **sin** `payments/appointments/firstSession/metaAttribution/
campaign_*/adset_*` y **con** `socialProfileName`, `socialUsername`, `paymentsCount`,
`failedPaymentsCount` (ver `mapContactRowForResponse` `:1831-1871`). `ad_name/ad_id` aquí se
"sanean" (se vacían si parecen nombre del contacto, `getSafeContactAdFields`).

#### GET `/api/contacts/search?q=<texto>` (`:3530-3677`)

- Sin `q` → `{success:true, data:[]}`. Máximo 20 resultados, rankeados.
- Respuesta por item: `{ id, createdAt, name, email, phone, ltv, status, lastPurchase, purchases,
  successfulPaymentsCount, hasAppointments, hasShowedAppointment, hasAttendedAppointment,
  hasUpcomingConfirmedAppointmentBadge, source, ad_name, ad_id, profilePhotoUrl, phones,
  phoneNumbers, notes:'' }`.
- Excluye ocultos y papelera. La app RN lo usa para "Nuevo chat" y búsqueda de invitados.

#### POST `/api/contacts` (`:3830-3957`)

Body (todos opcionales, pero al menos uno de nombre/correo/teléfono):

```json
{ "name": "Juan Pérez",          // o "full_name"; o "first_name"+"last_name"
  "first_name": "Juan", "last_name": "Pérez",
  "email": "a@b.com",            // se guarda en minúsculas
  "phone": "5512345678",         // se normaliza con lada de la cuenta (§5.1)
  "source": "ristak_manual",     // default 'ristak_manual'
  "createdAt": "2026-07-07T18:00:00.000Z"  // opcional, ISO
}
```
- Validación: 400 `'Agrega al menos nombre, correo o teléfono para crear el contacto'`.
- Duplicados: 409 con mensaje específico
  `'Ya existe un contacto con ese correo. Búscalo en la lista y edítalo si necesitas cambiar algo.'`
  (o "…con ese teléfono…"). También mapea violaciones UNIQUE concurrentes a 409 (CNT-012).
- 201 → `{ success:true, data: <contacto tipo lista> }` (SIN payments/appointments).
- Registra el teléfono como `contact_phone_numbers` principal (`source:'manual'`).
- Dispara evento de automatización `contact-created`.
- La app RN usa `source: 'mobile_native_appointment_guest'` al crear invitados de cita
  (`mobile/src/App.tsx:9430`). El buscador de escritorio usa `contactsService.createContact`
  con `{name, email?, phone?}`.

#### PUT `/api/contacts/:id` (`:4064-4436`) — el endpoint central de la ficha

Body — todos los campos opcionales; solo se actualiza lo presente:

| Campo | Tipo | Regla |
|---|---|---|
| `full_name` | string | el cliente debe mapear `name→full_name` (los clientes existentes lo hacen) |
| `email` | string | conflicto → 409 (ver abajo) |
| `phone` | string | se normaliza a E.164 con lada de cuenta; conflicto → 409; **si `confirmMerge:true` y otro contacto tiene ese teléfono, se FUSIONA** (ver §5.5) |
| `source` | string | libre |
| `attribution_ad_name`, `attribution_ad_id` | string | edición manual de atribución |
| `tags` | string[] | REEMPLAZA el set completo. Acepta IDs o nombres (nombres desconocidos se crean, `resolveTagIds(createMissing:true)`); IDs de etiquetas internas se descartan |
| `customFields` | ContactCustomField[] | 400 si no es array. Se MERGEA con los existentes por identidad (id/key/fieldKey/label). Crea definiciones que no existan. Claves de sistema se ignoran silenciosamente |
| `dnd` | boolean | solo se reenvía a HighLevel (no se persiste local) |
| `dndSettings` | object | idem |
| `preferredWhatsAppPhoneNumberId` (o `preferred_whatsapp_phone_number_id`) | string \| "" | `""` limpia el número fijado; si no existe en `whatsapp_api_phone_numbers` → 400 `'Ese número de WhatsApp no está conectado'` |
| `routingSource` | `'manual'`\|`'contingency'` | metadato del cambio de número (default manual) |
| `routingReason` (o `preferredWhatsAppPhoneNumberReason`) | string | texto libre del rastro |
| `confirmMerge` | boolean \| 'true' | autoriza la fusión al chocar teléfono/email (CNT-001) |

Errores:
- 404 `'Contacto no encontrado'`.
- 400 `'customFields debe ser un arreglo'`, 400 `'No hay campos para actualizar'` (body vacío),
  400 `'Ese número de WhatsApp no está conectado'`.
- **409 fusión requerida** (sin `confirmMerge`):
  ```json
  { "success": false, "code": "merge_confirmation_required",
    "error": "El teléfono ya pertenece a otro contacto. Confirma la fusión para continuar.",
    "conflict": { "field": "phone",
                  "contact": { "id": "…", "full_name": "…"|null, "phone": "…"|null } } }
  ```
  Variante email: `field:"email"`, `contact` incluye `email` y `phone`.
- 409 `code:'duplicate_email'` `'El email ya pertenece a otro contacto. Usa uno distinto o confirma la fusión.'`
  (constraint UNIQUE en carrera, CNT-004).
- 500 `'Error actualizando contacto'`.

Respuesta 200 — **OJO: forma distinta al GET**. Es la fila cruda de la tabla `contacts`
(snake_case: `full_name`, `first_name`, `created_at`, `updated_at`, `assigned_user_id`,
`ghl_contact_id`, `attribution_*`, `total_paid`, `purchases_count`, `deleted_at`, etc.) con
overrides: `preferredWhatsAppPhoneNumberId`, `phones`, `phoneNumbers`, `customFields`
(normalizados), `tags` (array de IDs) (`:4385-4407`). **Recomendación nativa: tras un PUT
re-fetch `GET /contacts/:id` o parchear el modelo local con lo enviado (como hacen /movil y RN)
en lugar de decodificar esta respuesta.**

Efectos secundarios: sincroniza a HighLevel si el contacto tiene `ghl_contact_id` (fallos NO
bloquean el guardado local, CNT-008); registra `whatsapp_routing_events` al cambiar el número
preferido; dispara automatizaciones `contact-updated` (changedFields) y `tag-changed`
(added/removed por tag).

#### DELETE / papelera (`:4604-4713`)

- `DELETE /api/contacts/:id` → 200 `{ success:true, message:'Contacto movido a la papelera. Sus pagos e historial se conservan; puedes restaurarlo.' }`.
  Soft-delete (`deleted_at`), limpia `ghl_contact_id`, borra también en HighLevel si estaba ligado.
- `GET /api/contacts/trash?limit=100` → `{ success:true, contacts:[…] }` (§1.9).
- `POST /api/contacts/:id/restore` → `{ success:true, message:'Contacto restaurado correctamente' }`; 404 si no está en papelera.
- `DELETE /api/contacts/:id/permanent` → `{ success:true, message:'Contacto borrado permanentemente. Sus pagos se conservaron en el historial.' }`; los pagos quedan con `contact_id = NULL`.

#### GET `/api/contacts/:id/payment-link-delivery-options` (`:3679-3825`)

Respuesta `data`:
```json
{ "contact": { "id", "name", "email", "phone" },
  "channels": {
    "whatsapp":  { "key":"whatsapp",  "label":"WhatsApp",          "available":bool, "connected":bool, "value":"<tel>",   "reason":"El contacto no tiene teléfono" | "Conecta WhatsApp API para enviar este link desde Ristak" | "" },
    "messenger": { "key":"messenger", "label":"Messenger DM",      "available":bool, "connected":bool, "value":"<nombre|user>", "reason":"El contacto no tiene Messenger enlazado" | "Activa Messenger en Configuración > Meta Ads > Redes sociales" | "" },
    "instagram": { "key":"instagram", "label":"Instagram DM",      "available":bool, "connected":bool, "value":"…", "reason":"El contacto no tiene Instagram enlazado" | "Activa Instagram en …" | "" },
    "email":     { "key":"email",     "label":"Correo electrónico","available":bool, "connected":bool, "value":"<email>", "reason":"El contacto no tiene correo" | "El correo no está conectado" | "" }
  } }
```

### 2.2 Custom fields (definiciones)

| Método | Path | Gate | Notas |
|---|---|---|---|
| GET | `/api/contacts/custom-fields?includeArchived=true` | contacts | → `data: ContactCustomFieldDefinition[]` (ordenadas por carpeta/label) |
| POST | `/api/contacts/custom-fields` | contacts | upsert por key; 400 `'Ese campo pertenece a los datos principales del contacto'` si key reservada; body = definición parcial `{ key/fieldKey, label/name, dataType/type, options, folderId, description, syncTarget }` → 201 `data: definición` |
| PUT | `/api/contacts/custom-fields/:definitionId` | contacts | edita `label`, `folderId`, `options`, `archived`; 404 si no existe; 400/403 según reglas §1.4 |
| GET | `/api/settings/custom-fields?includeArchived=` | settings_custom_fields | → `data: { folders: Folder[], fields: Definition[] }` |
| POST | `/api/settings/custom-fields` | settings_custom_fields | `createOnly:true` → 409 `'Ese ID ya existe…'` si la key existe; 400 `'Usa un ID de campo válido y que no sea reservado'` |
| PUT | `/api/settings/custom-fields/:definitionId` | settings_custom_fields | igual que el PUT de contacts |
| DELETE | `/api/settings/custom-fields/:definitionId` | settings_custom_fields | **única vía de borrado**; elimina la definición Y borra el valor en todos los contactos; 404/403 |
| POST | `/api/settings/custom-field-folders` | settings_custom_fields | `{name, description?}` → 201 folder |
| PUT | `/api/settings/custom-field-folders/:folderId` | settings_custom_fields | `{name?, description?, sortOrder?, archived?}` |
| DELETE | `/api/settings/custom-field-folders/:folderId` | settings_custom_fields | archiva la carpeta y desasigna sus campos (`folder_id=NULL`) |

Valores por contacto: se editan vía `PUT /api/contacts/:id { customFields: [...] }` o en bloque
`POST /api/contacts/bulk/custom-fields { contactIds: string[] (1..1000), customFields: [...] }`
→ `data: { updated, total, customFields }` (400 `'Selecciona al menos un contacto'`,
`'Máximo 1000 contactos por operación'`, `'Selecciona al menos un campo personalizado'`).

### 2.3 Etiquetas (`/api/contact-tags`, gate `contacts`)

| Método | Path | Body/Query | Respuesta / errores |
|---|---|---|---|
| GET | `/` | `?includeSystem=true&includeUsage=true` | `data: ContactTag[]` (con `usageCount` si includeUsage) |
| GET | `/system` | — | `data: [{id:'client'…,isSystem:true}]` |
| GET | `/catalog` | `?includeSystem=true` | `data: { tags: ContactTag[] (con usageCount), folders: TagFolder[] }` |
| POST | `/` | `{ "name": "VIP", "folderId": "rstk_tag_folder_…"? }` | 201 `data: tag`. Si ya existe una con ese nombre normalizado devuelve la existente. 400 `'El nombre de la etiqueta no puede estar vacío'` / `'Ese nombre está reservado para el estado interno del contacto'`; nombre máx 60 chars |
| PUT | `/:id` | `{ name?, folderId? }` | 400 internas no editables; 404; 409 `'Ya existe una etiqueta con ese nombre'` |
| DELETE | `/:id` | — | `{success:true}`; borra del catálogo Y la quita de todos los contactos; 400 si es interna; 404 |
| POST | `/folders` | `{ name, description? }` | 201 folder; 409 nombre duplicado |
| DELETE | `/folders/:id` | — | `{success:true}`; etiquetas quedan sin carpeta |

Aplicar/quitar en bloque: `POST /api/contacts/bulk/tags`
`{ "contactIds": ["…"], "addTagIds": ["rstk_tag_…"|"nombre"], "removeTagIds": [...] }`
→ `data: { updated: n, total: m }`. Límite 1000 contactos. `addTagIds` crea nombres desconocidos.
(La app RN agrega una etiqueta a UN contacto usando este endpoint con un solo contactId,
`mobile/src/api.ts:441-450`.)

### 2.4 Asignación de responsable (gate `contacts`)

| Método | Path | Respuesta |
|---|---|---|
| GET | `/api/contacts/assignable-users` | `{ "success": true, "users": [ {"id","name","role"} ] }` — **clave `users`, sin `data`** |
| GET | `/api/contacts/:id/assignment` | `{ "success": true, "assignedUserId": "3" \| null }`; 404 contacto inexistente |
| PUT | `/api/contacts/:id/assignment` | body `{ "userId": "3" \| null \| "" }` (null/"" desasigna) → `{ "success": true, "assignedUserId": … }`; 400 `'Usuario no válido'` si inactivo/inexistente |

UI actual: solo el chat de ESCRITORIO (`DesktopChat.tsx:3997-4060`). Ni `/movil` ni la app RN
muestran asignación. **El detalle del contacto (GET /:id) NO incluye `assigned_user_id`** — hay
que pedir `/assignment` aparte.

### 2.5 Perfil social vinculado

`GET /api/contacts/:id/linked-social` — gate `contacts` **y** `chat`. Respuesta §1.7.
400 `'Falta el contacto'`, 500 `'No se pudo leer el perfil social del contacto'`.

### 2.6 Contactos ocultos (`/api/hidden-contacts`)

| Método | Path | Gate | Body | Respuesta |
|---|---|---|---|---|
| GET | `/` | auth | — | `data: [{id, filterText, matchType, createdAt}]` |
| POST | `/` | **admin** | `{ "filterText": "spam", "matchType": "contains"\|"exact" }` | `data: filtro`; 400 texto requerido / matchType inválido; 409 `'Este filtro ya existe'` |
| DELETE | `/:id` | **admin** | — | `{ success:true, message:'Filtro eliminado correctamente' }`; 404 |

UI actual: solo Configuración de escritorio (`frontend/src/pages/Settings/HighLevelIntegration.tsx`).
No existe acción "ocultar contacto" en /movil ni en RN.

### 2.7 Avatar de iniciales (PNG generado por backend)

`GET /api/push/contact-avatar/:contactId?i=<INICIALES>&c=<colorIndex>&s=<firma>`
(`push.routes.js:15`, `pushController.js:28-43`, `pushNotificationsService.js:842-988`).

- PNG 512×512, círculo de color con 1–2 iniciales blancas. `Cache-Control: public, max-age=31536000, immutable`.
- **La URL está firmada con HMAC** (secreto derivado de llaves del servidor): el cliente NO puede
  construirla; solo llega ya armada dentro de payloads de notificación push (fallback cuando el
  contacto no tiene foto real). Firma inválida → 404 `Not found` (texto plano).
- Iniciales: 2 primeras letras de las 2 primeras palabras del nombre para mostrar; color =
  `sha256(contactId:nombre:iniciales)[0] % numColores`.
- **Para la app nativa**: renderizar iniciales localmente en la UI (como hacen /movil y RN con la
  primera letra); usar esta URL solo si viene en una notificación push.

### 2.8 Relacionados (documentados en otros módulos, listados por completitud)

- `GET /api/contacts/chats`, `POST /api/contacts/chats/read`, `POST /api/contacts/chats/:id/read`
  (bandeja de chat; gate `chat`). El item de chat = contacto tipo lista + `lastMessage*`,
  `unreadCount`, `messageCount`, `hasCommentMessage`, `hasPrivateDm`, `lastBusinessPhone*`… (`mapChatContactRowForResponse` `:1873-1891`).
- `GET /api/contacts/:id/journey` (timeline: mensajes, visitas, citas, pagos…).
- `GET /api/contacts/stats`, `/chart`, `POST /sync-stats` (analytics de contactos).
- `POST /api/contacts/bulk-actions/*` (envíos masivos WhatsApp/automatización).
- `GET /api/contacts/:id/whatsapp-routing-events` (historial de cambios de número).

---

## 3. Reglas de negocio y derivaciones (backend)

### 5.1 Normalización de teléfono (`backend/src/utils/phoneUtils.js`, `accountLocale.js`)

- Almacenamiento canónico: E.164 `+<código país><10 dígitos>` vía `normalizePhoneForStorage`.
- Lada por defecto = configuración de cuenta (`account_default_dial_code`, default **52** México;
  país default MX / moneda MXN, `accountLocale.js:9-13`). 10 dígitos "pelones" → `+52…`.
- México: `521 + 10 dígitos` (JID de WhatsApp) se colapsa a `+52 + 10 dígitos`.
- Menos de 7 dígitos → inválido (null).
- Matching de duplicados (`buildPhoneMatchCandidates`): expande candidatos (con/sin `+`, con/sin
  lada, 52/521 solo para números MX; NO cruza países distintos que compartan 10 dígitos, CNT-005).
- Validación de UI móvil (ambas apps): regex `^\+?\d{7,15}$` tras limpiar no-dígitos
  (se conserva `+` inicial). Mensaje: "Revisa que el número tenga lada y entre 7 y 15 dígitos."

### 5.2 Nombre para mostrar (`getContactDisplayName`, `contactsController.js:1682-1706`)

Prioridad: (1) nombre social Meta si el guardado parece un @handle; (2) `full_name` guardado si
no parece teléfono/JID; (3) nombre de perfil WhatsApp API; (4) nombre en raw profile JSON;
(5) `first_name`; (6) nombre social; (7) teléfono; (8) `''`. El backend ya lo resuelve en el
campo `name` — el cliente nativo debe usar `name` tal cual (los clientes actuales aplican además
Title Case cosmético con `formatName`).

### 5.3 Status derivado

`customer` si `customer_payments_count > 0` (pagos exitosos, incluye modo test); si no,
`appointment` si tiene citas activas; si no `lead`. Etiquetas internas (client/booked/lead)
siguen la misma lógica pero excluyen citas canceladas de otra lista (§1.5).

### 5.4 Foto de perfil (`getContactProfilePhotoUrl`, `:1671-1680`)

Orden: `profile_photo_url` → `profile_picture_url` → foto WhatsApp API → foto WhatsApp QR →
foto Meta social → `avatar_url` → `photo_url` → `picture_url` → foto embebida en raw profile
JSON. El resultado llega en `profilePhotoUrl` (string|null). URLs de WhatsApp caducan; el backend
las "recalienta" cuando `warmProfilePictures` está activo.

### 5.5 Fusión de contactos (merge, CNT-001/CNT-002; `contactIdentityService.js:364-525`)

Al `PUT` con `phone` que ya pertenece a otro contacto y `confirmMerge:true`:
- El OTRO contacto (matched) se absorbe en el contacto editado: se suman `total_paid` y
  `purchases_count`, se unen `tags` y `customFields` (prioridad al sobreviviente), se conservan
  `ghl_contact_id` y `preferred_whatsapp_phone_number_id` si faltaban, todas las referencias
  (mensajes, citas, pagos, etc.) se reasignan, el teléfono viejo queda como "Adicional", y el
  contacto absorbido se BORRA físicamente.
- Con email el flujo es igual de gate (409 sin confirm) pero la escritura solo actualiza el email;
  si el UNIQUE truena en carrera → 409 `duplicate_email`. **OPEN QUESTION:** con
  `confirmMerge:true` y conflicto de email (sin conflicto de teléfono) el backend NO ejecuta una
  fusión: intenta el UPDATE y puede fallar con `duplicate_email`. El diálogo de escritorio
  reintenta con `confirmMerge:true` para ambos casos; para email el resultado real depende del
  constraint. Verificar antes de prometer "fusión por email" en iOS.

### 5.6 Ocultos, papelera y visibilidad

- Lista, búsqueda, chats y detalle excluyen `deleted_at IS NOT NULL` y filtros de ocultos
  (detalle → 404).
- La papelera solo se ve con `GET /trash` (UI: modal de escritorio en Contactos).

### 5.7 Custom fields — flujo de guardado de VALORES

`PUT /contacts/:id { customFields }`: el backend (a) descarta claves de sistema, (b) crea/reusa
definiciones para claves nuevas (`sourceType:'manual'`, `syncTarget:'local'`), (c) mergea con los
valores existentes por identidad, (d) sincroniza a HighLevel solo los campos cuyo `syncTarget`
no sea `local/internal/none/ristak` (payload `{id?, key?, field_value}`).

---

## 4. Inventario UX

### 4.1 `/movil` — pantalla "Info del contacto" (PhoneChat.tsx:16674-17077)

Acceso: desde la conversación (tap en el header del chat). Es una pantalla deslizante
(`contactInfoScreen`), no un modal. Estado: se cachea por día (`phone-chat/contact-info/<loc>/<id>`,
MOB-007) y se refresca con `GET /contacts/:id` (con `refreshExternalAppointments=false` para
pintar rápido; muestra pill "Actualizando datos" con spinner mientras carga; errores en texto rojo).

Estructura (top → bottom):

1. **Topbar**: chevron back "Volver al chat", título **"Info del contacto"**.
2. **Hero**: avatar grande (foto o inicial), nombre con botón lápiz →
   *edición inline* (TextInput autofocus; Enter/blur guardan, Escape cancela; spinner en el lápiz
   mientras guarda). Guardado: `PUT {full_name}`; toasts: éxito **"Nombre actualizado" / "El
   contacto ahora se llama X."**, error **"No se guardó el nombre"**. Debajo: línea de detalle
   (`phone || email || source`), badge de etapa (p.ej. "Cliente"), y pill **"Contactando desde"**
   (número de negocio: "Auto · +52…" o el fijado; tap → sheet de números; ver módulo chat).
3. Row **"Chat / Buscar en el chat"** ("Encuentra mensajes dentro de esta conversación") → abre
   búsqueda en conversación.
4. **Métricas** (2 cards con acción "Ver"): **Total** (`formatCurrency(ltv)`, "N pago(s)") → panel
   *Pagos totales*; **Citas** (total, "N activa(s)") → panel *Citas*.
5. **"Archivos del chat"** (resumen "3 fotos/videos · 2 documentos · 1 enlaces" o "Aún no hay
   archivos guardados", acción "Ver más") → panel *Archivos del chat* con tabs
   **Fotos y videos / Documentos / Enlaces** (grid de media o lista; vacíos:
   "Aún no hay fotos ni videos guardados en este chat." / "…documentos…" / "…enlaces…").
   Contenido derivado del journey (attachments/links), no de un endpoint propio.
6. **"Datos principales"**: fila **Número** *editable* (tap o lápiz → input `tel` con placeholder
   "+52...", botón check para guardar, X para cancelar). Al guardar: normaliza; si inválido toast
   warning **"Número incompleto" / "Revisa que el número tenga lada y entre 7 y 15 dígitos."**;
   si válido abre modal de confirmación **"Confirmar nuevo número"** ("Revisa que el número esté
   bien escrito antes de guardarlo:" + número nuevo + "Número actual: X"; botones **"Sí, cambiar
   número"** / "Cancelar"). Éxito → toast **"Número actualizado" / "Este chat ahora usa +52…"**.
   Filas read-only: **Correo**, **Contacto creado** (fecha), **Estado** (badge de etapa).
   ⚠️ /movil NO maneja el 409 `merge_confirmation_required` (mostraría el error crudo en toast).
7. **"Origen y conversión"**: filas Llegó desde / Primera visita / Página / Campaña / Conjunto /
   Anuncio / Dispositivo / Ubicación / Convirtió (primer pago o primera cita, o "Aún sin
   conversión registrada"). Botón **"Viaje de <cliente>"** ("N eventos · De más nuevo a más
   viejo" o "Aún sin actividad guardada") → panel *timeline* del journey (iconos por
   red/canal, título + descripción + fecha por evento; vacío: "Aún no hay actividad guardada para
   este contacto.").
8. **"Seguimiento"** (si hay datos): **Próxima cita** (fecha + título · estado) y hasta 3 pagos
   recientes.
9. **"Historial del agente"** (si hay): resumen de la última meta del agente IA → panel con cards
   (título, resumen de acción, fecha; vacío: "Aún no hay metas concretadas por el agente.").
10. **Campos personalizados** — `ContactCustomFieldsPanel` (surface `phone`, compacto, expandido,
    EDITABLE): lista todas las definiciones no-sistema del catálogo (`GET /contacts/custom-fields`)
    con el valor del contacto; editores por tipo (texto/número/moneda/fecha/radio/dropdown/
    checkboxes/checkbox/JSON/textarea; placeholder "Sin dato"; errores "Ese campo espera un numero
    valido." / "Ese campo espera JSON valido."). Guardar → `PUT {customFields:[...]}`; toasts
    **"Dato guardado" / "El campo personalizado quedó actualizado."**, error **"No se guardó el dato"**.
11. **"Integración"**: Canal (nombre legible del canal del último mensaje) y Origen.
12. **"Perfil social"** (si `GET /:id/linked-social` trae datos): filas por perfil
    ("Instagram · Mensajes directos", "Facebook · Comentarios"…, nombre y `@usuario`); bloque
    **"Mismo contacto en otro canal"** con botones para saltar al contacto vinculado.

Paneles secundarios (push dentro de la misma pantalla, back chevron): *Pagos totales* (fila
"Total pagado" + lista de pagos → *Detalle de pago*: Monto/Fecha/Estado/Concepto), *Citas*
(lista → *Detalle de cita*: Cita/Inicio/Fin/Estado/Notas), *Archivos del chat*, *Viaje*,
*Historial del agente*.

**Etiquetas en /movil**: NO viven en la ficha; se agregan desde el sheet "más" del chat
(`chatMore`) o el swipe del chat → sheet **"tag"**: buscador **"Buscar o crear etiqueta"**,
lista del catálogo (`GET /contact-tags` sin sistema; cache 1 día), opción activa marca
"Ya está agregada", opción **"Crear '<texto>' / Crear etiqueta y agregarla a este chat"**,
vacío "Sin etiquetas / Escribe un nombre para crear una etiqueta nueva.", loading "Cargando
etiquetas". Aplicar = `POST /contacts/bulk/tags` (add only). Toasts: **"Etiqueta agregada" /
"X quedó en <nombre>."**, info **"Etiqueta ya agregada"**, errores "No se agregó la etiqueta" /
"No se creó la etiqueta" / "No se cargaron las etiquetas". **No hay UI para QUITAR una etiqueta
de un contacto en /movil** (solo en escritorio).

**Sheet `chatMore`** (acciones del chat/contacto): "Agendar cita", "Registrar pagos",
"Agregar etiqueta", "Silenciar/Quitar silencio" + acciones de agente IA. *Silenciar* y
*archivar* son estado LOCAL del dispositivo (no hay endpoint).

**Sheet "Nuevo chat"** (`renderNewChatSheet`, `:17079-17113`): buscador
"Buscar por nombre, número o correo" (usa `GET /contacts/search`, mínimo 2 caracteres),
lista de resultados, vacío: "No hay contactos / Escribe al menos dos letras o revisa que el
contacto tenga teléfono.". **No permite crear contacto.** La creación en /movil-escritorio ocurre
dentro de formularios de pago/cita vía `ContactSearchInput` ("Buscar o agregar contacto...",
opción "Crear nuevo contacto: <texto>" → form Nombre* / Apellido / Correo electrónico / Teléfono;
validaciones: "El nombre es requerido", "Debes ingresar al menos un correo o teléfono",
"Correo inválido"; botón "Crear contacto"/"Creando...").

### 4.2 App React Native (Expo) — `NativeContactDetailScreen` (mobile/src/App.tsx:17796-18500)

Paridad casi 1:1 con /movil, con diferencias:

- Pantalla completa con header propio ("Info del contacto" + spinner de loading a la derecha).
- Nombre: edición inline (TextInput; submit/blur guardan). Teléfono: al guardar usa
  `Alert.alert('Actualizar teléfono', 'Cambiarás X por Y.', [Cancelar, Guardar])`; inválido →
  `Alert('Número incompleto', 'Escribe un teléfono válido (7 a 15 dígitos, opcionalmente con +).')`.
- `onSave(patch)` hace `PUT /contacts/:id` y parchea el modelo local (no re-decodifica la
  respuesta del PUT).
- Secciones en MAYÚSCULAS: DATOS PRINCIPALES, ORIGEN Y CONVERSIÓN (sin fila "Conjunto"),
  SEGUIMIENTO, HISTORIAL DEL AGENTE, **CAMPOS PERSONALIZADOS (solo lectura**, filas label/valor;
  vacío: "No hay campos personalizados guardados para este contacto."), INTEGRACIÓN.
  **No hay sección Perfil social ni contactos vinculados** en RN.
- Pill "CONTACTANDO DESDE" → `ContactInfoOurNumberSheet` (opción automática:
  "Usar el número por donde llegó la conversación: <núm>"); al elegir manda
  `preferredWhatsAppPhoneNumberId` + `routingSource:'manual'` + `routingReason` descriptivo.
- Paneles: Pagos totales, Citas, Archivos del chat (tabs "Fotos y vid... / Documentos / Enlaces"),
  Viaje de cliente (timeline con conectores; header "Recorrido del contacto", vacío
  "Sin actividad todavía / Aún no hay hitos guardados para este contacto."), Historial del agente.
- Etiquetas: sheet de tags (add-only, mismo copy) → `POST /contacts/bulk/tags` con un contactId;
  errores por `Alert('Etiqueta', …)`.
- "Nuevo chat" = `ContactPickerSheet` (título "Nuevo chat", buscador "Buscar contacto", vacío
  "No hay contactos para mostrar."). **Sin creación de contacto.** Crear contacto existe solo en
  el flujo de invitados de cita (`api.createContact`, source `mobile_native_appointment_guest`;
  errores: "Faltan datos / Escribe el nombre y el teléfono o correo del invitado.",
  "No se creó el contacto").
- Cliente API RN (`mobile/src/api.ts:344-458`): `getContact`, `updateContact` (mapea
  `name→full_name`), `createContact`, `searchContacts`, `getContactTags`, `createContactTag`,
  `addContactTag`, `getConversation/getContactJourney`, `markChatRead(s)`,
  `getPaymentLinkDeliveryOptions`, `getContactCustomFieldDefinitions` (`/contacts/custom-fields`).
- Modelo RN `ChatContact` (`mobile/src/types.ts:55-108`): tolera múltiples alias de nombre/foto;
  útil como referencia de qué campos consumen las vistas.

### 4.3 Haptics / gestos

- /movil: sin haptics específicos en la ficha; swipe del listado de chats abre acciones
  (etiqueta/archivar/más). RN: `Pressable` con estado pressed; swipe en filas de chat.
- Ambas apps cierran la ficha con back (gesto edge-swipe nativo en RN vía la animación de ruta).

---

## 5. Resumen de acciones de contacto disponibles (para paridad nativa)

| Acción | Endpoint | Superficie actual |
|---|---|---|
| Ver ficha completa | GET `/contacts/:id` | /movil + RN |
| Editar nombre | PUT `{full_name}` | /movil + RN (inline) |
| Editar teléfono (con confirmación) | PUT `{phone}` (+`confirmMerge`) | /movil + RN (sin manejo de 409) |
| Editar correo | PUT `{email}` | solo escritorio |
| Editar source / atribución manual | PUT `{source, attribution_ad_*}` | solo escritorio |
| Fijar número de WhatsApp saliente | PUT `{preferredWhatsAppPhoneNumberId, routingSource, routingReason}` | /movil + RN |
| Editar custom fields | PUT `{customFields}` | /movil (editable) / RN (solo lectura) |
| Agregar etiqueta | POST `/contacts/bulk/tags` | /movil + RN (add-only) |
| Quitar etiqueta | PUT `{tags}` o bulk `removeTagIds` | solo escritorio |
| Crear etiqueta | POST `/contact-tags` | /movil + RN |
| Crear contacto | POST `/contacts` | escritorio (ContactSearchInput) y RN (invitado de cita) |
| Eliminar / papelera / restaurar | DELETE `/contacts/:id`, `/trash`, `/restore`, `/permanent` | solo escritorio |
| Asignar responsable | GET/PUT `/contacts/:id/assignment` | solo DesktopChat |
| Ocultar contactos (filtros) | `/hidden-contacts` (admin) | solo Settings escritorio |
| Perfil social + salto a contacto vinculado | GET `/:id/linked-social` | /movil |
| Canales para link de pago | GET `/:id/payment-link-delivery-options` | flujos de pago |

---

## 6. Gaps / riesgos para iOS nativo

1. **Respuesta del PUT ≠ GET**: `PUT /contacts/:id` devuelve la fila cruda snake_case de la DB
   (con `deleted_at`, `ghl_contact_id`, etc.), no el contacto mapeado. Decodificar con un modelo
   tolerante o ignorar el body y re-fetch/parchear localmente (patrón de /movil y RN).
2. **Envelopes inconsistentes**: asignación usa `users`/`assignedUserId` sin `data`;
   linked-social usa `profiles`/`linked`; papelera usa `contacts`. El APIClient nativo no puede
   asumir siempre `{success, data}`.
3. **409 de fusión sin UI móvil**: ni /movil ni RN implementan el diálogo de
   `merge_confirmation_required`; solo el escritorio (Contacts.tsx:1377-1403). iOS debería
   implementarlo (mostrar contacto en conflicto + reintentar con `confirmMerge:true`).
   **OPEN QUESTION** (§5.5): semántica exacta de `confirmMerge` para conflictos de EMAIL
   (no hay merge real por email; puede acabar en 409 `duplicate_email`).
4. **No hay endpoint de notas** (`notes` siempre `''`).
5. **Quitar etiqueta**: no hay UI móvil; el backend lo soporta (PUT `tags` reemplaza el set o
   bulk `removeTagIds`). Decidir si iOS lo expone.
6. **Avatar de iniciales**: URL firmada solo utilizable desde payloads push; para UI, renderizar
   iniciales localmente (color estable por contacto si se quiere paridad con push: mismo algoritmo
   sha256 no replicable sin el secreto → usar hash propio).
7. **`assigned_user_id` no viene en GET /:id** — requiere llamada extra a `/assignment` si la
   ficha nativa quiere mostrar responsable.
8. **Silenciar/archivar chats** son estado local del dispositivo en ambas apps (sin backend);
   si iOS los implementa, no se sincronizan entre dispositivos.
9. **Custom fields en RN son read-only**; /movil sí edita. Para paridad "mejor cliente", iOS
   debería implementar el editor completo por tipo (§1.4, §4.1 punto 10) incluyendo dropdown/
   checkboxes con `options`.
10. **`GET /contacts/:id` puede ser lento** con `refreshExternalAppointments` on (llama a
    HighLevel). Usar `refreshExternalAppointments=false` + `warmProfilePictures=false` para
    primera pintura y refrescar después (patrón /movil).
11. **Los teléfonos adicionales (`phones[]`) no tienen CRUD propio** — solo se crean por fusión o
    al editar el principal. No prometer edición de múltiples teléfonos.
12. **dnd/dndSettings** solo se reenvían a HighLevel; no hay lectura local del estado DND.
    **OPEN QUESTION**: ¿exponerlo en iOS? No hay GET para saberlo.
13. **Filtros ocultos** afectan también al detalle (404): la navegación nativa debe tolerar 404
    en contactos que estaban en cache.
14. **`ContactCustomFieldDefinition.dataType` llega con valores ya normalizados**, pero valores
    viejos pueden traer tipos alias (`select`, `multiselect`); normalizar en cliente igual que
    `normalizeType` (§4.1 punto 10 / ContactCustomFieldsPanel.tsx:88-93).
15. **Creación de contacto desde "Nuevo chat"**: hoy NO existe en ninguna superficie móvil
    (solo búsqueda). Si iOS la agrega, usar POST `/contacts` con manejo de 409 de duplicados
    (mensajes del backend ya vienen en español listos para mostrar).

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **RESUELTO — OPEN QUESTION §5.5/§6.3 (`confirmMerge` con conflicto de EMAIL):**
   verificado en `backend/src/controllers/contactsController.js:4128-4180` y
   `contactIdentityService.js:496-521`:
   - **Teléfono** + `confirmMerge:true` ⇒ fusión real (`prepareContactPhoneUpsert` →
     `mergeContactIds`: absorbe al otro contacto y lo borra).
   - **Email** + `confirmMerge:true` ⇒ NO hay fusión: solo se salta el gate 409 y se
     intenta el `UPDATE email = ?` directo; el constraint UNIQUE dispara el catch de
     `contactsController.js:4409-4427` ⇒ **409 `duplicate_email`**
     ("El email ya pertenece a otro contacto. Usa uno distinto o confirma la fusión.").
   - **Regla para iOS:** el diálogo de fusión solo debe prometer fusión para conflictos
     de teléfono; para email, ofrecer "usar otro correo" (reintentar con `confirmMerge`
     terminará en `duplicate_email`). El copy del backend es engañoso ("...o confirma la
     fusión") — no existe fusión por email.
