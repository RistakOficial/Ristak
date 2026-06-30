# Render Blueprint Actual

Esta nota existe para evitar documentación duplicada y vieja. La guía principal está en [../DEPLOYMENT.md](../DEPLOYMENT.md).

## Estado Real Del `render.yaml`

El Blueprint actual define:

- Un `web` service llamado `ristak-app`.
- Runtime Node.
- Región `oregon`.
- Build de backend + frontend.
- Start command del backend.
- Una base PostgreSQL `ristak-db`.
- `DATABASE_URL` conectado desde esa base.
- `JWT_SECRET` generado por Render.
- Storage autoscaling habilitado para la base.

No define:

- Cron jobs separados de Render.
- `APP_URL`.
- `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID` ni `HIGHLEVEL_API_KEY`.
- Servicios frontend/backend separados.

Define:

- `diskSizeGB: 1` para que una base nueva arranque con 1 GB de storage.
  `storageAutoscalingEnabled` queda habilitado. Render no permite reducir disco,
  asi que un Blueprint sync puede fallar si una base existente ya fue aumentada
  manualmente por encima de 1 GB.

Los jobs automáticos viven dentro del backend. No hay cron services separados en
Render.

Los crons de sistema arrancan con el backend. Los crons de integraciones se
registran en `backend/src/jobs/integrationCronRegistry.js` y sólo se activan si
la integración está conectada localmente. Esa regla está documentada en
[INTEGRATION_CRON_RULES.md](./INTEGRATION_CRON_RULES.md).

Crons de integración actuales:

- Google Calendar: `backend/src/jobs/googleCalendarSync.cron.js`.
- Meta Ads/social: `backend/src/jobs/metaSync.cron.js`.
- Versiones Meta API: `backend/src/jobs/metaVersionCron.js`.
- HighLevel: `backend/src/jobs/highlevelSync.cron.js`.
- Stripe: `backend/src/jobs/stripePaymentPlans.cron.js`.
- Conekta: `backend/src/jobs/conektaPaymentPlans.cron.js`.
- Mercado Pago: `backend/src/jobs/mercadoPagoPaymentPlans.cron.js`.
- WhatsApp QR: `backend/src/jobs/whatsappQrWatchdog.cron.js`.

## Deploy

1. Render Dashboard -> **New +** -> **Blueprint**.
2. Selecciona el repo.
3. Render lee `render.yaml`.
4. Aplica el Blueprint.

No cambies nombres ni URLs en esta guía. Si necesitas renombrar servicios o base, hazlo directamente en `render.yaml` con cuidado porque el nombre de `fromDatabase.name` debe coincidir con la DB declarada.

## Dominio Y Frontend

Durante el build se crea:

```bash
frontend/.env.production
```

con:

```bash
VITE_API_URL=https://$RENDER_EXTERNAL_HOSTNAME
```

Eso hace que el frontend llame al mismo servicio Render donde corre el backend.

## Referencias Render

- [Blueprint YAML Reference](https://render.com/docs/blueprint-spec)
- [Environment variables and secrets](https://render.com/docs/configure-environment-variables/)
- [Deploys](https://render.com/docs/deploys/)
