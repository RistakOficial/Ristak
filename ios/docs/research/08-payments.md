# 08 — Módulo Pagos (Payments) — Spec para app nativa iOS

> Investigación exhaustiva del módulo de pagos de Ristak: backend (Node/Express + SQLite,
> puerto 3001) y frontend móvil (`/movil` → `frontend/src/pages/PhonePayments/PhonePayments.tsx`,
> `frontend/src/components/common/RecordPaymentModal/RecordPaymentModal.tsx`,
> `frontend/src/components/phone/PhoneSubscriptionForm.tsx`) y app React Native
> (`mobile/src/App.tsx`, `mobile/src/api.ts`). Este documento es autosuficiente: los agentes
> Swift NO deben re-leer las fuentes TS/JS.
>
> Convención: todo lo marcado **OPEN QUESTION** es ambiguo en el código y debe validarse antes de
> implementarse.

---

## 0. Convenciones generales de API

- Base URL: `https://<host>/api`. Autenticación: header `Authorization: Bearer <auth_token>`
  (mismo token de login; el frontend lo guarda en `localStorage.auth_token`). Algunos servicios
  web usan `credentials: 'include'` (cookie de sesión) — el token Bearer es suficiente para nativo.
- **Envelope**: la mayoría de endpoints de pagos responden `{ "success": true, "data": <payload> }`
  y en error `{ "success": false, "error": "<mensaje en español>" }` con status HTTP 4xx/5xx.
  Excepciones documentadas por endpoint (p. ej. `/api/products` responde
  `{ success, products, total }`; `/api/integrations/status` responde el objeto pelón).
- **ACL de módulo**: todas las rutas de transacciones, productos, suscripciones y operaciones de
  cobro por pasarela exigen `requireAuth` + `requireModuleAccess('payments')`
  (`backend/src/routes/transactions.routes.js:31-32`, `products.routes.js:16-19`,
  `subscriptions.routes.js:16-17`, y en cada `*.routes.js` de pasarela las rutas `/payment-links`,
  `/payment-plans`, `/saved-card-payments`, `/contacts/:id/payment-*`). Las rutas `/config` de cada
  pasarela exigen `requireModuleAccess('settings_payments')`.
- **Licencia (feature flags)**: `requireFeature('payment_plans')` protege
  `/api/transactions/payment-plans*`, `/api/transactions/payment-flows/installments` y los
  `/payment-plans` de stripe/conekta/mercadopago/rebill. `requireFeature('subscriptions')` protege
  `/api/subscriptions` completo y los endpoints públicos de checkout de suscripción.
  Estado de licencia: `GET /api/license/status` → `{ success, enforced, allowed, plan,
  features: { payment_plans?: bool, subscriptions?: bool, ... }, limits, expires_at }`
  (`backend/src/routes/license.routes.js:18-34`).
- **Moneda de cuenta**: clave `account_currency` en `GET /api/config` (config map genérico;
  `backend/src/utils/accountLocale.js:6`). El backend **fuerza** la moneda de cuenta al crear o
  editar pagos y links (ignora la currency del cliente) — ver §2.2 y §5.
- **Zona horaria del negocio**: `GET /api/settings/timezone`. Los rangos `startDate/endDate` de
  transacciones se interpretan en esa zona (`resolveDateRangeWithGHLTimezone`,
  `transactionsController.js:829`). Formato de fechas de filtro: `YYYY-MM-DD`.
- **Eventos en vivo**: `GET /api/payment-events/stream` (SSE, requiere módulo `payments`) emite
  eventos de cambio de pagos/suscripciones (`backend/src/routes/paymentEvents.routes.js`,
  `paymentLiveEventsService.js`). El frontend web lo usa para refrescar listas.

---

## 1. Modelo de datos

### 1.1 Transaction (pago) — respuesta de `/api/transactions`

Mapeo exacto desde la tabla `payments` (`mapTransactionRow`,
`backend/src/controllers/transactionsController.js:453-492`):

| Campo JSON | Tipo | Nullable | Notas |
|---|---|---|---|
| `id` | string | no | PK, p.ej. `manual_payment_...`, `stripe_payment_...`, o id de invoice GHL |
| `date` | string ISO datetime | no | Momento del pago (timestamp completo) |
| `contactId` | string | sí | |
| `contactName` | string | no (puede ser `""`) | JOIN a contacts.full_name |
| `email` | string | no (`""`) | email del contacto |
| `phone` | string | no (`""`) | teléfono del contacto |
| `amount` | number | no | 2 decimales |
| `currency` | string | no | ISO 4217, p.ej. `MXN` |
| `method` | string | no | default `other`. Valores vistos: `cash`, `bank_transfer`, `transfer`, `card`, `check`, `paypal`, `other`, `payment_link`, `direct_card`, `saved_card`, `stripe`, `stripe_saved_card`, `stripe_link`, `stripe_payment_link`, `conekta`, `conekta_saved_card`, `conekta_subscription`, `mercadopago`, `mercadopago_checkout`, `mercadopago_subscription`, `clip`, `clip_card`, `clip_link`, `clip_payment_link`, `rebill`, `rebill_checkout` (`frontend/src/services/transactionsService.ts:12`) |
| `status` | string enum | no | `draft \| sent \| scheduled \| paid \| pending \| overdue \| partial \| void \| refunded \| failed \| deleted`. El backend normaliza `succeeded`→`paid` (`transactionsController.js:75-79`) |
| `paymentMode` | `'live' \| 'test'` | no | default `live` |
| `paymentProvider` | string | no | `manual \| highlevel \| stripe \| conekta \| mercadopago \| clip \| rebill \| gigstack`. Si es null y hay `ghl_invoice_id` → `highlevel`; si no → `manual` |
| `paymentMethodCategory`, `paymentMethodCategoryId`, `paymentType`, `paymentChannel`, `paymentChannelId` | string | sí | Campos de display calculados por `buildPaymentDisplay` (`backend/src/utils/paymentDisplay.js`) para etiquetas de UI |
| `reference` | string | sí | referencia manual / public_payment_id en links |
| `title` | string | no | fallback: `description` → `'Pago'` |
| `description` | string | sí | |
| `createdAt`, `updatedAt` | string datetime | no | |
| `invoiceId` | string | sí | `ghl_invoice_id` (invoice HighLevel) |
| `invoiceNumber` | string | sí | |
| `dueDate` | string | sí | |
| `sentAt` | string | sí | |
| `publicPaymentId` | string | sí | id público del checkout Ristak (`/pay/<id>`) |
| `paymentUrl` | string | sí | URL del checkout público. Para `mercadopago` siempre se prefiere la URL local `/pay/<publicPaymentId>` (`transactionsController.js:147-152`) |
| `stripePaymentIntentId`, `stripeChargeId` | string | sí | |
| `mercadoPagoPaymentId`, `mercadoPagoPreferenceId` | string | sí | |
| `conektaOrderId`, `conektaChargeId`, `conektaPaymentSourceId` | string | sí | |
| `clipPaymentId`, `clipReceiptNo` | string | sí | |
| `rebillPaymentId`, `rebillSubscriptionId`, `rebillCustomerId`, `rebillCardId` | string | sí | |
| `paidAt` | string | sí | |

`GET /api/transactions/:id` agrega además: `contactSource`, `attributionAdName`,
`attributionAdId` (`transactionsController.js:1145-1147`) y NO incluye los campos
`paymentMethodCategory*` de display.

En BD también existe `metadata_json` (JSON string) con: `lineItems[]`, `tax{...}`,
`stripeInstallments{...}`, `paymentPlan{flowId,trigger,...}`, `source`, etc. Solo se expone
completo en los endpoints públicos de checkout, pero `POST /api/transactions` acepta `metadata`.

### 1.2 Estados de pago — semántica

- Éxito (cuentan para ingresos): `paid` (+ alias `succeeded/completed/complete/fulfilled/success`
  normalizados). `partial` cuenta como recibido en la UI móvil (`PhonePayments.tsx:65`).
- Cerrados (no se re-consultan a Stripe): `paid, refunded, void, deleted, failed`
  (`transactionsController.js:37`).
- `sent` = link enviado/creado pendiente de pago. `draft` = invoice HL creado sin enviar.
- Los intentos de checkout de sitio abandonados (metadata `site_checkout`/`site_form` con estados
  `sent/pending/processing/...`) se **excluyen** del listado (`transactionsController.js:906-911`).

### 1.3 Producto y Precio (catálogo local Ristak, espejo opcional en HighLevel)

`ProductItem` (`frontend/src/services/productsService.ts:16-33`):
`id?`, `_id?`, `localId?`, `ghlProductId?`, `name` (string, requerido), `description?`,
`currency?`, `productType?` (p.ej. `DIGITAL`), `source?`, `syncStatus?`, `syncError?`,
`gigstackProductKey?`, `gigstackUnitKey?`, `gigstackUnitName?`, `postWebhooks?[]`,
`prices?: ProductPrice[]`.

`ProductPrice`: `id?`, `_id?`, `localId?`, `ghlPriceId?`, `localProductId?`, `name?`,
`amount?` (number), `price?` (alias legacy), `currency?`, `type?` (`one_time`), `sku?`,
`syncStatus?`. **Regla de identidad**: el id efectivo es `localId || id || _id`
(`PhonePayments.tsx:156-162`).

### 1.4 PaymentSubscription

Modelo completo (`frontend/src/services/subscriptionsService.ts:6-69`; backend
`subscriptionsService.js` tabla `subscriptions`):

- Núcleo: `id`, `contactId?`, `contactName?`, `contactEmail?`, `contactPhone?`, `name`,
  `description?`, `status`, `amount` (number), `currency`, `intervalType`
  (`daily|weekly|monthly|yearly`), `intervalCount` (int ≥1), `startDate?`, `nextRunAt?`,
  `currentPeriodStart?`, `currentPeriodEnd?`, `cancelAt?`, `cancelledAt?`, `paymentMethod?`,
  `paymentProvider?`, `paymentMode?` (`test|live`), `source?`, `metadata?`, `raw?`,
  `createdAt?`, `updatedAt?`.
- Stripe: `stripeCustomerId?`, `stripeSubscriptionId?`, `stripeProductId?`, `stripePriceId?`,
  `stripePaymentMethodId?`, `stripeCheckoutSessionId?`, `stripeCheckoutUrl?`.
- Mercado Pago: `mercadoPagoPreapprovalId?`, `mercadoPagoPreapprovalPlanId?`,
  `mercadoPagoInitPoint?`, `mercadoPagoSandboxInitPoint?`, `mercadoPagoPayerId?`,
  `mercadoPagoCardId?`, `mercadoPagoPaymentMethodId?`, `mercadoPagoNextPaymentDate?`.
- Conekta: `conektaCustomerId?`, `conektaPlanId?`, `conektaSubscriptionId?`,
  `conektaPaymentSourceId?`, `conektaNextBillingAt?`, `conektaCheckoutId?`, `conektaCheckoutUrl?`.
- Rebill: `rebillSubscriptionId?`, `rebillPlanId?`, `rebillPaymentLinkId?`,
  `rebillPaymentLinkUrl?`, `rebillCustomerId?`, `rebillCardId?`, `rebillNextChargeAt?`,
  `rebillLastChargeAt?`, `rebillCheckoutUrl?`.
- Pago de arranque: `subscriptionStartPaymentId?`, `subscriptionStartPublicPaymentId?`,
  `subscriptionStartPaymentProvider?`, `subscriptionStartPaymentStatus?`, `subscriptionStartUrl?`.

Estados: `draft | active | trialing | past_due | paused | cancelled | incomplete` (+ `deleted`
interno, nunca se lista). Resumen: activos = `active|trialing`; pausados = `paused`;
vencidos = `past_due|incomplete` (`subscriptionsService.js:55-57`).

### 1.5 PaymentPlan (plan de pagos / invoice schedule)

Shape usado por el frontend (`frontend/src/services/transactionsService.ts:48-72`):
`id`, `name`, `title?`, `status` (string), `total` (number), `currency?`, `contactId?`,
`contactName?`, `email?`, `phone?`, `description?`, `startDate?`, `nextRunAt?`, `endDate?`,
`recurrenceLabel?`, `liveMode?`, `deleted?`, `itemCount?`, `source?` (`ghl|stripe|rebill|...`),
`createdAt?`, `updatedAt?`, `sortDate?`, `raw?`.

### 1.6 Flujo de parcialidades (payment_flows) — estados

`PAYMENT_FLOW_STATES` (`backend/src/services/paymentFlowService.js:25-36`):
`draft`, `first_payment_pending`, `first_payment_registered`, `offline_payment_registered`,
`waiting_card_authorization`, `installment_plan_created`, `installment_plan_active`, `cancelled`.

Métodos offline del primer pago: `cash, bank_transfer, transfer, deposit, offline, manual, check,
other`. Métodos "tarjeta": `card, payment_link, direct_card, saved_card`
(`paymentFlowService.js:41-42`).

### 1.7 Tarjetas guardadas por pasarela

- **Stripe** `StripeSavedPaymentMethod` (`stripePaymentsService.ts:245-260`): `id`, `contactId`,
  `stripeCustomerId`, `stripePaymentMethodId`, `brand`, `last4`, `expMonth`, `expYear`,
  `funding?`, `country?`, `mode` (`test|live`), `isDefault`, `label`, `expiresLabel`.
- **Conekta** `ConektaSavedPaymentSource`: `id`, `contactId`, `conektaCustomerId`,
  `conektaPaymentSourceId`, `brand`, `last4`, `expMonth`, `expYear`, `name?`, `mode`,
  `isDefault`, `label`, `expiresLabel`.
- **Rebill** `RebillSavedPaymentSource`: `id`, `contactId`, `rebillCustomerId`, `rebillCardId`,
  `brand`, `last4`, `name?`, `mode`, `isDefault`, `label`, `expiresLabel` (sin expMonth/Year).
- Mercado Pago y CLIP **no** exponen tarjetas guardadas.

### 1.8 PaymentSettings (`/api/settings/payments`)

Shape completo con defaults en `frontend/src/services/paymentSettingsService.ts:87-184`:

```
{
  paymentMode: 'test'|'live',
  checkout:  { useBusinessProfile, logoUrl, headline, description, buttonLabel,
               supportEmail, supportPhone, showSecureBadge },
  receipt:   { useBusinessProfile, logoUrl, invoiceTemplate ('classic'|'executive'|'accent'|'ledger'),
               invoicePalette, invoiceAccentColor, invoicePaperColor, invoiceTextColor, title,
               intro, footer, businessName, businessEmail, businessPhone, businessAddress,
               businessWebsite, terms, showBusinessInfo, showCustomerInfo, showTerms },
  automations: { remindersEnabled, reminderDaysBefore, reminderChannel ('whatsapp'|'email'|'both'),
               reminderQrFallbackEnabled, reminderTemplateId/Name/Language,
               receiptDeliveryEnabled, receiptDeliveryChannel, receiptQrFallbackEnabled,
               receiptTemplateId/Name/Language, afterPaymentAction
               ('none'|'send_receipt'|'start_automation'|'tag_contact'), afterPaymentMessage,
               failedPaymentEnabled, failedPaymentChannel, failedPaymentQrFallbackEnabled,
               failedPaymentTemplateId/Name/Language, failedPaymentDelayHours },
  taxes:     { enabled, taxName ('IVA'), rateType ('percentage'|'fixed'), rateValue (16),
               rateSource ('automatic'), calculationMode ('exclusive'|'inclusive'), country ('MX'),
               fiscalId, fiscalLegalName, fiscalPostalCode, fiscalRegime, provider ('gigstack'),
               gigstackEnabled, gigstackDefaultProductKey, gigstackDefaultUnitKey,
               gigstackDefaultUnitName, gigstackDefaultPaymentMethod,
               gigstackAutomateInvoiceOnComplete, gigstackPortalUrl, gigstackApiToken?,
               gigstackApiTokenPreview?, hasGigstackApiToken?, clearGigstackApiToken? }
}
```

Endpoints: `GET /api/settings/payments`, `POST /api/settings/payments` (module
`settings_payments`), `POST /api/settings/payments/receipt-preview-session` → `{ data: { url,
expiresAt } }` (`backend/src/routes/settings.routes.js:96-98`).

---

## 2. Endpoints de Transacciones (`/api/transactions`)

Rutas: `backend/src/routes/transactions.routes.js`. Controller:
`backend/src/controllers/transactionsController.js`.

### 2.1 `GET /api/transactions` — listar

Query params (todos opcionales):

| Param | Tipo | Default | Notas |
|---|---|---|---|
| `page` | int | 1 | |
| `limit` | int | 50 (máx 5000) | ver regla de paginación abajo |
| `status` | string | `''` | filtro exacto por estado |
| `q` | string | `''` | busca en contacto (nombre/email/teléfono/source) y en pago (reference, title, description, invoice_number, public_payment_id, provider, method, status, id, dígitos de teléfono) |
| `startDate`,`endDate` | `YYYY-MM-DD` | — | rango en TZ del negocio |
| `sortBy` | `date\|created_at\|amount\|status` | `date` | otros valores caen a `date` |
| `sortOrder` | `ASC\|DESC` | `DESC` | desempate estable por `created_at` y `id` |
| `sync` | `'true'\|'false'` | `'false'` | si `true`, sincroniza TODOS los invoices de HighLevel antes de responder (lento) |

**Regla de paginación** (`transactionsController.js:834-838`): solo se pagina si hay rango de
fechas o `limit` explícito Y no hay búsqueda `q`; en caso contrario devuelve TODO
(limit interno 999999). ⇒ el cliente nativo SIEMPRE debe mandar rango de fechas o `limit`.

Filtros implícitos del servidor: contactos ocultos excluidos; pagos hijos de parcialidades aún no
exitosos excluidos; primer pago placeholder de plan Stripe sin link excluido; intentos de checkout
de sitio abandonados excluidos (`transactionsController.js:854-911`). Antes de responder,
reconcilia hasta 25 pagos Stripe pendientes contra la API de Stripe
(`refreshStripeTransactionsForRows`, líneas 279-308).

Respuesta 200:
```json
{ "success": true,
  "data": [ Transaction, ... ],
  "pagination": { "page": 1, "limit": 50, "total": 123, "totalPages": 3,
                   "hasNext": true, "hasPrev": false } }
```
⚠️ El apiClient web descarta `pagination` (devuelve solo `data`); el nativo debe leer el envelope
completo.

### 2.2 `POST /api/transactions` — crear pago manual

Body (todos los campos JSON exactos; `transactionsController.js:644-806`):

```json
{
  "id": "opcional-id-estable",
  "amount": 1500.0,                  // requerido, > 0 → 400 "El monto debe ser mayor a 0"
  "currency": "MXN",                // IGNORADO: se fuerza account_currency
  "method": "cash",                 // o "paymentMethod"; default "cash"
  "status": "paid",                 // default "paid"; debe estar en el enum válido → 400 "Estado de pago inválido"
  "reference": "opcional",
  "title": "Pago",
  "description": "detalle",
  "date": "2026-07-07",             // o ISO completo; ver normalización abajo
  "dueDate": "2026-07-14",
  "contactId": "ct_...",            // al menos uno de contactId/contactName/email/phone
  "contactName": "Juan Pérez",
  "email": "a@b.com",
  "phone": "+52...",
  "paymentMode": "live",            // 'test' o cualquier otro → 'live'
  "metadata": { "lineItems": [...], "tax": {...} }   // objeto opcional
}
```

- **Idempotencia (PAY-007)**: si el cliente manda header `Idempotency-Key` (o
  `X-Idempotency-Key`), el id del pago se deriva como
  `manual_payment_idemp_<key-sanitizada>`; un reintento devuelve 200 con el pago existente sin
  duplicar (`transactionsController.js:98-112, 696-756`). El nativo DEBE mandar Idempotency-Key.
- **Contacto**: se busca por id → email → teléfono; si no existe y hay algún dato, se crea con
  `source='ristak_manual'`. Si no hay ningún dato → 400 `"Necesitas asociar el pago a un contacto
  con nombre, email o teléfono"`.
- **Fecha** (`resolvePaymentTimestamp`, líneas 417-437): sin valor → ahora; con hora → se respeta;
  `YYYY-MM-DD` de HOY (en TZ del negocio) → ahora; otra fecha → ese día a las 12:00 en TZ del
  negocio, convertido a UTC.
- Efectos si el estado es exitoso: Meta Purchase event, export a HighLevel (si conectado),
  factura Gigstack en background, mensaje de recibo (automatización), push notification.
- Respuesta: 201 `{ success: true, data: Transaction }` (200 en replay idempotente).

### 2.3 `GET /api/transactions/:id`

200 `{ success, data: Transaction+atribución }` · 404 `"Transacción no encontrada"`.

### 2.4 `PUT /api/transactions/:id`

Body: subset de `{ amount, currency (ignorada→account), method|paymentMethod, status, reference,
title, description, date, dueDate, contactId, contactName, email, phone }`.

Reglas (todas devuelven `{success:false,error}`):
- `amount <= 0` → 400. `status` inválido → 400.
- Cambio a `paid` de un pago que es **autorización de plan Stripe** (metadata
  `paymentPlan.flowId` + trigger `card_setup|card_setup_authorization|first_payment|
  first_payment_saved_card` o source `stripe_payment_plan_card_setup|stripe_payment_plan_first_link`)
  → 422 `"Este pago activa la domiciliación del plan y solo Stripe puede marcarlo como pagado…"`
  (líneas 213-231, 1296-1298).
- Cambio a `deleted` pasa por el **deletion guard** (§2.6).
- Con invoice HighLevel: cambio a `refunded` → 422 (hacer refund en HighLevel);
  `void` sobre pago exitoso → 422; cualquier estado manual distinto de `paid`/`void` → 422 con
  mensaje explicativo (líneas 1306-1325). Cambio a `paid` registra el pago en GHL
  (`recordPayment`) y a `void` anula el invoice.
- Si el pago es Stripe-backed se resincroniza el plan (`syncStripePaymentPlanFromLocalPayment`).
- Cambios de estado disparan webhooks de producto, push y (para éxito) Meta Purchase.
- Fecha: si el usuario deja el MISMO día, conserva el timestamp original (líneas 444-451).
- Respuesta 200 `{ success, data: Transaction }`.

### 2.5 `DELETE /api/transactions/:id`

Deletion guard (`paymentRecordSafetyService`): 422 con mensajes específicos si pertenece a un
plan de pagos, a una suscripción, o ya tiene actividad de ledger (líneas 233-258). Pagos en modo
test o ya `deleted` → hard delete. Pagos archivables → status `deleted` (o `void` + void del
invoice si es de HighLevel). Respuesta 200 `{ success, message: "Transacción eliminada
correctamente" }`.

### 2.6 Acciones

| Endpoint | Body | Reglas / respuesta |
|---|---|---|
| `POST /:id/refund` | `{}` | Ya reembolsado → 200 `"El pago ya estaba reembolsado"`. Invoice GHL → 422 (refund en HighLevel). No exitoso → 400 `"Solo se pueden reembolsar pagos completados"`. **Solo marca local `refunded`** — NO reembolsa en la pasarela (líneas 1523-1598). 200 `{success, message:"Pago reembolsado correctamente"}` |
| `POST /:id/void` | `{}` | Guard de plan/suscripción → 422. Pago exitoso → 422 `"…registra un reembolso…"`. Anula invoice GHL si existe; marca `void`. 200 `{success,message:"Pago anulado correctamente"}` |
| `POST /:id/record-payment` | `{ amount?: number, paymentDate?: string, paymentMethod?: string }` | Marca `paid` (y en GHL si tiene invoice). Bloquea autorizaciones de plan Stripe (422). Dispara gigstack/recibo/push. 200 `{success,message:"Pago registrado correctamente"}` |
| `POST /:id/send` | `{}` | Solo pagos con invoice GHL; si no → 500 `"No se puede enviar: el pago no tiene invoice asociado"`. 200 `{success,message:"Pago enviado correctamente"}` |
| `GET /:id/payment-link` | — | 200 `{ success, data: { link } }`; usa URL local `/pay/<publicId>` o el link del invoice GHL; sin link → 400 `"El pago no tiene enlace asociado"` |

### 2.7 `GET /api/transactions/stats` y `GET /api/transactions/summary`

Query: `startDate`, `endDate`. `summary` responde
`{ success, data: { totalRevenue, totalRevenuePrev, completedPayments, completedPaymentsPrev,
averageTicket, averageTicketPrev, refunds, refundsPrev } }` (números; período previo de igual
longitud). Excluye pagos test y contactos ocultos (`backend/src/services/analyticsService.js:479+`).
`stats` responde estructura con `total.count` etc. (usado por dashboard, no por /movil pagos).

### 2.8 Planes de pago (alias Ristak de invoice schedules)

Con `requireFeature('payment_plans')`:

- `GET /api/transactions/payment-plans` → `{ success, data: PaymentPlan[] , source? }`. Fusiona
  schedules de HighLevel (si conectado, con paginación interna hasta 10×100) + espejos locales de
  planes Stripe y Conekta; con fallback a caché local (`highlevelController.js:3578-3674`).
  Query: `activeOnly=true`, `limit`, `offset`.
- `POST /api/transactions/payment-plans` body `{ payload: {...}, scheduleNow: true }`.
- `GET /api/transactions/payment-plans/:scheduleId` → `{ success, data, source }`.
- `PUT /api/transactions/payment-plans/:scheduleId` body `{ payload: {...}, updateAndSchedule: true }`.
- `POST /api/transactions/payment-plans/:scheduleId/action` body `{ action, payload }` con
  `action ∈ { activate, pause, cancel, delete, auto-payment }`
  (`highlevelController.js:3984-4016`).

(El wrapper frontend está en `transactionsService.ts:164-196`.)

### 2.9 `POST /api/transactions/payment-flows/installments` — plan de parcialidades (HighLevel/local)

Payload exacto que arma el frontend (`RecordPaymentModal.tsx:2225-2252`):

```json
{
  "contact": { "id": "...", "name": "...", "email": "...", "phone": "..." },  // id requerido
  "totalAmount": 9000,
  "currency": "MXN",                    // ignorada, se fuerza account_currency
  "description": "Concepto",
  "invoicePayload": { ...payload de invoice GHL... },
  "firstPayment": {
    "enabled": true,                     // false o amount<=0 ⇒ sin enganche
    "type": "amount"|"percentage",
    "value": 3000,
    "amount": 3000,
    "date": "YYYY-MM-DD",
    "frequency": "monthly",
    "method": "card"|"bank_transfer"|"cash"|"deposit"|"none"
  },
  "remainingAutomatic": true,
  "remainingFrequency": "custom"|"daily"|"weekly"|"biweekly"|"monthly"|"yearly",
  "remainingPayments": [
    { "sequence": 1, "type": "amount", "value": 3000, "amount": 3000,
      "percentage": null, "dueDate": "YYYY-MM-DD", "frequency": "monthly" }
  ],
  "channels": { "email": true, "sms": false, "whatsapp": true }
}
```

Validaciones backend (`paymentFlowService.js:1821-1868`): contacto requerido; `totalAmount>0`;
≥1 pago restante con montos >0; la suma primer pago + restantes debe cuadrar con el total con
tolerancia **±0.50** (error `"Las parcialidades suman X, pero el total a cobrar es Y"`); primer
pago habilitado exige `method`. Pagos automáticos no pueden tener fechas pasadas.

Respuesta (`highlevelController.js:2252-2268` + `paymentFlowService.js:2004-2246`):
```json
{ "success": true, "message": "Flujo de parcialidades creado correctamente",
  "flowId": "flow_...", "currentState": "<estado §1.6>", "paymentMode": "live",
  "firstPaymentInvoiceId": null|"...", "firstPaymentLink": null|"https://...",
  "cardSetupInvoiceId": null|"...", "cardSetupPaymentLink": null|"https://...",
  "cardSetupSendMethod": null|"...", "stateHistory": [...] }
```

---

## 3. Productos (`/api/products`)

Handlers en `highlevelController.js:1707-1870` (mismo código sirve `/api/highlevel/products*`,
alias legacy).

| Método/Ruta | Request | Response |
|---|---|---|
| `GET /api/products` | query: `limit` (default 100), `offset`, `query` (texto), `includePrices` (`'true'` default; `'false'` para omitir), `sync` (`'true'` fuerza pull desde GHL) | `{ success, products: ProductItem[], total, source: 'ristak' }` |
| `POST /api/products` | `{ name, description?, currency?, productType?, availableInStore?, gigstackProductKey?, gigstackUnitKey?, gigstackUnitName?, postWebhooks?, prices?: [{ id?, localId?, name, amount, currency, type: 'one_time', sku?, description? }] }` | 201 `{ success, product, message: "Producto creado y sincronizado con HighLevel" \| "Producto creado localmente" }` |
| `PUT /api/products/:productId` | mismo shape; actualiza también el precio base incluido | `{ success, product, message }` |
| `DELETE /api/products/:productId` | — | `{ success, ..., message: "Producto eliminado del catálogo" }` (soft: lo quita del catálogo visible; los pagos históricos no se tocan) |
| `GET /api/products/:productId/prices` | — | `{ success, prices: ProductPrice[] }` |
| `POST /api/products/:productId/prices` | `{ name, amount, currency, type, ... }` | 201 `{ success, price, message }` |
| `POST /api/products/sync` | — | `{ success, result }` (sincroniza catálogo con HighLevel) |

⚠️ Estos endpoints NO usan el envelope `data`; los campos van al nivel raíz.

---

## 4. Suscripciones (`/api/subscriptions`) — feature `subscriptions`

Controller: `subscriptionsController.js`; servicio `subscriptionsService.js`.

| Método/Ruta | Request | Response |
|---|---|---|
| `GET /api/subscriptions` | query `status` (`all` o un estado), `refresh` (`true|1|yes` sincroniza pendientes de MP) | `{ success, data: { subscriptions: PaymentSubscription[], summary: { total, active, paused, pastDue, monthlyRevenue, nextRunAt } } }` |
| `GET /api/subscriptions/:subscriptionId` | — | `{ success, data: PaymentSubscription }` · 404 `"Suscripción no encontrada."` |
| `POST /api/subscriptions` | `SubscriptionPayload` (ver §1.4; campos `contactId?, contactName?, contactEmail?, contactPhone?, name*, description?, status?, amount*, currency, intervalType, intervalCount, startDate?, nextRunAt?, cancelAt?, paymentMethod?, paymentProvider?, paymentMode?, source?, metadata?` + ids de pasarela) | 201 `{ success, data }` · errores 400 con mensaje |
| `PUT /api/subscriptions/:id` | mismo payload | `{ success, data }` |
| `POST /api/subscriptions/:id/action` | `{ "action": "pause"\|"activate"\|"resume"\|"cancel"\|"mark_past_due", "payload": { "nextRunAt"? } }` | `{ success, data }`; acción desconocida → 400 `"Acción de suscripción no soportada."` |
| `DELETE /api/subscriptions/:id` | — | **204 sin body** · 422 si ya tiene cobros (`"…cancélala para conservar el historial."`) |

Validaciones create/update (`subscriptionsService.js:1186-1199, 1306-1328`): `name` obligatorio;
`amount > 0`; CLIP prohibido como método (`clip*` → error); `startDate`/`nextRunAt` no pueden ser
pasadas (TZ del negocio). Las acciones pause/resume/cancel se propagan a la pasarela remota
(Stripe/MP/Conekta/Rebill). Delete = cancela en pasarela + status `deleted` local (hard delete solo
para test).

**Métodos de pago por pasarela para crear** (regla `/movil` + `docs/MOBILE_APP.md:887-891`):
- Autorización por link: `paymentMethod: 'stripe_link'` (Stripe) o `'conekta_link'` (Conekta) —
  genera pago de arranque público (`subscriptionStartUrl`).
- Tarjeta guardada / provider-side: `'stripe_saved_card'`, `'conekta_subscription'`,
  `'rebill_subscription'`, `'mercadopago_subscription'`.
- `PhoneSubscriptionForm` manda: stripe→`stripe_saved_card`, conekta→`conekta_subscription`,
  mercadopago→`mercadopago_subscription`, rebill→`rebill_subscription`; `status`
  `'incomplete'` para mercadopago/rebill (requieren autorización del cliente) y `'active'` para
  stripe/conekta; `nextRunAt` null para MP/rebill (`PhoneSubscriptionForm.tsx:324-364`).
- Link de activación a compartir: MP → `mercadoPagoInitPoint` (o sandbox en modo test);
  Rebill → `rebillPaymentLinkUrl || rebillCheckoutUrl || subscriptionStartUrl`
  (`PhoneSubscriptionForm.tsx:115-130`).

Restricciones de frecuencia (frontend, `PhoneSubscriptionForm.tsx:200-207, 312-318`):
Conekta NO acepta `daily`; Rebill SOLO `monthly|yearly`. Stripe y MP aceptan las 4.

---

## 5. Pasarelas: links de pago, MSI, tarjetas guardadas y planes

Rutas por pasarela (`stripe.routes.js`, `conekta.routes.js`, `mercadopago.routes.js`,
`clip.routes.js`, `rebill.routes.js`). Todas las respuestas usan envelope `{success,data}` y
error `{success:false,error}` con `error.status`.

### 5.1 Matriz de capacidades

| Capacidad | Stripe | Conekta | Mercado Pago | CLIP | Rebill | HighLevel |
|---|---|---|---|---|---|---|
| Link de pago único (`POST /api/<gw>/payment-links`) | ✅ | ✅ | ✅ (devuelve además `preferenceId`) | ✅ | ✅ | vía invoice + send |
| MSI en link | ✅ MXN, monto ≥ **$300**, hasta 3/6/9/12/18/24; Stripe confirma plazos reales por tarjeta | ✅ mínimos por plazo: 3→$300, 6→$600, 9→$900, 12→$1200, 18→$1800 (Citibanamex), 24→$2400 (BBVA/Banorte/Afirme) | ✅ hasta 2/3/6/9/12/18/24 (o contado) | ✅ MXN, monto ≥ $300, máx 24; CLIP decide plazos en su Dashboard | ✅ 3-24; Rebill decide según cuenta/país/tarjeta | ❌ |
| Tarjetas guardadas (`GET /api/<gw>/contacts/:contactId/payment-methods\|payment-sources`) | ✅ `/payment-methods` | ✅ `/payment-sources` | ❌ | ❌ | ✅ `/payment-sources` | ❌ |
| Cobro directo tarjeta guardada (`POST /api/<gw>/saved-card-payments`) | ✅ | ✅ (acepta `installments`) | ❌ | ❌ | ✅ | ❌ |
| Plan de pagos (`POST /api/<gw>/payment-plans`) | ✅ | ✅ | ✅ backend (la UI web NO lo ofrece) | ❌ | ✅ | vía `/api/transactions/payment-flows/installments` |
| Suscripciones | ✅ | ✅ (no daily) | ✅ (por autorización) | ❌ | ✅ (monthly/yearly) | ❌ |
| Restricciones extra | — | — | — | Solo MXN; requiere email **y** teléfono del contacto | — | — |

Providers para UI (hook `usePaymentGatewayCapabilities`,
`frontend/src/hooks/usePaymentGatewayCapabilities.ts:81-106`):
`planProviders = [stripe, conekta, rebill]` conectados; `subscriptionProviders = [stripe, conekta,
mercadopago, rebill]` conectados; `canUsePaymentPlans = highLevelConnected || planProviders.length>0`;
`canUseSubscriptions = subscriptionProviders.length>0`.
La app RN además exige feature de licencia (`resolveMobilePaymentAccess`,
`mobile/src/App.tsx:12831-12855`): `canUsePaymentPlans = planProviders>0 &&
license.features.payment_plans`; ídem `subscriptions`. `offlineOnly = ninguna pasarela conectada`.

### 5.2 Estado de conexión

`GET /api/integrations/status` (SIN envelope) →
`{ highlevel: { configured, connected, locationId, locationData, accessToken },
   meta, whatsapp, openai, googleCalendar,
   stripe?: { configured, connected, connectionType?, mode?, publishableKey?, accountLabel? },
   mercadopago?: {...}, conekta?: {...}, clip?: {..., hasApiKey? }, rebill?: {..., webhookConfigured? } }`
(`frontend/src/services/integrationsService.ts:78-89`). "Conectado" = `connected === true`
(RN también acepta `configured === true`).

### 5.3 `POST /api/<gw>/payment-links` — payload común

Idéntico para stripe/conekta/mercadopago/clip/rebill
(tipos en `stripePaymentsService.ts:67-85` y análogos):

```json
{
  "contactId": "ct_...",           // opcional pero el modal siempre lo manda
  "contactName": "Juan",
  "email": "a@b.com",
  "phone": "+52...",
  "amount": 1000,                   // BASE gravable (taxBaseAmount): si exclusive = subtotal;
                                     // si inclusive = total. El backend recalcula el impuesto.
  "currency": "MXN",               // informativa; el backend usa la moneda configurada
  "applyTax": true,                  // default true; false desactiva impuestos en este cobro
  "taxCalculationMode": "exclusive"|"inclusive",
  "title": "Pago",
  "description": "…",
  "dueDate": "YYYY-MM-DD",
  "source": "record_payment_modal[_<gw>]",
  "lineItems": [ { name, description, amount, qty, currency, priceId?, productId?, ... } ],
  "installments": { "enabled": false, "maxInstallments": 12 }   // MSI; clip acepta también number
}
```

Respuesta 201: `{ success, data: { payment: PublicPayment, paymentUrl, publicPaymentId } }`
(MP agrega `preferenceId`). El backend crea la fila en `payments` con `status='sent'`,
`payment_method=<gw>`, `payment_provider=<gw>`, `payment_mode` según config, `public_payment_id`
y `payment_url = <base>/pay/<publicId>` (`stripePaymentService.js:1467-1545`). Error 400 si
`amount<=0` (`"El monto debe ser mayor a 0."`).

`PublicPayment` (por pasarela; tipos completos en `stripePaymentsService.ts:147-202`,
`conektaPaymentsService.ts:112-158`, `mercadoPagoPaymentsService.ts:104-154`,
`clipPaymentsService.ts:88-147`, `rebillPaymentsService.ts:189-250`): incluye `id`,
`publicPaymentId`, `paymentUrl`, `status`, `amount`, `currency`, `title`, `description`,
`dueDate/sentAt/paidAt`, `timezone`, `paymentMode`, `provider`, `contact{id,name,email,phone}`,
ids de la pasarela, config de MSI (`stripeInstallments`/`conektaInstallments`/
`mercadoPagoInstallments`/`clipInstallments`/`rebillInstallments`), `tax{...}` desglosado,
`settings` (PublicPaymentSettings), `subscriptionStart`, `paymentPlan` (Stripe) y
`metaPurchaseEvent`.

### 5.4 Tarjetas guardadas

- `GET /api/stripe/contacts/:contactId/payment-methods` → `{ success, data:
  StripeSavedPaymentMethod[] }`. El backend refresca desde Stripe y persiste
  (`stripePaymentService.js:3351-3398`). 404 si el contacto no existe.
- `GET /api/conekta/contacts/:contactId/payment-sources`,
  `GET /api/rebill/contacts/:contactId/payment-sources` → análogos.
- `POST /api/<gw>/saved-card-payments` body
  (`StripeSavedCardPaymentPayload`/`ConektaSavedCardPaymentPayload`/`RebillSavedCardPaymentPayload`):
  `{ contactId*, paymentMethodId* (stripe) | paymentSourceId* (conekta/rebill), contactName?,
  email?, phone?, amount*, currency*, applyTax?, taxCalculationMode?, title?, description?,
  dueDate?, source?, lineItems?, installments? (solo conekta) }` → 201
  `{ success, data: { payment } }` donde `payment.status` puede ser `paid` inmediato o
  pendiente ("la pasarela está terminando de procesar").

### 5.5 `POST /api/<gw>/payment-plans` (stripe/conekta/rebill; mercadopago existe en backend)

Payload (`StripePaymentPlanPayload`, `stripePaymentsService.ts:279-310`; conekta/rebill idénticos,
rebill agrega `frequency`/`paymentMethod` opcionales por pago):

```json
{
  "contact": { "id": "ct_*", "name", "email", "phone" },
  "totalAmount": 9000, "currency": "MXN",
  "description": "…", "title": "…",
  "invoicePayload": { ... },              // el payload de invoice armado por el modal
  "firstPayment": { "enabled": true, "amount": 3000, "date": "YYYY-MM-DD",
                     "frequency": "monthly", "method": "card"|"cash"|... },
  "remainingFrequency": "monthly",
  "remainingPayments": [ { "sequence", "type", "value", "amount", "percentage",
                            "dueDate": "YYYY-MM-DD", "frequency" } ],
  "paymentMethodId": "pm_..." | "src_..." | "card_...",   // "" si tarjeta nueva por link
  "cardSetupAmount": 25,
  "source": "record_payment_modal_<gw>_plan"
}
```

Respuesta 201 `{ success, data }`:
```json
{ "flowId": "flow_…", "currentState": "<estado §1.6>", "paymentMode": "test|live",
  "firstPaymentLink": null|url, "firstPaymentPaymentId": null|id,
  "cardSetupLink": null|url, "cardSetupPaymentId": null|id, "cardSetupAmount": 25,
  "savedPaymentMethod": SavedCard|null,    // stripe (savedPaymentSource en conekta/rebill)
  "scheduledPayments": [ { "installmentId", "paymentId", "sequence", "amount",
                            "currency", "dueDate", "status" } ] }
```

Semántica: si se dio `paymentMethodId` (tarjeta guardada) el plan queda programado directo;
si el primer pago es con tarjeta/link, `firstPaymentLink` autoriza la tarjeta al pagarse; si el
primer pago fue offline (o no hay), se genera `cardSetupLink` (domiciliación por
`cardSetupAmount`, default $25, configurable en `/api/highlevel/config.cardSetupAmount`).

### 5.6 Configuración por pasarela (módulo `settings_payments`; solo para pantalla Ajustes)

`GET|POST|DELETE /api/<gw>/config`, `POST /api/<gw>/config/test`. Shapes en
`stripePaymentsService.ts:4-65`, `conektaPaymentsService.ts:32-61`,
`mercadoPagoPaymentsService.ts:26-64` (+ `/connect/url`, `/connect/sync`, `/connect/mode`,
`/config/subscription-test-credentials`), `clipPaymentsService.ts:23-54`,
`rebillPaymentsService.ts:31-77`. Todas devuelven `webhookEndpointPath` y `webhookEndpoints[]`
`{source,label,description,url}`.

### 5.7 Endpoints públicos de checkout (sin auth; consumidos por la página `/pay/<id>`)

El nativo NO los implementa (abrir `paymentUrl` en Safari/SFSafariViewController), pero existen:
- Stripe: `GET /api/stripe/public/payments/:publicPaymentId` (query `sync`, `session_id`),
  `POST …/intent`, `POST …/installment-plans`, `POST …/installment-confirm`,
  `POST …/subscription-checkout`.
- Conekta: `GET …`, `POST …/card` `{tokenId, savePaymentSource?, installments?}`,
  `POST …/subscription` `{tokenId}`.
- Mercado Pago: `GET …`, `POST …/preference`, `POST …/card`, `GET /api/mercadopago/subscriptions/return`.
- CLIP: `GET …`, `POST …/card`, `POST …/refresh`.
- Rebill: `GET …`, `POST …/confirm` `{rebillPaymentId|paymentId, installments?}`.
- Webhooks: `POST /api/<gw>/webhook`.

### 5.8 HighLevel (integración opcional)

- `GET /api/highlevel/config` (auth) → objeto de config SIN envelope: incluye `businessName`,
  `businessEmail`, `companyLogoUrl`, `locationData` (JSON con business/address), `invoiceTermsNotes`,
  `invoiceDueDays` (default 7), `cardSetupAmount` (default 25), `ghlInvoiceMode` (`live|test`),
  `transferInfoUrl` (URL de datos de transferencia para pagos manuales), `domain`
  (uso en `RecordPaymentModal.tsx:1428-1456`).
- `POST /api/highlevel/invoices` — crea invoice en GHL y su espejo local (status `draft`).
  Body = invoice payload (§6.3.2, `cleanPayload` en `RecordPaymentModal.tsx:3385-3447`):
  `{ name, title, currency, businessDetails{name,email?,logoUrl?,phone?,website?,address{line1,city,state,country,postalCode}}, contactDetails{id,name,email,phoneNo}, items[{name,description,amount,qty,currency,priceId?,productId?}], metadata{lineItems,tax?}, issueDate, dueDate, liveMode, tax?{name,rate,amount}, termsNotes? }`.
  Respuesta `{ success, invoice: {...} }` — el id es `invoice.id || invoice._id`.
- `POST /api/highlevel/invoices/:invoiceId/send` — body `{ method: 'email'|'sms'|'both' }` (vía
  `highLevelService.sendInvoice`).
- `POST /api/highlevel/invoices/:invoiceId/record-payment` — body `{ amount*, currency,
  paymentDate, paymentMethod ('cash'|'transfer'|'bank_transfer'|'card'|'check'|'other'),
  reference?, notes? }`; marca `paid` local + GHL, actualiza stats del contacto, dispara
  gigstack/push (`highlevelController.js:2087-2246`). → `{ success, message: "Pago registrado
  correctamente" }`.
- `POST /api/highlevel/invoices/:invoiceId/sync` — re-sincroniza un invoice puntual.
- `POST /api/highlevel/contacts/search` — body `{ query, limit }` →
  `{ contacts: [{id,name,email,phone,firstName,lastName}] }` (para buscar contacto cuando GHL
  está conectado).
- Nota: el flujo GHL solo se usa si `highlevel.connected`; sin GHL el pago manual se registra
  directo con `POST /api/transactions` (§2.2).

### 5.9 Otros endpoints de soporte

- `GET /api/contacts/:id/payment-link-delivery-options` → `{ success?, data }` con
  `{ contact:{id,name,email,phone}, channels: { whatsapp|messenger|instagram|email:
  { key, label, available, connected, value, reason? } } }`
  (`contacts.routes.js:81`, tipo en `contactsService.ts:68-87`). Se usa en el panel "link listo"
  para ofrecer envío directo.
- Envío del link por canal (mismo panel, `PaymentLinkReadyPanel.tsx:158-201`):
  email → `emailService.send` (`/api/email/...`), whatsapp → `whatsappApiService.sendText`
  (`/api/whatsapp-api/messages/text`), messenger/instagram →
  `whatsappApiService.sendMetaSocialText`.

---

## 6. Inventario UX — `/movil` (fuente de verdad para el diseño nativo)

### 6.1 Página `PhonePayments` (`frontend/src/pages/PhonePayments/PhonePayments.tsx`)

Ruta `/movil/pagos` (deep-link `?mode=single|partial|subscription|products` fija la vista inicial,
línea 93-96). Estados de acceso: `checking` (muestra `PhoneStartupLoader`), `blocked` (pantalla
"Ruta móvil / Solo celular o tablet" con link "Ir a pagos" a `/transactions`), `allowed`.
Título de documento: `Pagos móviles | Ristak`. Navegación inferior `PhoneEcosystemNav`
(tab activa `payments`).

**Vista `select` (home de pagos)** — título `Elige cómo quieres pagar` y tarjetas (choice cards con
icono, título, subtítulo y chevron):
1. `Registrar pago único` — "Cobro único: envía una liga de pago o registra un pago manual."
   (siempre visible; icono CreditCard verde).
2. `Planes de pago` — "Parcialidades automáticas con enganche y cobros recurrentes."
   (solo si `canUsePaymentPlans`; icono CalendarDays azul).
3. `Suscripción` — "Cobros recurrentes con Stripe, Conekta o Mercado Pago."
   (solo si `canUseSubscriptions`; icono Repeat2).
4. `Precios Guardados` — "Revisa, crea, modifica o elimina precios para cobrarlos desde el
   celular." (siempre; icono Package).

**Últimos pagos** (sección colapsable al fondo): toggle "Mostrar últimos pagos"/"Ocultar últimos
pagos" con subtítulo `"<Periodo> recientes"` o `"<monto> seleccionado"`. Al abrir: picker de
periodo (chips `Hoy`, `7 días`, `30 días`, `90 días`; default `30 días`; rango = hoy y
`días-1` hacia atrás en TZ del negocio, líneas 67-107). Carga con
`transactionsService.getTransactions(startDate,endDate)` filtrando `amount>0` y estado
`paid|partial`, orden desc por `date||createdAt`. **Caché diaria** por clave
`phone-payments/recent-payments/<periodo>` (bucket por día del negocio, guarda hasta 80 items):
si hay caché se pinta al instante y se muestra "Mostrando lo guardado, actualizando pagos" con
spinner mientras refresca (líneas 482-537, 921-926). Estados: cargando ("Cargando…"), vacío
("No hay pagos recibidos en este periodo."). Lista muestra máx **24** filas; cada fila:
monto formateado (`Intl es-MX` con currency del pago o de la cuenta), etiqueta de contacto
(nombre → email → teléfono → "Cliente sin nombre"), fecha (día+mes corto, con hora si el valor
tiene hora), `"<Método> · <Estado>"` con labels: Tarjeta/Transferencia/Efectivo/Cheque/PayPal/Otro
y Pagado/Parcial/Reembolsado/Fallido/Pendiente (líneas 132-150). Tocar una fila la selecciona
(check) / deselecciona — es solo selección visual, **no hay pantalla de detalle** en /movil.

**Vista `products` (Precios Guardados)**: header con botón "Atrás" (se oculta al scrollear hacia
abajo). Toolbar: "Precios Guardados" + "N disponibles"/"1 disponible", botón refresh (icono girando
si refresca) y botón "Nuevo". Formulario inline crear/editar ("Nuevo producto"/"Editar producto",
"Estos datos aparecerán al cobrar desde Guardados."): campos `Nombre del producto`
(placeholder "Ej. Consulta inicial"), `Precio (<currency>)` (decimal, "0.00"), `Nombre del precio`
("Precio base"), `Descripción` (textarea "Agrega una nota corta para reconocerlo."); botones
Cancelar/Guardar. Validaciones toast: "Falta el nombre / Escribe cómo se llama el producto." y
"Falta el precio / Escribe un precio válido para poder cobrarlo.". Payload de guardado
(líneas 263-310): `{ name, description, currency: accountCurrency, prices: [{ id, localId,
name: priceName||'Precio base', amount, currency, type: 'one_time' }] }` → `POST /products` o
`PUT /products/:id`. Eliminación con confirm: título "Eliminar producto", mensaje
`Se quitará "<name>" de la lista para cobrar. Los pagos anteriores no se borran.`, botones
Eliminar/Cancelar → `DELETE /products/:id`. Estados: cargando, error ("No se pudieron cargar"),
vacío (icono Package, "Sin productos todavía", "Crea tu primer producto para cobrarlo rápido desde
el celular.", botón "Crear producto"). Cada item: icono, nombre ("Producto sin nombre"),
descripción ("Sin descripción"), `"<priceName> · <monto>"` o "Sin precio guardado", acciones
editar (lápiz) y eliminar (basura con spinner).

**Vistas `single`/`partial`**: montan `RecordPaymentModal` embebido
(`variant="embedded"`, `initialPaymentMode='single'|'partial'`, `lockPaymentMode`) — §6.3.
**Vista `subscription`**: monta `PhoneSubscriptionForm` — §6.4.

Comportamiento táctil: la página bloquea el scroll del documento y gestiona el touch para que solo
los contenedores `[data-phone-scrollable]` scrolleen (líneas 370-480); overlays de sheets marcan
`data-phone-payments-sheet="true"`.

### 6.2 Capacidades y datos que carga la página

- `usePaymentGatewayCapabilities()` (cachea `/api/integrations/status` en localStorage con TTL
  60 s / snapshot 7 días).
- `useAccountCurrency()` (clave `account_currency` de `/api/config`; default por locale).
- `useTimezone()` → TZ del negocio para rangos y formato.

### 6.3 `RecordPaymentModal` — wizard de cobro (único y parcialidades)

Archivo: `frontend/src/components/common/RecordPaymentModal/RecordPaymentModal.tsx` (5871 líneas).
Variantes: `modal` (escritorio) y `embedded` (móvil, con botón "Atrás" flotante que se oculta al
scrollear y barra inferior fija con "Total a cobrar"). Pasos (`step`):
`form → options → processing → link_ready`.

Al abrir carga: `/api/highlevel/config` (negocio, `invoiceDueDays`, `cardSetupAmount`,
`ghlInvoiceMode`, `transferInfoUrl`), `/api/settings/payments` (taxes) y
`/api/integrations/status` (flags por pasarela) (líneas 1659-1669).

#### 6.3.1 Paso `form`

- **Cliente**: en embedded, un "contact picker" botón (avatar/iniciales, nombre, email|teléfono,
  chevron; placeholder "Seleccionar contacto" / "Busca por nombre, teléfono o correo") que abre un
  bottom-sheet ("Cliente / Seleccionar contacto") con búsqueda ("Buscar contacto") y lista. Con
  <2 caracteres muestra los 60 contactos más recientes (`GET /api/contacts?page=1&limit=60&
  sortBy=created_at&sortOrder=DESC`); con query: si HL conectado
  `POST /api/highlevel/contacts/search {query,limit:10}`; si no
  `GET /api/contacts/search?q=` (líneas 1698-1791; debounce 90 ms). Estados: "Buscando
  contactos...", "Busca por nombre, teléfono o correo.", "No se encontraron contactos.". Botón X
  para quitar contacto. Puede venir contacto bloqueado (`lockInitialContact`).
- **Tipo de cobro**: tabs segmentadas `Personalizado` | `Productos` (líneas 3727-3754).
  - Personalizado: campo `Monto (<currency>)` con icono $.
  - Productos: select `Producto` (con botón "+ Nuevo" que abre panel de creación rápida con
    Nombre, Precio, Nombre del precio, Descripción, y si Gigstack está activo, "Categoría SAT para
    facturas" y "Unidad fiscal"; botones "Guardar producto"/"Cancelar"; crea con
    `POST /api/products` con `productType:'DIGITAL'`, `availableInStore:false`), select `Precio`
    ("<nombre> - <monto>"; hint "No hay precios disponibles para este producto"), y campo
    `Monto a cobrar (personalizable)` con hint "Puedes modificar el precio según tu negociación
    con el cliente". Productos: `GET /api/products?limit=100`; precios:
    `GET /api/products/:id/prices`.
- `Título de factura` (placeholder "Pago") y `Descripción del producto / detalle`
  (placeholder "Ej: Pago de servicios, consulta, etc.").
- **Impuestos** (solo si `taxes.enabled`): tabs `Sin <taxName>` | `Aplicar <rate>%`; si aplica,
  tabs `Cálculo del impuesto`: `Se suma al total` (exclusive) | `Ya incluido` (inclusive).
  Cálculo (líneas 82-119): exclusive → tax = amount×rate/100 y total = amount+tax;
  inclusive → tax = amount − amount/(1+rate/100), subtotal = amount − tax, total = amount.
- **Plan de pagos** (solo `partial`): sección "Plan de pagos / Define el primer pago y los cobros
  automáticos hasta cubrir el total a cobrar." con:
  - `Frecuencia de cobro`: Diario/Semanal/Quincenal/Mensual/Anual/Personalizada.
  - `Tipo de valor`: `Monto fijo` | `Porcentaje`.
  - Hint: con frecuencia automática "Las fechas se calculan automáticamente. Cambia a
    'Personalizada' para editarlas a mano."; personalizada "Ajusta el monto/porcentaje y la fecha
    de cada cobro.".
  - Lista de filas numeradas (#, Valor, Fecha de cobro, eliminar). La fila #1 es el **primer
    pago**: select `Cobrar inmediato` | `Cobro programado`; si inmediato, segundo select con el
    método: `Tarjeta / link`, `Transferencia`, `Efectivo`, `Depósito` (default `card`; el modal
    abre con primer pago habilitado y `card`, líneas 1383-1388). Fechas con date-picker nativo
    compartido (`PhoneDateField`, mínimo hoy). Botón `+ Agregar pago`.
  - Distribución automática: mientras el usuario no edite montos, el total se reparte en partes
    iguales (primer pago incluido si está en modo auto); al editar un valor se apaga el auto
    (líneas 1860-1913).
  - Barra "Asignado al plan": `X / Y` con estados `ok` ("El plan cuadra con el total a cobrar."),
    `under` ("Faltan $Z por asignar."), `over` ("Te excediste $Z del total.") — tolerancia ±0.50.
  - Aviso de autorización (ShieldCheck) con textos según pasarelas/tarjetas guardadas
    (líneas 1030-1048).
- Escritorio muestra tarjeta "Resumen del cobro" (Subtotal, impuesto, "Total a cobrar"); en
  embedded ese total vive en la barra inferior fija.
- **Footer**: botón primario `Continuar` (single) o `Crear parcialidades` (partial); "Preparando..."
  con spinner al cargar. Validaciones al continuar (líneas 2408-2465, toasts): "Selecciona un
  contacto", "Ingresa un monto válido", "Selecciona un producto", "Selecciona un precio",
  "Ingresa un total válido para el plan", "Selecciona un método de pago para el primer pago",
  "El primer pago debe ser menor al total cuando hay parcialidades restantes", "Agrega al menos
  un pago restante", "Todos los pagos restantes necesitan monto y fecha", "Las parcialidades no
  cuadran: faltan o sobran $X".
- Al continuar arma `invoicePayload` (§5.8) e `invoiceSummary` `{contactId, contactName,
  contactEmail, amount(total), subtotal, taxAmount, includesTax, taxName, taxRate,
  taxCalculationMode, taxBaseAmount, currency, description}` y pasa a `options`.

#### 6.3.2 Paso `options` — pago único

Encabezado: tarjeta resumen (Cliente, nombre, email; "Total a cobrar" + desglose de impuestos o
"Este cobro no incluye impuestos"; "Concepto"). Etapas (`singlePaymentOptionsStage`):

- **`method`** (elige acción):
  1. `Registrar pago manual` — "Marca el invoice como pagado (efectivo, transferencia, etc.)"
     (con HL) / "Registra el pago en Ristak (efectivo, transferencia, etc.)" (sin HL).
  2. `Enviar enlace de pago` (si hay pasarelas) — descripción "Después eliges pasarela: <lista>."
     o texto específico de la única pasarela (líneas 4714-4728).
  3. `Cobrar tarjeta guardada` (si hay una pasarela compatible; se deshabilita cuando el
     contacto no tiene tarjetas Stripe/Conekta/Rebill) —
     descripción "Elige la tarjeta guardada en <Stripe o Conekta o Rebill>." / "…de <único>." /
     "Este cliente todavía no tiene tarjetas guardadas.".
- **`gateway`** (si hay >1 pasarela): opciones con logo y copy:
  Stripe "Genera tu página pública con campo seguro de tarjeta y meses sin intereses si aplica.";
  Conekta "Genera tu página pública con tokenizador seguro y opción de meses sin intereses.";
  Mercado Pago "Genera el enlace y después configura si tendrá meses sin intereses.";
  CLIP "Genera una página pública con Checkout Transparente y MSI si aplica.";
  Rebill "Genera una página pública con checkout seguro y opción de meses sin intereses si aplica.";
  HighLevel "Envía automáticamente al cliente." con selector de canal (WhatsApp, SMS, Email,
  Email + WhatsApp, Email + SMS, Todos — según email/teléfono del contacto; default "Todos";
  aviso rojo "Sin email ni teléfono").
- **`gateway_config`** (config por pasarela): elección `Cobro único` ("Crea el link de <GW> para
  pago de contado.") vs `Meses sin intereses` (con descripciones/mínimos por pasarela,
  líneas 4660-4685) y panel de MSI:
  - Stripe: select "Máximo de meses" (3/6/9/12/18/24; default 24); resumen "Cliente paga /
    Referencia mensual (X × N) / Ristak registra"; nota "Ristak mostrará sólo los plazos que
    Stripe confirme para la tarjeta del cliente y nunca más de N meses…". Requiere MXN y ≥$300.
  - Mercado Pago: select "Máximo de meses" (2..24); nota "Mercado Pago solo mostrará meses
    disponibles… Ristak registra el total completo cuando el pago se confirma por webhook.".
  - Conekta: select con opciones deshabilitadas si el monto no alcanza el mínimo
    ("<N> meses (banco) - mínimo $X"), tabla "Montos mínimos", ayuda "Sube el monto del cobro para
    habilitar meses sin intereses.", nota "Conekta valida la disponibilidad con el banco emisor…".
  - CLIP: panel informativo (no hay select; "CLIP decide planes"); datos requeridos
    "Email y teléfono listos"/"Falta email o teléfono".
  - Rebill: select "Máximo de meses" (3..24, default 12); nota "…Rebill mostrará MSI solo cuando
    la cuenta, país, moneda, monto y tarjeta califiquen.".
- **`saved_cards`**: filas por pasarela con logo, descripción ("Se cobrará inmediatamente con
  Stripe."/"…Rebill."; Conekta: "Elige cobro único o meses sin intereses antes de cobrar." o
  "Se cobrará de contado; MSI requiere monto mínimo.") y un select de tarjeta
  ("VISA •••• 4242 · vence 12/27"). Conekta permite después elegir contado/MSI.
- **`manual`**: campos `Fecha de pago` (date-picker, default hoy TZ negocio), `Método de pago`
  (Efectivo / Transferencia bancaria / Tarjeta / Cheque / Otro; default Transferencia),
  `Referencia (opcional)` ("Número de transferencia, cheque, etc."), `Notas internas`. Si método =
  transferencia y hay `transferInfoUrl` configurada: panel "Enlace para transferencias / Comparte
  este enlace con el cliente para completar el depósito." con URL y botón "Copiar enlace"
  (o hint "Configura la URL en Ajustes > Pagos para mostrarla aquí.").

**Etiquetas del botón confirmar** (líneas 5525-5565): `Continuar` (elecciones intermedias),
`Cobrar tarjeta`, `Cobrar a <N> MSI` (conekta saved card con MSI), `Crear link Stripe`,
`Crear link Conekta`, `Crear link Mercado Pago`, `Crear link CLIP`, `Crear link Rebill` /
`Crear link Rebill hasta N meses`, `Enviar enlace` (HL), `Registrar pago` (manual). Botón
"Regresar" (solo escritorio; en embedded el botón "Atrás" navega hacia atrás por etapas).
Deshabilitadores con tooltip (líneas 5607-5746): sin canal de envío, sin tarjeta guardada
("Selecciona una tarjeta guardada"), CLIP sin email/teléfono ("CLIP requiere email y teléfono"),
CLIP/Stripe moneda-monto MSI ("… requiere MXN y mínimo 300 MXN para meses sin intereses"),
Conekta plazo no disponible ("Selecciona un plazo disponible para Conekta"), plan sin pasarela o
sin tarjetas.

**Ejecución al confirmar** (líneas 2582-3578):
- Tarjeta guardada → `POST /api/<gw>/saved-card-payments`; toasts "Cobro realizado /
  <tarjeta> quedó cobrada correctamente[ a N meses sin intereses]." o "Cobro enviado a <GW> /
  <GW> está terminando de procesar este cobro."; error "No se pudo cobrar la tarjeta".
- Link por pasarela → `POST /api/<gw>/payment-links` con `amount = taxBaseAmount`,
  `applyTax = includesTax`, `installments{enabled,maxInstallments}` → paso `link_ready`.
  Toasts "Link de <GW> creado".
- HighLevel `send` → crea invoice (`POST /api/highlevel/invoices`) + `POST …/send` con método
  mapeado (`whatsapp|sms→sms`, `email→email`, resto `both`); valida email/teléfono con errores
  "El contacto no tiene teléfono registrado…" / "…email registrado…". Después
  `POST …/invoices/:id/sync` silencioso.
- Manual con HL → crea invoice + `POST …/record-payment`; **fallback**: si falla antes de crear
  el invoice, guarda localmente vía `POST /api/transactions` (toast "Pago registrado en Ristak /
  El pago quedó guardado y aparecerá en el historial del contacto.").
- Manual sin HL → `POST /api/transactions` con `status:'paid'`, `date` =
  `buildPaymentTimestamp(fecha, tz)`, `metadata.lineItems` y `metadata.tax` (líneas 3308-3360).
  Toast "Éxito / Pago registrado correctamente".

#### 6.3.3 Paso `options` — plan de pagos (`partial`)

Resumen: "Total parcializado", "Primer pago", "Cobros programados: N pagos programados",
"Autorización: <texto dinámico>". Etapas: `method` (elige `Cobrar tarjeta guardada` vs
`Enviar enlace de pago`), `gateway` (Stripe/Conekta/Rebill/HighLevel con copys "La pasarela
enviará el primer link; cuando se pague, guardará la tarjeta y activará los cobros futuros." o
"…enviará domiciliación por $<cardSetupAmount>; al pagarse, guardará la tarjeta y activará el
plan."), `saved_cards` (filas con select de tarjeta y "Programará los cobros futuros con <GW>."),
`confirm`. Botones: `Continuar`, `Programar con tarjeta`, `Crear plan Rebill`,
`Crear y enviar enlace` (HL), `Registrar pago y enviar enlace de domiciliación` (si el primer pago
es offline), `Crear link de domiciliación`.

Ejecución: Stripe/Conekta/Rebill → `POST /api/<gw>/payment-plans` (§5.5); HighLevel/local →
`POST /api/transactions/payment-flows/installments` (§2.9) con `channels` según el método de envío
elegido. Resultados → paso `link_ready` con `kind: 'card_setup'` ("Enlace de domiciliación listo",
"Comparte este enlace para que el cliente domicilie su tarjeta. El plan se activa cuando pague y
guarde la tarjeta.") o `kind: 'first_payment'` ("Primer pago listo", "…Al pagarlo se guarda la
tarjeta y se activan los siguientes cobros programados."); o toast directo "N cobros quedaron
programados con tarjeta guardada." Si el flujo HL queda `waiting_card_authorization`:
"Parcialidades creadas. El sistema esperará la autorización de tarjeta antes de activar los pagos
automáticos.".

#### 6.3.4 Paso `link_ready` — `PaymentLinkReadyPanel`

(`frontend/src/components/common/PaymentLinkReadyPanel/PaymentLinkReadyPanel.tsx`)
Muestra: logo de pasarela, título/descr., "Cliente" y "Monto", caja "Enlace público de pago" con
URL + botones `Copiar` y `Abrir`, y sección "Enviar por / Solo aparecen los canales conectados
para este contacto." con botones por canal (WhatsApp, Messenger, Instagram, Email) según
`GET /api/contacts/:id/payment-link-delivery-options`; estado "Revisando canales..." y vacío
"Este contacto no tiene canales conectados para envío directo. Copia el enlace y mándalo
manualmente.". Texto de compartir por defecto (líneas 72-84): "Hola <nombre>, te comparto tu
enlace de pago por $X:\n<url>" (variantes para domiciliación/primer pago/suscripción). Asunto de
email: "Enlace de pago - <negocio>" etc. Footer del modal: botón `Listo` (cierra).

#### 6.3.5 Paso `processing`

Spinner + "Procesando..." + "Por favor espera mientras registramos el pago.".

### 6.4 `PhoneSubscriptionForm` (`frontend/src/components/phone/PhoneSubscriptionForm.tsx`)

Shell con título "Nueva suscripción" / "Configura el cobro recurrente desde el celular.", icono
Repeat2, resumen fijo ("Cobro recurrente", "<Pasarela|Sin pasarela> · Cada N <periodo>",
monto formateado). Campos:
- Cliente: picker + bottom-sheet de búsqueda (busca con `contactsService.searchContacts`, muestra
  8; copys "Buscar contacto guardado...", "Buscando...", "No encontramos contactos guardados con
  esa búsqueda.", "Busca por nombre, email o teléfono."). Hint si la pasarela lo requiere:
  "<Stripe|Conekta> necesita un contacto guardado.".
- `Nombre` ("Ej. Membresía mensual"), `Monto (<currency>)`, `Frecuencia`
  (Diaria/Semanal/Mensual/Anual; Diaria deshabilitada con Conekta), `Cada` (número), `Inicio`
  (date-picker, mín hoy), `Notas` (textarea "Notas internas de esta suscripción.").
- Botón `Crear enlace de pago`. Si hay >1 pasarela, segundo paso "Elige pasarela / Selecciona
  dónde quieres crear el enlace o autorización de la suscripción." con tarjetas (Stripe
  "Suscripciones con Stripe.", Conekta "Domiciliación con tarjeta guardada.", Mercado Pago
  "Autorización por enlace de Mercado Pago.", Rebill "Autorización por checkout hospedado de
  Rebill.").
- Validaciones toast (líneas 286-322): "Pasarela no conectada", "Falta el nombre", "Falta el
  monto", "Falta el contacto" (stripe/conekta sin contactId), "Falta el email" (MP/rebill),
  "Frecuencia no soportada" (conekta daily; rebill fuera de monthly/yearly).
- Éxito con link: pantalla "Suscripción lista / Envíale el link al cliente para que active la
  suscripción." con "Autorización pendiente / Cuando el cliente complete el enlace, la suscripción
  quedará activa.", URL, botones `Copiar link` y `Abrir`, footer `Listo`. Sin link: toast
  "Suscripción creada / <nombre> quedó guardada." y cierra.

### 6.5 App nativa RN existente (`mobile/src/App.tsx`, `PaymentsSection`) — referencia de paridad

- Home: título "Elige cómo quieres pagar"; tarjetas según `resolveMobilePaymentAccess`
  (licencia + pasarelas). Sección fija `Pagos` con chips `Hoy / 7 días / 30 días / 90 días` +
  `Personalizado` (captura `startDate/endDate` `YYYY-MM-DD`). Muestra error de carga explícito en
  vez de lista vacía (líneas 3968-3992).
- Selección de contacto: bottom-sheet compartido con Calendario; <2 chars lista chats recientes
  (`api.getChats('',0,60)`), con query usa `api.searchContacts` (líneas 4023-4053). Si viene del
  header de un chat, contacto va pre-cargado y bloqueado; en cuentas offline salta directo al
  wizard single.
- Alerts de gating: "Plan de pagos no disponible…", "Suscripciones no disponibles…".
- Wizard nativo: pago manual (siempre `status:'paid'`), link con pasarela + MSI básico,
  parcialidades y suscripciones; `source` en payloads: `native_mobile_payments`,
  `native_mobile_payments_saved_card`. Endpoints usados por `mobile/src/api.ts:766-905`:
  `/products*`, `/transactions` (GET/POST), `/transactions/payment-flows/installments`,
  `/stripe|conekta|rebill/contacts/:id/payment-methods|payment-sources`, `/subscriptions`,
  `/settings/payments`, `/<gw>/payment-links`, `/<gw>/saved-card-payments`,
  `/<gw>/payment-plans` (clip mapea a payment-links).
- Contrato UX adicional (`docs/MOBILE_APP.md:846-935`): tras crear un link, volver al chat del
  contacto con tarjeta de preview del link sobre el composer (título, monto, pasarela, dominio),
  campo de texto vacío, envío SIEMPRE manual (nunca auto-enviar); botón final nombra la acción
  real (`Registrar pago` / `Enviar enlace de pago` / `Cobrar tarjeta`); fechas siempre con
  calendario nativo legible; suscripción con link → volver al chat con preview; con tarjeta
  guardada → marcador de cobro completado.

---

## 7. Reglas de negocio clave (resumen para Swift)

1. Moneda: mostrar siempre la currency del registro o de la cuenta; nunca hardcodear. El backend
   fuerza `account_currency` al crear/editar pagos y links.
2. Estados exitosos para "pagos recibidos": `paid` y `partial`; montos > 0.
3. Idempotencia: mandar `Idempotency-Key` en `POST /api/transactions` (reintentos seguros).
4. Impuestos: aplicar la config de `/api/settings/payments.taxes`; enviar `amount =
   taxBaseAmount` + `applyTax` + `taxCalculationMode` a los endpoints de pasarela (el backend
   recalcula); para pagos manuales enviar el total y el desglose en `metadata.tax`.
5. MSI: validar en cliente los mínimos por pasarela (§5.1) — el backend NO rechaza montos bajos
   en todos los casos; la UI debe deshabilitar.
6. Plan de parcialidades: la suma debe cuadrar ±$0.50; primer pago < total; fechas futuras;
   primer pago $0 se manda `enabled:false`.
7. Refund/void: refund solo local y solo sobre pagos exitosos no-GHL; void solo sobre pagos no
   exitosos; pagos de planes/suscripciones no se borran individualmente.
8. Autorizaciones de plan Stripe no se pueden marcar pagadas manualmente (422).
9. Suscripciones: no editar a fechas pasadas; delete = cancelar; acciones se propagan a la
   pasarela.
10. Capacidades: combinar `/api/integrations/status` + `/api/license/status`
    (features `payment_plans`, `subscriptions`). Backend igual rechaza con 403 si falta licencia
    o módulo.
11. Búsquedas de contacto: HL conectado → `POST /api/highlevel/contacts/search`; si no →
    `GET /api/contacts/search?q=`.
12. Links de cobro se comparten manualmente (copiar/abrir/enviar por canal); nunca auto-enviar.

---

## 8. Gaps / riesgos para iOS nativo y OPEN QUESTIONS

1. **Paginación de `/api/transactions`**: sin rango de fechas ni `limit` el backend devuelve TODO
   (límite interno 999999). El nativo debe SIEMPRE acotar por fechas (como hace /movil) o mandar
   `limit`+`page` y leer `pagination` del envelope (el web lo tira).
2. **Sin pantalla de detalle de pago en /movil**: la lista solo selecciona/deselecciona. Para
   iOS habría que decidir si se agrega detalle (los datos existen vía `GET /transactions/:id`).
   **OPEN QUESTION**: ¿se desea detalle con acciones (refund/void/link) en móvil nativo?
3. **Refund no reembolsa en pasarela**: `POST /:id/refund` solo cambia el estado local; el dinero
   se devuelve en el dashboard de la pasarela. La UI debe comunicarlo.
4. **Mercado Pago payment-plans**: el backend expone `POST /api/mercadopago/payment-plans` pero
   ni la web ni la RN lo ofrecen (planProviders excluye MP). **OPEN QUESTION**: ¿soportarlo en
   iOS o mantener paridad (no)? Mantener paridad recomendado.
5. **CLIP**: sin tarjetas guardadas, sin planes, sin suscripciones; requiere email+teléfono y
   MXN. `mobile/src/api.ts` mapea "plan" de CLIP a payment-links — no usar CLIP para planes.
6. **Licencia vs /movil**: /movil habilita planes/suscripciones solo por pasarela conectada;
   la RN y el backend además exigen features de licencia. iOS debe seguir el modelo RN
   (licencia + pasarela) para no chocar con 403 del backend.
7. **`canUsePaymentPlans` incluye HighLevel** en /movil (flujo installments local/GHL), pero la
   selección de pasarela del plan sin GHL requiere stripe/conekta/rebill. Cubrir el caso
   "solo HighLevel conectado".
8. **Idempotencia solo en pagos manuales**: los endpoints `payment-links`, `saved-card-payments`
   y `payment-plans` NO aceptan Idempotency-Key; un timeout+reintento puede duplicar links o
   cobros de tarjeta guardada. Mitigar con UI (deshabilitar botón) — **riesgo backend**.
9. **SSE**: `/api/payment-events/stream` existe para refresco en vivo (pagos/suscripciones);
   /movil no lo usa en Pagos (usa caché diaria + pull). **OPEN QUESTION**: ¿usar SSE en iOS o
   pull-to-refresh?
10. **Envelopes inconsistentes**: `/api/products*` (raíz), `/api/integrations/status` (pelón),
    `/api/highlevel/config` (pelón), resto `{success,data}`. El cliente Swift necesita decoders
    por familia.
11. **`GET /api/highlevel/config` sin gate de admin** expone datos de negocio para el invoice;
    necesario para el wizard (dueDays, cardSetupAmount, transferInfoUrl, ghlInvoiceMode).
12. **Errores**: siempre `{success:false, error}` con mensajes en español listos para mostrar;
    422 se usa para reglas de negocio (mostrar tal cual). No hay códigos de error machine-readable
    — **gap** para lógica condicional fina.
13. **Los montos de MSI de Conekta** están hardcodeados en el frontend
    (`CONEKTA_INSTALLMENT_TERMS`, `RecordPaymentModal.tsx:223-230`); no hay endpoint que los
    devuelva. Replicarlos en Swift y mantenerlos sincronizados.
14. **Stripe MSI mínimo $300 MXN** también es constante de frontend (`RecordPaymentModal.tsx:201`).
15. **Checkout público**: abrir `paymentUrl` en SFSafariViewController; no re-implementar el
    checkout nativo (PCI y tokenizadores por pasarela viven en la página web `/pay/<id>`).
16. **`date` vs `createdAt` para ordenar**: usar `date || createdAt` como /movil
    (`parseSortableDateValue`).
17. **Caché diaria**: /movil cachea últimos pagos por bucket de día del negocio (clave
    `phone-payments/recent-payments/<periodo>`, máx 80 items, ~260 KB). Para iOS replicar con
    un cache local equivalente para carga instantánea.
18. **OPEN QUESTION — pagos con estado `partial`**: no hay UI para crear un pago `partial`
    directamente; llega vía GHL/planes. Confirmar si el nativo debe permitir editarlo.
19. **OPEN QUESTION — envío por SMS**: la opción "SMS" del selector de envío HighLevel mapea a
    `sms` de GHL; sin GHL no existe envío por SMS. El panel de link (no-GHL) solo ofrece
    whatsapp/messenger/instagram/email.
