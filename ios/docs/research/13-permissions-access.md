# 13 — Permisos, roles, acceso y licencia (spec para la app nativa iOS)

> Fuente de verdad investigada el 2026-07-07 sobre el repo `Ristak` (rama `main`).
> Este documento es autosuficiente: los agentes Swift NO deben re-leer las fuentes TS/JS.
> Todo copy visible al usuario está en español, exactamente como lo muestra el producto.

Archivos fuente principales:

- Backend: `backend/src/utils/userAccess.js`, `backend/src/middleware/userAccessMiddleware.js`,
  `backend/src/middleware/authMiddleware.js`, `backend/src/middleware/licenseMiddleware.js`,
  `backend/src/services/licenseService.js`, `backend/src/controllers/userAccessController.js`,
  `backend/src/controllers/authController.js`, `backend/src/routes/auth.routes.js`,
  `backend/src/routes/license.routes.js`, `backend/src/routes/apiAccess.routes.js`,
  `backend/src/utils/apiTokens.js`, `backend/src/server.js` (mounts, líneas 287–349).
- Web escritorio: `frontend/src/utils/accessControl.ts`, `frontend/src/contexts/AuthContext.tsx`,
  `frontend/src/services/authFetch.ts`, `frontend/src/pages/Login/LicenseBlocked.tsx`,
  `frontend/src/pages/Settings/UserAccessSettings.tsx`, `frontend/src/App.tsx`.
- App RN nativa (referencia de paridad): `mobile/src/access.ts` (completo), `mobile/src/types.ts`
  (líneas 1–45, 321), `mobile/src/api.ts` (líneas 266–342, 916–917, 1239–1264),
  `mobile/src/App.tsx` (líneas 1149–1272, 1291–1300, 3953–3966, 12783–12855).
- Docs: `docs/LICENSING.md`, `docs/EXTERNAL_API_ACCESS.md`, `docs/MOBILE_APP.md`.

---

## 1. Modelo de permisos en 3 capas

Toda decisión de acceso combina **tres capas independientes**. Las tres se evalúan en backend
en cada request; el cliente las replica solo para decidir **visibilidad** de UI.

1. **Rol del usuario** (`role`): solo existen dos valores efectivos: `'admin'` y `'employee'`.
   Cualquier otro string se normaliza a `'employee'` (`normalizeUserRole`,
   `backend/src/utils/userAccess.js:36-38`). `admin` tiene TODO en `'write'` siempre,
   ignora `accessConfig` guardado.
2. **Permisos por módulo** (`accessConfig`): mapa `{ moduleKey: 'none' | 'read' | 'write' }`
   con 25 claves de módulo (lista completa en §2.2). Solo aplica a `employee`.
   Se guarda en la columna `users.access_config` (JSON string) y el backend lo devuelve
   **ya normalizado** (todas las claves presentes) en el objeto de usuario.
3. **Licencia central** (feature flags de plan): si la instalación está conectada al portal
   central (`LICENSE_SERVER_URL` + `CLIENT_ID` + `LICENSE_KEY` configurados ⇒
   `licenseEnforced=true`), cada módulo/feature del plan puede estar apagado. Sin portal
   (instalación standalone / dev local) NO hay enforcement y todas las features están activas.

Regla del cliente (idéntica en escritorio, /movil y RN nativa):

```
accesoVisible(moduleKey, nivelRequerido) =
    licenciaPermite(moduleKey)                      // capa 3, solo si licenseEnforced
    && ( role == 'admin'                            // capa 1
         || nivel(accessConfig[moduleKey]) >= nivelRequerido )  // capa 2
```

El backend siempre re-valida; ocultar botones nunca es suficiente ni requisito.

---

## 2. Modelos de datos

### 2.1 Objeto de usuario autenticado (`serializeAuthUser`)

Devuelto por `POST /api/auth/login`, `POST /api/auth/verify`, `GET /api/auth/me`,
`PATCH /api/auth/profile` (campo `user`). Fuente: `backend/src/controllers/authController.js:47-75`.

| Campo | Tipo | Nulabilidad | Notas |
| --- | --- | --- | --- |
| `id` | number | no nulo | Id crudo de SQLite (entero). ⚠️ En `/api/auth/users` el `id` viene como **string** (ver §2.4). En Swift: decodificar tolerante (Int o String). |
| `username` | string | no nulo | Identificador interno; hoy suele ser el email o teléfono. |
| `email` | string | `''` si no hay | Siempre string (nunca null). |
| `firstName` | string | `''` si no hay | Máx 160 chars. |
| `lastName` | string | `''` si no hay | |
| `fullName` | string | no nulo | `firstName + lastName` o fallback a `full_name`/`username`. |
| `phone` | string | `''` si no hay | Máx 40 chars. |
| `businessName` | string | `''` si no hay | |
| `role` | string | no nulo | `'admin'` o `'employee'` (valor crudo de DB; normalizar defensivamente: ≠`'admin'` ⇒ employee). |
| `accessConfig` | object | no nulo | `Record<moduleKey, 'none'|'read'|'write'>`. **Ya normalizado por backend**: admin ⇒ las 25 claves en `'write'`; employee ⇒ las 25 claves presentes con defaults + reglas de §3.1. |
| `licenseEnforced` | boolean | no nulo | `true` solo si la instalación está gestionada por portal Y la licencia se evaluó. |
| `licensePlan` | string \| null | nullable | Ej. `'basic'`, `'pro'`. `null` en standalone. |
| `licenseFeatures` | object | `{}` si no hay | `Record<string, boolean>` (mapa de features del plan, ya normalizado con dependencias, ver §5.3). `{}` cuando `licenseEnforced=false`. |
| `licenseLimits` | object | `{}` si no hay | Hoy solo `{ conversational_agents: { max_agents: number|null } }`. |
| `licenseExternalModules` | object | `{}` si no hay | `Record<key, { key, label, menuLabel, enabled: boolean, sidebarPosition: number|null }>` — módulos externos tipo `mdp_program` (solo escritorio). |

⚠️ Importante: `licenseFeatures`/`licensePlan` vienen del **cache de licencia en el momento del
login/verify**. En `GET /api/auth/me` vienen de `req.license` (poblado por `requireAuth` solo si
`licenseEnforced`); en standalone `getMe` devuelve `licenseEnforced:false` y `licenseFeatures:{}`.

### 2.2 Claves de módulo (`ACCESS_MODULES`, 25 claves)

Fuente backend: `backend/src/utils/userAccess.js:5-31`. Fuente frontend (con labels UI):
`frontend/src/utils/accessControl.ts:10-186`.

| Grupo (UI) | `moduleKey` | Label UI escritorio | Ruta escritorio |
| --- | --- | --- | --- |
| CRM | `dashboard` | Dashboard | `/dashboard` |
| CRM | `appointments` | Citas | `/appointments` |
| CRM | `payments` | Pagos | `/transactions` |
| CRM | `contacts` | Contactos | `/contacts` |
| CRM | `chat` | Chat | `/chat` |
| Operación | `reports` | Reportes | `/reports/table/month/cashflow` |
| Operación | `analytics` | Analíticas | `/analytics` |
| Operación | `campaigns` | Publicidad / Meta | `/campaigns/classic` |
| Operación | `automations` | Automatizaciones | `/automations` |
| Operación | `sites` | Sitios | `/sites` |
| Operación | `ai_agent` | Ristak AI | `/ai-agent/general` |
| Configuración | `settings_account` | Cuenta | `/settings/account` |
| Configuración | `settings_mobile` | Aplicación móvil | `/settings/mobile-app` |
| Configuración | `settings_calendars` | Configuración de calendarios | `/settings/calendars` |
| Configuración | `settings_payments` | Configuración de pagos | `/settings/payments` |
| Configuración | `settings_integrations` | Integraciones | `/settings/highlevel` |
| Configuración | `settings_whatsapp` | WhatsApp | `/settings/whatsapp` |
| Configuración | `settings_email` | Correos | `/settings/email` |
| Configuración | `settings_tracking` | Rastreo Web | `/settings/tracking` |
| Configuración | `settings_domains` | Dominios | `/settings/domains` |
| Configuración | `settings_costs` | Costos | `/settings/costs` |
| Configuración | `settings_media` | Media | `/settings/media` |
| Configuración | `settings_custom_fields` | Campos y etiquetas | `/settings/custom-fields` |
| Configuración | `settings_api_access` | Developers | `/settings/developers` |
| Configuración | `settings_users` | Usuarios | `/settings/users-access` |

Niveles (`ACCESS_LEVELS`): `'none'` < `'read'` < `'write'`. Labels UI:
`'Sin acceso'`, `'Solo ver'`, `'Ver y editar'` (`UserAccessSettings.tsx:57-59`).

### 2.3 Módulos relevantes para el teléfono (subset nativo)

`mobile/src/access.ts:9-17` reduce a 8 claves alcanzables desde el shell móvil:
`chat`, `appointments`, `payments`, `analytics`, `contacts`, `ai_agent`,
`settings_mobile`, `dashboard`.

Mapeo sección del dock → módulo (`PHONE_SECTION_MODULE`, `mobile/src/access.ts:33-39`;
idéntico al gating de rutas /movil en `frontend/src/App.tsx:800-905`):

| Sección (`PhoneSection`) | Label dock | Módulo gate |
| --- | --- | --- |
| `settings` | Ajustes | `settings_mobile` |
| `chat` | Chats | `chat` |
| `calendar` | Citas | `appointments` |
| `payments` | Pagos | `payments` |
| `analytics` | Analíticas | `analytics` |

Además, el chat del agente IA en /movil (`/movil/agent-chat`, `/movil/agent-ai`,
`/movil/ai-agent`) está gateado por el módulo `ai_agent` (`frontend/src/App.tsx:818-847`).
En la app RN nativa, el botón de agente IA además depende del toggle de configuración
`mobile_chat_ai_agent_enabled` (config de app móvil, no permiso).

### 2.4 Miembro del equipo (`serializeMember`) — gestión de usuarios (solo admin)

Devuelto por `GET/POST/PATCH /api/auth/users`. Fuente:
`backend/src/controllers/userAccessController.js:112-135` y
`frontend/src/services/userAccessService.ts:4-18`.

| Campo | Tipo | Notas |
| --- | --- | --- |
| `id` | **string** | `String(row.id)` — distinto del auth user (number). |
| `username` | string | |
| `email` | string | `''` si no hay. |
| `phone` | string | `''` si no hay (formato normalizado de almacenamiento). |
| `firstName` / `lastName` | string | |
| `fullName` | string | |
| `role` | `'admin'|'employee'` | Normalizado. |
| `isActive` | boolean | `false` = acceso eliminado (borrado suave). |
| `lastLogin` | string \| null | Timestamp SQLite `YYYY-MM-DD HH:MM:SS` (UTC) o null. |
| `createdAt` / `updatedAt` | string \| null | |
| `accessConfig` | object | Normalizado (25 claves, mismas reglas de §3.1). |

### 2.5 Estado de licencia (`GET /api/license/status`)

Fuente: `backend/src/routes/license.routes.js:18-34` y tipo RN
`mobile/src/types.ts:38-45` (`LicenseStatusResponse`).

```json
{
  "success": true,
  "enforced": false,
  "allowed": true,
  "plan": null,
  "features": { "chat": true, "payments": true, "payment_plans": true, "...": true },
  "limits": { "conversational_agents": { "max_agents": null } },
  "expires_at": null
}
```

| Campo | Tipo | Notas |
| --- | --- | --- |
| `success` | boolean | |
| `enforced` | boolean | `false` ⇒ standalone: TODO permitido. |
| `allowed` | boolean | Si el usuario llegó aquí, `requireAuth` ya validó que es `true`. |
| `plan` | string \| null | |
| `features` | object | Mapa normalizado de features (ver §5.3). |
| `limits` | object | `{ conversational_agents: { max_agents: number|null } }`. |
| `expires_at` | string \| null | Expiración del license_token temporal (ISO), definida por el portal. |

### 2.6 Metadatos del API token externo

Fuente: `backend/src/utils/apiTokens.js:48-61`. Shape de `apiToken` / `apiTokenMetadata`:

```json
{
  "hasToken": true,
  "prefix": "ristak_live_",
  "lastFour": "aB3x",
  "preview": "ristak_live_...aB3x",
  "createdAt": "2026-01-01 12:00:00",
  "lastUsedAt": null,
  "revokedAt": null
}
```

Todos los campos son `null` (y `hasToken:false`) cuando no hay token activo.
El token plano (`ristak_live_` + 32 bytes base64url) **solo se muestra una vez** al rotar.

---

## 3. Reglas de negocio del backend

### 3.1 Normalización de `accessConfig` (`normalizeAccessConfig`, `userAccess.js:52-81`)

Al guardar y al servir, el backend produce SIEMPRE un objeto con las 25 claves:

1. `settings_account` ⇒ **siempre** `'write'` (cualquier usuario puede editar su propia cuenta).
2. `settings_users` ⇒ `'write'` si `role='admin'`, si no `'none'`. Un employee JAMÁS puede
   tener acceso a Usuarios (aunque el JSON guardado diga otra cosa; `hasUserAccess` además
   lo corta en `userAccess.js:99`).
3. **Compatibilidad Chat↔Contactos**: si la config guardada NO trae la clave `chat`,
   `chat` hereda el nivel de `contacts` (`userAccess.js:70-74`). El cliente nativo replica
   esto por seguridad (`mobile/src/access.ts:71-73`) aunque el backend ya lo resuelva.
4. Cualquier valor que no sea `none/read/write` ⇒ `'none'`. Claves desconocidas se ignoran.
5. `getEffectiveAccessConfig` (`userAccess.js:83-91`): admin ⇒ todas las claves `'write'`.

### 3.2 Chequeo por request (`requireModuleAccess`, `userAccessMiddleware.js:15-32`)

- Nivel requerido derivado del método HTTP: `GET`/`HEAD` ⇒ `'read'`; cualquier otro ⇒ `'write'`.
- Falla con **403**:
  - lectura: `{ "success": false, "code": "read_access_required", "module": "<moduleKey>", "error": "No tienes acceso a esta sección." }`
  - escritura: `{ "success": false, "code": "write_access_required", "module": "<moduleKey>", "error": "No tienes permiso para cambiar información en esta sección." }`
- `requireAdmin` (`userAccessMiddleware.js:3-13`) falla con 403:
  `{ "success": false, "code": "admin_required", "error": "Solo un administrador puede hacerlo." }`
  (texto exacto: `"Solo un administrador puede hacer esto."`).

### 3.3 Mapa de gates por endpoint (qué módulo protege qué API)

Recolectado de `backend/src/routes/*.js` y `backend/src/server.js:287-349`. La app iOS debe
esperar 403 con los codes de §3.2 al pegarle a estos recursos sin permiso:

| Recurso API | Gate de módulo (accessConfig) | Gate de licencia (requireFeature) |
| --- | --- | --- |
| `/api/dashboard/*` | `dashboard` (router.use) | `dashboard` |
| `/api/contacts/*` | `contacts` (router.use, contacts.routes.js:48) | `contacts` |
| `/api/contacts/chats`, `/api/contacts/chats/read`, `/api/contacts/chats/:id/read`, `/api/contacts/:id/linked-social` | `chat` (override por ruta, contacts.routes.js:55-89) | `contacts` |
| `/api/contact-tags/*` | `contacts` | `contacts` |
| `/api/chat-events/stream`, `/api/chat-events/viewing` | `chat` | — |
| `/api/calendars/*` | `appointments` (calendars.routes.js:20) | `google_calendar` (mount) |
| `/api/appointment-reminders/*` | `appointments` | — |
| `/api/transactions/*` | `payments` | `payments` (mount) + `payment_plans` por ruta |
| `/api/products/*` | `payments` (products.routes.js:19) | — |
| `/api/subscriptions/*` | `payments` + feature `subscriptions` (router.use ambos) | `subscriptions` |
| `/api/payment-events/stream` | `payments` | `payments` |
| `/api/stripe|conekta|mercadopago|clip|rebill/config*` | `settings_payments` | `payment_plans`/`subscriptions` en rutas de planes |
| `/api/stripe|conekta|mercadopago|clip|rebill/payment-links`, `payment-plans`, `saved-card-payments`, `contacts/:id/payment-*` | `payments` | `payment_plans` en payment-plans |
| `/api/attribution/*` | `analytics` | `analytics` (mount) |
| `/api/tracking/*` (privado) | `analytics` (tracking.routes.js:53) | — |
| `/api/reports/*` | `reports` | `advanced_reports` (mount) |
| `/api/meta/*` | `campaigns` (meta.routes.js:51) | `meta_ads` (mount) |
| `/api/automations/*` | `automations` | `automations` (mount) |
| `/api/sites/*` (privado) | `sites` | — |
| `/api/ai-agent/*` | `ai_agent` (aiAgent.routes.js:39) | `app_assistant_ai` (mount) |
| `/api/conversational-agent/*` | `ai_agent` | `conversational_ai` (mount) |
| `/api/whatsapp-api/*` | por ruta; backfill fotos ⇒ `settings_whatsapp` | `whatsapp` (mount) |
| `/api/email/*` | (rutas internas) | `email` (mount) |
| `/api/integrations/*` | — (solo auth) | `integrations` (mount) |
| `/api/settings/*` | por ruta: `settings_account`, `settings_custom_fields`, `settings_whatsapp`, `settings_payments` | — |
| `/api/costs/*` | `settings_costs` | — |
| `/api/media/*` | `settings_media` | feature `settings_media` |
| `/api/api-access/*` | `settings_api_access` (router.use) | — |
| `/api/auth/users*` | `requireAdmin` | — |
| `/api/user-config` (self GET/POST) | solo auth (a propósito sin gate de módulo) | — |
| `/api/user-config/admin*` | `requireAdmin` | — |
| `/api/config` GET | solo auth | — |
| `/api/config` escrituras | `settings_account` (config.routes.js:13) | — |
| `/api/push/subscriptions`, `/api/push/mobile-devices` | solo auth (sin gate de módulo) | — |
| `/api/hidden-contacts` POST/DELETE | `requireAdmin` | — |
| `/api/highlevel/*` (config/sync) | `requireAdmin` | — |
| `/api/license/status` | solo auth | — |
| `/api/license/account-cancellation/*` | `requireAdmin` + `settings_account` | — |
| `/api/mdp-program/*` | — | `mdp_program` (mount) |

Nota (LIC-002): en los mounts `requireAuth` va ANTES de `requireFeature`. `requireFeature` es
fail-open cuando la licencia no está enforced (standalone).

### 3.4 Invariantes de gestión de usuarios (`userAccessController.js`)

Aplican a `POST/PATCH/DELETE /api/auth/users`:

- Debe existir correo O teléfono (`"Agrega un correo o un teléfono para crear el acceso."`, 400).
- Teléfono inválido ⇒ 400 `"Ese teléfono no se ve válido. Usa lada y número."`
  (se normaliza con `normalizePhoneForStorage`).
- Alta requiere contraseña ≥ 6 chars ⇒ 400 `"Agrega una contraseña temporal de al menos 6 caracteres."`;
  en edición la contraseña es opcional pero si viene debe ser ≥ 6 ⇒ `"La contraseña debe tener al menos 6 caracteres."`
- Unicidad de email/teléfono/username ⇒ 400 `"Ya existe una persona con ese correo o teléfono."`
- Un admin no puede quitarse su propio rol ⇒ 400 `"No puedes quitarte el rol de administrador a ti mismo."`
- Siempre debe quedar ≥ 1 admin activo (en degradar rol o borrar) ⇒ 400
  `"Debe quedar al menos un administrador activo."`
- Nadie puede borrarse a sí mismo ⇒ 400 `"No puedes borrar tu propio acceso desde aquí."`
- Borrar = **soft delete** (`is_active = 0`); el usuario deja de poder loguear
  (login responde 401 `"Usuario inactivo. Contacta al administrador"`).
- Usuario inexistente ⇒ 404 `{ success:false, error:"Usuario no encontrado" }`.
- Tras crear/editar/borrar se dispara `requestPortalUserRefresh()` (aviso al portal central con
  hasta 3 reintentos, para que el login móvil por correo enrute al usuario nuevo; no bloquea la respuesta).
- Errores 5xx devuelven `{ success:false, error:"Error en el servidor" }`.

---

## 4. Endpoints del módulo

Convención de error: los endpoints de auth usan campo `message`; los de user-access y
middlewares usan campo `error`. El cliente debe leer `message || error`.

### 4.1 Sesión y usuario propio

| Método | Path | Auth | Body / params | Respuesta OK |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/verify` | ninguna (token en body) | `{ "token": "<jwt>" }` | `{ "success": true, "user": <AuthUser §2.1> }` |
| GET | `/api/auth/me` | Bearer JWT | — | `{ "success": true, "user": <AuthUser> }` |
| GET | `/api/license/status` | Bearer JWT | — | ver §2.5 |

Errores de `POST /api/auth/verify`:
- 400 `{ success:false, message:"Token requerido" }`
- 401 `{ success:false, message:"Token inválido o expirado" }`
- 401 `{ success:false, message:"Usuario no encontrado o inactivo" }`
- 401 `{ success:false, message:"Token revocado. Inicia sesión de nuevo." }` — el JWT lleva
  `tokenVersion`; cambiar contraseña incrementa `users.token_version` y revoca sesiones viejas
  (AUTH-003/AUTH-008, `authController.js:417-426`).
- 403 `{ success:false, code:"license_blocked", reason:"...", message:"..." }` (ver §6).

`requireAuth` (todas las rutas privadas, `authMiddleware.js:5-79`) puede responder:
- 401 `"Token no proporcionado"` / `"Token inválido o expirado"` / `"Usuario no encontrado o inactivo"`
- 401 `{ code:"token_revoked", error:"Tu sesión ya no es válida (la contraseña cambió). Inicia sesión de nuevo." }`
- 403 `{ code:"license_blocked", reason, message }` cuando la licencia se suspende a media sesión.

### 4.2 Gestión de usuarios (solo admin; UI solo en escritorio)

| Método | Path | Gate | Body (JSON exacto) | Respuesta OK |
| --- | --- | --- | --- | --- |
| GET | `/api/auth/users` | `requireAuth` + `requireAdmin` | — | `{ "success": true, "users": [<TeamUser §2.4>...] }` ordenados por activo desc, rol asc, nombre asc |
| POST | `/api/auth/users` | idem | `{ "firstName": string, "lastName": string, "email": string, "phone": string, "role": "admin"\|"employee", "password": string, "accessConfig": { moduleKey: level } }` | 201 `{ "success": true, "user": <TeamUser> }` |
| PATCH | `/api/auth/users/:userId` | idem | mismo body; `password` opcional | `{ "success": true, "user": <TeamUser> }` |
| DELETE | `/api/auth/users/:userId` | idem | — | `{ "success": true, "deleted": true, "userId": "<id>" }` |

No hay paginación (lista completa). Validaciones/errores en §3.4.

### 4.3 Acceso API externo (módulo `settings_api_access`)

Dos superficies equivalentes (mismos controladores `authController.js:708-780`):

| Método | Path | Gate | Respuesta OK |
| --- | --- | --- | --- |
| GET | `/api/api-access/` | auth + `settings_api_access` (read) | `{ "success": true, "appId": "app_...", "apiToken": <metadata §2.6> }` |
| POST | `/api/api-access/token/rotate` | auth + `settings_api_access` (write) | `{ "success": true, "message": "API token generado exitosamente", "appId": "app_...", "apiToken": "ristak_live_...", "apiTokenMetadata": <metadata> }` — token plano solo aquí |
| DELETE | `/api/api-access/token` | auth + `settings_api_access` (write) | `{ "success": true, "message": "API token revocado exitosamente", "appId": "app_...", "apiToken": <metadata> }` |
| GET | `/api/auth/api-token` | solo `requireAuth` | igual al GET de arriba |
| POST | `/api/auth/api-token/rotate` | solo `requireAuth` | igual al rotate |
| DELETE | `/api/auth/api-token` | solo `requireAuth` | igual al revoke |

Reglas: 1 token activo por usuario; rotar invalida el anterior de inmediato; revocar borra el
hash. El login (`POST /api/auth/login`) también devuelve `appId` y `apiTokenMetadata`.
La API externa (`/api/external/*`, `/api/mcp`) se autentica con ese token
(`Authorization: Bearer ristak_live_...` o header `x-api-key`) y NO aplica `accessConfig`
por módulo; solo algunas rutas internas exigen `role='admin'` (`external.routes.js:1264`).
Ver `docs/EXTERNAL_API_ACCESS.md`.

### 4.4 Licencia — cancelación de cuenta (solo admin escritorio)

`license.routes.js:36-66`; gates: `requireAuth` + `requireAdmin` + `requireModuleAccess('settings_account')`.

| Método | Path | Body |
| --- | --- | --- |
| GET | `/api/license/account-cancellation/status` | — |
| POST | `/api/license/account-cancellation/retention` | — |
| POST | `/api/license/account-cancellation/cancel` | `{ "reason_key": string, "reason_details": string }` (acepta también camelCase) |

⚠️ Las respuestas son **pass-through del portal central** (no definidas en este repo).
OPEN QUESTION: shape exacto; no implementar en iOS sin verificar contra el portal.

### 4.5 Rate limiting en superficies de auth

`auth.routes.js:37-74`. Respuesta 429:
`{ "success": false, "code": "rate_limited", "message": "Demasiados intentos de inicio de sesión. Espera unos minutos e intenta de nuevo." }`
(login; 10 fallos/15min por IP+correo, los éxitos no cuentan). Setup/SSO/Google/forgot/reset:
30/15min por IP con mensaje genérico `"Demasiados intentos. Espera unos minutos e intenta de nuevo."`

---

## 5. Licencia central — detalle

### 5.1 Enforcement y flujo

- `isLicenseEnforced()` = existen `LICENSE_SERVER_URL` (o `RISTAK_LICENSE_SERVER_URL`),
  `CLIENT_ID`, `LICENSE_KEY` en el entorno del backend (`licenseService.js:253-256`).
  El cliente NO puede saber esto por env; lo sabe por `user.licenseEnforced` o
  `GET /api/license/status.enforced`.
- Login: identidad local primero; luego `verifyLicenseWithServer(email)` contra
  `POST {LICENSE_SERVER_URL}/api/license/verify`. `allowed=false` ⇒ 403 `license_blocked`
  (el login NO abre sesión).
- Cada request privado re-valida vía cache: token temporal con `expires_at` (horas) +
  revalidación en caliente cada 300s (`LICENSE_REVALIDATE_SECONDS`, LIC-008) para reflejar
  cambios de plan sin re-login. Estado bloqueado se cachea 60s (LIC-006).
- Portal inaccesible: con token vigente se mantiene acceso; sin token, política
  `strict` (default) bloquea con `reason:"license_server_unreachable"`; política `grace`
  respeta el último estado permitido `LICENSE_OFFLINE_GRACE_HOURS` horas (default 24).
- `requireActiveLicense`/`requireAuth` bloqueados responden 403:
  `{ "success": false, "code": "license_blocked", "reason": "<license_blocked|license_server_unreachable|license_check_failed|...>", "message": "Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar." }`
- `requireFeature(key)` bloqueado responde 403:
  `{ "success": false, "code": "feature_not_available", "feature": "<key>", "message": "Esta función no está incluida en tu plan actual. Contacta al administrador para activarla." }`
  (o `"No se pudo validar tu plan. Intenta de nuevo en unos minutos."` si el chequeo falla).

### 5.2 Features por defecto (standalone = todas `true`)

`DEFAULT_FEATURES` (`licenseService.js:21-47`): `dashboard, contacts, chat, appointments,
payments, reports, analytics, campaigns, sites, forms, ai_agent, automations, whatsapp, email,
integrations, team_access, mobile_app, developers, premium_modules, meta_ads, google_calendar,
ai, app_assistant_ai, conversational_ai, advanced_reports`.

Fail-closed (LIC-003): si el portal responde `allowed` sin objeto `features` válido, las
features premium (`whatsapp, email, meta_ads, google_calendar, automations, advanced_reports,
app_assistant_ai, conversational_ai, ai, ai_agent, premium_modules`) se apagan y el resto queda.

### 5.3 Normalización de features (dependencias padre→hijo)

`FEATURE_DEPENDENCIES` (`licenseService.js:73-87`): cada feature padre propaga a sus hijas
salvo override explícito del portal (LIC-004):

| Padre | Hijas |
| --- | --- |
| `appointments` | `google_calendar`, `settings_calendars` |
| `payments` | `settings_payments` |
| `reports` | `advanced_reports`, `settings_costs` |
| `campaigns` | `meta_ads` |
| `sites` | `settings_domains`, `settings_tracking`, `settings_media` |
| `forms` | `settings_custom_fields` |
| `ai_agent` | `app_assistant_ai`, `conversational_ai` |
| `whatsapp` | `settings_whatsapp` |
| `email` | `settings_email` |
| `integrations` | `settings_integrations` |
| `team_access` | `settings_users` |
| `mobile_app` | `settings_mobile` |
| `developers` | `settings_api_access` |

Alias legacy: `ai` → `ai_agent`. Además `ai = app_assistant_ai && conversational_ai`.

### 5.4 Mapeo módulo→feature en el CLIENTE (regla de visibilidad)

Regla (`hasLicenseFeatureAccess`, idéntica en `accessControl.ts:343-366` y
`mobile/src/access.ts:45-59`):

1. Si `licenseEnforced != true` ⇒ permitido.
2. Si `licenseFeatures` tiene la clave EXACTA del módulo ⇒ usar ese boolean.
3. Si no, si tiene la clave `primary` de la regla ⇒ usar ese boolean.
4. Si no, si alguna clave `legacy` existe y es `true` ⇒ permitido (`.some(===true)`).
5. Sin regla o sin claves presentes ⇒ permitido (fail-open del lado del cliente).

Reglas del subset nativo (`mobile/src/access.ts:21-30`):

| Módulo | `primary` | `legacy` |
| --- | --- | --- |
| `chat` | `chat` | `whatsapp` |
| `appointments` | `appointments` | `google_calendar` |
| `payments` | `payments` | — |
| `analytics` | `analytics` | — |
| `contacts` | `contacts` | — |
| `ai_agent` | `ai_agent` | `app_assistant_ai`, `conversational_ai`, `ai` |
| `settings_mobile` | `mobile_app` | `settings_mobile` |
| `dashboard` | `dashboard` | — |

(La tabla completa de escritorio para las 25 claves está en `accessControl.ts:223-249`;
para iPad con módulos de escritorio, portarla completa.)

### 5.5 Límites

`limits.conversational_agents.max_agents`: entero positivo o `null` (sin tope). Ej.: plan
`basic` con `conversational_ai=true` aplica `max_agents=1`; el backend valida al crear agentes
(`conversationalAgentService.js`); la UI solo anticipa el bloqueo. `docs/LICENSING.md:80-83`.

---

## 6. Estados de fallo de sesión/licencia — comportamiento esperado del cliente

### 6.1 Web escritorio y /movil (mismo bundle)

- Interceptor global `authFetch.ts:106-122`: cualquier respuesta **403 con `code:"license_blocked"`**
  ⇒ borra `auth_token` de localStorage y redirige `window.location.href = '/license-blocked'`.
- Página `/license-blocked` (`LicenseBlocked.tsx`): icono escudo, título **"Licencia no activa"**,
  subtítulo = `message` del backend o fallback
  `"Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar."`,
  botón primario **"Volver al inicio de sesión"**, y nota:
  `"Si crees que esto es un error, escribe al equipo que te dio acceso a Ristak. En cuanto tu suscripción se reactive podrás entrar de nuevo con tu misma cuenta."`
- Login (`Login.tsx:116-119`): si el login lanza `code:"license_blocked"` ⇒ navega a
  `/license-blocked` pasando el `message`.
- Verify al arrancar (`AuthContext.tsx:115-140`): respuesta no-OK o sin `user` ⇒ borra token y
  manda a login. No distingue 403 licencia en el arranque (el interceptor lo captura después).

### 6.2 App RN nativa (paridad a replicar en iOS)

`mobile/src/App.tsx:1149-1272` y `mobile/src/api.ts:292-316`:

- **`license_blocked` (403) en cualquier request**: handler `onLicenseBlocked` ⇒ borra el token
  guardado, limpia sesión, vuelve a pantalla de login y muestra UNA sola vez (flag ref)
  `Alert` con título **"Licencia suspendida"** y cuerpo
  **"Tu licencia de Ristak ya no está activa. Inicia sesión de nuevo cuando se reactive."**
  El flag se resetea tras un login exitoso.
- **`license_blocked` en el login** (`api.ts:1257-1261`): se lanza error con el `message` del
  backend (fallback `"Tu licencia de Ristak no esta activa."`) y `code` para que la pantalla
  de login lo muestre.
- **`feature_not_available` (403)**: solo si el método NO es GET (los GET de carga de pantalla
  se silencian para no regañar en lecturas) ⇒ `Alert` título **"Función no disponible"**, cuerpo =
  `message` del backend o fallback
  **"Esta función no está incluida en tu plan. Pídele al administrador que la active."**
- **Bootstrap de sesión**: verifica el token guardado con `POST /api/auth/verify` bajo timeout.
  - Verify OK ⇒ set user (con `accessConfig`/`licenseFeatures` frescos).
  - Verify responde 401/403 ⇒ borra token, pantalla login.
  - Verify falla por red/timeout ⇒ **mantiene el shell con `user = null`** (optimista); las
    secciones no se ocultan (§7.3) y el backend sigue siendo quien rechaza por request.
- Logout: solo borra token (conserva `baseUrl` del tenant). "Cambiar empresa" limpia todo el
  runtime (baseUrl + token).

### 6.3 Revocación de token (`token_revoked`)

Tras un cambio de contraseña, el siguiente request devuelve 401 con `code:"token_revoked"` y
mensaje `"Tu sesión ya no es válida (la contraseña cambió). Inicia sesión de nuevo."` El cliente
debe tratar CUALQUIER 401 en rutas privadas como sesión inválida ⇒ limpiar token y volver a login.

---

## 7. Inventario UX (cómo se usa este módulo en /movil y en RN)

### 7.1 /movil (web) — gating por ruta, dock sin filtrar

- Cada ruta `/movil/*` se envuelve en `ProtectedRoute` (redirige a `/movil/login` sin sesión) +
  `AccessRoute moduleKey=...` (`frontend/src/App.tsx:267-279, 800-905`): si
  `hasModuleAccess(user, moduleKey, 'read')` es `false`, redirige con `<Navigate replace>` a
  `getFirstAllowedAppPath(user)` = la RUTA DE ESCRITORIO del primer módulo permitido en el orden
  de `ACCESS_MODULES` (fallback `/settings/account`). No hay pantalla de "sin permiso": es
  redirección silenciosa.
- El dock inferior de /movil (`PhoneEcosystemNav.tsx:259`) **NO filtra** por permisos: pinta las
  5 secciones siempre (Ajustes, Chats, Citas, Pagos, Analíticas); al tocar una sección sin
  permiso, la redirección de `AccessRoute` te saca.
- No existe gestión de usuarios ni edición de permisos en /movil; eso vive solo en escritorio
  (`/settings/users-access`).
- No hay gating visual read-vs-write en las páginas Phone*: los botones de escritura se muestran
  y el backend responde 403 `write_access_required` si el nivel es `read`.

### 7.2 /movil Pagos — capacidades por licencia + pasarelas

`resolveMobilePaymentAccess` (portado a RN en `mobile/src/App.tsx:12830-12855`; el nativo debe
igualarlo):

- Lee en paralelo `GET /api/license/status` y `GET /api/integrations/status` (ambos con
  `.catch(() => null)`; si fallan ⇒ default: solo pago único offline).
- `plan` se normaliza a minúsculas y `'pro'` ⇒ `'professional'`.
- Pasarela conectada = `integrations[key].connected === true || configured === true` para
  `stripe|conekta|mercadopago|clip|rebill`.
- `offlineOnly = !hayPasarelaConectada` (el gate online es SOLO por pasarela, no por plan).
- `canUsePaymentPlans` = hay pasarela de planes (`stripe|conekta|rebill`) **y** feature
  `payment_plans` no es `false` (ausente cuenta como `true`).
- `canUseSubscriptions` = hay pasarela de suscripción (`stripe|conekta|mercadopago|rebill`)
  **y** feature `subscriptions` no es `false`.
- Las cards "Planes de pago" y "Suscripción" solo aparecen si su capacidad es `true`.

### 7.3 App RN nativa — dock filtrado por permisos

`mobile/src/App.tsx:1291-1300`:

- `allowedNavItems = PHONE_NAV_ITEMS.filter(item => hasPhoneSectionAccess(user, item.key))`;
  si el filtro deja la lista vacía ⇒ **fallback: muestra las 5** (nunca un dock vacío).
- Si la sección activa deja de estar permitida, se salta automáticamente a la primera permitida.
- `navigateSection` ignora navegaciones a secciones no permitidas.
- `hasPhoneSectionAccess(null, s) === true` (`mobile/src/access.ts:79-85`): con usuario aún no
  verificado (arranque optimista o timeout de verify) NO se oculta nada; el backend sigue
  rechazando por request y el dock se re-filtra al resolver el usuario.
- El botón del chat de agente IA se controla con la config `mobile_chat_ai_agent_enabled`
  (default `true`; editable en Ajustes nativos) — es una preferencia de app, NO un permiso;
  el permiso real del backend es el módulo `ai_agent` + feature `app_assistant_ai`/`conversational_ai`.

### 7.4 Escritorio (referencia para iPad "clase escritorio")

- Sidebar filtra cada item con `hasModuleAccess(user, key, 'read')` (`Sidebar.tsx:197`).
- Rutas con `AccessRoute` + `getRouteAccess(pathname)` (tabla prefijo→módulo en
  `accessControl.ts:392-424`).
- Pantalla **Usuarios** (`/settings/users-access`, solo admin): lista de miembros con badge de
  rol (**"Administrador"** / **"Empleado"**, inactivo = **"Sin acceso"**), alta/edición con:
  rol (radio Empleado/Administrador), plantillas de permisos (`default` "Sin acceso",
  `read` **"Solo lectura"** — "Ve todo el CRM, sin editar." —, `full` acceso completo,
  `custom`), y matriz por grupos CRM/Operación/Configuración con segmented de 3 niveles
  ("Sin acceso" / "Solo ver" / "Ver y editar") por módulo. Admin muestra "Acceso completo".
  Nada de esto existe en móvil.

---

## 8. Decisión de visibilidad para la app nativa iOS (algoritmo recomendado, ya validado por RN)

Portar 1:1 `mobile/src/access.ts` (85 líneas, ya es el puerto reducido oficial):

```swift
enum AccessLevel: String, Decodable { case none, read, write }

func isAdmin(_ user: RistakUser?) -> Bool { user?.role == "admin" }

func hasLicenseFeatureAccess(_ user: RistakUser?, _ module: ModuleKey) -> Bool {
    guard user?.licenseEnforced == true else { return true }
    guard let rule = licenseRules[module] else { return true }        // tabla §5.4
    let f = user?.licenseFeatures ?? [:]
    if let v = f[module.rawValue] { return v == true }
    if let v = f[rule.primary]    { return v == true }
    if !rule.legacy.isEmpty { return rule.legacy.contains { f[$0] == true } }
    return true
}

func hasModuleAccess(_ user: RistakUser?, _ module: ModuleKey, _ required: AccessLevel = .read) -> Bool {
    guard hasLicenseFeatureAccess(user, module) else { return false }
    if isAdmin(user) { return true }
    var level = user?.accessConfig?[module.rawValue]
    if module == .chat, level == nil { level = user?.accessConfig?["contacts"] } // legado
    let resolved = level ?? .none
    return required == .write ? resolved == .write : (resolved == .read || resolved == .write)
}

func hasPhoneSectionAccess(_ user: RistakUser?, _ section: PhoneSection) -> Bool {
    guard let user else { return true }   // usuario aún cargando: no ocultar; el backend manda
    return hasModuleAccess(user, sectionModule[section]!, .read)
}
```

Reglas operativas:

- Filtrar el dock/tabs con `hasPhoneSectionAccess`; si el resultado queda vacío, mostrar todo
  (paridad con RN) para no dejar al usuario atrapado.
- Refrescar `user` (y con él `accessConfig`/`licenseFeatures`) re-llamando
  `POST /api/auth/verify` al volver a foreground o tras errores 403 de módulo; no hay push de
  cambios de permisos.
- Ante 403 `read_access_required`/`write_access_required`: mostrar el `error` del backend como
  toast/alert; no cerrar sesión.
- Ante 403 `license_blocked`: cerrar sesión local + alerta única "Licencia suspendida" (§6.2).
- Ante 403 `feature_not_available`: alertar SOLO en acciones del usuario (no-GET), con el
  `message` del backend (§6.2).
- Ante 401 (cualquiera, incl. `token_revoked`): limpiar token y volver a login.

---

## 9. Gaps / riesgos / OPEN QUESTIONS para iOS nativo

1. **No hay endpoint dedicado de permisos**: el único contrato para leer `accessConfig` y
   `licenseFeatures` es el objeto `user` de `login/verify/me`. Cambios de permisos hechos por un
   admin NO se notifican; solo se ven al siguiente `verify`. Recomendación: re-verify en
   foreground + tras cualquier 403 de módulo.
2. **Inconsistencia de tipos de `id`**: number en `serializeAuthUser`, string en
   `serializeMember`. Decodificar tolerante en Swift.
3. **Dock /movil vs RN divergen**: /movil muestra las 5 secciones y redirige; RN oculta las no
   permitidas (con fallback a todas si quedaran 0). Paridad objetivo = comportamiento RN.
4. **Usuario sin `settings_mobile`**: en /movil, `AccessRoute` lo redirige a una RUTA DE
   ESCRITORIO (p. ej. `/dashboard`) — experiencia rara en teléfono. En RN simplemente se oculta
   "Ajustes" del dock, dejando al usuario sin acceso a logout/preferencias dentro de la app.
   OPEN QUESTION: dónde exponer "Cerrar sesión" en iOS cuando `settings_mobile='none'`
   (RN hoy no lo resuelve; el fallback "mostrar todo si la lista queda vacía" solo cubre el caso
   de 0 secciones).
5. **Sin gating read-vs-write en UI móvil**: ni /movil ni RN deshabilitan acciones de escritura
   con nivel `read`; dependen del 403 `write_access_required`. OPEN QUESTION: si iOS debe
   deshabilitar proactivamente (mejor UX) o mantener paridad exacta. Si se deshabilita, usar
   `hasModuleAccess(user, module, .write)`.
6. **`licenseFeatures` del user pueden quedar viejas**: el backend revalida el plan en caliente
   cada ~300 s por request, pero el objeto `user` cacheado en el cliente no cambia hasta el
   próximo `verify`. Para Pagos, RN consulta `GET /api/license/status` fresco al abrir la
   sección — replicar.
7. **`GET /api/license/status` requiere licencia activa** (pasa por `requireAuth`): no sirve
   para distinguir "bloqueado" vs "sin red"; el estado bloqueado siempre llega como 403
   `license_blocked` con `reason` (`license_blocked`, `license_server_unreachable`,
   `license_check_failed`).
8. **Cancelación de cuenta** (`/api/license/account-cancellation/*`): respuestas pass-through
   del portal central, shape no definido en este repo. No implementar en iOS sin verificar.
   Es solo-admin + escritorio hoy.
9. **`hasPhoneSectionAccess(nil) == true`**: al arrancar con verify fallido por red, la app
   muestra secciones que quizá el usuario no puede usar; los requests fallarán con 403 module.
   Es comportamiento deliberado (comentario en `access.ts:80-84`); replicar y manejar los 403
   con mensajes no intrusivos.
10. **`/api/user-config` self no tiene gate de módulo** a propósito (preferencias de
    notificaciones propias); `/api/push/*` tampoco. La app puede registrarse a push aunque el
    usuario tenga permisos mínimos.
11. **Módulos externos** (`licenseExternalModules`, p. ej. `mdp_program`): solo tienen UI en el
    sidebar de escritorio. OPEN QUESTION: si el iPad "clase escritorio" debe pintarlos; no hay
    superficie móvil hoy.
12. **`contacts` como módulo separado**: en el shell móvil no hay sección "Contactos"; la
    búsqueda/creación de contactos vive dentro de Chats/Citas/Pagos y sus endpoints están
    gateados por `contacts` (y `chat` para la bandeja). Un usuario con `chat:'read'` pero
    `contacts:'none'` puede listar la bandeja (`/api/contacts/chats` gate `chat`) pero NO
    buscar/crear contactos (`/api/contacts/*` gate `contacts`) — la UI debe tolerar ese 403.
13. **SSE (`/api/chat-events/stream`)** está gateado por `chat` y `requireAuth` con header
    Bearer; verificar en el módulo realtime cómo se pasa el token (EventSource no permite
    headers custom en web; en iOS con URLSession sí).

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **CORRECCIÓN — §3.3 y §9.12 (gate de la bandeja de chat):** verificado en
   `backend/src/routes/contacts.routes.js:47-57`: el router aplica
   `router.use(requireModuleAccess('contacts'))` a TODO `/api/contacts/*` y las rutas
   `/chats*` agregan `requireModuleAccess('chat')` **ADEMÁS** (no como override).
   Por lo tanto un usuario con `chat:'read'` pero `contacts:'none'` **NO puede** listar
   la bandeja (403 `read_access_required` module `contacts`), al contrario de lo que
   afirma §9.12. La regla correcta: la bandeja exige `contacts ≥ read` **y** `chat ≥ read`.
   (El caso inverso —`contacts:'read'` con `chat:'none'`— también se bloquea, ACL-001.)
   Nota: `/api/chat-events/*` sí exige solo `chat` (sin `contacts`).
2. **CONFIRMADO — §3.2:** `userAccessMiddleware.js:17` deriva write para todo método no
   GET/HEAD; esto hace que `POST /api/chat-events/viewing` (presencia) exija
   `chat:'write'` (ver doc 11 Audit resolutions #2).
3. **NOTA — §2.3 (sección Analíticas):** el gate de cliente es el módulo `analytics`,
   pero los endpoints que consume la pantalla (`/api/dashboard/*`) exigen el módulo
   `dashboard` (`dashboard.routes.js:8-9`). Empleado con `analytics:read` +
   `dashboard:none` = pestaña visible con 403 en todos los datos (detalle en doc 09
   Audit resolutions #1).
