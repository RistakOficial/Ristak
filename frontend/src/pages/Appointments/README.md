# Módulo Frontend De Citas

Documentación real de:

- `frontend/src/pages/Appointments/Appointments.tsx`
- `frontend/src/pages/Appointments/Appointments.module.css`
- `frontend/src/pages/Appointments/AppointmentReminderModal.tsx`
- `frontend/src/services/appointmentRemindersService.ts`
- `frontend/src/services/calendarsService.ts`
- `frontend/src/services/calendarOfflineStore.ts`
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
- Permite definir calendarios presenciales o en línea y guardar el enlace de la
  videollamada sin exponer el destino directo al contacto.
- Permite abrir configuración de calendarios desde el botón de Settings.
- Descarta respuestas de rangos/calendarios anteriores cuando una carga más nueva
  o una mutación ya cambió la vista.
- Conserva calendarios, rangos y altas pendientes por cuenta para seguir
  consultando y creando citas sin internet.

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

## Trabajo Sin Conexión

`calendarOfflineStore.ts` guarda en `localStorage` namespaceado por cuenta una
lista acotada de calendarios, snapshots de rangos/próximas citas/estadísticas y
una cola de creación. Antes de persistir un borrador elimina `accessToken` y
`access_token`.

Una falla de red, timeout, `408`, `425`, `429` o `5xx` cierra el formulario,
muestra una cita sintética `offline-appointment:<clientRequestId>` y conserva el
POST. Al evento `online`, al volver visible la app y cada 30 segundos mientras
está visible, la cola reintenta con el mismo `clientRequestId`. Un rechazo
definitivo queda como `local_failed` y requiere reintento manual; no entra en un
bucle automático. La respuesta canónica reemplaza la fila local y revalida el
rango. Este contrato aplica a `/appointments`, `PhoneCalendar` y la creación
desde `PhoneChat`; editar y eliminar citas canónicas todavía requieren red.

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

`AppointmentReminderModal` edita filas de `appointment_reminders`. Cada fila
lleva `calendar_id`: el selector activo de `/appointments` y el calendario
abierto en Configuración son la fuente de verdad para listar, crear, editar y
eliminar mensajes. `GET /api/appointment-reminders` exige `calendarId`; al
cambiar de calendario la UI vacía la lista anterior y descarta respuestas
asíncronas que pertenezcan a la selección previa.

Cuando un calendario es `online`, Ristak agrega una regla administrada diez
minutos antes con la plantilla `acceso_videollamada_10_minutos_v2`. La
plantilla es la preferida para calendarios en línea nuevos, usa solamente el
enlace seguro como variable y conserva después el texto fijo de preparación
previa a la llamada para que Meta pueda aceptarla. El nombre versionado evita
chocar con una identidad anterior que el proveedor todavía conserve. La
variable **Enlace de ingreso a la cita** (`{{cita.enlace_ingreso}}`) aparece en
el grupo Citas del catálogo compartido del CRM: plantillas de WhatsApp, correos,
mensajes y demás campos con variables de Automatizaciones. Se materializa como
URL opaca individual únicamente cuando la ejecución trae la cita, el calendario
y el contacto exactos; fuera de ese contexto queda vacía para no enviar el
enlace de otra reserva. La URL de Zoom/Meet no aparece en el catálogo de enlaces
de disparo.

No importa si el usuario conecta WhatsApp antes o después de crear el calendario
en línea: el alta del calendario o la reparación posterior de la conexión envía
esta plantilla a revisión en la cuenta de WhatsApp del negocio. Cada negocio
conserva su propia aprobación del proveedor.

Si la plantilla oficial todavía está en revisión, el panel de salud conserva el
motivo y el cron reintenta después de que el proveedor la apruebe; WhatsApp QR
puede usar el texto renderizado bajo sus reglas existentes.

- El cron sólo combina una regla con citas cuyo `appointments.calendar_id`
  coincide. Un mensaje de un calendario nunca se muestra ni se envía en otro.
- Un ultimátum de confirmación heredado tampoco puede cancelar una cita ajena:
  la migración y el procesador lo marcan `disabled` si los calendarios difieren.
- La migración de filas globales anteriores las asigna al calendario
  predeterminado válido de la cuenta; si falta, usa el primer calendario activo.
  Así se conserva la configuración existente sin mantener el alcance global.

- **Recordatorio de cita** usa `timingAnchor: 'before_appointment'` y se calcula
  hacia atrás desde la hora de la cita.
- **Aviso de cita** usa `timingAnchor: 'after_booking'` y se calcula desde
  `date_added`, sólo para citas agendadas localmente en Ristak.
- El switch **Usar como confirmación de cita** no cambia el ancla del envío.
- En cada intento nuevo de crear un mensaje, la primera activación de
  **Usar como confirmación de cita** escribe de verdad
  `¡Perfecto! Te esperamos en tu cita. Nos vemos pronto.` dentro del campo de
  respuesta; no es un placeholder. El usuario puede modificarlo o borrarlo.
  Después de esa primera activación el borrador conserva exactamente su decisión,
  incluso si apaga y vuelve a encender el switch. Cancelar y abrir un intento
  nuevo reinicia la precarga. Las reglas existentes nunca se rellenan.
  Sólo cambia `messageType` a `confirmation` para activar IA, acciones de
  confirmación y ventanas de seguimiento.
- `appointmentStatus: 'confirmed'` no omite este mensaje ni bloquea su respuesta:
  el calendario puede usar ese estado para aceptar automáticamente la reserva,
  mientras la reconfirmación de asistencia se procesa de forma independiente.
  Sólo se excluyen citas cerradas, eliminadas o que ya comenzaron.
- Con IA activa, cada respuesta reinicia una espera de dos minutos. Los mensajes
  se acumulan de forma atómica, se ordenan por el instante del proveedor y se
  clasifican juntos; si entra otro mientras el modelo está clasificando, la
  acción se difiere y se vuelve a evaluar el lote completo después de otros dos
  minutos de silencio.
- **Al vencer el plazo sin confirmación** sólo decide el efecto sobre la cita:
  conservarla o cancelarla. El push ya no es una acción de este dropdown.
- Toda confirmación con IA configura su ventana de espera, sin importar cuál de
  esas dos acciones se elija. Una confirmación nueva parte de un plazo seguro
  calculado según su anticipación —normalmente 6 horas disponibles— y del horario
  de respuesta `09:00–21:00`.
- **Cómo contar este plazo** permite usar tiempo corrido o contar sólo minutos y
  horas dentro de un horario diario de respuesta independiente del horario de
  envío. El segundo modo pausa el contador fuera de la ventana, usa la zona del
  negocio, funciona todos los días y admite rangos que cruzan medianoche. Una
  respuesta recibida fuera de ese horario sigue siendo válida; la ventana sólo
  controla cuándo avanza el ultimátum.
- El plazo empieza cuando el transporte acepta el envío y cada mensaje congela
  su propio deadline UTC. El modo corrido de `before_appointment` debe terminar
  antes del inicio; en el horario de respuesta y en `after_booking`, si no cabe
  todo el plazo antes de la cita, no se ejecuta la acción por timeout. Si vence
  sin respuesta explícita, se conserva o cancela según el dropdown incluso si
  el calendario ya la hubiera marcado `confirmed`.
- Las reglas históricas permanecen en tiempo corrido. Cambiar después la zona
  horaria, la ventana o el recordatorio no mueve deadlines que ya fueron
  congelados. Una regla histórica de cancelación sin plazo sigue sin adquirir
  una cancelación destructiva por sorpresa; al abrirla, el editor propone el
  default y sólo se activa al guardarla.
- Una respuesta recibida antes del límite difiere el timeout hasta terminar de
  clasificarla. Una respuesta ambigua, `human_needed`, una ventana en error o
  una falla técnica conservan la cita, dejan el envío en `review_required` al
  vencer y avisan para revisión humana.
- Eliminar el mensaje automático desactiva sus ultimátums pendientes. El envío
  permanece como auditoría, pero ya no puede cancelar una cita.
- **Reservar estas respuestas para la confirmación** impide que esos mensajes
  lleguen al agente conversacional o a automatizaciones. No se reproducen al
  terminar; si el negocio necesita contestar preguntas logísticas debe dejarlo
  apagado.
- Cuando la IA confirma, deja el estado real de la cita en `confirmed` y resuelve
  explícitamente el envío, incluso si el calendario ya tenía ese estado. El
  editor usa `CheckboxMultiSelect` sólo para combinar tarjeta en el chat y
  etiqueta temporal `Asistirá a cita`; **Marcar la cita como confirmada**
  permanece seleccionado porque es el resultado obligatorio de este modo.
- **Mensaje de respuesta al confirmar** permite guardar un texto opcional de
  hasta 4096 caracteres. Después de que la IA clasifica `confirmed`, Ristak lo
  renderiza con las variables del contacto y de esa cita y lo manda como texto
  libre por el mismo canal que recibió el último mensaje: WhatsApp API/QR,
  correo, Instagram DM o Messenger. No usa plantilla: la respuesta entrante ya
  abrió la conversación correspondiente. La ventana sólo consume respuestas
  del canal configurado; un DM o correo ajeno no confirma por accidente una
  solicitud enviada por otro canal. Cada envío de confirmación manda la cortesía
  como máximo una vez; un fallo del proveedor se registra pero no revierte la
  cita ni deja la ventana de IA atorada.
- El push de confirmaciones se procesa por defecto al confirmar, detectar una
  respuesta no afirmativa, vencer el plazo o requerir revisión. Su única
  compuerta de producto está en **Configuración → Notificaciones →
  Confirmaciones de cita**, incluida la selección de destinatarios. Apagarlo
  allí evita la entrega; quitar una acción visual de un recordatorio no lo hace.
- Las filas históricas pueden conservar `notify_push` dentro del JSON legado,
  pero ese valor ya no gobierna la entrega ni aparece en el editor. En
  `no_confirm_action`, el valor legado `notify_push` equivale a conservar la
  cita.
- `confirmation_success_action` conserva su nombre histórico, pero las
  configuraciones nuevas guardan un arreglo JSON ordenado. El backend sigue
  aceptando valores escalares anteriores y la consulta del journey reconoce
  ambos formatos.
- Con IA apagada, una respuesta afirmativa simple resuelve la confirmación, deja
  la cita en `confirmed` y procesa el mismo push global sin abrir una ventana,
  aunque el calendario ya la mostrara confirmada; las acciones para interpretar
  negativas quedan ocultas.
- Si el switch está apagado, el mensaje se guarda como `messageType: 'reminder'`
  aunque sea un aviso posterior al agendado.
- El momento manda sobre el modo de confirmación al elegir plantilla: todo aviso
  `after_booking` usa `cita_programada`; antes de la cita se usa
  `confirmacion_cita_dia_anterior` para confirmaciones,
  `recordatorio_cita_una_hora_simple` para recordatorios configurados exactamente
  una hora antes y `recordatorio_cita_un_dia_antes` para los demás recordatorios.
  Backend vuelve a calcular esta selección y repara filas históricas que
  apunten a otra plantilla predeterminada, por lo que una confirmación inmediata
  nunca puede mandar el texto del día anterior.
- El copy relativo "dentro de una hora" sólo pertenece a
  `recordatorio_cita_una_hora_simple`: el editor cambia de plantilla si el offset
  deja de equivaler a una hora y el mensaje inicial tiene horario inteligente
  apagado. Las demás plantillas siguen usando datos canónicos de la cita.
- WhatsApp usa el canal conectado sin un switch manual de respaldo: QR-only sale
  por QR, API-only sale por API y API+QR del mismo número intenta API primero y
  usa QR sólo si la API realmente pierde disponibilidad. Una plantilla sin
  aprobar o una ventana cerrada no cambian a QR.
- Una cuenta nueva recibe únicamente tres mensajes automáticos en su calendario
  predeterminado, todos pausados:
  `Aviso al agendar`, exactamente al crear la cita, sin horario inteligente y
  con la plantilla `cita_programada`; `Recordatorio 1 hora antes`, sin IA ni
  horario inteligente y con `recordatorio_cita_una_hora_simple`; y
  `Confirmación 1 día antes`, con IA
  apagada y la plantilla `confirmacion_cita_dia_anterior`. Cada fila lleva una
  `system_key` única para que dos arranques simultáneos no la dupliquen. Las
  cuentas existentes no reciben este paquete y nada se envía hasta que el
  usuario active cada mensaje.
- `cita_programada` usa el encabezado "🗓️ Cita programada para el {{1}}", el
  aviso `🔔 *Importante:*` con `*NO*` y `*respondas*` resaltados,
  y `Este es un mensaje AUTOMÁTICO` como `FOOTER` real de WhatsApp. Una regla que
  selecciona otra plantilla o tiene texto directo personalizado conserva ese
  contenido. Ristak registra por proveedor la revisión ya enviada para actualizar
  instalaciones existentes una sola vez, sin repetir la solicitud en cada arranque.
- Si una cita se agenda después de la hora calculada para un recordatorio
  `before_appointment`, ese recordatorio se omite: no se aprovecha la tolerancia
  de reintento para mandarlo como si fuera la confirmación de la reserva. Un aviso
  inmediato configurado por el usuario usa `after_booking` y `cita_programada`,
  donde se muestran la fecha y hora reales de la cita.
- Un mensaje nuevo vive sólo como borrador local hasta que el usuario pulsa
  **Guardar**; abrir y cancelar el modal no crea una fila provisional de un día.
- El editor principal no se cierra al tocar el fondo ni al pulsar Escape. Sólo
  las acciones explícitas **Cancelar**, **Guardar** y la **X** lo cierran, para
  evitar perder por accidente una configuración todavía no guardada.
- Cada recordatorio o aviso guarda una `schedule_key` única dentro de su
  calendario, construida con el
  ancla y la duración normalizada. Por eso `60 minutos antes` y `1 hora antes`
  ocupan el mismo momento aunque cambien canal, plantilla, texto o modo de
  confirmación. Crear o mover otro mensaje a ese momento devuelve
  `409 appointment_reminder_schedule_conflict`; la UI mantiene abierto el editor
  y muestra un `<Modal type="alert">` para que el usuario elija otro horario.
- El índice compuesto `(calendar_id, schedule_key)` cierra carreras entre
  pestañas o instancias y permite usar el mismo momento en calendarios distintos.
  Si una instalación
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
- `meetingMode`: `in_person` o `online`. Se elige al crear el calendario y al
  editar el paso `Detalles`, antes de **Lo básico**.
- `meetingUrl`: sólo aparece y se exige en modo `online`; acepta la URL de Zoom,
  Google Meet u otra plataforma HTTP/HTTPS. El backend la reemplaza al enviar
  por un enlace seguro ligado a la cita.
- `description`: se edita en `Detalles > Lo básico` y alimenta el texto de la
  URL pública aunque el calendario haya sido importado desde HighLevel.
- `calendarCoverImage`: se edita en `Estilos y diseños` con
  `ImageUploadField`. Admite JPG, PNG, WebP o AVIF de hasta 2 MB, URL pública y
  eliminación. Un archivo nuevo se conserva como borrador local y sólo se sube
  a Media (`module=appointments`) al guardar; cancelar no crea un asset huérfano.
  El preview y el widget público regresan a la inicial del calendario si la URL
  está vacía o la imagen ya no carga.

El wizard usa ocho pasos: `Detalles`, `Disponibilidad`, `URL y Datos`, `Cobro`,
`Mensajes automáticos`, `Avanzado`, `Eventos` y `Estilos y diseños`.
`Disponibilidad` reúne el horario semanal, duración, cadencia, reglas y buffers;
`URL y Datos` reúne enlace público, formulario y acción final.

En **Configuración → Notificaciones**, el evento **Ingreso a videollamada**
permite elegir por destinatario `Apagado`, `Campanita`, `Push celular` o
`Campanita + push`. El primer clic válido marca la asistencia y genera el aviso;
los clics posteriores no lo duplican.

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
