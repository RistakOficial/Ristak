# Licenciamiento, instalación gestionada y Docker

Ristak se distribuye a clientes como **imagen Docker** (sin entregar el código fuente) y se instala
en la cuenta de Render de cada cliente desde el portal central
([ristak-installer](https://github.com/RistakOficial/ristak-installer)).

## Conceptos

- **Login local = identidad**: usuarios/contraseñas viven en la base de datos del cliente.
- **Licencia central = permiso comercial**: tras un login local correcto, la app valida contra el
  servidor central (`POST {LICENSE_SERVER_URL}/api/license/verify`). Sin licencia activa no se entra,
  aunque la contraseña local sea correcta.
- **Feature flags y límites = funciones disponibles y topes del plan**: el servidor central
  responde las features y `limits` del plan; el backend las valida en cada módulo premium
  (no basta ocultar botones).

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

### Standalone no significa aislado de las integraciones centrales

Licencia comercial e identidad técnica son contratos distintos. Una instalación creada
directamente desde `render.yaml`, sin variables de Installer, no valida plan ni suspensión,
pero puede usar el broker central para Google, Meta, WhatsApp, Mercado Pago, push, Bunny,
directorio móvil y dominios de Sites.

En el primer uso de una capacidad central, el backend:

1. genera una identidad Ed25519 propia y la guarda cifrada en `app_config`;
2. registra la URL pública ante `https://www.ristak.com` (o el broker central opcional);
3. responde un challenge recibido por `/api/central-broker/registration-proof` y firma un
   manifiesto ligado a esa URL y a la llave pública;
4. recibe credenciales técnicas de broker y las conserva cifradas en la misma base.

La URL central valida HTTPS, DNS y direcciones públicas antes de llamar al tenant. Un registro
de broker sólo autoriza rutas de integraciones: no sirve en `/api/license/verify`, no habilita
cancelación comercial ni administración de Render y no aparece como cliente o instalación de
negocio en los tableros de Installer. Si una instalación ya tiene `LICENSE_KEY` e
`INSTALLATION_ID`, esas credenciales administradas conservan prioridad y no se crea otra
identidad.

No hay un secret manual de enrolamiento ni una dependencia de arranque con Installer. Si el
broker central está temporalmente caído, el CRM, sus datos locales y las integraciones ya
materializadas continúan funcionando; una conexión OAuth nueva, una renovación que necesite al
proveedor central o la obtención inicial de configuración compartida espera a que vuelva el
servicio. El estado técnico se expone sanitizado en `/health`, sin llaves ni tokens.

## Stripe en instalaciones gestionadas

Stripe no se configura desde el portal central ni con OAuth. En cada instalación,
el usuario entra a **Configuración → Pagos → Stripe** y guarda manualmente las
credenciales de su propia cuenta de Stripe.

La configuración oficial usa:

- Publishable key de Stripe.
- Secret key creada por el usuario en su Stripe Dashboard.
- Webhook signing secret del endpoint de esa instalación.

Ristak sólo usa esas credenciales para crear y consultar cobros dentro de la
cuenta Stripe del usuario. Ristak no retiene fondos, no administra payouts, no
cobra en nombre de terceros y no actúa como marketplace.

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

Features principales: `dashboard`, `contacts`, `chat`, `appointments`, `payments`,
`reports`, `analytics`, `campaigns`, `sites`, `forms`, `ai_agent`, `automations`,
`whatsapp`, `email`, `integrations`, `team_access`, `mobile_app`, `developers`,
`meta_ads`, `google_calendar`, `advanced_reports`, `payment_plans`,
`subscriptions`, `web_analytics` y las variantes de cobro de calendarios
(`calendar_payments`, `calendar_payment`, `calendar_booking_payments`).

`web_analytics` tiene además una restricción comercial por plan: sólo se
considera habilitada en `professional`/`pro` (y el alias superior `premium`).
`basic` y `medium` no muestran ni consultan sesiones, visitantes, páginas vistas,
tráfico u otras métricas web, aunque un flag heredado llegue accidentalmente en
`true`. El frontend aplica la misma regla para no pintar esos bloques y el
backend la vuelve a validar antes de entregar datos.

Todo cobro que dependa de una pasarela también es exclusivo de
`professional`/`pro` (y `premium`): `payment_checkout`,
`payment_automations`, `payment_gateways`, `highlevel_payments`, `conekta`,
`mercadopago`, `rebill`, `payment_links`, `saved_payment_methods`,
`payment_plans`, `subscriptions` y `payment_webhooks`. `basic` y `medium`
conservan el módulo `payments` para registrar efectivo, transferencia, depósito,
comprobantes, impuestos y seguimiento offline, pero esos flags online se fuerzan
a `false` aunque una licencia o un override heredado los mande en `true`.

Subfeatures que no deben heredarse del módulo general: `payment_checkout`,
`payment_gateways`, `payment_automations`, `highlevel_integration`,
`whatsapp_api`, `whatsapp_templates` y `trigger_links`.

El backend valida el plan en varias capas:

- `requireActiveLicense` bloquea instalaciones sin licencia activa.
- `requireFeature(...)` bloquea features puntuales como `payment_plans`,
  `subscriptions`, `calendar_payments`, `web_analytics` o `developers`.
- `requireModuleAccess(...)` valida permiso del usuario **y** feature comercial
  del módulo mediante `hasModuleFeature(...)`. Esto evita que un admin entre a
  Pagos, Sites, Developers, Integraciones o Usuarios si el plan de la cuenta no
  los incluye.
- Superficies que no pasan por navegación normal (`/api/external`, `/api/mcp`,
  búsqueda global, crons y automatizaciones publicadas) tienen gates propios por
  recurso para no depender de botones ocultos en frontend.

Si el portal central responde `allowed=true` pero sin un objeto `features` válido,
o responde un objeto parcial, las features premium no incluidas fallan cerradas
hasta recibir flags explícitos. La base del CRM puede seguir abierta, pero módulos
comerciales como Pagos, Sites, Developers, Integraciones, WhatsApp, Email, Meta,
Google Calendar, Automatizaciones, IA, Reportes avanzados, planes de pago,
suscripciones y analíticas web quedan apagados.

El frontend puede leer `GET /api/license/status` para conocer plan, features y límites.

El plan `basic` puede tener `conversational_ai=true` y `app_assistant_ai=false`. En ese caso
la app permite entrar al Agente conversacional, oculta Ristak AI general y aplica
`limits.conversational_agents.max_agents=1` al crear agentes. El límite se valida en backend
en `backend/src/services/conversationalAgentService.js`; la UI solo anticipa el bloqueo.

### Gates por superficie

- API tokens legacy (`/api/auth/api-token`) y la pantalla nueva de Developers
  requieren `settings_api_access`/`developers`.
- `/api/external` requiere `developers` y además valida cada endpoint o tabla:
  pagos requieren `payments`, planes `payment_plans`, reportes `reports`,
  campañas `campaigns`, contactos `contacts`, HighLevel `integrations`, etc.
- `/api/mcp` requiere `developers`; las tools se listan/ejecutan solo si las
  features necesarias están activas. Las tools genéricas de tablas aplican el
  mismo mapeo por recurso.
- `/api/sites` requiere `sites`; el checkout público y cualquier bloque/gate de
  cobro en Sites requiere `payment_checkout`, y la preparación de parcialidades requiere
  `payment_plans`.
- Calendarios base requieren `appointments`. El formulario básico para agendar
  vive dentro de calendarios, pero usar un formulario personalizado de Sites
  dentro del calendario requiere `forms` y `sites`; si el plan baja, el público
  vuelve al formulario básico y el backend limpia/bloquea esa configuración.
- `/api/highlevel` requiere `highlevel_integration`; sus endpoints operativos además piden
  el módulo real (`contacts`, `chat`, `payments`, `settings_users`) y las
  parcialidades piden `payment_plans`.
- Campos personalizados, campos variables y etiquetas son capacidades base del
  CRM: requieren el permiso de usuario `settings_custom_fields`/`contacts`, pero
  no una feature comercial. Los enlaces de disparo son distintos y requieren
  `trigger_links` tanto en la navegación como en `/api/settings/trigger-links`.
- Inscribir un contacto en automatizaciones, desde ficha, chat o acciones
  masivas, requiere `automations` en frontend y backend. La ficha iOS aplica la
  misma regla.
- WhatsApp QR sigue bajo `whatsapp`; la conexión API, sus acciones operativas y
  los envíos API requieren `whatsapp_api`. La administración, consulta y envío de
  plantillas requieren `whatsapp_templates`.
- Configuración > Pagos muestra checkout, pasarelas y automatizaciones solo con
  `payment_checkout`, `payment_gateways` y `payment_automations`,
  respectivamente. El job de automatizaciones de pago valida
  `payment_automations`, no el módulo genérico `payments`.
- Crear o enviar links exige `payment_links` en las rutas de Stripe, Conekta,
  Mercado Pago, CLIP, Rebill y HighLevel. La misma compuerta aplica al agente
  conversacional, asistente de app y MCP; ocultar el botón no sustituye el
  bloqueo del servidor. Las URL públicas de links ya creados siguen resolviendo
  para no dejar al cliente final con un cobro roto después de un downgrade.
- Automatizaciones validan features al guardar, publicar, probar y ejecutar:
  nodos WhatsApp requieren `whatsapp`, Email requiere `email`, Meta/Messenger/
  Instagram requiere `campaigns`, formularios `forms`, pagos `payments`,
  webhooks `developers` e IA `ai_agent`.
- `/movil` filtra secciones y cargas de datos por feature; la caché móvil incluye
  la matriz de features para no mostrar datos viejos tras un downgrade.
- Crons de sistema e integraciones llaman `canRunBackgroundJob(...)` antes de
  enviar mensajes, sincronizar integraciones o cobrar parcialidades.

## Setup inicial del dueño (automático desde el portal)

1. El instalador termina el deploy y genera un **setup token de un solo uso**.
2. El cliente llega a `https://su-app.onrender.com/sso?token=...`.
3. La app valida el token contra el servidor central. Si el dueño tiene contraseña en el portal,
   la respuesta incluye únicamente su **hash PBKDF2**; la contraseña en claro nunca viaja.
4. La app crea al owner, consume el token, valida la licencia y abre el dashboard. Si la cuenta
   usa solamente Google, genera una credencial local aleatoria que nadie conoce: Ristak no pide,
   recibe ni guarda la contraseña de Google.
5. Si Render o el portal central todavía están estabilizándose, backend y frontend reintentan
   automáticamente sin sacar al cliente de **Preparando tu cuenta**.
6. En una instalación gestionada nunca se muestra un formulario para **crear otra contraseña**.
   Si el enlace expiró o falta, el dueño puede usar **Continuar con Google** o el correo y la
   contraseña vigentes del Installer. La contraseña global de soporte no puede activar una cuenta
   de cliente.

Sin servidor central configurado, el setup clásico independiente (usuario + contraseña, solo si
no existen usuarios) sigue funcionando igual.

Además, **Continuar con Google** funciona en modo standalone. El callback central devuelve a
`/sso` un handoff de un solo uso con el perfil verificado: si no existen usuarios crea al primer
administrador; si ya existen, sólo permite entrar a un usuario local activo con el mismo correo.
La instalación nunca recibe la contraseña de Google ni el client secret central.

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

El workflow `.github/workflows/docker-image.yml` publica en GHCR el alias
`ghcr.io/ristakoficial/ristak:stable` y un tag inmutable por commit. El Instalador puede
mostrar el alias estable, pero al actualizar una instalación debe usar el tag del commit
recibido por webhook: así dos builds simultáneos no pueden hacer que Render descargue una
imagen distinta de la autorizada. Los pushes normales actualizan solo Test; En vivo requiere
la promoción manual desde Installer. El instalador elige la imagen vía `RISTAK_DOCKER_IMAGE*`.

## Tests

```bash
cd backend && npm test
```

Cubren el cliente de licencias: modo standalone, registro técnico independiente, licencia
activa/suspendida, cache con token temporal, política estricta sin red, feature flags, contrato
de `/health`, login Google por handoff y setup tokens.
