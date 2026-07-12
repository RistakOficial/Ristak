# Meta OAuth: un solo Business Login para Ads y redes sociales

## Proposito

Este documento define el contrato OAuth oficial de Meta para instalaciones de
Ristak. Las conexiones nuevas usan **Facebook Login for Business** con una
credencial **Business Integration System User (BISU)** y una sola autorizacion
para cubrir:

- lectura de cuentas publicitarias, campanas e Insights;
- seleccion opcional de Dataset/Pixel y envio de eventos por Conversions API;
- Facebook Pages e Instagram profesional enlazado;
- Messenger, Instagram Direct y comentarios de Facebook e Instagram.

La experiencia recomendada usa el boton **Conectar con Meta**. Antes de abrir
el dialogo oficial, Ristak explica que el usuario debe marcar **Seleccionar
todo** en cada grupo de activos actuales; esa eleccion pertenece a Meta y no se
puede automatizar desde nuestra API. Al regresar, Ristak muestra solamente los
activos autorizados y utilizables, y el usuario elige una
cuenta publicitaria, una Page, un Dataset opcional y una cuenta de Instagram
opcional. Al finalizar, OAuth sustituye la conexion visible y conserva el
metodo anterior como fallback cifrado.

Una vez conectado, **Cambiar activos en Ristak** reutiliza el inventario
autorizado sin volver a abrir OAuth. **Autorizar nuevos activos** se usa sólo
cuando se agregaron activos después del consentimiento o se revocó acceso en
Meta. Facebook Login for Business con BISU no concede automáticamente activos
futuros.

La migracion es gradual y no elimina lo que ya funciona:

- `manual_system_user` sigue disponible como metodo heredado;
- las conexiones OAuth separadas `social|ads` desplegadas anteriormente quedan
  como fallback interno, pero la UI nueva ya no inicia esos dos flujos;
- una autorizacion cancelada, expirada o incompleta no sustituye la conexion
  activa ni borra el respaldo manual/separado;
- WhatsApp Embedded Signup conserva su propio Config ID, permisos y webhooks.

## Experiencia en Configuracion

`Configuracion > Meta` se divide por funcion, no por credencial:

1. **Cuenta Meta**: configuracion manual principal, tabla unica de la conexion
   activa y acceso discreto al login OAuth en revision.
2. **Redes sociales**: credencial de Messenger en modo manual, activos sociales
   y switches de Messenger, comentarios de Facebook, Instagram DM y comentarios
   de Instagram. En OAuth las credenciales de Page quedan incluidas y no se
   vuelven a pedir.
3. **Rastreo web**: parametros UTM e inclusion del Dataset en el snippet de
   tracking.
4. **Dataset Test**: codigo temporal de Test Events y envio controlado de
   eventos de navegador/servidor.

`/ads` es alias de `/settings/meta-ads/cuenta`; `/social` y `/mensajes` son
aliases de `/settings/meta-ads/redes-sociales`. Ninguna ruta debe volver a
presentar dos botones OAuth. El wizard manual permanece como entrada principal
dentro de **Cuenta Meta** y el OAuth unificado queda debajo, sin una tabla de
capacidades duplicada.

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
- `meta_business_login_config_id`, Config ID canonico del login unificado;
- `meta_social_login_config_id` y `meta_ads_login_config_id`, conservados como
  aliases/fallback para instalaciones de la etapa separada;
- `meta_webhook_verify_token`;
- estado operativo de App Review.

La API historica llama `legacy` al tipo sin segmento. Ese nombre es solamente
un alias de compatibilidad del transporte: desde producto representa la conexion
**unificada** y usa `meta_business_login_config_id`.

Installer crea y consume `state`, canjea el authorization code
server-to-server, valida el BISU, calcula `appsecret_proof`, enumera activos y
crea un candidato central. El handoff es cifrado, one-time y ligado a cliente e
instalacion. El App Secret nunca se copia a una instalacion ni llega al
navegador.

### Ristak instalado

La conexion unificada activa vive cifrada en `meta_config` con
`connection_mode=oauth_bisu`. Las sesiones temporales de seleccion viven
cifradas en `meta_oauth_pending_sessions` y tienen TTL/consumo unico.
`meta_oauth_authorized_assets` conserva cifrados la allowlist completa y los
Page tokens/proofs de cada Page autorizada. Nunca se devuelve al frontend y
permite cambiar la seleccion operativa sin repetir OAuth.

Durante la migracion tambien existen:

- `meta_oauth_integrations`: conexiones separadas `social|ads` anteriores;
- `meta_oauth_integration_sessions`: sesiones temporales de esos flujos
  anteriores;
- `meta_oauth_connection_backups`: respaldo cifrado del System User Token
  manual sustituido por OAuth.

Ningun secreto vuelve al frontend. La UI recibe IDs, nombres, capacidades,
expiraciones y permisos sanitizados.

## Permisos del login unificado

La configuracion de Facebook Login for Business solicita solamente lo que el
runtime actual usa:

| Capacidad | Permiso |
| --- | --- |
| Enumerar portafolios y Datasets propios/compartidos | `business_management` |
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

## Flujo completo

1. **Cuenta Meta** carga primero el metodo manual y consulta en segundo plano el
   estado con `GET /api/meta/oauth/status` sin crear `state`.
2. Al pulsar **Conectar con Meta** o **Autorizar nuevos activos**, Ristak muestra
   la guia para elegir **Seleccionar todo** y después solicita
   `POST /api/meta/oauth/connect-url` y manda como retorno absoluto
   `/settings/meta-ads/cuenta` en el host publico de la instalacion.
3. Installer valida ese origin contra la instalacion, crea un `state` opaco con
   TTL y abre el Config ID unificado.
4. Meta vuelve al callback unico de Installer. Installer consume `state`,
   canjea el code y valida `is_valid`, `app_id`, tipo `SYSTEM_USER`,
   `client_business_id`, expiraciones, permisos y `granular_scopes`.
5. Installer enumera Pages, Instagram, Ad Accounts y Datasets autorizados, crea
   el candidato y devuelve solamente un handoff opaco en el fragmento URL.
6. Ristak reclama el handoff desde backend, vuelve a consultar Graph y cruza los
   activos vivos con el snapshot autorizado. Una asignacion agregada despues
   del consentimiento no se cuela en la seleccion.
7. El usuario elige dentro de Ristak Ad Account y Page obligatorios; Dataset e Instagram son
   opcionales.
8. Ristak hace los preflights, guarda el candidato local, suscribe la Page y
   promueve de forma atomica la conexion/ruta central.
9. Solo despues arranca Ads sync, backfill social y los crons conectados.

El callback conserva `meta_oauth_kind` y
`meta_oauth_integration_kind=legacy` como aliases internos. Ristak acepta ese
valor o su ausencia para el login unificado; callbacks `social|ads` antiguos se
limpian y piden reconectar con el boton unico.

## Seleccion de activos

Reglas no negociables:

- Ad Account y Facebook Page son obligatorios.
- Dataset/Pixel e Instagram profesional son opcionales y nunca se eligen por
  sorpresa.
- La Page debe pertenecer al mismo portafolio que la cuenta publicitaria cuando
  Meta entrega esa relacion.
- Instagram debe estar enlazado a la Page elegida.
- Si Meta devuelve tareas de Page, deben incluir `ANALYZE`, `MESSAGING` y
  `MODERATE`.
- `granular_scopes.target_ids` debe incluir cada activo elegido; si Meta no
  devuelve `target_ids`, Ristak no inventa una allowlist vacia.
- El Page Token y su proof deben corresponder a la Page seleccionada.
- Cambiar entre activos de la allowlist usa `POST /api/meta/oauth/reconfigure` y
  no abre Meta. El inventario y las credenciales Page-scoped permanecen
  cifrados en backend.
- Los activos creados después del consentimiento no se agregan solos: requieren
  **Autorizar nuevos activos**.

### Descubrimiento y validacion del Dataset

Un Dataset puede pertenecer al Business y no aparecer en el edge de la cuenta
publicitaria. Installer combina y deduplica:

- `/{BUSINESS_ID}/owned_pixels`;
- `/{BUSINESS_ID}/client_pixels`;
- `/act_<AD_ACCOUNT_ID>/adspixels`.

Pertenecer al mismo Business no basta. Installer sólo lo entrega cuando el BISU
aparece en `assigned_users` con `UPLOAD`; antes de guardarlo, Ristak repite el
preflight de solo lectura:

1. lee `/{DATASET_ID}`;
2. consulta `/{DATASET_ID}/assigned_users?business={BUSINESS_ID}`;
3. encuentra el BISU del handoff;
4. exige la tarea `UPLOAD` en `tasks` o `permitted_tasks`.

Si falta `UPLOAD`, la conexion anterior queda intacta y Ristak pide corregir el
acceso en Meta Business. No manda un evento automatico durante OAuth: un evento
de prueba tambien entra al Dataset y debe dispararse conscientemente desde la
pestana **Dataset Test**.

Una conexion sin Dataset sigue funcionando para anuncios, reportes, Messenger,
Instagram y comentarios. CAPI se habilita solo al elegir y validar un Dataset;
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

La conexion unificada usa el Page Token para Messenger, Instagram y
comentarios; usa el BISU para Ads y CAPI. Cada token conserva su propio
`appsecret_proof`.

## Compatibilidad, reemplazo y desconexion

El cambio conserva tres capas sin mezclarlas:

- conexion unificada nueva en `meta_config`;
- conexiones OAuth separadas anteriores en `meta_oauth_integrations`;
- System User Token manual respaldado de forma cifrada.

Al conectar:

- el metodo anterior no se borra antes de que la nueva conexion quede
  promocionada;
- si la conexion separada Social usa la misma Page, Installer la guarda como
  fallback de la ruta unificada;
- si usa otra Page, su ruta se pausa solo despues del commit unificado;
- una respuesta central ambigua queda en reconciliacion automatica y nunca hace
  un rollback destructivo a ciegas.

Al desconectar el login unificado:

- Installer restaura la ruta Social separada que servia de fallback, si existe;
- Ristak restaura la configuracion manual cifrada, si existe;
- las filas separadas no se eliminan;
- los crons se recalculan segun la conexion que realmente quede activa.

El broker admite fallback bidireccional `legacy <-> social` para la misma Page.
Desconectar deliberadamente el fallback evita que una desconexion posterior lo
reviva. Una Page distinta nunca es desactivada por accidente.

## Endpoints internos

Ristak instalado, autenticado y protegido por el modulo `campaigns`:

- `GET /api/meta/oauth/status`;
- `POST /api/meta/oauth/connect-url`;
- `POST /api/meta/oauth/complete`;
- `POST /api/meta/oauth/finalize`;
- `POST /api/meta/oauth/disconnect`;
- `POST /webhooks/meta/installer-relay`, publico, firmado y anti-replay.

Los endpoints `/api/meta/oauth/:integrationKind/*` con `social|ads` se conservan
solo para migracion/regresiones de instalaciones que ya los usaron. La UI nueva
no debe llamarlos.

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
- Un Config ID System-user access token con Ad Accounts, Pages, Instagram y
  Datasets, y solo los once permisos de este documento.
- Privacy Policy y Data Deletion URL publicas.
- Webhooks de Pages, Messenger e Instagram apuntando al broker central.
- Advanced Access individual para los permisos usados y `public_profile` antes
  de poner Facebook Login for Business en vivo.
- Advanced Access de `ads_read` y Marketing API Full Access para cuentas de
  clientes; confirmar los requisitos vigentes en App Dashboard antes de enviar.
- Video de revision: un login, seleccion de Ad Account/Page/Dataset/Instagram,
  lectura de reporte, Test Event, mensaje y comentarios.
- Instagram profesional enlazado a la Page y **Connected Tools -> Allow Access
  to Messages** habilitado; OAuth no puede cambiar ese ajuste por API.

## Pruebas de aceptacion

1. La UI explica **Seleccionar todo**, abre un solo dialogo Meta y vuelve a **Cuenta Meta**.
2. El handoff contiene Ad Accounts, Datasets, Pages e Instagram autorizados.
3. Ad Account y Page son obligatorios; Dataset e Instagram son opcionales.
4. Cambiar Ad Account filtra Page/Dataset por Business y limpia selecciones
   incompatibles.
5. Un Dataset de `owned_pixels` o `client_pixels` aparece aunque
   `/act_<ID>/adspixels` venga vacio sólo si el BISU tiene `UPLOAD`.
6. Sin tarea `UPLOAD`, finalizar falla y conserva la conexion anterior.
7. Con Dataset validado, CAPI queda activa y Dataset Test puede enviar un evento
   controlado; sin Dataset, Ads y social siguen activos pero CAPI no.
8. Messenger, Instagram Direct y comentarios reciben relay firmado y hacen
   backfill sin usar el token Ads como Page Token.
9. Handoff ajeno, activo granular incorrecto, firma invalida y replay se
   rechazan.
10. Reconectar o fallar no borra el System User Token manual ni los fallbacks
    separados.
11. Desconectar restaura la ruta Social/manual correspondiente, tanto para la
    misma Page como para una Page distinta.
12. **Rastreo web** y **Dataset Test** permanecen en pestañas propias; no se
    mezclan con el login ni los controles sociales.
13. **Cambiar activos en Ristak** abre el selector interno sin OAuth; **Autorizar
    nuevos activos** abre Meta y actualiza la allowlist.

## Fuentes oficiales

- [Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business/)
- [Meta permissions](https://developers.facebook.com/docs/permissions/)
- [Conversions API integration template](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business/conversions-api-integration-template/)
- [Conversions API: using the API](https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api/)
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
