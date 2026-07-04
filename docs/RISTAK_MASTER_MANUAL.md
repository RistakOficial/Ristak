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
| Pagos | Stripe, Conekta, Mercado Pago, CLIP, Rebill, HighLevel invoices |
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
  y contexto de inicio de sesion. Los estados de carga inicial del CRM usan
  `AppStartupLoader`/`PhoneStartupLoader`: fondo limpio claro u oscuro, isotipo
  centrado y "Ristak" al pie, sin spinner como elemento principal.
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
- El Viaje del Cliente en la ficha debe mostrar cada actividad con una etiqueta
  legible: visitas, contactos, WhatsApp, Messenger, Instagram, correo, citas y
  compras. Si un evento trae metadata de mensaje social o email, el tooltip debe
  explicar canal, contenido, perfil/usuario, estado e identificadores utiles; no
  debe quedarse como "Evento" sin detalle. Los mensajes de WhatsApp, Messenger e
  Instagram se resumen en marcadores diarios por canal usando el dia local de la
  zona horaria del negocio, para evitar repetir varios puntos por mensajes del
  mismo dia.

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

En los chats desktop y movil, el selector para enviar o programar plantillas de
WhatsApp API debe listar solo plantillas con estado `APPROVED`. Las plantillas
rechazadas, pausadas, archivadas, pendientes o en apelacion pueden mostrarse en
las vistas de revision/estado, pero no deben aparecer como opcion seleccionable
en el flujo de envio.

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

En la pagina de Chat desktop y en el chat movil bajo `/movil`, la informacion
del contacto permite elegir el WhatsApp de respuesta del contacto. El modo
automatico usa el numero por donde llego la conversacion o, si no hay historial,
el principal actual; si el usuario elige un numero fijo, Ristak guarda
`preferred_whatsapp_phone_number_id` en el contacto y el composer empieza a
enviar desde ese remitente por default. El selector del composer puede seguir
cambiando el envio puntual, incluyendo cada WhatsApp conectado como opcion
separada, pero el panel/info del contacto es la fuente visible para decidir el
remitente preferido del contacto.

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

Documentacion especifica:

- `backend/src/services/README_CALENDARS.md`
- `frontend/src/pages/Appointments/README.md`

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

El modo de pasarelas puede ser `test` o `live`. Ese modo debe viajar con el pago
en `payment_mode` o metadata equivalente para evitar mezclar pruebas con dinero
real.

### Tabla de transacciones

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
- El comprobante posterior al pago incluye un enlace al checkout publico con
  `?receipt=1`; cuando el pago esta confirmado, esa pagina muestra el comprobante
  y activa la descarga/impresion del PDF.
- Si falta contacto de correo, telefono, conexion del canal o URL publica de pago,
  el despacho se omite o queda fallido con razon explicita; no se inventan datos ni
  se manda un comprobante sin enlace descargable.

### Planes de pago locales

En Stripe, Conekta y Mercado Pago, el calendario editable muestra y guarda cada
pago como `Pago N/M`, donde `N` es la posicion visible del pago y `M` es el total
actual del plan. Si el calendario se edita, por ejemplo de 3 a 6 pagos, Ristak
actualiza tambien los `title`/`description` de pagos existentes de `1/3` a `1/6`
sin cambiar importes, fechas ni estados ya registrados.

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
claves `rebill_*`; la public key `pk_` se entrega al checkout publico porque el
SDK la necesita y la secret key `sk_` queda cifrada en base de datos. No requiere
env vars nuevas para arrancar el servicio. La UI solo pide `pk_` y `sk_`; el
nombre visible de la organizacion se deriva de `GET /v3/organizations/me` o del
modo configurado, no de un campo manual.

Alcance:

- Cobros unicos por link publico `/pay/:publicPaymentId`.
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
- Checkout de Sites con el web component oficial `rebill-checkout`.
- En checkouts publicos y Sites, Ristak configura el SDK de Rebill con
  `display.excludePaymentMethods=['cash','bank_transfer']` para aceptar solo
  tarjeta. SPEI, PSE/transferencias bancarias y efectivo no deben aparecer en
  estos links porque el flujo local espera confirmar cobros de tarjeta.
- En links publicos activos de Rebill, la pagina mantiene el layout Ristak de
  dos columnas: resumen, logo, negocio, soporte, producto, vencimiento y total
  quedan en la columna izquierda; el web component de Rebill queda en la columna
  derecha. Para que no se duplique ni se desborde el resumen interno del
  proveedor, Ristak manda `display.checkoutSummary=false`,
  `display.discountCode=false`, `display.logo=false` y `display.footer=false`.
  El SDK decide su breakpoint con `window.innerWidth`, no con el ancho del
  contenedor, asi que Ristak no fuerza modo movil; en su lugar limita la columna
  y deja el formulario full-width dentro de esa columna. Los estados pagado,
  programado, cerrado o con error siguen usando las pantallas explicativas de
  Ristak.
- El prefill de telefono en `customer-information` debe separar el numero
  nacional de la region: `phoneNumber.countryCode` recibe ISO alpha-2 (`MX`,
  `US`, etc.) y `phoneNumber.number` recibe solo digitos nacionales. No mandes
  `+52`, `52` o `521` dentro de `number`, porque el selector de region del SDK ya
  resuelve la lada y la duplicaria en pantalla. Ademas Ristak manda
  `countryCode` top-level con el mismo ISO alpha-2 para que el selector visual de
  Rebill no caiga al pais calculado por la sesion instantanea del SDK.
- Meses/installments en cobros unicos: en el modal de cobro, Rebill entra al
  mismo paso de decision que Stripe, Conekta, Mercado Pago y CLIP: contado o MSI.
  Si se elige MSI, Ristak pide el maximo de meses (3, 6, 9, 12, 18 o 24), guarda
  `metadata.rebillInstallments.maxInstallments` y conserva
  `enabledInstallments`. Para la prueba operativa actual,
  `REBILL_USE_HOSTED_PAYMENT_LINKS=false`, asi que la pagina publica conserva el
  checkout embebido con `instant-product`, tarjeta unicamente,
  `display.discountCode=false`, `display.logo=false` y `one-click-checkout=false`
  cuando MSI esta activo. La integracion hosted de Rebill permanece en el backend
  como alternativa, pero el frontend no redirige y la respuesta de creacion de link
  sigue entregando la URL local `/pay/:publicPaymentId` mientras ese flag siga
  apagado.
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
- Suscripciones Rebill (`instant-plan`) existen en la documentacion del proveedor,
  pero no estan cableadas como flujo de suscripciones de Ristak en esta
  superficie. No se deben presentar como listas hasta implementar UI/API,
  conciliacion y cancelacion.
- Cron `rebill-payment-plans`: corre por el registry de crons de integracion y
  solo se activa si Rebill esta conectado en el modo de pago activo. Revisa
  primeros pagos y parcialidades vencidas segun la zona horaria de la cuenta. Si
  el flujo ya tiene `rebill_card_id`, cobra con `POST /v3/checkout` usando
  el `customer` estructurado del contacto + `cardId`; si el primer pago estaba
  programado y aun no hay tarjeta, libera su link publico.
  No delega el calendario a Rebill.
- Webhook publico `/api/rebill/webhook`; como la documentacion publica de Rebill
  no declara firma verificable para webhooks, Ristak no confia en el payload para
  marcar pagado. Cada evento extrae el `paymentId` y consulta el pago real con
  `GET /v3/payments/:id` usando la `sk_` del backend antes de actualizar la fila.
- El evento `success` del web component tampoco da acceso por si solo. El frontend
  manda el `paymentId` a `POST /api/rebill/public/payments/:publicPaymentId/confirm`
  y el backend vuelve a consultar Rebill antes de marcar `payments.status='paid'`.
- Configuracion > Pagos > Rebill valida la organizacion con
  `GET /v3/organizations/me` y, si la app tiene URL publica HTTPS, intenta crear o
  actualizar automaticamente el webhook con eventos `payment.created` y
  `payment.updated`. Si la URL publica no existe, queda en estado
  `pending_public_url` y la UI muestra un aviso simple; no expone botones para
  copiar URL o eventos porque la configuracion normal es automatica.
- Variables de automatizacion: `payment.rebill_payment_id`,
  `payment.rebill_subscription_id`, `payment.rebill_customer_id` y
  `payment.rebill_card_id`.

Persistencia:

- `payments.payment_provider='rebill'` y `payments.payment_method='rebill_checkout'`.
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
  por default Messenger y comentarios de Facebook; Instagram DM y comentarios de
  Instagram requieren ademas `meta_config.instagram_access_token` y se controlan
  desde la columna de Instagram.
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
  `action_source`. Detalle completo en `docs/CONVERSION_ATTRIBUTION.md`.
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

En el editor visual, los bloques de calendario embebido eligen el calendario y
la accion posterior a la cita desde la barra superior del editor. El inspector
derecho solo muestra el estado del calendario seleccionado y los controles de
diseno/estilo, para no duplicar la misma decision en dos superficies.

La ruta publica puede depender de dominio, slug, host o rutas internas. Cualquier
cambio a Sites debe revisar editor, renderer publico, submissions y tracking.
Cuando Meta ya tiene dataset/pixel y token guardado, los sitios nuevos activan
Meta CAPI por default. Las landings nuevas y las paginas nuevas creadas dentro de
una landing existente nacen con solo `PageView` al aterrizar la pagina (browser
Pixel + CAPI server-side, sin `ViewContent` por default); los formularios
nativos/importados/creados por IA encienden `Lead` al enviar. Los bloques de
calendario embebido nuevos nacen con `Schedule`. Las actualizaciones de sitios
existentes no reactivan eventos que el usuario apago manualmente.

En landings en modo embudo, los bloques nuevos que ejecutan una accion posterior
al evento (`calendario embebido`, `formulario embebido` y `pago`) nacen apuntando
a `Ir a la siguiente pagina` solo si la pagina actual tiene otra pagina por
delante. Si el bloque se crea en la ultima pagina, o no existe un destino
posterior real, conserva el comportamiento original del elemento: reglas del
calendario, reglas del formulario o mensaje de exito del pago. Ese default solo
se aplica al crear el bloque; si el usuario cambia la accion a reglas propias,
pagina especifica o redireccion, se respeta su configuracion guardada.

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
  el cobro trae `stripeInstallments.maxInstallments`; Mercado Pago, CLIP y Rebill resuelven
  installments dentro de su widget/SDK cuando la cuenta/tarjeta califica; boton de
  pago con icono; badge "No visible en el sitio
  publicado" cuando el gate esta deshabilitado). En modo test, el preview y el
  checkout publicado muestran el helper de tarjetas de prueba del proveedor debajo
  del mensaje de checkout, de modo que cualquier error/rechazo queda visible antes
  del acordeon de ayuda. Stripe, Conekta, Mercado Pago, CLIP y Rebill usan el mismo
  contrato de `paymentGate`; CLIP monta el SDK oficial en el checkout publicado,
  requiere email/telefono para procesar el cargo y puede habilitar MSI con
  `terms.enabled` si el bloque lo permite; Rebill prepara primero el pago local y
  luego confirma server-side el `paymentId` devuelto por el SDK. El selector de
  pasarela del inspector debe persistir
  inmediatamente el bloque para que el modo vivo no monte una pasarela anterior; el
  HTML publicado, `/checkout/init` y el cargo deben usar siempre el mismo
  `paymentGate.gateway`. Si un visitante abandona el checkout antes de pagar, el
  registro queda pendiente/oculto y no genera error; solo un rechazo real de la
  pasarela se muestra como `failed`. El toggle "guardar tarjeta" se retiro
  (Stripe Link no es ocultable por codigo).
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
Para operar desde esta Mac existe una configuracion local privada en
`.mobile-release.local.env` y una boveda local `.mobile-release/`, ambas
ignoradas por Git. La fuente recomendada para produccion sigue siendo Ristak
Installer; el archivo local guarda defaults operativos, rutas y fallback local.
Antes de publicar, se valida con `npm run mobile:release:check` para detectar
credenciales o archivos faltantes sin imprimir valores sensibles.

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
| Correo SMTP | `app_config.email_smtp_config` y `app_config.email_smtp_password` | No | Password cifrado; requerido solo para enviar correos |
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
