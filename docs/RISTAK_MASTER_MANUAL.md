# Manual maestro de Ristak

Ultima consolidacion: 2026-07-23.

Este manual junta el funcionamiento general de Ristak en una sola ruta legible.
Los documentos especializados siguen existiendo cuando tienen reglas obligatorias
o pasos operativos detallados. Si hay conflicto, mandan los documentos de control:

- `docs/DATE_TIME_GUIDELINES.md`
- `docs/DESIGN_SYSTEM.md`
- `docs/INTEGRATION_CRON_RULES.md`
- `AGENTS.md`

## Que es Ristak

Ristak es una plataforma CRM/operativa para negocios que venden, atienden,
conversan y miden resultados desde un solo sistema. Su centro es el contacto: de
ahi cuelgan conversaciones, citas, pagos, etiquetas, tracking, fuentes, anuncios,
automatizaciones y reportes.

El producto combina:

- CRM y contactos.
- Chat y mensajeria.
- Citas y calendarios.
- Pagos, planes, suscripciones y productos.
- Sites, formularios, dominios y checkout publico.
- Tracking pixel, sesiones, atribucion y conversiones.
- Meta Ads, WhatsApp, HighLevel, Google Calendar, email y pasarelas de pago.
- Automatizaciones visuales.
- Agentes IA.
- App movil nativa.
- API externa, OAuth/MCP y licenciamiento central.

## Stack y comandos

| Capa | Stack |
| --- | --- |
| Frontend desktop/movil web | React 19, TypeScript, Vite |
| Backend | Node.js ESM, Express |
| Base de datos local | SQLite |
| Base de datos produccion | PostgreSQL en Render cuando existe `DATABASE_URL` |
| Movil | `/movil` web/PWA; React Native/Expo Android en `mobile/`; SwiftUI Apple en `ios/app` |
| Deploy | Render Blueprint / web service |
| Pagos | Stripe, Conekta, Mercado Pago, CLIP, Rebill, HighLevel invoices |
| IA | OpenAI Agents / providers configurables |

Comandos principales:

- Frontend: `cd frontend && npm run typecheck`, `npm run design:audit`, `npm run build`.
- Backend: `cd backend && npm test`.
- Mobile Android React Native: `npm run mobile:native:typecheck`, `npm run mobile:native:start`, `npm run mobile:native:android`.
- Raiz: `npm run build`, `npm start`.
- Docs: `git diff --check` para validar whitespace basico.

## Estructura del repo

- `backend/src/server.js`: entrada del backend, middlewares, rutas, health,
  startup runtime, crons y servidor de frontend en produccion.
- `backend/src/routes/`: rutas HTTP agrupadas por dominio.
- `backend/src/controllers/`: controladores con validacion HTTP y respuesta.
- `mobile/`: app React Native/Expo para Android y dispositivos Google. Convive
  con `/movil` y debe mantenerse sincronizada con cualquier cambio de producto
  movil que tambien afecte al shell web publicado.
- `ios/app/`: app nativa Apple en SwiftUI para iPhone y iPad. Es la unica ruta
  propietaria de codigo nativo Apple.
- `backend/src/services/`: logica de negocio, integraciones y persistencia.
- `backend/src/jobs/`: crons, watchdogs y runtime de jobs.
- `backend/src/config/database.js`: conexion SQLite/Postgres, tablas base,
  migraciones idempotentes y helpers de `app_config`.
- `backend/migrations/versioned/`: migraciones versionadas.
- `frontend/src/App.tsx`: router principal, providers y shells.
- `frontend/src/pages/`: pantallas desktop, movil y publicas.
- `frontend/src/services/`: cliente API por dominio.
- `frontend/src/components/common/`: componentes reutilizables del sistema visual.
- `frontend/src/styles/index.css`: tokens globales.
- `docs/`: documentacion canonica.

## Runtime backend

El backend arranca desde `backend/src/server.js`.

Flujo de arranque:

1. Inicializa timezone de proceso en UTC.
2. Configura CORS, parsing JSON y `rawBody` para firmas de webhooks.
3. Expone health checks en `/api/health` y `/health`.
4. Aplica compuerta de readiness: mientras el runtime no esta listo, rutas API
   no publicas pueden responder 503.
5. Monta rutas publicas y privadas.
6. En produccion sirve `frontend/dist`.
7. Ejecuta `startRuntimeServices()`:
   - espera sólo el esquema indispensable de la base,
   - corre migraciones,
   - inicializa llave de cifrado,
   - sanea usuarios legacy que guardaban el correo en `username`,
   - asegura usuario inicial/default,
   - sincroniza estado de licencia,
   - inicializa version Meta,
   - repara o verifica tareas pendientes de webhooks/pagos/templates/media,
   - arranca schedulers de sistema,
   - sincroniza crons registrados por integracion.

El esquema base de `database.js` usa un candado distribuido durante despliegues
rodantes: una sola instancia puede prepararlo y las demás esperan sin repetir
DDL. Cuando el bootstrap vigente ya quedó registrado en `app_config`, los
reinicios normales omiten el replay legacy de cientos de tablas e índices; los
cambios nuevos deben entrar por `backend/migrations/versioned/`. PostgreSQL usa
timeouts de mantenimiento únicamente en esa sesión y restaura los límites de la
cuenta antes de atender tráfico.

El bootstrap común no ejecuta DDL específico de otro motor. En particular, el
índice legacy `idx_campaign_contacts_cursor_created_at_id`, cuya expresión usa
`julianday()` y `INDEXED BY`, se crea sólo en SQLite. PostgreSQL usa sus índices
keyset versionados y una base vacía debe completar el arranque sin funciones de
compatibilidad inventadas ni parches manuales en la base.

Las migraciones versionadas PostgreSQL comparten otro advisory lock de sesión y
no envuelven `CREATE/DROP INDEX CONCURRENTLY` en transacciones. El tren `091*` a
`099*` y cualquier construcción concurrente tienen límites internos de 10
segundos para esperar un lock y 15 minutos por statement, con un máximo de tres
intentos únicamente para timeout, deadlock o serialización transitorios. Cada
intento restaura los timeouts de sesión. `schema_migrations` se escribe sólo
después de terminar el DDL; desde `091*` un `already exists` inesperado falla
cerrado y jamás maquilla un archivo parcial como aplicado. Si PostgreSQL dejó un
índice concurrente homónimo con `indisvalid=false` o `indisready=false` por una
cancelación o caída, el runner elimina sólo ese artifact con `DROP INDEX
CONCURRENTLY` y lo reconstruye antes de publicar el ledger. Al agotar los
intentos la instancia no pasa readiness y sale con error para que el deploy se
reintente; no sirve tráfico con un esquema ambiguo ni espera locks sin límite.

Los índices de expresión que ordenan timestamps deben funcionar tanto en bases
históricas convertidas a `TIMESTAMPTZ` como en bases nuevas con `TIMESTAMP`. No se
fuerza uno de esos dos tipos dentro de `COALESCE`: los cursores PostgreSQL
`094a/094b` usan un literal UTC sin tipo explícito y sus servicios de lectura
repiten la misma expresión. Esto evita casts dependientes de `TimeZone` que no son
`IMMUTABLE`, conserva el plan keyset y se prueba contra ambos esquemas PostgreSQL.

Las normalizaciones históricas no forman parte de la compuerta de login. Semillas
de teléfonos, contrato neutral de WhatsApp, identidades legacy, fusiones y
limpieza de etiquetas/campos corren bajo otro candado, en segundo plano y con
lotes acotados para las tablas grandes. Móvil y escritorio pueden usar de
inmediato los contactos y chats existentes; el mantenimiento es idempotente,
marca su versión al completar y se reintenta en un arranque posterior si falla.

El proceso tiene soporte de shutdown graceful y estado de drain para deploys.

## Rutas backend principales

Rutas protegidas por auth y/o feature flags:

- `/api/auth`: setup, login por correo, SSO, reset password, usuarios, perfil, API token.
- `/api/dashboard`: metricas principales.
- `/api/contacts`: contactos, chats, tags, custom fields, bulk actions.
- `/api/contact-tags`: etiquetas y carpetas.
- `/api/transactions`: pagos/transacciones.
- `/api/products`: productos y precios.
- `/api/subscriptions`: suscripciones.
- `/api/payment-events`: stream interno SSE para refrescar pantallas de pagos.
- `/api/stripe`, `/api/conekta`, `/api/mercadopago`, `/api/clip`, `/api/rebill`: pasarelas.
- `/api/highlevel`: conexion, sync, invoices, productos, calendarios y conversaciones.
- `/api/settings`: configuracion general de cuenta, incluidos zona horaria y nombres visibles del CRM.
- `/api/meta`: Meta Ads, pixel, CAPI, social messaging y campaign builder.
- `/api/automations`: carpetas, flujos, ejecuciones y assets.
- `/api/appointment-reminders`: recordatorios de citas.
- `/api/calendars`: calendarios locales/publicos/embebidos.
- `/api/sites`: Sites, paginas, dominios, formularios, pagos y media.
- `/api/tracking`: sesiones, visitantes, conversiones y config.
- `/api/reports`: reportes operativos/financieros.
- `/api/media`: uploads, library, Bunny Storage/Stream y cuotas.
- `/api/ai-agent`: asistente interno.
- `/api/conversational-agent`: agentes conversacionales.
- `/api/external`, `/api/mcp`: API externa y MCP.
- `/api/license`: estado de licencia local/central.
- `/api/mdp-program`: bridge con MDP.
- `/api/push`: web/mobile push.
- `/api/settings`, `/api/config`, `/api/user-config`: configuracion general.
- `/api/email`, `/api/whatsapp-api`: canales de comunicacion.

Rutas publicas o semi-publicas:

- `/pay/:publicPaymentId`: checkout publico en frontend.
- `/api/meta/pixel-test`: pagina de prueba Meta.
- `/api/meta/pixel-test/event`: CAPI test event.
- `/api/tracking`, `/snip.js`, `/collect`: tracking pixel.
- Rutas publicas de Sites, formularios, dominios y calendarios embebidos.
- `/webhook` y `/webhooks`: webhooks externos.

## Frontend

El router vive en `frontend/src/App.tsx`.

Providers globales:

- Theme.
- Timezone.
- Notifications.
- Labels.
- Auth.
- Date range.

El estado remoto compartido no debe duplicarse en componentes que solo consultan
una vez al montar. `frontend/src/services/integrationsService.ts` publica un
snapshot reactivo y `useIntegrationsStatus()` lo consume con
`useSyncExternalStore`: conectar, desconectar o cambiar Meta, WhatsApp,
HighLevel, Google Calendar, OpenAI o una pasarela revalida el snapshot y repinta
onboarding, permisos operativos y selectores dependientes sin recargar la ruta.
Las respuestas anteriores a una revalidacion mas nueva se descartan. Al cerrar
sesion se limpia tambien este snapshot para no heredar conexiones de otra sesion.
El shell escucha el evento local de una sincronizacion manual de HighLevel; su
sondeo de respaldo cada 30 segundos solo existe cuando coinciden licencia,
permiso `settings_integrations` y conexion local activa. Nunca solapa dos
requests, se cancela al desmontar y se apaga ante `401`, `403` o `404`. Una
cuenta desconectada o sin permiso no consulta `/api/highlevel/sync/progress`.

### Contrato transversal de rendimiento

La navegacion del CRM debe conservar el shell montado y cargar cada modulo por
separado. `frontend/src/routing/routeModules.tsx` es el registro canonico de
chunks para rutas desktop, moviles y publicas. El sidebar inicia la descarga al
detectar intencion real de navegar: el pointer exige 150 ms de permanencia y se
cancela al salir, mientras foco, touch y pointer-down son inmediatos. En Sites esa
precarga trae solamente la compuerta liviana de ruta; el workspace/editor pesado
se importa al entrar realmente a Sites y nunca durante el idle global. Configuracion hace lo
mismo con cada panel interno y navega directamente al primero permitido. Los
redirects de login/inicio precargan su destino, y el panel del asistente AI queda
en un chunk separado del shell. No se permite volver a importar todas las
paginas de forma estatica desde `App.tsx` ni bloquear el contenido completo con
un loader global mientras existan requests de una ruta. Las esperas inevitables
deben aparecer dentro de la zona que aun no tiene datos, conservando navegacion,
header y contenido anterior utilizable.

`frontend/src/services/authFetch.ts` se limita a autenticacion, telemetria de
actividad, bloqueo de licencia y notificacion de invalidaciones. No cachea,
materializa, clona ni deduplica `Response` de forma global: hacerlo para todas las
rutas retiene ramas de streams, duplica cuerpos grandes y mezcla el ciclo de vida
de modulos que no dependen entre si. Cada servicio que realmente se beneficia de
un snapshot —Dashboard, Analytics, Reportes, Publicidad, integraciones o
Automatizaciones— es owner de un cache acotado por principal, llave funcional,
TTL, revision y maximo de entradas. Tambien es owner de su single-flight y lo
cancela cuando se va el ultimo consumidor. Listas paginadas, binarios, streams y
fuentes vivas no se guardan como Responses globales.

La configuracion pequeña que consumen tablas y preferencias es la excepcion
especializada, no una vuelta al cache global. `appConfigService` reune en un
micro-batch las llaves distintas solicitadas durante el mismo montaje y hace un
solo `GET /api/config`; despues conserva cada llave —incluidas las ausentes—
durante 60 segundos en un LRU de 128 entradas aislado por cuenta. Theme,
preferencias del shell, tablas y modulos comparten ese mismo lector. Nunca
conserva `Response`, binarios ni cuerpos arbitrarios. Un POST confirmado o un
cambio de cuenta limpia el snapshot; un POST fallido conserva el valor anterior.
Una invalidacion suave separa lectores nuevos sin abortar a quienes ya esperan,
y una respuesta de la cuenta anterior nunca repuebla el cache vigente. La tabla
dueña debe montarse una sola vez durante la primera carga: Contactos empieza en
estado de carga real y no monta, desmonta y vuelve a montar
`table_contacts_v2`, mientras Transacciones y Reportes reutilizan las lecturas
concurrentes de moneda y configuracion de columnas. La lectura compartida tiene
un deadline de 20 segundos: un servidor o transporte colgado aborta el fetch
real, libera el single-flight y permite reintentar en vez de dejar consumidores
esperando indefinidamente.

La configuracion del asistente AI sigue el mismo principio especializado:
`aiAgentService` comparte un unico `GET /api/ai-agent/config` entre disponibilidad
y panel, con snapshot de 60 segundos por cuenta y deadline de 20 segundos. El
ultimo consumidor que abandona aborta el transporte. Un POST o DELETE fallido
conserva el ultimo estado confirmado; una mutacion exitosa publica su respuesta y
solo un DELETE confirmado vacia el snapshot. Timeouts y errores nunca se cachean.

Una mutacion exitosa notifica solamente los prefijos afectados; los POST que son
consultas declaradas, como los resumenes de Analytics, no cuentan como mutacion.
Los eventos SSE de Chat y Pagos invalidan antes de revalidar la pantalla, pero
solo despiertan las familias necesarias: Chat actualiza contactos, Dashboard,
Tracking y Reportes; Pagos actualiza transacciones, suscripciones, contactos,
Dashboard, Tracking y Reportes. Un evento vivo no debe enfriar Sites,
Configuracion ni otro modulo independiente. Los caches especializados declaran
sus prefijos y descartan respuestas de una revision anterior. Cambiar de cuenta
invalida todos y cancela las promesas de la cuenta anterior. Tema y disponibilidad
del agente AI esperan una sesion autenticada y el snapshot persistido de
integraciones nunca guarda el access token de HighLevel.

La invalidacion viva es suave: no aborta ni desacopla un agregado pesado que ya
esta en vuelo y conserva su snapshot especializado durante el TTL corto. Asi un
stream de mensajes, pagos o tracking no crea transportes competidores ni vuelve
a encender loaders con cada evento. La siguiente ventana de revalidacion obtiene
el estado nuevo; una mutacion explicita o un cambio de cuenta invalida de forma
dura, cancela el trabajo anterior y fuerza una lectura nueva. Marcar uno o varios
chats como leidos es una mutacion operacional de la bandeja y no invalida
Dashboard, Analytics ni Reportes. El clasificador reconoce tanto `calendar` como
`calendars`; ninguna variante puede dejar snapshots dependientes sin revision ni
reiniciar agregados ajenos con cada mensaje leido.

Las lecturas que controlan el estado `loading` de una vista deben tener un
presupuesto explicito —20 segundos en el frontend y menor en los endpoints
pesados— y propagar `AbortSignal` al fetch y a la consulta de base. Cambiar de
rango, pagina, contacto o ruta cancela la lectura anterior; un error o deadline
termina el loader con un estado reintentable y nunca con una promesa pendiente.

Los cambios automaticos de una cita (confirmar, cancelar, marcar asistencia o
procesar una respuesta afirmativa) publican `chat_data_changed` unicamente
despues de persistir la mutacion. El frontend invalida entonces Calendario,
Contactos, Dashboard y Reportes; no expulsa datos antes de tiempo ni obliga a
recargar toda la aplicacion.

En produccion el backend comprime JSON, JavaScript, CSS y SVG mayores a 1 KB sin
bufferizar SSE ni recomprimir binarios. Los assets Vite con hash se entregan con
cache inmutable de un ano; `index.html`, manifests y `sw.js` siempre revalidan.
El service worker usa cache-first solamente para assets versionados y
network-first para navegacion y archivos sin hash. Un cache lleno nunca debe
convertir una respuesta de red valida en error.

Reglas de datos para cualquier modulo nuevo o refactorizado:

- Una lista no descarga una tabla completa para paginar, buscar, ordenar o
  mostrar cinco filas. Debe pedir una pagina acotada al servidor.
- En tablas que crecen continuamente se prefiere cursor estable sobre
  `offset + COUNT(*)`. El cursor debe incluir un desempate unico y quedar ligado
  por hash al alcance efectivo (cuenta, rango, filtros, busqueda y orden) para
  que no pueda reutilizarse en otra consulta.
- La tupla del predicado keyset debe ser exactamente la misma del `ORDER BY`.
  En PostgreSQL, cualquier timestamp que viaje dentro del cursor se proyecta en
  una columna privada `::text`: `node-postgres` convierte timestamps a `Date` y
  perderia microsegundos. Esa columna nunca aparece en el DTO publico. Un cursor
  malformado o de otro alcance responde 400; no reinicia silenciosamente desde
  la primera pagina ni mezcla resultados. Los cursores legacy solo se aceptan
  durante la transicion y todos los cursores nuevos salen versionados.
- KPIs, graficas y facets se calculan en backend y viajan como agregados; no se
  reconstruyen recorriendo eventos crudos en el navegador.
- Un GET de pantalla no debe sincronizar Stripe, HighLevel, Google, Meta ni otro
  proveedor. Primero responde con el estado local; la sincronizacion externa es
  una accion/job independiente.
- Las respuestas viejas se cancelan o descartan por secuencia cuando cambia el
  rango, filtro, busqueda o ruta. El contenido anterior puede conservarse como
  snapshot mientras llega la revalidacion.
- En PostgreSQL, las lecturas que reciben `AbortSignal` cancelan el backend por
  PID mediante un pool reservado de dos conexiones. La orden de cancelacion se
  completa antes de devolver la conexion de trabajo al pool, para que saturar
  las conexiones normales no bloquee la cancelacion ni una carrera alcance la
  siguiente consulta que reutilice el mismo PID. La señal tambien cubre la espera
  de `pool.connect()` y los backoffs de reconexion: si una conexion llega despues
  del aborto se libera sin ejecutar SQL. SQLite aplica cancelacion cooperativa
  antes y despues de la operacion. Si el canal reservado no logra confirmar
  `pg_cancel_backend`, el cliente de trabajo se destruye y el pool lo reemplaza:
  la promesa original siempre termina y una falla del canal de cancelacion nunca
  deja un loader esperando al query huerfano. Resolver la zona horaria usa esa misma señal;
  una falla transitoria de DB no cachea el timezone default como configuracion
  real de la cuenta.
- Los rangos siguen `docs/DATE_TIME_GUIDELINES.md`: dias del negocio en su zona
  horaria e instantes persistidos/consultados en UTC.

Los backfills historicos de proyecciones no arrancan como promesas pesadas
independientes. `backend/src/jobs/backfillJobCoordinator.js` es la cola canonica
por proceso y `projectionBackfillScheduler.js` agrega un fence distribuido para
que un rolling deploy tampoco ejecute dos backfills pesados a la vez. Ambos
cubren tracking de visitantes, actividad de Chats, listas de
Contactos/Pagos, primer mensaje y metricas del Agente IA. La cola mantiene una sola
ejecucion intensiva por proceso, deduplica cada proyeccion mientras esta en cola
o corriendo, aplica prioridad a Chats y listas operativas, deja una cesion corta
entre jobs y envejece los pendientes para impedir starvation. Un error queda
aislado y no detiene el siguiente trabajo. La cola se agenda despues de las
migraciones y fuera de readiness; los advisory locks/estados durables de cada
worker siguen siendo la autoridad de su propia proyeccion. Los workers se
encienden solamente despues de publicar readiness, para que un primer backfill
de millones de filas no retrase el healthcheck ni la inicializacion critica. Un
scheduler de sistema revisa cada 30 segundos las filas singleton de Chats, primer
mensaje, metricas del Agente IA y visitantes; solo vuelve a encolar estados
`backfilling`, `dirty` o `failed` y nunca reencola un estado `ready`. Los read
models que admiten cobertura parcial lo declaran expresamente; visitantes no se
publica hasta ser exacto. Ningun GET reconstruye el historial dentro del request.
Los snapshots `100*` de Reportes y `101*` de Publicidad se hidratan bajo demanda y
no pertenecen a esta cola de backfill.

Las lecturas de readiness de listas CRM, origen de contactos, identidad de
personas y visitantes de Tracking son puras: nunca encolan ni arrancan un
backfill. Startup y el watchdog de sistema de 30 segundos son los unicos dueños
de agendar esos workers; `crm-list-projections` tambien esta registrado en ese
watchdog. Mientras un modelo calienta, cada superficie responde segun su
contrato: cobertura parcial explicita o `warming`/503 reintentable con
`Retry-After`, sin convertir la lectura en una orden de reconstruccion.

El estado local de WhatsApp que comparten Chats, Contactos y Configuracion no
ejecuta `COUNT(*)` ni `GROUP BY` sobre mensajes, contactos, eventos o ruteos al
abrir una pantalla. Las migraciones `102*` construyen doce contadores exactos
por shards y una proyeccion del ultimo evento de ruteo por contacto; triggers
transaccionales mantienen altas, bajas y cambios de direccion/estado. La lectura
agrega como maximo 12 x 64 filas y una fila por numero con restauraciones
pendientes, aunque el historial tenga millones de mensajes. El scan legacy
exacto existe solo para compatibilidad si una instancia recibe trafico antes de
aplicar `102*`; el arranque normal corre migraciones antes de readiness. El GET
de status tampoco limpia credenciales legacy ni repara sesiones QR: desconectar,
resetear y reparar siguen siendo comandos explicitos. El worker deja de consultar
y escribir cuando el singleton llega a `ready`; mientras converge usa reintentos
con backoff en lugar de polling fijo. Un lote que si progreso vuelve al intervalo
minimo de un segundo; solo los errores consecutivos crecen exponencialmente, para
que cientos de miles de deltas no conviertan un backfill sano en horas de espera.
La migracion `112a*` hace atomico el corte
`replaying -> ready`: el worker toma `FOR UPDATE` y los triggers `FOR SHARE`, por
lo que un evento concurrente queda antes o despues del corte y no puede dejar un
delta huerfano. El baseline, el cambio a `replaying`, el drain y el finalizer usan
transacciones separadas; el finalizer nunca conserva un lock de contacto antes de
tomar el singleton. Ese orden evita el ciclo singleton-contacto que produciria
deadlocks con un writer concurrente. Al desplegar, una unica transicion
`ready -> replaying` recupera cualquier delta heredado y despues vuelve al camino
O(1).

El catalogo de plantillas de Automatizaciones es un read-model local con pagina
de 50 por default, 100 maximo, busqueda y cursor ligado a status + busqueda. Crear,
editar, importar, recibir webhook o sincronizar explicitamente materializa el
snapshot en `whatsapp_api_templates`; el GET nunca recorre y reescribe todas las
plantillas locales ni llama a Meta/YCloud. Una seleccion guardada fuera de la
primera pagina se resuelve con una busqueda local por ID. Si no hay snapshots,
la UI conserva la lista vacia hasta que el usuario conecta/refresca o ejecuta el
POST de sincronizacion; nunca dispara `refresh` por el simple hecho de abrir el
editor.

Analytics usa dos contratos protegidos por `analytics` + `web_analytics`. La
analítica web sólo pertenece al plan Profesional: `basic` y `medium` no muestran
ni solicitan sesiones, visitantes, páginas vistas, tráfico o distribuciones web,
aunque una configuración heredada todavía marque `web_analytics=true`. El gate
se repite en backend para que ocultar la interfaz no sea la única protección.

Los contratos son:

- `POST /api/tracking/analytics/summary`: recibe `start`, `end`, `groupBy` y
  filtros. Devuelve metricas actual/anterior, tendencias y series; nunca filas de
  `sessions`. `includeFacets=false` es el contrato de apertura web y evita crear
  cualquier consulta de facetas antes del primer paint. El default `true` se
  conserva exclusivamente por compatibilidad con callers legacy. Autoagrupa
  rangos grandes para no superar 400 puntos.
- `POST /api/tracking/analytics/facets`: acepta exactamente una dimension
  allowlisted por request y devuelve como maximo 25 opciones. Fuentes,
  dispositivos, navegadores, sistemas, ubicaciones, paginas, Sites, formularios,
  canales y jerarquia publicitaria se cargan por intencion real; el contrato no
  acepta una lista de dimensiones que permita reconstruir las 16 de golpe.
- `POST /api/tracking/sessions/search`: devuelve entre 20 y 100 filas angostas,
  `hasMore` y un cursor opaco basado en `started_at + id`. No calcula total. La
  tabla pide 50 y mantiene como maximo 100 filas en memoria/DOM, con busqueda
  server-side y cancelacion de requests anteriores. El filtro de etapa de
  conversion avanza por chunks de 500, con cursor, y corta a 10,000 candidatos
  por request para conservar latencia/memoria predecibles.

El contrato web `includeFacets=false` se calcula exclusivamente desde
`tracking_analytics_range_delta` / `tracking_analytics_presence` (proyeccion 113)
y `tracking_conversion_daily_rollup` (proyeccion 116). Esa lectura nunca cae de
regreso a scans de `sessions`, `contacts`, `payments` o `appointments`: si cualquiera de
las dos proyecciones todavia no converge para la zona horaria de la cuenta,
responde `503 tracking_analytics_projection_warming` o
`503 tracking_conversion_projection_warming`, con `Retry-After: 2`. La lectura no
agenda backfills; los workers y el mantenimiento existentes son quienes calientan
las proyecciones. El frontend reintenta solamente esos dos codigos, como maximo
tres intentos, respetando `Retry-After` con espera cancelable y tope de diez
segundos. Nunca reintenta automaticamente `tracking_analytics_busy` ni
`tracking_analytics_deadline`.
`allowStale=false` obliga a reconstruir de inmediato un snapshot stale y una
revision cruzada o una cola de proyeccion pendiente conserva la consistencia
`moving-window` hasta que un build nazca y termine sobre la misma revision.
El contrato `includeFacets=true` sigue usando el agregador legacy por
compatibilidad y es deuda explicita: no debe anunciarse como raw-free.
La generacion 4 de la proyeccion 113 separa `traffic_source` normalizado para
Origin de `source_filter_value`, que conserva la expresion historica de filtros
y facetas (`newsletter`, `fb` y demas aliases). Tambien representa por separado
`contact_id IS NULL` y el raro `contact_id = ''`: el primero no suma contactos
identificados y el segundo cuenta una vez, igual que el contrato legacy. La
misma regla conserva `session_id IS NULL` frente a `session_id = ''` para el
conteo de sesiones unicas. La migracion `120*` publica un fence generacional
antes del rebuild: PostgreSQL toma el mismo advisory lock global de los workers,
espera cualquier lote v3 en curso, renombra la fila durable a
`tracking_analytics_projection_state_v4` y deja en el nombre viejo una vista
vacia. SQLite hace el mismo corte dentro de su migracion atomica. Asi un binario
v3 que siga vivo durante el rolling deploy obtiene cero filas de estado y sale
`unavailable` antes de su primer `DELETE`; no puede alternar resets con v4. La
migracion no borra el read model. Solo el worker v4 conoce el nuevo state y hace
un unico reset/rebuild reanudable bajo lock. Hasta que termina, el reader
responde warming sin mezclar generaciones ni iniciar trabajo desde el request.
El fast path global conserva hasta 400 periodos y los consulta en lotes de hasta
900 parametros, por lo que no rebasa el limite clasico de SQLite ni recorta la
serie. `tracking_analytics_range_delta` tiene un indice de cobertura orientado a
`start_boundary + occurrence_date`; PostgreSQL lo instala con
`CREATE INDEX CONCURRENTLY` aislado para no bloquear escrituras durante deploy.

El resumen mantiene un snapshot SWR por rango, zona, agrupacion y filtros. Una
escritura de tracking incrementa su revision sin crear una llave nueva: durante
30 segundos se reutiliza el resultado fresco y, hasta cinco minutos, una
reentrada recibe el ultimo snapshot inmediatamente mientras una sola promesa
compartida recalcula en background. El frontend no fuerza red cuando el snapshot
sigue fresco, pinta primero cualquier snapshot util y no mantiene la pagina tras
el loader mientras revalida. Si recibe un snapshot `stale`, agenda una unica
lectura `waitForFresh` despues de `revalidateAfter` y nunca antes de 30 segundos;
no abre inmediatamente un segundo resumen mientras mensajes y tablas siguen
cargando. El timer se cancela al cambiar de rango o salir de la pagina. El
resumen, la configuracion de tracking y la tabla de sesiones son cargas
independientes: una configuracion lenta o un error de metricas no desmonta la
tabla. Toda lectura tiene cancelacion y presupuesto de 20 segundos con error
reintentable; nunca deja una promesa ni un loader pendientes.
En backend el core tiene dos carriles logicos —sesiones y conversiones— y un
semaforo global permite como maximo dos consultas pesadas activas entre todos los
builds. Asi el resumen inicial no espera facetas, no suma seis tiempos en serie
ni abre seis conexiones de golpe; requests identicos comparten el mismo build.
Las facetas singulares admiten un solo build activo y usan tambien ese semaforo,
por lo que siempre queda capacidad para el core. El proceso acepta como maximo
dos builds pesados globales y ocho esperas; cuenta el tiempo de cola dentro del
deadline de 18 segundos y devuelve un error reintentable bajo presion, sin seguir
ejecutando despues de que el cliente abandono la ruta. Si la revision cambia
mientras se calcula, el resultado queda marcado `stale` y se reconstruye antes de
declararse fresco. Un stream continuo de visitas no puede convertir cada apertura
en cache miss ni multiplicar agregados iguales.

En PostgreSQL cada faceta plana se agrega como una sola rama acotada: conserva su
definicion exacta de identidad y etiqueta, ordena y aplica top 25 dentro de esa
rama. El endpoint singular no genera un `UNION` de 16 scans. El contrato legacy
puede unir ramas acotadas, pero nunca usa `GROUPING SETS` ni una materializacion
global que derrame todas las dimensiones a disco. En la prueba con 300,000
sesiones, el core sin facetas termino en 3.705 s frente a 6.706 s del resumen
completo; `sources` tardo 536 ms, `devices` 352 ms, `topVisitors` 132 ms y la
jerarquia publicitaria acotada 1.839 s, cada una aislada y fuera del loader global.
Con 1,000,000 de sesiones, el core exacto completo termino entre 3.75 y 4.61 s.
El rollup de identidad/sesion redujo el I/O temporal total de PostgreSQL 54.4%:
de 671.3 MiB leidos + 517.8 MiB escritos a 271.0 + 271.5 MiB, sin cambiar una
metrica (`EXCEPT` dio cero filas en ambos sentidos). Node aumento solo 6.4 MiB de
RSS y 1.8 MiB de heap en el pico; no materializa el millon de eventos. El
frontend pide filtros por hover, click, foco o teclado, conserva un cache acotado
por cuenta/rango y carga de forma secuencial las cinco dimensiones normales
cuando su grid entra al viewport. `topVisitors`, la faceta de mayor cardinalidad,
queda fuera de ese lote y se solicita solo cuando su propia tarjeta se acerca al
viewport.

La tabla de visitantes lee exclusivamente `tracking_visitor_latest` con
pagina de 50, cursor estable, filtros y busqueda server-side. Nunca vuelve a
`SELECT` del historico ni reconstruye todos los registros dentro del GET. Una
instalacion que aun converge responde `503 tracking_visitor_projection_warming`
y `Retry-After`, mientras el worker reanudable procesa en PostgreSQL lotes de 200,
como maximo diez lotes por turno, cede un segundo y continua solo. El estado
`ready` se publica unicamente cuando el historico completo ya fue proyectado;
con 300,001 sesiones el drain debe converger sin retener la tabla en memoria del
proceso. Si el fence distribuido falla antes de entrar al callback, el scheduler
libera su bandera y programa el retry; no puede quedarse eternamente en
`warming`. La busqueda atribuida limita y ordena por cursor cada fuente de
candidatos antes de unirlas, en vez de materializar todos los matches. La metadata
de cada consulta declara por separado si una busqueda
acotada o un borde no alineado reducen su cobertura.
Los rangos se separan entre buckets diarios completos y bordes parciales de
trimestre; cada rama recibe su propio limite temporal y solo la rama que contiene
el cursor aplica el predicado keyset. Esto evita que un `LIMIT 51` ordene cientos
de miles de candidatos antes de paginar. Sobre 1,000,000 de sesiones y 2,000,000
de filas de proyeccion, la primera pagina medida termino en 34-93 ms y la segunda
en 5-11 ms, con 100 identidades unicas y un incremento pico de 6.2 MiB de RSS en
Node. Una busqueda de una o dos letras no toca PostgreSQL; desde tres caracteres
usa el indice trigram acotado y la interfaz explica el minimo requerido.
`GET /api/tracking/config` tambien es estrictamente local: lee dominio,
preferencias, Sites publicados y la evidencia hash de la ultima sincronizacion
aceptada por HighLevel. La consulta remota del custom value vive solamente en
la mutacion explicita `POST /api/tracking/configure`.

La jerarquia publicitaria de tracking se agrega en SQL como
`utm_source -> utm_campaign -> utm_medium -> utm_content`, cuenta identidades
unicas y conserva los IDs UTM crudos para filtros. El payload se poda a 8
plataformas, 8 campanas por plataforma, 5 conjuntos por campana, 5 anuncios por
conjunto y 750 nodos globales. Las etiquetas URL-encoded se decodifican sin
alterar esos IDs. `GET /api/tracking/messages-summary` lee exclusivamente la
generacion activa del read model `114*`/`115*`: hechos angostos, rollup diario y
ledger exacto de rangos para WhatsApp, Meta y correo. El request ya no ejecuta el
`UNION` legacy sobre `whatsapp_api_messages`, `meta_social_messages` y
`email_messages`, ni lo conserva como fallback. Si la version, timezone,
generacion o ledger de rangos aun no estan disponibles, responde
`503 message_analytics_projection_warming` con `Retry-After`; nunca fabrica ceros
ni vuelve a recorrer los historiales.

La respuesta conserva las metricas, tendencia y filtros existentes y agrega
observabilidad en `performance.readPath`, estado/generacion de la proyeccion y el
header `X-Ristak-Read-Path`. El agregado proyectado termina antes de abrir las dos
lecturas auxiliares acotadas: estado local de conexiones mediante `EXISTS` y
conteo first-seen. La misma senal de aborto llega a todas las lecturas para que
abandonar la vista no deje trabajo huerfano. El GET no agenda backfills; el
scheduler de mantenimiento es el unico responsable de hacer converger la
proyeccion.

El conteo de contactos por primer mensaje inbound no vuelve a ejecutar
`MIN(...) GROUP BY` sobre todo el historial. La proyeccion versionada
`message_first_seen_ledger` deja un sentinel por mensaje de WhatsApp, Meta y
email; `message_identity_first_seen_global` conserva el primer mensaje por
identidad entre canales y `message_identity_first_seen_source` el primero dentro
de cada canal. Las identidades y defaults siguen literalmente el contrato
legacy, incluidos anonimos `message:<id>`, WhatsApp/Meta sin direccion como
inbound y email sin direccion como outbound. Inserts, cambios de identidad o
direccion y borrados actualizan ambas summaries en la misma transaccion; solo al
quitar el minimo se busca un reemplazo por indice. Los filtros de contactos
ocultos se evaluan contra `contacts` al leer para reflejar cambios sin
reproyectar mensajes. `messages-summary` y el resumen compatible de WhatsApp
leen siempre estas tablas. Mientras el estado converge devuelven el conteo
materializado disponible y `status.firstSeenProjection=warming` con
`firstSeenProjectionComplete=false`; si el esquema aun no está disponible
responden cero con `unavailable`. Ningún GET ejecuta el antiguo
`MIN(...) GROUP BY`, agenda el backfill ni bloquea la página. Al llegar a
`ready`, el mismo camino queda exacto. Las migraciones aditivas e indices de
backfill viven en `099*`.

Los indices aditivos del contrato viven en
`backend/migrations/versioned/050_tracking_performance_indexes.sqlite.sql` y
`051_message_analytics_indexes.sqlite.sql` para SQLite. PostgreSQL aplica las
migraciones concurrentes `050a` a `051d`, habilita `pg_trgm` en `052` y crea el
GIN de busqueda en `053`; cada `CREATE INDEX CONCURRENTLY` vive en su propia
migracion para no bloquear despliegues ni quedar dentro de una transaccion. Si
el volumen exige rollups o proyecciones incrementales, se implementan detras de
los mismos endpoints agregados: no se vuelve a exponer el historico al frontend.

El Dashboard obtiene sus tres listas recientes desde
`GET /api/dashboard/operational-snapshot`. Esa respuesta consulta solo la base
local, entrega como maximo cinco pagos, cinco contactos y cinco citas, y no
contacta proveedores. El funnel tiene un solo owner de carga para no duplicar la
misma consulta al montar. Pagos usa exactamente las exclusiones de la lista de
Transacciones (estados no publicables, flujos internos y pruebas). La frescura
externa depende de los crons registrados de HighLevel/Google y del sync al
conectar; el GET del Dashboard nunca sacrifica latencia esperando un proveedor.
Origenes, funnel, citas, asistencias y fuentes de trafico se agregan en SQL por
rango y zona de la cuenta; no recorren contactos, citas o sesiones completas en
Node ni hacen fallback a HighLevel durante la navegacion. Sus deadlines cubren
tambien la espera de conexion, la resolucion de timezone y la consulta: abandonar
la ruta cancela el trabajo y una saturacion responde como error reintentable, no
como loader permanente. Las graficas devuelven solo buckets y top 10. Ingresos,
reembolsos y ticket promedio comparten una sola
pasada condicional por `payments`, mientras publicidad, costos y gastos manuales
se resuelven en paralelo. El frontend conserva snapshots por principal y rango:
al volver pinta el ultimo Dashboard util y revalida sin cubrir la pantalla con
un loader. Las metricas concurrentes del mismo rango comparten una sola lectura,
cada consumidor cancela su propia espera y el fetch compartido continua mientras
exista otro consumidor; al irse el ultimo se aborta la consulta. La vista no
fuerza red si el snapshot de 30 segundos sigue fresco. Si el primer snapshot
falla, Dashboard muestra un error reintentable en vez de conservar
`metrics=null` bajo un loader; las graficas extendidas tambien detienen su
reintento automatico al fallar. Los modales de contacto/visitante, sus editores y los
servicios de Reportes/Campanas para drill-down no forman parte del chunk inicial:
se descargan al abrir el detalle y muestran un modal ligero durante una red fria.
Los indices locales de este contrato viven en `063*`.

El limitador compartido del backend admite como maximo dos lecturas de Dashboard,
incluyendo los periodos actual/anterior y el contexto movil; un montaje ya no
puede abrir ocho conexiones simultaneas. En el navegador, metricas, snapshot
operativo, financiera, las dos series visibles, funnel, fuentes y origen pasan
por una cola abortable de maximo dos transportes, en ese orden de prioridad. La
espera de cola termina a los 10 segundos con error local reintentable; el timeout
de red/ejecucion de 20 segundos empieza solamente al obtener un carril. Asi una
tercera familia no pierde su presupuesto mientras espera y tampoco extiende un
loader a 40-45 segundos. Salir de la ruta elimina una entrada pendiente antes de
abrir su `fetch`.
`OriginDistributionCard` solicita `dimension=<visible>&includeBreakdowns=0`:
el backend agrega solo esa dimension y no calcula leads, citas, conversiones ni
numeros WhatsApp que la card no renderiza. Cada dimension queda cacheada por
cuenta/rango durante 30 segundos, de modo que cambiar el selector reutiliza el
resultado sin rehacer las otras cinco agregaciones. Si una dimension falla, la
card conserva las demas y ofrece reintento local; no borra datos validos ni
reactiva el loader global.

El caso visible `dimension=sources` con web y WhatsApp activos tiene un carril
proyectado propio: combina el ledger de rangos de tracking `119*` con la
generacion activa de mensajes `114*`/`115*`, aplica los contactos ocultos y
devuelve el mismo top 10 sin consultar `sessions` ni los historiales de mensajes.
Ese GET tampoco agenda backfills. Si alguna proyeccion, version, timezone o
ledger todavia no esta disponible, responde `503` con `Retry-After` en lugar de
volver silenciosamente al scan legacy; `performance.readPath` y
`X-Ristak-Read-Path` permiten comprobar el carril servido. Las demas dimensiones,
los breakdowns de contactos y los numeros de WhatsApp conservan sus contratos
independientes y no forman parte de este fast path.

`PhoneAnalytics` obtiene su primer paint desde
`GET /api/dashboard/mobile-analytics-snapshot`: una sola peticion entrega KPIs,
origen, funnel y la grafica financiera seleccionada. El cliente actual manda
`includePhoneBreakdown=0` para sacar el desglose por numero del camino critico;
por compatibilidad, un bundle anterior que omita el flag conserva el payload
historico con hasta 100 numeros WhatsApp. El endpoint resuelve una vez
el rango en `account_timezone`, filtros ocultos, calendarios de atribucion y
labels, y reutiliza las mismas funciones puras que los endpoints de Dashboard;
no llama controladores entre si ni toca HighLevel, Meta, WhatsApp u otro
proveedor. Si el cliente abandona o cambia de periodo, el `AbortSignal` llega a
las consultas de base. El frontend conserva como maximo ocho snapshots por
principal/rango/scope (30 segundos frescos y cinco minutos como stale visible),
descarta respuestas de periodos anteriores con un ID monotono y revalida con una
request propia. Peticiones concurrentes de la misma llave comparten single-flight;
cada consumidor puede abandonar su espera y la consulta real se cancela solo
cuando ya no queda ninguno. Cambiar scope, grafica u otra vista despues del primer
paint usa solamente el endpoint focal necesario.

El desglose `Origen por numero` se enriquece despues del primer render: web lo
pide cuando el panel se acerca al viewport, Android despues de las interacciones
iniciales e iOS al aparecer el panel Origen. Los tres clientes llaman
`GET /api/dashboard/origin-distribution` con `includeWeb=0`,
`includeWhatsapp=0`, `includeBreakdowns=0` e `includePhoneBreakdown=1`; la
respuesta solo mezcla `whatsappNumbers` y nunca reemplaza trafico, leads, citas
o conversiones ya visibles. Cada superficie cancela rangos anteriores y evita
que una respuesta vieja publique sobre el periodo activo. La lectura usa
exclusivamente `message_analytics_phone_range_delta` y metadata proyectada
`118*`, respeta contactos ocultos y no consulta `whatsapp_api_messages`, no
agenda backfills y no cae al historial crudo. Si la proyeccion aun calienta, el
panel secundario conserva el ultimo dato util y reintenta en una recarga o rango
posterior sin bloquear el resto de Analiticas.

Contactos confia en los flags de cita/asistencia calculados por su endpoint
paginado; no descarga anos de calendarios para pintar veinte filas. La busqueda
de Chat escritorio entrega la primera pagina de inmediato y pagina resultados
al hacer scroll, en lugar de recorrer toda la cuenta antes de mostrar algo. La
lista de conversaciones avanza por `last_message_sort + contact_id`, no por
offset. El montaje no precarga cinco paginas ni 250 conversaciones: solo pide el
siguiente lote de 50 cuando la lista aun no llena la pantalla o el usuario se
acerca al final. La lectura de la pagina y del hilo tiene deadline y no puede
dejar sus loaders activos indefinidamente. Dentro de una conversacion, Desktop y
movil conservan la tupla privada
`cursorDate + cursorKey` del mensaje mas antiguo y la envian al pedir historia;
esto evita saltar mensajes distintos que compartan el mismo instante. La
app movil solo carga los datos de la seccion activa y sus listas de pagos,
contactos y conversaciones permanecen acotadas. En Calendario, los eventos
visibles se publican sin esperar las metricas mensuales; si estas fallan se
conserva el ultimo resumen valido. El mes usa
`GET /api/calendars/events/month-preview`: devuelve conteos exactos por dia del
negocio y como maximo tres previews por dia en escritorio o dos en telefono, por
lo que Node nunca materializa el mes completo. Semana y dia usan
`GET /api/calendars/events/page`, paginas keyset de 100 filas (200 maximo) por
`start_time + id`; la primera incluye total/conteos y las siguientes avanzan con
`Cargar mas citas` sin repetir el agregado. El anual movil usa
`GET /api/calendars/events/day-counts` y no descarga filas. La portada Citas de
`PhoneApp` usa `GET /api/calendars/events/overview`: recibe KPIs exactos de todos
los calendarios y sólo las próximas cinco citas del rango (20 máximo), en vez de
descargar cada fila para calcular tarjetas en el navegador. La lista de proximas citas usa
`GET /api/calendars/upcoming` con keyset exacto `start_time + id`, entrega 20
filas por default (maximo 100) y avanza con `Cargar mas`; el resumen mensual se
calcula aparte en `GET /api/calendars/events/summary`. Ninguno de esos GET de
navegacion llama a Google o HighLevel: leen el espejo local y la frescura queda
a cargo de la conexion inicial, webhooks, sync manual y crons condicionales. El
listado de calendarios tampoco cuenta el histórico para detectar una semilla
vacía: usa una comprobación `EXISTS` indexada sólo sobre candidatos semilla.

Las listas de Contactos y Pagos no reconstruyen actividad historica al ordenar.
La proyeccion durable `097*` mantiene por contacto pagos, compras, intentos
fallidos, primera/ultima compra, citas, citas activas, asistencias, prioridad y
ultima cita; `payment_list_activity` conserva las llaves normalizadas de orden de
cada pago. Triggers transaccionales actualizan inserts, cambios, reasignaciones y
borrados, y un backfill reanudable converge instalaciones existentes fuera del
readiness. La lectura usa el fast path solo cuando el estado durable esta
`ready`; antes conserva SQL legacy exacto. Las primeras sesiones se hidratan
unicamente para los contactos de la pagina, en lote y con precedencia
`contact_id > visitor_id > email`.

Las sincronizaciones de pagos/facturas no deben cerrar con un recálculo global
de `contacts.total_paid`, `purchases_count` o `last_purchase_date`. Cada upsert
de invoice actualiza solo los contactos afectados; si se necesita una reparación
manual, `POST /api/contacts/sync-stats` usa `updateContactsStats()` por keyset en
lotes acotados y no un `UPDATE contacts` full-table. Esto evita locks largos y
mantiene navegables Contactos, Pagos, Dashboard y Reportes durante imports
grandes.

Los drill-downs de Analytics/Reportes cargan como maximo las cinco citas mas
recientes por contacto junto con `appointmentsTotal` y
`appointmentsTruncated`. La tarjeta siempre muestra el total real y avisa cuando
la coleccion es parcial. Si al seleccionar el contacto se hidrata el detalle
completo, esa metadata se reemplaza por el tamano real para no etiquetar una
lista completa como truncada.

Publicidad usa `GET /api/meta/campaigns/page`: devuelve 50 entidades por
default, permite hasta 100 principales y hasta 200 hijos por expansion. La
busqueda, el orden y la paginacion ocurren en backend; conjuntos y anuncios se
cargan solo al expandir. Los visitantes se agregan en SQL para las entidades de
la pagina y el navegador no vuelve a descargar contactos o visitantes masivos.
El orden por resultados/ROAS conserva exactitud global antes de paginar. El
contrato legacy queda acotado y solo incluye la jerarquia completa con una
solicitud explicita. Los indices de este contrato viven en las migraciones
`054*`. El drill-down de contactos usa cursor estable, busqueda remota y DTOs
ligeros; pagos, citas y perfil se hidratan solo al seleccionar una persona.

La cabecera, KPIs y graficas de Publicidad usan un solo read-model:
`GET /api/meta/overview`. Meta Ads y contactos se agregan una vez para periodo
actual + anterior; citas y visitantes se recorren una vez para el rango actual.
Esos cuatro scans acotados reemplazan once agregados solapados que antes salian
de Reportes, inversión y funnel por separado. El snapshot `101*` es durable por
cuenta, rango, zona, filtros ocultos, calendarios e inclusion de visitantes;
durante 30 segundos se reutiliza como fresco y despues se pinta stale mientras
una sola promesa lo recompone. Como maximo se ejecutan dos builds de overview a
la vez. Una revision que cambie durante los scans no se publica falsamente como
exacta: queda marcada stale para la siguiente reconstruccion. El frontend
conserva el shell, cancela tanto la pagina de entidades como el overview anterior
y nunca cubre toda la ruta con un loader. Si falla la revalidacion en background,
conserva el snapshot stale visible y muestra una advertencia; no vacia KPIs ni
regresa al loader. Un build frio se cancela cuando pierde
su ultimo consumidor; una revalidacion SWR con snapshot util puede terminar en
background para beneficiar la siguiente navegacion. `meta_ads.date` se filtra
como su texto ISO canonico; `101b*` agrega `ad_id + date` para resolver la
validacion de atribucion sin recorrer todos los dias historicos del anuncio y
`101c*` cubre el agregado por fecha con inversión, clics y alcance sin depender
de un scan completo.

Reportes devuelve listas de contactos con cursor estable `created_at + id`, 50
filas por default y 100 como maximo. La busqueda es remota, el conteo de interfaz
se corta en `10,000+` y la fila solo contiene el resumen necesario; pagos,
citas, sesiones y perfil completo se consultan por ID al seleccionar un
contacto. Suscripciones pagina 20 filas por default (100 maximo), filtra y
ordena en SQL, mientras sus KPIs se calculan con un agregado global separado.
Contactos, transacciones, contactos de campana, suscripciones y planes preservan
la precision completa de sus timestamps de cursor y recorren empates/nulos en
ASC o DESC sin repetir ni perder filas. Los cursores de suscripciones y planes
incluyen tambien el orden y filtros normalizados en su alcance.
Los eventos vivos solo revalidan la pagina visible; hablar con una pasarela es
una accion explicita. Los indices compartidos de Reportes/Suscripciones viven en
`060*`.

La tabla principal de Reportes agrega contactos, citas, asistencias, primera
compra, pagos, anuncios y visitantes directamente en SQL. Como maximo ejecuta
dos consultas agregadas concurrentes por request para no agotar el pool. En
SQLite normaliza timestamps legacy numericos/texto y genera los cambios reales
de offset IANA con Luxon para que el dia del negocio siga siendo correcto al
cruzar horario de verano; la identidad usa primero la proyeccion canonica
`contact_phone_numbers` y deja la limpieza recursiva exacta solo como fallback
legacy. La primera compra parte de candidatos del rango y comprueba que no exista
un pago anterior, apoyada por los indices parciales `064*`; no agrupa todo el
historico de pagos en cada apertura. El modal de transacciones pagina 50 filas
con cursor `date + id`, busca en servidor y obtiene su resumen global por
separado; sus indices viven en `066*`. Resumen y filas arrancan juntos con un
maximo de dos operaciones de DB; el `COUNT` filtrado espera a que termine la
pagina de filas para no abrir un tercer carril. Como maximo existen dos builds
frios globales; un tercero recibe
`503 report_transaction_summary_busy` reintentable en lugar de abrir otra
consulta pesada. Consumidores iguales comparten build, irse uno no cancela a los
demas y el ultimo si aborta la consulta. Backend corta a 18 segundos y frontend a
20. Reportes no repite una segunda consulta de visitantes despues de recibir el
agregado principal.

La apertura web y movil de Reportes usa un solo read-model:
`GET /api/reports/snapshot`. La respuesta incluye buckets, rango y los KPIs
financieros comparables. Los totales actuales se derivan de los mismos buckets;
no vuelve a escanear contactos, pagos ni anuncios mediante `/metrics` y
`/summary`. Solo el periodo anterior ejecuta dos agregados acotados (pagos y
anuncios). `/metrics` y `/summary` permanecen compatibles para integraciones y
callers legacy, pero no son el camino de montaje de la UI. El snapshot se guarda
por cuenta, rango, agrupacion y scope en
`reports_snapshot_cache`; `100*` mantiene una revision durable que cambia con
contactos, telefonos canonicos, pagos, citas, asistencias, anuncios, sesiones,
filtros y configuracion. En PostgreSQL la revision core usa secuencia y triggers
por statement. Reutiliza la revision `070*` para contactos, pagos, citas,
asistencia y anuncios, además de su secuencia append-only de visitantes; `100*`
solo agrega teléfonos canónicos, filtros, zona/calendarios y HighLevel. Así no
duplica escrituras en los hot paths ni invalida por una clave de configuración
ajena al reporte. Una revision nueva sirve inmediatamente el ultimo snapshot
como stale y comparte una sola reconstruccion SWR entre usuarios autorizados de
la misma cuenta: la ruta ya exige autenticacion y permiso de Reportes, y el
agregado no contiene datos especificos del principal. Esto evita dos filas o
builds identicos por cada usuario. El frontend respeta `revalidateAfter`; un
stream continuo produce un snapshot `moving-window` honesto y como maximo un
nuevo intento cada 30 segundos, sin encadenar `waitForFresh` ni declarar
exactitud falsa. Cambiar rango o scope aborta la lectura anterior y las respuestas
tardias no pueden pisar la vista actual. Esa cancelacion cruza el request HTTP:
el backend propaga `AbortSignal` hasta los agregados y, en PostgreSQL, cancela la
consulta activa en el servidor. Un build frio o `waitForFresh` se detiene cuando
ya no queda ningun consumidor; una reconstruccion SWR que ya tiene un snapshot
stale util conserva `keepAlive` y termina de publicar el cache durable para la
siguiente entrada. Tanto la cola como el build tienen presupuesto total de 18
segundos; la cola admite como maximo ocho misses frios. Una revalidacion SWR no se
encola si los dos slots estan ocupados: devuelve el snapshot stale y reintenta en
la siguiente lectura. El fence de persistencia recibe la misma señal y un timeout
responde `503 reports_snapshot_deadline` con `Retry-After`, nunca un loader
indefinido ni trabajo huerfano.
El cliente conserva como maximo 12 snapshots de Reportes durante 30 segundos,
aislados por cuenta, rango, agrupacion y scope. Volver a la ruta pinta ese dato
de inmediato; llamadas equivalentes comparten una sola promesa y el ultimo
consumidor que abandona cancela el `fetch`. Los eventos vivos conservan el TTL
corto y una mutacion explicita limpia y aborta. Ambos loaders de la pagina se
liberan en `finally`; un error inicial muestra estado reintentable y una falla de
revalidacion nunca borra el snapshot que el usuario ya puede consultar.

La cabecera de Reportes siempre se pinta antes de la primera respuesta; solo la
zona de datos conserva su loader. En PostgreSQL, un cache hit obtiene cuenta,
revision de Reportes, revision core, revision de visitantes y fila durable en un
unico statement cancelable, en vez de cinco adquisiciones consecutivas del pool.
El fence posterior al build usa la misma lectura compacta y el touch LRU se
limita a una vez cada 30 segundos para no generar WAL y locks por navegacion.
Este fast path no amplia el TTL ni omite la comprobacion exact/moving-window.

Pagos mantiene contratos server-side en todas sus listas crecientes. Productos
pagina y busca en backend, calcula el resumen global en SQL y carga los precios
de la pagina con un solo `IN`, no con una consulta por producto. Planes de pago
pagina, busca, ordena y obtiene facets/resumen desde el espejo local; una
actualizacion normal no bloquea la vista esperando Stripe, Conekta o HighLevel.
Sus indices viven en `061*`. Transacciones avanza por cursor ligado a rango,
busqueda, estados y orden; la pagina visible llega primero sin `COUNT(*)` ni
facets. KPIs y estados se leen despues desde endpoints separados con cache SWR
por hash de consulta, invalidado por una revision durable de pagos. Volver a la
vista reutiliza el snapshot, pero una mutacion o evento SSE cambia la revision y
revalida. Los GET son locales; hablar con pasarelas/HighLevel exige la accion
explicita `POST /api/transactions/sync`.

El cache SWR de Pagos admite como maximo dos builds globales y uno de fondo; no
existe cola de espera. Un snapshot stale se sirve de inmediato y su revalidacion
solo ocupa el carril de fondo, dejando libre el segundo slot para una lectura
fria. Cada build tiene 16 segundos, el request HTTP 18 y el cliente 20. La
cancelacion llega hasta SQL y, cuando abandona el ultimo waiter, tambien corta el
build compartido. Saturacion responde `503 payment_summary_busy` y el deadline
del request responde `504 payment_request_deadline`; ambos son reintentables y
envian `Retry-After: 1`. Un cache hit no escribe para actualizar LRU y una falla
de resumen conserva los KPIs anteriores en vez de fabricar valores en cero. Este
contrato no cambia las lecturas de suscripciones ni el refresh o la
sincronizacion de Mercado Pago.

La revision materializada de esas listas es una optimizacion, no una dependencia
de disponibilidad. Durante el intervalo de un rolling deploy en que una instancia
nueva ya sirve trafico pero `payment_list_revisions` aun no existe, el backend
calcula el resumen exacto sin cache y conserva el mismo payload; no convierte una
lectura valida de Pagos en error 500. En cuanto la migracion queda aplicada, las
lecturas vuelven automaticamente al cache versionado.

El listado de planes siempre lee el espejo local. HighLevel se actualiza por
`highlevelPaymentPlansMirror.cron.js`, registrado como cron de integracion: solo
corre cuando HighLevel esta conectado, pagina hasta 300 schedules por tick,
guarda checkpoint, usa lease distribuido y hace upsert idempotente sin borrar por
ausencia. Arranca cinco segundos despues de habilitarse y luego cada diez
minutos; desconectar HighLevel lo apaga sin reiniciar el backend. Ningun GET de
planes espera ese proveedor.

Sites mantiene paginas y cursores independientes para landings y formularios.
`view=landing_library` solo devuelve `landing_page`; `view=form_library` solo
devuelve formularios del usuario y excluye el formulario interno de calendario.
Cada pagina obtiene metricas de formularios/tracking en un solo lote y carga el
documento completo solo al abrir, editar o ejecutar una accion. El endpoint
legacy queda capado, los detalles limitan submissions y los indices de las
bibliotecas viven en `055*` y `091*`. La carga incremental conserva el contenido
ya visible y no mezcla tipos. Las tarjetas de galeria no hidratan bloques ni
reconstruyen el sitio: cuando entran al viewport solicitan de forma diferida el
HTML del preview sin tracking y muestran su primer pliegue a escala de escritorio.
Las tarjetas fuera de pantalla conservan el placeholder ligero. Cambiar tipo,
carpeta, busqueda o abandonar la ruta aborta la promesa anterior; una promesa de
otra llave nunca se reutiliza para la consulta nueva ni queda consumiendo backend
fuera de pantalla.

La ruta de Sites tiene una compuerta propia y liviana. Mientras descarga una sola
vez el chunk del workspace muestra únicamente el cargador global de Ristak; no
pinta encabezados, tabs, bibliotecas ni controles provisionales que parezcan una
versión anterior antes de montar la interfaz real. El menú precarga solamente la
compuerta con intención real y nunca dispara biblioteca, carpetas, dominio ni
documento de edición antes de montar Sites. El workspace es el único owner de
esas lecturas, todas con deadline y cancelación; así no se duplican datos ni una
API lenta impide abrir o abandonar la ruta. Un fallo transitorio del chunk limpia
su promesa y permite reintentar. El editor pesado nunca forma parte del shell
global ni bloquea una transición hacia otro módulo.
El documento de edicion se solicita con `includeTrackingStats=0`: abrir,
previsualizar, guardar o recibir respuestas no ejecuta conteos historicos de
sesiones. El API directo conserva `includeTrackingStats=1` por compatibilidad,
pero la UI obtiene metricas por el summary de Analytics con rango y cache
independientes.

Cada biblioteca filtra carpeta y busca en servidor; la busqueda se activa con al
menos tres letras o numeros y cruza todas las carpetas. Las facets globales se
leen aparte, se conservan cinco minutos y no se recalculan al pedir cada pagina;
las paginas usan un snapshot SWR de 30 segundos que conserva contenido mientras
revalida. `Cargar mas` no reemplaza la primera ventana ni pierde una mutacion que
ocurra durante la request. Los cursores quedan ligados a vista, busqueda y
carpeta efectiva; el root se representa como `__root__`. Los indices de carpeta
y busqueda viven en `093*`.

La primera pintura de la biblioteca no descarga el catalogo de embeds,
calendarios, campos personalizados, configuracion Meta, perfiles sociales ni
fuentes publicas. Esos recursos tienen promesa compartida, proteccion contra
respuestas tardias y se solicitan al entrar al editor, abrir respuestas, iniciar
creacion/importacion o seleccionar el bloque que los necesita. Un fallo
transitorio de Meta, calendarios o perfiles nunca se memoriza como lista vacia ni
permite guardar CAPI apagado por accidente.

Meta es una integracion opcional de Sites: crear o importar una pagina usa el
snapshot compartido de Integraciones y continua con CAPI apagado cuando el plan
no incluye Meta o su lectura falla. Ese 403/fallo no bloquea la creacion ni
dispara reintentos infinitos de perfiles sociales.

`POST /api/sites/analytics/summary` no recibe el universo de IDs cargado en el
navegador. `siteScope` selecciona en SQL sitios o formularios publicados, modo
website/funnel y un ID opcional; `aggregate` calcula metricas y `entityCount`
sobre todo ese alcance, incluso si la entidad queda fuera de la primera pagina.
`breakdownSiteIds` se intersecta con el scope y se limita a 100 filas visibles;
`formFunnelSiteId` calcula preguntas unicamente para el formulario seleccionado.
El contrato v2 rechaza scopes o modos desconocidos y exige siempre un rango
completo de fechas del negocio, para que una apertura no pueda escanear por
accidente todo el historico. El contrato legacy por `siteIds` sigue disponible:
conserva hasta 500 desgloses y todos sus embudos como antes, pero ningun flujo
nuevo debe enumerar cientos de miles de entidades.

Analiticas usa `analytics_selector`, un catalogo paginado independiente de las
bibliotecas visuales y de sus carpetas. Solo incluye entidades publicadas; los
formularios internos de calendario quedan fuera y la opcion Videos exige un
asset listo/no eliminado. La seleccion remota puede buscar sin disparar el
agregado pesado en cada tecla: el summary espera a que el catalogo default, un
deep link exacto y la primera ventana de videos queden resueltos, y entonces
lanza un solo request. El lookup exacto de un video aplica el mismo tipo, modo e
ID de site que el agregado.

El embudo de formularios cuenta submissions y respuestas por pregunta dentro de
SQL; no transporta cada `response_json` a Node ni hace preguntas por submission.
Los campos se agregan en bloques acotados y JSON historico corrupto se trata
como objeto vacio. SQLite lo protege con `json_valid`; PostgreSQL instala antes
de los indices la funcion inmutable `ristak_safe_jsonb`, usada tambien para
proyectar y filtrar `theme_json` legacy sin tumbar una biblioteca completa. Los
indices de bibliotecas, scope, modo, sesiones y submissions viven en `091*` y
`092*`.

La videoteca de Sites usa `/api/sites/video-assets` con paginas de 50 y cursor
`created_at + id` para los modulos `sites/forms`. Un preview de Bunny busca solo
su `streamVideoId`, nunca descarga la videoteca para localizar un archivo. El
dashboard agregado de reproducciones filtra en SQL todos los Sites publicados
por tipo y modo de pagina, aunque la biblioteca visual solo tenga cargada su
primera ventana. Elegir un origen reduce el agregado a ese site y el detalle de
un video consulta solo su asset. El JOIN paginado adjunta a cada video el ID y
nombre ligero de su origen; por eso los labels, el selector y el ranking siguen
siendo correctos aunque ese Site no aparezca en la primera pagina de la
biblioteca. El summary y las series conservan alcance
global, pero el desglose `byAssetId` se limita a los primeros 100 videos
cargados y `bySiteId` queda apagado salvo opt-in; nunca se serializa un mapa de
toda la cuenta. Los indices de pagina y reproduccion por site/asset viven en
`068*`. Sus cursores estan ligados a cuenta, tipo, modo y site seleccionado;
cambiar cualquiera de ellos invalida la pagina anterior en vez de repetirla.

Los selectores de dominios y formularios usan `GET /api/sites/selectors` con
busqueda server-side, cursor y paginas de 30 (maximo 50); no descargan
submissions/tracking ni hacen un `getSite` por opcion. Dominios pinta primero la
configuracion local y abre el catalogo solo al desplegar el combo. Calendarios lo
consulta unicamente dentro del paso `URL y Datos` cuando realmente se eligio un
formulario personalizado. Los IDs ya guardados viajan en `selectedIds` y se
hidratan directamente aunque no pertenezcan a la primera pagina. El detalle del
formulario se pide solo al guardar cuando se necesita validar una colision de
pago.
El formulario interno de calendario se asegura una sola vez durante startup,
después de migraciones, mediante una promesa single-flight e idempotente. Ni
`GET /api/sites/selectors` ni el listado de Sites ejecutan UPSERTs o cualquier
otra escritura; varias ventanas y varias llamadas concurrentes siguen siendo
lecturas puras.

Automatizaciones lista summaries sin el grafo del flujo, pagina por cursor,
busca/filtra en SQL y consulta el detalle solo al abrir. Las referencias externas
se validan despues del primer paint y unicamente para la pagina visible. Esa
auditoria usa una señal separada de la primera pagina y se cancela al recargar o
desmontar la biblioteca, sin sobrevivir como request huerfano. Su cache
LRU se invalida por principal y mutaciones; los indices de libreria viven en
`062*`. La biblioteca publica explicitamente su primera pagina al snapshot
reactivo; crear, renombrar, mover o borrar publica un delta revisionado que se
aplica a todas las paginas ya visibles. Una pagina que llega mientras ocurre un
autosave se reconcilia con esos deltas antes de entrar al cache, conserva su
cursor y vuelve a filtrarse por busqueda/carpeta/status; por eso una mutacion no
borra paginas append ni inserta filas de otro filtro. Cambiar de cuenta descarta
respuestas tardias en vez de devolverlas al caller. Los eventos del CRM
consultan `automation_trigger_index` por tipo y endpoint en vez de descargar y
parsear todos los grafos publicados; ese contrato durable se instala con `090*`.
El selector de formularios del editor usa
`GET /api/automations/catalogs/forms?limit=30&search=...&cursor=...`: cada fuente
(formularios nativos, campos en landings, embeds e imports) ejecuta una consulta
acotada, el backend mezcla solo esas paginas y nunca materializa el catalogo
completo. Abrir, buscar y `Cargar mas` son las unicas acciones que piden paginas;
`selectedIds` recupera una referencia guardada fuera de la pagina actual. Las
plantillas de WhatsApp son snapshots locales: una lectura vacia no dispara
`refresh` al proveedor; sincronizar sigue siendo una accion explicita.

### Ejecuciones, reingreso y eventos dentro de Automatizaciones

Cada entrada de un contacto a una automatizacion es una ejecucion independiente
en `automation_enrollments`. Si el flujo permite reingreso, terminar o sacar al
contacto libera la proteccion de ejecucion activa y la siguiente entrada crea
otra fila con otro `enrollmentId`; nunca reutiliza el resultado, los objetivos
cumplidos ni las esperas de una vuelta anterior. La opcion
`preventDuplicateActiveEnrollment` solo evita dos vueltas simultaneas mientras
la fila esta `active`, `waiting` o `paused`. Las migraciones `132*` retiran la
unicidad historica por contacto y la sustituyen por
`uq_automation_enrollments_active_contact`, un indice parcial sobre
`dedupe_contact_id`.

Un evento del CRM se entrega primero a las ejecuciones que ya estaban activas y
despues se evalua como posible disparador de entrada. Si el evento completa una
espera u objetivo de una automatizacion, ese mismo hecho no puede cerrar una
vuelta y abrir otra vuelta de esa automatizacion ya autocumplida. Un clic, cita,
pago, formulario o respuesta que ocurrio antes del `entered_at` de la ejecucion
actual no cuenta para los modos `during-automation` o `window`. Solo la opcion
explicita `immediate` puede consultar el estado acumulado actual del contacto.

El contrato por ejecucion aplica a:

- `Esperar` una respuesta o una accion: clic de disparo, formulario, pago,
  reserva de cita, respuesta de mensaje o webhook/evento personalizado.
- `Esperar` condiciones: se revisa al entrar y con cada evento nuevo del
  contacto; si ya era verdadera al entrar, continua de inmediato porque es
  estado actual, no un hecho historico consumible.
- `Evento objetivo`: etiqueta recibida o retirada, pago exitoso/fallido o
  reembolso, cita agendada o cambio de estado, formulario, clic de disparo,
  respuesta/palabra clave, cambios de contacto, mensaje atribuido a Ads,
  evento personalizado y condicion avanzada.
- `No ha respondido`: no es un evento entrante sino una ausencia. Exige una
  ventana de tiempo; al vencer sin respuesta cumple el objetivo de esa
  ejecucion. Si responde antes, toma la salida de no cumplido/continuacion y una
  entrada futura empieza con un temporizador limpio.

Los eventos recibidos mientras una ejecucion esta pausada se guardan como
cumplimiento pendiente de esa misma vuelta y se aplican al reanudar. Los
timeouts conservan sus salidas `timeout`/`notmet`, y las fechas limite se
interpretan en la zona horaria del flujo o, si no esta configurada, en la zona
horaria efectiva de la cuenta.

Las alertas de referencias rotas del Header también son un read-model local.
`listAutomationReviewProblems` ejecuta un único `SELECT ... LIMIT` sobre el
snapshot publicado: no consulta el estado, no agenda trabajo y jamás carga o
parsea flows dentro de un GET. Un scheduler de sistema revisa cada segundo la
fila singleton de `automation_review_projection_state`; si detecta `pending` o
revisiones distintas, encola el worker en el coordinador global de backfills.

El worker recorre `automations` por keyset de `id`, con lotes de 100 como máximo,
y escribe los problemas en staging bajo un `run_token` de la migración `106*`.
La tabla publicada no se borra al comenzar ni cambia entre lotes. Una transacción
final toma la fila de estado, hace CAS contra `source_revision`, aplica upserts,
elimina únicamente problemas ausentes del candidato y publica `ready`. Si una
automatización o catálogo cambia durante la corrida, toda esa publicación se
revierte, staging se descarta y el snapshot anterior sigue atendiendo lecturas
hasta el siguiente intento. El staging abandonado por una caída se limpia por el
índice de `projected_at` en lotes de hasta 200 filas y nunca mediante un scan sin
límite.

Los catálogos de referencias válidas se cargan una vez por corrida y se comparten
como Sets entre todos los lotes. Se conserva así porque validar cada nodo contra
la base produciría fan-out por flow y porque la corrección exige membresía global
de etiquetas, usuarios, calendarios, links, números, plantillas y formularios.
Esta carga queda fuera de requests y no se repite por página; si esos catálogos de
configuración alcanzan volumen masivo, deberán convertirse en otra proyección
incremental, no volver a consultas por nodo.

La biblioteca de Media pagina 50 assets por `created_at + id`, busca en servidor
y usa `folder_path` indexado (`065*`). La primera pagina no calcula facets ni
espera un `GROUP BY` de carpetas: devuelve `facets=[]` y el arbol llega despues
por `/api/media/folders`, con proteccion contra respuestas viejas. Ese endpoint
lee contadores exactos por carpeta mantenidos por triggers (`067f/g*`), no
recorre todos los assets. Uso, conteos por tipo y modulo salen de contadores
incrementales (`067c/d*`): un GET no vuelve a sumar `media_assets`, crear una
cuota ni escribir timestamps. El picker de Sites comparte ese contrato.
El timestamp privado del cursor conserva microsegundos PostgreSQL y su scope
incluye negocio, modulos, tipo, estado, busqueda y carpeta/recursion; cambiar el
filtro exige empezar una pagina nueva y no puede contaminar el recorrido actual.

El MCP puede preparar la subida de un archivo nuevo de la computadora con
`media_prepare_bunny_upload`. La tool exige `ristak.execute`, confirmacion,
idempotencyKey, nombre, MIME, bytes y SHA-256; no recibe Base64 ni entrega llaves
de Bunny. Devuelve una URL multipart y un pase firmado de diez minutos que no se
guarda en el replay del MCP. `/api/media/mcp-upload` valida usuario y grant OAuth
vigentes, Developers, permiso de escritura de Media y plan antes de Multer;
despues comprueba tamaño, MIME y SHA-256 exactos y delega al mismo servicio de
cuota, carpetas, idempotencia y Bunny Storage de la biblioteca. Revocar o cambiar
la conexión MCP invalida el pase pendiente. Los archivos quedan como assets
normales de `module=media`; este flujo no importa ZIPs como Sites ni reemplaza la
subida TUS del editor de video de Sites.

Mover, borrar o descargar conserva `businessId`, `mediaType` y `status` del
filtro visible; los IDs explicitos se revalidan contra ese alcance. Mover usa el
endpoint por lote, transmite archivos remotos sin crear un buffer completo y no
recalcula cuota porque la ruta no cambia bytes. Sin una cola de background, una
seleccion mayor a 2,000 archivos se rechaza antes de mutar con un error claro en
vez de dejar una request indefinida. Las descargas individuales y ZIP son
streams; el ZIP valida tamaño antes de leer, corta a 512 MB, consume archivos de
uno en uno y no arma el archivo completo en RAM. El backfill PostgreSQL de
carpetas corre por lotes de 2,000 con commits intermedios, y el indice global por
tipo permite el orden keyset aun sin filtro de status. No existe un
`listAllAssets` en el camino de render.

Las mutaciones que requieren mover o borrar objetos remotos se rechazan antes de
tocar datos si exceden 25 archivos, 64 MB por archivo, 256 MB totales o el
presupuesto sincrono de 60 segundos. El lookup de Bunny Stream usa la columna
`stream_video_id`, alcance por negocio/modulo e indice `069*`; el backfill legacy
es por lotes y nunca vuelve a buscar el ID dentro de todo `metadata_json`.

Los modales crecientes de tracking tambien son paginados. Visitantes y
conversiones aceptan cursor y busqueda remota, devuelven 50 filas por default y
100 como maximo, y nunca piden historiales de HighLevel. Visitantes limita a las
cinco citas locales mas recientes por contacto e indica si hay mas; conversiones
calcula LTV/conteo con un agregado por la pagina y carga pagos, citas y perfil de
una sola persona cuando se selecciona.
Todos los cursores de sesiones, chunks de etapa, visitantes y conversiones usan
la misma llave lossless del SQL y quedan ligados al rango/filtros/tipo de vista.
Las columnas privadas del cursor se eliminan antes de construir la respuesta.

La pagina normal de visitantes no vuelve a ordenar todo `sessions`. La
proyeccion durable v3 `tracking_visitor_latest` conserva, por identidad y scope,
la visita mas reciente de cada dia UTC y de cada cuarto de hora UTC. La consulta
combina dias completos con los cuartos de hora de los bordes, elimina identidades
dominadas y aplica cursor antes de hidratar las 50 filas. Los triggers mantienen
inserts, updates y deletes; el backfill `080*` avanza newest-first por lotes y
puede ser retomado por varias instancias.

La migracion `111*` agrega el singleton
`tracking_visitor_projection_state`. El GET de visitantes solo lee ese estado y
`tracking_visitor_latest`: nunca inspecciona `visitor_projection_version`, arma
ventanas ni recorre el historico de `sessions` para decidir un fallback. Mientras
el backfill esta en `warming`, o si el esquema todavia no existe durante un
rolling deploy, responde `503 tracking_visitor_projection_warming` con
`Retry-After` y metadata de cobertura; no entrega una pagina parcial ni dispara
el scan legacy. Cuando el estado es `ready` y los bordes caen en cuartos de hora,
`coverage.exact=true`. Los bordes no alineados y la busqueda remota permanecen
acotados a la proyeccion y declaran su cobertura: la request nunca compra
exactitud con un sort historico que bloquee la interfaz.

Vincular miles de visitas a un contacto no ejecuta miles de reparaciones del
rollup en PostgreSQL: una transaccion local actualiza el historial y reconstruye
de forma set-based solamente las dos identidades afectadas; cualquier error hace
rollback de sesiones y proyeccion juntas. SQLite usa lotes acotados para no
bloquear su unica conexion. La busqueda exige al menos tres caracteres y revisa
como maximo 500 identidades de la proyeccion por request. Busca en la sesion
representante mas reciente y en su contacto, pagina el siguiente bloque con el
mismo cursor y publica `search.mode=bounded_latest_projection`, el numero de
candidatos revisados y `historicalSessionsIncluded=false`. Una coincidencia que
solo exista en una sesion historica no se promete como exacta; para recuperarla
hara falta un read model de busqueda dedicado, nunca reintroducir un scan global
en un GET.

`GET /api/integrations/status` resuelve en paralelo las configuraciones locales
de HighLevel, Meta, WhatsApp, OpenAI, Google Calendar y pasarelas. Navegar nunca
verifica proveedores externos ni expone el token de HighLevel al navegador; una
verificacion remota requiere `verify=true` y solo se usa en diagnostico o
reconexion explicitos. Los endpoints de Calendario obtienen la credencial
guardada dentro del backend cuando necesitan sincronizar, sin depender de que
el frontend transporte el secret.

### Runtime autónomo sin Installer

Una instalación creada directamente desde `render.yaml` funciona sin quedar enlazada de forma
administrativa a Ristak Installer. `DATABASE_URL` y el `JWT_SECRET` generado por Render bastan
para arrancar. En el primer uso de una capacidad compartida, el backend genera una identidad
Ed25519 cifrada, demuestra control de su URL pública contra un challenge del broker central y
recibe una credencial técnica limitada.

Esa identidad habilita Google Login/Calendar, Meta OAuth, WhatsApp Meta Direct, Mercado Pago,
push, Bunny multimedia, directorio móvil y dominios de Sites. No equivale a una licencia
comercial: no activa verificación de plan, cancelación, autoscaling, despliegues ni releases de
tiendas y sus filas técnicas se excluyen de clientes, instalaciones y estadísticas comerciales
de Installer. Si existen credenciales gestionadas, tienen prioridad y nunca se abre un registro
paralelo.

La prueba central exige HTTPS público, valida DNS contra SSRF y liga la firma a la URL y llave
pública. Los handoffs OAuth son de un solo uso y los callbacks conservan HMAC. La caída temporal
del broker no bloquea el CRM ni los datos locales; sólo deja pendientes las operaciones nuevas
que realmente requieren a ese servicio central.

### Inicializacion de cuentas

`/initialization` es la entrada rápida para administradores nuevos. La pantalla
no replica toda la configuracion ni presenta una checklist tecnica: muestra solo
las conexiones disponibles por permiso para **WhatsApp**, **Meta**, **Google
Calendar** y **OpenAI**, en ese orden.

- WhatsApp aparece primero y abre su superficie canonica en
  `/settings/whatsapp`, donde el administrador elige entre la conexion oficial
  disponible para su licencia o una sesion mediante QR. Al volver a
  Inicializacion, el progreso reconoce YCloud, Meta directo o QR conectado; no
  obliga a repetir la configuracion ni confunde WhatsApp con la conexion general
  de Meta.
- Meta Ads aparece despues de WhatsApp y abre `/settings/meta-ads/cuenta`, donde
  el administrador conecta el acceso publicitario ya aprobado y elige su cuenta
  publicitaria. Facebook e Instagram se habilitan aparte cuando Meta termine la
  revision correspondiente; Inicializacion ya no abre el login combinado
  anterior para cuentas nuevas.
- Google Calendar abre el OAuth central con retorno permitido a
  `/initialization`, reclama el handoff y guarda el refresh token cifrado. Elegir
  calendarios concretos o combinar citas es configuracion posterior, no requisito
  para considerar conectada la cuenta.
- OpenAI abre un modal local para pegar la API key. Backend valida la key contra
  el proveedor y conserva solamente la credencial cifrada; el navegador no la
  persiste ni vuelve a mostrarla completa.

El progreso se calcula únicamente con las conexiones que el usuario puede usar
segun permisos. Cuando todas están conectadas, el administrador puede entrar al
dashboard; si todavía no tiene alguna cuenta, **Hacerlo después** conserva la
salida explícita sin inventar credenciales ni valores de prueba.

Rutas publicas:

- `/setup`: configuracion inicial. En instalaciones administradas el enlace SSO crea al dueño y
  abre su sesión automáticamente. Si la cuenta tiene contraseña en Installer reutiliza su hash; si
  usa solamente Google crea una credencial local aleatoria que nadie conoce y nunca recibe ni guarda
  la contraseña de Google. Si el enlace falta, expiró o no es válido, conserva **Continuar con
  Google** y también permite ingresar con las credenciales vigentes del dueño en Installer. El
  formulario manual solo existe en instalaciones independientes sin servidor central.
- En una instalación standalone, **Continuar con Google** registra la identidad técnica, vuelve
  a `/sso` con un handoff de un solo uso y crea al primer admin si la base está vacía. Con usuarios
  existentes sólo inicia sesión cuando el correo Google coincide con un usuario local activo.
- `/login`, `/sso`, `/reset-password`. El login de una instalación administrada inicia Google en
  el portal central y regresa a la app mediante una llave SSO de un solo uso; la instalación no
  recibe ni almacena la contraseña de Google.
- `/login` usa el isotipo nuevo de Ristak (`RistakAppMark`) con nombre visible
  y contexto de inicio de sesion. Los estados de carga inicial del CRM en
  escritorio y movil usan `AppStartupLoader`/`PhoneStartupLoader` sin logo ni
  nombre visible: solo un indicador minimo y accesible sobre el fondo del tema.
  La app nativa Android en `mobile/` es la excepcion: `BootScreen` y el login
  nativo muestran el logo oficial transparente de modo noche, y
  `mobile/app.json` usa los iconos oficiales light/dark para el launcher Android.
- `/license-blocked`.
- `/pay/success` y `/pay/:publicPaymentId`.
- Las superficies publicas de cliente no aplican el selector global de vista
  tablet/computadora del CRM. Checkout, Sites, calendarios publicos, tracking y
  endpoints publicos de pasarelas deben abrir como experiencia de visitante, sin
  redirigir al shell movil ni mostrar el modal "Tablet detectada".
- El estado exitoso de `/pay/:publicPaymentId` muestra un comprobante centrado
  con icono de confirmacion de contorno, titulo del resultado, monto, pasarela,
  concepto, detalles del pago, descarga de PDF y datos del negocio cuando estan
  configurados.
- rutas moviles de tenant/login.

Shell movil:

- Produccion actual vive bajo el prefijo movil (`/movil` en la app actual) y se
  empaqueta con Capacitor.
- Incluye chat, pagos, analiticas, calendario, ajustes y secciones moviles.
- Las rutas legacy `/phone/*` redirigen al shell nuevo.
- El cliente React Native nuevo vive en `mobile/` y habla directo con las mismas
  APIs del backend. Mientras convivan, los cambios moviles deben revisarse en
  `/movil` y en `mobile/`; si una superficie queda fuera, el cambio debe
  documentar la razon.

Shell desktop protegido:

- `/dashboard`
- `/chat`
- `/contacts`
- `/appointments`
- `/transactions`
- `/transactions/payment-plans`
- `/transactions/subscriptions`
- `/transactions/products`
- `/reports`
- `/campaigns`
- `/analytics`
- `/sites`
- `/automations`
- `/ai-agent`: pestaña principal `Chatbot`, con secciones internas `Chatbot` y
  `Configuracion`.
- `/mdp-program`
- `/settings`

El shell de `/mdp-program` consulta su navegacion remota una sola vez por
montaje. Cuando el iframe sincroniza la URL de `/mdp-program` a un item interno,
la ruta vuelve a seleccionar ese item sobre el snapshot ya recibido; no repite
`GET /api/mdp-program/navigation` por el simple cambio de pathname.

Configuracion se organiza en:

- Cuenta: Perfil (`/settings/profile`) concentra datos personales, correo de
  acceso, identificador interno, foto y contraseña. Negocio
  (`/settings/account`) concentra identidad comercial, logo, contacto,
  nombres de contactos, zona horaria, país, lada, moneda, almacenamiento y
  cancelación. También incluye usuarios, notificaciones, privacidad y
  aplicación móvil. Los datos personales y comerciales no deben volver a
  mezclarse en una sola pantalla.
- Contactos: contactos ocultos. Esta pagina es independiente de HighLevel y de
  cualquier otra integracion; solo los administradores pueden agregar o eliminar
  reglas de ocultamiento.
- Agenda: calendarios.
- Cobros: pagos.
- Plataformas conectadas: HighLevel, Meta, WhatsApp, correos, Inteligencia
  Artificial.
- Datos y rastreo: rastreo web, dominios, costos, media.
- Personalizacion: campos, variables, trigger links, etiquetas.
- Avanzado: Developers. La entrada principal es **Conectar con MCP**: muestra
  salud/capacidades del servidor remoto, instrucciones para Codex, ChatGPT,
  Claude y clientes compatibles, conexiones OAuth revocables y acceso a la
  auditoria autenticada en `GET /api/api-access/mcp/audit`. Credenciales API,
  webhooks, documentacion y logs permanecen como subsecciones separadas. Codex
  registra el servidor con `codex mcp add` y abre OAuth con
  `codex mcp login ristak`; ese flujo usa la sesion web normal de Ristak y pide
  consentimiento para los scopes. No genera, copia ni usa el API token de
  REST/OpenAPI. La pantalla mantiene una jerarquia plana y responsive: el estado
  del servidor aparece como un resumen unico, las areas disponibles se leen como
  una lista compacta en vez de una nube de etiquetas y los campos con acciones
  se apilan sin desbordarse en ventanas chicas.

Las tablas de Configuracion que permiten seleccion multiple usan el patron
compartido de `Table` con acciones integradas en una sola barra dentro del
encabezado de la tabla. No deben crear barras locales separadas ni partir los
controles de mover, sincronizar o eliminar en filas independientes; ese
comportamiento debe reutilizar `TableSelectionToolbar`. El checkbox maestro de
seleccion selecciona todos los registros filtrados de la tabla, aunque esten en
otras paginas de la paginacion; no debe limitarse a las filas visibles de la
pagina actual.

## Permisos, licencia y acceso

Hay tres capas distintas:

1. Auth: el usuario debe tener sesion valida.
2. Licencia/plan: `requireActiveLicense` y `requireFeature(...)` bloquean
   acceso si la licencia central no permite el modulo.
3. Permisos de usuario: `requireModuleAccess(moduleKey)` valida lectura/escritura
   por modulo.

En instalaciones administradas existe un acceso global de soporte desde el
login normal. El operador escribe su propio correo y contraseña vigentes de
administrador de Ristak Installer. La app consulta
`/api/owner-credentials/verify` con su `client_id`, licencia e instalación; el
Installer valida ambas credenciales contra `admin_users` y responde
`support_access: true` sin entregar ni copiar el hash del admin.
Aunque ese correo no exista entre los usuarios del cliente, la app toma la
identidad administrativa local configurada en `OWNER_EMAIL`; nunca crea ni
guarda al administrador central dentro de la base del cliente. Si la instalación
todavía no tiene un administrador local, el acceso global no crea uno.

Ese acceso genera un JWT local con `supportAccess=true` y sin `exp`, guardado en
el mismo `localStorage` de una sesión normal. No se invalida cuando el cliente
cambia su contraseña o incrementa `token_version`; sí deja de servir si el
usuario se desactiva, la licencia se bloquea, se cierra sesión, se borra el
almacenamiento local o cambia la llave de firma del backend. Los logins normales
mantienen su expiración de 30 días y su revocación por `token_version`.

La contraseña del admin nunca vive en la base del cliente, variables de entorno
ni documentación. Solo su hash permanece en `admin_users.password_hash` del
Installer y cada autorización se audita centralmente como
`support_login_authorized`.

Una instalación administrada sin usuarios también acepta el primer ingreso con
el correo y la contraseña vigentes del dueño en Ristak Installer. La app valida
ambas credenciales contra `/api/owner-credentials/verify`, comprueba la licencia
y crea de forma atómica el primer administrador local con el hash del dueño que
devuelve el portal. La contraseña nunca se guarda en texto plano. El enlace de
setup de un solo uso sigue funcionando como acceso automático, pero ya no es un
requisito: si falta o expiró, `/setup` presenta el mismo formulario de correo y
contraseña. La credencial global de soporte no puede activar este primer acceso
ni crear una identidad local.

`requireModuleAccess(moduleKey)` tambien valida la feature comercial del modulo
con `hasModuleFeature(...)`. Un admin local con permiso `write` no puede abrir
Pagos, Sites, Developers, Integraciones, Usuarios u otros modulos comerciales si
el plan de la cuenta no los incluye. Las pantallas y botones solo anticipan la
restriccion; el backend es la barrera real.

El modulo `ai_agent` aparece como la pestaña principal `Chatbot` en el menu
lateral. Puede dividirse por feature de licencia: `conversational_ai` habilita
la seccion Chatbot y `app_assistant_ai` habilita la configuracion general de
Ristak AI.
El plan basico puede abrir solo `conversational_ai` y limitar la creacion a
`limits.conversational_agents.max_agents=1`.

No basta con esconder botones en frontend. Cualquier endpoint que escriba o lea
datos sensibles debe tener validacion de backend.

Las superficies que no pasan por navegacion normal tambien deben validar plan:
los API tokens REST legacy y nuevos requieren `developers`; `/api/external` y
`/api/mcp` requieren `developers` y feature del recurso, aunque MCP se autoriza
con la sesion web y OAuth en lugar del API token; la busqueda global filtra
categorias por permiso y plan; `/movil` filtra secciones/cargas y cache por
feature; automatizaciones validan nodos premium al guardar, publicar, probar y
ejecutar.

En `ios/app`, mientras el usuario aun no termina de resolverse el shell conserva
acceso provisional para no parpadear. Una vez conocido el usuario, si ninguna
seccion queda autorizada, la app muestra solo Ajustes para explicar el acceso y
permitir cerrar sesion; nunca convierte una lista vacia en acceso a todos los
modulos.

Las subfeatures premium no deben colarse por herencia visual. `appointments`
habilita citas y calendarios locales; `google_calendar` habilita solo la
integracion/sincronizacion con Google. El cobro antes de agendar en calendarios
se controla con `calendar_payments` (`calendar_payment` /
`calendar_booking_payments` como aliases legacy) y, por compatibilidad temporal,
con plan `pro`/`professional` cuando el portal aun no manda esa llave. Si el
portal manda `calendar_payments=false`, ese false gana aunque el plan sea Pro.
Cuando el portal mande un objeto `features` parcial, cualquier feature premium no
incluida se considera apagada; no se deben rellenar defaults premium en `true`.
El formulario publico básico del calendario forma parte de `appointments`; usar
un formulario personalizado de Sites dentro del calendario requiere `forms` y
`sites`. Si la cuenta baja de plan, el calendario público vuelve al formulario
básico y el backend bloquea/limpia esa configuración aunque la UI vieja mande el
payload.

Campos personalizados, campos variables y etiquetas pertenecen al CRM base y
están disponibles también en Basic; se rigen por permiso de usuario, no por
`forms`, `settings_custom_fields`, `variable_fields` ni `tags` comerciales.
`forms` se reserva para formularios de Sites y calendarios personalizados. Los
enlaces de disparo siguen siendo una función separada y requieren
`trigger_links` en ruta, navegación y backend.

Las superficies incrustadas deben validar su propia subfeature: HighLevel usa
`highlevel_integration`; WhatsApp API usa `whatsapp_api`; plantillas de WhatsApp
usan `whatsapp_templates`; checkout, pasarelas y automatizaciones de pago usan
`payment_checkout`, `payment_gateways` y `payment_automations`. No se permite
abrir estas superficies solo porque su módulo padre esté disponible.
Además, checkout, pasarelas, links, tarjetas guardadas, planes, suscripciones y
webhooks de pago requieren plan Profesional aunque un flag viejo llegue activo.
Básico y Medio siguen pudiendo registrar y comprobar pagos offline.

Modulos de acceso principales:

- dashboard, appointments, payments, contacts, chat, reports, analytics,
  campaigns, automations, sites, ai_agent.
- settings_account, settings_mobile, settings_calendars, settings_payments,
  settings_integrations, settings_whatsapp, settings_email, settings_tracking,
  settings_domains, settings_costs, settings_media, settings_custom_fields,
  settings_api_access, settings_users.

## Datos y persistencia

`backend/src/config/database.js` soporta SQLite local y PostgreSQL cuando existe
`DATABASE_URL`. La app usa migraciones idempotentes y migraciones versionadas.

Familias de tablas relevantes:

- Configuracion: `app_config`, `user_app_config`, `highlevel_config`,
  `meta_config`, `storage_settings`, `storage_quotas`.
- Usuarios y acceso: `users`, OAuth clients/tokens, preferencias por usuario.
- CRM: `contacts`, telefonos, etiquetas, campos personalizados, variables,
  trigger links.
- Conversaciones: mensajes WhatsApp/API, Meta social, email, read states y
  eventos de chat.
- Pagos: `payments`, `payment_flows`, `installment_payments`, `payment_plans`,
  `subscriptions`, metodos Stripe/Conekta, productos y precios.
- Citas/calendarios: `appointments`, `calendars`, `blocked_slots`,
  `appointment_creation_requests`, attendance signals, reminders, confirmation
  windows.
- Sites/tracking: `public_sites`, `public_site_domains`, `public_site_blocks`,
  submissions, imports, assets, folders, `sessions`, video playback
  sessions/events, identity matches.
- Automations: `automations`, folders, enrollments, drip entries, schedule runs,
  contact jobs, assets.
- IA: agent runs/steps/pending actions/idempotency, memories, conversational
  agents/state/events/goal links.
- Infra: audit logs, distributed locks, cron locks.

## CRM y contactos

El contacto es la entidad central. Puede venir de HighLevel, formularios, Sites,
tracking, WhatsApp, Meta, carga manual, API externa o automatizaciones.

Capacidades:

- CRUD y busqueda.
- Los administradores gestionan las reglas globales de contactos ocultos desde
  `Configuracion > Contactos > Contactos ocultos`. Las reglas pueden buscar una
  coincidencia parcial o exacta sobre nombre, correo, telefono e ID, y se aplican
  a contactos, chat, reportes, metricas y notificaciones. Esta configuracion no
  depende de que HighLevel este conectado o siquiera habilitado.
- Detalle con historial y actividad.
- Tags y carpetas.
- Campos personalizados y variables. El catalogo de campos personalizados vive
  en Configuracion > Campos personalizados y se muestra completo en la ficha de
  contacto, el panel derecho del chat desktop y la info de contacto del chat
  movil. Las carpetas del catalogo se respetan como secciones desplegables; los
  campos sin carpeta quedan bajo "Campos personalizados". La edicion se guarda
  como actualizacion manual del contacto y conserva el flujo normal de
  automatizaciones.
- Etiquetas, campos personalizados y campos variables son parte del CRM base,
  incluido el plan Basic. El plan no debe ocultarlos ni rechazar sus endpoints;
  los permisos de usuario siguen aplicando.
- La sección de automatizaciones en la ficha de contacto, el modal del chat y
  las acciones masivas solo aparece con `automations`; el backend rechaza también
  las inscripciones o filtros avanzados de automatizaciones sin esa feature.
- Los nombres configurables de la cuenta para contacto convertido y oportunidad
  (`labels.customer`, `labels.customers`, `labels.lead`, `labels.leads`) son la
  fuente visible para CRM, chat desktop, chat movil web, app nativa,
  transacciones, suscripciones, reportes, filtros, Viaje del contacto,
  notificaciones y configuracion de agentes. No hardcodear `Cliente`,
  `Clientes`, `Prospecto` o `Prospectos` en copy visible nuevo; si una superficie
  no puede leer labels todavia, usar `contacto/persona` como fallback visible y
  conservar las llaves internas (`customer`, `lead`) solo para logica.
- La fuente de verdad de esos cuatro nombres es `app_config.crm_labels`, no
  `highlevel_config`: deben funcionar aunque HighLevel no este conectado, no
  exista en el plan o el usuario no tenga acceso a Integraciones. Todos los
  usuarios autenticados pueden leerlos con `GET /api/settings/contact-labels`;
  cambiarlos con `POST /api/settings/contact-labels` exige permiso
  `settings_account`. El frontend solo confirma "Guardado" despues de recibir
  una respuesta exitosa y vuelve a cargarlos cuando cambia la sesion/cuenta.
  `highlevel_config.custom_labels` queda unicamente como compatibilidad legacy:
  la primera lectura desde Configuracion migra su valor a `app_config`, y la
  ruta historica de HighLevel delega a la misma fuente mientras existan
  clientes anteriores.
- La app nativa Apple y las superficies web/movil leen la misma ruta general de
  Settings. Dashboard, embudos y etiquetas internas del sistema consumen el
  mismo servicio de nombres; no deben abrir lecturas paralelas directas a
  `highlevel_config`.
- Telefonos normalizados. Cuando un formulario separa la region del numero, el
  selector visible muestra solo bandera y codigo internacional (`🇲🇽 +52`), sin
  repetir el nombre del pais. Este contrato aplica al alta/edicion de contactos,
  Sites, calendarios publicos y cualquier superficie futura que solicite lada;
  los selectores de pais de cuenta, direccion o facturacion conservan el nombre.
- Nombres de contactos normalizados como nombre propio al entrar al CRM. Si un
  contacto llega como `raul gomez`, `RAUL GOMEZ` o `rAuL GomEZ`, Ristak lo guarda
  y muestra como `Raul Gomez`. La normalizacion aplica en alta/edicion manual,
  formularios/Sites, HighLevel, WhatsApp, Meta, email, calendarios, pagos/API y
  contactos de prueba de automatizaciones. Correos, telefonos y handles usados
  como fallback no se capitalizan como nombres.
- Autocompletado de identidad desde mensajes entrantes: cuando un contacto de
  Messenger, Instagram DM o comentarios Facebook/Instagram todavia no tiene
  telefono y/o correo, el backend puede detectar el primer telefono/correo claro
  escrito por el usuario y guardarlo en el contacto. El telefono se normaliza con
  la lada configurada en la cuenta (`account_default_dial_code`), por ejemplo un
  numero nacional mexicano `656 742 6612` queda como `+526567426612`. En
  WhatsApp solo se autoguarda correo detectado en el texto; el telefono no se
  extrae del cuerpo porque el numero de WhatsApp ya es la identidad del canal. En
  correo entrante no se extraen telefonos ni correos desde el cuerpo del email.
  La captura no reemplaza datos existentes y no fusiona/roba identidad si el
  telefono o correo detectado ya pertenece a otro contacto.
- La lista de contactos usa una sola entrada visible de filtros: el boton
  "Todos" abre un panel lateral derecho de filtros avanzados. Primero se elige
  un campo desde un catalogo buscable y luego se arma la condicion del lado
  derecho. El catalogo mezcla campos nativos, etiquetas, citas, pagos,
  atribucion/tracking, automatizaciones y campos personalizados activos en la
  misma lista; datos como ciudad, pais o codigo postal se filtran como campos
  personalizados cuando no existen como columna nativa del contacto.
- El panel de filtros debe usar lenguaje de usuario final en espanol claro:
  bloques, condiciones, combinar, ordenar y excluir. No debe exponer terminos
  tecnicos como "anidado". Cada campo debe renderizar el control congruente con
  su tipo: fechas con selector de fecha, cantidades/importes con valor numerico,
  campos booleanos como si/no, listas conocidas como dropdown y campañas,
  conjuntos, anuncios, automatizaciones, calendarios, usuarios, pagos y planes
  como busqueda contra catalogos reales.
- Filtros avanzados combinables en la lista de contactos. El endpoint
  `/api/contacts` aplica del lado servidor los filtros rapidos (todos, leads,
  citados, asistencias, clientes), conserva compatibilidad con filtros legacy de
  tracking (paginas, fuentes, dispositivos, navegadores, sistemas,
  placements/anuncios) y aplica condiciones avanzadas por grupos AND/OR sobre
  etiquetas, campos personalizados, fechas de creacion/actualizacion, citas,
  asistencia, calendarios, usuarios asignados, pagos, metodos guardados, planes
  de pago, parcialidades, atribucion, UTM/tracking, anuncios Meta y
  automatizaciones. Las citas pueden filtrarse por estado, fecha de cualquier
  cita, cita activa, proxima cita, ultima cita, citas futuras/pasadas,
  canceladas, inasistencias y confirmacion vigente. Los pagos pueden filtrarse
  por pago especifico, importe, moneda, proveedor, metodo, modo, estado,
  referencia, concepto y fecha; los planes/parcialidades por estado, proveedor,
  total, fecha, parcialidad pendiente o parcialidad vencida. Las
  automatizaciones pueden filtrarse por automatizacion especifica, nombre,
  estado, paso actual, tipo de espera y fechas de entrada/actualizacion/reanudar.
  Las fechas de negocio se interpretan en la zona horaria de la cuenta y los
  pagos usan estados live/exitosos/fallidos normalizados. La clasificacion CRM
  interna `customer` se activa con cualquier pago exitoso del contacto,
  incluyendo `payment_mode = test`, para poder probar checkouts sandbox de punta
  a punta. La UI debe mostrar esa clasificacion con el nombre configurado en la
  cuenta.
  Las metricas financieras de la lista (`total_paid`, LTV, conteos live y
  reportes de ingresos) siguen excluyendo pagos test.
- La pantalla `/contacts` usa paginacion real del lado servidor. La tabla pide
  solamente la pagina visible (20 contactos) con el rango, busqueda, filtro
  rapido, condiciones avanzadas y orden activo; no debe cargar el CRM completo en
  segundo plano para simular paginacion local. Cada pagina avanza por un cursor
  opaco y lossless ligado a esos filtros y al orden; no repite `OFFSET` ni
  `COUNT(*)` sobre el historico. El frontend conserva la pila de cursores para
  volver atras, la reinicia al cambiar la consulta y aborta respuestas viejas.
- `contact_list_activity` mantiene cobertura total: existe exactamente una fila
  angosta por contacto, incluso si todavia no tiene pagos ni citas. La migracion
  `109/109a` solo instala el estado y el trigger O(1); el historico se completa
  por keyset en lotes fuera del arranque. Cuando `contact_rows` queda `ready`,
  los ordenamientos por prioridad, pagos y citas parten de sus indices y usan
  `INNER JOIN`, sin ordenar toda `contacts`. Durante el calentamiento los GET
  leen el read model parcial y reportan `performance.activityProjection =
  "warming"`; nunca vuelven al `GROUP BY` historico de pagos.
- Las tarjetas KPI de Contactos no son metricas de la pagina visible: resumen el
  conjunto completo que coincide con el rango y filtros activos. `/api/contacts/stats`
  debe reutilizar los mismos filtros de `/api/contacts`, para
  que totales, clientes, LTV y promedio sigan siendo correctos aunque la tabla
  muestre solo un batch. La ficha/modal pinta primero el snapshot local del
  contacto; no descarga pagos, citas, conversacion ni journey como requisito
  para abrirse. Pagos y citas se piden al expandir su seccion mediante
  `/api/contacts/:id/payments` y `/api/contacts/:id/appointments`, en paginas
  keyset de 20 filas con cursor opaco ligado al contacto. Conversacion y journey
  tambien usan paginas acotadas y permiten cargar historial anterior. Cerrar el
  modal o cambiar de contacto aborta las solicitudes obsoletas.
- `GET /api/contacts/:id`, `/journey` y `/conversation` son lecturas locales:
  nunca deben calentar avatares, consultar HighLevel/Meta en vivo ni escribir en
  base de datos. La renovacion externa se solicita explicitamente con
  `POST /api/contacts/:id/refresh`; se encola y responde `202` sin bloquear la
  interfaz. El detalle reutiliza `contact_list_activity` cuando su proyeccion
  esta lista y cae a agregados indexados del contacto cuando aun hay backfill.
  Un contacto fusionado se consulta por su ID canonico; la UI no dispara un
  detalle completo por cada ID absorbido.
- La papelera no alimenta la bandeja de Chats. Un contacto con `deleted_at`
  queda fuera de `/api/contacts/chats` y de la ficha activa. Si despues del
  borrado llega un inbound nuevo por WhatsApp, HighLevel, Meta o correo, Ristak
  reactiva la misma identidad antes de publicar el evento realtime; el mensaje
  debe ser estrictamente posterior a `deleted_at`. Un retry duplicado o un
  backfill con fecha anterior nunca deshace una eliminacion intencional. El
  mantenimiento versionado `contact_reengagement_repair_version` corrige el
  historico que ya hubiera quedado como `conversation=200` y `contact=404`.
- Acciones masivas con job propio.
- Atribucion por UTMs, click IDs, WhatsApp referrals, Meta y tracking identity.
- `contacts.attribution_ad_id` y `contacts.attribution_ad_name` representan el
  primer registro/adquisicion inicial del contacto. Una vez que el contacto tiene
  un anuncio real, esos campos no se pisan por retargeting, reactivaciones,
  mensajes posteriores ni marcadores `rstkad_id`; los anuncios posteriores se
  conservan como touches del historial (`whatsapp_api_attribution`, sesiones o
  mensajes sociales) para conversiones.
- Si un mensaje de WhatsApp trae `source_id` oficial y tambien
  `rstkad_id=<ad_id>!`, el backend compara ambos contra `meta_ads` en el dia
  local del negocio: gana el unico ID que exista ese dia; si ambos existen, gana
  el `source_id` oficial; si ninguno existe, queda el oficial como default y el
  payload crudo se conserva para auditoria/backfill.
- Reportes en vista `Identificados de anuncios` y Publicidad miden registros por
  `contacts.created_at` + `contacts.attribution_ad_id`, validando que el anuncio
  exista en `meta_ads` el mismo dia local de creacion del contacto. Por eso ese
  `ad_id` debe quedarse congelado como origen de registro. En Publicidad, los
  conteos de interesados, citas, asistencias y ventas y el modal que abre cada
  cifra deben reutilizar el mismo rango, nivel (campana, conjunto o anuncio),
  atribucion, calendarios y deduplicacion por persona. Un fallo al cargar el
  detalle debe mostrarse como error; nunca debe degradarse a una lista vacia que
  parezca un resultado valido.
- El backend agenda un backfill automatico versionado para datos historicos de
  WhatsApp API sin bloquear el arranque: `repairWhatsAppApiContactIdentityFromMessages({ limit: 0 })`
  corre en segundo plano cuando falta
  `app_config.whatsapp_api_first_ad_attribution_backfill_version` y marca esa
  version al terminar. Si la version ya esta aplicada, el arranque omite la
  barrida historica. Si detecta que un contacto quedo atribuido a un retouch
  posterior, restaura el primer anuncio real del historial sin borrar los
  touches posteriores. Tambien corrige touches historicos cuando el
  `detected_source_id` guardado venia del candidato incorrecto y el marcador
  `rstkad_id` si coincide con el anuncio vivo de ese dia.
- El Viaje del contacto en la ficha debe titularse con el nombre configurable de
  la cuenta (por ejemplo, `Viaje del paciente`) y mostrar cada actividad con una
  etiqueta legible: visitas, contactos, WhatsApp, Messenger, Instagram, correo, citas y
  compras. Si un evento trae metadata de mensaje social o email, el tooltip debe
  explicar canal, contenido, perfil/usuario, estado e identificadores utiles; no
  debe quedarse como "Evento" sin detalle. Los mensajes de WhatsApp se resumen
  en un solo marcador por dia local; si el mismo dia existe un WhatsApp directo y
  otro atribuido a anuncio, gana/fusiona el atribuido para conservar el origen
  sin duplicar la entrada del cliente. Los eventos de Messenger/Instagram se
  resumen por dia local, plataforma y tipo de accion (`message` vs `comment`).
  Asi un DM y un comentario del mismo dia no se pisan entre si, pero cinco
  comentarios del mismo dia siguen contando como un solo punto de comentario.
  Los marcadores visuales de Messenger e Instagram deben diferenciar DM privado
  vs comentario con iconografia de plataforma y accion, no con el mismo glifo
  generico para todo. Un comentario usa como icono principal una publicacion y
  muestra abajo el badge del canal real: Facebook para publicaciones de pagina e
  Instagram para publicaciones de Instagram; nunca el badge de Messenger.
- El historial conversacional del modal de contacto no debe tratar el Viaje del
  Cliente como si fuera chat completo. Para pintar burbujas usa
  `/contacts/:id/conversation`, de modo que reciba solo mensajes reales de
  WhatsApp, Meta social, email y tarjetas conversacionales como confirmaciones de
  cita por IA. El journey completo vive en `/contacts/:id/journey`, sigue siendo
  la linea de actividad/atribucion del CRM y puede incluir visitas, contacto
  creado, citas, pagos y compras.

Los contactos alimentan reportes, automations, chat, pagos, citas y conversiones.

## Chat y mensajeria

Ristak maneja varias superficies de comunicacion:

- Bandeja desktop.
- Chat movil.
- WhatsApp API oficial por YCloud.
- WhatsApp Cloud API oficial por Meta directo, incluido Coexistence.
- WhatsApp QR/Baileys como transporte separado y fallback cuando aplica.
- Meta social messaging.
- Email.
- Eventos live para sincronizar UI.

La mensajeria usa servicios especializados para plantillas, media, atribucion,
sincronizacion de conversaciones, read states, presencia y eventos.

La bandeja de chats debe resolver primero los mensajes de WhatsApp que ya tienen
`contact_id` directo y reservar la búsqueda por teléfono exclusivamente para
filas heredadas sin identidad. Una cuenta con historial grande no debe
materializar todo el historial para volver a resolver contactos ya conocidos:
ese patrón puede agotar el timeout del endpoint `/api/contacts/chats` y dejar
vacías las apps móviles durante su primera carga.

La bandeja no agrega las tablas históricas completas en cada apertura. La
proyección durable `chat_message_activity` registra exactamente una fila por
mensaje de WhatsApp, Meta o email, incluso para estados excluidos y mensajes aún
sin contacto; `chat_contact_activity` mantiene el resumen global por contacto y
`chat_contact_scope_activity` el resumen por línea de negocio. WhatsApp conserva
la prioridad de identidad `message.contact_id > api_profile.contact_id >
MIN(contacto por teléfono)`. Cada mensaje pertenece a un solo scope canónico:
`id:<phoneNumberId>` cuando existe catálogo y `phone:<E.164>` sólo cuando no lo
hay, por lo que filtrar por una línea no duplica mensajes relacionados por ID y
teléfono. Inserts, cambios y borrados actualizan ledger y summaries en la misma
transacción; cambiar teléfonos, perfiles o aliases marca una cola generacional
durable y reproyecta por lotes sin perder cambios concurrentes.

El endpoint usa siempre esas proyecciones. Durante el primer backfill o una
reparación de identidad sirve el snapshot materializado disponible y añade
`performance.activityProjection=warming` con `complete=false`; nunca vuelve a
agrupar mensajes ni resolver teléfonos contra todo el historial dentro del GET.
El worker arranca después de las migraciones, el scheduler de sistema reintenta
estados pendientes fuera del request y, al llegar a `ready`, la misma lectura
queda completa. Una página normal sale del índice
`last_message_sort + contact_id`; una vista por varias líneas toma candidatos
acotados por cada scope, consolida sólo esos contactos y después hidrata por llave
primaria un máximo de tres mensajes por conversación (último, primer inbound y
último inbound). Así el costo depende de la página visible y no de los millones
de mensajes guardados.

El contrato canónico de proveedores, webhooks, IDs, Coexistence y soporte vive
en [integrations/WHATSAPP_PROVIDER_ARCHITECTURE.md](./integrations/WHATSAPP_PROVIDER_ARCHITECTURE.md).
Todo registro WhatsApp debe distinguir `provider` (`ycloud`, `meta_direct` o
`qr`), `transport` (`api` o `qr`) y `source_adapter` (`ycloud`, `meta_direct` o
`baileys`). YCloud y Meta directo comparten el modelo interno, no credenciales,
endpoints, nombres de webhook ni columnas de ID específicas. Baileys nunca debe
presentarse como proveedor de API oficial.

Al enviar, el `phoneNumberId` elegido manda. El backend toma `provider`, teléfono
emisor, WABA y disponibilidad desde esa fila; la preferencia global histórica
`whatsapp_api_provider` no puede convertir un envío YCloud en Meta ni viceversa.
Una fila solamente QR usa Baileys. Si el mismo teléfono también tiene una fila
oficial sana, API conserva prioridad aunque una ruta histórica solicite QR; esa
sesión queda como respaldo. Si la API está indisponible y ese mismo número tiene
respaldo QR listo, el mensaje puede salir por QR únicamente cuando la solicitud
lo autorizó. La ventana de 24 horas, una plantilla no aprobada, errores de
contenido o destinatario, `131047`, `131053`, timeout, red o HTTP 5xx jamás
autorizan Baileys. La ventana cerrada exige plantilla oficial. Sólo una
indisponibilidad inequívoca del transporte (desconexión, autorización perdida,
suspensión/restricción o límite confirmado) permite el respaldo. Cuando Meta
pierde permisos, sólo su fila queda inactiva y YCloud/QR continúan operando.

Esta prioridad es independiente del orden de conexión. Cuando termina de
conectarse cualquier proveedor registrado como API oficial, el backend marca esa
fila como remitente principal y conserva cualquier QR del mismo teléfono como
respaldo sin cerrar su sesión. Así, QR seguido de YCloud/Meta directo queda
operativamente igual que YCloud/Meta directo seguido de QR. Los adaptadores
oficiales futuros deben pasar por la misma reconciliación central; HighLevel no
participa porque sólo se usa cuando el usuario elige explícitamente su canal.

El chat desktop y `/movil` también resuelven la disponibilidad por la fila
seleccionada. El `connected` superior del status corresponde a la conexión
histórica de YCloud; Meta directo se valida con
`phone.availability.apiAvailable` y `metaDirect.connected`. Si HighLevel y una
fila nativa de WhatsApp coexisten, elegir esa fila conserva la ruta nativa:
HighLevel sólo puede manejar WhatsApp cuando el usuario elige explícitamente
`WhatsApp · HighLevel`, nunca como fallback silencioso de una fila
indisponible. Con HighLevel conectado, el selector agrega `WhatsApp · HighLevel`
y consulta el inventario activo de LC Phone para mostrar cada remitente SMS como
`SMS · <etiqueta> · <numero>` sin ocultar las filas nativas. Elegir un SMS pasa
su `fromNumber` a HighLevel en texto, adjuntos, audio y programación. Si el token
instalado todavía no tiene `phonenumbers.read`, o HighLevel no devuelve números,
el selector conserva `SMS · HighLevel` como fallback y deja que la cuenta resuelva
su remitente predeterminado. Cada selección limpia o conserva el remitente nativo
según la ruta elegida, de modo que el envío salga por el proveedor visible. La
ruta WhatsApp HighLevel se liga al `business_phone` del ultimo inbound
`transport=ghl_whatsapp` verificado de la conversacion; durante una sesion activa
no inventa una lista de remitentes usando LC Phone. La ventana de 24 horas se
calcula para ese numero usando solamente inbounds dirigidos al mismo
`business_phone`; un
  inbound Meta Direct, YCloud, QR o de otro numero no abre esa ventana. Si esta
  cerrada, el backend responde `HIGHLEVEL_WHATSAPP_REPLY_WINDOW_CLOSED`; si no
  puede verificarla responde `HIGHLEVEL_WHATSAPP_REPLY_WINDOW_UNKNOWN`. En ambos
  casos conserva la ruta solicitada y nunca convierte el envio a SMS. Texto,
  adjuntos, audio, reacciones y programación mantienen esa misma decisión de
  proveedor.

Los envíos por HighLevel nunca incluyen el remitente de una fila nativa de
WhatsApp. `WhatsApp · HighLevel` usa el `fromNumber` verificado de la conversacion;
una fila SMS explicita incluye su propio `fromNumber`. El endpoint
`/api/highlevel/phone-numbers` es exclusivamente LC Phone/SMS y responde
`source=lc_phone`, `channels=['sms']`; jamás alimenta rutas WhatsApp. Si el `ghl_contact_id`
guardado ya no existe, Ristak busca o recrea el contacto por teléfono/correo,
persiste el vínculo reparado y reintenta el envío una sola vez únicamente ante
`CONVERSATIONS_CONTACT_NOT_FOUND`.

Un HTTP 2xx de HighLevel sin recibo durable, incluso `sent`, `pending` o `queued`,
significa aceptacion del proveedor, no entrega al destinatario. El espejo local
conserva `pending` hasta que webhook o sync publique el estado durable
`sent/delivered/read/failed`; el mismo evento SSE reconcilia el globo optimista.
El loader de `/chat`, `/movil` y el chat del modal de contacto representa sólo la
peticion local que todavía no termina (`sending`/`enviando`). En cuanto el
proveedor acepta la solicitud, los estados `pending`, `queued` o `processing`
deben mostrarse como enviados y dejar de girar, aunque la base conserve el
estado pendiente para esperar el recibo final. Un `delivered/read` posterior
actualiza el acuse y un `failed` posterior reemplaza esa confirmacion visual con
el error real y su motivo limpio de `message.error`; la UI nunca debe esconder
ese rechazo. Los inbounds sincronizados guardan `from_phone`, `to_phone` y
`business_phone` desde el payload HighLevel para que selector, ventana y ultimo
remitente compartan la misma identidad.

Para un mismo contacto, WhatsApp y SMS de HighLevel forman una sola decisión de
salida del agente conversacional. La última selección manual de **WhatsApp ·
HighLevel** o **SMS · HighLevel** hecha en el selector de `/chat` o `/movil` se
persiste por contacto en `contact_conversational_channel_preferences`; un envío
manual por una de esas rutas también actualiza la preferencia. `GET/PUT
/api/contacts/:id/chat-channel-preference` exponen esa elección al chat. La
preferencia manual manda hasta que el usuario elija el otro medio, sin que una
respuesta automática del agente la reescriba.

Si no existe selección manual, la ruta automática usa WhatsApp cuando hay un
inbound real `ghl_whatsapp` del mismo teléfono ocurrido hace menos de 24 horas;
al vencer esa ventana usa SMS. Un inbound que llegó sólo por SMS no se descarta:
el agente conserva ese mensaje como contexto, pero entrega la respuesta por
WhatsApp si la ventana sigue abierta. Si HighLevel materializa el mismo inbound
en `ghl_whatsapp` y `ghl_sms` con el mismo teléfono y contenido dentro de 90
segundos, el agente procesa únicamente la fila del medio ganador. La copia
WhatsApp de ese par no puede reabrir por sí sola una ventana vencida. El runner
revalida esta decisión después de su debounce y otra vez justo antes de entregar,
incluidos los seguimientos, para impedir una salida simultánea por ambos medios.
Las firmas operativas que HighLevel agrega al espejo `TYPE_CUSTOM_SMS`, como
`[Received on ...]` o `Sent from another device (...)`, se eliminan antes de
comparar el contenido. La fila firmada no despierta otra ejecución del agente y
se colapsa en la conversación visible, aunque permanece guardada como evidencia
cruda del proveedor. Dos envíos reales idénticos conservan sus dos burbujas.

Los estados del runtime siguen separados por canal para conservar claims y
entregas aisladas, pero `GET
/api/conversational-agent/states/:contactId?includeAll=1` entrega como máximo
una asignación activa/pausada por `agent_id`. Los clientes móviles también
agrupan por `agent_id` como defensa: una fila WhatsApp y otra SMS del mismo
agente no significan dos agentes activos. Una acción humana sin canal explícito
(`pause`, `take_over`, `skip`) se aplica a todas las filas de ese agente para el
contacto; nunca debe requerir varios toques para apagar el mismo agente en
WhatsApp y SMS.

Un webhook sólo concilia estado y puede marcar la API como restringida para
solicitudes futuras; nunca origina por sí mismo un reenvío QR. Campañas y
acciones masivas usan `allowQrFallback=false`: si la API falla, el lote registra
el error y se detiene sin derramarse a Baileys.

En Meta directo, la respuesta síncrona de Graph se guarda como el mensaje
saliente real con su texto, `wamid`, `meta_message_id`, `contact_id` y
`localMessageId`. Los objetos `value.statuses[]` de webhook son solamente ACK de
`sent`/`delivered`/`read`/`failed`: actualizan esa fila por `wamid` y jamás se
renderizan como otro globo. Si un ACK gana la carrera y llega antes del INSERT,
queda como recibo `message_type=status` invisible y se transforma en el mensaje
real cuando termina el POST. Conversación, bandeja y frontend filtran cualquier
residuo `status` para que una fila antigua vacía no vuelva a aparecer como
`Mensaje`.

En `Configuración > WhatsApp`, la opción **WhatsApp API** ofrece conexiones
separadas. El botón **Conectar WhatsApp** precarga Embedded Signup v4 desde el
backend del tenant. Meta detecta automáticamente el flujo por el número: si ya
está activo en WhatsApp Business usa Coexistence y conserva la app; si es nuevo
lo registra directo en Cloud API. Ambos casos usan la
misma pestaña para pasar por el dominio central autorizado y abren una sola
ventana oficial de Meta; al terminar regresan a
`/settings/whatsapp/numbers` sobre el mismo origen donde empezó el usuario, para
conservar su sesión aunque la instalación tenga dominio personalizado y dominio
Render. Ese origen viaja firmado y debe coincidir con una de las URLs registradas
de la instalación; el JSSDK nunca se ejecuta desde el dominio del tenant;
**YCloud** conserva su formulario de API key. La página intermedia de Installer
queda sólo como fallback para clientes anteriores. Meta valida el WABA y el
número, guarda el token cifrado sólo en
la base de esa instalación y activa
`meta_direct`; el broker central enruta webhooks por WABA sin mezclarlos con
YCloud ni con las sesiones QR/Baileys. Si la entrega final al tenant falla,
Installer conserva temporalmente el resultado cifrado y una sesión nueva de la
misma instalación lo retoma sin volver a autorizar ni exponer el token al
navegador.

Al regresar de una conexión Meta exitosa, la pantalla abre un modal para
configurar el método de pago de ese WABA. El usuario elige **Configurar después**
como acción de texto o **Configurar ahora** como acción principal. La segunda
abre la configuración de WhatsApp Business en Meta con el Business ID y WABA ID
de la conexión directa; Ristak no recibe ni guarda los datos de la tarjeta. Si se
pospone, la liga sigue disponible en Más acciones > Configurar pagos de Meta. El
aviso pertenece solo a Meta directo y nunca debe mostrarse al conectar YCloud.

Meta exige un sitio web por defecto. La casilla **Mi empresa no cuenta con sitio
web ni una página de perfil** sólo aparece para Solution Partners Select o
Premier aprobados para Partner-led Business Verification; no se habilita por
usar un número nuevo ni desde el frontend. Hasta que Ristak reciba esa
aprobación, la interfaz debe explicarlo sin prometer que el sitio puede omitirse.

La app se suscribe al WABA durante la conexión. Si Meta directo lleva al menos
30 minutos sin recibir webhook/relay, el siguiente envío renueva de forma
idempotente `/{WABA_ID}/subscribed_apps`, con una espera mínima de seis horas
entre intentos. Esa reparación sólo recupera la escucha de Meta: no reenvía el
mensaje, no activa Baileys y no mezcla credenciales de YCloud.

El ACK de conexión exige acceso operativo real: el token debe ser de usuario de
sistema, conservar los dos permisos de WhatsApp y listar el Phone Number ID
dentro del WABA. Los tokens de Meta Ads/Facebook/Instagram permanecen separados
y no pueden reemplazar la credencial `whatsapp_meta_direct_*`. Si Meta retira el
activo después, Ristak marca esa fila como `reconnect_required`, apaga su envío
API y pide reconectar con un mensaje legible; el historial y la configuración de
YCloud/QR permanecen intactos.

Cada número tiene en la última columna acciones separadas para **Meta Directo**,
**YCloud** y **QR**. Desconectar ahí sólo retira esa conexión de Ristak: no borra
ni desregistra el número real en Meta, YCloud o WhatsApp. Una fila oficial puede
conservar su respaldo QR, o viceversa, sin mezclar credenciales ni apagar la otra
conexión. Los mensajes, contactos y plantillas históricas permanecen; los nuevos
eventos API de una fila retirada se ignoran localmente hasta que el usuario la
conecte otra vez de forma explícita.

Las plantillas usan el proveedor API activo. Con Meta directo se administran en
Graph bajo `/{WABA_ID}/message_templates`; con YCloud se usan sus endpoints
propios. El modelo neutral y la UI se comparten, pero IDs remotos, estados,
payloads y handles multimedia permanecen etiquetados por proveedor.

El selector de canal del composer desktop muestra cada WhatsApp con su número
exacto además de la etiqueta o nombre verificado. Dos filas del mismo negocio no
pueden verse idénticas; la opción elegida conserva su `phoneNumberId`, lo guarda
como remitente preferido de ese contacto y por tanto mantiene su proveedor y
transporte reales al reabrir el chat en desktop o móvil. Si no se puede guardar,
la UI restaura el número anterior y no finge que el cambio quedó aplicado.

Cuando el agente conversacional envia una respuesta, los servicios de salida
deben persistir la marca `sentByAgent`/`agentId` en el payload local y el journey
debe exponerla como `sent_by_agent`/`agent_id`. `/chat`, `/movil`, `mobile/` e
iOS usan esa marca para pintar un icono de robot fuera del globo, en el lateral
del mensaje segun su direccion. La meta interna del globo conserva `API`, `QR`,
hora y vistos; el robot no debe volver a mezclarse dentro de esa fila.

La bandeja desktop de Chat (`/chat` y subrutas) es una superficie de trabajo
propia y no debe montar el globo global del Asistente Personal AI, para no tapar
el historial, composer ni acciones rapidas del chat. El asistente interno sigue
disponible desde la pestaña principal `Chatbot`, seccion `Configuracion`, y
desde `Configuración > Inteligencia Artificial`.

El historial de `/chat` conserva una textura punteada ligera, con los puntos
espaciados para que el fondo se sienta limpio y no compita con los mensajes.

Los avisos flotantes de `/chat` desktop usan el mismo `NotificationContext` y el
mismo `ToastContainer` global del resto del CRM, anclado al lado derecho. Chat no
debe mover ese contenedor con atributos o estilos especiales por ruta. Los avisos
ajustan textos largos sin aumentar el ancho del documento. El historial de la
conversacion solo admite desplazamiento vertical: globos, errores, menus y
contenido del mensaje nunca deben crear scroll horizontal. El detalle de error
de cada mensaje se abre hacia el interior del hilo (a la izquierda para mensajes
salientes y a la derecha para entrantes), con ancho limitado al viewport.

En `/chat` desktop y `/movil`, el avatar del contacto no debe llevar aro,
contorno ni relleno coloreado por red social. La identidad del canal vive en el
badge inferior derecho usando los mismos assets WebP de canal que `mobile/` e
`ios/app` (`whatsapp`, `facebook`, `messenger`, `instagram`, `gmail`), pintados
como iconos libres sin disco, borde, brillo ni contenedor circular extra.

El color del globo se resuelve por mensaje con el mismo contrato de identidad en
`/chat`, `/movil`, React Native Android e iOS. En tema claro, todo mensaje
entrante es blanco y solo los salientes usan color: WhatsApp API lleva un verde
claro, WhatsApp QR un verde apenas mas oscuro, Messenger/Facebook azul e
Instagram morado rosita. En tema oscuro, las cuatro superficies pintan entrantes
en carbon y usan equivalentes profundos para cada canal saliente; texto, hora y
estados pasan a una paleta clara de contraste y nunca se fuerza internamente
`colorScheme` claro. Correo, SMS y canal desconocido se mantienen neutrales.
`api`, `qr` o `smtp` no se interpretan como plataforma por si solos: primero se
considera el canal social real y despues, solo para WhatsApp, el transporte
API/QR. Mensajes programados mantienen ademas su borde punteado y los fallidos
conservan prioridad visual de error.

En `/chat` y en el chat movil bajo `/movil`, el historial de conversacion acepta
drag and drop de archivos. Mientras el usuario arrastra archivos sobre el area de
mensajes, la superficie se cubre con un overlay borroso con borde punteado y el
texto `Suelta aquí tu contenido multimedia`; al soltar, los archivos se agregan
como adjuntos del composer antes de enviar, para que el usuario pueda escribir
texto o agregar mas archivos.
El correo queda fuera de este flujo hasta que su manejo de adjuntos se cierre en
la superficie de email.

La apertura de una conversacion prioriza siempre `GET /contacts/:id/conversation`:
en cuanto llegan los ultimos 50 mensajes se pinta el hilo y se fija el ultimo
mensaje sin animacion. Mensajes programados, perfil, estados/resumenes del agente
y marcadores de negocio se hidratan despues y no pueden retener ese primer paint.
El panel derecho conserva la ficha disponible del contacto mientras esa
hidratacion termina en segundo plano: no inserta avisos temporales de
`Actualizando` ni cambia la geometria del panel al cambiar de conversacion.
Pagos/citas usan `GET /contacts/:id/journey?chatActivityOnly=true`, una lectura
ligera que consulta en paralelo solo pagos, citas y confirmaciones; no recorre
sesiones, video, atribucion ni el historial de mensajes. El resultado se conserva
en la cache diaria de la conversacion y se reconcilia en refresh silenciosos.

El layout de media del timeline es estable antes de descargar: las superficies
web reservan imagenes 4:3, videos 16:9 y audios/archivos de altura fija; iOS usa
un canvas visual unico 252x189 para foto y video desde el placeholder hasta el
contenido final. Si el primer payload iOS solo declara `messageType=image|video`
y todavia no incluye `attachment` o URL, el globo ya debe reservar ese canvas;
el refresh que materializa el archivo conserva la geometria y no agrega un pie
temporal con `Foto` o `Video`. La miniatura se prepara fuera del hilo principal,
se reutiliza al reciclar la fila, se ajusta dentro de ese espacio y el original
se abre en el visor interno. `/chat` y `/movil` desactivan el scroll anchoring
automatico del navegador y mantienen el
anclaje inferior mientras se hidrata el chat; un gesto real del usuario hacia
arriba libera el anclaje inmediatamente. Cargar fuentes, fotos, audio o previews
no debe cambiar la posicion visible ni disparar correcciones temporizadas.

Los mensajes de correo dentro del historial del chat desktop, el modal de
contacto y el chat movil `/movil` deben renderizarse como globo desplegable de
email, no como texto plano mezclado con WhatsApp/Meta. El resumen muestra icono
de correo, direccion enviado/recibido, asunto y destinatario principal. Al
desplegar, el globo debe mostrar los campos estructurados del correo, incluyendo
`Asunto`, `Remitente`, `Destinatarios`, `Responder a`, `Estado`, `Transporte`
cuando existan y el `Cuerpo` completo a partir de `message_text` o `html_body`
sanitizado.

Los mensajes de ubicacion de WhatsApp/API y QR deben renderizarse como mapa
limpio tanto en `/chat` desktop como en `/movil`. El frontend normaliza payloads
con `location_latitude`/`location_longitude`, `location`, `locationMessage`,
`whatsappMessage.location`, `whatsappInboundMessage.location`, `response.location`
o `request.location`; el globo muestra tiles de OpenStreetMap, pin y accion de
abrir Maps sin una franja secundaria de titulo/coordenadas dentro del mensaje.
Si el texto recibido solo dice `location` o `Ubicacion`, se oculta para no
duplicar el contenido debajo del mapa.

En `/chat` desktop, los mensajes entrantes de WhatsApp, Messenger o Instagram
que vienen de un anuncio deben mostrar una vista previa compacta del anuncio
dentro del globo antes del texto del contacto. Esto aplica por mensaje: si el
mismo contacto vuelve por otro anuncio semanas despues, ese nuevo globo tambien
muestra su propia vista previa; un mensaje organico intermedio no debe heredarse
la atribucion vieja del contacto. La tarjeta se arma con `is_ad_attributed`,
`referral_source_id`, `referral_ctwa_clid`, `referral_source_url`,
`referral_headline` y `referral_body`, pero `headline`/`body`/`source_app`/
`entry_point` no son senal suficiente por si solos. En WhatsApp la preview solo
se dispara con referral CTWA real de YCloud o Meta directo (`ctwa_clid`,
`source_id`/`ad_id` con
senal de anuncio), `is_ad_attributed=true` o el marcador Ristak; `transport='api'`
o `source_app='api'` nunca deben pintar anuncio. En Messenger/Instagram salen del
`referral_json` de `meta_social_messages` (`ad_id`, `source='ADS'`,
`ads_context_data`). Si Meta
incluye `ads_context_data.photo_url` o `ads_context_data.video_url`, el backend
los expone como media/thumbnail del anuncio para que la tarjeta tenga material
visual aunque todavia no exista una fila sincronizada en `meta_ads`. Cuando
WhatsApp entrega `image_url`/`thumbnail_url` dentro de su `referral_json`, Ristak
los expone tambien en el evento del chat y, si apuntan a CDN temporal de Meta,
guarda una copia estable en el storage de chat antes de conservar el referral.
Asi el globo no depende de que `fbcdn` siga aceptando la misma URL dias despues.
Cuando
el backend ya enriquecio el evento con `meta_ads`, usa
`creative_image_url`/`creative_thumbnail_url`, `creative_preview_url`,
`ad_account_id`, campana, conjunto y nombre del anuncio. En `/chat`, `/movil`,
`mobile/` e `ios/app`, el CTA "Ver anuncio" debe abrir primero el preview real
de Meta; si falta, debe abrir Ads Manager con `ad_account_id` + ID del anuncio;
y solo como ultimo respaldo puede usar `referral_source_url` cuando sea una URL
externa. Nunca debe usar una URL same-origin de Ristak como CTA del anuncio. Si
no hay senal real de anuncio, el chat no debe inventar previews ni decorar
mensajes directos. Como fallback
operativo para WhatsApp, si el texto recibido contiene el marcador
`rstkad_id=<ad_id>!`, Ristak extrae solo los digitos entre `=` y `!`, lo trata
como `referral_source_id` de anuncio y oculta ese marcador del texto visible del
mensaje en el contrato de backend compartido por desktop, `/movil`, Android e
iOS. Si el marcador viene envuelto como `(rstkad_id=<ad_id>!)`,
`[rstkad_id=<ad_id>!]` o `{rstkad_id=<ad_id>!}`, también se elimina la envoltura
completa para que el globo no deje `()`, `[]` ni `{}` vacíos. El texto real del
contacto se conserva y el ID continúa disponible en los campos de atribución y
en la vista previa del anuncio. El `!` es obligatorio para no atribuir por
accidente otros números que el contacto haya escrito.

El chat desktop (`/chat`) y el chat movil (`/movil`) permiten responder un
globo especifico y reaccionar a mensajes recibidos cuando el canal expone
soporte nativo. En movil la respuesta a un globo normal se activa deslizando la
burbuja hacia la derecha, igual que el flujo de comentarios: en mensajes
normales abre la cajita/preview de respuesta del composer; en comentarios de
publicaciones mantiene la respuesta publica al comentario. En desktop, las
reacciones no aparecen al pasar el cursor: se abren con click derecho sobre el
globo recibido, mostrando una tira horizontal de emojis rapidos y, cuando el
canal lo permite, un boton `+` que despliega el picker de emojis frecuentes. La
reaccion debe enviarse como reaccion nativa apuntando al `provider_message_id`
de ese mensaje, no como un mensaje normal con emoji. La UI desktop solo debe
mostrar esos iconos si el mensaje pertenece a una ruta nativa conectada y
compatible; mensajes sincronizados desde HighLevel, email, SMS, webchat y
comentarios no deben abrir el picker de reaccion. WhatsApp API/YCloud envia
respuestas con
`context.message_id` y reacciones con `type='reaction'`; WhatsApp QR/Baileys usa
el mensaje citado (`quoted`) y `react.key`. Messenger e Instagram nativos usan
`reply_to.mid` para respuestas y `sender_action='react'` para reacciones; en
Meta la reaccion soportada por contrato es corazon (`love`). HighLevel, email y
comentarios no deben simular quote/reaccion si la API del canal no lo soporta:
la UI debe avisar al usuario y mandar un mensaje normal solo cuando cancele la
respuesta seleccionada. El journey debe exponer `provider`, `provider_message_id`,
`reply_to_provider_message_id`, `reaction_emoji` y
`reaction_target_provider_message_id` para que las burbujas de `/chat` y
`/movil` pinten el quote y peguen el emoji al globo correcto. Visualmente, las
reacciones visibles en `/chat`, `/movil`, `mobile/` e iOS deben mostrarse como
emoji suelto pegado al globo, sin fondo, borde, sombra ni pill/contenedor.

Cuando el usuario abre o marca como leida una conversacion movil, el estado local
se actualiza en `chat_read_states` y el backend debe encolar en background el
acuse externo del canal cuando exista soporte nativo: WhatsApp API/YCloud usa
`/whatsapp/inboundMessages/{id}/markAsRead` con `wamid` o id de YCloud,
WhatsApp API/Meta directo usa Graph `PUT /{PHONE_NUMBER_ID}/messages` con
`status='read'` y el `wamid` entrante,
WhatsApp QR/Baileys usa `sock.readMessages([{ remoteJid, id, fromMe }])`, y
Messenger/Instagram usan `sender_action='mark_seen'`. Correo no participa en
este contrato porque no es chat conversacional. El acuse externo puede tardar,
fallar o agotar timeout sin bloquear la respuesta local del chat, pero debe
quedar registrado en logs porque no equivale a visto real del proveedor.
Si la fila del número conserva API oficial activa, su QR asociado es respaldo y
no puede mandar un segundo acuse de lectura por Baileys.
Configuracion > Privacidad guarda
`app_config.chat_send_read_receipts_enabled`: si esta apagado, Ristak conserva
el marcado local como leido, pero no manda acuses externos de visto a WhatsApp
API/YCloud, WhatsApp QR/Baileys, Messenger ni Instagram.

En el chat movil, el selector de canal del composer no debe mostrar rutas
fantasma: lista cada numero de WhatsApp conectado como opcion separada y envia el
`phoneNumberId` elegido en texto, adjuntos, ubicacion y mensajes programados.
Si HighLevel está conectado, esas opciones nativas coexisten con
`WhatsApp · HighLevel` y una fila por cada número SMS activo de HighLevel; elegir
una de esas filas aplica su `fromNumber`, y elegir cualquier ruta HighLevel no
arrastra el `phoneNumberId` nativo anterior. Sin permiso/catálogo de números se
mantiene el fallback `SMS · HighLevel`. Elegir un WhatsApp nativo desde el botón
inferior guarda `preferred_whatsapp_phone_number_id` en el contacto; `/movil`,
React Native Android e iOS deben abrir después con el mismo remitente. En iOS el
botón vive en el panel inferior antes de `+`, además del acceso equivalente
dentro de la ficha del contacto. Messenger/Instagram aparecen cuando el
proveedor correspondiente está conectado y el contacto pertenece a ese canal.
La resolucion inicial es comun: preferencia explicita, ultimo numero inbound,
ultimo numero usado y finalmente default. Guardar la preferencia es best-effort:
si la ficha responde `404` o hay una falla transitoria, la seleccion de esta
sesion sigue siendo autoritativa y el envio no se bloquea ni vuelve al canal
anterior. Los catalogos locales conservan el ultimo snapshot valido y admiten un
solo retry acotado; nunca consultan Meta ni HighLevel en loop.

Los comentarios de Facebook e Instagram son un canal publico distinto de
Messenger/Instagram DM. Si un contacto nace desde un comentario, el composer debe
mostrar el canal `Comentario de Facebook` o `Comentario de Instagram` y enviar
la respuesta como comentario publico en la publicacion. Si el humano cambia el
canal a Messenger o Instagram DM, el texto se manda como respuesta privada al
comentario. Si ya existia una conversacion privada y despues llega un comentario,
la conversacion sigue en Messenger/Instagram DM; el canal publico solo aparece
cuando ese comentario es el ultimo mensaje entrante del contacto. Si despues del
comentario el contacto manda un DM, responder en la publicacion exige tocar el
boton `Responder en la publicacion` del globo de comentario exacto.

### Correo electronico

Configuracion > Integraciones > Correos conecta envio por SMTP y recepcion por
IMAP desde un solo formulario. La recepcion queda activa por defecto: para Gmail,
Workspace, Outlook, Yahoo, iCloud, Zoho, Titan y proveedores comunes Ristak
detecta host, puerto, seguridad y bandeja sin pedirselo al usuario. Los ajustes
manuales de recepcion solo deben mostrarse para proveedores personalizados que
entregan datos IMAP propios. La configuracion vive en
`app_config.email_smtp_config`; el app password se guarda cifrado en
`app_config.email_smtp_password` y se reutiliza para SMTP e IMAP cuando el
proveedor lo permite. No se agregan secrets ni env vars nuevas para recibir
correo.

La recepcion IMAP se configura dentro de
`app_config.email_smtp_config.inbound` (`enabled`, `host`, `port`, `security`,
`username`, `mailbox`, `createContactsFromUnknownSenders`, cursor `lastSeenUid`
y timestamps). Al conectar, Ristak valida SMTP y, salvo que el usuario desactive
explicitamente la recepcion, tambien abre la bandeja IMAP antes de marcarla como
conectada. La pantalla permite probar recepcion, buscar correos manualmente con
`/api/email/inbound/test` y `/api/email/inbound/sync`, y guardar el ajuste de
contactos nuevos con `/api/email/inbound/settings`.

El job `email-inbound-sync` esta registrado como cron de integracion externa y
solo arranca cuando el detector local confirma correo conectado, app password
guardado e IMAP activo. El sync lee `INBOX` por UID, mantiene cursor incremental,
importa una ventana reciente en la primera ejecucion para no volcar buzones
historicos completos y primero busca un contacto existente por email normalizado.
Si encuentra contacto, guarda el correo en `email_messages` con
`direction='inbound'` y `provider='imap'`, y publica el evento live del chat para
que aparezca en la bandeja, en el modal del contacto y en `/movil`. Si el
remitente no existe y `createContactsFromUnknownSenders` esta apagado (default),
Ristak no crea contacto ni guarda ese correo, aunque si avanza el cursor IMAP
para no reprocesarlo indefinidamente. Si el ajuste esta encendido, crea el
contacto con `source='email_inbound'` y guarda el correo en su historial.

Los adjuntos manuales del chat soportan imagenes, videos, audios y documentos
compatibles. Si un video o audio cabe como media directa, la UI pregunta si debe
mandarse como video/nota de voz o como archivo. Si excede el limite de media
directa pero cabe como documento, se clasifica automaticamente como archivo. En
WhatsApp API/QR los adjuntos usan las rutas nativas de imagen, video, audio o
documento segun esa decision; las notas de voz de WhatsApp se preparan y envian
como OGG/Opus (`audio/ogg; codecs=opus`) cuando el canal requiere nota de voz.
Independientemente del formato que exija el proveedor, Ristak debe persistir una
copia publica reproducible en el historial (`media_url`, MIME y nombre de
archivo), usando MP4/M4A cuando haga falta para que `/chat`, `/movil`, `mobile/`
y la app iOS puedan volver a reproducir audios salientes despues de recargar. El
M4A nativo de iPhone puede ser detectado por magic bytes como `audio/x-m4a`;
`mediaStorageService` debe normalizar ese alias a `audio/mp4` antes de validar y
guardar el preview compartido por los envios WhatsApp API y QR. En
clientes nativos (`mobile/` e `ios/app`), cualquier `media_url` relativo
(`/media/...`) debe resolverse contra la URL base del tenant antes de pintar la
burbuja, visor o archivo compartido; `Image`/`URL(string:)` no deben recibir
rutas sin host. En
`/chat` desktop, las burbujas de media deben mostrar solo el contenido principal:
foto/video completo, audio con icono/control del lado izquierdo o mapa completo.
En iOS, foto y video son full-bleed: el contenido forma la superficie completa
del globo, conserva una puntita visible y superpone hora, transporte y acuse en
la esquina inferior; video superpone tambien su duración. El scrubber de las
notas de voz usa holgura lateral para que la bolita en 0:00 y al final no parezca
adelantada ni recortada dentro del globo. En las superficies web, la hora,
etiqueta de transporte, vistos y razones de ruteo viven fuera/debajo de la
burbuja para no crear columnas internas. Los errores de envio no se escriben
dentro del globo: se muestran como icono externo con detalle en tooltip. En
Messenger/Instagram nativo, el chat desktop y `/movil` envian por Meta texto,
imagen, video y audio/nota de voz; Messenger tambien admite documentos. Se
pueden mandar varios adjuntos en secuencia. Si Meta nativo y HighLevel estan
conectados al mismo tiempo, la ruta se decide por el perfil y transporte reales
del contacto: una conversacion `ghl_messenger`/`ghl_instagram` conserva
HighLevel y una fila nativa de `meta_social_contacts` usa Meta. Nunca se fuerza
Meta solo porque la integracion global este encendida. El mensaje privado mas
reciente de la plataforma elegida prevalece sobre el hint global del contacto,
para que un Instagram de HighLevel no desvie un Messenger nativo ni al reves.
El texto que acompana media se envia como mensaje separado
porque Send API no admite caption dentro del adjunto. Cada elemento conserva su
estado optimista y un fallo parcial solo restaura al composer el texto/archivo
que no salio.

La frontera `prepareMetaSocialOutboundMedia` es compartida por chat directo y
Automatizaciones. Lee los bytes reales del data URL o descarga con proteccion
SSRF la URL externa, valida tipo/tamano, normaliza imagen a JPEG compatible,
video a MP4 H.264/AAC y todo audio (incluidos MP3, OGG y WebM de Chrome)
a M4A/AAC `audio/mp4`, lo publica en el storage multimedia y solo entonces manda
una URL publica HTTPS a Graph. Messenger e Instagram no exponen `ptt` ni
`voice=true`: una nota de voz se representa como
`message.attachment.type='audio'`, aunque Ristak conserva `voice` como metadata
interna para mostrarla correctamente. La burbuja queda con `media_url`, MIME y
nombre reproducibles despues de recargar.

Instagram aplica su contrato antes del POST: imagen JPG/PNG (GIF cuando Meta lo
admita) hasta 8 MB ya preparada, audio normalizado y video normalizado. Su Send
API no ofrece documentos/PDF salientes; cualquier archivo se detiene antes de
Graph con una explicacion clara. El editor tampoco ofrece `Documentos` cuando el
composer usa Instagram nativo; un audio o video conserva su tipo multimedia en
vez de degradarse a archivo.
Messenger admite imagen, audio, video y archivos compatibles. El limite de
entrada de esta tuberia es 25 MB y los formatos que requieren conversion pueden
quedar sujetos a un limite menor despues de comprimir.
El chat usa `POST /api/whatsapp-api/meta/social/messages/attachment` para
imagen/video/archivo y conserva la ruta especializada `/audio` para voz/audio.
Estas rutas de Messenger/Instagram requieren `campaigns` y acceso al modulo
`chat`; el montaje `/api/whatsapp-api` las excluye de la compuerta externa
`whatsapp`, por lo que no dependen de `whatsapp` ni `whatsapp_api`.

En Automatizaciones, los bloques de mensaje de WhatsApp, Messenger e Instagram
pueden consistir en un solo adjunto: imagen, video, archivo de audio, nota de
voz o archivo, sin requerir un bloque de texto. WhatsApp conserva el tipo real
de imagen/video/documento y el bloque `Nota de voz` se envia como voz (OGG/Opus
cuando el proveedor lo necesita), separado del bloque `Audio`, que se manda como
archivo reproducible. Messenger recibe imagen, video, audio y documentos;
Instagram recibe imagen, video y audio mediante `message.attachment` con una URL publica HTTPS. Si el bloque
trae texto opcional, Ristak lo manda como el siguiente mensaje porque Meta no
admite caption dentro del payload de adjunto. Los assets cargados en
automatizaciones se resuelven desde su URL pública CDN al asset interno antes de
enviar. Así una foto WebP ya cargada se manda por la misma ruta de conversión a
JPEG compatible que usa el chat normal, un video MOV/WebM se vuelve MP4 y un
MP3/OGG se vuelve M4A antes de llegar a Meta; no se reenvían bytes crudos por
confiar en la extensión.
El editor no repone un bloque de texto vacío: al borrar el último bloque el flujo
queda vacío hasta que el usuario agregue explícitamente texto, imagen, video,
audio, nota de voz, archivo o retraso; esta regla aplica igual a WhatsApp,
Messenger e Instagram.
Cuando un bloque de audio o nota de voz ya tiene archivo, su tarjeta dentro del
lienzo muestra un reproductor compacto, nunca la URL técnica del CDN. Ese
reproductor y el de la configuración usan la misma instancia de reproducción por
archivo: pausar, avanzar o reproducir desde cualquiera refleja el mismo estado en
ambas vistas. Es un control propio basado en los tokens activos de Ristak, por lo
que conserva el modo oscuro y no depende de los controles blancos del navegador.
Las notas de voz de Automatizaciones pasan por la misma preparación del chat
directo: WhatsApp API recibe un OGG real con códec Opus y la marca de voz; el
transporte QR/Baileys valida los límites y segmentos de las páginas OGG y los headers
`OpusHead`/`OpusTags`, y usa además `ptt=true`; no confía únicamente en el MIME
declarado ni en encontrar dos cadenas dentro del archivo. Messenger e Instagram
no exponen un flag equivalente de PTT, por lo que una nota de voz se entrega como
adjunto de audio reproducible. Tanto el chat de escritorio como el chat móvil
envían la grabación por el canal activo de Instagram/Messenger, sin exigir un
teléfono ni desviarla a WhatsApp. Para YCloud, Ristak convierte y valida los bytes
como OGG/Opus canónico: una sola pista mono a 48 kHz, Opus para voz, frames de
20 ms, mapping family 0 y sin metadata heredada del MP3/M4A/OGG fuente. Incluso
un OGG/Opus ya válido se regenera en esta frontera para que chat directo y
Automatizaciones produzcan el mismo binario. Luego se sube al endpoint de media
con `audio/ogg; codecs=opus` —YCloud documenta que el MIME base `audio/ogg` sin
codec no está soportado— y se envía el Media ID resultante con `voice=true`. No
se usa el importador de links
de YCloud para notas de voz: en producción ese importador reclasificó como
`application/octet-stream` un OGG/Opus válido y Meta devolvió `131053`. El chat
nativo y Automatizaciones comparten esta misma ruta; los flujos externos primero
descargan el archivo con los límites y protecciones de red y después lo preparan.
Antes de reutilizar un asset de Automatizaciones, el runtime valida que sus bytes
sí sean audio reconocible; un MP3/M4A legacy o un OGG anterior se normaliza antes
del upload. WhatsApp QR/Baileys y el multipart de YCloud usan
`audio/ogg; codecs=opus`; el proxy HTTP público usa el MIME base `audio/ogg` con
una URL y filename `.ogg`, además de bytes Opus validados. Todo asset de voz
administrado por Ristak conserva el
proxy público `/media/assets/:id/voice.ogg` para reproducción y respaldo QR:
valida los bytes, responde con `audio/ogg`, usa una URL terminada en `.ogg` y un
`Content-Disposition` cuyo filename también termina en `.ogg`. Nunca debe
conservar ahí la extensión original `.mp3`
después de convertir el archivo: mezclar bytes/MIME OGG con filename MP3 deja un
contrato contradictorio para el procesador de media del proveedor.
YCloud conserva el envío por su cola asíncrona con filtros de desuscritos y
bloqueados. Si Meta devuelve `131053`, la nota permanece fallida en transporte
API y no se reenvía por QR. Meta Direct usa `audio.link` con `voice=true` a
través de Graph API, porque no atraviesa el importador de YCloud.
El bloque **Audio** conserva byte por byte los formatos normales que WhatsApp
acepta (MP3/MPEG, M4A/MP4, AAC, AMR y OGG/Opus); WAV y WebM se normalizan a
M4A/AAC reproducible, nunca a Opus/PTT. En WhatsApp API se envía sin `voice=true`
y en WhatsApp QR/Baileys con `ptt=false`. El bloque **Nota de
voz** sí usa OGG/Opus y `voice=true`/`ptt=true`. Messenger e Instagram no exponen
un flag PTT: ambos tipos viajan como `attachment.type=audio`, pero Ristak conserva
la distinción en su historial y evita degradar un audio normal.
Como WhatsApp tampoco admite caption dentro de un audio, el texto opcional del
bloque se envía inmediatamente después como un mensaje separado.
Las URLs públicas existen exclusivamente para que los proveedores puedan descargar
el contenido; el endpoint/proxy mantiene MIME, `nosniff` y fuerza la descarga de
tipos no seguros.

Cuando el usuario toca contenido enviado o recibido dentro del chat (`/chat`,
`/movil` o `mobile/`), Ristak debe abrirlo primero en su propio modal de enfoque,
no redirigir de inmediato a la URL del archivo. Imagenes y videos se ven dentro de
la app; documentos, archivos y enlaces muestran una ficha/preview interna con
accion explicita para abrir fuera cuando haga falta. Ubicaciones y links de pago
pueden mantener su salida externa porque su accion principal ocurre en Maps o en
checkout.

En el chat movil, si el usuario abre la camara desde la bandeja sin estar dentro
de una conversacion, la captura de foto o video abre un selector de destinatarios.
Ese selector debe permitir elegir uno o varios contactos, escribir un caption,
mostrar una mini-preview del media tomado y conservar los badges del canal del
contacto (WhatsApp, Messenger, Instagram, email o SMS) para que el humano sepa
por donde esta hablando antes de enviar. Cuando el teclado iOS se abre sobre ese
selector, el composer inferior debe subir usando la altura nativa `--phone-kb`
para que el caption y el boton de envio sigan visibles.

La lista de chats se carga por lotes de 50 conversaciones. Al abrir una
conversacion, el frontend usa `/contacts/:id/conversation` para pedir solo los
ultimos 50 mensajes combinados del hilo (`messageLimit`) y conserva el historial
ya visible durante refresh silenciosos. Si el usuario sube al inicio de la
conversacion, la UI pide otro bloque anterior usando `beforeMessageDate`; no
debe precargar el historial completo de todas las conversaciones de la bandeja.
Con `chat_message_activity` lista, esa ruta selecciona por indice los IDs
ganadores de WhatsApp, Meta y email usando exactamente el cursor publico
`(message_sort, cursorKey)` y luego hidrata sólo esas filas. Mientras la
proyeccion no este `ready`, conserva el match legacy por identidad/telefono para
no dejar instalaciones en blanco. Ambos caminos respetan un deadline de 8 s,
propagan `AbortSignal` hasta la base y cancelan al desconectarse el cliente; un
timeout responde `CHAT_CONVERSATION_TIMEOUT` en vez de dejar queries zombis.
Las ramas auxiliares `whatsapp_attribution` y `appointment_confirmation` se
mantienen y participan en el orden/limite global.
Desktop Chat conserva una sola hidratacion activa por contacto aunque coincidan
el efecto inicial, SSE, polling, foco o una accion manual. Cambiar de contacto o
salir de `/chat` aborta fisicamente conversacion, journey, detalle, programados,
estado y eventos del agente; descartar un resultado viejo en React no sustituye
esa cancelacion. Marcar leido ocurre una vez al abrir un contacto con pendientes
y comparte el POST en vuelo por contacto. Las reconciliaciones silenciosas no
vuelven a mandar `/read` ni duplican toda la cadena de hidratacion.
En la primera conexion de `mobile/`, si esa cuenta todavia no tiene snapshot
local ni la marca namespaceada `mobile:first-sync:completed`, la ruta critica
termina al obtener y guardar la primera pagina de conversaciones. Android
solicita el inbox primero, muestra progreso solo para cuenta, conversaciones y
copia local, y deja configuracion/directorio a sus efectos normales en
background. Si falla esa pagina, termina de forma degradada: abre la app y
reintenta silenciosamente, en vez de encerrar al negocio en un loader. Tras
completar —incluso con cero chats o con ese fallback— la marca evita repetir el
progreso mientras exista esa cache.

`ios/app` no usa overlay de bootstrap. Mantiene el shell montado, pinta cualquier
snapshot de inmediato y solicita inbox/directorio en paralelo. Numeros, labels,
integraciones, flags y etiquetas llegan despues en una tarea satelite que
construye un snapshot puro y solo lo aplica si siguen coincidiendo task ID,
namespace, generacion y sesion, y si no fue cancelada. Logout o cambio de cuenta
elimina snapshots y generaciones; ningun resultado viejo puede entrar a la nueva
sesion. Este flujo no contradice la paginacion: no descarga todos los mensajes de
todos los hilos al dispositivo.
Al entrar a un chat nuevo, desktop, `/movil`, `mobile/` e iOS presentan el
timeline en el ultimo mensaje disponible. Ese anclaje inicial se mantiene
mientras termina la hidratacion de caché, mensajes, media y actividad; no usa
animación para corregir una posición intermedia. Al insertar mensajes antiguos
arriba del hilo, la UI debe conservar la posición visible del usuario y nunca
forzar scroll al último mensaje.
En iOS, abrir o cerrar el teclado no reutiliza el ancla inicial como política de
redimensionamiento: si el usuario estaba abajo, el hilo estabiliza el centinela
inferior antes y después de la animación real de UIKit. Esto evita que el
`LazyVStack` apunte a una región no materializada y deje temporalmente invisibles
las burbujas mientras se escribe.

El mismo contrato aplica al chat dentro del modal de contacto: debe usar
`/contacts/:id/conversation` para no mezclar eventos de viaje, visitas, compras
o contacto creado dentro del historial de WhatsApp/Meta/email. Las tarjetas
`appointment_confirmation` con accion `chat_card` si pertenecen al hilo y se
incluyen en ese endpoint. Para los marcadores inline de `Pago completado`,
`Cita agendada` y `Cita confirmada`, las superficies de chat pueden consultar
además `/contacts/:id/journey` de forma secundaria: solo se extraen pagos/citas,
se ordenan dentro del timeline y nunca se convierten visitas u otros eventos de
CRM en burbujas. Si esa lectura secundaria falla, se conserva la actividad
conocida y se reintenta en la siguiente reconciliación; una respuesta vacía
autoritativa sí puede retirar marcadores que ya no existan.

La recepcion rapida de mensajes de chat usa `/api/chat-events/stream` como
camino principal en desktop (`/chat`), movil web (`/movil`), cliente nativo
React Native (`mobile/`) y app iOS Swift. El evento SSE `chat_message` no
transporta el mensaje completo, pero sus metadatos minimos permiten que el
cliente nativo promueva y actualice la fila local inmediatamente antes del
refetch silencioso y coalescido. Para entrantes nuevos, el servicio de canal debe
persistir primero el incremento de `chat_read_states` y publicar despues; ese
incremento es un UPSERT atomico para todos los usuarios activos y una falla se
registra sin invalidar el mensaje ya guardado. WhatsApp y Meta reservan ademas
`channel + message_id` en `chat_inbound_message_claims` dentro de la misma
transaccion del unread: dos webhooks concurrentes no pueden incrementar ni
publicar dos veces. Un import historico crea el claim sin sumar unread. Despues
de escribir el frame, el
stream intenta flush inmediato para no dejarlo retenido por buffers. El polling
queda como red de seguridad adaptativa, no como camino principal. Android usa
30 s durante desconexion y 2 min con SSE sano tanto en bandeja como en hilo. iOS
usa 25 s durante desconexion, 2 min para la bandeja conectada y no mantiene poll
periodico del hilo conectado. Tras una desconexion real, ambos clientes
emiten una sola reconciliacion; la primera conexion no se trata como reconexion
ni duplica el bootstrap. En iOS, si el GET inicial fallo con el stream sano, se
permite una sola recuperacion silenciosa. El poll fijo anterior de 12 s/4 s queda
prohibido.

SSE, push y polling comparten un gate. Una rafaga admite como maximo dos GET
inmediatos: peticion primaria/actual y un follow-up. Si llega otro evento durante
ese follow-up, conserva un dirty bit y agenda un unico trailing a 500 ms; los
nudges del cooldown se coalescen. Teardown, background y cambio de contacto,
API, cuenta o sesion cancelan timers y generaciones viejas. Si se pierde el
stream por proxy, reconexion o app suspendida, la recuperacion ocurre sin spinner
ni salto de scroll.

En mensajes entrantes de QR, YCloud y Meta Direct, persistencia, unread y SSE se
confirman antes de esperar push. QR y YCloud disparan la entrega best-effort
fuera de su ruta critica. Meta Direct inserta un job `push` en el outbox backend
`chat_delivery_outbox` dentro de la misma transaccion que reclama el inbound;
el ACK del relay no espera APNs, FCM ni Installer. No confundir esta tabla con el
outbox local de mensajes optimistas de cada app.

APNs, FCM y OAuth FCM locales tienen deadline end-to-end de 8 s, incluida la
lectura del body; Web Push usa el mismo timeout. Installer central conserva su
propio presupuesto end-to-end de 5 s en `licenseService`. La seleccion por
usuario ocurre en SQL mediante indices `(enabled, user_id)`. Un token se invalida
solo por razones permanentes explicitas del proveedor, no por cualquier `400`.
Un fallo transitorio total o parcial mantiene el job pendiente y restringe el
siguiente intento a los IDs exactos de suscripcion/device que fallaron. Los
skips `apns_not_configured`/`fcm_not_configured` tambien son reintentables. Si
falla la comprobacion de contactos ocultos, la entrega durable reintenta; la
ruta best-effort conserva fail-closed para no exponer datos sensibles.

Meta Direct encola `push` y `meta_enrichment` como jobs independientes con
unicidad `(job_kind, message_id)`, lease, heartbeat y backoff. Push y
`meta_enrichment` tienen lanes/locks separados: Graph, descarga o Storage no
bloquean la notificacion. Push admite hasta 20 intentos con backoff acotado a
5 min. `meta_enrichment` admite hasta 2,016 intentos, aproximadamente siete dias
con ese backoff, para sobrevivir caidas largas de Graph/Storage; al agotar su
politica queda `failed`/dead-letter con `failed_at`. Un replay real del webhook
puede revivir solo ese enrichment con payload nuevo, nunca una push terminal. El
enriquecimiento actualiza la misma fila, publica `isNew=false` y termina no-op si
ya estaba hidratada. Un fallo reintenta el job, no el relay ni el unread.

Este outbox es at-least-once, no exactly-once. Un crash o una entrega parcial
multi-device puede repetir una notificacion. `messageId`, tag y collapse se
mantienen estables para reducir duplicados donde el proveedor o sistema operativo
lo soporte. Al completar o entrar en dead-letter, `payload_json` se reemplaza
inmediatamente por `{}`; solo queda metadata operativa durante 7 dias para
`completed` y 30 dias para `failed`. Los jobs pending/reintentables siguen
durables.

La limpieza terminal corre como maximo una vez por hora, dentro del lock de
push, y procesa lotes de hasta 500 filas por categoria. El scrub defensivo de
payloads legacy y la purga por retencion no barren toda la tabla cada 10 s.

Las lanes de `push` y limpieza forman parte de la infraestructura del sistema y
permanecen siempre activas,
incluso si Meta Direct se desconecta despues de confirmar el inbound. Solo
`meta_enrichment` se registra como cron de integracion y se enciende mientras la
conexion local Meta Direct siga valida, sin depender del proveedor de envio
activo. Conectar/desconectar sincroniza esa lane. El avatar inbound se rehospeda
despues de la persistencia inicial. Citas, automatizaciones y agente corren
post-ACK como best-effort registrado en deploy drain; un crash abrupto aun puede
cortar esos side effects sin deshacer el mensaje confirmado.

Los cambios que afectan datos secundarios del hilo usan el mismo stream con el
evento `chat_data_changed`; no se disfrazan como mensajes nuevos. Para mensajes
programados, el backend publica el dominio `scheduled_messages` solamente
despues de persistir una creacion, edicion, cancelacion o cambio de estado del
scheduler. Desktop, `/movil`, Android e iOS invalidan la lista programada del
contacto y la leen de nuevo inmediatamente. Este nudge no mueve la conversacion,
no suma no leidos y, en Android, salta exclusivamente el throttle de 30 segundos
de programados sin convertir el journey completo en una consulta frecuente.

La app SwiftUI `ios/app` usa los metadatos minimos del SSE y de cada envio
optimista para promover de inmediato la fila del contacto al inicio, incluso si
el hilo esta cubriendo la bandeja en iPhone. Deduplica la misma actividad cuando
llega por ambos caminos y luego reconcilia texto, perfil, contadores y orden
contra REST. Si el usuario inicio el chat desde el directorio, conserva esa fila
completa como seed y la inserta arriba con el primer envio aunque aun no estuviera
en la primera pagina. Un SSE de un chat viejo fuera de la profundidad cargada
consulta primero el indice ligero local y, si falta, resuelve solo ese contacto
con `picker=true&contactId=<id>`; las rafagas se coalescen por contacto y el
refresh completo queda como respaldo. La seleccion explicita de un telefono
alterno se conserva por cuenta para no cambiar el destinatario al reabrir, pero
se bloquea hasta validarla contra el inventario fresco y se elimina si ya no
pertenece al contacto. Una pagina REST vieja no se considera ACK por el solo
hecho de incluir la fila; cada actividad se compara con el estado/fecha del
servidor y la señal de hilo visible gana al deduplicar. Los
refresh vivos de bandeja mandan
`warmProfilePictures=false` para no consultar proveedores externos en cada
poll/SSE. Incluso cuando un arranque frío solicita calentamiento, la lista
responde con fotos cacheadas y el backend encola las faltantes en segundo plano,
en tandas deduplicadas; ninguna llamada a YCloud/QR forma parte del tiempo de
respuesta de chats, contactos o búsqueda.
El hilo iOS abre el stream antes de esperar conversacion, journey, contacto y
catalogos. Si llega un `chat_message` durante ese bootstrap, guarda un unico
nudge pendiente y ejecuta una reconciliacion REST coalescida en cuanto la carga
base queda lista; no pierde el evento ni crea otro polling. Status de WhatsApp e
inventario HighLevel se leen en paralelo desde Ristak, con un retry corto y el
ultimo snapshot valido como respaldo.
La codificacion de fotos, videos, audios y documentos corre fuera del hilo
visual, el composer bloquea enviar mientras prepara y el tray conserva el limite
de 4 adjuntos con tope acumulado de 40 MB binarios. La app sube el multipart
desde archivo temporal a Media Storage/CDN y envia la referencia del asset; no
duplica el body completo en memoria ni persiste el preview optimista como base64.
Cuando el eco ya trae una URL HTTP(S) valida libera el binario local de la
imagen; los `data:` legacy nunca entran al snapshot del hilo.
La limpieza cubre tanto `attachment.url` como `attachment.dataUrl`, y una URL CDN
elimina cualquier copia base64 paralela en memoria.
Cada subida usa `clientUploadId` y el backend reserva una llave idempotente antes
de comprimir para que reintentos concurrentes reproduzcan el mismo asset; la
reserva se renueva con heartbeat ligado al owner durante Storage/Stream y su
identidad v2 incluye la cuenta. Una fila legacy solo se reproduce si el asset
completado se valida nuevamente contra esa misma cuenta.

Los selectores iOS de nuevo chat, cita y pagos usan
`/contacts/search?picker=true`: hidratan inmediatamente el snapshot de la cuenta,
revalidan sin bloquear y no vuelven a pedir la bandeja de chats. El backend
omite agregados de pagos/citas y calentamiento de avatares, limita el payload y
devuelve todos los telefonos del contacto junto con las señales mínimas del
último mensaje (`lastMessageChannel`, tipo, transporte y fecha) para pintar el
badge de canal sin recalcular la bandeja completa. Si WhatsApp o Meta ya tienen
una foto persistida, el directorio la devuelve sin I/O externo; iOS también
rellena URLs ausentes con el último avatar válido del snapshot de la bandeja.
Por ello los selectores de cita y pagos mantienen paridad visual con Nuevo chat
y solo recurren a iniciales cuando realmente no existe una foto conocida. Solo una consulta con forma real de
telefono puede producir `matchedPhone`; digitos dentro de un nombre no cambian
el destinatario.
El cache de queries exactas es LRU en memoria; solo los recientes se guardan en
disco y la persistencia queda deshabilitada hasta tener usuario verificado.
Las precargas y escrituras detached tambien llevan generacion de sesion, por lo
que logout/relogin a la misma cuenta no puede revivir un snapshot anterior.

En `Info del contacto`, `/movil`, `mobile/` e `ios/app` revalidan el detalle de
forma silenciosa y no muestran un loader encima del avatar. La sección de campos
personalizados se construye exclusivamente desde definiciones activas creadas o
configuradas por el usuario; valores huérfanos y definiciones de sistema o de
integraciones no se presentan aunque existan dentro del JSON del contacto. El
nombre del negocio (`business_name`, `business.name` o “Nombre del negocio”) es
perfil de la cuenta —se administra en Configuración > Negocio—
y nunca se presenta como campo personalizado del contacto, aunque un catálogo
legacy omita sus banderas de sistema. La
acción para inscribir en una automatización publicada vive inmediatamente debajo
de Etiquetas. Los Ajustes móviles permiten crear y eliminar tanto definiciones
de campos personalizados como etiquetas usando los endpoints canónicos de
`/api/settings/custom-fields` y `/api/contact-tags`.

El hilo iOS muestra el bloque de `/contacts/:id/conversation` en cuanto llega;
agente, programados y datos secundarios no pueden taparlo con un spinner. Para
despliegues graduales conserva fallback a `/journey`. La salud se mide con
`mxSignpost` agregado por `MetricKit` y eventos `OSLog`; un ring local acotado
guarda solo categoria, resultado, duracion, conteos e hitos de push sanitizados.
La suite incluye unit tests de promocion de filas/estado inicial, una carga del
reductor real con 10,000 contactos, XCUITest sin red, smoke real opt-in y un
soak UI sintetico de 10,000-50,000 filas.

Cuando llega una push de chat o el usuario abre `/movil` desde esa notificacion,
el cliente debe priorizar el hilo afectado sobre la bandeja completa. La push web
o nativa propaga `contactId`, `messageId`, `title` y `body`; el chat movil pinta
una burbuja provisional inmediata con ese texto y luego la reconcilia contra el
refetch canonico del servidor. Si el `messageId` coincide, el mensaje real
reemplaza el preview sin duplicarse; si aun no llega, el preview solo vive unos
minutos y nunca se escribe en el cache diario como fuente final.

En el chat movil bajo `/movil`, los filtros de la bandeja viven en la fila de
chips bajo el buscador. No debe existir un dropdown aparte de `Numero / Ver
todos` ni una preferencia de ajustes para juntar/separar numeros. El chip `+`
administra los filtros visibles: `Agregar` manda el filtro a la fila rapida y lo
guarda en `app_config.mobile_chat_filter_chip_ids`; `Quitar` lo saca de esa fila.
La biblioteca incluye filtros rapidos, comentarios, cada WhatsApp conectado y
los filtros avanzados equivalentes a desktop (canal, origen, red social, etapa y
actividad). El filtro por numero simple sigue mandando
`businessPhoneNumberId`/`businessPhone` a `/contacts/chats`; solo cambia la
superficie desde donde el usuario lo controla. `Comentarios` debe ir separado
visualmente de `Interesados` con la misma linea divisoria que usa la bandeja
desktop. Los filtros condicionales guardados viven en
`app_config.mobile_chat_custom_filter_presets`, aparecen como chips normales,
pueden combinar reglas con modo todas/cualquiera, soportan numero de WhatsApp,
segmento, canal, origen, red social, etapa, actividad, etiquetas y campos
personalizados, y pueden editarse o eliminarse desde el mismo panel.

Las fotos de perfil de contactos WhatsApp se guardan en
`whatsapp_api_contacts.profile_picture_url`, no en el perfil del numero de
negocio. Cuando entra un mensaje nuevo del contacto, el backend intenta refrescar
ese avatar de forma oportunista y best-effort: primero reusa la ruta API/YCloud
si trae perfil, y si no alcanza usa WhatsApp QR/Baileys para consultar
`profilePictureUrl` del JID del contacto. La lectura respeta un cache minimo de
24 horas por contacto (`profile_picture_updated_at`) para no golpear WhatsApp en
cada mensaje; si la privacidad del contacto, la sesion QR o el proveedor no
entregan foto, Ristak conserva el avatar anterior o cae a iniciales. Si un
refresh QR falla y la foto guardada es una URL temporal de WhatsApp
(`pps.whatsapp.net`), el backend la limpia para que no quede una imagen caducada
en la base. Las listas de contactos y chats pueden pedir
`warmProfilePictures=true` para encolar la hidratación y guardado de avatares,
pero devuelven primero la página con el mejor avatar ya cacheado. La cola está
acotada, deduplica contacto y procesa tandas de ocho fuera del request; el avatar
nuevo aparece en refrescos posteriores sin provocar timeouts. Para corregir contactos ya existentes
sin esperar a que vuelvan a escribir, el endpoint protegido
`POST /api/whatsapp-api/contacts/profile-pictures/backfill` ejecuta un backfill
manual sobre el CRM completo por default (`scope: all_crm`): cualquier contacto
activo con telefono puede intentar avatar porque la libreta conectada pertenece
al negocio. Busca primero por API/YCloud, luego por QR/Baileys en tandas
pequenas, y guarda el resultado en `whatsapp_api_contacts.profile_picture_url`.
Si un operador necesita limitarlo a perfiles previamente relacionados con
WhatsApp puede mandar `scope: whatsapp_only`, pero no es el comportamiento
normal. Al conectar o refrescar WhatsApp API/YCloud, el sync de contactos dispara
este backfill en segundo plano; al abrirse una conexion WhatsApp QR/Baileys, el
controller tambien dispara un backfill `all_crm` de avatares faltantes con
debounce por numero para no repetirlo en cada reconexion. El frontend tambien
debe ocultar cualquier imagen de avatar que dispare `onError` y mostrar
iniciales en su lugar.

Antes de mandar mensajes libres por una API oficial, `whatsappApiService` debe
resolver primero la fila del número elegido y revisar la ultima respuesta
entrante del cliente para ese contacto y numero de negocio. Si la ventana de 24
horas sigue abierta, los envios manuales del chat deben salir por la API oficial
de esa fila aunque el frontend haya pedido `transport='qr'` por un calculo local
incompleto. Si la ventana ya esta cerrada o no existe una respuesta entrante
comprobable, no debe intentar un mensaje libre ni cambiar a QR: debe solicitar
una plantilla oficial. QR sólo es primario cuando la API de ese número está
indisponible o cuando se trata de un número QR standalone. Desktop y movil deben calcular el
transporte antes de pintar el mensaje optimista, pero el backend es la autoridad
final para evitar tanto que un QR previo secuestre conversaciones API como que
una preferencia global vieja cruce YCloud y Meta directo. Las plantillas quedan
fuera de este bloqueo porque son el camino permitido por WhatsApp cuando la
conversacion esta cerrada.

En los chats desktop y movil, el selector para enviar o programar plantillas de
WhatsApp API debe listar solo plantillas con estado `APPROVED`. Las plantillas
rechazadas, pausadas, archivadas, pendientes o en apelacion pueden mostrarse en
las vistas de revision/estado, pero no deben aparecer como opcion seleccionable
en el flujo de envio.

Los mensajes programados del chat deben guardar proveedor/canal de forma
explicita. En movil, WhatsApp usa `provider='whatsapp_api'`; `transport='api'`
permanece mientras la API esté disponible y una hora futura fuera de ventana
exige plantilla. `transport='qr'` sólo corresponde a un número QR standalone o
a una API ya indisponible. SMS usa `provider='highlevel'` con
`channel='sms_qr'`; Messenger, Instagram y correo no se programan desde la app
nativa hasta tener scheduler real para esos canales. Toda mutacion confirmada y
todo cambio final `sent`/`error` publica la invalidacion realtime
`scheduled_messages` despues de escribir la base, para que las demas sesiones
retiren o actualicen el globo programado usando la lectura canonica.

En `/chat` desktop, el campo `Fecha` del modal para programar o editar un mensaje
usa el `<DatePicker>` común y abre un calendario propio de Ristak al hacer clic en
cualquier parte del control. El panel se portalea con la capa de popover del
modal para no quedar recortado o detrás del overlay y no depende de
`input.showPicker()` ni del selector nativo del navegador. Las fechas anteriores
al día de negocio actual quedan deshabilitadas. La fecha seleccionada sigue
siendo una fecha de negocio `YYYY-MM-DD` y la hora se convierte a UTC con la zona
horaria de la cuenta antes de guardarse.

La sincronizacion historica de mensajeria es exhaustiva dentro de lo que cada
proveedor realmente expone y siempre es idempotente. Al vincular WhatsApp QR,
Baileys debe arrancar con `syncFullHistory=true`, aceptar todos los tipos de
`HistorySyncNotification` (incluido `FULL`) y consumir cada bloque de
`messaging-history.set`; no basta escuchar `messages.upsert`, porque ese evento
por si solo deja fuera el historial inicial. Cada bloque reutiliza el pipeline
normal de `captureQrChatMessage`, por lo que conserva direccion, remitente,
timestamp UTC, contenido estructurado, citas/contexto, reacciones y media
descargable (imagen, video, audio, documento o sticker) con dedupe por WAMID. La
media se rehospeda en `mediaStorageService` para que no dependa del dispositivo.
Los bloques historicos nunca deben incrementar no leidos ni disparar push,
automatizaciones, confirmaciones o agente conversacional. WhatsApp decide que
historial entrega a un nuevo dispositivo vinculado; Ristak debe importar todos
los bloques recibidos, pero no puede fabricar mensajes que WhatsApp no envie.
Para el enlace QR, el socket debe identificarse como un navegador real y logico
(`Browsers.macOS('Google Chrome')`); el nombre generico `Desktop` puede ser
rechazado con `428` antes de emitir un QR. Por estabilidad, Ristak deja que
Baileys use la version compatible incluida en el paquete y solo acepta
`WHATSAPP_WEB_VERSION` como override temporal de emergencia: no consulta ni
fuerza la version mas nueva de WhatsApp Web en cada socket.

WhatsApp API/YCloud ejecuta al conectar un sync de contactos, pagina el listado
saliente disponible en `/whatsapp/messages` y reprocesa los eventos
`whatsapp.smb.history`/webhooks ya recibidos para recuperar entradas, salidas,
estados, atribucion y payload crudo. El webhook YCloud debe suscribirse a
`whatsapp.smb.message.echoes`: ese es el evento que refleja los mensajes que el
negocio envia desde WhatsApp Business o un dispositivo companion. Cada
instalacion actualiza esa suscripcion y ejecuta una importacion saliente
idempotente por lotes mediante el cron de integracion `whatsapp-api-history-backfill`.
El cron solo corre con YCloud conectado, guarda la siguiente pagina en
`whatsapp_api_ycloud_history_backfill_state` y retoma despues de deploys o
reinicios sin volver a recorrer el historial completo. Cada lote esta acotado
para no bloquear el arranque ni el drenado de Render; solo al llegar a la ultima
pagina marca la version como terminada. Si YCloud o el webhook fallan, conserva
el punto y reintenta en el siguiente tick mientras la integracion siga activa.
YCloud limita `/whatsapp/messages` a 100 páginas; si el total supera 10,000,
Ristak cierra ese backfill como truncado al procesar la página 100 y conserva los
eventos nuevos por webhook, en vez de solicitar indefinidamente la página 101.
WhatsApp
Cloud API directo no ofrece un
endpoint Graph para descargar retroactivamente toda la cuenta: en ese proveedor
la fuente historica disponible son los webhooks `history` del onboarding,
webhooks/relay nuevos y ecos `smb_message_echoes` de Coexistence. Los lotes
`history` se guardan como importacion: no incrementan no leidos ni disparan push,
confirmaciones, automatizaciones o agente conversacional. La API
`syncMetaDirectHistory` debe reportar
esa limitacion como `not_available`, no fingir una sincronizacion completa.

En Configuracion > WhatsApp > Plantillas y en las burbujas del chat desktop,
modal de contacto, preview telefonico y chat movil, el texto debe respetar la
sintaxis visual que WhatsApp aplica al mensaje: `*negritas*`, `_italicas_`,
`~tachado~`, monospace con triple backtick, inline code con backtick, listas con
`- ` o `* `, listas numeradas con `1. ` y citas con `> `. El texto se guarda y
se copia con los marcadores originales; el formato se aplica solo al pintar el
mensaje para que el humano no lea los delimitadores crudos.

Los botones web de plantillas pueden usar URL fija o URL dinamica. Cuando el URL
incluye `{{1}}`, el editor debe mostrar el selector de dato dinamico y el ejemplo
para Meta en el target `buttons.N.value`, conservar esa binding al guardar y
enviarla como ejemplo al crear la plantilla en YCloud/Meta. Cada boton web acepta
maximo una variable dinamica. Los botones de telefono guardan un numero estatico
en formato internacional y los botones WhatsApp call no llevan variable de URL.

Al conectar WhatsApp API, Ristak crea y repara seis plantillas default en las
carpetas `Recordatorios` y `Pagos`: `cita_programada`,
`recordatorio_cita_un_dia_antes`, `confirmacion_cita_dia_anterior`,
`recordatorio_pago_pendiente`, `comprobante_pago_recibido` y
`pago_fallido_reintento`. El arranque solo garantiza la copia local y nunca llama
al proveedor. La conexion/refresco de WhatsApp y los comandos explicitos
`POST /api/settings/message-templates/repair-defaults` o
`POST /api/whatsapp-api/templates/repair-defaults` comparan esas plantillas contra
la definicion vigente; si una copia existente esta editable, actualizan el
copy/variables/botones y la reenvian a revision como edicion. Los GET de
`/api/settings/message-templates` y `/api/whatsapp-api/templates` son lecturas
locales puras. Si Meta/YCloud la tiene en revision, Ristak no la pisa y espera el
resultado. Las plantillas de pago
usan botones web `PUBLIC_URL/pay/{{1}}`; el ejemplo dinamico del boton sale de
`payment.public_id` o `payment.receipt_path` segun corresponda, nunca de una URL
fija de otra instalacion.

Al reenviar a revision una plantilla que ya existe, Ristak usa la identidad del
proveedor que administra esa copia. YCloud edita por
`wabaId + name + language`; Meta directo edita por `TEMPLATE_ID` con
`POST /{TEMPLATE_ID}`. Si una plantilla pertenecia a YCloud y el proveedor
activo cambia a Meta directo, el ID YCloud no se reutiliza: se crea y guarda una
identidad Meta separada. Si la copia local no tiene identidad remota pero YCloud
responde que ya existe, el submit puede reintentar como edicion por nombre e
idioma. Las plantillas archivadas o en revision no se editan desde Ristak; se
debe esperar el resultado o crear una nueva con otro nombre.

Las columnas neutrales `template_provider`, `provider_template_id`,
`provider_status` y sus campos relacionados son la fuente de verdad para código
nuevo. Las columnas `ycloud_*` son compatibilidad histórica y solo reciben datos
de YCloud. Los webhooks Meta `message_template_status_update`,
`template_category_update` y `message_template_quality_update` actualizan tanto
el catálogo remoto como la copia local, sin fingir eventos YCloud.

Esta separación aplica también fuera del editor: la lista de plantillas, filtros,
bloqueo de edición, envío de prueba y recordatorios de citas leen
`provider_status`, `provider_template_id` y `provider_template_name`. Meta directo
nunca cae a campos `ycloud_*`; esos campos solo sirven al adaptador YCloud y a su
compatibilidad histórica. El contrato interno de envío se llama
`submitToActiveProvider`, resuelve `meta_direct` o `ycloud` explícitamente y no
conserva aliases compartidos con nombre de un proveedor.

La nomenclatura visible separa **WhatsApp API con Meta** de **YCloud**. El
formulario de llave, los botones de conexión/desconexión y la etiqueta del canal
usan el nombre real del proveedor para que una conexión directa de Meta nunca se
presente como YCloud ni una llave de YCloud se presente como Meta Direct.

En plantillas con encabezado multimedia, YCloud usa `header_url`, mientras Meta
directo exige un `header_handle` cargado previamente a Graph. Ristak guarda ese
handle en `meta_header_handle` y jamás convierte una URL YCloud en handle. Hasta
que el flujo de carga Graph entregue un handle real, el adaptador debe rechazar
la solicitud con un error explícito en lugar de mandar una plantilla inválida.
La matriz completa y el mapa de campos viven en
`docs/integrations/WHATSAPP_PROVIDER_ARCHITECTURE.md`.

Cuando una foto, audio o video se envia por WhatsApp API/YCloud usando media ID
del proveedor, Ristak debe guardar una copia de preview/reproduccion en
`mediaStorageService` y persistir su `media_url` en `whatsapp_api_messages`.
WhatsApp no debe recibir ese link si el proveedor acepta media ID, pero el
historial interno si lo necesita para pintar la burbuja del chat en vez de
mostrar solo el nombre del archivo o un audio roto. Las notas de voz son la
excepcion deliberada: conservan un OGG/Opus público para entrega por enlace y
otra variante reproducible para el historial.
Meta Direct nunca usa el upload ni el endpoint de mensajes de YCloud: texto,
plantilla, interactivo, ubicación, foto, documento, video y audio salen por
Graph. Los archivos que nacen como bytes locales se publican primero en el
storage HTTPS de Ristak y Graph recibe su `link`.
Cuando una foto se envia directamente por WhatsApp QR/Baileys desde un archivo
local o `dataUrl`, el envio puede usar el buffer privado de Baileys, pero el
historial interno debe guardar una copia publica de preview en
`mediaStorageService` y persistir `media_url`, MIME y nombre en
`whatsapp_api_messages` para que `/chat`, `/movil` y las apps moviles la puedan
abrir despues de recargar.
Las fotos manuales se reducen a un maximo de 1600 px y JPEG optimizado antes de
subirse cuando la superficie lo permite. El backend repite esa normalizacion
como red de seguridad, reutiliza el mismo buffer preparado para WhatsApp y el
preview, y ejecuta en paralelo la subida al proveedor y a
`mediaStorageService`. No debe enviar la foto original de varios megapixeles a
WhatsApp para despues volver a comprimirla y subirla otra vez.
En `/chat`, `/movil` y las apps nativas, el globo optimista conserva su identidad
y preview local durante toda la sesion abierta. `localMessageId`, WAMID, URL CDN
y ACK se guardan como identidad/estado autoritativo separado y se fusionan en
background dentro de ese mismo globo. El final del POST no debe cambiar la key
visible, recargar toda la conversacion, desmontar la imagen ni mover el scroll;
el siguiente SSE/poll silencioso solo completa los datos remotos.
Si el mismo numero tambien tiene WhatsApp QR/Baileys conectado, Baileys no debe
capturar tráfico vivo inbound ni outbound mientras la API oficial esté
operativa; el webhook oficial es la única fuente y no aparece una burbuja QR
transitoria. Los bloques de HistorySync sí se importan. En históricos, el WAMID
de YCloud/Meta contiene la misma identidad interna que Baileys entrega como
`key.id`; Ristak la guarda en `protocol_message_key_id` y ambos adaptadores hacen
upsert sobre una sola fila.
No se comparan texto, minuto, telefono, tipo de media ni hashes del archivo para
decidir que dos globos son el mismo: dos mensajes iguales o dos envios del mismo
archivo siguen separados cuando WhatsApp les dio IDs distintos. Al arrancar, la
reparacion historica fusiona exclusivamente pares QR + `smb.message.echoes`
demostrables y activa la unicidad que cierra carreras simultaneas.

Los mensajes entrantes estructurados de WhatsApp (plantillas, botones, listas,
OTP/copy-code e interactivos) no deben degradarse a la etiqueta generica
`Mensaje`. En WhatsApp QR/Baileys y WhatsApp API/YCloud, el backend debe extraer
el cuerpo visible, footer y acciones legibles y persistirlos en
`whatsapp_api_messages.message_text` para que `/chat` y `/movil` pinten el mismo
contenido que el usuario ve en WhatsApp.

Cuando una solicitud saliente intenta WhatsApp API oficial por YCloud o Meta
Direct y recibe una indisponibilidad inequívoca, `whatsappApiService` puede usar
el QR asociado al mismo teléfono sólo si esa solicitud tenía
`allowQrFallback=true`. La decisión y el envío ocurren dentro de esa única
solicitud; ninguna capa superior vuelve a interpretar texto de errores y ningún
webhook manda mensajes. Si el proveedor aceptó la solicitud y después reporta
`failed`, se conserva el fallo API: no se crea un segundo envío silencioso.

La ventana cerrada, una plantilla pendiente/rechazada, errores de contenido o
media (`131053`) y errores de conversación (`131047`) no son indisponibilidad de
la API y nunca cambian a QR. Para texto o media fuera de 24 horas, el flujo se
detiene y ofrece una plantilla oficial. Si un fallback legítimo confirma el
envío, el historial registra el transporte real `qr` y la UI muestra un solo
globo; no se oculta una segunda fila para aparentar deduplicación.
Una vez que Baileys devuelve `key.id`, el request manual responde `sent` sin
esperar hasta 20 segundos por `delivered`/`read`. Los ACK posteriores se guardan
en background y actualizan la misma fila; si el ACK llega antes del INSERT, el
backend reintenta esa reconciliacion. Este contrato aplica a texto y multimedia
QR y evita que el composer parezca atorado aunque WhatsApp ya acepto el mensaje.

Cuando no existe ningun remitente oficial de WhatsApp API conectado y existe
un remitente WhatsApp QR/Baileys conectado, las automatizaciones deben tratar QR
como canal principal, no como respaldo. Esto aplica a nodos de WhatsApp en
Automatizaciones, recordatorios/avisos de citas y automatizaciones de pago. Si
la configuracion usa una plantilla, Ristak debe renderizar la plantilla local o
predeterminada como texto limpio, incluyendo URLs de botones, y enviarla por QR
sin exigir aprobacion de Meta/YCloud. El riesgo de usar QR se comunica al conectar
la sesion; las superficies posteriores de citas, pagos y Automatizaciones no
repiten esa advertencia. En nodos de WhatsApp y mensajes automáticos de Citas el
canal ya no depende de un switch manual: si el mismo número tiene API y QR,
Ristak usa API primero y habilita su QR como respaldo estricto de forma
automática. `sendViaQr` y `qr_fallback_enabled` sólo sobreviven para leer flujos
viejos; no pueden forzar QR, apagar el respaldo seguro ni seleccionar un QR de
otro teléfono. Plantilla no aprobada, ventana cerrada y contenido inválido siguen
siendo errores de API y no provocan fallback.

En automatizaciones de pago, si la plantilla configurada esta pendiente,
rechazada, pausada o no sincronizada, Ristak no debe brincar directo a QR. Primero
debe renderizar la misma plantilla como texto limpio, incluyendo el URL real de
los botones web, y mandar ese texto por WhatsApp API/YCloud cuando la ventana de
24 horas sigue abierta. El respaldo QR queda como ultimo recurso cuando WhatsApp
API no puede mandar texto libre legalmente o cuando hay una restriccion
recuperable y el fallback QR esta habilitado.

Si una ruta de envio responde exitosamente pero sin payload de mensaje, el
frontend debe tratarla como aceptada y refrescar el historial, no convertir ese
`null` en un error local del globo.
Los ACK de Baileys pueden llegar despues de que `sendMessage` ya devolvio el id;
ese lapso debe tratarse como pendiente/enviado, nunca como error de la API.
Si el QR esta temporalmente bloqueado por el lease de otra instancia durante un
deploy o reinicio, los envios manuales y los fallback deben esperar y reintentar
la apertura del socket en silencio. Ese lock no debe exponerse como globo rojo
ni como toast de "no se envio" mientras el QR pueda recuperar el control y
confirmar el mensaje.
Durante `SIGTERM`/deploy drain, el proceso viejo debe cerrar sus sockets QR y
liberar el lease de sesion antes de quedarse drenando requests; no debe seguir
renovando el candado mientras la instancia nueva ya esta live.
Al escanear un QR, Baileys puede cerrar con `restartRequired` (`515`): Ristak
guarda primero cada `creds.update` pendiente y solo despues crea el socket nuevo
con esas credenciales. Un `connectionClosed` (`428`) puede ser transitorio: una
sesion previamente registrada conserva su auth y queda en reconexion para que el
watchdog la recupere; un emparejamiento fresco conserva la bandera que impide
revivir credenciales rechazadas. Si el operador vuelve a pedir el QR durante el
backoff automatico, esa accion cancela la espera y abre de inmediato el siguiente
socket usando el mismo lease e intento fresco. No reemplaza un socket sano ni un
QR que ya se esta generando. Solo una regeneracion explicita desde un estado final
de error limpia el auth rechazado y empieza un emparejamiento limpio. Si Baileys
emite un QR pero no se puede convertir en imagen, el estado queda como error
accionable en lugar de dejar el modal girando indefinidamente.

El respaldo QR se resuelve por telefono, no solo por el id exacto del numero API.
Si el numero oficial y la conexion QR quedaron en filas distintas de
`whatsapp_api_phone_numbers`, el backend debe localizar la fila QR del mismo
telefono (`phone_number`, `display_phone_number` o `qr_connected_phone`) y enviar
desde ahi. Tambien cuenta como usable una sesion QR conectada o en reconexion
tecnica (`connected`, `reconnecting`, `restarting`, `connection_replaced` o
`disconnected_*`). Un `bad_session` (`500`) y los `connectionClosed` (`428`) se
reintentan y, si superan el limite de un intento, quedan en `reconnecting` para
que el watchdog los recupere sin borrar auth ni pedir otro QR. Si WhatsApp
reporta `logged_out` (`401`), el dispositivo ya fue desvinculado fuera de
Ristak: se conservan las credenciales, pero hace falta un QR nuevo. Solo una
regeneracion o desconexion solicitada explicitamente por el usuario puede
borrar credenciales. `number_mismatch` requiere escanear un QR nuevo y no se
usa como respaldo automatico.
Los ecos salientes capturados desde WhatsApp normal/QR deben persistir
`business_phone_number_id` resolviendo tambien por `qr_connected_phone`; si se
pierde ese enlace, la app de chats (`/chat`), la ficha de contacto, el chat movil
web y las apps nativas pueden ocultar las respuestas del negocio y dejar visible
solo lo que escribe el contacto. Si WhatsApp Web entrega el chat como LID
(`@lid`) en lugar de telefono, el listener QR debe resolverlo con el mapa de
Baileys antes de descartar el mensaje; esos salientes de WhatsApp normal son
fuente canonica del historial cuando el operador responde fuera de Ristak.

Al agregar un WhatsApp solo por QR desde Configuracion > WhatsApp, el usuario no
debe capturar el numero manualmente. Ristak crea una fila QR pendiente, muestra
el codigo, detecta el telefono conectado cuando WhatsApp Web abre la sesion y
entonces pide el nombre interno para guardar la conexion. Ese flujo standalone no
debe duplicar un telefono que ya existe como WhatsApp API: si el QR escaneado
coincide con un numero oficial existente, el usuario debe conectarlo desde la
fila de ese numero para conservar la validacion estricta. En numeros de
WhatsApp API ligados con QR, el QR escaneado debe coincidir con el numero
oficial esperado; si no coincide, se rechaza como `number_mismatch`.
Los numeros standalone de WhatsApp QR/Baileys pueden eliminarse directamente en
la tabla de Configuracion > WhatsApp: Ristak cierra la sesion QR, borra el auth
state local, limpia preferencias de contactos y quita el numero de
`whatsapp_api_phone_numbers`. Los numeros oficiales de YCloud/Meta no se borran
desde Ristak; deben eliminarse en el proveedor y Ristak los retira de la lista al
sincronizar o recibir el evento externo de eliminacion.

En la ficha de contacto, la pagina de Chat desktop y el chat movil bajo
`/movil`, la informacion del contacto permite elegir el WhatsApp de respuesta
del contacto solo cuando el contacto tiene al menos un telefono guardado. Si el
contacto llego por Messenger, Instagram o correo y no tiene telefono, la UI
oculta esa preferencia porque no existe destinatario de WhatsApp. El modo
automatico usa el numero por donde llego la conversacion cuando existe historial
de WhatsApp; si no hay historial, usa el principal actual. Si el usuario elige un
numero fijo, Ristak guarda
`preferred_whatsapp_phone_number_id` en el contacto y el composer empieza a
enviar desde ese remitente por default. El selector inferior del composer y el
panel/info del contacto son dos accesos al mismo remitente preferido persistente:
ambos incluyen cada WhatsApp conectado como opcion separada y el ultimo cambio
se refleja al reabrir el contacto en `/chat`, `/movil`, Android o iOS.

En las listas de chat, los mensajes del dia actual muestran la hora exacta en la
zona horaria del negocio; no muestran `Hoy` en la fila. Los del dia anterior
muestran `Ayer`, del anteayer hasta antes de una semana muestran el dia de la
semana, y a partir de 7 dias muestran fecha larga en espanol (`29 de junio`,
agregando año solo si no pertenece al año actual). Los separadores dentro del
historial de conversacion pueden seguir usando `Hoy` para agrupar el dia actual.
La bandeja desktop marca mensajes no leidos con el contador numerico y el resaltado
del renglon, sin punto adicional antes del numero.

## Citas y calendarios

Ristak tiene calendarios locales, sincronizacion con HighLevel/Google y flujos
publicos/embebidos para agendar. Antes de tocar logica de fechas o citas lee
`docs/DATE_TIME_GUIDELINES.md`.

Reglas base:

- La zona horaria del negocio manda.
- La base guarda instantes en UTC.
- Fechas de calendario se interpretan en zona del negocio.
- No dependas del timezone del navegador para datos CRM.
- `calendars.open_hours` (API `openHours`) es la fuente de verdad del horario
  semanal. Usa días `0..6` (`0=domingo`) y admite varios rangos no solapados por
  día. `availability_schedule_configured=1` distingue una agenda explícita vacía
  (calendario cerrado) de un registro legacy todavía sin configurar; un formato
  explícito ilegible falla cerrado y nunca inventa disponibilidad.
- Los calendarios existentes sin horario se migran una sola vez al horario legacy
  visible de lunes a viernes, 09:00–17:00. Los calendarios nuevos nacen con ese
  mismo horario explícito para que pueda editarse o apagarse desde el primer uso.
- En Configuración > Calendarios el wizard mantiene este orden: `Detalles`,
  `Disponibilidad`, `URL y Datos`, `Cobro`, `Mensajes automáticos`, `Avanzado`,
  `Eventos` y `Estilos y diseños`. `Disponibilidad` contiene primero el editor
  semanal y debajo duración, cadencia, reglas y espacios entre citas. `URL y
  Datos` reúne el enlace público, formulario y acción posterior al agendado.
- En `Detalles`, `Incluir en reportes comerciales` nace encendido para todos los
  calendarios. Una lista vacía en `app_config.attribution_calendar_ids` significa
  todos —incluidos los que se creen o sincronicen después— y la UI debe mostrar
  ese estado como activo; una lista con IDs es una selección explícita.
- La cabecera de Configuración > Calendarios refleja el estado real de Google:
  cuando la integración está activa muestra un check y `Conectado a Google
  Calendar` sobre un botón verde; cuando no está activa muestra `Conectar con
  Google Calendar` y conserva la acción para abrir la conexión.
- Cada hora del editor semanal se elige en un menú de tres columnas
  (hora, minuto y AM/PM). La selección sólo cambia el rango al pulsar
  `De acuerdo`; cerrar el menú o usar Escape descarta el borrador. Los botones
  `De acuerdo` y `Aplicar` conservan el contraste de texto del botón primario en
  todas las familias y modos del tema. El botón de copiar abre un selector de
  varios días, mantiene marcado y bloqueado el día origen y copia todos sus
  rangos únicamente al pulsar `Aplicar`.
- Al guardar, la UI adopta primero el calendario canónico devuelto por el PUT y
  después espera la recarga del listado. Una respuesta vieja o un GET fallido no
  debe volver a pintar el horario anterior ni convertir el listado en vacío.
- El mismo horario semanal gobierna `free-slots`, URL pública, calendarios
  embebidos/Sites, agente conversacional y los modales web, Android e iOS cuando
  usan el modo `Por defecto`. En el paso `Disponibilidad`, el switch
  `Permitir empalme de citas` persiste `allow_overlaps`: apagado exige un espacio
  sin otra cita y encendido permite varias citas en la misma hora. Esa decisión
  gobierna por igual URL pública, Sites, pagos, selectores normales y agente
  conversacional; ni una bandera del cliente ni un contexto interno puede
  ampliarla. `appoinmentPerSlot` queda sólo como dato legacy y no habilita
  empalmes aunque sea mayor a uno: manda exclusivamente el switch local y un
  refresh de HighLevel no lo pisa.
  El modo `Personalizado` es el override intencional para capturar una hora
  manual y sí puede empalmar otra cita; no puede atravesar una ausencia o
  `blocked_slot` explícito ni crear un rango inválido.
- Los rangos del horario semanal son horas de pared de la zona del negocio. Una
  zona elegida por el visitante sólo cambia cómo se muestran los mismos instantes;
  no desplaza el horario ni se usa para calcular qué espacios existen.
- Toda creación usa el candado/transacción del calendario, incluida una captura
  `Personalizado` que permita empalmar otra cita. Toda reserva pública vuelve a
  validar dentro de ese candado el calendario, horario semanal, ventana, máximo
  diario, bloqueos y política de empalme justo antes del INSERT. Con el switch
  apagado, dos solicitudes simultáneas al mismo espacio no pueden terminar en
  dos citas; encendido, el conflicto con otra cita deja de bloquear, pero no se
  saltan horarios, bloqueos ni máximos diarios. Los flujos con cobro aplican esa
  validación cuando finalmente intentan crear la cita; el pago pendiente no
  reserva el espacio.
- Los calendarios espejados desde HighLevel siguen siendo calendarios locales
  utilizables aunque HighLevel se desconecte. Sus URLs publicas, disponibilidad
  y bookings deben resolverse contra la DB de Ristak; las citas nuevas,
  ediciones y eliminaciones quedan en `sync_status` pendiente/error/
  `pending_delete` y se empujan a HighLevel cuando la integracion vuelva a
  conectarse. Mientras una edición local está `pending` o `error`, un refresh
  entrante de HighLevel no puede pisar su `openHours`; primero se reintenta el
  cambio local y sólo después el espejo vuelve a quedar `synced`. Ese estado
  pendiente no bloquea una edición local posterior: si un PUT trae `openHours`
  explícito, reemplaza el horario guardado; el horario anterior sólo se conserva
  cuando la escritura realmente omite el campo.
- El espejo saliente de calendarios usa el contrato vigente `v3` de HighLevel.
  Antes de crear o actualizar el calendario remoto, `openHours` se canoniza al
  formato de días `0..6` y rangos completos; el domingo legacy `7` se convierte
  en `0` y nunca se manda un horario local ambiguo al proveedor. La creación
  incluye la ubicación requerida, pero una actualización omite `locationId` y
  cualquier identificador inmutable porque HighLevel v3 los rechaza en el PUT.
  Cuando el reintento termina bien, también se limpia el error remoto anterior
  para que la agenda no siga mostrando una falla que ya fue resuelta.
- La enumeración completa de contactos usa `POST /contacts/search` con el
  contrato `v3`. Además de paginar en lotes de 100 con reintentos, esa versión
  entrega `customFields` explícito por contacto; así Ristak conserva los campos
  personalizados sin disparar un GET individual por cada ficha durante una
  sincronización masiva.
- Los leases distribuidos de la sincronización completa y de conversaciones se
  renuevan mientras el proceso siga vivo, pero vencen antes del siguiente tick
  si la instancia cae. Así un deploy o crash no deja dos corridas activas ni
  provoca que una carrera de milisegundos salte otra hora completa.
- Si HighLevel ya esta desconectado, un calendario espejado de HighLevel puede
  eliminarse de Ristak como copia local junto con sus citas locales asociadas.
  Mientras HighLevel siga configurado, el borrado local queda bloqueado porque
  el origen remoto podria volver a sincronizarlo.
- Las rutas publicas/privadas de calendario base dependen de `appointments`, no
  de `google_calendar`. Solo las rutas `/api/calendars/google-integration/*` y
  `/:id/google-sync` deben exigir `google_calendar`.
- Los calendarios publicos/embebidos reutilizan contactos existentes: si el
  correo ya existe en `contacts`, la cita se agenda sobre ese contacto aunque el
  telefono del formulario coincida con otro registro. Esto evita errores por el
  indice unico de email y permite que un cliente existente vuelva a agendar desde
  un sitio sin cambiar de correo.
- El formulario publico predeterminado de calendario pregunta nombre, correo y
  despues telefono. Los campos de telefono de calendario deben mostrar selector
  de pais/lada como bandera + codigo internacional, sin nombre de pais, y
  normalizar el valor con la region elegida; si el visitante no la cambia, se usa
  region detectada o la configurada en la cuenta como respaldo.
  Cuando el contacto se autopobla desde otro formulario, la lada queda en el
  selector y el campo visible conserva solo el numero nacional, sin prefijos tipo
  `+52`, `52` o `+1` duplicados dentro del input.
- Si el visitante llega desde un formulario/Site con `contactId` validado por la
  misma sesion/visitor, el calendario debe tratar ese registro como contacto
  activo del flujo. Si la persona corrige nombre, telefono o correo al agendar,
  se actualiza ese contacto activo en lugar de crear o escoger otro por datos
  viejos del navegador. Si no hay identidad activa validable, se conserva la
  regla de reutilizar por correo y luego por telefono.
- Los formularios personalizados de Sites dentro de calendarios no son parte del
  calendario base: requieren plan con `forms` y `sites`. En planes sin esa
  combinacion, Configuracion > Calendarios muestra solo datos básicos y el
  render público ignora cualquier custom form guardado previamente.
- Si Meta esta configurado con dataset/pixel y token guardado, los calendarios
  locales nuevos y los calendarios remotos espejados por primera vez activan
  `customEvents.enabled` por default para mandar `Schedule` al agendar. Ediciones
  posteriores y sincronizaciones de calendarios ya existentes respetan el apagado
  manual del usuario.
- Cobro antes de agendar: el paso `Cobro` del wizard de calendarios solo aparece
  cuando la licencia permite `calendar_payments` o el plan profesional
  compatible. El backend tambien valida la misma regla al crear/editar
  calendarios y al renderizar/agendar publicamente; si una cuenta baja de plan,
  `bookingPayment.enabled` se ignora para el visitante y no se crean links de
  pago nuevos. En calendario, ademas, la UI exige una pasarela conectada antes de
  activar el cobro.
- El canal `smart` de eventos de calendario se resuelve por la SUPERFICIE REAL
  de la conversion, no por la atribucion del contacto (ver
  `docs/CONVERSION_ATTRIBUTION.md`): un booking en la pagina/widget publico es
  `website` siempre; una cita creada desde el admin/webhook/agente usa el canal
  de la conversacion mas reciente del contacto (WhatsApp/Messenger/Instagram) y
  cae a `website` si no hay mensajeria. WhatsApp usa `ctwa_clid` cuando existe
  (sin ctwa se manda igual con matching por telefono), Messenger usa
  `page_scoped_user_id` + `page_id` e Instagram usa `ig_sid` + `ig_account_id`.
  En canales de mensajeria el evento de cita se normaliza a `LeadSubmitted`; el
  evento web sigue usando `Schedule`. Un canal explicito (whatsapp/messenger/
  instagram/site) en la config del calendario es override forzado.
- La atribucion interna de la cita (ultimo paid touch valido del contacto) se
  guarda como snapshot en `appointments.attribution_*` + `conversion_surface`
  al crearse, independiente del payload que se mande a Meta.
- En el chat movil, el sheet de `Agendar cita` permite alternar entre formulario
  completo y calendario mensual. La preferencia vive por usuario en
  `user_config.mobile_chat_appointment_entry_mode`; el modo mensual mantiene
  selector de calendario, cambio de mes por swipe/flechas y captura de hora,
  duracion, ubicacion e invitados antes de crear la cita por el endpoint normal.
  Ese mini calendario consume previews acotados (tres por dia) y conteos exactos;
  no usa la lectura legacy que descargaba todas las citas del mes.
- Las creaciones autenticadas de cita aceptan `clientRequestId`. `mobile/`,
  `PhoneCalendar` y el formulario de cita dentro de `PhoneChat` generan una
  llave por intento y la conservan al reintentar el mismo payload; el backend
  la reserva atomicamente en `appointment_creation_requests`, reproduce una
  respuesta completada y rechaza concurrencia, resultados ambiguos o la misma
  llave con datos distintos. Clientes legacy sin llave conservan temporalmente
  el contrato anterior. Los deep links de cita de Android esperan primero un
  bootstrap utilizable de `account_timezone` y calendarios para no consumir el
  enlace con contexto fallback.
- Toda alta normal por web, chat, calendario móvil, app nativa, iOS o API
  autenticada debe mandar un `calendarId` local válido. El backend rechaza la
  solicitud antes del INSERT cuando falta, porque una cita huérfana no puede
  respetar disponibilidad ni determinar su espejo externo. Si HighLevel está
  conectado, la misma alta confirma primero la cita canónica en Ristak e intenta
  de inmediato crear su espejo en el calendario remoto ligado. Un fallo remoto
  no borra ni duplica la cita local: la respuesta vuelve con `syncStatus=error`,
  las superficies muestran que HighLevel quedó pendiente y el reconciliador
  reintenta después. El formulario público conserva el mismo contrato local más
  espejo usando el calendario resuelto por su URL.
- Las creaciones locales desde calendario publico, admin o agente disparan los
  eventos `appointment-booked` y `appointment-status` del motor de
  Automatizaciones despues de persistir la cita. Los cambios de estado desde
  esas superficies disparan `appointment-status`; las sincronizaciones de
  Google/HighLevel no deben tratarse como si el cliente hubiera agendado en
  Ristak.
- En `ios/app`, los snapshots de citas usan una clave compuesta por calendario y
  mes. Cambiar calendario vacia las filas anteriores antes de hidratar la clave
  correcta, y volver a foreground fuerza la revalidacion del calendario activo.
- En `/appointments`, cada carga de calendarios, citas, proximas citas y bloqueos
  lleva una generacion. Una respuesta anterior no puede sobrescribir la seleccion
  o mutacion mas nueva. Crear o editar pinta solo la respuesta ya confirmada por
  backend y despues espera el refetch canonico; eliminar quita la fila confirmada
  inmediatamente y tambien revalida eventos y proximas citas.
- `/appointments` y DesktopChat crean citas con el mismo `AppointmentModal`
  compartido; Chat sólo inyecta el contacto y calendario del hilo. En ambos, el
  bloque de Invitados vive en la columna principal entre Ubicación y Notas, y el
  panel lateral queda reservado para asignar equipo. Cada invitado se persiste
  como participante estructurado con rol `guest`, sin contaminar el texto de
  Notas.
- `/appointments` no consulta proveedores externos para abrir la vista. Los GET
  de calendarios y eventos leen el espejo local y tampoco escriben para crear
  defaults. El calendario semilla se inicializa antes de habilitar tráfico, con
  single-flight por proceso, transacción, `BEGIN IMMEDIATE` en SQLite,
  `pg_advisory_xact_lock` en PostgreSQL e ID estable protegido por PK. HighLevel se refresca al
  conectar, por webhook y por su cron condicional, mientras Google se refresca
  al vincular, con la accion manual y por su cron condicional. Las proximas citas
  se paginan por `start_time + id` con cursor ligado al calendario, limite 20 por
  default y 100 maximo. Los indices `095*` siguen exactamente ese filtro y orden
  en SQLite y PostgreSQL, incluyendo timestamps PostgreSQL con microsegundos.
  El GET de calendarios detecta una semilla con citas mediante `EXISTS` indexado
  y sólo para candidatos semilla; nunca recuenta el histórico completo.
- Las vistas visibles tampoco descargan rangos completos: mes entrega conteos
  exactos y previews acotados por dia (hasta 45 dias por solicitud), semana/dia
  pagina por `start_time + id` con cursor ligado a calendario, rango, zona y
  orden, y el anual movil pide solo conteos. Los limites de cada dia se calculan
  con la zona del negocio y aceptan dias DST de 23/25 horas. Cambiar vista, rango
  o calendario aborta la lectura anterior en frontend, controller y base.
- La portada móvil multi-calendario usa `events/overview`: agrega estados en SQL
  y materializa sólo cinco próximas citas. El endpoint legacy `events` queda por
  compatibilidad, pero ninguna vista React lo usa para descargar rangos completos.
  Los índices parciales `107*` siguen el orden global `start_time + id` en
  SQLite/PostgreSQL y PostgreSQL los crea de forma concurrente.

Documentacion especifica:

- `backend/src/services/README_CALENDARS.md`
- `frontend/src/pages/Appointments/README.md`
- `docs/MOBILE_APP.md`

## Pagos

Ristak soporta:

- Cobros publicos por link.
- Stripe.
- Conekta.
- Mercado Pago.
- CLIP.
- Rebill.
- HighLevel invoices.
- Productos/precios.
- Planes de pago.
- Suscripciones.
- Tarjetas/metodos guardados.
- Recibos y previews.
- Payment flows con estados y reparaciones.
- Automatizaciones al completarse pagos.

En app movil nativa, la disponibilidad de flujos de pago depende de licencia e
integraciones conectadas. Los planes `basic` y `medium` solo pueden registrar
pagos unicos offline como efectivo, transferencia, deposito u otro pago
confirmado. Links, tarjetas guardadas, planes de pago y suscripciones no deben
mostrarse en esos planes. En planes `professional`/`pro`, si no
hay ninguna pasarela de pago conectada, la app movil tambien debe limitarse al
pago unico offline; los flujos avanzados aparecen solo cuando la licencia permite
`payment_plans`/`subscriptions` y existe al menos una pasarela conectada.

En Configuración > Pagos, Básico y Medio no muestran página de cobro, pasarelas
ni automatizaciones: requieren, respectivamente, `payment_checkout`,
`payment_gateways` y `payment_automations`. Los checkouts públicos de Sites y
sus bloques de cobro validan `payment_checkout` en backend, incluso si una página
existía antes de un downgrade.

El modal de registrar pago y la capacidad `Cobrar` del chatbot ofrecen sólo
registro manual/transferencia fuera de Profesional. Las rutas autenticadas, el
asistente de app y MCP vuelven a validar `payment_links`; una licencia stale no
puede crear ni enviar un enlace. Los links públicos creados antes del downgrade
siguen disponibles para que el pagador no reciba una URL rota.

La ruta de Configuracion > Pagos siempre carga primero su configuracion local.
Variables Meta se piden solo al abrir `Meta`; estado y plantillas de WhatsApp,
solo al abrir `Automatizaciones`. En `Pasarelas`, la vista general puede leer los
estados de todas porque los muestra juntos, pero una subruta como
`/settings/payments/stripe` consulta unicamente Stripe. Cada lectura admite
`AbortSignal`, se deduplica durante la vida de la pantalla y se cancela al cambiar
de panel; abrir Conekta no debe disparar Mercado Pago, CLIP, Rebill ni Stripe.
Una lista local de plantillas vacia nunca ejecuta automaticamente el refresh
externo de WhatsApp.

En el flujo movil, cualquier pago unico, plan de pagos o suscripcion que genere
un link/autorizacion debe regresar al chat del contacto con el preview del link
preparado para enviar. Las suscripciones deben usar la URL devuelta por el
backend en `subscriptionStartUrl` o en las URL especificas de la pasarela
(`stripeCheckoutUrl`, `conektaCheckoutUrl`, `mercadoPagoInitPoint`,
`mercadoPagoSandboxInitPoint`, `rebillPaymentLinkUrl`, `rebillCheckoutUrl`). Los
cobros directos con tarjeta guardada o registros offline deben volver al chat con
el marcador/notificacion de cobro completado cuando exista cobro inmediato.
Para suscripciones moviles por autorizacion, el frontend debe enviar
`paymentMethod=stripe_link` en Stripe y `paymentMethod=conekta_link` en Conekta.
Para tarjeta guardada, debe enviar el metodo de suscripcion directa que espera la
pasarela (`stripe_saved_card`, `conekta_subscription` o `rebill_subscription`).
Los cobros con tarjeta guardada y la creacion de suscripciones iniciados desde
el movil envian una llave de intento estable en `Idempotency-Key` y
`clientRequestId`. `saved_card_payment_requests` y
`subscription_creation_requests` reservan la mutacion antes de tocar la
pasarela: una operacion completada reproduce su respuesta durable; una en
proceso o con resultado ambiguo queda bloqueada para revision y no vuelve a
cobrar ni a crear una suscripcion a ciegas.
El flujo movil no habilita importes ni fechas hasta confirmar juntos
`account_currency` y `account_timezone`. Si falta cualquiera, muestra reintento
y no sustituye moneda o zona horaria con defaults del dispositivo/Mexico.

El modo de pasarelas puede ser `test` o `live`. Ese modo debe viajar con el pago
en `payment_mode` o metadata equivalente para evitar mezclar pruebas con dinero
real.

### Gigstack y facturación fiscal

Gigstack no procesa el cobro. Ristak lo llama únicamente después de que el pago
local quedó confirmado y con impuesto. Configuración > Pagos > Impuestos separa
dos API keys: Test y Live. Ambas se cifran dentro de
`app_config.payments_settings.taxes`; no son variables de entorno y nunca se
regresan completas al frontend después de guardarlas.

Mientras Gigstack está apagado, Impuestos funciona como una regla manual e
interna de Ristak. Al conectarlo, Ristak consulta `GET /v2/teams/:id` con la llave
del ambiente activo e importa RFC, razón social, régimen, código postal, tasa,
factor fiscal (`Tasa`, `Cuota` o `Exento`) y modo inclusivo/exclusivo. Esos
campos quedan de sólo lectura y
`gigstackFiscalSource=gigstack`; un guard del backend conserva la copia importada
ante guardados ordinarios. **Actualizar desde Gigstack** repite la lectura. Al
apagarlo se recupera la edición manual y la tasa vuelve a resolverse por país.
No se permite activar por el endpoint de guardado genérico sin pasar antes por
la sincronización fiscal, y el equipo remoto debe reportar SAT completo, perfil
fiscal completo y un impuesto válido. Una operación exenta con tasa cero sigue
siendo una configuración fiscal válida y no se descarta como «sin impuesto».

Las claves SAT por defecto no forman un catálogo cerrado. El selector ofrece
giros frecuentes, busca por texto o código y acepta cualquier clave de producto
de ocho dígitos o clave de unidad alfanumérica que pase la validación de formato.
El usuario puede editar también el nombre de la unidad. Los productos conservan
su mapeo fiscal local y aplican la misma entrada abierta; HighLevel no lo
sobrescribe al sincronizar su catálogo. Las opciones visibles son atajos, no una
recomendación fiscal: la clave correcta sigue siendo responsabilidad del emisor
y puede consultarse en el catálogo oficial del SAT. Sincronizar el perfil fiscal
de Gigstack tampoco sustituye la descripción, clave de producto, unidad ni forma
de pago elegidas en Ristak: Gigstack manda sobre identidad y tasa fiscal; esos
valores operativos siguen bajo control del negocio.

La separación de ambientes es estricta:

- La fuente de verdad es `payments.payment_mode`, no el modo global que esté
  seleccionado después.
- `test`/`sandbox` usa sólo `gigstackTestApiTokenEncrypted`; `live`/`production`
  usa sólo `gigstackLiveApiTokenEncrypted`.
- Antes de guardar o usar una llave, Ristak revisa el claim `livemode` del JWT.
  Una llave pegada en el ambiente incorrecto se rechaza.
- Si el pago no trae un modo reconocido o falta su llave exacta, el envío fiscal
  queda bloqueado. No existe fallback entre Test y Live.
- Probar conexión hace una lectura autenticada de pagos (`GET /v2/payments`) y
  no registra pagos ni crea CFDI.

El registro usa `POST /v2/payments/register` con el contrato v2 vigente:
`client`, `automation_type`, `currency`, `payment_form`, `items[].unit_price`,
`metadata`, `idempotency_key` y `send_email`. El correo del contacto busca o
crea al cliente; opcionalmente puede preferirse un `gigstackClientId` ya ligado
al pago. Si faltan ambos, no se inventa un receptor. La moneda sale siempre del
pago, que a su vez usa `account_currency`; la forma SAT sólo se detecta cuando el
proveedor reporta un medio inequívoco (por ejemplo, crédito, débito o SPEI). Si
el dato es ambiguo, se usa el fallback configurado —por defecto `99`— en vez de
inferir una forma fiscal desde el nombre de la pasarela.

`pue_invoice` crea la factura PUE automáticamente; `none` registra el pago sin
timbrarlo. En ambos casos, cada pago conserva una llave idempotente estable
`ristak-payment-<payment_id>`. La respuesta remota `succeeded` se guarda
localmente junto con ambiente, ID remoto e IDs de factura. Cuando se eligió
`pue_invoice`, Ristak además consulta cada `GET /v2/invoices/income/:id` y sólo
marca el resultado como `stamped` si Gigstack confirma `stamped`/`valid` en el
mismo ambiente; registrar el pago remoto no se confunde con haber timbrado.

La lista de transacciones expone únicamente un resumen seguro de
`metadata_json.gigstack`. Cuando el estado es `stamped`/`valid` y hay un ID de
factura, el menú de tres puntos ofrece ZIP, PDF y XML. La descarga autenticada
sale por `GET /api/transactions/:id/fiscal-invoice?format=zip|pdf|xml`: el backend
elige la llave según el `payment_mode` fijado en el pago, vuelve a validar el
claim `livemode`, obtiene los archivos con
`GET /v2/invoices/:invoiceId/files` y nunca entrega la API key ni una URL fiscal
interna al navegador. El ZIP se arma en Ristak con PDF y XML; las URLs remotas se
aceptan sólo por HTTPS y desde hosts autorizados de Gigstack o Google Storage.

`gigstack_invoice_jobs` es el outbox durable de reintentos. La fila nace antes de
la llamada externa, reclama un lease por pago y reintenta sólo red, timeout,
`429` y `5xx` con backoff. Errores fiscales, credenciales incorrectas o datos de
cliente faltantes quedan bloqueados para corregir configuración; nunca se
reenvían a ciegas. Activar Gigstack no factura pagos históricos: sólo se encolan
pagos nuevos cuando la integración ya estaba encendida.

### Webhooks Stripe por instalación

Cada modalidad Stripe (`test` y `live`) conserva en
`app_config.stripe_manual_mode_connections` su endpoint, URL y signing secret
cifrados. El signing secret pertenece a un solo endpoint: Ristak nunca debe
adoptar por URL o metadata un endpoint cuyo ID no coincida con el guardado,
porque Stripe no vuelve a revelar el secret de endpoints existentes.

Al guardar Stripe y durante el arranque, una reconciliación best-effort se
ejecuta únicamente si la integración está conectada. Usa primero la URL directa
del servicio Render y aplica estas reglas:

- Si el endpoint guardado todavía existe y conserva su signing secret, actualiza
  URL, eventos, estado y metadata sin recrearlo.
- Si el endpoint fue eliminado o falta su secret, crea uno nuevo y persiste el
  nuevo secret antes de continuar con la otra modalidad.
- La metadata incluye `installation_id` para que instalaciones distintas que
  compartan una cuenta Stripe no se pisen.
- Después de crear el reemplazo, sólo desactiva endpoints anteriores atribuibles
  a la misma instalación; para endpoints legacy sin `installation_id`, exige
  además la misma URL.
- La reconciliación corre en segundo plano y nunca bloquea readiness si Stripe
  no responde. Un fallo de firma entrante responde `400`; no se registra el
  evento ni se ejecutan efectos de pago.

La lectura de Configuración > Pagos sigue siendo local y no sincroniza Stripe.
La reparación ocurre al conectar/guardar o en la tarea de arranque, no desde un
GET de pantalla.

Cuando un webhook, retorno de pasarela o accion interna cambia un pago o una
suscripcion, el backend emite un evento por `/api/payment-events/stream`. Las
pantallas de Transacciones, Planes de pago y Suscripciones escuchan ese stream y
recargan solo la vista abierta. No se usa polling periodico para mantener esas
tablas vivas; la actualizacion depende del evento que dispara el cambio real.

En `ios/app`, el SSE se detiene en background y se reconecta al volver a
foreground. Tanto `connected` como los eventos de pago/suscripcion disparan una
reconciliacion REST con debounce, porque el stream no reproduce lo ocurrido
durante un corte. Pagos recientes solicita `statuses=paid,partial` antes de
paginar. La app bloquea precios cuya moneda no coincide con
`account_currency`; si se pierde la respuesta de un cobro con tarjeta guardada,
lo marca como incierto y exige revisar el historial antes de permitir otro
intento. Fallar al cargar tarjetas guardadas se presenta como error reintentable,
no como una lista vacia autoritativa. Los cobros saved-card usan
`clientRequestId` estable: una reserva persistente por pasarela+llave reproduce
el resultado terminado y bloquea estados processing/ambiguos, mientras la misma
llave derivada llega a Stripe, Conekta o Rebill como segunda barrera.

En el cliente nativo movil, registrar pago unico, plan de pagos y suscripcion se
configura como wizard. En pago unico y suscripcion, el primer paso define
cliente, producto o monto y el segundo paso elige la ruta de cobro. En planes de
pago, el primer paso ya configura todo el plan: producto o monto, primer pago,
cuando cobrarlo, metodo del primer pago, frecuencia y pagos restantes con
distribucion automatica del saldo. En el movil, los pagos se muestran como una
sola lista numerada (`Pago 1`, `Pago 2`, `Pago 3`, etc.); `Pago 1` contiene el
metodo y momento de cobro. El reparto automatico ocurre al capturar el monto
total o cambiar la cantidad de pagos mientras no se hayan editado montos
manualmente; en cuanto el usuario cambia un monto de una cajita, Ristak deja de
mover los demas hasta que el usuario pulse `Distribuir`. Al continuar, el ultimo paso solo resuelve la
pasarela o tarjeta: si el primer pago es efectivo o transferencia, pide pasarela
para enviar domiciliacion; si el primer pago es tarjeta, pide pasarela y tarjeta
guardada de esa pasarela. Los links de pago vuelven al chat del contacto con
previsualizacion lista y caja de texto vacia; al enviarse, el globo del chat
intenta cargar la previsualizacion real de la URL con metadata Open Graph
(`og:image`, titulo y descripcion) en vez de pintar un componente generico de la
app. Si la pagina no entrega metadata, el chat cae a una preview minima con host.
Los cobros con tarjeta guardada usan el endpoint de la pasarela elegida, no se
registran como pagos manuales.

El pago manual iniciado dentro de `PhoneChat` conserva una llave idempotente por
intento: la pantalla entrega un scope estable a `RecordPaymentModal`, el modal
genera el `Idempotency-Key` y `/api/transactions` evita duplicar el registro si
la respuesta se perdio y el usuario reintenta sin cambiar los datos. Android
aplica el mismo contrato con su identificador estable de transaccion.

Cuando se registra un pago manual, se cobra una tarjeta guardada o se agenda una
cita desde desktop o una app nativa, el contacto vuelve a su conversacion y el
chat muestra un marcador inline en la linea de mensajes. Ese marcador no es un
globo del cliente ni del negocio: es una anotacion de conversacion que indica
que en ese punto se completo un cobro o se agendo una cita. Las apps nativas
pueden ademas mostrar una confirmacion breve con check animado dentro del area
del chat, sin cubrir el header ni la informacion del contacto.

Un pago exitoso en modo `test` puede clasificar al contacto como `Cliente` dentro
del CRM y del filtro de Contactos para validar flujos sandbox. Ese mismo pago no
debe sumar a LTV, ingresos reales, ROAS, reportes financieros ni conversiones
reales de Meta.

### Tabla de transacciones

La tabla principal de `/transactions` usa paginacion real del lado servidor. La
pantalla pide solo la pagina visible de pagos (20 filas) con fecha, busqueda,
estado y orden. En modo normal `/api/transactions` devuelve una pagina keyset,
`hasNext` y `nextCursor`, sin contar ni agrupar el universo antes de pintar. El
frontend guarda la pila de cursores, la reinicia al cambiar filtros y cancela la
respuesta anterior. Las facets globales llegan despues desde
`/api/transactions/facets`; las tarjetas KPI tampoco son metricas de la pagina
visible y se leen en `/api/transactions/summary` con los mismos filtros de fecha,
busqueda y estado. Ambos agregados usan cache versionado y se invalidan cuando
cambia cualquier pago. La opcion manual de sincronizar usa
`POST /api/transactions/sync`; abrir, buscar u ordenar nunca llama proveedores.

La tabla principal de `/transactions` separa tres conceptos que antes podian
mezclarse en `payment_method`:

- Metodo de pago: la categoria real usada por el cliente, por ejemplo tarjeta de
  credito, tarjeta de debito, efectivo, transferencia bancaria, SPEI, wallet o
  metodo pendiente de seleccion si el link aun no se paga.
- Tipo de pago: la modalidad del cobro, por ejemplo pago unico, pago diferido,
  MSI, suscripcion o autorizacion de tarjeta.
- Canal: la plataforma o integracion que proceso el cobro, por ejemplo Ristak,
  Stripe, Conekta, Mercado Pago, CLIP, Rebill, Openpay o HighLevel.

La fuente canonica para construir esos labels es
`backend/src/utils/paymentDisplay.js`, usando `payments.payment_method`,
`payments.payment_provider`, IDs de proveedor y `payments.metadata_json`. Las
pasarelas deben guardar solo metadata no sensible para enriquecer la clasificacion
del metodo real (por ejemplo `cardFunding`, `paymentTypeId`, `installments`,
`monthlyInstallments`, marca y ultimos 4 si ya se almacenaban como fuente de pago).
`Tipo de pago` debe mostrar `N MSI` solo cuando el cobro tenga evidencia de meses
sin intereses configurados por Ristak o confirmados por la pasarela, por ejemplo
`stripeInstallments`, `mercadoPagoInstallments`, `conektaInstallments`,
`clipInstallments`, `rebillInstallments`, `stripe.installments.plan`,
`conekta.monthlyInstallments` o metadata explicita `msi`/`interestFree`. No se
debe convertir cualquier `installments` generico en MSI ni usar el maximo
configurado como si fuera el plazo pagado: si Ristak permite hasta 12 MSI pero la
respuesta real del gateway confirma 3 MSI, la tabla debe mostrar `3 MSI`. Si la
fila pertenece a un plan de pagos interno (`paymentPlan`, cobro programado o
`*_scheduled_card`) debe seguir mostrando `Pago diferido` salvo que tambien
exista una senal MSI explicita del gateway.
No se deben guardar PAN, CVV, tokens secretos, llaves de API ni datos que permitan
cobrar fuera de la pasarela. Si una transaccion historica no tiene suficiente
metadata para distinguir credito/debito u otra categoria fina, la UI debe mostrar
un fallback honesto como `Tarjeta`, `Pendiente de seleccion` o
`Metodo no especificado`; no debe inventar una categoria.

### Estados de links de pago

Crear o enviar un link de pago no significa que el cobro fallo si el cliente no
paga. Ristak mantiene esos links como `sent`/`pending` hasta que exista una
confirmacion real de la pasarela. Esta regla aplica a Stripe, Conekta, Mercado
Pago, CLIP, Rebill y cualquier pasarela futura: abandono, expiracion,
`canceled`, `cancelled`, `requires_payment_method` sin error real, o estados
equivalentes no deben marcarse como `failed` ni cerrar el link local. El pago
debe quedar reintentable mientras no exista una fecha limite o una accion manual
que lo archive.

Los rechazos reales de tarjeta o proveedor siguen visibles como `failed`. Una
pasarela solo puede marcar `failed` cuando el payload externo trae una senal
explicita de rechazo/fallo, por ejemplo `declined`, `rejected`, `payment_failed`,
`charged_back`, `last_payment_error` en Stripe o el evento
`payment_intent.payment_failed`. Las integraciones nuevas deben mapear estados
con `backend/src/services/paymentGatewayStatusPolicy.js` y cubrir en pruebas el
caso de abandono/reintento y el caso de rechazo real.

### Contacto asociado a pagos publicos

Los webhooks y confirmaciones de Stripe, Conekta, Mercado Pago, CLIP y Rebill
deben resolver `payments.contact_id` antes de disparar efectos de pago pagado
(stats del contacto, recibo automatico, Gigstack, Meta Purchase y post-webhooks).
La resolucion usa, en este orden:

- `contact_id` ya guardado en el pago o metadata.
- Telefono del pago, metadata local o payload del proveedor.
- Email del pago, metadata local o payload del proveedor.

Si encuentra un contacto existente por telefono o email, liga el pago a ese
contacto y completa campos faltantes no conflictivos. Si no existe contacto y el
payload trae email o telefono, Ristak crea uno nuevo con source
`payment_checkout` y guarda la resolucion en `payments.metadata_json` como
`paymentContactResolution`. El webhook nunca debe fallar el cobro por no poder
resolver contacto; si la resolucion falla, se conserva el pago y se registra un
warning para reintento/diagnostico posterior.

### Webhooks POST configurados por producto

Los webhooks POST guardados en `products.post_webhooks` pertenecen al producto
local de Ristak. No pertenecen a HighLevel, Stripe, Conekta, Mercado Pago, CLIP,
Rebill ni a ninguna otra pasarela. Por eso, cualquier transición real de estado
de un pago con `lineItems` enlazados al producto debe pasar por
`productPostWebhookService.js`, sin importar qué integración creó o confirmó el
pago.

La entrega es idempotente por pago, estado, producto, webhook y versión de la
configuración; los intentos quedan en `payments.metadata_json` bajo
`productPostWebhookDeliveries`. El registro manual de invoices HighLevel, los
webhooks entrantes y las sincronizaciones de invoices deben respetar la misma
regla. Una sincronización posterior no debe duplicar una entrega ya confirmada.

El payload es disperso: omite valores vacíos, objetos sin contenido y datos
internos de entrega. Dentro de `payment` sólo expone los IDs de la pasarela que
realmente procesó el cobro, según `payments.payment_provider`. Por ejemplo, un
pago Stripe puede incluir `stripePaymentIntentId` y `stripeChargeId`, pero nunca
campos de Mercado Pago, Conekta, CLIP o Rebill; la misma regla aplica a cada una
de esas pasarelas. `payment.metadata` conserva datos comunes y valores válidos
como `0` o `false`, pero elimina ramas de otras pasarelas y
`productPostWebhookDeliveries`.

El contrato actual usa `schemaVersion: ristak.product-payment.v1` y conserva el
sobre detallado (`payment`, `contact`, `product`, `price`, `lineItem` y
`lineItems`). Además expone en la raíz los campos canónicos para receptores de
compras: `email`, `name`, `phone`, `payment_id`, `payment_status`,
`payment_mode`, `SKU`, `product_name`, `amount`, `currency`, `payment_method`,
`paid_at`, `due_at` y `provider`. El header
`X-Ristak-Webhook-Schema` identifica la misma versión.
El health público `/api/health` expone el valor en
`contracts.productPostWebhook` para comprobar qué contrato está desplegado.

`price` y `SKU` deben corresponder al precio exacto señalado por el `priceId` del
`lineItem`. Si el producto tiene varias opciones, nunca se toma el primer precio
por conveniencia. Los campos canónicos calculados por Ristak ganan sobre campos
estáticos del body cuando existe evidencia real del pago; esto evita que una
configuración vieja mande el SKU o contacto equivocado.

`payment_mode` siempre viaja para separar `test|sandbox` de `live`. Un receptor
que otorgue productos o membresías debe validar los webhooks test sin conceder
acceso productivo. Para MDP, la respuesta esperada es `test_validated` con
`accessPrepared: false`; sólo un pago live puede preparar al alumno.

`post_webhooks` y los campos fiscales Gigstack son configuración local de
Ristak. La sincronización de catálogo desde HighLevel puede refrescar nombre,
descripción, IDs y precios remotos, pero nunca debe vaciar ni reemplazar esos
campos locales sólo porque HighLevel no los conoce.

### Push de estado de pagos

Las notificaciones push de pagos deben comunicar el resultado real del cobro, no
el titulo del bloque, boton o concepto del checkout. Esta regla aplica a pagos
manuales, links publicos, Sites y webhooks de Stripe, Conekta, Mercado Pago,
CLIP, Rebill y HighLevel invoices.

Estados exitosos (`paid`, `approved`, `succeeded`, `completed` y equivalentes)
deben mostrarse como `Pago completado`. Rechazos o fallos reales (`failed`,
`declined`, `rejected`, `error`) deben mostrarse como `Pago rechazado`.
Pendientes/procesando deben mostrarse como `Pago pendiente`, `requires_action`
como `Pago requiere atencion`, reembolsos como `Pago reembolsado` y cancelados
como `Pago cancelado`. El cuerpo de la push puede incluir cliente, monto,
concepto y razon de fallo, pero etiquetas genericas de Sites como `Pago
requerido` no deben aparecer como si fueran el resultado del pago.

### Automatizaciones de pago

Configuracion > Pagos > Automatizaciones controla recordatorios, comprobantes y
avisos de cobro fallido desde `payments_settings.automations`.

Esta sección y todo su despacho en segundo plano requieren
`payment_automations`. Tener el módulo `payments` no basta.

- Canales soportados: WhatsApp API, WhatsApp QR solo, correo electronico o ambos.
- Cada automatizacion de pago puede usar `contentMode='template'` o
  `contentMode='direct'`. En `template`, WhatsApp usa la plantilla configurada y
  correo usa el mensaje predeterminado del sistema. En `direct`, el texto
  editable (`reminderMessageText`, `receiptMessageText` o
  `failedPaymentMessageText`) se renderiza con variables de pago/contacto y se
  usa para los canales seleccionados.
- `channel='whatsapp'` usa API oficial con plantillas aprobadas cuando hay
  remitente API conectado; QR solo entra como respaldo si el switch de respaldo
  esta activo o si no existe API y QR es la unica ruta disponible.
- `channel='whatsapp_qr'` usa QR como canal principal sólo para un remitente QR
  standalone o con API indisponible. Si el mismo teléfono conserva API activa,
  el backend sustituye la petición QR por API.
- Los mensajes directos por WhatsApp API no sustituyen a las plantillas fuera de
  la ventana permitida por Meta: sólo salen si existe conversación abierta de
  24 horas. Fuera de esa ventana debe usarse plantilla aprobada; QR sólo aplica
  si la API dejó de estar disponible o el remitente es QR standalone.
- WhatsApp registra el despacho en `payment_automation_dispatches` con
  `channel='whatsapp'` o `channel='whatsapp_qr'` segun la ruta elegida.
- Correo electronico usa la conexion SMTP guardada en Configuracion > Integraciones
  > Correos. El password vive cifrado en `app_config.email_smtp_password`; no se
  agrega env var nueva para arrancar el servicio.
- Cada canal tiene su propio despacho idempotente por pago, tipo de automatizacion
  y canal. Un envio por WhatsApp no bloquea el envio por correo, y viceversa.
- `reminderDaysBefore` define el primer dia objetivo: si esta en 3, el
  recordatorio se prepara a tres dias del vencimiento. Si un reinicio o despliegue
  pierde ese tick, el sistema lo recupera solo mientras el pago siga venciendo hoy
  o en el futuro; nunca revive recordatorios de pagos ya vencidos. El despacho
  persistente mantiene la idempotencia aunque el barrido vuelva a pasar.
- En planes de pago locales, esa ventana no debe disparar varias parcialidades del
  mismo flujo en el mismo barrido. Si dos o mas cuotas del mismo `payment_flow`
  estan dentro de la ventana, Ristak solo envia el recordatorio de la siguiente
  parcialidad abierta; los pagos unicos y pagos de otros flujos siguen
  evaluandose de forma independiente.
- Los avisos de cobro fallido solo se disparan para fallos recientes: despues del
  `failedPaymentDelayHours` configurado y dentro de una tolerancia maxima de 24h
  adicionales. Esto evita revivir pagos historicos cuando se prende, repara o
  despliega la cola de automatizaciones.
- El comprobante posterior al pago incluye un enlace al checkout publico con
  `?receipt=1`; cuando el pago esta confirmado, esa pagina muestra el comprobante
  y activa la descarga/impresion del PDF.
- Si falta contacto de correo, telefono, conexion del canal o URL publica de pago,
  el despacho se omite o queda fallido con razon explicita; no se inventan datos ni
  se manda un comprobante sin enlace descargable.

### Recordatorios de citas

Los mensajes automaticos de citas (`appointment_reminders`) se calculan en la
zona horaria de la cuenta. Los recordatorios `before_appointment` se anclan al
inicio de la cita. Los avisos `after_booking` se anclan a la fecha de reserva
local en Ristak; citas sincronizadas desde Google/GHL no reciben avisos de
reserva como si el cliente hubiera agendado por Ristak.

Cada recordatorio/aviso guarda canal y contenido por separado. En la UI, el canal
visible `WhatsApp API` guarda `channel='whatsapp'`; `WhatsApp QR solo` guarda
`channel='whatsapp_qr'`. Tambien puede ser `email`, `messenger` o `instagram`.
Los modos automaticos guardan `channel='booking_channel'` para "Por el canal que
agendo" y `channel='available_channel'` para "Por canal disponible". Al crear
una cita, Ristak guarda `appointments.booking_channel` solo cuando el flujo
conoce el canal real (por ejemplo, un agente de WhatsApp, Instagram, Messenger o
correo, o una solicitud que lo declara). "Por el canal que agendo" usa ese dato
guardado y, si falla, prueba los demas canales disponibles. No deduce el canal
desde el ultimo mensaje del contacto: eso podria pertenecer a otra conversacion.
Las citas antiguas o formularios que no informan canal usan directamente la
prioridad configurada. "Por canal disponible" hace un solo intento de WhatsApp:
API si está disponible o QR si es standalone; después prueba Instagram,
Messenger y correo electrónico.
`channel='whatsapp'` usa el canal conectado automáticamente: WhatsApp API como
ruta principal y el QR del mismo teléfono como respaldo estricto, sin switch
manual. `channel='whatsapp_qr'` queda por compatibilidad y usa QR como ruta principal sólo si la
API del mismo teléfono no está disponible. En los dos canales de WhatsApp, el contenido
puede ser `content_mode='template'` para seleccionar un mensaje guardado o
`content_mode='direct'` para texto editable; en QR el mensaje guardado se renderiza
como texto y no depende de aprobacion de Meta. En correo, Messenger e Instagram,
Ristak fuerza mensaje directo porque esos canales no usan plantillas de WhatsApp.
Los modos automaticos tambien usan mensaje directo editable por default para que
puedan caer correctamente en canales no WhatsApp.
El texto directo usa variables como `{{contact.first_name}}`, `{{cita.fecha}}` y
`{{cita.hora}}`.

La confirmacion de asistencia no es un tipo principal de mensaje. En la UI de
Citas, cualquier recordatorio o aviso puede activar "Usar como confirmacion de
cita". Internamente eso guarda `message_type='confirmation'`, habilita las
opciones de IA/acciones de confirmacion y hace que las respuestas del contacto
abran una ventana en `appointment_confirmation_windows`. Si el switch esta
apagado, el mensaje queda como `message_type='reminder'` aunque su ancla sea
`after_booking`.

La plantilla se decide primero por el momento del mensaje y despues por el modo:
`after_booking` siempre usa `cita_programada`; para `before_appointment`, una
confirmacion usa `confirmacion_cita_dia_anterior` y un recordatorio usa
`recordatorio_cita_un_dia_antes`. Esta regla se aplica tanto en frontend como en
backend. El arranque repara filas historicas que apunten a otra plantilla default
y el envio vuelve a validar el contrato para fallar cerrado ante una corrupcion
posterior. Las plantillas default muestran la fecha y hora canonicas y no dependen
de texto relativo como "mañana" o "dentro de 1 dia".

Si solo hay WhatsApp QR conectado, recordatorios y avisos de cita envian el
texto renderizado del mensaje por QR aunque la plantilla de WhatsApp API este
pendiente o no exista remotamente. Si hay API y QR conectados para el mismo
teléfono, API sigue como ruta principal incluso si una configuración histórica
guardó `whatsapp_qr`; QR entra sólo ante indisponibilidad real. La autorización
la agrega automáticamente el servicio de Citas y la capa central verifica que
el QR pertenezca al mismo número.

Los mensajes directos por WhatsApp API en citas tambien dependen de ventana de
conversacion abierta de 24 horas. Si no existe una respuesta reciente del
contacto, el envio libre por API falla de forma explicita; para mensajes
proactivos fuera de ventana debe usarse plantilla aprobada. Tener QR conectado
no evita esta regla mientras la API esté disponible.

Cada par `reminder_id + appointment_id` se reclama en
`appointment_reminder_sends` antes de enviar para evitar duplicados. Estados
`sent`, `skipped` y `sending` bloquean nuevos envios. Si el intento termina en
`error`, el cron puede reintentarlo despues de 15 minutos, siempre que la hora de
envio siga dentro de la ventana util de 3 horas; si ya se paso esa ventana se
marca como omitido en vez de mandar un WhatsApp tarde. El enfriamiento se compara
en UTC con SQL nativo del motor activo; PostgreSQL no ejecuta funciones exclusivas
de SQLite durante este reclamo.

La tolerancia de reintento no convierte un recordatorio vencido en confirmacion
de reserva. Si una cita se crea despues del instante calculado para un mensaje
`before_appointment`, ese mensaje queda `skipped` aunque el desfase sea menor a
tres horas. La confirmacion inmediata de una reserva, cuando el usuario la
configura, debe usar `after_booking` y la plantilla `cita_programada`, que muestra
la fecha y hora reales de la cita.

Una cuenta nueva recibe una sola fila inicial: `Confirmación 1 día antes`, con
`message_type='confirmation'`, ancla `before_appointment`, plantilla
`confirmacion_cita_dia_anterior` y `enabled=0`. Nace pausada para que no se envie
nada hasta que el usuario revise y active su configuracion. Esta fila lleva
`system_key='default_one_day_before'` y un índice único parcial. Así dos
instancias que arrancan al mismo tiempo no pueden sembrarlo dos veces. Además,
cada mensaje automático guarda una `schedule_key` única compuesta por el ancla
(`before_appointment` o `after_booking`) y la duración normalizada en
milisegundos. Dos configuraciones que caerían en el mismo momento —por ejemplo,
`60 minutos antes` y `1 hora antes`— se consideran el mismo horario sin importar
canal, plantilla, texto o modo de confirmación. Crear o actualizar un segundo
mensaje devuelve HTTP `409` con
`code='appointment_reminder_schedule_conflict'`; el editor permanece abierto y
muestra el modal canónico para elegir otro momento. La llave única también
cierra carreras entre pestañas o procesos. Los duplicados históricos no se
borran durante la migración: sólo la fila canónica recibe la llave y las demás
deben corregirse al editarse. La creación concurrente de la carpeta y plantillas
base también usa operaciones idempotentes para que esa carrera no tumbe el
arranque antes de llegar a los índices.

Al pulsar **Agregar**, el frontend abre un borrador local y no persiste nada
hasta **Guardar**. Esto evita crear provisionalmente otro recordatorio de un día
antes y garantiza que cerrar el modal no deje filas huérfanas activas.

En PostgreSQL, las columnas de citas y envios siguen siendo
`timestamp without time zone` con el valor normalizado a UTC. Al leerlas, el
backend debe rehidratar los componentes guardados como UTC porque
`node-postgres` puede entregarlas como objetos `Date` interpretados en la zona
del proceso. Si se convierten directamente a texto y se pasan a Luxon, el
recordatorio queda fuera de la cola sin error visible.

### Planes de pago locales

En Stripe, Conekta, Rebill y Mercado Pago, el calendario editable muestra y guarda cada
pago como `Pago N/M`, donde `N` es la posicion visible del pago y `M` es el total
actual del plan. Si el calendario se edita, por ejemplo de 3 a 6 pagos, Ristak
actualiza tambien los `title`/`description` de pagos existentes de `1/3` a `1/6`
sin cambiar importes, fechas ni estados ya registrados.

Los cobros automaticos de planes con tarjeta guardada deben reclamar localmente
la cuota o primer pago a `processing` antes de llamar a la pasarela. Stripe,
Conekta y Rebill usan este claim atomico mas los locks del cron para evitar doble
cargo ante solapes de deploy, ticks concurrentes o ejecuciones manuales. Mercado
Pago no cobra cuotas locales desde el cron; genera/libera links programados.
Mercado Pago y CLIP no se ofrecen para crear planes nuevos: Mercado Pago queda
disponible para links únicos y suscripciones, y CLIP para pagos únicos. El cron
de Mercado Pago sólo conserva compatibilidad con planes legados; reclama cada
fila antes de generar el link y nunca libera automáticamente un link atrasado.

Blindajes obligatorios del reloj de cobros:

- Cada creación Stripe/Conekta/Rebill usa una llave idempotente generada por el
  cliente. Durante compatibilidad con apps anteriores, backend deriva una llave
  conservadora por día de negocio y payload. `payment_plan_creation_requests`
  guarda huella, estado y respuesta; repetir la misma petición reproduce el
  resultado y no ejecuta otro cobro.
- El primer cargo con tarjeta guardada no ocurre dentro de la petición que crea
  el plan. El flujo permanece en el estado interno no cobrable `creating` hasta
  que se hayan persistido flujo, pagos y parcialidades; sólo entonces cambia de
  estado y el cron puede tomarlo en el siguiente tick. Si el alta falla a medias,
  el flujo queda `creation_failed_review` y todos sus cargos automáticos quedan
  bloqueados.
- La suma del primer pago y parcialidades debe coincidir exactamente con el
  total en unidades mínimas de la moneda. No existe tolerancia de `0.50`.
- Las fechas programadas sin hora explícita se fijan a las 10:00 en la zona del
  negocio. Cuando el usuario elige cobro inmediato para hoy, el cliente envía el
  instante UTC actual para que el próximo tick lo procese sin convertirlo en un
  cobro diferido de las 10:00.
- El cron sólo cobra vencimientos del día de negocio actual. Cualquier fecha de
  un día anterior queda `overdue_review`/`overdue`; reiniciar, reconectar o
  reanudar nunca dispara una ráfaga de cobros atrasados. El flujo completo se
  pausa hasta que esas fechas se revisen y reprogramen.
- Un fallo de proveedor o tarjeta queda visible como `failed` o
  `requires_action` y no se reintenta automáticamente. Para volver a cobrar se
  requiere revisión y reprogramación explícita.
- Pausar, cancelar, eliminar o editar falla con conflicto si una parcialidad ya
  está `processing`. El claim del cron vuelve a comprobar dentro del mismo
  `UPDATE` que el plan continúa activo.
- Mientras se edita, el flujo usa el estado interno `editing`, que impide nuevos
  claims. Si la mutación falla después de haber comenzado, el plan queda
  `paused` por seguridad hasta que el usuario revise y vuelva a activarlo.
- Los crones de Stripe, Conekta, Rebill y compatibilidad legada de Mercado Pago
  usan lock distribuido con dueño, heartbeat y
  `failOpen=false`; si la DB no confirma exclusividad, se omite el barrido.
- Los webhooks Conekta sin llave pública de firma o con `DIGEST` inválido se
  rechazan y no alteran estados financieros.

Rebill es completamente local para listar, abrir, editar, pausar, reanudar,
cancelar, eliminar y cambiar tarjeta. Esas acciones nunca deben caer al cliente
de HighLevel cuando `payment_plans.source='rebill'`.

### Moneda de cuenta

La moneda default de Ristak siempre es la configurada en la cuenta. La fuente de
verdad es `app_config.account_currency`, expuesta en Configuracion > Negocio y
resuelta con `backend/src/utils/accountLocale.js` y
`frontend/src/hooks/useAccountCurrency.ts`.

Reglas:

- Registros nuevos con importe usan la moneda de la cuenta si el usuario no
  selecciono otra moneda explicitamente.
- Registros existentes conservan su moneda guardada; cambiar la moneda de la
  cuenta no reescribe historicos automaticamente.
- Frontend debe formatear importes con moneda explicita:
  `formatCurrency(amount, record.currency || accountCurrency)`.
- Backend debe usar `getAccountCurrency()` o helpers existentes basados en ese
  helper. `DEFAULT_CURRENCY` es fallback defensivo, no default de negocio para
  codigo nuevo.
- No agregues env vars o secrets para moneda default. Si una pasarela guarda una
  moneda propia, debe inicializarse o sincronizarse desde la moneda de cuenta
  cuando aplique.
- CLIP Checkout Transparente solo acepta `MXN`; Ristak debe bloquear cobros CLIP
  en otra moneda en vez de convertir o inferir moneda.
- Rebill Checkout acepta `ARS`, `BRL`, `CLP`, `COP`, `MXN` y `USD`; Ristak debe
  bloquear cobros Rebill en otras monedas en vez de convertir o inferir moneda.

Documento obligatorio: `docs/CURRENCY_GUIDELINES.md`.

### Stripe MSI en links y Sites

En links publicos `/pay/:publicPaymentId` y checkouts embebidos de Sites, Stripe
puede ofrecer meses sin intereses cuando el cobro esta en `MXN` y cumple el
minimo de `300 MXN`:

- El modal de cobro permite elegir el maximo local permitido para Stripe
  (`3, 6, 9, 12, 18 o 24` meses).
- Stripe debe tener MSI habilitado en su Dashboard; Ristak no crea ni modifica
  reglas globales de Stripe.
- En `/pay`, Ristak usa el flujo controlado por backend: crea un PaymentMethod
  seguro con Stripe, consulta `available_plans`, filtra por
  `metadata.stripeInstallments.maxInstallments` y confirma el PaymentIntent desde
  backend con el `plan.count` elegido.
- En el checkout embebido de Sites, Stripe MSI usa el mismo flujo controlado que
  `/pay`: Elements separados para tarjeta, endpoint
  `/api/sites/public/checkout/prepare-installments`, `available_plans` filtrados
  por el maximo local del bloque y confirmacion server-side con `fixed_count`.
  No hay boton adicional de "ver meses"; el checkout consulta automaticamente
  cuando Stripe ya puede crear la tarjeta segura. Si hay planes disponibles, el
  vivo muestra un checkbox "Pagar en cuotas (meses sin intereses)" y cards tipo
  radio para cada plazo permitido; desmarcar el checkbox cobra de contado.
- Si Stripe Dashboard ofrece hasta 24 meses pero el bloque de Sites dice "diferir
  hasta 9 meses", el vivo solo debe renderizar los planes de Stripe con `count`
  menor o igual a 9. El selector nativo del Payment Element no se usa en Sites
  porque no permite ocultar meses por bloque.
- La fila/PaymentIntent pendiente guardada en `sessionStorage` solo se reutiliza
  si sigue coincidiendo con el bloque actual en sitio, pagina, bloque, monto,
  moneda, pasarela, modo y maximo MSI. Si cambias de 3 a 9 meses, o de $500 a
  $5,000, Ristak ignora el pago viejo y crea uno nuevo para no enseñar planes
  obsoletos.
- El editor de Sites usa un preview no interactivo del mismo estado: cuando el
  bloque Stripe es elegible para MSI, muestra la tarjeta con numero elegible y
  las opciones de meses debajo del numero, no una fila fija de contado desde el
  inicio.
- Si el cliente abandona despues de preparar el intento MSI pero antes de confirmar,
  el pago queda pendiente; no se marca como fallido salvo que Stripe reporte un
  rechazo real.

### CLIP Checkout Transparente

CLIP vive como pasarela manual administrada desde Configuracion > Pagos. Sus
credenciales de prueba y en vivo se guardan cifradas en `app_config` bajo claves
`clip_*`; no requiere env vars nuevas para arrancar el servicio.

Alcance:

- Cobros unicos por link publico `/pay/:publicPaymentId`.
- Checkout de Sites con SDK oficial `https://sdk.clip.mx/js/clip-sdk.js`.
- CLIP no se ofrece para suscripciones ni planes de pago en Ristak. Solo se usa
  para pagos unicos, porque el flujo disponible no guarda tarjeta ni autoriza
  cargos recurrentes/off-session administrados por Ristak.
- Meses sin intereses en cobros unicos: Ristak habilita `terms.enabled` en el
  objeto `Card` del SDK, usa `paymentAmount` igual al monto del cobro y envia a
  `POST /payments` el valor devuelto por `card.installments()`. CLIP solo muestra
  MSI si la cuenta los tiene activos en su Dashboard, el monto cumple el minimo
  configurado y la tarjeta/banco califican.
- Webhook publico `/api/clip/webhook`; cada notificacion consulta el pago real
  con `GET /payments/{payment_id}` antes de actualizar Ristak.
- Configuracion > Pagos > CLIP muestra, debajo de las credenciales de prueba y
  en vivo, las URLs disponibles para copiar el Postback Webhook y pegarlo en el
  dashboard de CLIP.
- Autenticacion 3DS: si CLIP responde `pending_action.url`, el frontend abre el
  iframe de validacion y luego refresca el estado contra el backend.
- Variables de automatizacion: `payment.clip_payment_id` y
  `payment.clip_receipt_no`.

Restricciones operativas:

- Moneda obligatoria: `MXN`.
- Cliente obligatorio: email y telefono.
- MSI requiere `MXN`, monto minimo de `300 MXN` y configuracion activa en CLIP.
  Ristak no crea reglas MSI dentro de CLIP; solo habilita el dropdown del SDK y
  valida que el link local tenga MSI activado antes de aceptar `installments`.
- La Clave API visible de CLIP se expone al SDK publico porque asi lo requiere
  CLIP para tokenizar tarjeta; Ristak la conserva cifrada del lado servidor y
  solo la entrega al checkout publico necesario. La clave secreta de CLIP no se
  usa para inicializar el SDK.
- La validacion de Configuracion > Pagos > CLIP solo comprueba que exista una
  Clave API utilizable para montar el SDK oficial. No consulta listas de
  transacciones ni prueba endpoints de Payments, porque esas capacidades pueden
  no estar habilitadas para la credencial. El cobro real sigue usando el token
  generado por el SDK y `POST /payments` contra CLIP cuando el cliente paga.
- Si se necesita recurrencia automatica real con cargo futuro gestionado por la
  pasarela, usar Stripe, Conekta o Mercado Pago. El backend rechaza intentos de
  crear suscripciones con `payment_provider=clip`, `payment_method=clip`,
  `clip_link` o `clip_payment_link`.

### Rebill Checkout

Rebill vive como pasarela manual administrada desde Configuracion > Pagos >
Rebill. Las credenciales de prueba y en vivo se guardan en `app_config` bajo
claves `rebill_*`; la public key `pk_` queda disponible para compatibilidad con
flujos publicos legacy y la secret key `sk_` queda cifrada en base de datos. No
requiere env vars nuevas para arrancar el servicio. La UI solo pide `pk_` y
`sk_`; el nombre visible de la organizacion se deriva de
`GET /v3/organizations/me` o del modo configurado, no de un campo manual.

Alcance:

- Cobros unicos por link publico: Ristak crea una fila local, crea un Payment
  Link hospedado de Rebill (`pay.rebill.com`) y comparte esa URL como liga de
  cobro. La ruta local `/pay/:publicPaymentId` queda como retorno, estado,
  recibo y compatibilidad para links viejos.
- Cobros unicos con tarjeta Rebill guardada: Ristak usa el `cardId` guardado y
  llama `POST /v3/checkout` desde backend con `customer` estructurado
  (`firstName`, `lastName`, `email` y `phone` si existe), `cardId` y
  `x-idempotency-key`; no guarda PAN, CVV ni datos sensibles de tarjeta.
- Planes de pago administrados por Ristak: `payment_flows.payment_provider='rebill'`
  y `payment_plans.source='rebill'`. Rebill solo procesa cada checkout; Ristak es
  dueno del calendario, vencimientos y estado del plan (`clockOwner='ristak'`).
  Cuando el plan tiene tarjeta guardada, el cron cobra cada parcialidad que vence
  en el día de negocio actual
  con `cardId`; si falta tarjeta, el primer pago o la domiciliacion guardan la
  tarjeta antes de activar los cobros futuros.
- Checkout de Sites con redireccion al Checkout Landing hospedado de Rebill
  (`pay.rebill.com`); Sites no monta el web component `rebill-checkout` porque el
  Payment Gate debe abrir la superficie propia de Rebill y evitar conflictos de
  MSI dentro del embed.
- Los Payment Links hospedados de Rebill se crean card-only con
  `paymentMethods=[{ methods:['card'], currency }]`, `showCoupon=false` e
  `isSingleUse=true`; SPEI, PSE/transferencias bancarias y efectivo no deben
  aparecer en estos links porque el flujo local espera confirmar cobros de
  tarjeta.
- En Payment Links de Rebill, Ristak manda `prefilledFields.customer` con
  `email`, `fullName`, `phoneNumber`, `countryCode` y `language='es'` cuando el
  contacto los tiene. Para Payment Links, `phoneNumber` recibe solo digitos
  nacionales y `countryCode` recibe la lada (`+52`, `+1`, etc.); esto replica el
  comportamiento de suscripciones donde el cliente ya ve su identidad cargada en
  el checkout hospedado.
- Meses/installments en cobros unicos: en el modal de cobro, Rebill entra al
  mismo paso de decision que Stripe, Conekta, Mercado Pago y CLIP: contado o MSI.
  Si se elige MSI, Ristak pide el maximo de meses (3, 6, 9, 12, 18 o 24), guarda
  `metadata.rebillInstallments.maxInstallments` y conserva
  `enabledInstallments`. En todos los links publicos de Rebill, contado o MSI, y
  en todos los Payment Gate de Sites con Rebill, Ristak crea un Payment Link
  hospedado de Rebill (`pay.rebill.com`) card-only; en Sites el boton del bloque
  crea el pago local y redirige a esa URL. La pagina local
  `/pay/:publicPaymentId` se conserva como superficie de retorno, estado, errores
  y fallback; si alguien abre la URL local de un pago Rebill abierto, Ristak crea
  o recupera el Payment Link hospedado y redirige cuando existe.
  Al crear el Payment Link hospedado, Ristak manda solo tarjeta en
  `paymentMethods`, conserva `showCoupon=false`, agrega `installmentsSettings` y
  mantiene el `title` como el concepto visible del cobro. `description` solo se
  manda cuando el usuario configuro una descripcion real distinta del titulo; no
  debe usarse para meter datos del negocio porque Rebill la muestra dentro del
  resumen del producto y se ve saturado. La informacion publica del negocio
  configurada en Pagos/recibos (nombre, email, telefono, web, direccion, soporte y
  URL publica del logo) se conserva en `metadata` para trazabilidad. Rebill muestra
  el logo del hosted checkout con el branding de la organizacion configurado en
  Rebill; la API de Payment Links no sube un archivo de logo por link desde Ristak.
  En sandbox, Rebill muestra la lista inicial de mensualidades configuradas, pero
  al validar el BIN de la tarjeta puede bloquear el selector si el emisor/pais no
  devuelve MSI; para Mexico, probar con tarjetas que el endpoint de Rebill marque
  como credito MX y con `installments` disponibles.
- Tarjetas sandbox Rebill Mexico: la ayuda visible debe usar la tabla oficial
  vigente del SDK: Visa debito `4111 1111 1111 1111`, Visa credito
  `4242 4242 4242 4242`, Mastercard debito `5555 5555 5555 4444`,
  Mastercard credito `5105 1051 0510 5100`, AmericanExpress credito
  `3456 7800 0000 007`, `3411 1111 1111 111`, `3434 3434 3434 343`,
  y Carnet credito `5062 5416 0000 5232`, `5064 0501 0000 0063`,
  `5064 5100 0030 0020`; todas vencen `10/29`, usan CVV `123` salvo
  AmericanExpress con `1234`. Para probar MSI hay que usar tarjetas de credito;
  debito no debe prometer mensualidades.
- Suscripciones Rebill: la pantalla de Suscripciones y el flujo movil/PhoneChat
  permiten crear suscripciones con Rebill cuando la pasarela esta conectada.
  Ristak crea primero un Plan de Rebill (`POST /v3/plans`) y despues un Payment
  Link hospedado (`POST /v3/payment-links`) card-only, sin cupon, con el campo
  `plan` como objeto `{ id: <rebillPlanId> }`; no se manda `type` porque Rebill lo
  infiere a partir de `plan`. El link conserva metadata local
  (`ristakSubscriptionId`, pago inicial y contacto). El cliente se redirige al
  checkout hospedado de Rebill para autorizar la tarjeta. Ristak guarda
  `subscriptions.rebill_plan_id`,
  `rebill_payment_link_id`,
  `rebill_payment_link_url`, `rebill_subscription_id`, `rebill_customer_id` y
  `rebill_card_id` para conciliacion posterior.
- Suscripciones Rebill desde Sites: el bloque de pago de Sites puede crear una
  suscripcion Rebill mensual o anual sin contacto previo. Antes de redirigir, el
  checkout publicado pide correo y telefono, crea o liga el contacto local y pasa
  esos datos como `prefilledFields.customer` al Payment Link hospedado. El Plan y
  Payment Link de Rebill conservan la metadata `site_checkout_subscription` y el
  objeto `paymentGate` para que webhooks, pagos iniciales y conciliacion posterior
  sepan de que sitio, pagina y bloque salio la suscripcion.
- Las suscripciones Rebill solo aceptan frecuencia mensual o anual. Ristak bloquea
  diario/semanal porque los planes de Rebill documentados usan `month` o `year`.
  Si la suscripcion tiene fecha final, Ristak calcula `repetitions` para el Plan;
  si no, queda abierta hasta que se pause o cancele.
- Despues de autorizar el checkout hospedado, Rebill manda
  `subscription.created`/`subscription.updated`; Ristak sincroniza el estado local,
  IDs de proveedor, cliente, tarjeta y proximas fechas de cobro. Los cobros
  recurrentes llegan como `payment.created`/`payment.updated`; si no existe una
  fila local para ese cargo, Ristak la crea desde el webhook, la asocia a la
  suscripcion y resuelve el contacto por metadata local, email o telefono mediante
  el resolvedor de pagos existente.
- Cron `rebill-payment-plans`: corre por el registry de crons de integracion y
  solo se activa si Rebill esta conectado en el modo de pago activo. Revisa
  primeros pagos y parcialidades que vencen en el día actual segun la zona
  horaria de la cuenta. Las fechas de días anteriores pasan a revisión y no se
  cobran por catch-up. Si
  el flujo ya tiene `rebill_card_id`, cobra con `POST /v3/checkout` usando
  el `customer` estructurado del contacto + `cardId`; si el primer pago estaba
  programado y aun no hay tarjeta, libera su Payment Link hospedado de Rebill.
  No delega el calendario a Rebill.
- Webhook publico `/api/rebill/webhook`; como la documentacion publica de Rebill
  no declara firma verificable para webhooks, Ristak no confia en el payload para
  marcar pagado. Cada evento extrae el `paymentId` y consulta el pago real con
  `GET /v3/payments/:id` usando la `sk_` del backend antes de actualizar la fila.
- El endpoint
  `POST /api/rebill/public/payments/:publicPaymentId/confirm` queda para retorno
  manual o compatibilidad legacy: si recibe un `paymentId`, el backend vuelve a
  consultar Rebill antes de marcar `payments.status='paid'`. El camino normal de
  Payment Links hospedados se confirma por webhook y consulta server-side.
- Configuracion > Pagos > Rebill valida la organizacion con
  `GET /v3/organizations/me` y, si la app tiene URL publica HTTPS, intenta crear o
  actualizar automaticamente el webhook con eventos `payment.created`,
  `payment.updated`, `subscription.created` y `subscription.updated`. Si la URL
  publica no existe, queda en estado
  `pending_public_url` y la UI muestra un aviso simple; no expone botones para
  copiar URL o eventos porque la configuracion normal es automatica.
- Variables de automatizacion: `payment.rebill_payment_id`,
  `payment.rebill_subscription_id`, `payment.rebill_customer_id` y
  `payment.rebill_card_id`.

Persistencia:

- `payments.payment_provider='rebill'` y `payments.payment_method='rebill_checkout'`
  para cobros unicos; en suscripciones usa `rebill_subscription`.
- Tarjetas guardadas Rebill en `rebill_payment_sources` (`contact_id`,
  `rebill_customer_id`, `rebill_card_id`, `brand`, `last4`, `mode`, `is_default`).
  Es metadata de fuente de pago; los datos sensibles permanecen en Rebill.
- `payment_flows` guarda `rebill_customer_id`, `rebill_card_id` y
  `rebill_card_label` cuando un plan queda autorizado para cobros automaticos.
- En planes Rebill, cada parcialidad tiene una fila local en `payments` desde el
  alta del plan. Si ya hay tarjeta, queda `status='scheduled'` y sin
  `payment_url`; al vencer, el cron la cobra con `rebill_saved_card`. Si aun no
  hay tarjeta, queda esperando autorizacion hasta que el primer pago o la
  domiciliacion guarde el `cardId`.
- IDs de proveedor en `payments.rebill_payment_id`,
  `payments.rebill_subscription_id`, `payments.rebill_customer_id` y
  `payments.rebill_card_id`.
- IDs de suscripcion en `subscriptions.rebill_subscription_id`,
  `subscriptions.rebill_plan_id`, `subscriptions.rebill_payment_link_id`,
  `subscriptions.rebill_payment_link_url`, `subscriptions.rebill_customer_id`,
  `subscriptions.rebill_card_id`, `subscriptions.rebill_next_charge_at` y
  `subscriptions.rebill_last_charge_at`.
- `installment_payments.rebill_payment_id` sincroniza la referencia del pago Rebill
  confirmado para que el espejo `payment_plans.schedule_json` refleje el estado
  real de cada parcialidad.

### Regla pagos test y Meta

Los pagos en modo `test` no deben generar conversiones reales de Meta.

Implementacion esperada:

- `backend/src/utils/paymentMode.js` normaliza modos `test`, `sandbox`, `demo`,
  `live`, `production`.
- `backend/src/services/metaConversionEventsService.js` bloquea eventos Purchase
  para pagos test por default.
- Si Configuracion > Meta tiene activo `meta_test_event_code`, el backend puede
  mandar el evento CAPI con `test_event_code`. Eso debe entrar a Meta Test
  Events, no a conversiones reales.
- Si no hay Dataset/Pixel conectado en Configuracion > Meta, una compra `live`
  puede usar WhatsApp QR/Baileys como fallback aplicando la etiqueta nativa
  `Paid` al chat del contacto. Esto solo aplica si el contacto tiene telefono,
  el numero QR esta conectado y Baileys ya sincronizo esa etiqueta nativa.
- Si existe Dataset/Pixel conectado, no se aplica la etiqueta QR de compra:
  CAPI/dataset es la fuente principal y no se deben duplicar senales de compra.
- Los pagos `test`, `sandbox` o `demo` tampoco deben aplicar etiquetas QR de
  compra, porque las etiquetas nativas de WhatsApp no tienen equivalente de
  Meta Test Events.
- El pixel publico de navegador para checkout no debe usarse para pagos test si
  no hay aislamiento equivalente al `test_event_code` de CAPI.
- En compras con canal `smart`, el `action_source` lo decide la SUPERFICIE REAL
  de la conversion (ver `docs/CONVERSION_ATTRIBUTION.md`): un pago con URL de
  checkout es `website` aunque el contacto tenga atribucion de mensajeria; un
  pago sin checkout usa el canal de la conversacion mas reciente
  (WhatsApp/Messenger/Instagram) y cae a website/system_generated si no hay
  mensajeria. La atribucion interna (ultimo paid touch) se guarda en
  `payments.attribution_*` + `conversion_surface` y viaja como metadata en
  `custom_data` (ad_id, ad_name, attribution_channel).
- El pixel publico del checkout SIEMPRE se genera para pagos de checkout (la
  superficie es website); comparte `event_id` con el evento server-side para
  que Meta deduplique. Solo se suprime si el canal configurado es un override
  explicito de mensajeria (whatsapp/messenger/instagram).
- Tests: `backend/test/metaPaymentPurchaseEvent.test.mjs` y
  `backend/test/conversionAttribution.test.mjs`.

Esta regla existe para que los reportes de Meta no se contaminen con compras de
prueba. No la debilites por comodidad.

## Meta, tracking y atribucion

Ristak usa Meta en varias areas:

### Conexión OAuth, App Review y retirada del método manual

- Desde el **20 de julio de 2026**, las conexiones nuevas usan OAuth separado
  por capacidad. **Meta Ads** está disponible con `ads_read`; **Redes sociales**
  queda detrás de `meta_oauth_review_mode` mientras Meta termina Advanced Access
  para mensajes, comentarios y webhooks.
- La app central ya tiene aprobados `ads_read`, `business_management`,
  `pages_show_list`, `pages_read_engagement`, `public_profile`,
  `whatsapp_business_management` y `whatsapp_business_messaging`. Los permisos
  base de Pages no bastan para el inbox: siguen faltando
  `pages_manage_metadata`, `pages_read_user_content`,
  `pages_manage_engagement`, `pages_messaging`, `instagram_basic`,
  `instagram_manage_comments` e `instagram_manage_messages`.
- Una cuenta nueva ve **Conectar Meta Ads**. El botón usa
  `/api/meta/oauth/ads/*`, vuelve a Meta Ads y exige elegir una cuenta
  publicitaria antes de **Guardar**; el Dataset es opcional. `/initialization`
  manda a esa pantalla para no perder la sesión de selección.
- Cuando sólo Ads está conectado, la pestaña **Redes sociales** muestra
  **Pendiente de aprobación** y no expone OAuth ni switches falsamente
  funcionales. Al cambiar `meta_oauth_review_mode=false` en Installer, la misma
  pantalla habilita **Conectar Facebook e Instagram** mediante
  `/api/meta/oauth/social/*`.
- Installer es el único dueño de `meta_app_secret`,
  `meta_ads_login_config_id`, `meta_social_login_config_id`,
  `meta_business_login_config_id` y la compuerta de revisión. Los secretos nunca
  se copian a una instalación.
- Las conexiones separadas activas viven cifradas por `ads|social` en
  `meta_oauth_integrations`; sus sesiones one-time viven en
  `meta_oauth_integration_sessions`. Sus inventarios autorizados viven cifrados
  en `meta_oauth_authorized_assets` bajo `split:ads|split:social`, ligados al
  `connection_id`. La conexión combinada anterior permanece en `meta_config`
  como `legacy`, con sesiones en `meta_oauth_pending_sessions` e inventario
  `unified` en la misma tabla de activos.
- Las rutas canónicas para cuentas nuevas son
  `/api/meta/oauth/:integrationKind/{status,status/refresh,connect-url,complete,reconfigure,finalize,disconnect}`.
  Los endpoints sin segmento siguen sólo para conexiones combinadas legacy. Las
  rutas manuales de guardado/revelado/importación responden
  `410 META_OAUTH_REQUIRED`.
- Ristak reclama cada handoff server-to-server, valida que
  `integration_kind=ads|social|legacy` coincida y mantiene la conexión anterior
  hasta que el nuevo tipo termina su `finalize`. Un fallo Ads no toca Social y
  viceversa.
- Para liberar Social: verificar permisos completos y Config ID en App
  Dashboard, probar Page/Instagram/relay/mensajes/comentarios, cambiar
  `meta_oauth_review_mode` a `false` en Installer y completar una conexión real
  antes de anunciarla. El procedimiento completo vive en `docs/META_OAUTH.md`.
- Al iniciar OAuth, Ristak convierte la ruta de regreso en una URL absoluta del
  host publico que origino la solicitud. Installer valida ese origin contra la
  instalacion antes de guardarlo en `state`; asi el callback central no manda al
  usuario al dominio generico `app.ristak.com` cuando conecto desde un tenant
  Render. Con Strict Mode de Meta, la lista de redirects debe incluir el callback
  central completo, no solo la raiz de `www.ristak.com`.
- Al volver, Ristak conserva activos anteriores sólo si pertenecen a la misma
  conexion OAuth y siguen autorizados. Una conexion nueva empieza sin Page, Ad
  Account, Dataset ni Instagram. Cambiar un dropdown sólo actualiza el borrador;
  pulsar Guardar abre una sesión one-time con `reconfigure` y manda un único
  `finalize` para la seccion correspondiente. Después del commit, los dropdowns
  permanecen visibles con nombres y opciones tomados del inventario cifrado; no
  se degradan a texto genérico. `status/refresh` recupera ese inventario desde
  Installer para conexiones separadas o unificadas creadas antes de esta
  persistencia; la pantalla dispara ese backfill sólo cuando falta el inventario
  local.
  Instagram exige una Page enlazada. Si Meta devuelve tareas de Page, Ristak
  exige `MESSAGING` y `MODERATE`.
- El Dataset se descubre por `/act_<AD_ACCOUNT_ID>/adspixels` para pixels
  clásicos y por `/{BUSINESS_ID}/ads_dataset` para Datasets modernos. Los edges
  `owned_pixels|client_pixels` sólo producen candidatos: la relación de cuenta
  debe confirmarse con `/{DATASET_ID}/adaccounts` o `/shared_accounts`. La UI
  muestra sólo los Datasets conectados a la cuenta elegida y limpia una selección
  incompatible al cambiar de cuenta. Un `OAuth 190` obliga a reconectar y nunca
  se presenta como una lista vacía. En BISU, Installer y Ristak exigen `UPLOAD`
  en `assigned_users`; en USER, Ristak confia en la allowlist firmada ya
  resuelta. No manda un evento automatico durante el login.
- Ristak prepara `subscribed_apps`, Page token/proof, configuracion Ads/Dataset
  y ruta del broker antes de promocionar. Una confirmacion central con fallo
  local queda en reparacion automatica en lugar de hacer rollback a ciegas.
- Una sola app Meta implica un solo callback de webhooks. Installer
  valida `X-Hub-Signature-256`, deduplica, enruta por Page/Instagram y
  retransmite a `/webhooks/meta/installer-relay` con HMAC de licencia,
  timestamp, nonce e ID estable.
- El callback registrado en Meta siempre es el central de Installer. El dominio
  público de cada Render sólo se usa como regreso firmado después del callback y
  como destino del relay; jamás necesita agregarse a Valid OAuth Redirect URIs.
- El User Access Token no es permanente: Installer lo amplía y Ristak conserva
  sus expiraciones, muestra aviso de renovación y mantiene separado el Page
  token para que Messenger/comentarios no hagan `/me` en cada operación.
- Al desconectar, Installer restaura la ruta OAuth Social separada si era el
  fallback de esa Page y Ristak restaura el System User Token manual cifrado si
  existia. Las filas separadas no se eliminan. HighLevel nunca recibe,
  reconcilia ni borra credenciales OAuth. WhatsApp Embedded Signup sigue
  separado porque usa otro Config ID y activos distintos.
- Contrato completo, permisos y checklist de revision:
  `docs/META_OAUTH.md`.

- **Contrato local-first de Configuracion > Meta.** Abrir, cambiar de pestaña o
  volver al wizard sólo puede leer estado local. `GET /api/meta/custom-values`,
  `GET /api/meta/oauth/status`, `GET /api/meta/assets`, los GET compatibles de
  `ad-accounts|pixels|pages|social-profiles`, `GET /api/meta/verify-token`,
  `GET /api/meta/webhook-info` y `GET /api/meta/social/messaging/setup` no llaman
  HighLevel, Installer ni Meta Graph; tampoco reconcilian, limpian sesiones,
  migran secretos ni escriben en base. Si encuentran una credencial legacy en
  texto plano la usan sólo en memoria: el cifrado oportunista queda para la
  siguiente mutacion explicita, nunca para la navegación.
- El inventario autorizado de OAuth se pinta directamente desde
  `meta_oauth_authorized_assets`: `unified` identifica el login combinado y
  `split:ads|split:social` las conexiones separadas. El modo manual usa el snapshot durable
  `app_config.meta_asset_snapshot_v1`, ligado a un fingerprint SHA-256 de la
  conexion para que un cambio de token no pueda reutilizar activos ajenos. El
  snapshot guarda sólo metadata de cuentas, Datasets, Pages y perfiles; jamás
  tokens. Se muestra aun si está vencido para que la interfaz abra de inmediato,
  se reemplaza atomicamente al refrescar y se invalida al desconectar. Una
  cantidad de seguidores no disponible se conserva como `null`; nunca se
  convierte artificialmente en cero.
- Las operaciones remotas son intencionales y usan `POST`:
  `/api/meta/assets/refresh` consulta identidad una vez y carga cuentas, Pages y
  los Datasets de la cuenta elegida en paralelo;
  `/api/meta/social-profiles/refresh` actualiza foto y seguidores con los Page
  tokens/proofs cifrados de cada Page autorizada;
  `/api/meta/oauth/status/refresh` verifica Installer; y
  `/api/meta/sync-from-highlevel` hace una sola lectura de Custom Values. Un
  HighLevel vacío o incompleto en dirección `from_highlevel` nunca dispara el
  camino inverso ni pisa Meta local. Los aliases OAuth `social|ads` conservan el
  mismo corte entre GET local y POST remoto.
- Regresión obligatoria: `backend/test/metaSettingsPassiveReadContract.test.mjs`
  abre todos los lectores pasivos con HighLevel e Installer configurados,
  compara la base antes/después y exige cero llamadas remotas y cero escrituras.

- Meta Ads config y sync. En `Configuracion > Meta > Meta Ads`, el dropdown
  **Actualizar datos de anuncios** permite elegir 5, 10, 15 o 30 minutos; 1, 2,
  3, 6 o 12 horas; o 1 día. El default para instalaciones sin configuración es
  una hora. La selección se guarda inmediatamente en
  `app_config.meta_ads_sync_interval_minutes` y reprograma el job activo sin
  reiniciar el backend. Los endpoints canónicos son `GET` y `PUT`
  `/api/meta/sync/settings`; backend valida la lista y el job sigue apagado si
  no existe una cuenta publicitaria conectada. Cada ejecución conserva guard
  anti-solape y lock distribuido para no duplicar consultas a Meta.
- En la misma configuración, los selectores y resúmenes de cuenta publicitaria,
  **Dataset o pixel**, Facebook Page e Instagram muestran únicamente el nombre
  legible. Los IDs se conservan como valores internos para hablar con Meta, pero
  no se imprimen en la interfaz ni como subtítulo ni dentro de las opciones.
- `Rastreo web` mantiene los parametros UTM y la inclusion del Dataset en el
  snippet; no se mezcla con el login ni con los controles sociales.
- `Dataset Test` conserva su propia pestana; las rutas internas pueden
  conservar `pixel` por contrato con Meta y tracking.
- En Dataset Test, los eventos web usan `action_source=website`; los eventos
  `LeadSubmitted (Messaging)` y `Purchase (Messaging)` usan
  `action_source=business_messaging` y permiten probar WhatsApp, Messenger o
  Instagram DM desde la UI. WhatsApp requiere `ctwa_clid` + `page_id`;
  Messenger requiere `page_scoped_user_id` + `page_id`; Instagram requiere
  `ig_sid` + `ig_account_id`. Dataset/token principal salen de Ads; Page/Page
  Token salen de Social o del login combinado legacy, cada uno con su proof
  correcto. Los secretos manuales previos pueden seguir como compatibilidad
  interna, pero no vuelven a presentarse como método de conexión.
  `Purchase (Messaging)` se envia a Meta como `event_name=Purchase` y usa por
  default la moneda de la cuenta (`app_config.account_currency`).
- Conversions API acepta OAuth Ads separado o el OAuth combinado legacy activo;
  exige `ads_read` y un Dataset validado. System User Token manual y
  `META_ACCESS_TOKEN` quedan sólo como compatibilidad. Una conexión Ads sin
  Dataset sigue válida para reportes y deja CAPI apagado.
- Elegir una Ad Account arranca Ads sync; elegir una Page o Instagram prepara
  sólo su runtime social y backfill. Messenger/comentarios se habilitan al elegir
  Page y DMs/comentarios de Instagram al elegir la cuenta enlazada. Ristak no
  pide un token separado de Instagram.
- La suscripcion de Page/webhooks es programatica y la UI nunca pide copiar
  tokens ni valores de Developers. La suscripcion canonica del inbox pide
  `messages`, `message_echoes`, `message_edits`, `message_reactions`,
  `message_reads`, `message_deliveries`, `messaging_postbacks`,
  `messaging_referrals` y `feed`: los primeros ocho mantienen DMs, estados y
  origen; `feed` conserva comentarios de Facebook. No se suscriben campos de
  pagos, carrito, juegos o account linking si esos productos no estan activos.
  Como la configuracion previa de Meta no se reejecuta sola cuando Ristak agrega
  un campo de webhook, cada arranque reconcilia idempotentemente esa lista para
  instalaciones ya conectadas. Esa pasada solo llama a Meta si la integracion y
  Messenger estan activos; no prende Messenger ni modifica una Page desconectada.
  El webhook entrega eventos futuros. El historial previo se importa de forma
  separada por Conversations API y se deduplica por ID de mensaje; no depende de
  que Meta vuelva a emitir los mensajes viejos por Webhook.
- **Messenger externo** usa el Page Token y su proof entregados por Installer;
  no aparece un segundo campo ni se acepta un User Token humano. Ads/CAPI usan el User
  Access Token de larga duración (`oauth_user`; BISU sólo en legado) y
  Messenger/Instagram/comentarios usan el Page Token. El toggle solo se
  habilita cuando existe el activo OAuth requerido. Las tarjetas no muestran
  botones de Meta Developers: la app y el webhook pertenecen al Installer central.
- El bloque **Perfil de red social** del editor de Sites lee primero el OAuth
  unificado activo de `meta_config`, despues la conexion Social separada y al
  final los campos manuales `page_id`, `instagram_account_id` y `access_token`.
  El endpoint no debe interpretar el JWT de sesion de Ristak
  como token de Meta; solo usa `X-Meta-Access-Token` durante el wizard manual
  cuando se esta probando un token explicito. Al cargar el catálogo del editor,
  Sites ejecuta una mutación explícita de refresh y luego consume el snapshot
  local: cada Page OAuth usa su propio Page Token y `appsecret_proof`, y las
  lecturas de Facebook e Instagram separan identidad/avatar de conteos si Meta
  rechaza un grupo de fields. Si el refresh falla, conserva el último valor real
  guardado en vez de reemplazarlo por vacíos o ceros. En sitios publicados, el
  refresh diario de Meta actualiza avatar, nombre y seguidores de bloques con
  `socialAutoSync=true`; si un bloque legacy no tiene `socialSourceProfileId`,
  puede adoptar el perfil configurado que coincida con su plataforma. Cuando el
  bloque esta asociado a un slot `social-profile` de HTML importado, conserva la
  misma fuente, el mismo refresh diario y la opcion manual `brandVerified`, pero
  el renderer llena los hooks del HTML en vez de sustituir el diseño creado por
  la IA. Nunca expone el token de Meta ni consulta la red social desde el
  navegador publico. Cuando el bloque vive dentro de un formulario nativo o un
  formulario embebido en Sites,
  se alinea con el mismo carril de ancho y justificacion que los campos, opciones,
  acciones y pagos del formulario.
- Cuando Meta ya tiene dataset/pixel y token guardado, las nuevas superficies nacen
  con Meta encendido por default: Sites/landings y paginas nuevas usan solo el
  `PageView` base al aterrizar (browser Pixel + CAPI server-side, sin `ViewContent`
  ni otra conversion extra), formularios usan `Lead` al enviar y calendarios usan
  `Schedule` al agendar. Bloques de calendario embebido tambien crean su trigger
  `Schedule` al agregarse. El usuario puede apagarlos manualmente despues.
- Las conversiones server-side de mensajeria Meta comparten el mismo servicio:
  WhatsApp, Messenger e Instagram usan `action_source=business_messaging` con
  `messaging_channel` segun el canal real. `Purchase` conserva `event_name=Purchase`
  y toma `currency` desde la cuenta; las citas de mensajeria usan
  `LeadSubmitted`.
- Atribucion interna y payload de Meta son dos conceptos SEPARADOS: la
  atribucion la decide el ultimo paid/ad touch valido del contacto
  (`backend/src/services/conversionAttributionService.js`) y el payload CAPI lo
  decide la superficie real donde ocurrio la conversion. Nunca se falsifica
  `action_source`. Ese ultimo touch puede ser un anuncio posterior guardado en el
  historial, pero no debe pisar `contacts.attribution_ad_id`, porque ese campo
  es adquisicion inicial. Detalle completo en `docs/CONVERSION_ATTRIBUTION.md`.
- Social messaging nativo separa los contratos de envio: Messenger envia por
  `graph.facebook.com/{PAGE_ID}/messages` con token de Pagina; Instagram DM tambien envia por el nodo
  `graph.facebook.com/{PAGE_ID}/messages` cuando la cuenta profesional esta
  enlazada a la Page. En manual Ristak deriva el Page token desde la credencial
  base y liga su cache al hash del token origen. En OAuth usa el Page token y
  `page_appsecret_proof` entregados por Installer para la Page seleccionada; no
  reutiliza el proof del token principal con el Page Token. Si Meta invalida esa credencial, exige
  reconectar OAuth en vez de pedir el App Secret central. En modo manual, un
  rechazo de token invalida la derivacion y permite repetir una sola vez el POST
  ya rechazado; en OAuth una credencial invalida exige reconexion. Texto, audio,
  adjuntos y reacciones comparten este manejo. Si falta el Page token, la
  integracion falla con un error accionable; no hay token alterno de Instagram.
  El recipient sigue siendo el IGSID recibido por webhook. Los envios de
  Automatizaciones llevan un `externalId` determinista por
  `automationId + enrollmentId + nodeId + bloque`: un reintento de la misma
  inscripcion reutiliza el despacho, pero un reingreso legitimo crea otro. Antes
  de Graph se reserva una fila `pending`, pasa a `sending` y luego a
  `accepted/sent`; la llave primaria derivada evita que dos workers hagan dos
  POST. Un resultado de red ambiguo queda bloqueado como `send_unknown` para no
  duplicarlo a ciegas. Si el webhook echo llega antes o despues de guardar, se
  fusiona por `meta_message_id` con esa reserva y la copia local autoritativa
  conserva URL publica, `externalId`, voz, nombre y contexto.
  Las mutaciones notificadas por Meta se reconcilian sobre ese mismo
  `meta_message_id`: `message_edit` reemplaza el texto sin crear otro globo ni
  incrementar no leidos, y `message.is_deleted=true` conserva una marca
  `Mensaje anulado` mientras elimina texto, adjunto y payload original. Aplica a
  mensajes entrantes y a ecos salientes de Instagram o Messenger cuando Meta
  entregue ese webhook. Una mutacion no dispara automatizaciones, agente,
  confirmaciones ni notificaciones nuevas. La API publica de Meta no expone una
  operacion para editar desde Ristak un mensaje que ya fue enviado; por eso la
  interfaz no debe fingir una edicion local que el destinatario no veria.
  Para perfil/DM/comentarios la credencial activa debe tener los permisos
  Meta correspondientes (`instagram_manage_messages`,
  `instagram_manage_comments`, `pages_messaging`, `pages_manage_engagement`,
  `pages_read_user_content`, `pages_read_engagement`/`pages_show_list` segun el
  endpoint y acceso a la Page); no se debe pedir otra credencial en Redes
  sociales. Facebook comments tiene tres contratos distintos: recibir comentarios
  por webhook usa la suscripcion `feed` de la Page; responder publicamente un
  comentario usa `/{COMMENT_ID}/comments` y requiere `pages_manage_engagement`;
  leer comentarios historicos por Graph (`/{PAGE_ID}/posts?...comments` o
  similares) puede requerir `pages_read_user_content` o Page Public Content
  Access aunque `pages_read_engagement` aparezca como concedido.
  Los switches son `meta_messenger_messaging_enabled` /
  `meta_instagram_messaging_enabled` para DMs y
  `meta_facebook_comments_enabled` / `meta_instagram_comments_enabled` para
  comentarios. Si Meta responde `(#3) Application does
  not have the capability...`, Ristak debe tratarlo como bloqueo de
  capability/App Review, no como fallo generico: Messenger requiere
  `pages_messaging`; Instagram DM requiere capacidad/permisos de mensajeria de
  Instagram en la app (`instagram_manage_messages` o el permiso equivalente del
  flujo Instagram Login), app en Live para clientes reales y Advanced Access
  cuando aplique.
- Al conectar Meta con una Facebook Page o al prender
  `meta_messenger_messaging_enabled` / `meta_instagram_messaging_enabled`,
  Ristak inicia en segundo plano un backfill de conversaciones disponibles por
  Graph Conversations API: Messenger usa `/{PAGE_ID}/conversations` con Page
  token; Instagram usa `/{INSTAGRAM_ACCOUNT_ID}/conversations?platform=instagram`
  con ese mismo Page token por Facebook Graph. El backfill pagina conversaciones y mensajes hasta
  que Graph deja de devolver cursor; no aplica topes silenciosos por conversacion
  ni por cuenta. Los limites solo se aceptan como parametros explicitos para una
  ejecucion manual/controlada. El importador conserva el payload Graph completo,
  adjuntos y relaciones expuestas por Meta, rehospeda media temporal para que no
  caduque,
  deduplica por `meta_message_id`, guarda inbound/outbound en
  `meta_social_messages` y fusiona el contacto por PSID/IGSID igual que los
  webhooks. Es historial: no incrementa no leidos, no dispara push,
  automatizaciones, confirmaciones ni agente conversacional. La suscripcion de
  webhook no reenvia eventos viejos: Ristak primero la asegura para capturar lo
  nuevo y deduplica por ID mientras el backfill trae lo disponible. Meta puede no
  devolver hilos de Requests inactivos por mas de 30 dias; Ristak importa todo lo
  que la API expone y registra skip/fallos sin bloquear la conexion.
- Los comentarios publicados por la propia Pagina de Facebook o cuenta de
  Instagram no se descartan como anti-loop. Si llegan por webhook y tienen
  `parent_id`, Ristak los enlaza al comentario padre ya guardado y los refleja en
  el chat del contacto como `comment_reply_public` saliente. Esos ecos propios no
  incrementan no leidos ni disparan automatizaciones o agente conversacional.
- Los comentarios de Facebook e Instagram nunca deben pintar globos vacios en
  Chat o Movil. Si Meta entrega un comentario sin texto, Ristak muestra
  `Comentario sin texto` solo como fallback visual; ese texto generico no debe
  persistirse como contenido real del mensaje, porque Meta puede reenviar el
  mismo `comment_id` sin `message` y no debe pisar el comentario original. Si el
  comentario, media o publicacion relacionada se elimina o deja de estar
  disponible por Graph, conserva la fila como historial y muestra
  `Comentario eliminado`. El contexto de la publicacion comentada se cachea en
  `meta_social_posts`; si Graph ya no expone el post/media, el chip del globo
  queda como `Publicacion eliminada` sin borrar el hilo.
  La foto del comentario y la imagen de contexto de la publicacion se rehospedan
  en el storage de chat cuando Meta entrega una URL temporal. Si una fila legacy
  todavia apunta a `fbcdn`, `scontent` o `cdninstagram`, la siguiente lectura del
  chat renueva el contenido contra Graph, lo rehospeda y reemplaza esa URL por la
  persistente; no hace falta esperar a que Meta reenvie otro comentario.
  Mientras una imagen no esta disponible o falla, `/chat` y `/movil` conservan el
  tamaño del preview y muestran placeholder; nunca el icono roto del navegador.
- El enriquecimiento de contactos Meta usa el mismo contrato de Page token:
  Messenger lee perfil/conversaciones por Facebook Graph con Page token;
  Instagram lee perfiles de DMs y autores de comentarios con las mismas
  credenciales resueltas para Instagram (`name,username,profile_pic`). Si el
  perfil directo no trae nombre, Instagram cae a
  `/{INSTAGRAM_ACCOUNT_ID}/conversations?platform=instagram` usando el token/baseUrl resuelto. Las
  fotos recibidas se rehospedan best-effort antes de guardarse en
  `meta_social_contacts.profile_picture_url`; si Meta no entrega foto o permisos,
  Ristak conserva el mejor nombre disponible y no inventa avatar.
- Business Messaging events.
- Campaign Builder en modo preview/validacion segun entorno.
- Test Events desde Configuracion > Meta.

Tracking:

- `/snip.js` instala el pixel Ristak.
- `/collect` y rutas de tracking guardan eventos.
- El pixel se ejecuta en el origen de la página, aunque `snip.js` y `/collect`
  compartan host. `publicTrackingRoutes` usa CORS público propio, sin
  credenciales y limitado a orígenes web `http(s)`; la allowlist CORS global
  sigue reservada para el dashboard y las APIs privadas. El tracking externo no
  depende de `CORS_ALLOWED_ORIGINS` ni de agregar dominios manualmente en Render.
- `sessions` conserva evento/sesion/visitante, UTMs, click IDs, geo, device,
  identidad y matching.
- `tracking_source` distingue el pixel instalado en páginas externas
  (`external_pixel`) del renderer público nativo de Sites (`native_site`) y del
  tracking de sus videos (`native_site_video`). No se deben mezclar ni contar
  filas como si cada evento fuera una sesión nueva.
- Sites y formularios publicados emiten tracking nativo en su dominio público.
  El editor, las sesiones de preview y los modos `no_track` lo desactivan a
  propósito; una prueba real exige dominio conectado, Site publicado, navegador
  real y confirmación en DB.
- El incidente de CORS del 15 de julio de 2026, la frontera de seguridad, las
  reglas para Cloudflare/CDN y el procedimiento end-to-end viven en
  `docs/TRACKING_PIXEL.md`. Cualquier agente que optimice o audite esta tubería
  debe leer ese contrato antes de cambiar CORS, cookies, caché, dominios o rutas.

Documentos:

- `docs/TRACKING_PIXEL.md`
- `docs/PIXEL_SETUP.md`

## Sites, formularios y dominios

Sites es el constructor/publicador de paginas. Incluye:

- Editor visual.
- Bloques propios.
- Importacion de sitios/HTML.
- Assets importados.
- Dominios y resolucion publica.
- Formularios y submissions.
- Prefill.
- Checkout/pago publico.
- Calendarios embebidos.
- Video/media.
- Eventos Meta y tracking.
- AI create/edit para contenido.

En Sitios > Analíticas, al elegir un formulario específico, Ristak muestra un
embudo de completición por pregunta calculado desde las respuestas guardadas del
rango seleccionado: vistas, visitantes, envíos, porcentaje de finalización y
cuántas personas respondieron o dejaron sin respuesta cada campo. Al elegir un
sitio/landing específico, la misma vista muestra el resumen de conversión del
sitio con vistas, visitantes, sesiones y conversiones. En la categoría Sitios,
el filtro separa Sitios web y Embudos antes de elegir una pieza específica, y el
dashboard recalcula métricas, videos asociados y conversiones sólo para esa
categoría.

En el editor visual, los bloques de calendario embebido eligen el calendario y
la accion posterior a la cita desde la barra superior del editor. El inspector
derecho solo muestra el estado del calendario seleccionado y los controles de
diseno/estilo, para no duplicar la misma decision en dos superficies.
Cada bloque o elemento editable incluye en el inspector derecho la categoria
`Visibilidad`, con dos controles independientes: `Computadora` y `Celular`.
Ambos nacen activos para mantener el comportamiento historico. Apagar uno oculta
el elemento solo en ese tipo de dispositivo; apagar los dos equivale a ocultarlo
por completo. El ojo del panel izquierdo representa ese estado global: aparece
apagado cuando ningun dispositivo esta activo y, al volver a mostrar el elemento
desde ahi, reactiva ambos. El canvas conserva atenuados los elementos ocultos en
la vista seleccionada para que sigan siendo editables, mientras preview y
publicado los eliminan realmente del layout en el breakpoint correspondiente.
Las acciones de formularios, calendarios, pagos y botones pueden avanzar a la
siguiente pagina, redirigir a una URL o ir a una pagina especifica del mismo
proyecto usando el selector de paginas de esa landing.
Al agregar un formulario nuevo dentro de una landing, el bloque nace con un
preset visual consistente entre editor y publicado: no se estira a toda la
franja, queda centrado, usa espacio compacto, ancho angosto, esquinas cuadradas
y borde fino. Estos valores solo son el punto de partida; el usuario puede
ajustarlos desde Diseño del formulario. Los formularios guardados que se
embeben conservan su diseño propio.
La biblioteca de sitios y formularios permite seleccionar varios elementos con
checkboxes en vista galeria, lista o tabla y eliminarlos juntos con confirmacion
destructiva. Los controles masivos de `Todos los visibles` y `Eliminar` aparecen
solo despues de marcar al menos un elemento; en vista tabla viven dentro de la
toolbar de seleccion comun de las tablas. Esta seleccion multiple no aparece
dentro del selector de paginas del editor de sitios; ahi las paginas se eliminan
una por una desde su menu.
En vista galeria, la miniatura usa el mismo renderer de preview que el editor y el
publicado, en un iframe inerte y sin tracking. Por eso una landing HTML enseña el
layout completo del primer pliegue —copy, columnas, fondos y slots nativos— en vez
de intentar reconstruirse a partir de sus bloques conectados. El ancho fuente es
un viewport de escritorio completo y se escala al ancho real de la tarjeta; el
recorte vertical siempre comienza en la parte superior de la primera pagina.

La ruta publica puede depender de dominio, slug, host o rutas internas. Cualquier
cambio a Sites debe revisar editor, renderer publico, submissions y tracking.
En landings ruteables, incluidas las paginas subidas como HTML importado, cada
pagina puede tener su propia ruta publica del dominio sin quedar obligada a vivir
debajo del slug del sitio: una pagina principal puede usar `/promo`, `/agenda` o
cualquier slug valido. En landings nativas con modo sitio web, las subpaginas
usan la jerarquia de su pagina padre (`/promo/detalles`); en HTML importado las
paginas se rutean como paginas principales del archivo importado. Las paginas
nuevas o importadas sin ruta manual nacen con slugs neutrales secuenciales
(`/rstk01`, `/rstk02`, etc.) para evitar rutas automaticas tipo `/sitio-01` o colisiones
entre paginas nuevas. En publicado, los links internos del HTML importado que
apuntan a otra pagina del mismo import tambien se reescriben hacia esa ruta
limpia en lugar de depender de `?page=`. La ruta legacy del sitio
`/<site-slug>` se conserva por compatibilidad y abre la landing como antes. La
opcion "Cambiar ruta" en el menu de tres puntos de cada pagina abre el editor de
ruta de esa pagina especifica, separado de "Cambiar nombre". La
ruta predeterminada de cada dominio puede apuntar a un sitio completo o a una
pagina especifica (`siteId + pageId`): cuando apunta a una pagina, esa pagina
abre en la raiz de ese dominio (`https://dominio/`) y su slug propio sigue
resolviendo como ruta directa.
La ruta `/meta-privacy` esta reservada por el sistema en cualquier host publico
de Ristak, incluyendo el dominio Render `*.onrender.com` y dominios publicos de
Sites. Siempre responde una Privacy Policy publica para Meta/Facebook/Instagram
antes de resolver el dashboard, calendarios o paginas editables del usuario, por
lo que ningun Site, slug o pagina personalizada puede sobrescribirla. El
contenido toma nombre, email, telefono, direccion y sitio web desde
`account_business_profile` (Configuracion > Negocio) y usa el usuario admin activo
solo como respaldo para nombre/email; no depende de secrets externos.
Configuracion > Dominios separa la lista de dominios publicos de la configuracion
de cada dominio: el usuario agrega dominios con "Agregar dominio", el modal
valida que el dominio responda a esta instalacion de Ristak en Render antes de
guardarlo, y luego permite elegir de forma opcional la pagina o formulario que
abrira en la raiz de ese dominio. La base usa `public_site_domains` para permitir
multiples dominios publicos con root independiente; el dominio legacy en
`app_config.sites_public_domain` se mantiene como compatibilidad/primario para
links existentes y se migra a la tabla al leer settings. Se puede configurar
desde Dominios con el selector de pagina oficial, desde el enlace "Hacer pagina
oficial" junto a Ruta publica en Ajustes del editor o con la estrella del menu
de tres puntos de la pagina; las acciones del editor deben confirmar escribiendo
la URL raiz del dominio.
Cuando Meta ya tiene dataset/pixel y token guardado, los sitios nuevos activan
Meta CAPI por default. Las landings nuevas y las paginas nuevas creadas dentro de
una landing existente nacen con solo `PageView` al aterrizar la pagina (browser
Pixel + CAPI server-side, sin `ViewContent` por default); los formularios
nativos/importados/creados por IA encienden `Lead` al enviar. Los bloques de
calendario embebido nuevos nacen con `Schedule`. Las actualizaciones de sitios
existentes no reactivan eventos que el usuario apago manualmente.

En sitios HTML importados, el submit interceptado por Ristak puede declarar una
conversion especifica para Meta con atributos `data-rstk-conversion-*` en el
`<form>` final o en el boton submit. El contrato oficial es:
`data-rstk-conversion-event="Lead|CompleteRegistration|Schedule|Purchase|Contact|ViewContent|FormSubmitted"`
y `data-rstk-conversion-type="form_submit|appointment_scheduled|purchase|complete_registration|contact|view_content"`.
Ristak valida el evento en backend, manda CAPI server-side con el mismo
`event_id` que usa el Pixel del navegador y guarda el submit normal en
`public_site_submissions`. Para `Schedule` se aceptan datos explicitos de
calendario/cita (`data-rstk-calendar-*`, `data-rstk-appointment-*` o campos con
`data-rstk-conversion-param`). Para `Purchase` se aceptan monto, producto,
order id y payment id; la moneda enviada a Meta sigue saliendo de
`account_currency`, no del HTML externo. Un HTML externo no debe marcar
`Purchase` en clicks o intentos de pago: solo en confirmacion real/pagina de
gracias.
Esta ruta aplica a formularios HTML independientes. El
`<form data-rstk-calendar-book-form>` que vive dentro de un calendario custom es
parte del calendario y queda fuera del submit generico: no crea submission de
formulario ni dispara un evento adicional de formulario. El tipo detectado y el
evento Meta son independientes: `calendar` fija que el disparo ocurre después de
confirmar la cita, mientras Ajustes permite elegir `Schedule`, `Lead`, otro
evento permitido o ninguno para ese calendario.

Los formularios HTML propios distinguen `SUBMITTED` de `QUALIFIED`. Si una
opcion radio, checkbox o select descarta candidatos, esa opcion lleva
`data-rstk-choice-actions` con `action="disqualify"` y el formulario final lleva
`data-rstk-conversion-condition="qualified_only"`. El descarte puede mostrar un
mensaje (`disqualifyOutcome="message"`), ir a una pagina del sitio
(`specific_page`) o redirigir a una URL (`url`). En los tres casos Ristak guarda
contacto y submission como `disqualified`, permite automatizaciones de descarte
y bloquea el evento de conversion tanto en CAPI como en el Pixel del navegador.
Usar solo `specific_page` o `url` navega, pero no descalifica; por eso el editor
y las instrucciones para IA deben exigir `action="disqualify"` cuando el destino
representa un no candidato. Para HTML importado, el editor mantiene el selector
`Evento al terminar`, incluida la opcion `Sin evento (solo PageView)`, pero
reemplaza la eleccion `SUBMITTED`/`QUALIFIED` por el texto fijo
`Enviar cuando · Formulario enviado`. La condicion real sigue siendo code-first:
el HTML puede declarar `data-rstk-conversion-condition="qualified_only"` y Ristak
omite Pixel/CAPI cuando el mismo formulario descalifica al contacto.

Cada submit HTML independiente persistido dispara `form-submitted` despues de
guardar contacto, respuestas y submission. Automatizaciones puede seleccionar
tanto el formulario fuente que aparece en la biblioteca de Formularios como la
identidad estable del formulario dentro del HTML
`<siteId>:imported:<data-rstk-form-id>`; el mismo evento incluye ambas identidades
y las respuestas por ID, llave y etiqueta. El formulario de calendario custom
sigue siendo la excepcion deliberada: al terminar con una reserva confirmada
dispara `Cita agendada`, no un segundo `Formulario enviado`, para que una sola
accion del visitante no inscriba dos veces al contacto.

Para HTML importado con elementos nativos de Ristak, el contrato es declarar una
zona con `data-rstk-native-element="form|calendar|payment|video|social-profile"` y
`data-rstk-native-id` unico. El editor detecta esas zonas y permite conectarlas
a bloques reales del sitio:

El HTML importado es una superficie cerrada y code-first, no un editor visual
alterno. Al crear la pagina, el usuario pega el documento HTML completo o sube
un archivo HTML/ZIP; Ristak crea automaticamente el sitio y sus paginas, abre el
editor y detecta los campos, slots multimedia y elementos nativos declarados en
el codigo. Reemplazar el HTML/ZIP o guardar codigo pegado vuelve a ejecutar la
deteccion. El usuario tambien puede pedirle al asistente que devuelva el HTML
completo modificado. El codigo de cada pagina se puede pegar y editar
directamente; el preview no modifica copy, imagenes, botones, campos o secciones
por si solo y solo permite seleccionar slots funcionales de Ristak.

Al crear un sitio web, la pantalla inicial muestra solo tres caminos en una misma
fila: `En blanco`, `Desde plantilla` y `Crear desde HTML`. La última opción
concentra en un solo flujo `Abrir editor HTML`, `Subir HTML o ZIP`, creación con
la IA de Ristak y el asistente de compatibilidad para ChatGPT, Claude o Codex;
todas terminan en el mismo editor y contrato de reglas HTML.

Con el editor ya abierto, la barra superior mantiene `Subir paginas` junto al
selector de paginas. El control acepta HTML o ZIP y reutiliza el mismo flujo de
importacion: guarda primero cualquier cambio pendiente del sitio abierto, crea
el nuevo proyecto importado con el mismo tipo de sitio y lo abre directamente en
el editor. No mezcla silenciosamente codigo externo con los bloques del proyecto
que estaba abierto. La transicion queda fijada al ID del proyecto importado: el
sincronizador de la URL no puede restaurar el sitio anterior mientras cambia la
ruta y cualquier carga pendiente de ese sitio se descarta. Por eso la lista de
paginas no debe alternar ni parpadear entre el proyecto fuente y el recien
importado.

Dentro del editor HTML, la guía `Reglas HTML y versión móvil` inicia plegada y el
usuario puede abrirla u ocultarla sin perder contenido. Exige una versión móvil
real: `meta viewport`, layout fluido, un `@media (max-width: 640px)` con cambios
concretos, controles táctiles de al menos 44 px, campos de al menos 16 px y cero
scroll horizontal a 390 px. El mismo bloque completo se incluye en las
instrucciones copiables para IA externa, en creación con IA y en cada edición
del asistente de código; editar escritorio nunca autoriza borrar o romper las
media queries. El asistente de código también inicia oculto y se abre o cierra
desde el botón con icono de chat en la cabecera del código; al abrirse conserva
modelo, adjuntos, dictado y aplicación sobre el HTML activo.

El favicon es obligatorio en todo sitio HTML: cada documento debe incluir dentro
de `<head>` un `<link rel="icon" href="...">` válido y todas las páginas del
mismo sitio deben compartirlo. La IA debe crear uno acorde con la marca o el
concepto del sitio, conservarlo al editar y comprobar que no apunte a una ruta
inexistente. Un HTML autocontenido puede usar un SVG en `data:image/svg+xml`; un
ZIP puede incluir SVG, PNG o ICO. Si se pega, genera o importa HTML sin favicon,
Ristak inyecta uno de respaldo para que la pestaña nunca quede sin icono.

El botón de dispositivo no escala una captura de escritorio: en `Móvil`, tanto
la vista normal del HTML como la vista partida código/preview montan el documento
en un iframe con viewport real de hasta 390 px, de modo que sus media queries se
activen igual que en un celular.

La visibilidad exclusiva declarada por el propio HTML usa un contrato estable,
no nombres de clase que Ristak tenga que adivinar. El contenedor completo lleva
`data-rstk-device-only="desktop"` cuando solo existe en computadora o
`data-rstk-device-only="mobile"` cuando solo existe en celular; si aparece en
ambas vistas, no lleva el atributo. Para dos composiciones diferentes se crean
dos contenedores hermanos, uno por dispositivo. El HTML no agrega `hidden`,
JavaScript ni otra regla de `display` para alternarlos: en el editor, el selector
Computadora/Celular oculta de forma explícita la variante contraria; en publicado,
Ristak inyecta la regla responsive de `640px` para que mande el ancho real. El
sanitizador también agrega `meta viewport` cuando un documento HTML completo no
lo incluyó, evitando que un celular evalúe las reglas con un viewport ficticio de
escritorio. Esta misma instrucción se comparte con la IA de Ristak y con los
textos copiables para ChatGPT, Claude y Codex.

El Panel de contenido muestra lo que ya declaro el HTML; no existe una accion
"Agregar al HTML" ni un flujo que obligue a subir multimedia antes de escribir
el codigo. Un `data-rstk-asset-id` o `data-rstk-background-asset-id` con clave no
vacia declara inmediatamente un slot asociable, aunque todavia no tenga archivo
y aparezca como pendiente. Desde esa fila el usuario elige o sube el recurso de
Media que corresponde. Al asociarlo, `public_site_content_assets` guarda
`asset_key` como alias estable y `media_asset_id` como archivo fisico actual.
Reemplazar el archivo actualiza el binding sin tocar la clave ni regenerar el
HTML. El renderer resuelve la clave server-side y la ruta publica estable es
`/api/sites/public/content-assets/:siteId/:assetKey`.
La tabla y sus indices tambien viven en la migracion versionada `125`, por lo que
una instalacion existente los recibe aunque el replay del esquema base ya se
haya marcado como completado. El preview HTML no depende de tener un dominio
publico conectado; usa una sesion temporal autenticada y mantiene el tracking
apagado.

Si una zona multimedia, un campo o un slot nativo existe solo en el borrador
activo, la accion de asociarlo guarda primero el codigo de forma silenciosa y
continua solo si ese guardado termino bien. El selector no cierra ni anuncia una
asociacion hasta que backend la confirma. Los guardados automaticos se agrupan
por clave y pasan por una sola cola por sitio para que cambios rapidos o dos
zonas simultaneas no creen duplicados ni apliquen respuestas fuera de orden. El
panel se aisla por `site.id`, por lo que un timer o respuesta de un sitio anterior
no puede escribir ni repintar el sitio que se abrio despues. Si coincide con el
guardado global del sitio, ambas rutas comparten la misma compuerta: Guardar o
Publicar espera la cola nativa que ya este en vuelo, y un slot que llegue despues
se aplaza hasta que termine el guardado global. Solo ese slot aplazado se
reintenta. Antes de confirmar Guardar o Publicar tambien se vacian de inmediato
los autosaves que sigan dentro del debounce de 450 ms y cualquier draft nativo
pendiente. Dos intenciones globales concurrentes se encolan; una publicacion no
se descarta porque haya empezado antes un guardado silencioso. Las respuestas de
preview se validan contra sitio, pagina y request vigente para no pintar una
pagina anterior despues de cambiar de paso.

El selector de Media carga hasta 250 archivos por pagina y ofrece `Cargar mas`
sin bloquear la primera vista. Si la busqueda local aun no encuentra una
coincidencia, conserva la opcion `Buscar en mas archivos`; eliminar un archivo
recarga la primera pagina para no saltarse elementos por el cambio de offsets.

El contrato canonico para contenido asociable es:

- Imagen: `<img data-rstk-asset-id="imagen-01" data-rstk-label="Imagen principal" alt="">`.
- Fondo: `<section data-rstk-background-asset-id="fondo-01" data-rstk-label="Fondo principal">`.
- Audio: `<audio data-rstk-asset-id="audio-01" data-rstk-label="Audio principal" controls></audio>`.
- PDF, ZIP o cualquier multimedia descargable: `<a data-rstk-asset-id="descarga-01" data-rstk-label="Archivo descargable" download>Descargar</a>`. El selector permite cualquier tipo de Media para este caso.

Los descargables nunca apuntan directamente al CDN: el renderer coloca una URL
same-origin con `?download=1`, fuerza `Content-Disposition: attachment` y
transmite el archivo en streaming. En Bunny propaga rangos HTTP para que una
descarga grande se pueda reanudar sin cargar el archivo completo en memoria. La
ruta responde `no-store` porque una misma clave puede apuntar a otro archivo
después de una reasociación. Un video antiguo que solo vive en Bunny Stream debe
crear su espejo binario de Storage durante la asociación autenticada; la visita
pública nunca dispara esa preparación ni intenta descargar el HTML del player.

Un `data-rstk-asset-id` solo declara una zona cuando Ristak puede escribirla de
verdad: `href` en `<a>`; `src` en `<img>`, `<audio>`, `<video>`, `<source>`,
`<track>`, `<iframe>` o `<input type="image">`; y `poster` en `<video>` cuando
se declara `data-rstk-asset-target="poster"`. Para fondos se usa exclusivamente
`data-rstk-background-asset-id`. Poner la clave en un `<div>`, `<picture>` u
otro tag sin destino compatible no crea una zona fantasma en el panel.
El `iframe` sin `src` que generaba el editor anterior se conserva únicamente
cuando tiene una clave estable válida; el sanitizador elimina cualquier otro
`iframe` vacío o inseguro y el binding legacy completa su `src` al renderizar.

Las claves de `public_site_content_assets` son globales al sitio, no a una sola
pagina. Repetir `imagen-01` en una o varias paginas reutiliza intencionalmente el
mismo archivo. Si dos zonas deben poder asociarse por separado, el HTML debe
usar claves distintas, idealmente con contexto de pagina, por ejemplo
`landing-imagen-01` y `gracias-imagen-01`.
Si una clave ya asociada cambia de tipo en el HTML, por ejemplo de imagen a
audio, el editor la marca para reasociar y el renderer no inyecta el archivo
incompatible anterior.

Los slots nativos que Ristak renderiza (`form`, `calendar` con
`data-rstk-native-render="ristak"`, `payment`, `video` y `social-profile` con
render nativo) deben ser huecos
limpios: contenedores vacios, sin texto placeholder, mocks, tarjetas, bordes
punteados/dashed, outlines, fondos, sombras, iconos, labels, pseudo-elementos ni
wrappers decorativos dentro, detras o encima. El HTML externo solo decide la
ubicacion del bloque; Ristak pinta el formulario, calendario, checkout, video o
perfil social completo con su propio diseno y configuracion. El slot no debe
reservar altura: si la composición necesita controlar ubicación o ancho, lo hace
un padre neutro sin borde/fondo visible. Al montarlo, el renderer neutraliza en
el wrapper `height`, `min-height`, `max-height`, tamaños lógicos, `aspect-ratio`
y crecimiento flex heredados del CSS de página completa; así una regla original
para `body` no convierte cada elemento nativo en una pantalla vacía. Las
excepciones son `calendar` y
`social-profile` con `data-rstk-native-render="custom"`, porque ahi el frontend
importado si es el elemento visual y Ristak solo conecta los datos y operaciones
reales.

El slot nativo de `video` tampoco es dueño de su geometria. No debe declarar
`width`/`max-width`, `height`/`min-height`/`max-height`, `aspect-ratio`, padding
porcentual, `overflow` recortado ni una clase que fuerce orientación vertical u
horizontal. Si el diseño necesita columna, ancho de sección o posicionamiento,
eso vive en un contenedor padre externo. Al montar el bloque, Ristak neutraliza
esas restricciones legacy del slot, detecta la orientación real por metadata o
por las dimensiones cargadas del archivo y aplica la proporción, ancho responsive
y controles configurados en el editor.

El panel define tres comportamientos para el ancho de un video vertical. En
`Automático`, el reproductor queda centrado y contenido en computadora y ocupa
todo el ancho disponible en móvil, siempre conservando 9:16. `Completo` ocupa
todo el ancho en todas las vistas. `Manual` respeta el porcentaje configurado
por separado en computadora, tablet y móvil. El HTML importado no debe fabricar
franjas laterales, un marco negro ni otra relación de aspecto: el slot permanece
neutro y el reproductor nativo resuelve su geometría.

Cuando una página necesita un archivo de video distinto para computadora y
móvil, declara dos slots con la misma base semántica y sufijos de vista, por
ejemplo `video-presentacion-escritorio` y `video-presentacion-movil`, y deja que
sus contenedores padres usen respectivamente
`data-rstk-device-only="desktop"` y `data-rstk-device-only="mobile"`. Al cambiar la vista del
editor, el inspector sigue automáticamente el slot visible para que una subida
móvil no reemplace por accidente el bloque de computadora. Mientras una de las
dos variantes todavía no tenga bloque propio, el renderer usa como respaldo el
único video configurado de la variante hermana; al conectar un archivo en el
slot pendiente se crea su bloque independiente y esa coincidencia exacta siempre
tiene prioridad. El respaldo solo aplica a videos emparejados por base y vista,
nunca a dos videos distintos de la misma página.

El bloqueo de contenido por video en HTML importado es una capacidad nativa del
renderer, no una composición de acciones `show`/`hide`. Cada slot fuente declara
`data-rstk-video-gate-id`, `data-rstk-video-gate-trigger` y
`data-rstk-video-gate-value`. El diseño bloqueado usa
`data-rstk-video-gate-locked`, el contador vivo
`data-rstk-video-gate-remaining` y el contenido real completo
`data-rstk-video-gate-content`, todos con el mismo ID. El comportamiento legacy
oculta el contenido real con `hidden`, `inert` y `aria-hidden` desde el primer
render. Para una experiencia integrada, `data-rstk-video-gate-shell` envuelve
como hijos directos el contenido y la capa, mientras el contenido declara
`data-rstk-video-gate-locked-mode="blur"`: el calendario real permanece visible
con blur, pero `inert`, sin eventos de puntero y fuera del árbol accesible; la
capa se posiciona encima del mismo contenedor. Al cumplir el umbral se eliminan
blur y bloqueo y se oculta la capa. No se deben renderizar un calendario falso
bloqueado y otro real debajo. El HTML puede ajustar la intensidad con
`--rstk-video-gate-blur` y la opacidad con
`--rstk-video-gate-locked-opacity`. Si el contenido es un calendario compuesto,
el estado bloqueado deja visibles `date` y `time`, elige temporalmente el primer
día con disponibilidad del mes y pinta sus horarios reales; las preguntas,
contacto y confirmación permanecen ocultos. Al desbloquear se borra esa
preselección y el flujo regresa a `date`. En
`playback_seconds` suma únicamente reproducción activa: seek, buffering y el
preview automático no cuentan. `unique_watched_percent` usa fragmentos vistos
sin inflar el avance por repetir, y `timeline_reached` sí permite adelantar.
Variantes móvil/escritorio con el mismo gate comparten el mayor progreso
individual; nunca se suman entre sí. El contador sale del mismo estado real y no
de decenas de spans o reglas por segundo.

- `form`: usa la misma configuracion del bloque `form_embed` del editor visual:
  exclusivamente un formulario ya existente, reglas "Al enviar", estilo del
  bloque y snapshot del formulario fuente. La zona debe ser un contenedor vacio;
  no debe incluir `<form>`, campos ni botones de envio dentro o pegados a esa
  zona, porque Ristak renderiza el formulario completo dentro de un frame aislado
  con su propio boton y sus acciones "Al enviar". Ese frame no dispara tracking
  propio, reporta su altura al documento padre y envia al padre cualquier
  navegacion final, para evitar PageView duplicado, cortes en formularios
  multipagina o redirects atrapados dentro del iframe.
- `calendar` con `data-rstk-native-render="ristak"`: renderiza el calendario
  embebido normal y respeta disponibilidad, campos, pagos, reglas de completado
  y evento Meta "al agendar".
- `calendar` con `data-rstk-native-render="custom"`: conserva el frontend del
  HTML importado y usa un flujo declarativo tipo Calendly. El paso `date` incluye
  navegación mensual, etiqueta del mes y `data-rstk-calendar-days`; Ristak llena
  la cuadrícula con todos los días y estados `available`, `unavailable` y
  `outside`. El paso `time` recibe botones reales en
  `data-rstk-calendar-slots`; después siguen `form` y `success`. El HTML y el CSS
  son dueños del diseño, pero no incluyen fetch, fechas, horarios ni JavaScript
  de agenda. El runtime expone además
  `window.ristakCalendarGetSlots(slotId, params)` y
  `window.ristakCalendarBook(slotId, payload)` para compatibilidad y usos
  avanzados. `payload.startTime` debe ser ISO UTC y `payload.timezone` la zona
  usada para mostrar la cita; el backend calcula con la zona del negocio y
  vuelve a validar disponibilidad al crearla. Los instantes recibidos para el
  mes se agrupan en la zona mostrada sin confiar en el día agrupador del backend.
  El `<form data-rstk-calendar-book-form>` pertenece semánticamente a este bloque:
  no requiere `data-rstk-form-id` ni `data-rstk-field-id`, no aparece como
  formulario independiente en Contenido o Meta y no ejecuta el runtime genérico
  de leads. Solo una reserva confirmada en backend dispara el evento configurado
  del calendario, cuyo default recomendado es `Schedule` pero puede cambiarse en
  Ajustes sin cambiar el tipo de elemento.
  La clasificación tampoco depende del orden visual. Cuando un único submit
  crea la cita, preguntas, contacto, fecha y horario siguen siendo un solo
  `calendar` aunque aparezcan antes, después o intercalados. El flujo flexible
  usa un solo `data-rstk-calendar-book-form` y secciones ordenadas
  `data-rstk-calendar-flow-step` tipadas como `questions`, `date`, `time`,
  `confirm` y `success`; `data-rstk-calendar-response` conserva preguntas
  adicionales en el resumen de la cita. Un submit independiente sí produce un
  segundo elemento `form`.
  Cuando la petición especifica que el formulario pertenece al calendario y
  debe aparecer después de elegir fecha y hora, las instrucciones para IA fijan
  el orden `date -> time -> questions -> confirm -> success`: ningún campo de
  situación, inversión o contacto aparece antes del horario, y los datos de
  contacto quedan en el último paso `questions`. Si un video controla el acceso,
  el estado inicial recomendado conserva a la vista el único calendario real
  bajo un blur y una capa superpuesta con el progreso, mediante
  `data-rstk-video-gate-shell`, `data-rstk-video-gate-content`,
  `data-rstk-video-gate-locked-mode="blur"` y
  `data-rstk-video-gate-locked`. El calendario permanece visible pero
  inaccesible hasta el desbloqueo; no existe una segunda agenda debajo. Al
  desbloquearse queda activo en `date`, mientras las preguntas permanecen
  ocultas hasta seleccionar `time`.
  El contrato legacy de `input date` más `select` permanece montable para HTML
  publicado anteriormente, pero ya no es la estructura indicada a las IA.
- `payment`: renderiza el checkout real de Ristak y usa la misma configuracion
  de pagos del editor. El `Purchase` sale solo del pago confirmado.
- `video`: renderiza el bloque de video real de Ristak con la misma subida/URL,
  controles, diseno, acciones por tiempo, formulario de video y eventos
  Meta/CAPI que el editor normal. El formulario de video usa el mismo panel,
  campos, reglas de completado, diseno y submit publico del bloque nativo; el
  HTML externo solo reserva la zona donde se monta el reproductor.
  Un video nuevo se prepara en backend y se sube directo a Bunny Stream con TUS
  resumible y firma temporal; la API key nunca llega al navegador. Al finalizar,
  backend descarga el original autenticado desde Stream y lo transmite a Bunny
  Storage sin cargarlo completo en memoria. El asset queda listo solamente
  cuando existen Storage para reproducción nativa y la identidad/metadata de
  Stream para procesamiento y analítica.
  Editor, canvas, preview-session y publicado/en vivo usan la URL de Storage con
  el reproductor personalizable de Ristak. Publicar nunca sustituye un video
  nativo listo por el iframe visual de Stream: conserva exactamente el botón,
  colores, barra, controles, acciones y formulario configurados. Editor y
  preview mantienen tracking apagado; publicado envía los eventos first-party
  de video y conserva los ids del asset y de Stream.
  El HTML importado inyecta el mismo stylesheet y el mismo runtime de reproductor
  que el sitio construido en el editor: preview silencioso en loop, detección de
  orientación, HLS, play/pausa, volumen, velocidad, progreso, barra responsive,
  aviso de sonido y formulario sobre video. El runtime de acciones por tiempo es
  adicional y no sustituye al runtime del reproductor. La vista `srcDoc` embebida
  dentro del editor es deliberadamente conservadora: monta el player con
  `preload="none"`, no inicia el loop automático y no conecta HLS hasta una
  reproducción real. Así puede mostrar a la vez variantes desktop/mobile sin
  descargar ni decodificar videos ocultos; preview-session y publicado conservan
  la reproducción configurada. El runtime del candado actualiza el tiempo restante
  sólo cuando el texto realmente cambia y su observador ignora mutaciones de texto;
  esto evita ciclos de render infinitos entre el contador y `MutationObserver`.
  Un asset legacy que solo vive en Stream muestra brevemente `Preparando vista
  previa del video`; abrir el editor o crear una preview-session autenticada
  dispara automáticamente la creación de su espejo de Storage. El proceso está
  deduplicado por asset, conserva el mismo video de Stream y jamás usa la página
  iframe como `<video src>` ni carga Stream como fallback no-track.
  El mismo contrato aplica al HTML importado. En el canvas, el primer click
  selecciona el bloque y, una vez seleccionado, el reproductor recibe interacción
  para reproducir, pausar y operar sus controles sin volver interactivos los
  demás embeds del editor.
  Al cerrar la sesión, backend valida la URL TUS, el tamaño reservado, el total
  recibido por Bunny y que el original copiado a Storage tenga exactamente el
  mismo tamaño antes de marcar el asset listo; estados de error de Stream nunca
  se convierten en éxito y liberan inmediatamente asset/video/cuota.
  Cancelar elimina la reserva y el video
  pendiente, y las sesiones abandonadas de más de siete días se limpian al
  siguiente intento de subida. Los videos
  legacy respaldados por Storage conservan su preview compatible y cambian a
  reproducción nativa de Ristak en publicado. Player.js queda como compatibilidad
  para un asset Stream-only que todavía no tiene espejo y para embeds Bunny
  externos sin archivo Storage asociado; las acciones del reproductor nativo se
  conectan directamente al elemento de video.
- `social-profile` con `data-rstk-native-render="ristak"`: renderiza el bloque
  completo del editor normal. Ese modo nativo es el default cuando el usuario no
  pide otra composición: conserva exactamente la fila compacta y transparente,
  el avatar circular, la insignia de la red superpuesta abajo a la derecha, el
  nombre con la roseta azul de verificado y los seguidores debajo. Las reglas
  para IA no deben intentar copiar ese diseño con HTML propio; deben usar el slot
  nativo vacío para garantizar la misma iconografía, proporción y posición.
  Su wrapper conserva altura intrínseca y usa la clase canónica
  `rstk-imported-native-social-profile`; el renderer elimina geometría inline
  heredada del código importado y aplica el reset de slots montados antes de
  comenzar el título, video, formulario o sección siguiente. Esto evita que un
  `body { min-height: 100vh }`, un `height: 100vh`, `flex: 1` o una reserva de
  viewport empujen el resto del embudo debajo de un bloque vacío.
  `data-rstk-native-render="custom"` se usa únicamente cuando el usuario pide de
  forma explícita otro diseño. En ese caso conserva
  el markup, clases, layout y CSS creados por ChatGPT, Claude o Codex y sustituye
  server-side solamente los hooks `data-rstk-social-avatar` (en un `<img>`),
  `data-rstk-social-name`, `data-rstk-social-followers` y
  `data-rstk-social-verified`; `data-rstk-social-platform` y
  `data-rstk-social-subtitle` son opcionales. Foto, nombre, red, texto y
  seguidores salen del perfil conectado elegido en el inspector. El hook
  completo de verificado se oculta cuando `brandVerified=false`, sin cambiar el
  CSS del autor. El sitio publico no llama Meta ni recibe credenciales; consume
  el snapshot guardado que el job diario existente actualiza desde backend.

  La raíz de un perfil social custom representa únicamente la ficha conectada y
  siempre conserva altura intrínseca. No puede reservar una pantalla completa
  con `height`, `min-height`, `max-height`, propiedades lógicas equivalentes,
  `aspect-ratio`, unidades `vh`/`svh`/`dvh`, crecimiento flex o margen inferior
  artificial. La portada, el fondo grande y el ritmo entre secciones pertenecen
  a un padre o hermano; hero, video, formulario y contenido posterior quedan
  fuera de la raíz del perfil. Además de exigirlo a la IA interna y en las reglas
  copiables para ChatGPT, Claude o Codex, el renderer neutraliza geometría legacy
  en esa raíz al montarla para que un HTML anterior no genere un vacío gigante.

El reproductor nativo de video de un HTML importado acepta el contrato
declarativo `data-rstk-video-settings` en el mismo slot que se conecta a Ristak.
Ese objeto JSON usa las mismas propiedades y el mismo renderer del bloque de
video normal; no crea un segundo reproductor ni permite que el HTML dibuje
controles falsos. Sus grupos de control son:

- Visibilidad: `videoControlsMode` (`clean`, `native` o `none`),
  `videoOverlayPlay`, `videoControlBar`,
  `videoControlBarInitiallyVisible`, `videoControlPlay`,
  `videoControlProgress`, `videoControlTime`, `videoControlVolume`,
  `videoControlSpeed` y `videoControlSettings`.
- Diseño: fondo, borde y radio del frame; color y radio del panel; color, forma,
  radio, tamaño, estilo e icono del play; y color del aviso de sonido mediante
  `videoPlayerBackground`, `videoPlayerRadius`, `videoPlayerBorderColor`,
  `videoPlayerBorderWidth`, `videoPlayerColor`, `videoControlPanelRadius`,
  `videoPlayColor`, `videoPlayShape`, `videoPlayRadius`, `videoPlaySize`,
  `videoPlayIconStyle`, `videoPlayIconSize` y `videoSoundColor`.
- Reproducción: autoplay silenciado, loop, velocidad inicial, preview, aviso de
  sonido y progreso visual mediante `videoMuted`, `videoAutoplay`, `videoLoop`,
  `videoDefaultSpeed`, `videoPreviewEnabled`, `videoPreviewStart`,
  `videoPreviewEnd`, `videoDisableEditorPlayback`, `videoSoundHint`,
  `videoSoundNoticeText`, `videoSoundNoticeHideAfter`,
  `videoTrickProgressEnabled`, `videoTrickProgressRampPercent` y
  `videoTrickProgressPeakPercent`. Autoplay fuerza `videoMuted=true` porque los
  navegadores bloquean la reproducción automática con audio.
- Formato responsive: `videoOrientation`, `videoPortraitWidthMode`, `videoFit`,
  `mediaWidth`, `mediaAlign` y overrides `responsive.tablet/mobile` de ancho y
  alineación. La geometría del slot HTML sigue perteneciendo al reproductor y
  nunca se fija con CSS en el propio slot.

Ejemplo:

```html
<div
  data-rstk-native-element="video"
  data-rstk-native-id="video-principal"
  data-rstk-label="Video principal"
  data-rstk-video-settings='{"videoControlsMode":"clean","videoOverlayPlay":true,"videoControlBar":true,"videoControlPlay":true,"videoControlProgress":true,"videoControlVolume":true,"videoControlSpeed":true,"videoControlSettings":true,"videoPlayerColor":"rgba(0,0,0,.62)","videoPlayShape":"round","videoPlaySize":96,"videoPlayColor":"#fff","videoMuted":true,"videoAutoplay":false,"videoOrientation":"auto","responsive":{"mobile":{"mediaWidth":100,"mediaAlign":"center"}}}'
></div>
```

La declaración se reconcilia por `data-rstk-native-id`, tipo y página. Al crear
el bloque completa propiedades faltantes. En ediciones posteriores compara la
declaración anterior, el HTML nuevo y el ajuste actual del panel: solo una clave
que cambió expresamente en el HTML vuelve a aplicarse; una personalización manual
del panel se conserva cuando la declaración no cambió. Quitar el atributo u
omitir una clave es no destructivo. Para retirar una propiedad declarada se usa
un tombstone `null`, por ejemplo `{"videoControlVolume":null}`. Propiedades
desconocidas, enums fuera de contrato, rangos inválidos o JSON roto detienen el
preflight de Guardar, Preview y Publicar. Los aliases `data-ristak-video-settings`
y `data-ristack-video-settings` se leen por compatibilidad, pero toda instrucción
nueva emite `data-rstk-video-settings`.

Las acciones de video en HTML importado solo apuntan a elementos identificables
y publicables. Cada CTA, boton, link, formulario, seccion, bloque de texto,
titulo, imagen, figura o slot nativo controlable debe declarar desde la creacion
de la pagina un `data-rstk-video-action-target` semantico, estable y unico, junto
con un `data-rstk-label` legible para el panel. Esta identidad se conserva aunque
cambien copy, clases, estilos, posicion o diseño responsive. Se marca el elemento
completo que debe reaccionar, no sus spans, iconos o wrappers internos; los
controles interiores de un slot nativo pertenecen a Ristak y no se exponen como
targets independientes.

El contrato se exige tanto a la IA interna como a las instrucciones copiables
para ChatGPT, Claude o Codex. Como defensa para HTML legacy o incompleto, Ristak
normaliza cada pagina al cargarla, guardarla y renderizarla: reutiliza primero
`id`, `data-rstk-section`, `data-rstk-form-id`, `data-rstk-native-id`, claves de
contenido o el ID declarativo de la accion del boton; si ninguno existe, genera
una identidad determinista para el elemento semantico. Esos hooks llegan también
al catálogo de "Elementos a controlar" del inspector, por lo que una página
anterior no depende de volver a escribir manualmente todos sus botones. Cuando
una accion arranca con estado "Mantener oculto", el render importado marca el
target con `data-rstk-video-action-hidden="true"` desde el HTML inicial para
evitar parpadeos entre preview y sitio publicado. Al mostrar un target también
retira un atributo `hidden` legacy si el autor lo había dejado en el elemento.

El panel de acciones ofrece las mismas tres condiciones para un video nativo del
editor visual y para un slot `data-rstk-native-element="video"` de HTML
importado:

- `timeline_reached` (**Llegó al minuto X**) compara la posición actual del
  reproductor. Adelantar el video hasta ese punto sí cuenta como cumplimiento.
- `playback_seconds` (**Reprodujo X tiempo**) acumula solamente tiempo real de
  reloj mientras la reproducción está activa. Pausas, buffering y saltos por
  seek no suman; volver a reproducir un fragmento sí acumula tiempo adicional.
- `unique_watched_percent` (**Vio X% del video**) calcula la union de los
  fragmentos que realmente se reprodujeron contra la duración total. Saltar a
  otra posición no rellena el tramo omitido y repetir una zona ya vista no infla
  el porcentaje.

El contrato declarativo para pedir estas acciones desde código es
`data-rstk-video-rules` sobre el slot de video nativo. Cada regla necesita un
`id` estable, `triggerType`, `triggerValue`, la `action` y sus
`targetBlockIds` cuando la acción opera sobre elementos. Cada valor debe coincidir
con la identidad estable de `data-rstk-video-action-target`; por ejemplo:

Las acciones disponibles son `show`, `hide`, `open_form`, `open_video_form`,
`show_popup`, `site_page`, `redirect`, `change_text`, `change_link`,
`scroll_to`, `activate_checkout`, `meta_event` y `reveal_form_action`. Según la
acción se declaran `targetBlockIds`, `targetPageId`, `redirectUrl`, `value`,
`before`, `pauseUntilComplete`, `metaCapiEnabled`, `metaEventName`,
`metaEventParameters` y `repeatMode`.

`triggerValue` se expresa en segundos para `timeline_reached` y
`playback_seconds` (`3 minutos = 180`), y como porcentaje de `1` a `100` para
`unique_watched_percent`.

```html
<div
  data-rstk-native-element="video"
  data-rstk-native-id="video-principal"
  data-rstk-label="Video principal"
  data-rstk-video-rules='[{"id":"mostrar-oferta","triggerType":"unique_watched_percent","triggerValue":50,"action":"show","targetBlockIds":["oferta-final"],"before":"hidden"}]'
></div>
<section
  id="oferta-final"
  data-rstk-video-action-target="oferta-final"
  data-rstk-label="Oferta final"
>...</section>
```

La IA y el HTML solo declaran reglas; nunca deben inyectar JavaScript arbitrario
para escuchar el reproductor o manipular la página. Reescribir el código no debe
borrar configuración por accidente: quitar el atributo completo u omitir una
regla conserva las acciones ya asociadas. Para eliminar intencionalmente una
regla declarada se usa su mismo ID con el tombstone
`{"id":"mostrar-oferta","deleted":true}`. Ristak conserva la última declaración
por ID y hace una reconciliación de tres vías entre esa declaración anterior, el
HTML nuevo y la configuración actual del panel. Si el usuario personalizó una
regla en el panel y la declaración no cambió esa propiedad, la personalización se
mantiene; si el código cambia expresamente una propiedad declarada, solo esa
parte se actualiza.

Estas acciones sirven para controlar la experiencia visible de la página, por
ejemplo revelar una oferta, formulario, botón o sección conforme avanza el video.
No son una barrera de seguridad, autorización, paywall ni control de acceso: el
contenido realmente privado debe protegerse en backend.

En el editor HTML importado, el Panel de contenido ocupa el inspector derecho y
administra en una sola vista todo lo que el codigo de la pagina activa ya
contiene. El listado se calcula por pagina, no con totales de todo el sitio, y
muestra por separado cada imagen, fondo, audio, descargable, formulario HTML,
calendario, pago, video y perfil social detectado. No existe un limite de un
elemento por tipo:
dos formularios, varias imagenes, varios videos o varios descargables aparecen
como filas independientes y se asocian desde ahi. Los campos se agrupan debajo
del formulario HTML real al que pertenecen, de modo que dos formularios con un
campo `email` no comparten accidentalmente la misma ruta de datos. No aparecen
popovers sobre textos, imagenes, botones, campos o secciones, ni controles para
insertar elementos nuevos en el HTML.

La vista general del panel resuelve las asociaciones simples directamente en
cada fila. Los elementos con configuracion avanzada, como video, calendario,
pago o perfil social, muestran un engrane. En el perfil social el usuario elige
la red y el perfil conectado, puede ajustar los valores visibles y decide si se
muestra verificado; en modo custom no aparece el control de escala porque el
tamaño pertenece al CSS importado. Al abrirlo, el mismo inspector derecho cambia a la
configuracion de ese elemento; arriba aparece una flecha con `Volver`, que
regresa al mapeo general de la pagina y conserva el elemento desde el que se
entro. El encabezado de detalle es el único separador antes del inspector; los
controles no agregan una segunda línea contigua. No se abre otra ventana ni se
mezcla la configuracion avanzada con todas las filas del resumen. Para un video
premium y personalizable, el HTML debe reservar
`<div data-rstk-native-element="video" data-rstk-native-id="video-01" data-rstk-label="Video principal"></div>`;
usar un `<video>` HTML propio lo deja bajo control del codigo y no sustituye el
player nativo. El slot nativo conserva la misma fuente/subida, diseno del frame,
boton de play, colores, controles, acciones por tiempo, formulario de video y
eventos Meta/CAPI del editor visual. Pago tambien permanece siempre nativo porque
la IA no puede sustituir el checkout seguro. Cuando no hay borradores de HTML sin
guardar, la previsualizacion usa el render del backend de la pagina activa para
mostrar los elementos nativos ya montados tal como se veran en vivo; las
respuestas de preview viejas no deben repintar otra pagina si el usuario cambio
de pagina mientras cargaba. Los slots nativos y las acciones de video se resuelven por
`data-rstk-native-id` + tipo + pagina, de modo que dos paginas importadas no
compartan accidentalmente un formulario, calendario, pago, video, perfil social o target con el
mismo identificador. IDs duplicados dentro de una misma pagina nunca montan dos
veces el mismo bloque: el preview muestra un diagnostico y publicado omite el
duplicado. Antes de persistir siquiera el HTML, Guardar, Publicar, Preview y las
asociaciones directas ejecutan el mismo preflight sobre todos los borradores
efectivos del sitio: detienen la operacion si existe un `data-rstk-form-id`
repetido globalmente, un `data-rstk-field-id` repetido dentro de su formulario,
  un `data-rstk-native-id` repetido dentro de la pagina, ajustes declarativos del
  reproductor invalidos, reglas de video invalidas
o un perfil social custom sin sus cuatro hooks obligatorios. Asi la UI no puede avisar
del error despues de haber dejado codigo ambiguo en un sitio publicado. El
inspector derecho guarda automaticamente cambios validos
de video, calendario, pago y perfil social con bajo ruido, y el boton de guardado manual sigue
mostrando validaciones cuando falta una configuracion obligatoria. Para pagos,
ese preview usa un snapshot temporal de la
configuracion del inspector derecho y dibuja una maqueta de checkout con pasarela,
monto, campos, boton, modo test y ayuda del proveedor; no monta SDKs reales ni
intenta iniciar cobros hasta que el sitio publicado confirme el pago. En el sitio
publicado, los pagos importados usan el checkout publico real de Ristak y nunca
la maqueta deshabilitada del editor. Los calendarios nativos dentro del preview
usan la ruta interna `/api/sites/public/calendar-preview/:slug`, no
`/calendar/:slug`, para que el editor pueda mostrarlos sin depender de que el
dominio publico ya este configurado; el sitio publicado conserva la ruta publica
normal y no debe llevar `editor_preview=1` ni `preview=1`. Los calendarios
custom publicados conservan su UI importada, pero las funciones
`window.ristakCalendarGetSlots` y `window.ristakCalendarBook` son internas del
runtime seguro. El HTML generado por IA no escribe JavaScript: declara
`data-rstk-calendar-date`, `data-rstk-calendar-time`,
`data-rstk-calendar-load-slots`, `data-rstk-calendar-book-form` y los hooks de
contacto/mensaje; Ristak los conecta a los endpoints publicos vivos de
disponibilidad y agendado.
En preview, `window.ristakCalendarGetSlots` consulta disponibilidad real aun
dentro de un `srcDoc` cuyo origen es `null`; `window.ristakCalendarBook` responde
con una confirmación de demostración y no hace POST, no crea citas, no redirige
ni dispara Pixel/CAPI. El agendado y el evento elegido para ese calendario solo
ocurren en la página publicada después de confirmar la cita real.

Cuando el asistente de codigo prepara un HTML completo y todavia no se ha guardado,
la vista de pagina debe mandar ese archivo como borrador al endpoint de preview
para que pase por el mismo renderer aislado de Ristak: sanitizacion, rutas
internas, slots nativos, pago mock de editor, calendario preview y runtime de
video. Ese borrador solo vive en memoria de la solicitud de preview; no actualiza
`public_site_imports` ni `public_site_import_assets` hasta que el usuario guarde
el sitio.

Los aliases `data-ristak-*` y `data-ristack-*` se conservan para compatibilidad,
pero las reglas copiables nuevas deben preferir `data-rstk-*`.

En HTML importado multipagina, los nombres de pagina y archivo deben poder
expresar el orden real del flujo. La convencion nueva para reglas copiables y
HTML generado es usar sufijo numerico de dos digitos en `title` y `filename`,
por ejemplo `Landing-01.html`, `Form-02.html`, `Booked-03.html`. Ristak usa ese
numero para ordenar paginas importadas o generadas; no debe depender del orden
alfabetico del ZIP ni de nombres como `Pagina 1`.

En el flujo de crear un sitio, el asistente externo vive dentro de la única
opción `Crear desde HTML`, bajo la acción `Preparar para ChatGPT, Claude o
Codex`. Esta acción no llama a ninguna API de IA ni crea paginas por el usuario:
solo abre un asistente de compatibilidad que pregunta si ChatGPT, Claude o Codex
diseñaran los formularios, el calendario, el video o el perfil social con
compatibilidad Ristak, si se insertaran
los elementos completos de Ristak o si la pagina no los incluira. Los dropdowns
usan el `CustomSelect` global y el valor cerrado conserva la misma tipografia de
las opciones abiertas. Al terminar muestra instrucciones listas para copiar y
pegar en ChatGPT, Claude o Codex junto con la peticion real del usuario. Desde ese
modal, `Subir mi HTML` abre el flujo de importacion
ZIP/HTML y `Ir al editor` crea una hoja HTML en blanco para pegar codigo pagina
por pagina. Si el usuario elige formulario HTML personalizado, ese bloque
copiable incluye el contrato de calificacion por opcion, los tres destinos de
descarte y `data-rstk-conversion-condition="qualified_only"`; tambien prohibe
disparar Pixel/CAPI manualmente antes del veredicto de Ristak.
Cuando elige perfil social custom, las instrucciones exigen los cuatro hooks
obligatorios, prohiben seguidores o identidades inventadas y dejan claro que
Ristak conserva el diseño pero inyecta los datos del perfil conectado. Si la
petición no describe una composición diferente, las mismas instrucciones mandan
volver al slot nativo para reproducir exactamente el perfil del editor; el modo
custom sólo queda autorizado por una petición visual explícita. También
exigen tanto al slot nativo como a la raíz custom cerrar justo después de la
ficha, mantener altura intrínseca y no reservar viewport, y
validar a 390 px que el siguiente contenido aparezca con espaciado normal, sin
un bloque vacío ni una sección de alto completo.

El mapeo de campos HTML vive exclusivamente en el Panel de contenido; se elimina
el modal separado de revision o "Ruta de datos". Cada formulario personalizado
debe ser un elemento real `<form>` con una identidad estable, por ejemplo
`<form data-rstk-form-id="landing-contacto" data-rstk-label="Formulario de contacto">`.
`data-rstk-form-id` debe ser no vacio, estable y unico en todo el sitio, incluso
entre paginas; `data-rstk-label` aporta el nombre humano que muestra el panel.
No se debe usar un `div` vecino como sustituto del conjunto, dejar campos fuera
de un `<form>` ni repartir los campos de un mismo formulario entre wrappers
distintos. El panel avisa y bloquea asociaciones ambiguas cuando detecta IDs
duplicados. Si una reescritura introduce temporalmente dos formularios con el
mismo ID, ninguno hereda a ciegas la configuracion del otro: la asociacion
canonica anterior queda dormida y se restaura cuando el ID vuelve a ser unico.
Mientras exista la ambiguedad tampoco se crea ni sobrescribe el formulario
fuente de Ristak, y guardar/publicar debe detenerse hasta corregirla.

Cada campo logico guardable dentro de ese `<form>` debe declarar un
`data-rstk-field-id` estable y unico dentro del formulario, ademas de conservar
su `name` o `id` normal para el submit. Las opciones radio o checkbox que forman
un solo campo se agrupan en un `fieldset` con `legend` (o una etiqueta accesible
equivalente) y comparten esa identidad logica; otro campo distinto no puede
reutilizarla en el mismo formulario. Desde la fila de cada campo el usuario
elige un dato estandar del contacto, un campo personalizado existente, crear un
campo personalizado nuevo (`destinationType/saveMode = new_custom`) o no
guardarlo. Por eso no hace falta crear previamente todo el catalogo ni salir del
panel. En cada fila, el estado (`Asociado`, `Pendiente`, `Guardando` o una alerta)
se muestra como una etiqueta compacta a la derecha del titulo; el selector de
destino conserva una fila completa debajo y el estado nunca se presenta como
una barra de ancho completo. Los titulos detectados deben ignorar snippets tecnicos de Ristak
(`data-rstk-*`, acciones `open_popup/close_popup` y JSON de botones) y usar
`data-rstk-label`, un titulo humano cercano o `Formulario N` como respaldo.
Si una reescritura duplica temporalmente el ID estable de dos campos distintos,
el formulario completo entra en cuarentena: ninguno de esos campos sincroniza
el formulario fuente, el PATCH se rechaza y el runtime publico no consume el
payload ambiguo. El mapping canonico anterior queda dormido y vuelve a activarse
automaticamente cuando el ID vuelve a ser unico; no se obliga al usuario a
configurarlo otra vez.

Las instrucciones copiables para ChatGPT, Claude o Codex y el asistente interno
tratan este contrato como una compuerta obligatoria de entrega, no como una
recomendacion. Si el HTML contiene un formulario propio de captacion, la IA no
debe entregarlo ni marcarlo listo hasta comprobar que cada `<form>` tenga
`data-rstk-form-id` y cada `input`, `textarea` o `select` guardable tenga
`data-rstk-field-id`. `name`, `id` y `data-rstk-field` ayudan a interpretar los
campos, pero no reemplazan su identidad estable. La excepción explícita es
`<form data-rstk-calendar-book-form>` dentro de un calendario custom: sus hooks
`data-rstk-calendar-*` alimentan la reserva y no deben recibir IDs ni conversión
de formulario independiente.

En el sitio publicado, `data-rstk-field-id` es tambien la llave estable del
payload capturado. Por eso dos campos distintos pueden conservar el mismo
atributo `name` sin pisarse. En formularios con el contrato estable, el backend
acepta solamente campos detectados: una llave arbitraria o la llave de un campo
ausente no se infiere como dato de contacto ni crea un campo personalizado. El
fallback por `name` se conserva solo para HTML legacy sin IDs estables.

Cada cambio se guarda por campo mediante `PATCH /api/sites/:siteId/import-mapping`
con identidad exacta y exclusion por sitio; ya no existe un `PUT` que reemplace
el arreglo completo y pueda pisar asociaciones guardadas desde otra sesion.

La identidad persistente de una asociacion es `formId + fieldId`;
`pagePath` registra en que archivo se detecto y protege el PATCH contra una
pagina equivocada, pero no cambia la identidad. Como `formId` es globalmente
unico, mover el mismo formulario a otra pagina sin cambiar sus IDs conserva el
mapeo.
Editar copy, clases, estilos, orden o estructura alrededor de esos elementos no
borra el mapeo mientras se conserven los IDs. Si una reescritura del HTML retira
temporalmente un formulario o campo, Ristak conserva su asociacion como ausente
y la restaura cuando reaparece con la misma identidad; cambiar un ID significa
de forma intencional crear otro elemento que debe asociarse de nuevo. Si la
pagina solo contiene slots nativos o no tiene campos HTML propios, el panel
simplemente no muestra grupos de campos y cada slot nativo se configura desde su
fila o su engrane correspondiente.

En landings en modo embudo, los bloques nuevos que ejecutan una accion posterior
al evento (`calendario embebido`, `formulario embebido` y `pago`) nacen apuntando
a `Ir a la siguiente pagina` solo si la pagina actual tiene otra pagina por
delante. Si el bloque se crea en la ultima pagina, o no existe un destino
posterior real, conserva el comportamiento original del elemento: reglas del
calendario, reglas del formulario o mensaje de exito del pago. En bloques de
pago la accion posterior siempre queda guardada de forma explicita en
`settings.postPayment`: mostrar mensaje de exito, ir a la siguiente pagina,
redirigir a una pagina especifica o redirigir a una URL externa. Si el usuario
elige pagina especifica o URL externa, debe configurar ese destino en el
inspector del bloque; el renderer publico valida que la pagina exista o que la
URL sea `http/https`, y si llega una configuracion vieja/incompleta cae a
mensaje de exito para no dejar al comprador en una redireccion rota. Ese default
solo se aplica al crear o guardar el bloque; si el usuario cambia la accion a
reglas propias, pagina especifica o redireccion, se respeta su configuracion
guardada mientras sea valida.

El default de `Ir a la siguiente pagina` de un bloque de formulario vacio no se
hereda al vincular un formulario ya guardado. Elegir o cambiar el formulario
fuente deja `Al enviar` en `Usar reglas del formulario`: se conservan sus reglas
por opcion, estado `disqualified`, mensaje o pantalla de no calificado y
redirecciones configuradas. `settings.completionActionOrigin` distingue el
default automatico del embudo (`auto_funnel`), la herencia del formulario
(`form_source`) y una accion elegida de forma deliberada en el sitio (`user`).
Para embeds legacy que guardaron `next_page` sin origen, si el formulario fuente
contiene una regla `disqualify` o `disqualify_after_submit`, la hidratacion lo
trata como el antiguo default automatico y restaura las reglas del formulario.
Si el usuario vuelve a elegir explicitamente una accion del sitio, esa accion sí
manda. La regresion completa esta cubierta por
`backend/test/sitesEmbeddedStepform.test.mjs`: formulario fuente, seleccion en
landing, render publico y submission descalificada.

El editor tambien debe ocultar cualquier opcion literal de `Ir a la siguiente
pagina` cuando la pagina activa ya es la ultima del orden del sitio. Esta regla
aplica a formularios embebidos, calendarios embebidos, pagos, botones de bloques
y botones/opciones editables de sitios/HTML importados. Si una configuracion
vieja llega a la ultima pagina con `next_page` guardado, el editor debe bajarla
a un fallback seguro: reglas del formulario/calendario, mensaje de exito del
pago, URL vacia o accion omitida en botones/campos importados, segun la
superficie.

En embudos multipagina, los bloques de pago top-level solo bloquean el submit de
la pagina donde viven. Un formulario en una pagina anterior debe crear contacto y
submission aunque exista un bloque de pago habilitado en una pagina posterior. La
excepcion son pagos anidados dentro de un formulario/video gate: esos siguen
protegiendo el formulario que los contiene porque forman parte de la misma
experiencia de envio.

El prefill entre formularios, paginas de Sites y calendarios publicos debe usar
el contacto activo mas reciente del flujo. Al completar un formulario o cita se
guardan `contactId`, nombre, correo, telefono, `visitorId` y `sessionId` en la
sesion del navegador, y los links/redirecciones sobrescriben los parametros de
contacto anteriores. Si una URL trae datos de contacto explicitos, esos datos
ganan sobre `localStorage`; `localStorage` solo es respaldo cuando no hay una
sesion/URL activa. Esto evita que un test o visitante nuevo vea autocompletado
con el contacto viejo.

El checkout publico de Sites se resuelve por identidad completa:
`siteId + pageId + paymentBlockId`. Los requests de checkout deben incluir el
ID del bloque; si el `pageId` enviado no coincide con la pagina persistida del
bloque, el backend rechaza la peticion. Un `publicPaymentId` ya pagado solo puede
reanudar o desbloquear el envio cuando su metadata coincide con el mismo sitio,
pagina y bloque de pago; no puede pagar ni desbloquear otra pagina del embudo.
Al crear o actualizar Sites, las paginas sin ID o con ID repetido se normalizan
a IDs estables y unicos. Al restaurar bloques desde el editor, un bloque sin ID,
duplicado o colisionado con otro site recibe un ID nuevo antes de persistirse,
para evitar que dos elementos compartan identidad o se pisen entre si.

Los parametros configurables de eventos Meta en Sites y Automatizaciones exponen
las respuestas reales del formulario. Para preguntas con opciones se conserva el
valor interno enviado por el formulario en `{{form.responses.<clave>.value}}`
(por ejemplo `3500`) y el texto visible de la opcion en
`{{form.responses.<clave>.text}}` (por ejemplo `3,500 a 5,000 pesos`). El token
historico `{{form.responses.<clave>}}` sigue resolviendo al valor interno para
no romper configuraciones existentes. En el editor de Automatizaciones se muestran
los equivalentes bajo `{{formulario.respuestas.<clave>.value}}` y
`{{formulario.respuestas.<clave>.text}}`.

Los parametros configurables de eventos Meta en Sites y Automatizaciones exponen
las respuestas reales del formulario. Para preguntas con opciones se conserva el
valor interno enviado por el formulario en `{{form.responses.<clave>.value}}`
(por ejemplo `3500`) y el texto visible de la opcion en
`{{form.responses.<clave>.text}}` (por ejemplo `3,500 a 5,000 pesos`). El token
historico `{{form.responses.<clave>}}` sigue resolviendo al valor interno para
no romper configuraciones existentes. En el editor de Automatizaciones se muestran
los equivalentes bajo `{{formulario.respuestas.<clave>.value}}` y
`{{formulario.respuestas.<clave>.text}}`.

### Paridad de render editor/preview/publicado (contrato compartido)

Editor (canvas React), preview autenticado, preview-session publico y sitio
publicado/live comparten UNA sola fuente de verdad para estilos, defaults y CSS:
**`shared/sites/renderContract.js`** (ESM puro, sin dependencias) mas
**`shared/sites/paymentGateContract.js`**. Backend (`backend/src/services/sitesService.js`)
y frontend (`frontend/src/pages/Sites/*`) lo importan; el `Dockerfile` copia
`shared/` a ambos stages.

- Tema -> variables: `computeSitePageRenderState(site)` calcula TODAS las variables
  `--rstk-*` de pagina. Regla de contrato: la "explicitud" de `backgroundColor`/
  `textColor` se evalua sobre el theme CRUDO guardado; las lecturas de valores usan
  el theme mergeado con `DEFAULT_THEME`. Asi, un sitio SIN `backgroundColor`
  guardado conserva la paleta de su template en TODAS las superficies (antes el
  live mergeaba `#ffffff` y perdia la paleta del template: p. ej. un landing con
  template oscuro se publicaba en blanco). **Los sitios con fondo explicito no
  cambian.**
- Hoja publica: `buildStyleSheet(state)` = `:root` + `RSTK_BASE_CSS` +
  `RSTK_TEMPLATE_EXTRAS`. El canvas del editor inyecta esa MISMA hoja transformada
  con `rescopeSiteCssForCanvas` (prefijo `.rstkCanvas`, `@media`->`@container
  rstk-canvas`, `vw`->`cqw`, `100vh`->`var(--rstk-vh100)`), de modo que el
  responsive del editor simula el viewport real. `sitesCanvas.css` queda reducido
  a chrome del editor (seleccion, drag, mocks) con divergencias marcadas
  `/* ALLOWED-DIVERGENCE */`.
- Bloques: `buildBlockStyleVars`/`buildBlockStyleClassName`/`blockHasStyleWrapper`
  son compartidos; el wrapper `.rstk-block-style` se emite bajo las mismas
  condiciones en editor y live, y el override de ancho por campo cuelga de
  `.rstk-field-width-set` (solo con `fieldWidth`).
- Pago: el shell del checkout comparte estilos; el preview del editor solo muestra
  lo que el vivo mostraria (fila de meses standalone solo Conekta via
  `msiEligibility`; Stripe en `/pay` y Sites usa MSI controlado por backend cuando
  el cobro trae `stripeInstallments.maxInstallments`; Mercado Pago y CLIP resuelven
  installments dentro de su widget/SDK cuando la cuenta/tarjeta califica; Rebill en
  Sites muestra resumen de redireccion y abre el Checkout Landing hospedado
  card-only con `installmentsSettings`; boton de
  pago con icono; badge "No visible en el sitio
  publicado" cuando el gate esta deshabilitado). En modo test, el preview y el
  checkout publicado muestran el helper de tarjetas de prueba del proveedor debajo
  del mensaje de checkout, de modo que cualquier error/rechazo queda visible antes
  del acordeon de ayuda. Stripe, Conekta, Mercado Pago, CLIP y Rebill usan el mismo
  contrato de `paymentGate`; CLIP monta el SDK oficial en el checkout publicado,
  requiere email/telefono para procesar el cargo y puede habilitar MSI con
  `terms.enabled` si el bloque lo permite; Rebill prepara primero el pago local y
  redirige a `pay.rebill.com`, dejando la confirmacion a webhooks/retorno de
  Rebill y al status autoritativo de Ristak. El selector de
  pasarela del inspector debe persistir
  inmediatamente el bloque para que el modo vivo no monte una pasarela anterior; el
  HTML publicado, `/checkout/init` y el cargo deben usar siempre el mismo
  `paymentGate.gateway`. Si un visitante abandona el checkout antes de pagar, el
  registro queda pendiente/oculto y no genera error; solo un rechazo real de la
  pasarela se muestra como `failed`. El toggle "guardar tarjeta" se retiro
  (Stripe Link no es ocultable por codigo).
- Tipo de cobro en Sites: el bloque de pago permite elegir `Pago unico` o
  `Suscripcion` cuando la pasarela soporta recurrencia en checkout hospedado.
  Stripe, Conekta, Mercado Pago y Rebill pueden crear el checkout de
  autorizacion de suscripcion desde Sites; CLIP queda limitado a pago unico. En
  suscripciones de Sites, el publicado siempre pide correo y telefono antes de
  redirigir al checkout de la pasarela para crear o ligar el contacto local. El
  pago inicial de autorizacion conserva metadata `site_checkout_subscription`,
  `siteId`, `pageId`, `paymentBlockId`, pasarela, monto, moneda y frecuencia. La
  reanudacion de un `publicPaymentId` pendiente valida tambien tipo de cobro y
  frecuencia, no solo monto/pasarela, para evitar reutilizar una liga vieja de
  pago unico como suscripcion o viceversa.
- Diferencias permitidas entre superficies: SOLO auth, tracking/pixel, param
  preservation y `headerTrackingCode` (nunca corren en editor/preview por
  seguridad), y el chrome de edicion. NO se permite divergencia en CSS visual,
  defaults de tema, estructura del bloque, border, color, fuente, radius o
  spacing.
- Compatibilidad legacy: no hay migracion de datos; la normalizacion maneja
  shapes viejos. **Impacto en produccion:** sitios ya publicados que dependian de
  la paleta del template sin fondo explicito cambiaran su apariencia live para
  coincidir con lo que el editor siempre mostro.

## Automaciones

Automations incluye:

- Carpetas.
- Flujos visuales.
- Triggers.
- Condiciones.
- Acciones sobre contactos/tags/usuarios.
- Mensajes WhatsApp/Meta/email.
- Webhooks.
- Delays/drips.
- Enrollments.
- Jobs programados.
- Assets y referencias.

El motor principal vive en `backend/src/services/automationEngine.js`.
Los cambios de fechas/delays deben obedecer `DATE_TIME_GUIDELINES.md`.
Los crons de integraciones externas deben obedecer `INTEGRATION_CRON_RULES.md`.

El camino caliente de eventos usa el indice durable
`automation_trigger_index (event_type, endpoint_id, automation_id)`, mantenido
por `automationTriggerIndexService.js`. Publicar o republicar reemplaza en la
misma transaccion las llaves derivadas de `published_flow`; pausar, archivar o
eliminar retira las llaves productivas, y guardar un borrador solo actualiza el
lookup de su muestra de webhook sin cambiar el contrato vivo. Un flujo puede
tener varios disparadores y un tipo puede mapear a varios eventos reales; por
ejemplo, `trigger-contact-updated` tambien participa en eventos de etiquetas,
citas y pagos porque el motor vuelve a evaluar sus filtros antes de inscribir.
La compuerta de licencia `canRunAutomationFlow` se conserva despues del lookup.

Los webhooks entrantes productivos siempre hacen match exacto por `endpoint_id`:
un endpoint vacio no es comodin. La captura de muestra del editor usa una llave
interna separada derivada del `flow` editable, por lo que tampoco necesita
recorrer todas las automatizaciones. Al instalar `090*`,
`automation_trigger_index_state` coordina un bootstrap por lotes de 100 con
candado distribuido, `index_version` y yields entre lotes. Cambiar el mapeo de
disparadores exige subir esa version; una version vieja borra y reconstruye el
indice antes de volver a `ready`. Corre en segundo plano y no bloquea el
healthcheck; mientras no llega a `ready`, el runtime conserva temporalmente la
lectura legacy para no perder eventos. Esperas de respuesta, clics y
reanudaciones ya conocen sus `automation_id` y cargan solo esos flujos
publicados. La captura de muestra bloquea y vuelve a leer el borrador antes de
escribir; luego actualiza `flow` e indice en la misma transaccion para no pisar
un endpoint guardado al mismo tiempo.

Los disparadores del nodo inicial son opcionales. Una automatizacion publicada
puede funcionar como secuencia manual o externa y arrancar desde contactos,
acciones masivas, jobs programados, pruebas del editor, API o cualquier
superficie que inscriba contactos explicitamente. Publicar sin disparadores es
valido siempre que exista al menos un paso conectado al inicio; si el flujo debe
arrancar solo ante un evento, entonces se agrega y valida el disparador
correspondiente.

Al crear o duplicar automatizaciones, el backend asigna nombres numerados y
unicos a partir del nombre base: `Automatización sin título 1`,
`Automatización sin título 2`, etc. La numeracion evita que varias
automatizaciones nuevas se vean iguales en la libreria. El renombrado manual no
aplica esa numeracion automatica: si el usuario cambia el nombre, se respeta lo
que escriba.

Al eliminar una automatizacion, el backend debe hacerlo en transaccion y limpiar
su estado runtime directo: inscripciones, entradas de goteo, ejecuciones de
disparadores programados y jobs manuales/programados. Las notificaciones internas
historicas no se borran, pero se les quitan las referencias a la automatizacion,
nodo e inscripcion eliminados para evitar enlaces fantasma.

La libreria frontend comparte un overview observable entre home y editor. Crear,
duplicar, renombrar, mover o cambiar carpetas publica el resultado confirmado sin
esperar una recarga completa. El borrado retira la fila antes de esperar otra
consulta y la restaura en la misma posicion si la API falla. Las consultas del
overview llevan version y revision local: una respuesta que empezo antes de una
mutacion no puede revivir automatizaciones ni pisar el estado mas nuevo.

Al cambiar entre automatizaciones dentro del editor visual, la ruta
`/automations/:id` es frontera de estado: el editor se remonta por ID y limpia
errores de carga, seleccion, modales, pruebas, registros, stats, paneles y estado
de guardado antes de cargar la siguiente automatizacion. No debe ser necesario
refrescar la pagina para abrir otra automatizacion ni para salir de un error de
carga anterior.

Los disparadores programados de una automatizacion tienen recuperacion acotada:
si un reinicio o despliegue cruza su hora, el scheduler ejecuta la instancia
perdida solo durante las siguientes 24 horas. `automation_schedule_runs` reclama
una clave unica por instancia para no duplicarla. Despues de esa ventana no se
reproducen campañas viejas al volver a levantar el backend. Las inscripciones
que vencen durante una espera se retoman en orden de `resume_at`, de la mas vieja
a la mas nueva.

En el editor visual, la libreria lateral de automatizaciones es responsiva y
estatica: en pantallas muy amplias usa el ancho grande fijo, y en ventanas
normales o chicas se compacta por breakpoint. No se expande ni se contrae al
hover o al enfocar controles internos.

Las herramientas flotantes del canvas (post-it, zoom, centrar y ordenar flujo),
la barra de selección múltiple y el botón de agregar paso se muestran solo
cuando el editor montó el frame estable de la automatización activa **y** el
cargador de datos de la ruta ya se retiró. El canvas se prepara por detrás, pero
sus controles no deben aparecer solos sobre el fondo del lienzo mientras la
página sigue mostrando que carga contenido.

El editor visual no ofrece una vista previa separada del flujo. El canvas es la
representacion editable del recorrido; la validacion practica se hace con
**Probar**, registros de ejecucion e historial de inscripciones.

Regla de prueba desde el editor: el botón **Probar** usa la última versión
guardada del flujo y no exige que la automatización esté publicada. Si hay
cambios locales sin guardar, primero debe guardarse. Las inscripciones manuales
desde contactos, acciones masivas, jobs programados y eventos reales siguen
usando únicamente automatizaciones publicadas y su `published_flow`.
El modal de prueba usa un solo campo **Contacto**: el usuario puede buscar un
contacto existente o crear uno nuevo desde el mismo selector, y la prueba corre
sobre ese contacto elegido.

El modal **Registros de la automatización** muestra el historial de
inscripciones y los registros de ejecución con fecha y hora en la zona horaria
del negocio. Esto permite reconstruir cuándo entró cada contacto y cuándo se
ejecutó cada paso, no sólo el día calendario. Cada inscripción conserva además
un resultado agregado (`En curso`, `Exitoso`, `Error` o `Detenido`) y cada paso
del registro conserva un resultado explícito (`Exitoso`, `Error`, `Esperando`,
`Omitido` o `Información`) junto con el detalle de lo que ocurrió. Los errores
guardan el mensaje técnico legible y, cuando existe, el código de respuesta;
los reintentos muestran el intento programado y marcan el error como resuelto
cuando una repetición posterior sí funciona. Los registros antiguos sin esos
campos se normalizan al leerlos para mantener visible su información histórica.

Las inscripciones manuales programadas también dejan una bitácora propia en
`automation_contact_enrollment_jobs.log`: registra cuándo el motor tomó el
trabajo, si creó la inscripción y el motivo exacto cuando falló. El campo
`error` se conserva como resumen para consultas rápidas, mientras que la
bitácora es la fuente detallada para investigar el caso.

La acción **Notificaciones** permite elegir canales de entrega independientes:
campanita interna del CRM (`internal_notifications`), push a la app movil/PWA
(`push_subscriptions` y `mobile_push_devices`) y correo interno al email del
usuario (`users.email`) mediante la configuración SMTP de la cuenta. Las
automatizaciones legacy sin esos flags conservan el comportamiento anterior:
campanita + push, sin correo. Si correo o push no están configurados, el paso
registra el canal como omitido y continúa; no debe bloquear todo el flujo.

Los nodos del canvas muestran un badge con el numero de contactos activos,
en espera o pausados dentro de ese paso. El badge se refresca al cargar el
editor, al volver a enfocar la pestaña, cada pocos segundos y cuando la propia
app mete o mueve contactos en automatizaciones. Al hacer clic en el badge se
abre un modal de control por paso: desde ahi se puede sacar al contacto del
flujo, pausarlo, reanudarlo, reintentarlo, empujarlo al siguiente paso o moverlo
a un paso especifico del flujo publicado. Las acciones que ejecutan pasos usan
el motor real de automatizaciones; no son solo cambios visuales de estado.

Los disparadores de comentario de Facebook e Instagram se activan solo con
eventos reales de comentario. La respuesta no se configura como un DM suelto:
el editor usa la acción **Responder comentario**, y dentro de esa acción el
usuario debe elegir una accion especifica: responder comentario publico en
Facebook, responder comentario publico en Instagram, enviar mensaje privado por
Messenger o enviar mensaje privado por Instagram DM. La accion debe coincidir
con la plataforma del disparador; si una automatizacion mezcla comentarios de
Facebook e Instagram, se deben separar los flujos para evitar que el sistema
adivine la red social. Por contrato de Meta, Instagram publico solo acepta texto
en `/{ig-comment-id}/replies`, Facebook publico acepta texto y una imagen, y las
respuestas privadas usan el `comment_id` para mandar un unico mensaje inicial de
texto al comentarista por Messenger o Instagram DM. Ese contrato inicial no
acepta imagen, video, audio ni archivo; cuando la persona responde, el flujo ya
puede continuar con un nodo normal de Messenger/Instagram y multimedia por
`recipient.id`. Editor, validacion y runtime aplican la misma restriccion. La
imagen publica de Facebook pasa por la preparacion multimedia antes de entregar
su URL HTTPS a Graph. Las respuestas privadas a comentario cuentan como mensaje
enviado para una espera posterior de respuesta; las respuestas publicas no abren
una espera de DM. El `externalId` se reserva antes del POST para que un reintento
no consuma dos veces el unico mensaje privado permitido. Si una respuesta a
comentario falla temporalmente y entra a reintento, la inscripcion debe conservar
`platform`, `commentId`, `postId`, `mediaId`, `parentCommentId` y `permalink`;
sin ese contexto el reintento ya no puede reconstruir el endpoint correcto de
Meta y debe tratarse como bug del motor, no como configuracion del usuario.

## Jobs y crons

Crons de sistema que pueden vivir activos:

- Mensajes programados.
- Acciones masivas de contactos.
- Recordatorios de citas.
- Automatizaciones de pago.
- Scheduler de automations.
- Scheduler local de revisión de referencias de automatizaciones (lectura O(1),
  worker paginado y publicación CAS).
- Mantenimiento de read-models 096/098/099 (tres singleton rows cada dos
  segundos; sólo encola workers, nunca recorre fuentes dentro del tick).
- Vencimiento de pausas del agente conversacional (local, indexado e idempotente).

Crons de integracion que deben pasar por registry y detector local:

- HighLevel sync.
- Meta sync/version.
- Google Calendar sync.
- WhatsApp QR watchdog.
- Stripe/Conekta/Mercado Pago/Rebill payment plans. En Rebill el cron cobra
  parcialidades vencidas con tarjeta guardada (`cardId`) y solo libera link cuando
  falta autorizar tarjeta; Ristak mantiene el reloj del plan.
  CLIP queda fuera de planes de pago y suscripciones; solo confirma pagos unicos
  con webhook/refresh del checkout.

Regla: un cron de integracion externa no arranca solo porque el backend arranco.
Debe activarse por estado local de conexion y sincronizarse al conectar,
desconectar o cambiar modo relevante.

La sincronización completa de HighLevel tiene single-flight por proceso para que
guardar la conexión, el botón manual y el cron no dupliquen simultáneamente el
mismo trabajo. Los contactos se enumeran con `POST /contacts/search`, páginas de
100 y detección de página repetida; timeouts, rate limits y fallos 5xx se
reintentan con espera acotada, mientras errores permanentes fallan de inmediato.
El borrado suave de contactos faltantes sólo ocurre después de terminar toda la
enumeración remota sin errores.

Ademas, cada tick que pueda enviar mensajes, sincronizar datos premium o cobrar
debe validar `canRunBackgroundJob(feature)`. Ejemplos: mensajes programados y
watchdog QR requieren `whatsapp`; recordatorios y confirmaciones de citas
requieren `appointments`, y cada canal valida su propia conexion/permiso al
momento de enviar; automatizaciones de pago requieren `payment_automations` y
crons de parcialidades requieren `payments`/`payment_plans`; Meta requiere
`meta_ads`; Google Calendar requiere `google_calendar`; email inbound requiere
`email`; HighLevel requiere `highlevel_integration` y sus conversaciones tambien
`chat`.

## Media y Bunny

Media centraliza uploads, cuotas, storage provider, Bunny Storage y Bunny Stream.
El servicio principal es `backend/src/services/mediaStorageService.js`.

Capacidades:

- Upload desde archivo, buffer o data URL.
- Libreria de media.
- Explorador por cuenta con carpetas persistentes, incluidas carpetas vacías.
- Soft delete, move, replace.
- Cuotas.
- Compresion.
- Bunny Storage para archivos.
- Bunny Stream para video.
- En `Configuración > Media`, **Nueva carpeta** crea rutas relativas a la unidad
  privada del negocio y **Subir aquí** guarda directamente en la carpeta abierta,
  sin inventar niveles de tipo o fecha. El backend siempre antepone
  `accounts/<slug>` y normaliza la ruta, así que el navegador nunca puede elegir
  ni escapar hacia la raíz de otro cliente. La tabla `media_folders` conserva las
  carpetas vacías; Bunny crea el árbol físico al recibir el primer archivo.
- El usuario también puede arrastrar archivos o carpetas desde Finder, Escritorio,
  Descargas o un volumen externo. Soltar sobre una carpeta sube ahí; soltar en el
  resto del explorador sube a la ubicación abierta. Una carpeta arrastrada
  conserva su jerarquía interna y la operación siempre copia: no altera el
  archivo original de la computadora.
- Mover o eliminar carpetas mantiene sincronizados los assets y la carpeta
  persistente. Las taxonomías automáticas de Chat, Sites, formularios, avatares y
  otros módulos internos no cambian: el control manual aplica sólo a la biblioteca
  administrativa de Media.
- Subida TUS directa y resumible para videos de Sites/Forms, en chunks, sin que
  el upload inicial atraviese el proceso Render ni exponga la API key.
- Preparacion/finalizacion idempotente en `media_assets`: reserva cuota mientras
  sube y queda `ready` solo después de verificar por TUS el tamaño y avance que
  Bunny recibió, confirmar el original en Stream y transmitir ese original a
  Bunny Storage con el mismo número de bytes.
- Mientras sube, un TUS directo vive temporalmente como `bunny_stream`; al
  finalizar queda como `bunny`, con `bunny_path` y `public_url` de Storage. La
  identidad Stream permanece en metadata para el render publicado y analíticas.
- La sincronización de Stream también repara assets TUS antiguos que quedaron
  sin Storage, sin crear otro video ni cargar el archivo completo en memoria.
- Candado distribuido por negocio para que dos preparaciones simultáneas no
  creen videos duplicados ni compitan por la misma cuota; cancelar, un fallo
  terminal de Stream y el TTL de siete días limpian reservas abandonadas.
- El upload iniciado desde Sites se autoriza con permiso de escritura `sites`;
  empleados quedan forzados al tenant/usuario de su sesión y la biblioteca
  administrativa conserva `settings_media` y su ruteo multi-cuenta para admins.
- Sync/retry/diagnosticos.

Documento operativo: `docs/MEDIA_STORAGE_BUNNY.md`.

## IA

Ristak expone una superficie principal de IA en el menu lateral: `Chatbot`
(`/ai-agent`). Dentro de esa pagina viven dos secciones segun licencia:

- `Chatbot` (`/ai-agent/conversational`): agentes que interactuan con contactos
  y objetivos.
- `Configuracion` (`/ai-agent/general`): configuracion del asistente interno de
  operacion, busqueda, analisis y acciones con ledger de ejecucion.

La misma pantalla de configuracion general tambien esta disponible como proxy en
`Configuración > Inteligencia Artificial` (`/settings/artificial-intelligence`),
para que el usuario pueda ajustar token, modelo y contexto desde Configuracion o
desde Chatbot sin duplicar estado ni rutas de backend.

### Catalogo y default de OpenAI

Cuando el proveedor es OpenAI, el catalogo actual ofrece GPT-5.6 Sol para
trabajo complejo, GPT-5.6 Terra para balance de capacidad y costo, y GPT-5.6
Luna para alto volumen sensible a costo. El default nuevo de Ristak AI y de los
agentes conversacionales es `gpt-5.6-luna`; los flujos automaticos de menor
costo aprobados por backend usan ese mismo modelo. La seleccion explicita de un
usuario nunca se reemplaza. Al conectar o reconectar OpenAI, una configuracion
que aun conserve exactamente el default anterior `gpt-5.4-mini` se promueve a
Luna; los modelos anteriores siguen disponibles para quien los haya elegido.

En Sites, crear una pagina con IA usa GPT-5.6 Sol por defecto y los cambios
pequenos usan GPT-5.6 Luna. Web, Android e iOS exponen el mismo catalogo de
OpenAI para que el usuario no pierda opciones al cambiar de superficie.

La API conserva endpoints separados:

- `/api/ai-agent`: asistente interno.
- `/api/conversational-agent`: agentes conversacionales.

### Configuracion y experiencia del usuario

Todos los agentes conversacionales usan un solo runtime nativo de tool calling.
No existe selector, fallback ni ruta de ejecucion del motor anterior. El editor
deja plantillas utiles por defecto y separa las piezas que el dueño sí controla:

- Estrategia y capacitacion: conocimiento, objetivo, guion y proceso del negocio.
  Es la autoridad sobre que debe lograr la conversacion, que debe ocurrir antes de
  una accion y en que momento se puede consultar, agendar, cobrar, enlazar o
  entregar a una persona.
- Personalidad: tono, vocabulario, formalidad, humor, emojis y estilo del agente.
  No puede cambiar el proceso ni adelantar una accion definida por Estrategia. Si
  queda vacia, la voz general del negocio funciona como respaldo.
- Capacidades: agenda, cobro, enlace, traspaso y objetivo propio, cada una con su
  configuracion operativa. Activarlas sólo pone la herramienta a disposicion del
  modelo cuando esta completa y lista; no inicia un flujo ni ordena usarla.

La zona blindada existe solamente en servidor y no se muestra como un bloque
editable ni como "Proteccion de Ristak". Se deriva del manifiesto validado de
`schedule_appointment`, `collect_payment`, `send_link`, `handoff_human` y
`custom_goal`; nunca se acepta desde el cliente como fuente de permisos ni se
mezcla con el texto del dueño.

La jerarquia es deliberada y no intercambiable: la zona blindada manda sólo en
seguridad, permisos, configuracion y hechos reales; Estrategia manda en proceso y
momento; Personalidad manda en la forma de expresarlo. Si Personalidad contiene
una instruccion operativa que contradice Estrategia, se ignora esa parte sin
silenciar ni descartar la respuesta. Ninguna capacidad activa se interpreta como
intencion del cliente ni como permiso para brincar los pasos definidos por el
dueño.

Los dos campos editables aceptan el texto completo sin recortes silenciosos y
pueden abrirse en un editor enfocado grande sin crear una copia temporal del
borrador. El contrato `prompt_config` schema 2 conserva `strategyText` y
`personalityText` por separado; un agente anterior con solo `editableText` se
migra de forma compatible copiando todo su contenido a estrategia y dejando
personalidad vacia, sin intentar adivinar como partirlo. El autosave usa una
revision por borrador para que una respuesta lenta no pise cambios mas nuevos y
ejecuta cualquier guardado pendiente al cerrar, probar, publicar o salir.

Cada capacidad se configura por separado y un agente puede tener varias. Agenda
queda amarrada a un calendario; cobro a un producto/precio real o a un anticipo
configurado; enlace a una URL web absoluta y segura con protocolo HTTP(S);
traspaso a sus reglas y usuario; objetivo propio a una descripcion concreta. Una
URL ausente, relativa o con otro protocolo deja `send_link` no disponible y su
tool no se expone al modelo. Al editar una capacidad activa el agente se
pausa para probarlo antes de volver a publicar. Un borrador apagado puede quedar
incompleto; al publicar, el backend valida el manifiesto otra vez y consulta la
realidad operativa antes de persistir el cambio: calendario y usuario activos,
producto/precio relacionados y cobrables, moneda de la cuenta, monto de
anticipo y destino HTTP(S) de enlaces directos o triggers.

Activar Agenda y Cobrar al mismo tiempo no convierte cualquier deposito en
anticipo de cita. Un cobro conserva `purchase` o `deposit` mientras sea
independiente. Sólo cuando la agenda ya ofrecio un slot real, la persona acepto
esa oferta y el terminal abrio un intento durable para ese horario, el cobro se
etiqueta `appointment_deposit`. Si la oferta falla, vence o el slot se ocupa, el
mismo turno no puede degradar ese intento a un deposito general y cobrarlo de
todos modos.

Agenda define ademas `bookingOwner`: `ai` hace que la IA revalide, cree y solo
despues confirme la cita; `human` deja que la misma IA consulte y ofrezca slots
reales, pero al elegirse uno ejecuta `request_human_booking`. Esa tool vuelve a
comprobar que el horario siga libre, guarda la fecha y el contexto, cambia el
chat a atencion humana y avisa al equipo sin crear ni prometer una cita. Puede
asignarse un usuario activo concreto o avisarse al equipo sin asignacion. La
asignacion generica de `handoff_human` no se hereda silenciosamente cuando
Agenda dice "sin asignar".

`bookingOwner` decide quien confirma cualquier horario nuevo. En modo IA esto
incluye crear una cita y mover una existente. En modo humano, la IA puede consultar
la cita actual, buscar disponibilidad y ofrecer un horario nuevo, pero al recibir
la confirmacion usa la misma terminal `request_human_booking`: revalida el espacio,
entrega al equipo la cita original y la nueva fecha, y conserva intacto el horario
vigente hasta que una persona haga el cambio. `reschedule_appointment` ni siquiera
se expone al modelo en ese modo. Cancelar sigue siendo una operacion independiente
controlada por `allowCancellation`; la disponibilidad para cambios depende de
`allowReschedule`.

En la capacidad Cobrar, `collectionMethod` separa dos caminos excluyentes desde
el primer campo del formulario. `payment_link` usa una pasarela, crea un enlace
hospedado y sólo confirma el pago por la señal real del proveedor; su pasarela
predeterminada es Stripe y nunca solicita una foto. `bank_transfer` no usa ni
valida pasarela, MSI o vencimiento de link: comparte los datos bancarios
configurados y analiza la foto, PDF o captura enviada por la persona. Esa imagen
siempre se registra como `pending_review` y no prueba fondos por sí sola. El
frontend muestra un resumen completo encima de **Configurar cobro** y vuelve a
validarlo antes de guardar. `chargeType` sigue distinguiendo producto/precio,
cobro directo y anticipo; no se sobrecarga para representar el medio de cobro.
`paymentMode` se conserva como contrato compatible: pago completo apaga residuos
de anticipo y anticipo los activa. Los montos se editan con el simbolo derivado de
`account_currency` y respetan los decimales de esa moneda. Publicar permanece
accionable aun cuando falte configuracion: al intentarlo, la interfaz muestra el
requisito exacto dentro de Cobrar y junto al boton, en vez de dejar un boton
deshabilitado sin explicacion. Si el catalogo no puede cargarse, el selector
tambien informa el error en lugar de aparentar que no existen productos.
Para links, publicar vuelve a comprobar que la pasarela elegida esté conectada y
en modo `live`; el runtime repite ese guard justo antes de crear el link y nunca
cae a otra pasarela. Para transferencias, publicar exige datos bancarios y omite
por completo esa consulta. Los meses disponibles se filtran por proveedor, monto
y moneda. La compatibilidad interna puede leer una conexion heredada, pero no se
ofrece como opcion nueva ni como valor predeterminado. Si un monto perdería
precisión antes de hablar con el proveedor, el runtime falla cerrado. En
PostgreSQL, la migración `041_payments_amount_numeric.postgres.sql` convierte el
ledger a `NUMERIC(20,6)` con un `lock_timeout` local; SQLite conserva `REAL` para
desarrollo. Los contratos HTTP/MCP serializan el decimal de PostgreSQL como
número JSON para no cambiar la API pública.

Los links conversacionales también tienen una reserva durable por identidad
financiera en `conversational_payment_semantic_claims`. La idempotency key evita
repetir el mismo inbound; el claim semántico impide que dos mensajes distintos y
concurrentes creen dos links para el mismo agente, contacto, producto/precio,
monto, moneda, pasarela, propósito y, cuando aplica, selección de cita. Un
segundo turno espera el request canónico ya ligado y reutiliza exactamente su
ledger; si el primer intento quedó ambiguo, la búsqueda falla o el vínculo no es
verificable, se bloquea antes de volver a llamar al proveedor. Un cobro ya
pagado, cancelado, rechazado, reembolsado o vencido libera la identidad para un
nuevo cobro legítimo, pero nunca se reutiliza como pendiente.
Si un proceso muere después de reservar la identidad pero antes de crear el
request durable, una lease permite que otro inbound recupere el claim sólo
cuando no existe ninguna fila de request; el dueño anterior debe revalidar el
claim después de insertar su request y antes de llamar al proveedor. Una vez que
existe request, nunca hay takeover ciego: un fallo potencialmente ambiguo queda
bloqueado para revisión humana en vez de intentar un segundo cobro.

`get_payment_status` sólo expone cobros ligados por el mismo agente al contacto
del hilo. `fundsConfirmed=true` exige status exitoso y `payment_mode=live`
explícito. Un link sólo vuelve a mostrarse si su status interno sigue abierto,
su estado crudo guardado por la pasarela no es terminal y conserva un
`due_date` válido; las fechas de calendario se comparan en la zona del negocio y
los instantes UTC no dependen de la zona del servidor. Monto y moneda se
revalidan en unidades mínimas reales de cada currency, no con una tolerancia
decimal fija.

El bloque **Control y datos** y las capacidades guardan estos contratos dentro de
`capabilities_config` schema 3:

- `safetyPolicy`: medidas preventivas reversibles ante phishing, enlaces
  maliciosos, fraude, spam persistente, acoso sexual, amenazas, abuso severo o
  manipulacion del prompt.
- `schedule_appointment.testMode` y `collect_payment.testMode`: habilitan por
  separado los efectos reales de prueba de citas y pagos, siempre aislados y con
  limpieza fija a los cinco minutos. El valor raiz anterior sólo se lee para
  migrar configuraciones viejas y ya no aparece como categoria en la interfaz.
- `dataRequirements`: define exactamente que datos puede solicitar, si son
  obligatorios, opcionales o condicionales, para que accion aplican, como se
  actualiza el contacto y que campos se piden a titulares distintos o invitados.

Los datos del contacto y de titulares distintos/invitados se eligen en dos
dropdowns con casillas. No existen switches maestros ni uno por campo: una lista
vacia significa que no debe pedirlos, y seleccionar cualquier campo deriva los
flags `enabled` correspondientes tanto en frontend como en servidor.

Los requisitos de datos no son un cuestionario general ni se preguntan al inicio
por reflejo. Se aplican justo al borde de una accion terminal que el modelo ya
decidio completar: confirmar una cita nueva, cobrar, entregar un enlace u objetivo
o pasar el chat al equipo. No bloquean consultas, ofertas de horario, cancelaciones
ni la reagenda de una cita existente. Ademas, sólo aplican si esa capacidad esta
lista y el `scope` del requisito coincide con la accion concreta. La configuracion de titulares distintos o invitados sólo
entra cuando Agenda esta disponible y el cliente menciona expresamente que la
cita es para otra persona o que habra invitados. Esa configuracion nunca obliga a
pedir telefono, correo o nombre adicional al solicitante del hilo.

Sin `dataRequirements` activo, el agente usa la identidad del hilo y no insiste
por nombre, telefono, correo, apellido ni otra ficha. `save_contact_data` sólo se
expone cuando esa configuracion autoriza campos, aplica una allowlist en servidor,
valida telefono/correo y nunca usa datos de un invitado para sobrescribir al
solicitante. Si el dueño desactiva la actualizacion de la ficha, la misma tool
conserva el dato confirmado únicamente durante esa vuelta para completar la
accion y no escribe el contacto; así un dato obligatorio no entra en un ciclo
imposible. Los campos marcados `required` se vuelven una precondicion real de
servidor antes de confirmar una cita nueva, cobrar, entregar un enlace u objetivo
o pasar el chat cuando tienen alcance `any_action`; no
basta con que el modelo diga que ya los obtuvo. Los opcionales no bloquean y los
condicionales conservan su condicion explicita para que el modelo los solicite
cuando corresponda. Un nombre, telefono o correo valido que ya sea distinto no
se reemplaza por un booleano emitido por la IA: se conserva como dato alternativo
para revision. Vacios y nombres provisionales sí pueden completarse segun la
politica configurada. Nombres automaticos de canal como `Usuario de WhatsApp`,
`WhatsApp User`, sus equivalentes de Instagram/Facebook/Messenger, valores que
son solamente un telefono y perfiles formados o decorados con emojis o sólo
simbolos se consideran provisionales: no satisfacen `full_name` requerido y
`replace_placeholders` puede sustituirlos por el nombre humano confirmado. El
servidor tambien rechaza como nombre nuevo esos mismos valores no humanos para
que la IA no cambie un placeholder por otro. Cuando la cita es para otra persona,
`primaryAttendee` es tambien la
fuente canonica del nombre y relacion usados en titulo/notas, tanto para
`book_appointment` como para `request_human_booking`; los campos legacy pueden
venir en `null` sin perder a la persona titular.

El boton `Nuevo agente` crea directamente un borrador con la plantilla y abre
este mismo editor; ya no existe un wizard paralelo basado en objetivo, intención
o "quien completa". La plantilla y las tools reales hacen util al agente aunque todavia no exista un
perfil estructurado completo del negocio. Crear, probar, publicar o activar una
conversacion no queda bloqueado por ese perfil: si falta contexto, el prompt
obliga a reconocerlo y consultar productos, calendarios o datos reales. Cualquier
valor viejo de `runtime_mode` se normaliza a `tool_calling_v2` y nunca selecciona
otra implementacion. Una fila sin `capabilities_config` queda sin capacidades;
`success_action`, `goal_workflow_config` y otros campos anteriores no se
convierten ni pueden habilitar tools por debajo.

La personalidad inicial de cada agente nuevo usa como fuente unica
`shared/conversational/default-personality.md` (plantilla
`ristak-conversational-v3`). Backend y frontend cargan el mismo Markdown completo,
por lo que escritorio y la vista celular no pueden divergir. El contenido se
materializa dentro de `prompt_config` al crear el agente: cambiar el archivo en una
version futura no reescribe la personalidad ya guardada de agentes existentes. La
zona de Personalidad controla la forma de expresarse; cualquier regla operativa
incluida ahi sigue subordinada a Estrategia y capacitacion y a las capacidades
blindadas del runtime.

Escritorio y celular crean el mismo borrador sin capacidades operativas
preactivadas: el dueño debe elegir calendario, cobro, enlace o traspaso de forma
explícita, en vez de recibir una tool distinta según la pantalla usada.

Requisitos duros al publicar (`enabled=true`, validados en
`assertAgentGoalRequirements` de `conversationalAgentService.js` y espejados en
wizard/editor web):

- Toda capacidad activa debe estar completa. Agenda exige
  calendario; pago completo exige producto y precio; anticipo exige monto/rango
  y metodo verificable; transferencia exige datos bancarios; enlace exige URL;
  objetivo propio exige descripcion. Ademas, publicar cruza esos IDs contra las
  tablas reales y rechaza recursos inexistentes, inactivos, mal relacionados,
  precios no positivos o monedas distintas a `account_currency`.

Un borrador apagado puede guardarse incompleto; publicarlo exige lo anterior.

Alcance de contactos ("¿A quien puede atender?"), tres opciones funcionales
(`contactScope`, enforcement en `contactIsOutOfScopeForAgent` sobre matching y
runner):

- `new_only` ("A todos los nuevos contactos desde ahora"): solo contactos
  CREADOS despues del corte. Es el alcance predeterminado al crear cualquier
  agente nuevo, tanto desde escritorio como desde la experiencia movil o la API.
- `all` ("A todos los nuevos mensajes desde ahora"): cualquier chat con inbound
  nuevo, sin importar cuando nacio el contacto (historico).
- `existing_only` ("A todos los contactos existentes"): solo contactos que YA
  existian antes del corte; los leads nuevos no entran (agentes de
  reactivacion/recuperacion de base).

Los alcances acotados sellan `contact_scope_cutoff_at` al configurarse; cambiar
de alcance re-sella y volver a `all` lo limpia. Un par `new_only` +
`existing_only` con cortes compatibles (corte de existentes <= corte de nuevos)
son universos disjuntos y NO generan conflicto de entrada entre si
(`contactScopesAreDisjoint`); el mismo alcance catch-all duplicado si conflictua.
El alcance se evalua JUNTO con los filtros factuales de entrada/salida
(`entryRulesMatch`/`exitRulesMatch`: OR de grupos, AND por grupo; categorias
canal o numero receptor, tags, contacto, citas, pagos, anuncios y horario):
ambos deben cumplirse para que el agente tome el chat. No existe filtro por
palabras, frases o texto del mensaje; el lenguaje natural siempre lo interpreta
el modelo principal. Una pausa, omision o asignacion manual real conserva su
procedencia. Las superficies de control manejan agentes individuales, nunca un
pseudoagente global "Todos".

`contactScope` limita exclusivamente el matching automatico. Cuando un usuario
asigna manualmente un agente a un contacto, esa decision pertenece al contacto
completo y aplica por defecto a todos sus canales conversacionales soportados,
presentes y futuros; por eso una asignacion manual explicita puede atender un
contacto historico aunque el agente use `new_only`, o uno nuevo aunque use
`existing_only`. El runtime materializa un estado independiente por
contacto + agente + canal para que Messenger, Instagram, WhatsApp, SMS, webchat
y correo no compartan claims ni mensajes procesados. Pausar, tomar, omitir o
reanudar una asignacion manual actualiza la politica global y los estados ya
materializados. El agente debe seguir publicado y las reglas de salida,
seguridad preventiva y disponibilidad real del canal conservan autoridad. La
migracion `124*_conversational_manual_assignment_all_channels` recupera como
politica global la asignacion manual vigente mas reciente que ya existiera para
cada contacto.

### Runtime conversacional unico

Cada inbound, preview y seguimiento entra a un solo `Agent`/`Runner`. El modelo conversa y
decide llamadas estructuradas a las tools
que corresponden exactamente a las capacidades activadas. No ejecuta
`assessment`, `strategyPlanner`, `turnPolicy`, `closingPhaseGate`,
`complianceGuard`, reglas regex que decidan intención, bloqueen acciones o
supriman respuestas,
`stay_silent`, `discard_conversation` ni `update_closing_context`. La separacion
en globos es la unica excepcion de posprocesamiento: si el dueño la activa, una
mini-IA aislada con `gpt-5-nano` recibe solamente la respuesta final visible y
devuelve cortes estructurados. El umbral para dividir, numero maximo de globos,
tamano minimo y maximo, variacion de los cortes y pausas se toman exactamente de
la configuracion guardada por el dueño; el backend no los reemplaza en silencio
por los valores de fabrica. Una respuesta menor al umbral elegido sale en un solo
globo sin otra llamada.
No recibe historial, contexto del negocio ni tools; no interpreta la intencion
del cliente, no decide acciones y no puede agendar, cobrar, transferir ni
suprimir la respuesta. Esta excepcion usa OpenAI aunque el proveedor principal
del agente sea otro: solo se comparte la respuesta final visible y la llamada
usa `store=false`. El backend comprueba que no cambie ninguna letra, numero,
precio, fecha, hora, URL, telefono, correo o codigo, y solo acepta cortes en
espacios o saltos reales para no romper un token. Si falta la llave OpenAI,
excede ocho segundos, devuelve algo invalido o falla la mini-IA, se manda el
texto original completo en un solo globo. Un fallo al guardar la telemetria
nunca bloquea los globos ya validados. No hay reintentos de esa llamada
secundaria.

Antes del primer envio se guarda un plan durable por contacto, agente, canal,
mensaje origen y tipo de respuesta. Ese plan fija texto, orden, pausas e IDs de
cada globo; un retry reutiliza el primer plan y continua solo las partes
pendientes, sin volver a pedir cortes ni duplicar lo ya confirmado. Cada parte
pasa por `sending` y `sent` con compare-and-swap y lease. Si el proceso muere
despues de iniciar un envio pero antes de confirmar su resultado, el plan queda
`ambiguous` y no se reenvia a ciegas porque Meta no ofrece idempotencia real en
ese punto. Si entra un mensaje nuevo, el plan viejo queda `interrupted` y sus
partes pendientes no reviven. `parallelToolCalls=false` impide
mutaciones paralelas en una misma vuelta del modelo y las acciones conservan
idempotencia en servidor. Ademas, una medida preventiva toma prioridad antes de
cualquier tool mutable y cada mutacion vuelve a consultar la cuarentena justo
antes de tocar estado. Una mutacion live confirmada termina esa vuelta del
Runner; el modelo no puede encadenar otra tool despues del commit. Agendar, completar un objetivo o transferir reutiliza
directamente el resumen factual estructurado de la tool: no levanta otra
instancia de IA para releer el chat. El unico saneamiento textual final redacta
identificadores internos para que no lleguen al cliente; no decide intención ni
puede impedir que una tool se ejecute.

La base de Ristak sigue siendo la fuente canonica del hilo para todos los
proveedores. V2 carga el historial por paginas y construye un unico sobre
continuo medido por bytes, no por un numero arbitrario de mensajes: incluye todo
el hilo cuando cabe, nunca corta un mensaje y conserva siempre el ultimo turno
integro. Si el limite fisico del modelo deja mensajes anteriores fuera, expone a
esa misma instancia la tool de solo lectura `get_conversation_history`, ligada en
servidor al mismo contacto y canal. La tool pagina texto, rol, fecha y una
descripcion segura de adjuntos sin IDs, URLs, nombres de archivo ni payloads
internos. Para hilos largos permite leer la pagina anterior, saltar a una
posicion contada desde el inicio, abrir los mensajes mas antiguos o buscar una
frase literal unicamente dentro del tramo omitido. Los cursores avanzan por las
filas realmente devueltas, incluso cuando el presupuesto por bytes recorta una
pagina, por lo que no repiten ni brincan mensajes. Preview,
seguimientos y runtime vivo comparten el constructor; la telemetria registra
mensajes totales, incluidos, omitidos, bytes y paginas cargadas. No existe una IA
de resumen o compactacion escondida.

El prompt se arma en servidor con estrategia/capacitacion y personalidad como
las instrucciones editoriales del dueño, contexto real recuperado y una zona
blindada que sólo protege seguridad, permisos, identidad, configuracion y hechos
operativos. La estrategia es el cerebro de la conversacion: decide semanticamente
si primero pregunta, informa, consulta, agenda, cobra, retoma, cancela o entrega.
Activar una capacidad no crea una etapa, prioridad ni atajo obligatorio. El texto
editable no puede agregar tools, cambiar calendario/producto/monto/moneda ni
convertir un resultado pendiente o fallido en exito, pero fuera de esos limites
el backend no reemplaza su criterio con un embudo propio.

La proteccion preventiva tampoco usa regex ni detectores de palabras. El mismo
modelo principal puede decidir `apply_safety_measure` sólo con contexto claro,
confianza alta y severidad alta o critica. La tool crea un caso global por
contacto+canal, una cuarentena temporal reversible, auditoria y notificacion; no
borra el contacto ni bloquea cuentas del proveedor. Sólo un resultado durable
exitoso puede suprimir la respuesta de esa vuelta. Los inbounds recibidos durante
la cuarentena quedan completados sin respuesta para que no revivan al vencer, y
el job de sistema reintenta avisos fallidos con claim y lease. La medida es
reversible: una deteccion automatica nunca borra el contacto ni ejecuta un veto
permanente que dependa solamente del juicio del modelo.
El dueño puede dirigir el aviso a los administradores o a un usuario activo
concreto. La entrega visible comparte el mismo candado distribuido y vuelve a
leer la cuarentena inmediatamente antes de cada globo: una respuesta partida no
continúa después de activarse la medida. Reactivar o reanudar manualmente el
contacto resuelve todos sus casos activos con actor y motivo auditables.

El conocimiento base de la cuenta proviene de `ai_business_profile` y su
`source_context`; productos, precios, calendarios y slots se consultan en sus
servicios reales. El recuperador de conocimiento es determinista, no otra IA, y
no incluye campos con nombres de secrets, tokens o llaves.

### Estado, concurrencia y seguimiento

Un estado conversacional se identifica por `contact_id + agent_id + channel`.
WhatsApp, Instagram, Messenger, SMS, webchat, correo y comentarios no comparten
accidentalmente pausas, señales ni memoria. Cada inbound se reclama de forma
atomica con token y lease; una ejecucion vigente bloquea duplicados, mientras un
error o lease vencido permite reintentar el mismo mensaje. La recuperacion de
pendientes pagina todos los claims fallidos/vencidos, sin un tope global que
abandone conversaciones viejas.

El contrato de asignacion visible es mas estricto que el historial: solo
`active` y `paused` significan que el agente sigue asignado al chat. `human`,
`skipped`, `completed` y `discarded` conservan trazabilidad para metricas y
auditoria, pero el agente ya salio de la conversacion. Web, `/movil`, Android e
iOS deben excluir esos estados terminales de listas, contadores y controles que
afirman una asignacion actual, y nunca pintarles el robot en el avatar o header.
Las bandejas historicas `Omitidos` y `Meta cumplida` pueden conservarlos con su
estado textual, pero no deben presentarlos como si el bot siguiera ahi. Una
asignacion `paused` conserva el robot y agrega una marca de pausa para comunicar
que sigue ligada al agente aunque no este respondiendo. Si un estado terminal
conserva una senal pendiente para el humano, la interfaz puede mostrar la alerta
y permitir descartarla, pero esa alerta no cuenta como asignacion ni usa robot.

Una conversacion `completed` solo se reabre con un inbound nuevo cuando el mismo
agente sigue publicado y todavia cumple entrada, salida y alcance. Los handoffs,
pausas, omisiones y asignaciones manuales no se borran con heuristicas de edad.

Los seguimientos usan el mismo agente principal y el mismo transcript; no
inventan un mensaje nuevo del contacto ni llaman un analizador aparte. El modo
seguimiento es estrictamente de solo lectura: no expone agenda, cobro, enlaces,
handoff, guardado de datos ni medidas preventivas mutables. Estado, opt-out,
ventana del canal, mensajes nuevos y numero de intento se comprueban como hechos
externos antes de enviar. El primer intervalo comienza cuando termino de
entregarse la ultima respuesta visible del agente, no cuando entro el mensaje del
cliente. El segundo comienza cuando termino de enviarse el primer seguimiento;
por eso puede configurarse con una espera menor que el primero. El formulario
solo exige que la suma de ambas esperas no rebase 23 horas y el runtime vuelve a
calcular el reloj si aparece otra salida, para no mandar un recordatorio pegado a
un mensaje mas reciente.

### Generacion, preview y entrega

OpenAI, Claude, Gemini y DeepSeek pueden ejecutar el agente si su conexion esta
configurada; las rutas conversacionales no exigen OpenAI globalmente. La
prueba del editor llama la misma ruta nativa, con las mismas tools en
`dryRun`, el mismo prompt blindado y el mismo limite de historial. Devuelve el
manifiesto de capacidades y las acciones simuladas; no produce assessment,
estrategia ni una decision de silencio. `responseDelayMs` es cero
en preview; la previsualizacion y el chat publicado comparten la misma mini-IA
de globos cuando el switch esta activo. El chat publicado conserva su espera. Si
entran mensajes durante esa espera, mientras se calculan los cortes o entre
globos, el runtime recarga contexto, detiene partes obsoletas y vuelve a ejecutar
el turno mas reciente antes de enviar contenido viejo.

El tester usa por defecto un contacto virtual estable. `get_contact_profile` lo
reconoce como la identidad del hilo, sin inventar que falta una ficha, pedir otro
telefono ni marcarlo como cliente anterior. Con los switches de prueba apagados, todas las
tools conservan `dryRun=true`: el telefono muestra decisiones y respuestas, pero
no crea citas, pagos, asignaciones ni notificaciones.

Cada burbuja de usuario o asistente del tester conserva un ID de transcript
estable tanto en el editor como en el wizard. El backend lo valida y lo aisla
dentro del `previewScopeId`; para clientes anteriores que todavía no mandan IDs,
deriva uno determinista encadenando en orden rol, contenido y huellas de adjuntos.
Agregar otra vuelta al final no cambia los IDs de mensajes anteriores. Esa
identidad demuestra orden y visibilidad dentro de la conversación y es distinta
del `executionId`/`testMessageId`, que identifica e idempotentiza el request que
se está ejecutando. Nunca se vuelve a numerar el historial por posición ni se
usa el ID del request actual como si fuera el ID durable de todas las vueltas.

Cada capacidad guarda su propio **Modo test**. Citas sólo autoriza cita o entrega
humana; Pagos autoriza exclusivamente el mecanismo configurado: link sandbox si
es `payment_link`, o lectura real del adjunto sin crear dinero si es
`bank_transfer`. Activar una no amplia la otra ni hace que una cita exija
credenciales sandbox de pagos. Al
activarlo, el usuario
elige un contacto existente y el servidor vuelve a cargar la configuracion
persistida; nunca confia en calendario, usuario, producto, precio, pasarela,
monto o moneda enviados como override por el navegador. La decision del modelo
sigue ocurriendo primero en `dryRun`; sólo la accion estructurada exacta que tuvo
exito se convierte despues en un efecto real, aislado y marcado como prueba.

Los efectos se guardan en `conversational_agent_test_runs` y
`conversational_agent_test_effects`, con ledgers especializados para links
sandbox y asignaciones temporales. Quedan ligados a usuario, agente, contacto,
sesion y mensaje. Requieren lectura de Contactos, escritura de Contactos para
asignar, escritura de Citas para agendar y escritura de Pagos para cobrar. Otro
usuario no puede leer ni limpiar la corrida. Cada efecto usa hash, llave
idempotente, claim token y lease; reintentar el mismo mensaje no duplica la cita,
el link, la asignacion ni la notificacion. La corrida guarda tambien el hash de
la revision de capacidades. Si el switch aplicable se apaga o cualquier capacidad cambia
mientras el modelo responde, el servidor revoca la corrida y vuelve a comprobar
esa revision antes de cada mutacion; una respuesta vieja no puede crear efectos.
El request completo vive además en `conversational_agent_test_turns`, con una
identidad única por corrida y `testMessageId`. Antes de consultar a la IA toma un
claim con lease y fencing token; un heartbeat lo renueva sin retener una conexión
de PostgreSQL durante la llamada externa. La lease y su vencimiento usan el reloj
de la base para que dos instancias no discrepen por clock skew. Un retry concurrente consulta el ledger,
espera al dueño vigente y después recibe el mismo `response_json`, sin ejecutar
otro agent run ni volver a tocar tools. Si el proceso muere, la lease vence y el
siguiente dueño recupera el checkpoint bajo un token nuevo. El
hash durable cubre transcript, configuración efectiva, contacto y revisión de
capacidades; un segundo hash cubre el request original del cliente y permite
reproducir una respuesta ya completada aunque después se apague Modo test, sin
saltarse ownership ni aceptar otro payload. La identidad queda reservada como
`pending` antes de renovar `effects_json` o el TTL de la corrida: reutilizar el ID
con otro contenido se rechaza sin mutar autoridad. El resultado crudo
del preview se guarda antes de materializar cualquier efecto. Si el proceso cae
después, el siguiente dueño retoma esas mismas acciones y los ledgers de efectos
recuperan la misma entidad; no se vuelve a pedir una decisión al modelo. La
respuesta final también se serializa antes de entregar el primer HTTP, por lo que
un corte de red posterior reproduce exactamente la confirmación ya cerrada.
Las instalaciones existentes reciben este contrato mediante las migraciones
versionadas `052a_conversational_agent_test_effect_error_code.sql`,
`052b_conversational_agent_test_effect_error_retryable.sql` y
`052c_conversational_agent_test_turns.sql`; no depende de que el bootstrap legacy
vuelva a correr. Si `response_json` quedó ilegible pero el preview durable existe,
el fast-path cede al executor para repararlo por CAS sin consultar otra vez a la IA.
Cuando una cita de prueba se materializa, la oferta y el progreso parcial se
cierran juntos como `materialized`, sin dejar un estado falso de “falta hora”.
La oferta aceptada y el `effectId` de la cita canónica son la autoridad final: si
el progreso quedó viejo o con otro calendario, el mismo commit lo reconcilia al
horario realmente creado en vez de reintentar para siempre el mismo mismatch.
Aunque el preview redacte opciones contradictorias, el controller canonicaliza
el éxito desde el efecto registrado antes de guardar o mostrar la respuesta.
El cierre local de `effect + offer + progress` hace commit antes de enviar la
notificación interna/push; un rollback nunca anuncia una cita que el ledger no
cerró. Los fallos guardan si son reintentables: `processing`, `pending` y
`failed/retryable` no pueden convertirse en `response_json` terminal. El mismo
preview se rematerializa con backoff acotado y el `clientRequestId` de la cita
recupera la entidad canónica si el calendario ya la había creado. Un conflicto de
slot sólo es terminal después de confirmar que el día quedó restaurado; si esa
reparación falla, se reintenta en vez de congelar otra vez la pregunta de hora.
Frontend usa un mutex síncrono compartido entre envío manual y continuación de
pago. Ante red/5xx reconsulta una vez la misma sesión y `testMessageId`; no limpia
una corrida cuyo resultado externo todavía sea ambiguo. Mientras ese dueño sigue
vivo tampoco permite cambiar contacto ni reiniciar. Si expira un adjunto durante
el HTTP, invalida el render pero conserva el ownership hasta que termine; una
respuesta vieja no puede entrar después en una conversación reiniciada.
Un advisory lock de sesion de PostgreSQL, sostenido en una conexion dedicada,
serializa por agente los cambios de capacidades contra citas, cobros o
asignaciones externas. No usa una fila con TTL que pueda caducar a mitad de una
llamada al proveedor: el motor conserva el candado hasta que termina el callback
y lo libera tambien si muere la conexion. SQLite usa `BEGIN IMMEDIATE` sobre un
archivo auxiliar por agente durante todo el callback como fallback local
multiproceso, sin bloquear pruebas de agentes distintos. Si un efecto ya está
terminando, el guardado responde ocupado y el frontend lo reintenta en vez de
apagar Modo test a mitad del proveedor; si el guardado gana primero, el efecto
ve la revision revocada antes de mutar.

- Agenda: vuelve a comprobar el slot dentro del candado real, crea una cita con
  `is_test=1`, participantes y prefijo visible de prueba, ejecuta sincronizacion
  de calendario y push reales marcados como test, y suprime Meta/CAPI productivo.
  Si dos sesiones preview del mismo contacto alcanzaron a ofrecer el mismo slot,
  la primera cita materializada gana. La segunda confirmacion trata esa cita no
  vinculada a su propia sesion como conflicto definitivo de disponibilidad: no la
  adopta, no la declara exitosa ni manda el caso a handoff; cierra la oferta
  vencida, conserva el dia y obliga a consultar otra hora antes de continuar.
  Aunque ambas respuestas se hayan redactado antes de materializar, el controller
  reconcilia el texto contra el efecto real bajo candado: sólo el ganador puede
  devolver confirmacion y cualquier efecto no terminal reemplaza la promesa provisional.
  Un contender que agota la espera del candado se reporta como `processing`, sin
  afirmar que la cita existe o que no existe. Si el proceso dueño cayó, el replay
  retoma la lease sólo después de adquirir ese candado; si la cita ya alcanzó a
  insertarse, exige la misma identidad durable run/effect/contacto/calendario/slot
  y vuelve a pasar por el request idempotente. Mientras la lease interna del
  controller siga fresca, el replay sólo reporta `processing`. Si esa ejecución
  cayó antes de cerrar providers/checkpoints, no adopta la fila local como éxito:
  la marca interrumpida y deja que el cleanup retire la cita temporal sin duplicarla.
  En agenda humana, cita y asignacion se reconcilian por separado para informar
  resultados parciales verdaderos.
  El despachador de automatizaciones de prueba manda webhooks reales con headers
  `X-Ristak-Test-*`, payload `testMode/ristakTest` e idempotencia; las
  notificaciones y recordatorios llegan como copia interna real al usuario que
  inició la prueba. Mensajes externos al contacto, tags, campos, asignaciones e
  inscripciones productivas se simulan y auditan porque no se pueden deshacer de
  forma confiable. `conversational_appointment_test_automation_receipts` conserva
  cada resultado y nunca reenvía un webhook ambiguo. A
  los cinco minutos elimina Google/HighLevel cuando apliquen, recordatorios,
  confirmaciones, participantes y fila local usando `appointment_id +
  test_effect_id`; nunca acepta borrar una cita real. La API normal rechaza las
  marcas `is_test/test_*`: sólo el contexto interno del tester puede llegar al
  flujo y aun así debe coincidir con run, effect, claim, contacto, calendario,
  participantes y payload durables. Los IDs creados en Google o HighLevel se
  guardan inmediatamente en `conversational_appointment_test_provider_receipts`
  antes del upsert local, con fallback y compensacion remota; la limpieza puede
  recuperar esos recibos aunque se haya perdido la fila local. Al retirar un
  espejo de Google, el cleanup exige receipt, effect, run e ID de evento
  determinista coincidentes. `entity_id` también debe coincidir cuando ya existe,
  pero puede seguir nulo en la ventana crash-after-provider/before-complete-effect;
  el receipt durable conserva autoridad suficiente para reparar esa caída aunque
  también se haya perdido la fila local. Usa el calendario remoto original
  guardado en el comando o, para recibos compatibles anteriores, el provider persistido en la
  propia cita; nunca cae al owner actual ni al calendario global. Así puede
  retirar el evento aunque la agenda se haya religado despues, sin convertir el
  receipt en permiso para borrar IDs arbitrarios. El DELETE es exclusivamente
  remoto: cita y ledger se cierran juntos en la transaccion propia de la
  limpieza. En HighLevel,
  la prueba sólo reutiliza un contacto ya ligado o una coincidencia exacta y
  única de solo lectura; nunca crea ni vincula una ficha remota para poder probar.
  Cuando `bookingOwner=human`, el efecto real de prueba valida el horario y
  notifica al equipo sin crear ni prometer una cita. Si hay `handoffUserId`,
  tambien prueba la asignacion temporal y restaura al responsable anterior; si
  esta vacio, la corrida conserva `scheduleAppointment + notifyOwner` y nunca
  exige ni fabrica `assignUser`.
- Cobro por link: vuelve a cruzar capacidad, catalogo o monto directo y
  `account_currency`, fuerza credenciales `test` de Stripe, Conekta, Mercado
  Pago, CLIP o Rebill y falla cerrado si no existen. Nunca cae a live. El link
  se muestra en el telefono, el webhook actualiza el efecto a `paid_test` y el
  frontend lo sondea para reanudar al mismo agente con contexto factual, sin
  fabricar otro mensaje del cliente. A los cinco minutos expira/invalida el
  checkout y elimina o sanea únicamente la fila financiera marcada como test.
  HighLevel legacy no puede forzar sandbox por conversacion: el control queda
  visible si una configuracion anterior lo tenia activo para que el dueño pueda
  apagarlo, pero el tester no abre una corrida ni sondea webhooks para ese caso.
  `payments.conversational_test_effect_id` liga el pago directamente al efecto y
  permite recuperarlo si el proceso cae entre crear el proveedor y cerrar el
  ledger. Mercado Pago no marca la limpieza como exitosa si no pudo confirmar la
  expiracion: bloquea el checkout local, conserva los IDs y reintenta.
  El webhook sandbox queda ligado al contacto ya autorizado por la corrida y no
  crea, busca ni enriquece otra ficha de contacto.
- Transferencia/Deposito: no intenta crear un checkout ni consultar credenciales
  de pasarela. En el tester lee la foto o PDF adjunto con el mismo analizador del
  runtime, cruza monto y moneda contra el cobro guardado y registra sólo un efecto
  aislado de `pending_review`: no inserta una transaccion, no crea link, no marca
  fondos confirmados y su limpieza no intenta borrar un checkout inexistente.
- Asignacion: cambia de verdad al usuario configurado, manda notificacion/push
  `[PRUEBA]`, conserva al responsable anterior y lo restaura a los cinco minutos.
  La fila del contacto lleva una marca CAS; una reasignacion humana o handoff live
  la elimina, por lo que la limpieza nunca deshace una decision posterior.

Los jobs de sistema barren efectos vencidos y reintentan limpiezas o avisos. Si
el usuario reinicia manualmente la practica puede pedir limpieza inmediata; si
cierra la pantalla, la limpieza durable de cinco minutos sigue siendo la fuente
de verdad y no depende de que el navegador permanezca abierto.

La observabilidad de agenda registra `appointment_transition` para cambios de
estado y `loop_question_repeated` cuando la salida vuelve a pedir la misma
categoría de dato; `reply_sent` conserva sólo un resumen técnico en lista blanca.
Estos eventos pueden incluir IDs técnicos, canal, modo live/test, estado anterior
y nuevo, tool, resultado/código, instantes UTC y conteo de reintentos, pero nunca
serializan el texto visible, `ctx.actions`, nombres, teléfonos, correos, notas,
participantes ni citas textuales del cliente. El texto de salida sólo se clasifica
para reconocer qué pregunta intenta mostrar; nunca interpreta con regex la
intención del usuario. Antes de renderizar o enviar, el estado durable decide si
esa pregunta es imposible: una fecha ya conservada obliga a pedir únicamente la
hora, una revalidación técnica conserva el día y una oferta activa vuelve a
mostrar su confirmación canónica. En esos casos el servidor sustituye el borrador
antes de entregarlo y registra `loop_question_repeated` con `outcome=prevented`.
Las respuestas canónicas de una tool tienen prioridad para que texto, oferta y
efecto no se desalineen.

### Herramientas y verdad operativa

La lista de tools se construye sólo con capacidades `enabled` que ademas estan
`ready` en la configuracion efectiva del servidor. Una capacidad apagada,
incompleta o ligada a un recurso invalido no se puede recuperar escribiendo su
nombre en el prompt y ni siquiera se expone como tool al modelo. Las tools de
lectura consultan negocio, contacto y catalogo real. Cada tool
valida sus precondiciones y sella en `ctx.actions[].outcome` si el resultado fue
`ok`, `error` o `simulated`. El estado final usa ese outcome y la base de datos,
nunca un booleano escrito por el modelo.

- Citas: v2 fija el calendario en servidor, consulta slots reales y vuelve a
  comprobar que el horario exista y siga libre. La llamada nativa reemplaza el
  detector textual de confirmacion. Voluntad y seleccion son contratos
  distintos: decir que quiere agendar, que quiere ir o que ya acepto atenderse
  nunca autoriza al modelo a escoger el primer hueco. Una consulta amplia como
  "que dias tienes" usa `get_free_slots` y despues
  `offer_appointment_options`. El servidor agrupa opciones reales en hasta tres
  dias, escribe cada encabezado entre asteriscos para que el canal lo muestre en
  negritas y compacta slots consecutivos como ventanas legibles indicando su
  cadencia (`cada hora`, `cada 30 min`, etc.) para no inventar inicios intermedios. La lista es
  informativa: no crea una oferta durable, no aparta ningun horario y un `ok`
  posterior no identifica cual opcion eligio. Dia y hora pueden llegar en
  mensajes distintos. Cuando la persona elige solamente un dia, el agente
  reconsulta esa fecha exacta y llama `offer_appointment_options` con
  `selectionMode=collecting_time`; el servidor muestra solo los horarios de ese
  dia y pregunta unicamente la hora faltante.
  `weekdays` usa numeracion ISO de lunes 1 a domingo 7,
  `earliestLocalTime`/`latestLocalTime` acotan horas locales y
  `relativeToPreviousOffer` permite negociar "mas tarde" o "mas temprano" sin
  repetir el slot individual rechazado. Para sostener esa negociacion entre
  mensajes, la lista guarda durante 24 horas una referencia interna minima y
  maxima con instante exacto, fecha, hora y zona originales, ademas de identidad
  de agente, contacto, canal, calendario, proposito y sesion de prueba; no guarda
  una oferta aceptable ni convierte un `ok` en seleccion.

  La seleccion parcial vive en `appointment_selection_progress` dentro de
  `conversational_agent_events`. Conserva agente, contacto, canal, calendario,
  proposito, cita de origen cuando es reagenda, fecha local cuando ya existe,
  zona del negocio,
  rangos que realmente se mostraron, estado y vencimiento. Se aisla por agente,
  contacto, canal y sesion de preview; cada hilo recupera solamente su propio
  estado. Se invalida si cambia el calendario o la zona, vence el TTL, el dia ya
  paso o deja de ser valida la cita o el permiso de una reagenda. En la siguiente
  vuelta el Runner rehidrata el alcance como hecho estructurado. En estado
  `collecting_time`, si llega solo una hora, la combina con el dia guardado,
  reconsulta exactamente ese punto y despues crea la oferta individual. Con
  fecha activa, `get_free_slots` exige
  `progressDateAction=keep_selected_date` para una hora suelta; solo acepta
  `replace_selected_date` con un rango de un unico dia cuando la persona cambio
  explicitamente de fecha. Primero comprueba la disponibilidad base del nuevo
  dia: si el dia tiene slots pero la hora exacta solicitada no, guarda el dia
  nuevo como `collecting_time`. Si la consulta técnica falla al cambiar o
  revalidar el día, conserva esa fecha, limpia cualquier hora/rango no verificado,
  marca `availabilityVerificationRequired=true` y deja `availability` como el
  dato faltante; la siguiente vuelta debe reconsultar ese mismo día y no volver a
  pedir la fecha. Sólo una consulta real completada que demuestra que el día no
  tiene ningún slot limpia la fecha y guarda `collecting_date` con
  `missingFields=date`. Ese último estado conserva calendario, propósito y la
  cita objetivo de una reagenda, pero no conserva ninguna fecha: entonces sí pide
  un día nuevo y una hora suelta no puede volver a pegarse al día viejo. Una
  revalidación exitosa elimina la marca técnica y continúa pidiendo únicamente la
  hora que falta. El mismo registro guarda `lastError.code` y su instante cuando
  existe un fallo técnico; nunca persiste el texto libre del proveedor y limpia
  ese error al completar una revalidación real.
  `request_other_options` con alcance `different_date` o `open` entra por esta
  misma transicion: no borra el progreso ni pierde el `appointmentId` de una
  reagenda. Durante un despliegue gradual, una instancia anterior todavia puede
  alcanzar a crear una oferta sin cerrar este progreso. El lector nuevo reconcilia
  ambas filas dentro del mismo candado: la oferta solo gana si es posterior y
  conserva exactamente identidad, canal, calendario, zona, fecha, texto canonico,
  proposito y forma de alta o reagenda; entonces liga el responsable terminal y
  marca el progreso como reemplazado. Una oferta distinta, incompleta o mas vieja
  se cierra por CAS y deja ganar al progreso. Formas desconocidas, estados no
  reconocidos y versiones futuras del ledger fallan cerrado incluso si aparentan
  estar terminados o vencidos, para no degradar una operacion futura a una cita
  nueva ni agendar una hora distinta de la mostrada.
  Tambien permite explorar varios dias sin convertir una reagenda en cita nueva.
  La transicion se guarda por CAS y la transicion final a oferta vuelve a
  comprobar la fecha, por lo que el modelo no puede consultar o confirmar
  silenciosamente otro dia. Si la persona si cambia el dia, reemplaza la fecha sin
  arrastrar una hora anterior; una pregunta intermedia no borra la seleccion. En una reagenda,
  `purpose` y `appointmentId`
  se derivan del estado durable en servidor aunque el modelo mande `null`; un ID
  distinto falla cerrado para no convertir una reagenda en cita nueva ni al
  reves. Antes de rehidratar una reagenda, el backend vuelve a comprobar que la
  cita siga siendo futura, activa, del contacto y del calendario, y que la agenda
  todavia permita reagendar; si cualquiera de esos hechos cambia, cierra el
  progreso por CAS en vez de preguntar la misma fecha indefinidamente. Un fallo
  transitorio de base no invalida la seleccion: falla cerrado y permite que la
  siguiente vuelta reintente la lectura. Los rangos guardados permiten razonar sobre
  referencias como "el ultimo", "ese dia" o "el de las cuatro", pero nunca
  prueban disponibilidad vigente. Reiniciar o abandonar cierra el estado parcial
  con `resolve_active_appointment_selection`; sus escrituras usan CAS para que
  dos ejecuciones no se pisen y el estado expira a las 24 horas. Una fecha que ya
  quedo en el pasado, un TTL vencido o un cambio de calendario o zona se marca
  `superseded` por CAS antes de empezar de nuevo: no bloquea el chat y tampoco
  revive si vuelve la configuracion anterior. Versiones desconocidas del esquema
  no se sobrescriben ni se degradan durante un despliegue gradual. La referencia de la lista y el
  progreso se guardan en una sola transaccion; el salto de progreso a oferta
  individual tambien crea la oferta y cierra la fecha parcial atomicamente. Si
  una mitad falla, no queda una lista fantasma ni se pierde el dia elegido. El
  mismo candado por contacto obliga a que una oferta individual y una lista
  concurrentes tengan una sola autoridad: el turno viejo revierte su escritura,
  recarga el estado ganador y termina esa vuelta con una respuesta canonica, sin
  reintentar sobre el mismo fingerprint ni abrir otro loop. El
  preview usa una fila centinela por sesion para conservar esa misma exclusion
  mutua en PostgreSQL incluso cuando todavia no existe una oferta o un progreso
  que pueda bloquearse. El
  reset y el job de limpieza del tester eliminan tambien el progreso de preview.
  "Mas tarde" y "mas
  temprano" comparan la hora local que vio la persona: la misma hora de otro dia
  no cuenta como posterior o anterior. El instante sólo desempata dos horas
  repetidas del mismo dia y la misma zona durante un cambio DST. Si despues se
  rechaza una oferta individual, esa referencia mas reciente manda sobre la lista
  anterior. Una oferta individual no vence por tiempo: las nuevas guardan
  `expiresAt=null` y el loader ignora el vencimiento de ofertas legacy. Esto no
  reserva el espacio. Al recibir la confirmación, el backend vuelve a comprobar
  el instante ofrecido contra el calendario vigente y sólo entonces crea o
  reagenda. Si el horario ya pasó, cambió de alcance o dejó de estar disponible,
  la oferta se cierra por CAS. Cuando el conflicto es otra cita y
  `allow_overlaps` está apagado, conserva el día, consulta `get_free_slots` y
  termina con `offer_appointment_options` para mostrar alternativas reales sin
  pedir que la persona adivine otra hora. Una oferta rechazada sí conserva
  durante 24 horas su instante como referencia semántica para interpretar
  "más tarde" o "más temprano" sin caer de nuevo en una lista anterior.

  Incluso si el cliente propone dia y hora exactos, el agente debe consultar
  `get_free_slots` y llamar `offer_appointment_slot` con un solo `startTime`.
  Esta tool vuelve a validar el
  slot, guarda `appointment_slot_offer_created` en vivo o su sobre aislado de
  preview y construye el unico texto visible de la oferta. El modelo sólo
  clasifica el enlace conversacional con el enum cerrado `selectionContext`:
  `selected_from_options` cuando la persona eligió de una lista,
  `exact_preference` cuando pidió directamente fecha y hora, `replacement`
  cuando reemplazó otra opción o `neutral` si el hilo no permite distinguirlo.
  El backend usa ese matiz para responder de forma congruente, pero sigue siendo
  el único dueño de la fecha, la hora, el anticipo, el responsable y la pregunta
  de confirmación. El modelo no escribe, reformula ni agrega horarios; live y preview
  terminan la vuelta y entregan esa oferta en un solo globo, sin pasarla por el
  divisor de mensajes. El contrato de copy v2 persiste `offerCopyVersion`, el
  contexto normalizado, `depositRequiredAtOffer` y el `offerText` exacto que se
  entregó. Ese mismo string alimenta la burbuja, el ledger, la evidencia y los
  reintentos; si la misma ejecución se repite con otro matiz, gana el primer texto
  durable. Si el requisito de anticipo cambia después de mostrar la oferta, ésta
  se cierra con `appointment_deposit_requirement_changed` y debe consultarse otra
  vez: un “sí” nunca puede cobrar ni agendar contradiciendo el siguiente paso que
  la persona aceptó. En reagenda el snapshot de anticipo siempre debe ser `false`.
  Ofertas v1 sin versión conservan y validan la frase anterior después del cutover;
  esta compatibilidad supone un cambio atómico de tráfico o un único writer activo,
  no lectores viejos atendiendo ofertas v2. Una versión desconocida, un enum
  inválido o un texto adulterado fallan cerrado. Una oferta activa queda en fase durable
  `awaiting_decision` y no puede ser sobrescrita por otra ejecución. Antes de
  cada vuelta el backend hidrata ese hecho desde
  `conversational_agent_events`. La misma IA puede responder una duda, consultar
  precios o usar otra capacidad y luego regresar a esa oferta sin repetirla, pero
  no puede publicar otra lista u otro horario individual hasta resolver la oferta
  vigente. Cuando existe esa oferta, la primera acción del modelo se fuerza
  exactamente a `resolve_active_appointment_offer`: debe adjudicar `accept`,
  `request_other_options`, `decline`, `handoff` cuando aplique o `preserve` si la
  persona preguntó otra cosa o su intención respecto al horario es ambigua.
  `preserve` no cambia ni cierra el evento y, después de ejecutarse, el SDK vuelve
  `toolChoice` a automático para responder la duda o usar otra capacidad en ese
  mismo turno. La postcondición del Runner exige que la adjudicación corresponda
  al ID de la oferta inicial. Si el modelo intenta contestar sin resolverla, o
  escribe una confirmación sin que la terminal estructurada haya terminado con
  éxito, el servidor reemplaza esa prosa por una respuesta segura y no afirma que
  exista una cita. La confirmación positiva visible siempre se reconstruye desde
  la acción real, nunca desde texto libre del modelo. Para `decline`, `handoff` y
  `request_other_options` también se ignora la prosa libre y se usa la respuesta
  estructurada del resolver. Sólo `preserve` puede conservar una respuesta lateral
  del modelo: antes de mostrarla, una segunda llamada acotada al mismo proveedor y
  modelo, forzada a una única tool de clasificación, comprueba que no afirme un
  resultado de agenda ni vuelva a pedir una decisión sobre fecha u hora. Sólo
  `safe_unrelated` pasa sin cambios; duda, timeout, tool ausente o cualquier otra
  clasificación usan una respuesta determinista que deja claro que la oferta sigue
  pendiente y que no se creó ni cambió una cita.
  Cuando la creación sí termina, la respuesta positiva incluye el `localLabel`
  canónico de la oferta —fecha y hora exactas en la zona del negocio— para que el
  cliente no reciba una confirmación ambigua ni dependa de un recordatorio
  posterior para saber qué horario quedó reservado.
  La adjudicación también se serializa dentro del turno antes del primer `await`:
  dos invocaciones paralelas nunca pueden alcanzar dos terminales ni intercambiar
  sus resultados. Si `accept` se detiene en un preflight recuperable por datos
  faltantes, conserva esa salida como respuesta canónica y sólo permite reentrar
  cuando cambió el fingerprint de argumentos o de la ficha efectiva; repetir la
  misma llamada queda bloqueado. La reentrada está limitada a tres intentos y no
  aplica a decisiones ya consumidas ni a mutaciones terminales.
  Mientras esa oferta individual esta activa, el modelo no recibe tambien
  `book_appointment`, `reschedule_appointment` ni `request_human_booking`: la
  unica puerta de decision es `resolve_active_appointment_offer`. Una aceptacion
  natural como "si", "va" o "confirmo" entra como `accept`; el resolver recupera
  la oferta exacta y ejecuta internamente la terminal correcta segun proposito y
  `bookingOwner`. Esto evita que la confirmacion caiga en una tool incompatible,
  vuelva a pedir fecha u hora o deje la cita sin crear. Pedir otro horario declara
  si conserva el mismo dia, cambia de fecha o deja la busqueda abierta; solo el
  primer caso restaura la fecha parcial y ninguno reutiliza la hora rechazada.
  Cada oferta nueva queda ligada tambien al calendario, la zona del negocio y el
  responsable terminal vigentes al mostrarla. El backend revalida esos tres
  hechos al hidratarla, justo antes de resolverla y otra vez dentro de la terminal
  antes de sellar o materializar la seleccion. Esa ultima comprobacion vuelve a
  leer la configuracion durable del agente, sin dejar que el snapshot viejo del
  turno la tape, exige que el agente siga existiendo y habilitado y compara
  calendario, `account_timezone`, `bookingOwner` y tool terminal contra la
  oferta. En el borde de commit usa un fingerprint semantico de las reglas que
  cambian disponibilidad —duracion, intervalo, buffers, horario abierto, cupos,
  ventana de reservacion y permisos— y repite la comprobacion dentro de la misma
  transaccion que crea, reagenda o entrega la solicitud humana. Primero toma el
  candado del calendario y despues los locks de autoridad para mantener un orden
  unico en PostgreSQL. `app_config.account_timezone` conserva una fila sentinel
  con valor `NULL` cuando no hay override: sigue usando HighLevel/default, pero
  permite bloquear tambien el primer cambio concurrente de zona sin serializar
  citas distintas entre si. Si la capacidad se
  apaga o cambia calendario, zona o `bookingOwner`, marca la oferta `superseded`
  por CAS. Asi un `si` posterior no agenda un UTC cuyo significado local cambio;
  la cierra sin esperar el TTL y no la revive aunque vuelva la configuracion.
  Persistir la oferta
  no basta para volverla autoridad visible: si el fence de entrega demuestra que
  salieron cero partes por un mensaje nuevo, una medida preventiva, un estado
  externo o un fallo durable previo al envio, el Runner cierra exactamente la
  oferta creada por esa ejecucion y restaura el dia sin marcar la hora como
  rechazada. Antes de un cierre previo al envio comprueba el plan durable de
  entrega: si ya existe o no puede leerse, conserva la oferta porque otro intento
  pudo haberla enviado o todavia puede reintentar exactamente ese mismo texto. Si
  el primer intento al proveedor falla con cero partes, el plan queda `pending` y
  la oferta tambien se conserva para que el retry no envie un horario que ya no
  pueda aceptarse. Una entrega `ambiguous` o con alguna parte enviada tampoco se
  toca para no duplicar mensajes. Como defensa adicional, una confirmación se
  liga a la cadena exacta mensaje origen de la oferta → burbuja canónica del
  asistente → mensaje actual de confirmación. El evento conserva el ID estable y
  la huella textual del mensaje origen; el resolver exige después la burbuja con
  el texto exacto de esa oferta, su propio ID visible y el orden correcto antes
  del `si`. Una oferta vieja con texto idéntico no sirve como evidencia para una
  oferta nueva que nunca salió.

  En live, si el límite físico de 64 KB dejó esa burbuja fuera del transcript, el
  resolver puede recuperar únicamente la evidencia factual del ledger durable de
  entrega. Para aceptarla exige el mismo contacto, agente, canal, mensaje origen
  y prefijo de proveedor, plan `completed`, exactamente una parte `sent`, ID
  externo verificable y coincidencia exacta de texto y hash con la oferta. Un
  ledger pendiente, ambiguo, corrupto, con identidad distinta o con más/menos
  partes falla cerrado. Este respaldo no aplica en preview ni en seguimientos y
  no reemplaza la revalidación del calendario ni la decisión semántica del
  resolver. Si ni transcript ni ledger prueban visibilidad, no agenda, cierra la
  oferta invisible y vuelve a pedir solamente la hora en vez de dejarla en loop.
  En preview, donde no existe ledger de entrega, el backend conserva por separado
  el transcript normalizado completo sólo como evidencia de agenda, aunque el
  contexto que se envía al modelo se recorte a 64 KB. Esa evidencia nunca se
  agrega al prompt ni se reutiliza en live: únicamente permite demostrar que la
  burbuja exacta fue visible en historiales largos del tester. Una duda o respuesta
  ambigua se adjudica como `preserve` y deja el evento byte por byte idéntico. No
  existe detector de `ok`, listas de frases, regex ni etapa que sustituya el
  trabajo semántico del modelo. Pedir otras opciones cambia la
  oferta anterior a `superseded` y devuelve el control al mismo Runner para que
  pueda reconsultar con las restricciones nuevas y mostrar una lista o una
  oferta exacta en esa vuelta; rechazarla la cambia a
  `declined`; entregarla a una persona la reclama primero por CAS y termina en
  `handed_off`, por lo que nunca puede ganar también una aceptación concurrente.
  El horario reemplazado se conserva hasta 24 horas como instante canonico y las
  consultas siguientes lo excluyen aunque vuelva con otro offset equivalente.
  La reconsulta es obligatoria antes de mostrar el reemplazo. En el retroceso de
  horario de verano, dos horas locales visualmente iguales siguen siendo dos
  instantes distintos y la respuesta agrega su offset UTC para que la persona
  pueda distinguirlos.
  Además, el guard de persistencia rechaza por CAS cualquier intento accidental
  de pisar una oferta activa y conserva byte por byte la evidencia original.
  Si la lectura durable falla, aparecen varias ofertas activas o una entrega
  queda a medio resolver tras un crash, el runtime falla cerrado y no vuelve a
  exponer agenda o cobro a ciegas.
  `book_appointment` y `request_human_booking` ya no le piden al modelo volver a
  copiar `startTime`, `selectionEvidence`, el mensaje del cliente ni la etiqueta
  del horario. La llamada nativa expresa la decision semantica del modelo; el
  servidor recupera `startTime` desde la unica oferta vigente que guardo el
  propio servidor y construye la evidencia con el mensaje completo más reciente
  del cliente, el ID/huella del mensaje estable que originó la oferta y la burbuja
  canónica exacta que quedó entre ambos. En preview, el `executionId` conserva la
  idempotencia del request y el ID del transcript conserva el orden visible; no
  se intercambian esos papeles. Puede haber una aclaración intermedia después de
  esa oferta sin perderla. Después
  sólo comprueba identidad, orden y coincidencia literal contra el hilo; no usa
  regex ni reglas de palabras para adivinar intención. Una oferta ausente,
  vencida, tomada de otro turno, ambigua, ligada a otro slot o perteneciente a
  otra sesion de prueba falla antes de producir `ctx.actions`. El preview
  conserva una sola oferta interna por usuario, agente y `testSessionId` bajo
  `appointment_slot_preview_offer_created`; nunca consulta ni reemplaza ofertas
  live, no aparece en la bitacora visible y el barrido por TTL o la limpieza de
  la corrida la elimina. El tester del wizard genera una identidad de borrador,
  sesion y mensaje estables aunque el agente todavía no se haya guardado; eso
  permite probar el flujo de dos turnos como mock sin habilitar efectos reales.
  Así Modo test apagado y encendido recuperan el mismo UTC entre requests sin
  confiar en texto o estado del navegador. Modo test vuelve a exigir esa marca
  verificada y toma un claim CAS de la misma oferta antes de convertir una
  simulacion en cita temporal real; si otra petición cambió el slot, no crea nada
  ni pisa la oferta nueva. En vivo,
  la seleccion sólo se sella despues de volver a comprobar que el horario existe
  y sigue libre, mediante el evento durable
  `appointment_slot_selection_verified`, ligado a agente, contacto, calendario,
  `startTime`, ejecucion y los IDs de la oferta y confirmacion. Al sellar la
  seleccion, la oferta queda `accepted`; si la configuración exige anticipo por
  link, esa misma resolución prepara el enlace automáticamente y no pide un
  segundo “sí” artificial. Crear el link no confirma ni cobra el pago: la cita
  continúa pendiente hasta recibir el webhook real. Un retry exacto puede
  reproducir la selección, pero nunca revivirla después de que otra selección la
  sustituyó.
  `get_free_slots` entrega el instante UTC y, por separado, fecha, hora y etiqueta
  visibles ya calculadas con la zona horaria del negocio. Una exploracion entrega
  esa coleccion a `offer_appointment_options`; una eleccion exacta copia un solo
  UTC sin cambios a `offer_appointment_slot`. Las tools terminales recuperan ese
  instante del evento de oferta; el modelo no convierte UTC ni adivina el
  horario que debe decirle a la persona. Después de un anticipo confirmado,
  `book_appointment` recupera el mismo UTC de la cadena durable reconciliacion →
  fuente de cobro → seleccion → oferta y vuelve a validar disponibilidad; no le
  pide al modelo reconstruirlo ni consultar otro horario. Antes de abrir el cobro,
  la primera llamada terminal guarda juntos el borrador canonico de titulo, notas,
  titular e invitados y el contrato terminal `bookingOwner` + `terminalToolName`.
  La oferta preview o seleccion live, el intento de anticipo, el request de
  pasarela, el evento fuente y la reconciliacion conservan esa misma pareja. Si la
  configuracion vigente sigue coincidiendo, el primer paso de la reanudacion fija
  `toolChoice` exactamente en `book_appointment` o `request_human_booking`; no
  analiza otra vez el texto del cliente para elegir terminal. Si el dueño cambia
  IA ↔ humano mientras el pago esta pendiente, o falta el binding en una fuente
  antigua, no ejecuta ninguna de las dos terminales: conserva el pago confirmado,
  deja la conversacion en estado humano con señal durable de revision y manda la
  notificacion prioritaria sin reintentar el webhook indefinidamente.
  El borrador vive una sola vez dentro de la oferta preview aceptada o de la
  seleccion live; el intento y el evento fuente del cobro arrastran su hash. Al
  reanudar, ese borrador manda sobre cualquier argumento nuevo del modelo. Cambiar
  a Paty por el contacto, perder un invitado o alterar draft, hash o terminal en
  cualquier eslabon falla cerrado antes de reservar o consumir el anticipo. El SDK
  puede volver a `auto` despues de una tool fallida para explicar el problema u
  ofrecer una alternativa real; una terminal exitosa corta la vuelta, y ninguna
  continuacion puede volver a cobrar ni religar el pago a otro horario. La reserva
  IA compara otra vez calendario, UTC, huella del borrador, responsable y tool
  terminal contra la reconciliacion pagada. La reconciliacion entrega a la tool un
  claim con lease renovable; el Runner mantiene heartbeat mientras el modelo y la
  entrega estan trabajando y comprueba el mismo claim justo antes de responder.
  La reserva del anticipo tiene un segundo fencing token. El controller vuelve a
  validar ambos candados y el estado `active` sin señal dentro de la transaccion
  que crea la cita; el INSERT de la cita y el consumo del anticipo confirman o se
  revierten juntos. Un claim vencido no puede crear, consumir, liberar ni contestar
  usando la lease de su reemplazo. Si una persona pausa o toma el chat antes del
  commit, no se crea la cita; si la cita confirma primero, cualquier takeover
  posterior conserva la cita real pero nunca es sobrescrito por el cierre del bot.
  Aunque una reanudacion falle y después exista otra oferta, ese anticipo no puede
  pagar a otra persona ni otra cita.
  En Modo test, una oferta `accepted` es inmutable: intentar ofrecerla otra vez no
  cambia su JSON, huella, ejecucion de aceptacion ni UTC. La tool terminal exitosa
  termina esa vuelta del Runner y la respuesta visible sale del resultado
  estructurado; despues el controller materializa el efecto temporal antes de
  responder. En Modo test, el efecto
  del link sandbox conserva la huella exacta de la oferta aceptada. Sólo un
  webhook `paid_test` del mismo run, scope, evento, calendario, UTC y huella puede
  reanudar esa cita en otro request; la ejecución que materializa queda registrada
  aparte y nunca reescribe la confirmación original. La
  idempotencia de cada intento se deriva de
  mensaje, canal, contacto, calendario y slot; un retry reproduce la cita
  canonica. La exclusion fisica del slot vive en el candado
  transaccional del calendario, que serializa altas del agente contra citas
  manuales. El ledger de creacion usa token y lease: una caida recupera la cita
  real o libera el intento sin dejar el horario bloqueado para siempre. Si la
  cita fue reprogramada, la tool relee fecha, hora y calendario canonicos, vuelve
  a cercar la autoridad del inbound antes de devolverlos y nunca responde con ese
  snapshot si ya llegó otra instrucción. Ademas, antes de crear una cita v2 se busca cualquier
  cita futura activa unida al mismo agente, contacto y calendario por su request
  durable. Si un crash creo la cita pero no alcanzo a sellar el cierre, incluso un
  inbound posterior que proponga otro slot repara la cita ya existente en lugar de
  duplicarla. Esa recuperación ejecuta el fence, el consumo pendiente del anticipo,
  la señal `appointment_booked` y su evento dentro de una sola transacción; un
  inbound más nuevo revierte todo el cierre interno. Una cita ajena o de otro calendario nunca se adopta como exito del
  agente. La cita, su ID y su calendario canonicos son siempre locales de Ristak;
  los IDs de Google o HighLevel sólo identifican sus espejos. Un fallo de
  configuracion o de la BD local cierra en seguro; un fallo de espejo externo no
  invalida la agenda local.
  Para la agenda conversacional, la consulta comparte la ruta verificada del
  calendario local. Google se refresca en modalidad best-effort para materializar
  su ocupacion externa en Ristak, pero Google y HighLevel nunca intersectan ni
  vetan los slots locales en vivo. Si un proveedor no responde, se usa la
  ocupacion ya guardada en la BD y la conversación puede continuar. La ruta
  calcula con la zona del negocio, respeta las unidades reales de duracion e
  intervalo y no inventa el horario historico de lunes a viernes de 9 a 5 cuando
  `openHours` falta o tiene un formato inutilizable. Las citas que
  comienzan antes del rango pero lo atraviesan tambien bloquean los slots que
  corresponden. La lista y la comprobacion final comparten las reglas del
  calendario: anticipacion minima, horizonte maximo, maximo diario, bloqueos y
  buffers antes/despues. Por eso una opcion que la configuracion no permitiria
  confirmar tampoco se muestra como negociable.
  Toda creacion, incluida la del agente, confirma primero una cita en el
  calendario local de Ristak bajo el candado transaccional. Ese INSERT es el
  commit canonico: su ID se guarda en el ledger idempotente antes de tocar Google,
  HighLevel, notificaciones o automatizaciones. Google Calendar y HighLevel son
  únicamente espejos opcionales. Si están conectados se sincronizan despues; si
  falta conexión o el espejo falla, la cita local sigue confirmada y el proveedor
  queda `pending`/`error` para conciliación sin invalidar el cierre del agente. Un
  retry devuelve la misma cita local y nunca crea otra.

  La creación conversacional permite como máximo un reintento adicional —dos
  intentos totales— y solamente alrededor de la llamada al controller de alta.
  El segundo intento reutiliza el mismo objeto de request inmutable, el mismo
  `clientRequestId` y el mismo contexto interno; no vuelve a pedirle una decisión
  al modelo, no reconstruye la oferta ni abre otra selección. Sólo se activa ante
  fallos transitorios explícitos (`408`, `425`, `429`, `500`, `502`, `503`, `504`
  o códigos de red/timeout permitidos), espera 200 ms y registra
  `appointment_creation_retry` con datos técnicos sanitizados. Un `409` u otro
  `4xx` definitivo no se reintenta. Si el primer intento alcanzó a confirmar la
  cita pero se perdió la respuesta, la idempotencia del controller reproduce esa
  misma cita; si ambos intentos fallan, el agente cierra en seguro y no afirma que
  quedó agendada. La materialización de citas del Modo test usa la misma política
  acotada y la misma llave `conv-test:<effectId>`; una falla transitoria del
  calendario no crea una divergencia artificial entre tester y conversación real.
  El controller sólo reconoce esa identidad de prueba cuando el request interno,
  `is_test=1` y `test_effect_id` coinciden exactamente. Una cita manual o live que
  casualmente comparta contacto y horario jamás se adopta como replay del tester.
  Dentro de la misma transacción del INSERT local, el ledger guarda primero el
  `appointment_id`; así una caída posterior nunca puede crear una segunda cita y
  la limpieza conserva la identidad exacta del registro parcial. Un checkpoint de
  Modo test no se auto-promueve a éxito: si Google o HighLevel fallan después del
  INSERT queda `failed/test_provider_sync_failed`; si vence el lease antes de
  terminar queda `failed/test_checkpoint_interrupted`. En ambos casos conserva la
  cita local para cleanup, responde error y un replay exacto no duplica ni inventa
  una confirmación. Sólo una fila que ya alcanzó `completed` puede reproducir éxito.
  Los estados `error_retryable` anteriores al INSERT sí pueden reabrirse; conflictos
  y demás `4xx` definitivos permanecen cerrados.

  Toda terminal live recibe además la identidad y el claim del inbound que la
  originó. El precommit y el controller vuelven a comprobar el claim activo, su
  lease y la fila canónica más reciente del canal. En PostgreSQL, todo writer
  inbound sustantivo de WhatsApp/QR/Meta Direct, SMS/webchat de HighLevel,
  Messenger/Instagram, comentarios y correo toma primero un
  `pg_advisory_xact_lock` por `contacto + canal`, antes de insertar el mensaje.
  Esto incluye syncs manuales/background con notificaciones apagadas y backfills
  históricos: el historial también debe competir si descubre la instrucción más
  reciente, aunque no incremente no leídos ni arranque notificaciones,
  automatizaciones o runner. En SQLite, `BEGIN IMMEDIATE` aporta la serialización
  equivalente. Los efectos vivos arrancan sólo después del commit. El controller
  toma primero el candado del calendario, verifica disponibilidad sin tomar aún el
  candado conversacional y lo adquiere una sola vez en el fence final,
  inmediatamente antes del INSERT o UPDATE. Conserva ambos locks hasta el
  commit: ése es el punto lineal de la decisión y no queda una ventana entre el
  último `SELECT` y la escritura real. Si ya existe otro mensaje
  sustantivo —por ejemplo `sí` seguido de `mejor a las 3`— el horario anterior no
  se crea, la oferta se cierra conservando el día y el rerun procesa la instrucción
  nueva. Un claim live que ya no conserva su fila canónica también pierde autoridad
  y falla cerrado. Reacciones y stickers no revocan una confirmación sustantiva.
  La identidad de contacto de una burbuja inbound es además write-once: un UPSERT
  deduplicado conserva siempre el `contact_id` no nulo ya guardado y sólo puede
  completar una fila legacy cuyo dueño era `NULL`. Un cambio real de dueño ocurre
  exclusivamente mediante `mergeContactIds`, que toma los locks de origen y destino
  para todos los canales canónicos en un orden global estable. Así un replay bajo el
  lock del contacto B no puede sacar de A una corrección que el fence terminal de A
  ya leyó.
  Una caída técnica al releer agente, calendario, zona o SQL no se disfraza como un
  cambio funcional ni quema la oferta: responde `503`
  `appointment_authority_revalidation_failed`, conserva la evidencia para retry y
  permite el segundo intento acotado del controller. Sólo una diferencia durable
  comprobada produce `appointment_offer_scope_changed` y marca `superseded`.

  Los reintentos de espejo tampoco hacen POST a ciegas. Cada request a HighLevel
  tiene un deadline global de 30 segundos que cubre conexión, lectura del body y
  esperas por `429`. Un GET puede reintentarse sólo dentro de ese mismo presupuesto;
  un POST con timeout, error de transporte o `5xx` ambiguo no se repite porque el
  proveedor pudo haber aplicado el cambio. El error `GHL_REQUEST_TIMEOUT` conserva
  metadata de resultado ambiguo y libera los locks del tester para que la
  conciliación o la limpieza durable continúen. Google usa un ID remoto
  determinista derivado del ID local y reconcilia ese mismo evento despues de un
  timeout o conflicto. HighLevel busca primero una cita remota equivalente; si el
  primer write tuvo resultado ambiguo y todavía no puede encontrarla, conserva la
  marca `remote_outcome_unknown` y espera otra conciliación en vez de duplicarla.
  Cada cita conserva tambien el calendario proveedor exacto de su espejo Google.
  Si la agenda cambia de Google A a Google B, el retry retira primero la copia de
  A y sólo después crea la de B; un error de DELETE impide el segundo write para
  no dejar dos espejos. La ocupacion importada del vínculo anterior se limpia al
  religar o desvincular. Si alguien cancela en Google una copia creada por Ristak,
  la cita local permanece activa y rota a una nueva generación determinista de ID
  remoto, incluso cuando el POST termina en timeout y necesita reconciliación.
  Antes de cada POST, PATCH o DELETE se vuelve a comprobar que ese calendario de
  Google tenga un solo dueño local; una liga duplicada legacy falla antes de
  escribir. Un tombstone viejo de otro calendario proveedor tampoco puede rotar
  ni perder la referencia del espejo vigente.
  La opción persistida del calendario `allow_overlaps` se aplica igual en
  consulta, oferta, validación previa al cobro, confirmación automática y
  solicitud humana; apagada exige slot libre y encendida permite el empalme sin
  saltarse horas de atención, bloqueos ni máximo diario. La configuración legacy
  `allowOverlaps` de la capacidad del agente ya no autoriza excepciones: el
  calendario es la única fuente de verdad y una bandera
  `ignoreAppointmentConflicts` enviada por un cliente tampoco puede ampliarla.
  El contacto solicitante de la cita es siempre el contacto canonico del hilo.
  `appointment_participants` conserva snapshots separados para `requester`,
  `primary_attendee` y cualquier cantidad acotada de `guest`; nombre es el unico
  dato base y telefono, correo o relacion sólo se exigen cuando el dueño los
  activo. Un titular distinto o invitado tampoco hereda silenciosamente el
  telefono o correo de quien escribe. Todo telefono o correo de un tercero lleva
  como evidencia el mensaje completo y literal del cliente que lo proporciono;
  el servidor comprueba la cita contra el hilo real, incluido el tramo omitido de
  la ventana del modelo, y exige coincidencia exacta del correo o del telefono
  normalizado. Sin evidencia, elimina el dato; si era obligatorio, la cita se
  detiene y pide sólo ese dato. Google deduplica invitados por correo y envia
  updates reales. Un familiar o tercero nunca reemplaza silenciosamente la ficha
  del solicitante.
  Cuando `bookingOwner=human`, `request_human_booking` comparte la
  misma revalidacion estricta y el mismo slot UTC, pero sella una solicitud humana
  idempotente en lugar de llamar al controller de creacion. Un retry exacto no
  duplica el aviso y un slot ocupado no cambia estado, asignacion ni notificaciones.
  En ese modo `reschedule_appointment` tampoco se expone: si la persona confirma
  una oferta `purpose=reschedule`, `request_human_booking` vuelve a comprobar el
  horario y entrega al equipo el ID de la cita original y el horario solicitado.
  La cita conserva fecha, estado y participantes anteriores hasta que una persona
  haga el cambio; el agente nunca afirma que ya fue reagendada.
  `get_contact_appointments` pagina todas las citas futuras activas del contacto
  solicitante en el calendario configurado; cada pagina conserva total,
  `hasMore` y `nextPage`, de modo que una recurrencia posterior no obliga a aceptar
  un ID escrito por el cliente. Para reagendar, `get_free_slots` recibe el
  `appointmentId`, excluye esa misma fila del conflicto y calcula cada opcion con
  la duracion real de la cita, no con la duracion generica del calendario.
  `cancel_appointment` respeta `allowCancellation`, hace cancelacion suave,
  conserva fila, participantes e historial y supersede cualquier oferta activa de
  reagendamiento ligada a esa cita. `reschedule_appointment` respeta
  `allowReschedule`, exige una oferta durable `purpose=reschedule` ligada al ID,
  horario, fin, duracion y estado anteriores exactos, y mueve la misma fila con los
  mismos participantes. Cancelar y reagendar comparten el candado transaccional
  del calendario y un CAS de estado/hora/duracion: sólo una mutacion concurrente
  gana, una cita cancelada nunca se reporta como reagendada y el segundo intento
  identico se devuelve como replay visible sin repetir proveedor, push ni
  automatizacion. Un ID ajeno, invitado no solicitante, cita pasada, estado
  inactivo u oferta vieja falla sin crear una segunda cita. Las citas canceladas,
  `no_show`/`noshow`, invalidas o eliminadas dejan de ocupar disponibilidad.
  Al sincronizar con HighLevel, la respuesta remota sólo puede guardar el ID y el
  estado tecnico del espejo: nunca sustituye contacto, titulo, horario, estado,
  notas ni ningun otro dato canonico local. Una respuesta tardía tampoco puede pisar una
  cancelación o reagendamiento posterior: vuelve a tomar el candado, compara el
  estado y horario post-commit y, si ya cambiaron, conserva la versión nueva,
  responde conflicto y la marca `sync_status=pending` para reparar cualquier
  mutación remota vieja. Antes de cada alta remota, incluida la agenda pública y
  el batch de reconexión, Ristak guarda una intención durable con calendario,
  contacto y horario. Si el webhook de HighLevel se adelanta a la respuesta del
  POST, esa intención liga el ID remoto a la cita local y la deja `pending` hasta
  validar el eco completo; nunca importa una segunda cita ni crea otra ficha.
  Los pulls, la apertura de la agenda y los webhooks de
  HighLevel resuelven primero `ghl_appointment_id`: si es el eco de una cita
  canónica de Ristak, sólo concilian el espejo y nunca crean otra fila, otra ficha
  de contacto ni disparan de nuevo automatizaciones o avisos; si el proveedor
  difiere, la versión local queda pendiente para volver a publicarse. Sólo un
  evento que realmente nació en HighLevel puede importarse como ocupación
  `source=ghl`. Si falla transitoriamente el DELETE de una cita
  cancelada en Google Calendar, queda `google_sync_status=error` y el reconciliador
  vuelve a intentar la eliminacion aunque la cita local ya este cancelada.
- Pago: producto, precio, monto, concepto y moneda deben coincidir con la
  capacidad blindada o el catalogo real. `payment_link` expone exclusivamente
  `create_payment_link`; `bank_transfer` expone exclusivamente
  `register_deposit_payment_proof`. El modelo nunca recibe ambas tools para el
  mismo cobro. Antes de hablar con el proveedor, v2
  reserva una llave durable
  por agente, contacto, producto/precio, monto, moneda, canal y mensaje entrante;
  concurrencia o replay del mismo mensaje reproducen el resultado. Un mensaje
  posterior con la misma identidad exacta reutiliza el link pendiente y vigente,
  incluso si el cliente se desvio y después retomo el cobro; no llama otra vez a
  la pasarela ni vuelve a reclamar el anticipo. Cambiar agente, contacto,
  producto/precio, monto, moneda, proveedor, canal, proposito, MSI o binding de
  cita crea un contrato distinto. Un link pagado, cancelado, reembolsado, fallido
  o vencido tampoco se recicla. Si la reserva no se puede
  guardar, falla cerrado. La reserva guarda tambien el request canonico y el
  evento determinista que vincula el cobro con agente, contacto, proposito y
  ejecucion. Crear/enviar link deja la compra `pending`; solo un pago real la
  completa. Si el proveedor alcanzo a crear el link pero el proceso cayo antes de
  sellar ese vinculo, el recovery de arranque o webhook reconstruye primero la
  fila `processing` desde el invoice/ledger exactos y despues sella el source event.
  La pasarela elegida tambien es parte inmutable del request. HighLevel conserva
  compatibilidad por invoice; Stripe, Conekta, Mercado Pago, CLIP y Rebill usan
  `createPaymentGateLink` y guardan la misma llave durable desde el INSERT de la
  fila `payments`. El runtime live exige que la pasarela seleccionada este
  conectada y en `live`, nunca cae a otra ni entrega un link sandbox. Para estas
  pasarelas la recuperacion usa `public_payment_id`; la URL visible sale siempre
  de la fila canonica y no de un valor suelto devuelto por el proveedor. MSI,
  minutos de vencimiento y accion posterior forman parte del hash; el instante
  absoluto de expiracion lo decide una sola vez la corrida ganadora y los retries
  concurrentes o secuenciales reutilizan el valor del resultado/ledger canonico.
  La accion `afterPayment` queda congelada en esa misma fuente durable y sólo se
  ejecuta despues de confirmar fondos reales. `continue` reanuda al mismo
  Agent/Runner con el pago como hecho verificado, sin inventar otro mensaje del
  cliente; `handoff` cambia de forma deterministica el chat a
  `human/ready_for_human`, crea su evento y avisa al equipo. El modelo no vuelve a
  decidir cual de las dos aplicar desde el texto del webhook, y un pago
  `pending`, sandbox o un comprobante sin aprobar nunca dispara ninguna.
  Esa accion opera sólo sobre el agente y canal que crearon la fuente durable del
  cobro. Un webhook tardio de un agente eliminado nunca toma, cierra ni transfiere
  el estado de su reemplazo. Una pausa, takeover o cierre humano posterior se
  conserva y no genera un aviso falso de entrega. Si el pago era anticipo y la
  agenda la termina la IA, el handoff posterior sólo puede ejecutarse despues del
  cierre durable `appointment_booked`; nunca convierte un estado todavía activo
  en humano antes de crear la cita.
  Cuando el cobro es el anticipo de una cita, la seleccion abre primero un intento
  durable y la fuente exacta lo reclama antes de llamar al proveedor. El mismo
  mensaje puede reentrar despues de un crash con ese intento ya `collecting` o
  `source_bound`: vuelve a pedir `create_payment_link` y recupera el mismo link,
  ledger y evento, sin crear un segundo cobro ni dejar el turno varado.
  `request_human_booking` aplica el mismo requisito de anticipo que
  `book_appointment`: primero fija asistentes y terminal, cobra una sola vez y,
  después de confirmarse el pago, entrega el horario al equipo sin afirmar que la
  cita ya fue creada. Esa entrega consume el anticipo con el mismo evento durable
  `${reconciliationId}_consumed`, marcado como `human_booking_request` y sin un
  `appointmentId`. Consumo, estado humano y evento `human_booking_requested`
  confirman o se revierten dentro de una sola transacción. Si el proceso cae
  después del commit, la reconciliación reconoce esos tres hechos, se cierra sin
  volver a ejecutar al agente, repara con identidad durable la notificación
  prioritaria y la respuesta visible al cliente que hayan quedado pendientes, y
  conserva la conversación en manos del equipo. La agenda automatica tiene la
  recuperacion simetrica: consumo, request idempotente y cita local activa son la
  prueba terminal aun si el proceso cayó antes de actualizar el estado. Recovery
  puede sellar un request que quedó `processing` o `failed` sólo cuando el consumo
  exacto y el `appointmentId` prueban la misma cita activa; si el staff ya la
  reprogramó, conserva fecha/calendario canónicos actuales. Una cita consumida que
  fue cancelada, eliminada o ya no existe deja el request como tombstone
  `completed` y pasa a revisión humana, sin volver al modelo ni reciclar el
  anticipo. Sólo repara `appointment_booked` si el estado conserva la autoridad interna de
  esa terminal; un estado humano o pausado posterior manda. Tanto la agenda IA
  como la humana usan el mismo identificador de entrega para que una respuesta ya
  confirmada no vuelva a enviarse.
  El consumo y el evento humano bastan
  para reconocer esa terminal aunque después el staff haya limpiado la señal,
  pausado o cerrado el chat; recovery preserva ese estado más nuevo.
  Las rutas de revisión manual congelan la reconciliación con
  `autoResumeAllowed=false` y `manualReviewOnly=true`; desde ese momento el pago
  sigue registrado, pero ya no puede reaparecer como evidencia disponible para
  otra cita. Esto aplica también a fuentes antiguas o incompletas sin selección,
  calendario, UTC, borrador/huella o terminal verificables, y a reanudaciones con
  feature apagada, agente apagado o conversación en un estado no ejecutable. Si
  alguien ya tomó o pausó el chat antes de que llegue el webhook, el pago no lo
  reactiva. La reconciliación nunca reescribe `active` ni limpia la señal después
  de observar el estado: la señal de revisión manual se reclama por CAS y su
  cambio de estado + evento `signal_set` confirman en una sola transacción, o se
  revierten juntos. Se aplica una sola vez. Si después falla el push o la
  respuesta, el retry sólo recupera esas entregas y conserva cualquier pausa o
  takeover posterior. El Runner valida
  el estado otra vez, así que un takeover humano concurrente tampoco se pierde. Si
  el agente fue eliminado mientras el link estaba pendiente, el
  webhook valida igualmente monto, moneda, proveedor y ledger usando el `agentId`
  durable de la fuente, conserva el pago, mantiene liberado el contacto y escala
  el caso a una persona; nunca abandona el pago como un rechazo sin seguimiento.
  En un pago completo conserva igualmente el cierre y la notificación histórica,
  pero no vuelve a asignar el contacto al identificador de un agente inexistente.
  Las alertas criticas usan una outbox por evento con claim y lease. Sólo `sent`
  deduplica para siempre; `pending`, `failed` o un `processing` vencido pueden ser
  retomados. La deduplicacion generica de notificaciones recientes no bloquea esa
  recuperacion. El payload guardado por el primer intento manda durante los
  retries, aunque después cambien el título o la hora de una cita. Como el
  proveedor push no ofrece idempotencia transaccional, el
  contrato es al menos una entrega ante un crash ambiguo, pero nunca se pierde una
  alerta solo porque ya existia su marcador `pending`.
  Una combinacion sin
  soporte falla cerrada en vez de degradarse en silencio. HighLevel no promete
  MSI porque su API de invoices no permite fijar ese maximo.
  `request_json` debe conservar su hash original; una mutacion de proposito, monto
  o identidad bloquea el cobro. Los filtros persistidos de contacto e invoice
  permiten reparar el webhook objetivo sin quedar detras de otros pendientes.
  `get_payment_status` no acepta IDs ni otro contacto: consulta sólo ledgers
  vinculados durablemente por ese agente al hilo actual, y devuelve estado,
  monto, moneda, proveedor y vencimiento sin exponer IDs internos. Sólo
  `fundsConfirmed=true`, derivado de un estado exitoso live, demuestra fondos;
  `pending` y `pending_review` nunca autorizan el siguiente paso. La reconciliacion exige status exitoso
  explicito y cruza el invoice contra su fila exacta, monto en unidades menores,
  moneda, proposito inmutable y ambiente.
  Los tres ambientes deben ser `live`: pagos `test`/sandbox, datos ausentes o
  cualquier diferencia quedan rechazados sin marcar compra. Un claim durable y
  checkpoints por señal, aviso y evento hacen idempotentes los webhooks repetidos
  y el recovery tras reinicio. V2 no reutiliza invoices recientes solo porque
  contacto, monto y concepto se parezcan; su dedupe fuerte queda ligado a agente,
  capacidad, producto/precio y mensaje. Un supuesto comprobante del modelo no
  sirve como evidencia.
- Transferencias y comprobantes: pueden corresponder a pago completo o anticipo.
  Con `payment_link`, el agente
  puede mandar `create_payment_link` aunque su cierre sea una cita. Con
  `bank_transfer`, comparte los datos configurados y, al recibir la foto o PDF del
  comprobante, ejecuta `register_deposit_payment_proof`: la tool lee el
  comprobante con vision (monto, moneda, fecha, banco, referencia), lo compara
  contra el anticipo configurado (fijo exacto o rango, moneda de la cuenta). En
  v2, si cuadra, lo registra como `pending_review`/`manual_review`, sin `paid_at`,
  sin estadisticas de venta y sin satisfacer `findVerifiedPaymentEvidence`; el
  equipo debe confirmar los fondos por la via real antes de que agenda o cobro
  avancen. En `Transacciones` el registro se muestra como `Comprobante por
  revisar`, con el archivo y los importes bloqueados. Las unicas decisiones son
  `POST /api/transactions/:id/approve-transfer-proof` y
  `POST /api/transactions/:id/reject-transfer-proof`: aprobar exige que un
  usuario autenticado haya verificado fondos, hace CAS a `paid/live`, sella
  revisor/fecha y reanuda el mismo Agent/Runner; rechazar guarda el motivo y nunca
  reanuda. La edicion generica, `record-payment` y el borrado no pueden brincar ni
  eliminar esta revision ya auditada.
  El mismo contrato permite comprobantes de un pago completo (`purchase`) o de
  un anticipo independiente (`deposit`) aunque no exista agenda: ambos quedan
  pendientes y sólo `approve-transfer-proof` puede convertirlos en pago real y
  completar la compra una vez.
  Tener Agenda habilitada no cambia ese proposito. El comprobante sólo conserva
  `appointment_deposit` cuando existe el intento durable de la cita exacta; el
  analizador y el tester transportan ese proposito de forma estructurada en vez
  de inferirlo por texto o por la mera presencia de un calendario.
  Si el anticipo aprobado pertenecia a una cita, el runner recibe el pago como
  contexto factual interno. El evento fuente del cobro conserva el ID y snapshot
  exactos de la seleccion durable que existia antes de crear el enlace o registrar
  el comprobante. La reanudacion sólo puede reutilizar esa seleccion si la
  reconciliacion apunta a ese mismo evento fuente y si agente, contacto,
  calendario y `startTime` siguen coincidiendo; una seleccion posterior o ajena
  falla cerrada. Despues vuelve a comprobar el slot antes de agendar y reserva la
  evidencia de pago para un request de
  cita concreto con `claimToken` y lease. El controller vuelve a bloquear y validar
  ese fencing token, el pago y la reconciliacion dentro de la misma transaccion que
  inserta la cita; un proceso viejo no puede despertar y crear otra cita despues de
  perder la lease. Una lease vencida solo se recupera si el request anterior nunca
  alcanzo a crear cita o su cita canonica ya esta inactiva. Al confirmar la cita se
  consume el contrato de anticipo congelado en el intento, aunque luego cambie la
  configuracion. Otro request no puede gastar de nuevo el mismo anticipo. No fabrica
  un mensaje del cliente ni espera otro inbound.
  El equipo recibe push para auditar el comprobante. Una imagen ilegible, sin
  monto, con monto distinto u otra moneda no se descarta ni fabrica una fila de
  pago: se sella una sola vez como `payment_proof_manual_review_required`, con la
  media, proposito, expectativa y causa, `ledgerPaymentId=null`, sin permiso de
  aprobar ni reanudar. Caso y estado `human/ready_for_human` se confirman juntos;
  si la persona asignada ya no sirve, el chat queda con el equipo general. Si la
  lectura habia tomado el claim de un anticipo, se libera por CAS despues de
  sellar el caso para permitir una foto correcta posterior. Un comprobante valido
  pero viejo, ambiguo o enviado despues de que el mismo anticipo ya genero un
  link conserva `appointment_deposit`, crea ledger pendiente, bloquea autoagenda,
  deja el source original intacto y pasa el chat a revision humana antes de
  registrar ese ledger. En v2, pago y evento se guardan en una sola
  transaccion y quedan ligados al contacto, canal y mensaje/media exactos, no al
  agente que alcanzo a procesarlo. Repetir el mismo comprobante incluso desde otro
  agente devuelve el mismo ledger, mientras cambiar importe, proposito o archivo
  falla cerrado.
- Handoff: `send_to_human` valida y asigna de forma idempotente al usuario activo
  configurado. Asignacion del contacto, estado terminal del chat y evento de
  auditoria confirman dentro de una sola transaccion o se revierten juntos; un
  retry no deja un contacto asignado mientras la tool reporta fracaso. Registra
  transferencia y no infla la meta como conversion. Un objetivo propio que
  termina en handoff usa la misma operacion atomica. La opcion de
  enviar clientes anteriores al equipo se basa en pagos exitosos reales o citas
  previas no canceladas recuperadas por `get_contact_profile`, nunca en una frase
  del contacto. El resumen estructurado evita que la persona repita su historia.
- Entrega visible: si una tool de pago o enlace tuvo exito y el texto generado
  omitio su URL, el servidor la agrega completa y una sola vez despues de
  sanitizar el mensaje. Los nombres de tools, IDs, payloads y codigos internos no
  se entregan al contacto; v2 tampoco dispone de una tool capaz de quedarse mudo.
  Para listas y ofertas de horario, el tester tampoco agrega el globo generico
  "Prueba interna": simula el efecto por estado y deja visible solamente el
  horario que recibiria el contacto. Esas listas y ofertas estructuradas siempre
  salen como un solo globo. Al
  recibir cualquier comprobante, el fallback visible aclara que quedo pendiente
  de revision y que el pago todavia no esta confirmado, incluso si el handoff
  propio ya cambio el estado del chat a humano.
- Confirmaciones posteriores: webhooks reales de pago o integraciones externas
  pueden cerrar una meta pendiente. Reutilizan el resumen factual, no levantan
  otra IA y no aplican asignaciones, etiquetas ni campos ajenos a las capacidades
  blindadas.
- Enlaces y meta por URL: **Mandar enlace** por sí sola entrega la URL segura
  configurada mediante `send_trigger_link`, sin agregar identidad, crear una meta
  ni cambiar el chat a humano. **Objetivo propio** usa otra tool fisicamente
  separada, `send_goal_url`, para preparar el enlace rastreable y crear la meta
  pendiente. Si ambas capacidades estan activas se exponen ambas tools con
  contratos distintos: una llamada a `send_trigger_link` nunca puede convertirse
  globalmente en meta por el simple hecho de que Objetivo propio tambien exista.
  Sólo cuando **Objetivo propio** esta activo, termina mediante `send_link` y usa
  un enlace `verified_goal`, el enlace visible contiene un ID de seguimiento. La
  meta queda `pending`:
  abrir el enlace no prueba una cita ni un pago. El sistema externo debe estar
  conectado a Ristak y confirmar el resultado por la API autenticada
  `POST /api/external/conversational-agent/goals/:goalId/complete`, con API token
  e `Idempotency-Key`. La confirmacion exige `externalSource`, ID externo, status exitoso y
  coincidencia estricta de calendario/producto/precio/monto/moneda. El mismo
  request es idempotente; uno distinto no puede apropiarse de una meta ya
  completada y una misma evidencia externa no puede cerrar dos metas. Los IDs
  opacos se comparan exactamente, sin normalizar mayusculas. La creacion tambien
  usa la identidad del inbound para no generar dos links por el mismo turno.
  Evidencia y `Idempotency-Key` quedan reclamados en una tombstone sin cascade,
  dentro de la misma transaccion que completa la meta; borrar contacto o link no
  permite reutilizarlos. Un trigger instalado junto con el backfill bloquea a
  binarios anteriores durante un rolling deploy si intentan completar sin claim.
  Señal, notificacion y evento final tienen checkpoints separados, fencing por
  lease y recovery al arrancar y periodico. El push usa
  entrega `at-most-once`: un ACK incierto queda como `unknown` y no se duplica.
  Los ledgers de metas y claims quedan bloqueados en CRUD generico, MCP y SQL del
  agente; solo la ruta dedicada puede confirmar metas. El resto de las tablas del
  agente son de solo lectura
  para el CRUD externo, de modo que una integracion no pueda falsificar estados,
  eventos ni metricas.
  Los tokens de callback por URL de versiones anteriores se aceptan unicamente
  por header y nunca se generan ni se agregan a enlaces nuevos.

### Metricas y seguridad

Las metricas separan metas completadas, handoffs, citas, links de pago,
seguimientos enviados/suprimidos, errores de herramientas, tasa de respuesta,
acciones ejecutadas y numero real de vueltas del modelo. Un estado `human` con
señal `ready_for_human` cuenta como traspaso, no como exito. No existen versiones
de assessment, estrategia o aprendizaje que puedan modificar el prompt o las
capacidades por fuera del editor del dueño.

La pantalla de metricas no agrega `conversational_agent_state` ni
`conversational_agent_events` completos en cada apertura. La proyeccion durable
`098*` conserva un ledger sentinel por estado/evento, summaries por agente para
conversaciones y 64 shards para eventos globales. Los triggers cubren insert,
update, reasignacion y delete en la misma transaccion. El fast path lee los
agentes actuales mas esas filas acotadas y conserva agentes eliminados,
precedencia de ultima actividad, tasa de respuesta y las doce familias de evento
del contrato anterior. Durante backfill lee únicamente los summaries ya
convergidos y responde `projection.status=warming`; no agrega las filas
`version < 1` ni escanea tablas fuente en el GET. Si el esquema aun no existe
devuelve un snapshot vacío con `projection.status=unavailable`. Al estar `ready`
el mismo read-model vuelve a ser exacto. Las
pausas vencidas se buscan por el indice parcial `098*` desde un job de sistema
cada cinco segundos; abrir Metricas o un listado es lectura pura y no cambia el
CRM. Cada lote se reclama dentro de una transaccion (`FOR UPDATE SKIP LOCKED` en
PostgreSQL y `BEGIN IMMEDIATE` en SQLite), actualiza como maximo 500 filas y
escribe sus eventos en la misma transaccion. Dos instancias no pueden reactivar
la misma pausa ni duplicar su auditoria.

La migracion del runtime unico elimina las tablas anteriores de politicas y
aprendizaje, elimina el antiguo interruptor global redundante, limpia estados
`discarded` y no conserva adaptadores ejecutables de keywords o configuraciones
antiguas. Publicar o pausar un agente individual es la unica llave operativa;
ninguna segunda configuracion puede revertir o bloquear esa accion.

Reglas:

- No meter secrets de IA en codigo.
- Si una llave puede configurarse desde la app de forma segura, debe vivir en la
  configuracion interna correspondiente.
- Acciones sensibles deben registrar estado, idempotencia y pendiente de
  aprobacion cuando aplique.

## API externa, OAuth y MCP

La API externa vive en `/api/external` y se documenta en
`docs/EXTERNAL_API_ACCESS.md`.

Incluye:

- Tokens API.
- OpenAPI.
- OAuth clients/codes/refresh tokens.
- Rutas para lectura y mutacion controlada.
- Confirmacion idempotente de metas conversacionales por integraciones
  autenticadas; una URL sin integracion permanece pendiente.
- MCP para clientes compatibles.

El MCP externo es un plano de control tipado sobre los servicios de negocio de
Ristak. El registro actual contiene 235 tools antes del filtrado de autorizacion
y cubre CRM/contactos, tags, campos personalizados, trigger links, inbox y envio
de mensajes, chatbot, citas, calendarios, automatizaciones, pagos, productos,
precios, suscripciones, dashboard, reportes, analytics/tracking, campañas,
activos multimedia —incluida la subida firmada de archivos locales a Bunny—,
costos, plantillas de WhatsApp, preferencias moviles,
estado seguro de integraciones y Sites con sus archivos HTML. El status de
Developers y `tools/list` cuentan/muestran solo las tools visibles para el
usuario, plan, modulos y scopes actuales. No es SQL libre, no es un proxy
generico de rutas y no autoriza secretos, infraestructura, administracion de
usuarios ni escritura directa en tablas/ledgers protegidos. Cada accion nueva
de producto que se publique por MCP debe registrarse con schema, contrato de
salida, feature/modulo, permiso de usuario, scope OAuth, anotaciones de riesgo y
ejecutor auditable.

El servidor remoto usa Streamable HTTP y OAuth 2.1 con PKCE. Los scopes separan
`ristak.read`, `ristak.write`, `ristak.execute` y `ristak.destructive` para que
leer, modificar estado, provocar efectos externos y destruir datos no sean el
mismo permiso. `tools/list` solo descubre acciones compatibles con licencia,
acceso de usuario y scopes; `tools/call` vuelve a comprobarlos. Mensajes,
publicaciones, pagos y borrados requieren las confirmaciones/metadatos de riesgo
correspondientes y dejan auditoria con secretos redactados.
La edición genérica de pagos no acepta `status`: registrar un pago requiere
`ristak.execute`; anular, reembolsar o cancelar/eliminar un plan exige
`ristak.destructive`.

El usuario administra estas conexiones en
`Configuracion > Developers > Conectar con MCP`. El frontend consulta
`GET /api/api-access/mcp/status` y
`GET /api/api-access/mcp/connections`; revoca una autorizacion con
`DELETE /api/api-access/mcp/connections/:id`. Las fechas de negocio que entren
por tools se resuelven con la zona de la cuenta y la moneda default sale de
`account_currency`, nunca de la computadora del cliente MCP.

"Recibir mensajes" en una herramienta MCP significa listar inbox/conversacion o
mantener polling desde el runtime del cliente. Ristak no puede iniciar una
llamada espontanea dentro de una sesion cerrada de Codex, ChatGPT o Claude; para
flujos event-driven se usan automatizaciones o webhooks.

Los tokens se tratan como secretos. La documentacion solo debe indicar nombres,
ubicacion y uso, nunca valores.

El soporte interno para revisar clientes instalados no usa este MCP externo. Los
agentes deben entrar por el MCP/CLI de soporte de Ristak Installer, documentado
en `docs/support-mcp-operations.md`, para resolver la instalacion, leer logs,
inspeccionar schema y consultar filas read-only de la DB del cliente.

La API externa y MCP no son bypass de plan. Generar, rotar y revocar tokens de
REST/OpenAPI requiere `developers`; conectar MCP usa la sesion web normal y
consentimiento OAuth, sin ese token. Usar `/api/external` o `/api/mcp` requiere
`developers`; cada endpoint/tool vuelve a revisar la feature del recurso (`payments`, `payment_plans`,
`subscriptions`, `reports`, `campaigns`, `appointments`, `sites`, `contacts`,
`integrations`, etc.), el acceso vigente del usuario y, para MCP, el scope OAuth.
Una credencial emitida antes de un downgrade o un cambio de permisos no conserva
acceso a modulos que la cuenta o ese usuario ya no pueden usar.

Las tablas `meta_oauth_integrations` y `meta_oauth_integration_sessions` estan
bloqueadas completamente en el CRUD generico de `/api/external` y en las
herramientas de datos MCP. No se pueden listar, consultar, editar ni borrar por
esas superficies aunque el token tenga `developers` y `campaigns`; el ciclo de
vida OAuth solo se modifica mediante sus endpoints dedicados.

## App movil

Ristak tiene tres rutas moviles activas:

1. `/movil`: experiencia movil web/PWA dentro de `frontend/`. Es la ruta usada
   para web.
2. `mobile/`: cliente React Native/Expo para Android y dispositivos Google. No
   debe contener configuracion, scripts, entitlements, APNs, targets,
   extensiones ni codigo nativo Apple.
3. `ios/app`: app nativa Apple en SwiftUI para iPhone y iPad. Es la unica ruta
   propietaria de la experiencia nativa Apple y usa el bundle oficial de App
   Store `com.ristak.app`.

En **Configuración > Dispositivos móviles**, el equipo encuentra los enlaces
oficiales de descarga: App Store para iPhone/iPad y Google Play para Android
(`com.ristak.android`), además del acceso web/PWA de respaldo para el chat.

Regla obligatoria para futuros cambios: si una feature, label, permiso, push,
agenda, pago, filtro, login o contrato de API cambia la experiencia movil, la IA
debe revisar las superficies que apliquen: `/movil`, `mobile/` y `ios/app`.
Cuando solo aplique a una superficie, el resumen del cambio debe explicar por
que.

La app React Native no es un rediseño. Su contrato de producto es paridad visual
y funcional con `/movil`: mismo orden de secciones, nombres visibles,
jerarquia, flujos, permisos, estados y comportamiento final. La implementacion
puede ser nativa distinta, pero el usuario no debe sentir que esta usando una app
diferente o recortada.

La lista de chats nativa debe mantenerse alineada con `PhoneChat`: header de
chats, buscador, chips de filtros, filas planas, avatares sin aro de canal y
badge inferior derecho con asset nativo, preview de ultimo mensaje, estados de
no leido, fila/vista de archivados y seleccion multiple por long press. Tocar
abre la conversacion y mantener presionado abre `Mas acciones`. El swipe de fila
es comun a `/movil`, React Native e iOS: izquierda muestra `Mas` y luego
`Archivar/Restaurar`; derecha muestra `No leido` y luego `Fijar/Desfijar`. Los
fijados quedan arriba y el estado local persiste en el dispositivo. Tambien debe usar sheets nativos para
`Mas`, `+`/nuevo chat y selector de destinatarios despues de camara. Cuando
cambien filtros, labels, canales, unread, archivados, seleccion, swipe, camara,
sheets o preview en `/movil`, se debe revisar el equivalente en
`mobile/src/App.tsx` y documentar cualquier brecha temporal en
`docs/MOBILE_APP.md`. En la conversacion nativa, si un agente conversacional
esta activo, enviar un mensaje manual debe pedir primero que el usuario pause el
agente 24 horas, quite el contacto del agente o cancele; el menu `+` debe poner
los controles del agente al inicio cuando haya estado de agente asignado.

En iPhone y Android, el modo de seleccion multiple ofrece dos alcances
distintos: `Visibles` alterna solamente las filas mostradas y `Seleccionar
todos` incluye literalmente todas las conversaciones seleccionables del inbox,
aunque esten fuera de pantalla, paginadas o escondidas por el filtro actual. El
backend expone ese universo como ids ligeros con
`GET /contacts/chats?idsOnly=true`; las acciones masivas operan sobre la
seleccion completa y no deben reconstruirla a partir de las filas visibles.
La bandeja Android expone el Hub del agente conversacional desde el robot de la
esquina superior izquierda, con control individual para encender/pausar,
reiniciar omisiones y editar la configuracion principal. Dentro de un chat con
agente asignado (`active` o `paused`), el robot vive a la izquierda del
calendario en la capsula del header y abre los controles por contacto (`pause`,
`take_over`, `skip`, `resume` y `clear_signal`). Si esta pausado, el mismo robot
muestra una marca de pausa. Un takeover, omision o cierre terminal retira ese
control; reingresar el chat al agente requiere una asignacion explicita. No
existe un runtime global que pueda bloquear al agente: la app controla
directamente cada agente individual y no presenta `Apagar todos`.

La pantalla de analiticas nativa debe mantenerse alineada con
`PhoneAnalytics`: periodos `30d`/`60d`/`180d`/`year`/`custom`, 8 KPIs, grafica
principal, embudo, distribucion de origen y origen por numero de WhatsApp. Los
rangos se calculan con `account_timezone`, el rango personalizado usa fechas
`YYYY-MM-DD`, y los importes se formatean con `account_currency`. Si no se pueden
confirmar ambos valores, la pantalla falla cerrada y ofrece reintento en vez de
mostrar cifras o periodos con defaults inventados. Si la licencia no incluye
`web_analytics` o el plan no es Profesional, Android y `/movil` mandan
`includeWeb=0` al embudo/origen y no muestran visitantes ni trafico web.

En `/movil`, la apertura de `PhoneAnalytics` usa el snapshot unificado de
Dashboard para evitar el fan-out de metricas, origen, funnel, financiera y
estado WhatsApp. El ultimo snapshot util puede pintarse antes de revalidar; las
selecciones posteriores de grafica o atribucion se cargan por separado y nunca
permiten que una respuesta de un periodo anterior reemplace el periodo activo.

El ACL de esta pantalla movil es `dashboard` en Android y `/movil`, igual que
los endpoints `/api/dashboard/*` que alimentan el resumen operativo y
financiero. El permiso `analytics` no sustituye ese acceso: corresponde al
modulo web de sesiones, visitantes y conversiones. El rail de tablet aplica el
mismo guard antes de montar `PhoneAnalytics` dentro de Chat.

Contrato de confiabilidad Android: la bandeja aplica los metadatos del SSE antes
de reconciliar, normaliza timestamps SQLite/ISO como instantes UTC, conserva la
lista cacheada ante fallos silenciosos y cancela requests colgados. La
conversacion se remonta por `contactId`, guarda solo sus mensajes mas recientes
sin base64, limita la cache en memoria y pinta `/conversation` antes de cargar
journey/programados secundarios; no consulta journey/acuse de lectura en cada
poll. El outbox local conserva pendientes/fallidos siete dias, vuelve
reintentable un envio sin acuse al reabrir, evita el segundo intento mientras el
primero sigue activo y permite que una respuesta canonica vacia limpie cache
fantasma despues de hidratar. Calendario cancela rangos viejos y guarda sus
arreglos en archivos: sin cache, un fallo de calendarios/zona horaria es error visible; con cache conserva
la ultima agenda con aviso y bloquea cambios de fecha hasta tener timezone
valida. Pagos bloquea creacion si no puede confirmar moneda y zona horaria, y
mantiene features avanzadas en fail-closed.

La apertura de un hilo Android precarga su snapshot puntual antes de montar la
ruta, se ancla una sola vez al mensaje mas reciente y distingue error transitorio
de un `200 []` realmente autoritativo. Un preview/conteo de inbox incompatible
con un hilo vacio activa una recuperacion acotada; timeout/`5xx` conserva cache,
ofrece reintento manual y nunca muestra falsamente que no hay mensajes; no hace
loops ni reintentos ocultos. En background,
WorkManager mantiene bandeja y hasta seis hilos recientes, mientras el task
headless de push da hasta 1.8 s al contacto notificado para persistir, deja una
sola alerta local y despues actualiza una pagina de inbox. Si la red no alcanza,
aborta la precarga y alerta sin esperar el timeout largo. No usa journey ni
fan-out por push. Es oportunista y siempre valida namespace/sesion antes de
persistir y antes de programar la alerta.

El bootstrap Android precarga antes del shell solo los cinco snapshots de
primera pintura (bandeja, first-sync, configuracion/labels y filtros), con un
presupuesto conjunto de 4 MiB. La precarga general del namespace corre despues
de las interacciones y procesa metadata, lecturas y limpieza en lotes de cuatro,
cediendo el hilo JS despues de cada lote. Valida epoch/namespace entre lotes:
un cambio de cuenta descarta el resultado y una escritura foreground en RAM
siempre gana sobre el snapshot viejo de disco. Mantiene sus limites de 180
archivos, 32 MiB y 45 dias. Asi Chats pinta de inmediato sin hacer que el
arranque analice toda la cache; Calendario, Pagos, Analiticas y Ajustes hidratan
el ultimo estado en background y revalidan sin dejar una pantalla vacia. Pagos
conserva el gating conocido de
licencia/pasarelas/HighLevel, productos y recibidos por rango; Analiticas separa
KPIs, grafica, embudo y origen por rango/scope; Ajustes conserva sus catalogos.
Cada respuesta fresca exitosa, incluyendo una lista vacia, reemplaza la copia
local. El snapshot nunca concede permisos nuevos ni autoriza mutaciones: ACL,
moneda, zona horaria y licencias definitivas siguen verificandose contra el
backend y un `401`/`license_blocked` limpia la sesion.

El arranque offline Android conserva la ultima ACL verificada solo para el mismo
servidor y token. Sin esa evidencia no monta modulos; al volver a primer plano y
periodicamente revalida la sesion. `401`/`license_blocked` limpian sesion y cache,
mientras timeout, offline o `5xx` conservan temporalmente la ultima ACL valida.
Si la licencia esta aplicada, una fuente de features marcada invalida o una
llave de modulo ausente falla cerrada y no habilita esa seccion por omision.

En la implementacion SwiftUI, una recarga de Analiticas solo cuenta como fresca
si completan metricas, grafica, embudo y origen. Si algun panel falla, conserva
el snapshot pero lo advierte y vuelve a intentar al regresar a foreground. La
consulta de numeros de WhatsApp es independiente de Origen y solo reemplaza su
cache cuando responde con exito.
Los filtros horizontales de grafica, scope, embudo y origen ocupan el ancho
completo de su tarjeta sin gutter, pero se recortan exactamente en el viewport
de esa tarjeta y nunca invaden el fondo de la ventana. Las series de Swift
Charts se escalan con 20 % de techo libre —el maximo queda al 80 % de altura— y
usan relleno degradado sutil hasta la base; la escala no altera datos, leyendas
ni valores del scrub interactivo.

En Android, contexto, KPIs, grafica, embudo y origen fallan por separado: cada
panel muestra error y reintento sin fabricar ceros ni presentar `Sin datos`
cuando en realidad fallo la red o el servidor. Los paneles sanos permanecen
visibles.

El cliente de red iOS captura `{baseURL, token, generation}` al iniciar cada
request. Un 401 o rollback perteneciente a una cuenta anterior no puede mutar la
sesion actual, y las cargas de configuracion tambien descartan generaciones
viejas. Solo `GET`/`HEAD` puede reintentarse automaticamente ante un 503; una
escritura nunca se repite a ciegas.

Documentos:

- `docs/MOBILE_APP.md`
- `docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`
- `docs/MOBILE_STORE_RELEASES.md`

Las credenciales de stores no deben vivir en el repo. Los builds de tienda se
manejan con flujo manual/Installer segun el documento de releases.
Para operar desde esta Mac existe una configuracion local privada en
`.mobile-release.local.env` y una boveda local `.mobile-release/`, ambas
ignoradas por Git. La fuente recomendada para produccion sigue siendo Ristak
Installer; el archivo local guarda defaults operativos, rutas y fallback local.
Antes de publicar, se valida con `npm run mobile:release:check` para detectar
credenciales o archivos faltantes sin imprimir valores sensibles.
En iOS, la app SwiftUI de `ios/app` es la app oficial de App Store con bundle
`com.ristak.app`. El Installer mantiene tambien el perfil reservado para
`com.ristak.app.NotificationService` para la extension de notificaciones. Cada
bundle necesita su propio provisioning profile App Store, ambos ligados al mismo
certificado Apple Distribution. El perfil de la app principal debe incluir Push
Notifications y Communication Notifications
(`com.apple.developer.usernotifications.communication`) para que las push puedan
mostrar el avatar del contacto como remitente. La extension
`ios/app/RistakNotificationService` ya se embebe en la app con bundle
`com.ristak.app.NotificationService` y procesa `contactAvatarUrl` /
`senderAvatarUrl` como avatar de remitente; `notificationImageUrl` queda para
media real del mensaje. Ese enriquecimiento y `INSendMessageIntent` pertenecen
solo a `category=chat`: citas, pagos, prioridades de agente y otros eventos
conservan su titulo semantico y no reciben avatar de remitente. El contrato
visible de una cita nueva es `📅 Nueva Cita` con
`Contacto - 28 Mayo, 11:00 AM` en la zona horaria de la cuenta; el de un pago
exitoso es `💸 Nuevo Pago` con `Contacto ($20,000)` en la moneda del pago o
de la cuenta. Los estados no exitosos mantienen titulos especificos.
El topic APNs valido para la app Apple es exactamente `com.ristak.app`; el
Installer no debe reportar iOS configurado con un bundle legacy o Android. La
app registra el token con `platform=ios`, `clientType=native` y
`appPackage=com.ristak.app`. Permiso del sistema y registro confirmado por
backend son estados separados: Ajustes solo muestra alertas activas cuando ambos
estan listos. La activacion se serializa, usa reintentos 5/15/60/300 s y se
revalida en foreground si la confirmacion supera 6 h. Logout deshabilita el
device con `DELETE /api/push/mobile-devices` best-effort y siempre limpia APNs
local; 401/licencia revocada tambien ejecutan la limpieza local inmediata.
El mismo principio aplica a Android Play/Expo (`com.ristak.android`): permiso
concedido no significa token registrado. La app exige la confirmacion de
`POST /api/push/mobile-devices`, reintenta fallas de token o red con backoff
5/15/60/300 s y al volver a foreground, y solo entonces muestra
`Alertas activas`. La renovacion del token tambien reintenta su persistencia.
La Notification Service Extension serializa tareas/callbacks para finalizar una
sola vez, descarga avatar y media en paralelo con presupuesto visual total de
1.8 s y limita el avatar a 5 MB y la media adjunta a 12 MB; si no puede
enriquecer a tiempo, entrega inmediatamente la notificacion base. Cada push de
chat lleva ademas `content-available=1`: la app principal precarga el hilo
notificado y el inbox, fuerza el commit de snapshots y usa BGAppRefresh/tiempo
residual como respaldo best-effort. iOS decide cuando concede esas ventanas; un
cierre forzado no permite prometer ejecucion continua.
La apertura iOS sigue cambios del timeline y de la altura hasta terminar la
primera carga; un gesto del usuario cancela de inmediato el anclaje automatico.
Dos respuestas vacias que contradicen al inbox producen un error reintentable,
no un chat vacio exitoso. Las escrituras de hilo llevan version monotónica por
namespace/contacto y las cargas compartidas usan leases cancelables, de modo que
una respuesta vieja, un cambio de cuenta o la expiracion de BGTask no dejan red
ni cache obsoletas vivas.
El login de `com.ristak.app` muestra el isotipo Ristak libre de contenedores y el
wordmark oficial adaptado a claro/oscuro dentro de una cabecera pequena y
compacta. `Iniciar sesion` se presenta como subtitulo ligero, y la separacion
entre cabecera, subtitulo, campos y boton es corta y uniforme. Solo presenta los
campos `Correo` y `Contrasena`, sin subtitulo explicativo, correo de ejemplo ni
configuracion avanzada de servidor. La app resuelve automaticamente la
instalacion correcta por correo via
`https://www.ristak.com/api/mobile/resolve` antes de autenticar contra el backend
del cliente.
En Android hay dos contratos: el legacy Capacitor (`frontend/android`,
`com.ristak.app`) sigue usando FCM data-only para que
`RistakFirebaseMessagingService` dibuje la notificacion nativa; la app Play/Expo
(`mobile/`, `com.ristak.android`) conserva `clientType=expo` para builds legacy,
que reciben `message.notification` visible mas `message.data`. El build que
confirma su task headless usa `clientType=expo_background_v1` y solo los push de
chat para esa capacidad reciben FCM data-only; citas, pagos y demas eventos
conservan alerta remota visible. El payload de chat evita las llaves reservadas
de Expo y usa `ristakRelayTitle`/`ristakRelayBody`; el task precarga y emite una
alerta local deduplicada marcada para que el handler no la suprima. Ristak
Installer guarda cifrado el `google-services.json` de
Firebase para `com.ristak.android` como `mobile_android_google_services_json` y
lo entrega temporalmente al workflow de tienda; no se commitea en este repo.
Si el portal central reporta Android configurado, la instalacion cliente delega
al Installer los tokens Android cuando no tenga FCM local, igual que con iOS/APNs
central.

## Licenciamiento y distribucion

El licenciamiento central protege instalaciones managed Docker, feature flags y
límites de plan. El backend local valida licencia y plan con cache. El frontend
tambien oculta modulos o anticipa limites, pero el bloqueo real debe estar en
backend.

El límite de almacenamiento de PostgreSQL también se administra mediante el
Installer central. La app local reporta el tamaño real de la base a
`POST /api/license/database-storage/status`; el backend central consulta en Render
la capacidad efectiva, el estado del autoscaling y la decisión guardada para el
siguiente salto. Al 80% de uso, si todavía no hay decisión, el Installer pausa el
autoscaling y la app muestra a un administrador con permiso `settings_account`
un modal no descartable con los costos de almacenamiento de Render en USD.

La autorización por `POST /api/license/database-storage/decision` reactiva el
autoscaling para que Render pueda ampliar el disco al 90%. Rechazar exige una
segunda confirmación escrita, mantiene el autoscaling apagado y conserva un aviso
de riesgo con opción de cambiar la decisión. Render factura ese almacenamiento
directamente al cliente y sus discos no pueden reducirse. Si la base se llena,
puede ser suspendida y Ristak dejará de guardar información o funcionar. Cada
nuevo salto de capacidad requiere una decisión nueva. Las instalaciones sin
credenciales administradas de Render sólo reciben el aviso de riesgo y nunca
acciones falsas.

Documento: `docs/LICENSING.md`.

Variables y datos sensibles de licencia:

- `LICENSE_SERVER_URL`
- `CLIENT_ID`
- `LICENSE_KEY`
- `INSTALLATION_ID`
- aliases `RISTAK_*` cuando apliquen

No escribir valores reales en docs.

## Configuracion sensible

Regla del proyecto: el unico secret idealmente obligatorio para arrancar debe ser
la base de datos. Todo lo que pueda administrarse desde la app debe vivir en DB o
config interna, con cifrado cuando aplique.

Registro de ubicacion:

| Configuracion | Vive en | Obligatoria para arrancar | Notas |
| --- | --- | --- | --- |
| Base de datos produccion | `DATABASE_URL` | Si en Render/Postgres | SQLite local si no existe |
| URL publica/CORS | `APP_URL`, `PUBLIC_URL`, `RENDER_EXTERNAL_URL`, `CORS_ALLOWED_ORIGINS` | No siempre | Necesaria para webhooks y links correctos |
| HighLevel | `highlevel_config` y servicios HighLevel | No | Tokens deben estar cifrados o gestionados internamente |
| Meta Ads/Dataset/social | OAuth `ads|social` cifrado en `meta_oauth_integrations` y sesiones en `meta_oauth_integration_sessions`; login combinado legacy en `meta_config` con allowlist/sesiones propias; App Secret, Config IDs y `meta_oauth_review_mode` en DB de Installer | No | Ads se conecta con permisos aprobados; Social se habilita al terminar App Review. Manual queda como compatibilidad y `meta_test_event_code` activa Test Events |
| Pagos | config interna de pagos y metadata por provider | No | Modo `test/live` debe persistir por pago |
| Correo SMTP/IMAP | `app_config.email_smtp_config` y `app_config.email_smtp_password` | No | App password cifrado; requerido para enviar y recibir correos cuando la integracion esta activa |
| Moneda de cuenta | `app_config.account_currency` | No | Default obligatorio para importes nuevos; no crear env/secret de moneda |
| Bunny/media | `storage_settings`, env fallback, licencia central | No | API keys nunca en docs |
| Push web/movil | env VAPID/FCM/APNS o configuracion segura | No | Provider puede exigir secrets externos |
| Licencia central | env `LICENSE_*`/`RISTAK_*` | En instalaciones managed | No exponer valores |
| IA providers | configuracion segura/env segun provider | No | No hardcodear API keys |
| OAuth/API externa | DB OAuth/tokens hasheados/cifrados | No | Tokens nunca en texto plano |

## Reglas criticas antes de tocar codigo

- Fechas/horas: lee `docs/DATE_TIME_GUIDELINES.md`.
- Moneda/currency/importes: lee `docs/CURRENCY_GUIDELINES.md` y usa la moneda de
  cuenta como default.
- UI desktop: lee `docs/DESIGN_SYSTEM.md`, usa componentes comunes y corre
  `cd frontend && npm run design:audit`.
- Crons de integraciones: lee `docs/INTEGRATION_CRON_RULES.md`.
- Pagos/Meta: conserva bloqueo de pagos test a conversiones reales.
- Secrets: nunca documentes valores reales.
- Permisos: frontend no es frontera de seguridad.
- Worktrees: una tarea, una rama limpia, dependencias propias.

## Validacion recomendada

Usa validacion proporcional al cambio:

- Docs solamente: `git diff --check`.
- Backend servicios/rutas: `cd backend && npm test` o test especifico.
- Pagos/Meta: `cd backend && node --test --test-concurrency=1 test/metaPaymentPurchaseEvent.test.mjs`.
- Frontend TS: `cd frontend && npm run typecheck`.
- UI desktop: `cd frontend && npm run design:audit` y build si aplica.
- Build completo: `npm run build`.

## Como documentar cambios futuros

1. Identifica el dominio del cambio.
2. Actualiza la seccion correspondiente en este manual.
3. Si hay documento especializado, actualizalo tambien.
4. Si agregas documento nuevo, enlazalo en `docs/README.md`.
5. Si cambias reglas para agentes, actualiza `AGENTS.md`.
6. En tu respuesta final, explica que vera el usuario y que docs tocaste.
