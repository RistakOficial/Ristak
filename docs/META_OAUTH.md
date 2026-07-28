# Meta Business OAuth oficial

## Proposito

Este documento define el contrato OAuth oficial de Meta para instalaciones de
Ristak. Desde el **27 de julio de 2026**, una cuenta nueva usa una sola
autorización **Meta Business** para anuncios, Pages, Messenger e Instagram.
WhatsApp mantiene su propio Embedded Signup v4 porque entrega credenciales y
activos diferentes.

El backend conserva tres nombres internos por compatibilidad:

- `legacy`: alias técnico histórico de la autorización unificada. Aunque el wire
  protocol conserve ese valor, la UI y la operación lo llaman **Meta Business**.
- `ads`: conexión separada anterior de Ads.
- `social`: conexión separada anterior de Facebook e Instagram.

Las conexiones separadas siguen funcionando y pueden desconectarse sin afectar
la unificada. No son la entrada de una cuenta nueva.

## Estado productivo aprobado (fuente de verdad)

`meta_oauth_review_mode=false` es el estado productivo. La bandera permanece como
interruptor de contingencia para instalaciones separadas anteriores, no como
paso normal de onboarding.

### Permisos aprobados en la app central

| Permiso | Estado al 2026-07-27 | Uso actual |
| --- | --- | --- |
| `ads_read` | aprobado | conexión Meta Ads, campañas, Insights y Dataset/CAPI |
| `business_management` | aprobado | base para inventario/portafolio cuando el flujo lo requiera |
| `pages_show_list` | aprobado | identificar Pages autorizables |
| `pages_manage_metadata` | aprobado | suscribir la Page a webhooks |
| `pages_read_engagement` | aprobado | leer contenido y metadata de Page |
| `pages_read_user_content` | aprobado | recibir comentarios de personas |
| `pages_manage_engagement` | aprobado | responder comentarios de Facebook |
| `pages_messaging` | aprobado | recibir y responder Messenger |
| `instagram_basic` | aprobado | identificar Instagram profesional enlazado |
| `instagram_manage_comments` | aprobado | recibir y responder comentarios de Instagram |
| `instagram_manage_messages` | aprobado | recibir y responder Instagram Direct |
| `public_profile` | aprobado | identidad básica exigida por Meta |
| `whatsapp_business_management` | aprobado | WhatsApp Embedded Signup separado |
| `whatsapp_business_messaging` | aprobado | mensajería WhatsApp separada |
| `whatsapp_business_manage_events` | aprobado | Dataset y eventos de conversión de WhatsApp |

El Config ID **Meta Business** incluye los once permisos de Ads/Social de la
tabla. El Config ID **WhatsApp API v4** incluye los tres permisos
`whatsapp_business_*`. No se agregan `ads_management`, publicación de posts ni
permisos de Instagram Login que el producto no usa.

### Comportamiento visible productivo

1. Una cuenta sin OAuth ve **Conectar Meta Business** y usa
   `/api/meta/oauth/*` con `meta_business_login_config_id`.
2. El callback vuelve a una sola sesión de selección que contiene cuentas
   publicitarias, Datasets, Pages e Instagram.
3. La cuenta publicitaria y la Page son obligatorias para sus respectivas
   capacidades; Dataset e Instagram son opcionales.
4. Cada sección guarda su selección de forma explícita. Cambiar un dropdown no
   hace llamadas ni reemplaza la conexión activa.
5. Las conexiones `ads|social` anteriores permanecen como compatibilidad. Una
   autorización unificada nueva sólo sustituye la conexión activa cuando
   `finalize` termina.
6. WhatsApp Embedded Signup v4 permanece separado y nunca reutiliza el token de
   Meta Business.

La migración sigue siendo no destructiva: una autorización cancelada, expirada
o incompleta no sustituye la conexión activa de su tipo ni borra los respaldos
cifrados existentes.

## Experiencia en Configuracion

`Configuracion > Meta` se divide por función y por capacidad realmente disponible:

1. **Meta Ads**: cuenta publicitaria obligatoria y Dataset de conversiones opcional, con
   dropdowns buscables y un solo boton **Guardar** para esa seccion. No existe
   wizard de System User ni ruta visible para pegar tokens. Después de guardar,
   ambos dropdowns permanecen visibles con el nombre legible del activo y pueden
   cambiarse sin desconectar Meta.
2. **Redes sociales**: usa la misma autorización Meta Business para seleccionar
   **Página** e Instagram y activar mensajes y comentarios. La UI nunca pide una
   credencial de Messenger ni muestra una guía de Meta Developers.
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
pestañas ni formularios: ve directamente **Conectar Meta Business**. Esto también aplica
si la base conserva un `manual_system_user` heredado; las rutas antiguas del
wizard muestran la misma entrada segura y no reactivan el método manual.

## WhatsApp Embedded Signup especializado

WhatsApp no usa el callback ni el `meta_business_login_config_id` de la conexión
Meta general. Su Config ID productivo es
`whatsapp_business_login_config_v4_id` y su superficie pública es
`/meta/whatsapp/connect` en Ristak Installer. El Config ID v2 sólo queda como
registro histórico y nunca es fallback de una conexión nueva.

1. Ristak genera un `state` HMAC ligado a licencia, instalacion, dominio y TTL.
2. Installer valida ese contrato y carga Facebook JavaScript SDK solo en su
   propio dominio.
3. `FB.login` usa `response_type=code`,
   `override_default_response_type=true` y
   `featureType=whatsapp_business_app_onboarding` para Coexistence.
4. Installer canjea el code en backend, valida
   `whatsapp_business_management`, `whatsapp_business_messaging` y
   `whatsapp_business_manage_events`, y comprueba que el Phone Number ID
   pertenece al WABA autorizado.
5. El token se entrega servidor-a-servidor a la instalacion; nunca aparece en
   el navegador.

WhatsApp Meta Direct, YCloud y Baileys siguen siendo proveedores separados. El
login Meta general no reemplaza ni mezcla sus tokens.

## Fuentes de verdad

### Ristak Installer

Installer es el unico dueno de la app central de Meta y guarda de forma segura:

- `meta_app_id`;
- `meta_app_secret`;
- `meta_business_login_config_id`, Config ID canónico de Meta Business;
- `meta_ads_login_config_id` y `meta_social_login_config_id`, conservados para
  conexiones separadas anteriores;
- `whatsapp_business_login_config_v4_id`, Config ID canónico y separado de
  WhatsApp;
- `meta_webhook_verify_token`;
- `meta_oauth_review_mode`, interruptor de contingencia guardado en configuración
  interna y apagado en producción.

La API histórica llama `legacy` al tipo sin segmento. Ese alias permanece en el
wire protocol por compatibilidad, pero ahora representa la conexión oficial
unificada y es la entrada canónica para cuentas nuevas.

Installer crea y consume `state`, canjea el authorization code
server-to-server e intenta ampliar el User Access Token cuando Meta todavía lo
entrega corto. Si el token ya es largo y Meta rechaza un segundo intercambio,
conserva el token válido y su expiración real. Después valida el token, calcula
`appsecret_proof`, enumera activos y
crea un candidato central. El handoff es cifrado, one-time y ligado a cliente e
instalacion. El App Secret nunca se copia a una instalacion ni llega al
navegador.

Una instalación standalone obtiene antes una identidad técnica del broker mediante challenge
Ed25519 sobre su URL pública. Esa identidad puede iniciar y reclamar los mismos handoffs de Meta,
pero no es una licencia, no aparece en métricas comerciales y no autoriza ninguna ruta de plan,
cancelación o administración de infraestructura. Las instalaciones gestionadas conservan sus
credenciales existentes con prioridad.

### Ristak instalado

Las conexiones viven cifradas en:

- `meta_config`: conexión Meta Business oficial unificada, con token, selección
  y estado sanitizado;
- `meta_oauth_pending_sessions`: sesiones temporales del flujo oficial, con TTL
  y consumo único;
- `meta_oauth_integrations`: conexiones separadas anteriores `social|ads`, con
  credencial, selección y estado independientes;
- `meta_oauth_integration_sessions`: sesiones temporales de compatibilidad por
  tipo;
- `meta_oauth_authorized_assets`: inventario cifrado ligado al `connection_id`.
  `unified` es el inventario oficial; `split:ads|split:social` conserva nombres
  y opciones de conexiones anteriores;
- `meta_oauth_connection_backups`: respaldo cifrado del System User Token
  manual sustituido por OAuth.

Ningun secreto vuelve al frontend. La UI recibe IDs, nombres, capacidades,
expiraciones y permisos sanitizados.

## Permisos por conexión

El flujo oficial Meta Business solicita el conjunto completo aprobado en una
sola autorización. Las conexiones separadas anteriores conservan sus subconjuntos
Ads o Social únicamente para compatibilidad:

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

1. Configuración consulta el estado local con `GET /api/meta/oauth/status`.
2. **Conectar Meta Business** solicita `POST /api/meta/oauth/connect-url`.
3. El broker central valida el origin de la instalación —con licencia gestionada o con identidad
   técnica standalone—, crea un `state` con TTL y abre
   `meta_business_login_config_id`. `config_id` sustituye a `scope`; no se mandan
   ambos.
4. Meta vuelve al callback único de Installer. Installer consume el `state`,
   canjea el code y valida identidad, App ID, expiraciones, permisos y
   `granular_scopes`.
5. Installer enumera Ad Accounts, Datasets, Pages e Instagram en un solo
   candidato. El handoff opaco conserva `integration_kind=legacy` como alias
   técnico de Meta Business.
6. Ristak reclama el handoff en backend y crea una sesión local cifrada. La
   conexión anterior sigue activa hasta completar el commit.
7. La selección exige cuenta publicitaria y Page. Dataset e Instagram son
   opcionales.
8. Al finalizar, Ristak conserva localmente el inventario cifrado y el estado
   devuelve `assetSnapshot` más `selectedAssets`; por eso el nombre y el dropdown
   no desaparecen al guardar o recargar. Si una conexión unificada anterior no
   tiene inventario `unified`, la pantalla ejecuta un backfill una sola vez.
9. Cambiar un dropdown sólo cambia el borrador local. Al pulsar **Guardar**, el
   frontend obtiene una sesión corta con `POST /api/meta/oauth/reconfigure` y
   después llama a `POST /api/meta/oauth/finalize`; Ads inicia su sync y Social
   registra relay/backfill.
10. **Autorizar nuevos activos** repite el OAuth oficial completo. Los endpoints
    segmentados `ads|social` siguen disponibles sólo para conexiones anteriores.

El callback devuelve `meta_oauth_kind` y
`meta_oauth_integration_kind=ads|social|legacy`. Ristak limpia esos parámetros
del navegador inmediatamente y completa exactamente el flujo declarado.

## Seleccion de activos

Reglas no negociables:

- El commit oficial exige una Ad Account y una Page autorizadas. Dataset e
  Instagram son opcionales; cada módulo sólo funciona si además se eligió el
  activo opcional que necesita.
- La Page debe pertenecer al mismo portafolio que la cuenta publicitaria cuando
  Meta entrega esa relacion.
- Instagram debe estar enlazado a la Page elegida.
- Si Meta devuelve tareas de Page, deben incluir `MESSAGING` y `MODERATE`.
- `granular_scopes.target_ids` debe incluir cada activo elegido; si Meta no
  devuelve `target_ids`, Ristak no inventa una allowlist vacia.
- El Page Token y su proof deben corresponder a la Page seleccionada.
- En la conexión oficial, `complete` crea la sesión cifrada inicial. Después de
  guardar, los selectores se reconstruyen desde el inventario local sin exponer
  credenciales; si cambia la selección, **Guardar** obtiene una sesión one-time
  con `POST /api/meta/oauth/reconfigure` y ejecuta un solo `finalize`. Las
  conexiones separadas anteriores usan el equivalente segmentado. Cambiar un
  dropdown nunca llama a la API.
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
  la allowlist local y consulta cada Page con su Page Token/proof. Una conexión
  separada anterior que sólo tenga Ads puede descubrir Pages para lectura si
  conserva `pages_show_list` y `pages_read_engagement`; ese fallback no habilita
  mensajes, comentarios, publicaciones ni webhooks. El `GET`
  `/api/meta/social-profiles` permanece pasivo. Foto, identidad y seguidores se
  recuperan por grupos tolerantes a fallos para que un field rechazado no borre
  los demás. Un conteo ausente es desconocido (`null`), no cero.
- El encabezado actualiza automáticamente sólo avisos locales. La revisión en
  vivo de Meta queda detrás del botón **Actualizar** de Notificaciones.
- Los mensajes nuevos entran por webhook y el chat consulta la base local. Cada
  sender de Messenger/Instagram se enriquece con su PSID/IGSID mediante el Page
  Token y la foto temporal se rehospeda antes de persistirse.
- El respaldo de historial enumera conversaciones sin volver a listar el
  Business. Reutiliza la identidad incluida en `participants` y, si falta foto,
  hace una sola consulta de perfil por PSID/IGSID dentro de esa ejecución. Un
  cache por sender evita duplicarla cuando la misma persona aparece en varios
  mensajes.
- Cada despliegue agenda el backfill versionado
  `2026-07-28-official-profile-photos-v1` solo cuando Meta Social esta conectado.
  Recorre en lotes las filas de `meta_social_contacts` sin avatar durable, usa un
  advisory lock por plataforma y guarda progreso en
  `meta_social_profile_backfill_state_{messenger|instagram}`. Al completarse no
  vuelve a consultar Graph en siguientes arranques con la misma autorización.
  El estado guarda una firma no secreta de la conexión; pasar de Legacy/manual
  al OAuth oficial o volver a autorizar cambia esa firma y habilita un nuevo
  intento sobre los perfiles que Meta había rechazado. Reconectar Meta vuelve a
  importar el historial y agenda la hidratacion despues de crear los contactos.
- Meta puede negar el perfil de una persona que solo comento, bloqueo la cuenta
  o no dio consentimiento de mensajeria. Ese caso conserva iniciales/nombre y no
  inventa una foto; un mensaje posterior vuelve a intentar el enriquecimiento.

Esta separación evita que una pantalla abierta consuma la cuota compartida de
la app y bloquee callbacks OAuth legítimos con el código `4` de Meta.

## Compatibilidad, reemplazo y desconexion

El cambio conserva tres capas sin mezclarlas:

- conexión Meta Business oficial en `meta_config`;
- conexiones OAuth separadas anteriores en `meta_oauth_integrations`;
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
  vuelve a mostrar **Conectar Meta Business**;
- los crons se recalculan segun la conexion que realmente quede activa.

El broker admite fallback bidireccional `legacy <-> social` para la misma Page.
Desconectar deliberadamente el fallback evita que una desconexion posterior lo
reviva. Una Page distinta nunca es desactivada por accidente.

## Endpoints internos

Ristak instalado, autenticado y protegido por el modulo `campaigns`, usa como
endpoints canónicos:

- `GET /api/meta/oauth/status`;
- `POST /api/meta/oauth/connect-url`;
- `POST /api/meta/oauth/complete`;
- `POST /api/meta/oauth/reconfigure`;
- `POST /api/meta/oauth/finalize`;
- `POST /api/meta/oauth/disconnect`;
- `POST /api/meta/social-profiles/refresh`;
- `POST /webhooks/meta/installer-relay`, publico, firmado y anti-replay.

Compatibilidad de conexiones separadas anteriores:

- `GET /api/meta/oauth/:integrationKind/status`;
- `POST /api/meta/oauth/:integrationKind/status/refresh`;
- `POST /api/meta/oauth/:integrationKind/connect-url`;
- `POST /api/meta/oauth/:integrationKind/complete`;
- `POST /api/meta/oauth/:integrationKind/finalize`;
- `POST /api/meta/oauth/:integrationKind/disconnect`.

Las rutas heredadas `POST /api/meta/config`,
`POST /api/meta/save-and-sync`, `POST /api/meta/sync-from-highlevel`,
`POST /api/meta/social/messaging/user-token` y
`GET /api/meta/config/reveal/access_token` ya no son metodos de conexion:
responden `410 META_OAUTH_REQUIRED` para dirigir al login oficial.

Los endpoints sin segmento son canónicos para conexiones nuevas. El valor
`reviewPending=false` es el estado productivo; los endpoints segmentados
`social|ads` sólo mantienen compatibilidad con conexiones previas.

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
- Config ID Meta Business con los once permisos aprobados de Ads/Social y Config
  ID WhatsApp v4 separado con los tres permisos `whatsapp_business_*`.
- `meta_oauth_review_mode=false`; la compuerta sólo se usa ante una contingencia.
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

1. Sin conexión, la UI ofrece **Conectar Meta Business** y abre el Config ID
   unificado oficial.
2. El Config ID exige el conjunto completo aprobado; un permiso faltante produce
   `meta_scopes_missing` y no crea una conexión parcial.
3. El handoff contiene Ad Accounts, Datasets, Pages e Instagram, conserva
   `integration_kind=legacy` como alias técnico y se consume una sola vez.
4. La cuenta publicitaria y la Page son obligatorias; Dataset e Instagram son
   opcionales. Ningún `onChange` persiste datos y **Guardar** ejecuta un único
   finalize oficial.
5. Las conexiones segmentadas anteriores siguen funcionando sin mezclarse ni
   revocarse automáticamente.
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
9. La misma conexión oficial habilita Facebook e Instagram, registra relay y
   nunca usa el User Token como sustituto del Page Token.
10. Handoff ajeno, activo granular incorrecto, firma invalida y replay se
   rechazan.
11. Reconectar o fallar no borra el respaldo cifrado ni los fallbacks OAuth
    separados.
12. Una instalacion con sólo `manual_system_user` se presenta como desconectada,
    no muestra tokens/webhooks manuales y ofrece **Conectar Meta Business**; los
    endpoints manuales responden `410 META_OAUTH_REQUIRED`.
13. **Rastreo web** y **Dataset Test** permanecen en pestañas propias; no se
    mezclan con el login ni los controles sociales.
14. **Autorizar nuevos activos** abre el Config ID oficial completo; una conexión
    segmentada anterior conserva el Config ID de su propio tipo.
15. Después de guardar o recargar, Cuenta publicitaria y Dataset siguen siendo
    dropdowns, muestran sus nombres y permiten cambiar entre activos ya
    autorizados. Una conexión segmentada o unificada anterior recupera ese
    inventario durante el primer refresh necesario sin desconectarse.
16. El perfil social de Sites muestra avatar y seguidores reales con OAuth USER,
    conserva el último snapshot si Graph falla y nunca presenta `0` cuando Meta
    no devolvió el conteo. Una conexión Ads anterior con permisos de lectura de
    Pages puede conservar el fallback de sólo lectura, sin convertirse en token
    operativo de Social. El System User heredado conserva prioridad cuando ya
    está configurado.

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
- [Instagram User Profile API (coleccion oficial de Meta)](https://www.postman.com/meta/instagram/folder/23987686-22b3a5b0-4a51-449a-9299-e3667d69b182)
- [Tech Providers](https://developers.facebook.com/docs/development/release/tech-providers/)
- [Business Verification](https://developers.facebook.com/documentation/development/release/business-verification)
- [App Review](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review)
- [Secure Graph requests](https://developers.facebook.com/docs/graph-api/guides/secure-requests/)
