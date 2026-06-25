# Auditoría Ristak — 03. Integraciones

> Documento de la auditoría de producto del CRM **Ristak**. Cubre las integraciones externas detectadas en los **22 módulos** auditados.
> Convenciones: cuando un hallazgo aparece duplicado entre módulos (mismo defecto visto por dos auditores) se consolida en una sola entrada citando **ambos IDs**. Los hallazgos `verifyStatus="refutado"` (p. ej. RPT-002 — los ingresos ya excluyen pagos `refunded`) **no** se listan como problemas. Los marcados `requiere-verificacion-manual` o `ajustado` se reflejan tal cual.

---

## 0. Mapa de integraciones y dónde se configuran

Cada cliente tiene su **propia instalación** (DB + servicio Render aislados). El **Installer / portal central** actúa de broker de licencias y de OAuth. Las integraciones se conectan desde **Ajustes** dentro de la app del cliente, salvo las que pasan por handoff OAuth del Installer.

| Integración | Tipo de credencial | Dónde se configura | Cifrado en reposo |
|---|---|---|---|
| Google Calendar | OAuth (refresh token vía handoff Installer) | Ajustes → Calendarios → Google | Sí (refresh token cifrado en `app_config`) |
| HighLevel (GHL) | Private Integration Token (larga vida, sin refresh) | Ajustes → HighLevel | **No** (texto plano, `highlevel_config.api_token`) — ver **GHL-001** |
| Meta Ads | System User Token (sin OAuth, expiración "Nunca") | Ajustes → Meta | Sí (cifrado), pero se revela y viaja por query string — ver **META-005** |
| WhatsApp YCloud (API oficial) | API Key YCloud | Ajustes → WhatsApp | Sí |
| WhatsApp QR (Baileys, no oficial) | Sesión QR escaneada | Ajustes → WhatsApp → QR | Estado de sesión en DB |
| WhatsApp "Meta directo" | Relay firmado HMAC vía Installer | Automático | — |
| Stripe | Secret key + webhook secret, o Connect-OAuth | Ajustes → Pagos → Stripe | Sí |
| MercadoPago | OAuth gestionado por el portal central (con refresh) | Ajustes → Pagos → MercadoPago | Sí |
| Conekta | Llave privada/pública local | Ajustes → Pagos → Conekta | Sí (privateKey cifrada) |
| Gigstack (facturación CFDI) | Token Gigstack | Ajustes → Pagos → Facturación | Token enmascarado (preview) |
| Bunny CDN (media) | Credenciales de almacenamiento | Provisión / config | — |
| Push FCM/APNs/WebPush | VAPID + service accounts | `app_config` / env | VAPID autogenerado si falta — ver NOTI-009 |
| License server (Installer) | CLIENT_ID + LICENSE_KEY + INSTALLATION_ID | env de la instalación | — |
| OAuth handoffs (installer) | Code → tokens, handoff cifrado 10 min | Automático | Sí (payload AES) |
| MCP / API externa | API token `ristak_live_` / OAuth PKCE | Ajustes → API/Developers | Token hasheado SHA-256 |

**Regla transversal que afecta a TODAS las integraciones:** los webhooks entrantes financieros genéricos (`/webhook/payment`, `/contact`, `/refund`, `/appointment`) **no verifican firma** (**SEC-002**), no hay rate limiting en ningún lado del backend de la app (**SEC-004**), y casi todos los crons de sincronización corren dentro del proceso web sin lock distribuido (**CRON-009 / GHL-005 / META-006 / WA-003 / APT-009**).

---

## 1. Google Calendar (sincronización bidireccional)

**Qué es.** Espejo bidireccional entre la agenda local de Ristak y el calendario de Google del cliente. La fuente de verdad es la BD local; Google se refresca en segundo plano.

**Cómo se conecta.**
1. El usuario pulsa Conectar en Ajustes → Calendarios → Google.
2. La app pide `connect-url` al Installer y redirige a Google con `prompt=consent select_account`, `access_type=offline`.
3. Google vuelve al Installer (`/api/auth/google/callback`); el Installer intercambia el `code`, guarda email/nombre/scopes en `clients` y crea un **handoff cifrado de 10 min** con el refresh token.
4. La app reclama el handoff (`claimGoogleCalendarOAuthHandoff`) y guarda el refresh token **cifrado** en `app_config: google_calendar_service_account_config`.
5. El usuario vincula **cada** calendario local de Ristak con un calendario de Google escribible.

**Cuenta a conectar.** Una cuenta de Google con scopes `calendar.events` + `calendarlist.readonly`. El access token se renueva contra el Installer (`refreshCentralGoogleCalendarToken`) con caché en memoria por proceso.

### Qué pasa en cada situación

| Situación | Comportamiento actual | Hallazgo |
|---|---|---|
| No conectada | Las citas nunca van a Google; no hay aviso visible si el calendario no está vinculado (`calendar_not_linked`) | — |
| Token expira / Google 5xx al subir | La cita queda `google_sync_status='error'` **y nunca se reintenta** (no hay cron) | **GCAL-002** |
| Google → local solo on-demand | Solo corre con el botón de sync manual o al pedir free-slots de un rango | **GCAL-002** |
| Evento duplicado / conflicto local-vs-Google | El pull entrante **pisa** la edición local sin comparar `date_updated` (no hay last-write-wins) | **GCAL-003** |
| Zona horaria (eventos all-day) | Se guardan a medianoche UTC; en zonas no-UTC el día se desfasa | GCAL-004 |
| Sin estado por cita en UI | El usuario no sabe si una cita específica llegó a Google | GCAL-007 (`requiere-verificacion-manual`) |

### Dirección de la sincronización

- **Local → Google:** al crear/editar/eliminar una cita, `syncAppointmentToGoogle` hace PATCH (si hay `google_event_id`) o POST y persiste el id. 404/410 recrean el evento. Los errores no rompen el guardado local. Funciona, pero **sin reintento** (GCAL-002).
- **Google → local:** `syncGoogleEventsToLocal` trae eventos del rango y hace upsert, asociando por `extendedProperties.ristakAppointmentId`.

### Quién gana en conflicto, borrados, cancelaciones

- **Quién gana:** hoy, **el último sync ciegamente**. El pull entrante usa `ON CONFLICT(id) DO UPDATE` con `date_updated = excluded.date_updated` **incondicional**; si el push a Google falló o aún no corrió, el pull trae el evento viejo y revierte la edición fresca del usuario (**GCAL-003**, confirmado).
- **Borrados / cancelaciones (externo→local):** un evento `cancelled` en Google dispara **HARD DELETE** de la cita en Ristak (`deleteLocalAppointment`, sin `markPendingDelete`, sin papelera), **incluida una cita originada en Ristak** con su contacto, notas y trazabilidad. Cualquiera con acceso a ese calendario de Google puede borrar datos de negocio en el CRM (**GCAL-001**, confirmado, severidad alto).
- **Citas creadas en Google:** entran **sin contacto** y **no disparan** recordatorios, eventos Meta ni automatizaciones (esos solo viven en `createAppointment` del controller). Quedan huérfanas (GCAL-006).
- **Desconexión:** `deleteGoogleCalendarConfig` solo borra la llave local; **no** revoca el token en Google ni avisa al Installer (el endpoint `disconnectGoogleCalendar` existe pero la app no lo llama). El acceso de Ristak a la cuenta de Google sigue concedido tras "desconectar"; los calendarios locales conservan `googleCalendarId` viejo (GCAL-005).
- **Dedupe de duplicados:** la asociación por `ristakAppointmentId` evita duplicar la misma cita Ristak↔Google. Pero las citas que vinieron Google→HL→Ristak pierden su `googleEventId` (ver GHL-004), rompiendo la dedup contra Google.

### Hallazgos Google Calendar

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| GCAL-001 | alto | confirmado | Cancelar evento en Google hace hard-delete de la cita en Ristak |
| GCAL-002 | alto | confirmado | Sin cron de sync; citas con error nunca se reintentan |
| GCAL-003 | alto | confirmado | El pull entrante pisa ediciones locales (sin last-write-wins) |
| GCAL-004 | medio | probable | Eventos all-day a medianoche UTC desfasan el día |
| GCAL-005 | medio | confirmado | Desconectar no revoca el token ni avisa al Installer |
| GCAL-006 | medio | probable | Citas importadas sin contacto ni recordatorios/automatizaciones |
| GCAL-007 | medio | req. verif. manual | UI no muestra estado de sync por cita |
| GCAL-008 | bajo | probable | Token cache global por proceso; no invalida al revocar |

---

## 2. HighLevel / GoHighLevel (contactos, citas, invoices, conversaciones)

**Qué es.** Integración bidireccional con LeadConnector API v2 mediante un **Private Integration Token de larga vida** (no OAuth, sin refresh). Sincroniza contactos, citas/calendarios, productos/precios, invoices/pagos y conversaciones (WhatsApp/SMS/Messenger/Instagram/Email).

**Cómo se conecta.** Ajustes → HighLevel: se pega Location ID + Private Integration Token. `saveConfig` valida con `GET /locations/:id`. Si cambió el location, `clearAllData()` borra los espejos y arranca `syncHighLevelData` en background.

**Sincronización.** Cron horario (full sync minuto `:17`) + cron cada 10 min para conversaciones incrementales + sync inmediato al guardar config. Usa webhooks (custom values) para eventos en tiempo real.

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| Token revocado/expira | No hay re-auth guiado; el cron falla en silencio por módulo | GHL-010 |
| Token con scopes parciales | `saveConfig` responde 200 con solo `/locations/:id`; faltan citas/chats sin explicación | GHL-010 |
| API responde error / rate limit | Maneja 429 con `Retry-After`; try/catch por módulo (un fallo no detiene el resto) | — |
| Borrado en HL (externo→local) | **Nunca** se refleja: el sync solo hace upsert, jamás elimina; quedan datos zombie que inflan métricas | **GHL-002** |
| Evento duplicado (paginación) | `collectPaginatedData` corta al ver una página sin items nuevos, perdiendo páginas posteriores | GHL-012 |
| Conflicto local-vs-HL en citas | El pull horario pisa ediciones locales sin last-write-wins | **GHL-003** |
| Checkpoint de conversaciones | Avanza siempre aunque se salten mensajes por error → mensajes perdidos sin reintento (overlap 24h mitiga parcial) | GHL-006 |

### Dirección y conflictos (bidireccional)

- **Local → HL:** el full sync sube primero las citas locales (`syncLocalAppointmentsToHighLevel`).
- **HL → local:** luego baja TODO y hace upsert. Incluye contactos, citas, productos, invoices, conversaciones, stats y reconciliación Meta.
- **Quién gana:** **HL gana ciegamente** en cada cron. `upsertLocalAppointment` escribe `date_updated = excluded.date_updated` incondicional; si un usuario editó una cita en Ristak y HL trae una versión vieja/cacheada, **se pierde la edición** (**GHL-003**, confirmado). Es el mismo patrón que GCAL-003.
- **Borrados:** no existe ninguna pasada de reconciliación de borrado. Contacto/cita/invoice eliminado en HL **persiste para siempre** en Ristak (**GHL-002**, confirmado, severidad alto). Para invoices solo se marca `deleted` si el listado paginado lo incluye, lo cual HL no garantiza.
- **Dedupe de contactos:** `findHighLevelContactForLocal` busca por email y luego teléfono y toma el **primer candidato con id**, sin corroborar el segundo identificador. Dos contactos HL con el mismo teléfono (familiares/líneas compartidas) pueden **fusionar (`mergeContactIds`) personas distintas** (GHL-011). El merge además **pierde tags, custom_fields, ghl_contact_id y WhatsApp preferido** (CNT-002, en doc de contactos), relevante porque este flujo dispara merges.

### Seguridad del token y acoplamiento oculto

- **GHL-001 (alto, confirmado):** el Private Integration Token (acceso total a contactos/pagos/conversaciones del location) se guarda **sin cifrar** y el endpoint `GET /api/highlevel/config/reveal/api_token` lo devuelve **íntegro a cualquier usuario autenticado** (la ruta solo exige `requireAuth`, sin chequeo de rol/módulo). A diferencia de `openai_api_key_encrypted` que sí se cifra. Un empleado de bajo privilegio extrae el token y opera la cuenta HL completa fuera de Ristak.
- **GHL-007 (medio, confirmado):** todas las rutas privadas de HL solo exigen `requireAuth`; `revealToken`, `createInvoice`, `recordPayment`, `text2Pay`, `deleteConfig`, `sync` quedan accesibles a cualquier empleado (el control por módulo es solo de UI). Un empleado limitado puede **cobrar** o revelar el token.
- **GHL-009 (medio, confirmado):** `setupHighLevelWebhooks` (parte de **cada** sync) llama `reconcileMetaBusinessWithHighLevel` con `prefer='local'`, que puede **sobrescribir la config de Meta local** con la de HL en el cron horario, sin acción ni consentimiento del usuario. Un cambio en custom values de HL reconfigura silenciosamente las credenciales de Meta Ads → rompe el tracking de conversiones/CAPI.

### Concurrencia y versionado

- **GHL-005 (medio, `ajustado`):** `syncHighLevelData` no tiene **ningún** lock (ni advisory, ni fila, ni flag in-process). El modelo es 1 instalación por cliente, así que la doble ejecución normal no ocurre; la ventana real es el **solapamiento de deploy** (instancia vieja drenando + nueva). Riesgo concreto: `mergeContactIds` y rate-limit 429. (Patrón consolidado en **CRON-009**.)
- **GHL-008 (bajo, req. verif. manual):** el export de conversaciones usa header `Version: 2023-02-21` mientras el catálogo declara `2021-04-15`; posible cambio de shape o rechazo silencioso.

### Hallazgos HighLevel

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| GHL-001 | alto | confirmado | Token en texto plano + endpoint que lo revela completo |
| GHL-002 | alto | confirmado | El sync nunca borra entidades eliminadas en HL (datos zombie) |
| GHL-003 | alto | confirmado | Citas de HL pisan ediciones locales recientes |
| GHL-004 | medio | req. verif. manual | Citas de HL no capturan `googleEventId` → duplicación con Google |
| GHL-005 | medio | ajustado | Full sync sin lock; riesgo en solape de deploy |
| GHL-006 | medio | probable | Checkpoint de conversaciones avanza aunque se pierdan mensajes |
| GHL-007 | medio | confirmado | Rutas privadas sin control de rol/módulo (cobros, reveal token) |
| GHL-008 | bajo | req. verif. manual | Versión de API inconsistente en export de conversaciones |
| GHL-009 | medio | confirmado | Reconciliación Meta muta `meta_config` en cada cron sin consentimiento |
| GHL-010 | bajo | probable | Conexión "exitosa" con scopes parciales (faltan citas/chats) |
| GHL-011 | medio | probable | Match WhatsApp→HL por 1 identificador puede fusionar contactos distintos |
| GHL-012 | medio | probable | Paginación corta prematuramente al ver duplicados de borde |

---

## 3. Meta Ads (cuentas, pixels, campañas, métricas)

**Qué es.** Conecta una cuenta de Meta Ads vía **System User Token** (no OAuth), sincroniza métricas (spend/reach/clicks/cpc) cada hora y hasta 35 meses atrás, ofrece un probador de Pixel/CAPI y un "Campaign Builder" que arma/valida/previsualiza campañas.

**Cómo se conecta.** Ajustes → Meta: se pega un Access Token de larga duración (expiración "Nunca"). La app valida con `debug_token` y lista cuentas/pixels/páginas. Las credenciales se **cifran** antes de persistir. Al conectar, dispara sync de 35 meses.

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| Token expira/revocado | El cron horario falla en silencio (solo loguea); la UI sigue mostrando datos viejos sin aviso ni CTA | **META-003** |
| Estado del token en UI | El backend calcula `daysUntilExpiry` pero **ningún componente llama** `/api/meta/verify-token` | **META-003** |
| API error / rate limit | El sync histórico borra+reinserta por chunk mensual; lock `isMetaFullSyncRunning` solo in-process | META-006 |
| Versión de Graph API | Cron mensual auto-detecta y adopta la versión **más alta publicada** por Meta (hasta v30), no la probada | META-004 |
| Desconectar | Marca `meta_config_disconnected=1`, pero `getMetaConfig` (usado por el cron) **no consulta ese flag** | META-009 |
| Token por query string | `revealMetaToken` devuelve el token completo y el frontend lo manda como `?accessToken=` a `/ad-accounts` etc. → queda en logs/referers | **META-005** |

### Sincronización de métricas y conflictos

- **META-001 (alto, confirmado):** **CPM y CTR se calculan con `reach` en vez de `impressions`.** Como `reach <= impressions` siempre, ambas métricas quedan **sistemáticamente infladas** y no reconcilian con Meta Ads Manager. `META_INSIGHTS_FIELDS` ni siquiera pide `impressions`. El usuario toma decisiones de presupuesto sobre números erróneos.
- **META-008 (bajo, probable):** el cron horario `updateRecentAds` solo hace upsert (sin DELETE del rango), así que ads eliminados en Meta dejan filas zombie con spend viejo hasta el próximo sync histórico.
- **META-006 (medio, probable):** crons sin lock distribuido; en solape de deploy o >1 instancia, doble sync con rate-limit de Meta y `DELETE+INSERT` de chunk concurrente.

### Campaign Builder

- **META-002 (alto, confirmado):** el Campaign Builder **nunca crea campañas reales en Meta.** `executeMetaCampaignDraft`, tras validar y confirmar, siempre termina en `mcp_not_connected` o `adapter_missing` (no hay runtime que ejecute las tools MCP). El usuario arma el draft y al confirmar no pasa nada útil. Funcionalidad anunciada inoperante.

### Pixel / CAPI (lo que sí funciona)

El probador de Pixel/CAPI está bien hecho: enlace público protegido por **HMAC scoped token** (TTL 10 min) + tope de envíos (20) + `test_event_code` que auto-expira a 30 min. Sin hallazgos de seguridad confirmados aquí.

### Hallazgos Meta Ads

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| META-001 | alto | confirmado | CPM/CTR con `reach` en vez de `impressions` (métricas infladas) |
| META-002 | alto | confirmado | Campaign Builder nunca crea campañas reales |
| META-003 | alto | confirmado | UI nunca muestra estado/expiración del token; sync muere en silencio |
| META-004 | medio | probable | Auto-bump a versión de Graph no probada |
| META-005 | medio | confirmado | Token revelado y enviado por query string |
| META-006 | medio | probable | Crons sin locking entre instancias |
| META-007 | medio | req. verif. manual | `getCampaigns` recalcula atribución (DB+API HL) en cada request |
| META-008 | bajo | probable | `updateRecentAds` no borra filas obsoletas del rango reciente |
| META-009 | bajo | req. verif. manual | Estado "desconectado" no apaga el cron |
| META-010 | bajo | confirmado | `saveAdsToDatabase` hace un INSERT por anuncio sin transacción |

---

## 4. WhatsApp (YCloud oficial, QR/Baileys, Meta directo)

**Qué es.** Tres caminos para conectar WhatsApp Business: (1) **API oficial vía YCloud**, (2) **"Meta directo"** (relay de webhooks firmado por el Installer), y (3) **WhatsApp Web por QR (Baileys)** como respaldo no oficial. Incluye atribución Click-to-WhatsApp (ad_id/ctwa_clid), plantillas, media (Bunny CDN), estados de entrega, sistema anti-bloqueos (drip) para QR, watchdog que reabre sesiones tras deploys y fallback automático API→QR.

**Cómo se conecta.**
- **YCloud:** se pega la API Key; Ristak lista números/plantillas/balance y crea el webhook automático.
- **QR:** crear número QR, aceptar el riesgo de bloqueo, escanear; el switch de respaldo solo aparece si API y QR están conectados.

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| YCloud no permite crear webhook (401/403) | La conexión se guarda igual **sin `webhook_secret`**; el webhook entrante acepta cualquier payload sin firmar | **WA-001** |
| Webhook YCloud sin secret | `verifyYCloudSignature` retorna `null`; el handler solo rechaza si es `false`, así que `null` pasa y se procesa | **WA-001** |
| Webhook de atribución público | `/webhook/whatsapp/attribution` **no valida firma**; cualquiera con el teléfono pisa `attribution_ad_id` del contacto | **WA-004** |
| Evento duplicado | Dedup robusto contra espejos de envío y webhooks (ventana ±90s) | — |
| Envío QR sin ack en 20s | Se reporta como **fallido sin persistir** aunque el servidor ya lo entregó → reenvío → **mensaje duplicado** | **WA-002** |
| Multi-instancia QR | Cada réplica abre el mismo socket Baileys → `connectionReplaced` → flapping; el drip anti-bloqueo es por proceso | **WA-003** |
| Zona horaria / dirección | Si los hints de número no están cargados, un mensaje saliente se guarda como **inbound** y dispara IA/automatizaciones | WA-005 |
| Media con Bunny caído | Fallback a disco local (efímero, se pierde tras deploy) + `requirePublicMediaUrl` exige HTTPS → envío falla | WA-006 |
| Estado `failed` transitorio | Prioridad rígida: `failed` bloquea un `delivered`/`read` posterior (excepto fallback QR exitoso) | WA-007 |
| Envío API que falla sin fallback QR | No se persiste el mensaje fallido en el chat; sin rastro ni reintento | WA-009 |

### Atribución (externo→local) y conflictos

- **WA-004 (alto, confirmado):** `handleWhatsAppAttributionWebhook` está montado **público, sin firma ni secreto**. Resuelve el contacto por teléfono y hace `UPDATE contacts SET attribution_ad_id/ctwa_clid/ad_name`. Cualquiera que conozca/adivine un teléfono **falsifica la atribución** de un contacto y contamina los reportes de ROI. Siempre responde 200 (oculta errores). Pisa la atribución existente sin lógica de prioridad.
- **WA-001 (alto, confirmado):** mismo problema de origen — el webhook YCloud entrante acepta payloads sin firmar cuando no hay `webhook_secret`, permitiendo **inyectar mensajes/contactos falsos** y disparar automatizaciones + agente IA + push.

### Seguridad / disponibilidad de sesión QR

- **WA-003 (alto, confirmado en código):** sin lock distribuido, con >1 réplica (o solape de deploy) las instancias se disputan el socket Baileys en bucle (`connectionReplaced`/440), la sesión nunca se estabiliza y el espaciado del drip se rompe.

### Hallazgos WhatsApp

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| WA-001 | alto | confirmado | Webhook YCloud acepta payloads sin firmar si no hay `webhook_secret` |
| WA-002 | alto | confirmado | Envío QR se reporta fallido sin persistir → mensajes duplicados |
| WA-003 | alto | confirmado | Watchdog QR sin lock → réplicas se reemplazan en bucle |
| WA-004 | alto | confirmado | Webhook de atribución público sin firma sobrescribe atribución |
| WA-005 | medio | probable | Default `inbound` guarda salientes como entrantes |
| WA-006 | medio | confirmado | Fallback a disco efímero rompe envío de media |
| WA-007 | medio | probable | `failed` terminal bloquea delivered/read posterior |
| WA-008 | bajo | confirmado | Validación de plantilla APPROVED se omite si no está sincronizada |
| WA-009 | medio | probable | Mensajes API fallidos sin fallback QR no se persisten |

---

## 5. Stripe (pagos, parcialidades, suscripciones)

**Qué es.** Cobros con Stripe en la app por-cliente: links de pago públicos (`/pay/:id`), planes de parcialidades (primer pago + installments con tarjeta guardada off_session), suscripciones recurrentes y conciliación vía webhooks firmados.

**Cómo se conecta.** Ajustes → Pagos → Stripe: secret key cifrada + webhook secret, o Connect-OAuth (gated por `STRIPE_CONNECT_OAUTH_ENABLED`). La **verificación de firma del webhook está bien hecha** (raw body por buffer).

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| Eliminar suscripción Stripe | **NO se cancela en Stripe**: el SELECT ni trae `stripe_subscription_id`; solo cancela MP/Conekta → sigue cobrando | **PAY-001** |
| Reembolso parcial (webhook) | Marca el pago como **totalmente reembolsado** sin comparar montos | **PAY-002** |
| INSERT local falla tras crear en Stripe | Suscripción queda **huérfana cobrando** sin registro ni compensación | PAY-003 |
| Reintento de parcialidad fallida | `idempotencyKey` fija → Stripe devuelve el error cacheado ~24h → reintento es no-op | PAY-004 |
| Webhook duplicado (mismo `event.id`) | Sin dedupe a nivel de evento; depende de idempotencia aguas abajo (frágil) | PAY-005 |
| Falta de webhook | Si llega duplicado, re-ejecuta `rememberStripePaymentMethodFromIntent` (llamada extra a Stripe) | PAY-005 |
| Clicks concurrentes en `/pay` | `createStripePaymentIntent` sin `idempotencyKey` crea intents huérfanos confirmables | PAY-009 |
| SQL solo probado en SQLite | Queries type-ambiguas truenan solo en Postgres prod (`could not determine data type`) | PAY-006 |
| Cron de parcialidades | Lock solo in-process; claim no atómico (mitigado por idempotencyKey de Stripe) | PAY-008 |

> **Nota de consistencia (RPT-002 refutado):** los ingresos del dashboard **ya excluyen** pagos `refunded` porque el reembolso muta el `status` de la fila a `refunded` (no crea fila aparte). No es un problema. Lo que **sí** es problema es que un reembolso **parcial** marca todo como reembolsado (PAY-002).

### Hallazgos Stripe

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| PAY-001 | alto | confirmado | Eliminar suscripción no la cancela en Stripe (sigue cobrando) |
| PAY-002 | alto | confirmado | Reembolso parcial marca el pago como totalmente reembolsado |
| PAY-003 | medio | ajustado | Suscripción huérfana cobrando si falla el INSERT local |
| PAY-004 | medio | probable | `idempotencyKey` reusada bloquea reintentos 24h |
| PAY-005 | medio | confirmado | Webhook sin dedupe por `event.id` |
| PAY-006 | medio | confirmado | SQL probado solo en SQLite truena en Postgres |
| PAY-007 | medio | probable | Registro manual de pago no idempotente (duplicado por reintento) |
| PAY-008 | bajo | probable | Cron de parcialidades sin lock en DB |
| PAY-009 | bajo | probable | `createStripePaymentIntent` sin `idempotencyKey` (intents huérfanos) |

---

## 6. MercadoPago

**Qué es.** Cobros recurrentes y links de pago vía MercadoPago. **OAuth gestionado por el portal central** (con refresh de token) + webhooks firmados.

**Cómo se conecta.** Ajustes → Pagos → MercadoPago, vía broker OAuth del Installer (`connect`, `refresh`, `claim handoff`, `disconnect`). PKCE S256.

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| Comprobante automático tras pago | **NO se encola** `receipt` (sí lo hace Conekta); los clientes que pagan por MP nunca reciben comprobante | **PAY2-003** |
| Volver del checkout hospedado | El back_url usa `?mercadopago=return` pero la página solo sincroniza con `?payment=return` (Stripe) → sigue "pendiente" | PAY2-004 |
| Webhook sin secret | `validateWebhookSignature` retorna `true` si no hay secret → procesa cualquier request (mitigado: re-consulta el pago real por `data.id`) | PAY2-005 |
| Recordatorio sin `due_date` | Links sueltos no setean `due_date`; nunca entran a la lista de recordatorios → automatización silenciosamente inactiva | PAY2-007 |
| Parcialidades MP | Cron **construido pero NUNCA arrancado** (`startMercadoPagoPaymentPlansCron` no se importa en `server.js`) → parcialidades no generan link | **CRON-005** |
| Generación de preferencia (cron) | Claim no atómico; con réplicas puede duplicar preferencias/estados (no doble cobro, MP solo crea links) | PAY2-010 |
| Refresh token (lado Installer) | El broker acepta **cualquier** refresh_token sin atarlo al `client_id` que llama | PORTAL-004 |

### Hallazgos MercadoPago

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| PAY2-003 | medio | confirmado | MP no dispara el comprobante automático tras el pago |
| PAY2-004 | medio | confirmado | La página pública no refresca tras volver del checkout MP |
| PAY2-005 | medio | confirmado | Webhook acepta peticiones sin firma cuando no hay secret |
| PAY2-007 | medio | probable | Recordatorios no salen para links sin `due_date` |
| PAY2-010 | bajo | probable | Cron de preferencias MP sin claim atómico |
| CRON-005 | medio | confirmado | Cron de planes MercadoPago nunca se arranca |

---

## 7. Conekta

**Qué es.** Cobros con tarjeta vía Conekta: links de pago, parcialidades con tarjeta guardada off-session. **Llaves privadas/públicas locales** (privateKey cifrada). **Sin webhook.**

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| Cobro de parcialidad (cron) | **POST `/orders` sin `Idempotency-Key`** + claim no atómico → en solape de deploy o >1 instancia, **doble cobro real** | **PAY2-001 / CRON-001** |
| Pago asíncrono pendiente (3DS/OXXO/SPEI) | **No hay webhook ni cron de polling**; el pago queda `pending` para siempre, no dispara comprobante, Gigstack ni stats | **PAY2-002** |
| Guardar tarjeta | `savePaymentSource` default **`true`** en pago público: la tarjeta queda guardada sin opt-in explícito | PAY2-008 |
| Identidad fiscal del merchant | `getPublicPaymentSettings` expone RFC, razón social, CP, régimen a cualquier visitante del link `/pay/:id` | PAY2-009 |
| Limpieza de duplicados | Migración manual hardcodea un `locationId` específico → evidencia de bug recurrente de sync (locationId usado como contactId) | PAY2-011 |

> **Doble cobro Conekta (PAY2-001 / CRON-001)** es el hallazgo financiero más serio del módulo: Conekta **sí** soporta idempotency keys pero el código nunca las usa, y la transición `scheduled→processing` es un UPDATE incondicional sin `changes>0`. El único candado es un boolean in-process, que no protege ni contra el trigger manual `saved-card-payments` concurrente ni contra el solape de deploy. Confirmado por ambos auditores.

### Hallazgos Conekta

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| PAY2-001 / CRON-001 | alto | confirmado | Doble cobro: sin `Idempotency-Key` ni claim atómico |
| PAY2-002 | alto | confirmado | Sin webhook: pagos `pending` (3DS/voucher/SPEI) nunca se reconcilian |
| PAY2-008 | bajo | confirmado | Tarjeta guardada por default sin consentimiento explícito |
| PAY2-009 | bajo | confirmado | Página pública expone identidad fiscal del merchant |
| PAY2-011 | bajo | req. verif. manual | Migración hardcodeada evidencia bug de sync con `contactId` |

---

## 8. Facturación Gigstack (CFDI)

**Qué es.** Timbrado fiscal automático al confirmarse un pago, vía Gigstack (`/payments/register`). **Un solo intento, sin reintentos.**

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| Gigstack caído / error transitorio | Marca `metadata.gigstack.status='error'`, solo `logger.warn`; **ningún cron reintenta** → factura fiscal perdida | **PAY2-006** |
| Pago sin impuesto configurado | Solo registra si `tax.enabled && taxAmount>0` → pagos sin impuesto nunca se timbran | PAY2-006 |
| Pago MercadoPago/Conekta `pending` | No llega a `paid` síncrono → Gigstack nunca se dispara (ver PAY2-002) | PAY2-002 |

El token de Gigstack **sí** se enmascara correctamente en la página pública (solo preview), no se filtra.

### Hallazgos Gigstack

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| PAY2-006 | medio | confirmado | Sin reintentos: factura fiscal se pierde si el primer intento falla |

---

## 9. Bunny CDN (media)

**Qué es.** Almacenamiento de media (imágenes/audio/documentos de chat y assets). Se usa desde WhatsApp, Sites y automatizaciones.

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| Bunny caído al subir media WhatsApp | Fallback a disco local con `publicPath` relativo, pero `requirePublicMediaUrl` exige HTTPS → **el envío falla**; el disco de Render es efímero → la media desaparece tras el deploy | **WA-006** |
| Servir media públicamente | `GET /media/assets/:assetId/file` es público (antes de `requireAuth`) con `Content-Disposition: inline` → riesgo de **XSS almacenado** si se permiten SVG/HTML | SEC-010 (`req. verif. manual`) |

### Hallazgos Bunny / media

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| WA-006 | medio | confirmado | Fallback a disco efímero rompe envío de media |
| SEC-010 | medio | req. verif. manual | Media pública `inline` → posible XSS almacenado |

---

## 10. Notificaciones Push (FCM / APNs / WebPush) y OpenAI de confirmación

**Qué es.** Push web (VAPID) y nativo (FCM Android / APNs iOS) para avisar al staff de mensajes de chat, citas, pagos y prioridad del agente IA. La confirmación de citas usa OpenAI para clasificar la respuesta del contacto.

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| Push de chat sin `userIds` | Se envía a **TODAS** las suscripciones habilitadas sin filtrar por usuario ni "hidden contacts"; el payload incluye **nombre + texto del mensaje** | **NOTI-004 / MOB-002** |
| Contacto oculto manda mensaje | El push expone su nombre y mensaje en la pantalla de bloqueo de empleados que no deberían verlo | **NOTI-004 / MOB-002** |
| OpenAI caído/sin API key (confirmación de cita) | `classifyConfirmationResponse` devuelve `null` → resultado `ambiguous` → con `cancel_appointment` se **cancelan citas de pacientes que sí confirmaron** | **NOTI-001** (crítico) |
| Respuesta de confirmación por HighLevel/Meta | La ventana de confirmación solo se abre vía WhatsApp API; respuestas por otros canales no confirman | NOTI-003 |
| Token inválido (404/410, UNREGISTERED) | Se deshabilita automáticamente (bien) | — |
| DELETE de suscripción/dispositivo | Recibe `endpoint`/`token` del body **sin verificar propiedad** → un usuario puede silenciar a otro | NOTI-005 / MOB-008 |
| VAPID faltante en env | Se autogenera y guarda en DB; si la fila se pierde, las suscripciones viejas quedan inservibles sin aviso | NOTI-009 |
| Registro nativo lento | Timeout de 16s marca `denied` aunque el permiso esté concedido | MOB-005 |
| Toggles de notificación (móvil) | Son **config global del tenant**, no por usuario; un empleado apaga notificaciones de todo el equipo | MOB-006 |

> **NOTI-001 (crítico, confirmado)** es el peor hallazgo del flujo de OpenAI: una incidencia del proveedor cancela citas reales de pacientes en contexto médico. El fallo del clasificador **no se distingue** de "ambiguo".
> **NOTI-004 / MOB-002 (alto)** es la fuga relevante de push: el filtrado de "hidden contacts" se aplica en dashboards/contactos/transactions/tracking, pero **no en la capa push**. Confirmado por ambos auditores.

### Hallazgos Push / OpenAI confirmación

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| NOTI-001 | crítico | confirmado | Caída/ausencia de OpenAI cancela citas confirmadas |
| NOTI-003 | alto | confirmado | Confirmación solo por WhatsApp API; HL/Meta no confirman |
| NOTI-004 / MOB-002 | alto | confirmado | Push de chat ignora visibilidad por rol / hidden contacts |
| NOTI-005 | medio | confirmado | DELETE de suscripción/dispositivo sin verificar dueño |
| NOTI-009 | bajo | confirmado | VAPID autogenerado en DB; rotación rompe suscripciones |
| MOB-005 | medio | confirmado | Registro de push nativo limitado por timeout de 16s |
| MOB-006 | medio | probable | Toggles de notificación globales, no por usuario |
| MOB-008 | bajo | confirmado | `disableMobileDevice` borra por token sin verificar dueño |

---

## 11. License server / OAuth handoffs / Installer

**Qué es.** El Installer es el portal central: valida licencias (`POST /api/license/verify`), corre como **broker de OAuth** (Google Calendar, Stripe Connect, MercadoPago) entregando secretos a la app vía **handoffs de un solo uso**, y orquesta releases móviles.

### Validación de licencia (app instalada → portal)

- La app, tras login local válido, hace `POST /api/license/verify` con `client_id+license_key+installation_id+app_url`. El portal valida cliente/licencia/instalación, genera un `license_token` (JWT 12h) y las features del plan.
- **Failure-open (LIC-003, alto, confirmado):** si el portal responde `allowed:true` **sin** el campo `features`, `normalizeLicenseFeatures(undefined)` retorna **todas** las `DEFAULT_FEATURES=true` → el cliente obtiene el plan premium completo por una respuesta incompleta o truncada.
- **PORTAL-005 (medio):** `app_url` puede **promoverse a un dominio arbitrario** desde una verify call sin confirmación humana (basta que sea `.onrender.com` y empiece con `app`). Ese `app_url` se usa luego como `allowedReturnOrigin` de OAuth y base de webhooks MP.
- **AUTH-007 (medio, probable):** las credenciales del dueño se envían en claro al portal (`/api/owner-credentials/verify`) sin forzar HTTPS (`normalizeBaseUrl` no valida el esquema).

### OAuth handoffs (Installer → app)

- Handoff de un solo uso atómico (CTE `UPDATE consumed_at + payload_enc=NULL`), TTL 10 min, payload cifrado AES, PKCE S256 en MP, state de un solo uso. **Bien diseñado.**
- **Qué pasa si la app pierde el claim:** el handoff expira en 10 min y hay que rehacer todo el OAuth.
- **PORTAL-004 (medio):** los brokers de refresh de Google/MP aceptan **cualquier** `refresh_token` del body sin atarlo al `client_id` autenticado → una instalación comprometida puede renovar tokens de otra usando el portal como oráculo.

### Setup token / SSO de soporte

- **PORTAL-002 (alto, confirmado):** `POST /api/setup-token/verify` (peek) **no consume** el token y devuelve `owner_password_hash` (PBKDF2 del dueño) **repetidamente** dentro del TTL (24h). El token viaja en la URL del SSO (`/sso?token=...`), por lo que queda en logs/historial/referers. Quien lo capture extrae el hash para crackeo offline.

### Cifrado del control remoto

- **INST-004 (alto):** la llave que cifra las Render API Keys de los clientes **se deriva de `JWT_SECRET`** si no hay `INSTALLER_ENCRYPTION_KEY`. Rotar `JWT_SECRET` (operación rutinaria en Render) inutiliza updates/cancelación de **todas** las instalaciones sin `deploy_hook_url`.

### Hallazgos License/OAuth/Installer

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| LIC-003 | alto | confirmado | `allowed:true` sin `features` otorga todo el plan (failure-open) |
| PORTAL-002 | alto | confirmado | `setup-token/verify` expone el hash de contraseña del dueño |
| PORTAL-003 | alto | confirmado | Token de release móvil reutilizable + endpoint de credenciales sin rate limit |
| INST-004 | alto | confirmado | Llave de cifrado derivada de `JWT_SECRET`; rotarlo rompe el control remoto |
| PORTAL-001 | alto | confirmado | El entorno demo opera sobre WhatsApp/Meta reales de producción |
| PORTAL-004 | medio | probable | Brokers de refresh aceptan cualquier `refresh_token` |
| PORTAL-005 | medio | probable | `app_url` promovible a dominio arbitrario desde verify |
| PORTAL-006 | medio | confirmado | JWT del portal con secreto por defecto fuera de prod; sin revocación admin |
| PORTAL-007 | medio | probable | Rate limit en memoria no protege con >1 instancia |
| AUTH-007 | medio | probable | Credenciales del dueño en claro al portal sin forzar HTTPS |
| LIC-002 | medio | confirmado | `requireFeature` corre antes de `requireAuth` → amplificación al license server |

---

## 12. Provisioning Render, updates y release channels (Installer)

**Qué es.** El cliente, con licencia activa, instala su propia copia de Ristak en SU cuenta de Render (crea Postgres + web service Docker GHCR). El Installer ofrece updates centralizados, canales de release (stable/test) y releases móviles.

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| Instalación falla a media | El catch solo marca `failed`; **no borra** la Postgres ni el web service ya creados → recursos huérfanos **cobrando** en Render. "Intentar de nuevo" crea otra instalación nueva | **INST-001** |
| Push a main (canal Test) | Redespliega **TODAS** las apps Test sin canary ni rollback; un commit roto las tumba a la vez | INST-003 |
| Toggle `auto_update_on_push` | **Código muerto**: el webhook usa `triggerChannelUpdate` ignorando el flag; `triggerAdminSelectedAutoUpdates` no tiene callers | INST-002 |
| Promoción a "En vivo" | `pending_promote` es un valor global **sin TTL**; si el build stable nunca llega queda colgado | INST-007 |
| Webhook de deploy | Una sola API key estática compartida (con n8n/Zapier) protege el redeploy masivo; sin firma HMAC | INST-006 |
| Acceso a la DB de cada cliente | `ipAllowList` fijado a **`0.0.0.0/0` permanente** (no solo en soporte) | INST-008 |
| Release móvil (firma Apple/Google) | El token **no es de un solo uso** y el endpoint de credenciales **no tiene rate limit**; reutilizable 120 min para extraer .p8/keystores/passwords | **PORTAL-003** |

### Hallazgos provisioning/updates

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| INST-001 | alto | confirmado | Instalación fallida deja Postgres/web service huérfanos en Render |
| INST-002 | alto | confirmado | `auto_update_on_push` es código muerto |
| INST-003 | alto | probable | Auto-update masivo de Test sin canary ni rollback |
| INST-005 | medio | probable | Health marca `active` un redeploy que aún no terminó/falló |
| INST-006 | medio | probable | API key estática compartida protege el webhook de deploy |
| INST-007 | medio | confirmado | `pending_promote` global sin expiración |
| INST-008 | medio | confirmado | Acceso a la DB de cada cliente abierto a `0.0.0.0/0` permanente |
| INST-009 | bajo | probable | El webhook de deploy confía en `channel`/`branch` del body |
| INST-010 | bajo | probable | Endpoints de instalación sin rate limiting |

---

## 13. MCP / API externa

**Qué es.** Acceso programático externo vía API token `ristak_live_` (hasheado SHA-256) y OAuth/PKCE para MCP.

### Qué pasa en cada situación

| Situación | Comportamiento | Hallazgo |
|---|---|---|
| Proxy arbitrario a GoHighLevel | `POST /api/external/highlevel/request` acepta **method+path arbitrarios** contra `services.leadconnectorhq.com` con el token GHL de la instalación → cualquier portador de API token (no admin) controla **toda** la cuenta HL (incl. DELETE) | **SEC-001** (crítico) |
| Lectura de tabla `users` | `GET /api/external/data/users` expone id/email/nombre/rol/`access_config` (solo `password_hash`/`api_token_hash` se redactan) | SEC-006 |
| Lectura de contacto oculto por ID | `getContactById` (también vía API externa) ignora el filtro de "hidden contacts" | SEC-005 |
| Registro dinámico de cliente OAuth | `POST /api/oauth/register` **sin autenticación**; redirect_uris arbitrarias | SEC-008 |
| Sin rate limiting | Toda la API externa, login y `oauth/authorize` son ilimitados | SEC-004 |

> **SEC-001 (crítico, confirmado)** es el peor hallazgo de superficie externa: el proxy GHL no tiene allowlist de paths/métodos (solo bloquea `..` y `//`) y solo requiere `requireApiToken` (sin rol admin ni scope). Un token de bajo privilegio se convierte en control total del CRM externo del cliente.

### Hallazgos MCP / API externa

| ID | Sev. | Estado | Resumen |
|---|---|---|---|
| SEC-001 | crítico | confirmado | Proxy arbitrario a GoHighLevel con solo un API token |
| SEC-002 | alto | confirmado | Webhooks de pago/contacto/refund/appointment sin firma |
| SEC-004 | alto | confirmado | Sin rate limiting en login, OAuth ni API externa |
| SEC-005 | alto | confirmado | `getContactById` ignora hidden contacts (también vía API externa) |
| SEC-006 | medio | confirmado | API externa expone tabla `users` como directorio |
| SEC-008 | medio | probable | Registro dinámico de clientes OAuth sin autenticación |

---

## 14. Vista consolidada de hallazgos de integraciones

Conteo **deduplicado** (consolidando IDs repetidos entre auditores como una sola entrada).

### Por severidad (deduplicado)

| Severidad | Hallazgos relevantes a integraciones |
|---|---|
| **Crítico** | SEC-001 (proxy GHL); NOTI-001 (OpenAI cancela citas) |
| **Alto** | GCAL-001, GCAL-002, GCAL-003; GHL-001, GHL-002, GHL-003; META-001, META-002, META-003; WA-001, WA-002, WA-003, WA-004; PAY-001, PAY-002; PAY2-001/CRON-001, PAY2-002; NOTI-003, NOTI-004/MOB-002; LIC-003; SEC-002, SEC-004, SEC-005; PORTAL-001, PORTAL-002, PORTAL-003; INST-001, INST-002, INST-003, INST-004 |
| **Medio** | GCAL-004/005/006/007; GHL-004 a GHL-012 (varios); META-004 a META-007, META-009; WA-005/006/007/009; PAY-003 a PAY-008; PAY2-003/004/005/006/007/010; NOTI-005; LIC-002; SEC-006 a SEC-010; PORTAL-004 a PORTAL-009; INST-005 a INST-008; GHL-009; MOB-005/006 |
| **Bajo** | GCAL-008; GHL-008/010; META-008/010; WA-008; PAY-009; PAY2-008/009/011; NOTI-009; MOB-008; SEC-011/012; INST-009/010 |

### Duplicados consolidados explícitamente

| Entrada consolidada | IDs originales | Defecto |
|---|---|---|
| Cobro doble Conekta | **PAY2-001 / CRON-001** | Cron de parcialidades sin `Idempotency-Key` ni claim atómico |
| Push ignora hidden contacts | **NOTI-004 / MOB-002** | Push de chat sin filtro de visibilidad por rol |
| DELETE push sin dueño | **NOTI-005 / MOB-008** | Baja de dispositivo/suscripción sin verificar pertenencia |
| Crons sin lock distribuido (patrón sistémico) | **CRON-009** ⊃ GHL-005, META-006, WA-003, APT-009, PAY-008, PAY2-010, CRON-001/003/004/007 | Todos los crons corren in-process sin leader-election; idempotencia depende de "1 instancia" no garantizada |
| JWT 30 días sin revocación | **AUTH-003 / SEC-007** | Logout/cambio de password no invalidan sesiones |

### Patrones transversales que afectan a casi todas las integraciones

1. **Webhooks entrantes sin firma** (SEC-002, WA-001, WA-004, PAY2-005): los webhooks financieros y de atribución genéricos aceptan payloads no autenticados.
2. **Sin reintento ni cron de recuperación** (GCAL-002, PAY2-006, GHL-006): cuando un push externo falla, queda en estado `error` que nadie vuelve a leer.
3. **Conflict resolution ciego** (GCAL-003, GHL-003): el pull entrante pisa ediciones locales sin comparar timestamps.
4. **Falta de idempotencia de API** (PAY2-001, PAY-004, PAY-009, AI-004): cobros/links que pueden duplicarse en concurrencia.
5. **Secretos mal protegidos** (GHL-001, META-005, SEC-003, INST-004, PORTAL-002/003): tokens en texto plano, por query string, o cifrados con llaves derivadas frágiles.
6. **Gating de licencia inconsistente** (LIC-001, LIC-003, LIC-009): módulos premium servidos sin `requireFeature`, failure-open, y crons sin gate.

---

*Fin del documento de Integraciones. Los hallazgos completos con evidencia (archivo/símbolo/líneas) y `recommendedFix` están en el corpus de la auditoría; aquí se consolidan por integración y se respeta `verifyStatus`.*
