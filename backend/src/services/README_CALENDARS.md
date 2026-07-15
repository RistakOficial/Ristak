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
| GET | `/api/calendars/events/month-preview` | `getEventsMonthPreview` |
| GET | `/api/calendars/events/page` | `getEventsPage` |
| GET | `/api/calendars/events/day-counts` | `getEventDayCounts` |
| GET | `/api/calendars/events/overview` | `getEventsOverview` |
| GET | `/api/calendars/events/summary` | `getAppointmentStats` |
| GET | `/api/calendars/upcoming` | `getUpcomingAppointments` |
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
| DELETE | `/api/calendars/:id` | `deleteCalendar` |

El orden importa: rutas específicas como `/events` y `/block-slots` van antes de `/:id`.

## Lecturas Acotadas Para Navegación

Las vistas autenticadas de Calendario leen el espejo local y nunca sincronizan
Google o HighLevel dentro del GET. El contrato para volumen alto es:

- `events/month-preview` admite como máximo 45 días, devuelve conteos exactos
  por día del negocio y como máximo cinco previews por día. La UI usa tres en
  escritorio y dos en teléfono.
- `events/page` pagina día o semana por keyset ascendente `start_time + id`, con
  100 filas por default y 200 máximo. La primera página puede incluir el total y
  los conteos diarios; las siguientes usan `includeCounts=0` y no recalculan el
  agregado.
- `events/day-counts` devuelve únicamente conteos diarios. La vista anual del
  teléfono no descarga citas.
- `events/overview` devuelve los KPIs exactos de todos los calendarios y sólo
  las próximas cinco citas del rango (20 máximo). La portada móvil no descarga
  el histórico para calcular tres tarjetas y una lista corta.
- `events/summary` calcula los KPIs mensuales en SQL y se resuelve aparte del
  camino crítico que pinta la agenda.
- `upcoming` pagina próximas citas por el mismo orden estable, con límite 20 por
  default y 100 máximo.

Los cursores quedan ligados por hash al calendario, rango, zona del negocio y
orden. Reutilizarlos en otro alcance responde `400`; no reinicia silenciosamente.
Los límites UTC de cada día se construyen con Luxon y `account_timezone`, por lo
que días de 23 o 25 horas se cuentan correctamente. El índice parcial `095*`
coincide con filtro y orden en SQLite/PostgreSQL; Node nunca materializa el mes
completo aunque existan cientos de miles de citas. El índice `107*`
(`start_time + id`, sin `calendar_id` al frente) cubre el overview
multi-calendario y evita ordenar el histórico completo para hallar las próximas
cinco filas.

`GET /api/calendars` también es una lectura pura. El calendario semilla se crea
en `startRuntimeServices`, después de inicializar la clave maestra y antes de
habilitar tráfico. `ensureDefaultLocalCalendar` comparte una sola promesa por
proceso, usa `BEGIN IMMEDIATE` en SQLite y `pg_advisory_xact_lock` dentro de una
transacción PostgreSQL; el ID estable `rstk_cal_default` deja además la PK como
segunda defensa. Dos instancias o clientes simultáneos no pueden crear agendas
semilla duplicadas y abrir la pantalla nunca ejecuta un INSERT. Para decidir si
debe ocultar una semilla vacía, el GET consulta únicamente candidatos semilla
con `EXISTS` sobre el índice parcial; no ejecuta `COUNT(*)` sobre el histórico
ni revisa las citas de todos los calendarios.

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

El formulario publico predeterminado de calendario pregunta primero nombre,
despues correo y despues telefono. Todo campo de telefono de calendario debe
mostrar selector de pais/lada y guardar el valor normalizado con la lada elegida;
si el visitante no cambia la region, se usa la region detectada o la configurada
en la cuenta como respaldo. Al autopoblar desde un contacto o desde otro
formulario, la lada se separa en el selector y el input visible conserva solo el
numero nacional; no debe aparecer `+52`, `52`, `+1` ni otro prefijo dentro del
campo de numero. No vuelvas a renderizar telefono como un `type="tel"` simple
sin selector de pais.

## Disponibilidad Semanal

`calendars.open_hours` es la fuente de verdad del horario semanal. La API lo
expone como `openHours` en una forma canónica por día:

```json
[
  {
    "daysOfTheWeek": [1],
    "hours": [
      { "openHour": 9, "openMinute": 0, "closeHour": 12, "closeMinute": 0 },
      { "openHour": 13, "openMinute": 0, "closeHour": 17, "closeMinute": 0 }
    ]
  }
]
```

Reglas del contrato:

- Los días son `0..6`, donde `0=domingo`; `7` sólo se acepta como alias ISO de
  domingo al normalizar entradas históricas.
- Un día puede contener varios rangos, siempre dentro del mismo día, ordenados y
  sin solaparse. Las escrituras inválidas responden `400` con
  `invalid_calendar_open_hours`.
- Las escrituras nuevas usan horas `0..23`; el último cierre seleccionable es
  `23:59`. Esto mantiene el mismo contrato en Ristak y calendarios conectados.
- `availabilityScheduleConfigured=true` con `openHours: []` significa que el
  calendario está cerrado. Un horario explícito ilegible también falla cerrado.
- El fallback lunes a viernes 09:00–17:00 existe sólo para registros legacy sin
  la marca de configuración. La migración 049 materializa ese horario y los
  calendarios nuevos también lo guardan de forma explícita.
- Las horas se interpretan en `account_timezone`; el `timezone` del visitante
  sólo sirve para presentar los instantes ya calculados.
- URL pública, Sites, agente conversacional y creación admin/móvil en modo
  `Por defecto` consumen esta misma disponibilidad. El modo `Personalizado`
  conserva su override manual.
- La creación pública realiza la comprobación final dentro de la transacción y
  el candado del calendario. Además del horario aplica ventana de reserva,
  límites diarios/por espacio, buffers, bloqueos y citas existentes.

## Funciones Del Servicio

### `getCalendars(locationId, accessToken)`

Lista calendarios por location.

### `getCalendar(calendarId, accessToken)`

Obtiene detalle de un calendario.

### `getCalendarEvents(locationId, startTime, endTime, accessToken, calendarId = null)`

Lista eventos/citas por rango en timestamp ms. `calendarId` es opcional.

Las pantallas nuevas no deben usar esta lectura legacy para un mes completo.
Usan `listLocalAppointmentMonthPreview`, `listVisibleLocalAppointmentsPage` y
`getLocalAppointmentDayCounts` mediante los endpoints acotados anteriores.

### `getAppointment(eventId, accessToken)`

Obtiene detalle de una cita remota de HighLevel. Para citas propias de Ristak, el controlador puede responder desde la base local.

### `getFreeSlots(calendarId, startDate, endDate, accessToken, timezone)`

Obtiene slots disponibles. Para calendarios locales, las fechas se interpretan
con `account_timezone`; la zona pedida por una superficie pública sólo cambia la
representación de salida.

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

### `deleteCalendar(calendarId)`

Elimina calendarios locales de Ristak y sus citas asociadas. Si el calendario es
un espejo de HighLevel, solo se permite eliminarlo localmente cuando HighLevel ya
no esta configurado en `highlevel_config`; con HighLevel activo el controller
responde `409` para evitar que el origen remoto lo vuelva a sincronizar.

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

La herramienta resuelve contacto por DB/GHL, usa `default_calendar_id` cuando no se proporciona calendario, calcula `endTime` con la duracion del calendario si falta, consulta y vuelve a validar `openHours` y las reglas del calendario en la zona del negocio, guarda espejo local en `appointments`, dispara los eventos de Automatizaciones `appointment-booked` y `appointment-status` al crear, y conserva el evento WhatsApp de cita agendada.

## Referencias

- [HighLevel Calendars](https://marketplace.gohighlevel.com/docs/ghl/calendars/calendars)
- [HighLevel Calendar Events](https://marketplace.gohighlevel.com/docs/ghl/calendars/calendar-events)
