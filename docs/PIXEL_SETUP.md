# 🎯 GUÍA RÁPIDA - PIXEL DE TRACKING

## Para el cliente (instrucciones simples)

### 1. Configurar CNAME en su DNS

**Cloudflare / GoDaddy / Squarespace / Cualquier proveedor:**

```
Tipo: CNAME
Nombre: collect
Destino: tu-app.onrender.com (o tu dominio de servidor)
TTL: Automático (o 3600)
```

Esto creará: `https://collect.su-dominio.com`

**Ejemplo real:**
- Si su sitio es `https://zapatosdeportivos.com`
- El CNAME será `https://collect.zapatosdeportivos.com`

### 2. Insertar el script en su sitio

**Pegar esto ANTES de `</body>` en TODAS las páginas:**

```html
<script async src="https://collect.su-dominio.com/snip.js"></script>
```

**En WordPress:**
- Ir a: Apariencia → Editor de temas → footer.php
- Pegar el script antes de `</body>`
- Guardar

**En Shopify:**
- Ir a: Configuración → Checkout → Scripts adicionales
- Pegar el script
- Guardar

**En HTML estático:**
- Editar `index.html` o el template principal
- Pegar antes de `</body>`

### 3. Verificar que funciona

1. **Abrir su sitio** en el navegador
2. **Abrir DevTools** (F12 o clic derecho → Inspeccionar)
3. **Ir a la pestaña Network**
4. **Recargar la página** (F5)
5. **Buscar:** `snip.js` y `/collect`
   - `snip.js` debe aparecer con status **200 OK**
   - `/collect` debe aparecer con status **200 OK**

Si ves ambos con 200, ¡funciona! 🎉

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
