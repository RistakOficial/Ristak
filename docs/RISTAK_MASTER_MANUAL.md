# Manual maestro de Ristak

Ultima consolidacion: 2026-07-01.

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
| Movil nativo | Capacitor |
| Deploy | Render Blueprint / web service |
| Pagos | Stripe, Conekta, Mercado Pago, HighLevel invoices |
| IA | OpenAI Agents / providers configurables |

Comandos principales:

- Frontend: `cd frontend && npm run typecheck`, `npm run design:audit`, `npm run build`.
- Backend: `cd backend && npm test`.
- Raiz: `npm run build`, `npm start`.
- Docs: `git diff --check` para validar whitespace basico.

## Estructura del repo

- `backend/src/server.js`: entrada del backend, middlewares, rutas, health,
  startup runtime, crons y servidor de frontend en produccion.
- `backend/src/routes/`: rutas HTTP agrupadas por dominio.
- `backend/src/controllers/`: controladores con validacion HTTP y respuesta.
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
   - espera base de datos,
   - corre migraciones,
   - inicializa llave de cifrado,
   - asegura usuario inicial/default,
   - sincroniza estado de licencia,
   - inicializa version Meta,
   - repara o verifica tareas pendientes de webhooks/pagos/templates/media,
   - arranca schedulers de sistema,
   - sincroniza crons registrados por integracion.

El proceso tiene soporte de shutdown graceful y estado de drain para deploys.

## Rutas backend principales

Rutas protegidas por auth y/o feature flags:

- `/api/auth`: setup, login, SSO, reset password, usuarios, perfil, API token.
- `/api/dashboard`: metricas principales.
- `/api/contacts`: contactos, chats, tags, custom fields, bulk actions.
- `/api/contact-tags`: etiquetas y carpetas.
- `/api/transactions`: pagos/transacciones.
- `/api/products`: productos y precios.
- `/api/subscriptions`: suscripciones.
- `/api/stripe`, `/api/conekta`, `/api/mercadopago`: pasarelas.
- `/api/highlevel`: conexion, sync, invoices, productos, calendarios y conversaciones.
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

Rutas publicas:

- `/setup`: configuracion inicial.
- `/login`, `/sso`, `/reset-password`.
- `/license-blocked`.
- `/pay/success` y `/pay/:publicPaymentId`.
- rutas moviles de tenant/login.

Shell movil:

- Vive bajo el prefijo movil (`/movil` en la app actual).
- Incluye chat, pagos, analiticas, calendario, ajustes y secciones moviles.
- Las rutas legacy `/phone/*` redirigen al shell nuevo.

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
- `/ai-agent`
- `/mdp-program`
- `/settings`

Configuracion se organiza en:

- Cuenta: cuenta, usuarios, notificaciones, aplicacion movil.
- Integraciones: HighLevel, Meta, WhatsApp, correos, pagos, calendarios.
- Datos y rastreo: rastreo web, dominios, costos, media.
- Personalizacion: campos, variables, trigger links, etiquetas.
- Avanzado: Developers.

Las tablas de Configuracion que permiten seleccion multiple usan el patron
compartido de `Table` con acciones integradas en una sola barra dentro del
encabezado de la tabla. No deben crear barras locales separadas ni partir los
controles de mover, sincronizar o eliminar en filas independientes; ese
comportamiento debe reutilizar `TableSelectionToolbar`.

## Permisos, licencia y acceso

Hay tres capas distintas:

1. Auth: el usuario debe tener sesion valida.
2. Licencia/plan: `requireActiveLicense` y `requireFeature(...)` bloquean
   acceso si la licencia central no permite el modulo.
3. Permisos de usuario: `requireModuleAccess(moduleKey)` valida lectura/escritura
   por modulo.

No basta con esconder botones en frontend. Cualquier endpoint que escriba o lea
datos sensibles debe tener validacion de backend.

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
  attendance signals, reminders, confirmation windows.
- Sites/tracking: `public_sites`, `public_site_blocks`, submissions, imports,
  assets, folders, `sessions`, video playback sessions/events, identity matches.
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
- Detalle con historial y actividad.
- Tags y carpetas.
- Campos personalizados y variables. El catalogo de campos personalizados vive
  en Configuracion > Campos personalizados y se muestra completo en la ficha de
  contacto, el panel derecho del chat desktop y la info de contacto del chat
  movil. Las carpetas del catalogo se respetan como secciones desplegables; los
  campos sin carpeta quedan bajo "Campos personalizados". La edicion se guarda
  como actualizacion manual del contacto y conserva el flujo normal de
  automatizaciones.
- Telefonos normalizados.
- Filtros ocultos.
- Acciones masivas con job propio.
- Atribucion por UTMs, click IDs, WhatsApp referrals, Meta y tracking identity.

Los contactos alimentan reportes, automations, chat, pagos, citas y conversiones.

## Chat y mensajeria

Ristak maneja varias superficies de comunicacion:

- Bandeja desktop.
- Chat movil.
- WhatsApp API/YCloud.
- WhatsApp QR/legacy cuando aplica.
- Meta social messaging.
- Email.
- Eventos live para sincronizar UI.

La mensajeria usa servicios especializados para plantillas, media, atribucion,
sincronizacion de conversaciones, read states, presencia y eventos.

La bandeja desktop de Chat (`/chat` y subrutas) es una superficie de trabajo
propia y no debe montar el globo global del Asistente Personal AI, para no tapar
el historial, composer ni acciones rapidas del chat. El asistente interno sigue
disponible desde las rutas dedicadas de Ristak AI en el menu lateral.

En `/chat` y en el chat movil bajo `/movil`, el historial de conversacion acepta
drag and drop de archivos. Mientras el usuario arrastra archivos sobre el area de
mensajes, la superficie se cubre con un overlay borroso con el texto `Suelta tu
archivo aqui`; al soltar, los archivos se agregan como adjuntos del composer
antes de enviar, para que el usuario pueda escribir texto o agregar mas archivos.
El correo queda fuera de este flujo hasta que su manejo de adjuntos se cierre en
la superficie de email.

Los adjuntos manuales del chat soportan imagenes, videos, audios y documentos
compatibles. Si un video o audio cabe como media directa, la UI pregunta si debe
mandarse como video/nota de voz o como archivo. Si excede el limite de media
directa pero cabe como documento, se clasifica automaticamente como archivo. En
WhatsApp API/QR los adjuntos usan las rutas nativas de imagen, video, audio o
documento segun esa decision. En Messenger/Instagram nativo el chat conserva
texto solamente; si HighLevel esta conectado, los adjuntos se publican primero
como URLs publicas y se envian por `attachments` de HighLevel.

La lista de chats se carga por lotes de 50 conversaciones. Al abrir una
conversacion, el frontend pide solo los ultimos 50 mensajes combinados del hilo
(`chatMessagesOnly` + `messageLimit`) y conserva el historial ya visible durante
refresh silenciosos. Si el usuario sube al inicio de la conversacion, la UI pide
otro bloque anterior usando `beforeMessageDate`; no debe precargar el historial
completo de todas las conversaciones de la bandeja. Al insertar mensajes antiguos
arriba del hilo, la UI debe conservar la posicion visible del usuario y nunca
forzar scroll al ultimo mensaje.

Antes de mandar mensajes libres por WhatsApp API/YCloud, `whatsappApiService`
debe revisar la ultima respuesta entrante del cliente para ese contacto y numero
de negocio. Si la ventana de 24 horas ya esta cerrada, no debe intentar YCloud:
debe usar WhatsApp QR/Baileys directamente cuando exista un QR usable. Las
plantillas quedan fuera de este bloqueo porque son el camino permitido por
WhatsApp cuando la conversacion esta cerrada.

Cuando una foto se envia por WhatsApp API/YCloud usando media ID del proveedor,
Ristak debe guardar una copia de preview en `mediaStorageService` y persistir su
`media_url` en `whatsapp_api_messages`. WhatsApp no debe recibir ese link si el
proveedor acepta media ID, pero el historial interno si lo necesita para pintar
la imagen en la burbuja del chat en vez de mostrar solo el nombre del archivo.

Cuando un envio saliente intenta WhatsApp API/YCloud y la API lo rechaza por una
restriccion recuperable o por la ventana de 24 horas, `whatsappApiService` debe
usar WhatsApp QR/Baileys como respaldo si el numero tiene QR habilitado y
conectado. Si el respaldo QR confirma el envio, el historial y la respuesta al
frontend deben quedar como mensaje `qr` exitoso, sin exponer el error de la API
en el globo del chat. La burbuja del chat debe mostrar solo el contenido y la
etiqueta `QR`; la razon tecnica de ruteo/fallback no debe pintarse como nota
debajo del mensaje cuando el envio QR fue exitoso. Si Baileys captura despues el
eco saliente de un mensaje que coincide con un registro API fallido, ese
registro debe repararse como enviado por `qr`, limpiando `error_code` y
`error_message`. Si despues llega un
webhook tardio de WhatsApp API con estado `failed` para un mensaje que ya quedo
resuelto por QR, el historial debe conservar el transporte `qr` y mantener
limpios esos campos de error. Solo se guarda error visible cuando no existe
respaldo QR usable o cuando el respaldo QR tambien falla.
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

El respaldo QR se resuelve por telefono, no solo por el id exacto del numero API.
Si el numero oficial y la conexion QR quedaron en filas distintas de
`whatsapp_api_phone_numbers`, el backend debe localizar la fila QR del mismo
telefono (`phone_number`, `display_phone_number` o `qr_connected_phone`) y enviar
desde ahi. Tambien cuenta como usable una sesion QR conectada o en reconexion
tecnica (`connected`, `reconnecting`, `restarting`, `connection_replaced` o
`disconnected_*`); estados terminales como `logged_out`, `bad_session` o
`number_mismatch` requieren escanear un QR nuevo y no se usan como respaldo
automatico.

En las listas y separadores del chat, los mensajes del dia actual muestran hora
o `Hoy`, los del dia anterior muestran `Ayer`, y los anteriores usan fecha
compacta sin `de` (`29 junio`, agregando año solo si no pertenece al año actual).
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
- Si Meta esta configurado con dataset/pixel y token guardado, los calendarios
  locales nuevos activan `customEvents.enabled` por default para mandar `Schedule`
  al agendar. Ediciones posteriores respetan el apagado manual del usuario.
- Si el contacto que agenda viene de una conversacion Meta, el canal `smart`
  manda la conversion por CAPI con `action_source=business_messaging`: WhatsApp
  usa `ctwa_clid`, Messenger usa `page_scoped_user_id` + `page_id` e Instagram
  usa `ig_sid` + `ig_account_id`. En esos canales de mensajeria el
  evento de cita se normaliza a `LeadSubmitted`; el evento web sigue usando
  `Schedule`.

Documentacion especifica:

- `backend/src/services/README_CALENDARS.md`
- `frontend/src/pages/Appointments/README.md`

## Pagos

Ristak soporta:

- Cobros publicos por link.
- Stripe.
- Conekta.
- Mercado Pago.
- HighLevel invoices.
- Productos/precios.
- Planes de pago.
- Suscripciones.
- Tarjetas/metodos guardados.
- Recibos y previews.
- Payment flows con estados y reparaciones.
- Automatizaciones al completarse pagos.

El modo de pasarelas puede ser `test` o `live`. Ese modo debe viajar con el pago
en `payment_mode` o metadata equivalente para evitar mezclar pruebas con dinero
real.

### Moneda de cuenta

La moneda default de Ristak siempre es la configurada en la cuenta. La fuente de
verdad es `app_config.account_currency`, expuesta en Configuracion > Cuenta y
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

Documento obligatorio: `docs/CURRENCY_GUIDELINES.md`.

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
- En compras con canal `smart`, si el contacto tiene atribucion de WhatsApp,
  Messenger o Instagram, la conversion se manda server-side como
  `business_messaging` y el pixel publico del checkout no se genera para evitar
  doble conteo.
- Tests: `backend/test/metaPaymentPurchaseEvent.test.mjs`.

Esta regla existe para que los reportes de Meta no se contaminen con compras de
prueba. No la debilites por comodidad.

## Meta, tracking y atribucion

Ristak usa Meta en varias areas:

- Meta Ads config y sync.
- Dataset Test en la UI de Configuracion > Meta; las rutas internas pueden
  conservar `pixel` por contrato con Meta y tracking.
- En Dataset Test, los eventos web usan `action_source=website`; los eventos
  `LeadSubmitted (Messaging)` y `Purchase (Messaging)` usan
  `action_source=business_messaging` y permiten probar WhatsApp, Messenger o
  Instagram DM desde la UI. WhatsApp requiere `ctwa_clid` + `page_id`;
  Messenger requiere `page_scoped_user_id` + `page_id`; Instagram requiere
  `ig_sid` + `ig_account_id`. La Page/Instagram se toma de la
  configuracion detectada por el wizard de Meta. `Purchase (Messaging)` se
  envia a Meta como `event_name=Purchase` y usa por default la moneda de la
  cuenta (`app_config.account_currency`).
- Conversions API usa siempre el System User Access Token guardado en
  `meta_config.access_token` (o `META_ACCESS_TOKEN` como fallback). No hay un
  token separado para CAPI: no se pide, no se genera y no se sincroniza.
- Cuando Meta ya tiene dataset/pixel y token guardado, las nuevas superficies nacen
  con eventos Meta encendidos por default: Sites/landings usan `ViewContent` al
  aterrizar, formularios usan `Lead` al enviar y calendarios usan `Schedule` al
  agendar. El usuario puede apagarlos manualmente despues.
- Las conversiones server-side de mensajeria Meta comparten el mismo servicio:
  WhatsApp, Messenger e Instagram usan `action_source=business_messaging` con
  `messaging_channel` segun el canal real. `Purchase` conserva `event_name=Purchase`
  y toma `currency` desde la cuenta; las citas de mensajeria usan
  `LeadSubmitted`.
- Social messaging.
- Business Messaging events.
- Campaign Builder en modo preview/validacion segun entorno.
- Test Events desde Configuracion > Meta.

Tracking:

- `/snip.js` instala el pixel Ristak.
- `/collect` y rutas de tracking guardan eventos.
- `sessions` conserva evento/sesion/visitante, UTMs, click IDs, geo, device,
  identidad y matching.
- Sites y formularios pueden emitir eventos Meta y Ristak.

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

La ruta publica puede depender de dominio, slug, host o rutas internas. Cualquier
cambio a Sites debe revisar editor, renderer publico, submissions y tracking.
Cuando Meta ya tiene dataset/pixel y token guardado, los sitios nuevos activan
Meta CAPI por default. Las landings nuevas encienden `ViewContent` al aterrizar
la pagina; los formularios nativos/importados/creados por IA encienden `Lead` al
enviar. Las actualizaciones de sitios existentes no reactivan eventos que el
usuario apago manualmente.

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

## Jobs y crons

Crons de sistema que pueden vivir activos:

- Mensajes programados.
- Acciones masivas de contactos.
- Recordatorios de citas.
- Automatizaciones de pago.
- Scheduler de automations.

Crons de integracion que deben pasar por registry y detector local:

- HighLevel sync.
- Meta sync/version.
- Google Calendar sync.
- WhatsApp QR watchdog.
- Stripe/Conekta/Mercado Pago payment plans.

Regla: un cron de integracion externa no arranca solo porque el backend arranco.
Debe activarse por estado local de conexion y sincronizarse al conectar,
desconectar o cambiar modo relevante.

## Media y Bunny

Media centraliza uploads, cuotas, storage provider, Bunny Storage y Bunny Stream.
El servicio principal es `backend/src/services/mediaStorageService.js`.

Capacidades:

- Upload desde archivo, buffer o data URL.
- Libreria de media.
- Soft delete, move, replace.
- Cuotas.
- Compresion.
- Bunny Storage para archivos.
- Bunny Stream para video.
- Sync/retry/diagnosticos.

Documento operativo: `docs/MEDIA_STORAGE_BUNNY.md`.

## IA

Ristak tiene dos superficies principales:

- `ai-agent`: asistente interno de operacion, busqueda, analisis y acciones con
  ledger de ejecucion.
- `conversational-agent`: agentes que interactuan con contactos y objetivos.

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
- MCP para clientes compatibles.

Los tokens se tratan como secretos. La documentacion solo debe indicar nombres,
ubicacion y uso, nunca valores.

## App movil

La app movil usa Capacitor y el shell web movil bajo el prefijo movil. Incluye
chat, pagos, analytics, calendario y ajustes.

Documentos:

- `docs/MOBILE_APP.md`
- `docs/MOBILE_STORE_RELEASES.md`

Las credenciales de stores no deben vivir en el repo. Los builds de tienda se
manejan con flujo manual/Installer segun el documento de releases.

## Licenciamiento y distribucion

El licenciamiento central protege instalaciones managed Docker y feature flags.
El backend local valida licencia y plan con cache. El frontend tambien oculta
modulos, pero el bloqueo real debe estar en backend.

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
| Meta Ads/Dataset | `meta_config`, `app_config`, env fallback | No | CAPI usa System User Token; `meta_test_event_code` activa Test Events |
| Pagos | config interna de pagos y metadata por provider | No | Modo `test/live` debe persistir por pago |
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
