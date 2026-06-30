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

Frontend:

- Usa `useTimezone()` para leer la zona activa.
- Usa utilidades de `frontend/src/utils/timezone.ts`:
  - `todayDateOnlyInTimezone(timezone)`
  - `localDateTimeInputToUTCISOString(value, timezone)`
  - `toDateTimeLocalInputValue(utcDate, timezone)`
  - `formatInTimezone(utcDate, timezone)`
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
- Si un pago automático tiene tarjeta guardada y está vencido, el cron puede
  cobrarlo en el siguiente tick.
- Si falta tarjeta guardada/autorizada, el plan debe esperar autorización de
  tarjeta por la pasarela elegida; no inventes cobro automático.
- Usa locks/idempotencia al agregar nuevos crones o procesos programados.

## Frontend: Prohibido

No uses estas formas para fechas de negocio:

```ts
new Date().toISOString().slice(0, 10)
DateTime.local()
DateTime.now().toISODate()
new Date(year, month, day) // para interpretar una fecha del negocio
value.toLocaleDateString() // sin pasar timeZone explícito
```

Excepción: se permite `new Date()` como referencia del instante actual, siempre
que la fecha de negocio se derive después con `todayDateOnlyInTimezone(timezone)`
o una utilidad equivalente.

## Backend: Prohibido

No hagas esto para lógica de negocio:

```js
new Date().toISOString().slice(0, 10)
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
- Stripe, Conekta y Mercado Pago: las fechas internas del plan se calculan con la
  zona del negocio; los cargos reales se ejecutan como instantes UTC.
- Meta Ads y reportes: las agrupaciones por día deben usar la zona configurada,
  no UTC puro.
- Links públicos: el backend debe enviar la zona de la cuenta y el frontend debe
  formatear vencimientos con esa zona, no con la zona del visitante.
- Storage/media: los folders por fecha deben usar el día del negocio si el asset
  pertenece a una cuenta o CRM.

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
rg "toISOString\\(\\)\\.slice\\(0, 10\\)|DateTime\\.local\\(|DateTime\\.now\\(\\)\\.toISODate\\(|new Date\\('[0-9]{4}-[0-9]{2}-[0-9]{2}'\\)" backend/src frontend/src
```

Si aparece algo, justifícalo claramente o corrígelo.
