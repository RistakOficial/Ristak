# Arquitectura de proveedores WhatsApp

Ultima actualizacion: 2026-07-11.

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
- `wamid`: ID original de WhatsApp cuando exista; es la mejor llave de dedupe
  entre ecos de diferentes superficies.
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

No se deben renombrar estos campos como eventos YCloud. Ambos pipelines terminan
en el mismo modelo interno, pero conservan `provider`, `source_adapter`,
`origin`, payload crudo e IDs propios.

### Baileys

Baileys procesa `messages.upsert`, `messaging-history.set` y ACKs del socket.
Es transporte QR y fallback; no es un proveedor de Cloud API, no usa las
credenciales de Meta/YCloud y no debe consumir sus webhooks.

## Reglas de Coexistence

1. Un número puede seguir activo en WhatsApp Business y en una API oficial.
2. `history` es importación, no tráfico nuevo. Se persiste y publica para
   refrescar UI, pero no incrementa no leídos ni dispara push, confirmaciones,
   automatizaciones o agente conversacional.
3. `smb_message_echoes` sí es tráfico nuevo enviado manualmente desde la app y
   debe aparecer como `business_echo` sin duplicar una burbuja ya conocida por
   `wamid`.
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

## Embedded Signup centralizado

La pantalla `Configuración > WhatsApp` prepara el onboarding con Ristak
Installer por llamadas backend-to-backend y ejecuta `FB.login` dentro del tenant.
Así el clic abre una sola ventana, la oficial de Meta, sin navegar primero por
`www.ristak.com`. La instalación crea un `state` firmado con su licencia y TTL de
15 minutos; el navegador recibe únicamente ese state, App ID, Config ID y
versiones públicas del SDK. Nunca recibe tokens ni App Secret. La pantalla
central `/meta/whatsapp/connect` permanece como fallback compatible para
instalaciones anteriores, no como el camino principal.

Installer es dueño de `meta_app_id`, `meta_app_secret`,
`whatsapp_business_login_config_id` y del webhook central. El JavaScript SDK usa
`featureType=whatsapp_business_app_onboarding`, recibe el `code` y los IDs de la
sesión, y el backend central:

1. valida firma, licencia, instalación, dominio y expiración;
2. canjea el `code` y valida `app_id`, permisos, WABA y Phone Number contra Graph;
3. entrega el token en tránsito al endpoint firmado
   `/api/whatsapp-api/meta/connect/complete` de esa instalación;
4. activa una ruta exclusiva `waba_id -> installation_id`;
5. retransmite `object=whatsapp_business_account` por la cola durable existente
   hacia `/api/whatsapp-api/meta/webhook-relay`.

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
3. Suscribir la app al WABA y verificar recepción real de `messages`, estados,
   `history`, `smb_app_state_sync` y `smb_message_echoes` según los permisos
   aprobados.
4. Implementar/validar sincronización de contactos de `smb_app_state_sync`,
   incluidos BSUID, parent BSUID y username opcionales.
5. Confirmar dedupe cruzado por `wamid` cuando el mismo mensaje aparezca como
   respuesta Graph, status, echo de Coexistence o captura QR.
6. Probar texto, plantilla, botones, reacción, imagen, video, documento, audio y
   nota de voz con estados `sent`, `delivered`, `read` y `failed`.
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
- [YCloud: enviar mensajes](https://docs.ycloud.com/reference/whatsapp_message-send)
- [YCloud: ecos enviados desde WhatsApp Business](https://docs.ycloud.com/reference/whatsapp-business-app-sent-message-sync-webhook-examples)
- [YCloud: cambios BSUID](https://docs.ycloud.com/reference/webhook-updates-bsuid)

Las fuentes externas describen contratos del proveedor; este documento manda
sobre cómo se representan dentro de Ristak.
