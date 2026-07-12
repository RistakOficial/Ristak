# Manual maestro de Ristak

Ultima consolidacion: 2026-07-09.

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
   - espera base de datos,
   - corre migraciones,
   - inicializa llave de cifrado,
   - sanea usuarios legacy que guardaban el correo en `username`,
   - asegura usuario inicial/default,
   - sincroniza estado de licencia,
   - inicializa version Meta,
   - repara o verifica tareas pendientes de webhooks/pagos/templates/media,
   - arranca schedulers de sistema,
   - sincroniza crons registrados por integracion.

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

Configuracion se organiza en:

- Cuenta: cuenta, usuarios, notificaciones, privacidad, aplicacion movil.
- Integraciones: HighLevel, Meta, WhatsApp, correos, Inteligencia Artificial,
  pagos, calendarios.
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
API tokens legacy y nuevos requieren `developers`; `/api/external` y `/api/mcp`
requieren `developers` y feature del recurso; la busqueda global filtra
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
- Telefonos normalizados.
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

El contrato canónico de proveedores, webhooks, IDs, Coexistence y soporte vive
en [integrations/WHATSAPP_PROVIDER_ARCHITECTURE.md](./integrations/WHATSAPP_PROVIDER_ARCHITECTURE.md).
Todo registro WhatsApp debe distinguir `provider` (`ycloud`, `meta_direct` o
`qr`), `transport` (`api` o `qr`) y `source_adapter` (`ycloud`, `meta_direct` o
`baileys`). YCloud y Meta directo comparten el modelo interno, no credenciales,
endpoints, nombres de webhook ni columnas de ID específicas. Baileys nunca debe
presentarse como proveedor de API oficial.

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

En `/chat` desktop y `/movil`, el avatar del contacto no debe llevar aro,
contorno ni relleno coloreado por red social. La identidad del canal vive en el
badge inferior derecho usando los mismos assets WebP de canal que `mobile/` e
`ios/app` (`whatsapp`, `facebook`, `messenger`, `instagram`, `gmail`), pintados
como iconos libres sin disco, borde, brillo ni contenedor circular extra.

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

En `/chat` desktop, los mensajes entrantes de WhatsApp, Messenger o Instagram
que vienen de un anuncio deben mostrar una vista previa compacta del anuncio
dentro del globo antes del texto del contacto. Esto aplica por mensaje: si el
mismo contacto vuelve por otro anuncio semanas despues, ese nuevo globo tambien
muestra su propia vista previa; un mensaje organico intermedio no debe heredarse
la atribucion vieja del contacto. La tarjeta se arma con `is_ad_attributed`,
`referral_source_id`, `referral_ctwa_clid`, `referral_source_url`,
`referral_headline` y `referral_body`, pero `headline`/`body`/`source_app`/
`entry_point` no son senal suficiente por si solos. En WhatsApp la preview solo
se dispara con referral CTWA/YCloud real (`ctwa_clid`, `source_id`/`ad_id` con
senal de anuncio), `is_ad_attributed=true` o el marcador Ristak; `transport='api'`
o `source_app='api'` nunca deben pintar anuncio. En Messenger/Instagram salen del
`referral_json` de `meta_social_messages` (`ad_id`, `source='ADS'`,
`ads_context_data`). Si Meta
incluye `ads_context_data.photo_url` o `ads_context_data.video_url`, el backend
los expone como media/thumbnail del anuncio para que la tarjeta tenga material
visual aunque todavia no exista una fila sincronizada en `meta_ads`. Cuando
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
`/movil` pinten el quote y peguen el emoji al globo correcto. Visualmente, las
reacciones visibles en `/chat`, `/movil`, `mobile/` e iOS deben mostrarse como
emoji suelto pegado al globo, sin fondo, borde, sombra ni pill/contenedor.

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
En iOS, el scrubber de las notas de voz usa holgura lateral para que la bolita en
0:00 y al final no parezca adelantada ni recortada dentro del globo.
La hora, etiqueta de transporte, vistos y razones de ruteo viven fuera/debajo de
la burbuja para no crear columnas internas. Los errores de envio no se escriben
dentro del globo: se muestran como icono externo con detalle en tooltip. En
Messenger/Instagram nativo el chat puede conservar texto y notas de voz. El
audio nativo de Meta se guarda primero como media reproducible de Ristak y luego
se envia a Messenger/Instagram como `message.attachment.type='audio'` con URL
publica HTTPS; la burbuja local queda como `message_type='audio'` con
`media_url`/MIME para poder reproducirse al recargar. Los adjuntos manuales de
Messenger/Instagram pueden salir por HighLevel cuando esa integracion esta
conectada; el transporte nativo de Meta conserva audio y las automatizaciones
usan el envio nativo de adjuntos publicado por HTTPS.

En Automatizaciones, los bloques de mensaje de WhatsApp, Messenger e Instagram
pueden consistir en un solo adjunto: imagen, video, archivo de audio, nota de
voz o archivo, sin requerir un bloque de texto. WhatsApp conserva el tipo real
de imagen/video/documento y el bloque `Nota de voz` se envia como voz (OGG/Opus
cuando el proveedor lo necesita), separado del bloque `Audio`, que se manda como
archivo reproducible. Messenger e Instagram reciben imagen, video, audio y
archivo mediante `message.attachment` con una URL publica HTTPS; si el bloque
trae texto opcional, Ristak lo manda como el siguiente mensaje porque Meta no
admite caption dentro del payload de adjunto. Los assets cargados en
automatizaciones se resuelven desde su URL pública CDN al asset interno antes de
enviar. Así una foto WebP ya cargada se manda por la misma ruta de conversión a
JPEG compatible que usa el chat normal; no se reenvía el WebP crudo a WhatsApp.
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
bloqueados. Si Meta devuelve `131053` en el webhook, el claim atómico existente
activa una sola vez el respaldo QR/PTT cuando esa sesión está lista, sin duplicar
la nota. Meta Direct usa `audio.link` con `voice=true` a través de Graph API,
porque no atraviesa el importador de YCloud.
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
Al insertar mensajes antiguos arriba del hilo, la UI debe conservar la posicion
visible del usuario y nunca forzar scroll al ultimo mensaje.

El mismo contrato aplica al chat dentro del modal de contacto: debe usar
`/contacts/:id/conversation` para no mezclar eventos de viaje, visitas, compras
o contacto creado dentro del historial de WhatsApp/Meta/email. Las tarjetas
`appointment_confirmation` con accion `chat_card` si pertenecen al hilo y se
incluyen en ese endpoint. `/contacts/:id/journey` queda reservado para el viaje
del cliente y compatibilidad legacy.

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
queda como red de seguridad, no como camino principal: bandeja cada 12 s, hilo
abierto cada 4 s y acuses de salientes cada 12 s. Si se pierde el stream por
proxy, reconexion o app suspendida, el siguiente tick reconcilia sin spinner ni
salto de scroll.

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
poll/SSE; el calentamiento de fotos se reserva para arranque frio y paginacion.
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
badge de canal sin recalcular la bandeja completa. Solo una consulta con forma real de
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
perfil de la cuenta —se administra en Configuración > Cuenta/Perfil del negocio—
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
de negocio. Si la ventana de 24 horas sigue abierta, los envios manuales del chat
deben salir por API oficial aunque el frontend haya pedido `transport='qr'` por
un calculo local incompleto. Si la ventana ya esta cerrada o no existe una
respuesta entrante comprobable, no debe intentar YCloud: debe usar WhatsApp
QR/Baileys directamente cuando exista un QR usable. Desktop y movil deben
calcular el transporte antes de pintar el mensaje optimista, pero el backend es
la autoridad final para evitar que un QR previo secuestre conversaciones API.
Las plantillas quedan fuera de este bloqueo porque son el camino permitido por
WhatsApp cuando la conversacion esta cerrada.

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
el punto y reintenta en el siguiente tick mientras la integracion siga activa. WhatsApp
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
`pago_fallido_reintento`. El backfill de arranque compara esas plantillas contra
la definicion vigente del sistema; si una copia existente esta editable, actualiza
el copy/variables/botones y la reenvia a revision como edicion. Si Meta/YCloud la
tiene en revision, Ristak no la pisa y espera el resultado. Las plantillas de pago
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
Si el mismo numero tambien tiene WhatsApp QR/Baileys conectado, el eco saliente
que WhatsApp Web emite para esa foto no debe crear una segunda burbuja `QR` con
el texto generico `Foto`. El backend debe marcar los envios API originados por
Ristak y deduplicar ecos recientes de media sin caption por telefono canonico,
direccion, tipo de mensaje y ventana temporal antes de persistirlos como
mensajes nuevos. Para envios QR directos, donde WhatsApp puede cambiar el WAMID
entre la respuesta de Baileys y el eco de otro dispositivo, la reconciliacion
debe comparar `fileSha256`/`fileEncSha256` del archivo; no basta agrupar por
minuto porque el operador puede mandar dos fotos distintas seguidas.

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
`error_message`. El fallo asíncrono de media `131053` en una nota de voz también
debe usar este respaldo cuando el envío permitió QR: el webhook suele traer solo
`audio.id`, así que el backend recupera de la fila original la URL de entrega o
preview y reintenta una sola vez con `ptt=true`. Ante webhooks duplicados o
concurrentes, un claim atómico en la fila del mensaje permite que sólo un proceso
ejecute el respaldo QR. Si despues llega un
webhook tardio de WhatsApp API con estado `failed` para un mensaje que ya quedo
resuelto por QR, el historial debe conservar el transporte `qr` y mantener
limpios esos campos de error. Solo se guarda error visible cuando no existe
respaldo QR usable o cuando el respaldo QR tambien falla.
Para media manual (foto, video, audio o documento), el fallback por ventana
cerrada debe conservar el tipo real del contenido: una foto fuera de 24 horas se
manda por WhatsApp QR como imagen, no como mensaje de texto ni como placeholder
`Foto`.
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
repiten esa advertencia. Cuando tambien hay WhatsApp API conectado, el usuario
puede activar QR como respaldo directamente desde la configuracion correspondiente.

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
con esas credenciales. Un `connectionClosed` (`428`) de una sesion previamente
registrada se reintenta dos veces porque puede ser transitorio. Si vuelve a cerrar
antes de abrir, Ristak conserva el auth local, desactiva ese QR para envios y lo
marca `qr_repair_required`; nunca borra ni desconecta automaticamente un numero
sano. El operador debe elegir generar un QR nuevo, y solo ese acto explicito
limpia el auth rechazado y empieza un emparejamiento limpio. Si Baileys emite un
QR pero no se puede convertir en imagen, el estado tambien queda como error
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
- Los calendarios espejados desde HighLevel siguen siendo calendarios locales
  utilizables aunque HighLevel se desconecte. Sus URLs publicas, disponibilidad
  y bookings deben resolverse contra la DB de Ristak; las citas nuevas,
  ediciones y eliminaciones quedan en `sync_status` pendiente/error/
  `pending_delete` y se empujan a HighLevel cuando la integracion vuelva a
  conectarse.
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
- Las creaciones autenticadas de cita aceptan `clientRequestId`. `mobile/`,
  `PhoneCalendar` y el formulario de cita dentro de `PhoneChat` generan una
  llave por intento y la conservan al reintentar el mismo payload; el backend
  la reserva atomicamente en `appointment_creation_requests`, reproduce una
  respuesta completada y rechaza concurrencia, resultados ambiguos o la misma
  llave con datos distintos. Clientes legacy sin llave conservan temporalmente
  el contrato anterior. Los deep links de cita de Android esperan primero un
  bootstrap utilizable de `account_timezone` y calendarios para no consumir el
  enlace con contexto fallback.
- Las creaciones locales desde calendario publico, admin o agente disparan los
  eventos `appointment-booked` y `appointment-status` del motor de
  Automatizaciones despues de persistir la cita. Los cambios de estado desde
  esas superficies disparan `appointment-status`; las sincronizaciones de
  Google/HighLevel no deben tratarse como si el cliente hubiera agendado en
  Ristak.
- En `ios/app`, los snapshots de citas usan una clave compuesta por calendario y
  mes. Cambiar calendario vacia las filas anteriores antes de hidratar la clave
  correcta, y volver a foreground fuerza la revalidacion del calendario activo.

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

En Configuración > Pagos, Basic no muestra página de cobro, pasarelas ni
automatizaciones: requieren, respectivamente, `payment_checkout`,
`payment_gateways` y `payment_automations`. Los checkouts públicos de Sites y
sus bloques de cobro validan `payment_checkout` en backend, incluso si una página
existía antes de un downgrade.

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
- `channel='whatsapp_qr'` usa WhatsApp QR como canal principal aunque tambien
  exista API conectada. En ese modo Ristak renderiza el mensaje como texto y no
  exige aprobacion de Meta ni ventana de 24 horas.
- Los mensajes directos por WhatsApp API no sustituyen a las plantillas fuera de
  la ventana permitida por Meta: solo salen si existe conversacion abierta de 24
  horas o si QR queda como ruta principal/respaldo. Fuera de esa ventana, para
  automatizaciones proactivas debe usarse plantilla aprobada o QR.
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
prioridad configurada. "Por canal disponible" siempre usa esa prioridad fija:
WhatsApp API, WhatsApp QR, Instagram, Messenger y correo electronico.
`channel='whatsapp'` usa WhatsApp API como ruta principal y QR solo como
respaldo opcional. `channel='whatsapp_qr'` usa WhatsApp QR como ruta principal
aunque tambien exista API conectada. En los dos canales de WhatsApp, el contenido
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

Si solo hay WhatsApp QR conectado, recordatorios y avisos de cita envian el
texto renderizado del mensaje por QR aunque la plantilla de WhatsApp API este
pendiente o no exista remotamente. Si hay API y QR conectados, `whatsapp` sigue
usando API como ruta principal y QR entra solo como respaldo cuando el switch de
respaldo esta activo; `whatsapp_qr` usa QR como canal elegido y no muestra el
switch de respaldo.

Los mensajes directos por WhatsApp API en citas tambien dependen de ventana de
conversacion abierta de 24 horas. Si no existe una respuesta reciente del
contacto, el envio libre por API falla de forma explicita; para mensajes
proactivos fuera de ventana debe usarse plantilla aprobada o QR cuando este
conectado y habilitado.

Cada par `reminder_id + appointment_id` se reclama en
`appointment_reminder_sends` antes de enviar para evitar duplicados. Estados
`sent`, `skipped` y `sending` bloquean nuevos envios. Si el intento termina en
`error`, el cron puede reintentarlo despues de 15 minutos, siempre que la hora de
envio siga dentro de la ventana util de 3 horas; si ya se paso esa ventana se
marca como omitido en vez de mandar un WhatsApp tarde.

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

### Conexion OAuth y convivencia manual

- `Configuracion > Meta` ofrece dos rutas compatibles. `manual_system_user`
  conserva el wizard y System User Token historicos; `oauth_bisu` usa Facebook
  Login for Business desde la app central de Ristak Installer. OAuth permanece
  como vista previa para roles/testers durante App Review y el metodo manual no
  se retira.
- Installer es el unico dueño de `meta_app_secret` y del Config ID FLFB. Genera
  un `state` hasheado/one-time, recibe el callback HTTPS exacto, valida la
  credencial BISU y entrega token, Page tokens y `appsecret_proof` mediante un
  handoff cifrado ligado a cliente/instalacion. Ninguno de esos secretos llega
  al navegador.
- Ristak reclama el handoff server-to-server y conserva una sesion cifrada con
  TTL mientras se eligen activos. Solo promociona `oauth_bisu` cuando estan los
  permisos completos y las relaciones Ad Account ↔ Dataset y Page ↔ Instagram
  pertenecen al snapshot autorizado. Cancelar, expirar o fallar deja intacta la
  conexion activa. Installer conserva la autorizacion nueva como candidato y no
  sustituye la conexion/ruta anterior hasta la promocion atomica final; repetir
  esa promocion por `connection_id` es idempotente.
- Una sola app Meta implica un solo callback de webhooks. Installer valida
  `X-Hub-Signature-256`, deduplica, enruta por Page/Instagram y retransmite a
  `/webhooks/meta/installer-relay` con HMAC de la licencia, timestamp, nonce e
  ID estable de entrega. La instalacion valida firma/replay/idempotencia antes de
  usar el procesador social normal. En OAuth, el webhook directo falla cerrado;
  el webhook de apps manuales conserva compatibilidad legacy.
- HighLevel nunca recibe, reconcilia ni borra la credencial OAuth. El flujo
  manual conserva su compatibilidad previa. WhatsApp Embedded Signup sigue
  separado porque usa otro Config ID y activos distintos.
- Contrato completo, permisos y checklist de revision:
  `docs/META_OAUTH.md`.

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
- Conversions API usa la credencial base activa guardada cifrada en
  `meta_config.access_token`: System User Token para el modo manual o BISU para
  OAuth. `META_ACCESS_TOKEN` queda solo como fallback legacy. No existe un token
  separado de CAPI.
- En Configuracion > Meta, al editar el wizard o moverse entre sus pasos, la UI
  vuelve a consultar cuentas de anuncios, datasets/pixeles, Facebook Pages e
  Instagram desde backend. En manual usa el token guardado; en OAuth usa el
  snapshot seguro del handoff y nunca revela el BISU al frontend. El usuario no
  debe borrar y pegar de nuevo el token solo para que aparezcan activos recien
  asignados en Meta Business. Las selecciones dentro del wizard son borrador:
  elegir cuenta, dataset, Facebook Page o Instagram no dispara guardado ni
  sincronizacion inmediata; Ristak persiste la configuracion una sola vez al
  terminar el wizard. Al terminarlo, Ristak arranca automaticamente la
  sincronizacion de anuncios de Meta en segundo plano y lleva al usuario a
  `Configuracion > Meta > Redes sociales`. Las Page nuevas dejan encendidos por
  default Messenger y comentarios de Facebook; cuando tambien hay una cuenta
  profesional de Instagram enlazada, quedan encendidos sus cuatro switches de
  mensajes y comentarios. Instagram DM y comentarios se operan con el token de
  Pagina derivado de `meta_config.access_token` cuando la cuenta profesional de
  Instagram esta enlazada a esa Page y el token base tiene permisos de Instagram.
  Ristak no pide, guarda ni acepta un token separado de Instagram. En la pestaña
  Redes sociales, la guia de Webhooks muestra solo la
  URL de devolucion de llamada y el token de verificacion que deben repetirse en
  cada caso de uso/producto de Meta activo (Page, Messenger, Instagram o
  WhatsApp). La UI no debe pedir al usuario copiar campos de suscripcion
  manuales; Ristak mantiene la suscripcion programatica de la Page cuando
  conecta o actualiza la integracion. La suscripcion canonica del inbox pide
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
- **Messenger externo** depende del modo. En manual usa un User Token humano
  distinto del System User Token: el usuario lo pega en
  `Configuracion > Meta > Redes sociales > Messenger`, Ristak valida la Page y
  lo cifra en `meta_config.messenger_user_token`. En `oauth_bisu`, Installer
  entrega en el handoff el Page Token de la Page delegada y su proof; no aparece
  un segundo campo de token en UI. Anuncios/CAPI usan la credencial base activa
  y Messenger/Instagram/comentarios usan el Page token correspondiente. El
  toggle solo se habilita cuando existe la credencial requerida por el modo.
- En modo manual, las tarjetas de Messenger e Instagram muestran botones de Meta Developers que
  arman con el App ID y el portafolio de la integración guardada; nunca con un
  ID hardcodeado de Ristak. Si una conexión antigua no tenía esos IDs, Ristak
  los recupera del System User Token y los conserva en `meta_config.app_id` y
  `meta_config.meta_business_id` antes de abrir el caso de uso correcto para
  generar token/configurar Webhooks. En OAuth esos botones y campos no aparecen:
  la app y el webhook pertenecen al Installer central.
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
  `graph.facebook.com/{PAGE_ID}/messages` con token de Pagina; Instagram DM tambien envia por el nodo
  `graph.facebook.com/{PAGE_ID}/messages` cuando la cuenta profesional esta
  enlazada a la Page. En manual Ristak deriva el Page token desde la credencial
  base y liga su cache al hash del token origen. En OAuth usa el Page token y
  `page_appsecret_proof` entregados por Installer para la Page seleccionada; no
  reutiliza el proof BISU con otro token. Si Meta invalida esa credencial, exige
  reconectar OAuth en vez de pedir el App Secret central. No hay token alterno
  para Instagram; si falta el Page token, la integracion falla con un error
  accionable. El recipient sigue siendo el IGSID recibido por webhook.
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
  token; Instagram usa `/me/conversations?platform=instagram` con ese mismo Page
  token por Facebook Graph. El backfill pagina conversaciones y mensajes hasta
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
- El enriquecimiento de contactos Meta usa el mismo contrato de Page token:
  Messenger lee perfil/conversaciones por Facebook Graph con Page token;
  Instagram lee perfiles de DMs y autores de comentarios con las mismas
  credenciales resueltas para Instagram (`name,username,profile_pic`). Si el
  perfil directo no trae nombre, Instagram cae a
  `/me/conversations?platform=instagram` usando el token/baseUrl resuelto. Las
  fotos recibidas se rehospedan best-effort antes de guardarse en
  `meta_social_contacts.profile_picture_url`; si Meta no entrega foto o permisos,
  Ristak conserva el mejor nombre disponible y no inventa avatar.
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

- `form`: usa la misma configuracion del bloque `form_embed` del editor visual:
  formulario existente o formulario interno, reglas "Al enviar", estilo del
  bloque y snapshot del formulario fuente. La zona debe ser un contenedor vacio;
  no debe incluir `<form>`, campos ni botones de envio dentro o pegados a esa
  zona, porque Ristak renderiza el formulario completo dentro de un frame aislado
  con su propio boton y sus acciones "Al enviar".
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
  controles, diseno, acciones por tiempo, formulario de video y eventos
  Meta/CAPI que el editor normal. El formulario de video usa el mismo panel,
  campos, reglas de completado, diseno y submit publico del bloque nativo; el
  HTML externo solo reserva la zona donde se monta el reproductor.

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
visual. En formularios, el inspector reutiliza el control normal de `form_embed`
y el render monta una mini pagina Ristak aislada para no mezclar CSS/JS del HTML
externo con el runtime del CRM. Ese inspector no debe abrirse automaticamente solo porque el HTML tenga
un video, calendario, pago o formulario nativo detectado; aparece unicamente
cuando el usuario selecciona esa zona desde la previsualizacion o desde el modo
codigo, y se cierra cuando el usuario selecciona texto, botones, campos,
secciones, fondo u otro elemento editable que no sea esa zona nativa. Ese
inspector debe scrollear con rueda, trackpad y tactil como el panel
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
intenta iniciar cobros hasta que el sitio publicado confirme el pago. En el sitio
publicado, los pagos importados usan el checkout publico real de Ristak y nunca
la maqueta deshabilitada del editor. Los calendarios nativos dentro del preview
usan la ruta interna `/api/sites/public/calendar-preview/:slug`, no
`/calendar/:slug`, para que el editor pueda mostrarlos sin depender de que el
dominio publico ya este configurado; el sitio publicado conserva la ruta publica
normal y no debe llevar `editor_preview=1` ni `preview=1`. Los calendarios
custom publicados conservan su UI importada, pero las funciones
`window.ristakCalendarGetSlots` y `window.ristakCalendarBook` deben apuntar a los
endpoints publicos vivos de disponibilidad y agendado.

Cuando el usuario edita directamente el codigo HTML y todavia no ha guardado,
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
respuestas privadas usan el `comment_id` para mandar un unico mensaje inicial al
comentarista por Messenger o Instagram DM. Las respuestas privadas a comentario
cuentan como mensaje enviado para una espera posterior de respuesta; las
respuestas publicas no abren una espera de DM. Si una respuesta a comentario
falla temporalmente y entra a reintento, la inscripcion debe conservar
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
- Soft delete, move, replace.
- Cuotas.
- Compresion.
- Bunny Storage para archivos.
- Bunny Stream para video.
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

La API conserva endpoints separados:

- `/api/ai-agent`: asistente interno.
- `/api/conversational-agent`: agentes conversacionales.

### Configuracion y experiencia del usuario

Todos los agentes conversacionales usan un solo runtime nativo de tool calling.
No existe selector, fallback ni ruta de ejecucion del motor anterior. El editor
deja plantillas utiles por defecto y separa tres piezas visibles:

- Estrategia y capacitacion: conocimiento, objetivo, guion y proceso del negocio.
- Personalidad: tono, vocabulario, formalidad, humor, emojis y estilo del agente.
  Si queda vacia, la voz general del negocio funciona como respaldo.
- Zona blindada: manifiesto derivado por el servidor para las capacidades
  `schedule_appointment`, `collect_payment`, `send_link`, `handoff_human` y
  `custom_goal`. Se muestra en la interfaz, pero nunca se acepta desde el cliente
  como fuente de permisos ni se mezcla con el texto editable.

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
configurado; enlace a una URL segura; traspaso a sus reglas y usuario; objetivo
propio a una descripcion concreta. Al editar una capacidad activa el agente se
pausa para probarlo antes de volver a publicar. Un borrador apagado puede quedar
incompleto; al publicar, el backend valida el manifiesto otra vez y consulta la
realidad operativa antes de persistir el cambio: calendario y usuario activos,
producto/precio relacionados y cobrables, moneda de la cuenta, monto de
anticipo y destino HTTP(S) de enlaces directos o triggers.

Agenda define ademas `bookingOwner`: `ai` hace que la IA revalide, cree y solo
despues confirme la cita; `human` deja que la misma IA consulte y ofrezca slots
reales, pero al elegirse uno ejecuta `request_human_booking`. Esa tool vuelve a
comprobar que el horario siga libre, guarda la fecha y el contexto, cambia el
chat a atencion humana y avisa al equipo sin crear ni prometer una cita. Puede
asignarse un usuario activo concreto o avisarse al equipo sin asignacion. La
asignacion generica de `handoff_human` no se hereda silenciosamente cuando
Agenda dice "sin asignar".

En la capacidad Cobrar, `paymentMode` es la fuente de verdad: pago completo
apaga cualquier configuracion vieja de anticipo y anticipo la activa. Los montos
se editan con el simbolo derivado de `account_currency` y respetan los decimales
de esa moneda. Publicar permanece accionable aun cuando falte configuracion: al
intentarlo, la interfaz muestra el requisito exacto dentro de Cobrar y junto al
boton, en vez de dejar un boton deshabilitado sin explicacion. Si el catalogo no
puede cargarse, el selector tambien informa el error en lugar de aparentar que
no existen productos.

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
  CREADOS despues del corte.
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
devuelve cortes estructurados. Las respuestas menores a 120 caracteres salen en
un solo globo sin otra llamada; las que superan ese umbral exigen de dos a seis.
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
idempotencia en servidor. Agendar, completar un objetivo o transferir reutiliza
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

El prompt se arma en servidor con el texto editable, contexto real recuperado
y la zona blindada al final. El texto del dueño puede cambiar personalidad y
conocimiento, pero no agregar tools, cambiar calendario/producto/monto/moneda ni
convertir un resultado pendiente o fallido en exito.

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

Una conversacion `completed` solo se reabre con un inbound nuevo cuando el mismo
agente sigue publicado y todavia cumple entrada, salida y alcance. Los handoffs,
pausas, omisiones y asignaciones manuales no se borran con heuristicas de edad.

Los seguimientos usan el mismo agente principal y el mismo transcript; no
inventan un mensaje nuevo del contacto ni llaman un analizador aparte. Las tools
de mutacion quedan fuera en modo seguimiento. Estado, opt-out, ventana del canal,
mensajes nuevos y numero de intento se comprueban como hechos externos antes de
enviar.

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
telefono ni marcarlo como cliente anterior. En **Mas opciones de prueba** el
usuario puede activar validaciones controladas, elegir un contacto existente y
habilitar por separado agenda, cobro y notificacion. Elegir contacto nunca crea
uno nuevo. En ese modo el servidor conserva `dryRun=true` para todas las tools,
recarga las capacidades guardadas del agente e ignora cualquier calendario,
producto, precio, monto o moneda enviados como override por el navegador.

Las validaciones se guardan de forma aislada en
`conversational_agent_test_runs` y `conversational_agent_test_effects`, ligadas
al usuario, agente, contacto, sesion y mensaje. Requieren acceso de lectura a
Contactos y permiso de escritura en Citas o Pagos segun corresponda; otro
usuario no puede leer ni limpiar la corrida. Cada efecto usa hash, llave
idempotente, claim token y lease: reintentar el mismo mensaje no duplica la
evidencia ni la notificacion. Al reiniciar, cambiar contacto, apagar el modo o
cerrar el editor, el frontend pide limpiar la corrida; el servidor la cierra por
compare-and-swap antes de limpiar para bloquear efectos tardios.

La validacion de agenda vuelve a consultar el calendario estricto y registra el
horario probado, pero no inserta una cita real, no cambia el chat y no cuenta una
conversion. La validacion de cobro vuelve a cruzar capacidad, catalogo, cantidad,
monto y `account_currency`, pero no crea pago ni link, no llama al proveedor, no
envia nada al contacto y nunca simula un pago confirmado. Es una prueba de la
decision y de la autoridad de datos de Ristak, no una prueba sandbox de la
pasarela. Si se activa **Notificarme al validar**, la campana/push se dirige solo
al usuario que inicio la prueba; el estado de envio queda durable y un fallo se
muestra como pendiente en lugar de afirmar que se notifico.

### Herramientas y verdad operativa

La lista de tools se construye desde las capacidades activadas; una
capacidad apagada no se puede recuperar escribiendo su nombre en el prompt. Las
tools de lectura consultan negocio, contacto y catalogo real. Cada tool
valida sus precondiciones y sella en `ctx.actions[].outcome` si el resultado fue
`ok`, `error` o `simulated`. El estado final usa ese outcome y la base de datos,
nunca un booleano escrito por el modelo.

- Citas: v2 fija el calendario en servidor, consulta slots reales y vuelve a
  comprobar que el horario exista y siga libre. La llamada nativa reemplaza el
  detector textual de confirmacion. `get_free_slots` entrega el instante UTC que
  debe copiarse sin cambios a `book_appointment` y, por separado, fecha, hora y
  etiqueta visibles ya calculadas con la zona horaria del negocio; el modelo no
  convierte UTC ni adivina el horario que debe decirle a la persona. La
  idempotencia de cada intento se deriva de
  mensaje, canal, contacto, calendario y slot; un retry reproduce la cita
  canonica. La exclusion fisica del slot vive en el candado
  transaccional del calendario, que serializa altas del agente contra citas
  manuales. El ledger de creacion usa token y lease: una caida recupera la cita
  real o libera el intento sin dejar el horario bloqueado para siempre. Si la
  cita fue reprogramada, la tool relee fecha, hora y calendario canonicos y nunca
  confirma el snapshot viejo. Ademas, antes de crear una cita v2 se busca cualquier
  cita futura activa unida al mismo agente, contacto y calendario por su request
  durable. Si un crash creo la cita pero no alcanzo a sellar el cierre, incluso un
  inbound posterior que proponga otro slot repara la cita ya existente en lugar de
  duplicarla. Una cita ajena o de otro calendario nunca se adopta como exito del
  agente. El ID local/GHL se canonicaliza al calendario local activo. Un fallo de
  calendario o disponibilidad cierra en seguro.
  El contacto de la cita es siempre el contacto canonico del hilo. Si quien
  asistira es un familiar o tercero, el modelo manda `attendeeName` y
  `attendeeContext`; Ristak conserva al remitente como contacto y guarda el nombre
  y contexto del asistente en titulo/notas, sin buscar otra ficha ni insistir con
  otro telefono. Cuando `bookingOwner=human`, `request_human_booking` comparte la
  misma revalidacion estricta y el mismo slot UTC, pero sella una solicitud humana
  idempotente en lugar de llamar al controller de creacion. Un retry exacto no
  duplica el aviso y un slot ocupado no cambia estado, asignacion ni notificaciones.
- Pago: producto, precio, monto, concepto y moneda deben coincidir con la
  capacidad blindada o el catalogo real. Antes de hablar con el proveedor, v2
  reserva una llave durable
  por agente, contacto, producto/precio, monto, moneda, canal y mensaje entrante;
  concurrencia o replay del mismo mensaje reproducen el resultado, mientras un
  mensaje posterior permite una compra nueva legitima. Si la reserva no se puede
  guardar, falla cerrado. La reserva guarda tambien el request canonico y el
  evento determinista que vincula el cobro con agente, contacto, proposito y
  ejecucion. Crear/enviar link deja la compra `pending`; solo un pago real la
  completa. Si el proveedor alcanzo a crear el link pero el proceso cayo antes de
  sellar ese vinculo, el recovery de arranque o webhook reconstruye primero la
  fila `processing` desde el invoice/ledger exactos y despues sella el source event.
  `request_json` debe conservar su hash original; una mutacion de proposito, monto
  o identidad bloquea el cobro. Los filtros persistidos de contacto e invoice
  permiten reparar el webhook objetivo sin quedar detras de otros pendientes.
  La reconciliacion exige status exitoso
  explicito y cruza el invoice contra su fila exacta, monto en unidades menores,
  moneda, proposito inmutable y ambiente.
  Los tres ambientes deben ser `live`: pagos `test`/sandbox, datos ausentes o
  cualquier diferencia quedan rechazados sin marcar compra. Un claim durable y
  checkpoints por señal, aviso y evento hacen idempotentes los webhooks repetidos
  y el recovery tras reinicio. V2 no reutiliza invoices recientes solo porque
  contacto, monto y concepto se parezcan; su dedupe fuerte queda ligado a agente,
  capacidad, producto/precio y mensaje. Un supuesto comprobante del modelo no
  sirve como evidencia.
- Anticipos: se cobran por los metodos configurados. Con `paymentLink`, el agente
  puede mandar `create_payment_link` aunque su cierre sea una cita. Con
  `bankTransfer`, comparte los datos configurados y, al recibir la foto o PDF del
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
  Si el anticipo aprobado pertenecia a una cita, el runner recibe el pago como
  contexto factual interno, recupera el hilo completo y vuelve a comprobar el
  slot antes de agendar; antes de crearla reserva esa evidencia para un request de
  cita concreto con `claimToken` y lease. El controller vuelve a bloquear y validar
  ese fencing token, el pago y la reconciliacion dentro de la misma transaccion que
  inserta la cita; un proceso viejo no puede despertar y crear otra cita despues de
  perder la lease. Una lease vencida solo se recupera si el request anterior nunca
  alcanzo a crear cita o su cita canonica ya esta inactiva. Al confirmar la cita se
  consume el contrato de anticipo congelado en el intento, aunque luego cambie la
  configuracion. Otro request no puede gastar de nuevo el mismo anticipo. No fabrica
  un mensaje del cliente ni espera otro inbound.
  El equipo recibe push para auditar el comprobante. Un
  comprobante ilegible, con monto distinto u otra moneda se rechaza y el agente
  pide una foto clara o transfiere. En v2, pago y evento se guardan en una sola
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
- Confirmaciones posteriores: webhooks reales de pago o integraciones externas
  pueden cerrar una meta pendiente. Reutilizan el resumen factual, no levantan
  otra IA y no aplican asignaciones, etiquetas ni campos ajenos a las capacidades
  blindadas.
- Meta por URL: el enlace visible contiene solo un ID de seguimiento y se puede
  entregar aunque apunte a una pagina externa generica. La meta queda `pending`:
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

Los tokens se tratan como secretos. La documentacion solo debe indicar nombres,
ubicacion y uso, nunca valores.

El soporte interno para revisar clientes instalados no usa este MCP externo. Los
agentes deben entrar por el MCP/CLI de soporte de Ristak Installer, documentado
en `docs/support-mcp-operations.md`, para resolver la instalacion, leer logs,
inspeccionar schema y consultar filas read-only de la DB del cliente.

La API externa y MCP no son bypass de plan. Para generar/rotar/revocar tokens y
usar `/api/external` o `/api/mcp` se requiere `developers`; cada endpoint/tool
vuelve a revisar la feature del recurso (`payments`, `payment_plans`,
`subscriptions`, `reports`, `campaigns`, `appointments`, `sites`, `contacts`,
`integrations`, etc.). Un token generado antes de un downgrade no conserva
acceso a modulos que el plan actual ya no incluye.

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
La bandeja Android expone el Hub del agente conversacional desde el robot de la
esquina superior izquierda, con control individual para encender/pausar,
reiniciar omisiones y editar la configuracion principal. Dentro de un chat con
agente asignado, el robot vive a la izquierda del calendario en la capsula del
header y abre los controles por contacto (`pause`, `take_over`, `skip`,
`resume`/`activate` y `clear_signal`). No existe un runtime global que pueda
bloquear al agente: la app controla directamente cada agente individual y no
presenta `Apagar todos`.

La pantalla de analiticas nativa debe mantenerse alineada con
`PhoneAnalytics`: periodos `30d`/`60d`/`180d`/`year`/`custom`, 8 KPIs, grafica
principal, embudo, distribucion de origen y origen por numero de WhatsApp. Los
rangos se calculan con `account_timezone`, el rango personalizado usa fechas
`YYYY-MM-DD`, y los importes se formatean con `account_currency`. Si no se pueden
confirmar ambos valores, la pantalla falla cerrada y ofrece reintento en vez de
mostrar cifras o periodos con defaults inventados. Si la licencia
no incluye `web_analytics`, Android manda `includeWeb=0` al embudo/origen y no
muestra visitantes ni trafico web.

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

El bootstrap Android precarga a memoria los snapshots de la sesion antes de
montar el shell (maximo 180 archivos, 32 MiB y 45 dias). Asi Chats, Calendario,
Pagos, Analiticas y Ajustes pintan el ultimo estado de esa cuenta de inmediato y
revalidan sin dejar una pantalla vacia: Pagos conserva el gating conocido de
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
media real del mensaje.
El topic APNs valido para la app Apple es exactamente `com.ristak.app`; el
Installer no debe reportar iOS configurado con un bundle legacy o Android. La
app registra el token con `platform=ios`, `clientType=native` y
`appPackage=com.ristak.app`. Permiso del sistema y registro confirmado por
backend son estados separados: Ajustes solo muestra alertas activas cuando ambos
estan listos. La activacion se serializa, usa reintentos 5/15/60/300 s y se
revalida en foreground si la confirmacion supera 6 h. Logout deshabilita el
device con `DELETE /api/push/mobile-devices` best-effort y siempre limpia APNs
local; 401/licencia revocada tambien ejecutan la limpieza local inmediata.
La Notification Service Extension serializa tareas/callbacks para finalizar una
sola vez, descarga con timeouts de 6–7 s y limita el avatar a 5 MB y la media
adjunta a 12 MB; si no puede enriquecer, entrega la notificacion base.
El login de `com.ristak.app` muestra marca Ristak, solo pide correo y contrasena,
no expone configuracion avanzada de servidor y resuelve automaticamente la
instalacion correcta por correo via `https://www.ristak.com/api/mobile/resolve`
antes de autenticar contra el backend del cliente.
En Android hay dos contratos: el legacy Capacitor (`frontend/android`,
`com.ristak.app`) sigue usando FCM data-only para que
`RistakFirebaseMessagingService` dibuje la notificacion nativa; la app Play/Expo
(`mobile/`, `com.ristak.android`) registra el token con `clientType=expo` y debe
recibir `message.notification` visible mas `message.data` completa para
navegacion. Ristak Installer guarda cifrado el `google-services.json` de
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
| Meta Ads/Dataset/social | Credencial activa cifrada en `meta_config`; app/secret/Config ID central en DB de Installer; env solo fallback legacy | No | `manual_system_user` y `oauth_bisu` conviven; OAuth usa handoff y proofs, `meta_test_event_code` activa Test Events |
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
