# 02 — Autenticación y sesión (auth-session)

> Spec de investigación para la app nativa SwiftUI (iPhone/iPad, iOS 26).
> Fuente de verdad: backend Node/Express + SQLite de este repo, el shell web
> `/movil` (frontend Vite) y la app React Native de `mobile/`. Los agentes Swift
> deben poder implementar login/sesión **solo con este documento**.
>
> Fuentes principales:
> - `backend/src/routes/auth.routes.js`
> - `backend/src/controllers/authController.js`
> - `backend/src/controllers/userAccessController.js`
> - `backend/src/middleware/authMiddleware.js`, `userAccessMiddleware.js`, `licenseMiddleware.js`, `apiTokenMiddleware.js`
> - `backend/src/utils/auth.js`, `backend/src/utils/userAccess.js`, `backend/src/utils/apiTokens.js`
> - `backend/src/services/licenseService.js`
> - `backend/src/routes/license.routes.js`
> - `frontend/src/contexts/AuthContext.tsx`, `frontend/src/services/authFetch.ts`, `frontend/src/services/apiBaseUrl.ts`, `frontend/src/services/mobileTenantService.ts`
> - `frontend/src/pages/Login/{Login,Sso,Setup,ResetPassword,LicenseBlocked}.tsx`, `frontend/src/components/phone/MobileTenantSetup.tsx`
> - `frontend/src/utils/phoneAccess.ts`, `frontend/src/utils/accessControl.ts`
> - `mobile/src/api.ts`, `mobile/src/App.tsx`, `mobile/src/storage.ts`, `mobile/src/access.ts`, `mobile/src/types.ts`
> - `docs/MOBILE_APP.md`

---

## 1. Arquitectura general

Ristak es **multi-instalación**: cada cliente (empresa) tiene su propia
instalación (su propio backend Render + su propia DB SQLite/Postgres). No hay
"tenant id" en las requests: el tenant se resuelve eligiendo **la URL base del
backend** contra la que se habla.

Dos servidores intervienen:

1. **Portal central / installer** (`https://www.ristak.com` por defecto,
   override con `EXPO_PUBLIC_INSTALLER_API_URL` en RN o `VITE_INSTALLER_API_URL`
   en Capacitor). Solo se usa para:
   - `POST /api/mobile/resolve` → dado un correo, devuelve la instalación
     (backend) de esa empresa. **El código de este endpoint vive en el repo
     `ristak-installer`, no aquí** (ver Gaps §12).
2. **Backend de la instalación** (p. ej. `https://cliente.onrender.com`). Todo
   lo demás (`/api/auth/*`, `/api/contacts/*`, etc.) va contra esa base.

La identidad es **local por instalación** (tabla `users`). Además, si la
instalación está "gestionada" (`isLicenseEnforced()` → hay
`LICENSE_SERVER_URL`/config central), cada login y cada request valida la
**licencia comercial** contra el portal central (features de plan, bloqueo por
suspensión).

---

## 2. Resolución de tenant (login móvil "un solo paso")

### 2.1 Endpoint del portal central

`POST {INSTALLER_BASE}/api/mobile/resolve`
(consumido en `mobile/src/api.ts:1206-1237` y
`frontend/src/services/mobileTenantService.ts:28-55`)

Request (JSON):

```json
{ "identifier": "correo@negocio.com" }
```

- `identifier` (string): correo del usuario (dueño o empleado). El cliente
  exige `identifier.trim().length >= 3` antes de llamar; si no, error local
  "Escribe tu correo de Ristak." (RN) / "Escribe tu correo o el nombre de tu
  empresa." (web).

Response OK:

```json
{
  "success": true,
  "tenant": {
    "client_id": "…",
    "installation_id": "…",
    "name": "Nombre de la empresa",
    "email": "correo@negocio.com",
    "app_url": "https://cliente.onrender.com"
  }
}
```

Response error: `{ "success": false, "message": "…" }` — el cliente muestra
`message` o el fallback "No encontré una app activa para ese correo." (RN usa
"No encontre una app activa para ese correo." sin tildes; unificar en iOS).

Todos los campos de `tenant` son strings; el cliente trata todos como
opcionales excepto `app_url` (sin `app_url` válido ⇒ error). `app_url` se
normaliza a **origin** (`cleanBaseUrl`: sólo `http:`/`https:`, se recorta a
`URL.origin`, sin slash final).

Modelo cliente (RN `RuntimeTenant`, `mobile/src/types.ts:47-53`):

```ts
{ clientId: string; installationId: string; name: string; email: string; appUrl: string }
```

### 2.2 Flujo de login RN (a replicar en iOS)

`loginWithResolvedTenant(identifier, password)` (`mobile/src/api.ts:1239-1264`):

1. Validación local: correo y contraseña no vacíos (error "Escribe tu correo y
   contrasena."). La pantalla además valida formato de email con regex
   `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (error "Escribe un correo válido.",
   `App.tsx:2146-2150`).
2. `resolveMobileTenant(email)` contra el portal central → `tenant.appUrl`.
3. `POST {appUrl}/api/auth/login` con ese mismo correo + contraseña.
4. Si la respuesta trae `token` y `user` ⇒ éxito; se persisten:
   - `baseUrl` (appUrl) → SecureStore key `ristak.native.apiBaseUrl.v1`
   - `token` → SecureStore key `ristak.native.authToken.v1`
   (`mobile/src/storage.ts:3-24`; en iOS nativo usar Keychain.)
5. Si `code === 'license_blocked'` ⇒ error con ese code y mensaje del backend
   (fallback "Tu licencia de Ristak no esta activa.").
6. Otro fallo ⇒ `message` del backend o "Correo o contrasena incorrectos.".

El shell web `/movil` en Capacitor hace lo mismo (`loginWithPortal`,
`mobileTenantService.ts:67-99`) y guarda `auth_token` en `localStorage`; además,
en `Login.tsx:110-152` hay un **retry MOB-003**: si el login falla, re-resuelve
el tenant por si el correo pertenece a OTRA empresa; si la base URL cambió,
reintenta el login una sola vez contra la nueva base. Recomendado replicar en
iOS.

Al cambiar de base URL, el web limpia el storage tenant-scoped
(`apiBaseUrl.ts:84-91`): `auth_token`, `ristak_latest_api_token` y todos los
keys con prefijo `rstk_config_` / `ristak_phone_`. Equivalente iOS: al cambiar
de empresa, purgar caches/preferencias locales de la empresa anterior.

---

## 3. Endpoints de autenticación (backend de la instalación)

Base path: `/api/auth` (montado en `server.js`). Content-Type siempre
`application/json`. Errores genéricos 500: `{ "success": false, "message":
"Error en el servidor" }`.

| # | Método | Path | Auth | Rate limit | Uso móvil |
|---|--------|------|------|-----------|-----------|
| 1 | POST | `/api/auth/login` | — | 10 fallos / 15 min por IP+correo (`skipSuccessfulRequests`) | **Sí (core)** |
| 2 | POST | `/api/auth/verify` | — (token en body) | no | **Sí (bootstrap)** |
| 3 | GET | `/api/auth/me` | Bearer | no | Opcional (refrescar usuario) |
| 4 | PATCH | `/api/auth/profile` | Bearer | no | Ajustes de cuenta |
| 5 | POST | `/api/auth/change-password` | Bearer | no | Ajustes de cuenta |
| 6 | POST | `/api/auth/change-username` | Bearer | no | Ajustes (desktop) |
| 7 | POST | `/api/auth/forgot-password` | — | 30 / 15 min por IP | Recuperación |
| 8 | POST | `/api/auth/reset-password` | — | 30 / 15 min por IP | Vía web (enlace de correo) |
| 9 | GET | `/api/auth/setup` | — | no | Primer arranque (web) |
| 10 | GET | `/api/auth/setup-info?token=` | — | no | Setup gestionado (web) |
| 11 | POST | `/api/auth/setup` | — | 30 / 15 min por IP | Setup (web) |
| 12 | POST | `/api/auth/sso` | — (token de un solo uso) | 30 / 15 min por IP | Entrada desde portal (web) |
| 13 | POST | `/api/auth/google/start` | — | 30 / 15 min por IP | Login con Google (web) |
| 14 | POST | `/api/auth/local-dev-session` | — (solo localhost, no prod) | no | Dev |
| 15 | GET | `/api/auth/users` | Bearer + admin | no | Gestión de equipo |
| 16 | POST | `/api/auth/users` | Bearer + admin | no | Gestión de equipo |
| 17 | PATCH | `/api/auth/users/:userId` | Bearer + admin | no | Gestión de equipo |
| 18 | DELETE | `/api/auth/users/:userId` | Bearer + admin | no | Gestión de equipo |
| 19 | GET | `/api/auth/api-token` | Bearer | no | No (API externa) |
| 20 | POST | `/api/auth/api-token/rotate` | Bearer | no | No |
| 21 | DELETE | `/api/auth/api-token` | Bearer | no | No |

Cuando el rate limiter dispara: HTTP 429 con

```json
{ "success": false, "code": "rate_limited", "message": "Demasiados intentos de inicio de sesión. Espera unos minutos e intenta de nuevo." }
```

(login) o el genérico "Demasiados intentos. Espera unos minutos e intenta de
nuevo." para el resto (`auth.routes.js:39-74`). `RATE_LIMIT_DISABLED=1`
desactiva los límites (dev).

### 3.1 POST /api/auth/login

`authController.js:155-274`.

Request:

```json
{ "email": "correo@negocio.com", "password": "…" }
```

- Acepta `email` o `username` (legacy) como identificador; el backend lo
  limpia (quita zero-width chars, trim, lowercase) y **exige formato de
  email** (`isValidEmailAddress`). El correo es la única credencial de login;
  `username` interno es solo un identificador de datos.
- Búsqueda: `SELECT * FROM users WHERE LOWER(email) = LOWER(?)`.

Errores:

| HTTP | Body | Causa |
|------|------|-------|
| 400 | `{ "success": false, "message": "Correo y contraseña son requeridos" }` | faltan campos |
| 400 | `{ "success": false, "message": "Ingresa un correo válido" }` | email inválido |
| 401 | `{ "success": false, "message": "Correo o contraseña incorrectos" }` | usuario no existe o password mal |
| 401 | `{ "success": false, "message": "Usuario inactivo. Contacta al administrador" }` | `is_active = 0` |
| 403 | `{ "success": false, "code": "license_blocked", "reason": "<reason>", "message": "…" }` | licencia central no activa |
| 429 | `{ "success": false, "code": "rate_limited", "message": "…" }` | rate limit |

Notas:
- En instalaciones gestionadas, si el hash local no coincide, el backend
  verifica la contraseña contra el portal central
  (`verifyOwnerCredentialsWithServer`) y sincroniza el hash — transparente
  para el cliente.
- Passwords: PBKDF2-SHA512, 100k iteraciones, formato `salt:hash`
  (`utils/auth.js`). Irrelevante para el cliente iOS (nunca ve hashes).

Response OK (200):

```json
{
  "success": true,
  "message": "Login exitoso",
  "token": "<JWT>",
  "appId": "app_…",
  "apiTokenMetadata": {
    "hasToken": false,
    "prefix": null,
    "lastFour": null,
    "preview": null,
    "createdAt": null,
    "lastUsedAt": null,
    "revokedAt": null
  },
  "user": { …AuthUser, ver §5 }
}
```

- `token` (string): JWT de sesión (ver §4).
- `appId` (string): id público de la API externa (`app_` + random). El móvil
  no lo necesita.
- `apiTokenMetadata` (objeto, ver `utils/apiTokens.js:48-62`): metadatos del
  API token de integraciones del usuario (no es el token de sesión). Campos:
  `hasToken` bool; `prefix` string|null (`"ristak_live_"`); `lastFour`
  string|null; `preview` string|null (`"ristak_live_...abcd"`); `createdAt`,
  `lastUsedAt`, `revokedAt` string ISO|null.

### 3.2 POST /api/auth/verify

`authController.js:382-448`. Verifica un token guardado y devuelve el usuario
fresco. **No requiere header Authorization** — el token va en el body.

Request: `{ "token": "<JWT>" }`

Respuestas:

| HTTP | Body |
|------|------|
| 200 | `{ "success": true, "user": { …AuthUser } }` |
| 400 | `{ "success": false, "message": "Token requerido" }` |
| 401 | `{ "success": false, "message": "Token inválido o expirado" }` |
| 401 | `{ "success": false, "message": "Usuario no encontrado o inactivo" }` |
| 401 | `{ "success": false, "message": "Token revocado. Inicia sesión de nuevo." }` (tokenVersion desalineado) |
| 403 | `{ "success": false, "code": "license_blocked", "reason", "message" }` |

### 3.3 GET /api/auth/me

`authController.js:666-702`. Requiere Bearer. Response 200:
`{ "success": true, "user": { …AuthUser } }`. 404 si el usuario ya no existe
(`{ "success": false, "message": "Usuario no encontrado" }`).
Nota: el bloque de licencia del user (`licenseEnforced/licensePlan/...`) solo
viene poblado si `req.license` existe (siempre que la instalación es
gestionada, porque `requireAuth` lo setea).

### 3.4 PATCH /api/auth/profile

`authController.js:786-857`. Requiere Bearer. Actualiza datos visibles.
Solo modifica los campos **presentes** en el body (semántica PATCH real):

```json
{ "firstName": "Raúl", "lastName": "Gómez", "phone": "+52…", "businessName": "Mi Negocio" }
```

Límites: firstName/lastName 80 chars, phone 40, businessName 160. `fullName`
se recalcula como `"firstName lastName"` (fallback a `body.fullName`).
Response 200: `{ "success": true, "message": "Perfil actualizado", "user": {…} }`.
Errores usan la clave **`error`** (no `message`): 401 `"Token inválido o
expirado"`, 404 `"Usuario no encontrado"`, 500 `"Error en el servidor"`.

### 3.5 POST /api/auth/change-password

`authController.js:454-546`. Requiere Bearer (también acepta `token` en body,
legacy).

Request: `{ "currentPassword": "…", "newPassword": "…" }`

Validaciones (400 con `message`):
- "Todos los campos son requeridos"
- Política de contraseña (AUTH-005): mínimo **10** caracteres, al menos una
  minúscula, una mayúscula y un dígito; bloquea comunes. Mensajes exactos:
  - "La contraseña debe tener al menos 10 caracteres"
  - "La contraseña debe incluir mayúsculas, minúsculas y números"
  - "La contraseña es demasiado común. Elige una más segura"
- "La nueva contraseña debe ser diferente de la actual"
- 401 "Contraseña actual incorrecta"

Response 200:

```json
{ "success": true, "message": "Contraseña cambiada exitosamente", "token": "<JWT nuevo>" }
```

**Importante (AUTH-003):** cambiar la contraseña incrementa `token_version` en
DB ⇒ **todas las demás sesiones quedan revocadas** (401 `code:"token_revoked"`
en su siguiente request). La respuesta trae un token nuevo con la versión
vigente: el cliente DEBE reemplazar el token guardado inmediatamente.

### 3.6 POST /api/auth/change-username

Request `{ "newUsername": "…" }` (mín. 3 chars). 400 si corto o en uso ("Este
nombre de usuario ya está en uso"). 200 `{ "success": true, "message":
"Nombre de usuario actualizado exitosamente" }`. No emite token nuevo.

### 3.7 Recuperación de contraseña (AUTH-010)

- `POST /api/auth/forgot-password` — request `{ "email": "…" }`. **Siempre**
  responde 200 con
  `{ "success": true, "message": "Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña." }`
  (anti-enumeración, incluso ante errores). Si existe, manda un correo con
  enlace `{APP_URL}/reset-password?token=<hex64>`, válido **1 hora**, un solo
  uso, un solo token activo por usuario.
- `POST /api/auth/reset-password` — request `{ "token": "…", "newPassword": "…" }`
  (también acepta `password`). Errores 400 con clave **`error`**:
  "Falta el token de recuperación.", mensajes de política (los de §3.5),
  "El enlace es inválido o ya expiró. Solicita uno nuevo.", "El enlace es
  inválido.". 200:
  `{ "success": true, "message": "Tu contraseña se actualizó. Ya puedes iniciar sesión." }`.
  Incrementa `token_version` ⇒ revoca TODAS las sesiones.
- La página web `/reset-password` (fuera de `/movil`) pide nueva contraseña +
  confirmación ("Las contraseñas no coinciden." si difieren) y al éxito
  redirige a `/login` a los 2.5 s. En iOS el enlace del correo abriría el web;
  ver Gaps.

### 3.8 Setup inicial (primer usuario)

Flujo web, documentado por completitud (la app nativa normalmente NO lo
implementa; el usuario ya tiene cuenta):

- `GET /api/auth/setup` → `{ "success": true, "needsSetup": bool, "requiresToken": bool }`
  (`requiresToken` = instalación gestionada: setup exige token del instalador).
- `GET /api/auth/setup-info?token=…` → `{ "success": true, "requiresToken": true, "email": "…" }`
  o 403 con `message`.
- `POST /api/auth/setup` — body
  `{ "email", "password", "token"?, "internalUsername"?, "accountLocale"?: { countryCode, currency, dialCode… } }`.
  Solo funciona si NO hay usuarios (si ya hay: 403 "Ya existen usuarios
  registrados…" o 409 `code:"setup_already_completed"` en carrera). Crea el
  usuario `role:"admin"`, responde como el login pero además con `apiToken`
  (token plano de API externa, se muestra una sola vez).

### 3.9 POST /api/auth/sso

Entrada de un solo uso desde el portal central (web `/sso?token=…`). Body
`{ "token": "…" }`. 200 igual que login (`token`, `appId`,
`apiTokenMetadata`, `user`). Errores: 400 "Falta el enlace de acceso", 404 si
la instalación no es gestionada, 403 mensaje de enlace inválido/usado, 409
`{ "success": false, "code": "needs_setup" }` (sin usuarios aún ⇒ ir a setup
con el mismo token), 403 `license_blocked`. No aplica a la app nativa salvo
que se quiera deep-link.

### 3.10 POST /api/auth/google/start

Body `{ "return_path": "/dashboard" }` (o `returnPath`). 200
`{ "success": true, "url": "https://…" , …}` → el cliente abre esa URL; Google
termina regresando a la instalación vía `/sso?token=…`. 503
`code:"central_login_not_configured"` si la instalación no es gestionada; 502
si el portal no devolvió URL. El login web muestra el botón "Continuar con
Google"; el RN **no** lo implementa. Para iOS ver Gaps (requiere manejar el
retorno `/sso` con ASWebAuthenticationSession o similar).

### 3.11 POST /api/auth/local-dev-session

Solo `NODE_ENV !== 'production'` y requests loopback. Sin body. 200 idéntico
al login (usa el primer usuario activo). 404 en prod, 403 fuera de localhost,
409 `{ success:false, needsSetup:true, message:"No hay usuarios locales activos" }`.
Útil para el simulador iOS contra backend local.

### 3.12 Gestión de usuarios del CRM (admin)

`userAccessController.js` (rutas 15-18 de la tabla). Requiere `role:"admin"`.
Miembro serializado (`serializeMember`):

```json
{
  "id": "3",
  "username": "empleado1",
  "email": "e@x.com",
  "phone": "+521…",
  "firstName": "…", "lastName": "…", "fullName": "…",
  "role": "employee",
  "isActive": true,
  "lastLogin": "2026-07-01 12:00:00" ,
  "createdAt": "…", "updatedAt": "…",
  "accessConfig": { "dashboard": "read", … }
}
```

- `id` aquí es **string** (`String(row.id)`), mientras que en AuthUser es el
  entero crudo. Ojo al tipar en Swift (usar decodificador tolerante
  Int/String).
- Crear: `POST /api/auth/users` body `{ firstName?, lastName?, email?, phone?, role?, password (min 6, temporal), accessConfig? }`;
  exige correo o teléfono. Errores 400 con `message` ("Agrega un correo o un
  teléfono para crear el acceso.", "Ya existe una persona con ese correo o
  teléfono.", etc.).

### 3.13 API token externo (rutas 19-21)

Para la API pública (`Authorization: Bearer ristak_live_…` o header
`x-api-key`, ver `apiTokenMiddleware.js`). La app móvil NO lo usa para su
sesión; solo lo mostraría en Ajustes de escritorio. Shapes en §3.1.

### 3.14 GET /api/license/status

`license.routes.js:18-34`. Requiere Bearer. Response:

```json
{
  "success": true,
  "enforced": true,
  "allowed": true,
  "plan": "pro",
  "features": { "chat": true, "payments": true, … },
  "limits": { "conversational_agents": { "max_agents": 3 } },
  "expires_at": "2026-08-01T00:00:00Z"
}
```

(`plan`, `expires_at` pueden ser `null`; `enforced:false` en instalaciones no
gestionadas.) El RN lo expone como `getLicenseStatus()` pero el gating por
módulo se hace con los campos `license*` del user (§6).

También existen `/api/license/account-cancellation/{status,retention,cancel}`
(admin + módulo `settings_account`) — fuera del alcance móvil actual.

---

## 4. Token de sesión (formato, vida, envío, renovación)

- **Formato**: JWT HS256 **hecho a mano** (`utils/auth.js:generateToken`), tres
  segmentos base64url `header.payload.signature`, firmado con `JWT_SECRET`
  (obligatorio en producción; en dev sin configurar usa un secreto efímero por
  proceso ⇒ las sesiones locales mueren al reiniciar el server).
- **Payload exacto**:

```json
{
  "userId": 1,
  "username": "admin",
  "email": "correo@negocio.com",
  "role": "admin",
  "tokenVersion": 0,
  "iat": 1751871600,
  "exp": 1754463600
}
```

- **Vida: 30 días** (`exp = iat + 60*60*24*30`). **No hay refresh endpoint**:
  no existe renovación silenciosa; al expirar, el usuario vuelve al login.
  Único caso que entrega token nuevo sin re-login: `change-password` (§3.5).
- **Envío**: header `Authorization: Bearer <JWT>` en TODA request a `/api/*`
  del backend de la instalación (el middleware exige el prefijo `Bearer `).
  Excepciones sin auth: `login`, `verify` (token en body), `setup*`, `sso`,
  `forgot/reset-password`, `google/start`, `local-dev-session` y endpoints
  públicos de pagos/sitios.
- **Revocación (AUTH-003)**: cada user tiene `token_version` (entero, default
  0). `requireAuth` compara `payload.tokenVersion ?? 0` vs
  `user.token_version ?? 0`; si difieren → 401
  `{ "success": false, "code": "token_revoked", "error": "Tu sesión ya no es válida (la contraseña cambió). Inicia sesión de nuevo." }`.
- **401 del middleware** (`authMiddleware.js:5-48`) usan la clave **`error`**
  (no `message`):
  - `"Token no proporcionado"`
  - `"Token inválido o expirado"`
  - `"Usuario no encontrado o inactivo"`
  - `code:"token_revoked"` (arriba)
- **403 de licencia** (middleware, en cualquier request):
  `{ "success": false, "code": "license_blocked", "reason": "<reason>", "message": "…" }`.
  Reasons observados: el que mande el portal, o `"license_blocked"` (fallback),
  `"license_server_unreachable"`, `"license_check_failed"`.
- **403 de plan**: `{ "success": false, "code": "feature_not_available", "feature": "<key>", "message": "Esta función no está incluida en tu plan actual. Contacta al administrador para activarla." }`.
- **403 de permisos de módulo** (`userAccessMiddleware.js:15-32`):
  `{ "success": false, "code": "read_access_required" | "write_access_required", "module": "<moduleKey>", "error": "No tienes acceso a esta sección." | "No tienes permiso para cambiar información en esta sección." }`
  (GET/HEAD ⇒ read, resto ⇒ write). Admin-only:
  `{ "success": false, "code": "admin_required", "error": "Solo un administrador puede hacer esto." }`.

### 4.1 Manejo cliente de sesión expirada / bloqueada (contrato UX)

Cliente RN (`RistakApiClient.request`, `mobile/src/api.ts:266-328`):

- Cualquier respuesta no-OK ⇒ `Error` con `status`, `code` y `message`
  extraídos de `error || message` del body.
- **403 + `code:"license_blocked"`** ⇒ handler global: borra el token
  guardado, resetea sesión, vuelve a la pantalla de login y muestra UNA sola
  alerta: título "Licencia suspendida", texto "Tu licencia de Ristak ya no
  está activa. Inicia sesión de nuevo cuando se reactive."
  (`App.tsx:1150-1161`).
- **403 + `code:"feature_not_available"`** ⇒ solo si el método NO es GET
  (para no regañar en cargas de pantalla): alerta "Función no disponible" con
  el `message` del backend (`App.tsx:1162-1167`, `api.ts:305-315`).
- **401 genérico**: el RN **no** tiene interceptor global de 401 en requests
  normales (solo en bootstrap); cada pantalla muestra el mensaje de error.
  OPEN QUESTION §12: en iOS conviene un interceptor 401 → logout suave, que el
  RN no implementa hoy.
- Convención de payloads del cliente: si el body trae
  `{ success, data }` con `data !== undefined`, se desenvuelve `data`; si no,
  se devuelve el JSON completo. HTTP 204 ⇒ `{}`.

Web `/movil` (`authFetch.ts`): interceptor global de fetch añade el Bearer a
requests same-API y, ante **403 license_blocked**, borra `auth_token` y
redirige a `/license-blocked` (pantalla: título "Licencia no activa", botón
"Volver al inicio de sesión").

---

## 5. Modelo de usuario autenticado (AuthUser)

`serializeAuthUser` (`authController.js:47-75`). Shape EXACTO devuelto por
`login`, `verify`, `me`, `profile`, `sso`, `setup`, `local-dev-session`:

```json
{
  "id": 1,
  "username": "admin",
  "email": "correo@negocio.com",
  "firstName": "Raúl",
  "lastName": "Gómez",
  "fullName": "Raúl Gómez",
  "phone": "+52…",
  "businessName": "Mi Negocio",
  "role": "admin",
  "accessConfig": { "dashboard": "write", "chat": "write", … },
  "licenseEnforced": true,
  "licensePlan": "pro",
  "licenseFeatures": { "chat": true, "whatsapp": true, … },
  "licenseLimits": { "conversational_agents": { "max_agents": 3 } },
  "licenseExternalModules": {}
}
```

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | number (entero SQLite) | RN lo tipa string — decodificar tolerante |
| `username` | string | identificador interno, no editable desde móvil |
| `email` | string | puede ser `""` |
| `firstName` / `lastName` | string | `""` si no hay |
| `fullName` | string | `firstName lastName` o fallback `full_name`/`username` |
| `phone` | string | máx 40 chars, `""` si no hay |
| `businessName` | string | `""` si no hay |
| `role` | string | **enum: `"admin"` \| `"employee"`** (todo lo que no sea `admin` se normaliza a `employee`) |
| `accessConfig` | objeto `{ [module]: level }` | SIEMPRE completo y normalizado (ver §6) |
| `licenseEnforced` | bool | `false` cuando la respuesta no evaluó licencia (p. ej. `getMe` sin `req.license`, instalación no gestionada) |
| `licensePlan` | string \| null | |
| `licenseFeatures` | objeto `{ [feature]: bool }` | `{}` si no aplica |
| `licenseLimits` | objeto | `{}` si no aplica; conocido: `conversational_agents.max_agents` number\|null |
| `licenseExternalModules` | objeto | `{}`; entradas con `{ key?, label?, menuLabel?, enabled?, sidebarPosition? }` |

El nombre a mostrar en el cliente: RN usa `user.name || user.email || 'Ristak'`
(`getUserDisplayName`) — pero el backend nunca manda `name`; el web usa
`fullName || username`. Para iOS: `fullName` → `username` → `email`.

---

## 6. Permisos por módulo y gating de secciones

### 6.1 Módulos y niveles (backend `utils/userAccess.js`)

- Niveles: `"none" | "read" | "write"`.
- Roles: `"admin" | "employee"`. **Admin ⇒ `write` en TODOS los módulos**
  (el backend ya lo materializa en `accessConfig`).
- Módulos (26): `dashboard, appointments, payments, contacts, chat, reports,
  analytics, campaigns, automations, sites, ai_agent, settings_account,
  settings_mobile, settings_calendars, settings_payments,
  settings_integrations, settings_whatsapp, settings_email, settings_tracking,
  settings_domains, settings_costs, settings_media, settings_custom_fields,
  settings_api_access, settings_users`.
- Reglas de normalización que el backend ya aplica al serializar:
  - `settings_account` siempre `"write"` (todos pueden ver su cuenta).
  - `settings_users` = `"write"` si admin, `"none"` si employee (y
    `hasUserAccess` lo niega SIEMPRE a employees aunque diga otra cosa).
  - Compat: si la config guardada no trae `chat`, hereda el nivel de
    `contacts`.
  - Cualquier valor desconocido ⇒ `"none"`.

### 6.2 Gating por licencia + permisos en el cliente (paridad exacta)

Port nativo de referencia: `mobile/src/access.ts` (réplica reducida de
`frontend/src/utils/accessControl.ts`).

Mapa sección móvil → módulo (`PHONE_SECTION_MODULE`):

| Sección del shell | Módulo |
|---|---|
| `chat` | `chat` |
| `calendar` | `appointments` |
| `payments` | `payments` |
| `analytics` | `analytics` |
| `settings` | `settings_mobile` |

Features de licencia por módulo (con claves legacy de fallback):

| Módulo | feature primaria | legacy |
|---|---|---|
| chat | `chat` | `whatsapp` |
| appointments | `appointments` | `google_calendar` |
| payments | `payments` | — |
| analytics | `analytics` | — |
| contacts | `contacts` | — |
| ai_agent | `ai_agent` | `app_assistant_ai`, `conversational_ai`, `ai` |
| settings_mobile | `mobile_app` | `settings_mobile` |
| dashboard | `dashboard` | — |

Algoritmo `hasModuleAccess(user, module, level)`:

1. Si `user.licenseEnforced` y la feature del módulo NO está permitida ⇒ false
   (busca la clave del módulo, luego la primaria, luego alguna legacy; si el
   mapa de features no menciona ninguna ⇒ true).
2. Admin ⇒ true.
3. Lee `accessConfig[module]` (con herencia `chat`→`contacts` si falta);
   `write` requiere `"write"`, `read` acepta `"read"|"write"`.

`hasPhoneSectionAccess(user, section)`: si `user == null` (todavía cargando o
el verify de arranque falló por red) ⇒ **true** (no ocultar secciones; el
backend igual rechaza por request). El shell RN filtra los items del dock con
esto y si la sección activa deja de estar permitida salta a la primera
permitida (`App.tsx:1289-1297`). En web `/movil` cada ruta está envuelta en
`AccessRoute moduleKey=…` y redirige a la primera ruta permitida.

Nota RN: el dock nativo permite además `dashboard`/`ai_agent` como destinos de
herramientas internas; el gating de rutas web incluye `ai_agent` para
`/movil/agent-chat`.

---

## 7. Estado de licencia (detalle para modelado)

`licenseService.js`. Estado interno (lo que viaja embebido en el user y en
`/api/license/status`):

- `allowed` bool, `enforced` bool, `plan` string|null,
  `features` `{ [key]: bool }`, `limits`, `externalModules`,
  `expiresAt`/`expires_at` string|null; en bloqueo: `reason` y `message`.
- Features conocidas (defaults, `licenseService.js:21-46`): `dashboard,
  contacts, chat, appointments, payments, reports, analytics, campaigns,
  sites, forms, ai_agent, automations, whatsapp, email, integrations,
  team_access, mobile_app, developers, premium_modules, meta_ads,
  google_calendar, ai, app_assistant_ai, conversational_ai, advanced_reports`.
- Premium gated (si el portal responde `allowed` sin features válidas, estas
  se apagan fail-closed): `whatsapp, email, meta_ads, google_calendar,
  automations, advanced_reports, app_assistant_ai, conversational_ai, ai,
  ai_agent, premium_modules`.
- El backend cachea el veredicto (token temporal + ventana de revalidación);
  una suspensión a media sesión aparece como 403 `license_blocked` en
  cualquier request.

---

## 8. Bootstrap de sesión (qué pasa al arrancar y tras login)

### 8.1 App RN (referencia principal para iOS) — `App.tsx:1176-1244`

Arranque (`screen: 'boot'` → BootScreen: logo Ristak + `ActivityIndicator`):

1. Lee de SecureStore `baseUrl` y `token`.
2. Sin `baseUrl` ⇒ pantalla `login` (sesión vacía).
3. Con `baseUrl` sin token ⇒ `login` (conserva baseUrl).
4. Con ambos ⇒ **entra al shell inmediatamente de forma optimista**
   (`user: null`) y en paralelo llama `POST /api/auth/verify` con **timeout de
   8 s** (`BOOTSTRAP_SESSION_VERIFY_TIMEOUT_MS = 8000`):
   - `success && user` ⇒ setea `user` (habilita gating §6).
   - Respuesta válida pero sin user ⇒ borra token, va a `login`.
   - Error con `status` 401/403 ⇒ borra token, va a `login`.
   - Error de red/timeout ⇒ **se queda en el shell con `user: null`**
     (log: "session verify skipped during startup"); el gating no oculta nada
     y el backend decide por request.

Tras login exitoso:
- Persiste `baseUrl` + `token` (Keychain en iOS).
- Muestra el shell. El shell al montar:
  - `GET /api/config?keys=…` con `SETTINGS_APP_CONFIG_KEYS`
    (`mobile_chat_ai_agent_enabled, mobile_chat_ai_reply_suggestions_enabled,
    mobile_chat_show_archived, mobile_chat_sort_mode,
    mobile_chat_show_last_preview, mobile_chat_show_unread_indicators,
    mobile_chat_theme_preference, mobile_chat_selected_whatsapp_phone_id,
    chat_send_read_receipts`) para preferencias de chat/tema.
  - Auto-registro de push si el permiso está `granted`/`prompt`
    (`App.tsx:1444-1464`), una vez por `baseUrl:userId`.
  - Cada sección carga sus datos al entrar (chats, calendario, etc.).
- No hay ningún otro "bootstrap" obligatorio: no se llama `/api/auth/me` ni
  `/api/license/status` tras el login (los datos de licencia ya vienen en el
  user del login/verify).

### 8.2 Web `/movil` (AuthContext)

- Arranque: si es runtime nativo sin base URL ⇒ borra `auth_token` y muestra
  `/movil/tenant` (login único). Si hay token ⇒ `POST /api/auth/verify`; si
  falla ⇒ borra token; si no hay token ⇒ `GET /api/auth/setup` para decidir
  `/setup`.
- Tras autenticar, un efecto pide `GET /api/integrations/status` para capturar
  `highlevel.locationData.id` y `highlevel.accessToken` (usado por pantallas de
  citas/pagos). La app nativa RN NO replica esto en el login (lo hace por
  pantalla). Para iOS: no es prerequisito de sesión.

---

## 9. Logout y cambio de empresa

RN (`App.tsx:1240-1250`, UI en `App.tsx:11662-11672` y fila de Ajustes
`App.tsx:11825-11840`):

- Fila en Ajustes: icono LogOut rojo, título "Cerrar sesión", subtítulo
  "Salir de este dispositivo.".
- Al tocar: `Alert.alert` nativa con título "Cerrar sesión", mensaje
  `"¿Seguro que quieres cerrar tu sesión en este dispositivo?\n\n{nombre} · {baseUrl}"`
  y TRES botones:
  - "Cancelar" (style cancel)
  - "Cambiar app" ⇒ `clearRuntimeState()` (borra token **y** baseUrl) → login
  - "Cerrar sesión" (style destructive) ⇒ `clearAuthToken()` (borra SOLO el
    token, conserva baseUrl) → login
- No hay endpoint de logout en el backend; cerrar sesión es puramente local
  (el JWT sigue siendo válido hasta expirar/revocarse — ver Gaps).

Web `/movil` (`PhoneSettings.tsx:563-581`): confirm "Cerrar sesión" /
"¿Seguro que quieres cerrar tu sesión en este dispositivo?"; en nativo
Capacitor borra también el tenant runtime y vuelve a `/movil/tenant`; en web
vuelve a `/movil/login`. `AuthContext.logout` borra `auth_token` (+ storage
tenant-scoped en nativo, MOB-004).

---

## 10. Inventario UX (pantallas de auth tal como existen hoy)

### 10.1 RN nativa — LoginScreen (`App.tsx:2130-2204`)

- Layout: panel centrado con `KeyboardAvoidingView` (iOS `padding`) dentro de
  ScrollView (`keyboardShouldPersistTaps="handled"`).
- Elementos y copy exacto:
  - Logo Ristak (asset night-mode), accessibilityLabel "Ristak".
  - Kicker: "Ristak".
  - Título: "Iniciar sesion" (sin tilde en RN; corregir a "Iniciar sesión" en iOS).
  - Cuerpo: "Entra con el correo y la contrasena de tu cuenta."
  - Input correo: placeholder "correo@negocio.com", `autoCapitalize=none`,
    `keyboardType=email-address`, sin autocorrect.
  - Input contraseña: placeholder "Contrasena", `secureTextEntry`.
  - Texto de error en rojo bajo los inputs (mensajes de §2.2/§3.1).
  - Botón primario "Entrar" con spinner cuando `busy`.
- Estados: idle / busy (botón con spinner, submit deshabilitado por guard) /
  error inline. No hay "olvidé mi contraseña" ni Google en la RN (ver Gaps).
- BootScreen: logo + ActivityIndicator (accessibilityLabel "Cargando").
- Pantalla de licencia bloqueada: no existe pantalla dedicada; es la Alert de
  §4.1 + regreso a login.

### 10.2 Web `/movil` — MobileTenantSetup (`/movil/tenant`, solo runtime nativo Capacitor)

- Título "Iniciar sesión", logo, inputs "Correo" (placeholder
  "tu@correo.com") y "Contraseña" (placeholder "********"), error inline,
  botón "Iniciar sesión" (busy: spinner + "Entrando").
- Éxito ⇒ `window.location.replace('/movil')`. `license_blocked` ⇒
  `/license-blocked`.

### 10.3 Web `/movil/login` — Login compartido (`Login.tsx`)

- Subtítulo phone: con tenant "Inicia sesión para entrar a {tenant.name}.",
  sin tenant "Inicia sesión para ver chats, pagos y citas desde el celular."
- Botón "Continuar con Google" (loading: "Abriendo Google...") + divisor
  "o usa tu correo".
- Campos "Correo electrónico" / "Contraseña"; validaciones locales:
  "Por favor ingresa correo y contraseña", "Ingresa un correo válido".
- Botón primario "Iniciar sesión" (loading).
- Link "¿Olvidaste tu contraseña?" ⇒ sección de recuperación:
  - Form "Recupera tu acceso por correo" + botón "Enviar enlace de
    recuperación"; tras enviar SIEMPRE: "Si el correo está registrado, te
    enviamos un enlace para restablecer tu contraseña. Revisa tu bandeja de
    entrada (y spam). El enlace vence en 1 hora."
  - Sección avanzada "Recuperar acceso desde Render" con comando copiable
    (solo web; NO portar a iOS).
- En runtime nativo: link extra "Cambiar empresa" ⇒ limpia tenant y va a
  `/movil/tenant`.
- Errores de login: mensaje del backend; `license_blocked` navega a
  `/license-blocked` con el message.
- Loading de arranque: `PhoneStartupLoader` "Revisando tu acceso".

### 10.4 Otras pantallas web relacionadas

- `/sso` — "Entrando a tu cuenta..." y ante error, link "Iniciar sesión con mi
  correo y contraseña".
- `/license-blocked` — título "Licencia no activa", mensaje del backend o
  fallback, botón "Volver al inicio de sesión", nota "Si crees que esto es un
  error, escribe al equipo que te dio acceso a Ristak…".
- `/reset-password` — ver §3.7.
- Gate nativo iOS del shell Capacitor (`mobileAppService.getIosMobileRedirectPath`):
  sin tenant ⇒ fuerza `/movil/tenant`; con tenant restringe a rutas `/movil/*`.

---

## 11. Contrato mínimo que debe implementar la app iOS

1. Pantalla de login: marca Ristak + email + password, sin configuración
   avanzada visible → `resolveMobileTenant` → `POST {appUrl}/api/auth/login`
   (con retry MOB-003 si se desea paridad completa con /movil).
2. Persistir en Keychain: `apiBaseUrl` y `authToken` (equivalentes a
   `ristak.native.apiBaseUrl.v1` / `ristak.native.authToken.v1`).
3. Cliente HTTP: `Authorization: Bearer <token>`; desenvolver `{success,data}`;
   mapear errores con `status`/`code`/`message||error`.
4. Arranque: shell optimista + `POST /api/auth/verify` (timeout 8 s);
   401/403 ⇒ limpiar token y volver a login; error de red ⇒ continuar sin user.
5. Handlers globales: `license_blocked` (logout + alerta única "Licencia
   suspendida"), `feature_not_available` en métodos != GET (alerta "Función no
   disponible").
6. Gating de secciones con `accessConfig` + `licenseFeatures` (algoritmo §6.2,
   fail-open cuando `user == null`).
7. Logout local con alerta de 3 opciones (Cancelar / Cambiar app / Cerrar
   sesión).
8. Tras `change-password`, reemplazar el token guardado por el de la
   respuesta.

---

## 12. Gaps / riesgos para iOS nativo

1. **`/api/mobile/resolve` no está en este repo** (vive en `ristak-installer`).
   El contrato documentado (§2.1) se dedujo de los DOS clientes que lo
   consumen; no se pudo leer el servidor. OPEN QUESTION: códigos de error
   exactos (¿404 vs 200 con `success:false`?), rate limits del portal, y si
   acepta "nombre de empresa" como identifier (el copy web lo sugiere; el RN
   solo manda correos).
2. **Sin refresh token**: JWT de 30 días sin renovación silenciosa. Tras 30
   días exactos, cualquier request devuelve 401 "Token inválido o expirado".
   El RN solo maneja esto en bootstrap; en medio de la sesión las pantallas
   muestran errores sueltos. Recomendación iOS: interceptor 401 global
   (excepto login/verify) que haga logout limpio — es un EXTRA sobre la
   paridad, no comportamiento actual.
3. **No hay endpoint de logout / revocación por dispositivo**: cerrar sesión
   solo borra el token local; el JWT sigue vivo server-side hasta expirar o
   hasta que un cambio de contraseña suba `token_version`.
4. **`user.id` inconsistente**: entero en `serializeAuthUser`, string en
   `serializeMember`. Decodificar tolerante en Swift.
5. **Claves de error mixtas**: los endpoints usan a veces `message` y a veces
   `error` (middleware y PATCH profile usan `error`; login usa `message`).
   Parsear ambos (`error || message`).
6. **Google Login en nativo**: el RN no lo tiene; el web sí
   (`/api/auth/google/start` → URL → retorno vía `/sso?token=`). Implementarlo
   en iOS requiere `ASWebAuthenticationSession` y captura del redirect a
   `{appUrl}/sso?token=…` para canjearlo con `POST /api/auth/sso`. OPEN
   QUESTION: si el portal permite un `return_path`/scheme custom para apps
   nativas.
7. **Recuperación de contraseña en RN**: inexistente (solo web). El backend sí
   la soporta (§3.7); en iOS se puede ofrecer `forgot-password` in-app, pero
   el enlace del correo abre la web `/reset-password` de la instalación (no
   hay deep link nativo).
8. **Verify no renueva el token** ni devuelve `apiTokenMetadata`; solo valida
   y devuelve `user`.
9. **JWT dev efímero**: contra un backend local sin `JWT_SECRET`, cada
   reinicio del server invalida los tokens (401). Documentado para no
   confundirlo con bugs.
10. **`licenseEnforced` en `getMe`** puede venir `false`/vacío si `req.license`
    no está poblado; para gating usar el user de login/verify, no el de `me`,
    o combinar con `/api/license/status`.
11. **Multi-tenant en un dispositivo**: solo hay UNA empresa activa a la vez
    (una base URL). "Cambiar app" borra todo; no hay multi-cuenta simultánea.
12. **Rate limit de login por IP+correo** (10 fallos/15 min): la UI debe
    mostrar el `message` del 429 tal cual y no reintentar sola.
13. **Sin expiración de sesión por inactividad** ni "sesiones activas"
    listables: no existe API para ver/gestionar dispositivos con sesión.

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **RESUELTO — Gap §12.1 (`/api/mobile/resolve`):** verificado leyendo el repo local
   `Ristak - Installer` (`backend/src/routes/mobile.routes.js` +
   `backend/src/services/mobileTenant.service.js`):
   - **Códigos de error exactos** (con HTTP status real, NO 200 + success:false):
     - `404 { success:false, code:'identifier_required', message:'Escribe el correo o código de tu empresa.' }` (identifier < 3 chars)
     - `404 { success:false, code:'tenant_not_found', message:'No encontré una app activa para esos datos.' }`
     - `403 { success:false, code:'client_inactive', message:'Esta cuenta no está activa.' }`
     - `404 { success:false, code:'installation_not_ready', message:'Esta cuenta todavía no tiene una app lista.' | 'La app de esta cuenta todavía no está lista.' }`
     - `429 { success:false, code:'rate_limited', ... }` + header `Retry-After`.
   - **Rate limit del portal:** 40 requests / 15 min por IP (regla `mobile-tenant-resolve`).
   - **SÍ acepta "nombre de empresa"** como identifier: resolución en 3 pasos —
     (1) email del dueño / invite_code / client_id exactos, (2) directorio de empleados
     (`installation_user_access` por email), (3) matching laxo por slug contra
     nombre del cliente, nombre de la app o hostname del `app_url`.
   - El objeto `tenant` incluye además `status` (estado de la instalación); `app_url`
     prefiere `app_origin_url` (URL Render, siempre enruta) sobre el dominio custom.
2. **CONFIRMADO — §4/§3.2:** el middleware usa clave `error` y el verify usa `message`,
   tal como está documentado (verificado en `authMiddleware.js` / `authController.js`).
