# Date and Time Guidelines

Estas reglas son obligatorias para cualquier cambio que toque fechas, horas,
rangos, crones, pagos, citas, contactos, anuncios, sitios, formularios,
mensajes, reportes o integraciones.

## Principio

La zona horaria del negocio es la fuente de verdad.

- La base de datos guarda instantes reales en UTC.
- Una fecha de calendario (`YYYY-MM-DD`) significa ese día en la zona horaria del
  negocio, no en UTC y no en la computadora del usuario.
- El frontend muestra y captura fechas usando la zona del negocio, salvo una
  experiencia explícitamente marcada como "zona del visitante".
- Las integraciones externas reciben UTC, timestamps o `timezone` según el
  contrato de cada API, siempre derivado de la zona del negocio.

## Fuente de Verdad

Backend:

- Usa `getAccountTimezone()`, `resolveTimezone()` y `DEFAULT_TIMEZONE` desde
  `backend/src/utils/dateUtils.js`.
- No hardcodees `America/Mexico_City` fuera de defaults centralizados, listas de
  opciones, ejemplos o tests.
- Si un valor no trae zona horaria explícita, interprétalo con la zona del
  negocio antes de convertirlo a UTC.
- Los rangos semanales de calendario (`openHours`) son horas de pared en la zona
  del negocio. Calcula primero ahí el día y el rango válido y después conviértelo
  a un instante UTC. Una zona del visitante puede reformatear ese instante, pero
  nunca mover ni redefinir la disponibilidad del negocio. Al consultar por fecha
  del visitante cubre hasta dos días de borde: UTC-12 y UTC+14 pueden separar el
  mismo instante por dos fechas de calendario.

Frontend:

- Usa `useTimezone()` para leer la zona activa.
- Usa utilidades de `frontend/src/utils/timezone.ts`:
  - `getStoredBusinessTimezone()`
  - `todayDateOnlyInTimezone(timezone)`
  - `localDateTimeInputToUTCISOString(value, timezone)`
  - `toDateTimeLocalInputValue(utcDate, timezone)`
  - `formatInTimezone(utcDate, timezone)`
- Para texto visible reutiliza `frontend/src/utils/format.ts`:
  - `formatDate(value, { timezone })`
  - `formatDateTime(value, { timezone })`
  - `formatDateToISO(value, { timezone })`
  - `formatEndDateToISO(value, { timezone })`
  - `normalizeDateInputToLocalDate(value, { timezone })`
  - `getBusinessDateRangeTimestamps(start, end, timezone)`
- Para pagos usa `frontend/src/utils/paymentDate.ts` y pásale la zona de la
  cuenta cuando armes timestamps.

## Formatos Permitidos

Usa estos formatos de forma intencional:

- Instante real: ISO UTC con `Z`, por ejemplo `2026-06-29T21:00:00.000Z`.
- Fecha de calendario del negocio: `YYYY-MM-DD`, por ejemplo `2026-06-29`.
- Input `datetime-local`: `YYYY-MM-DDTHH:mm`; debe convertirse a UTC con la zona
  del negocio antes de enviarse al backend.
- Rangos de reportes: manda fecha inicial/final como fechas de negocio y deja
  que backend resuelva `startOfDay/endOfDay` con la zona del negocio.

## Reglas de Almacenamiento

- Guarda eventos con hora como UTC: citas, bloqueos, mensajes programados,
  acciones masivas, automatizaciones, pagos ejecutados, links enviados,
  webhooks, media y eventos de tracking.
- Guarda fecha pura (`YYYY-MM-DD`) sólo cuando el concepto sea realmente de
  calendario: vencimiento, día seleccionado, corte de reporte, fecha base de un
  plan, fecha de campaña por día.
- No guardes strings localizados como `29 jun 2026`, `6/29/2026`, ni valores
  dependientes del locale del navegador.

## Reglas de Programación y Crones

- Los crones comparan instantes UTC, pero calculan "hoy", vencimientos y buckets
  diarios con la zona del negocio.
- Un pago programado para "hoy" en el negocio queda vencido hoy aunque el servidor
  esté en UTC y ya haya cambiado de día.
- Si un pago automático tiene tarjeta guardada y vence en el día actual del
  negocio, el cron puede cobrarlo al llegar su hora o en el siguiente tick del
  mismo día.
- Una parcialidad cuya fecha de negocio ya quedó en un día anterior nunca se
  cobra como "puesta al corriente" automática. Debe pasar a
  `overdue_review`/`overdue`, quedar visible para revisión y exigir una nueva
  fecha antes de reactivar el plan. El flujo completo queda pausado para que las
  cuotas futuras tampoco avancen sin esa revisión. Esto aplica también al arranque después de
  downtime, reconexión de pasarela y reanudación de un plan pausado.
- Una fecha de plan sin hora explícita se normaliza a las 10:00:00 en la zona
  del negocio. Nunca se hereda silenciosamente la hora en que se creó o editó.
- Si falta tarjeta guardada/autorizada, el plan debe esperar autorización de
  tarjeta por la pasarela elegida; no inventes cobro automático.
- Usa locks/idempotencia al agregar nuevos crones o procesos programados.

## Mutaciones y Refresco Canónico

- Después de crear, editar, cancelar o cobrar entidades programadas con fechas
  calculadas por backend o por una integración (planes de pago, citas, mensajes,
  automatizaciones, reportes programados), no pintes filas optimistas como fuente
  final si contienen fechas. Espera un refetch canónico del backend y descarta
  respuestas anteriores para evitar que la UI muestre timestamps intermedios o
  datos sin normalizar.
- Si la mutación puede detonar webhooks, espejos locales, crones inmediatos o
  cobros vencidos "hoy", espera la recarga canónica antes de cerrar el flujo o
  enseñar la tabla. El usuario debe ver la fecha final del negocio, no el estado
  parcial previo al refresh.

## Frontend: Prohibido

No uses estas formas para fechas de negocio:

```ts
new Date().toISOString().slice(0, 10)
DateTime.local()
DateTime.now().toISODate()
new Date(year, month, day) // para interpretar una fecha del negocio
value.toLocaleDateString() // sin pasar timeZone explícito
new Date(dateRange.start) // si puede venir como YYYY-MM-DD
```

Excepción: se permite `new Date()` como referencia del instante actual, siempre
que la fecha de negocio se derive después con `todayDateOnlyInTimezone(timezone)`
o una utilidad equivalente.

No crees formatters locales en pantallas (`function formatDate(...)`,
`formatDateTime(...)`, `new Intl.DateTimeFormat('es-MX', ...)`) para datos del
CRM. Si el texto es visible para el usuario, usa los helpers globales y pasa la
zona del negocio, o justifica claramente por qué el valor es una fecha local del
control y no un dato de negocio.

## Backend: Prohibido

No hagas esto para lógica de negocio:

```js
new Date().toISOString().slice(0, 10)
new Date().toISOString().split('T')[0]
DateTime.local()
DateTime.now().toISODate()
new Date('2026-06-29') // interpreta UTC y puede mover el día mostrado
```

Usa `businessTodayDateOnly(timezone)`, `normalizeDateOnlyInTimezone()`,
`normalizeToUtcIso(value, timezone)`, `assertDateOnlyNotInPast()` y
`assertLocalDateTimeNotInPast()` desde `dateUtils.js`.

## Integraciones

- Google Calendar / HighLevel Calendar: convierte rangos `YYYY-MM-DD` a inicio y
  fin de día en la zona del negocio antes de pedir slots o eventos.
- Calendarios públicos y embebidos: si el visitante elige otra zona, amplía la
  consulta de fechas lo necesario para cubrir el borde visual, calcula los slots
  con la zona del negocio y luego agrúpalos/muéstralos en la zona del visitante.
- Stripe, Conekta, Rebill y Mercado Pago: las fechas internas del plan se calculan con la
  zona del negocio; los cargos reales se ejecutan como instantes UTC.
- En planes Stripe, Conekta y Rebill, una fecha programada sin hora usa las 10:00
  del negocio. La opción explícita de cobro inmediato debe enviar el instante UTC
  actual; no debe degradarse a una fecha de calendario que pueda cobrarse después.
- Meta Ads y reportes: las agrupaciones por día deben usar la zona configurada,
  no UTC puro.
- Links públicos: el backend debe enviar la zona de la cuenta y el frontend debe
  formatear vencimientos con esa zona, no con la zona del visitante.
- Storage/media: los folders por fecha deben usar el día del negocio si el asset
  pertenece a una cuenta o CRM.

## SQL, reportes y SQLite

- En PostgreSQL, agrupa fechas con `AT TIME ZONE` usando la zona del negocio.
- En SQLite, nunca hardcodees offsets como `'-6 hours'`. SQLite no entiende
  zonas IANA; usa `sqliteTimezoneOffsetClause(timezone)` desde
  `backend/src/utils/dateUtils.js` para generar el modificador de fecha.
- Si agregas una métrica nueva, reutiliza `getGroupExpression(...)`,
  `timestampLocalExpression(...)` o un helper compartido equivalente. No metas
  `datetime(col, ...)` a mano en servicios nuevos.

## Antes de Cerrar un Cambio

Para cambios de fechas corre como mínimo:

```bash
cd backend && npm test
cd frontend && npm run typecheck
cd frontend && npm run build
git diff --check
```

Si el cambio toca UI de escritorio, también:

```bash
cd frontend && npm run design:audit
```

Haz un grep final buscando patrones peligrosos:

```bash
rg "toISOString\\(\\)\\.slice\\(0, 10\\)|toISOString\\(\\)\\.split\\('T'\\)\\[0\\]|DateTime\\.local\\(|DateTime\\.now\\(\\)\\.toISODate\\(|new Date\\('[0-9]{4}-[0-9]{2}-[0-9]{2}'\\)" backend/src frontend/src
rg "new Date\\([^)]*dateRange|dateRange\\.(start|end) instanceof Date" frontend/src
rg "toLocaleDateString\\('es-MX'|toLocaleString\\('es-MX'|new Intl\\.DateTimeFormat\\('es-MX'" frontend/src
```

Si aparece algo, justifícalo claramente o corrígelo.
