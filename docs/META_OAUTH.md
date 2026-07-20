# Meta OAuth: Ads disponible y Social condicionado por App Review

## Proposito

Este documento define el contrato OAuth oficial de Meta para instalaciones de
Ristak y la compuerta temporal usada mientras Meta termina el App Review. La
regla vigente desde el **20 de julio de 2026** es separar las autorizaciones por
capacidad:

- `ads`: lectura de cuentas publicitarias, campañas e Insights con `ads_read`,
  más Dataset/Pixel opcional para Conversions API. Está disponible para clientes.
- `social`: Facebook Pages, Instagram profesional, mensajes, comentarios y
  webhooks. Permanece bloqueado para clientes mientras falten permisos avanzados.
- `legacy`: login combinado anterior. Sólo existe para conservar conexiones ya
  activas y compatibilidad; nunca es el botón inicial de un cliente nuevo.

La separación evita que un permiso social todavía no aprobado haga fallar una
conexión Ads que sí puede funcionar. El token Ads nunca habilita Messenger,
Instagram, comentarios ni webhooks, y una lista parcial de Pages nunca se pinta
como si el inbox social ya estuviera conectado.

## Estado temporal de App Review (fuente de verdad)

Mientras `meta_oauth_review_mode=true` en Installer, esta sección manda sobre
cualquier descripción histórica del login combinado.

### Permisos disponibles en la app central

| Permiso | Estado al 2026-07-20 | Uso actual |
| --- | --- | --- |
| `ads_read` | aprobado | conexión Meta Ads, campañas, Insights y Dataset/CAPI |
| `business_management` | aprobado | base para inventario/portafolio cuando el flujo lo requiera |
| `pages_show_list` | aprobado | identificar Pages autorizables; no habilita el inbox |
| `pages_read_engagement` | aprobado | lectura base de Page; no permite responder ni suscribir webhooks |
| `public_profile` | aprobado | identidad básica exigida por Meta |
| `whatsapp_business_management` | aprobado | WhatsApp Embedded Signup separado |
| `whatsapp_business_messaging` | aprobado | mensajería WhatsApp separada |

Los permisos sociales necesarios para producto siguen pendientes, entre ellos
`pages_manage_metadata`, `pages_read_user_content`,
`pages_manage_engagement`, `pages_messaging`, `instagram_basic`,
`instagram_manage_comments` e `instagram_manage_messages`. Por eso
`pages_show_list` y `pages_read_engagement` se conservan como base aprobada, pero
no se ofrece una “conexión social parcial” que no podría recibir o responder.

### Comportamiento visible durante la revisión

1. Una cuenta sin OAuth ve **Conectar Meta Ads**. Ese botón usa
   `/api/meta/oauth/ads/*` y el Config ID `meta_ads_login_config_id`.
2. Después del callback, la persona elige una cuenta publicitaria obligatoria y
   un Dataset opcional; nada queda activo hasta pulsar **Guardar**.
3. La pestaña **Redes sociales** muestra **Pendiente de aprobación** y explica
   qué falta. No abre OAuth ni enciende switches sociales.
4. `/initialization` manda a `Configuración > Meta` para que la selección de
   activos ocurra en una sola superficie y no se pierda una sesión intermedia.
5. Las conexiones `legacy` y `social|ads` existentes siguen funcionando; no se
   migran, revocan ni reconectan automáticamente.
6. WhatsApp Embedded Signup conserva su Config ID, permisos, token y webhooks;
   este cambio no lo mezcla con Meta Ads ni con Social.

### Activación cuando Meta apruebe Social

No hace falta volver a rediseñar el flujo ni desplegar otro parche de permisos.
El procedimiento operativo es:

1. Confirmar en App Dashboard que **todos** los permisos sociales requeridos
   tienen Advanced Access y que el Config ID Social los incluye.
2. Ejecutar el recorrido real de App Review con una Page e Instagram de prueba:
   callback, selección, `subscribed_apps`, relay, mensaje, DM y comentarios.
3. Mantener configurados `meta_social_login_config_id`, App ID, App Secret y
   webhook central en Installer, sin copiar secretos a Ristak.
4. Cambiar `meta_oauth_review_mode` a `false` desde la configuración interna de
   Installer. La pantalla de Ristak consulta ese valor con
   `POST /api/meta/oauth/social/status/refresh`.
5. Verificar que el badge pendiente cambia por **Conectar Facebook e Instagram**
   y completar una conexión de cliente antes de anunciar disponibilidad.
6. Sólo después de esas pruebas considerar si conviene volver al login combinado;
   el flujo dividido sigue siendo el default seguro y funcional.

La migración sigue siendo no destructiva: una autorización cancelada, expirada
o incompleta no sustituye la conexión activa de su tipo ni borra los respaldos
cifrados existentes.

## Experiencia en Configuracion

`Configuracion > Meta` se divide por función y por capacidad realmente disponible:

1. **Meta Ads**: cuenta publicitaria obligatoria y Dataset de conversiones opcional, con
   dropdowns buscables y un solo boton **Guardar** para esa seccion. No existe
   wizard de System User ni ruta visible para pegar tokens.
2. **Redes sociales**: durante App Review muestra un estado pendiente sin
   controles operativos. Cuando `meta_oauth_review_mode=false`, habilita el OAuth
   Social, la selección de **Página** e Instagram y los controles de mensajes y
   comentarios. La UI nunca pide una credencial de Messenger ni muestra una guía
   de Meta Developers.
   Cuando todavía no hay una selección, cada dropdown OAuth guía con
   **Selecciona tu cuenta publicitaria**, **Selecciona tu Dataset o pixel**,
   **Selecciona tu página** o **Selecciona tu cuenta de Instagram** en lugar de
   describir el activo como ausente.
3. **Rastreo web**: parametros UTM e inclusion del Dataset en el snippet de
   tracking.
4. **Dataset Test**: codigo temporal de Test Events y envio controlado de
   eventos de navegador/servidor.

`/ads` es alias de `/settings/meta-ads/cuenta`; `/social` y `/mensajes` son
aliases de `/settings/meta-ads/redes-sociales`. Una cuenta sin configurar no ve
pestañas ni formularios: ve directamente **Conectar Meta Ads**. Esto también aplica
si la base conserva un `manual_system_user` heredado; las rutas antiguas del
wizard muestran la misma entrada segura y no reactivan el método manual.

## WhatsApp Embedded Signup especializado

WhatsApp no usa el callback ni el `meta_business_login_config_id` de la conexion
Meta general. Su Config ID es `whatsapp_business_login_config_id` y su superficie
publica es `/meta/whatsapp/connect` en Ristak Installer.

1. Ristak genera un `state` HMAC ligado a licencia, instalacion, dominio y TTL.
2. Installer valida ese contrato y carga Facebook JavaScript SDK solo en su
   propio dominio.
3. `FB.login` usa `response_type=code`,
   `override_default_response_type=true` y
   `featureType=whatsapp_business_app_onboarding` para Coexistence.
4. Installer canjea el code en backend, valida
   `whatsapp_business_management` y `whatsapp_business_messaging`, y comprueba
   que el Phone Number ID pertenece al WABA autorizado.
5. El token se entrega servidor-a-servidor a la instalacion; nunca aparece en
   el navegador.

WhatsApp Meta Direct, YCloud y Baileys siguen siendo proveedores separados. El
login Meta general no reemplaza ni mezcla sus tokens.

## Fuentes de verdad

### Ristak Installer

Installer es el unico dueno de la app central de Meta y guarda de forma segura:

- `meta_app_id`;
- `meta_app_secret`;
- `meta_ads_login_config_id`, Config ID canónico para nuevas conexiones Ads;
- `meta_social_login_config_id`, Config ID Social que queda detrás de
  `meta_oauth_review_mode` hasta terminar App Review;
- `meta_business_login_config_id`, conservado para el login combinado legacy;
- `meta_webhook_verify_token`;
- `meta_oauth_review_mode`, compuerta operativa guardada en configuración interna.

La API histórica llama `legacy` al tipo sin segmento. Es compatibilidad para la
conexión combinada anterior y usa `meta_business_login_config_id`; no debe
iniciarse para cuentas nuevas durante la revisión.

Installer crea y consume `state`, canjea el authorization code
server-to-server e intenta ampliar el User Access Token cuando Meta todavía lo
entrega corto. Si el token ya es largo y Meta rechaza un segundo intercambio,
conserva el token válido y su expiración real. Después valida el token, calcula
`appsecret_proof`, enumera activos y
crea un candidato central. El handoff es cifrado, one-time y ligado a cliente e
instalacion. El App Secret nunca se copia a una instalacion ni llega al
navegador.

### Ristak instalado

Las conexiones nuevas viven cifradas en:

- `meta_oauth_integrations`: conexión activa por `social|ads`, con credencial,
  selección y estado independientes;
- `meta_oauth_integration_sessions`: sesión temporal cifrada por tipo, con TTL y
  consumo único;
- `meta_config`: conexión manual o OAuth combinado legacy; permanece como
  compatibilidad y no se sobreescribe al iniciar una conexión separada;
- `meta_oauth_pending_sessions` y `meta_oauth_authorized_assets`: sesiones y
  allowlist del login combinado legacy;
- `meta_oauth_connection_backups`: respaldo cifrado del System User Token
  manual sustituido por OAuth.

Ningun secreto vuelve al frontend. La UI recibe IDs, nombres, capacidades,
expiraciones y permisos sanitizados.

## Permisos por conexión

El flujo Ads nuevo solicita únicamente `ads_read`. El flujo Social solicita los
permisos `pages_*` e `instagram_*` de la tabla y sólo se habilita cuando todos
están aprobados. El Config ID combinado legacy conserva el conjunto completo
porque instalaciones existentes pueden seguir usándolo:

| Capacidad | Permiso |
| --- | --- |
| Identificar portafolios y validar acceso a sus activos | `business_management` |
| Leer cuentas, campanas e Insights | `ads_read` |
| Mostrar Pages administrables | `pages_show_list` |
| Suscribir la Page y recibir webhooks | `pages_manage_metadata` |
| Leer contenido y metadata de Page | `pages_read_engagement` |
| Leer comentarios/UGC de Facebook | `pages_read_user_content` |
| Responder/moderar comentarios Facebook | `pages_manage_engagement` |
| Messenger | `pages_messaging` |
| Identificar Instagram profesional enlazado | `instagram_basic` |
| Instagram Direct | `instagram_manage_messages` |
| Comentarios Instagram | `instagram_manage_comments` |

No se solicita `ads_management`: Ristak hoy lee campanas/reportes y envia
eventos, pero no publica, edita ni genera gasto publicitario. Ese permiso se
agregara solo cuando exista escritura real demostrable en App Review. Tampoco se
piden por anticipado `pages_manage_posts`, `instagram_content_publish`,
`leads_retrieval` ni permisos ajenos al producto actual.

El dialogo usa `config_id`; no envia un parametro `scope` paralelo:

```text
https://www.facebook.com/v25.0/dialog/oauth
  ?client_id={APP_ID}
  &redirect_uri={CALLBACK_EXACTO_DE_INSTALLER}
  &state={STATE_OPACO}
  &response_type=code
  &config_id={META_BUSINESS_LOGIN_CONFIG_ID}
```

## Flujo completo por tipo

1. Configuración consulta estados locales con
   `GET /api/meta/oauth/:integrationKind/status` y verifica la compuerta de
   Installer sólo mediante el POST explícito
   `/api/meta/oauth/:integrationKind/status/refresh`.
2. **Conectar Meta Ads** solicita
   `POST /api/meta/oauth/ads/connect-url`. Social sólo solicita su URL si
   `reviewPending=false`; el frontend y el backend mantienen tipos separados.
3. Installer valida el origin de la instalación, crea un `state` con TTL y abre
   el Config ID de ese tipo. `config_id` sustituye a `scope`; no se mandan ambos.
4. Meta vuelve al callback único de Installer. Installer consume el `state`,
   canjea el code y valida identidad, App ID, expiraciones, permisos y
   `granular_scopes`.
5. Installer enumera sólo los activos de esa familia: Ad Accounts/Datasets para
   Ads; Pages/Instagram para Social. El handoff opaco conserva
   `integration_kind` y Ristak rechaza cruces entre tipos.
6. Ristak reclama el handoff en backend y crea una sesión local cifrada. La
   conexión anterior del mismo tipo sigue activa hasta completar el commit.
7. Ads exige elegir una cuenta publicitaria y permite dejar Dataset vacío.
   Social exige una Page y permite Instagram vacío.
8. Cambiar un dropdown sólo cambia el borrador local. **Guardar** llama a
   `POST /api/meta/oauth/:integrationKind/finalize`; Ads inicia su sync y Social
   registra su relay/backfill. Un fallo de un tipo no desactiva el otro.
9. **Autorizar nuevos activos** repite únicamente el OAuth del tipo activo. Las
   conexiones combinadas existentes conservan sus endpoints sin segmento para
   selección y reconexión legacy.

El callback devuelve `meta_oauth_kind` y
`meta_oauth_integration_kind=ads|social|legacy`. Ristak limpia esos parámetros
del navegador inmediatamente y completa exactamente el flujo declarado.

## Seleccion de activos

Reglas no negociables:

- El commit `ads` exige una Ad Account autorizada y el commit `social` exige una
  Page autorizada. Dataset e Instagram son opcionales; cada módulo sólo funciona
  si además se eligió el activo opcional que necesita.
- La Page debe pertenecer al mismo portafolio que la cuenta publicitaria cuando
  Meta entrega esa relacion.
- Instagram debe estar enlazado a la Page elegida.
- Si Meta devuelve tareas de Page, deben incluir `ANALYZE`, `MESSAGING` y
  `MODERATE`.
- `granular_scopes.target_ids` debe incluir cada activo elegido; si Meta no
  devuelve `target_ids`, Ristak no inventa una allowlist vacia.
- El Page Token y su proof deben corresponder a la Page seleccionada.
- En conexiones separadas, `complete` crea la sesión cifrada del tipo y
  **Guardar** ejecuta un solo
  `POST /api/meta/oauth/:integrationKind/finalize`. En conexiones combinadas
  legacy, los selectores pueden obtener una sesión con
  `POST /api/meta/oauth/reconfigure` y guardar con el endpoint sin segmento.
  Cambiar un dropdown nunca llama a la API.
- Los activos creados después del consentimiento no se agregan solos: requieren
  **Autorizar nuevos activos**.

### Descubrimiento y validacion del Dataset

El selector combina dos generaciones de Graph: `/act_<AD_ACCOUNT_ID>/adspixels`
para pixels clásicos y `/{BUSINESS_ID}/ads_dataset` para Datasets modernos. Los
edges `owned_pixels|client_pixels` sólo amplían el inventario candidato; nunca
prueban por sí solos que un Dataset pertenece a la cuenta. La relación se
confirma por `/{DATASET_ID}/adaccounts` y, cuando aplica, `/shared_accounts`.
Cuando cambia la cuenta, Ristak muestra únicamente esos resultados confirmados y
limpia una selección anterior incompatible. Un Dataset compartido conserva todas
sus asignaciones y aparece sólo en esas cuentas.

Si Graph responde `OAuth 190`, el flujo exige reconexión. Ese error no se atrapa
como `[]`, porque una sesión inválida no significa “esta cuenta no tiene
Datasets”.

En una conexión System User, Installer sólo entrega un Dataset relacionado
cuando el BISU aparece en `assigned_users` con `UPLOAD`; al
seleccionarlo por primera vez Ristak repite ese preflight de solo lectura. En una
conexión USER, la allowlist firmada que Installer ya validó es la fuente de verdad
y seleccionar el Dataset no agrega otra llamada a Graph:

1. para BISU, lee `/{DATASET_ID}`;
2. para BISU, consulta `/{DATASET_ID}/assigned_users?business={BUSINESS_ID}`;
3. para BISU, encuentra el System User del handoff;
4. para BISU, exige la tarea `UPLOAD` en `tasks` o `permitted_tasks`.

Si falta `UPLOAD` en una conexión BISU, la conexion anterior queda intacta y
Ristak pide corregir el acceso en Meta Business. No manda un evento automatico
durante OAuth: un evento
de prueba tambien entra al Dataset y debe dispararse conscientemente desde la
pestana **Dataset Test**.

Una conexión Ads sin Dataset sigue funcionando para anuncios y reportes. Social
es independiente. CAPI se habilita sólo al elegir y validar un Dataset;
en ese momento Ristak enciende los defaults de eventos reales para citas y
compras. `test_event_code` es temporal y no sustituye la configuracion
operativa.

## Webhooks y runtime social

La app Meta tiene un solo callback de webhooks, por lo que Installer recibe y
enruta los eventos sociales:

1. GET compara `hub.verify_token` y devuelve `hub.challenge`.
2. POST valida `X-Hub-Signature-256` sobre el body original.
3. Installer deduplica y resuelve la instalacion por Page o Instagram activo.
4. El relay a `/webhooks/meta/installer-relay` se firma con HMAC de licencia,
   timestamp, nonce, Installation ID y Delivery ID estable.
5. Ristak valida firma, antiguedad, nonce, instalacion, activo e idempotencia.
6. Los reintentos agotados destruyen el payload con PII y conservan solo
   metadata/error sanitizado.

La conexión Social usa el Page Token para Messenger, Instagram y comentarios;
la conexión Ads usa su token para Ads y CAPI. El login combinado legacy puede
resolver ambos. Cada token conserva su propio `appsecret_proof`.

El User Access Token no es “permanente”. Installer lo amplía al máximo permitido
por Meta y Ristak guarda `expires_at` y `data_access_expires_at`. La pantalla
avisa cuando debe renovarse; revocaciones, cambios de contraseña, políticas de
Meta o vencimiento pueden exigir que la persona autorice otra vez. El Page token
se guarda separado para que el inbox no dependa del endpoint `/me` en cada
mensaje.

### Disciplina de llamadas a Graph

Las pantallas y el polling pasivo nunca deben volver a validar el token ni
relistar el portafolio. El contrato es:

- `/debug_token` se usa una sola vez al conectar o reconectar. Si un token USER
  corto se amplía con el mismo App ID, la respuesta de ampliación actualiza su
  expiración sin repetir `debug_token`. Si Meta limita esa validación, el
  callback termina con un error reintentable; no cae a `/me`, no reintenta a
  escondidas y no guarda una conexión parcialmente validada.
- `/{BUSINESS_ID}`, `owned_*` y `client_*` se consultan durante el callback OAuth
  o cuando la persona pulsa **Autorizar nuevos activos**. Abrir Configuración,
  Chat o Notificaciones no enumera negocios ni activos.
- El estado social se sirve con permisos ya validados y la suscripción guardada
  localmente. Al elegir una Page se hace el POST de suscripción y una sola
  lectura de confirmación; después el polling no toca esos endpoints.
- El catálogo **Perfil de red social** de Sites usa
  `POST /api/meta/social-profiles/refresh` al solicitar datos actuales. Recorre
  la allowlist local y consulta cada Page con su Page Token/proof; el `GET`
  `/api/meta/social-profiles` permanece pasivo. Foto, identidad y seguidores se
  recuperan por grupos tolerantes a fallos para que un field rechazado no borre
  los demás. Un conteo ausente es desconocido (`null`), no cero.
- El encabezado actualiza automáticamente sólo avisos locales. La revisión en
  vivo de Meta queda detrás del botón **Actualizar** de Notificaciones.
- Los mensajes nuevos entran por webhook y el chat consulta la base local. El
  respaldo de historial usa únicamente los endpoints de conversaciones y está
  limitado por intervalo; nunca vuelve a listar el Business.

Esta separación evita que una pantalla abierta consuma la cuota compartida de
la app y bloquee callbacks OAuth legítimos con el código `4` de Meta.

## Compatibilidad, reemplazo y desconexion

El cambio conserva tres capas sin mezclarlas:

- conexiones OAuth separadas nuevas en `meta_oauth_integrations`;
- conexión unificada legacy en `meta_config`;
- System User Token manual respaldado de forma cifrada, sólo como dato de
  migracion y continuidad heredada; no es una conexion visible ni admite nuevas
  escrituras desde producto.

Al conectar un tipo separado:

- la conexión anterior del mismo tipo no se borra antes de que la nueva quede
  promocionada;
- conectar Ads no modifica Social ni sus webhooks;
- conectar Social no modifica Ads ni su sincronización;
- una respuesta central ambigua queda en reconciliacion automatica y nunca hace
  un rollback destructivo a ciegas.

Al desconectar:

- cada endpoint segmentado elimina sólo su propio tipo;
- al desconectar el login combinado, Installer puede restaurar la ruta Social
  separada que servía de fallback, si existe;
- Ristak puede conservar/restaurar internamente la configuracion manual cifrada
  para no destruir el respaldo, pero Configuracion la trata como desconectada y
  vuelve a mostrar **Conectar Meta Ads**;
- los crons se recalculan segun la conexion que realmente quede activa.

El broker admite fallback bidireccional `legacy <-> social` para la misma Page.
Desconectar deliberadamente el fallback evita que una desconexion posterior lo
reviva. Una Page distinta nunca es desactivada por accidente.

## Endpoints internos

Ristak instalado, autenticado y protegido por el modulo `campaigns`:

- `GET /api/meta/oauth/:integrationKind/status`;
- `POST /api/meta/oauth/:integrationKind/status/refresh`;
- `POST /api/meta/oauth/:integrationKind/connect-url`;
- `POST /api/meta/oauth/:integrationKind/complete`;
- `POST /api/meta/oauth/:integrationKind/finalize`;
- `POST /api/meta/oauth/:integrationKind/disconnect`;

Compatibilidad del login combinado legacy:

- `GET /api/meta/oauth/status`;
- `POST /api/meta/oauth/connect-url`;
- `POST /api/meta/oauth/complete`;
- `POST /api/meta/oauth/finalize`;
- `POST /api/meta/oauth/disconnect`;
- `POST /api/meta/social-profiles/refresh`;
- `POST /webhooks/meta/installer-relay`, publico, firmado y anti-replay.

Las rutas heredadas `POST /api/meta/config`,
`POST /api/meta/save-and-sync`, `POST /api/meta/sync-from-highlevel`,
`POST /api/meta/social/messaging/user-token` y
`GET /api/meta/config/reveal/access_token` ya no son metodos de conexion:
responden `410 META_OAUTH_REQUIRED` para dirigir al login oficial.

Los endpoints segmentados `social|ads` son los canónicos para conexiones nuevas.
La UI llama Ads durante la revisión y sólo llama Social cuando Installer reporta
`reviewPending=false`.

Installer, autenticado por licencia salvo callbacks publicos:

- `/api/license/meta/status`;
- `/api/license/meta/connect-url`;
- `/api/license/meta/connect`;
- `/api/license/meta/webhook-subscription`;
- `/api/license/meta/disconnect`;
- `/api/license/oauth-handoff/claim`;
- `/api/meta/oauth/callback`;
- webhook central `/webhooks/meta`.

## Controles de seguridad

- `state`, handoff, candidato y sesion local tienen TTL, uso unico y binding de
  instalacion.
- El callback nunca devuelve code, token, Config ID ni proof; el handoff opaco
  viaja en fragmento y se limpia inmediatamente del navegador.
- La URL de retorno usa un origin registrado y nunca acepta rutas `/api`,
  credenciales, fragments arbitrarios ni protocol-relative URLs.
- Credenciales, sesiones y respaldo manual se cifran; expiraciones y
  compensaciones purgan secretos.
- El App Secret vive exclusivamente en Installer.
- HighLevel no recibe, reconcilia ni borra credenciales OAuth.
- Las tablas OAuth internas estan bloqueadas en el CRUD generico/API externa y
  MCP.
- Los crons `meta`, `meta-ads` y `meta-social` se sincronizan al conectar,
  desconectar o restaurar un fallback.

## Checklist de Meta App y App Review

- App tipo Business, App Purpose `Clients` y portafolio verificado.
- Business Verification y verificacion como Tech Provider para activos de
  clientes externos.
- App Domain de Installer, HTTPS, Strict Mode y callback exacto en Valid OAuth
  Redirect URIs.
- Config IDs separados para Ads y Social. Ads debe contener sólo los permisos
  aprobados que usa; Social debe contener el conjunto social completo antes de
  apagar `meta_oauth_review_mode`. El Config ID combinado queda como legacy.
- Privacy Policy y Data Deletion URL publicas.
- Webhooks de Pages, Messenger e Instagram apuntando al broker central.
- Advanced Access individual para los permisos usados y `public_profile` antes
  de poner Facebook Login for Business en vivo.
- Advanced Access de `ads_read` y Marketing API Full Access para cuentas de
  clientes; confirmar los requisitos vigentes en App Dashboard antes de enviar.
- Video de revision: un login que vuelve directamente a la tabla conectada;
  despues se eligen ahi los activos necesarios y se demuestra lectura de
  reporte, Test Event, mensaje y comentarios.
- Instagram profesional enlazado a la Page y **Connected Tools -> Allow Access
  to Messages** habilitado; OAuth no puede cambiar ese ajuste por API.

## Pruebas de aceptacion

1. Sin conexión, la UI ofrece **Conectar Meta Ads** y nunca abre el Config ID
   combinado.
2. Con `meta_oauth_review_mode=true`, Redes sociales muestra el estado pendiente,
   no abre OAuth y no habilita switches por tener sólo permisos base de Pages.
3. Ads solicita `ads_read`; un faltante social no puede producir
   `meta_scopes_missing` en ese flujo.
4. El handoff Ads contiene sólo Ad Accounts/Datasets, conserva
   `integration_kind=ads` y se consume una sola vez.
5. La cuenta publicitaria es obligatoria para finalizar; el Dataset es opcional.
   Ningún `onChange` persiste datos y **Guardar** ejecuta un único finalize Ads.
6. El dropdown de Dataset contiene sólo relaciones confirmadas por
   `adspixels`, `adaccounts` o `shared_accounts`; aparecer en `ads_dataset`,
   `owned_pixels` o `client_pixels` sin relación de cuenta no basta. Cambiar de
   cuenta limpia un Dataset incompatible. BISU además exige `UPLOAD`; USER usa
   la allowlist firmada y nunca se confunde con un System User en
   `assigned_users`.
7. Sin tarea `UPLOAD` en modo BISU, finalizar falla y conserva la conexion
   anterior.
8. Con Dataset validado, CAPI queda activa y Dataset Test puede enviar un evento
   controlado; sin Dataset, Ads/reportes siguen activos y CAPI queda apagado.
9. Cuando la compuerta cambia a `false`, aparece **Conectar Facebook e
   Instagram**. Social exige Page, mantiene Instagram opcional, registra relay y
   nunca usa el token Ads como Page Token.
10. Handoff ajeno, activo granular incorrecto, firma invalida y replay se
   rechazan.
11. Reconectar o fallar no borra el respaldo cifrado ni los fallbacks OAuth
    separados.
12. Una instalacion con sólo `manual_system_user` se presenta como desconectada,
    no muestra tokens/webhooks manuales y ofrece **Conectar Meta Ads**; los
    endpoints manuales responden `410 META_OAUTH_REQUIRED`.
13. **Rastreo web** y **Dataset Test** permanecen en pestañas propias; no se
    mezclan con el login ni los controles sociales.
14. **Autorizar nuevos activos** abre sólo el Config ID del tipo conectado;
    reconectar Ads no cambia Social y viceversa.
15. El perfil social de Sites muestra avatar y seguidores reales con OAuth USER,
    conserva el último snapshot si Graph falla y nunca presenta `0` cuando Meta
    no devolvió el conteo.

## Fuentes oficiales

- [Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business/)
- [Meta permissions](https://developers.facebook.com/docs/permissions/)
- [Conversions API integration template](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business/conversions-api-integration-template/)
- [Conversions API: using the API](https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api/)
- [Ad Account `adspixels` edge (Business SDK oficial)](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/ad-account.js)
- [Business `ads_dataset` edge (Business SDK oficial)](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/business.py)
- [Dataset/Pixel `adaccounts` y `shared_accounts` (Business SDK oficial)](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adspixel.py)
- [Dataset/Pixel assigned users](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ads-pixel/assigned_users)
- [Debug Token y granular scopes](https://developers.facebook.com/docs/graph-api/reference/debug_token/)
- [Pages API overview](https://developers.facebook.com/documentation/pages-api/overview)
- [Messenger webhooks](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks)
- [Pages webhooks](https://developers.facebook.com/documentation/pages-api/webhooks-for-pages)
- [Instagram webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks)
- [Tech Providers](https://developers.facebook.com/docs/development/release/tech-providers/)
- [Business Verification](https://developers.facebook.com/documentation/development/release/business-verification)
- [App Review](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review)
- [Secure Graph requests](https://developers.facebook.com/docs/graph-api/guides/secure-requests/)
