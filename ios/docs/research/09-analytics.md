# 09 — Analytics (Analíticas)

Spec exhaustiva del módulo de Analíticas para la app nativa SwiftUI (iPhone/iPad, iOS 26).
Fuente de verdad visual/funcional: `/movil/analytics` (`frontend/src/pages/PhoneAnalytics/PhoneAnalytics.tsx`)
y la sección `AnalyticsSection` de la app Expo (`mobile/src/App.tsx:10563-11237`).
Fuente de verdad de API: `backend/src/routes/dashboard.routes.js` + `backend/src/controllers/dashboardController.js`.
Contrato móvil documentado en `docs/MOBILE_APP.md:318-342`.

> Los agentes Swift NO releerán las fuentes TS/JS: este documento es autosuficiente.

---

## 1. Resumen del módulo

La pantalla "Analíticas" muestra, para un rango de fechas elegido por el usuario:

1. **8 tarjetas KPI** financieras con variación vs. periodo anterior (`GET /api/dashboard/metrics`).
2. **Gráfica principal** de doble línea con 5 vistas seleccionables por chips
   (Ingresos vs gastos / Visitantes vs Interesados / Interesados vs citas / Citas vs asistencias / Asistencias vs ventas).
3. **Embudo de conversiones** de 5 etapas con 3 scopes de atribución (`GET /api/dashboard/funnel`).
4. **Origen (Fuentes)** con 4 tabs (Tráfico / Interesados / Citas / Clientes) (`GET /api/dashboard/origin-distribution`).
5. **Origen por número de WhatsApp** (solo si hay ≥ 2 números detectados), cruzando
   `origin-distribution.whatsappNumbers` con `GET /api/whatsapp-api/status`.

Textos "Interesados"/"Clientes" son **labels personalizables** (`GET /api/settings/contact-labels`).

---

## 2. Autenticación, permisos y convenciones de API

- Base: `https://<tenant>/api`. La app nativa Expo manda `Authorization: Bearer <token>` (`mobile/src/api.ts:266-279`); `/movil` usa cookie de sesión. Todos los endpoints de este módulo requieren `requireAuth`.
- **Gate de módulo**: TODAS las rutas `/api/dashboard/*` exigen `requireModuleAccess('dashboard')`
  (`backend/src/routes/dashboard.routes.js:8-9`). Un GET sin acceso responde:
  ```json
  HTTP 403
  { "success": false, "code": "read_access_required", "module": "dashboard", "error": "No tienes acceso a esta sección." }
  ```
  (`backend/src/middleware/userAccessMiddleware.js`).
- `GET /api/whatsapp-api/status` solo requiere `requireAuth` (sin gate de módulo)
  (`backend/src/routes/whatsappApi.routes.js:56-58`).
- `GET /api/settings/contact-labels` requiere auth; el POST exige el permiso `settings_account`.
- **Envelopes mixtos** (¡ojo en el decoder Swift!):
  - `/dashboard/metrics` y las series (`/visitors`, `/leads`, `/appointments`, `/attendances`, `/sales`, `/roas`, `/new-customers`, `/chart-data`) devuelven el **payload "pelado"** (objeto o array directo, sin `success/data`).
  - `/dashboard/financial-overview`, `/dashboard/funnel`, `/dashboard/origin-distribution`, `/dashboard/traffic-sources`, `/settings/contact-labels` devuelven `{ "success": true, "data": ... }`.
  - `/api/config` devuelve `{ "success": true, "config": {...} }` (clave `config`, NO `data`).
  - El cliente Expo desenvuelve automáticamente cuando el payload tiene `success` **y** `data` (`mobile/src/api.ts:319-325`). Replicar esa regla.
- **Errores**: los endpoints con envelope devuelven `{ success:false, error: "<mensaje ES>" }` con status 400/500.
  Las series de dashboard, en cambio, ante error interno responden **HTTP 200 con `[]`**
  (catch → `res.json([])`, p. ej. `dashboardController.js:590-593`), y ante falta de fechas responden **HTTP 400 con body `[]`**.
  `/dashboard/metrics` sin fechas → 400 `{success:false, error:"Se requieren startDate y endDate (formato: YYYY-MM-DD)"}`.

---

## 3. Fechas, timezone y moneda (reglas de negocio duras)

### 3.1 Timezone de negocio (`account_timezone`)

- El backend resuelve TODA fecha con `resolveDateRangeWithGHLTimezone()` (`backend/src/utils/dateUtils.js:281-287`), que usa `getAccountTimezone()` con prioridad:
  1. `app_config.account_timezone` (override configurado en Ristak),
  2. timezone de HighLevel (`highlevel_config.location_data.timezone`),
  3. default `America/Mexico_City` (`dateUtils.js:66-101`).
- `startDate` se interpreta como `startOf('day')` y `endDate` como `endOf('day')` **en esa zona**, luego se convierte a UTC para las queries (`dateUtils.js:236-269`).
- El cliente NO debe usar la zona del iPhone para calcular "hoy": debe obtener la zona con
  `GET /api/config?keys=account_timezone,account_currency` (la app Expo lo hace en `App.tsx:10620-10637`)
  o `GET /api/settings/timezone` (devuelve `{ success, timezone, source }`; así lo usa `/movil` vía `TimezoneContext`).
  Fallback si viene vacío/ inválido: `America/Mexico_City` (`mobile/src/format.ts:93-101`).

### 3.2 Formato de parámetros de fecha

- `startDate`: `YYYY-MM-DD`.
- `endDate`: la app Expo manda `YYYY-MM-DD` y `/movil` manda `YYYY-MM-DDT23:59:59` (`formatEndDateToISO`, `frontend/src/utils/format.ts:175-180`). Ambos funcionan porque el backend aplica `endOf('day')`. **Recomendación nativa: mandar `YYYY-MM-DD`.**

### 3.3 Periodos visibles y agrupación

Opciones del selector (`PhoneAnalytics.tsx:71-76`, `App.tsx:1044-1050`):

| id | chip (`label`) | menú (`menuLabel`) | días | groupBy |
|---|---|---|---|---|
| `30d` | `30 días` | `Últimos 30 días` | 30 | `day` |
| `60d` | `60 días` | `Últimos 60 días` | 60 | `day` |
| `180d` | `180 días` | `Últimos 180 días` | 180 | `month` |
| `year` | `Año` | `Último año` | 365 | `month` |
| `custom` | `Personalizado` | `Fecha personalizada` | libre | `day` si span ≤ 120 días, si no `month` (`App.tsx:10325-10331`) |

- `custom` existe en la app Expo (y es requisito del contrato `docs/MOBILE_APP.md:333-337`); **`/movil` web NO lo tiene** (solo 30d/60d/180d/year).
- Cálculo del rango: `end = hoy en account_timezone`, `start = end - (días - 1)` (rango inclusivo de N días) — `getTodayRange()` en `mobile/src/format.ts:505-513`; equivalente en `PhoneAnalytics.tsx:106-120`.
- El mismo rango se aplica a métricas, gráfica, embudo y origen.

### 3.4 Moneda (`account_currency`)

- Config key `account_currency` (`app_config`), leída junto al timezone. Normalización: trim + uppercase; si no es un código ISO de 3 letras válido para `Intl`, fallback `MXN` (`mobile/src/format.ts:478-487`).
- Formateos (locale fijo `es-MX`):
  - `formatCurrency(value, currency)` → `Intl.NumberFormat('es-MX', { style:'currency', currency, maximumFractionDigits:2 })` (`format.ts:442-448`).
  - `formatNumber(value)` → entero con separador de miles `es-MX` (`format.ts:450-454`).
  - `formatRoas(value)` → `"{value.toFixed(2)}x"`, p. ej. `3.42x` (`format.ts:456-458`).
  - `formatCompactCurrency` / `formatCompactNumber` → `notation:'compact', compactDisplay:'short', maximumFractionDigits:1` (para la escala superior de la gráfica) (`format.ts:460-476`).
- ⚠️ Nota: `/movil` web hoy hardcodea `MXN` en sus KPIs (`PhoneAnalytics.tsx:92-98,485-492` usan `formatCurrency` con default). La app Expo SÍ usa `account_currency` (`App.tsx:10583,10792-10801`) y **el contrato oficial exige `account_currency`** (`docs/MOBILE_APP.md:333-336`). La app nativa iOS debe usar `account_currency`.

---

## 4. Endpoints

### 4.1 Tabla resumen (los usados por Analíticas móvil)

| # | Método | Path | Query | Envelope | Respuesta |
|---|--------|------|-------|----------|-----------|
| 1 | GET | `/api/dashboard/metrics` | `startDate`, `endDate` (obligatorios) | pelado | objeto con 8 KPIs |
| 2 | GET | `/api/dashboard/financial-overview` | `startDate`, `endDate`, `scope=all\|attribution\|campaigns` | `{success,data}` | `[{label,value,value2}]` |
| 3 | GET | `/api/dashboard/visitors` | `startDate`, `endDate`, `groupBy=day\|month` | pelado | `[{label,value}]` |
| 4 | GET | `/api/dashboard/leads` | idem | pelado | `[{label,value}]` |
| 5 | GET | `/api/dashboard/appointments` | idem + `scope` opcional | pelado | `[{label,value}]` |
| 6 | GET | `/api/dashboard/attendances` | idem | pelado | `[{label,value}]` |
| 7 | GET | `/api/dashboard/sales` | idem | pelado | `[{label,value}]` |
| 8 | GET | `/api/dashboard/funnel` | `startDate`, `endDate`, `scope` | `{success,data}` | `[{stage,value}]` (5 etapas) |
| 9 | GET | `/api/dashboard/origin-distribution` | `startDate`, `endDate` | `{success,data}` | ver §4.5 |
| 10 | GET | `/api/whatsapp-api/status` | — | pelado | objeto de estado WhatsApp (subset usado, §4.6) |
| 11 | GET | `/api/settings/contact-labels` | — | `{success,data}` | `{customer,customers,lead,leads}` |
| 12 | GET | `/api/config?keys=account_timezone,account_currency` | `keys` CSV | `{success,config}` | `{account_timezone,account_currency}` |

Endpoints de dashboard que existen pero **NO usa /movil** (solo escritorio): `GET /api/dashboard/chart-data`, `/roas`, `/new-customers`, `/storage-status`, `/traffic-sources` (ver §8).

### 4.2 `GET /api/dashboard/metrics`

`dashboardController.js:272-369`. Params: `startDate`, `endDate` (400 si faltan).

Respuesta 200 (objeto pelado, cada campo es `{ value: Number, variation: Number }`, ambos redondeados a 2 decimales):

```json
{
  "ingresosNetos":    { "value": 152340.55, "variation": 12.34 },
  "gastosPublicidad": { "value": 42100.00,  "variation": -3.10 },
  "gananciaBruta":    { "value": 110240.55, "variation": 18.20 },
  "roas":             { "value": 3.62,      "variation": 15.00 },
  "totalCostos":      { "value": 18500.00,  "variation": 0.00 },
  "gananciaNeta":     { "value": 91740.55,  "variation": 21.75 },
  "reembolsos":       { "value": 1200.00,   "variation": 100.00 },
  "ltvPromedio":      { "value": 1890.44,   "variation": -2.50 }
}
```

**Fórmulas (backend, `computeFinancialSnapshot`, `dashboardController.js:131-267`):**

- `ingresosNetos` = `SUM(payments.amount)` con estado exitoso (§6.1), no-test, `date` en rango, excluyendo contactos ocultos.
- `gastosPublicidad` = `SUM(meta_ads.spend)` en rango (la columna `meta_ads.date` es TEXT `YYYY-MM-DD` local, se compara con `startZoned/endZoned.toISODate()`).
- `gananciaBruta` = ingresos − gastosPublicidad.
- `roas` = ingresos / gastos (0 si gastos = 0).
- `totalCostos` ("Gastos negocio") = suma de:
  - filas activas de la tabla `costs`: `calculation_type='percentage'` → `value%` sobre ingresos (`applies_to='revenue'`, default) o sobre gananciaBruta (`applies_to='profit'`); `calculation_type='fixed'` → monto **mensual prorrateado** por los días del rango (cada mes aporta `valor * díasDelMesEnRango / díasDelMes`; `manualBusinessExpensesService.js:135-175`);
  - gastos manuales de negocio (`report_manual_business_expenses`, prorrateados por día con prioridad day > month > year; `manualBusinessExpensesService.js:206-235`).
- `gananciaNeta` = gananciaBruta − totalCostos.
- `reembolsos` = `SUM(payments.amount)` con `status='refunded'`, no-test, en rango.
- `ltvPromedio` ("Pago promedio") = `AVG(payments.amount)` de pagos exitosos individuales en rango (no LTV por contacto).

**Variación**: se calcula contra un periodo anterior de la misma longitud
(prev = `[start − spanDays, start − 1 día]` en la zona de negocio; `dashboardController.js:287-318`).
`delta = ((actual − previo) / |previo|) * 100`; si previo = 0 → 100 si actual > 0, si no 0 (`dashboardController.js:32-38`).

Error 500: `{ "success": false, "error": "Error al calcular las métricas" }`.

### 4.3 `GET /api/dashboard/financial-overview`

`dashboardController.js:1202-1335`. Params: `startDate`, `endDate` (400 si faltan) y `scope` (`all` default; acepta `attribution`, `campaigns` y el legado `attributed`).

```json
{ "success": true, "data": [ { "label": "2026-06-01", "value": 5200.5, "value2": 830.0 } ] }
```

- `label`: día local `YYYY-MM-DD` (siempre agrupa por día; no acepta `groupBy`).
- `value` = ingresos del día, `value2` = gasto publicitario del día.
- Semántica por `scope`:
  - `all` ("Todos"): ingresos por **fecha real del pago** (`payments.date`).
  - `attribution` ("Al registro"): ingresos agrupados por **fecha de creación del contacto** que pagó (`contacts.created_at`), incluyendo días con contactos sin pago (revenue 0).
  - `campaigns` ("Anuncios"): igual que `attribution` pero solo contactos con `attribution_ad_id` que exista en `meta_ads` con anuncio activo el mismo día local de la creación del contacto.
  - En los 3 scopes, `value2` (gasto) es SIEMPRE el gasto total de `meta_ads` por día.
- Si no hay datos: `{ "success": true, "data": [] }`.

### 4.4 Series `visitors` / `leads` / `appointments` / `attendances` / `sales`

Todas devuelven array pelado `[{ "label": String, "value": Number }]`, ordenado por `label` asc.
`label` = `YYYY-MM-DD` con `groupBy=day`, `YYYY-MM` con `groupBy=month` (agregación en zona de negocio).
Sin fechas → 400 con body `[]`. Error interno → 200 con `[]`.

| Serie | Fuente | Definición |
|---|---|---|
| `/visitors` (`:599-638`) | `sessions` | `COUNT(DISTINCT identidad)` por periodo de `started_at`. Identidad de visitante: `contact:<id>` → `visitor:<id>` → `session:<id>` (`trackingService.js:49-59`). |
| `/leads` (`:643-690`) | `contacts` | `COUNT(*)` de contactos con `created_at` en el periodo (excluye ocultos). |
| `/appointments` (`:702-827`) | híbrido `appointments` DB + API HighLevel (opcional) | Con `scope` default (`all`): contactos ÚNICOS con cita agrupados por `date_added` de la cita (cuándo se agendó). Con `scope=attribution|campaigns|attributed`: contactos únicos con cita agrupados por `created_at` del contacto. Solo calendarios de atribución configurados (`app_config.attribution_calendar_ids`; null = todos). Nota: **ni /movil ni la app Expo mandan `scope` aquí** (usan default `all`). |
| `/attendances` (`:834-904`) | híbrido citas con `appointment_status` "showed" | Contactos únicos con asistencia, agrupados SIEMPRE por `created_at` del contacto (métrica de atribución). Si nadie asistió → `[]`. |
| `/sales` (`:909-956`) | `payments` | `COUNT(*)` de pagos exitosos no-test por periodo de `payments.date` (excluye contactos ocultos). |

### 4.5 `GET /api/dashboard/funnel`

`dashboardController.js:1361-1626`. Params: `startDate`, `endDate` (400 → `{success:false,error:"Se requieren startDate y endDate"}`), `scope` (`all` default, `attribution`, `campaigns`, legado `attributed`).

```json
{
  "success": true,
  "data": [
    { "stage": "Visitantes",  "value": 4210 },
    { "stage": "Interesados", "value": 380 },
    { "stage": "Citas",       "value": 92 },
    { "stage": "Asistencias", "value": 61 },
    { "stage": "Clientes",    "value": 18 }
  ]
}
```

- `stage` de posiciones 2 y 5 usa los **custom labels** (`labels.leads`, `labels.customers`) leídos de `highlevel_config.custom_labels`; defaults `Interesados` / `Clientes` (`:1374-1397`). Posiciones 1/3/4 son fijas: `Visitantes`, `Citas`, `Asistencias`.
- Semántica por scope (`:1399-1607`):
  - **Visitantes**: `all` → visitantes únicos de `sessions` en rango; `attribution/campaigns` → solo visitantes con sesión ligada a un contacto creado en el rango (y con ad activo si `campaigns`).
  - **Leads**: contactos con `created_at` en rango; `campaigns` añade `attribution_ad_id NOT NULL` + anuncio activo en `meta_ads` el mismo día local.
  - **Citas**: `all` → contactos únicos con cita cuyo `date_added` cae en rango (híbrido DB+HighLevel API, filtrado por calendarios de atribución); `attribution/campaigns` → contactos creados en rango que tienen cita en cualquier fecha.
  - **Asistencias**: siempre contactos creados en rango que tienen cita "showed" (más filtro de ads si `campaigns`).
  - **Clientes**: `all` → contactos cuyo PRIMER pago exitoso cae en el rango; `attribution/campaigns` → contactos creados en rango con `purchases_count > 0` (+ filtro ads).
- HighLevel es opcional: sin `api_token`, todo se calcula con datos locales (log `[RPT-007]`).

### 4.6 `GET /api/dashboard/origin-distribution`

`dashboardController.js:1167-1196` + `originDistributionService.js`. Params: `startDate`, `endDate` (400 si faltan).

```json
{
  "success": true,
  "data": {
    "traffic": {
      "sources":    [ { "name": "Facebook", "value": 120 } ],
      "platforms":  [ { "name": "Facebook", "value": 120 } ],
      "devices":    [ { "name": "mobile", "value": 300 } ],
      "placements": [ { "name": "Feed", "value": 80 } ],
      "browsers":   [ { "name": "Chrome", "value": 210 } ],
      "os":         [ { "name": "iOS", "value": 190 } ]
    },
    "leads":        [ { "name": "Meta Ads", "value": 44 } ],
    "appointments": [ { "name": "WhatsApp", "value": 12 } ],
    "conversions":  [ { "name": "Meta Ads", "value": 6 } ],
    "whatsappNumbers": [
      {
        "name": "Ventas MX",
        "value": 87,
        "phoneNumberId": "123456",
        "phoneNumber": "5215512345678",
        "displayPhoneNumber": "+52 1 55 1234 5678",
        "status": "CONNECTED",
        "apiSendEnabled": true,
        "qrSendEnabled": false
      }
    ]
  }
}
```

- Cada lista viene ordenada desc por `value` y limitada a **top 10**.
- ⚠️ Los items NO traen `color` (a diferencia de `/dashboard/traffic-sources`). El cliente pinta con su acento (fallback `#0078f8` en `/movil`, `COLORS.accent` en Expo).
- `traffic.*`: visitantes únicos web por bucket (un visitante puede caer en varios buckets); `sources` y `platforms` usan la misma normalización, más conversaciones únicas de WhatsApp API sumadas a `sources`/`platforms` (`originDistributionService.js:670-734`).
- `leads`: desglose por fuente de los contactos creados en el rango (`getLeadsContactIds` + `getContactSourceBreakdown`).
- `appointments`: fuentes de contactos con cita (`appointments.date_added` en rango, calendarios de atribución).
- `conversions`: fuentes de contactos cuyo primer pago exitoso cae en el rango (misma definición que "Clientes" del embudo en scope `all`).
- Resolución de fuente por contacto (prioridad): primera sesión web → plataforma de atribución WhatsApp/Meta (`ad_id`/`ctwa_clid` ⇒ `Meta Ads`) → campos de atribución del contacto (`contactSourceService.js:131-151`).
- Nombres de fuente posibles (normalizador `trafficSourceNormalizer.js`): `Facebook`, `Instagram`, `Google`, `Meta Ads`, `TikTok`, `Bing`, `Twitter`, `LinkedIn`, `YouTube`, `Messenger`, `WhatsApp`, `WhatsApp directo`, `Email`, `Directo`, `Orgánico`, `Referencia`, `Otro`, `Desconocido`, etc. Tratar como string abierto.
- `whatsappNumbers`: conversaciones entrantes únicas por número de negocio (identidad `contact:`/`phone:`/`whatsapp-profile:`/`message:`), con metadatos del número (`originDistributionService.js:762-849`). `name` = `label` → `verified_name` → `display_phone_number` → `business_phone` → `phone_number` → `"Número sin nombre"`.
- El frontend cambia de tab **localmente** sin re-pedir datos.

### 4.7 `GET /api/whatsapp-api/status` (subset usado por Analíticas)

De la respuesta completa (ver spec del módulo WhatsApp) Analíticas solo usa `phoneNumbers`:

```ts
phoneNumbers: Array<{
  id: string
  phone_number?: string | null
  display_phone_number?: string | null
  verified_name?: string | null
  label?: string | null
  status?: string | null
  api_send_enabled?: boolean
  qr_send_enabled?: boolean
  qr_status?: string | null          // 'connected' | ...
  qr_connected_phone?: string | null
}>
```

(`frontend/src/services/whatsappApiService.ts:3-27`, `mobile/src/types.ts:394-434`). Si la llamada falla se ignora (catch → lista vacía).

### 4.8 `GET /api/settings/contact-labels`

`settingsController.js` (`getContactLabels`).

```json
{ "success": true, "data": { "customer": "Cliente", "customers": "Clientes", "lead": "Interesado", "leads": "Interesados" } }
```

Defaults exactamente esos 4 valores; merge con lo guardado. La app debe sanear: trim y fallback al default si viene vacío (`App.tsx:10353-10360`).

### 4.9 `GET /api/config?keys=account_timezone,account_currency`

`configController.js:36-77`.

```json
{ "success": true, "config": { "account_timezone": "America/Mexico_City", "account_currency": "MXN" } }
```

Valores pueden ser `null`/`""` si no configurados → aplicar fallbacks (§3).

---

## 5. Modelos de datos (para Swift)

```text
DashboardKPI            { value: Double, variation: Double }            // variation en %, puede ser negativa
DashboardMetrics        { ingresosNetos, gastosPublicidad, gananciaBruta, roas,
                          totalCostos, gananciaNeta, reembolsos, ltvPromedio : DashboardKPI }
                          // tratar cada campo como opcional en el decoder (Expo los tipa opcionales, types.ts:328-337)

DashboardSeriesPoint    { label: String, value: Double }                // label = "YYYY-MM-DD" o "YYYY-MM"
DashboardFinancialPoint { label: String, value: Double, value2: Double }
DashboardFunnelScope    = "all" | "attribution" | "campaigns"
DashboardFunnelRow      { stage: String, value: Double }

SourceDatum             { name: String, value: Double, color: String? } // color solo llega en /traffic-sources
WhatsAppNumberOriginDatum : SourceDatum + {
                          phoneNumberId: String?, phoneNumber: String?,
                          displayPhoneNumber: String?, status: String?,
                          apiSendEnabled: Bool?, qrSendEnabled: Bool? }

OriginDistributionData  {
  traffic: { sources, platforms, devices, placements, browsers, os : [SourceDatum] },
  leads: [SourceDatum], appointments: [SourceDatum], conversions: [SourceDatum],
  whatsappNumbers: [WhatsAppNumberOriginDatum]?   // opcional
}

CustomLabels            { customer, customers, lead, leads : String }
```

(`mobile/src/types.ts:320-441`, `frontend/src/services/dashboardService.ts:5-99`.)

---

## 6. Reglas de negocio transversales (backend)

### 6.1 Pagos "exitosos" y modo test

- Estados exitosos (case-insensitive): `succeeded, paid, completed, complete, fulfilled, success` (`backend/src/utils/paymentMode.js:3-10`).
- Se excluyen pagos de prueba: `COALESCE(payment_mode,'live') != 'test'` (`paymentMode.js:153-156`).

### 6.2 Contactos ocultos

Todas las métricas de contactos/pagos excluyen contactos que caen bajo los filtros de
`hidden_contacts` (`backend/src/utils/hiddenContactsFilter.js`), aplicado en metrics, series, funnel y origin.
Los visitantes web (`sessions`) NO se filtran por ocultos.

### 6.3 Scopes de atribución (UI: segmented "Todos / Al registro / Anuncios")

| valor API | etiqueta UI | significado |
|---|---|---|
| `all` | `Todos` | evento contado por su fecha real (pago, cita agendada, primera compra) |
| `attribution` | `Al registro` | todo se agrupa/cuenta por la fecha de creación del contacto |
| `campaigns` | `Anuncios` | como `attribution` pero solo contactos con `attribution_ad_id` que coincide con un anuncio de `meta_ads` activo el mismo día local de la creación |

(`PhoneAnalytics.tsx:78-82`, `App.tsx:1051-1055`; backend acepta además `attributed` como sinónimo de `campaigns`.)

- En `/movil` y Expo, `financialScope` aplica SOLO a la vista "Ingresos vs gastos"; `funnelScope` aplica solo al embudo. Son estados independientes, ambos default `all`.

### 6.4 Calendarios de atribución

Citas y asistencias se filtran por `app_config.attribution_calendar_ids` (JSON array).
Sin configurar (`null`/`[]`) = todos los calendarios (`dashboardController.js:1632-1649`).

---

## 7. Inventario UX (pantalla "Analíticas")

Referencias: `/movil` `PhoneAnalytics.tsx:534-782` + `PhoneAnalytics.module.css`; Expo `App.tsx:10875-11235`.
Tab de navegación inferior: `Analíticas` con icono BarChart3 (`App.tsx:659-665`).
Título del documento web: `Analíticas móviles | Ristak`.

### 7.1 Header

- Eyebrow: `Ristak` (mayúsculas pequeñas).
- Título H1: `Analíticas`.
- A la derecha del título, **botón de periodo** (pill con chevron ▼) que muestra el `label` del periodo activo (`30 días`, `60 días`, `180 días`, `Año`, `Personalizado`). Al tocar, despliega menú con los `menuLabel` (§3.3). Opción activa resaltada. En Expo, la opción `custom` muestra `Fecha personalizada - {dd-mmm} - {dd-mmm}` si ya hay rango elegido, y bajo el título aparece una línea con el rango (`formatDateOnlyRangeLabel`: `07-jul`).
- **Sheet de rango personalizado** (solo Expo hoy; requisito para nativa): BottomSheet título `Fecha personalizada`, subtítulo `Rango de analíticas`, hint `Escribe el rango en formato YYYY-MM-DD.`, dos campos `Inicio` / `Fin` (teclado numérico), botones `Aplicar rango` (primario) y `Cancelar`. Validaciones con mensajes exactos: `Usa el formato YYYY-MM-DD.` y `La fecha inicial no puede ser mayor que la final.` (`App.tsx:10854-10873,11192-11234`). En iOS nativo es razonable usar date pickers, manteniendo las mismas validaciones.

### 7.2 Grid de 8 KPIs (2 columnas)

Todos los carruseles horizontales de filtros de la pantalla usan el mismo
contrato: el primer chip arranca con el inset interior de la tarjeta (16 pt),
pero el viewport conserva todo el ancho de la tarjeta para que, al desplazar,
los chips desaparezcan por completo en su borde.

Cada tarjeta: icono en cápsula con tono, título pequeño, valor en negrita, delta abajo.
Config exacta (`PhoneAnalytics.tsx:484-493`, `App.tsx:10792-10801`):

| key | título | icono (lucide) | tono | formato |
|---|---|---|---|---|
| `ingresosNetos` | `Ingresos netos` | DollarSign | green | moneda |
| `gastosPublicidad` | `Gastos publicidad` | CreditCard | black | moneda |
| `gananciaBruta` | `Ganancia bruta` | TrendingUp | blue (web) / neutral (Expo) | moneda |
| `roas` | `ROAS` | Activity | gold | `X.XXx` |
| `totalCostos` | `Gastos negocio` | WalletCards | black | moneda |
| `gananciaNeta` | `Ganancia neta` | Banknote (web) / CircleDollarSign (Expo) | green | moneda |
| `reembolsos` | `Reembolsos` | TrendingDown | red | moneda |
| `ltvPromedio` | `Pago promedio` | Users | blue/neutral | moneda |

- Delta: `+12.3% vs antes` / `-3.1% vs antes` / `0% vs antes` (1 decimal, `getVariationLabel`). Color positivo si `variation >= 0`, negativo si `< 0`.
- Estado cargando: valor `...` y delta vacío (no skeleton).

### 7.3 Panel "Gráfica"

- Header: label pequeño `Gráfica` + H2 con el nombre de la vista activa (default `Ingresos vs gastos`).
- **Chips scrollables horizontales** (una sola selección):
  1. `Ingresos vs gastos`
  2. `Visitantes vs {labels.leads}`
  3. `{labels.leads} vs citas`
  4. `Citas vs asistencias`
  5. `Asistencias vs ventas`
- **Segmented control de scope** (solo visible en `Ingresos vs gastos`): `Todos` / `Al registro` / `Anuncios` → `financialScope`.
- **Leyenda**: dos puntos de color + etiquetas `label1`/`label2`.
- Metadatos por vista (`PhoneAnalytics.tsx:464-482`):

| vista | label1 | label2 | color1 | color2 | moneda |
|---|---|---|---|---|---|
| revenue-spend | `Ingresos` | `Gastos` | accent `#0078f8` | contraste `#101010` | sí |
| visitors-leads | `Visitantes` | labels.leads | azul `#2563eb` | accent | no |
| leads-appointments | labels.leads | `Citas` | accent | ámbar `#f59e0b` | no |
| appointments-attendances | `Citas` | `Asistencias` | ámbar | azul | no |
| attendances-sales | `Asistencias` | `Ventas` | azul | accent | no |

- **Datos**:
  - `revenue-spend`: `GET /financial-overview` con `financialScope` → puntos `{label, value=ingresos, value2=gastos}`.
  - Las otras 4: dos llamadas en paralelo a las series correspondientes con `groupBy` del periodo, combinadas por unión de labels ordenados asc, faltantes = 0 (`combineSeries`, `PhoneAnalytics.tsx:126-136`).
- **Render** (SVG 320×176, padding t18 r14 b28 l14): 3 gridlines horizontales al 25/50/75%; dos polylines (stroke ~2.6-5, linecap/linejoin round) con círculo en cada punto (r ~2.8-4); escala superior = valor máximo en formato compacto (`$152.3 k` o `4.2 k`); eje X con 3 etiquetas (primera, central, última) formateadas `7 jul` (día) o `jul` (mes); escala Y desde 0 hasta `max(1, máximo de ambas series)`. Si hay 1 solo punto, se centra.
- **Estados**: cargando → spinner centrado (aria-label `Cargando gráfica`); sin datos (todas las Y en 0 o array vacío) → texto `Sin datos para este periodo.`.

### 7.4 Panel "Embudo"

- Header: label `Embudo`, H2 `Conversiones`, y **pill** a la derecha con la conversión total: `((última.value / primera.value) * 100).toFixed(1)%`, `0.0%` si primera = 0.
- Segmented `Todos` / `Al registro` / `Anuncios` → `funnelScope` (recarga solo el funnel).
- Lista de 5 filas; si el backend devolvió vacío, se renderiza placeholder con las 5 etapas en 0 (usando labels personalizados) — no hay estado vacío distinto.
- Cada fila: icono (orden fijo: Users, Target, CalendarDays, CheckCircle2, DollarSign), nombre de etapa (viene del backend), valor `formatNumber`, barra de progreso con ancho `value / max(1, máximo de etapas) * 100%`, y desde la fila 2 un caption `"{rate}% desde el paso anterior"` con `rate = (value/previa*100).toFixed(1)` (omitido si previa = 0).
- Cargando → spinner (aria-label `Cargando embudo`).

### 7.5 Panel "Origen"

- Header: label `Origen`, H2 `Fuentes`, pill derecha con el **total** (`formatNumber(sum(values))` de la tab activa).
- Chips (scroll horizontal): `Tráfico`, `{labels.leads}`, `Citas`, `{labels.customers}` → cambia la lista **localmente** (sin fetch).
  - `Tráfico` muestra `data.traffic.sources`; las otras usan `data.leads` / `data.appointments` / `data.conversions`.
- Lista: máximo **8 filas** (`slice(0,8)`), cada una con nombre, valor `formatNumber`, barra con ancho relativo al máximo y color `item.color || acento` (el backend no manda color aquí).
- Estados: cargando → spinner (`Cargando origen`); vacío → `Sin origen detectado en este periodo.`.

### 7.6 Panel "WhatsApp — Origen por número" (condicional)

- Solo se muestra si el cruce produce **≥ 2 filas** (`showPhoneNumberOrigin`, `PhoneAnalytics.tsx:527`).
- Construcción de filas (`buildPhoneNumberRows`, `PhoneAnalytics.tsx:179-222`):
  1. Por cada teléfono de `whatsappStatus.phoneNumbers` (filtrados a los que tienen `id`/`phone_number`/`display_phone_number`/`qr_connected_phone`), buscar match en `originData.whatsappNumbers` por `phoneNumberId === phone.id` o por dígitos del número; `value` = del match o 0.
  2. Añadir las filas de `whatsappNumbers` sin match (números detectados solo por mensajes).
- Cada fila: `name` (label → verified_name → nombre del row → display), debajo el número (o el statusLabel si no hay número); a la derecha `"{formatNumber(value)} personas"`; barra (color de contraste, no acento) con ancho relativo al máximo; caption inferior con el **status**:
  - `API y web` si (qr conectado) y (api activa)
  - `Web activo` si solo qr (qr_status === 'connected' || qr_send_enabled || row.qrSendEnabled)
  - `API activa` si solo `api_send_enabled || row.apiSendEnabled`
  - `Detectado` si nada.
- Comparte el estado de carga del panel Origen (misma promesa).

### 7.7 Carga, refresco y errores (orquestación)

- **Al cambiar rango/periodo**: en paralelo `metrics` + `origin-distribution` + `whatsapp-api/status` (esta última con catch silencioso). En Expo, al montar también `config` + `contact-labels` (una sola vez).
- **Al cambiar `funnelScope` o rango**: solo `funnel`.
- **Al cambiar `chartView`/`financialScope`/`groupBy`/rango**: solo la gráfica.
- Los efectos usan flag de cancelación (ignorar respuestas obsoletas).
- `/movil` web: los servicios tragan errores y devuelven defaults (KPIs en 0, arrays vacíos) — no hay UI de error.
- Expo (referencia para nativa): estado `error` con banner inline (texto del error) + botón `Reintentar` que relanza `loadOverview`; **pull-to-refresh** en el ScrollView que incrementa `reloadKey` y relanza las 3 cargas (`App.tsx:10836-10943`). Sin haptics específicos en esta pantalla.
- No hay caché offline en esta pantalla (a diferencia de otras que usan `phoneDailyCache`).

### 7.8 Paleta (referencia /movil, tema claro base)

`PhoneAnalytics.module.css:2-17`: bg `#fbfaf6`, surface `#ffffff`, soft `#f5f3ee`, texto `#0b0b0d`, muted `#77736c`, borde `rgba(20,20,20,0.09)`, accent `#0078f8`, accent-soft `#e2f1ff`, línea contraste `#101010`, línea azul `#2563eb`, línea warning `#f59e0b`, danger `#dc2626`. Tipografía SF Pro. La app nativa debe mapear a su design system Liquid Glass manteniendo semántica (accent para ingresos, contraste para gastos, etc.).

---

## 8. Qué tiene el escritorio que /movil NO tiene

Para paridad futura, el Dashboard/Analytics web de escritorio añade (NO requerido en la v1 nativa):

- **Dashboard escritorio** (`frontend/src/pages/Dashboard/Dashboard.tsx`):
  - `DateRangePicker` con rango libre; `ViewSelector`.
  - Drill-down clic en KPI/etapa del funnel → modales con listas: visitantes (`GET /api/tracking/visitors?startDate&endDate&scope` → `{success,data:[DashboardVisitorDetail]}`, shape en `dashboardService.ts:30-61`) y contactos (`GET /api/reports/contacts/list?from&to&type=interesados|sales|appointments|attendances&scope`).
  - "Chart insight modal" por punto de la gráfica.
  - Series adicionales: `GET /api/dashboard/chart-data` (`[{date,ingresos,gastado,ganancia}]`, valida `groupBy` con 400), `GET /api/dashboard/roas` (`[{label,value}]` mensual), `GET /api/dashboard/new-customers`, `GET /api/dashboard/traffic-sources` (dona con `color` hex por plataforma y flags `includeWeb`/`includeWhatsapp` `'1'|'0'`), `GET /api/dashboard/storage-status`.
  - La dona de Origen de escritorio usa también `traffic.platforms/devices/placements/browsers/os` (en móvil solo se usa `traffic.sources`).
- **Analytics escritorio** (`frontend/src/pages/Analytics/Analytics.tsx` + `analyticsService.ts`): sesiones crudas (`GET /api/tracking/sessions`), métricas de sesión, conversiones por fecha (`/api/tracking/contact-conversions-by-date`), resumen de mensajes por canal (`/api/tracking/messages-summary`, shape `MessageAnalyticsSummary` con `metrics{inboundMessages,conversations,contacts,attributionRate}`, `trend`, `filters`, `status`).
- **Reports** (`/api/reports/*`, módulo `reports`, `reportsController.js`): métricas consolidadas, gastos manuales de negocio (PUT `/api/reports/manual-business-expenses` con `{period_type:'day'|'month'|'year', period_start, amount}`), listas de contactos/transacciones paginadas. El módulo de Analíticas móvil solo se ve afectado indirectamente: los gastos manuales alimentan el KPI `totalCostos`.

---

## 9. Gaps / riesgos para iOS nativo y OPEN QUESTIONS

1. **Envelopes inconsistentes**: mezclar respuestas peladas (`/metrics`, series) con `{success,data}` y `{success,config}` obliga a un decoder tolerante como el de `api.ts:319-325`. Riesgo de decodificación silenciosa incorrecta si se asume un solo formato.
2. **Errores como 200 `[]`**: las series devuelven `[]` ante error interno; el cliente no puede distinguir "sin datos" de "error backend". Asumir "sin datos" (igual que /movil).
3. **400 con body `[]`** en series (no JSON de error): no intentar decodificar `{success,error}` ahí.
4. **Latencia**: `/appointments`, `/attendances`, `/funnel` y `/origin-distribution` pueden llamar a la API de HighLevel y hacer merges en memoria; pueden tardar segundos con datos grandes. Mantener cargas independientes por panel + cancelación, como hace /movil.
5. **Moneda en /movil**: la web móvil hardcodea MXN; el contrato (docs/MOBILE_APP.md) exige `account_currency`. La nativa debe seguir el contrato (como Expo), no el bug de /movil.
6. **`custom` range solo existe en Expo**, no en /movil web. El contrato lo exige para nativa. Umbral `>120 días → groupBy month` sale de Expo (`App.tsx:10325-10331`).
7. **KPI deltas del periodo previo**: el rango previo se computa server-side; el cliente no necesita pedir dos rangos.
8. **`variation` con previo=0** devuelve 100 (no infinito) — no recalcular en cliente.
9. **Sin endpoint de storage/notificaciones en móvil**: `/dashboard/storage-status` existe pero no se usa en /movil.
10. **Permisos**: si el usuario no tiene el módulo `dashboard`, todos los endpoints responden 403 `read_access_required`. /movil no oculta la pestaña por permisos hoy; OPEN QUESTION: ¿la app nativa debe ocultar el tab Analíticas o mostrar un estado "sin acceso"? (no hay precedente claro en /movil; Expo muestra el error inline con Reintentar).
11. **OPEN QUESTION — `scope` en `/api/dashboard/appointments`**: el backend lo acepta (`all` vs atribución) pero ni /movil ni Expo lo mandan; la serie de citas de la gráfica usa siempre `all` mientras que la de asistencias es de atribución. Puede producir aparente inconsistencia Citas vs Asistencias en la vista "Citas vs asistencias"; comportamiento actual = paridad, no "arreglar".
12. **OPEN QUESTION — colores de `origin-distribution`**: el backend no manda `color` (sí en `/traffic-sources`). ¿Se desea paleta por plataforma en nativo? /movil pinta todo con el acento; paridad = acento.
13. **OPEN QUESTION — tono de "Ganancia bruta"/"Pago promedio"**: web usa tono `blue`, Expo usa `neutral`. Elegir uno para nativo (sugerido: seguir Expo por ser la referencia nativa más reciente).
14. **Timezone cacheado 1 h en backend** (`dateUtils.js:8-11`): tras cambiar `account_timezone` en Ajustes, las agregaciones pueden tardar hasta 1 h en reflejarlo (el POST de settings invalida el cache server-side, pero otros procesos no). No es controlable desde el cliente.
15. **`meta_ads.date` es fecha local TEXT**: el gasto publicitario se agrupa por fecha local del ad account, no por timestamp UTC; pequeñas discrepancias de borde de día entre ingresos y gastos son esperadas (comentarios `dashboardController.js:57-76`).

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **HOYO CONFIRMADO — desajuste de módulo `analytics` vs `dashboard`:**
   `backend/src/routes/dashboard.routes.js:8-9` aplica `requireModuleAccess('dashboard')`
   a TODAS las rutas `/api/dashboard/*`, pero la pestaña móvil "Analíticas" se gatea en el
   cliente con el módulo **`analytics`** (`mobile/src/access.ts` → `analytics→analytics`;
   docs 02 §6.2 y 13 §2.3). Un empleado con `analytics:'read'` y `dashboard:'none'` VE la
   pestaña pero TODAS las llamadas (`/metrics`, series, `/funnel`, `/origin-distribution`)
   devuelven 403 `read_access_required` con `module:'dashboard'`. iOS debe manejar ese 403
   con un estado "sin acceso" (o considerar gatear la pestaña por `dashboard` además de
   `analytics`) — no hay precedente resuelto en /movil ni RN.
2. **MATIZ — §2 (`GET /api/whatsapp-api/status`):** es cierto que no tiene gate de módulo,
   pero el mount `/api/whatsapp-api` lleva `requireFeature('whatsapp')`
   (`server.js:341`); con licencia sin feature `whatsapp`, el panel "Origen por número"
   recibirá 403 `feature_not_available` (silencioso por ser GET). El catch → lista vacía
   ya lo tolera.
