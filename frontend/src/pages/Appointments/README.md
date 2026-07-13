# Módulo Frontend De Citas

Documentación real de:

- `frontend/src/pages/Appointments/Appointments.tsx`
- `frontend/src/pages/Appointments/Appointments.module.css`
- `frontend/src/pages/Appointments/AppointmentReminderModal.tsx`
- `frontend/src/services/appointmentRemindersService.ts`
- `frontend/src/services/calendarsService.ts`
- `frontend/src/components/common/AppointmentModal/AppointmentModal.tsx`
- `frontend/src/components/common/BlockedSlotModal/BlockedSlotModal.tsx`

## Ruta

```txt
/appointments
```

Registrada en `frontend/src/App.tsx` dentro de `ProtectedRoute`.

El item de menú vive en `frontend/src/components/layout/Sidebar/Sidebar.tsx` como **Citas**.

## Qué Hace

- Lista calendarios activos de Ristak, Google y HighLevel opcional.
- Selecciona calendario por prioridad:
  1. último calendario usado en la sesión,
  2. `default_calendar_id` desde `useAppConfig`,
  3. primer calendario activo.
- Muestra vistas de mes, semana y día.
- Carga eventos por rango visible.
- Carga citas futuras para la lista lateral.
- Calcula KPIs mensuales.
- Permite crear, editar y eliminar citas.
- Permite crear, editar y eliminar horarios bloqueados.
- Permite configurar mensajes automáticos de cita: recordatorios antes de la cita
  y avisos después de agendar.
- Permite abrir configuración de calendarios desde el botón de Settings.
- Descarta respuestas de rangos/calendarios anteriores cuando una carga más nueva
  o una mutación ya cambió la vista.

## Estado Global Usado

- `AuthContext`: `locationId` y `accessToken`.
- `NotificationContext`: toasts y feedback.
- `useAppConfig`: `default_calendar_id`.
- `sessionStorage`: último calendario seleccionado.

## Vistas

### Mes

Muestra días del mes actual, eventos agrupados por fecha y señal de horarios bloqueados.

### Semana

Muestra grilla horaria de 7 días con eventos posicionados por hora y bloques editables.

### Día

Muestra una columna horaria del día actual seleccionado con eventos y bloqueos.

## Flujos De Citas

Crear cita:

```typescript
calendarsService.createAppointment(payload, accessToken)
```

Actualizar cita:

```typescript
calendarsService.updateAppointment(eventId, updates, accessToken)
```

Eliminar cita:

```typescript
calendarsService.deleteEvent(eventId, accessToken)
```

`AppointmentModal` maneja contacto, usuario asignado, título, estado, fechas, ubicación y notas.

Después de crear o editar, la vista aplica únicamente la respuesta confirmada por
backend y ejecuta un refetch canónico para respetar normalización de fechas,
webhooks y sincronización externa. Después de eliminar, quita la fila confirmada
de eventos y próximas citas inmediatamente y revalida ambas colecciones. Ninguno
de estos flujos requiere recargar la página.

## Flujos De Horarios Bloqueados

Crear:

```typescript
calendarsService.createBlockedSlot(payload, accessToken)
```

Actualizar:

```typescript
calendarsService.updateBlockedSlot(eventId, payload, accessToken)
```

Eliminar:

```typescript
calendarsService.deleteBlockedSlot(blockedSlotId, accessToken)
```

`BlockedSlotModal` soporta bloqueo de calendario completo o bloqueo por usuario, siguiendo la lógica XOR requerida por HighLevel.

## Mensajes Automáticos De Citas

`AppointmentReminderModal` edita filas de `appointment_reminders`.

- **Recordatorio de cita** usa `timingAnchor: 'before_appointment'` y se calcula
  hacia atrás desde la hora de la cita.
- **Aviso de cita** usa `timingAnchor: 'after_booking'` y se calcula desde
  `date_added`, sólo para citas agendadas localmente en Ristak.
- El switch **Usar como confirmación de cita** no cambia el ancla del envío.
  Sólo cambia `messageType` a `confirmation` para activar IA, acciones de
  confirmación y ventanas de seguimiento.
- Si el switch está apagado, el mensaje se guarda como `messageType: 'reminder'`
  aunque sea un aviso posterior al agendado.
- Las plantillas default son `recordatorio_cita_un_dia_antes` para recordatorios,
  `cita_programada` para avisos y `confirmacion_cita_dia_anterior` cuando el
  switch de confirmación está activo.

## Servicio API Frontend

`frontend/src/services/calendarsService.ts` expone:

- `getCalendars`
- `getCalendar`
- `getEvents`
- `getAppointment`
- `getFreeSlots`
- `getBlockedSlots`
- `createBlockedSlot`
- `updateBlockedSlot`
- `deleteBlockedSlot`
- `createAppointment`
- `updateAppointment`
- `deleteEvent`
- `updateCalendar`
- `calculateStats`
- `groupEventsByDate`
- `getUpcomingAppointments`
- `getTodayUpcomingAppointments`
- `getFutureAppointments`
- `parseOpenHours`

## Endpoints Backend Usados

| Método | Ruta |
| --- | --- |
| GET | `/api/calendars` |
| GET | `/api/calendars/:id` |
| PUT | `/api/calendars/:id` |
| GET | `/api/calendars/events` |
| GET | `/api/calendars/events/:eventId` |
| POST | `/api/calendars/appointments` |
| PUT | `/api/calendars/appointments/:id` |
| DELETE | `/api/calendars/events/:id` |
| GET | `/api/calendars/:id/free-slots` |
| GET | `/api/calendars/:calendarId/blocked-slots` |
| POST | `/api/calendars/block-slots` |
| PUT | `/api/calendars/block-slots/:id` |
| DELETE | `/api/calendars/block-slots/:id` |

También usa:

- `GET /api/highlevel/users`
- `POST /api/highlevel/users/by-ids`
- `POST /api/highlevel/contacts/search`

## Estados De Citas

Frontend:

- `confirmed`
- `pending`
- `cancelled`
- `showed`
- `noshow`
- `rescheduled`

El backend mapea `pending` y `rescheduled` a `confirmed` cuando HighLevel no acepta esos estados directamente.

## Configuración Relacionada

En `/settings/calendars`:

- `default_calendar_id`: calendario seleccionado por defecto en `/appointments`.
- `attribution_calendar_ids`: calendarios que cuentan para atribución/marketing.

Si no hay calendarios de atribución configurados, backend usa todos como fallback.

## Notas Técnicas

- Las fechas para llamadas de eventos se envían como timestamps en milisegundos.
- `calendarsRequestRef`, `eventsRequestRef`, `upcomingEventsRequestRef` y
  `blockedSlotsRequestRef` impiden que una petición vieja vuelva a pintar datos.
- La grilla horaria calcula posiciones visuales por hora/minuto.
- Los modales usan portal con componentes comunes; no deben usar `alert`, `confirm` ni `prompt`.
- La página funciona con calendarios/citas de Ristak; HighLevel es una sincronización opcional y sólo debe mostrar estado pendiente cuando el usuario intenta operar recursos externos de esa integración.
