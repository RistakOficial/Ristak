# Meta OAuth: conexiones separadas y broker social

## Proposito

Este documento define el contrato OAuth oficial de Meta para instalaciones de
Ristak. Las conexiones nuevas usan **Facebook Login for Business** con
credenciales **Business Integration System User (BISU)**, pero no comparten
permisos, activos ni ciclo de vida:

- `social`: Facebook Pages, Instagram profesional enlazado, Messenger,
  Instagram Direct y comentarios.
- `ads`: cuenta publicitaria, lectura de campañas/reportes y, si el usuario lo
  elige, un Dataset/Pixel para Conversions API.

La separacion es una frontera real de seguridad y operacion. El token Ads nunca
se usa como token social, Social nunca enumera cuentas publicitarias ni datasets,
y Ads nunca registra rutas de webhooks de Page o Instagram.

La migracion sigue siendo gradual:

- `manual_system_user` continua disponible con el comportamiento historico.
- El OAuth combinado anterior conserva sus aliases y datos legacy mientras
  existan instalaciones que aun lo usan.
- `meta_config` no se elimina ni se sobreescribe al conectar una de las dos
  superficies nuevas; queda como fallback manual/legacy.
- Un login cancelado, expirado o incompleto no sustituye la conexion activa de
  ese tipo ni rompe la otra superficie.
- WhatsApp Embedded Signup mantiene su propio Config ID, permisos y webhooks.

## WhatsApp Embedded Signup especializado

WhatsApp no usa el callback ni el `meta_business_login_config_id` de la conexión
social. Su Config ID es `whatsapp_business_login_config_id` y su superficie
pública es `/meta/whatsapp/connect` en Ristak Installer.

1. Ristak genera un `state` HMAC ligado a licencia, instalación, dominio y TTL.
2. Installer valida ese contrato y carga Facebook JavaScript SDK sólo en su
   propio dominio.
3. `FB.login` usa `response_type=code`,
   `override_default_response_type=true` y
   `featureType=whatsapp_business_app_onboarding` para Coexistence.
4. Installer canjea el code en backend, valida los permisos
   `whatsapp_business_management` y `whatsapp_business_messaging`, y comprueba
   en Graph que el Phone Number ID pertenece al WABA autorizado.
5. El token se manda servidor-a-servidor con firma de licencia a
   `/api/whatsapp-api/meta/connect/complete`; el navegador nunca lo recibe.
6. Installer registra el WABA en su broker central y entrega los webhooks por
   `/api/whatsapp-api/meta/webhook-relay` usando cola durable, dedupe y reintentos.
7. La instalación cifra el token, activa `provider=meta_direct` y conserva
   YCloud/Baileys como implementaciones separadas.

Este onboarding habilita la administración directa de plantillas ya existente:
Ristak crea/lista/edita/elimina en `/{WABA_ID}/message_templates`. Los IDs,
estados y `header_handle` de Meta nunca se escriben en campos YCloud.

## Fuentes de verdad

### Ristak Installer

Installer es el unico dueño de la app central de Meta. Guarda en su
configuracion segura:

- `meta_app_id`
- `meta_app_secret`
- `meta_social_login_config_id`
- `meta_ads_login_config_id`
- `meta_business_login_config_id` solo para OAuth combinado legacy
- `meta_webhook_verify_token` para la conexion Social
- estado operativo de App Review

Los dos Config IDs nuevos pertenecen a la misma app Business de Meta y usan
System-user access token. Esto permite una sola App Review y un solo callback,
sin mezclar los permisos concedidos a cada flujo.

Installer crea y consume `state`, canjea el authorization code server-to-server,
inspecciona el BISU, calcula `appsecret_proof` y entrega los secretos mediante un
handoff cifrado, one-time y ligado a cliente, instalacion e
`integration_kind`. El App Secret nunca se copia a una instalacion ni llega al
navegador.

### Ristak instalado

Las conexiones nuevas viven cifradas en tablas separadas del contrato legacy:

- `meta_oauth_integrations`: credenciales y seleccion por `social|ads`, con
  estados `candidate`, `active` o `replaced`.
- `meta_oauth_integration_sessions`: sesion temporal cifrada de seleccion por
  tipo, con TTL y consumo unico.
- `meta_config`: conexion manual o OAuth combinado anterior; permanece como
  fallback durante la migracion.

Solo puede existir una fila `active` por tipo. Social guarda Page, Instagram,
Page token y proofs; Ads guarda Ad Account y Dataset opcional. Ningun secreto se
devuelve al frontend: la UI recibe IDs, nombres, capacidades, expiraciones y
permisos sanitizados.

## Flujo comun

1. Cada pestaña consulta su estado sin crear `state`:
   `GET /api/meta/oauth/:integrationKind/status`.
2. Solo al pulsar el boton de esa pestaña, Ristak pide a Installer una URL:
   `POST /api/meta/oauth/:integrationKind/connect-url`.
3. Installer crea un `state` aleatorio y hasheado, con TTL y binding de cliente,
   instalacion, URL de retorno e `integration_kind`. Antes de llamar a Installer,
   Ristak convierte la ruta de regreso en una URL absoluta usando el host publico
   de la instalacion que inicio el flujo. Installer vuelve a validar ese origin
   contra `installations.app_url` y `installations.app_origin_url`; una ruta
   relativa sola no es suficiente porque podria regresar al dominio generico de
   la licencia en vez del tenant correcto.
4. Installer usa el Config ID correspondiente en el dialogo oficial:

   ```text
   https://www.facebook.com/v25.0/dialog/oauth
     ?client_id={APP_ID}
     &redirect_uri={CALLBACK_EXACTO_DE_INSTALLER}
     &state={STATE_OPACO}
     &response_type=code
     &config_id={CONFIG_ID_SOCIAL_O_ADS}
   ```

   `config_id` sustituye a `scope`; no se mandan ambos.
5. Meta vuelve al callback unico de Installer. Installer consume `state`,
   canjea el code y valida `is_valid`, `app_id`, tipo `SYSTEM_USER`,
   `client_business_id`, permisos, expiraciones y `granular_scopes`.
6. Installer enumera solamente la familia de activos autorizada por el Config
   ID y crea un candidato central. La conexion anterior de ese tipo sigue activa.
7. El handoff conserva `integration_kind`; Ristak rechaza un handoff Social en
   Ads o viceversa, lo reclama desde backend y crea una sesion local cifrada.
8. El usuario elige el activo requerido. El backend cruza la seleccion con el
   snapshot del handoff y sus `target_ids` granulares.
9. Ristak prepara un candidato local y promueve el candidato central. Solo
   despues activa la fila nueva; una confirmacion central con fallo local queda
   en reparacion automatica, no en un falso rollback.

No se usa el JavaScript SDK desde dominios de clientes. El callback central
permite una sola App Domain y una sola Valid OAuth Redirect URI exacta.

## Conexion Social

Social pide exclusivamente Pages e Instagram:

| Capacidad | Permiso |
| --- | --- |
| Mostrar Pages administrables | `pages_show_list` |
| Suscribir la Page y recibir webhooks | `pages_manage_metadata` |
| Leer contenido y metadata de Page | `pages_read_engagement` |
| Leer comentarios/UGC de Facebook | `pages_read_user_content` |
| Responder y moderar comentarios Facebook | `pages_manage_engagement` |
| Messenger | `pages_messaging` |
| Identificar Instagram profesional enlazado | `instagram_basic` |
| Instagram Direct | `instagram_manage_messages` |
| Comentarios Instagram | `instagram_manage_comments` |

No pide `business_management`, `ads_read`, `ads_management`, Ad Account ni
Dataset. `business_management` solo seria justificable si Ristak administrara o
reclamara activos mediante Business Manager API, cosa que este flujo no hace.

Reglas de seleccion y promocion:

- La Page es obligatoria.
- Instagram es opcional y debe pertenecer a la Page seleccionada.
- Si Meta devuelve tareas de Page, deben incluir `MESSAGING` y `MODERATE`.
  `ANALYZE` no es requisito de inbox ni comentarios.
- Los permisos `pages_*` granulares deben incluir la Page; los permisos
  `instagram_*` deben incluir el Instagram seleccionado o su Page enlazada,
  segun el mapping que devuelve Meta.
- Antes de activar, Ristak registra `subscribed_apps` y el relay central para
  esa Page/Instagram.
- Al terminar arranca el backfill de conversaciones, activa los canales
  disponibles y sincroniza los crons `meta-social`.

Meta documenta una excepcion para **Facebook User access tokens**: si el rol de
Page fue concedido mediante Business Manager, ciertos endpoints de comentarios
de Instagram pueden exigir ademas `ads_read` o `ads_management`. No es un
requisito general documentado para BISU. Social conserva minimo privilegio y
debe probarse con una Page real administrada desde Business Manager durante App
Review; si Meta aplica esa excepcion al caso real, el unico fallback aceptable
es ampliar explicitamente el Config Social con `ads_read` o separar Instagram
Login, nunca agregar permisos Ads silenciosamente.

## Conexion Meta Ads

Ads pide hoy un solo permiso:

| Capacidad actual | Permiso |
| --- | --- |
| Leer cuentas, campañas e Insights | `ads_read` |
| Enviar eventos web server-side por Conversions API | `ads_read` |

Reglas de seleccion y promocion:

- La cuenta publicitaria es obligatoria.
- Page e Instagram no forman parte de esta autorizacion ni de su wizard.
- El Dataset/Pixel es opcional y nunca se elige automaticamente.
- Si el usuario elige Dataset, debe aparecer en
  `GET /act_<AD_ACCOUNT_ID>/adspixels` para la cuenta autorizada. Un ID escrito a
  mano o perteneciente a otra cuenta se rechaza.
- Ads no crea `subscribed_apps`, rutas de relay ni entregas de webhook.
- Al terminar arranca la sincronizacion de Ads y el cron `meta-ads`. Si se
  eligio Dataset, tambien habilita los defaults de eventos reales para citas y
  compras; Test Events no es un sustituto de esa activacion operativa.

Una conexion Ads sin Dataset sigue siendo valida para campañas existentes,
costos y reportes. CAPI se habilita solamente cuando coinciden estas tres
condiciones:

1. conexion Ads activa y validada;
2. `ads_read` concedido;
3. Dataset elegido y comprobado para esa cuenta.

Si el BISU no tiene acceso real al Dataset, Ristak debe pedir ampliar la
autorizacion o conservar la configuracion manual. No debe agregar
`business_management`, asumir el primer Dataset ni fingir que el evento fue
aceptado. Las pruebas reales se hacen con `test_event_code` y las reglas de
`docs/CONVERSION_ATTRIBUTION.md`.

Los eventos `business_messaging` de WhatsApp conservan la identidad del flujo
WhatsApp activo: primero usan el WABA legacy explicito si existe y, si no, el
WABA de WhatsApp Meta Direct. Ads OAuth no sustituye ni mezcla el token de
WhatsApp; solo aporta Dataset y credencial CAPI.

### `ads_read` frente a `ads_management`

`ads_read` cubre el runtime que existe hoy: lectura de Ads/Insights y Server-Side
API para eventos web. El Campaign Builder de Ristak sigue en preview y no
publica, edita ni genera gasto en Meta.

`ads_management` se agregara solamente cuando exista un flujo real de escritura
que pueda demostrarse en App Review. En ese momento tambien se debera resolver
la Page del creativo y la tarea `ADVERTISE`; copiar el `page_id` elegido en
Social no prueba que el token Ads tenga permiso para publicar con esa Page.

No se piden por anticipado `read_insights`, `pages_manage_posts`,
`instagram_content_publish`, `leads_retrieval` ni permisos de escritura Ads.

## Promocion, reemplazo y desconexion

Cada tipo tiene saga, lock y conexion activa independientes:

- Reconectar Social solo reemplaza la fila Social.
- Reconectar Ads solo reemplaza la fila Ads.
- Un candidato abandonado no sustituye la fila activa de su tipo.
- Un fallo Social deja Ads intacto; un fallo Ads deja Social y su relay intactos.
- `POST /api/meta/oauth/social/disconnect` desregistra su ruta central, quita
  `subscribed_apps` y elimina solo credenciales/sesiones Social.
- `POST /api/meta/oauth/ads/disconnect` elimina solo credenciales/sesiones Ads;
  no toca rutas ni entregas de webhooks.
- Despues de desconectar, los resolvers pueden caer a `meta_config` manual o al
  OAuth combinado legacy si sigue configurado.

Eliminar Ristak desde Connected Apps en Meta puede invalidar todos los tokens de
la misma app. La independencia garantizada por Ristak es local y operativa; no
convierte dos Config IDs de la misma app en dos apps distintas.

## Broker central de webhooks Social

La app Meta tiene un solo callback de webhooks, por lo que Installer recibe y
enruta los eventos Social:

1. GET compara `hub.verify_token` y devuelve `hub.challenge`.
2. POST valida `X-Hub-Signature-256` sobre el body original con el App Secret.
3. Installer deduplica y resuelve la instalacion por Page o Instagram activo.
4. El relay a `/webhooks/meta/installer-relay` se firma con HMAC de la licencia,
   timestamp, nonce, Installation ID y un Delivery ID estable.
5. Ristak valida firma, antiguedad, nonce, instalacion, activo seleccionado e
   idempotencia antes de entregar al procesador social.
6. Los reintentos agotados destruyen el payload con PII y conservan solo
   metadata/error sanitizado.

Ads nunca registra rutas en este broker. El webhook manual `/webhook/meta`
conserva su compatibilidad: valida firma cuando el modo manual tiene App Secret;
en OAuth Social, el webhook directo falla cerrado y solo se acepta el relay del
Installer.

## Tokens y `appsecret_proof`

- Cada conexion guarda su propio BISU y proof cifrados.
- Social conserva ademas el Page token de la Page elegida y su proof propio.
- Messenger, Instagram y comentarios usan el Page token; Ads y CAPI usan el
  token Ads.
- Un proof nunca se reutiliza con otro token.
- Las expiraciones reales de Meta se persisten aunque el BISU normalmente sea
  de larga duracion.
- Una credencial invalida exige reconectar ese tipo; Ristak no intenta
  reconstruir el App Secret.

## Endpoints internos

Ristak instalado, autenticado y protegido por el modulo `campaigns`:

- `GET /api/meta/oauth/:integrationKind/status`
- `POST /api/meta/oauth/:integrationKind/connect-url`
- `POST /api/meta/oauth/:integrationKind/complete`
- `POST /api/meta/oauth/:integrationKind/finalize`
- `POST /api/meta/oauth/:integrationKind/disconnect`
- `POST /webhooks/meta/installer-relay` publico, firmado, anti-replay y limitado

`:integrationKind` solo acepta `social` o `ads`. Los endpoints sin ese segmento
se conservan como aliases del OAuth combinado legacy y no deben usarse para
conexiones nuevas.

Installer, autenticado por licencia salvo callbacks publicos:

- `/api/license/meta/status`
- `/api/license/meta/connect-url`
- `/api/license/meta/connect`
- `/api/license/meta/finalize` para promover Ads
- `/api/license/meta/webhook-subscription` para registrar/desregistrar Social
- `/api/license/meta/disconnect`
- `/api/license/oauth-handoff/claim`
- `/api/meta/oauth/callback`
- webhook Meta central `/webhooks/meta`
- preparación/finalización pública de WhatsApp Meta Direct, firmada por tenant,
  en `/api/meta/whatsapp/session` y `/api/meta/whatsapp/complete`
- página central de Embedded Signup `/meta/whatsapp/connect`

Los payloads internos incluyen `integration_kind`. No deben exponerse como API
de terceros ni reutilizar el MCP externo del cliente.

## Controles de seguridad

- `state`, handoff, candidato y sesion local tienen TTL, uso unico y binding de
  instalacion y tipo.
- Un handoff de otro tipo se rechaza antes de guardar secretos.
- El callback nunca devuelve code, token, Config ID ni proof en query; el
  handoff opaco viaja en fragmento y se limpia del navegador.
- La URL de retorno sale absoluta desde la instalacion, solo acepta origins
  registrados y nunca rutas `/api`. El callback central exacto debe estar en
  Valid OAuth Redirect URIs de Meta; no basta con allowlistear la raiz del
  dominio cuando Strict Mode esta activo.
- Credenciales y sesiones se cifran; expiraciones y compensaciones limpian los
  secretos.
- `granular_scopes.target_ids` se cruza con la Page/Instagram o Ad Account
  seleccionada. Si Meta no devuelve `target_ids`, no se inventa una allowlist
  vacia.
- Las mutaciones se serializan por tipo, no con un lock global que bloquee la
  otra superficie.
- `meta_oauth_integrations` y `meta_oauth_integration_sessions` estan bloqueadas
  por completo en el CRUD generico de API externa y en MCP; no basta con
  redactar sus columnas secretas porque tampoco se pueden alterar estados,
  activos ni IDs de conexion.
- HighLevel no recibe, reconcilia ni borra credenciales OAuth.
- Los crons `meta-social` y `meta-ads` se activan por su conexion local; el cron
  de version Meta puede seguir activo mientras cualquier superficie lo requiera.

## Checklist de Meta App y App Review

- App tipo Business, App Purpose `Clients` y portafolio verificado.
- Business Verification y verificacion como Tech Provider para activos de
  clientes externos.
- App Domain de Installer, HTTPS, Strict Mode y callback exacto en Valid OAuth
  Redirect URIs.
- Config Social de tipo System-user access token con Pages/Instagram y solo los
  nueve permisos sociales de este documento.
- Config Ads de tipo System-user access token con Ad Accounts y solo
  `ads_read` mientras no exista escritura real.
- Privacy Policy y Data Deletion URL publicas.
- Webhooks de Pages, Messenger e Instagram apuntando al broker central.
- Advanced Access individual para los permisos utilizados y `public_profile`
  antes de poner Facebook Login for Business en vivo.
- Advanced Access de `ads_read` y Marketing API Full Access para operar cuentas
  de clientes. La guia vigente exige al menos 500 llamadas exitosas en 15 dias
  y menos de 15% de errores en las ultimas 500 para mantener/obtener Full
  Access; confirmar el requisito actual en App Dashboard antes de enviar.
- Grabaciones separadas: Social demuestra Page, mensaje y comentarios sin pedir
  Ad Account; Ads demuestra Ad Account, reportes y CAPI/Test Events sin pedir
  Page ni Instagram.
- Instagram profesional enlazado a la Page y **Connected Tools → Allow Access
  to Messages** habilitado. OAuth no puede cambiar ese ajuste por API.

## Pruebas de aceptacion

1. Social solo devuelve Pages/Instagram y rechaza Ad Account/Dataset.
2. Ads solo devuelve Ad Accounts/Datasets accesibles y rechaza Page/Instagram.
3. Social exige Page; Instagram es opcional y debe estar enlazado.
4. Ads exige Ad Account; Dataset es opcional y nunca se autoselecciona.
5. Un Dataset seleccionado recibe un evento controlado en Test Events; sin
   Dataset, CAPI queda desactivado sin invalidar Ads.
6. Social suscribe la Page, recibe relay firmado y permite Messenger, Instagram
   Direct y comentarios segun permisos.
7. Ads no crea ni modifica rutas del broker.
8. Handoff cruzado, target granular incorrecto, firma invalida y replay se
   rechazan.
9. Reconectar o fallar una superficie no altera la otra ni `meta_config`.
10. Desconectar cada tipo restaura su fallback legacy sin apagar el otro.
11. El Campaign Builder sigue reportando preview; no promete publicacion real ni
    solicita `ads_management`.

## Fuentes oficiales

- [Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business)
- [Manual Login Flow](https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow)
- [Meta permissions](https://developers.facebook.com/docs/permissions/)
- [Page tasks](https://developers.facebook.com/documentation/pages-api/overview)
- [Debug Token y granular scopes](https://developers.facebook.com/docs/graph-api/reference/debug_token/)
- [Marketing API authorization](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization)
- [Ad Account Pixels](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/adspixels)
- [Conversions API](https://developers.facebook.com/documentation/ads-commerce/conversions-api/get-started)
- [Instagram Comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment)
- [Instagram Media Comments](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments)
- [Tech Providers](https://developers.facebook.com/docs/development/release/tech-providers/)
- [Business Verification](https://developers.facebook.com/documentation/development/release/business-verification)
- [App Review](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review)
- [Secure Graph requests](https://developers.facebook.com/docs/graph-api/guides/secure-requests/)
- [Messenger webhooks](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks)
- [Pages webhooks](https://developers.facebook.com/documentation/pages-api/webhooks-for-pages)
- [Instagram webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks)
