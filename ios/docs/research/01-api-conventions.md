# 01 — Convenciones de API y red del backend Ristak

> Spec de investigación para la app nativa SwiftUI (iPhone/iPad, iOS 26).
> Fuentes: `backend/src/server.js`, `backend/src/middleware/*`, `backend/src/utils/auth.js`,
> `backend/src/controllers/authController.js`, `mobile/src/api.ts`, `mobile/src/storage.ts`,
> `mobile/src/access.ts`, `frontend/src/services/apiBaseUrl.ts`, `frontend/src/services/authFetch.ts`,
> `docs/MOBILE_APP.md`, `docs/DATE_TIME_GUIDELINES.md`, `docs/CURRENCY_GUIDELINES.md`,
> `docs/EXTERNAL_API_ACCESS.md`. Todo lo que no está confirmado en código se marca como **OPEN QUESTION**.

---

## 1. Resumen ejecutivo

- Backend: Node/Express, un solo proceso, escucha en `PORT` (default **3001**), `0.0.0.0` (`backend/src/server.js:108-109,481`).
- Todas las APIs privadas viven bajo el prefijo **`/api`**. En producción el mismo proceso sirve el frontend estático (`frontend/dist`) y responde `404 {"error":"Endpoint no encontrado"}` para rutas `/api`/`/webhook` desconocidas (`server.js:352-369`).
- **Single-tenant por instalación**: cada cliente tiene su propio backend (Render). NO hay header de tenant/workspace; el "tenant" se resuelve **antes del login** contra el portal instalador central (`https://www.ristak.com`, `POST /api/mobile/resolve`) que devuelve la `app_url` de la instalación del cliente. A partir de ahí todos los requests van a esa base URL.
- Autenticación: JWT propio (HS256 hecho a mano, sin librería), header **`Authorization: Bearer <jwt>`**, expira a los **30 días**, con `tokenVersion` para revocación al cambiar contraseña (`backend/src/utils/auth.js:130-203`).
- Tres capas de autorización en cada request: (1) `requireAuth` (401), (2) licencia central (`license_blocked`, 403) + features del plan (`feature_not_available`, 403), (3) permisos por usuario/módulo (`read_access_required`/`write_access_required`, 403).
- Convención de éxito dominante: `{ "success": true, ... }`. Muchos endpoints envuelven el resultado en `data`; el cliente móvil desenvuelve automáticamente `{ success, data }` (ver §7.1).
- Zona horaria y moneda son **de la cuenta**, nunca del dispositivo: `GET /api/settings/timezone` y `app_config.account_currency` vía `GET /api/config?keys=account_currency`.

---

## 2. Base URLs y resolución de tenant

### 2.1 Entornos

| Entorno | Backend | Frontend web | Nota |
|---|---|---|---|
| Dev local | `http://localhost:3001` | Vite dev `http://localhost:3000` (proxy/`VITE_API_URL`) | `POST /api/auth/local-dev-session` abre sesión sin password sólo desde loopback y `NODE_ENV!=='production'` (`authController.js:281-339`) |
| Producción | `https://<instalacion>.onrender.com` o dominio propio (`app_url` del tenant) | Servido por el mismo backend | `NODE_ENV=production` |

- Web de escritorio/movil (`frontend/`): base URL = `VITE_API_URL` de build, o el origin actual si vacío. En shell Capacitor nativo, la base se guarda en `localStorage['ristak.mobile.apiBaseUrl.v1']` y el tenant en `localStorage['ristak.mobile.tenant.v1']` (`frontend/src/services/apiBaseUrl.ts:3-6,93-133`). Cambiar de base URL limpia `auth_token` y storage con prefijos `rstk_config_`, `ristak_phone_` (`apiBaseUrl.ts:84-91`).
- La base URL siempre se normaliza a **origin** (sin path, sin slash final, sólo `http:`/`https:`) — `cleanBaseUrl` en `apiBaseUrl.ts:16-27` y `mobile/src/format.ts:37`.

### 2.2 Resolución de tenant (login móvil, SIN pedir URL)

La app RN (`mobile/src/api.ts:1206-1237`) y la nativa iOS deben replicar esto:

```
POST {INSTALLER_BASE}/api/mobile/resolve
Content-Type: application/json
Body: { "identifier": "<email del usuario, trim>" }   // mínimo 3 chars
```

- `INSTALLER_BASE` = `EXPO_PUBLIC_INSTALLER_API_URL` (env) o default **`https://www.ristak.com`** (`api.ts:62,202-209`). Frontend usa `VITE_INSTALLER_API_URL` con el mismo default.
- Respuesta (`InstallerTenantResponse`, `api.ts:179-189`):

```json
{
  "success": true,
  "tenant": {
    "client_id": "…",
    "installation_id": "…",
    "name": "…",
    "email": "…",
    "app_url": "https://cliente.onrender.com"
  },
  "message": "…"            // presente en error
}
```

- Si `!response.ok || !success || !app_url` → error con `message` o fallback `"No encontre una app activa para ese correo."` (`api.ts:1225-1228`).
- Flujo completo de login: `loginWithResolvedTenant(identifier, password)` = resolver tenant → `POST {app_url}/api/auth/login`. Si la respuesta trae `code:'license_blocked'` se propaga ese código (`api.ts:1239-1264`).
- El backend publica el directorio de usuarios al portal en el boot (`requestPortalUserRefresh`, `server.js:396`) para que dueño **y empleados** resuelvan por su correo.

### 2.3 Persistencia de sesión (RN — replicar con Keychain en iOS)

`mobile/src/storage.ts` usa `expo-secure-store`:

| Clave | Contenido |
|---|---|
| `ristak.native.apiBaseUrl.v1` | base URL de la instalación (origin) |
| `ristak.native.authToken.v1` | JWT |

Bootstrap de la app (`mobile/src/App.tsx:1176-1224`):
1. Lee baseUrl+token. Sin baseUrl o sin token → pantalla login.
2. Con ambos: entra al shell **optimistamente** y verifica en paralelo con `POST /api/auth/verify` con timeout de **8000 ms** (`BOOTSTRAP_SESSION_VERIFY_TIMEOUT_MS`, `App.tsx:358`).
3. `verify` OK → guarda `user`. `verify` falla con status **401/403** → borra token y va a login. Cualquier otro error (red/timeout) → **se queda en el shell con el token** (tolerante a offline; el user queda `null` y los gates de sección no ocultan nada — ver §6.3).

---

## 3. Montaje de rutas y gating por mount (`server.js:278-349`)

Orden de middlewares globales: contador de drain → CORS → `express.json({limit:'35mb'})` (guarda `req.rawBody`) → `express.urlencoded({limit:'35mb'})` → static `/uploads` (cache 7d immutable) → health → **gate de arranque** (503 si la app no terminó de arrancar) → media/internal/trigger-links → host-router de Sites públicos → API routes.

| Mount | Router | Gating en el mount |
|---|---|---|
| `/` | oauthRoutes | — (OAuth/`.well-known`) |
| `/api/auth` | auth | rate limits; sub-rutas con `requireAuth` según endpoint |
| `/api/api-access` | apiAccess | interno del router |
| `/api/media`, `/media` | media | interno |
| `/api/internal`, `/internal` | internalStorage | interno |
| `/api/sites` | sites | interno (checkout/leads públicos, no gatear) |
| `/api/automations` | automations | `requireAuth` + `requireFeature('automations')` |
| `/api/appointment-reminders` | appointmentReminders | interno |
| `/api/reports` | reports | `requireAuth` + `requireFeature('advanced_reports')` |
| `/api/highlevel` | highlevel | interno del router |
| `/api/products` | products | interno |
| `/api/subscriptions` | subscriptions | interno |
| `/api/stripe` `/api/mercadopago` `/api/conekta` `/api/clip` `/api/rebill` | pasarelas | interno (webhooks públicos, no gateados en mount) |
| `/api/meta` | meta | `requireAuth` + `requireFeature('meta_ads')` (pixel-test es público con token corto, `server.js:306-307`) |
| `/api/dashboard` | dashboard | `requireAuth` + `requireFeature('dashboard')` |
| `/api/webhook-config` | webhookConfig | interno |
| `/api/contacts` | contacts | `requireAuth` + `requireFeature('contacts')` (+ dentro: `requireModuleAccess('contacts')` global y `'chat'` en `/chats*`, `/:id/linked-social` — `contacts.routes.js:47-90`) |
| `/api/contact-tags` | contactTags | `requireAuth` + `requireFeature('contacts')` |
| `/api/transactions` | transactions | `requireAuth` + `requireFeature('payments')` |
| `/api/integrations` | integrations | `requireAuth` + `requireFeature('integrations')` |
| `/api/attribution` | attribution | `requireAuth` + `requireFeature('analytics')` |
| `/api/settings` | settings | `router.use(requireAuth)` interno (`settings.routes.js:61`) |
| `/api/calendars` | publicCalendars + calendars | `requireFeature('google_calendar')`; booking público SIN auth; el router privado aplica `requireAuth` interno |
| `/api/push` | push | `/public-key` y `/contact-avatar/:contactId` públicos; resto `requireAuth` (`push.routes.js`) |
| `/api/license` | license | `/status` con `requireAuth`; account-cancellation con admin |
| `/api/mdp-program` | mdpProgram | `requireAuth` + `requireFeature('mdp_program')` |
| `/api/chat-events` | chatEvents | `requireAuth` + `requireModuleAccess('chat')` interno |
| `/api/payment-events` | paymentEvents | `requireAuth` + `requireFeature('payments')` |
| `/api/config` | config | `router.use(requireAuth)`; POST/DELETE además `requireModuleAccess('settings_account')` (`config.routes.js`) |
| `/api/user-config` | userConfig | `router.use(requireAuth)`; `/admin*` con `requireAdmin` |
| `/api` | costs | interno |
| `/api/hidden-contacts` | hiddenContacts | interno |
| `/api/ai-agent` | aiAgent | `requireAuth` + `requireFeature('app_assistant_ai')` |
| `/api/conversational-agent` | conversationalAgent | `requireAuth` + `requireFeature('conversational_ai')` |
| `/api/search` | search | `router.use(requireAuth)` interno |
| `/api/external` | external | API token externo (§15) |
| `/api/mcp` | mcp | OAuth/API token |
| `/api/whatsapp-api` | whatsappApi | `requireAuth` + `requireFeature('whatsapp')` |
| `/api/email` | email | `requireAuth` + `requireFeature('email')` |
| `/webhook`, `/webhooks` | webhooks | públicos (proveedores) |
| `/`, `/api/tracking` | tracking público (`/snip.js`, `/collect`, `/sync-visitor`, `/link-visitor`) + privado | mixto |

Regla (LIC-002): `requireAuth` va **antes** de `requireFeature` para que tráfico no autenticado reciba 401 sin tocar el servidor de licencias.

---

## 4. Autenticación

### 4.1 Token JWT

- Formato JWT estándar (header.payload.signature, base64url, HMAC-SHA256) generado a mano (`utils/auth.js:130-153`).
- Payload: `{ userId, username, email, role, tokenVersion, iat, exp }`; **`exp = iat + 30 días`**.
- No hay refresh token ni endpoint de renovación. Cuando expira → 401 y re-login.
- Revocación: `tokenVersion` del token debe coincidir con `users.token_version`; si no → 401 `{ success:false, code:'token_revoked', error:'Tu sesión ya no es válida (la contraseña cambió). Inicia sesión de nuevo.' }` (`authMiddleware.js:42-48`).
- Se envía SIEMPRE como `Authorization: Bearer <token>`. Sin header o mal formado → 401 `{ success:false, error:'Token no proporcionado' }`. Token inválido/expirado → 401 `{ success:false, error:'Token inválido o expirado' }`. Usuario borrado/inactivo → 401 `{ success:false, error:'Usuario no encontrado o inactivo' }`.
- Con licencia enforced, `requireAuth` también valida licencia en cada request (cacheada) y puede devolver 403 `license_blocked` (`authMiddleware.js:59-73`).

### 4.2 Endpoints de `/api/auth` (`auth.routes.js`)

| Método | Path | Auth | Propósito |
|---|---|---|---|
| GET | `/api/auth/setup` | — | ¿Se necesita crear el primer usuario? |
| POST | `/api/auth/setup` | rate-limit IP | Crear primer usuario |
| GET | `/api/auth/setup-info` | — | Validar setup token del instalador |
| POST | `/api/auth/sso` | rate-limit IP | Entrada desde portal central (token de un uso) |
| POST | `/api/auth/login` | rate-limit IP+email | Login con email+password |
| POST | `/api/auth/forgot-password` / `/reset-password` | rate-limit IP | Recuperación por correo |
| POST | `/api/auth/local-dev-session` | sólo dev+loopback | Sesión automática de desarrollo |
| POST | `/api/auth/google/start` | rate-limit IP | Google login vía portal central (requiere licencia enforced; si no → 503 `code:'central_login_not_configured'`) |
| POST | `/api/auth/verify` | — (token va en body) | Verificar JWT + revocación + licencia |
| POST | `/api/auth/change-password` | Bearer | Cambiar contraseña (body: `currentPassword`, `newPassword`) |
| POST | `/api/auth/change-username` | Bearer | Cambiar username |
| PATCH | `/api/auth/profile` | Bearer | Actualizar perfil visible |
| GET | `/api/auth/me` | Bearer | Usuario autenticado (`{ success, user }` con `serializeAuthUser`) |
| GET/POST/PATCH/DELETE | `/api/auth/users*` | Bearer + admin | CRUD usuarios/permisos |
| GET | `/api/auth/api-token` | Bearer | Metadatos del API token externo |
| POST | `/api/auth/api-token/rotate` | Bearer | Rotar API token |
| DELETE | `/api/auth/api-token` | Bearer | Revocar API token |

### 4.3 Login — contrato exacto (`authController.js:155-274`)

Request:
```
POST /api/auth/login
Content-Type: application/json
{ "email": "user@dominio.com", "password": "…" }   // también acepta "username" como alias del email
```

Respuestas:
- **200**:
```json
{
  "success": true,
  "message": "Login exitoso",
  "token": "<jwt>",
  "appId": "<app id externo o null>",
  "apiTokenMetadata": { "…metadatos del API token o null…" },
  "user": { …serializeAuthUser… }
}
```
- **400** `{ success:false, message:'Correo y contraseña son requeridos' | 'Ingresa un correo válido' }`
- **401** `{ success:false, message:'Correo o contraseña incorrectos' | 'Usuario inactivo. Contacta al administrador' }`
- **403** licencia: `{ success:false, code:'license_blocked', reason:'…', message:'…' }`
- **429** rate limit: `{ success:false, code:'rate_limited', message:'Demasiados intentos de inicio de sesión. Espera unos minutos e intenta de nuevo.' }` — 10 fallos / 15 min por IP+email; los logins exitosos no cuentan (`auth.routes.js:50-63`).
- **500** `{ success:false, message:'Error en el servidor' }`

Nota: el email es la única credencial de login (case-insensitive); en instalaciones gestionadas, si el password local falla se verifica contra el portal central y se sincroniza el hash (`authController.js:204-215`).

### 4.4 `serializeAuthUser` — shape exacto del usuario (`authController.js:47-75`)

```json
{
  "id": "…",
  "username": "…",
  "email": "…",                 // "" si null
  "firstName": "…",             // "" si vacío
  "lastName": "…",
  "fullName": "…",              // first+last, o full_name/username de fallback
  "phone": "…",                 // max 40 chars
  "businessName": "…",
  "role": "admin" | "employee",
  "accessConfig": { "<modulo>": "none"|"read"|"write", … },  // SIEMPRE normalizado y completo (admin ⇒ todo write)
  "licenseEnforced": true|false,
  "licensePlan": "…"|null,
  "licenseFeatures": { "<feature>": true|false, … },   // {} si no enforced
  "licenseLimits": { … },
  "licenseExternalModules": { … }
}
```

### 4.5 Verify (`authController.js:382-448`)

```
POST /api/auth/verify
{ "token": "<jwt>" }
```
- 200 `{ success:true, user:{…serializeAuthUser…} }`
- 400 `{ success:false, message:'Token requerido' }`
- 401 `{ success:false, message:'Token inválido o expirado' | 'Usuario no encontrado o inactivo' | 'Token revocado. Inicia sesión de nuevo.' }`
- 403 `license_blocked` (mismo shape que login)

### 4.6 Política de contraseñas (para pantallas de cambio)

Mínimo **10** caracteres, al menos 1 minúscula + 1 mayúscula + 1 dígito, y no estar en una lista de contraseñas comunes (`utils/auth.js:30-49`). El backend devuelve el mensaje de error exacto en `message` (400).

---

## 5. Licencia y features del plan

- `isLicenseEnforced()`: instalaciones standalone (sin portal central) → **todo fail-open** (no se valida licencia ni features).
- **403 `license_blocked`** (`licenseMiddleware.js:8-34`, `authMiddleware.js:63-70`):
```json
{ "success": false, "code": "license_blocked", "reason": "…", "message": "Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar." }
```
  Manejo cliente (web `authFetch.ts:106-122`; RN `api.ts:302-315`): borrar token y mandar a pantalla de bloqueo/login. La app nativa debe hacer lo mismo (handler `onLicenseBlocked`).
- **403 `feature_not_available`** (`licenseMiddleware.js:40-63`):
```json
{ "success": false, "code": "feature_not_available", "feature": "<featureKey>", "message": "Esta función no está incluida en tu plan actual. Contacta al administrador para activarla." }
```
  Convención de UI (RN `api.ts:305-315`): sólo mostrar alerta si el request NO es GET (las cargas de pantalla en background no deben regañar al usuario).
- Feature keys usadas en mounts: `automations`, `advanced_reports`, `meta_ads`, `dashboard`, `contacts`, `payments`, `integrations`, `analytics`, `google_calendar`, `mdp_program`, `app_assistant_ai`, `conversational_ai`, `whatsapp`, `email`.
- `GET /api/license/status` (Bearer) → `{ success:true, enforced:bool, allowed:bool, plan:string|null, features:{}, limits:{}, expires_at:string|null }` (`license.routes.js:18-34`).
- Push móvil managed: `GET /api/license/mobile-push/status` reporta `iosConfigured`/`androidConfigured` (contrato descrito en `docs/MOBILE_APP.md` §Variables de servidor).

---

## 6. Permisos por usuario (módulos)

### 6.1 Modelo (`backend/src/utils/userAccess.js`)

- Roles: `admin` | `employee`. Admin ⇒ acceso `write` a todo.
- Niveles: `none` | `read` | `write`. `read` requerido para GET/HEAD, `write` para el resto (`userAccessMiddleware.js:15-32`).
- Módulos (25): `dashboard, appointments, payments, contacts, chat, reports, analytics, campaigns, automations, sites, ai_agent, settings_account, settings_mobile, settings_calendars, settings_payments, settings_integrations, settings_whatsapp, settings_email, settings_tracking, settings_domains, settings_costs, settings_media, settings_custom_fields, settings_api_access, settings_users`.
- Reglas especiales: `settings_account` siempre `write` para todos; `settings_users` sólo admin; `chat` hereda el nivel de `contacts` cuando la config guardada es anterior a la clave `chat`.

### 6.2 Errores 403 de acceso

```json
{ "success": false, "code": "read_access_required", "module": "chat", "error": "No tienes acceso a esta sección." }
{ "success": false, "code": "write_access_required", "module": "chat", "error": "No tienes permiso para cambiar información en esta sección." }
{ "success": false, "code": "admin_required", "error": "Solo un administrador puede hacer esto." }
```

### 6.3 Gating en el cliente móvil (`mobile/src/access.ts`)

- Secciones del shell → módulo: `chat→chat`, `calendar→appointments`, `payments→payments`, `analytics→analytics`, `settings→settings_mobile`.
- Doble gate: primero licencia (`licenseEnforced` + `licenseFeatures`, con claves legacy: chat←whatsapp; appointments←google_calendar; ai_agent←app_assistant_ai/conversational_ai/ai; settings_mobile←mobile_app), luego `accessConfig` (admin siempre pasa). Feature ausente en el mapa ⇒ permitido (fail-open).
- Si `user == null` (verify pendiente/timeout) NO se ocultan secciones; el backend sigue siendo la autoridad por request (`access.ts:79-85`).

---

## 7. Formas de respuesta, envelope y errores

### 7.1 Envelope de éxito

- Convención dominante: `{ "success": true, … }`.
- Cuando hay payload de lista/objeto suele ir en **`data`**: p.ej. `/api/contacts/chats` → `{ success:true, data:[…] }`; `/api/transactions` → `{ success:true, data:[…], pagination:{…} }`; journey → `{ success:true, data:[…] }`.
- **Regla de desenvolvido del cliente RN** (`api.ts:319-327`) — replicar tal cual en Swift: si el JSON es objeto y tiene **ambas** claves `success` y `data` (con `data !== undefined`) ⇒ devolver `data`; si no, devolver el payload completo. Ejemplos que NO se desenvuelven: `/api/config` → `{ success, config }`; `/api/settings/timezone` → `{ success, timezone, source }`; `/api/license/status` → `{ success, enforced, … }`; login → `{ success, token, user, … }`.
- `204 No Content` ⇒ tratar como éxito con cuerpo vacío (`api.ts:281-283`; lo usa `POST /api/chat-events/viewing`).
- Algunos endpoints devuelven arrays u objetos “pelones” sin envelope (por eso los tipos RN aceptan `T[] | { xxx?: T[] }`, p.ej. `getCalendars`, `getTransactions`). El cliente debe tolerar ambas formas.

### 7.2 Errores — shape y extracción de mensaje

- Shapes posibles: `{ success:false, error:string }`, `{ success:false, message:string }`, o ambos, más opcionales `code`, `reason`, `feature`, `module`.
- Extracción del mensaje (cliente RN `api.ts:191-195`): `payload.error || payload.message || statusText`. Guardar además `status`, `body` y `code`.
- Status codes usados: 400 validación, 401 auth, 403 (license/feature/módulo/admin), 404, 409 (p.ej. `needsSetup`), 429 rate limit, 500 genérico, 502 upstream (Google login), 503 arranque/licencia no configurada.
- Handler global de errores: 500 `{ error:'Error interno del servidor', message: NODE_ENV==='production' ? 'Algo salió mal' : err.message }` (`server.js:372-378`).

### 7.3 Arranque y salud

- Mientras el backend no termina de arrancar, **cualquier ruta no-health devuelve 503**: `{ error:'Aplicación iniciando', message:'La app está terminando de preparar la base de datos y servicios internos.' }` o `{ error:'Aplicación no disponible', message:'El arranque falló. Revisa los logs del servidor.' }` (`server.js:258-274`). El cliente nativo debe tratar 503 como transitorio y reintentar.
- `GET /api/health` (sin auth) → `{ status:'ok'|'starting'|'error'|'shutting_down', startup, timestamp(ISO), environment, version }`; status HTTP refleja readiness.
- `GET /health` (sin auth) → info de instalación para el portal + `ok`, `startup`.
- Deploy con drain: en shutdown el server manda `Connection: close` pero sigue atendiendo (hasta ~295 s); pueden verse cierres de conexión en despliegues.

---

## 8. Paginación — tres convenciones distintas

| Convención | Endpoints | Request | Response |
|---|---|---|---|
| **offset/limit sin total** | `GET /api/contacts/chats` | `limit` (default 50, **máx 100**), `offset` (default 0) (`contactsController.js:1893-1894,2194-2200`) | `{ success, data:[…] }` — no hay `total`; se pagina hasta que el lote regrese `< limit`. Fusionar lotes por `contact.id` (regla en `docs/MOBILE_APP.md` §Lista de chats) |
| **page/limit con objeto pagination** | `GET /api/transactions` (`transactionsController.js:814-838,1028-1039`), `GET /api/contacts` | `page` (default 1), `limit` (default 50, máx 5000 transactions / 500 contacts), filtros `startDate`,`endDate` (`YYYY-MM-DD`), `q` | `{ success, data:[…], pagination:{ page, limit, total, totalPages, hasNext, hasPrev } }`. En transactions la paginación sólo se activa si hay rango filtrado o `limit`, y se desactiva con búsqueda `q` |
| **cursor por fecha (chat)** | `GET /api/contacts/:id/journey` | `chatMessagesOnly=true`, `messageLimit` (máx **500**), `beforeMessageDate=<ISO del mensaje más viejo cargado>` (`contactsController.js:380,422-424`; `api.ts:395-405`) | `{ success, data:[eventos…] }` — para cargar historial hacia atrás |

Los query params se serializan como strings; el cliente RN omite params `undefined`/`null`/vacíos y sólo manda `offset` cuando `> 0` (`api.ts:256-264,344-355`).

---

## 9. Fechas y zona horaria (`docs/DATE_TIME_GUIDELINES.md`)

- **La zona horaria del negocio es la fuente de verdad.** Nunca usar la zona del iPhone para datos de negocio.
- DB guarda instantes en **UTC ISO** (`2026-06-29T21:00:00.000Z`). Fechas de calendario del negocio: `YYYY-MM-DD`.
- Prioridad de resolución backend (`dateUtils.js:66+`): (1) override `app_config.account_timezone`, (2) timezone de HighLevel, (3) default `America/Mexico_City`. Cache 1 h.
- Endpoint: `GET /api/settings/timezone` → `{ success:true, timezone:'America/Mexico_City', source:'ristak'|'highlevel' }`; `POST /api/settings/timezone { timezone }` (IANA válida; vacío/null limpia el override) (`settingsController.js:24-90`).
- Rangos de reportes/dashboard/transacciones: mandar `startDate`/`endDate` como **fechas de negocio `YYYY-MM-DD`**; el backend resuelve start/end-of-day con la zona del negocio.
- Inputs de fecha-hora del usuario (citas, mensajes programados): interpretarlos en `account_timezone` y mandar al backend como **instante UTC ISO** (`scheduledAt`, etc.).
- Calendarios: `GET /api/calendars/events` usa `startTime`/`endTime` en **epoch ms**; `free-slots` usa `startDate`/`endDate` (+`timezone` opcional); `blocked-slots` usa `startTime`/`endTime` y devuelve ISO.
- La UI iOS debe formatear TODAS las fechas visibles con la zona de la cuenta (reglas de la lista de chats: hoy → hora `7:47 p.m.`, ayer → `Ayer`, semana → día de semana, después → `04-jul`; `docs/MOBILE_APP.md` §Lista de chats).

## 10. Moneda (`docs/CURRENCY_GUIDELINES.md`)

- Fuente de verdad: `app_config.account_currency` → leer con `GET /api/config?keys=account_currency`.
- Registros nuevos con dinero: inicializar `currency` con la moneda de cuenta. Registros existentes: **respetar la `currency` guardada en el registro** (`formatCurrency(amount, record.currency || accountCurrency)`).
- Prohibido hardcodear `MXN`/`USD` como default de negocio. Regla móvil dura: **si no se puede leer `account_currency`, la app NO debe crear registros de dinero** (`docs/MOBILE_APP.md` §Pagos).

---

## 11. CORS, transporte y límites

- CORS con allowlist (`server.js:195-220`): orígenes de `APP_URL`, `RENDER_EXTERNAL_URL`, `CORS_ALLOWED_ORIGINS` + siempre `capacitor://localhost`, `ionic://localhost`, `https://localhost`. **Requests sin header `Origin` siempre pasan** → una app nativa iOS con URLSession no necesita nada especial. `credentials: true`.
- Body JSON y urlencoded: **límite 35 MB** (los adjuntos de chat viajan como data URLs base64 en JSON — dimensionar uploads en consecuencia).
- `trust proxy` activado (Render). Rate limits usan IP real de `X-Forwarded-For`.
- `/uploads/*` estático público (cache 7d). Media firmada vive bajo `/media` y `/api/media`.
- No hay versión de API ni header de versión. No hay compresión configurada en Express (el proxy de Render puede aplicarla). **OPEN QUESTION:** no existe header `User-Agent`/versión de app convencional; decidir si la app nativa manda un UA propio (el backend no lo exige).

---

## 12. Tiempo real: SSE + presencia + polling

### 12.1 SSE `GET /api/chat-events/stream` (`chatEvents.routes.js`, `chatLiveEventsService.js`)

- Requiere `requireAuth` + módulo `chat`. **El token va por header Authorization** — un `EventSource` nativo no manda headers; en iOS usar `URLSession` streaming con el header Bearer. No se aceptan tokens por query string.
- Headers de respuesta: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
- Formato: eventos SSE con `id:` incremental, `event: <nombre>`, `data: <JSON>`.
  - Al conectar: `event: connected`, `data: { connected:true, serverTime:ISO }`.
  - Mensajes: `event: chat_message`, `data: { type:'chat_message', contactId, messageId, channel, provider, transport, direction, messageType, messageTimestamp, isNew, receivedAt }`.
  - Heartbeat comentario `: heartbeat <ms>` cada **25 s**.
- **OPEN QUESTION:** existen otros publishers en el servicio (revisar `chatLiveEventsService.js` completo y `paymentLiveEventsService` web para el catálogo de eventos de pagos: `/api/payment-events`).

### 12.2 Presencia

`POST /api/chat-events/viewing` body `{ contactId: string, foreground: boolean }` → **204**. Reporta qué chat está abierto para suprimir push a ese usuario. `contactId:''` o `foreground:false` ⇒ deja de suprimir.

### 12.3 Lo que hace la app RN hoy (paridad mínima)

La app RN **no consume SSE**: hace polling — bandeja cada **20 s** (`CHAT_INBOX_REFRESH_INTERVAL_MS=20000`) y conversación abierta cada **7 s** (`CONVERSATION_REFRESH_INTERVAL_MS=7000`), sin spinners y sin interrumpir el scroll (`App.tsx:729-730,18800-18905`). La web `/movil` sí usa el stream SSE. Para iOS nativo, SSE con URLSession es la mejora natural; el polling es el contrato mínimo verificado.

---

## 13. Cliente API móvil (`mobile/src/api.ts`) — contrato a replicar en Swift

### 13.1 Construcción de requests (`RistakApiClient`, `api.ts:249-328`)

1. `withApiPrefix(path)`: si el path no empieza con `/api`, se antepone (`'/auth/login'` → `/api/auth/login`).
2. URL = `baseUrl + path`; query params: omitir `undefined`/`null`/string vacío; valores → `String(value)`.
3. Headers: `Content-Type: application/json` sólo si hay body y no viene ya definido; `Authorization: Bearer <token>` si hay token.
4. Sin retries, sin timeout custom (salvo el verify del bootstrap, 8 s). **OPEN QUESTION:** definir política de timeout/retry para iOS; el backend no ofrece idempotency-keys (los envíos de chat usan `externalId` único `native-*-<Date.now()>` como dedupe de cliente).
5. Respuesta: 204 → `{}`; parsear JSON tolerante (si falla → `null`).
6. `!response.ok` → error con `message` (§7.2), `status`, `body`, `code`; hooks `onLicenseBlocked` (403+`license_blocked`) y `onFeatureBlocked` (403+`feature_not_available`, sólo métodos ≠ GET).
7. Desenvolver `{ success, data }` (§7.1).

### 13.2 Inventario maestro de funciones del cliente (endpoint + propósito)

**Auth/tenant**
| Función | Endpoint | Propósito |
|---|---|---|
| `resolveMobileTenant(identifier)` | `POST {installer}/api/mobile/resolve` | Resolver instalación por correo |
| `loginWithResolvedTenant(id, pass)` | resolve + `POST /api/auth/login` | Login completo móvil |
| `login(email, password)` | `POST /api/auth/login` | Login directo contra la instalación |
| `verify(token)` | `POST /api/auth/verify` | Validar sesión guardada (sin header auth) |

**Chats/contactos**
| Función | Endpoint | Propósito |
|---|---|---|
| `getChats(q, offset, limit, opts)` | `GET /api/contacts/chats?q&limit&offset&businessPhoneNumberId&businessPhone&warmProfilePictures` | Bandeja paginada, filtrable por número WhatsApp |
| `searchContacts(q)` | `GET /api/contacts/search?q` | Buscar contactos |
| `createContact(payload)` | `POST /api/contacts` | Crear contacto (`name/full_name/first_name/last_name/email/phone/source`) |
| `getContact(id)` | `GET /api/contacts/:id` | Detalle de contacto |
| `updateContact(id, patch)` | `PUT /api/contacts/:id` | Editar (duplica `name` → `full_name`) |
| `getConversation(id, limit, before)` | `GET /api/contacts/:id/journey?includeBusinessMessages=true&refreshExternalStatuses=false&chatMessagesOnly=true&messageLimit&beforeMessageDate` | Mensajes del chat (cursor hacia atrás) |
| `getContactJourney(id)` | `GET /api/contacts/:id/journey?includeBusinessMessages=true&refreshExternalStatuses=false` | Journey completo (Info del contacto) |
| `markChatRead(id)` | `POST /api/contacts/chats/:id/read` (body `{}`) | Marcar chat leído (+ acuse al proveedor en background) |
| `markChatsRead(ids)` | `POST /api/contacts/chats/read` `{contactIds}` | Marcar varios |
| `getContactTags()` / `createContactTag(name)` | `GET/POST /api/contact-tags` | Etiquetas |
| `addContactTag(cid, tagId)` | `POST /api/contacts/bulk/tags` `{contactIds,addTagIds,removeTagIds}` | Asignar etiqueta |
| `getCustomFieldDefinitions(inclArch)` | `GET /api/contacts/custom-fields?includeArchived` | Definiciones de campos custom |
| `getPaymentLinkDeliveryOptions(cid)` | `GET /api/contacts/:id/payment-link-delivery-options` | Canales para mandar un link de cobro |

**Agente conversacional**
| `getAgentStates(cid)` | `GET /api/conversational-agent/states/:cid?includeAll=1` | Estados del agente en el chat |
| `updateAgentState(cid, action, {agentId})` | `POST /api/conversational-agent/states/:cid` `{action:'activate'|'pause'|'take_over'|'skip', agentId?}` | Controlar agente |

**Envío de mensajes** (todos con `externalId` único de cliente y `messageOrigin:'native_mobile_chat'`)
| `sendText(contact, text, channel, reply?, phoneNumberId?, transport?)` | WhatsApp: `POST /api/whatsapp-api/messages/text` `{to,from?,contactId,text,externalId,phoneNumberId?,messageOrigin,transport?('qr'|'api'),replyToMessageId?,replyToProviderMessageId?}`; SMS: `POST /api/highlevel/conversations/messages` `{contactId,channel:'sms_qr',message,toNumber?,externalId}`; Messenger/IG: `POST /api/whatsapp-api/meta/social/messages/text` `{contactId,platform,message,externalId,replyTo…}`; email → error local ("se envía desde la vista completa") |
| `sendImage / sendVideo / sendDocument / sendAudio / sendLocation` | `POST /api/whatsapp-api/messages/{image|video|document|audio|location}` | Media como **data URL** (`imageDataUrl`,`videoDataUrl`,`documentDataUrl`+`filename`+`mimeType`,`audioDataUrl`+`durationMs`+`voice:true`, `latitude/longitude/name/address`) |
| `sendReaction(contact, message, emoji)` | WhatsApp: `POST /api/whatsapp-api/messages/reaction` (`transport` deducido del mensaje: qr/baileys/web → `'qr'`, si no `'api'`); Meta: `POST /api/whatsapp-api/meta/social/messages/reaction` `{platform, emoji, targetMessageId, targetProviderMessageId?}` |
| `sendMetaSocialCommentReply(payload)` | `POST /api/whatsapp-api/meta/social/comments/reply` `{contactId, platform, message, replyType:'public'|'private', commentId?, postId?, externalId}` | Responder comentarios FB/IG |

**Mensajes programados**
| `scheduleText(...)` | `POST /api/whatsapp-api/messages/scheduled` `{id?, contactId, provider:'whatsapp_api'|'highlevel', channel:'sms_qr'?, transport?, messageType:'text'|'template', text, templateId?, templateName?, templateLanguage?, toPhone?, fromPhone?, businessPhoneNumberId?, scheduledAt(UTC ISO), externalId}` | Programar (WhatsApp→`provider:'whatsapp_api'`+`transport:'api'`; SMS→`provider:'highlevel'`+`channel:'sms_qr'`; Messenger/IG/email NO se pueden programar — error local con copy en español, `api.ts:226-242`) |
| `getScheduledMessages(cid)` | `GET /api/whatsapp-api/messages/scheduled?contactId` | Pendientes del chat |
| `cancelScheduledMessage(mid, cid)` | `DELETE /api/whatsapp-api/messages/scheduled/:mid` con **body** `{contactId}` | Cancelar (¡DELETE con body!) |

**Plantillas WhatsApp**
| `getMessageTemplateBundle()` | `GET /api/settings/message-templates` | Bundle de plantillas |
| `getWhatsAppTemplates(status?)` | `GET /api/whatsapp-api/templates?status` | Plantillas por estado |
| `sendWhatsAppTemplate(contact, tpl)` | `POST /api/whatsapp-api/templates/send` `{to,from?,contactId,templateId?,templateName?,language(def 'es_MX'),externalId,phoneNumberId?}` | Enviar plantilla |

**WhatsApp estado/números**
| `getWhatsAppApiStatus()` / `getWhatsAppStatus()` | `GET /api/whatsapp-api/status` | Números conectados, default, QR/API |
| `refreshWhatsAppStatus()` | `POST /api/whatsapp-api/refresh` | Refrescar estado |
| `setDefaultWhatsAppPhoneNumber(id)` | `POST /api/whatsapp-api/phone-numbers/default` `{phoneNumberId}` | Número default |

**Pagos**
| `getProducts(limit=100)` | `GET /api/products?limit&includePrices=true` → `{products?,total?}` | Catálogo |
| `createProduct/updateProduct/deleteProduct` | `POST/PUT/DELETE /api/products[/:id]` | CRUD productos |
| `getTransactions(query)` | `GET /api/transactions?limit&page&startDate&endDate&q&sync` | Pagos por rango |
| `createTransaction(payload)` | `POST /api/transactions` | Pago manual (estado siempre `paid` para pago recibido) |
| `getPaymentSettings()` | `GET /api/settings/payments` | Config de pasarelas |
| `createInstallmentFlow(payload)` | `POST /api/transactions/payment-flows/installments` | Parcialidades (HighLevel/local) |
| `getStripeSavedPaymentMethods(cid)` | `GET /api/stripe/contacts/:cid/payment-methods` | Tarjetas guardadas Stripe |
| `getConektaSavedPaymentSources(cid)` | `GET /api/conekta/contacts/:cid/payment-sources` | Tarjetas Conekta |
| `getRebillSavedPaymentSources(cid)` | `GET /api/rebill/contacts/:cid/payment-sources` | Tarjetas Rebill |
| `createSubscription(payload)` | `POST /api/subscriptions` | Suscripción (`paymentMethod`: `stripe_link`/`conekta_link` por autorización; `stripe_saved_card`/`conekta_subscription`/`rebill_subscription` con tarjeta) |
| `createHighLevelInvoice` / `sendHighLevelInvoice(id, 'email'|'sms'|'both')` / `recordHighLevelInvoicePayment` / `syncHighLevelInvoice` | `POST /api/highlevel/invoices[…]` | Invoices HL |
| `createPaymentLink(provider, payload)` | `POST /api/{stripe|conekta|mercadopago|clip|rebill}/payment-links` | Link de cobro |
| `chargeSavedCard(provider, payload)` | `POST /api/{stripe|conekta|rebill}/saved-card-payments` | Cobro directo tarjeta guardada |
| `createPaymentPlan(provider, payload)` | `POST /api/{stripe|conekta|mercadopago|rebill}/payment-plans`; `highlevel`→installments; `clip`→payment-links | Plan de pagos |
| `getBankClabes()` / `saveBankClabes(accts)` | `GET/POST /api/config` key `payment_bank_clabes` | CLABEs para transferencia |

**Dashboard/Analíticas**
| `getDashboardMetrics(start, end)` | `GET /api/dashboard/metrics?startDate&endDate` | KPIs |
| `getFinancialOverview(start, end, scope)` | `GET /api/dashboard/financial-overview?…&scope` | Serie financiera |
| `getDashboardSeries(kind, start, end, groupBy)` | `GET /api/dashboard/{visitors|leads|appointments|attendances|sales}?…&groupBy=day|month` | Series |
| `getFunnelData(start, end, scope)` | `GET /api/dashboard/funnel` | Embudo |
| `getOriginDistribution(start, end)` | `GET /api/dashboard/origin-distribution` | Origen por fuente |
| `getCustomLabels()` | `GET /api/settings/contact-labels` | Labels custom (nombres de etapas) |

**Calendarios/Citas**
| `getCalendars()` | `GET /api/calendars` → `CalendarItem[] | {calendars}` | Lista |
| `getCalendarEvents(startMs, endMs, calId?)` | `GET /api/calendars/events?startTime&endTime&calendarId` (epoch ms) | Eventos |
| `getAppointment(eventId)` | `GET /api/calendars/events/:id` | Detalle |
| `getBlockedSlots(calId, startMs, endMs)` | `GET /api/calendars/:calId/blocked-slots?startTime&endTime` | Bloqueos (ISO startTime/endTime/reason) |
| `getFreeSlots(calId, startDate, endDate, tz?)` | `GET /api/calendars/:calId/free-slots?startDate&endDate&timezone` | Slots libres |
| `getCalendarUsers()` | `GET /api/highlevel/users` → `{users}` | Usuarios/equipo |
| `getCalendarUsersByIds(ids)` | `POST /api/highlevel/users/by-ids` `{userIds:[…]}` (**POST**, no GET) | Nombres por id |
| `createAppointment(data)` | `POST /api/calendars/appointments` | Crear cita |
| `updateAppointment(id, data)` | `PUT /api/calendars/appointments/:id` | Editar |
| `deleteCalendarEvent(id)` | `DELETE /api/calendars/events/:id` | Eliminar |

**Config/Ajustes/Estado**
| `getConfig(keys)` | `GET /api/config?keys=a,b` → `{success, config:{k:v}}` (claves sensibles llegan `null`) | Config de cuenta (`account_currency`, prefs `mobile_chat_*`) |
| `setConfig(key, value)` | `POST /api/config` `{key,value}` o `{config:{…}}` (requiere `settings_account:write`) | Guardar config |
| `getUserConfig(keys)` / `setUserConfig(key, value)` | `GET/POST /api/user-config` | Preferencias POR usuario (notificaciones, `mobile_chat_appointment_entry_mode`) — sólo requireAuth |
| `getTimezone()` | `GET /api/settings/timezone` | Zona de la cuenta |
| `getIntegrationsStatus()` | `GET /api/integrations/status` | Integraciones conectadas |
| `getLicenseStatus()` | `GET /api/license/status` | Plan/features |

**Asistente AI**
| `getAIAgentConfig()` / `saveAIAgentConfig({apiKey?,model?})` | `GET/POST /api/ai-agent/config` | Config del asistente |
| `saveAIAgentBusinessContext(answer)` | `POST /api/ai-agent/business-context-answer` `{field:'businessContext',answer}` | Contexto de negocio |
| `sendAIAgentMessage(messages, viewContext, category='auto')` | `POST /api/ai-agent/chat` | Chat del asistente personal |
| `transcribeAIAgentAudio(uri, mime='audio/m4a')` | `POST /api/ai-agent/transcribe` — **upload binario** con `Content-Type: <mime>` + Bearer (NO JSON; en RN `FileSystem.uploadAsync` BINARY_CONTENT, `api.ts:1136-1174`) | Transcribir nota de voz |

**Push**
| `getPushPublicConfig()` | `GET /api/push/public-key` (público) | Config web push |
| `saveMobilePushDevice(payload)` | `POST /api/push/mobile-devices` `{token, platform:'ios'|'android', calendarIds?, appVersion?, appBuild?, deviceModel?, osVersion?}` → `{id?, enabled?, calendarIds?}` | Registrar token nativo (APNs) |
| — | `DELETE /api/push/mobile-devices` | Desactivar dispositivo |

### 13.3 Tipos de error del cliente

`ApiError = Error & { status?: number; body?: unknown; code?: string }` — replicar en Swift como error tipado con `status`, `code` y `body` decodificable.

---

## 14. Push — convenciones de payload (resumen de `docs/MOBILE_APP.md`)

- Registro: `POST /api/push/mobile-devices` (ver arriba). En managed, el envío APNs lo hace el portal central (broker); estado en `GET /api/license/mobile-push/status` (`iosConfigured`). Standalone: `APNS_KEY_ID/TEAM_ID/BUNDLE_ID/PRIVATE_KEY/ENV` en el server.
- Payload APNs incluye `mutable-content` cuando hay `contactAvatarUrl`/`senderAvatarUrl` o media. Campos data: `title`, `body`, `contactAvatarUrl`, `senderAvatarUrl`, `notificationImageUrl`, `notificationAttachmentUrl`, `threadId`, `messageId`, `url`, `contactId`.
- Reglas: avatar del contacto (foto o PNG de iniciales generado en `GET /api/push/contact-avatar/:contactId` con firma en query) va en `contactAvatarUrl`/`senderAvatarUrl`, NUNCA en `notificationImageUrl` (reservado a media real del mensaje). Copys: `📷 Envió una foto.`, `🎤 Mensaje de voz (0:02)`, `📄 <archivo.ext>`, `📍 Ubicación`.
- iOS usa Communication Notifications (`INSendMessageIntent`) con extension `RistakNotificationService`; entitlement `com.apple.developer.usernotifications.communication`. Tocar la push abre el chat por `contactId` o `url`.

---

## 15. API externa (contexto, no la usa la app)

`/api/external` + `/api/mcp` aceptan **API tokens** opacos (`ristak_live_…`) por `Authorization: Bearer` o `x-api-key` (`apiTokenMiddleware.js`). Un token por usuario, rotación invalida el anterior; OpenAPI en `/api/external/openapi.json`. La app nativa iOS usa exclusivamente el JWT de sesión; el `appId`/`apiTokenMetadata` del login sólo alimentan la pantalla de Acceso API.

---

## 16. Resumen del contrato `docs/MOBILE_APP.md` (secciones normativas para la app nativa)

1. **Paridad obligatoria**: cualquier cambio de producto móvil se revisa en `/movil` y `mobile/`; el resultado visible debe ser idéntico (secciones, orden, nombres, flujos, permisos, estados). Brechas → `docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`.
2. **Analíticas**: consumir exactamente `/api/dashboard/metrics`, `financial-overview`, `visitors|leads|appointments|attendances|sales`, `funnel`, `origin-distribution`, `/api/whatsapp-api/status`, `/api/settings/contact-labels`. Rangos `30d/60d/180d/year/custom` calculados con `account_timezone`; importes con `account_currency`; custom con `YYYY-MM-DD` aplicado a todo.
3. **Bandeja**: `/contacts/chats` con `limit/offset` (lotes de 50, merge por `contact.id`); filtro por número manda `businessPhoneNumberId`/`businessPhone` al server (no filtrar localmente); preferencias en `app_config` (`mobile_chat_ai_agent_enabled`, `mobile_chat_show_archived`, `mobile_chat_sort_mode`, `mobile_chat_show_last_preview`, `mobile_chat_show_unread_indicators`, `mobile_chat_selected_whatsapp_phone_id`, `mobile_chat_filter_chip_ids`, `mobile_chat_custom_filter_presets`).
4. **Conversación**: journey con `chatMessagesOnly`+`messageLimit`; envío por los endpoints de §13.2; respuestas con `replyToMessageId`/`replyToProviderMessageId`; reacciones Meta sólo corazón; leído vía `/contacts/chats/:id/read` (acuse externo apagable con `chat_send_read_receipts_enabled`).
5. **Programados**: `scheduledAt` UTC derivado de la zona del negocio, validado futuro; WhatsApp→`whatsapp_api/api`, SMS→`highlevel/sms_qr`; Messenger/IG/email no programables.
6. **Pagos**: moneda de `account_currency` (sin ella NO crear registros); capacidades según `/api/license/status` + `/api/integrations/status` (plan `basic` o sin pasarela ⇒ sólo pago único offline); links de checkout devueltos (`subscriptionStartUrl`, `stripeCheckoutUrl`, `conektaCheckoutUrl`, `mercadoPagoInitPoint`, `mercadoPagoSandboxInitPoint`, `rebillPaymentLinkUrl`, `rebillCheckoutUrl`) se llevan al chat como preview y el usuario los envía manualmente — nunca auto-enviar cobros.
7. **Citas**: crear contra `/api/calendars/appointments` en UTC (zona de la cuenta); preferencia `user_config.mobile_chat_appointment_entry_mode` = `form|calendar`.
8. **Avisos**: acciones exitosas se confirman con cambio visible en pantalla, nunca `Alert`/toast; alertas sólo para errores, permisos del sistema, validaciones bloqueantes y confirmaciones destructivas.

---

## 17. Gaps / riesgos para iOS nativo

1. **Sin refresh token**: JWT de 30 días; al expirar cualquier request da 401 sin `code` específico. La app debe interceptar 401 global → limpiar Keychain → login. Distinguir `code:'token_revoked'` para el copy.
2. **SSE requiere header Authorization**: `EventSource` puro no sirve; usar URLSession bytes/stream. La app RN de referencia ni siquiera usa SSE (polling 20 s/7 s) — decidir estrategia y validar reconexión/backoff (el server no manda `retry:`).
3. **Media por JSON base64 (data URLs)** con límite 35 MB: videos/documentos grandes pueden fallar sin mensaje claro; no hay endpoint multipart para el chat móvil (sólo `/api/ai-agent/transcribe` acepta binario crudo).
4. **Envelope inconsistente**: mezcla de `{success,data}`, `{success,<clave-propia>}` y arrays pelones; el decoder Swift debe implementar la regla de desenvolvido §7.1 y tolerar ambas formas por endpoint (p.ej. `getCalendars`, `getTransactions`, `getProducts`).
5. **Errores heterogéneos**: `error` vs `message` según endpoint; mapear como §7.2.
6. **`DELETE` con body** (`/api/whatsapp-api/messages/scheduled/:id` con `{contactId}`): URLSession lo permite pero hay que setear el body explícitamente.
7. **503 de arranque/deploy**: cualquier request puede recibir 503 JSON durante deploys de Render (~minutos); tratar como transitorio con retry, no como sesión inválida.
8. **`/api/mobile/resolve` vive en el portal central** (`www.ristak.com`), fuera de este repo: el shape exacto se infiere del cliente (`api.ts:179-189`). **OPEN QUESTION:** códigos de error específicos del installer (sólo se conoce `message`).
9. **Paginación de chats sin `total`**: fin de lista = lote `< limit`. No asumir `total`.
10. **`getChats` con `warmProfilePictures`**: costoso en server (hidrata avatares de WhatsApp); usarlo como lo hace RN (sólo cuando conviene) para no degradar la bandeja.
11. **Rate limit en login** (10 fallos/15 min por IP+email): manejar 429 con su `message` y no reintentar automático.
12. **Timezone/moneda**: nunca `TimeZone.current` ni `Locale.current.currency` para datos de negocio; cargar `GET /api/settings/timezone` y `account_currency` al abrir sesión y cachear con invalidación al cambiar de tenant.
13. **`feature_not_available` en GET** debe ser silencioso (paridad con web/RN); sólo alertar en acciones del usuario.
14. **Verify optimista**: replicar el patrón RN (entrar al shell con token guardado y verificar con timeout 8 s; sólo 401/403 expulsan) para no bloquear el arranque offline.
15. **OPEN QUESTION:** catálogo completo de eventos SSE (`chat-events`) y el stream de `/api/payment-events` — revisar `chatLiveEventsService.js`/`paymentEvents.routes.js` completos antes de implementar tiempo real.
16. **OPEN QUESTION:** contrato exacto de `apiTokenMetadata` y `appId` en la respuesta de login (`utils/apiTokens.js`) — sólo necesario si la app nativa expone la pantalla de Acceso API.

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **RESUELTO — OPEN QUESTION §12.1/§17.15 (catálogo SSE):** verificado en
   `backend/src/services/chatLiveEventsService.js` y `paymentLiveEventsService.js`.
   El stream de chat emite **solo** `connected` y `chat_message`; el de pagos emite
   `connected`, `payment_changed` y `subscription_changed`. No hay más publishers.
   Payloads completos en doc 11 §2-§4.
2. **RESUELTO — OPEN QUESTION §17.16 (`apiTokenMetadata`):** verificado en
   `backend/src/utils/apiTokens.js` (`buildMetadata`): `{ hasToken:bool, prefix, lastFour,
   preview ("<prefix>...<lastFour>"), createdAt, lastUsedAt, revokedAt }` — todos `null`
   (y `hasToken:false`) sin token activo. Coincide con doc 02 §3.1.
3. **RESUELTO — OPEN QUESTION §17.8 (`/api/mobile/resolve`):** leído el repo local
   `Ristak - Installer` (`backend/src/routes/mobile.routes.js`,
   `backend/src/services/mobileTenant.service.js`):
   - Errores con **HTTP status real** (no 200): `404 {success:false, code, message}` para
     `identifier_required` ("Escribe el correo o código de tu empresa."),
     `tenant_not_found` ("No encontré una app activa para esos datos.") e
     `installation_not_ready`; **403** para `client_inactive` ("Esta cuenta no está activa.");
     **429** `code:'rate_limited'` con header `Retry-After` (límite **40 req / 15 min por IP**).
   - `identifier` acepta: email del dueño, email de empleado (directorio
     `installation_user_access`), `invite_code`, `client_id` **y nombre de empresa/slug**
     (matching laxo contra client_name/app_name/hostname).
   - El tenant de éxito incluye un campo extra `status` (estado de la instalación) no
     documentado arriba; `app_url` prefiere `app_origin_url` (URL de Render) sobre el
     dominio custom.
4. **CORRECCIÓN — §13.1 punto 4:** "el backend no ofrece idempotency-keys" es impreciso.
   Es cierto para envíos de chat (solo `externalId`), pero `POST /api/transactions` SÍ
   soporta los headers `Idempotency-Key`/`X-Idempotency-Key`
   (`transactionsController.js:99-112`, PAY-007; ver doc 08 §2.2).
5. **MATIZ — §17.10 (`warmProfilePictures`):** doc 03 (verificado contra
   `PhoneChat.tsx`/RN) confirma que ambos clientes lo mandan `'true'` SIEMPRE en la
   bandeja; la recomendación de "usarlo solo cuando conviene" debe leerse como "no
   usarlo fuera de la bandeja", no como omitirlo en la bandeja.
