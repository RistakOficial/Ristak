# Contexto Maestro - Ristak App

Este archivo es la fuente de verdad operativa del proyecto. Actualizado contra el código actual el 2026-05-28.

## Reglas Críticas

1. No crear módulos duplicados si ya existe uno equivalente.
2. No dejar código muerto, imports fantasma ni componentes huérfanos.
3. No usar `alert`, `confirm` ni `prompt`; usar `NotificationContext` y modales propios.
4. No implementar OAuth centralizado para integraciones externas. Cada instancia usa credenciales propias del usuario.
5. No contar pagos `refunded`, `cancelled`, `void`, `failed` o `pending` como ingresos.
6. No borrar Custom Values en HighLevel cuando el usuario limpia campos en Ristak; solo limpiar estado local/DB de Ristak.
7. Mantener esta documentación sincronizada cuando cambien rutas, schema, deploy o arquitectura.

## Stack Real

Frontend:

- React 19.0.0
- TypeScript 5.7
- Vite 5.4
- React Router DOM 7.1
- Recharts 2.15
- Lucide React, React Icons, Radix Dropdown
- CSS Modules + Tailwind utilities

Backend:

- Node.js con ES Modules
- Express 4.21
- SQLite local cuando no existe `DATABASE_URL`
- PostgreSQL en Render cuando existe `DATABASE_URL`
- `pg`, `sqlite3`, `node-fetch`, `node-cron`, `luxon`, `stripe`

Deploy:

- Render Blueprint en `render.yaml`
- Un web service sirve API y frontend compilado
- `frontend/dist` se sirve desde Express cuando `NODE_ENV=production`

## Estructura

```txt
/
├── backend/
│   ├── package.json
│   ├── migrations/
│   └── src/
│       ├── config/
│       │   ├── database.js
│       │   └── constants.js
│       ├── controllers/
│       ├── jobs/
│       │   ├── metaSync.cron.js
│       │   ├── highlevelSync.cron.js
│       │   └── metaVersionCron.js
│       ├── routes/
│       ├── services/
│       ├── startup/
│       ├── utils/
│       └── server.js
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── components/
│       ├── contexts/
│       ├── hooks/
│       ├── pages/
│       ├── services/
│       ├── styles/
│       ├── theme/
│       ├── types/
│       ├── utils/
│       ├── App.tsx
│       └── main.tsx
├── docs/
├── render.yaml
├── start-local.sh
└── package.json
```

## Frontend

Rutas principales en `frontend/src/App.tsx`:

- `/setup`
- `/login`
- `/dashboard`
- `/reports`
- `/campaigns`
- `/transactions`
- `/contacts`
- `/appointments`
- `/analytics`
- `/settings/*`

Settings (`frontend/src/pages/Settings/Settings.tsx`):

- `/settings/highlevel`
- `/settings/meta-ads`
- `/settings/calendars`
- `/settings/tracking`
- `/settings/payments`
- `/settings/costs`
- `/settings/account`

Contexts:

- `AuthContext`: login, setup inicial, token local, `locationId`, `accessToken`.
- `DateRangeContext`: rango global.
- `ThemeContext`: tema.
- `NotificationContext`: toasts y modal global.
- `TimezoneContext`: timezone HighLevel.
- `LabelsContext`: labels custom de HighLevel.

Services frontend:

- `apiClient.ts`: agrega `/api` automáticamente si la ruta no lo trae.
- `dashboardService.ts`
- `contactsService.ts`
- `reportsService.ts`
- `transactionsService.ts`
- `campaignsService.ts`
- `calendarsService.ts`
- `trackingService.ts`
- `analyticsService.ts`
- `paymentMethodsService.ts`
- `costsService.ts`
- `hiddenContactsService.ts`
- `highLevelService.ts`
- `globalSearchService.ts`

## Backend

`backend/src/server.js`:

- Configura CORS, JSON 10 MB y `trust proxy`.
- Expone `/api/health`.
- Monta rutas API.
- Monta `/webhook` y `/webhooks`.
- Monta tracking en `/` y `/api/tracking`.
- Sirve `frontend/dist` en producción.
- Inicializa encryption key, setup auth check, versión Meta API, verificación webhooks y cron jobs.

## Base De Datos

`backend/src/config/database.js` elige DB así:

- `DATABASE_URL` presente -> PostgreSQL.
- `DATABASE_URL` ausente -> SQLite en `./ristak.db`.

Tablas creadas por inicialización:

- `highlevel_config`
- `app_config`
- `contacts`
- `payments`
- `appointments`
- `meta_config`
- `meta_ads`
- `whatsapp_attribution`
- `meta_api_version`
- `payment_methods`
- `sessions`
- `users`
- `hidden_contact_filters`
- `costs`

Migraciones inline agregan columnas opcionales como `ghl_invoice_id`, campos Stripe/invoice, timezone Meta, pixel Meta, `match_type`, etc.

## Auth

No hay usuario admin por defecto.

Flujo:

1. `GET /api/auth/setup` revisa si existe algún usuario.
2. Si no existe, frontend redirige a `/setup`.
3. `POST /api/auth/setup` crea el primer usuario y devuelve token.
4. Login usa `POST /api/auth/login`.
5. Token JWT se firma con `JWT_SECRET` o fallback de desarrollo.

En producción debe existir `JWT_SECRET`. `render.yaml` lo genera con `generateValue: true`.

## Integraciones

### HighLevel

Rutas base:

- `/api/highlevel/*`
- `/api/calendars/*`
- `/webhook/*`

Funcionalidad:

- Configuración de token/location.
- Sincronización manual y automática.
- Contactos, citas, pagos/invoices.
- Stripe config e invoices/Text2Pay.
- Usuarios del location.
- Custom labels.
- Webhooks.

### Meta Ads

Rutas base:

- `/api/meta/*`

Funcionalidad:

- Guardar config Meta.
- Cargar cuentas de anuncios.
- Cargar pixels.
- Sync manual y cron.
- Campañas, creatives, media, spend, funnel y métricas.
- Versión de Meta API guardada en DB y revisada al arrancar, en GitHub Actions y mensualmente.

### Tracking Web

Rutas:

- `/snip.js`
- `/collect`
- `/sync-visitor`
- `/link-visitor`
- `/api/tracking/*`

Comportamiento:

- Pixel dinámico por host.
- Eventos insertados uno por fila en `sessions`.
- SPA tracking con History API.
- `visitor_id` en localStorage, `session_id` en sessionStorage.
- Vinculación con HighLevel por `rkvi_id`.
- Geo IP con `ip-api.com` para IPs públicas.

Documentación completa: `docs/TRACKING_PIXEL.md`.

### Calendarios

Backend:

- `backend/src/services/highlevelCalendarService.js`
- `backend/src/controllers/calendarsController.js`
- `backend/src/routes/calendars.routes.js`

Frontend:

- `frontend/src/pages/Appointments/Appointments.tsx`
- `frontend/src/services/calendarsService.ts`
- `AppointmentModal`
- `BlockedSlotModal`

Soporta vistas mes/semana/día, citas, slots libres, blocked slots y configuración de calendario.

## Cron Jobs Internos

Todos se inician en `server.js`; no son servicios cron de Render.

- `metaSync.cron.js`: cada hora minuto `7`, actualiza ads recientes.
- `highlevelSync.cron.js`: cada hora minuto `17`, sync completo HighLevel en modo silencioso.
- `metaVersionCron.js`: día 1 de cada mes a las 03:00, revisa versión Meta API.

## Rutas Backend

### Auth

- `GET /api/auth/setup`
- `POST /api/auth/setup`
- `POST /api/auth/login`
- `POST /api/auth/verify`
- `POST /api/auth/change-password`
- `POST /api/auth/change-username`
- `GET /api/auth/me`

### Dashboard

- `GET /api/dashboard/metrics`
- `GET /api/dashboard/chart-data`
- `GET /api/dashboard/financial-overview`
- `GET /api/dashboard/roas`
- `GET /api/dashboard/new-customers`
- `GET /api/dashboard/visitors`
- `GET /api/dashboard/leads`
- `GET /api/dashboard/appointments`
- `GET /api/dashboard/sales`
- `GET /api/dashboard/storage-status`
- `GET /api/dashboard/traffic-sources`
- `GET /api/dashboard/funnel`

### HighLevel

- `POST /api/highlevel/test-connection`
- `POST /api/highlevel/test`
- `POST /api/highlevel/config`
- `GET /api/highlevel/config`
- `DELETE /api/highlevel/config`
- `GET /api/highlevel/config/reveal/api_token`
- `GET /api/highlevel/integration-status`
- `POST /api/highlevel/refresh-location`
- `POST /api/highlevel/sync`
- `GET /api/highlevel/sync/progress`
- `POST /api/highlevel/sync-custom-values`
- `POST /api/highlevel/sync-contacts`
- `GET /api/highlevel/custom-labels`
- `POST /api/highlevel/custom-labels`
- `POST /api/highlevel/contacts/search`
- `GET /api/highlevel/contacts/:id`
- `GET /api/highlevel/users`
- `POST /api/highlevel/users/by-ids`
- `POST /api/highlevel/stripe-config`
- `GET /api/highlevel/stripe-config`
- `POST /api/highlevel/invoice-config`
- `GET /api/highlevel/products`
- `GET /api/highlevel/products/:productId/prices`
- `POST /api/highlevel/invoices`
- `POST /api/highlevel/invoices/:invoiceId/send`
- `POST /api/highlevel/invoices/:invoiceId/record-payment`
- `POST /api/highlevel/invoices/:invoiceId/sync`
- `POST /api/highlevel/text2pay`
- `GET /api/highlevel/payment-methods/contact/:contactId`
- `POST /api/highlevel/payment-methods/charge`

### Meta

- `POST /api/meta/config`
- `GET /api/meta/config`
- `GET /api/meta/config/reveal/access_token`
- `GET /api/meta/verify-token`
- `GET /api/meta/ad-accounts`
- `GET /api/meta/pixels`
- `GET /api/meta/custom-values`
- `POST /api/meta/save-and-sync`
- `POST /api/meta/save-pixel-token`
- `POST /api/meta/sync`
- `POST /api/meta/sync-from-highlevel`
- `GET /api/meta/sync/progress`
- `GET /api/meta/sync/status`
- `POST /api/meta/update-recent`
- `GET /api/meta/campaigns`
- `GET /api/meta/creative-preview/:creativeId`
- `GET /api/meta/ad-creative-media/:adId`
- `GET /api/meta/spend-over-time`
- `GET /api/meta/contacts`
- `GET /api/meta/leads-over-time`
- `GET /api/meta/appointments-over-time`
- `GET /api/meta/visitors-over-time`
- `GET /api/meta/funnel-metrics`

### Calendarios

- `GET /api/calendars`
- `GET /api/calendars/events`
- `GET /api/calendars/events/:eventId`
- `POST /api/calendars/appointments`
- `PUT /api/calendars/appointments/:id`
- `DELETE /api/calendars/events/:id`
- `GET /api/calendars/:id/free-slots`
- `GET /api/calendars/:calendarId/blocked-slots`
- `POST /api/calendars/block-slots`
- `PUT /api/calendars/block-slots/:id`
- `DELETE /api/calendars/block-slots/:id`
- `GET /api/calendars/:id`
- `PUT /api/calendars/:id`

### Tracking

- `GET /snip.js`
- `POST /collect`
- `POST /sync-visitor`
- `POST /link-visitor`
- `GET /api/tracking/sessions`
- `GET /api/tracking/sessions/:id`
- `PUT /api/tracking/sessions/:id`
- `DELETE /api/tracking/sessions`
- `GET /api/tracking/config`
- `POST /api/tracking/configure`
- `POST /api/tracking/analytics-preference`
- `POST /api/tracking/visitor-source-preference`
- `GET /api/tracking/visitors-by-ad`
- `GET /api/tracking/visitors-by-period`
- `GET /api/tracking/visitors`
- `GET /api/tracking/contacts-by-date`

### Otros

- Reports: `/api/reports/*`
- Contacts: `/api/contacts/*`
- Transactions: `/api/transactions/*`
- Integrations: `GET /api/integrations/status`
- Attribution: `/api/attribution/fallback/*`
- Settings: `GET /api/settings/timezone`
- Payment methods: `/api/payment-methods/*`
- Costs: `/api/costs/*`
- Maintenance: `POST /api/maintenance/fix-visitor-ids`
- Hidden contacts: `/api/hidden-contacts/*`
- Global search: `/api/search/global`
- Webhook config: `/api/webhook-config/*`
- Webhooks: `/webhook/contact`, `/webhook/payment`, `/webhook/refund`, `/webhook/appointment`, `/webhook/appointment/showed`, `/webhook/whatsapp/attribution`, `/webhook/invoice`

## Configuración

Variables relevantes:

- `NODE_ENV`
- `PORT`
- `DATABASE_URL`
- `JWT_SECRET`
- `ENCRYPTION_MASTER_KEY`
- `RENDER_EXTERNAL_URL`
- `TRACKING_DOMAIN`
- `PUBLIC_URL` legacy en `constants.js`
- `VITE_API_URL` para frontend

Uso normal:

- Local: sin `DATABASE_URL`, SQLite.
- Render: `DATABASE_URL` desde Blueprint.
- Frontend producción: `render.yaml` genera `frontend/.env.production`.

## Deploy

`render.yaml` actual:

- Crea web service `ristak-app`.
- Crea DB `ristak-db`.
- Genera `JWT_SECRET`.
- Conecta `DATABASE_URL`.
- Build instala backend/frontend y compila frontend.
- Start corre `npm start --prefix backend`.

Guía: `DEPLOYMENT.md`.

## Comandos Locales

Instalar:

```bash
npm install --prefix backend
npm install --prefix frontend
```

Arrancar:

```bash
bash start-local.sh
```

Build frontend:

```bash
npm run build --prefix frontend
```

Backend:

```bash
npm start --prefix backend
```

## Documentos Específicos

- `README.md`: resumen y quickstart.
- `DEPLOYMENT.md`: Render.
- `docs/TRACKING_PIXEL.md`: pixel y `sessions`.
- `docs/PIXEL_SETUP.md`: setup simple del pixel.
- `WHATSAPP_AD_ATTRIBUTION.md`: webhook WhatsApp actual.
- `backend/src/services/README_CALENDARS.md`: calendario backend.
- `frontend/src/pages/Appointments/README.md`: citas frontend.

## Riesgos Técnicos Conocidos

- Algunos servicios frontend hacen `fetch` directo y otros usan `apiClient`; hay que cuidar `VITE_API_URL`.
- `backend/src/config/constants.js` mantiene `PUBLIC_URL` default `http://localhost:3002`, pero la app real usa puerto backend `3001`.
- `WHATSAPP_AD_ATTRIBUTION.md` documenta que el handler actual no parsea `<<ad_id>>`; si se requiere, hay que implementarlo.
- `sessions` no tiene métricas agregadas como `pageviews_count` o `is_bounce`; Analytics debe calcular desde filas/eventos reales.
