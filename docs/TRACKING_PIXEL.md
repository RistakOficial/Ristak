# Pixel De Tracking Ristak

Esta documentación describe el comportamiento real del código en:

- `backend/src/controllers/trackingController.js`
- `backend/src/services/trackingService.js`
- `backend/src/routes/tracking.routes.js`
- `backend/src/middleware/publicTrackingCors.js`
- `backend/src/controllers/sitesController.js`
- `backend/src/services/sitesService.js`
- `frontend/src/pages/Settings/WebTracking.tsx`
- `frontend/src/services/trackingService.ts`
- `backend/test/publicTrackingCors.test.mjs`
- `backend/test/sitesVideoPlayer.test.mjs`
- `backend/test/sitesFormHeadersPixel.test.mjs`

## Resumen

El backend sirve un pixel JavaScript dinámico en `GET /snip.js`. Ese pixel envía eventos a `POST /collect` en el mismo host donde se cargó el script.

El host del script y del colector puede ser el mismo, pero el origen del
navegador es la página que ejecuta el pixel. Por ejemplo,
`https://www.ejemplo.com` hacia `https://track.ejemplo.com/collect` es
cross-origin. `publicTrackingRoutes` aplica CORS público específico, sin
credenciales y limitado a orígenes web `http(s)`, mientras la allowlist global
del dashboard sigue protegiendo las APIs privadas.

Cada evento recibido se inserta como una fila nueva en la tabla `sessions`. No es una tabla agregada por sesión: `session_start`, `page_view`, `session_end` y eventos custom pueden compartir `session_id`, pero cada evento tiene su propio `id`.

## Contrato Operativo Para Investigaciones Futuras

Esta sección es lectura obligatoria antes de optimizar, endurecer seguridad o
diagnosticar tracking. Aplica tanto a humanos como a agentes como Codex o Claude.
El objetivo es no confundir dos tuberías distintas ni convertir una revisión de
seguridad en un bloqueo de producción.

### Las Dos Tuberías De Tracking

| Superficie | Dónde se ejecuta | Cómo llega a Ristak | `tracking_source` esperado | Prueba válida |
| --- | --- | --- | --- | --- |
| Pixel externo | HighLevel, Squarespace, una tienda o cualquier página que cargue `snip.js` | La página llama al dominio de tracking; normalmente es cross-origin | `external_pixel` | Navegar la URL externa real y confirmar Network + DB |
| Site público de Ristak | Página publicada por Sites en un dominio público conectado | El renderer nativo usa `fetch('/collect')` en el mismo origen | `native_site` | Navegar la URL pública publicada y confirmar DB |
| Video dentro de Site público | Reproductor publicado de Sites | El runtime envía eventos a `/video-event` | `native_site_video` | Reproducir el video público y confirmar sus eventos |

Una página nativa de Sites ya incluye tracking propio cuando se publica. No se
debe insertar además `snip.js` por reflejo: hacerlo puede duplicar vistas y
mezclar `external_pixel` con `native_site` para la misma navegación.

### “Es El Mismo Dominio” No Significa “Es El Mismo Origen”

El navegador define un origen con tres piezas: protocolo, hostname y puerto.
Por eso estos dos URLs comparten dominio raíz, pero **no** origen:

- página: `https://www.ejemplo.com`
- colector: `https://track.ejemplo.com/collect`

`www` y `track` son hostnames diferentes. El navegador puede hacer un preflight
`OPTIONS` antes del `POST`; la respuesta debe incluir
`Access-Control-Allow-Origin` para el origen exacto de la página.

Cambiar DNS de Squarespace a Cloudflare no elimina ni crea esta regla. DNS sólo
decide a dónde resuelve un hostname. Cloudflare puede dejar al descubierto un
problema de enrutamiento, caché o headers, pero el CORS final sigue siendo un
contrato entre el navegador y la respuesta del servidor que recibe `/collect`.

### Incidente De Referencia: 15 De Julio De 2026

Superficie afectada:

- página externa: `https://www.raulgomez.com.mx/quiero-pacientes`
- colector: `https://track.raulgomez.com.mx/collect`

Síntoma real: el `OPTIONS /collect` respondía, pero sin
`Access-Control-Allow-Origin`; por eso el navegador cancelaba el `POST` y no
entraban eventos. El mensaje de consola decía que la solicitud había sido
bloqueada por CORS.

Causa raíz: las rutas públicas del pixel no aplicaban su propio CORS y quedaban
bajo el contrato de la allowlist privada del dashboard. El culpable técnico era
el backend de Ristak, no HighLevel, Cloudflare ni el navegador. El cambio de DNS
coincidió con el síntoma y ayudó a exponerlo, pero no justificaba abrir todas las
APIs privadas.

Solución: el commit `5825ffddf` agregó `publicTrackingCorsMiddleware`, limitado a
rutas públicas exactas y sin credenciales. Después del deploy se abrió la página
real con una marca única; la base pasó de cero coincidencias a tres eventos bajo
un solo `session_id`. Tres filas eran tres eventos de carga/recarga, no tres
sesiones distintas.

Mensajes como `ERR_BLOCKED_BY_CLIENT` para Facebook/DoubleClick, APIs deprecadas
de HighLevel, `MutationObserver` o avisos de Tracking Prevention pueden aparecer
al mismo tiempo, pero no prueban que `/collect` haya fallado. El veredicto se
toma con Network y la base de datos, no contando líneas rojas de la consola.

### Contrato De Sites Públicos

El tracking nativo de Sites sólo debe considerarse probado en vivo cuando:

1. existe un registro de dominio público verificado en `public_site_domains` o
   el dominio primario compatible en `app_config.sites_public_domain`;
2. el Site tiene `status = 'published'`;
3. la URL pública resuelve a la página correcta;
4. la navegación no usa un modo de preview o bypass de tracking.

El renderer público inyecta el runtime nativo con
`tracking_source = 'native_site'`, contexto del Site y de la página, cookies first-party
`ristak_vid`/`ristak_sid`, UTMs, click IDs y datos del navegador. La vista genera
`native_site_view` con `event_id` único; un retry conserva una sola fila por ese
ID. El lector sólo acepta `native_site_view`/`page_view` si la fila también
declara `tracking_source = 'native_site'`. Una conversión válida puede generar
`native_site_conversion`, pero sólo cuando el envío es final y no quedó
descalificado.

El payload público marca `formFinalSubmit = true` para el envío final de una
landing, formulario interactivo o última página de un formulario estándar, y
declara `formFinalMarkerVersion = 2`. Las landings históricas con formulario
embebido podían guardar `formFinalSubmit = false`; además, el runtime antiguo
podía emitir `native_site_conversion` después de un submit prematuro. Como
ninguna de esas dos señales prueba el final por separado, Analytics clasifica
los `false` afectados sin versión 2 como `legacy_unknown`, los excluye de
conversiones y reporta cobertura `partial`. Un checkpoint de formulario estándar
standalone también permanece parcial aunque exista un evento legacy. El runtime
actual impide que Enter o un submit implícito guarde/convierta antes del último
paso de formularios estándar, interactivos y embebidos. El índice versionado
`137*` acelera la reconciliación de cada conversión guardada con su envío sin
escanear todas las sesiones.

`native_site_conversion` está reservado al backend: se emite después de que
`/api/sites/public/submit` guarda un envío calificado. El endpoint público
`/collect` lo rechaza, aun si el cliente intenta declarar
`tracking_source = native_site`; así un tercero no puede fabricar la evidencia
de conversión usada por Analytics.

El instante canónico de un evento nativo usa `started_at`. El backend conserva el
timestamp original en `client_started_at`, pero si es inválido o difiere más de
cinco minutos de la recepción marca `timestamp_adjusted = 1` y usa la hora del
servidor. Esto evita que el reloj del dispositivo mueva tráfico a otro día sin
ocultar la evidencia original.

Analytics define visitante con `visitor_id` first-party y sesión como actividad
continua con no más de 30 minutos entre vistas. La sesión se reconstruye desde
los eventos del alcance; `session_id` sigue siendo una señal útil de ingesta e
identidad, pero no es por sí solo el contador canónico.
Una persona que convirtió sólo se atribuye por `visitor_id` o, si falta, por
`session_id` del evento de conversión. Un `contact_id` compartido no basta para
fusionar visitantes; la conversión queda como no atribuida si faltan ambas
señales web. La vista atribuida debe tener `started_at` anterior o igual al
instante de conversión; una vista futura no puede convertir a alguien de forma
retroactiva. Las consultas reciben ambos extremos como días reales
`YYYY-MM-DD`, en orden; cualquier rango incompleto o inválido responde `400` en
vez de quitar silenciosamente el filtro temporal.

El editor y las sesiones temporales de preview usan `trackingEnabled: false`.
También desactivan tracking los modos reservados como `no_track=1`,
`preview=1`, `editor_preview=1`, ciertos valores de `tracking`, las banderas de
preview y rutas de prueba. Esto es intencional: editar o previsualizar no debe
ensuciar Analytics ni mandar conversiones reales.

Por lo tanto:

- una captura del editor no prueba tracking;
- un preview sin filas nuevas es comportamiento correcto;
- no se debe quitar el bypass para “hacer que la prueba pase”;
- si no hay dominio público y Site publicado, la prueba end-to-end todavía no
  existe, aunque las pruebas automatizadas del renderer pasen;
- publicar un borrador o cambiar DNS requiere autorización explícita del dueño.

### Frontera De Seguridad

Las rutas del pixel son públicas porque un navegador anónimo debe poder cargar
el script y mandar una visita. Actualmente el CORS público:

- sólo se aplica a paths exactos como `/snip.js`, `/collect`, `/video-event`,
  `/sync-visitor` y `/link-visitor`;
- acepta orígenes web `http(s)` bien formados y requests sin `Origin` para
  clientes no navegador;
- permite `GET`, `HEAD`, `POST` y `OPTIONS`, y sólo el header `Content-Type`;
- usa `credentials: false`;
- conserva `Vary: Origin` y un preflight con cache máximo de 24 horas;
- no se hereda por `/sessions`, `/analytics`, `/config` ni otras APIs privadas.

Las APIs privadas siguen exigiendo autenticación, módulo y licencia. Nunca se
debe resolver un problema del pixel con alguna de estas salidas rápidas:

- abrir `CORS_ALLOWED_ORIGINS` para todo el dashboard;
- activar credenciales en el CORS público;
- aplicar `Access-Control-Allow-Origin: *` a rutas privadas;
- agregar cada landing como secret de Render;
- desactivar CORS en el navegador;
- poner un secret compartido dentro de `snip.js` o del HTML público.

CORS **no es autenticación**. Un cliente no navegador puede llamar `/collect`
sin header `Origin`, y un origen permitido puede fabricar eventos. La protección
actual rechaza requests cuyo `Content-Length` declarado supera 50 KB, valida
campos obligatorios, verifica contra la DB cualquier `contact_id` recibido antes
de vincular identidad y mantiene las APIs de lectura/escritura privadas fuera
del CORS público. El límite de 50 KB no es un límite de stream independiente del
parser: una auditoría de abuso/DoS no debe presentarlo como protección completa.
Aun así, una auditoría de seguridad debe considerar spam o contaminación
analítica como riesgo de una ingesta pública.

Si en el futuro hace falta mayor integridad, un allowlist de `Origin` sólo reduce
ruido de navegadores; no detiene solicitudes server-to-server. Una solución
fuerte debe diseñar rate limiting, detección de abuso o tokens efímeros firmados
por servidor/relay first-party. Un token fijo incrustado en JavaScript público no
es un secret y no resuelve el problema.

### Reglas De Optimización

- `snip.js` puede cachearse como asset según su contrato actual; `/collect` y sus
  respuestas no deben meterse en una regla de caché de contenido.
- Si Cloudflare u otro CDN toca `OPTIONS`, debe preservar `Origin`,
  `Access-Control-Request-*`, `Access-Control-Allow-Origin` y `Vary: Origin`.
- No proxies el tracking hacia otro hostname sin volver a probar el origen real,
  el endpoint generado por `snip.js` y la DB destino.
- No confundas una mejora de privacidad o bloqueo de terceros con la eliminación
  del tracking first-party de Sites. Evalúa identidad, atribución y conversiones
  por separado.
- Una optimización que cambia cookies, storage, caché, headers, dominio público,
  renderer o rutas debe repetir las pruebas externa y nativa.
- No cuentes filas como sesiones. Los eventos se cuentan por `event_id`/fila y
  las sesiones se reconstruyen por identidad y brechas mayores a 30 minutos.
  `COUNT(DISTINCT session_id)` sólo sirve como diagnóstico del runtime.

### Prueba End-To-End Obligatoria

Una validación seria usa navegador real y base real. `curl` sirve para revisar
headers, pero no sustituye la ejecución del pixel, storage, cookies y
navegación del browser.

1. Elige la superficie exacta: landing externa o Site público publicado.
2. Agrega una marca única inocua a la URL, por ejemplo
   `codex_tracking_test=20260715T0715Z_external`.
3. Confirma en la DB que la marca todavía tiene cero filas.
4. Abre la URL pública real en un navegador normal. No uses editor ni preview.
5. En Network filtra `collect`.
   - Pixel externo: `OPTIONS` debe responder `204` con
     `Access-Control-Allow-Origin` igual al origen de la página y el `POST` debe
     responder `200`.
   - Site nativo: el `POST /collect` suele ser same-origin; que no exista
     preflight es válido.
6. Consulta la DB y conserva `id`, `event_id`, `session_id`, `event_name`,
   `tracking_source`, contexto de Site/página, `page_url`, `started_at`,
   `client_started_at` y `timestamp_adjusted`.
7. Reporta por separado cantidad de eventos y sesiones canónicas; si la consulta
   manual sólo cuenta `session_id`, etiquétala como diagnóstico, no como KPI.
8. Guarda una captura de la página real y, cuando sea posible, evidencia de
   Network o del resultado exacto de DB sin exponer credenciales.

Consulta de comprobación, reemplazando `<MARCA_UNICA>`:

```sql
SELECT
  id,
  event_id,
  session_id,
  event_name,
  tracking_source,
  site_id,
  public_page_id,
  page_url,
  started_at,
  client_started_at,
  timestamp_adjusted
FROM sessions
WHERE page_url LIKE '%<MARCA_UNICA>%'
ORDER BY started_at DESC;
```

Conteo de ingesta para la marca (no sustituye la sesión canónica por inactividad):

```sql
SELECT
  COUNT(*) AS accepted_event_rows,
  COUNT(DISTINCT event_id) AS idempotent_events,
  COUNT(DISTINCT visitor_id) AS visitors,
  COUNT(DISTINCT session_id) AS runtime_session_ids
FROM sessions
WHERE page_url LIKE '%<MARCA_UNICA>%';
```

`started_at` se guarda como instante de base de datos. Para comunicar una hora
de negocio, conviértela con el timezone configurado y declara cuál se usó; no
deduzcas la fecha por el reloj o timezone del navegador.

### Contrato De Analíticas De Video

Los eventos publicados de video usan `tracking_source = native_site_video` y
`/video-event`. La fuente analítica es `video_playback_events`; la tabla
`video_playback_sessions` es una proyección para Journey/identidad y no debe
usarse para recomponer métricas históricas.

En ingesta v2 son obligatorios `event_id`, `event_sequence` monotónica por
`playback_id`, versión y hash de payload. El ledger se inserta antes de mutar la
proyección. Un retry idéntico responde como deduplicado sin volver a sumar; el
mismo ID o secuencia con otro payload se rechaza. El reproductor acumula
`watched_delta_seconds` entre heartbeats y vacía el acumulado al pausar, buscar,
terminar o salir. Saltar con seek no cuenta el tramo saltado como tiempo visto.
Las migraciones versionadas `136*` agregan estos campos e índices a instalaciones
existentes antes de que el backend quede listo; un esquema parcial detiene el
arranque en vez de perder o duplicar eventos silenciosamente. En PostgreSQL cada
índice se construye concurrentemente y por separado; el cierre valida su tabla,
método B-tree, columnas, unicidad y predicado, no sólo el nombre.

Las definiciones canónicas son:

- carga: primer `video_ready` de un playback;
- reproducción iniciada: primer `video_play`; reanudar no suma otra;
- tiempo visto: suma de deltas aceptados por `event_at`;
- completada: existe `video_ended`; llegar o buscar hasta 99% no completa;
- alcance: máximo playhead alcanzado, presentado como **Curva de alcance**, no
  retención;
- heatmap de intervalos: no disponible mientras no exista telemetría suficiente.

El histórico previo a v2 puede sumar retries dos veces en la proyección y, al
mismo tiempo, perder segundos o eventos repetidos en el ledger. No se debe
backfillear una fuente desde la otra. La respuesta declara `quality` como
`verified`, `mixed_legacy`, `legacy_only` o `empty`; cualquier valor legacy debe
mostrarse con advertencia. Bunny u otro proveedor puede aparecer como comparación
separada, nunca como fallback de la medición first-party. El detalle de un asset
acepta `siteId`: si se eligió un origen exacto, todas sus métricas y espectadores
quedan limitados a ese sitio aunque el mismo video exista en otros.

### Matriz Rápida De Diagnóstico

| Síntoma | Lectura correcta | Qué verificar |
| --- | --- | --- |
| `OPTIONS` responde pero falta `Access-Control-Allow-Origin` | CORS público roto o interceptado | Middleware, CDN/proxy y `Vary: Origin` |
| `POST /collect` da `200`, pero la DB consultada no tiene filas | Posible DB/servicio equivocado, bypass o query incorrecta | Host destino, deployment, `no_track`, marker y base de esa instalación |
| Preview de Sites no genera eventos | Esperado | Publicar y probar la URL pública real |
| Varias filas comparten `session_id` | Son eventos de una sesión | Contar distintos `session_id` |
| `ERR_BLOCKED_BY_CLIENT` en Meta/Google | Bloqueador o Tracking Prevention de tercero | Revisar `/collect` por separado |
| `ERR_NAME_NOT_RESOLVED` | DNS del hostname exacto | CNAME, Render custom domain y propagación |
| La tabla Analytics falla, pero hay filas en DB | Problema del endpoint/UI de lectura, no necesariamente de ingesta | Separar `/collect` de `/api/tracking/analytics/*` |
| Site público devuelve 404 | Dominio no conectado, Site en draft o ruta no publicada | `public_site_domains`, status y resolución de página |

### Pruebas Que Deben Correr Después De Cambios

```bash
cd backend
node --test --test-concurrency=1 test/publicTrackingCors.test.mjs
node --test --test-concurrency=1 test/sitesVideoPlayer.test.mjs test/sitesFormHeadersPixel.test.mjs
```

Las pruebas automatizadas protegen el contrato de CORS, el aislamiento de rutas
privadas, la diferencia preview/publicado, cookies first-party y tracking Meta de
Sites. No reemplazan la prueba end-to-end cuando cambia DNS, Cloudflare, Render,
el dominio público o la instalación productiva.

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

El preflight `OPTIONS /collect` acepta el origen web externo y responde `204`
con `Access-Control-Allow-Origin`. Este contrato no depende de `APP_URL`,
`RENDER_EXTERNAL_URL` ni `CORS_ALLOWED_ORIGINS`; esas variables controlan la
superficie privada de la aplicación, no el transporte público del pixel.

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

### `GET /api/tracking/sessions` (legacy/compatibilidad)

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

Con `start` y `end`, el endpoint legacy puede devolver un array directo para
clientes anteriores:

```bash
curl 'http://localhost:3001/api/tracking/sessions?start=2026-05-01&end=2026-05-28'
```

La pagina Analytics ya no usa esta variante porque su payload crece con cada
evento. Ninguna superficie nueva debe usarla para descargar un rango completo.

El rango se resuelve con el timezone configurado en Ristak. Si HighLevel está conectado y no hay timezone propio, se usa como fallback de compatibilidad mediante `resolveDateRangeWithGHLTimezone()`.

### `POST /api/tracking/analytics/summary`

Contrato agregado y acotado para la pagina Analytics. Body:

La lectura privada de analítica web requiere simultáneamente la feature
`web_analytics` y un plan Profesional (`professional`/`pro`; `premium` como alias
superior). Los planes `basic` y `medium` reciben `403 feature_not_available` y
sus interfaces no deben solicitar ni mostrar estos datos.

```json
{
  "start": "2026-05-01",
  "end": "2026-05-28",
  "groupBy": "day",
  "filters": { "device_type": ["mobile"] },
  "includeFacets": false
}
```

La respuesta usa `{ "success": true, "data": ... }` y contiene:

- rango actual/anterior y timezone aplicado;
- metricas, periodo anterior y tendencias;
- `trafficSeries` y `conversionSeries`;
- distribuciones top y facets acotadas.

No incluye eventos crudos. `groupBy` acepta `day`, `month` o `year`; si el rango
generaria mas de 400 puntos, el backend sube automaticamente la granularidad.
Cada facet devuelve como maximo 25 opciones. Los filtros desconocidos o valores
fuera de los limites se rechazan en vez de interpolarse en SQL.

El contrato de apertura de la web manda `includeFacets=false`. Esa variante
lee sesiones/visitantes desde el read model `113*` y conversiones desde `116*`;
no vuelve a agregar `sessions`, `contacts`, `payments` ni `appointments`. Si
alguna proyeccion todavia no esta disponible o no coincide con el timezone de la
cuenta, responde `503` con
`tracking_analytics_projection_warming` o
`tracking_conversion_projection_warming` y `Retry-After: 2`. El navegador
reintenta un maximo de tres intentos, respeta cancelacion y nunca reintenta por
`busy` o `deadline`.

Excepcion de privacidad: si existen reglas activas en
`hidden_contact_filters`, la proyeccion agregada no tiene identidad suficiente
para restar de forma retroactiva a una persona que acaba de ocultarse. En ese
caso el summary usa la consulta acotada sobre datos fuente con la exclusion
aplicada antes de agregar. La firma de las reglas forma parte del cache y
agregar/eliminar una regla invalida el snapshot. Es preferible pagar ese costo
solo en cuentas con ocultamiento a devolver una metrica contaminada.

La generacion 4 de `113*` conserva por separado la categoria normalizada de
fuente (`traffic_source`, usada por Origin) y el valor compatible con el filtro
historico (`source_filter_value`). Asi aliases como `newsletter` o `fb` siguen
filtrando exactamente las sesiones que anunciaron las facetas, sin ampliar el
resultado a toda la categoria Email/Facebook. Tambien distingue
`contact_id IS NULL` de `contact_id = ''`: NULL nunca suma un contacto
identificado y el string vacio conserva la semantica legacy de contar una vez.
La misma distincion aplica a `session_id`: NULL no suma una sesion unica y el
string vacio legacy cuenta una vez.
La migracion `120*` separa tambien la autoridad de cada binario. PostgreSQL
espera el mismo advisory lock global de los workers y ambos dialectos renombran
el state durable a `tracking_analytics_projection_state_v4`; el nombre v3 queda
como una vista vacia. Una instancia vieja obtiene cero filas y sale antes de
borrar datos, mientras solo el worker v4 ejecuta una vez el reset y el rebuild
reanudable. La migracion no borra el read model. Mientras v4 no converge, la
lectura responde warming y nunca mezcla generaciones ni vuelve a tablas crudas.
El reader global conserva los 400 periodos y los divide en lotes de hasta 900
parametros para funcionar tambien con el limite clasico de SQLite. El indice de
cobertura por `start_boundary + occurrence_date` evita recorrer completo
`tracking_analytics_range_delta`; en PostgreSQL se crea concurrentemente desde
una migracion aislada.

Deuda explicita: `includeFacets=true` conserva temporalmente el contrato legacy
que calcula el resumen junto con todas las facetas. No debe describirse como
raw-free ni usarse para la apertura de Analytics. Las facetas visibles se piden
de una en una por `POST /api/tracking/analytics/facets`; eliminar el camino
legacy requiere una migracion separada con paridad completa de todas las
dimensiones.

### `POST /api/tracking/sessions/search`

Tabla paginada de eventos. Body:

```json
{
  "start": "2026-05-01",
  "end": "2026-05-28",
  "filters": {},
  "q": "campana primavera",
  "column": "utm_campaign",
  "cursor": null,
  "limit": 50
}
```

Devuelve `items`, `limit`, `hasMore` y `nextCursor`. El limite se normaliza entre
20 y 100. El cursor es opaco y pagina por `started_at + id`; el endpoint no hace
`COUNT(*)` ni entrega columnas pesadas que la tabla no muestra. Para editar una
fila, la interfaz hidrata el registro completo con `GET /sessions/:id`.
Las reglas de contactos ocultos se aplican antes de paginar y su firma forma
parte del cursor. Se excluyen tanto filas enlazadas por `contact_id` como
historial anonimo que comparta `visitor_id` o `session_id` con una persona
oculta; esas filas tampoco consumen lugares de la pagina.

### `GET /api/tracking/sessions/:id`

Busca por la columna primaria `sessions.id`, no por `session_id`.
Si la fila pertenece o puede vincularse a un contacto oculto, responde `404` y
no permite leerla ni modificarla por ID directo.

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
- `POST /api/tracking/domain/verify`
- `POST /api/tracking/configure`
- `POST /api/tracking/analytics-preference`
- `POST /api/tracking/visitor-source-preference`
- `GET /api/tracking/visitors-by-ad`
- `GET /api/tracking/visitors-by-period`
- `GET /api/tracking/visitors`
- `GET /api/tracking/contacts-by-date`

`domain/verify` recibe `{ "domain": "track.tudominio.com" }`, comprueba que
`/health` responde con la identidad de esta instalación y sólo entonces guarda el
dominio como activo. Usa el mismo contrato de verificación que Configuración ->
Dominios: no basta con que el DNS resuelva o que responda cualquier Ristak; debe
llegar al servicio instalado correcto.

La fuente de verdad vive en `app_config`:

- `tracking_domain`
- `tracking_domain_verified`
- `tracking_domain_checked_at`
- `tracking_domain_error`

`GET /api/tracking/config` sólo entrega `trackingSnippet` cuando ese estado está
verificado. Ya no toma el hostname del navegador ni exige abrir el dashboard
desde el CNAME. Si se intenta cambiar a un dominio nuevo que todavía falla, se
conserva el dominio verificado anterior; si falla la revalidación del dominio
activo, se deshabilita el snippet hasta que vuelva a responder.

`configure` crea o actualiza el custom value `rstktrack` en HighLevel usando
exclusivamente el dominio verificado. El estado `isConfigured` sólo es verdadero
si el custom value apunta al dominio activo, no por encontrar cualquier script
viejo. Si hay Meta Pixel y la preferencia `include_meta_pixel` está activa, el
snippet también incluye Meta Pixel.

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
declarar la conversion en el `<form>` final o en el boton submit. Este ejemplo
es para una cita externa autogestionada, no para un calendario custom conectado
a Ristak:

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

### Submitted vs Qualified En Formularios HTML

Un submit guardado no siempre es una conversion calificada. Cuando radio,
checkbox o select puedan descartar candidatos, el formulario debe declarar
`data-rstk-conversion-condition="qualified_only"` y la opcion descartada debe
usar `action="disqualify"`:

```html
<form
  data-rstk-form-id="aplicacion"
  data-rstk-conversion-event="Lead"
  data-rstk-conversion-type="form_submit"
  data-rstk-conversion-condition="qualified_only">
  <label>
    <input
      type="radio"
      name="candidato"
      value="no"
      data-rstk-choice-actions='[{"id":"no-califica","action":"disqualify","disqualifyOutcome":"specific_page","buttonPageId":"no-califica"}]'>
    No cumplo los requisitos
  </label>
  <button type="submit">Enviar</button>
</form>
```

`disqualifyOutcome` acepta `message` + `buttonMessage`, `specific_page` +
`buttonPageId`, o `url` + `buttonUrl`. El backend guarda la submission y el
contacto con estado `disqualified`, pero omite tanto CAPI como el Pixel del
navegador. En HTML importado, el editor no expone un selector `SUBMITTED` frente
a `QUALIFIED`: muestra `Enviar cuando · Formulario enviado` como texto fijo y
deja que el contrato del propio HTML decida la calificacion. Sin
`data-rstk-conversion-condition`, el evento aplica a todo envio; con
`data-rstk-conversion-condition="qualified_only"`, solo aplica a quien no fue
descalificado. El selector `Evento al terminar` permanece disponible, incluida
la opcion `Sin evento (solo PageView)`. Un HTML importado no debe llamar `fbq`,
`gtag` o `dataLayer` por su cuenta: Ristak dispara la conversion despues de
conocer el veredicto.

En formularios nativos embebidos, las pantallas de resultado calificado y
descalificado son terminales: ocultan campos y controles de navegacion. Si un
video habia revelado el boton de envio mediante `reveal_form_action`, su estado
persistido o un evento tardio del reproductor no puede volver a mostrar
`Enviar`/`Anterior` encima del resultado.

### Elementos Nativos Ristak En HTML Importado

Cuando el HTML externo quiere usar la misma configuracion nativa del editor de
Sites, debe declarar una zona con `data-rstk-native-element` y
`data-rstk-native-id`. El editor solo reconoce `form`, `calendar`, `payment` y
`video` y `social-profile`.

```html
<div data-rstk-native-element="form" data-rstk-native-id="lead-form-slot"></div>
<div data-rstk-native-element="calendar" data-rstk-native-id="agenda-slot" data-rstk-native-render="ristak"></div>
<div data-rstk-native-element="payment" data-rstk-native-id="checkout-principal"></div>
<div data-rstk-native-element="video" data-rstk-native-id="video-principal" data-rstk-native-render="ristak"></div>
<section data-rstk-native-element="video" data-rstk-native-id="video-custom" data-rstk-native-render="custom">
  <video data-rstk-video-media playsinline></video>
  <button type="button" data-rstk-video-command="toggle">Reproducir / pausar</button>
</section>
```

Ristak guarda cada zona como bloque real del sitio importado:

- `form`: se conecta a un formulario existente de Ristak. La zona debe ser un
  contenedor vacio; no debe traer `<form>`, campos ni botones de envio propios,
  porque el formulario embebido ya renderiza su boton y acciones desde Ristak.
- `calendar`: se conecta a cualquier calendario disponible y respeta su
  configuracion de disponibilidad, campos, pagos, completado y Meta.
- `payment`: usa el mismo `PaymentGateControls` del editor; el evento `Purchase`
  sale del cobro confirmado, no del click.
- `video` con `data-rstk-native-render="ristak"`: usa el mismo bloque de video
  del editor: subida/URL, controles,
  diseno, acciones por tiempo, formularios dentro del video y eventos Meta/CAPI
  configurados. En publicado conserva el reproductor personalizable de Ristak y
  manda los eventos first-party a `/video-event`; cuando existe una playlist HLS
  validada la usa dentro del player de Ristak en publicado.
  **Resolución inteligente** viene activa y deja que Bunny elija la variante
  adecuada para la conexión; al apagarla el player prioriza la variante más alta.
  Editor/preview prefieren el MP4 de Bunny Storage cuando existe y mantienen
  tracking apagado. En publicado, ese MP4 también queda conectado como
  recuperación automática si HLS falla; el cambio de fuente ocurre en el mismo
  `<video>` y no crea otra sesión ni eventos duplicados.
  Este modo nunca sustituye el player nativo por el iframe visual de Bunny Stream.
  `videoMobilePortraitCrop` viene activo en el editor visual y en el editor HTML:
  para un video horizontal, únicamente cambia el frame móvil a 9:16 y aplica un
  recorte centrado, sin transformar ni duplicar el asset. Por ello no crea otro
  reproductor, sesión ni fuente de eventos; tracking y acciones siguen leyendo
  el mismo elemento de video.
- `video` con `data-rstk-native-render="custom"`: el HTML/CSS conserva todo el
  frame, controles, overlays, contadores y animaciones; Ristak solo conecta al
  `<video data-rstk-video-media>` la fuente MP4/HLS elegida en Media/Bunny y el
  runtime first-party. Puede no existir botón de play, usar controles nativos o
  declarar comandos `play|pause|toggle|mute|unmute|toggle-mute|restart|fullscreen`,
  progreso y contadores propios. Publicado sigue enviando `/video-event`,
  acciones, gates y Meta/CAPI con los IDs del mismo asset/Stream, sin iframe de
  Bunny ni un segundo reproductor. Preview/editor conserva tracking apagado,
  pero sí carga y reproduce el medio para comprobar loop, controles y
  animaciones antes de publicar. Al mover el inicio o el final del loop, el
  reproductor del canvas y el iframe del editor HTML saltan en ese mismo cambio
  al nuevo inicio para mostrar el tramo actualizado sin esperar al autosave; esta
  reproducción sigue siendo de editor y no habilita tracking. El teaser inicial
  espera a que exista un cuadro reproducible, nace silenciado y regresa
  continuamente de `videoPreviewEnd` a `videoPreviewStart` en editor, URL de
  preview y publicado. Mientras corre conserva
  `data-rstk-video-previewing="true"`, la interfaz inicial —incluido el botón de
  play cuando el HTML decidió mostrarlo— y el estado público `idle`; no asigna
  `data-rstk-video-real-played` ni continúa con el video completo. Sólo un click
  o comando explícito cambia a reproducción real. Los reintentos por cambios de
  fuente son acotados y los listeners de media no interpretan el objeto del
  evento como una orden de reiniciar el rango.
  El sanitizador sigue eliminando scripts inline, handlers `on*`, `src` físicos
  del autor y cualquier llave de Bunny; esos datos nunca forman parte del HTML.

Para bloquear contenido por reproducción sin escribir JavaScript, el slot
`video` puede declarar:

```html
<div
  data-rstk-native-element="video"
  data-rstk-native-id="video-principal"
  data-rstk-video-gate-id="agenda-admision"
  data-rstk-video-gate-trigger="playback_seconds"
  data-rstk-video-gate-value="30">
</div>

<section data-rstk-video-gate-shell="agenda-admision">
  <section
    data-rstk-native-element="calendar"
    data-rstk-native-id="agenda-real"
    data-rstk-native-render="custom"
    data-rstk-video-gate-content="agenda-admision"
    data-rstk-video-gate-locked-mode="blur">
  </section>

  <section data-rstk-video-gate-locked="agenda-admision">
    Faltan <strong data-rstk-video-gate-remaining="agenda-admision">30</strong>
    segundos.
  </section>
</section>
```

Con `data-rstk-video-gate-locked-mode="blur"`, Ristak mantiene visible el
calendario real pero lo vuelve `inert`, le aplica blur y posiciona la capa
`data-rstk-video-gate-locked` encima del mismo
`data-rstk-video-gate-shell`. No existe un calendario falso seguido de otro
calendario real. El modo sin `locked-mode` conserva el comportamiento compatible
que oculta el contenido. En ambos casos el restante sale del progreso real del
reproductor y el contenido se habilita al cumplir el umbral.
En calendarios compuestos, el estado bloqueado muestra simultáneamente los pasos
`date` y `time`: Ristak toma el primer día disponible del mes y pinta sus horarios
reales detrás del blur. Las preguntas y datos de contacto siguen ocultos. Al
desbloquear, esa preselección se limpia y el flujo vuelve a `date` para que el
visitante elija su propia fecha.
`playback_seconds` no acredita adelantos ni buffering;
`unique_watched_percent` mide fragmentos distintos vistos y
`timeline_reached` sí permite seek. Dos videos responsive pueden compartir el
mismo gate; se usa su mayor progreso individual, no la suma. El HTML puede
ajustar el efecto con `--rstk-video-gate-blur` y
`--rstk-video-gate-locked-opacity`.

Una VSL puede conservar el avance real del gate sin JavaScript propio:

```html
<div
  data-rstk-native-element="video"
  data-rstk-native-id="vsl-desktop"
  data-rstk-video-gate-id="admision"
  data-rstk-video-gate-trigger="unique_watched_percent"
  data-rstk-video-gate-value="91.3424"
  data-rstk-video-gate-persist="visitor"
  data-rstk-video-gate-resume="true"
  data-rstk-video-gate-seek-policy="watched_only"
  data-rstk-video-gate-progress-key="vsl-admision-v1">
</div>
```

`visitor` guarda en `localStorage` la posición normalizada, el tiempo reproducido
y la unión de fragmentos vistos durante 30 días; `session` usa
`sessionStorage`, y `none` no persiste. El TTL opcional se declara con
`data-rstk-video-gate-progress-ttl` en segundos. Las variantes desktop/mobile
comparten avance cuando usan la misma `progress-key`, incluso si sus duraciones
exactas difieren. Esa key debe versionarse al reemplazar el contenido para no
heredar progreso de otra VSL.

Ristak agrega automáticamente el ID estable del sitio y de la página a la clave
de almacenamiento. Por eso una vista previa nueva conserva el mismo avance sin
depender del token temporal de su URL, y dos páginas distintas no contaminan su
progreso aunque reutilicen la misma `progress-key`.

Con `resume="true"`, el primer play de una visita posterior arranca en el punto
guardado. `seek-policy="watched_only"` permite retroceder y volver hasta el
frente ya visto, pero bloquea adelantos. Al combinarlo con
`unique_watched_percent`, repetir un tramo anterior no reduce el restante: el
contador sólo avanza al cubrir fragmentos nuevos. El valor
`data-rstk-video-gate-remaining-time` convierte el porcentaje faltante a tiempo
real usando la duración del video activo, por lo que conserva una lectura
`MM:SS` aun cuando el gate mida cobertura única.

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

El `<form data-rstk-calendar-book-form>` de ese frontend es parte del calendario,
no un formulario HTML independiente. El importador, el Panel de contenido, la
pestaña Meta y el runtime de submits genéricos deben excluirlo, incluso si un
sitio anterior conserva `data-rstk-form-id` o `data-rstk-field-id`. Por lo tanto,
una reserva no genera además el evento del formulario genérico: únicamente
genera el evento configurado para el elemento calendario después de que el
backend confirma la cita. Ese evento puede ser `Schedule`, `Lead`, otro permitido
o ninguno; el tipo `calendar` determina cuándo se dispara y el selector de
Ajustes determina qué nombre recibe. Entrar a la página, escoger fecha u horario
y abrir el paso de datos no son conversiones.

La clasificación tampoco depende del orden visual. Si preguntas, contacto,
fecha y horario comparten un único submit que crea la cita, el recorrido completo
es un solo elemento `calendar`, ya sea preguntas → fecha, fecha → preguntas o
cualquier orden declarativo válido. Para ello el único
`data-rstk-calendar-book-form` envuelve los pasos
`data-rstk-calendar-flow-step`, tipados con
`data-rstk-calendar-flow-kind="questions|date|time|confirm|success"`. Solo si
existe otro submit que guarda el formulario como operación independiente se
detectan dos elementos (`form` + `calendar`) y cada uno obtiene su propio
disparador configurable.

El preview consulta disponibilidad real, pero es deliberadamente inerte para
escrituras y tracking: confirmar ahí no crea la cita, no redirige y no manda
Pixel/CAPI. La validación de `Schedule` debe hacerse en una URL pública publicada
y completando una reserva real.

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

Usa un dominio o CNAME que llegue al mismo servicio donde vive Ristak. Después
de darlo de alta en Render, entra a **Configuración ->
Rastreo Web**, escríbelo en **Dominio personalizado** y presiona **Validar y
guardar**. El pixel aparece en esa misma pantalla en cuanto Ristak confirma que
el dominio ya responde con la identidad de esta instalación; no necesitas abrir
el dashboard desde ese dominio.

Ejemplo:

```html
<script async src="https://collect.tudominio.com/snip.js"></script>
```

Si el sitio es HighLevel, puedes guardar el snippet con **Configuración -> Rastreo Web -> Sincronizar** y luego usar el custom value `rstktrack`.

El sitio que ejecuta el pixel y el subdominio de tracking normalmente son
orígenes diferentes. Las rutas públicas de tracking resuelven ese cruce con
CORS propio; nunca abras por reflejo el CORS privado de toda la app ni agregues
dominios de páginas como secrets de Render.

## Notas De Seguridad Y Privacidad

- Captura IP, user-agent, cookies de Facebook y datos de navegación.
- Debe existir aviso de privacidad adecuado para la jurisdicción del negocio.
- `ip-api.com` se usa para geolocalización básica de IPs públicas.
- No hay `tenant_id`; la app es single-tenant por instancia/base de datos.
