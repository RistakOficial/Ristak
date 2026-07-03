# Servicio Backend De Calendarios Ristak / HighLevel Opcional

Documentación del módulo backend actual:

- `backend/src/services/highlevelCalendarService.js`
- `backend/src/controllers/calendarsController.js`
- `backend/src/routes/calendars.routes.js`

## API Externa De HighLevel

- Base URL: `https://services.leadconnectorhq.com`
- Header Version: `2021-04-15`
- Auth: `Authorization: Bearer <accessToken>`
- Timeout local por request: 15 segundos

## Rutas Backend

Montadas en `server.js` como:

```javascript
app.use('/api/calendars', calendarsRoutes)
```

| Método | Ruta | Controlador |
| --- | --- | --- |
| GET | `/api/calendars` | `getCalendars` |
| GET | `/api/calendars/events` | `getEvents` |
| GET | `/api/calendars/events/:eventId` | `getAppointment` |
| POST | `/api/calendars/appointments` | `createAppointment` |
| PUT | `/api/calendars/appointments/:id` | `updateAppointment` |
| DELETE | `/api/calendars/events/:id` | `deleteEvent` |
| GET | `/api/calendars/:id/free-slots` | `getFreeSlots` |
| GET | `/api/calendars/:calendarId/blocked-slots` | `getBlockedSlots` |
| POST | `/api/calendars/block-slots` | `createBlockedSlot` |
| PUT | `/api/calendars/block-slots/:id` | `updateBlockedSlot` |
| DELETE | `/api/calendars/block-slots/:id` | `deleteBlockedSlot` |
| GET | `/api/calendars/:id` | `getCalendar` |
| PUT | `/api/calendars/:id` | `updateCalendar` |

El orden importa: rutas específicas como `/events` y `/block-slots` van antes de `/:id`.

## Calendarios Publicos Y Contactos

El endpoint `POST /api/calendars/public/:slug/appointments` crea citas desde la
URL publica del calendario o desde un calendario embebido en Sites. Antes de
crear la cita, el backend resuelve el contacto local con esta prioridad:

1. Correo normalizado existente en `contacts`.
2. Telefono existente.
3. Contacto nuevo.

Si el correo ya existe y el telefono pertenece a otro contacto, el correo manda:
la cita se agenda sobre el contacto del correo y el helper de identidad resuelve
el telefono sin romper el indice unico `contacts.email`. No cambies esto a
"telefono primero"; en formularios publicos eso puede provocar
`contacts_email_key` cuando un cliente existente vuelve a agendar desde un sitio.

## Funciones Del Servicio

### `getCalendars(locationId, accessToken)`

Lista calendarios por location.

### `getCalendar(calendarId, accessToken)`

Obtiene detalle de un calendario.

### `getCalendarEvents(locationId, startTime, endTime, accessToken, calendarId = null)`

Lista eventos/citas por rango en timestamp ms. `calendarId` es opcional.

### `getAppointment(eventId, accessToken)`

Obtiene detalle de una cita remota de HighLevel. Para citas propias de Ristak, el controlador puede responder desde la base local.

### `getFreeSlots(calendarId, startDate, endDate, accessToken, timezone = 'America/Mexico_City')`

Obtiene slots disponibles.

### `getBlockedSlots(locationId, startTime, endTime, accessToken, calendarId = null, calendar = null)`

Obtiene horarios bloqueados. Si el controlador tiene `calendarId`, primero intenta cargar el calendario para pasar `teamMembers`.

### `createBlockedSlot(blockData, locationId, accessToken)`

Crea un bloque de calendario. La API de HighLevel usa una lógica exclusiva:

- `calendarId` sin `assignedUserId`: bloquea todo el calendario.
- `assignedUserId` sin `calendarId`: bloquea a un usuario.

### `updateBlockedSlot(eventId, updateData, accessToken)`

Actualiza un blocked slot.

### `deleteBlockedSlot(eventId, accessToken)`

Elimina un blocked slot.

### `createAppointment(appointmentData, locationId, accessToken)`

Crea una cita. El servicio mapea estados no soportados por HighLevel:

- `pending` -> `confirmed`
- `rescheduled` -> `confirmed`

### `updateAppointment(eventId, updateData, accessToken)`

Actualiza una cita. El servicio tambien normaliza `appointmentStatus` para que `pending` y `rescheduled` no se manden crudos a HighLevel.

### `deleteEvent(eventId, accessToken)`

Elimina una cita/evento.

### `updateCalendar(calendarId, updateData, accessToken)`

Actualiza configuración de calendario.

## Respuestas Del Controller

Los endpoints devuelven normalmente:

```json
{
  "success": true,
  "data": {}
}
```

`apiClient.ts` extrae automáticamente `data` cuando la respuesta incluye `{ success, data }`.

## Requisitos

Ristak puede operar calendarios, citas y bloqueos con datos locales aunque HighLevel no esté conectado. Si se quiere sincronizar con HighLevel, el frontend obtiene `locationId` y `accessToken` desde `AuthContext`, que a su vez consulta:

```http
GET /api/integrations/status
```

Para que la sincronización con HighLevel funcione:

- HighLevel debe estar configurado en Settings sólo para recursos remotos o sincronizados con esa integración.
- El token debe tener permisos para calendarios, eventos, usuarios y citas.
- Para productos/pagos relacionados, algunos flujos requieren scopes adicionales fuera de este módulo.

## Errores Comunes

- 400 desde controller: faltan `locationId`, `accessToken`, `startTime`, etc.
- 401/403 desde HighLevel: token inválido o scopes insuficientes.
- 404: calendario/evento inexistente.
- 429: rate limit de HighLevel.
- Timeout local: request excedió 15 segundos.

## Archivos Relacionados

Frontend:

- `frontend/src/pages/Appointments/Appointments.tsx`
- `frontend/src/services/calendarsService.ts`
- `frontend/src/components/common/AppointmentModal/AppointmentModal.tsx`
- `frontend/src/components/common/BlockedSlotModal/BlockedSlotModal.tsx`

Config:

- `frontend/src/pages/Settings/CalendarsConfiguration.tsx`
- `app_config.default_calendar_id`
- `app_config.attribution_calendar_ids`

## IA Agente

`backend/src/services/aiAgentService.js` expone la herramienta interna `manage_highlevel_appointment` para que el agente no tenga que improvisar REST directo.

Operaciones soportadas:

- `lookup_slots`: busca disponibilidad con `/calendars/:calendarId/free-slots`.
- `create`: agenda con `POST /calendars/events/appointments`.
- `reschedule`: mueve fecha/hora con `PUT /calendars/events/appointments/:eventId`.
- `cancel`: marca `appointmentStatus = cancelled`.
- `confirm`: marca `appointmentStatus = confirmed`.
- `showed`: marca `appointmentStatus = showed` y registra senal de asistencia local.
- `noshow`: marca `appointmentStatus = noshow`.
- `delete`: elimina el evento con `DELETE /calendars/events/:eventId`.

La herramienta resuelve contacto por DB/GHL, usa `default_calendar_id` cuando no se proporciona calendario, calcula `endTime` con la duracion del calendario si falta, guarda espejo local en `appointments` y dispara el evento WhatsApp de cita agendada al crear.

## Referencias

- [HighLevel Calendars](https://marketplace.gohighlevel.com/docs/ghl/calendars/calendars)
- [HighLevel Calendar Events](https://marketplace.gohighlevel.com/docs/ghl/calendars/calendar-events)
