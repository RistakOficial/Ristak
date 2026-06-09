# Licenciamiento, instalación gestionada y Docker

Ristak se distribuye a clientes como **imagen Docker** (sin entregar el código fuente) y se instala
en la cuenta de Render de cada cliente desde el portal central
([ristak-installer](https://github.com/RistakOficial/ristak-installer)).

## Conceptos

- **Login local = identidad**: usuarios/contraseñas viven en la base de datos del cliente.
- **Licencia central = permiso comercial**: tras un login local correcto, la app valida contra el
  servidor central (`POST {LICENSE_SERVER_URL}/api/license/verify`). Sin licencia activa no se entra,
  aunque la contraseña local sea correcta.
- **Feature flags = funciones disponibles**: el servidor central responde las features del plan;
  el backend las valida en cada módulo premium (no basta ocultar botones).

## Variables de entorno de una instalación

| Variable | Descripción |
| --- | --- |
| `CLIENT_ID` | Id del cliente en el portal central. |
| `LICENSE_KEY` | License key asignada al cliente. |
| `LICENSE_SERVER_URL` | URL del portal central (license server). |
| `INSTALLATION_ID` | Id de esta instalación. |
| `APP_URL` | URL pública de la app. Si falta, se usa `RENDER_EXTERNAL_URL` (Render la inyecta). |
| `DATABASE_URL` | PostgreSQL propio del cliente (usuarios, contactos, citas, datos operativos). |
| `SECRET_KEY` / `JWT_SECRET` | Secreto de sesión (el instalador define ambos con el mismo valor). |
| `OWNER_EMAIL` | Email del dueño; se precarga en el setup inicial. |
| `APP_VERSION` | Versión reportada en `/health` y al license server. |
| `LICENSE_OFFLINE_POLICY` | `strict` (default) o `grace`. |
| `LICENSE_OFFLINE_GRACE_HOURS` | Horas de gracia si la política es `grace` (default 24). |

Si `LICENSE_SERVER_URL`, `CLIENT_ID` o `LICENSE_KEY` faltan, la app corre en **modo standalone**
(desarrollo local o instalación propia): no exige licencia y todas las features quedan activas.

## Flujo de autenticación con licencia

1. Usuario escribe email/usuario y contraseña.
2. La app valida la identidad contra su DB local.
3. Si es correcta, llama a `POST {LICENSE_SERVER_URL}/api/license/verify` con
   `client_id`, `license_key`, `installation_id`, `email`, `app_url`, `version`.
4. `allowed=true` → entra; la app cachea el permiso con el `license_token` temporal
   (expiración definida por el servidor: 1/12/24 h configurables) y no vuelve a consultar
   hasta que expire.
5. `allowed=false` → 403 con `code: license_blocked` y el frontend muestra la pantalla
   `/license-blocked`: «Tu licencia de Ristak no está activa…».
6. Todas las rutas privadas pasan por `requireAuth`, que re-valida el cache de licencia; si la
   licencia se suspende a media sesión, el siguiente request expulsa al usuario a la pantalla de bloqueo.
7. Si el servidor central no responde: con token vigente se mantiene el acceso; sin token,
   la política `strict` bloquea (la `grace` respeta el último estado permitido unas horas).

Implementación: `backend/src/services/licenseService.js`,
`backend/src/middleware/licenseMiddleware.js` y `requireAuth` en
`backend/src/middleware/authMiddleware.js`.

## Feature flags

Features: `whatsapp`, `meta_ads`, `google_calendar`, `ai`, `automations`, `advanced_reports`,
`premium_modules`. Los mounts premium se protegen en `server.js` con `requireFeature(...)`
(WhatsApp API, Meta, Calendarios, AI Agent, Reportes). El frontend puede leer
`GET /api/license/status` para conocer plan y features.

## Setup inicial del dueño

1. El instalador termina el deploy y genera un **setup token de un solo uso**.
2. El cliente llega a `https://su-app.onrender.com/setup?token=...`.
3. La app valida el token contra el servidor central (`/api/setup-token/verify`) y precarga
   `OWNER_EMAIL`.
4. El cliente crea su contraseña; la app consume el token (`/api/setup-token/consume`, un solo uso),
   crea el usuario owner local y valida la licencia antes de abrir sesión.

Sin servidor central configurado, el setup clásico (usuario + contraseña, solo si no existen
usuarios) sigue funcionando igual.

## Health check

`GET /health` responde:

```json
{ "ok": true, "app": "ristak", "version": "...", "client_id": "...", "installation_id": "..." }
```

El instalador lo usa para saber cuándo la app quedó lista (también es el `healthCheckPath` del
web service en Render). `GET /api/health` se mantiene para compatibilidad.

## Imagen Docker

```bash
docker build -t ristak .
docker run -p 10000:10000 -e DATABASE_URL=... -e JWT_SECRET=... ristak
```

- Multi-stage: build del frontend (Vite) + deps de producción del backend.
- Escucha en `0.0.0.0:$PORT` (Render inyecta `PORT`; default 10000).
- `HEALTHCHECK` integrado contra `/health`.
- Las tablas se crean/migran automáticamente al arrancar (igual que hoy).

El workflow `.github/workflows/docker-image.yml` publica en GHCR:
`main` → `ghcr.io/ristakoficial/ristak:stable`, `test` → `:beta` (más el tag del commit, que sirve
para canal `custom` o rollbacks). El instalador elige la imagen vía `RISTAK_DOCKER_IMAGE*`.

## Tests

```bash
cd backend && npm test
```

Cubren el cliente de licencias: modo standalone, licencia activa/suspendida, cache con token
temporal, política estricta sin red, feature flags, contrato de `/health` y setup tokens.
