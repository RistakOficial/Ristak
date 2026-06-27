# Setup Simple Del Pixel

Esta guía es para instalar el tracking de Ristak sin meterte en todo el código.

## Qué Hace

El pixel registra visitas, UTMs, click IDs, navegador, dispositivo, referrer y eventos custom. La información llega a `POST /collect` y se guarda en `sessions`.

Ojo: la tabla guarda una fila por evento, no una fila agregada por sesión.

## Opción Recomendada: Instalación Directa En Ristak

1. Entra a **Configuración -> Rastreo Web**.
2. Usa un dominio personalizado o CNAME, no el dominio `*.onrender.com`.
3. Copia el snippet del pixel.
4. Inserta el snippet antes de `</body>` o en el bloque global de tracking del sitio.

El snippet queda parecido a:

```html
<!-- Pixel de Tracking Ristak -->
<script async src="https://collect.tudominio.com/snip.js?v=8"></script>
```

Si hay Meta Pixel configurado y la preferencia está activa, el snippet generado también puede incluir Meta Pixel.

## Opción HighLevel Opcional

Si el sitio o funnel vive en HighLevel, puedes sincronizar el snippet como custom value:

1. En Ristak, entra a **Configuración -> HighLevel** y conecta tu cuenta.
2. Entra a **Configuración -> Rastreo Web**.
3. Haz click en **Sincronizar ahora**.
4. Ristak crea/actualiza el custom value `rstktrack` en HighLevel.
5. En el sitio/funnel de HighLevel, inserta ese custom value en el tracking code.

HighLevel no es requisito para que el pixel funcione; sólo es una forma cómoda de instalarlo en sitios de esa plataforma.

## Opción Manual

Inserta antes de `</body>` o en el bloque global de tracking del sitio:

```html
<script async src="https://collect.tudominio.com/snip.js"></script>
```

Cambia `collect.tudominio.com` por el dominio que apunta a tu app Ristak.

## DNS / Dominio

Configura un CNAME hacia tu servicio Render:

```txt
Tipo: CNAME
Nombre: collect
Apunta a: tu-servicio.onrender.com
```

Después agrega ese dominio en Render como custom domain si lo necesitas. En Cloudflare, proxy ON puede funcionar, pero valida que el host llegue correcto al backend.

## Probar Que Jala

1. Abre el sitio donde instalaste el script.
2. Abre DevTools -> Network.
3. Recarga la página.
4. Busca:
   - `snip.js` con status 200.
   - `collect` con status 200.

También puedes probar con curl:

```bash
curl https://collect.tudominio.com/snip.js
```

Y revisar eventos:

```bash
curl 'https://tu-app.onrender.com/api/tracking/sessions?limit=20'
```

## Eventos Custom

El pixel expone:

```javascript
window.ristakTrack('button_click', {
  button_id: 'btn-comprar',
  product_id: '12345'
})
```

Otro ejemplo:

```javascript
window.ristakTrack('purchase', {
  order_id: '67890',
  total: 299.99,
  currency: 'MXN'
})
```

Estos eventos se guardan como filas nuevas en `sessions`.

## Consultas SQL Útiles

Eventos recientes:

```sql
SELECT id, session_id, visitor_id, event_name, page_url, started_at
FROM sessions
ORDER BY started_at DESC
LIMIT 50;
```

Fuentes de tráfico:

```sql
SELECT COALESCE(source_platform, utm_source, 'direct') AS source,
       COUNT(DISTINCT visitor_id) AS visitors,
       COUNT(*) AS events
FROM sessions
GROUP BY source
ORDER BY visitors DESC;
```

Google Ads:

```sql
SELECT id, visitor_id, page_url, gclid, utm_campaign, started_at
FROM sessions
WHERE gclid IS NOT NULL
ORDER BY started_at DESC;
```

Facebook Ads:

```sql
SELECT id, visitor_id, page_url, fbclid, fbc, fbp, started_at
FROM sessions
WHERE fbclid IS NOT NULL OR fbc IS NOT NULL OR fbp IS NOT NULL
ORDER BY started_at DESC;
```

## Troubleshooting

### `snip.js` da 404

- Verifica que el CNAME apunte al servicio Render correcto.
- Verifica que el dominio esté agregado en Render si usas custom domain.
- Prueba:

```bash
nslookup collect.tudominio.com
curl -I https://collect.tudominio.com/snip.js
```

### Eventos no aparecen

- Revisa Network y confirma que `/collect` responda `200`.
- Revisa logs del backend en Render.
- Consulta:

```sql
SELECT COUNT(*) FROM sessions;
```

### CORS

El pixel está pensado para same-origin. Carga el script y envía `/collect` desde el mismo host:

```html
<script async src="https://collect.tudominio.com/snip.js"></script>
```

No mezcles `snip.js` de un dominio con `collect` de otro.

### Analíticas no aparecen

La app oculta Analíticas en dominios `*.onrender.com`. En dominio personalizado, **Rastreo Web** activa `show_analytics` y `visitor_source=tracking` automáticamente cuando detecta dominio válido.

## Más Detalle

Lee [TRACKING_PIXEL.md](./TRACKING_PIXEL.md) para schema, endpoints y comportamiento completo.
