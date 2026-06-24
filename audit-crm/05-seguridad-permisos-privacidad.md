# 05 — Seguridad, Permisos y Privacidad

> Auditoría de producto del CRM **Ristak**. Documento transversal de seguridad: autenticación/autorización, aislamiento de datos, privacidad de pacientes/clientes, manejo de secretos, webhooks, validación servidor vs cliente y exposición de credenciales. Cobertura total de la auditoría: **22 módulos**.

Este documento consolida hallazgos de los módulos `security-secrets`, `auth-session`, `multitenancy-access`, `licensing-features`, `installer-*` y todo hallazgo de tipo `bug-seguridad` y de privacidad que aparezca en cualquier otro módulo. Los duplicados entre módulos (el mismo defecto visto por dos auditores) se consolidan en una sola entrada citando ambos IDs.

**Notas de honestidad sobre el corpus:**
- El aislamiento **entre clientes distintos** es a nivel de infraestructura (cada cliente = su propia base de datos + su propia instalación Render). Eso es sólido y no se cuestiona aquí. Los problemas de aislamiento de este documento son **dentro de una misma instalación** (entre empleados/roles) o de exposición pública.
- Un hallazgo fue **refutado** en verificación adversarial y NO se lista como problema: `RPT-002` (los "ingresos netos" no restan reembolsos). Refutado porque un reembolso **muta** el estado del pago a `refunded`, que ya queda excluido del cálculo de ingresos exitosos; restarlo de nuevo sería doble deducción. No es un bug.
- Donde un hallazgo quedó marcado como `requiere-verificacion-manual` se indica explícitamente.

---

## 1. Resumen ejecutivo

Ristak maneja datos sensibles de negocio (contactos/pacientes, conversaciones de WhatsApp, pagos con tarjeta, RFC fiscal) y, sin embargo, su capa de seguridad tiene **un crítico de seguridad**, **un crítico operativo de privacidad/integridad**, varios **altos** y muchos **medios** que comprometen privacidad, monetización e integridad de datos. Los patrones dominantes son cuatro:

1. **Control de acceso que solo vive en la UI.** Múltiples routers del backend protegen módulos únicamente con `requireAuth` (o nada), aunque el frontend los oculta por rol o por licencia. Un empleado con DevTools, o un cliente sin el plan contratado, accede a esos datos/funciones llamando la API directamente.
2. **Endpoints públicos sin firma ni control de abuso.** Webhooks financieros y de contacto sin verificación de firma, formularios públicos sin rate limiting, y un proxy arbitrario hacia GoHighLevel accesible con un simple API token.
3. **Privacidad de "contactos ocultos" evitable.** El mecanismo de ocultamiento de contactos se aplica solo en algunos listados; se evade por búsqueda, búsqueda global, apertura por ID, reportes de pagos y notificaciones push.
4. **Sin rate limiting en ningún punto de la app por-cliente.** Login, OAuth, API externa y formularios públicos son ilimitados.

### Conteo deduplicado

Tras consolidar duplicados entre módulos, las entradas únicas de seguridad/privacidad relevantes son **~46** (sin contar el refutado `RPT-002`). Distribución por severidad:

| Severidad | IDs (consolidados) |
|---|---|
| **Crítico (2)** | SEC-001, NOTI-001 |
| **Alto (~19)** | AUTH-001/SEC-004, AUTH-002, AUTH-003/SEC-007, LIC-001, LIC-003, ACL-001, ACL-002/SEC-005, GHL-001, SEC-002, SEC-003, WA-001, WA-004, NOTI-004/MOB-002, TRK-001, TRK-004, PORTAL-001, PORTAL-002, PORTAL-003, INST-004 |
| **Medio (~18)** | AUTH-004, AUTH-005, AUTH-007, AUTH-010, ACL-003, ACL-006, GHL-007, META-005, NOTI-005/MOB-008, PAY2-005, AUTO-009, SEC-006, SEC-008, SEC-009, SEC-010, INST-006, INST-008, PORTAL-004, PORTAL-005, PORTAL-006 |
| **Bajo (~9)** | AUTH-008, AI-008, PAY2-008, PAY2-009, SEC-011, SEC-012/ACL-005, INST-009, TRK-009, LIC-002 |

---

## 2. CRÍTICOS — atender primero

### 🔴 SEC-001 — Proxy arbitrario a GoHighLevel con solo un API token (toma total de la cuenta externa)

**Tipo:** bug-seguridad · **verifyStatus:** confirmado · `backend/src/routes/external.routes.js`

`POST /api/external/highlevel/request` acepta `method` + `path` arbitrarios y los ejecuta contra `services.leadconnectorhq.com` usando el **Private Integration Token** de la instalación.

- `proxyHighLevelRequest` (líneas **1089-1118**): la única validación es la lista de métodos HTTP y `normalizeGhlApiPath` (líneas **302-308**), que solo bloquea `..`, `//` y URLs absolutas. **No hay allowlist de recursos.**
- Montado bajo `router.use(requireApiToken)` (línea **753**): basta **cualquier** API token válido. El middleware no exige rol admin ni scope; solo que el token mapee a un usuario activo. El API token lo genera cualquier usuario con acceso al módulo `settings_api_access`, y no tiene scopes reales.

**Impacto:** un portador de un API token de bajo privilegio puede leer/escribir/**borrar** todo en la cuenta GoHighLevel ligada (contactos, conversaciones, calendarios, usuarios, oportunidades) — datos de pacientes/clientes — fuera de Ristak, incluyendo `DELETE` sin confirmación.

**Reproducción:** `POST /api/external/highlevel/request {"method":"GET","path":"/contacts/"}` (o un `DELETE` a cualquier recurso).

**Fix recomendado:** eliminar el proxy o restringirlo a una allowlist explícita de paths/métodos de solo lectura; exigir rol admin + scope dedicado; registrar auditoría de cada llamada.

---

### 🔴 NOTI-001 — Una caída de OpenAI puede CANCELAR citas confirmadas de pacientes

**Tipo:** bug-integracion · **verifyStatus:** confirmado · `backend/src/services/appointmentConfirmationService.js`

En `processConfirmationWindow` (líneas **203-235**):

```
result = classification?.result || 'ambiguous'
```

`classifyConfirmationResponse` (`appointmentConfirmationAgent.js:74-78,106-128`) devuelve `null` cuando no hay API key de OpenAI, hay error de red, timeout o JSON inválido. Ese `null` colapsa a `'ambiguous'`. Para cualquier resultado distinto de `'confirmed'` se ejecuta `executeNoConfirmAction`; si el usuario configuró `no_confirm_action='cancel_appointment'` (líneas **296-303**), **la cita se cancela aunque el paciente haya respondido "sí, confirmo"**. El UPDATE a `'confirmed'` solo ocurre con `result==='confirmed'`.

**Por qué es crítico (y no solo alto):** es una acción **destructiva e irreversible** disparada por una falla de un proveedor externo, en contexto médico. El propio agente loguea "Sin API Key", confirmando que el camino del `null` es real en producción. El comportamiento por defecto ante fallo del clasificador debería ser **no tomar ninguna acción**, no cancelar.

**Fix recomendado:** si la clasificación es `null` (fallo del modelo), marcar la ventana como `error`/`human_needed` y **nunca** ejecutar acciones destructivas. Separar "sin clasificación" de "clasificado como ambiguo".

---

## 3. Autenticación y sesión

### 🔴 AUTH-001 / SEC-004 — Sin rate limiting ni lockout (login, OAuth, API externa)

**Tipo:** bug-seguridad / falta-validacion · **verifyStatus:** confirmado *(consolida AUTH-001 del módulo auth y SEC-004 del módulo seguridad — mismo defecto sistémico)*

`login()` (`authController.js:129-241`) entra directo a `verifyPassword` sin throttle, contador ni lockout. `router.post('/login')` (`auth.routes.js:43`) no monta middleware. `grep` confirma que **no existe `express-rate-limit` ni ningún limitador en todo `backend/src`** de la app; `package.json` no incluye la dependencia. `/setup`, `/sso`, `oauth/authorize` (que valida un API token), `oauth/token` y toda `/api/external` son igualmente ilimitados. Middlewares en `server.js:152-159` son solo `cors()` + `express.json`.

Combinado con la política de contraseñas débil (AUTH-005, mínimo 6), permite fuerza bruta ilimitada de credenciales y de API tokens, enumeración y scraping masivo de datos de clientes/pacientes. El installer sí tiene `rateLimit.js`, pero la app por-cliente **no**.

**Fix:** añadir `express-rate-limit` (o portar el `rateLimit.js` del installer) a `/login`, `/sso`, `/setup`, `oauth/authorize`, `oauth/token` y `/api/external`, por IP y por usuario, con backoff y lockout.

---

### 🔴 AUTH-002 — Instructivo público de reset fija credenciales `admin / admin123`

**Tipo:** bug-seguridad · **verifyStatus:** confirmado · `frontend/src/pages/Login/Login.tsx`

El panel "¿Olvidé mi usuario o contraseña?" muestra a **cualquier visitante** de `/login` un comando de Render Shell que resetea el primer usuario a `username 'admin'` / `password 'admin123'` hardcodeado.

- Línea **127**: `pbkdf2Sync('admin123', ...)` y `UPDATE` al primer usuario (`ORDER BY id LIMIT 1`).
- El comando es visible en la UI (línea **282**) y el resultado se muestra en texto plano: "Usuario: admin / Contraseña: admin123" (líneas **296-297, 301-303**).

**Mitigante:** ejecutarlo requiere acceso al Render Shell (soporte/dev/ex-empleado). Pero normaliza un password trivial **públicamente conocido** y expone el flujo de reset a cualquiera. Quien tenga ese acceso (o lo recupere) deja la cuenta admin en un estado predecible.

**Fix:** generar password aleatorio mostrado una sola vez en el Shell, o forzar cambio de password en el primer login post-reset. No exhibir el comando ni el password objetivo en la UI pública.

---

### 🔴 AUTH-003 / SEC-007 — JWT de 30 días sin revocación; logout y cambio de password no invalidan sesiones

**Tipo:** bug-seguridad / bug-arquitectura · **verifyStatus:** confirmado *(consolida AUTH-003 y SEC-007 — mismo defecto)*

- `generateToken` (`auth.js:94-117`) firma un payload sin `jti` ni `token_version`, con `exp` fijo a **30 días**. `verifyToken` (`auth.js:124-163`) solo valida firma + expiración.
- `logout()` (`AuthContext.tsx:267-272`) solo borra `localStorage`; no llama a ningún endpoint server-side.
- `changePassword` (`authController.js:456-463`) actualiza el hash **sin invalidar tokens previos**.

**Matiz (mitigación parcial):** `requireAuth` (`authMiddleware.js:25-28`) re-lee `is_active` y `role` desde la DB en cada request, así que **desactivar** un usuario sí corta el acceso al instante. Pero para un usuario que sigue activo, una sesión robada (XSS, dispositivo compartido, log filtrado) **vive 30 días** y ni el logout ni el cambio de password la cortan. La única forma de revocar es rotar `JWT_SECRET`, que tumba a TODOS.

**Fix:** añadir `token_version`/`password_changed_at` en `users`, incluirlo en el payload, compararlo en `requireAuth`, e incrementarlo en `changePassword` y en un logout server-side. Reducir el TTL y usar refresh tokens.

---

### 🟠 AUTH-004 — `JWT_SECRET` con fallback estático fuera de producción

**Tipo:** bug-seguridad · **verifyStatus:** confirmado · `auth.js:5-15`

`getJwtSecret()` devuelve la cadena fija `'ristak-default-secret-change-me'` cuando no hay `JWT_SECRET` y `NODE_ENV !== 'production'`. En staging/preview o una instalación Render mal configurada (donde `NODE_ENV` no quede en `production`), **cualquiera que conozca esa cadena del repo puede forjar JWTs válidos y autenticarse como cualquier `userId`**, incluido admin, sin contraseña.

**Fix:** exigir `JWT_SECRET` siempre (también fuera de prod) o derivar un secreto aleatorio persistente por instalación.

---

### 🟠 AUTH-005 — Política de contraseñas débil (mínimo 6, sin complejidad)

**Tipo:** falta-validacion · **verifyStatus:** confirmado

`hashPassword` (`auth.js:22-24`) y `changePassword` (`authController.js:420-425`) exigen solo `length >= 6`, sin complejidad, sin lista de comunes, y sin impedir que la nueva contraseña sea igual a la anterior. Permite `123456`. Combinado con AUTH-001 (sin throttling), el espacio de búsqueda es trivial.

**Fix:** mínimo ≥10, validación de complejidad/lista de comunes, e impedir `new == current`.

---

### 🟠 AUTH-007 — Password del dueño se envía en claro al portal sin forzar HTTPS

**Tipo:** bug-seguridad · **confidence:** probable

`verifyOwnerCredentialsWithServer` (`licenseService.js:511-536`) hace POST a `${licenseServerUrl}/api/owner-credentials/verify` con el password en texto plano en el body. `normalizeBaseUrl` (`licenseService.js:124-126`) solo recorta slashes; **no valida que el esquema sea https**. Si `LICENSE_SERVER_URL` se configura como `http://` (o se degrada), el password del dueño viaja interceptable en cada login con licencia enforced.

**Fix:** rechazar `licenseServerUrl` que no sea https en producción.

---

### 🟠 AUTH-010 — No existe recuperación de cuenta para el usuario final (solo Render Shell)

**Tipo:** decision-producto · **verifyStatus:** confirmado

No hay endpoint de "olvidé mi contraseña" (`auth.routes.js:30-79`). El único camino es ejecutar un comando en el Render Shell (`Login.tsx:252-313`). Un dueño no técnico queda fuera de su propio CRM hasta que un técnico intervenga. Es un problema de seguridad operativa además de producto: incentiva el flujo inseguro de AUTH-002.

**Fix:** reset real por correo o desde el portal central (que ya es fuente de verdad del password del dueño).

---

### 🔵 AUTH-008 — `/api/auth/verify` sin auth acepta token en el body (sondeo/amplificación)

**Tipo:** deuda-tecnica · **verifyStatus:** confirmado

`POST /api/auth/verify` (`auth.routes.js:52`) no tiene `requireAuth` (por diseño, para bootstrap del cliente) y lee el token del body, devolviendo datos de usuario y estado de licencia (`authController.js:348-403`). Combinado con la ausencia de rate limiting, permite sondear validez de tokens y forzar verificaciones de licencia contra el portal sin coste.

**Fix:** rate limiting a `/verify`; considerar leer el token del header `Authorization`.

---

## 4. Autorización, roles y aislamiento de datos (dentro de la instalación)

### 🔴 ACL-001 — Módulos sin `requireModuleAccess` en backend: empleados restringidos acceden por API directa

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`requireModuleAccess` se aplica router por router, no global. Varios routers que el frontend SÍ protege con `AccessRoute` solo tienen `requireAuth` en el backend:

| Módulo (frontend) | Router | Protección backend real |
|---|---|---|
| analytics | `tracking.routes.js:45` | solo `requireAuth` |
| settings | `config.routes.js:7` | solo `requireAuth` |
| payments/settings | `products.routes.js:15` | solo `requireAuth` |
| analytics/reports | `attribution.routes.js:7` | solo `requireAuth` |
| contacts | `contactTags.routes.js:16` | solo `requireAuth` |
| appointments | `appointmentReminders.routes.js:12` | solo `requireAuth` |
| **chat** | `contacts.routes.js:37`, `chatEvents.routes.js:8` | gateado como `'contacts'`, nunca `'chat'` |

El `moduleKey 'chat'` existe en `ACCESS_MODULES` (`userAccess.js:10`) pero **nunca se enforce** en backend. Un empleado con esos módulos en `'none'` es bloqueado solo en la UI; la API responde 200 con datos (lectura, y en POST escritura). Es **escalada horizontal de privilegios** dentro del tenant.

**Matiz no refutatorio:** `normalizeAccessConfig` hace que `'chat'` herede el nivel de `'contacts'` cuando la config no trae clave `chat`; el gap de chat solo se explota cuando el admin fija explícitamente `chat:'none'` con `contacts:'read'` — que es exactamente el caso que el control debería respetar y no lo hace.

**Fix:** añadir `requireModuleAccess('<modulo>')` al `router.use` de cada uno; montar `requireModuleAccess('chat')` en los endpoints de chat.

---

### 🔴 ACL-002 / SEC-005 — Contactos ocultos se filtran por búsqueda, búsqueda global, `getContactById` y reportes

**Tipo:** bug-seguridad · **verifyStatus:** confirmado *(consolida ACL-002 y SEC-005 — mismo defecto desde dos ángulos)*

El filtro de "hidden contacts" es la única capa de privacidad fina de datos de contacto. Se aplica en `getContacts`/dashboard/analytics/`transactionsController`, pero **NO** en:

- `searchContacts` (`contactsController.js:2728-2808`): `WHERE ${searchClause.condition}` sin filtro de ocultos.
- `getContactById` (`contactsController.js:2310-2389`): `WHERE c.id = ?` sin filtro y **sin 404** si el contacto matchea un filtro de oculto. Reutilizado por la API externa en `/api/external/contacts/:id`.
- `globalSearch` (`searchController.js:104-127`): expone `full_name/first_name/last_name/email/phone` sin filtro.
- Lista de transacciones de reportes (`reportsController.js:353-369`): `LEFT JOIN contacts` expone `contact_name/email/phone` con `whereClause` que solo filtra por fecha.

**Impacto:** el admin oculta un contacto deliberadamente y reaparece con todos sus datos (PII) al buscarlo, abrirlo por ID/enlace, usar el buscador global o ver reportes de pagos.

**Matiz importante:** el filtro de ocultos es **global**, no por usuario/rol (`hiddenContactsFilter.js:9-20` lee `hidden_contact_filters` sin scope de usuario). Por tanto el contacto está oculto para TODOS en listados, pero recuperable por ID por cualquier usuario/token. El problema real es **recuperación por ID + vía API externa** de datos que el admin marcó como ocultos.

**Fix:** aplicar `getHiddenContactFilters()` + `buildHiddenContactsCondition` en `searchContacts`, `globalSearch`, `getContactById` (devolver 404 si matchea) y en el SELECT de transacciones; aplicarlo también en la API externa. Idealmente hacer el filtro consciente del rol.

---

### 🟠 ACL-003 — Cualquier empleado puede crear/borrar filtros de contactos ocultos

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

El router `/api/hidden-contacts` solo aplica `requireAuth` (`hiddenContacts.routes.js:11-15`), sin `requireAdmin` ni `requireModuleAccess`. Cualquier usuario activo (incluso read-only) puede listar, agregar y **eliminar** filtros que afectan globalmente lo que ven todos. Un empleado puede des-ocultar datos sensibles o, al revés, ocultar contactos legítimos a sus compañeros.

**Fix:** proteger el router con `requireAdmin` (o `requireModuleAccess` write).

---

### 🟠 ACL-006 — `POST/DELETE /api/config` sin gate de módulo

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`config.routes.js` solo usa `requireAuth`. `saveConfig` / `deleteConfig` quedan accesibles a cualquier empleado. La lectura (`getConfig`) sí redacta claves sensibles (`configController.js:4-15`), pero la **escritura** de configuración global queda abierta a todos y afecta a toda la instalación.

**Fix:** `requireModuleAccess('settings_*')` (o `requireAdmin`) al menos en POST/DELETE.

---

### 🟠 GHL-007 — Rutas de HighLevel solo con `requireAuth`: empleado limitado puede cobrar y revelar token

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`highlevel.routes.js:46` aplica únicamente `router.use(requireAuth)`. Endpoints sensibles — `revealToken`, `createInvoice`, `recordPayment`, `text2Pay`, `deleteConfig`, `sync` — quedan accesibles a **cualquier** usuario autenticado, incluidos empleados restringidos. El frontend usa `AccessRoute` por `moduleKey` pero el backend no lo replica. Un empleado sin permiso de Settings/Payments puede revelar el token de HighLevel, **crear cobros** (`text2Pay`/`recordPayment`) o desconectar la integración.

**Fix:** `userAccessMiddleware` con el `moduleKey` apropiado (settings para config/token, payments para cobros).

---

### ℹ️ ACL-004 — No existe "owner" por contacto (decisión de producto con impacto de privacidad)

**Tipo:** decision-producto · **verifyStatus:** confirmado

No hay propietario/asignación por contacto. `getContacts` (`contactsController.js:1931-2010`) no filtra por usuario; `appointments.assigned_user_id` existe (`database.js:2450`) pero nunca se usa para filtrar visibilidad. Cualquier empleado con el módulo `contacts` ve, edita, exporta y borra **toda** la base, incluyendo custom fields que pueden contener datos médicos. Combinado con ACL-002, la única segmentación posible es el filtro global de ocultos (que además fuga).

---

## 5. Licenciamiento y monetización (bypass de plan)

### 🔴 LIC-001 — Módulos premium sin `requireFeature` en backend: el plan se salta por API directa

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`server.js` aplica `requireFeature` a solo 8 routers (automations, advanced_reports, meta_ads, google_calendar, app_assistant_ai, conversational_ai, whatsapp, email). Otros módulos que el frontend trata como features de licencia — **payments, sites, analytics, contacts, dashboard, attribution, integrations** — se montan sin `requireFeature`; su única protección es `requireModuleAccess`, que valida ROL, **no licencia**.

Verificado: los routers de pagos gatean solo con `requireModuleAccess('payments')` (`transactions.routes.js:22`, `subscriptions.routes.js:16`, `conekta.routes.js:22-28`, `stripe.routes.js:29-35`); ninguno importa `requireFeature`. Un tenant cuyo plan no incluya payments tiene la UI oculta pero `/api/transactions`, `/api/stripe`, `/api/subscriptions`, `/api/conekta` responden normal. Contradice el comentario del propio middleware (`licenseMiddleware.js:38`): "ocultar botones en frontend no es suficiente".

**Severidad:** alto como **bypass de monetización**, no fuga de datos entre tenants. El negocio cobra por features que se sirven igual sin pagarlas.

**Fix:** mapa central módulo→feature aplicado de forma consistente, o `requireFeature` por router.

---

### 🔴 LIC-003 — `allowed:true` sin `features` otorga TODO el plan premium (failure-open)

**Tipo:** bug-seguridad · **verifyStatus:** confirmado · `licenseService.js`

`verifyLicenseWithServer` (líneas **319-331**) hace `features: normalizeLicenseFeatures(data.features)`. Si el portal responde `{ allowed:true }` sin el campo `features` (o `null`), `normalizeLicenseFeatures` (líneas **249-254**) recibe `undefined`, hace `source = {}` y retorna `{ ...DEFAULT_FEATURES }` con **todas las features en true** (`DEFAULT_FEATURES`, líneas **21-47**). Es **failure-open**: cualquier respuesta válida pero incompleta (bug del portal, payload truncado, endpoint viejo) abre todo el plan premium en vez de fallar cerrado.

**Fix:** si `enforced` y `data.allowed` pero `features` ausente/vacío, tratar como features mínimas o error de validación. Separar `DEFAULT_FEATURES` (standalone) del default de respuesta remota.

---

### 🔵 LIC-002 — `requireFeature` corre antes de `requireAuth`: tráfico no autenticado al license server

**Tipo:** bug-arquitectura · **verifyStatus:** confirmado

`requireFeature` se monta como primer middleware (`server.js:219`), antes de `requireAuth`. Se llama **sin email**; si el cache no es válido dispara `verifyLicenseWithServer(null)` (fetch sincrónico al portal). Un atacante no autenticado puede martillar `/api/automations`, `/api/meta`, etc. y forzar llamadas repetidas al portal, especialmente en estado `blocked` donde el cache nunca es válido (ver LIC-006).

**Fix:** aplicar `requireAuth` antes de `requireFeature`; cachear el estado `blocked` con TTL corto; throttle a `verifyLicenseWithServer`.

---

## 6. Webhooks, endpoints públicos y validación servidor-vs-cliente

### 🔴 SEC-002 — Webhooks de pago/contacto/refund/appointment sin verificación de firma

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`webhooks.routes.js` monta `POST /contact /payment /payment-plan /refund /appointment` (líneas **24-43**) **sin ningún middleware de verificación**. `handlePaymentWebhook` (`webhooksController.js:730+`) lee `req.body` directo, resuelve/crea contacto y procesa el pago, sin firma/HMAC/secreto compartido. Solo Stripe (`stripeWebhookView`) y Meta (`verifyMetaSocialWebhook`) validan. El `rawBody` está disponible (`server.js:155-156`) pero no se usa.

**Impacto:** cualquier tercero que conozca/adivine la URL puede inyectar pagos falsos (inflar ingresos), crear contactos basura o disparar automatizaciones.

**Fix:** exigir un secreto compartido/HMAC por instalación (usando `rawBody`) o un token en header validado contra `app_config`; rechazar 401 si no coincide.

---

### 🔴 WA-001 — Webhook YCloud público acepta payloads sin firmar cuando falta `webhook_secret`

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`verifyYCloudSignature` (`whatsappApiService.js:5517-5518`) retorna `null` si no hay secret. `processYCloudWhatsAppWebhook` (líneas **5566-5594**) solo rechaza con 401 cuando `signatureValid === false`; con `null` **guarda el evento y continúa procesando inbound** (crea/actualiza contactos, dispara confirmación IA, automatizaciones, push). En `connectWhatsAppApi` (líneas **3324-3347**), si la creación del webhook falla (401/403 sin permiso) el catch solo guarda un warning y la conexión se marca `enabled='1'` con `webhookStatus 'pending'` — **sin secret**. El endpoint `/webhook/whatsapp-api/ycloud` (`webhooks.routes.js:40`) no aplica auth.

**Impacto:** en cuentas YCloud sin permiso para crear webhooks, el endpoint queda abierto en producción: inyección de mensajes/contactos/atribución falsos y disparo no autorizado del agente IA.

**Fix:** rechazar (401) si no hay `webhook_secret`; exigir secret antes de marcar la conexión activa; tratar `signatureValid === null` como inválido en producción.

---

### 🔴 WA-004 — Webhook de atribución WhatsApp público sin firma: sobreescribe atribución de cualquier contacto

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`handleWhatsAppAttributionWebhook` (`webhooksController.js:1747-1855`) montado en `/webhook/whatsapp/attribution` (`webhooks.routes.js:33`) **sin auth ni firma**. Resuelve el contacto por teléfono y hace `UPDATE contacts SET attribution_ad_id/attribution_ctwa_clid/attribution_ad_name` (líneas **1810-1832**), **pisando** la atribución existente con datos del payload no autenticado. Siempre responde 200, incluso en error (líneas **1850-1853**).

**Impacto:** cualquiera que conozca/adivine un teléfono puede falsear la atribución de un contacto y contaminar reportes de ROI/campañas.

**Fix:** exigir token/secreto compartido o firma; no sobreescribir atribución existente sin lógica de prioridad.

---

### 🔴 TRK-001 — `/collect` acepta sesiones falsas: inyección de tracking y reasignación de identidad

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`POST /collect` (`trackingController.js:858-960`) es público (montado en `/` y `/api/tracking`) y solo valida presencia de `visitor_id/session_id/event_name/ts`. **No valida origen, Referer, firma ni que el par `(visitor_id, contact_id)` sea legítimo.** CORS abierto (`server.js:152`). Cuando viene `contact_id`, dispara `linkVisitorToContact` y `unifyVisitorIds` (`trackingService.js:946-1024`), que **reescribe el `visitor_id` de TODAS las sesiones del contacto** al más viejo.

**Verificación con matiz:** `linkVisitorToContact` **ni siquiera verifica que el `contact_id` exista** (`trackingService.js:571`), lo que hace el endpoint **aún más permisivo** para inyección de sesiones/conversiones falsas — eso no requiere secreto. El cruce de identidades sí necesita un `contact_id` válido (UUIDv4 no enumerable, requiere fuga previa); pero la **corrupción de atribución/revenue por campaña** con `visitor_id` arbitrarios está totalmente abierta y sin auth.

**Fix:** restringir `/collect` a hosts/orígenes conocidos del tenant; ignorar `contact_id` arbitrario salvo canal confiable; no disparar `unifyVisitorIds` desde un endpoint público sin verificación.

---

### 🔴 TRK-004 — Submit público de Sites sin rate limiting, honeypot ni captcha

**Tipo:** falta-validacion · **verifyStatus:** confirmado

`POST /api/sites/public/submit` (`sites.routes.js:50`, montado **antes** de `requireAuth`) crea contactos reales, inserta en `public_site_submissions`, dispara automatizaciones y envía eventos a Meta CAPI — **sin control anti-abuso alguno**. Búsqueda global confirma **cero** rate limiting/captcha/honeypot inbound en todo `backend/src`.

**Impacto:** un bot puede crear contactos ilimitados, ensuciar el CRM, gastar cuota de CAPI y disparar automatizaciones/mensajes en masa con datos basura.

**Fix:** rate limiting por IP+site, honeypot, y/o captcha; throttle de creación de contactos y de envíos CAPI.

---

### 🟠 PAY2-005 — Webhook MercadoPago acepta peticiones sin firma cuando no hay secret

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`validateWebhookSignature` (`mercadoPagoPaymentService.js:2150-2163`) retorna `true` de inmediato si `webhookSecret` está vacío. En instalaciones sin secret provisionado, `/api/mercadopago/webhook` procesa cualquier request sin verificar. **Mitigado** porque el handler reconsulta el pago real en la API de MP por `data.id`; pero permite disparar refrescos arbitrarios y enumerar IDs sin autenticación.

**Fix:** rechazar (401) cuando no haya secret, o exigir secret para habilitar MP.

---

### 🟠 AUTO-009 — Endpoint de assets de automatización público: lectura de archivos por ID sin auth

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`router.get('/assets/:assetId', serveAssetHandler)` (`automations.routes.js:31-34`) se registra **antes** de `requireAuth`, por diseño para que WhatsApp/Meta lean adjuntos. `getAutomationAsset` (`automationsService.js:1105-1113`) solo busca por id, sin control de acceso ni expiración. Una URL filtrada da acceso indefinido a adjuntos que pueden contener datos del cliente.

**Fix:** URLs firmadas con expiración o token por asset; documentar que son públicos por diseño y evitar datos sensibles.

---

### 🟠 SEC-009 — CORS totalmente abierto (`cors()` sin allowlist)

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`app.use(cors())` (`server.js:152`) refleja cualquier origen. La auth de sesión es por header Bearer (no cookies), así que el riesgo CSRF clásico es bajo; pero sin allowlist no hay defensa de origen, y combinado con tokens en `localStorage` (XSS) amplía la superficie de exfiltración cross-origin.

**Fix:** allowlist de orígenes (dominio de la instalación + app móvil), dejando abiertas solo las rutas públicas de tracking/sites.

---

### 🟠 SEC-010 — Media servida públicamente con `Content-Disposition: inline` (riesgo de XSS almacenado)

**Tipo:** bug-seguridad · **confidence:** requiere-verificacion-manual

`GET /media/assets/:assetId/file` (`media.routes.js:65-72`) es público (antes de `requireAuth`) y `serveMediaAssetFileHandler` (`mediaController.js:380-398`) hace stream con el `Content-Type` del asset y `Content-Disposition 'inline'`. Si el upload permite subir SVG/HTML, un archivo malicioso se renderiza en el origen de la app y ejecuta scripts (XSS almacenado), accesible sin sesión por quien conozca el `assetId`. **Requiere verificar** la validación de MIME en upload.

**Fix:** forzar `Content-Disposition: attachment` (o CSP/sandbox) para tipos no-imagen, allowlist de MIME en upload, y servir media desde un dominio separado.

---

### 🟠 SEC-008 — Registro dinámico de clientes OAuth abierto sin autenticación

**Tipo:** bug-seguridad · **confidence:** probable

`POST /api/oauth/register` (`oauth.routes.js:122-136`) no requiere autenticación: cualquiera registra un `oauth_client` con `redirect_uris` arbitrarias (`oauthTokens.js:94-122`). Permite preparar clientes con `redirect_uri` del atacante; combinado con ingeniería social en el form de authorize (la víctima pega su API token), el code podría entregarse a un redirect controlado.

**Fix:** restringir el registro (auth de admin o, dado que es DCR de MCP, rate limit + validación estricta de `redirect_uris` + mostrar el nombre del cliente en el consentimiento).

---

## 7. Manejo de secretos y credenciales

### 🟠 GHL-001 — Token de HighLevel en texto plano + endpoint que lo devuelve completo

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

El Private Integration Token de HL (acceso total a contactos, pagos, conversaciones del location) se guarda **sin cifrar** en `highlevel_config.api_token` (`database.js:1140`). Otros secretos SÍ se cifran (Conekta privateKey, Google refresh token, email password), confirmando la asimetría. `revealToken` (`highlevelController.js:1155-1180`) lo devuelve **íntegro sin máscara**, y la ruta (`highlevel.routes.js:53`) solo exige `requireAuth` — cualquier usuario autenticado, incluso de rol limitado, lo extrae.

**Fix:** cifrar `api_token` en reposo (como `openai_api_key_encrypted`); restringir `revealToken` a rol admin/owner; devolver solo preview salvo acción explícita auditada.

---

### 🟠 SEC-003 — Master key de cifrado guardada en plano en la misma DB que protege

**Tipo:** bug-seguridad · **verifyStatus:** confirmado · `utils/encryption.js`

Si no hay `ENCRYPTION_MASTER_KEY` en el entorno, `getMasterKey()` genera una clave y hace `INSERT INTO app_config (config_key='encryption_master_key', config_value=newKeyHex)` en **hex plano** (líneas **50-66**), en la misma base donde viven todos los secretos cifrados de integraciones (Stripe, Meta/GHL/Google tokens, OpenAI). Comprometer un dump/backup entrega **la llave junto al ciphertext**, anulando el cifrado en reposo.

**Fix:** exigir `ENCRYPTION_MASTER_KEY` desde el entorno (fallar el arranque en producción si falta) en lugar de auto-generar y persistir en DB.

---

### 🟠 META-005 — Access token de Meta se revela y viaja por query string

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`revealMetaToken` (`metaController.js:1035-1058`) devuelve el token desencriptado completo al navegador, y el frontend lo manda como **query param** (`?accessToken=`) a `/ad-accounts`, `/pixels`, `/pages` (`metaController.js:3181-3241`; `MetaAdsIntegration.tsx:707-727`). Los query params quedan en logs de proxy/Render, historial y referers. El token de System User es de larga duración ("Nunca" expira), con `ads_management`/`business_management`.

**Fix:** que `/ad-accounts /pixels /pages` usen el token guardado en backend; no revelar el token completo al frontend; pasar secretos por body/headers, nunca query.

---

### 🟠 NOTI-005 / MOB-008 — DELETE de suscripción/dispositivo push sin verificar propiedad

**Tipo:** bug-seguridad · **verifyStatus:** confirmado *(consolida NOTI-005 y MOB-008 — mismo defecto)*

`disableSubscription` / `disableMobileDevice` (`pushController.js:48-104`) reciben `endpoint`/`token` del body y ejecutan `UPDATE ... WHERE endpoint=?` / `WHERE token=?` (`pushNotificationsService.js:545-553,616-624`) **sin filtrar por `user_id`**. Cualquier usuario autenticado que conozca/adivine un token puede deshabilitar el dispositivo de otro (DoS de notificaciones).

**Fix:** filtrar por `user_id` del solicitante o validar propiedad antes de deshabilitar.

---

### 🔵 SEC-011 — Comparación de firma JWT no constante (timing)

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`verifyToken` compara la firma con `!==` (`auth.js:144-147`) en vez de `crypto.timingSafeEqual`, a diferencia de `oauthTokens`/`apiTokens`/`verifyScopedToken` que sí usan comparación constante. Canal de timing teórico; regresión de la propia convención del proyecto.

**Fix:** `crypto.timingSafeEqual` sobre buffers de igual longitud.

---

### 🔵 SEC-012 / ACL-005 — Filtro de contactos ocultos construido por concatenación de string

**Tipo:** deuda-tecnica / bug-tecnico · **confidence:** probable *(consolida SEC-012 y ACL-005)*

`buildHiddenContactsCondition` (`hiddenContactsFilter.js:34-55`) interpola `filter.text` directamente en el SQL con solo un escape de comilla simple (`'→''`), en vez de parámetros bindeados. El texto lo controlan usuarios autenticados (ver ACL-003); riesgo bajo pero real: `%`/`_` de `LIKE` no se escapan y en Postgres los backslashes se tratan distinto.

**Fix:** parametrizar los valores; escapar también `%`/`_`.

---

### 🔵 SEC-006 — API externa expone la tabla `users` como directorio

**Tipo:** bug-seguridad · **verifyStatus:** confirmado *(reclasificado medio→bajo: PII de empleados, no de clientes)*

`resolveAccessibleTable` (`external.routes.js:49-50,175-189`) solo bloquea lectura de tablas en `SENSITIVE_TABLE_PATTERN`; `users` está solo en `WRITE_BLOCKED`. `GET /api/external/data/users` con cualquier API token devuelve `id, username, email, full_name, role, access_config` (los `*_hash` se redactan). Expone el directorio de empleados y el mapa de permisos — útil para reconocimiento y targeting de cuentas admin.

**Fix:** agregar `users` (y tablas con PII de cuenta) a `SENSITIVE_TABLE_PATTERN`.

---

## 8. Privacidad de datos sensibles / médicos (brutalmente honesto)

Ristak se vende a negocios que pueden manejar **datos de pacientes**. La realidad del corpus es que la privacidad fina dentro de una instalación es **débil y evitable**:

1. **Contactos ocultos no se ocultan de verdad** (ACL-002 / SEC-005). El admin marca un contacto como oculto y reaparece con nombre, email y teléfono por búsqueda, búsqueda global, apertura por ID y reportes de pagos. La capa de privacidad da una **falsa sensación de seguridad**.

2. **Las notificaciones push filtran contactos ocultos con nombre + texto del mensaje** (🔴 **NOTI-004 / MOB-002**, consolidado, verifyStatus confirmado). `sendChatMessageNotification` (`pushNotificationsService.js:1022-1054`) arma el payload con `title = nombre del contacto` y `body = texto del mensaje`, y lo envía vía `sendAppNotificationPayload`. `resolvePushNotificationTargetForEvent` (`notificationPreferencesService.js:105-140`) resuelve destinatarios solo por opt-in de evento (all/admins/explícitos), **nunca por visibilidad de contacto**. `grep` confirma **cero** referencias a `hidden_contact`/`buildHiddenContactsCondition` en toda la capa push. Un mensaje entrante de un contacto oculto dispara un push con su nombre y el texto del WhatsApp **en la pantalla de bloqueo** del celular de empleados que no deberían verlo. En contexto médico, fuga de PII sensible.

3. **No hay segmentación por usuario** (ACL-004): cualquier empleado con acceso a Contactos ve toda la base, incluyendo custom fields que pueden contener datos médicos.

4. **El trace del agente IA es visible entre empleados** (🔵 AI-008, confidence probable): `getAgentRunTrace` (`agentExecutionLedgerService.js:248-267`) filtra por `(user_id = ? OR user_id IS NULL)`, y los runs conversacionales se guardan con `userId:null` (`runner.js:846`). Un empleado con módulo `ai_agent` que obtenga un `traceId` puede leer el contenido completo de conversaciones. Riesgo bajo (traceId UUID aleatorio), pero la consulta no ata el run al scope del usuario.

5. **La página pública `/pay` expone identidad fiscal del merchant** (🔵 PAY2-009, confirmado): `getPublicPaymentSettings` (`paymentSettingsService.js:427-435`) devuelve `taxes` completo (RFC, razón social, CP, régimen) a cualquier visitante del link `/pay/:id`. Es del propio merchant, pero innecesario para mostrar el pago.

6. **La base de datos de cada cliente está expuesta a Internet de forma permanente** (🟠 INST-008): `ensurePostgresExternalAccess` fija `ipAllowList` a `0.0.0.0/0` y lo **reaplica en cada update** (`render.service.js:106-139`, `update.service.js:60-63`). La Postgres con todos los datos del cliente queda accesible por IP desde cualquier origen, protegida solo por credenciales, no solo durante soporte.
   **Fix:** abrir bajo demanda y cerrar al terminar, o restringir el CIDR a las IPs del portal.

7. **Tarjetas y consentimiento** (🔵 PAY2-008): la tarjeta del cliente se guarda **por defecto** en cada pago público Conekta sin opt-in explícito (`savePaymentSource` default `true`), habilitando cobros off-session futuros — posible problema de cumplimiento/PCI.

---

## 9. Portal/Installer — secretos y superficie de ataque

### 🔴 PORTAL-001 — El entorno demo opera sobre las conexiones reales de WhatsApp y Meta de producción

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`demo.routes.js` importa los servicios **globales** `metaAds.*` y `whatsapp.*` (los mismos del admin), no un sandbox. Un `demo_user` (creado para revisores / Meta App Review, bajo privilegio) puede **enviar mensajes WhatsApp reales** (`/integrations/whatsapp/messages → whatsapp.sendTextMessage`, líneas 333-340), crear/borrar plantillas reales, y **cambiar la selección de Meta Ads de producción** (`/integrations/meta-ads/select → metaAds.saveSelection`, líneas 215-226). El header dice "acceso aislado" pero solo es aislamiento de **auth**, no de **datos**. El mecanismo `sendDisabledIntegration` solo cubre seed-pixel/seed-campaigns/test-event, no WhatsApp/select.

**Fix:** sandbox/conexión de prueba dedicada, o forzar respuestas mock/403 en todos los endpoints de escritura del demo.

---

### 🔴 PORTAL-002 — `setup-token/verify` expone el hash de contraseña del dueño, repetible y sin atar `installation_id`

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`POST /api/setup-token/verify` (`license.routes.js:520`) llama `peekSetupToken` (**no consume** el token) y devuelve `owner_password_hash` (PBKDF2 del dueño) en cada llamada (rate limit 30/15min). `findValidToken` (`setupToken.service.js:53-70`) solo compara `installation_id` si se envía, así que **basta el token**. El token viaja en **query string** del SSO (`/sso?token=...`; `/setup?token=...`, `admin.routes.js:2289`) y se reutiliza para el app-login de soporte del admin.

**Impacto:** quien capture el token (logs, historial, referers) extrae el hash de contraseña del dueño para crackeo offline, cuantas veces quiera dentro del TTL de 24h.

**Fix:** no devolver `password_hash` en `/verify` (peek); entregarlo solo en `/consume` (un solo uso); exigir `installation_id` obligatorio; mover el token al body/Authorization.

---

### 🔴 PORTAL-003 — Token de release móvil reutilizable 120 min y endpoint de credenciales sin rate limit

**Tipo:** bug-seguridad · **verifyStatus:** confirmado

`validateMobileReleaseToken` (`mobileStoreRelease.service.js:121-156`) solo actualiza `last_used_at`; **nunca marca consumido** → reutilizable hasta expirar (TTL 120 min). `readMobileReleaseCredentials` (líneas 158-174) devuelve **en claro** el `.p8` de App Store Connect, certificado iOS + password, provisioning profile, keystore Android + passwords y el service account JSON de Google Play. El endpoint `POST /api/webhooks/mobile-release/credentials` (`webhook.routes.js:569-591`) **no tiene rate limit**.

**Impacto:** si el token se filtra (logs de CI), cualquiera lee **todas** las credenciales de firma móvil durante 120 min, repetidamente, y puede publicar apps maliciosas en App Store/Play Store en nombre de la marca.

**Fix:** token de un solo uso (`consumed_at` en la primera lectura); rate limit estricto; reducir TTL; loguear cada lectura con IP.

---

### 🟠 INST-004 — Llave de cifrado de la Render API Key derivada de `JWT_SECRET`

**Tipo:** bug-seguridad · **confidence:** probable

`getMasterSecret` (`utils/crypto.js:39-61`) usa `INSTALLER_ENCRYPTION_KEY` si existe; si no, deriva `'installer-master:'+JWT_SECRET`. Las Render API Keys de los clientes se cifran con esa llave y se usan para updates centralizados y `destroy-resources`. Si `JWT_SECRET` cambia (operación rutinaria de infra), `decryptSecret` falla (`update.service.js:44-51`, `decrypt_failed`) y se **pierde el acceso a la API key de todas las instalaciones** sin `deploy_hook_url`.

**Fix:** exigir `INSTALLER_ENCRYPTION_KEY` dedicada y persistente; no derivar de `JWT_SECRET`; versionar la llave por registro.

---

### 🟠 PORTAL-004 — Brokers de refresh Google/MP aceptan cualquier `refresh_token` sin atarlo al cliente

**Tipo:** bug-seguridad · **confidence:** probable

`POST /api/license/google-calendar/refresh-token` y `.../mercadopago/refresh-token` validan la licencia del cliente que llama, pero pasan `refresh_token` **tal cual del body** a `refreshGoogleOAuthAccessToken`/`refreshMercadoPagoOAuthToken` (que usan el `client_secret` central) **sin verificar pertenencia al `client_id`**. Una instalación que obtenga el refresh token de otra (fuga de logs/backup) puede renovarlo usando el portal como oráculo.

**Fix:** atar el refresh al cliente (guardar/hashear por `client_id` y verificar pertenencia).

---

### 🟠 PORTAL-005 — `app_url` se promueve a un dominio arbitrario desde una verify call sin confirmación

**Tipo:** bug-seguridad · **confidence:** probable

`canPromotePublicAppUrl` (`license.service.js:43-56`) permite reemplazar `installation.app_url` por cualquier host con origen `.onrender.com` que empiece con `app`, sin intervención humana. Ese `app_url` se usa como `allowedReturnOrigin` de OAuth y base de webhooks de MercadoPago. Quien controle `client_id+license_key+installation_id` puede mover el dominio público y potencialmente redirigir returns de OAuth o webhooks de pago.

**Fix:** verificación explícita de dominio antes de promover, o allowlist gestionada por admin.

---

### 🟠 PORTAL-006 — JWT del portal con secreto por defecto fuera de prod y sin revocación admin

**Tipo:** bug-seguridad · **confidence:** confirmado

`getJwtSecret()` (installer `auth.js:3-13`) usa `'ristak-installer-default-secret-change-me'` si no hay `JWT_SECRET` y `NODE_ENV!=='production'`. Los tokens admin no tienen `jti` ni lista de revocación. Si una instancia corre sin `NODE_ENV=production`, el secreto es público y se forjan tokens admin; aun en prod, un token admin filtrado vive hasta `exp` sin revocación. El token demo dura 30 días.

**Fix:** exigir `JWT_SECRET` siempre; añadir `jti` + tabla de revocación o `token_version` por admin.

---

### 🟠 INST-006 — Una sola API key estática y compartida protege el webhook de deploy

**Tipo:** bug-seguridad · **confidence:** probable

`POST /api/webhooks/deploy` se autentica con `requireWebhookKey`, que acepta la **misma** API key estática usada para todos los webhooks (clients, payments, deploy), compartida con integraciones de pago/n8n/Zapier (`webhook.routes.js:18-21`). No hay firma HMAC de GitHub ni llave dedicada. Quien tenga esa key puede disparar `triggerChannelUpdate('test')` redesplegando todas las apps Test, o registrar `deploy_events` falsos.

**Fix:** llave dedicada o firma HMAC de GitHub (`X-Hub-Signature-256` sobre `rawBody`) para `/deploy`.

---

### 🔵 INST-009 — El webhook de deploy confía en el campo `channel`/`branch` del body sin validar la rama real

**Tipo:** falta-validacion · **confidence:** probable

En `/deploy`, `channel` se deriva de `body.channel||body.branch` (`webhook.routes.js:428-448`). Cualquier llamada autenticada con `channel:'test'` dispara `triggerChannelUpdate('test')` aunque el build venga de una rama de feature, sin verificar el sha/branch real de GitHub.

**Fix:** validar que el deploy provenga de `main` (cruzar con `readMainSha`) antes de propagar.

---

### 🔵 TRK-009 — Snippet inyecta `rkvi_id` (visitor_id) en la URL: fuga en referrers y enlaces compartidos

**Tipo:** decision-producto · **confidence:** probable

`injectVisitorIdToURL` (`trackingController.js:789-810`) reescribe la URL agregando `?rkvi_id=<visitor_id>` en cada carga; queda visible y se propaga por copiar/compartir o por cabecera Referer. `getUrlVisitorId` (`trackingController.js:346-378`) además acepta `rkvi_id` de la URL como fuente de identidad, permitiendo que otra persona herede el visitor_id y se asocie a otro contacto.

**Fix:** no persistir `rkvi_id` en la URL visible (solo cookie/localStorage); no aceptar `rkvi_id` de la URL para establecer identidad cuando ya hay una cookie distinta.

---

## 10. Tabla consolidada de hallazgos de seguridad/privacidad

| ID(s) | Título corto | Sev. | Tipo | verifyStatus / confidence |
|---|---|---|---|---|
| SEC-001 | Proxy arbitrario a GoHighLevel con API token | Crítico | bug-seguridad | confirmado |
| NOTI-001 | Caída de OpenAI cancela citas confirmadas | Crítico | bug-integracion | confirmado |
| AUTH-001 / SEC-004 | Sin rate limiting (login/OAuth/API externa) | Alto | falta-validacion | confirmado |
| AUTH-002 | Reset público fija `admin/admin123` | Alto | bug-seguridad | confirmado |
| AUTH-003 / SEC-007 | JWT 30 días sin revocación | Alto | bug-seguridad | confirmado |
| LIC-001 | Premium sin `requireFeature` (bypass de plan) | Alto | bug-seguridad | confirmado |
| LIC-003 | `allowed:true` sin features = todo premium | Alto | bug-seguridad | confirmado |
| ACL-001 | Módulos sin `requireModuleAccess` en backend | Alto | bug-seguridad | confirmado |
| ACL-002 / SEC-005 | Contactos ocultos se filtran (search/ID/reportes) | Alto | bug-seguridad | confirmado |
| GHL-001 | Token HighLevel en texto plano + reveal | Alto | bug-seguridad | confirmado |
| SEC-002 | Webhooks pago/contacto sin firma | Alto | bug-seguridad | confirmado |
| SEC-003 | Master key en plano en la misma DB | Alto | bug-seguridad | confirmado |
| WA-001 | Webhook YCloud sin firma cuando falta secret | Alto | bug-seguridad | confirmado |
| WA-004 | Webhook atribución sin firma sobreescribe datos | Alto | bug-seguridad | confirmado |
| NOTI-004 / MOB-002 | Push filtra contactos ocultos (nombre+texto) | Alto | bug-seguridad | confirmado |
| TRK-001 | `/collect` acepta sesiones falsas | Alto | bug-seguridad | confirmado |
| TRK-004 | Submit público de Sites sin anti-abuso | Alto | falta-validacion | confirmado |
| PORTAL-001 | Demo opera sobre WhatsApp/Meta reales | Alto | bug-seguridad | confirmado |
| PORTAL-002 | `setup-token/verify` expone hash del dueño | Alto | bug-seguridad | confirmado |
| PORTAL-003 | Token release móvil reutilizable, sin rate limit | Alto | bug-seguridad | confirmado |
| INST-004 | Llave de cifrado derivada de `JWT_SECRET` | Alto | bug-seguridad | probable |
| AUTH-004 | `JWT_SECRET` fallback estático fuera de prod | Medio | bug-seguridad | confirmado |
| AUTH-005 | Política de contraseñas débil | Medio | falta-validacion | confirmado |
| AUTH-007 | Password del dueño en claro sin forzar HTTPS | Medio | bug-seguridad | probable |
| AUTH-010 | Sin recuperación de cuenta (solo Render Shell) | Medio | decision-producto | confirmado |
| ACL-003 | Cualquier empleado edita filtros de ocultos | Medio | bug-seguridad | confirmado |
| ACL-006 | `POST/DELETE /api/config` sin gate de módulo | Medio | bug-seguridad | confirmado |
| GHL-007 | Rutas HighLevel solo `requireAuth` | Medio | bug-seguridad | confirmado |
| META-005 | Token Meta revelado y por query string | Medio | bug-seguridad | confirmado |
| NOTI-005 / MOB-008 | DELETE push sin verificar propiedad | Medio | bug-seguridad | confirmado |
| PAY2-005 | Webhook MP sin firma cuando falta secret | Medio | bug-seguridad | confirmado |
| AUTO-009 | Assets de automatización públicos por ID | Medio | bug-seguridad | confirmado |
| SEC-008 | Registro OAuth abierto sin auth | Medio | bug-seguridad | probable |
| SEC-009 | CORS sin allowlist | Medio | bug-seguridad | confirmado |
| SEC-010 | Media inline (XSS almacenado) | Medio | bug-seguridad | requiere-verif-manual |
| INST-006 | API key compartida en webhook deploy | Medio | bug-seguridad | probable |
| INST-008 | Postgres de cliente abierta a `0.0.0.0/0` | Medio | bug-seguridad | confirmado |
| PORTAL-004 | Broker refresh OAuth sin atar al cliente | Medio | bug-seguridad | probable |
| PORTAL-005 | `app_url` promovido sin confirmación | Medio | bug-seguridad | probable |
| PORTAL-006 | JWT portal default + sin revocación | Medio | bug-seguridad | confirmado |
| AUTH-008 | `/verify` sin auth (sondeo/amplificación) | Bajo | deuda-tecnica | confirmado |
| LIC-002 | `requireFeature` antes de `requireAuth` (amplificación) | Bajo | bug-arquitectura | confirmado |
| AI-008 | Trace IA visible entre empleados (user_id NULL) | Bajo | bug-seguridad | probable |
| SEC-006 | API externa expone tabla `users` | Bajo | bug-seguridad | confirmado |
| PAY2-009 | `/pay` expone RFC/razón social del merchant | Bajo | bug-datos | confirmado |
| PAY2-008 | Tarjeta guardada por defecto sin consentimiento | Bajo | decision-producto | confirmado |
| SEC-011 | Comparación de firma JWT no constante | Bajo | bug-seguridad | confirmado |
| SEC-012 / ACL-005 | Filtro de ocultos por concatenación SQL | Bajo | deuda-tecnica | probable |
| INST-009 | Webhook deploy confía en `channel` del body | Bajo | falta-validacion | probable |
| TRK-009 | Snippet inyecta `rkvi_id` en la URL (fuga referrer) | Bajo | decision-producto | probable |

**Refutado (NO es problema):** `RPT-002` — los ingresos netos no restan reembolsos. Refutado: el reembolso muta el pago a `refunded`, que ya queda fuera del cálculo de ingresos exitosos.

---

## 11. Prioridades recomendadas

**Inmediato (crítico + privacidad de pacientes):**
1. **SEC-001** — cerrar o restringir el proxy GoHighLevel.
2. **NOTI-001** — que un fallo de OpenAI nunca cancele citas.
3. **NOTI-004 / MOB-002** — filtrar contactos ocultos antes de mandar push con nombre+texto.
4. **ACL-002 / SEC-005** — aplicar el filtro de ocultos en search/global/getById/reportes.

**Corto plazo (altos transversales):**
5. **AUTH-001 / SEC-004** — rate limiting en login, OAuth, API externa y formularios públicos (TRK-004).
6. **SEC-002 / WA-001 / WA-004 / PAY2-005** — firma obligatoria en todos los webhooks; rechazar 401 sin secret.
7. **ACL-001 / GHL-007 / ACL-006** — replicar el control de módulo del frontend en el backend.
8. **LIC-001 / LIC-003** — gate de licencia consistente en backend y failure-closed.
9. **AUTH-003 / SEC-007** — revocación de sesiones (`token_version`) + logout server-side.
10. **GHL-001 / SEC-003 / META-005** — cifrar secretos en reposo, no derivar la master key de la propia DB, no pasar tokens por query string.
11. **PORTAL-001/002/003 / INST-004 / INST-008** — aislar el demo, no exponer el hash del dueño, tokens de release de un solo uso, llave de cifrado dedicada, cerrar la Postgres a Internet.
