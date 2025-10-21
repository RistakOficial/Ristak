# 🎯 TUTORIAL SIMPLE - PIXEL DE TRACKING

## ¿Qué hace esto?
Este pixel es como una cámara invisible en tu sitio web. Cada vez que alguien entra, guarda de dónde viene (Facebook, Google, Instagram, etc.) y qué hace en tu sitio. Así sabes qué anuncios están jalando gente.

---

## PASO 1: Configurar el subdominio (DNS)

**¿Qué carajos es esto?**
Básicamente vas a crear una "puerta trasera" en tu dominio para que el pixel funcione. Es un paso técnico pero súper simple.

**Entra a donde controlas tu dominio** (Cloudflare, GoDaddy, etc.) y agrega esto:

```
Tipo: CNAME
Nombre: collect
Apunta a: ristak-app.onrender.com
```

**Ejemplo:**
- Tu sitio: `mitienda.com`
- Vas a crear: `collect.mitienda.com`
- Ese collect.mitienda.com va a apuntar a donde está la app de Ristak

**Espera 5-10 minutos** para que se active. Listo.

---

## PASO 2: Poner el código en tu sitio

**Copia y pega este código en tu sitio web:**

```html
<script async src="https://collect.tudominio.com/snip.js"></script>
```

**¿Dónde lo pego?**

### WordPress:
1. Ve a **Apariencia → Editor de temas**
2. Abre el archivo `footer.php`
3. Busca `</body>` (está casi al final)
4. Pega el código ARRIBA de `</body>`
5. Dale **Guardar**

### HighLevel (tu landing page):
1. En el builder, ve a **Settings → Tracking Code**
2. Pega el código en "Footer Scripts"
3. Guarda

### Shopify:
1. Ve a **Configuración → Checkout**
2. Busca "Scripts adicionales"
3. Pega el código
4. Guarda

---

## PASO 3: Revisar si jala

1. **Abre tu sitio** (el sitio donde pusiste el código)
2. **Dale F12** en tu teclado (o clic derecho → Inspeccionar)
3. Ve a la pestaña **Network** (Red)
4. **Recarga la página** (F5)
5. **Busca** en la lista algo que diga `snip.js` y algo que diga `collect`

**Si ves ambos con un "200" al lado → ¡ESTÁ JALANDO! 🎉**

Si no aparecen o dice "404":
- Verifica que configuraste bien el CNAME en el paso 1
- Espera otros 10 minutos (a veces el DNS tarda)
- Revisa que pegaste bien el código en tu sitio

---

## ¿Y ahora qué?

Una vez que funcione, el pixel empezará a guardar automáticamente:
- Quién entra a tu sitio
- De dónde viene (Facebook, Google, Instagram, TikTok)
- Qué anuncio clickeó
- Cuánto tiempo estuvo
- Si se registró o compró algo

Todo eso lo vas a ver en la página de **Analíticas** dentro de Ristak.

---

## Para ti (administrador)

### Ver sesiones capturadas

**API:**
```bash
curl 'https://tu-app.onrender.com/api/tracking/sessions?limit=100'
```

**Query en SQLite (local):**
```bash
sqlite3 ristak.db "SELECT * FROM sessions ORDER BY started_at DESC LIMIT 10;"
```

**Query en PostgreSQL (producción):**
```sql
SELECT
  session_id,
  visitor_id,
  landing_url,
  utm_source,
  utm_medium,
  utm_campaign,
  gclid,
  fbclid,
  pageviews_count,
  started_at
FROM sessions
ORDER BY started_at DESC
LIMIT 50;
```

### Top fuentes de tráfico

```sql
SELECT
  utm_source,
  COUNT(*) as sessions,
  SUM(pageviews_count) as total_pageviews
FROM sessions
WHERE utm_source IS NOT NULL
GROUP BY utm_source
ORDER BY sessions DESC;
```

### Sesiones con Google Ads (gclid)

```sql
SELECT
  session_id,
  landing_url,
  gclid,
  utm_campaign,
  pageviews_count,
  started_at
FROM sessions
WHERE gclid IS NOT NULL
ORDER BY started_at DESC;
```

### Sesiones con Facebook Ads (fbclid)

```sql
SELECT
  session_id,
  landing_url,
  fbclid,
  utm_campaign,
  pageviews_count,
  started_at
FROM sessions
WHERE fbclid IS NOT NULL
ORDER BY started_at DESC;
```

### Calcular bounce rate

```sql
SELECT
  ROUND((SUM(CASE WHEN is_bounce = 1 THEN 1 ELSE 0 END) * 100.0) / COUNT(*), 2) as bounce_rate_percent
FROM sessions;
```

---

## Troubleshooting

### El script no carga (404)

**Problema:** `https://collect.cliente.com/snip.js` devuelve 404

**Solución:**
1. Verificar que el CNAME esté configurado:
   ```bash
   nslookup collect.cliente.com
   ```
2. Esperar propagación DNS (puede tardar hasta 24 horas, normalmente 5-10 minutos)
3. Verificar en Cloudflare que el proxy esté ON

### Los eventos no se guardan

**Problema:** El script carga pero no aparecen sesiones en la base de datos

**Solución:**
1. Verificar logs del backend:
   ```bash
   # En Render
   Dashboard → Logs → Ver en tiempo real
   ```
2. Buscar errores relacionados con `/collect`
3. Verificar que la tabla `sessions` exista:
   ```bash
   sqlite3 ristak.db ".tables"
   ```

### CORS errors

**Problema:** Error de CORS en la consola del navegador

**Causa:** El pixel y el endpoint `/collect` NO están en el mismo dominio

**Solución:**
1. Verificar que el CNAME esté apuntando correctamente
2. El script debe cargarse desde `https://collect.cliente.com/snip.js`
3. Y el endpoint será automáticamente `https://collect.cliente.com/collect`
4. NO mezclar dominios (ej. cargar de `tu-app.onrender.com` pero enviar a `collect.cliente.com`)

---

## Eventos personalizados

El pixel expone una función global `window.ristakTrack()`:

```javascript
// Rastrear clic en botón
document.querySelector('#btn-comprar').addEventListener('click', function() {
  window.ristakTrack('button_click', {
    button_id: 'btn-comprar',
    product_id: '12345',
    price: 99.99
  });
});

// Rastrear formulario enviado
window.ristakTrack('form_submit', {
  form_name: 'contacto',
  email: 'usuario@ejemplo.com'
});

// Rastrear conversión
window.ristakTrack('purchase', {
  order_id: '67890',
  total: 299.99,
  currency: 'MXN'
});
```

Todos los datos adicionales se guardan en la sesión.

---

## Próximos pasos (opcional)

1. **Crear dashboard en frontend** para ver sesiones visualmente
2. **Linkear sesiones con contactos** de HighLevel (usando email/phone)
3. **Agregar enriquecimiento de IP** con MaxMind GeoIP
4. **Implementar conversion tracking** (revenue_value, orders_count)
5. **Crear reportes de atribución** (ROAS por UTM source)

---

## Documentación completa

Ver: [TRACKING_PIXEL.md](./TRACKING_PIXEL.md)
