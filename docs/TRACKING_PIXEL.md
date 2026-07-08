# Pixel De Tracking Ristak

Esta documentación describe el comportamiento real del código en:

- `backend/src/controllers/trackingController.js`
- `backend/src/services/trackingService.js`
- `backend/src/routes/tracking.routes.js`
- `frontend/src/pages/Settings/WebTracking.tsx`
- `frontend/src/services/trackingService.ts`

## Resumen

El backend sirve un pixel JavaScript dinámico en `GET /snip.js`. Ese pixel envía eventos a `POST /collect` en el mismo host donde se cargó el script.

Cada evento recibido se inserta como una fila nueva en la tabla `sessions`. No es una tabla agregada por sesión: `session_start`, `page_view`, `session_end` y eventos custom pueden compartir `session_id`, pero cada evento tiene su propio `id`.

## Datos Que Captura

- `visitor_id` persistente en `localStorage` con formato de 20 caracteres alfanuméricos.
- `session_id` temporal en `sessionStorage`.
- URL actual, referrer y título.
- UTMs: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`.
- Click IDs: `gclid`, `fbclid`, `msclkid`, `ttclid`, `wbraid`, `gbraid`.
- Cookies Facebook: `_fbc`, `_fbp`.
- Parámetros Meta/Google Ads: campaign/adset/ad ids, names, placement, keyword, network, etc.
- Device, OS, browser, browser version, idioma y timezone.
- IP real desde headers proxy (`x-forwarded-for`, `cf-connecting-ip`) o socket.
- Geo por IP usando `ip-api.com`, excepto IPs locales/privadas.
- `contact_id` cuando el sitio HighLevel expone datos en `localStorage._ud`.

## Endpoints

El router se monta dos veces:

- En `/`, para el pixel: `/snip.js`, `/collect`, `/sync-visitor`, `/link-visitor`.
- En `/api/tracking`, para la app: `/api/tracking/sessions`, `/api/tracking/config`, etc.

### `GET /snip.js`

Devuelve JavaScript con `Content-Type: application/javascript` y cache de 1 hora.

El endpoint interno se genera desde `req.headers.host`:

- `localhost` usa `http`.
- cualquier otro host usa `https`.

Ejemplo:

```bash
curl http://localhost:3001/snip.js
```

### `POST /collect`

Recibe eventos del pixel. Límite real: 50 KB por request validado con `content-length`.

Body mínimo:

```json
{
  "visitor_id": "abc123",
  "session_id": "f9e3c5c7-1c5f-4c62-bf7b-8fb0f3dca1d5",
  "event_name": "page_view",
  "ts": 1729206000000,
  "data": {
    "url": "https://ejemplo.com/pagina",
    "referrer": "https://google.com",
    "utm_source": "google",
    "utm_medium": "cpc",
    "utm_campaign": "campana",
    "gclid": "CjwK..."
  }
}
```

Campos requeridos:

- `visitor_id`
- `session_id`
- `event_name`
- `ts`

Respuesta exitosa:

```json
{ "ok": true }
```

### `POST /sync-visitor`

Usado por el pixel cuando detecta contacto HighLevel en `_ud`. Actualiza el custom field `rkvi_id` en HighLevel para guardar el `visitor_id`.

### `POST /link-visitor`

Vincula sesiones históricas de un `visitor_id` a un `contact_id`.

### `GET /api/tracking/sessions`

Sin fechas, devuelve paginación:

```bash
curl 'http://localhost:3001/api/tracking/sessions?offset=0&limit=50'
```

Respuesta:

```json
{
  "sessions": [],
  "total": 0,
  "offset": 0,
  "limit": 50,
  "hasMore": false
}
```

Con `start` y `end`, devuelve un array directo para la página Analytics:

```bash
curl 'http://localhost:3001/api/tracking/sessions?start=2026-05-01&end=2026-05-28'
```

El rango se resuelve con el timezone configurado en Ristak. Si HighLevel está conectado y no hay timezone propio, se usa como fallback de compatibilidad mediante `resolveDateRangeWithGHLTimezone()`.

### `GET /api/tracking/sessions/:id`

Busca por la columna primaria `sessions.id`, no por `session_id`.

```bash
curl 'http://localhost:3001/api/tracking/sessions/<id>'
```

Respuesta:

```json
{
  "session": {
    "id": "...",
    "session_id": "...",
    "visitor_id": "...",
    "event_name": "page_view"
  }
}
```

### `PUT /api/tracking/sessions/:id`

Actualiza campos permitidos de una fila de `sessions`.

### `DELETE /api/tracking/sessions`

Elimina hasta 100 filas por request.

Body:

```json
{ "ids": ["id1", "id2"] }
```

### Configuración

- `GET /api/tracking/config`
- `POST /api/tracking/configure`
- `POST /api/tracking/analytics-preference`
- `POST /api/tracking/visitor-source-preference`
- `GET /api/tracking/visitors-by-ad`
- `GET /api/tracking/visitors-by-period`
- `GET /api/tracking/visitors`
- `GET /api/tracking/contacts-by-date`

`configure` crea o actualiza el custom value `rstktrack` en HighLevel. Si hay Meta Pixel y la preferencia `include_meta_pixel` está activa, el snippet también incluye Meta Pixel.

## Flujo Del Pixel

1. Carga `https://dominio/snip.js`.
2. Genera o reutiliza `visitor_id`.
3. Genera o reutiliza `session_id`.
4. Inyecta `rkvi_id` en la URL si no existe.
5. Envía `session_start` en la primera vista de la sesión.
6. Detecta navegación SPA con `pushState`, `replaceState`, `popstate` y `hashchange`.
7. Envía `page_view` cuando cambia la URL.
8. Envía `session_end` en `beforeunload`.
9. Expone `window.ristakTrack(eventName, data)`.

Ejemplo de evento custom:

```javascript
window.ristakTrack('form_submit', {
  form_name: 'contacto',
  email: 'cliente@ejemplo.com'
})
```

## HTML Importado Y Conversiones Meta

Los sitios HTML importados por Sites no deben depender de heuristicas visuales
para saber si un formulario representa lead, cita o pago. El contrato oficial es
declarar la conversion en el `<form>` final o en el boton submit:

```html
<form
  data-rstk-form-id="agenda"
  data-rstk-conversion-event="Schedule"
  data-rstk-conversion-type="appointment_scheduled"
  data-rstk-calendar-name="Consulta inicial">
  <input name="email" type="email" data-rstk-field="email" autocomplete="email">
  <input type="hidden" data-rstk-conversion-param="appointment_start_time" value="2026-08-15T17:00:00Z">
  <button type="submit">Agendar</button>
</form>
```

Eventos permitidos: `Lead`, `CompleteRegistration`, `Schedule`, `Purchase`,
`Contact`, `ViewContent` y `FormSubmitted`. Para `Purchase`, manda
`data-rstk-conversion-value`, `data-rstk-conversion-content-name` y un
`data-rstk-conversion-order-id` o `data-rstk-payment-id` solo cuando el pago ya
esta confirmado. Ristak manda CAPI server-side y el Pixel del navegador con el
mismo `event_id`; Meta deduplica ambos. La moneda de `Purchase` sale de
`account_currency`, no del HTML externo.

### Elementos Nativos Ristak En HTML Importado

Cuando el HTML externo quiere usar la misma configuracion nativa del editor de
Sites, debe declarar una zona con `data-rstk-native-element` y
`data-rstk-native-id`. El editor solo reconoce `form`, `calendar`, `payment` y
`video`.

```html
<div data-rstk-native-element="form" data-rstk-native-id="lead-form-slot"></div>
<div data-rstk-native-element="calendar" data-rstk-native-id="agenda-slot" data-rstk-native-render="ristak"></div>
<div data-rstk-native-element="payment" data-rstk-native-id="checkout-principal"></div>
<div data-rstk-native-element="video" data-rstk-native-id="video-principal"></div>
```

Ristak guarda cada zona como bloque real del sitio importado:

- `form`: se conecta a un formulario existente de Ristak.
- `calendar`: se conecta a cualquier calendario disponible y respeta su
  configuracion de disponibilidad, campos, pagos, completado y Meta.
- `payment`: usa el mismo `PaymentGateControls` del editor; el evento `Purchase`
  sale del cobro confirmado, no del click.
- `video`: usa el mismo bloque de video del editor: subida/URL, controles,
  diseno, acciones por tiempo, formularios dentro del video y eventos Meta/CAPI
  configurados.

Si el calendario usa frontend propio, el HTML debe marcar
`data-rstk-native-render="custom"`. Ristak conserva el markup del sitio externo
e inyecta helpers publicos:

```javascript
await window.ristakCalendarGetSlots('agenda-custom', {
  startDate: '2026-08-15',
  endDate: '2026-08-22',
  timezone: 'America/Mexico_City'
})

await window.ristakCalendarBook('agenda-custom', {
  startTime: '2026-08-15T17:00:00Z',
  timezone: 'America/Mexico_City',
  name: 'Ana Cliente',
  email: 'ana@example.com',
  phone: '+525512345678'
})
```

`startTime` debe ser el ISO UTC del slot confirmado y `timezone` la zona usada
para mostrar/agendar la cita. El backend vuelve a validar disponibilidad antes
de crear la cita y manda el evento Meta de calendario cuando corresponde.

## Tabla `sessions`

Schema creado por `backend/src/config/database.js`:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id UUID_OR_TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  contact_id TEXT,
  full_name TEXT,
  email TEXT,
  event_name TEXT NOT NULL DEFAULT 'page_view',
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  page_url TEXT,
  referrer_url TEXT,

  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  gclid TEXT,
  fbclid TEXT,
  fbc TEXT,
  fbp TEXT,
  wbraid TEXT,
  gbraid TEXT,
  msclkid TEXT,
  ttclid TEXT,

  channel TEXT,
  source_platform TEXT,
  campaign_id TEXT,
  adset_id TEXT,
  ad_group_id TEXT,
  ad_id TEXT,
  campaign_name TEXT,
  adset_name TEXT,
  ad_group_name TEXT,
  ad_name TEXT,
  placement TEXT,
  site_source_name TEXT,
  network TEXT,
  match_type TEXT,
  keyword TEXT,
  search_query TEXT,
  creative_id TEXT,
  ad_position TEXT,

  ip TEXT,
  user_agent TEXT,
  device_type TEXT,
  os TEXT,
  browser TEXT,
  browser_version TEXT,
  language TEXT,
  timezone TEXT,

  geo_country TEXT,
  geo_region TEXT,
  geo_city TEXT,

  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);
```

Índices:

```sql
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_visitor ON sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_utm ON sessions(utm_source, utm_medium, utm_campaign);
CREATE INDEX IF NOT EXISTS idx_sessions_ids ON sessions(gclid, fbclid, msclkid, ttclid);
CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions(campaign_id, adset_id, ad_group_id, ad_id);
CREATE INDEX IF NOT EXISTS idx_sessions_geo ON sessions(geo_country, geo_region, geo_city);
CREATE INDEX IF NOT EXISTS idx_sessions_contact ON sessions(contact_id);
```

Campos que ya no existen y no debes usar en consultas:

- `landing_url`
- `last_event_at`
- `pageviews_count`
- `events_count`
- `is_bounce`
- `orders_count`
- `revenue_value`

## Consultas Útiles

Sesiones/eventos recientes:

```sql
SELECT id, session_id, visitor_id, event_name, page_url, started_at
FROM sessions
ORDER BY started_at DESC
LIMIT 50;
```

Visitantes únicos por fuente:

```sql
SELECT COALESCE(source_platform, utm_source, 'direct') AS source, COUNT(DISTINCT visitor_id) AS visitors
FROM sessions
GROUP BY source
ORDER BY visitors DESC;
```

Eventos con `gclid`:

```sql
SELECT id, visitor_id, page_url, gclid, started_at
FROM sessions
WHERE gclid IS NOT NULL
ORDER BY started_at DESC;
```

Eventos por ad:

```sql
SELECT ad_id, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS events
FROM sessions
WHERE ad_id IS NOT NULL
GROUP BY ad_id
ORDER BY visitors DESC;
```

## Desarrollo Local

Desde la raíz:

```bash
npm install --prefix backend
npm install --prefix frontend
bash start-local.sh
```

Probar pixel:

```bash
curl http://localhost:3001/snip.js
```

Enviar evento:

```bash
curl -X POST http://localhost:3001/collect \
  -H "Content-Type: application/json" \
  -d '{
    "visitor_id": "test-visitor-001",
    "session_id": "test-session-001",
    "event_name": "page_view",
    "ts": 1729206000000,
    "data": {
      "url": "https://ejemplo.com/producto",
      "utm_source": "google",
      "utm_medium": "cpc",
      "utm_campaign": "zapatos",
      "device_type": "desktop"
    }
  }'
```

Consultar:

```bash
curl 'http://localhost:3001/api/tracking/sessions?limit=10'
```

## Producción

Para same-origin real, usa un dominio o CNAME que llegue al mismo servicio donde vive Ristak.

Ejemplo:

```html
<script async src="https://collect.tudominio.com/snip.js"></script>
```

Si el sitio es HighLevel, puedes guardar el snippet con **Configuración -> Rastreo Web -> Sincronizar** y luego usar el custom value `rstktrack`.

## Notas De Seguridad Y Privacidad

- Captura IP, user-agent, cookies de Facebook y datos de navegación.
- Debe existir aviso de privacidad adecuado para la jurisdicción del negocio.
- `ip-api.com` se usa para geolocalización básica de IPs públicas.
- No hay `tenant_id`; la app es single-tenant por instancia/base de datos.
