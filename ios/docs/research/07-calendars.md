# 07 — Calendarios y Citas (módulo `appointments`)

> Spec de investigación para la app nativa SwiftUI (iOS 26). Fuentes: backend
> `backend/src/routes/calendars.routes.js`, `backend/src/controllers/calendarsController.js`,
> `backend/src/services/localCalendarService.js`, `backend/src/services/appointmentRemindersService.js`,
> `backend/src/services/appointmentReminderLogic.js`; frontend `frontend/src/services/calendarsService.ts`,
> `frontend/src/pages/PhoneCalendar/PhoneCalendar.tsx`, `frontend/src/components/common/AppointmentModal/AppointmentModal.tsx`,
> `frontend/src/pages/PhoneChat/PhoneChat.tsx`; RN `mobile/src/App.tsx`, `mobile/src/api.ts`, `mobile/src/types.ts`;
> docs `docs/MOBILE_APP.md` (§ "Agenda de citas desde el chat movil" y "Pagina de Citas nativa"),
> `docs/MOBILE_NATIVE_PARITY_CHECKLIST.md` ("Paridad completa de Citas").
> Nada de lo siguiente está inventado; lo ambiguo está marcado como **OPEN QUESTION**.

---

## 1. Arquitectura del módulo

- **Local-first**: la BD del backend (SQLite dev / Postgres prod) es la fuente de verdad.
  Los calendarios y citas pueden venir de 3 fuentes (`source`): `ristak` (nativo),
  `ghl` (espejo de HighLevel) y `google` (espejo de Google Calendar).
  `GET /api/calendars` y `GET /api/calendars/events` responden con lo local de inmediato y
  refrescan HighLevel/Google en segundo plano; solo esperan al remoto en la primera carga
  cuando la BD está vacía (`calendarsController.js:979-1026`, `1124-1226`).
- Crear/editar/borrar citas escribe local primero (`syncStatus: 'pending'`) y luego intenta
  propagar a HighLevel (si el calendario tiene `ghlCalendarId` y hay token guardado) y a
  Google (si el calendario está vinculado). Si el sync falla, la cita queda local con
  `syncStatus: 'pending'` / `'pending_delete'` y un cron la reintenta.
- Todos los instantes se guardan **normalizados a UTC ISO** usando la zona de la cuenta
  (`upsertLocalAppointment`, `localCalendarService.js:4086-4094`).
- La app nativa **no necesita** mandar `accessToken`/`locationId`: el backend los resuelve
  de `highlevel_config` guardado (`getHighLevelContext`, `calendarsController.js:127-133`).

### Zona horaria de la cuenta (`account_timezone`)

- Resolución en backend (`backend/src/utils/dateUtils.js:66+`): 1) `app_config.account_timezone`,
  2) timezone de HighLevel `location_data`, 3) default `America/Mexico_City`. Cache 5 min aprox.
- La app RN la obtiene con `GET /api/config?keys=account_timezone,default_calendar_id`
  (`mobile/src/App.tsx:7507`, `mobile/src/api.ts:1054-1060`; respuesta `{ config: {...} }` o mapa plano).
  Fallback RN: `America/Mexico_City` (`DEFAULT_BUSINESS_TIMEZONE`, `App.tsx:876`).
- **Regla dura**: TODA agrupación por día, grilla mensual, timeline y conversión del
  formulario usa `account_timezone`, nunca la zona del dispositivo (docs/MOBILE_APP.md:681-683, 697-699).

### Permisos

- Todas las rutas `/api/calendars/*` (menos las públicas `/api/calendars/public/:slug/*`) exigen
  `requireAuth` + `requireModuleAccess('appointments')` (`calendars.routes.js:19-20`).
- `/api/appointment-reminders` también exige `requireModuleAccess('appointments')`
  (`appointmentReminders.routes.js:13-16`).
- En cliente, la sección Citas se gatea con módulo `appointments` (licencia: feature `appointments`,
  legacy `google_calendar`) — ver `mobile/src/access.ts` (`PHONE_SECTION_MODULE.calendar = 'appointments'`).
  Niveles: `none | read | write`; admin siempre `write`.

---

## 2. Endpoints

Convención de respuesta: `{ "success": true, "data": ... }` en éxito;
`{ "success": false, "error": "mensaje" }` en error (mensajes en español). El cliente RN
desenvuelve `data` automáticamente cuando hay `success` y `data` (`api.ts:321-324`).

### 2.1 Calendarios

| Método | Path | Query/Body | Respuesta (`data`) |
|---|---|---|---|
| GET | `/api/calendars` | query opcional: `sourcePreference` = `combined`\|`ristak`\|`ghl` (`google`→`combined`); `locationId`, `accessToken` opcionales | `Calendar[]` (ver §3.1), ordenados por `is_active DESC, LOWER(name) ASC`, con campos de URL pública adjuntos |
| POST | `/api/calendars` | body: `Partial<Calendar>` (camelCase) | `Calendar` creado (201). Siempre `source:'ristak'` |
| GET | `/api/calendars/:id` | — | `Calendar` (busca por `id` o `ghl_calendar_id`); 404 `Calendario no encontrado` |
| PUT | `/api/calendars/:id` | body: `Partial<Calendar>` | `Calendar` actualizado. 404 si no existe. 400 si conflicto de cobro calendario+formulario |
| DELETE | `/api/calendars/:id` | — | `{ id, deleted: true }`. 404 si no existe; **409** si `source != 'ristak'` (`Los calendarios sincronizados se eliminan desde su origen`). Borra también sus citas |
| PUT | `/api/calendars/:id/google-sync` | body: `{ googleCalendarId: string }` (`""` desvincula) | `Calendar` + `initialGoogleSync` |

### 2.2 Citas (appointments/events)

| Método | Path | Query/Body | Respuesta (`data`) |
|---|---|---|---|
| GET | `/api/calendars/events` | query **requerido**: `startTime`, `endTime` en **epoch millis** (string numérica); opcional `calendarId`. Rango máx **370 días** | `Appointment[]` (§3.2). 400 si faltan/invalid: `Se requiere startTime y endTime`, `startTime inválido`, `endTime debe ser mayor o igual a startTime`, `El calendario permite rangos de hasta 370 días por solicitud` |
| GET | `/api/calendars/events/:eventId` | — | `Appointment` individual (incluye `contactId`, `assignedUserId`); busca local por `id`/`ghl_appointment_id`/`google_event_id`, con fallback a HighLevel |
| POST | `/api/calendars/appointments` | body §2.2.1 | `Appointment` creado (201). **409** `code:"slot_unavailable"` si el slot ya no tiene cupo (ver §5.1) |
| PUT | `/api/calendars/appointments/:id` | body §2.2.1 (parcial) | `Appointment` actualizado |
| DELETE | `/api/calendars/events/:id` | — | `{ success: true, message: 'Evento eliminado exitosamente' }` (sin `data`). Si está vinculado a GHL y el delete remoto falla, hace soft-delete local (`pending_delete` + status `cancelled`) |

#### 2.2.1 Body de crear/editar cita (nombres EXACTOS; el backend acepta camelCase y snake_case)

```jsonc
{
  "calendarId": "rstk_cal_xxx",        // requerido al crear
  "contactId": "cont_xxx",             // requerido al crear (regla de cliente)
  "title": "Cita con Juan",            // opcional; backend cae a eventTitle/name del calendario o "Cita"
  "appointmentStatus": "confirmed",    // ver enum §3.2; también acepta "status"
  "startTime": "2026-07-08T16:00:00.000Z",  // ISO UTC. Requerido
  "endTime": "2026-07-08T17:00:00.000Z",    // ISO UTC. Debe ser > startTime
  "timeZone": "America/Mexico_City",   // informativo; RN lo manda con account_timezone
  "notes": "texto...\n\nInvitados:\n- Ana: +52155...", // notas + bloque de invitados (§5.4)
  "address": "Av. X 123",              // opcional
  "assignedUserId": "ghl_user_id",     // opcional; requerido en cliente si round_robin (create)
  "ignoreAppointmentConflicts": true   // opcional (tb. "confirmDoubleBooking"): fuerza sobreagendar tras un 409
}
```

- Validaciones backend en `createLocalAppointment` (`localCalendarService.js:4177-4187`):
  `Fecha de inicio inválida` / `La fecha de fin debe ser posterior al inicio` (Error 500 — no envuelve status 400; el mensaje llega en `error`).
- Respuesta 409 de choque (`calendarsController.js:1970-1977`):

```json
{
  "success": false,
  "code": "slot_unavailable",
  "error": "Ese horario ya alcanzó el límite de citas. Elige otro horario o confirma el sobreagendamiento.",
  "data": { "limit": 1, "overlapping": 1 }
}
```

- En `PUT`, si el nuevo estado es `cancelled` el backend propaga la cancelación a HighLevel
  en el mismo PUT y usa el token guardado si no vino en el body (APT-006, `calendarsController.js:2099-2124`).
- Si cambia `startTime` (reprogramación): se limpian los envíos de recordatorios para que el
  cron los recalcule (APT-003) y se manda push `rescheduled`. Cancelación → push `cancelled`;
  cambio a `confirmed` → push de confirmación (`calendarsController.js:2149-2191`).

### 2.3 Disponibilidad y bloqueos

| Método | Path | Query/Body | Respuesta (`data`) |
|---|---|---|---|
| GET | `/api/calendars/:id/free-slots` | query **requerido**: `startDate`, `endDate` en `YYYY-MM-DD`; opcional `timezone` (IANA). Rango máx **45 días** | `[{ "date": "2026-07-08", "slots": ["2026-07-08T15:00:00.000Z", ...], "timezone": "America/Mexico_City" }]` — un objeto por día del rango, `slots` = inicios ISO UTC |
| GET | `/api/calendars/:calendarId/blocked-slots` | query **requerido**: `startTime`, `endTime` epoch millis. Rango máx **45 días** | Sin HighLevel (caso nativo): `[{ "id", "calendarId", "startTime", "endTime", "title" }]` (ISO UTC, `calendarId` null = bloqueo global). Con HighLevel: forma normalizada GHL `{ id?, date: "YYYY-MM-DD", startTime: "HH:mm", endTime: "HH:mm", reason?, blockedBy?, startIso?, endIso? }` (ver `RawBlockedSlot`/`BlockedSlot` en `calendarsService.ts:315-340`) |
| POST | `/api/calendars/block-slots` | body: `{ calendarId?, startTime, endTime, title? }` (acepta `reason`/`name` como título; ISO o epoch) | Bloqueo creado (201): `{ id: "rstk_block_...", calendarId, startTime, endTime, title }`. 400 `Se requiere startTime y endTime para el bloqueo` |
| PUT | `/api/calendars/block-slots/:id` | body: `{ startTime?, endTime?, title? }` | `{ id, startTime, endTime, title }`; 404 `Bloqueo no encontrado` |
| DELETE | `/api/calendars/block-slots/:id` | — | `{ success: true, message: 'Blocked slot eliminado exitosamente' }`; 404 `Bloqueo no encontrado` |

Notas:
- Sin `accessToken` en el request, todas las rutas de block-slots operan sobre bloqueos
  **nativos locales** (tabla `blocked_slots`, APT-004). Con `accessToken` (flujo GHL) delegan a HighLevel.
- Cálculo de slots libres (`getLocalFreeSlots`, `localCalendarService.js:4664-4750`):
  - Genera los instantes usando `openHours` en `account_timezone`; la zona pedida
    sólo cambia la fecha/hora con la que se agrupan y muestran al visitante.
  - `slotDuration` (default 60) = duración; `slotInterval` (default = duración) = paso.
  - Excluye: slots en el pasado (`slotStartMs >= now`), slots que chocan con citas existentes
    hasta el límite `appoinmentPerSlot` (sic, con typo, ver §3.1), y slots que tocan bloqueos nativos.
  - Un registro legacy sin `openHours` ni marca de configuración usa Lun–Vie
    9:00–17:00. `openHours: []` configurado significa cerrado y un horario
    explícito ilegible falla cerrado. Días aceptan formato
    `{ daysOfTheWeek:[1..5], hours:[{openHour,openMinute,closeHour,closeMinute}] }`, forma plana
    `{ day }`/`{ dayOfWeek }`, ISO 7→0 (0=domingo, como `Date.getDay()`).
  - Para calendarios GHL con `appoinmentPerSlot <= 1` el backend intenta primero los free-slots
    de HighLevel y cae a lo local si falla (`getFreeSlots`, `calendarsController.js:1681-1754`).

### 2.4 Usuarios para asignación / Round Robin

| Método | Path | Body | Respuesta |
|---|---|---|---|
| GET | `/api/highlevel/users` | — | `{ success: true, users: [...] }` — usuarios de la location GHL guardada. 400 si no hay config HighLevel (`No hay configuración de HighLevel activa`) |
| POST | `/api/highlevel/users/by-ids` | `{ "userIds": ["id1","id2"] }` | `{ success: true, users: [...] }` |

Modelo `CalendarUser` (RN `types.ts:784-792`): `{ id?, _id?, userId?, name?, firstName?, lastName?, email? }`.
El label del usuario = `name` → `firstName lastName` → `email` → id (`App.tsx:6703-6710`).

### 2.5 Recordatorios de citas (mensajes automáticos)

Base `/api/appointment-reminders` (auth + módulo appointments):

| Método | Path | Body | Respuesta (`data`) |
|---|---|---|---|
| GET | `/api/appointment-reminders` | — | `{ reminders: Reminder[], senders: Sender[], channels: [{ id:'whatsapp', label:'WhatsApp', connected: bool }] }` |
| POST | `/api/appointment-reminders` | Reminder parcial (§3.4) | `Reminder` creado (201) |
| PUT | `/api/appointment-reminders/:reminderId` | Reminder parcial | `Reminder`; 404 `Mensaje automático no encontrado.` |
| DELETE | `/api/appointment-reminders/:reminderId` | — | `{ id }`; 404 igual |

### 2.6 Calendario público (sin auth; para referencia — la app nativa NO lo usa)

- `GET /api/calendars/public/:slug/free-slots?startDate&endDate&timezone`
- `GET /api/calendars/public/:slug/contact-prefill?contactId|visitorId|sessionId`
- `POST /api/calendars/public/:slug/appointments` — body con `startTime` ISO, `timezone`,
  `name/phone/email/notes` o `responses{fieldId:value}` del formulario, `contactId`/`visitorId`/`sessionId`,
  `paymentPublicId`, `meta{...}`. Respuestas especiales: 409 `Ese horario ya no esta disponible`,
  400 `Ese horario ya paso`, 200 con `disqualified: true` (calificación) o `paymentRequired: true`
  (`status:'payment_pending'`, con `paymentUrl`, `publicPaymentId`, etc.). Requiere dominio público resuelto.
- Estado por `autoConfirm` del calendario: `confirmed` si `autoConfirm`, si no `pending`
  (`calendarsController.js:1466-1467`).

### 2.7 Integración Google Calendar (pantalla de Ajustes web; opcional en iOS)

`GET/DELETE /api/calendars/google-integration`, `POST .../connect-url`, `POST .../connect/claim`,
`GET .../calendars`, `POST .../test`, `POST .../sync`, `GET .../merge-preview`, `POST .../merge`
(`calendars.routes.js:29-37`). Tipos de respuesta en `calendarsService.ts:243-304`
(`GoogleCalendarIntegrationStatus`, `GoogleCalendarOption`, `GoogleCalendarMergePreview/Result`).

---

## 3. Modelos de datos

### 3.1 `Calendar` (respuesta de `/api/calendars`; `calendarRowToApi`, `localCalendarService.js:1152-1212`)

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | `rstk_cal_...` para nativos |
| `ghlCalendarId` | string \| null | |
| `googleCalendarId` | string | `''` si no vinculado |
| `googleAccessRole`, `googleCalendarSummary`, `googleCalendarTimeZone` | string | `''` default |
| `googleSyncEnabled` | boolean | derivado de `googleCalendarId` |
| `locationId` | string | `''` default |
| `groupId` | string \| undefined | |
| `name` | string | default `'Calendario'` |
| `description` | string | |
| `slug`, `widgetSlug` | string | |
| `calendarType` | string | default `'event'`; **`'round_robin'`** activa asignación obligatoria |
| `widgetType` | string | default `'classic'` |
| `eventTitle` | string | plantilla de título de cita (default = name) |
| `eventColor` | string | hex |
| `isActive` | boolean | |
| `teamMembers` | `[{ userId, priority, isPrimary, locationConfigurations? }]` | ids GHL |
| `locationConfigurations` | `[{ kind, location, meetingId? }]` | |
| `slotDuration` | number | default 60 |
| `slotDurationUnit` | string | `'mins'` (o `'hours'`) |
| `slotInterval` | number | default = slotDuration |
| `slotIntervalUnit` | string | `'mins'` |
| `slotBuffer`, `slotBufferUnit`, `preBuffer`, `preBufferUnit` | number/string | default 0/`'mins'`; solo se aplican en GHL |
| `appoinmentPerSlot` | number | **sic, typo intencional** (así viaja en JSON). Default 1. Límite de citas por slot; >1 solo cuenta en calendarios GHL |
| `appoinmentPerDay` | number | default 0 (sin límite). **No se valida en backend local** |
| `allowBookingAfter`, `allowBookingAfterUnit` | number/string | default 0/`'hours'`. **No aplicado en slots locales** |
| `allowBookingFor`, `allowBookingForUnit` | number/string | default 30/`'days'`. **No aplicado en slots locales** |
| `openHours` | `[{ daysOfTheWeek: number[], hours: [{openHour, openMinute, closeHour, closeMinute}] }]` | 0=domingo…6=sábado (acepta 7=domingo) |
| `autoConfirm` | boolean | default true — estado inicial de reservas públicas |
| `allowReschedule`, `allowCancellation` | boolean | default true |
| `notes` | string | plantilla de notas |
| `bookingForm` | objeto | `{ useCustomForm, customFormId, defaultFields: { name/phone/email/notes: { enabled, required } } }` |
| `bookingCompletion` | objeto | `{ action: 'message'\|'redirect', message, redirectUrl }` |
| `bookingPayment` | objeto | `{ enabled, gateway: 'stripe'\|'conekta'\|'mercadopago'\|'clip', amount, currency, productName, description, buttonText, pendingMessage, paidMessage }` |
| `bookingDisplay` | objeto | layout/tema/colores del widget público (ver `calendarsService.ts:106-139`) |
| `customEvents` | objeto | `{ enabled, channel: 'site'\|'whatsapp'\|'smart', eventName, parameters {...} }` (eventos Meta) |
| `availabilityType` | number | default 0 |
| `antiTrackingEnabled` | boolean | default true |
| `source` | `'ristak'` \| `'ghl'` \| `'google'` | |
| `syncStatus` | `'pending'` \| `'synced'` \| `'error'` | |
| `syncError` | string \| null | |
| `lastSyncedAt`, `createdAt`, `updatedAt` | string \| null | |
| `publicUrl`, `publicUrlEnabled`, `publicBookingPath`, `publicBaseDomain`, `publicUrlSource`, `publicUrlLockedToPublicCalendar`, `publicUrlUnavailableReason` | adjuntos por `attachPublicCalendarUrl(s)` | opcionales |

### 3.2 `Appointment` / evento (respuesta de events; `appointmentRowToApi`, `localCalendarService.js:4012-4041`)

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | `rstk_apt_...` para nativas |
| `ghlAppointmentId` | string \| null | |
| `googleEventId` | string \| null | |
| `calendarId` | string | `''` posible |
| `locationId` | string | |
| `contactId` | string \| undefined | |
| `title` | string | default `'(Sin título)'` |
| `status` | string | espejo de `appointmentStatus` |
| `appointmentStatus` | string | **enum**: `pending`, `confirmed`, `cancelled`, `showed`, `noshow`, `rescheduled`. El backend además tolera `canceled`, `no_show`, `invalid` en filtros (ver §5.1). Default `confirmed` |
| `assignedUserId` | string \| undefined | |
| `notes` | string | puede contener bloque `Invitados:` (§5.4) |
| `address` | string | |
| `startTime` | string ISO UTC | |
| `endTime` | string ISO UTC | = startTime si faltaba |
| `dateAdded` | string | |
| `dateUpdated` | string \| undefined | |
| `source` | `'ristak'`\|`'ghl'`\|`'google'` | |
| `syncStatus` | `'pending'`\|`'synced'`\|`'error'`\|`'pending_delete'` | |
| `syncError`, `syncedAt` | string \| null | |
| `googleSyncStatus`, `googleSyncError`, `googleSyncedAt` | string \| null | |
| `contactName`, `contactEmail`, `contactPhone` | string | JOIN con contacts, `''` default |

Etiquetas de estado en español (RN `App.tsx:6770-6793`; mismos colores del modal web
`AppointmentModal.tsx:92-99`):

| value | label | color web |
|---|---|---|
| `pending` | Pendiente | `#f97316` |
| `confirmed` | Confirmada | `#22c55e` |
| `cancelled` | Cancelada | `#ef4444` |
| `showed` | Asistió | `#2563eb` |
| `noshow` | No asistió | `#6b7280` |
| `rescheduled` | Reprogramada | `#8b5cf6` |

Normalización cliente: `canceled`→`cancelled`, `no_show`/`no-show`→`noshow` (`App.tsx:6795-6800`).

### 3.3 `FreeSlot` y `BlockedSlot`

```ts
// GET /:id/free-slots
type FreeSlotDay = { date: string /*YYYY-MM-DD*/, slots: string[] /*ISO UTC*/, timezone: string }

// GET /:calendarId/blocked-slots — forma NATIVA (sin HighLevel)
type NativeBlockedSlot = { id: string, calendarId: string | null, startTime: string /*ISO UTC*/, endTime: string, title: string | null }

// forma GHL normalizada (con HighLevel) — la que consume el AppointmentModal web
type GhlBlockedSlot = { id?: string, date: string, startTime: 'HH:mm', endTime: 'HH:mm', reason?: string, blockedBy?: string, startIso?: string, endIso?: string }
```

El RN tolera ambas formas al detectar choques (`getDraftBlockedConflict`, `App.tsx:7913-7947`:
lee `slot.date` o deriva el día de `slot.startTime`, y `reason || title` para el mensaje).

### 3.4 `Reminder` (mensaje automático; `normalizeReminderRow`, `appointmentRemindersService.js:138-175`)

| Campo | Tipo | Enum/notas |
|---|---|---|
| `id` | string | `apt_reminder_...` |
| `name` | string | autogenerado tipo "1 día antes" si vacío |
| `enabled` | boolean | |
| `messageType` | `'reminder'` \| `'confirmation'` | |
| `aiEnabled` | boolean | |
| `channel` | `'whatsapp'` | único canal |
| `senderMode` | `'contact'` \| `'default'` \| `'specific'` | |
| `senderPhoneNumberId` | string \| null | |
| `templateId`, `templateName` | string \| null | plantilla WhatsApp |
| `templateLanguage` | string | default `'es_MX'` |
| `timingAnchor` | `'before_appointment'` \| `'after_booking'` | |
| `offsetValue` | number | before: 1..60; after: >=0, tope 24 h |
| `offsetUnit` | before: `'minutes'\|'hours'\|'days'`; after: `'seconds'\|'minutes'\|'hours'` | |
| `messageText` | string | default `DEFAULT_REMINDER_TEXT` / `DEFAULT_CONFIRMATION_TEXT` (con variables `{{contact.first_name}}`, `{{cita.fecha}}`, `{{cita.hora}}`) |
| `smartEnabled` | boolean | ventana horaria inteligente |
| `smartStart`, `smartEnd` | `'HH:mm'` | defaults `09:00` / `21:00` |
| `smartOverflow` | `'before'` \| `'next_day'` | |
| `noConfirmAction` | `'no_action'` \| `'cancel_appointment'` \| `'notify_push'` | |
| `confirmationSuccessAction` | `'mark_confirmed'` \| `'chat_card'` \| `'notify_push'` \| `'chat_badge'` | |
| `bypassAutomations`, `qrFallbackEnabled` | boolean | |
| `position` | number | orden |
| `createdAt`, `updatedAt` | string | |
| `deliveryHealth` | `{ status: 'paused'\|'error'\|'warning'\|'ready', message, details[] }` | solo en overview |
| `failures` | `{ errorCount, lastErrorAt, lastErrorMessage }` | solo en overview |

`senders`: `[{ id, phone, name, isDefault, apiEnabled, qrConnected }]`.
Semilla automática: recordatorio "1 día antes" con smart activado (`ensureDefaultAppointmentReminder`).
Cálculo del envío en `computeReminderSendAt` (`appointmentReminderLogic.js:103+`): resta el offset
al `startTime` y, con smart, encaja en la ventana `smartStart–smartEnd` de la zona de la cuenta.

---

## 4. Manejo de fechas del cliente (contrato del RN a replicar)

- `GET /events`: el cliente calcula el rango visible en `account_timezone`
  (`getBusinessRangeTimestamps`, `App.tsx:6848-6854`): `00:00` del primer día → `00:00` exclusivo
  del día siguiente al último, convertidos a epoch ms UTC.
- El backend filtra **por hora de inicio solamente** (`a.start_time >= ? AND a.start_time <= ?`,
  `localCalendarService.js:4227-4235`): eventos que empiezan antes del rango pero terminan dentro no aparecen.
- Crear/editar: el formulario captura `dateOnly (YYYY-MM-DD)` + `startTime (HH:mm)` +
  `durationMinutes`, y los convierte con `localBusinessDateTimeToUTCISOString(dateOnly, time, accountTz)`
  a ISO UTC antes de mandar (`App.tsx:7966-7972`).
- Free-slots: `startDate = hoy(accountTz)`, `endDate = hoy + 30 días`, `timezone = accountTz`
  (`App.tsx:9210-9212`). Recordar límite backend de 45 días.

---

## 5. Reglas de negocio y validaciones

### 5.1 Choques de horario (doble reserva)

- Backend en `POST /appointments` (APT-001): antes de crear ejecuta `checkSlotAvailability`
  (`localCalendarService.js:4548-4583`), que:
  - Límite = `appoinmentPerSlot` **solo para calendarios GHL**; para nativos/google el límite es 1.
  - Cuenta citas del calendario que se solapan (`startA < endB && endA > startB`), excluyendo
    estados `cancelled/canceled/noshow/invalid` y, opcionalmente, `excludeAppointmentId`.
  - Si el slot toca un **bloqueo nativo** (tabla `blocked_slots`, del calendario o global
    `calendar_id IS NULL`) → no disponible (`blocked: true`).
  - La verificación normal de choques conserva compatibilidad fail-open ante un
    error interno; la validación estricta de reglas solicitada por los flujos
    `Por defecto`, público e IA no inventa disponibilidad.
  - Si no disponible → **409 `slot_unavailable`** salvo `ignoreAppointmentConflicts: true`
    o `confirmDoubleBooking: true`.
  - **El PUT de edición NO ejecuta este chequeo** (solo el POST).
- Cliente RN además pre-valida bloqueos para calendarios NO-GHL llamando
  `GET /:calendarId/blocked-slots` del día y comparando minutos en zona de negocio
  (`getDraftBlockedConflict`); si choca muestra alert "Horario bloqueado" con
  `reason || title || 'Este horario no está disponible. Selecciona otro horario.'` y no llama al POST.
- El modal web hace lo equivalente (`checkIfTimeIsBlocked`, `AppointmentModal.tsx:945-990`) y
  es **silencioso** si el fetch de bloqueos falla (permite crear).

### 5.2 Horas permitidas

- `openHours` del calendario define los slots ofertados en `free-slots`. Un arreglo
  vacío configurado significa cerrado; sólo registros legacy sin configurar usan
  Lun–Vie 9–17. Un formato explícito ilegible falla cerrado.
- Al crear, web, RN e iOS solicitan validación estricta en modo `Por defecto`; URL
  pública y agente también la aplican. El modo `Personalizado` permite cualquier
  hora como override intencional. La edición conserva el contrato legacy del PUT.

### 5.3 Round Robin

- `calendar.calendarType === 'round_robin'` → al **crear**, el cliente exige `assignedUserId`
  (RN: alert `Persona del equipo requerida` / `Selecciona quién atenderá esta cita.`, `App.tsx:7961-7963`;
  web igual en `AppointmentModal.tsx:1011-1023`). El backend NO lo valida.
- Los candidatos = `calendar.teamMembers[].userId` resueltos vía `POST /api/highlevel/users/by-ids`;
  para calendarios no-RR o al mostrar el asignado se usa `GET /api/highlevel/users`.
  Fallback RN si falla: chips `Usuario {id8}...`.

### 5.4 Invitados (guests) — convención en `notes`

No hay campo estructurado de asistentes. Los invitados se serializan dentro de `notes`
(`App.tsx:7000-7047`, mismo formato del modal web):

```
<notas del usuario>

Invitados:
- Nombre Uno: +5215512345678
- Nombre Dos: correo@dominio.com
```

- Header exacto: `Invitados:` (constante `APPOINTMENT_GUESTS_NOTE_HEADER`).
- Cada línea: `- {name}: {contact}` (contact = teléfono o email).
- Al editar, el cliente separa notas/invitados buscando el último `\n\nInvitados:\n`
  (o el string empezando con `Invitados:\n`) y parsea con regex `^-\s*(.+?):\s*(.+)$`.
- Duplicados por `contact` (case-insensitive) se ignoran. Validación de alta manual:
  `Invitado incompleto` / `Agrega nombre y teléfono o correo para poder invitarlo.`
- El RN permite crear un contacto nuevo desde el buscador de invitados (usa el endpoint de
  creación de contactos del módulo Contactos) — misma pieza que el modal web.

### 5.5 Efectos colaterales de citas (backend)

- Tras crear/actualizar/borrar: recalcula `contacts.appointment_date` = mínima cita futura no
  cancelada/noshow/invalid del contacto (`updateContactAppointmentDate`).
- Push notifications a los dueños de la cuenta (servicio `pushNotificationsService`):
  creación (`sendCalendarAppointmentNotification` con `source: 'admin_calendar'` o `'public_calendar'`),
  cancelación / reprogramación / confirmación (`sendAppointmentStatusNotification` /
  `sendAppointmentConfirmationNotification`). Preferencias por usuario:
  `user_config` keys `calendar_push_notifications_enabled`,
  `appointment_confirmation_push_notifications_enabled`, `calendar_push_notification_calendar_ids`.
- Eventos Meta (CAPI): al crear cita con contacto dispara evento por canal configurado
  (`customEvents.channel`: `site`/`whatsapp`/`smart`) — transparente para el cliente iOS.
- Deep link: la push de cita abre la app con URL que contiene el appointmentId; el RN lo maneja
  con `Linking` + `extractAppointmentIdFromUrl` y abre el sheet de detalles (`App.tsx:7625-7657`).

### 5.6 Errores y semántica de status HTTP

- 400: rangos inválidos/exceso de días, faltan parámetros. 404: calendario/cita/bloqueo no existe.
- 409: `slot_unavailable` (crear cita), borrar calendario sincronizado, slot público tomado.
- 500 con `{ success:false, error }` para errores generales (incluye mensajes de validación de
  `createLocalAppointment`). El cliente debe mostrar `error` textual.

---

## 6. Inventario UX

### 6.1 Página Citas nativa (RN `mobile/src/App.tsx`, réplica de `/movil` `PhoneCalendar.tsx`) — referencia principal para iOS

**Header** (siempre visible):
- Pastilla de período con chevron izquierdo: en vista mes muestra el **año** (tap = subir a vista año);
  en año muestra `Años`; en años muestra `Año`; en día/semana muestra el mes. (`App.tsx:8073-8080`)
- Cápsula de acciones a la derecha: botón `Hoy` (label cambia a `Mes`/`Año` según vista =
  quick return), icono de **calendario** (abre sheet selector de calendarios) y **`+`**
  (abre flujo Nueva cita → contact picker).
- Título grande del mes (p.ej. "julio"), en semana `d MMM - d MMM` + subtítulo mes/año.

**Vistas** (`CALENDAR_VIEW_OPTIONS`, `App.tsx:825-830`): `Día`, `Semana`, `Mes`, `Año` (+ grid de años).
- **Mes**: grilla mensual con pager de 3 páginas y swipe horizontal; fila `D L M M J V S` libre
  sobre la grilla; alto según semanas reales del mes; bolita de selección; puntos de eventos.
  Tap en día = seleccionar; **doble-tap (≤320 ms)** = abrir Nueva cita en ese día (`handleDayPress`).
  Debajo: agenda del día seleccionado (cards). Vacío: icono calendario + **"No hay citas este día"**.
- **Año**: grid de 12 meses; lista inferior "próximas citas" (vacío: **"No hay citas próximas"**).
- **Día/Semana (timeline)**: rejilla de 24 h (54 px/h), etiquetas `12 a.m. … 11 p.m.`.
  - Tap en un hueco → Nueva cita con inicio en ese minuto snapeado (`slotInterval` del calendario,
    5–60 min) y duración = `slotDuration` (15–1440).
  - **Long-press (380 ms)** → haptic (`Haptics.selectionAsync`, fallback `Vibration.vibrate(12)`),
    bloquea el scroll y permite estirar el rango vertical arrastrando; al soltar abre Nueva cita
    con ese rango (+15 min de gracia). Tolerancias: cancela con movimiento horizontal >12 px o
    vertical >30 px antes del long-press; tap = ≤10 px. Swipe horizontal cambia de día/semana (≥56 px).
  - Tarjetas de cita: campo suave con borde tenue, un solo color; muestran hora y título.
- **Pull-to-refresh** en todas las listas (recarga calendarios + eventos).

**Estados**:
- Carga inicial con cache: persiste en AsyncStorage el calendario seleccionado
  (`ristak.native.calendar.selectedCalendarId.v1`), bootstrap (`...bootstrapCache.v1` con calendars +
  timezone) y eventos por rango (`...eventsCache.v1`), pintando cache al instante y refrescando por red.
- Timeout de red de calendario: 8 s → error "La respuesta del calendario tardó demasiado."
- Errores: banner/text con mensaje (`No se pudieron cargar las citas.` / `No se pudieron cargar los calendarios.` /
  `No se pudo actualizar el calendario.`).

**Sheet selector de calendarios** (título `Calendarios`): lista con color del calendario, nombre,
check en el activo; vacío: `No hay calendarios conectados.` Cambiarlo recarga eventos y persiste la selección.

**Flujo Nueva cita**:
1. `+` (o tap/long-press en timeline, o doble-tap en día) → **sheet contact picker**: título
   `Nueva cita`, subtítulo = fecha seleccionada formateada; buscador `Buscar contacto`
   (≥2 chars = `searchContacts`, si no lista de chats recientes); filas de contacto **sin icono
   de enviar mensaje**; loading `Buscando contactos...`; vacío `Busca un contacto para agendar.`
   Si no hay calendario activo: alert `Selecciona calendario` / `Elige un calendario activo antes de agendar.`
2. Elegir contacto → **sheet formulario** (título `Agendar una cita`, subtítulo = nombre del
   contacto o nombre del calendario; en edición `Editar cita`). Secciones en orden
   (`App.tsx:9936-10200`):
   - **Calendario**: campo select que abre subvista `Calendarios` dentro del mismo sheet (no un
     segundo modal). Cambiarlo resetea slot elegido.
   - **Estado**: chips con las 6 opciones (§3.2). Default `confirmed` al crear.
   - **Persona asignada / Elegir miembro del equipo**: solo visible si round-robin (requerido al
     crear) o si la cita ya tiene `assignedUserId`. Chips por usuario (label + email); opción
     `Sin asignar` cuando no es requerido. Loading `Cargando equipo...`; error
     `No pudimos cargar el equipo. Reintenta antes de guardar.` / `No hay equipo para asignar.`
   - **Fecha y hora** (label con asterisco requerido): segmented `Por defecto` / `Personalizado`.
     - `Por defecto` (default al crear; al editar abre en `Personalizado`): carga
       `GET /:id/free-slots` (hoy → +30 días, zona de la cuenta), filtra días con slots;
       hint `Elige una fecha disponible` + chips horizontales de fecha (con contador
       `N horario(s)`); hint `Horario` + grid de chips de hora (máx 18 por día, muestra inicio
       y hora fin calculada con `slotDuration`). Elegir slot fija `dateOnly/startTime/durationMinutes`.
       Loading `Buscando horarios...`; error con botón `Reintentar`; vacío
       `No hay horarios disponibles en los próximos 30 días.`
       En este modo NO se muestran fecha/hora/duración/zona/dirección manuales.
     - `Personalizado`: campos `Fecha` (subvista `Elige la fecha` con wheels día/mes/año),
       `Hora` (subvista `Elige la hora` con wheels hora 1-12/minutos step 5/AM-PM) y
       `Duración` (subvista `Duración` con wheels horas 0-12 + minutos 0-59).
   - **Invitados** (antes de Notas): toggle/sección con buscador de contactos existentes
     (resultados sin icono de chat, máx 6), alta manual con `nombre` + `teléfono o correo`,
     creación de contacto nuevo inline, lista de invitados agregados con avatar y botón X.
     Se serializa en `notes` (§5.4).
   - **Notas**: multilinea, placeholder `Añade instrucciones, acuerdos o detalles importantes...`
   - CTA primario: **`Crear cita`** / **`Guardar cambios`** (spinner cuando `busy`).
3. Guardado (§5.1): valida contacto (`Contacto requerido` / `Selecciona un contacto para crear la cita.`),
   round-robin, horario (`Horario inválido` / `Usa fecha YYYY-MM-DD y hora HH:mm.`), bloqueos.
   Error genérico: alert `No se pudo guardar` + mensaje del backend. Al éxito: cierra sheet y
   recarga eventos **sin toast de éxito** (regla de docs/MOBILE_NATIVE_PARITY_CHECKLIST.md:63).

**Sheet detalles de cita** (tap en una card/evento; título = título de la cita, subtítulo = estado):
- Hero con acento del color del calendario, fecha (`formatBusinessDayHeader`) y rango horario
  (o `Sin hora`).
- Fila `Estado` (icono reloj) y fila `Detalle` (dirección/notas si existen).
- Sección `Acciones`: `Editar cita` ("Cambiar título, estado, horario, dirección o notas.") y
  `Eliminar cita` ("Borra esta cita del calendario.", destructiva).
- Eliminar → Alert de confirmación `Eliminar cita` / `Esta acción borra la cita del calendario.`
  botones `Cancelar` / `Eliminar` (destructivo) → `DELETE /events/:id` → recarga.
  Error: `No se pudo eliminar` / `Intenta otra vez.`
- Edición sin ID válido: alert `No se puede editar` / `Esta cita no tiene un ID válido del backend.`

**Deep link/push**: abrir cita por URL → selecciona fecha/mes/calendario y abre el sheet de
detalles; si falla: alert `No se abrió la cita` / `El calendario abrió, pero los detalles no cargaron.`

### 6.2 `/movil` original (`frontend/src/pages/PhoneCalendar/PhoneCalendar.tsx`)

- Misma estructura: vistas `Día/Semana/Mes/Año`, sheets `calendar` (título `Calendarios`) y
  `contactPicker` (título **`Agendar con`**), timeline con long-press + selección arrastrable,
  swipe de mes, quick-return `Hoy`/`Mes`/`Año actual`.
- Para crear/editar usa el **`AppointmentModal`** compartido (`frontend/src/components/common/AppointmentModal/`),
  que además del flujo RN tiene: selector de **zona horaria** (lista `Intl.supportedValuesOf('timeZone')`),
  free-slots del modal, `getAppointment(eventId)` para hidratar `contactId`/`assignedUserId`
  al editar, y estado inicial según `autoConfirm` del calendario (APT-008: `confirmed` si
  autoConfirm, si no `pending`; el RN usa `confirmed` fijo — ver Gaps).
- La página de escritorio `frontend/src/pages/Appointments/Appointments.tsx` agrega lo que
  `/movil` no tiene: KPIs por estado (`calculateStats` — ojo: "pending" ahí cuenta confirmadas
  futuras), gestión de **bloqueos de horario** con `BlockedSlotModal`
  (`frontend/src/components/common/BlockedSlotModal/`), y el modal de **Mensajes automáticos**
  (`AppointmentReminderModal.tsx`) sobre `/api/appointment-reminders`.

### 6.3 Agendar cita desde el chat (PhoneChat / conversación)

- Sheet `+` de la conversación incluye acción **`Agendar cita`** (`PhoneChat.tsx:18277, 18878`).
- El sheet `Agendar una cita` tiene **dos modos** intercambiables con el botón de calendario del
  encabezado; la preferencia se guarda por usuario en
  `user_config.mobile_chat_appointment_entry_mode` = `'form'` | `'calendar'`
  (docs/MOBILE_APP.md:651-671, `PhoneChat.tsx:222, 5133, 6091`).
  - **Modo formulario**: `AppointmentModal` con el contacto activo bloqueado; el selector de
    calendario abre subvista del mismo bottom sheet (no modal apilado).
  - **Modo calendario**: solo con contacto activo; selector de calendario arriba, vista mensual
    única (flechas o swipe para cambiar mes), luego pide hora, duración, ubicación e invitados;
    convierte a UTC con la zona de la cuenta; guarda por el MISMO `POST /api/calendars/appointments`
    y respeta bloqueos nativos antes de crear. Errores: `Abre un contacto antes de agendar.`,
    `No se pudo agendar. Intenta otra vez.`
- El acceso rápido de calendario del **header** del chat redirige a la página de Agenda nativa
  y abre el formulario de Nueva cita con el contacto de esa conversación precargado y bloqueado
  (RN: prop `initialContact` del screen de Citas, `App.tsx:7861-7875`).
- El info del contacto muestra bloque `Citas` (título/estado/fecha) que abre página nativa propia.

---

## 7. Gaps / riesgos para iOS nativo

1. **Invitados sin campo estructurado**: viajan embebidos en `notes` con el bloque `Invitados:`.
   Cualquier edición externa (GHL/Google) puede corromper el parseo. iOS debe replicar el
   formato byte a byte (§5.4) para interoperar con web/RN.
2. **`appoinmentPerSlot` (typo)**: el JSON usa el nombre mal escrito. Codificar el CodingKey
   exacto. `appointmentPerSlot` solo se acepta como entrada alternativa.
3. **El PUT de cita no valida choques**: solo el POST devuelve 409 `slot_unavailable`. Si iOS
   quiere paridad estricta con RN basta el pre-chequeo de bloqueos del cliente; si quiere
   protección real al reprogramar tendría que llamar `free-slots`/`blocked-slots` manualmente.
4. **Modo personalizado es un override real**: `openHours`, ventana de reserva,
   límite diario y buffers se aplican al listar y al crear en modo `Por defecto`,
   pero el modo `Personalizado` permite una hora manual. iOS debe mandar
   `strictAvailabilityCheck` sólo al crear en modo `Por defecto` y no al editar.
5. **Filtro de eventos por hora de inicio**: citas que cruzan medianoche pueden no aparecer en el
   día que terminan; la grilla debe agrupar por `startTime` como hace RN.
6. **`GET /events` refresca remotos en segundo plano**: la primera respuesta puede no traer
   cambios remotos recientes; conviene un pull-to-refresh que repita la llamada (patrón RN).
7. **Estados 500 con mensajes de validación**: `Fecha de inicio inválida` etc. llegan como 500,
   no 400. Manejar el `error` textual en cualquier status.
8. **Diferencia RN vs web en estado inicial**: el modal web usa `autoConfirm` del calendario para
   decidir `confirmed|pending` (APT-008); el RN fija `confirmed`. **OPEN QUESTION**: cuál adoptar
   en iOS (sugerido: paridad con el modal web).
9. **Round Robin depende de HighLevel**: `/api/highlevel/users*` devuelve 400 sin HighLevel
   conectado. En cuentas 100 % nativas no hay endpoint de "usuarios del equipo" para asignar.
   **OPEN QUESTION**: fuente de usuarios asignables sin GHL.
10. **Blocked slots con dos formas de respuesta** (nativa ISO vs GHL date/HH:mm). El decoder iOS
    debe tolerar ambas (usar la lógica de `getDraftBlockedConflict`).
11. **No hay paginación** en `/events` ni `free-slots`: solo límites de rango (370/45/45 días).
    Rango mayor = 400.
12. **`timeZone` de la cita**: se acepta en el body pero **no se persiste** como campo propio del
    appointment (no existe en `appointmentRowToApi`). No confiar en leerlo de vuelta.
13. **Sin websocket/eventos realtime de citas**: el RN usa cache + refresh manual/deep-link;
    las push (`calendar_push_notifications_enabled`) son la única señal en vivo.
14. **Brecha declarada en RN** (docs/MOBILE_APP.md:717-718): falta replicar la validación
    avanzada de slots/bloqueos y usuarios Round Robin del modal web original — misma brecha
    aplicará a iOS si solo se copia el RN.
15. **Recordatorios**: la UI de gestión vive solo en escritorio (AppointmentReminderModal).
    **OPEN QUESTION**: si iOS debe exponer CRUD de `/api/appointment-reminders` o solo lectura.

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **CORRECCIÓN — §1 (cache de timezone):** `backend/src/utils/dateUtils.js:9-11` define
   `CACHE_TTL_MS = 60 * 60 * 1000` (**1 hora**, no "5 min aprox"). Coincide con docs 01 §9
   y 09 §9.14. Tras cambiar `account_timezone` el backend puede tardar hasta 1 h en
   reflejarlo en procesos que no invalidan el cache.
2. **HECHOS VERIFICADOS — OPEN QUESTION §7.8 (estado inicial de cita, APT-008):**
   - Modal web: `AppointmentModal.tsx:897-905` → `initialStatus =
     effectiveCalendar?.autoConfirm === false ? 'pending' : 'confirmed'`.
   - RN: `mobile/src/App.tsx:7871` fija `appointmentStatus: 'confirmed'` siempre.
   La discrepancia es real y sigue siendo decisión de producto; la recomendación del doc
   (seguir el modal web / autoConfirm) queda en pie.
