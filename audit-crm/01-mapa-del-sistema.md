# Mapa del Sistema — Ristak

> Documento de referencia "qué existe". Inventario completo derivado del corpus de auditoría: módulos, rutas y endpoints, entidades de base de datos, integraciones externas, dependencias entre módulos, procesos automáticos, variables de entorno, roles/permisos y flujos de usuario.
>
> Arquitectura general: producto SaaS multi-instalación. **El Installer (portal central)** valida licencias y provisiona, para cada cliente, una copia aislada de la **app por-cliente** (frontend Vite + backend Node) con su propia base de datos y servicio Render. El aislamiento entre clientes es a nivel de infraestructura (DB + instalación Render separadas). Dentro de una instalación, el aislamiento es por roles. Producción corre PostgreSQL; SQLite es solo desarrollo local.

---

## 1. Módulos

Inventario de los módulos auditados, qué intenta hacer cada uno y sus archivos clave.

### App por-cliente (CRM)

| # | Módulo | Qué intenta hacer | Archivos clave |
|---|--------|-------------------|----------------|
| 1 | **Autenticación / login / setup / SSO / JWT** | Login local (usuario/email/teléfono + password PBKDF2), creación del primer usuario vía `/setup` con token del Installer, SSO desde el portal (`/sso?token=`), JWT casero HMAC-SHA256 (sesión 30 días), cambio de password/username, perfil y API tokens. | `backend/src/controllers/authController.js`, `backend/src/middleware/authMiddleware.js`, `backend/src/utils/auth.js`, `backend/src/routes/auth.routes.js`, `frontend/src/contexts/AuthContext.tsx`, `frontend/src/pages/Login/Login.tsx`, `Setup.tsx`, `Sso.tsx` |
| 2 | **Licenciamiento y feature flags (lado app)** | Conecta la app con el portal para validar la licencia comercial y exponer feature flags por plan; cachea el estado de licencia; aplica `requireFeature` a 8 routers premium. | `backend/src/services/licenseService.js`, `backend/src/middleware/licenseMiddleware.js`, `backend/src/routes/license.routes.js`, `frontend/src/utils/accessControl.ts` |
| 3 | **Multi-tenancy, roles, aislamiento de datos** | Roles `admin`/`employee` con acceso por módulo (`access_config` JSON); `requireModuleAccess` router por router; filtros de "contactos ocultos". | `backend/src/middleware/userAccessMiddleware.js`, `backend/src/utils/userAccess.js`, `backend/src/utils/hiddenContactsFilter.js`, `backend/src/controllers/userAccessController.js` |
| 4 | **Contactos: CRUD, dedup, identidad, custom fields, tags, bulk** | CRUD manual, dedup por teléfono/email, fusión por número, identidad multi-teléfono, campos personalizados, etiquetas, acciones masivas (plantillas WhatsApp / enrolamiento), recálculo de stats. | `backend/src/controllers/contactsController.js`, `backend/src/services/contactIdentityService.js`, `contactBulkActionsService.js`, `contactCustomFieldDefinitionsService.js`, `frontend/src/pages/Contacts/Contacts.tsx` |
| 5 | **Citas y calendarios locales** | Calendarios Ristak con horarios/slots/formularios públicos; agendar/editar/cancelar citas; estados; recordatorios WhatsApp; eventos de conversión. Fuente de verdad local, espejo a GHL/Google. | `backend/src/controllers/calendarsController.js`, `backend/src/services/localCalendarService.js`, `appointmentRemindersService.js`, `frontend/src/components/common/AppointmentModal/AppointmentModal.tsx`, `frontend/src/pages/Appointments/Appointments.tsx` |
| 6 | **Integración Google Calendar** | OAuth handoff cifrado vía Installer; vinculación por-calendario; push de citas a Google; pull on-demand. | `backend/src/services/googleCalendarService.js`, `calendarsController.js`, `frontend/src/pages/Settings/CalendarsConfiguration.tsx` |
| 7 | **Integración HighLevel (GHL)** | Sync bidireccional de contactos, citas, productos, invoices/pagos y conversaciones vía Private Integration Token; cron horario + webhooks. | `backend/src/services/ghlClient.js`, `highlevelSyncService.js`, `highlevelConversationsSyncService.js`, `invoicesSyncService.js`, `backend/src/controllers/highlevelController.js` |
| 8 | **Integración Meta Ads** | System User Token; sync de métricas de anuncios (35 meses); probador de Pixel/CAPI; "Campaign Builder" (no ejecuta campañas reales). | `backend/src/controllers/metaController.js`, `metaAdsService.js`, `metaCampaignBuilderService.js`, `metaVersionService.js`, `frontend/src/pages/Settings/MetaAdsIntegration.tsx` |
| 9 | **WhatsApp (YCloud + QR/Baileys + Meta directo)** | Conexión por API oficial (YCloud), QR no oficial (Baileys) y Meta directo; envío/recepción multimedia, plantillas, atribución Click-to-WhatsApp, drip anti-bloqueo, watchdog. | `backend/src/services/whatsappApiService.js`, `whatsappQrService.js`, `whatsappQrDripService.js`, `messageTemplatesService.js`, `backend/src/controllers/webhooksController.js` |
| 10 | **Pagos Stripe** | Config (key cifrada / Connect-OAuth), links de pago públicos, planes de parcialidades, suscripciones, conciliación por webhook firmado, crons de cobro. | `backend/src/services/stripePaymentService.js`, `subscriptionsService.js`, `paymentFlowService.js`, `frontend/src/pages/PublicPayment/PublicPayment.tsx` |
| 11 | **MercadoPago, Conekta, pago público, facturación, automatizaciones de pago** | Cobros MP/Conekta, links, parcialidades, suscripciones (MP), página `/pay/:id`, facturación Gigstack, automatizaciones por WhatsApp (recordatorio/comprobante/fallido). | `backend/src/services/mercadoPagoPaymentService.js`, `conektaPaymentService.js`, `paymentAutomationsService.js`, `gigstackInvoiceService.js` |
| 12 | **Automatizaciones (motor, editor, triggers, enrollment)** | Motor de flujos (nodos+aristas) que inscribe contactos por evento; esperas, condiciones, variables, acciones; editor React con validación; scheduler 20s. | `backend/src/services/automationEngine.js`, `automationsService.js`, `automationFlowValidation.js`, `frontend/src/pages/Automations/editor/nodeRegistry.tsx`, `AutomationEditor.tsx` |
| 13 | **Agentes IA (asistente app + agente conversacional)** | Asistente interno por categorías (SDK `@openai/agents`) y agente conversacional que auto-responde mensajes entrantes multicanal; multi-proveedor con API key por cuenta. | `backend/src/agents/conversational/runner.js`, `tools.js`, `backend/src/agents/runner.js`, `aiAgentService.js`, `conversationalAgentService.js` |
| 14 | **Pixel de tracking, Sites, atribución** | Pixel JS público (`/snip.js` + `/collect`), sesiones con UTMs/click IDs/geo, vinculación visitor→contacto, Sites públicos por host, trigger links, atribución fallback. | `backend/src/controllers/trackingController.js`, `trackingService.js`, `sitesController.js`, `sitesService.js`, `triggerLinksService.js`, `attributionFallbackService.js` |
| 15 | **Notificaciones push, recordatorios de cita, mensajes programados** | Push web (VAPID) y nativo (FCM/APNs); recordatorios/confirmaciones de cita por WhatsApp (con clasificación IA); mensajes de chat programados por cron. | `backend/src/services/pushNotificationsService.js`, `appointmentRemindersService.js`, `appointmentConfirmationService.js`, `scheduledChatMessagesService.js` |
| 16 | **Dashboard, Reportes, Analítica, Costos** | KPIs (ingresos, gasto Meta, ROAS, ganancia neta, LTV), gráficas, funnel, dona de origen, reportes, gastos manuales prorrateados, costos fijos/porcentuales. | `backend/src/controllers/dashboardController.js`, `reportsController.js`, `costsController.js`, `analyticsService.js`, `frontend/src/pages/Dashboard/Dashboard.tsx` |
| 17 | **App móvil (Capacitor): tenant, login, push, Phone\*** | App Capacitor iOS/Android + rutas `/phone/*` (PWA/tablet): gate de tenant, login por correo enrutado al backend del cliente, onboarding push, shell de chat nativo. | `frontend/src/services/apiBaseUrl.ts`, `mobileTenantService.ts`, `mobileAppService.ts`, `frontend/src/pages/PhoneApp/PhoneApp.tsx`, `PhoneSettings.tsx`, `frontend/capacitor.config.ts` |
| 18 | **Modelo de datos: schema, migraciones, índices** | Esquema completo embebido en `initTables()` (CREATE IF NOT EXISTS + ALTER en try/catch); adaptador SQLite/Postgres; migraciones de datos en boot. Sin runner de migraciones versionado. | `backend/src/config/database.js`, `backend/migrations/*.sql` |
| 19 | **Seguridad, secretos, encriptación, privacidad** | Cifrado AES-256-GCM de tokens, JWT propio, API token `ristak_live_`, OAuth/PKCE para MCP, API externa (CRUD genérico + proxy GHL), webhooks. | `backend/src/utils/encryption.js`, `auth.js`, `oauthTokens.js`, `apiTokens.js`, `backend/src/routes/external.routes.js`, `oauth.routes.js`, `media.routes.js` |
| 20 | **Crons, background, deploy drain, idempotencia** | Todos los crons corren dentro del proceso web (setInterval/node-cron); deploy drain; idempotencia desigual entre crons. | `backend/src/server.js`, `backend/src/jobs/*.cron.js`, `backend/src/utils/deployDrainTracker.js`, `deployDrainPolicy.js` |

### Installer (portal central)

| # | Módulo | Qué intenta hacer | Archivos clave |
|---|--------|-------------------|----------------|
| 21 | **Installer: provisioning Render, updates, release channels** | El cliente instala su copia en su cuenta de Render (Postgres + web service Docker GHCR); updates centralizados; canales stable/test; releases móviles. | `installer.service.js`, `render.service.js`, `update.service.js`, `releaseChannel.service.js`, `github.service.js`, `frontend/src/pages/Install.tsx` |
| 22 | **Installer: license server, OAuth handoffs, admin, demo, mobile releases** | Valida licencias (`/api/license/verify`); broker OAuth (Google/Stripe/MP) con handoffs de un solo uso; admin JWT; entorno demo; releases móviles con credenciales de firma. | `license.service.js`, `oauthHandoff.service.js`, `setupToken.service.js`, `mobileStoreRelease.service.js`, `demoUser.service.js`, `mercadoPagoConnect.service.js`, `googleOAuth.service.js` |

---

## 2. Rutas/páginas frontend y endpoints backend principales

### 2.1 Páginas/rutas frontend (escritorio)

- `/login`, `/setup?token=`, `/sso?token=` (autenticación)
- `/license-blocked` (licencia bloqueada)
- `/dashboard` (KPIs y gráficas)
- Contactos, Chat, Reportes, Campañas, Analíticas, Calendarios/Appointments, Automatizaciones, Pagos
- Ajustes: HighLevel, Meta Ads, WhatsApp, Calendarios, Costos, API access
- `/pay/:id` (página pública de pago)
- `/calendar/:slug` (reserva pública)
- Sitios públicos servidos por host vía `publicSiteHostMiddleware`

### 2.2 Rutas frontend móvil (`/phone/*`)

- `/phone/tenant` (gate/resolución de tenant — solo se re-resuelve aquí)
- `/phone/login` (login; **no** re-resuelve tenant)
- `/phone/chat` (shell nativo iOS de solo-chat)
- PhoneApp (dashboard/citas/pagos/contactos/campañas/reportes), PhoneSettings, PhonePayments, PhoneCalendar, PhoneAgentChat

### 2.3 Endpoints backend — App por-cliente

**Autenticación** (`/api/auth`)
- `GET/POST /setup`, `GET /setup-info`, `POST /sso`, `POST /login`, `POST /local-dev-session`, `POST /google/start`, `POST /verify`
- `POST /change-password`, `POST /change-username`, `PATCH /profile`, `GET /me` (requireAuth)
- `GET/POST/PATCH/DELETE /users` (requireAuth + requireAdmin)
- `GET/POST(rotate)/DELETE /api-token` (requireAuth)
- *No existe endpoint de password reset / forgot-password.*

**Licencia** (`/api/license`)
- `GET /status` (requireAuth) — **endpoint muerto**: ningún componente frontend lo consume.

**Contactos** (`/api/contacts`)
- `GET /`, `/chats`, `/search`, `/stats`, `/chart`, `/custom-fields`, `POST /custom-fields`, `PUT /custom-fields/:definitionId`
- `POST /`, `/sync-stats`, `/bulk/tags`, `/bulk/custom-fields`
- `GET /bulk-actions`, `POST /bulk-actions/whatsapp-template`, `/bulk-actions/automation`, acciones de lote (pause/resume/reschedule/cancel)
- `GET /:id`, `/:id/journey`, `/:id/whatsapp-routing-events`, `PUT /:id`, `DELETE /:id`

**Calendarios** (`/api/calendars`)
- CRUD calendarios, `GET /events`, `POST/PUT/DELETE` appointments y events
- `GET /:id/free-slots`, blocked-slots (CRUD), `PUT /:id/google-sync`
- Google integration: connect-url, connect/claim, calendars, test, sync, DELETE
- **Públicos sin auth:** `GET /public/:slug/free-slots`, `POST /public/:slug/appointments`

**HighLevel** (`/api/highlevel`)
- test-connection, config (GET/POST/DELETE), `GET /config/reveal/api_token`, integration-status
- sync, sync/progress, sync-contacts, conversations/sync, conversations/messages, contacts/search, contacts/:id
- invoices, invoices/:invoiceId/record-payment, text2pay, users

**Meta** (`/api/meta`)
- config (GET/POST/DELETE), reveal/access_token, webhook-info, verify-token, test-event
- pixel-test/link, **pixel-test (público firmado)**, **pixel-test/event (público firmado)**
- ad-accounts, pixels, pages, social-profiles, custom-values, save-and-sync, sync, sync-from-highlevel, sync/progress, sync/status, update-recent
- campaigns, creative-preview/:creativeId, spend-over-time, contacts, leads-over-time, appointments-over-time, visitors-over-time, funnel-metrics, campaign-builder/\*

**WhatsApp** (`/api/whatsapp-api`)
- status, connect, messages (text/image/document/audio/interactive), templates/send, templates
- qr/connect, qr/disconnect, qr, qr/drip-settings, phone-numbers/:id/reroute|restore
- **Públicos (firma HMAC):** meta/connect/complete, meta/setup-prefill, meta/webhook-relay
- **Webhooks públicos:** `POST /webhook/whatsapp-api/ycloud` (firma opcional), `POST /webhook/whatsapp/attribution` (**SIN firma**)

**Pagos** (`/api/stripe`, `/api/transactions`, `/api/mercadopago`, `/api/conekta`, `/api/subscriptions`)
- **Stripe:** `POST /webhook` (firma), público `GET /public/payments/:id`, `POST /public/payments/:id/intent`, connect/callback, config (auth+settings_payments), payment-links, payment-plans, saved-card-payments, contacts/:id/payment-methods
- **Transacciones:** `POST /api/transactions` (pago manual), `POST /api/transactions/:id/record-payment`
- **MercadoPago:** `POST /webhook` (público), público GET/preference/card, payment-links, payment-plans
- **Conekta:** público GET/card, payment-links, payment-plans, saved-card-payments, contacts/:id/payment-sources (**sin webhook**)

**Automatizaciones** (`/api/automations`)
- CRUD, `PUT /:id` (guarda+publica), duplicate, enrollments, stats, enroll-contact, contacts/:contactId/activity
- catalogs (campaigns/adsets/ads/forms/form-fields/whatsapp-templates), assets, **`GET /assets/:assetId` (PÚBLICO, sin auth)**

**Agentes IA** (`/api/ai-agent`, `/api/conversational-agent`)
- ai-agent: config (GET/POST/DELETE), config/token DELETE, chat, transcribe, agents, runs/:traceId, business-context-answer
- conversational-agent: config, agents (CRUD), metrics, states, test, events, ai-providers (CRUD)

**Tracking / Sites / Atribución**
- **Públicos:** `GET /snip.js`, `POST /collect`, `POST /video-event`, `POST /sync-visitor`, `POST /link-visitor`, `GET /trigger-links/:publicId` (302)
- `GET /api/tracking/*` (sessions/config y métricas, auth), `GET /api/attribution/fallback/preview`, `POST /api/attribution/fallback/execute`
- **Sites públicos:** `POST /api/sites/public/submit`, `POST /api/sites/public/meta-event`, `GET /api/sites/:siteId/preview-session/:token`, `GET /api/sites/public/imported-assets/:siteId/*`

**Push** (`/api/push`)
- `GET /public-key` (sin auth), `POST/DELETE /subscriptions`, `POST/DELETE /mobile-devices` (auth)

**Recordatorios de cita** (`/api/appointment-reminders`) — GET/POST/PUT/DELETE (auth)

**Dashboard / Reportes / Costos**
- `GET /api/dashboard/*` (metrics, chart-data, financial-overview, roas, new-customers, visitors, leads, appointments, attendances, sales, storage-status, traffic-sources, origin-distribution, funnel)
- `GET /api/reports/*` (metrics, contacts, payments, campaigns, summary, transactions, contacts/list, manual-business-expenses)
- `GET/POST/PUT/DELETE /api/costs`, `POST /api/costs/calculate`

**Seguridad / API externa**
- **Webhooks sin firma:** `POST /webhook/payment`, `/webhook/contact`, `/webhook/refund`, `/webhook/appointment`
- `POST /api/oauth/register` (sin auth), `/api/oauth/authorize`, `/api/oauth/token`
- `GET/POST/PUT/PATCH/DELETE /api/external/data/:table` (CRUD genérico con API token)
- `POST /api/external/highlevel/request` (proxy GHL arbitrario)
- `GET /media/assets/:assetId/file` (público, sin auth), `/internal/*` y `/api/internal/*` (token interno Installer)

### 2.4 Endpoints backend — Installer

- `POST /api/license/verify`, `/api/license/storage-config`, `/api/license/oauth-handoff/claim`
- `POST /api/license/google-calendar/{connect-url,refresh-token,status,disconnect}`, `/api/license/stripe-connect/*`, `/api/license/mercadopago/*`, `/api/license/users/refresh`
- `POST /api/setup-token/{verify,consume}`, `POST /api/owner-credentials/verify`
- `POST /api/admin/{setup,login}`, ADMIN `/api/admin/*` (requireAdmin), incl. deploys/promote, updates/channel, installations/:id/{redeploy,destroy-resources,reset-database-content}
- `POST /api/demo/login`, `/api/demo/*` (requireDemo)
- `POST /api/webhooks/{deploy,mobile-release,mobile-release/credentials}`, `POST /api/mobile/resolve`
- `POST /api/install`, `/api/install/validate-key`, `GET /api/install/:id`, `/api/install/steps` (requireClient)

---

## 3. Entidades de base de datos

> El esquema completo vive embebido en `backend/src/config/database.js` (~5450 líneas) en un único `initTables()` idempotente.

### 3.1 App por-cliente

**Identidad / acceso**
- `users` (id, username, email, phone, password_hash, full_name, first_name, last_name, business_name, role, is_active, access_config, last_login, created_at, updated_at)
- `hidden_contact_filters` (contains/exact), `oauth_clients`, `oauth_authorization_codes`, `oauth_refresh_tokens`

**Contactos**
- `contacts` (incl. tags, custom_fields, ghl_contact_id, visitor_id, attribution_*, total_paid, purchases_count, preferred_whatsapp_phone_number_id, phone/email UNIQUE)
- `contact_phone_numbers`, `contact_custom_field_definitions` (+ `_sources`, `_folders`), `contact_tags` (catálogo), `contact_bulk_actions` (+ `_items`), `whatsapp_routing_events`

**Citas / calendarios**
- `calendars` (sync_status, is_active, source ristak/ghl/google, googleCalendarId)
- `appointments` (status, appointment_status, google_sync_status, sync_status, google_event_id UNIQUE, ghl_appointment_id, assigned_user_id, deleted_at; **sin created_at/updated_at en el CREATE base**)
- `appointment_reminders`, `appointment_reminder_sends` (UNIQUE reminder_id,appointment_id), `appointment_confirmation_windows`, `appointment_attendance_signals` (**PK = contact_id**: una señal por contacto, no por cita)

**Pagos**
- `payments` (pending/scheduled/processing/sent/paid/failed/void/refunded/deleted; **FK contact_id ON DELETE CASCADE**; idx_payments_ghl_invoice **NO único**)
- `payment_flows`, `installment_payments`, `payment_plans`, `subscriptions` (FK ON DELETE SET NULL — inconsistente con payments)
- `stripe_payment_methods`, `conekta_payment_sources`, `payment_automation_dispatches`

**Integraciones / mensajería**
- `highlevel_config` (**api_token TEXT sin cifrar**), `meta_config`, `meta_ads` (date TEXT YYYY-MM-DD; CPM/CTR con base errónea), `meta_api_version`, `meta_campaign_templates/drafts/execution_logs`, `meta_conversion_event_logs`, `meta_social_contacts/messages`
- `ai_agent_config` (**openai_api_key_encrypted — sí cifrado**), `conversational_ai_providers`, `conversational_agent_state/agents`, `agent_runs`, `agent_steps`
- `whatsapp_api_messages/phone_numbers/templates/contacts/webhook_events/alerts`, `whatsapp_attribution`, `whatsapp_qr_sessions/auth_state`, `whatsapp_meta_direct_nonces`, `email_messages`, `scheduled_chat_messages`, `message_templates`

**Automatizaciones**
- `automations`, `automation_folders`, `automation_enrollments` (active/waiting/completed/exited; **sin UNIQUE por contacto+automatización**), `automation_drip_entries`, `automation_schedule_runs`, `automation_contact_enrollment_jobs`, `automation_assets`

**Tracking / Sites / reportes**
- `sessions` (sin dedup; cada evento es fila nueva), `video_playback_sessions`, `trigger_links`, `trigger_link_events`
- `sites`, `public_sites`, `public_site_blocks`, `public_site_imports`, `public_site_submissions`
- `costs` (fixed/percentage; applies_to revenue/profit/null — **'profit' no implementado**), `report_manual_business_expenses`
- `media_assets`, `storage_quotas`, `internal_notifications`, `push_subscriptions`, `mobile_push_devices`
- `app_config` (incl. `encryption_master_key` — puede quedar en plano si no hay env), `config`

### 3.2 Installer

- `clients` (incl. google_calendar_refresh_token_enc, password_hash del dueño)
- `licenses` (active/suspended/expired/revoked), `installations` (pending/provisioning/deploying/active/failed/suspended; app_url, auto_update_on_push, render_database_id, render_service_id)
- `license_checks`, `installation_events`, `deploy_events`, `client_features`, `client_payments`
- `setup_tokens` (peek/verify NO consume; expone password_hash), `oauth_handoffs` (TTL 10 min), `mercadopago_oauth_states`, `google_oauth_states`, `stripe_connect_oauth_states`
- `mobile_release_tokens` (no se marca consumido), `mobile_release_events`
- `installation_user_access` (directorio de usuarios para login móvil), `demo_users`, `admin_users`, `leads`, `app_settings`

---

## 4. Integraciones externas

| Integración | Uso | Autenticación | Notas |
|-------------|-----|---------------|-------|
| **Portal central / Installer** | Licencias, setup tokens, owner-credentials, refresh de directorio de usuarios, OAuth handoffs | client_id + license_key + installation_id | Fuente de verdad de licencia y password del dueño |
| **GoHighLevel (LeadConnector v2)** | Contactos, citas, calendarios, productos, invoices/pagos, conversaciones | Private Integration Token (sin OAuth, sin refresh) | Token guardado en claro; proxy arbitrario expuesto vía API externa |
| **Google Calendar API v3** | Sync bidireccional de eventos; calendarList | OAuth handoff (refresh token cifrado) intercambiado por el Installer | Solo pull on-demand, sin cron |
| **Meta Graph API / Ads** | Insights, creatives, adaccounts, pixels, CAPI | System User Token de larga duración | Campaign Builder no crea campañas reales |
| **Meta Conversions API (CAPI)** | Eventos de conversión (sitios, pixel-test) | Pixel access token | — |
| **Stripe** | PaymentIntents, webhooks, suscripciones, Connect OAuth | Secret key cifrada + webhook secret | Webhook con firma verificada (raw body) |
| **MercadoPago** | Checkout Pro, Card Brick, preapproval, webhooks | OAuth gestionado por el portal (con refresh, PKCE S256) | Webhook firmado |
| **Conekta** | Orders, tarjetas guardadas | Llaves privadas/públicas locales | **Sin webhook** — pagos asíncronos no se reconcilian |
| **Gigstack** | Facturación fiscal (CFDI) | API key | Un solo intento, sin reintentos |
| **YCloud** | WhatsApp Business API oficial | API key | Webhook con firma opcional |
| **WhatsApp Web (Baileys)** | Respaldo QR no oficial | Sesión QR (Baileys) | Estado en memoria, sin lock entre réplicas |
| **Bunny CDN** | Almacenamiento de media | — | Fallback local efímero peligroso |
| **ip-api.com** | Geolocalización por IP | Ninguna (HTTP plano, 45 req/min) | Llamada síncrona en `/collect` |
| **FCM (Android) / APNs (iOS)** | Push nativo | JWT (FCM/APNs) | — |
| **Web Push (VAPID)** | Push PWA/web | Llaves VAPID (autogeneradas si faltan) | — |
| **Render API** | Provisioning/destroy de Postgres y web services | Render API Key del cliente (cifrada) | Llave cifrada con secreto derivado de JWT_SECRET |
| **GitHub Actions / GHCR** | Builds, releases móviles, imagen Docker privada | Deploy hook / webhook key / GHCR pull token | — |
| **OpenAI / proveedores compatibles** | Agentes IA, transcripción, visión, clasificación de confirmación | API key por cuenta (cifrada) | Fallback OpenAI requerido para media en proveedores no-OpenAI |

---

## 5. Dependencias entre módulos

Relaciones de invocación derivadas del corpus (→ = "depende de / invoca a"):

```
Auth ──────────────→ licenseService (validación en cada login/verify/request)
                  └─→ userAccess (getEffectiveAccessConfig)
                  └─→ Installer (owner-credentials, setup-token)

Licenciamiento ────→ Installer (/api/license/verify)
                  └─→ requireFeature monta sobre 8 routers en server.js
                  └─→ accessControl.ts (frontend gatea UI por user.licenseFeatures)

Multi-tenancy ─────→ verifyToken (auth)
                  └─→ Installer (directorio para login móvil)

Contactos ─────────→ automationEngine (contact-created/updated, enroll)
                  └─→ ghlClient (sync), whatsappApiService (bulk), contactIdentityService
                  └─→ analyticsService (stats), trafficSourceNormalizer

Citas ─────────────→ contactIdentityService, ghlClient, googleCalendarService
                  └─→ pushNotificationsService, metaWhatsappEventsService
                  └─→ appointmentRemindersService → appointmentConfirmationService → OpenAI

Google Calendar ──→ Installer (OAuth handoff), localCalendarService, encryption

HighLevel ─────────→ contactIdentityService (merge), localCalendarService
                  └─→ metaAdsService (reconcile Meta en cada sync), automationEngine
                  └─→ conversational/runner (inbound dispara agente), paymentFlowService

Meta Ads ──────────→ highlevelSyncService (atribución), analyticsService
                  └─→ Campaign Builder → MCP (NO conectado)

WhatsApp ──────────→ automationEngine, conversational/runner, scheduledChatMessagesService
                  └─→ mediaStorageService (Bunny), Installer (relay Meta directo)
                  └─→ Citas (confirmación), Contactos (atribución CTWA)

Pagos (todos) ─────→ paymentAutomationsService (WhatsApp), gigstackInvoiceService
                  └─→ updateContactsStats, licenseService (Stripe Connect/MP OAuth)
                  └─→ conversational/runner (create_payment_link)

Automatizaciones ──→ whatsappApiService, emailService, contactTagsService
                  └─→ contactIdentityService, notificationsService
                  └─→ (re-emite eventos que pueden disparar otras automatizaciones)

Agentes IA ────────→ createSinglePaymentLink, createAppointment, getLocalFreeSlots
                  └─→ whatsappApiService, sendHighLevelConversationMessageCore, email
                  └─→ OpenAI/proveedor (API key por cuenta)

Tracking/Sites ────→ HighLevel (sync visitor_id), Meta CAPI, ip-api.com
                  └─→ contactIdentityService, automationEngine (trigger-link, submit)

Push/Recordatorios → whatsappApiService, sendHighLevelConversationMessageCore
                  └─→ OpenAI (clasificación de confirmación), pushNotificationsService

Dashboard/Reportes → analyticsService, HighLevel (citas/asistencias por API)
                  └─→ manualBusinessExpensesService, originDistributionService

App móvil ─────────→ Installer (/api/mobile/resolve), apiBaseUrl runtime
                  └─→ Auth (login), pushNotificationsService

Crons ─────────────→ stripe/conekta/mercadopago PaymentService, appointmentReminders
                  └─→ scheduledChatMessages, paymentAutomations, automationEngine
                  └─→ metaSync, highlevelSync, whatsappQrWatchdog
                  (todos dentro del proceso web)
```

**Acoplamientos ocultos notables (referencia):**
- Sincronizar HighLevel **muta** la config de Meta Ads (`reconcileMetaBusinessWithHighLevel`) en cada cron.
- Editar el teléfono de un contacto puede **fusionar y borrar** otro contacto (vía `contactIdentityService`).
- El runtime del agente conversacional se dispara desde los servicios de mensajería **sin pasar por** el gating de licencia HTTP.

---

## 6. Jobs / cron / webhooks / procesos automáticos

> **Característica arquitectónica clave:** todos los crons arrancan dentro del proceso web vía `setInterval`/`node-cron` en `startRuntimeServices()` de `server.js`. No hay cron services separados ni leader-election. Render corre 1 instancia por defecto (no hay `numInstances` en `render.yaml`).

### 6.1 Crons / procesos en background

| Job | Frecuencia | Qué hace | Lock / idempotencia |
|-----|-----------|----------|---------------------|
| Recordatorios/confirmaciones de cita | cada 60s | Calcula ventana, envía plantilla WhatsApp, clasifica respuesta con IA | Flag `running` en memoria; registro **después** del envío |
| Mensajes de chat programados | cada 30s | Despacha mensajes programados | **Claim atómico correcto** (compare-and-swap) |
| Automatizaciones de pago | cada 30 min | Recordatorio/comprobante/cobro fallido por WhatsApp | **Claim atómico correcto** (`payment_automation_dispatches` ON CONFLICT) |
| Parcialidades Stripe | cada 30 min | Cobra parcialidades vencidas (tarjeta guardada) | Flag in-process + idempotencyKey Stripe |
| Parcialidades Conekta | cada 30 min | Cobra parcialidades (tarjeta guardada) | **Sin idempotency key ni claim atómico** |
| Parcialidades MercadoPago | — | Genera links de parcialidades | **Cron construido pero NUNCA arrancado** |
| Acciones masivas de contactos | (cron) | Procesa lotes WhatsApp/automatización | Locking por item |
| Motor de automatizaciones (scheduler) | cada 20s | Reanuda esperas, dispara horarios, inscribe programados | `processDueResumes` **sin claim atómico** |
| Meta Sync | horario | `updateRecentAds` (7 días) + perfiles sociales (diario) | Lock in-process; sin guard de solape (node-cron) |
| Meta Version | mensual | Auto-detecta y fija versión de Graph API | — |
| HighLevel Sync (full) | min :17 | Sync completo de contactos/citas/productos/pagos/conversaciones | **Sin lock global** |
| HighLevel conversaciones | cada 10 min | Sync incremental de chats | Guard interno `syncRunning` (solo conversaciones) |
| WhatsApp QR Watchdog | cada ~4 min | Reabre sesiones QR tras deploy | **Sin lock entre réplicas** |
| Recovery agente conversacional | en boot | Reprograma respuestas/follow-ups pendientes | Solo al arrancar; sin cron periódico |
| Migraciones de datos | en cada boot | Fusión de contactos duplicados, normalización de teléfonos, etiquetas | **Sin advisory lock ni gating por versión** |

**Follow-ups del agente conversacional:** `setTimeout` en Map en memoria; recuperados solo en boot.

### 6.2 Webhooks entrantes

| Webhook | Firma | Notas |
|---------|-------|-------|
| `POST /api/stripe/webhook` | Sí (raw body) | Bien verificado; sin dedupe por event.id |
| `POST /api/mercadopago/webhook` | Condicional | Acepta sin firma si no hay secret configurado |
| Conekta | **No existe** | Pagos asíncronos (OXXO/SPEI/3DS) nunca se reconcilian |
| `POST /webhook/whatsapp-api/ycloud` | Opcional | Acepta sin firma si no hay `webhook_secret` |
| `POST /webhook/whatsapp/attribution` | **No** | Sobreescribe atribución de cualquier contacto por teléfono |
| Meta social webhook | Sí (`verify_token`) | — |
| `POST /webhook/payment`,`/contact`,`/refund`,`/appointment` | **No** | Crean/actualizan contactos, pagos y citas sin verificación |
| `POST /api/webhooks/deploy` (Installer) | API key estática compartida | Sin HMAC de GitHub |
| `POST /api/webhooks/mobile-release/credentials` (Installer) | Token (no de un solo uso) | Sin rate limit |

### 6.3 Deploy drain

- `deployDrainPolicy` + `deployDrainTracker` + `handleShutdown` drenan HTTP y trabajo de cron hasta `GRACEFUL_SHUTDOWN_TIMEOUT_MS=295s` (alineado con `maxShutdownDelaySeconds=300` de Render).
- El solape de deploy zero-downtime (instancia vieja + nueva vivas hasta ~295s) puede activar doble ejecución en los crons sin claim atómico.

---

## 7. Variables de entorno requeridas

> Derivadas de `dataEntities`/dependencies del corpus (no de un `.env.example` literal).

### 7.1 App por-cliente

**Sesión / cifrado**
- `JWT_SECRET` — firma del JWT. Fallback estático `ristak-default-secret-change-me` fuera de producción.
- `ENCRYPTION_MASTER_KEY` — master key AES-256-GCM. Si falta, se autogenera y persiste **en plano** en `app_config`.
- `NODE_ENV` — controla fallbacks de seguridad (debe ser `production`).

**Licencia (instalación gestionada)**
- `LICENSE_SERVER_URL` / `RISTAK_LICENSE_SERVER_URL`, `CLIENT_ID`, `LICENSE_KEY`, `INSTALLATION_ID`
- `APP_URL` / `RENDER_EXTERNAL_URL`, `OWNER_EMAIL`, `APP_VERSION`
- `LICENSE_OFFLINE_POLICY` (strict/grace), `LICENSE_OFFLINE_GRACE_HOURS`

**Base de datos**
- `DATABASE_URL` — Postgres en producción; si ausente, SQLite local (`./ristak.db`)

**Media / WhatsApp**
- `PUBLIC_APP_URL` — base para links públicos de pago
- `WHATSAPP_LOCAL_MEDIA_FALLBACK` — habilita fallback local (efímero, peligroso)

**Push**
- `WEB_PUSH_*` / `VAPID_*` — llaves VAPID (autogeneradas si faltan)

**Agentes IA / MCP**
- `MCP_EXECUTION_ENABLED`, `MCP_AUTHORIZATION_TOKEN` — Campaign Builder (aun presentes → `adapter_missing`)

**Interno**
- `INTERNAL_INSTALLER_TOKEN` — rutas `/internal/*`

### 7.2 Installer

- `JWT_SECRET` — firma de JWT admin/demo. Fallback `ristak-installer-default-secret-change-me` fuera de producción.
- `INSTALLER_ENCRYPTION_KEY` — cifrado de Render API Keys. Si falta, **se deriva de `JWT_SECRET`** (`installer-master:`+JWT_SECRET).
- `INSTALLER_WEBHOOK_SECRET` / `webhook_api_key` (app_settings) — webhooks
- `ghcr_pull_token`, `ristak_docker_image*`, `ristak_github_repo`, `portal_public_url` (app_settings)
- Render API (provisioning), GitHub Actions dispatch, SMTP/Zoho (correos)

---

## 8. Roles / permisos

### 8.1 App por-cliente (dentro de una instalación)

| Rol | Acceso | Mecanismo |
|-----|--------|-----------|
| `admin` | Total | `is_active=1` + role |
| `employee` | Por módulo vía `access_config` JSON | `requireModuleAccess(<modulo>)` router por router |

**Módulos de acceso** (`utils/userAccess.js`): contacts, chat, analytics, dashboard, reports, payments, sites, calendars/appointments, automations, campaigns, products, attribution, contact-tags, appointment-reminders, settings_\*, team_access, developers, ai_agent, etc.

**Estados de usuario:** `is_active=1` (puede entrar), `is_active=0` (rechazado; soft-delete). `requireAuth` re-lee `is_active`/role de la DB en cada request.

**Capas de privacidad fina:**
- Filtros de "contactos ocultos" (`hidden_contact_filters`) — globales por instalación, aplicados ad-hoc por query (inconsistente).
- **No existe** owner/asignación por contacto: todo empleado con módulo `contacts` ve toda la base.

**Notas de enforcement (referencia rápida):**
- 8 routers premium con `requireFeature`; el resto sin gating de licencia en backend.
- Varios routers (chat, analytics/tracking, products, attribution, contact-tags, appointment-reminders, config) solo tienen `requireAuth`, sin `requireModuleAccess`.
- API externa (token `ristak_live_`) sin scopes reales: permite CRUD genérico + proxy GHL.

### 8.2 Installer

| Rol | Acceso | Mecanismo |
|-----|--------|-----------|
| `admin` (admin_users) | Panel completo de administración | JWT HS256 propio (`requireAdmin`) |
| `demo` (demo_users) | Entorno demo (revisor) | Token tipo `demo` (30 días), revocable, `requireDemo` |
| App instalada | Server-to-server | client_id + license_key + installation_id |
| Cliente | Instalación/provisioning | `requireClient` |

Sin jti ni lista de revocación para tokens admin; la única revocación es rotar `JWT_SECRET` (cierra a todos).

---

## 9. Flujos principales del usuario

### App por-cliente

1. **Login** con usuario/email/teléfono + contraseña → validación de licencia → JWT en localStorage → `/dashboard`.
2. **Setup del primer usuario** (instalación gestionada): enlace `/setup?token=` del Installer → crear admin.
3. **SSO desde el portal** (`/sso?token=`): token de un solo uso → sesión o redirección a setup.
4. **Logout** (solo client-side; no invalida server-side).
5. **Crear contacto manual** / **Editar teléfono/email** (puede fusionar) / **Acción masiva** (WhatsApp/automatización).
6. **Agendar cita** (escritorio/móvil) / **Reserva pública** por URL / **Reprogramar** / **Cancelar** / **Bloquear horarios**.
7. **Conectar HighLevel** (locationId + token) → sync horario.
8. **Conectar Meta Ads** (System User Token) → sync de métricas / **Probar Pixel/CAPI** / **Campaign Builder** (preview-only).
9. **Conectar Google Calendar** (OAuth handoff) → vincular calendarios → push de citas.
10. **Conectar WhatsApp** (YCloud / QR / Meta directo) → enviar/recibir mensajes y plantillas → recibir atribución CTWA.
11. **Cobrar:** crear/enviar link de pago (Stripe/MP/Conekta), plan de parcialidades, suscripción; cliente paga en `/pay/:id`.
12. **Registrar pago manual** (RecordPaymentModal).
13. **Construir y publicar una automatización** (editor de flujos) → disparo por evento → esperas/reanudación.
14. **Asistente IA de la app** (chat por categorías) / **Agente conversacional** auto-responde mensajes entrantes.
15. **Visitante anónimo → sesión trackeada → contacto** (pixel + vinculación) / **Sitio público por host** / **Trigger link redirect** / **Fallback attribution**.
16. **Recordatorio/confirmación de cita por WhatsApp** / **Mensaje de chat programado** / **Push al staff** (chat/cita/pago).
17. **Ver KPIs del dashboard** / **Configurar Costos** / **Funnel de conversión** / **Gráfica financiera por atribución**.

### App móvil

18. **Primer arranque → tenant → login** (resolución del backend del cliente por correo vía Installer).
19. **Onboarding de notificaciones push** (web o nativo Capacitor).
20. **Cerrar sesión / cambiar de empresa**.

### Installer

21. **Autoinstalación del cliente** (Render API Key + subdominio → Postgres + web service → setup token).
22. **Validación de licencia** de la app instalada al iniciar sesión.
23. **Conectar pago/calendario** (OAuth handoff de un solo uso).
24. **Auto-update de Test** en cada push a main / **Promoción manual a "En vivo"**.
25. **Acceso al entorno demo** (revisor).
26. **Release móvil** (GitHub Actions lee credenciales de firma).
