# 15 — Mapa del CRM de escritorio (desktop-crm-map)

> **Objetivo.** Mapear el CRM completo de escritorio (`frontend/src/pages/*`) para que
> el equipo de la app nativa iOS sepa (a) qué capacidades existen en el producto que las
> superficies móviles (`/movil` = páginas `Phone*` y la app RN `mobile/src`) **no** tienen,
> y (b) cuál es la identidad visual de marca (tokens, familias de tema, semántica de color)
> que la app iOS debe "eco-ar" de forma nativa.
>
> Este doc complementa los research docs 01–12. No repite el contrato endpoint-por-endpoint
> de los módulos ya cubiertos; se enfoca en **diferencial escritorio vs móvil** y en marca.
> Todo lo aquí descrito fue leído del código el 2026-07-07. Nada es inventado; lo ambiguo
> se marca como **OPEN QUESTION**.

---

## 1. Inventario de páginas de escritorio (`frontend/src/pages/*`)

Rutas declaradas en `frontend/src/App.tsx:925-950` (todas bajo el shell autenticado, con
`AccessRoute moduleKey=…` como gate de permisos por módulo).

| Ruta | Página (archivo) | moduleKey | Propósito |
| --- | --- | --- | --- |
| `/dashboard` | `Dashboard/Dashboard.tsx` (1 970 líneas) | `dashboard` | Panel financiero del negocio. KPIs: **Ingresos Netos, Gastos de Publicidad, Ganancia Bruta, Retorno de Inversión, Gastos negocio, Ganancia Neta, Reembolsos, Pagos totales promedio** (líneas 1579-1636), gráfica de área con `DateRangePicker`, embudo de conversión (`ConversionFunnelChart` con scope `all/attribution/campaigns`), distribución de orígenes (`OriginDistributionCard`), modales de detalle de contacto/visitante. Config persistida vía `useAppConfig` (`dashboard_show_funnel_visitors`). Endpoints: `GET /api/dashboard/metrics`, `/chart-data`, `/financial-overview`, `/roas`, `/new-customers`, `/visitors`, `/leads`, `/appointments`, `/attendances`, `/sales`, `/traffic-sources`, `/storage-status` (`backend/src/routes/dashboard.routes.js:11-22`). |
| `/chat` | `DesktopChat/DesktopChat.tsx` (8 633 líneas) | `chat` | Bandeja de conversaciones omnicanal de escritorio (3 paneles: lista, hilo, panel de info del contacto). Detalle en §3.1. |
| `/reports` | `Reports/Reports.tsx` (3 191 líneas) | `reports` | Reportes tabulares/series por período (Día/Mes/Año; presets "Últimos 12 meses / Este año / Todo el tiempo / Personalizado") con dos vistas: **Histórico** y **Métricas**. Métricas de embudo publicitario: Clicks, CPC, ingreso por click, Visitantes, Web→Leads %, Leads, costo por lead, Citas, costo por cita, Asistencias, Citas→Asistencias %, Ventas, etc. (líneas 1447-1501). Scope de atribución: "Todos / Al momento de registro / Identificados de anuncios" (líneas 155-171). Permite capturar **gastos manuales del negocio** (`PUT /api/reports/manual-business-expenses`). Endpoints: `GET /api/reports/metrics`, `/contacts`, `/contacts/list`, `/transactions`, `/payments`, `/campaigns`, `/summary`, `/manual-business-expenses` (`backend/src/routes/reports.routes.js:21-29`). |
| `/campaigns` | `Campaigns/Campaigns.tsx` (2 659 líneas) | `campaigns` | "Publicidad": rendimiento de campañas/conjuntos/anuncios de Meta. Vistas de tabla `classic/adsets/ads` + modo **winners** (`/campaigns/winners/:categoria`), KPIs, gráfica de área, previews de creativos de anuncios, drill-down a contactos/visitantes atribuidos. Depende de la integración Meta Ads (`metaController`, `attributionController`). |
| `/transactions` | `Transactions/Transactions.tsx` (4 171 líneas) | `payments` | Tabla completa de pagos + KPIs + planes de pago. Detalle en §3.3. |
| `/transactions/subscriptions` | `Transactions/PaymentSubscriptions.tsx` (2 180 líneas) | `payments` + feature `subscriptions` | Administración de **suscripciones** (cobros recurrentes): filtros de estado `all/active/paused/past_due/cancelled`, intervalos `daily/weekly/monthly/yearly`, estados `active/draft/trialing/paused/past_due/incomplete/cancelled`, métodos por pasarela (Stripe/Conekta tarjeta guardada o link, Mercado Pago) (líneas 100-171), acciones por fila (menú), tarjetas guardadas y próximos ciclos. |
| `/transactions/products` | `Transactions/PaymentProducts.tsx` (1 606 líneas) | `payments` | Catálogo de **productos**: "Administra los productos, precios e impuestos guardados en la base de datos" (línea 1140). CRUD + refresh. |
| `/transactions/payment-plans` | (mismo `Transactions.tsx`) | `payments` + feature `payment_plans` | Planes de pago programados (progreso de cuotas, activar/pausar/abrir plan; botón "Programar plan"). |
| `/contacts` | `Contacts/Contacts.tsx` (2 320 líneas) | `contacts` | CRM de contactos: tabla con KPIs, rango de fechas, filtros avanzados (`ContactAdvancedFiltersModal.tsx`, 1 003 líneas), acciones por fila (ver detalle, mailto, abrir chat, eliminar) y **acciones masivas** con progreso: etiquetas bulk, campos personalizados bulk, WhatsApp bulk (plantillas masivas), **inscribir en automatización bulk** (`showBulkTagsModal/BulkCustomFields/BulkWhatsApp/BulkAutomation`, líneas 558-561). |
| `/appointments` | `Appointments/Appointments.tsx` (2 538 líneas) | `appointments` | "Calendarios": agenda de escritorio. Detalle en §3.2. |
| `/sites` | `Sites/Sites.tsx` (40 675 líneas) | `sites` | Constructor visual de sitios/funnels (canvas propio `.rstkCanvas` con su propio sistema de estilos, fuentes, formularios embebibles). Sin equivalente móvil y **fuera de alcance para iOS** (editor de páginas). |
| `/automations` | `Automations/*` (editor + `AutomationsHome`, `AutomationLibrary`) | `automations` | Editor node-based de automatizaciones + biblioteca de plantillas + carpetas. Backend: `backend/src/controllers/automationsController.js`, rutas en §3.1.4. Sin superficie móvil. |
| `/analytics` | `Analytics/Analytics.tsx` (3 263 líneas) | `analytics` | Analíticas web (tracking de sesiones): gráfica principal `Tráfico del sitio / Visitantes vs registros / Sesiones vs Visitantes / Identificados vs Recurrentes` y gráficas de conversión `registros vs clientes / leads vs clientes / mensajes vs citas / citas vs pacientes` (líneas 2444-2484), vistas Día/Mes/Año, tabla de sesiones (`SessionsTable`), filtros de etapa de conversión (lead → agendó → asistió → cliente, líneas 1190-1194). |
| `/ai-agent` | `AIAgent/AIAgent.tsx` | `ai_agent` + license features | Sección "Ristak AI": monta `AIAgentSettings` (asistente personal del equipo, feature `app_assistant_ai`/`ai`) y `ConversationalAgentSettings` (agentes conversacionales que chatean con clientes; wizard de creación `AgentCreationWizard`, metas/goal workflow con `assign_user`/`notify_only`). |
| `/mdp-program` | `MDPProgram/MDPProgram.tsx` | (route especial `MdpProgramRoute`) | Portal embebido del programa "Magnetismo de Pacientes" (contenido de curso/licencia). No aplica a iOS. |
| `/initialization` | `Initialization/Initialization.tsx` | `settings_integrations` | Checklist de onboarding del tenant (conectar Meta, WhatsApp, calendario, agente, tracking…) con CTAs a cada integración. |
| `/settings/*` | `Settings/*` (≈25 sub-pantallas) | por-pantalla | Ver §3.5. |
| Público | `Login/*` (`Login`, `Setup`, `Sso`, `ResetPassword`, `LicenseBlocked`), `PublicPayment/PublicPayment.tsx` (3 855 líneas, checkout público `/pay/:publicPaymentId` + `/pay/success`), `/api-docs` (`APIDocumentation`) | — | Autenticación y checkout público de links de pago. El checkout es web pública; iOS solo necesita **compartir el link**, no renderizarlo. |
| Móvil-web | `PhoneApp`, `PhoneChat`, `PhoneCalendar`, `PhonePayments`, `PhoneAnalytics`, `PhoneSettings`, `PhoneAgentChat` bajo `PHONE_APP_PREFIX` (`/movil/...`) | — | La app móvil-web actual; base de paridad de los docs 03–12. |

---

## 2. Identidad de marca Ristak → guía para iOS

Fuentes: `frontend/src/styles/index.css` (bloque "SISTEMA DE DISEÑO GLOBAL", líneas 2728-2964)
y `docs/DESIGN_SYSTEM.md`. El motor de temas vive en `frontend/src/contexts/ThemeContext.tsx`
(atributo `data-dir` en `<body>`, modo `.light/.dark`, persistido en `theme_dir`).

### 2.1 Constantes de marca

- **Azul Ristak (logo/marca):** `--brand-ristak-blue: #0078f8` (rgb 0,120,248) — `index.css:32-33`.
  Se usa para la marca, NO como accent de UI por defecto.
- **Default del producto:** familia **Aurora · Neutral** (`data-dir="en"`), modo oscuro por defecto
  (los tokens `:root` caen a dark). Estética: minimalista, monocromática slate, sobria, glass.
- La app móvil-web (`data-phone-app`) tiene un sistema propio **excluido** del sistema de escritorio;
  para iOS la referencia de marca es este sistema global + Liquid Glass nativo.

### 2.2 Vocabulario de tokens (el que iOS debe replicar semánticamente)

```
Superficies:  --bg  --bg-soft  --surface  --surface-2  --surface-hover  --surface-solid
Texto:        --text  --text-dim  --text-mute  --on-accent
Bordes:       --border  --border-strong
Acento:       --accent  --accent-2  --accent-soft
Semántico:    --pos/--pos-soft  --neg/--neg-soft  --warn/--warn-soft  --info/--info-soft
Forma:        --radius-card  --radius-ctl  --radius-pill
Sombra:       --shadow-card  --shadow-xs  --shadow-pop
Tipografía:   --font-display  --font-body  --font-mono  --num-font  --label-font
```

Reglas duras del sistema (DESIGN_SYSTEM.md §5): números/deltas positivos SIEMPRE `--pos`,
negativos `--neg` (nunca verde/rojo a mano); negrita solo en títulos/números/KPIs/badges
(cuerpo 400–500); controles sobre `--surface` + `--border` (nunca transparentes);
labels de tabla/eyebrow en 11px/600 con `--label-transform`/`--label-spacing` por familia.

### 2.3 Las 4 familias de tema (valores exactos, modo oscuro / claro)

**Aurora (E\*)** — glass, profundidad, degradados suaves. `--radius-card:20px --radius-ctl:13px`,
fuentes `Outfit` (display+body) + `IBM Plex Mono`. Sombras difusas grandes.
Superficies **translúcidas** (p. ej. Neutral dark `--surface: rgba(24,28,36,0.72)`) con
`--surface-solid` opaco para modales. Es la familia que más se acerca a **Liquid Glass de iOS 26**.

| Variante | `data-dir` | accent dark | accent light | on-accent dark |
| --- | --- | --- | --- | --- |
| Neutral (default) | `en` | `#64748b` (slate) | `#475569` | `#080a0d` |
| Violeta | `e` | `#8b7bff` | `#6d5cff` | `#0c0e1a` |
| Azul | `eb` | `#3d8bff` | `#2f6fed` | `#06101f` |
| Sobria (grafito+dorado) | `em` | `#c6a256` | `#9c7a2a` | `#15130c` |

Aurora·Neutral dark (la referencia principal): `--bg:#080a0d`, `--text:#edf0f4`,
`--text-dim:#a0a8b3`, `--text-mute:#68717c`, `--pos:#54c8a0`, `--neg:#e87d80`,
`--warn:#d8b46a`, `--info:#6f8794`, `--border:rgba(160,170,184,0.14)` (index.css:2873-2890).

**Onyx (C\*)** — alto contraste, audaz; sidebar SIEMPRE oscuro. `--radius-card:9px --radius-ctl:8px`,
fuente `Outfit`. Variantes: Esmeralda `c` (`#22c98a`/`#0a9d62`), Azul `cb` (`#3d9bff`/`#1f74e0`),
Violeta `cv` (`#9d7bff`/`#6d3fe0`), Ámbar `ca` (`#f0a93c`/`#c97f10`). En Onyx `--pos` se alinea
al esmeralda (`#22c98a` dark / `#0a9d62` light) (index.css:2768-2802).

**Brut (D\*)** — neobrutalismo: bordes duros (`--border-strong:#ffffff`/`#141414`), radios 2px,
sombras sólidas offset (`4px 4px 0 #000`), fuentes `Space Grotesk` + `Space Mono`, labels
UPPERCASE con tracking 0.08em. Variantes: Rojo `d` (`#ff4d24`/`#fa3c12`), Azul `db`
(`#2f6bff`/`#1f4fe0`), Lima `dl` (`#c6f432`/`#7fa600`), Magenta `dm` (`#ff2d8e`/`#e0107a`)
(index.css:2804-2840).

**Nimbus (A\*)** — limpio, profesional, neutro frío. `--radius-card:14px --radius-ctl:10px`,
fuentes `Sora` (display) + `Hanken Grotesk` (body). Variantes: Clásico `a` (`#4c8dff`/`#2f6fed`),
Violeta `av` (`#8b7bff`/`#6d5cff`), Azul `ab` (`#3d8bff`/`#2f6fed`), Sobria `am`
(`#c6a256`/`#9c7a2a`) (index.css:2735-2767).

### 2.4 Recomendación de traducción a iOS (derivada, no inventiva)

- Base visual: **Aurora Neutral** (glass translúcido + `--surface-solid` para sheets) encaja
  1:1 con materiales Liquid Glass; los valores de arriba dan la paleta dark/light.
- Colores semánticos del sistema iOS: mapear `--pos → verde de la familia activa`,
  `--neg → rojo/rosa de la familia`, `--warn`, `--info` como Assets de color dinámicos
  (dark/light) en el asset catalog; NUNCA `systemGreen/systemRed` crudos si se quiere
  fidelidad de marca.
- Radios: cards 20pt / controles 13pt (Aurora); pills = capsule.
- Tipografía: el sistema usa Outfit/Sora/etc. vía Google Fonts. **OPEN QUESTION:** si iOS debe
  embeber Outfit (licencia OFL, embebible) o usar SF Pro y reservar la personalidad a
  color/forma. No hay decisión escrita en el repo.
- **OPEN QUESTION:** ¿la app iOS debe exponer el selector de familia/variante (como el menú
  de usuario del sidebar de escritorio, persistido en `theme_dir` vía user config) o fijar
  Aurora Neutral? El backend guarda la preferencia en config de usuario (`userConfigService`),
  pero no existe contrato móvil documentado para `theme_dir` en `docs/MOBILE_APP.md`.

---

## 3. Brechas por sección: qué tiene escritorio que `/movil` NO tiene

Convención: "✅ ya en móvil" = existe en `PhoneChat/PhoneCalendar/...`; lo listado son **faltantes**.
La app RN (`mobile/src/App.tsx`) fue verificada por grep para los mismos faltantes (automations: 0
hits; asignación de contacto: 0; recordatorios de cita: 0; reembolsos: 1 hit de formato de texto).

### 3.1 Chats (DesktopChat vs PhoneChat)

Contexto de paridad: PhoneChat (22 184 líneas) YA tiene: filtros de bandeja
(`all/agent/unread/appointments/customers/leads`, PhoneChat.tsx:406), filtros avanzados
(canal/red/origen/etapa/actividad), vista de comentarios FB/IG, archivar/silenciar, selección
múltiple (archivar/restaurar, silenciar, asignar chats a agente IA), plantillas WhatsApp,
mensajes programados, notas de voz, adjuntos, ubicación, journey del contacto, pagos y citas
del contacto, hub de agentes IA, y muestra correos entrantes. Los faltantes reales:

1. **Asignación de responsable (usuario) por contacto.** Desktop: selector "responsable"
   en el panel de info (`assignableUsers`/`assignedUserId`, DesktopChat.tsx:2653-2654).
   - `GET /api/contacts/assignable-users` → `{ success: true, users: [{ id: string, name: string, role: string|null }] }`
     (`backend/src/controllers/contactAssignmentController.js:17-37`; usuarios `is_active=1`).
   - `GET /api/contacts/:id/assignment` → `{ success: true, assignedUserId: string|null }`.
   - `PUT /api/contacts/:id/assignment` body `{ userId: string|null }` → `{ success: true, assignedUserId: string|null }`.
     400 si el userId no es un usuario activo; 404 si el contacto no existe. La asignación
     enruta notificaciones de chat al asignado (comentario del controller, líneas 4-6).
   - PhoneChat: **0 referencias**. RN: 0 (los hits de "assignment" en RN son `assignedUserId`
     de CITAS round-robin, no de contacto).

2. **Inscribir el contacto en una automatización** ("Mandar a automatización",
   DesktopChat.tsx:8592-8599). Modal que lista automatizaciones `status === 'published'`
   (`automationsService.getOverview()` → `GET /api/automations`) y postea
   `POST /api/automations/:automationId/enroll-contact` (routes:67; body con
   `{ contactId }` vía `automationsService.enrollContact(selectedAutomationId, {...})`,
   DesktopChat.tsx:5620). PhoneChat/RN: **0 referencias a automations**.
   Rutas relacionadas del backend (`automations.routes.js:58-70`): `GET /`, `POST /`,
   `GET /contacts/:contactId/activity` (actividad de automatización por contacto),
   `GET /:id/enrollments`, `POST /:id/enrollments/:enrollmentId/control`, `GET /:id/stats`,
   `POST /:id/test-run`, `POST /:id/duplicate`, `DELETE /:id`. Gate: `requireModuleAccess('automations')`.

3. **Componer correo electrónico desde el chat.** Desktop tiene canal de composer `email`
   con asunto, cuerpo HTML (editor `EmailRichTextEditor`) y toggle de firma
   (`emailSubject/emailBodyHtml/emailIncludeSignature`, DesktopChat.tsx:2670-2672).
   PhoneChat lista el canal pero deshabilitado con el copy exacto:
   *"El correo electrónico se envía desde la vista completa de chats."* (PhoneChat.tsx:16086)
   y *"Correo electrónico — Disponible desde la vista completa de chats."* (PhoneChat.tsx:1357).
   iOS puede superar a `/movil` aquí usando el contrato de `emailController` (doc 05).

4. **Selección masiva con acción "Eliminar" (quitar chats de la vista) tecleando `ELIMINAR`**
   (`BulkChatConfirmAction = 'archive' | 'remove'`, palabras `ARCHIVAR/RESTAURAR/ELIMINAR`,
   DesktopChat.tsx:134, 372-374; estado "removed" persistido en localStorage
   `ristak_desktop_chat_removed_state_v1` — es estado de UI local, el chat regresa si entra
   mensaje nuevo). PhoneChat solo tiene archivar/silenciar/asignar-a-agente en bulk.

5. **Drag & drop de archivos al hilo** (`draggingFilesOverChat`, DesktopChat.tsx:2695) y
   límites de adjuntos idénticos a móvil (imagen 8MB, media 16MB, documento 20MB, video 25MB,
   máx 4 borradores; DesktopChat.tsx:375-379). En iOS: sustituir por share sheet/drop en iPad.

6. **Búsqueda global del shell** (`GlobalSearch` en el header de escritorio,
   `components/common/GlobalSearch` + `searchController` / `GET /api/search`): busca
   contactos/entidades desde cualquier página. En `/movil` la búsqueda vive por-sección.
   **OPEN QUESTION:** alcance exacto del search global (el controller cubre contactos;
   verificar en doc 03/06 si iOS lo necesita como búsqueda unificada).

Nota: el filtro avanzado de origen incluye "Enlace de disparo" (trigger link) en AMBAS
superficies (DesktopChat.tsx:465, PhoneChat tiene los mismos filtros), o sea el chat ya
expone atribución por trigger links; la **gestión** de trigger links es solo de escritorio (§3.5).

### 3.2 Calendarios (Appointments + CalendarsConfiguration vs PhoneCalendar)

PhoneCalendar (2 212 líneas) YA tiene: vistas `month/week/day/year/years`, crear/editar/eliminar
cita, buscador de contactos para la cita, selección de rango en timeline, swipe de mes.
Faltantes de escritorio:

1. **Recordatorios de citas** (`AppointmentReminderModal.tsx`, 850 líneas; estados en
   Appointments.tsx:348-354: `reminders`, `reminderSenders`, `reminderChannels`,
   `reminderTemplates`). CRUD: `GET/POST /api/appointment-reminders`,
   `PUT/DELETE /api/appointment-reminders/:reminderId` (routes:18-21, gate `appointments`).
   Los recordatorios eligen canal + remitente + plantilla de mensaje. Ni PhoneCalendar ni RN
   los muestran (0 hits "reminder").
2. **Bloqueos de horario** (`BlockedSlotModal`, `blockedSlots`, Appointments.tsx:335, 375-377):
   crear/editar franjas bloqueadas desde la agenda. PhoneCalendar: **0 hits de `BlockedSlot`**
   (la RN app solo los LEE para pintar disponibilidad, App.tsx:7956 `api.getBlockedSlots`).
3. **KPIs / stats de citas** (`AppointmentStats`, Appointments.tsx:337) y lista de
   "próximos eventos desde HOY" (línea 336). PhoneCalendar no tiene stats.
4. **Drag & drop para reagendar** (`draggedEvent/dragOverDate`, líneas 384-385) y
   **selección por arrastre para crear** (líneas 388-390). En iOS: gestos nativos equivalentes.
5. **Copiar enlace público de agendamiento** del calendario ("Copiar enlace de agendamiento",
   Appointments.tsx:1646; con razón de no-disponibilidad `publicUrlUnavailableReason`).
6. **Búsqueda de citas** con dropdown (líneas 514-515) y tooltips de hover de evento.
7. **Configuración de calendarios** (`Settings/CalendarsConfiguration.tsx`, 4 385 líneas):
   crear calendarios, disponibilidad/horarios, round-robin/equipo, duración de slots, buffers,
   página pública, modo de agendado custom vs default (`createScheduleMode`,
   Appointments.tsx:371). Nada de esto existe en móvil; PhoneCalendar consume calendarios ya
   configurados. Endpoints en `calendars.routes.js` (cubierto en doc 07).

### 3.3 Pagos (Transactions/* + RecordPaymentModal vs PhonePayments)

PhonePayments (962 líneas) es una superficie de **cobro**: vistas `select | single | partial |
subscription | products` (línea 30) — reusa `RecordPaymentModal` (línea 774) y
`PhoneSubscriptionForm` (789), lista "pagos recientes" con períodos `today/7d/30d/90d`
(línea 31) y CRUD básico de productos. Faltantes de escritorio:

1. **Tabla completa de transacciones** con modos "Todos / Por fecha" (+`DateRangePicker`),
   filtro por estado, `TreeFilter` y búsqueda por contacto (`ContactSearchInput`), y **KPI row**
   (Ingresos Netos con delta "vs periodo anterior", etc.) — Transactions.tsx:3256-3344.
2. **Acciones por pago** (menú por fila, Transactions.tsx:2484-2578, copy literal):
   - *Copiar enlace de pago* (`handleCopyPaymentLink`)
   - *Ver recibo* (solo pagados; `handleViewReceipt`)
   - *Enviar por Email / Enviar por WhatsApp / Enviar por Ambos* (`handleSendPayment(id, 'email'|'sms'|'both')`)
   - *Editar* / *Marcar como pagado*
   - Destructivas: *Reembolsar pago* (`handleRefundTransaction`), *Anular pago*
     (`handleVoidTransaction`), *Eliminar pago* (confirm `ELIMINAR`).
   En `/movil` un pago reciente solo se visualiza. Endpoints por pasarela en
   `transactions.routes.js` / `stripe|conekta|mercadopago|clip|rebill.routes.js` (doc 08).
3. **Gestión de planes de pago**: página con progreso de cuotas ("Faltan N pagos",
   Transactions.tsx:3064), acciones *abrir plan / activar / pausar…* (3120-3129) y crear con
   "Programar plan" (gate: pasarela compatible conectada). `/movil` solo CREA planes (`partial`).
4. **Gestión de suscripciones** (`PaymentSubscriptions.tsx`): listar/filtrar por estado,
   ver tarjetas guardadas, próximos ciclos, acciones por suscripción. `/movil` solo CREA
   suscripciones (no lista ni cancela; 0 hits de `subscriptionsService` en PhonePayments).
5. **Capacidades completas de `RecordPaymentModal`** (5 871 líneas; ambas superficies lo montan,
   pero conviene que iOS implemente el contrato completo): `PaymentMode = 'single'|'partial'`;
   opciones `send | manual | stripe | stripe_saved_card | mercadopago | conekta |
   conekta_saved_card | clip | rebill | rebill_saved_card`; envío del link por
   `whatsapp|sms|email|email_whatsapp|email_sms|all`; primera-cuota `cash|bank_transfer|deposit|card`;
   frecuencia restante `custom|daily|weekly|biweekly|monthly|yearly`; MSI por pasarela
   (Stripe `3-24`, MercadoPago/Conekta `none|2..24`, Rebill `3-24`); impuestos con
   `calculationMode: 'inclusive'|'exclusive'`; pasos `form → options → processing → link_ready`
   (RecordPaymentModal.tsx:121-138). Detalle endpoint-por-endpoint en doc 08.

### 3.4 Analíticas (Dashboard + Reports + Campaigns + Analytics vs PhoneAnalytics)

PhoneAnalytics (783 líneas) tiene: períodos `30d/60d/180d/año`, scope `Todos / Al registro /
Anuncios`, 5 gráficas comparativas (Ingresos vs gastos, Visitantes vs leads, Leads vs citas,
Citas vs asistencias, Asistencias vs ventas), embudo y orígenes (tab `traffic`). Faltantes:

1. **KPIs financieros completos** del Dashboard (los 8 KPIs de §1) con deltas vs período
   anterior y rango de fechas arbitrario (`DateRangePicker`); PhoneAnalytics no muestra
   Ganancia Bruta/Neta, ROI, Reembolsos, Gastos negocio ni ticket promedio.
2. **Reportes** (`/reports`): series por Día/Mes/Año, vista Histórico vs Métricas, métricas de
   costo unitario (CPC/CPL/CPA/costo por asistencia), conversiones % etapa a etapa y
   **gastos manuales del negocio** (input editable con guard,
   `PUT /api/reports/manual-business-expenses`). Nada de esto en móvil.
3. **Publicidad** (`/campaigns`): tablas campañas/adsets/ads con métricas Meta, vista
   "winners" por categoría, previews de creativos, drill-down a contactos atribuidos.
   PhoneAnalytics solo grafica gasto agregado.
4. **Analíticas web** (`/analytics`): sesiones, visitantes identificados/recurrentes, tabla de
   sesiones en vivo, orígenes de tráfico detallados. El tab de origen de PhoneAnalytics es
   un subconjunto.
5. **Drill-down a detalle** (modales `ContactDetailsModal`/`VisitorDetailsModal` al click en
   cualquier métrica) — patrón transversal de escritorio ausente en móvil.

### 3.5 Ajustes (Settings/* vs PhoneSettings)

PhoneSettings (971 líneas) solo tiene 6 tarjetas (copy literal, PhoneSettings.tsx:593-598):
**Plantillas** ("Crear y revisar estados de Meta"), **Asistente IA** (chat fijo y sugerencias +
descripción del negocio), **Lista de chats** (orden recientes/no leídas, archivados, vista
previa), **Campos personalizados** (qué datos se VEN en cada contacto), **Apariencia**
(Sistema/Claro/Noche/Horario) y **Notificaciones** (permiso, sonido, vibración, calendario).

Todo el resto de la configuración es SOLO escritorio (`Settings/settingsNav.ts:28-49`,
labels y permission keys literales):

| Grupo | Pantalla (ruta) | permissionKey | Qué hace |
| --- | --- | --- | --- |
| Cuenta | Cuenta (`/settings/account`) | `settings_account` | Perfil del negocio, moneda, zona horaria, branding, cancelación de cuenta (`AccountSettings.tsx`, 1 775 líneas). |
| Cuenta | Usuarios (`/settings/users-access`) | `settings_users` | Alta/baja de usuarios, roles y permisos por módulo (`UserAccessSettings.tsx`; backend `userAccessController`). |
| Cuenta | Notificaciones (`/settings/notifications`) | `settings_account` | Preferencias de notificación + admin de preferencias por usuario (`NotificationSettings.tsx`, `UserNotificationPreferencesAdmin.tsx`). |
| Cuenta | Aplicación móvil (`/settings/mobile-app`) | `settings_mobile` | Instrucciones de instalación PWA + copiar enlace/ruta interna (`MobileAppSettings.tsx`). |
| Privacidad | Privacidad (`/settings/privacy`) | `settings_account` | Controles de privacidad (`PrivacySettings.tsx`). |
| Agenda | Calendarios (`/settings/calendars`) | `settings_calendars` | Ver §3.2.7. |
| Cobros | Pagos (`/settings/payments`) | `settings_payments` | Conexión de pasarelas (Stripe/Conekta/MercadoPago/Clip/Rebill), impuestos, recibos (`PaymentsConfiguration.tsx`, 4 869 líneas; `paymentSettingsController`). |
| Plataformas | HighLevel (`/settings/highlevel`) | `settings_integrations` | Integración HighLevel (mensajería SMS/canales; `highlevelController`). |
| Plataformas | Meta Ads (`/settings/meta-ads`) | `campaigns` | OAuth Meta, cuentas publicitarias, píxel, campaign builder (`MetaAdsIntegration.tsx`, 3 261 líneas; `metaController`, `metaCampaignBuilderController`). |
| Plataformas | WhatsApp (`/settings/whatsapp`) | `settings_whatsapp` | Conexión WhatsApp Cloud API, números, calidad (`WhatsAppSettings.tsx`; `whatsappApiController`). |
| Plataformas | Correos (`/settings/email`) | `settings_email` | Dominios de envío, firma, buzón (`EmailSettings.tsx`; `emailController`). |
| Datos | Rastreo Web (`/settings/tracking`) | `settings_tracking` | Snippet de tracking, dominios rastreados (`WebTracking.tsx`; `trackingController`). |
| Datos | Dominios (`/settings/domains`) | `settings_domains` | Dominios propios para sitios/links (`Domains.tsx`). |
| Datos | Costos (`/settings/costs`) | `settings_costs` | Costos manuales de publicidad/operación (`Costs.tsx`; `costsController`). |
| Datos | Media (`/settings/media`) | `settings_media` | Biblioteca de archivos (carpetas, límites de almacenamiento) (`MediaSettings.tsx`, 2 096 líneas; `mediaController`). |
| Personalización | Campos personalizados (`/settings/custom-fields`) | `settings_custom_fields` | CRUD de campos custom de contacto (definiciones; PhoneSettings solo elige cuáles VER). |
| Personalización | Campos variables (`/settings/variable-fields`) | `settings_custom_fields` | Variables reutilizables para plantillas: `GET/POST /api/settings/variable-fields`, `PUT/DELETE /api/settings/variable-fields/:id` (`variableFieldsService.ts:27-41`). |
| Personalización | **Enlaces de disparo** (`/settings/trigger-links`) | `settings_custom_fields` | Trigger links: `GET/POST /api/settings/trigger-links`, `PUT/DELETE /api/settings/trigger-links/:triggerLinkId`, `GET /api/settings/trigger-links/:id/events` (`triggerLinksService.ts:40-58`; `triggerLinksController`). Los clicks alimentan la atribución "Enlace de disparo" visible en los filtros del chat de ambas superficies. |
| Personalización | Etiquetas (`/settings/tags`) | `settings_custom_fields` | CRUD de etiquetas (`TagsSettings.tsx`; `contactTagsController`). PhoneChat solo ASIGNA etiquetas existentes. |
| Avanzado | Developers (`/settings/developers`) | `settings_api_access` | Tokens de API + documentación (`APIAccessSettings.tsx`, `/api-docs`). |

**Plantillas de mensajes (escritorio, más completo que móvil):** `Settings/MessageTemplates.tsx`
(2 224 líneas) — categorías `utility/marketing/authentication/service`, idiomas
`es_MX/es/en_US`, filtros de revisión `all/active/pending/rejected/draft` (líneas 95-121),
carpetas, variables Meta `{{n}}` con bindings a campos custom, y ciclo YCloud/Meta:
`GET /api/settings/message-templates` (bundle), `/variables`, `POST …/preview`, `POST …`
(crear), `PUT …/:id`, `POST …/:id/submit` (enviar a revisión), `POST …/:id/sync`,
`POST /sync` (todos), `POST …/:id/send-test`, `DELETE …/:id`, carpetas
(`POST/PUT/DELETE …/folders[/:id]`) y campos custom de plantilla
(`POST/DELETE …/custom-fields[/:id]`) (`messageTemplatesService.ts:152-187`).
PhoneSettings tiene una vista reducida de plantillas ("Crear y revisar estados de Meta").

---

## 4. Permisos (gate transversal)

- Cada módulo de escritorio se gatea con `AccessRoute moduleKey=…` (App.tsx:933-949) y en
  backend con `requireModuleAccess('<module>')`. Keys observadas: `dashboard, chat, reports,
  campaigns, payments, contacts, appointments, sites, automations, analytics, ai_agent,
  settings_*` (+ `featureKeys` de licencia: `payment_plans`, `subscriptions`, `email`,
  `app_assistant_ai`, `ai`).
- PhoneChat gatea el canal email con `hasLicenseFeature(user, ['email'])` (PhoneChat.tsx:5117).
- iOS debe replicar el patrón: ocultar secciones sin permiso de lectura y respetar
  `featureKeys` de licencia (contrato de acceso en doc 02/10).

---

## 5. Gaps / riesgos para iOS nativo

1. **Asignación de contacto**: el endpoint existe y es trivial (§3.1.1) pero ninguna superficie
   móvil lo implementa; si iOS lo añade (recomendado: en el panel de info del contacto),
   hay que decidir el UX de notificación al asignado. Backend ya enruta notificaciones al
   responsable — cero trabajo de backend.
2. **Automatizaciones**: `POST /api/automations/:id/enroll-contact` requiere permiso del
   módulo `automations`; usuarios móviles con solo `chat` recibirán 403. **OPEN QUESTION:**
   ¿se quiere exponer "Mandar a automatización" en iOS aunque el permiso del módulo
   automations sea independiente del de chat?
3. **Recordatorios de cita y bloqueos**: endpoints listos (§3.2.1-2, gate `appointments`);
   son la brecha más visible de Calendarios en móvil.
4. **Acciones de pago (reembolsar/anular/enviar/recibo)**: las rutas son por-pasarela
   (stripe/conekta/mercadopago/clip/rebill) — el matrix exacto de qué acción aplica a qué
   pasarela/estado vive en `getAvailableActions` dentro de `Transactions.tsx` y NO está
   documentado como contrato; hay que extraerlo si iOS implementa la tabla de pagos
   (**OPEN QUESTION** para doc 08: matrix acción×pasarela×estado).
5. **Correo desde el chat en iOS**: desktop-only hoy por decisión de UI (el copy de PhoneChat
   lo dice explícitamente); el backend lo soporta. Riesgo bajo; requiere editor rich-text.
6. **Estado local no sincronizado**: archivado/silenciado/"eliminado" de chats se persiste en
   `localStorage` (claves `ristak_phone_chat_archived_state_v1`,
   `ristak_desktop_chat_removed_state_v1`, DesktopChat.tsx:350-352) — **no hay endpoint**;
   iOS tendrá su propio estado local y NO habrá sincronización entre dispositivos
   (mismo riesgo ya señalado en docs 03). Cambiarlo requiere backend nuevo.
7. **Búsqueda global**: existe `searchController` (`GET /api/search`) usado por el shell de
   escritorio; útil para un ⌘K/pull-down search en iPad. Verificar shape en doc 06.
8. **Sites, Automations editor, Meta campaign builder, Initialization, MDP Program**: fuera de
   alcance razonable para iOS v1 (editores complejos de escritorio). Documentados aquí solo
   para que nadie los "descubra" tarde.
9. **Tema/branding**: no existe contrato móvil para `theme_dir` (preferencia de familia);
   si iOS quiere seguir el tema del tenant/usuario habría que leer la config de usuario
   (`userConfigService` / `GET /api/user-config`) — **OPEN QUESTION** sobre la key exacta
   expuesta y si aplica a móvil.
10. **Iconografía de marca de terceros**: WhatsApp/Messenger/Instagram usan su color de marca
    solo en su contexto inmediato (DESIGN_SYSTEM.md §7); en iOS respetar lo mismo y la regla
    de no aplicar stroke a glifos rellenos (regla §5.12 — bug real que ya ocurrió en móvil).

---

## Audit resolutions (2026-07-07, verificación cruzada contra código)

1. **CORRECCIÓN — §3.1.6 y §5.7 (búsqueda global):** la ruta real es
   `GET /api/search/global` (mount `/api/search` + ruta `/global`,
   `backend/src/routes/search.routes.js`; solo `requireAuth`, sin gate de módulo).
   Respuesta `{ success, data: { categories:[...], total } }` — contrato detallado en
   doc 03 §1.4.
