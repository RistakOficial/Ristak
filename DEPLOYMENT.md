# Deploy En Render

> Documento operativo historico. Para ubicar la documentacion vigente, empieza en
> [`docs/README.md`](docs/README.md). La guia especifica de Render sigue en
> [`docs/DEPLOY-RENDER.md`](docs/DEPLOY-RENDER.md).

Esta guía refleja el `render.yaml` actual del repo. No hay cron jobs separados en Render: las sincronizaciones automáticas corren dentro del backend con `node-cron`.

## Requisitos

- Cuenta de Render.
- Repo conectado a Render como Blueprint.
- Para producción real, usa instancia web y Postgres de pago o al menos entiende los límites del plan free. Render documenta que las bases Postgres free expiran después de 30 días y no tienen backups.

Referencias oficiales:
- [Render Blueprint YAML Reference](https://render.com/docs/blueprint-spec)
- [Render environment variables](https://render.com/docs/configure-environment-variables/)
- [Render free limits](https://render.com/docs/free)

## Deploy Con Blueprint

1. En Render, ve a **New +** -> **Blueprint**.
2. Conecta este repositorio.
3. Render detecta `render.yaml`.
4. Click en **Apply**.

Render creará:
- Web service `ristak-app`.
- PostgreSQL `ristak-db`.
- `DATABASE_URL` apuntando a la base creada.
- `JWT_SECRET` generado por Render desde el Blueprint.

Eso es suficiente para arrancar el producto completo. Cuando Google, Meta, WhatsApp Meta
Direct, Mercado Pago, push, Bunny, directorio móvil o dominios de Sites necesitan el servicio
central, la instalación se registra sola mediante una prueba criptográfica de control de su URL.
No se copian credenciales de Installer al Blueprint ni se requieren variables manuales de Bunny.
Este registro técnico no crea una licencia comercial ni habilita tareas administrativas de
Installer sobre la cuenta de Render.

### Storage De Postgres

El Blueprint fija `diskSizeGB: 1` y habilita `storageAutoscalingEnabled`.
Esto hace que una base nueva arranque con 1 GB de storage y pueda crecer
automaticamente cuando Render detecte uso alto.

Importante: Render no permite reducir el disco de una base existente. Si una
base ya fue aumentada manualmente a 15 GB o mas, el siguiente Blueprint sync
puede fallar intentando bajarla a 1 GB.

## Qué Hace El Build

`render.yaml` ejecuta:

```bash
npm install --prefix backend &&
rm -rf frontend/node_modules frontend/.vite &&
npm cache clean --force &&
npm install --include=dev --prefix frontend &&
echo "VITE_API_URL=https://$RENDER_EXTERNAL_HOSTNAME" > frontend/.env.production &&
NODE_ENV=production npm run build --prefix frontend
```

Puntos importantes:
- El frontend queda compilado en `frontend/dist`.
- `VITE_API_URL` apunta al mismo servicio Render.
- El backend sirve `frontend/dist` cuando `NODE_ENV=production`.
- No edites manualmente `frontend/.env.production` en Render; se genera durante el build.

## Start Command

```bash
npm start --prefix backend
```

El backend arranca `backend/src/server.js`, registra las rutas API, sirve el frontend en producción y activa estos jobs internos:

- `metaSync.cron.js`: cada hora en minuto `7`.
- `highlevelSync.cron.js`: cada hora en minuto `17`.
- `metaVersionCron.js`: día 1 de cada mes a las 03:00, timezone `America/Mexico_City`.

Además, el backend revisa la versión de Meta API al arrancar. Con auto-deploy activo, cada push a la rama conectada provoca deploy y dispara esa revisión.

## Variables De Entorno

Definidas por el Blueprint:

```bash
NODE_ENV=production
DATABASE_URL=<connection string de ristak-db>
JWT_SECRET=<generado por Render>
```

Render también expone variables runtime como `PORT`, `RENDER_EXTERNAL_HOSTNAME` y `RENDER_EXTERNAL_URL`.

Opcionales:

```bash
ENCRYPTION_MASTER_KEY=<hex de 32 bytes o más>
TRACKING_DOMAIN=<dominio personalizado, sin https://>
META_API_VERSION=<version fija opcional, ej. v25.0>
```

Normalmente no necesitas declarar credenciales de HighLevel, Meta Ads o Stripe en Render. Stripe se configura manualmente desde Settings con la cuenta propia del usuario, usando Secret keys guardadas cifradas en el backend.

`CENTRAL_BROKER_URL` es opcional y sólo existe para apuntar a otro broker en desarrollo o una
infraestructura privada. Si falta, producción usa el portal central oficial. No es un secret.

Si defines `META_API_VERSION`, la app queda fijada en esa versión y no hace auto-update de versión Meta. Déjala vacía para que use la DB y las revisiones automáticas.

## Primer Acceso

1. Abre la URL del servicio, por ejemplo `https://ristak-app.onrender.com`.
2. Si no hay usuarios, la app redirige a `/setup`.
3. Crea el primer usuario.
   También puedes usar **Continuar con Google**: el portal central verifica la cuenta y devuelve
   un handoff de un solo uso; si la instalación está vacía crea al primer administrador.
4. Entra a **Configuración -> HighLevel** y guarda `Access Token` + `Location ID`.
5. Conecta Meta Ads, pagos, calendarios y tracking desde las pestañas de Settings.

## HighLevel

La integración HighLevel se guarda desde UI. Al sincronizar:

- Contactos se guardan en `contacts`.
- Citas se guardan en `appointments`.
- Invoices/pagos se guardan en `payments`.
- Webhooks se verifican/actualizan en producción cuando existe `RENDER_EXTERNAL_URL`.

## Meta Ads

En **Configuración -> Meta Ads** puedes:

- Guardar token, cuenta de anuncios, app id/secret opcionales y pixel id.
- Cargar cuentas y pixels desde Meta.
- Sincronizar ads manualmente.
- Dejar que el cron actualice datos recientes cada hora.

Meta Ads no usa OAuth centralizado. Stripe tampoco usa un flujo centralizado en Ristak: cada usuario configura su propia cuenta desde Settings con las llaves de su Stripe Dashboard.

## Tracking Web

Para tracking en producción:

1. Usa dominio personalizado o CNAME que apunte al servicio Render.
2. Abre Ristak desde ese dominio.
3. Ve a **Configuración -> Rastreo Web**.
4. Sincroniza el snippet `rstktrack` hacia HighLevel o copia el `<script>`.

Más detalle: [docs/TRACKING_PIXEL.md](./docs/TRACKING_PIXEL.md)

## Troubleshooting

### Build falla en frontend

Revisa logs de Render. El build real corre `npm install --include=dev --prefix frontend` y luego `npm run build --prefix frontend`.

### La app no conecta con la DB

Verifica que `DATABASE_URL` exista y venga de `ristak-db` en el Blueprint.

### Login vuelve a setup

Significa que no hay usuarios en la tabla `users`. Crea el primer usuario en `/setup`.

### Error de desencriptado

La clave de cifrado cambió o la DB no conserva la clave en `app_config`. Vuelve a guardar tokens desde Settings. Para respaldo estable, define `ENCRYPTION_MASTER_KEY`.

### Webhooks usan URL local

En Render debe existir `RENDER_EXTERNAL_URL`. Si estás local, el backend usa `http://localhost:3001`.

## Actualizaciones

Con auto-deploy activo, cada push a la rama conectada dispara build y deploy. Si usas fork, sincroniza tu fork antes de hacer push.

El repo también incluye `.github/workflows/meta-api-version.yml` para revisar la versión de Meta API en cada push, el día 1 de cada mes y manualmente desde GitHub Actions. Para que ese workflow actualice la DB directamente, configura `DATABASE_URL` como secret de GitHub; si no existe, el job se salta sin fallar y Render lo cubre al arrancar.
