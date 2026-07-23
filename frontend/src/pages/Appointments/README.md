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
- Carga únicamente previews acotados en mes y páginas keyset en semana/día.
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

Muestra días del mes actual, hasta tres citas por día en escritorio y dos en
teléfono, el total diario exacto y la señal de horarios bloqueados. `+N más`
abre el día, donde la colección completa se obtiene por páginas; el mes nunca
descarga todas las citas para poder pintar el grid.

### Semana

Muestra grilla horaria de 7 días con eventos posicionados por hora, total exacto
por día y bloques editables. La primera página trae 100 citas y **Cargar más
citas** avanza por cursor cuando el rango es más grande.

### Día

Muestra una columna horaria del día actual seleccionado con eventos, bloqueos y
total exacto. También usa páginas de 100 filas y carga incremental explícita.

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

`AppointmentModal` es el formulario canónico compartido por `/appointments` y
el agendado desde DesktopChat: Chat sólo le pasa el contacto y el calendario del
contexto, no mantiene otro modal paralelo. Maneja contacto, usuario asignado,
título, estado, fechas, ubicación, invitados y notas. En creación, Invitados
aparece dentro del flujo principal justo después de Ubicación y antes de Notas;
el panel derecho se reserva exclusivamente para asignar a la persona del equipo
cuando el calendario lo requiere. Los invitados se guardan en
`appointment_participants` con rol `guest`, no concatenados dentro del texto de
Notas. Al crear siempre incluye el `calendarId` seleccionado; el
backend rechaza una alta sin calendario antes de guardar una cita huérfana.
Al crear una cita, el modo `Por defecto` manda una validación estricta para que
la hora pertenezca al horario semanal y cumpla las reglas del calendario. El
switch `Permitir empalme de citas` del calendario decide si ese modo exige un
espacio libre o admite varias citas en la misma hora. El modo `Personalizado`
conserva el override explícito desde el primer intento, pero no atraviesa
ausencias ni horarios bloqueados. Editar una cita mantiene el contrato anterior
y no convierte silenciosamente una hora existente en una reserva nueva.

Después de crear o editar, la vista aplica únicamente la respuesta confirmada por
backend y ejecuta un refetch canónico para respetar normalización de fechas,
webhooks y sincronización externa. Después de eliminar, quita la fila confirmada
de eventos y próximas citas inmediatamente y revalida ambas colecciones. Ninguno
de estos flujos requiere recargar la página.

Cuando la respuesta trae `syncStatus=error`, la cita ya quedó guardada en Ristak,
pero HighLevel sigue pendiente. `/appointments`, DesktopChat, PhoneCalendar y
PhoneChat deben mostrar esa advertencia y cerrar el formulario sin invitar al
usuario a crear otra cita; el backend se encarga del reintento seguro.

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
- El momento manda sobre el modo de confirmación al elegir plantilla: todo aviso
  `after_booking` usa `cita_programada`; antes de la cita se usa
  `recordatorio_cita_un_dia_antes` o `confirmacion_cita_dia_anterior` según el
  switch. Backend vuelve a calcular esta selección y repara filas históricas que
  apunten a otra plantilla predeterminada, por lo que una confirmación inmediata
  nunca puede mandar el texto del día anterior.
- Los tres textos predeterminados incluyen la fecha y hora canónicas de la cita.
  No dependen de frases relativas como "mañana" o "dentro de 1 día", que pueden
  dejar de ser ciertas si cambia el horario inteligente o el momento configurado.
- WhatsApp usa el canal conectado sin un switch manual de respaldo: QR-only sale
  por QR, API-only sale por API y API+QR del mismo número intenta API primero y
  usa QR sólo si la API realmente pierde disponibilidad. Una plantilla sin
  aprobar o una ventana cerrada no cambian a QR.
- Una cuenta nueva recibe únicamente `Confirmación 1 día antes`, configurado
  como tipo Confirmación y con el mensaje automático pausado. Lleva una `system_key`
  única para que dos arranques simultáneos no lo dupliquen y nunca envía nada
  hasta que el usuario lo active.
- Si una cita se agenda después de la hora calculada para un recordatorio
  `before_appointment`, ese recordatorio se omite: no se aprovecha la tolerancia
  de reintento para mandarlo como si fuera la confirmación de la reserva. Un aviso
  inmediato configurado por el usuario usa `after_booking` y `cita_programada`,
  donde se muestran la fecha y hora reales de la cita.
- Un mensaje nuevo vive sólo como borrador local hasta que el usuario pulsa
  **Guardar**; abrir y cancelar el modal no crea una fila provisional de un día.
- Cada recordatorio o aviso guarda una `schedule_key` única construida con el
  ancla y la duración normalizada. Por eso `60 minutos antes` y `1 hora antes`
  ocupan el mismo momento aunque cambien canal, plantilla, texto o modo de
  confirmación. Crear o mover otro mensaje a ese momento devuelve
  `409 appointment_reminder_schedule_conflict`; la UI mantiene abierto el editor
  y muestra un `<Modal type="alert">` para que el usuario elija otro horario.
- El índice único cierra carreras entre pestañas o instancias. Si una instalación
  ya tenía duplicados históricos, no se borran silenciosamente: la fila canónica
  ocupa la llave y las demás deben corregirse antes de volver a guardarse.

## Servicio API Frontend

`frontend/src/services/calendarsService.ts` expone:

- `getCalendars`
- `getCalendar`
- `getEvents`
- `getMonthEventPreview`
- `getEventsPage`
- `getEventDayCounts`
- `getAppointmentStats`
- `getUpcomingAppointmentsPage`
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
| GET | `/api/calendars/events/month-preview` |
| GET | `/api/calendars/events/page` |
| GET | `/api/calendars/events/day-counts` |
| GET | `/api/calendars/events/overview` |
| GET | `/api/calendars/events/summary` |
| GET | `/api/calendars/upcoming` |
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
  Una lista vacía significa todos los calendarios y el switch de cada calendario
  debe mostrarse activo; una lista con IDs limita la inclusión a esa selección.
- `openHours`: horario semanal por calendario, con días activables y varios
  rangos por día. Un arreglo vacío configurado significa calendario cerrado.
- `allowOverlaps`: switch `Permitir empalme de citas` del paso
  `Disponibilidad`. Apagado bloquea una segunda cita en el mismo horario;
  encendido permite el empalme sin saltarse horario, bloqueos o máximo diario.

El wizard usa ocho pasos: `Detalles`, `Disponibilidad`, `URL y Datos`, `Cobro`,
`Mensajes automáticos`, `Avanzado`, `Eventos` y `Estilos y diseños`.
`Disponibilidad` reúne el horario semanal, duración, cadencia, reglas y buffers;
`URL y Datos` reúne enlace público, formulario y acción final.

En el editor semanal, cada control de hora abre columnas separadas para hora,
minuto y AM/PM. Mientras el menú está abierto, el campo y el resumen `Horario
seleccionado` muestran en vivo la combinación temporal. El valor se confirma con
`De acuerdo`; Escape o cerrar el menú descarta el cambio temporal y restaura la
última hora confirmada. Los CTA `De acuerdo` y `Aplicar` mantienen el color de
texto con contraste del botón primario en todas las familias y modos del tema.
`Copiar horarios` abre un menú de selección múltiple para elegir días destino y
`Aplicar` clona todos los rangos del día origen sin alterar los días no
seleccionados.

El guardado incorpora inmediatamente la respuesta canónica del PUT y luego
espera una recarga estricta del listado. Las recargas anteriores se ignoran y un
GET fallido conserva la última lista válida, por lo que cerrar y reabrir el modal
debe mostrar exactamente el horario persistido.

Si no hay calendarios de atribución configurados, backend usa todos como fallback.

## Notas Técnicas

- Las fechas para llamadas de eventos se envían como timestamps en milisegundos.
- Los timestamps delimitan días del negocio mediante
  `getBusinessDateRangeTimestamps`; el backend vuelve a dividirlos con
  `account_timezone` y conserva correctamente los cambios DST.
- `calendarsRequestRef`, `eventsRequestRef`, `upcomingEventsRequestRef` y
  `blockedSlotsRequestRef` impiden que una petición vieja vuelva a pintar datos.
- Las lecturas visibles llevan `AbortSignal`. Cambiar calendario, rango o vista
  cancela la consulta anterior; los cursores de día/semana no se reutilizan en
  otro alcance.
- `PhoneCalendar` conserva un snapshot diario acotado por calendario, vista y
  rango. El mes guarda sólo previews/conteos, la vista anual sólo conteos y la
  agenda del día seleccionado solicita sus propias páginas completas.
- El mini calendario para agendar desde `PhoneChat` comparte
  `getMonthEventPreview`: pinta hasta tres marcadores por día y muestra el total
  diario exacto sin descargar el mes completo.
- La sección Citas de `PhoneApp` consume `getEventsOverview`: recibe KPIs
  multi-calendario y sólo las próximas cinco filas, no todos los eventos del
  periodo.
- La grilla horaria calcula posiciones visuales por hora/minuto.
- Los modales usan portal con componentes comunes; no deben usar `alert`, `confirm` ni `prompt`.
- La página funciona con calendarios/citas de Ristak; HighLevel es una sincronización opcional y sólo debe mostrar estado pendiente cuando el usuario intenta operar recursos externos de esa integración.
