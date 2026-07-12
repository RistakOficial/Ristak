# Meta OAuth y broker de webhooks

## Proposito

Este documento define la conexion oficial de Meta para instalaciones de Ristak.
El flujo nuevo usa **Facebook Login for Business** con credencial
**Business Integration System User (BISU)** y convive con la conexion manual por
System User Token mientras la app termina App Review.

La regla de compatibilidad es estricta:

- `manual_system_user` sigue disponible y conserva el comportamiento anterior.
- `oauth_bisu` es una via adicional; no toca la conexion manual hasta que el
  callback, permisos, activos y seguridad hayan sido validados.
- Un login cancelado, expirado, incompleto o sin permisos no sustituye una
  conexion que ya funciona.
- WhatsApp Embedded Signup mantiene su Config ID y flujo especializado. No se
  mezcla con esta autorizacion de Ads, Pages, Messenger e Instagram.

## Fuentes de verdad

### Ristak Installer

Installer es el unico dueño de la app central y guarda en su configuracion
cifrada:

- `meta_app_id`
- `meta_app_secret`
- `meta_business_login_config_id`
- version de Graph utilizada por el broker
- estado operativo de revision OAuth, sin ser un secret

El App Secret nunca se copia a Render, al navegador ni a la base de una
instalacion. Installer inicia OAuth, canjea el codigo, inspecciona la credencial,
calcula `appsecret_proof` y entrega los secretos en un handoff cifrado, de un
solo uso y ligado a cliente e instalacion.

### Ristak instalado

La instalacion guarda localmente la credencial activa cifrada en `meta_config`.
Para OAuth conserva el modo, BISU/Business/App IDs, permisos, expiraciones si
Meta las entrega, activos seleccionados, estado del relay y el proof que
corresponde a cada token. Una sesion temporal separada conserva el handoff
mientras el usuario elige activos; vence y se consume una sola vez.

El frontend nunca recibe el BISU token, Page token, App Secret ni
`appsecret_proof`. Los selectores consultan activos a traves del backend.

## Flujo oficial

1. `Configuracion > Meta` consulta el estado OAuth a su backend sin crear
   `state` ni iniciar una autorizacion.
2. Solo cuando el usuario pulsa **Conectar con Meta**, el backend pide a
   Installer una URL central y autenticada por licencia.
3. Installer crea un `state` aleatorio, hasheado, con TTL y ligado al cliente,
   instalacion y URL de retorno permitida.
4. Installer abre el dialogo oficial:

   ```text
   https://www.facebook.com/v25.0/dialog/oauth
     ?client_id={APP_ID}
     &redirect_uri={CALLBACK_EXACTO_DE_INSTALLER}
     &state={STATE_OPACO}
     &response_type=code
     &config_id={CONFIG_ID}
   ```

   `config_id` sustituye a `scope`; no se mandan ambos.
5. El cliente autoriza la configuracion completa y designa portafolio y activos.
6. Meta regresa al callback unico de Installer. Installer consume `state`,
   canjea el codigo server-to-server y valida `app_id`, `is_valid`, permisos,
   BISU/Business ID y expiraciones.
7. Installer enumera solo activos delegados, Page/Instagram vinculados y sus
   tareas. Crea un candidato temporal por `connection_id`; no reemplaza la
   conexion activa ni su ruta de webhooks.
8. Los secretos quedan dentro de un handoff cifrado de un solo uso. Ristak
   vuelve automaticamente a Configuracion con el identificador opaco en el
   fragmento de la URL, lo elimina del navegador y lo reclama desde su backend.
   La sesion local temporal responde al frontend solo con IDs, nombres,
   capacidades y faltantes.
9. Si existe un solo conjunto coherente, Ristak lo selecciona automaticamente.
   Si hay varios, el usuario elige; Ristak valida Page ↔ Instagram y
   Ad Account ↔ Dataset contra el snapshot del handoff.
10. Ristak prepara `subscribed_apps` y guarda la seleccion local, pero Installer
    promueve candidato y ruta de relay atomicamente solo cuando todo lo anterior
    es valido. Repetir la promocion con el mismo `connection_id` es idempotente.
    Despues se activan crons Meta, defaults CAPI, backfill social y sincronizacion
    de Ads. Un fallo o timeout ambiguo se reconcilia antes de hacer rollback.

No se usa el JavaScript SDK desde dominios de clientes. Hacerlo obligaria a
registrar cada host en Allowed Domains for JavaScript SDK. El callback central
usa una sola App Domain y una sola Valid OAuth Redirect URI exacta.

## Permisos de la configuracion FLFB

La configuracion es **all-or-nothing**. Si el usuario no acepta un permiso, la
conexion no debe promocionarse parcialmente.

| Capacidad de Ristak | Permisos / feature |
| --- | --- |
| Descubrir portafolio y activos delegados | `business_management` |
| Leer Ads e Insights | `ads_read` + Marketing API Access Tier |
| Enviar eventos server-side a Dataset por Conversions API y administrar el acceso al Dataset/Pixel | `ads_management` |
| Listar Pages | `pages_show_list` |
| Leer Page y engagement | `pages_read_engagement` |
| Leer comentarios/UGC de Facebook | `pages_read_user_content` |
| Responder/moderar comentarios Facebook | `pages_manage_engagement` |
| Suscribir la Page a la app | `pages_manage_metadata` |
| Messenger | `pages_messaging` |
| Identificar Instagram profesional enlazado | `instagram_basic` |
| Instagram Direct | `instagram_manage_messages` |
| Comentarios Instagram | `instagram_manage_comments` |

No agregar `read_insights`, `pages_manage_posts`, `instagram_content_publish`,
`leads_retrieval` u otro permiso por comodidad. Cada permiso nuevo necesita un
caso de uso real, prueba y evidencia separada para App Review.

## Broker central de webhooks

La configuracion de webhook pertenece a la app Meta, no a cada tenant. Por eso
Installer recibe todos los eventos en un endpoint central:

1. GET de verificacion compara `hub.verify_token` y devuelve `hub.challenge`.
2. POST valida `X-Hub-Signature-256` sobre el body original usando el App Secret.
3. Installer deduplica el evento y resuelve la instalacion por Page o Instagram
   ID registrados al finalizar OAuth.
4. Installer responde a Meta rapidamente y procesa el relay fuera de la ruta
   critica, con reintentos acotados y estado de entrega.
5. El relay a Ristak se firma con la licencia de esa instalacion:

   ```text
   X-Ristak-Signature: HMAC_SHA256(license_key, timestamp + "." + nonce + "." + rawBody)
   X-Ristak-Timestamp: instante de entrega
   X-Ristak-Nonce: identificador unico anti-replay
   X-Ristak-Installation-Id: instalacion destino
   ```

6. `/webhooks/meta/installer-relay` valida timestamp, firma, instalacion, nonce y
   `X-Ristak-Delivery-Id` en modo fail-closed antes de delegar al procesador
   social existente. El ID de entrega da idempotencia incluso tras un reintento.

El webhook manual `/webhook/meta` sigue funcionando como antes. Si la conexion
manual tiene App Secret configurado valida la firma nativa; instalaciones legacy
sin ese dato conservan temporalmente su comportamiento anterior para no romper
produccion. En modo OAuth, el webhook directo siempre rechaza eventos y solo
acepta el relay firmado por Installer.

## Tokens y `appsecret_proof`

- BISU es la credencial base para Ads/CAPI y normalmente no expira; aun asi se
  guardan las expiraciones reales que reporte Meta.
- Messenger, Instagram y comentarios usan el Page token de la Page elegida.
- `appsecret_proof` depende del token. El proof de BISU no se reutiliza con el
  Page token.
- Installer calcula ambos proofs porque es el unico dueño del App Secret. Ristak
  guarda cifrado solo el par de la conexion activa.
- Si Meta invalida la credencial o cambia el conjunto de permisos, el usuario
  reconecta mediante OAuth; nunca se intenta reconstruir el App Secret localmente.

## Endpoints internos

Ristak instalado, autenticado y bajo `campaigns`:

- `GET /api/meta/oauth/status`
- `POST /api/meta/oauth/connect-url`
- `POST /api/meta/oauth/complete`
- `POST /api/meta/oauth/finalize`
- `POST /api/meta/oauth/disconnect`
- `POST /webhooks/meta/installer-relay` (publico, firmado, acotado a 1 MB y
  anti-replay)

Installer, autenticado por licencia salvo callbacks publicos:

- estado/inicio OAuth bajo `/api/license/meta/*`, protegido por licencia y la
  feature `meta_ads`
- claim generico `/api/license/oauth-handoff/claim`
- registro/desregistro de activos para relay
- callback OAuth central `/api/meta/oauth/callback`
- webhook Meta central `/webhooks/meta`

Los nombres y payloads son contratos internos. No deben exponerse como API de
terceros ni reutilizar el MCP externo del cliente.

## Controles de seguridad

- `state`, handoff y sesion local tienen TTL, uso unico y binding de instalacion.
- El candidato central dura lo suficiente para reclamar el handoff y elegir
  activos, pero no toca la conexion anterior hasta la promocion final.
- La URL de retorno solo acepta origins registrados por Installer y nunca `/api`.
- Los callbacks y respuestas no incluyen token, codigo OAuth ni proof.
- Los secretos se cifran con la llave local correspondiente y se limpian al
  consumir/expirar. Entregas que agotan reintentos destruyen el payload con PII
  y conservan solo metadata/error sanitizado.
- No se loguean respuestas de `FB.login`, codes, tokens, payloads completos ni
  headers de firma.
- HighLevel no recibe ni reconcilia tokens OAuth. La conexion OAuth es local e
  independiente de conectar/desconectar HighLevel.
- Los crons Meta solo arrancan cuando `meta_config` tiene una conexion activa.
- El broker valida la firma nativa antes de responder y el tenant valida de
  nuevo la firma del relay.

## Checklist de Meta App

- App tipo Business, App Purpose `Clients` y portafolio verificado.
- App Domain del Installer.
- Client OAuth Login y Web OAuth Login activos.
- Strict Mode y HTTPS.
- Callback completo de Installer en Valid OAuth Redirect URIs.
- Config ID versionado de tipo System-user access token con activos y permisos
  de esta guia.
- Privacy Policy y Data Deletion URL publicas.
- Webhooks centrales con Pages, Messenger e Instagram configurados.
- Advanced Access, Business Verification, Marketing API Access Tier, Business
  Asset User Profile Access y Human Agent cuando el caso de uso lo requiera.
- Una grabacion y descripcion distintas por permiso durante App Review.

## Pruebas de aceptacion

Una autorizacion no se considera completa solo porque Meta devolvio un token.
Debe validar con activos de prueba:

1. descubrir Ad Account, Dataset, Page e Instagram correctos;
2. consultar Ads/Insights y enviar un evento controlado a Test Events del
   Dataset para demostrar `ads_management` sin publicar ni gastar;
3. suscribir la Page y recibir un webhook en el broker;
4. recibir y responder Messenger;
5. leer y responder comentario de Facebook;
6. recibir y responder Instagram Direct;
7. leer y responder comentario de Instagram;
8. confirmar deduplicacion, firma invalida, replay y aislamiento entre tenants;
9. comprobar que un fallo OAuth deja intacta la conexion manual;
10. desconectar OAuth sin romper el flujo manual disponible.

Instagram profesional debe estar enlazado a la Page y tener habilitado
**Connected Tools → Allow Access to Messages**. OAuth no puede activar ese
ajuste por API.

## Fuentes oficiales

- [Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business)
- [Manual Login Flow](https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow)
- [Facebook Login Security](https://developers.facebook.com/documentation/facebook-login/security)
- [Meta permissions](https://developers.facebook.com/docs/permissions/)
- [Secure Graph requests](https://developers.facebook.com/docs/graph-api/guides/secure-requests/)
- [Messenger webhooks](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks)
- [Pages webhooks](https://developers.facebook.com/documentation/pages-api/webhooks-for-pages)
- [Instagram webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks)
