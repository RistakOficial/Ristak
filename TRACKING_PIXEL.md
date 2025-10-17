# 🎯 PIXEL DE TRACKING - RISTAK

Sistema de tracking minimalista con pixel JavaScript que captura visitas, UTMs, click IDs (gclid, fbclid, etc) y los guarda en tu base de datos.

## 📋 ¿Qué hace esto?

Permite a tus clientes meter un simple `<script>` en su sitio web y automáticamente capturar:

- ✅ Visitas a páginas
- ✅ UTMs (utm_source, utm_medium, utm_campaign, etc)
- ✅ Click IDs de anuncios (gclid, fbclid, msclkid, ttclid, wbraid, gbraid)
- ✅ Cookies de Facebook (fbc, fbp)
- ✅ Información del navegador (device_type, idioma, timezone)
- ✅ Referrer (de dónde viene el visitante)
- ✅ IP y User-Agent

Todo se guarda en la tabla `sessions` de tu base de datos.

---

## 🚀 CÓMO USAR (Para tus clientes)

### Paso 1: Configurar CNAME

El cliente debe crear un **CNAME** en su DNS apuntando a tu app:

**Ejemplo en Cloudflare:**
```
Tipo: CNAME
Nombre: collect
Destino: tu-app.onrender.com (o el dominio de tu servidor)
Proxy: ON (Opcional, pero recomendado)
```

Esto crea la URL: `https://collect.su-dominio.com`

**Ejemplo en Squarespace/GoDaddy:**
```
Host: collect
Apunta a: tu-app.onrender.com
TTL: Automático
```

### Paso 2: Insertar el script en su sitio

El cliente debe pegar esto **ANTES de `</body>`** en TODAS las páginas de su sitio:

```html
<!-- Pixel de Tracking Ristak -->
<script async src="https://collect.su-dominio.com/snip.js"></script>
```

**Eso es todo.** El pixel empezará a capturar automáticamente.

---

## 🧪 PROBAR EN DESARROLLO LOCAL

### 1. Arrancar la app

```bash
cd /Users/raulgomez/Desktop/Ristak\ -\ High\ Level
bash start-local.sh
```

### 2. Ver el código del pixel

```bash
curl http://localhost:3001/snip.js
```

Deberías ver el código JavaScript con `ENDPOINT = 'http://localhost:3001/collect'`

### 3. Enviar un evento de prueba

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
      "referrer": "https://google.com/search?q=zapatos",
      "title": "Zapatos deportivos - Mi Tienda",
      "utm_source": "google",
      "utm_medium": "cpc",
      "utm_campaign": "zapatos_verano",
      "gclid": "CjwKCAiA_test",
      "device_type": "desktop",
      "language": "es-MX",
      "timezone": "America/Mexico_City"
    }
  }'
```

Respuesta esperada: `{"ok":true}`

### 4. Consultar las sesiones guardadas

```bash
curl 'http://localhost:3001/api/tracking/sessions?limit=10' | python3 -m json.tool
```

### 5. Ver una sesión específica

```bash
curl 'http://localhost:3001/api/tracking/sessions/test-session-001' | python3 -m json.tool
```

---

## 📊 ENDPOINTS DISPONIBLES

### 1. `GET /snip.js`

**Descripción:** Sirve el código JavaScript del pixel

**Headers de respuesta:**
- `Content-Type: application/javascript`
- `Cache-Control: public, max-age=3600`

**Ejemplo:**
```bash
curl http://localhost:3001/snip.js
```

**Nota:** El ENDPOINT dentro del JS se genera dinámicamente según el dominio de la petición. Si el cliente accede desde `https://collect.midominio.com/snip.js`, el pixel apuntará a `https://collect.midominio.com/collect`.

---

### 2. `POST /collect`

**Descripción:** Recibe eventos del pixel y los guarda en la base de datos

**Body (JSON):**
```json
{
  "visitor_id": "uuid-del-visitante",
  "session_id": "uuid-de-la-sesion",
  "event_name": "page_view",
  "ts": 1729206000000,
  "data": {
    "url": "https://ejemplo.com/pagina",
    "referrer": "https://google.com",
    "title": "Título de la página",
    "utm_source": "google",
    "utm_medium": "cpc",
    "utm_campaign": "verano2024",
    "utm_term": "zapatos deportivos",
    "utm_content": "anuncio-azul",
    "gclid": "CjwKCAiA...",
    "fbclid": "IwAR...",
    "msclkid": "...",
    "ttclid": "...",
    "wbraid": "...",
    "gbraid": "...",
    "fbc": "fb.1.1234567890.IwAR...",
    "fbp": "fb.1.1234567890.1234567890",
    "device_type": "desktop",
    "language": "es-MX",
    "timezone": "America/Mexico_City"
  }
}
```

**Respuesta:**
```json
{"ok": true}
```

**Límites:**
- Máximo 50 KB por request
- Si excede, responde con `413 Payload Too Large`

**Validaciones:**
- `visitor_id`, `session_id`, `event_name`, `ts` son obligatorios
- Si falta alguno, responde con `400 Bad Request`

---

### 3. `GET /api/tracking/sessions?limit=50`

**Descripción:** Obtiene las sesiones más recientes

**Query params:**
- `limit` (opcional): Número de sesiones a devolver (default: 50, max: 1000)

**Ejemplo:**
```bash
curl 'http://localhost:3001/api/tracking/sessions?limit=10'
```

**Respuesta:**
```json
{
  "sessions": [
    {
      "session_id": "abc-123",
      "visitor_id": "xyz-456",
      "contact_id": null,
      "landing_url": "https://ejemplo.com/producto",
      "referrer_url": "https://google.com",
      "utm_source": "google",
      "utm_medium": "cpc",
      "utm_campaign": "verano2024",
      "gclid": "CjwKCAiA...",
      "fbclid": null,
      "msclkid": null,
      "ttclid": null,
      "device_type": "desktop",
      "pageviews_count": 3,
      "events_count": 5,
      "is_bounce": 0,
      "started_at": "2024-10-17T23:00:00.000Z",
      "last_event_at": "2024-10-17T23:05:30.000Z"
    }
  ]
}
```

---

### 4. `GET /api/tracking/sessions/:id`

**Descripción:** Obtiene una sesión específica con todos sus datos

**Ejemplo:**
```bash
curl 'http://localhost:3001/api/tracking/sessions/abc-123'
```

**Respuesta:**
```json
{
  "session": {
    "session_id": "abc-123",
    "visitor_id": "xyz-456",
    "contact_id": null,
    "event_name": "page_view",
    "started_at": "2024-10-17T23:00:00.000Z",
    "last_event_at": "2024-10-17T23:05:30.000Z",
    "landing_url": "https://ejemplo.com/producto",
    "referrer_url": "https://google.com",
    "utm_source": "google",
    "utm_medium": "cpc",
    "utm_campaign": "verano2024",
    "gclid": "CjwKCAiA...",
    "device_type": "desktop",
    "ip": "192.168.1.100",
    "user_agent": "Mozilla/5.0...",
    "pageviews_count": 3,
    "events_count": 5,
    "is_bounce": 0
  }
}
```

---

## 🗄️ TABLA EN BASE DE DATOS

Todos los datos se guardan en la tabla `sessions`:

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  contact_id TEXT,
  event_name TEXT NOT NULL DEFAULT 'page_view',
  started_at TIMESTAMP NOT NULL,
  last_event_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- URLs
  landing_url TEXT,
  referrer_url TEXT,

  -- Atribución (UTMs + Click IDs)
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

  -- Dispositivo y navegador
  ip TEXT,
  user_agent TEXT,
  device_type TEXT,
  language TEXT,
  timezone TEXT,

  -- Geo (opcional)
  geo_country TEXT,
  geo_region TEXT,
  geo_city TEXT,

  -- Métricas
  pageviews_count INTEGER DEFAULT 0,
  events_count INTEGER DEFAULT 0,
  is_bounce INTEGER DEFAULT 0,

  -- Conversión (opcional)
  orders_count INTEGER DEFAULT 0,
  revenue_value REAL DEFAULT 0,
  currency TEXT DEFAULT 'MXN',

  -- Identidad (opcional)
  email TEXT,
  phone_e164 TEXT
);
```

**Índices creados:**
```sql
CREATE INDEX idx_sessions_visitor ON sessions(visitor_id);
CREATE INDEX idx_sessions_started_at ON sessions(started_at);
CREATE INDEX idx_sessions_utm ON sessions(utm_source, utm_medium, utm_campaign);
CREATE INDEX idx_sessions_ids ON sessions(gclid, fbclid, msclkid, ttclid);
CREATE INDEX idx_sessions_geo ON sessions(geo_country, geo_region, geo_city);
```

---

## 🔄 FLUJO DE TRACKING

### Primera visita del usuario:

1. Usuario entra a `https://cliente.com/producto?utm_source=google&gclid=abc123`
2. El pixel carga desde `https://collect.cliente.com/snip.js`
3. El pixel:
   - Crea un `visitor_id` único (localStorage, permanente)
   - Crea un `session_id` único (sessionStorage, temporal)
   - Captura la URL, UTMs, gclid, referrer, device_type, etc.
   - Envía POST a `https://collect.cliente.com/collect`
4. El backend:
   - Detecta que es una sesión nueva
   - Crea fila en tabla `sessions` con todos los datos
   - Responde `{"ok": true}`

### Segunda visita en la misma sesión:

1. Usuario navega a `https://cliente.com/contacto`
2. El pixel:
   - Reutiliza el mismo `visitor_id` y `session_id`
   - Captura la nueva URL
   - Envía POST a `/collect`
3. El backend:
   - Detecta que la sesión ya existe
   - Actualiza `last_event_at`
   - Incrementa `pageviews_count` y `events_count`
   - Responde `{"ok": true}`

### Cierre de sesión:

1. Usuario cierra el tab o navega fuera del sitio
2. El pixel envía evento `session_end` con `beforeunload`
3. El backend:
   - Calcula si fue bounce (1 página y < 30 segundos)
   - Actualiza `is_bounce` si aplica

---

## 🎨 EVENTOS PERSONALIZADOS

El pixel expone una función global `window.ristakTrack()` para enviar eventos custom:

```javascript
// Ejemplo: Rastrear cuando un usuario hace clic en "Comprar"
document.querySelector('#btn-comprar').addEventListener('click', function() {
  window.ristakTrack('button_click', {
    button_id: 'btn-comprar',
    product_id: '12345'
  });
});

// Ejemplo: Rastrear un formulario enviado
window.ristakTrack('form_submit', {
  form_name: 'contacto',
  email: 'usuario@ejemplo.com'
});
```

Todos los datos adicionales se guardarán en la tabla `sessions` junto con la sesión.

---

## ⚙️ CONFIGURACIÓN AVANZADA

### Heartbeat (pulso cada 15s)

Por defecto está **desactivado** para no saturar. Si quieres activarlo, edita el pixel en:

**Archivo:** `backend/src/controllers/trackingController.js`

**Buscar:**
```javascript
// Heartbeat cada 15 segundos (opcional, comentado por defecto)
// setInterval(function() {
//   sendEvent('heartbeat');
// }, 15000);
```

**Descomentar:**
```javascript
// Heartbeat cada 15 segundos
setInterval(function() {
  sendEvent('heartbeat');
}, 15000);
```

Esto enviará un evento `heartbeat` cada 15 segundos mientras el usuario tenga la página abierta.

### Bounce Detection

Un usuario se marca como "bounce" si:
- Solo ve 1 página (`pageviews_count = 1`)
- Y dura menos de 30 segundos en el sitio

Esto se calcula automáticamente cuando el pixel envía `session_end`.

---

## 🔒 SEGURIDAD

### Límites:
- ✅ Máximo 50 KB por request
- ✅ Validaciones básicas de campos requeridos
- ✅ Sanitización automática (SQLite/Postgres previene injection)

### Same-Origin:
- ✅ El pixel y el endpoint `/collect` se sirven desde el **mismo host** (collect.cliente.com)
- ✅ Cumple con políticas CSP (Content Security Policy)
- ✅ No hay CORS issues porque el origen es el mismo

### No hardcodeamos dominios:
- ✅ Todo se detecta dinámicamente desde `req.headers.host`
- ✅ Funciona con cualquier CNAME sin cambiar código
- ✅ En local usa `localhost:3001`, en producción usa el CNAME real

---

## 📊 CONSULTAS ÚTILES

### Ver sesiones de hoy:

```sql
SELECT * FROM sessions
WHERE DATE(started_at) = DATE('now')
ORDER BY started_at DESC;
```

### Top fuentes de tráfico (UTM Source):

```sql
SELECT utm_source, COUNT(*) as sessions
FROM sessions
WHERE utm_source IS NOT NULL
GROUP BY utm_source
ORDER BY sessions DESC;
```

### Sesiones con gclid (Google Ads):

```sql
SELECT session_id, landing_url, gclid, started_at
FROM sessions
WHERE gclid IS NOT NULL
ORDER BY started_at DESC;
```

### Sesiones que rebotaron:

```sql
SELECT session_id, landing_url, pageviews_count, started_at
FROM sessions
WHERE is_bounce = 1
ORDER BY started_at DESC;
```

### Duración promedio de sesiones:

```sql
SELECT
  AVG((julianday(last_event_at) - julianday(started_at)) * 86400) as avg_duration_seconds
FROM sessions
WHERE last_event_at IS NOT NULL;
```

---

## 🐛 TROUBLESHOOTING

### El pixel no carga

**Problema:** El cliente puso `<script src="https://collect.midominio.com/snip.js"></script>` pero no carga.

**Solución:**
1. Verificar que el CNAME esté configurado correctamente:
   ```bash
   nslookup collect.midominio.com
   ```
   Debería resolver a tu servidor.

2. Verificar que el servidor responda:
   ```bash
   curl https://collect.midominio.com/snip.js
   ```
   Debería devolver el código JavaScript.

3. Verificar en el navegador (DevTools > Network):
   - Buscar la request a `snip.js`
   - Ver si responde 200 OK
   - Ver si hay errores de CORS o CSP

---

### Los eventos no se guardan

**Problema:** El pixel carga pero los eventos no aparecen en la base de datos.

**Solución:**
1. Verificar que `/collect` responda:
   ```bash
   curl -X POST https://collect.midominio.com/collect \
     -H "Content-Type: application/json" \
     -d '{"visitor_id":"test","session_id":"test","event_name":"test","ts":1234567890,"data":{}}'
   ```
   Debería responder `{"ok":true}`.

2. Ver logs del backend:
   ```bash
   # En producción (Render)
   Ir a Dashboard > Logs

   # En local
   Ver la terminal donde corre el backend
   ```

3. Verificar que la tabla `sessions` exista:
   ```bash
   sqlite3 ristak.db "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions';"
   ```

---

### El ENDPOINT está hardcodeado

**Problema:** El pixel tiene `ENDPOINT = 'http://localhost:3001/collect'` en producción.

**Causa:** El servidor no está detectando correctamente el host.

**Solución:**
1. Verificar headers:
   ```bash
   curl -H "Host: collect.midominio.com" https://tu-app.onrender.com/snip.js
   ```
   Debería generar `ENDPOINT = 'https://collect.midominio.com/collect'`.

2. Si usa proxy (Cloudflare), asegurarse que pase el header `Host` correcto.

3. En Render, verificar que no haya configuración que sobrescriba el host.

---

## 🚀 DEPLOY A PRODUCCIÓN (RENDER)

### 1. Push a GitHub

```bash
git add .
git commit -m "Agregar pixel de tracking con /snip.js y /collect"
git push origin main
```

### 2. En Render

El deploy es automático. Render detectará los cambios y:
- Instalará dependencias
- Ejecutará migraciones (crea tabla `sessions`)
- Reiniciará el servidor

### 3. Configurar dominio custom (opcional)

Si quieres que sea `collect.tudominio.com` en lugar de `tu-app.onrender.com`:

1. En Render > Settings > Custom Domains
2. Agregar `collect.tudominio.com`
3. En tu DNS, crear CNAME:
   ```
   Nombre: collect
   Destino: tu-app.onrender.com
   ```

### 4. Probar en producción

```bash
curl https://collect.tudominio.com/snip.js
```

Debería devolver el código JavaScript con `ENDPOINT = 'https://collect.tudominio.com/collect'`.

---

## 📝 NOTAS IMPORTANTES

1. **Single-tenant:** Esta implementación NO usa `tenant_id`. Todas las sesiones van a una sola base de datos. Si necesitas multi-tenant después, solo agrega una columna `client_id` o `location_id`.

2. **No enriquecimiento de IP:** No se hace lookup de geolocalización por IP. Si el cliente quiere eso, necesitarás integrar un servicio como MaxMind GeoIP (de pago).

3. **Cookies de terceros:** El pixel captura cookies de Facebook (`_fbc`, `_fbp`) si existen. Estas ayudan con la atribución de campañas de Facebook Ads.

4. **Privacidad:** Este sistema captura IPs y User-Agents. Asegúrate de tener un Privacy Policy claro si operas en Europa (GDPR) o California (CCPA).

5. **Performance:** SQLite funciona bien hasta ~100k sesiones. Si creces más, considera migrar a PostgreSQL (ya está soportado en `database.js`).

---

## 📚 ARCHIVOS CREADOS

```
backend/src/
├── config/
│   └── database.js              ← Tabla sessions agregada
├── controllers/
│   └── trackingController.js    ← Lógica de endpoints
├── services/
│   └── trackingService.js       ← CRUD de sesiones
├── routes/
│   └── tracking.routes.js       ← Rutas del pixel
└── server.js                    ← Rutas registradas

Documentación:
└── TRACKING_PIXEL.md            ← Este archivo
```

---

## ✅ CHECKLIST DE IMPLEMENTACIÓN

Para que un cliente use el pixel:

- [ ] Configurar CNAME en su DNS (`collect.sudominio.com` → `tu-app.onrender.com`)
- [ ] Insertar `<script async src="https://collect.sudominio.com/snip.js"></script>` en su sitio
- [ ] Probar que cargue: abrir su sitio y buscar en DevTools > Network el request a `snip.js`
- [ ] Probar que envíe: abrir DevTools > Network > XHR y ver requests a `/collect`
- [ ] Verificar en Ristak: consultar `/api/tracking/sessions` y ver las sesiones

---

## 🎉 ¡LISTO!

Ya tienes un sistema de tracking completo que:

✅ Captura visitas, UTMs, click IDs, referrers
✅ Se sirve same-origin (cumple CSP)
✅ Funciona con cualquier CNAME sin hardcodear dominios
✅ Guarda todo en tu BD (SQLite/Postgres)
✅ Expone APIs para consultar sesiones

Si necesitas agregar features (como eventos custom, conversiones, o linkear con contactos de HighLevel), ya tienes la base sólida.

**¡Chingón!** 🚀
