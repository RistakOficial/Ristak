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
| Movil nativo | Capacitor para `/movil` en produccion; React Native/Expo en `mobile/` como cliente nativo nuevo |
| Deploy | Render Blueprint / web service |
| Pagos | Stripe, Conekta, Mercado Pago, CLIP, Rebill, HighLevel invoices |
| IA | OpenAI Agents / providers configurables |

Comandos principales:

- Frontend: `cd frontend && npm run typecheck`, `npm run design:audit`, `npm run build`.
- Backend: `cd backend && npm test`.
- Mobile React Native: `npm run mobile:native:typecheck`, `npm run mobile:native:start`, `npm run mobile:native:ios`, `npm run mobile:native:android`.
- Raiz: `npm run build`, `npm start`.
- Docs: `git diff --check` para validar whitespace basico.

## Estructura del repo

- `backend/src/server.js`: entrada del backend, middlewares, rutas, health,
  startup runtime, crons y servidor de frontend en produccion.
- `backend/src/routes/`: rutas HTTP agrupadas por dominio.
- `backend/src/controllers/`: controladores con validacion HTTP y respuesta.
- `mobile/`: app React Native/Expo nueva para iOS/Android. Convive con el shell
  Capacitor de `/movil` y debe mantenerse sincronizada con cualquier cambio de
  producto movil que tambien afecte al shell publicado.
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
- `/api/payment-events`: stream interno SSE para refrescar pantallas de pagos.
- `/api/stripe`, `/api/conekta`, `/api/mercadopago`, `/api/clip`, `/api/rebill`: pasarelas.
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
- `/login` usa el isotipo nuevo de Ristak (`RistakAppMark`) con nombre visible
  y contexto de inicio de sesion. Los estados de carga inicial del CRM en
  escritorio y movil usan `AppStartupLoader`/`PhoneStartupLoader` sin logo ni
  nombre visible: solo un indicador minimo y accesible sobre el fondo del tema.
  La app nativa en `mobile/` es la excepcion: `BootScreen` y el login nativo
  muestran el logo oficial transparente de modo noche, y `mobile/app.json` usa
  los iconos oficiales light/dark para el launcher iOS/Android.
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
- `/ai-agent`
- `/mdp-program`
- `/settings`

Configuracion se organiza en:

- Cuenta: cuenta, usuarios, notificaciones, privacidad, aplicacion movil.
- Integraciones: HighLevel, Meta, WhatsApp, correos, pagos, calendarios.
- Datos y rastreo: rastreo web, dominios, costos, media.
- Personalizacion: campos, variables, trigger links, etiquetas.
- Avanzado: Developers.

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

El modulo `ai_agent` puede dividirse por feature de licencia: `app_assistant_ai`
habilita Ristak AI general y `conversational_ai` habilita el Agente conversacional.
El plan basico puede abrir solo `conversational_ai` y limitar la creacion a
`limits.conversational_agents.max_agents=1`.

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
  `Cliente` se activa con cualquier pago exitoso del contacto, incluyendo
  `payment_mode = test`, para poder probar checkouts sandbox de punta a punta.
  Las metricas financieras de la lista (`total_paid`, LTV, conteos live y
  reportes de ingresos) siguen excluyendo pagos test.
- La pantalla `/contacts` usa paginacion real del lado servidor. La tabla pide
  solamente la pagina visible (20 contactos) con el rango, busqueda, filtro
  rapido, condiciones avanzadas y orden activo; no debe cargar el CRM completo en
  segundo plano para simular paginacion local. Al cambiar de fecha, filtro,
  busqueda u orden vuelve a la pagina 1; al avanzar de pagina se consulta solo
  ese batch.
- Las tarjetas KPI de Contactos no son metricas de la pagina visible: resumen el
  conjunto completo que coincide con el rango y filtros activos. `/api/contacts/stats`
  debe reutilizar los mismos filtros de `/api/contacts` sin `limit/offset`, para
  que totales, clientes, LTV y promedio sigan siendo correctos aunque la tabla
  muestre solo un batch. La ficha/modal del contacto hidrata el detalle completo
  al abrirse; la lista debe usar datos suficientes para la tabla y no bloquearse
  por datos pesados de contactos que no estan visibles.
- Acciones masivas con job propio.
- Atribucion por UTMs, click IDs, WhatsApp referrals, Meta y tracking identity.
- `contacts.attribution_ad_id` y `contacts.attribution_ad_name` representan el
  primer registro/adquisicion inicial del contacto. Una vez que el contacto tiene
  un anuncio real, esos campos no se pisan por retargeting, reactivaciones,
  mensajes posteriores ni marcadores `rstkad_id`; los anuncios posteriores se
  conservan como touches del historial (`whatsapp_api_attribution`, sesiones o
  mensajes sociales) para conversiones.
- Reportes en vista `Identificados de anuncios` y Publicidad miden registros por
  `contacts.created_at` + `contacts.attribution_ad_id`, validando que el anuncio
  exista en `meta_ads` el mismo dia local de creacion del contacto. Por eso ese
  `ad_id` debe quedarse congelado como origen de registro.
- El Viaje del Cliente en la ficha debe mostrar cada actividad con una etiqueta
  legible: visitas, contactos, WhatsApp, Messenger, Instagram, correo, citas y
  compras. Si un evento trae metadata de mensaje social o email, el tooltip debe
  explicar canal, contenido, perfil/usuario, estado e identificadores utiles; no
  debe quedarse como "Evento" sin detalle. Los mensajes de WhatsApp se resumen
  en marcadores diarios por canal y los eventos de Messenger/Instagram se
  resumen por dia local, plataforma y tipo de accion (`message` vs `comment`).
  Asi un DM y un comentario del mismo dia no se pisan entre si, pero cinco
  comentarios del mismo dia siguen contando como un solo punto de comentario.
  Los marcadores visuales de Messenger e Instagram deben diferenciar DM privado
  vs comentario con iconografia de plataforma y accion, no con el mismo glifo
  generico para todo.

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
mensajes, la superficie se cubre con un overlay borroso con borde punteado y el
texto `Suelta aquí tu contenido multimedia`; al soltar, los archivos se agregan
como adjuntos del composer antes de enviar, para que el usuario pueda escribir
texto o agregar mas archivos.
El correo queda fuera de este flujo hasta que su manejo de adjuntos se cierre en
la superficie de email.

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

En `/chat` desktop, los mensajes entrantes de WhatsApp que vienen de un anuncio
deben mostrar una vista previa compacta del anuncio dentro del globo antes del
texto del contacto. La tarjeta se arma con `is_ad_attributed`,
`referral_source_id`, `referral_ctwa_clid`, `referral_source_url`,
`referral_headline` y `referral_body`; cuando el backend ya enriquecio el evento
con `meta_ads`, usa `creative_image_url`/`creative_thumbnail_url`,
`creative_preview_url`, campana, conjunto y nombre del anuncio. Si no hay senal
real de anuncio, el chat no debe inventar previews ni decorar mensajes directos.
Como fallback operativo, si el texto recibido contiene el marcador
`rstkad_id=<ad_id>!`, Ristak extrae solo los digitos entre `=` y `!`, lo trata
como `referral_source_id` de anuncio y oculta ese marcador del texto visible del
mensaje. El `!` es obligatorio para no atribuir por accidente otros numeros que
el contacto haya escrito.

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
`/movil` pinten el quote y peguen el emoji al globo correcto.

Cuando el usuario abre o marca como leida una conversacion movil, el estado local
se actualiza en `chat_read_states` y el backend debe encolar en background el
acuse externo del canal cuando exista soporte nativo: WhatsApp API/YCloud usa
`/whatsapp/inboundMessages/{id}/markAsRead` con `wamid` o id de YCloud,
WhatsApp QR/Baileys usa `sock.readMessages([{ remoteJid, id, fromMe }])`, y
Messenger/Instagram usan `sender_action='mark_seen'`. Correo no participa en
este contrato porque no es chat conversacional. El acuse externo puede tardar,
fallar o agotar timeout sin bloquear la respuesta local del chat, pero debe
quedar registrado en logs porque no equivale a visto real del proveedor.
Configuracion > Privacidad guarda
`app_config.chat_send_read_receipts_enabled`: si esta apagado, Ristak conserva
el marcado local como leido, pero no manda acuses externos de visto a WhatsApp
API/YCloud, WhatsApp QR/Baileys, Messenger ni Instagram.

En el chat movil, el selector de canal del composer no debe mostrar rutas
fantasma: lista cada numero de WhatsApp conectado como opcion separada y envia el
`phoneNumberId` elegido en texto, adjuntos, ubicacion y mensajes programados.
SMS aparece solo si HighLevel esta conectado, y Messenger/Instagram solo cuando
Meta esta conectado y el contacto pertenece a ese canal.

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
como OGG/Opus (`audio/ogg; codecs=opus`) cuando el canal requiere nota de voz. En
`/chat` desktop, las burbujas de media deben mostrar solo el contenido principal:
foto/video completo, audio con icono/control del lado izquierdo o mapa completo.
La hora, etiqueta de transporte, vistos y razones de ruteo viven fuera/debajo de
la burbuja para no crear columnas internas. Los errores de envio no se escriben
dentro del globo: se muestran como icono externo con detalle en tooltip. En
Messenger/Instagram nativo el chat conserva texto solamente; si HighLevel esta
conectado, los adjuntos se publican primero como URLs publicas y se envian por
`attachments` de HighLevel.

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
conversacion, el frontend pide solo los ultimos 50 mensajes combinados del hilo
(`chatMessagesOnly` + `messageLimit`) y conserva el historial ya visible durante
refresh silenciosos. Si el usuario sube al inicio de la conversacion, la UI pide
otro bloque anterior usando `beforeMessageDate`; no debe precargar el historial
completo de todas las conversaciones de la bandeja. Al insertar mensajes antiguos
arriba del hilo, la UI debe conservar la posicion visible del usuario y nunca
forzar scroll al ultimo mensaje.

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
`warmProfilePictures=true` para hidratar y guardar avatares mientras cargan, con
limites por pagina para no bloquear la UI. Para corregir contactos ya existentes
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

Antes de mandar mensajes libres por WhatsApp API/YCloud, `whatsappApiService`
debe revisar la ultima respuesta entrante del cliente para ese contacto y numero
de negocio. Si la ventana de 24 horas ya esta cerrada o no existe una respuesta
entrante comprobable, no debe intentar YCloud: debe usar WhatsApp QR/Baileys
directamente cuando exista un QR usable. Desktop y movil deben calcular el mismo
transporte antes de pintar el mensaje optimista para evitar duplicados visuales
API/QR. Las plantillas quedan fuera de este bloqueo porque son el camino permitido
por WhatsApp cuando la conversacion esta cerrada.

En los chats desktop y movil, el selector para enviar o programar plantillas de
WhatsApp API debe listar solo plantillas con estado `APPROVED`. Las plantillas
rechazadas, pausadas, archivadas, pendientes o en apelacion pueden mostrarse en
las vistas de revision/estado, pero no deben aparecer como opcion seleccionable
en el flujo de envio.

Los mensajes programados del chat deben guardar proveedor/canal de forma
explicita. En movil, WhatsApp usa `provider='whatsapp_api'` con `transport='api'`
y SMS usa `provider='highlevel'` con `channel='sms_qr'`; Messenger, Instagram y
correo no se programan desde la app nativa hasta tener scheduler real para esos
canales.

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
`pago_fallido_reintento`. El backfill de arranque compara esas plantillas contra
la definicion vigente del sistema; si una copia existente esta editable, actualiza
el copy/variables/botones y la reenvia a revision como edicion. Si Meta/YCloud la
tiene en revision, Ristak no la pisa y espera el resultado. Las plantillas de pago
usan botones web `PUBLIC_URL/pay/{{1}}`; el ejemplo dinamico del boton sale de
`payment.public_id` o `payment.receipt_path` segun corresponda, nunca de una URL
fija de otra instalacion.

Al reenviar a revision una plantilla que ya existe en Meta/YCloud, Ristak debe
editarla por `wabaId + name + language` en vez de intentar crear otra con el
mismo nombre. Si la copia local no tiene la identidad remota pero YCloud responde
que esa plantilla ya existe, el submit debe reintentarse como edicion y dejar la
plantilla local en revision. Las plantillas archivadas o en revision no se editan
desde Ristak; se debe esperar el resultado o crear una nueva con otro nombre.

Cuando una foto se envia por WhatsApp API/YCloud usando media ID del proveedor,
Ristak debe guardar una copia de preview en `mediaStorageService` y persistir su
`media_url` en `whatsapp_api_messages`. WhatsApp no debe recibir ese link si el
proveedor acepta media ID, pero el historial interno si lo necesita para pintar
la imagen en la burbuja del chat en vez de mostrar solo el nombre del archivo.
Si el mismo numero tambien tiene WhatsApp QR/Baileys conectado, el eco saliente
que WhatsApp Web emite para esa foto no debe crear una segunda burbuja `QR` con
el texto generico `Foto`. El backend debe marcar los envios API originados por
Ristak y deduplicar ecos recientes de media sin caption por telefono, direccion,
tipo de mensaje y ventana temporal antes de persistirlos como mensajes nuevos.

Los mensajes entrantes estructurados de WhatsApp (plantillas, botones, listas,
OTP/copy-code e interactivos) no deben degradarse a la etiqueta generica
`Mensaje`. En WhatsApp QR/Baileys y WhatsApp API/YCloud, el backend debe extraer
el cuerpo visible, footer y acciones legibles y persistirlos en
`whatsapp_api_messages.message_text` para que `/chat` y `/movil` pinten el mismo
contenido que el usuario ve en WhatsApp.

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
Para media manual (foto, video, audio o documento), el fallback por ventana
cerrada debe conservar el tipo real del contenido: una foto fuera de 24 horas se
manda por WhatsApp QR como imagen, no como mensaje de texto ni como placeholder
`Foto`.

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

El respaldo QR se resuelve por telefono, no solo por el id exacto del numero API.
Si el numero oficial y la conexion QR quedaron en filas distintas de
`whatsapp_api_phone_numbers`, el backend debe localizar la fila QR del mismo
telefono (`phone_number`, `display_phone_number` o `qr_connected_phone`) y enviar
desde ahi. Tambien cuenta como usable una sesion QR conectada o en reconexion
tecnica (`connected`, `reconnecting`, `restarting`, `connection_replaced` o
`disconnected_*`); estados terminales como `logged_out`, `bad_session` o
`number_mismatch` requieren escanear un QR nuevo y no se usan como respaldo
automatico.

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
enviar desde ese remitente por default. El selector del composer puede seguir
cambiando el envio puntual, incluyendo cada WhatsApp conectado como opcion
separada, pero el panel/info del contacto es la fuente visible para decidir el
remitente preferido del contacto.

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
- Los calendarios publicos/embebidos reutilizan contactos existentes: si el
  correo ya existe en `contacts`, la cita se agenda sobre ese contacto aunque el
  telefono del formulario coincida con otro registro. Esto evita errores por el
  indice unico de email y permite que un cliente existente vuelva a agendar desde
  un sitio sin cambiar de correo.
- El formulario publico predeterminado de calendario pregunta nombre, correo y
  despues telefono. Los campos de telefono de calendario deben mostrar selector
  de pais/lada y normalizar el valor con la region elegida; si el visitante no la
  cambia, se usa region detectada o la configurada en la cuenta como respaldo.
  Cuando el contacto se autopobla desde otro formulario, la lada queda en el
  selector y el campo visible conserva solo el numero nacional, sin prefijos tipo
  `+52`, `52` o `+1` duplicados dentro del input.
- Si el visitante llega desde un formulario/Site con `contactId` validado por la
  misma sesion/visitor, el calendario debe tratar ese registro como contacto
  activo del flujo. Si la persona corrige nombre, telefono o correo al agendar,
  se actualiza ese contacto activo en lugar de crear o escoger otro por datos
  viejos del navegador. Si no hay identidad activa validable, se conserva la
  regla de reutilizar por correo y luego por telefono.
- Si Meta esta configurado con dataset/pixel y token guardado, los calendarios
  locales nuevos y los calendarios remotos espejados por primera vez activan
  `customEvents.enabled` por default para mandar `Schedule` al agendar. Ediciones
  posteriores y sincronizaciones de calendarios ya existentes respetan el apagado
  manual del usuario.
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
integraciones conectadas. Plan `basic` solo puede registrar pagos unicos offline
como efectivo, transferencia, deposito u otro pago confirmado. Planes de pago y
suscripciones no deben mostrarse en Basic. En planes `professional`/`pro`, si no
hay ninguna pasarela de pago conectada, la app movil tambien debe limitarse al
pago unico offline; los flujos avanzados aparecen solo cuando la licencia permite
`payment_plans`/`subscriptions` y existe al menos una pasarela conectada.

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

El modo de pasarelas puede ser `test` o `live`. Ese modo debe viajar con el pago
en `payment_mode` o metadata equivalente para evitar mezclar pruebas con dinero
real.

Cuando un webhook, retorno de pasarela o accion interna cambia un pago o una
suscripcion, el backend emite un evento por `/api/payment-events/stream`. Las
pantallas de Transacciones, Planes de pago y Suscripciones escuchan ese stream y
recargan solo la vista abierta. No se usa polling periodico para mantener esas
tablas vivas; la actualizacion depende del evento que dispara el cambio real.

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

Cuando se registra un pago manual, se cobra una tarjeta guardada o se agenda una
cita desde la app nativa, el contacto vuelve a su conversacion y el chat muestra
un marcador inline en la linea de mensajes. Ese marcador no es un globo del
cliente ni del negocio: es una anotacion de conversacion que indica que en ese
punto se completo un cobro o se agendo una cita. La accion tambien muestra una
confirmacion breve con check animado dentro del area del chat, sin cubrir el
header ni la informacion del contacto.

Un pago exitoso en modo `test` puede clasificar al contacto como `Cliente` dentro
del CRM y del filtro de Contactos para validar flujos sandbox. Ese mismo pago no
debe sumar a LTV, ingresos reales, ROAS, reportes financieros ni conversiones
reales de Meta.

### Tabla de transacciones

La tabla principal de `/transactions` usa paginacion real del lado servidor. La
pantalla pide solo la pagina visible de pagos (20 filas) con fecha, busqueda,
estado y orden; al cambiar cualquiera de esos filtros vuelve a la pagina 1. El
endpoint `/api/transactions` siempre debe devolver `pagination` y facets de
estado calculados sobre todo el resultado filtrado, no solo sobre las filas de la
pagina actual. Las tarjetas KPI de Pagos tampoco son metricas de la pagina
visible: `/api/transactions/summary` debe recalcular ingresos, pagos
completados, ticket promedio y reembolsos con los mismos filtros de fecha,
busqueda y estado seleccionados.

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

- Canales soportados: WhatsApp API, correo electronico o ambos.
- WhatsApp usa plantillas aprobadas y registra el despacho en
  `payment_automation_dispatches` con `channel='whatsapp'`.
- Correo electronico usa la conexion SMTP guardada en Configuracion > Integraciones
  > Correos. El password vive cifrado en `app_config.email_smtp_password`; no se
  agrega env var nueva para arrancar el servicio.
- Cada canal tiene su propio despacho idempotente por pago, tipo de automatizacion
  y canal. Un envio por WhatsApp no bloquea el envio por correo, y viceversa.
- `reminderDaysBefore` es un dia exacto, no una ventana acumulada: si esta en 3,
  el recordatorio solo se evalua para pagos que vencen exactamente tres dias
  despues del dia de negocio actual.
- En planes de pago locales, ese dia exacto no debe disparar varias parcialidades
  del mismo flujo en el mismo barrido. Si dos o mas cuotas del mismo
  `payment_flow` caen en el dia objetivo, Ristak solo envia el recordatorio de la
  siguiente parcialidad abierta; los pagos unicos y pagos de otros flujos siguen
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
inicio de la cita y las confirmaciones `after_booking` se anclan a la fecha de
reserva local en Ristak; citas sincronizadas desde Google/GHL no reciben
confirmaciones de reserva como si el cliente hubiera agendado por Ristak.

Cada par `reminder_id + appointment_id` se reclama en
`appointment_reminder_sends` antes de enviar para evitar duplicados. Estados
`sent`, `skipped` y `sending` bloquean nuevos envios. Si el intento termina en
`error`, el cron puede reintentarlo despues de 15 minutos, siempre que la hora de
envio siga dentro de la ventana util de 3 horas; si ya se paso esa ventana se
marca como omitido en vez de mandar un WhatsApp tarde.

### Planes de pago locales

En Stripe, Conekta y Mercado Pago, el calendario editable muestra y guarda cada
pago como `Pago N/M`, donde `N` es la posicion visible del pago y `M` es el total
actual del plan. Si el calendario se edita, por ejemplo de 3 a 6 pagos, Ristak
actualiza tambien los `title`/`description` de pagos existentes de `1/3` a `1/6`
sin cambiar importes, fechas ni estados ya registrados.

Los cobros automaticos de planes con tarjeta guardada deben reclamar localmente
la cuota o primer pago a `processing` antes de llamar a la pasarela. Stripe,
Conekta y Rebill usan este claim atomico mas los locks del cron para evitar doble
cargo ante solapes de deploy, ticks concurrentes o ejecuciones manuales. Mercado
Pago no cobra cuotas locales desde el cron; genera/libera links programados.

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
  Cuando el plan tiene tarjeta guardada, el cron cobra cada parcialidad vencida
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
  primeros pagos y parcialidades vencidas segun la zona horaria de la cuenta. Si
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
- Si Configuracion > Meta Ads tiene activo `meta_test_event_code`, el backend puede
  mandar el evento CAPI con `test_event_code`. Eso debe entrar a Meta Test
  Events, no a conversiones reales.
- Si no hay Dataset/Pixel conectado en Configuracion > Meta Ads, una compra `live`
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

- Meta Ads config y sync.
- Dataset Test en la UI de Configuracion > Meta Ads; las rutas internas pueden
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
- En Configuracion > Meta Ads, al editar el wizard o moverse entre sus pasos, la UI
  vuelve a consultar cuentas de anuncios, datasets/pixeles, Facebook Pages e
  Instagram disponibles con el System User Access Token guardado. El usuario no
  debe borrar y pegar de nuevo el token solo para que aparezcan activos recien
  asignados en Meta Business. Las selecciones dentro del wizard son borrador:
  elegir cuenta, dataset, Facebook Page o Instagram no dispara guardado ni
  sincronizacion inmediata; Ristak persiste la configuracion una sola vez al
  terminar el wizard. Al terminarlo, Ristak arranca automaticamente la
  sincronizacion de anuncios de Meta en segundo plano y lleva al usuario a
  `Configuracion > Meta Ads > Redes sociales`. Las Page nuevas dejan encendidos
  por default Messenger y comentarios de Facebook; Instagram DM requiere ademas
  `meta_config.instagram_access_token` y queda encendido si la conexion nueva ya
  trae cuenta de Instagram + token directo. Los comentarios de Instagram se
  controlan aparte desde la columna de Instagram.
- El bloque **Perfil de red social** del editor de Sites lee los perfiles desde
  la configuracion Meta guardada (`meta_config.page_id`,
  `meta_config.instagram_account_id` y `meta_config.access_token`) cuando el
  usuario ya esta autenticado en Ristak. El endpoint no debe interpretar el JWT
  de sesion de Ristak como token de Meta; solo usa `X-Meta-Access-Token` durante
  el wizard cuando se esta probando un token explicito. En sitios publicados, el
  refresh diario de Meta actualiza avatar, nombre y seguidores de bloques con
  `socialAutoSync=true`; si un bloque legacy no tiene `socialSourceProfileId`,
  puede adoptar el perfil configurado que coincida con su plataforma. Cuando el
  bloque vive dentro de un formulario nativo o un formulario embebido en Sites,
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
  `graph.facebook.com/{PAGE_ID}/messages` con token de Pagina derivado de
  `meta_config.access_token`; Instagram DM envia por
  `graph.instagram.com/{IG_ID}/messages` con el Instagram User access token
  guardado en `meta_config.instagram_access_token`, usando el IGSID recibido por
  webhook. Ese token se captura visible/editable en
  `Configuracion > Meta Ads > Redes sociales > Instagram` para pruebas, pero se
  guarda encriptado en base de datos. El valor esperado es el Instagram API /
  Instagram User access token generado en Meta Developers desde
  `Configuracion de la API con inicio de sesion de empresa de Instagram` >
  `Generar tokens de acceso` (normalmente prefijo `IGA...`). No usar el System
  User Access Token ni el Page/Messenger token aqui: esos tokens no sirven para
  leer perfiles de Instagram ni responder Instagram DM por la API de Instagram
  Login. Para perfil requiere `instagram_business_basic`; para DMs requiere
  `instagram_business_manage_messages`; para comentarios/mentions requiere
  `instagram_business_manage_comments`.
  Los switches son `meta_messenger_messaging_enabled` /
  `meta_instagram_messaging_enabled` para DMs y
  `meta_facebook_comments_enabled` / `meta_instagram_comments_enabled` para
  comentarios. Si Meta responde `(#3) Application does
  not have the capability...`, Ristak debe tratarlo como bloqueo de
  capability/App Review, no como fallo generico: Messenger requiere
  `pages_messaging`; Instagram DM con Instagram Login requiere
  `instagram_business_basic` e `instagram_business_manage_messages`, app en Live
  para clientes reales, Advanced Access cuando aplique y token regenerado despues
  de aprobar los permisos.
- Al conectar Meta con una Facebook Page, al guardar el Instagram API token o al
  prender `meta_messenger_messaging_enabled` / `meta_instagram_messaging_enabled`,
  Ristak inicia en segundo plano un backfill de conversaciones disponibles por
  Graph Conversations API: Messenger usa `/{PAGE_ID}/conversations` con Page
  token; Instagram usa `/me/conversations` por Instagram Graph con
  `meta_config.instagram_access_token`. El backfill pagina conversaciones y
  mensajes, deduplica por `meta_message_id`, guarda inbound/outbound en
  `meta_social_messages` y fusiona el contacto por PSID/IGSID igual que los
  webhooks. Es historial: no incrementa no leidos, no dispara push,
  automatizaciones, confirmaciones ni agente conversacional. Meta puede no
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
- El enriquecimiento de contactos Meta usa el mismo contrato separado:
  Messenger lee perfil/conversaciones por Facebook Graph con Page token;
  Instagram lee perfiles de DMs y autores de comentarios por Instagram Graph con
  `meta_config.instagram_access_token` (`name,username,profile_pic`). Si el
  perfil directo no trae nombre, Instagram cae a
  `graph.instagram.com/me/conversations`, nunca al Page ID ni al System User
  token. Las fotos recibidas se rehospedan best-effort antes de guardarse en
  `meta_social_contacts.profile_picture_url`; si Meta no entrega foto o permisos,
  Ristak conserva el mejor nombre disponible y no inventa avatar.
- Business Messaging events.
- Campaign Builder en modo preview/validacion segun entorno.
- Test Events desde Configuracion > Meta Ads.

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
Las acciones de formularios, calendarios, pagos y botones pueden avanzar a la
siguiente pagina, redirigir a una URL o ir a una pagina especifica del mismo
proyecto usando el selector de paginas de esa landing.
La biblioteca de sitios y formularios permite seleccionar varios elementos con
checkboxes en vista galeria, lista o tabla y eliminarlos juntos con confirmacion
destructiva. Los controles masivos de `Todos los visibles` y `Eliminar` aparecen
solo despues de marcar al menos un elemento; en vista tabla viven dentro de la
toolbar de seleccion comun de las tablas. Esta seleccion multiple no aparece
dentro del selector de paginas del editor de sitios; ahi las paginas se eliminan
una por una desde su menu.

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
`account_business_profile` (Configuracion > Cuenta) y usa el usuario admin activo
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

Para HTML importado con elementos nativos de Ristak, el contrato es declarar una
zona con `data-rstk-native-element="form|calendar|payment|video"` y
`data-rstk-native-id` unico. El editor detecta esas zonas y permite conectarlas
a bloques reales del sitio:

Los slots nativos que Ristak renderiza (`form`, `calendar` con
`data-rstk-native-render="ristak"`, `payment` y `video`) deben ser huecos
limpios: contenedores vacios, sin texto placeholder, mocks, tarjetas, bordes
punteados/dashed, outlines, fondos, sombras, iconos, labels, pseudo-elementos ni
wrappers decorativos dentro, detras o encima. El HTML externo solo decide la
ubicacion del bloque; Ristak pinta el formulario, calendario, checkout o video
completo con su propio diseno y configuracion. Si hace falta reservar espacio en
el layout, debe hacerse con estructura neutra sin borde/fondo visible para que
no quede UI falsa atras o encima del embed. La excepcion es `calendar` con
`data-rstk-native-render="custom"`, porque ahi el frontend importado si es el
calendario visual y solo se conecta a disponibilidad/agendado de Ristak.

- `form`: selecciona un formulario existente de Ristak. La zona debe ser un
  contenedor vacio; no debe incluir `<form>`, campos ni botones de envio dentro
  o pegados a esa zona, porque Ristak renderiza el formulario completo con su
  propio boton y sus acciones "Al enviar".
- `calendar` con `data-rstk-native-render="ristak"`: renderiza el calendario
  embebido normal y respeta disponibilidad, campos, pagos, reglas de completado
  y evento Meta "al agendar".
- `calendar` con `data-rstk-native-render="custom"`: conserva el frontend del
  HTML importado, pero expone `window.ristakCalendarGetSlots(slotId, params)` y
  `window.ristakCalendarBook(slotId, payload)` para mapearlo a un calendario de
  Ristak. `payload.startTime` debe ser ISO UTC y `payload.timezone` la zona
  horaria usada para la cita; el backend valida disponibilidad antes de crearla.
- `payment`: renderiza el checkout real de Ristak y usa la misma configuracion
  de pagos del editor. El `Purchase` sale solo del pago confirmado.
- `video`: renderiza el bloque de video real de Ristak con la misma subida/URL,
  controles, diseno, acciones por tiempo y eventos Meta/CAPI que el editor
  normal. En HTML importado no se ofrece la accion "Abrir formulario de video";
  las acciones esperadas son mostrar/ocultar elementos, ir a paginas del proyecto,
  popup, redireccion y eventos Meta cuando correspondan.

Las acciones de video en HTML importado solo deben apuntar a elementos
identificables y publicables: botones, links, formularios, secciones, imagenes o
contenedores con `id`, `data-rstk-edit-id`, `data-rstk-form-id`,
`data-rstk-section` o `data-rstk-native-id`. El editor filtra elementos
decorativos marcados como `data-rstk-edit-type="background_image"` o
`aria-hidden="true"` para no ofrecer fondos como targets. Cuando una accion
arranca con estado "Mantener oculto", el render importado marca el target con
`data-rstk-video-action-hidden="true"` desde el HTML inicial para evitar
parpadeos entre preview y sitio publicado.

En el editor HTML importado, estos elementos se configuran desde un inspector
derecho independiente del panel de codigo. El panel de codigo se conserva para
editar HTML/IA externa, mientras el inspector de elementos Ristak administra
formularios, calendarios, pagos y videos con la misma configuracion del editor
visual. Ese inspector debe scrollear con rueda, trackpad y tactil como el panel
derecho del editor visual; los controles internos no deben bloquear el scroll
del panel principal. Al seleccionar una zona nativa en la previsualizacion, el
editor abre la configuracion en ese inspector derecho y no muestra popovers de
configuracion sobre la pagina. El texto editable puede modificarse directamente
desde el preview con ajuste basico de tamano de letra; en el modo codigo ese
cambio queda como borrador de HTML hasta guardar el sitio. El panel de codigo
puede arrastrarse hasta ocultarse y queda una tira con flecha para recuperar el
editor cuando se necesite revisar el HTML. Cuando no hay borradores de HTML sin
guardar, la previsualizacion usa el render del backend de la pagina activa para
mostrar los elementos nativos ya montados tal como se veran en vivo; las
respuestas de preview viejas no deben repintar otra pagina si el usuario cambio
de pagina mientras cargaba. Los slots nativos y las acciones de video se resuelven por
`data-rstk-native-id` + tipo + pagina, de modo que dos paginas importadas no
compartan accidentalmente un formulario, calendario, pago, video o target con el
mismo identificador. El inspector derecho guarda automaticamente cambios validos
de video, calendario y pago con bajo ruido, y el boton de guardado manual sigue
mostrando validaciones cuando falta una configuracion obligatoria. Para pagos,
ese preview usa un snapshot temporal de la
configuracion del inspector derecho y dibuja una maqueta de checkout con pasarela,
monto, campos, boton, modo test y ayuda del proveedor; no monta SDKs reales ni
intenta iniciar cobros hasta que el sitio publicado confirme el pago. Los
calendarios nativos dentro del preview usan la ruta interna
`/api/sites/public/calendar-preview/:slug`, no `/calendar/:slug`, para que el
editor pueda mostrarlos sin depender de que el dominio publico ya este
configurado; el sitio publicado conserva la ruta publica normal.

Los aliases `data-ristak-*` y `data-ristack-*` se conservan para compatibilidad,
pero las reglas copiables nuevas deben preferir `data-rstk-*`.

En HTML importado multipagina, los nombres de pagina y archivo deben poder
expresar el orden real del flujo. La convencion nueva para reglas copiables y
HTML generado es usar sufijo numerico de dos digitos en `title` y `filename`,
por ejemplo `Landing-01.html`, `Form-02.html`, `Booked-03.html`. Ristak usa ese
numero para ordenar paginas importadas o generadas; no debe depender del orden
alfabetico del ZIP ni de nombres como `Pagina 1`.

En el flujo de crear un sitio, la opcion `Hacer la mia con ChatGPT/Claude`
vive dentro del grupo de Editor HTML, despues de `Subir HTML o ZIP`. Esta opcion
no llama a ninguna API de IA ni crea paginas por el usuario: solo abre un
asistente de compatibilidad que pregunta si el HTML generado externamente usara
formularios, calendario, video o pago de Ristak. Al terminar muestra un bloque de
texto listo para copiar y pegar en ChatGPT, Claude o Codex junto con la peticion
real del usuario. Desde ese modal, `Subir mi HTML` abre el flujo de importacion
ZIP/HTML y `Ir al editor` crea una hoja HTML en blanco para pegar codigo pagina
por pagina.

La revision de "Ruta de datos" de HTML importado debe permitir dos salidas para
campos personalizados: mapear a un campo guardado del catalogo o declarar un
campo nuevo con clave interna (`destinationType/saveMode = new_custom`) cuando
no existe todavia. El usuario no debe quedar bloqueado por no tener campos
personalizados creados antes de importar. Los titulos visibles de formularios
detectados tambien deben ignorar snippets tecnicos de Ristak (`data-rstk-*`,
acciones `open_popup/close_popup`, JSON de acciones de boton) y caer al titulo
humano cercano o a `Formulario N`, para no mostrar atributos internos en el
modal ni en formularios fuente.
Si el HTML importado solo usa elementos nativos de Ristak o no tiene campos de
formulario propios detectados, la revision de "Ruta de datos" no debe abrirse:
no hay campos HTML que enrutar y el formulario nativo se configura desde su
inspector correspondiente.

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

En el editor visual, la libreria lateral de automatizaciones es responsiva y
estatica: en pantallas muy amplias usa el ancho grande fijo, y en ventanas
normales o chicas se compacta por breakpoint. No se expande ni se contrae al
hover o al enfocar controles internos.

Regla de prueba desde el editor: el botón **Probar** usa la última versión
guardada del flujo y no exige que la automatización esté publicada. Si hay
cambios locales sin guardar, primero debe guardarse. Las inscripciones manuales
desde contactos, acciones masivas, jobs programados y eventos reales siguen
usando únicamente automatizaciones publicadas y su `published_flow`.
El modal de prueba usa un solo campo **Contacto**: el usuario puede buscar un
contacto existente o crear uno nuevo desde el mismo selector, y la prueba corre
sobre ese contacto elegido.

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
respuestas privadas usan el `comment_id` para mandar un unico mensaje inicial al
comentarista por Messenger o Instagram DM. Las respuestas privadas a comentario
cuentan como mensaje enviado para una espera posterior de respuesta; las
respuestas publicas no abren una espera de DM.

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
- Stripe/Conekta/Mercado Pago/Rebill payment plans. En Rebill el cron cobra
  parcialidades vencidas con tarjeta guardada (`cardId`) y solo libera link cuando
  falta autorizar tarjeta; Ristak mantiene el reloj del plan.
  CLIP queda fuera de planes de pago y suscripciones; solo confirma pagos unicos
  con webhook/refresh del checkout.

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
  El formulario manual agrupa la configuracion en cinco bloques: personalidad e
  instrucciones, operacion tecnica del chat, objetivo y cierre, reglas de
  atencion, y entrada/salida. El wizard de nuevo asistente cubre las decisiones
  principales de esos bloques: proveedor/modelo de IA, identidad, persuasion,
  lenguaje, personalizacion y capacitacion del asistente (`extraInstructions`),
  tiempos de respuesta, mensajes en partes, notificaciones mientras el agente
  atiende, objetivo, quien cumple la meta, cierre posterior cuando lo cumple la
  IA o un enlace, datos requeridos, reglas de pase a equipo y alcance de
  contactos. El alcance "solo contactos nuevos desde hoy" sella el instante
  exacto en que se crea o cambia el asistente a ese alcance; desde ese momento
  en adelante puede tomar contactos nuevos, pero no toma contactos que ya
  existian antes de ese corte. Cuando el proveedor es OpenAI, el modelo default
  del sistema es `gpt-5.4-mini` (mostrado en UI como GPT-5.4 Mini); las
  conexiones nuevas de OpenAI y los agentes sin modelo explicito deben caer en
  ese default.
  Las reglas finas de entrada/salida y acciones extra de cierre se ajustan desde
  el formulario manual avanzado. `extraInstructions` es la superficie editable de
  personalizacion del asistente: reglas del negocio, limites, datos que debe
  pedir, casos especificos y comportamiento que siempre debe respetar, salvo los
  limites de seguridad e integridad. El prompt avanzado de fabrica vive interno:
  no se muestra, no se edita desde la UI y las APIs de configuracion ignoran
  intentos de guardar `closingStrategyCustom`. Los datos estrictamente necesarios
  para avanzar deben vivir en `requiredData`. Si `extraInstructions` condiciona
  precio/valor/costo/cotizacion (por ejemplo,
  "no des precio hasta conocer el problema o reto"), el prompt activa un bloqueo
  explicito: una pregunta directa por precio no desbloquea montos, rangos,
  descuentos, promociones ni links de pago hasta cumplir esa condicion; el agente
  debe pedir el contexto faltante de uno en uno y despues usar precios reales.

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

La app movil publicada usa Capacitor y el shell web movil bajo el prefijo
`/movil`. Incluye chat, pagos, analytics, calendario y ajustes.

El nuevo cliente nativo React Native/Expo vive en `mobile/`. Es una app separada
del WebView, con almacenamiento seguro local y consumo directo de APIs del
backend. Arranca como app paralela con bundle/package `com.ristak.native`; no
debe reemplazar el bundle de tienda `com.ristak.app` hasta validar la migracion
completa. La configuracion default de `mobile/app.json` debe mantenerse en
`com.ristak.native` para poder comparar ambas apps instaladas en el mismo
telefono; usar `com.ristak.app` desde `mobile/` es una decision de migracion o
release, no una configuracion local normal.
en dispositivos reales y actualizar el flujo de release.

Regla obligatoria para futuros cambios: si una feature, label, permiso, push,
agenda, pago, filtro, login o contrato de API cambia la experiencia movil, la IA
debe revisar e implementar lo necesario tanto en `/movil` como en `mobile/`.
Cuando solo aplique a una superficie, el resumen del cambio debe explicar por
que.

La app React Native no es un rediseño. Su contrato de producto es paridad visual
y funcional con `/movil`: mismo orden de secciones, nombres visibles,
jerarquia, flujos, permisos, estados y comportamiento final. La implementacion
puede ser nativa distinta, pero el usuario no debe sentir que esta usando una app
diferente o recortada.

La lista de chats nativa debe mantenerse alineada con `PhoneChat`: header de
chats, buscador, chips de filtros, filas planas, avatares con aro/badge de canal,
preview de ultimo mensaje, estados de no leido, fila/vista de archivados,
swipe lateral `Mas` + `Archivar`/`Restaurar` y seleccion multiple por long
press. Tambien debe usar sheets nativos para `Mas`, `+`/nuevo chat y selector de
destinatarios despues de camara. Cuando cambien filtros, labels, canales,
unread, archivados, seleccion, swipe, camara, sheets o preview en `/movil`, se
debe revisar el equivalente en
`mobile/src/App.tsx` y documentar cualquier brecha temporal en
`docs/MOBILE_APP.md`. En la conversacion nativa, si un agente conversacional
esta activo, enviar un mensaje manual debe pedir primero que el usuario pause el
agente 24 horas, quite el contacto del agente o cancele; el menu `+` debe poner
los controles del agente al inicio cuando haya estado de agente asignado.

La pantalla de analiticas nativa debe mantenerse alineada con
`PhoneAnalytics`: periodos `30d`/`60d`/`180d`/`year`/`custom`, 8 KPIs, grafica
principal, embudo, distribucion de origen y origen por numero de WhatsApp. Los
rangos se calculan con `account_timezone`, el rango personalizado usa fechas
`YYYY-MM-DD`, y los importes se formatean con `account_currency`.

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
En iOS hay dos bundles que se firman para App Store: la app
`com.ristak.app` y la extension de notificaciones
`com.ristak.app.NotificationService`. Cada uno necesita su propio provisioning
profile App Store, ambos ligados al mismo certificado Apple Distribution. El
perfil de la app principal debe incluir Push Notifications y Communication
Notifications (`com.apple.developer.usernotifications.communication`) para que
las push puedan mostrar el avatar del contacto como remitente; la extension
mantiene su propio perfil para modificar el payload antes de mostrarlo.
En Android, el binario necesita `frontend/android/app/google-services.json` fuera
de Git y el envio puede resolverse por FCM local o por Ristak Installer central.
Si el portal central reporta Android configurado, la instalacion cliente debe
delegar al Installer los tokens Android cuando no tenga FCM local, igual que con
iOS/APNs central. Las push Android deben enviarse como FCM data-only para que
`RistakFirebaseMessagingService` dibuje la notificacion nativa con el small icon
`ic_stat_ristak`, el avatar circular del contacto como large icon, el AppIcon de
Ristak cuando no hay avatar y `notificationImageUrl` solo como preview multimedia
real. No debe mandarse `message.notification` para Android porque Firebase
renderiza una notificacion generica y se pierde el look alineado a iOS.

## Licenciamiento y distribucion

El licenciamiento central protege instalaciones managed Docker, feature flags y
límites de plan. El backend local valida licencia y plan con cache. El frontend
tambien oculta modulos o anticipa limites, pero el bloqueo real debe estar en
backend.

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
