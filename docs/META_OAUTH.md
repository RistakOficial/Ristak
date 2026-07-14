# Meta OAuth: un solo Business Login para Ads y redes sociales

## Proposito

Este documento define el contrato OAuth oficial de Meta para instalaciones de
Ristak. Las conexiones nuevas usan **Facebook Login for Business** con un
**User Access Token de larga duración** y una sola autorizacion
para cubrir:

- lectura de cuentas publicitarias, campanas e Insights;
- seleccion opcional de Dataset/Pixel y envio de eventos por Conversions API;
- Facebook Pages e Instagram profesional enlazado;
- Messenger, Instagram Direct y comentarios de Facebook e Instagram.

La experiencia recomendada usa el boton **Conectar con Meta**, que abre
directamente el dialogo oficial. La persona decide libremente qué activos
autoriza; Ristak no preselecciona ni obliga opciones dentro de Meta. Antes de
conectar, Configuracion muestra solamente el titulo, una explicacion corta y el
boton centrado; las pestañas no aparecen todavía. Al regresar, la cuenta queda
conectada y entonces aparecen las secciones funcionales. **Meta Ads** contiene la
cuenta publicitaria y el Dataset; **Redes sociales** contiene la Página y el
Instagram profesional. Una conexion nueva empieza sin activos operativos. Cada
seccion conserva sus cambios como borrador y los aplica únicamente al pulsar su
boton **Guardar**; guardar Ads no arrastra un borrador social ni viceversa. Si la
misma conexion OAuth se vuelve a autorizar, Ristak conserva las selecciones que
sigan permitidas. OAuth sustituye la conexion visible y conserva el metodo
anterior como fallback cifrado.

Los dropdowns de la tabla reutilizan el inventario autorizado sin volver a abrir
OAuth ni relistar el portafolio. **Autorizar nuevos activos** se usa sólo cuando
se agregaron activos después del consentimiento o se revocó acceso en Meta. Si
la persona eligió “actuales y futuros”, el permiso puede cubrir activos nuevos,
pero Ristak vuelve a pasar por el callback central para obtener el inventario
actualizado y los Page tokens/proofs sin exponer el App Secret.

La migracion es gradual y no elimina lo que ya funciona:

- `manual_system_user` sigue disponible como metodo heredado;
- las conexiones OAuth separadas `social|ads` desplegadas anteriormente quedan
  como fallback interno, pero la UI nueva ya no inicia esos dos flujos;
- una autorizacion cancelada, expirada o incompleta no sustituye la conexion
  activa ni borra el respaldo manual/separado;
- WhatsApp Embedded Signup conserva su propio Config ID, permisos y webhooks.

## Experiencia en Configuracion

`Configuracion > Meta` se divide por funcion, no por credencial:

1. **Meta Ads**: cuenta publicitaria y Dataset de conversiones opcionales, con
   dropdowns buscables y un solo boton **Guardar** para esa seccion. El wizard de
   System User queda sólo como ruta heredada para instalaciones que ya dependan
   de él.
2. **Redes sociales**: **Facebook y Messenger** permite elegir la **Página** y
   controlar Messenger/comentarios; Instagram permite elegir su cuenta y
   controlar DMs/comentarios. Página e Instagram son opcionales y comparten un
   boton **Guardar**. La credencial de Messenger y la guia de Developers aparecen
   sólo en modo manual; OAuth ya incluye el acceso de Page y no presenta esos
   detalles al usuario final.
3. **Rastreo web**: parametros UTM e inclusion del Dataset en el snippet de
   tracking.
4. **Dataset Test**: codigo temporal de Test Events y envio controlado de
   eventos de navegador/servidor.

`/ads` es alias de `/settings/meta-ads/cuenta`; `/social` y `/mensajes` son
aliases de `/settings/meta-ads/redes-sociales`. Ninguna ruta debe volver a
presentar dos botones OAuth. Una cuenta sin configurar no ve pestañas, estados
vacíos ni formularios: ve directamente **Conectar con Meta**; el wizard manual
no se abre por defecto ni compite con el flujo oficial.

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
server-to-server e intenta ampliar el User Access Token cuando Meta todavía lo
entrega corto. Si el token ya es largo y Meta rechaza un segundo intercambio,
conserva el token válido y su expiración real. Después valida el token, calcula
`appsecret_proof`, enumera activos y
crea un candidato central. El handoff es cifrado, one-time y ligado a cliente e
instalacion. El App Secret nunca se copia a una instalacion ni llega al
navegador.

### Ristak instalado

La conexion unificada activa vive cifrada en `meta_config` con
`connection_mode=oauth_user`. `oauth_bisu` se conserva para conexiones System
User anteriores. La sesion temporal de commit vive cifrada en
`meta_oauth_pending_sessions`, tiene TTL/consumo unico y nunca se presenta como
un paso adicional al usuario.
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

## Flujo completo

1. Configuracion muestra el login OAuth sin pestañas y consulta en segundo plano
   el estado con `GET /api/meta/oauth/status` sin crear `state`.
2. Al pulsar **Conectar con Meta** o **Autorizar nuevos activos**, Ristak solicita
   `POST /api/meta/oauth/connect-url` y abre Meta directamente, mandando como retorno absoluto
   `/settings/meta-ads/cuenta` en el host publico de la instalacion.
3. Installer valida ese origin contra la instalacion, crea un `state` opaco con
   TTL y abre el Config ID unificado.
4. Meta vuelve al callback unico de Installer. Installer consume `state`,
   canjea el code, amplía el token cuando es `USER` y todavía es corto, y valida `is_valid`,
   `app_id`, tipo `USER|SYSTEM_USER`, portafolio, expiraciones, permisos y
   `granular_scopes`.
5. Installer enumera Pages, Instagram y Ad Accounts autorizados. Combina los
   pixels clásicos de `/act_<ID>/adspixels` con Datasets modernos de
   `/{BUSINESS_ID}/ads_dataset`, y sólo enlaza un Dataset a una cuenta después de
   confirmarlo por `/{DATASET_ID}/adaccounts` o `/shared_accounts`. Después crea
   el candidato y devuelve solamente un handoff opaco en el fragmento URL.
6. Ristak reclama el handoff desde backend y usa directamente la identidad,
   permisos y allowlist que Installer ya validó durante el callback. No repite
   `/me`, `/me/accounts`, `/me/adaccounts` ni `/me/permissions`. Una asignación
   ajena al snapshot autorizado nunca se agrega.
7. En esa misma petición Ristak conserva una seleccion anterior sólo cuando
   pertenece a la misma conexion OAuth y sigue autorizada. Una conexion nueva se
   guarda sin Page, Ad Account, Dataset ni Instagram seleccionados.
8. La respuesta ya representa una cuenta autorizada y devuelve una sesion nueva
   del inventario cifrado. Las pestañas conectadas aparecen sin recargar la pagina
   y no existe un segundo boton **Guardar conexion**.
9. Cambiar un dropdown sólo modifica el borrador de su seccion. **Guardar** en
   Meta Ads finaliza Ad Account/Dataset conservando la selección social guardada;
   **Guardar** en Redes sociales finaliza Page/Instagram conservando Ads. Elegir
   Page prepara la suscripcion y la ruta del broker; elegir Ad Account inicia Ads
   sync; elegir Instagram inicia su backfill; elegir Dataset habilita CAPI.
   Cambios que no afectan Page no vuelven a suscribir webhooks ni relistan activos.

El callback conserva `meta_oauth_kind` y
`meta_oauth_integration_kind=legacy` como aliases internos. Ristak acepta ese
valor o su ausencia para el login unificado; callbacks `social|ads` antiguos se
limpian y piden reconectar con el boton unico.

## Seleccion de activos

Reglas no negociables:

- Page, Ad Account, Dataset e Instagram son selecciones operativas opcionales. La
  cuenta OAuth puede quedar autorizada sin activos; cada modulo sólo funciona al
  elegir el activo que necesita.
- La Page debe pertenecer al mismo portafolio que la cuenta publicitaria cuando
  Meta entrega esa relacion.
- Instagram debe estar enlazado a la Page elegida.
- Si Meta devuelve tareas de Page, deben incluir `ANALYZE`, `MESSAGING` y
  `MODERATE`.
- `granular_scopes.target_ids` debe incluir cada activo elegido; si Meta no
  devuelve `target_ids`, Ristak no inventa una allowlist vacia.
- El Page Token y su proof deben corresponder a la Page seleccionada.
- Los selectores obtienen una sesion del inventario con
  `POST /api/meta/oauth/reconfigure`; pulsar **Guardar** en cualquiera de las dos
  secciones ejecuta un solo `POST /api/meta/oauth/finalize`, cuya respuesta
  incluye la siguiente sesion. Cambiar el dropdown no llama a la API. No abre
  Meta y el inventario y las credenciales Page-scoped permanecen cifrados en
  backend.
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
comentarios; usa el User Access Token de larga duración para Ads y CAPI. Las
conexiones heredadas pueden seguir usando BISU. Cada token conserva su propio
`appsecret_proof`.

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
- El encabezado actualiza automáticamente sólo avisos locales. La revisión en
  vivo de Meta queda detrás del botón **Actualizar** de Notificaciones.
- Los mensajes nuevos entran por webhook y el chat consulta la base local. El
  respaldo de historial usa únicamente los endpoints de conversaciones y está
  limitado por intervalo; nunca vuelve a listar el Business.

Esta separación evita que una pantalla abierta consuma la cuota compartida de
la app y bloquee callbacks OAuth legítimos con el código `4` de Meta.

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
- Un Config ID User access token con Ad Accounts, Pages, Instagram y Datasets,
  y solo los once permisos de este documento. Los Config IDs System-user
  anteriores se conservan únicamente como compatibilidad.
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

1. Sin conexion, la UI no muestra pestañas ni formularios: abre directamente un
   solo dialogo Meta y vuelve a **Meta Ads**, sin una guía intermedia ni selección forzada.
2. El handoff contiene Ad Accounts, Datasets, Pages e Instagram autorizados y se
   consume una sola vez dentro de la petición que deja la cuenta conectada.
3. Una conexion nueva no preselecciona Page, Ad Account, Dataset ni Instagram;
   la autorizacion queda conectada y la tabla permite dejar cualquiera vacio.
4. Meta Ads muestra Ad Account/Dataset y Redes sociales muestra Página/Instagram;
   todos son dropdowns buscables. Ningún `onChange` persiste datos: cada seccion
   tiene un solo boton **Guardar**.
5. Los selectores muestran el nombre de cada activo y su ID debajo sin llamar a
   Graph para pintarlos. Guardar Ad Account/Dataset no toca el relay social;
   guardar Page limpia Instagram incompatible y actualiza sólo su suscripcion/ruta.
6. El dropdown de Dataset contiene sólo relaciones confirmadas por
   `adspixels`, `adaccounts` o `shared_accounts`; aparecer en `ads_dataset`,
   `owned_pixels` o `client_pixels` sin relación de cuenta no basta. Cambiar de
   cuenta limpia un Dataset incompatible. BISU además exige `UPLOAD`; USER usa
   la allowlist firmada y nunca se confunde con un System User en
   `assigned_users`.
7. Sin tarea `UPLOAD` en modo BISU, finalizar falla y conserva la conexion
   anterior.
8. Con Dataset validado, CAPI queda activa y Dataset Test puede enviar un evento
   controlado; sin Dataset, Ads y social siguen activos pero CAPI no.
9. Messenger, Instagram Direct y comentarios reciben relay firmado y hacen
   backfill sin usar el token Ads como Page Token.
10. Handoff ajeno, activo granular incorrecto, firma invalida y replay se
   rechazan.
11. Reconectar o fallar no borra el System User Token manual ni los fallbacks
    separados.
12. Desconectar restaura la ruta Social/manual correspondiente, tanto para la
    misma Page como para una Page distinta.
13. **Rastreo web** y **Dataset Test** permanecen en pestañas propias; no se
    mezclan con el login ni los controles sociales.
14. Las dos secciones son los unicos selectores internos. **Autorizar nuevos
    activos** abre Meta y actualiza la allowlist; cambiar entre los ya autorizados
    no abre OAuth.

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
