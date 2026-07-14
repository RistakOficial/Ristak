# Arquitectura de proveedores WhatsApp

Ultima actualizacion: 2026-07-12.

## Proposito

Este documento es la fuente de verdad para distinguir las tres implementaciones
de WhatsApp de Ristak. Debe leerse antes de modificar conexión, webhooks,
mensajes, historial, contactos, plantillas, media, fallback o soporte de
WhatsApp.

La regla principal es: **YCloud, Meta directo y Baileys no son sinónimos**. Dos
pueden usar la API oficial de Meta, mientras el tercero usa WhatsApp Web por QR.
Compartir el chat y algunas tablas no autoriza a mezclar credenciales, endpoints,
eventos ni IDs.

## Vocabulario obligatorio

| Campo | Valores | Significado |
| --- | --- | --- |
| `provider` | `ycloud`, `meta_direct`, `qr` | Relación/proveedor que posee la conexión del número. |
| `transport` | `api`, `qr` | Camino real usado para ese envío o captura. |
| `source_adapter` | `ycloud`, `meta_direct`, `baileys` | Código que interpretó o produjo el registro. |
| `origin` | Evento/campo del proveedor | Evento específico que originó el registro. No sustituye a `provider`. |

Ejemplos:

- Mensaje normal por YCloud: `provider=ycloud`, `transport=api`,
  `source_adapter=ycloud`.
- Mensaje normal por Cloud API: `provider=meta_direct`, `transport=api`,
  `source_adapter=meta_direct`.
- Fallback QR de un número oficial: conserva el `provider` propietario del
  número, pero usa `transport=qr` y `source_adapter=baileys`.
- Número únicamente QR: `provider=qr`, `transport=qr`,
  `source_adapter=baileys`.

Nunca etiquetar una captura de Baileys como `source_adapter=ycloud` o
`source_adapter=meta_direct`, aunque el mismo número también tenga API oficial.

## Autoridad de ruteo para envíos

La fila elegida en `whatsapp_api_phone_numbers` es la autoridad del envío. El
backend debe resolver en cada solicitud:

1. `phoneNumberId` enviado por el chat, automatización o flujo de producto;
2. si no viene, el número predeterminado guardado;
3. `provider`, teléfono emisor, WABA y disponibilidad API desde esa misma fila;
4. `transport=api` o el respaldo `transport=qr` asociado a ese número.

`whatsapp_api_provider` es una preferencia global histórica y de configuración.
No puede sobreescribir el `provider` de la fila seleccionada. En particular:

- una fila `provider=ycloud` siempre llama YCloud, aunque Meta directo esté
  conectado, revocado o haya quedado como preferencia global;
- una fila `provider=meta_direct` siempre llama Graph y nunca usa la API key de
  YCloud;
- una fila `provider=qr` sin conexión API oficial hermana sólo usa Baileys;
- desactivar o revocar una fila no debe apagar ni secuestrar las otras.

Si una fila QR representa el mismo teléfono que una fila oficial sana, la fila
oficial toma la salida aunque el consumidor histórico haya solicitado
`transport=qr`. QR es respaldo, no un segundo remitente: sólo toma el mensaje
cuando la API está inequívocamente indisponible y la solicitud puntual lo
autorizó. Una ventana de 24 horas cerrada exige plantilla oficial y nunca cambia
el transporte a Baileys.

Si Meta pierde permisos, además de marcar su fila `AUTHORIZATION_REQUIRED`, se
reconcilia la preferencia global a YCloud cuando esa conexión sigue disponible.
Esto protege rutas históricas, pero no sustituye la regla por fila.

El respaldo QR sólo se ejecuta cuando existe una sesión compatible del mismo
teléfono, la solicitud tiene `allowQrFallback=true` y el fallo confirma pérdida
de conexión/autorización, suspensión, restricción o límite del transporte. No
aplica a ventana cerrada, plantilla no aprobada, destinatario, contenido,
`131047`, `131053`, timeout, red ni HTTP 5xx. Campañas/broadcasts siempre usan
`allowQrFallback=false`.

El webhook es un observador: persiste estados y puede marcar la API restringida
para solicitudes futuras, pero jamás origina un envío QR. Si una solicitud fue
aceptada y después llega `failed`, se conserva como fallo API. Esta frontera
evita que un evento tardío mande una segunda copia sin autorización.

## Matriz de implementaciones

| Implementación | API oficial | Intermediario | Coexistence | Entrada principal | Autenticación |
| --- | --- | --- | --- | --- | --- |
| YCloud | Sí | YCloud | Sí, cuando la cuenta lo habilita | `POST /webhook/whatsapp-api/ycloud` | `YCloud-Signature` con secreto del endpoint |
| Meta directo | Sí | Ninguno para Graph; Installer coordina el onboarding y retransmite webhooks por instalación | Sí | `POST /api/whatsapp-api/meta/webhook-relay` | Firma HMAC interna de Installer |
| WhatsApp QR | No; usa WhatsApp Web | Baileys | No es Coexistence oficial | Eventos del socket Baileys | Estado de vinculación QR cifrado |

Meta directo puede dejar de usar el relay de Installer cuando cada instalación
tenga callback público directo y verificación Meta completa. Ese cambio debe
crear un endpoint explícito de Meta; jamás debe reutilizar el endpoint de YCloud.

## Identificadores y base de datos

### Mensajes

`whatsapp_api_messages` es el historial canónico compartido. Las columnas
neutrales son:

- `provider`: proveedor dueño del número.
- `source_adapter`: implementación que procesó el mensaje.
- `provider_message_id`: ID devuelto por ese proveedor/adaptador.
- `wamid`: ID original de WhatsApp cuando exista. En Coexistence, el WAMID
  oficial y el `key.id` de Baileys no son cadenas iguales.
- `protocol_message_key_id`: identidad interna que WhatsApp incluye dentro del
  WAMID oficial y que Baileys entrega directamente como `key.id`. Es la llave
  exacta para reconciliar ambos adaptadores sin comparar contenido ni tiempo.
- `transport`: `api` o `qr`.
- `origin`: evento concreto (`whatsapp.message.updated`, `messages`, `history`,
  `smb_message_echoes`, etc.).

Compatibilidad histórica:

- `ycloud_message_id` solo guarda IDs de YCloud por transporte API.
- `meta_message_id` solo guarda IDs de Meta directo por transporte API.
- Código nuevo debe leer primero `provider + provider_message_id` y `wamid`; las
  columnas específicas existen para compatibilidad y diagnóstico.
- Un ID de Meta jamás se debe escribir en `ycloud_message_id`.
- Un ID de Baileys jamás se debe escribir en `ycloud_message_id` ni
  `meta_message_id`.
- `protocol_message_key_id` tiene unicidad local cuando la reparación histórica
  terminó. El upsert sin target de conflicto cierra la carrera en la que webhook
  y socket intentan insertar el mismo mensaje al mismo tiempo.

### Eventos, envíos de plantilla y contactos

- `whatsapp_api_webhook_events.provider` separa eventos YCloud y Meta directo.
- `whatsapp_api_template_sends` conserva `provider`, `source_adapter` y
  `provider_message_id` además de los campos legacy.
- `whatsapp_api_contacts` conserva teléfono y, cuando el proveedor los entregue,
  `whatsapp_user_id`, `parent_whatsapp_user_id` y `username`.
- Después del rollout de BSUID, no se debe asumir que el teléfono es el único
  identificador estable. Los campos BSUID son opcionales y se rellenan sin
  invalidar contactos históricos.

### Plantillas

Las plantillas comparten el contenido de negocio (`name`, `language`,
`category`, componentes, variables y ejemplos), pero **no comparten el contrato
de administración del proveedor**.

| Operación | YCloud | Meta directo |
| --- | --- | --- |
| Crear | `POST /v2/whatsapp/templates`; `wabaId` viaja en el body | `POST /{WABA_ID}/message_templates`; el WABA viaja en la ruta y no en el body |
| Listar | `GET /v2/whatsapp/templates` con `items`/`data` y paginación YCloud | `GET /{WABA_ID}/message_templates` con `data` y cursores Graph |
| Consultar | Ruta por `wabaId/name/language` | Por `TEMPLATE_ID` o filtro `name` sobre el WABA |
| Editar | `PATCH /v2/whatsapp/templates/{wabaId}/{name}/{language}` | `POST /{TEMPLATE_ID}` |
| Eliminar | Ruta por `wabaId/name/language` | `DELETE /{WABA_ID}/message_templates?name=...`; puede incluir `hsm_id` para una versión concreta |
| Estado | Payload/eventos YCloud normalizados | `message_template_status_update`, `template_category_update` y `message_template_quality_update` |

Modelo local neutral:

- `whatsapp_message_templates.template_provider` dice quién administra la copia
  remota actual: `ycloud` o `meta_direct`.
- `provider_template_name`, `provider_template_id`, `provider_status`,
  `provider_reason`, `provider_status_update_event`, `provider_quality_rating`,
  `provider_raw_payload_json`, `provider_submitted_at` y `provider_synced_at`
  son el contrato que debe usar código nuevo.
- Las columnas `ycloud_*` se conservan para compatibilidad y diagnóstico. Solo
  se actualizan cuando `template_provider=ycloud`. Un ID de Meta jamás se guarda
  en `ycloud_template_id`.
- `whatsapp_api_templates` conserva `provider`, `source_adapter` y
  `provider_template_id`. `official_template_id` sigue disponible como alias
  histórico del ID remoto.
- Cambiar el proveedor activo no convierte una plantilla existente: si la copia
  remota pertenece a YCloud y se envía por Meta directo, se crea una identidad
  Meta nueva. Nunca se manda el ID YCloud al endpoint Graph.

Encabezados multimedia:

- YCloud acepta `example.header_url` en el payload que hoy construye el editor.
- Meta directo exige `example.header_handle`, obtenido mediante una carga previa
  a Graph. `header_url` y `header_handle` no son equivalentes.
- Ristak guarda el handle Meta por separado en
  `whatsapp_message_templates.meta_header_handle`. El adaptador Meta rechaza una
  URL YCloud con el código `META_TEMPLATE_HEADER_HANDLE_REQUIRED` en lugar de
  enviar un payload incorrecto.
- Cuando se conecte la carga multimedia directa, su responsabilidad será obtener
  el handle y llenar `meta_header_handle`; no debe reemplazar
  `header_media_url`, porque esa URL sigue siendo útil para preview y YCloud.

Coexistence no cambia estos endpoints. Sirve para mantener WhatsApp Business App
y Cloud API sobre el mismo número, pero las plantillas siguen perteneciendo al
WABA y se administran mediante el proveedor activo una sola vez.

## Contratos de webhook

### YCloud

YCloud entrega un evento propio con `id`, `type`, `apiVersion`, `createTime` y
un objeto específico como `whatsappMessage` o `whatsappInboundMessage`.
Ristak necesita al menos:

- `whatsapp.inbound_message.received` para entradas.
- `whatsapp.message.updated` para estados salientes.
- `whatsapp.smb.history` para historial compartido en Coexistence.
- `whatsapp.smb.message.echoes` para mensajes enviados desde WhatsApp Business o
  dispositivos companion.

El ID de YCloud y el `wamid` son cosas distintas. Se guardan por separado.

### Meta directo

Meta entrega el envelope `object=whatsapp_business_account` con
`entry[].changes[]`. El adaptador de Meta debe interpretar por separado:

- `value.messages[]`: mensajes entrantes normales.
- `value.statuses[]`: estados de mensajes salientes.
- `value.smb_message_echoes[]` o `value.message_echoes[]`: mensajes enviados
  desde la app WhatsApp Business durante Coexistence.
- `value.history[]`: lotes históricos aceptados durante onboarding.

`value.statuses[]` es un recibo de entrega, no un mensaje visible. Debe buscar la
fila saliente por `wamid`/`meta_message_id`, actualizar únicamente estado y error,
y publicar un refresh con `isNew=false`. Nunca debe pasar por el alta normal de
mensajes ni crear una burbuja vacía. Si el ACK llega antes de que termine el POST
a Graph, se permite guardar temporalmente una fila `message_type=status` sin
contacto; esa fila es invisible para conversación, bandeja y conteos, y el
INSERT del envío la convierte en el mensaje real usando el mismo `wamid`.

Todo envío de texto aceptado por Graph debe persistirse de inmediato con el texto
visible, `provider=meta_direct`, `source_adapter=meta_direct`,
`meta_message_id`, `wamid`, `contact_id` y `localMessageId`. Los ACK posteriores
se fusionan con esa misma fila. Texto, plantillas, interactivos, ubicación,
foto, documento, video y audio seleccionados para Meta Direct salen por Graph y
nunca usan el endpoint de mensajes ni el upload de YCloud. El fallback QR aplica
con las mismas reglas estrictas de indisponibilidad que YCloud.

Meta directo también conserva el contrato conversacional nativo. Una respuesta
saliente usa `context.message_id`; una reacción usa `type=reaction` con
`reaction.message_id` y `reaction.emoji`; al abrir el chat, el visto se manda por
Graph con `PUT /{PHONE_NUMBER_ID}/messages`, `status=read` y el `wamid` entrante.
Ese acuse se resuelve por la fila real `provider=meta_direct`: nunca debe caer al
endpoint `markAsRead` de YCloud por una preferencia global vieja. Si el número
tiene QR como respaldo, Baileys tampoco manda un segundo visto mientras
`api_send_enabled=1`.

La suscripción `/{WABA_ID}/subscribed_apps` se crea al conectar. Si el relay no
ha recibido eventos durante al menos 30 minutos, el siguiente envío Meta Direct
renueva esa suscripción de forma idempotente antes de mandar el mensaje. Los
intentos se limitan a uno cada seis horas mediante
`whatsapp_meta_direct_last_subscription_refresh_at`; un fallo al renovar se
registra, pero no cambia de proveedor ni derrama el envío hacia QR.

Los mensajes Click to WhatsApp llegan en `value.messages[].referral`. Meta
entrega el contrato plano `source_id`, `source_url`, `source_type`, `headline`,
`body`, `media_type`, `image_url`, `video_url` y `thumbnail_url`. El adaptador
debe conservar ese objeto sin renombrarlo como evento YCloud; la capa neutral
extrae los mismos campos `detected_*`, crea el touch en
`whatsapp_api_attribution`, actualiza la atribución del contacto y expone el
preview por mensaje. Si la URL visual es temporal de Meta, se re-hospeda antes
de guardarla.

No se deben renombrar estos campos como eventos YCloud. Ambos pipelines terminan
en el mismo modelo interno, pero conservan `provider`, `source_adapter`,
`origin`, payload crudo e IDs propios.

### Baileys

Baileys procesa `messages.upsert`, `messaging-history.set` y ACKs del socket.
Es transporte QR y fallback; no es un proveedor de Cloud API, no usa las
credenciales de Meta/YCloud y no debe consumir sus webhooks. Mientras la API
oficial del mismo número esté operativa, `captureQrChatMessage` omite todo el
tráfico vivo inbound/outbound. Sólo HistorySync puede importarse en paralelo.

## Reglas de Coexistence

En Embedded Signup v4, Meta activa este flujo automáticamente cuando el usuario
ingresa un número que ya está activo en la app de WhatsApp Business. Un número
nuevo sigue el flujo estándar de Cloud API.

1. Un número puede seguir activo en WhatsApp Business y en una API oficial.
2. `history` es importación, no tráfico nuevo. Se persiste y publica para
   refrescar UI, pero no incrementa no leídos ni dispara push, confirmaciones,
   automatizaciones o agente conversacional.
3. `smb_message_echoes` sí es tráfico nuevo enviado manualmente desde la app y
   debe aparecer como única fila oficial. Con API operativa, la captura viva
   `fromMe` de Baileys se omite antes de persistir. La identidad
   `protocol_message_key_id` queda para reconciliar históricos demostrables;
   nunca se compara texto, minuto, tipo de media o parecido visual.
4. El historial puede llegar por lotes grandes, duplicado o fuera de orden. El
   procesamiento debe ser idempotente y asíncrono cuando el volumen lo exija.
5. No existe un endpoint Graph genérico para volver a descargar toda la cuenta
   cuando se quiera. `syncMetaDirectHistory` debe seguir reportando
   `not_available`; la carga histórica depende de los webhooks de onboarding.
6. YCloud y Meta directo pueden quedar configurados en la misma instalación,
   pero solo un proveedor API debe ser el remitente activo para un número en un
   momento dado. No se debe enviar el mismo request por ambos “por seguridad”.
7. Baileys puede ser fallback explícito. El resultado final debe registrar
   `transport=qr` y `source_adapter=baileys`.
8. La preferencia global del tenant no decide el proveedor de salida. Cada
   mensaje usa el proveedor de la fila `phoneNumberId` elegida.
9. Al arrancar una versión que introduce la identidad de protocolo, Ristak
   rellena esa llave y fusiona sólo pares históricos QR + eco SMB demostrables.
   Dos mensajes iguales o dos envíos del mismo archivo permanecen separados si
   WhatsApp les asignó identidades distintas.
10. La persistencia compartida debe funcionar igual en PostgreSQL y SQLite.
    Cuando todavía no existe una fila conocida, hace `INSERT ... ON CONFLICT DO
    NOTHING`, resuelve la fila canónica por ID de proveedor, WAMID o
    `protocol_message_key_id`, y sólo entonces actualiza por la llave primaria
    con `ON CONFLICT(id) DO UPDATE`. Nunca se usa una actualización de conflicto
    sin objetivo: PostgreSQL la rechaza y el mensaje quedaría enviado por el
    proveedor pero marcado como error dentro de Ristak.
11. El ID oficial del proveedor manda. En tráfico nuevo con API operativa no se
    crea la fila espejo de Baileys; YCloud/Meta produce la única fila y sus
    estados `accepted`, `sent`, `delivered` y `read` la actualizan. La fusión por
    `protocol_message_key_id` sólo repara/importa históricos exactos. No se
    permite resolver ningún caso por texto, hora, teléfono aproximado ni
    deduplicación visual.
12. `(provider, provider_message_id)` es una identidad única. El mantenimiento
    de arranque fusiona duplicados históricos demostrables antes de crear el
    índice único parcial; si encuentra un conflicto entre conversaciones
    distintas, no borra nada y deja una advertencia para revisión manual.

## Embedded Signup centralizado

La pantalla `Configuración > WhatsApp` prepara el onboarding con Ristak
Installer por llamadas backend-to-backend. El botón navega la misma pestaña a
`/meta/whatsapp/connect` en el dominio central autorizado; ahí se ejecuta el SDK
y se abre únicamente la ventana oficial de Meta. Al terminar, la pestaña regresa
al mismo origen y a `/settings/whatsapp/numbers`, conservando la sesión desde la
que inició el usuario aunque la instalación tenga dominio personalizado y dominio
Render. El origen se toma del request, se firma en `state` y Installer lo valida
contra `installations.app_url` y `installations.app_origin_url`; nunca se acepta
un destino arbitrario enviado por el navegador. El SDK nunca corre desde dominios variables como
`*.onrender.com`, por lo que no depende de registrar cada cliente como dominio
JSSDK en la app de Meta. La instalación crea un `state` firmado con su licencia y
TTL de 15 minutos; el navegador no recibe tokens ni App Secret.

Installer es dueño de `meta_app_id`, `meta_app_secret`,
`whatsapp_business_login_config_id`,
`whatsapp_business_login_config_v4_id` y del webhook central. La clave sin
sufijo conserva temporalmente el flujo v2; la v4 tiene prioridad y deja que Meta
detecte Coexistence o Cloud API según el número ingresado. El JavaScript SDK usa
`featureType=whatsapp_business_app_onboarding` para mantener disponible
Coexistence. Recibe el `code` y los IDs de la sesión, y el backend central:

1. valida firma, licencia, instalación, dominio y expiración;
2. canjea el `code` y valida `app_id`, permisos, WABA y Phone Number contra Graph;
3. entrega el token en tránsito al endpoint firmado
   `/api/whatsapp-api/meta/connect/complete` de esa instalación;
4. activa una ruta exclusiva `waba_id -> installation_id`;
5. retransmite `object=whatsapp_business_account` por la cola durable existente
   hacia `/api/whatsapp-api/meta/webhook-relay`.

El sitio web es obligatorio por defecto en el portfolio comercial. La casilla
para declarar que el negocio no tiene sitio ni página de perfil sólo se habilita
a Solution Partners Select o Premier aprobados para Partner-led Business
Verification. No depende del número ni puede habilitarse desde Ristak. Si Meta
aprueba a Ristak, Installer deberá procesar el `account_update` con
`PARTNER_CLIENT_CERTIFICATION_NEEDED` y certificar al cliente antes de permitir
el envío de mensajes.

Fuentes de este contrato: [Meta — sitio web opcional](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/website-optional/)
y [Meta — Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4/).

La conexión no se considera operativa sólo porque Meta devolvió un token o
porque `/{WABA_ID}/subscribed_apps` respondió. Antes de guardar `connected`, el
tenant debe listar `/{WABA_ID}/phone_numbers` con el token recibido y comprobar
que el `Phone Number ID` seleccionado está en esa respuesta. El Installer valida
además que el token sea `SYSTEM_USER`, no esté vencido y conserve
`whatsapp_business_management` y `whatsapp_business_messaging`. Una autorización
de Meta Ads, Facebook o Instagram nunca puede sustituir el token cifrado de
`whatsapp_meta_direct_*`, aunque pertenezca a la misma app y al mismo negocio.

Meta puede retirar permisos o acceso al activo después del onboarding. Si Graph
responde `code=100/subcode=33`, `code=190` o un error de permisos equivalente al
operar el WABA/número, Ristak cambia la conexión a `reconnect_required`, desactiva
el envío API de esa fila y muestra una instrucción corta para reconectar. No debe
seguir presentando el número como conectado ni exponer el error crudo de Graph al
usuario. La reconexión explícita vuelve a validar el activo y reactiva la misma
fila; no borra historial, plantillas ni contactos.

El token termina cifrado sólo en la base del tenant. Installer conserva metadata
de sesión y ruteo; un payload de entrega pendiente queda cifrado temporalmente y
se destruye al recibir el ACK. Si el tenant estuvo caído, el siguiente state
válido de la misma instalación adopta esa entrega pendiente y vuelve a enviarla
sin canjear otro code ni reabrir OAuth. YCloud y Baileys no participan en este
flujo.

Los callbacks Installer -> tenant (`/meta/connect/complete`,
`/meta/setup-prefill` y `/meta/webhook-relay`) están antes de la autenticación
humana del router porque usan HMAC, timestamp, nonce e installation ID. Todas las
rutas operadas por una persona están después de `router.use(requireAuth)`. No se
debe volver a montar `requireAuth` sobre todo `/api/whatsapp-api`, porque eso
bloquea los callbacks firmados antes de validarlos. El mount también debe quedar
antes del router histórico `costsRoutes` montado sobre `/api`, ya que su
`router.use(requireAuth)` actúa como catch-all para cualquier ruta posterior.

Al finalizar, `meta_direct` pasa a ser el proveedor API activo. La configuración
YCloud permanece guardada para un cambio explícito posterior; nunca se hacen dos
envíos simultáneos.

Al desconectar una conexión que usa `installer_relay`, Ristak exige primero el
ACK de `/api/license/whatsapp/meta/disconnect`; sólo entonces elimina el token
local. Así no queda un WABA central activo enviando eventos a un tenant que ya
se considera desconectado.

## Desconexión por número desde Ristak

La última columna de cada fila en `Configuración > WhatsApp > Números` es la
autoridad para retirar una conexión individual. La acción siempre nombra el
proveedor o transporte y exige escribir `DESCONECTAR`. En este flujo
**desconectar no significa borrar ni dar de baja el número real**:

- YCloud: se marca sólo esa fila con `api_send_enabled=0`, deja de ofrecerse
  para enviar y sus nuevos eventos de mensajes se ignoran localmente. Ristak no
  llama una operación remota de borrado. Si era el último número YCloud activo,
  también deshabilita el webhook global y limpia las credenciales locales.
- Meta directo: se desactiva el ruteo central de Installer, se elimina el token
  local cifrado y la fila queda inactiva. El número sigue registrado en Meta y
  Coexistence no se cancela ni se desregistra remotamente.
- QR/Baileys: se cierra la sesión WhatsApp Web y se eliminan únicamente el auth
  state y la fila local QR. No se elimina la cuenta ni el número en WhatsApp.
- Si una fila oficial tiene respaldo QR, las dos conexiones se desconectan con
  acciones separadas. Retirar QR no toca API; retirar API no toca el QR.

Mensajes, contactos, plantillas, eventos e IDs históricos permanecen para
auditoría. Las filas oficiales desactivadas se conservan como tombstone local
para impedir que una sincronización normal de YCloud las reactive; una conexión
explícita posterior sí puede reactivarlas.

## Credenciales y configuración

Las credenciales viven cifradas en configuración interna/base de datos. No se
documentan valores reales y no se copian a código o Git.

YCloud usa las claves `whatsapp_api_ycloud_api_key_encrypted` y
`whatsapp_api_webhook_secret_encrypted`, además de IDs/estado con prefijo
`whatsapp_api_*`.

Meta directo usa claves con prefijo `whatsapp_meta_direct_*`, incluyendo token
de system user cifrado, WABA ID, Phone Number ID, Business ID, App ID, modo de
webhook y bandera de Coexistence.

Baileys usa las tablas/estado de sesión QR. Nunca debe leer el token de system
user de Meta ni la API key de YCloud.

## Mapa de código

- Registro y reglas neutrales:
  `backend/src/services/whatsapp/providers/providerRegistry.js`.
- Adaptador de webhook Meta directo:
  `backend/src/services/whatsapp/providers/metaDirectWebhookAdapter.js`.
- Payloads y normalización de plantillas Meta directo:
  `backend/src/services/whatsapp/providers/metaDirectTemplateAdapter.js`.
- Orquestación compartida, persistencia, envíos y compatibilidad:
  `backend/src/services/whatsappApiService.js`.
- Socket QR/Baileys: `backend/src/services/whatsappQrService.js`.
- Endpoints API/autenticados: `backend/src/routes/whatsappApi.routes.js`.
- Endpoint público YCloud: `backend/src/routes/webhooks.routes.js`.
- Esquema compatible con instalaciones existentes:
  `backend/src/config/database.js` y
  `backend/migrations/versioned/031_whatsapp_provider_foundation.sql` más
  `032_whatsapp_template_provider_foundation.sql`.

## Checklist operativo de Meta directo

Antes de declarar lista la conexión directa:

1. Confirmar que Installer tiene App ID, App Secret, WhatsApp Config ID y verify
   token, sin exponer sus valores.
2. Validar WABA, Phone Number ID, Business ID, App ID y scopes sin copiar
   secretos al repositorio.
   El token debe depurarse como `SYSTEM_USER`, no estar vencido y poder listar
   el Phone Number ID dentro de `/{WABA_ID}/phone_numbers` justo antes del ACK.
3. Suscribir la app al WABA y verificar recepción real de `messages`, estados,
   `history`, `smb_app_state_sync` y `smb_message_echoes` según los permisos
   aprobados.
4. Implementar/validar sincronización de contactos de `smb_app_state_sync`,
   incluidos BSUID, parent BSUID y username opcionales.
5. Confirmar dedupe cruzado por `wamid` cuando el mismo mensaje aparezca como
   respuesta Graph, status, echo de Coexistence o captura QR.
   El status debe actualizar una fila existente o quedar como recibo invisible
   hasta que llegue el INSERT del envío; nunca debe aparecer como `Mensaje`.
6. Probar texto, plantilla, botones, reacción, imagen, video, documento, audio y
   nota de voz con estados `sent`, `delivered`, `read` y `failed`.
   Probar además respuesta a un `wamid`, reacción entrante/saliente y visto
   saliente por `PUT /{PHONE_NUMBER_ID}/messages`.
7. Probar un lote `history` real y demostrar que no dispara efectos vivos.
8. Probar mensaje manual desde WhatsApp Business y demostrar un solo
   `business_echo` en Ristak.
9. Probar cambio controlado del proveedor activo YCloud a Meta directo y vuelta
   atrás sin perder historial.
10. Verificar soporte con consultas filtradas por `provider`, `source_adapter`,
    `origin`, `provider_message_id` y `wamid`.
11. Probar creación, consulta, edición, eliminación y webhooks de estado de una
    plantilla de texto por Meta directo.
12. Probar una plantilla con imagen/documento/video usando un `header_handle`
    real y confirmar que `header_media_url` no se manda a Graph como sustituto.
13. Probar un mensaje CTWA real por Meta directo y verificar `source_id`,
    headline, body, preview visual y un solo touch por mensaje.
14. Confirmar que cada opción del selector de envío muestra el teléfono exacto,
    aunque dos números compartan nombre verificado o etiqueta.

## Diagnóstico de soporte

Antes de culpar a “WhatsApp”, responder en este orden:

1. ¿Cuál es el `provider` del número y cuál está activo para enviar?
2. ¿Cuál es el `source_adapter` del mensaje?
3. ¿Llegó por `transport=api` o `transport=qr`?
4. ¿Qué `origin` y webhook event lo crearon?
5. ¿Cuál es el `provider_message_id` y cuál el `wamid`?
6. ¿Es `history`, `business_echo`, entrada o status?
7. ¿Existe el mismo `wamid` en otra fila/evento?

No borrar ni “reparar” IDs específicos sin contestar esas preguntas.

## Fuentes externas

- [Meta: WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)
- [Meta: colección oficial de WhatsApp Business Platform](https://www.postman.com/meta/whatsapp-business-platform/overview)
- [Meta: colección oficial de administración de WhatsApp Business](https://www.postman.com/meta/whatsapp-business-platform/documentation/3kru5r6/moved-whatsapp-business-management-api)
- [Meta: plantilla con encabezado de imagen y `header_handle`](https://www.postman.com/meta/whatsapp-business-platform/request/zwo15hw/create-template-w-image-header-text-body-text-footer-and-2-call-to-action-buttons)
- [Meta: Resumable Upload API](https://developers.facebook.com/docs/graph-api/guides/upload/)
- [Meta: referencia oficial de payloads webhook](https://www.postman.com/meta/whatsapp-business-platform/folder/13382743-83ff049c-d89c-4d54-904c-c77964653d6d)
- [YCloud: crear una plantilla](https://docs.ycloud.com/reference/whatsapp_template-create)
- [YCloud: editar una plantilla](https://docs.ycloud.com/reference/whatsapp_template-edit)
- [YCloud: configurar webhooks](https://docs.ycloud.com/reference/configure-webhooks)
- [YCloud: listar números de WhatsApp](https://docs.ycloud.com/reference/whatsapp_phone_number-list)
- [YCloud: eventos webhook y eliminación remota](https://docs.ycloud.com/reference/webhook-events-payloads)
- [YCloud: enviar mensajes](https://docs.ycloud.com/reference/whatsapp_message-send)
- [YCloud: ecos enviados desde WhatsApp Business](https://docs.ycloud.com/reference/whatsapp-business-app-sent-message-sync-webhook-examples)
- [YCloud: cambios BSUID](https://docs.ycloud.com/reference/webhook-updates-bsuid)

Las fuentes externas describen contratos del proveedor; este documento manda
sobre cómo se representan dentro de Ristak.
