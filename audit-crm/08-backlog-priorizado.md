# 08 — Backlog Priorizado (Ristak)

Documento de trabajo de la auditoría de producto de Ristak. Es la tabla maestra de **todos los hallazgos confirmados** del corpus, con ficha completa para cada hallazgo **crítico** y **alto**.

## Alcance y metodología

- La auditoría cubrió **22 módulos** del CRM (app por-cliente, app móvil Capacitor, Installer/portal central).
- Esta lista incluye únicamente hallazgos con `verifyStatus` ≠ `refutado`. **Excluido por refutación adversarial:** `RPT-002` ("Ingresos/Ganancia Neta no restan reembolsos") — se refutó porque los ingresos ya excluyen pagos con status `refunded` (el reembolso muta la fila del pago a `refunded`, que no entra en `SUCCESS_PAYMENT_STATUSES`); restarlos otra vez sería doble deducción. (Nota: hallazgos marcados `ajustado` como `MOB-004`, `DB-003`, `GHL-005`, `PAY-003` SÍ se listan — "ajustado" no es "refutado".)
- Varios defectos aparecen como dos IDs porque dos auditores los vieron en módulos distintos. Aquí se **consolidan** en una sola entrada del backlog, citando ambos IDs:
  - **"JWT 30 días sin revocación"** → `AUTH-003 / SEC-007` (alto).
  - **"Cron sin claim atómico / sin lock entre instancias"** es un patrón sistémico: `AUTH-006`, `APT-009`, `GHL-005`, `META-006`, `PAY-008`, `PAY2-001 / CRON-001`, `PAY2-010`, `AUTO-003 / CRON-004`, `AI-001 / CRON-007`, `NOTI-002 / CRON-003`, `CRON-002`, `CRON-008`, `CRON-009`, `WA-003`, `DB-002`, `PORTAL-007`, `PORTAL-009`. Se mantienen separados porque el arreglo y el blast radius difieren por flujo, pero comparten causa raíz (ver `CRON-009`).
  - **"Push / getContactById exponen contactos ocultos"** → `NOTI-004` (web push) y `MOB-002` (push de chat móvil) son el mismo defecto de la capa push; `SEC-005` y `ACL-002` son la misma fuga por getContactById / búsqueda. Se reportan por separado porque la corrección toca código distinto, pero comparten la causa: el filtro de ocultos no se aplica fuera de los listados.
  - **"Falta de rate limiting"** → `AUTH-001`, `SEC-004` (login/OAuth/API externa), `TRK-004` (submit Sites), `INST-010`, `PORTAL-007`. Mismo gap, superficies distintas.

---

## Resumen por severidad

| Severidad | Conteo (IDs) |
|---|---|
| Crítico | 3 |
| Alto | 56 |
| Medio | 56 |
| Bajo | 42 |
| **Total confirmado (sin refutados)** | **157** |

> El total cuenta cada ID por separado (incluyendo los pares consolidados arriba). Si se colapsan los duplicados de causa raíz, el número de *defectos únicos* es menor; la tabla los marca para no contarlos dos veces.

---

## Cómo leer este documento

- **Severidad:** `crítico > alto > medio > bajo`.
- **Tipo (abreviado):** SEG=seguridad · DAT=datos · INT=integración · FUN=funcional · ARQ=arquitectura · VAL=validación · EST=estado/error-handling · UX=ux · DEU=deuda-técnica · PROD=decisión-producto · TEC=técnico.
- **Esfuerzo:** estimación del corpus (`bajo / medio / alto`).
- **¿Decisión?** Sí = necesita una definición del dueño de producto (política de retención, modelo de planes, alcance de privacidad…), no solo "arreglar el código".
- **Confianza:** `Confirmado` (verificado en código) · `Probable` (defecto presente, disparo condicional a runtime/infra) · `Req. verif. manual` (hay que comprobarlo antes de tocar).
- **Orden:** por severidad; dentro de cada severidad, **esfuerzo bajo primero** para destacar los quick wins de alta severidad.

---

## Tabla maestra

### CRÍTICOS

| ID | Título | Sev | Tipo | Módulo / Flujo | Esfuerzo | ¿Decisión? | Confianza |
|---|---|---|---|---|---|---|---|
| NOTI-001 | Caída/ausencia de OpenAI puede CANCELAR citas confirmadas (fallback 'ambiguous') | Crítico | INT | Recordatorios / Confirmación IA | Bajo | No | Confirmado |
| MOB-001 | CORS del installer bloquea resolución de tenant en Android nativo | Crítico | INT | App móvil / arranque Android | Bajo | No | Probable |
| SEC-001 | Proxy arbitrario a GoHighLevel: control total de la cuenta GHL con un API token | Crítico | SEG | Seguridad / API externa-MCP | Medio | Sí | Confirmado |

> `MOB-001` es crítico de producto (la app Android no puede loguear a nadie en prod). Su confianza es "probable" por depender del header exacto del WebView en runtime; verificar antes de tratarlo como bloqueante absoluto.

### ALTOS (quick wins de esfuerzo bajo primero)

| ID | Título | Sev | Tipo | Módulo / Flujo | Esfuerzo | ¿Decisión? | Confianza |
|---|---|---|---|---|---|---|---|
| AUTH-001 | Sin rate limiting ni lockout en login | Alto | SEG | Auth / login | Bajo | No | Confirmado |
| SEC-004 | Sin rate limiting en login, OAuth authorize ni API externa | Alto | VAL | Seguridad / auth | Bajo | No | Confirmado |
| LIC-003 | allowed:true sin 'features' otorga TODO el plan premium (failure-open) | Alto | SEG | Licenciamiento / login | Bajo | No | Confirmado |
| GCAL-001 | Cancelar evento en Google hace HARD DELETE de la cita en Ristak | Alto | DAT | Google Calendar / inbound | Bajo | No | Confirmado |
| META-001 | CPM y CTR se calculan con reach en vez de impressions | Alto | DAT | Meta Ads / métricas | Bajo | No | Confirmado |
| WA-001 | Webhook YCloud público acepta payloads sin firmar (sin webhook_secret) | Alto | SEG | WhatsApp / recepción | Bajo | Sí | Confirmado |
| PAY-001 | Eliminar suscripción NO la cancela en Stripe: sigue cobrando | Alto | INT | Pagos Stripe / suscripciones | Bajo | No | Confirmado |
| SEC-003 | Master key de cifrado guardada en plano en la misma DB | Alto | SEG | Seguridad / cifrado | Bajo | Sí | Confirmado |
| AUTO-003 / CRON-004 | processDueResumes sin claim atómico: doble ejecución de rama reanudada | Alto | ARQ/FUN | Automatizaciones / scheduler | Bajo | No | Confirmado |
| PORTAL-002 | setup-token/verify (peek) expone el hash de password del dueño, repetible | Alto | SEG | Installer / setup-SSO | Bajo | No | Confirmado |
| PORTAL-003 | Token de release móvil reusable + endpoint de credenciales sin rate limit | Alto | SEG | Installer / mobile release | Bajo | No | Confirmado |
| INST-002 | auto_update_on_push es código muerto: el webhook actualiza todo el canal Test | Alto | FUN | Installer / auto-update | Bajo | Sí | Confirmado |
| SEC-002 | Webhooks de pago/contacto/refund/appointment sin verificación de firma | Alto | SEG | Seguridad / webhooks | Medio | No | Confirmado |
| GHL-001 | Token de HighLevel en texto plano + endpoint que lo revela | Alto | SEG | HighLevel / config | Medio | Sí | Confirmado |
| AUTH-002 | Instructivo público de reset deja credenciales fijas admin/admin123 | Alto | SEG | Auth / recuperación | Medio | No | Confirmado |
| AUTH-003 / SEC-007 | JWT 30 días sin revocación; cambiar password no invalida sesiones | Alto | SEG | Auth / sesión | Medio | Sí | Confirmado |
| SEC-005 | getContactById ignora filtro de ocultos (empleados/API ven contactos ocultos) | Alto | SEG | Seguridad / contactos | Medio | No | Confirmado |
| ACL-002 | Contactos ocultos se filtran en búsqueda/global/getById/reportes | Alto | SEG | Multi-tenancy / privacidad | Medio | No | Confirmado |
| ACL-001 | Módulos sin requireModuleAccess en backend (chat, analytics, config…) | Alto | SEG | Multi-tenancy / API directa | Medio | No | Confirmado |
| MOB-002 | Push de chat exponen contactos ocultos (nombre + mensaje) | Alto | SEG | App móvil / push | Medio | Sí | Confirmado |
| TRK-001 | /collect acepta sesiones falsas: inyección de tracking y reasignación de identidad | Alto | SEG | Tracking / atribución | Medio | Sí | Confirmado |
| TRK-004 | Submit público de Sites sin rate limiting/honeypot/captcha | Alto | VAL | Sites / formulario público | Medio | Sí | Confirmado |
| WA-004 | Webhook de atribución WhatsApp público sin firma sobreescribe atribución | Alto | SEG | WhatsApp / atribución | Medio | Sí | Confirmado |
| PAY-002 | Reembolso parcial Stripe marca el pago como totalmente reembolsado | Alto | DAT | Pagos Stripe / webhook refund | Medio | No | Confirmado |
| PAY2-001 / CRON-001 | Cobro doble Conekta: sin Idempotency-Key ni claim atómico | Alto | TEC/INT | Pagos / cron parcialidades | Medio | No | Confirmado |
| CNT-001 | Editar teléfono/email fusiona y BORRA otro contacto en silencio | Alto | DAT | Contactos / editar identidad | Medio | Sí | Confirmado |
| CNT-002 | La fusión pierde tags, custom_fields, ghl_contact_id, WhatsApp preferido | Alto | DAT | Contactos / merge | Medio | No | Confirmado |
| APT-001 | Admin puede crear doble-booking: createAppointment no valida disponibilidad | Alto | VAL | Citas / agendar admin | Medio | No | Confirmado |
| APT-003 | Reprogramar una cita no reenvía el recordatorio | Alto | FUN | Citas / reprogramar | Medio | No | Confirmado |
| GCAL-002 | Sin cron de sync Google→local; citas con error nunca se reintentan | Alto | ARQ | Google Calendar / sync | Medio | No | Confirmado |
| GCAL-003 | Sync entrante pisa ediciones locales (sin comparar date_updated) | Alto | DAT | Google Calendar / inbound | Medio | No | Confirmado |
| GHL-002 | Sync HL→local nunca borra entidades eliminadas en HighLevel | Alto | DAT | HighLevel / cron | Medio | Sí | Confirmado |
| GHL-003 | Citas de HL pisan ediciones locales recientes (sin last-write-wins) | Alto | DAT | HighLevel / cron citas | Medio | Sí | Confirmado |
| META-003 | El frontend nunca muestra estado/expiración del token de Meta | Alto | EST | Meta Ads / conexión | Medio | No | Confirmado |
| LIC-001 | Módulos premium sin requireFeature: el plan se salta por API directa | Alto | SEG | Licenciamiento / acceso premium | Medio | Sí | Confirmado |
| WA-002 | Envío QR se reporta fallido sin ack en 20s, sin persistir (duplicados) | Alto | FUN | WhatsApp / envío QR | Medio | Sí | Confirmado |
| AUTO-002 | Disparadores del editor sin evento (comentarios FB/IG, ad-click, CTWA) | Alto | FUN | Automatizaciones / triggers | Medio | No | Confirmado |
| AUTO-001 | El editor publica nodos que el motor no ejecuta: cortan el flujo en silencio | Alto | FUN | Automatizaciones / publicar | Medio | No | Confirmado |
| MOB-003 | /phone/login no re-resuelve tenant: correo de otra empresa falla sin explicación | Alto | FUN | App móvil / login | Medio | No | Confirmado |
| AI-002 | Runtime del agente conversacional no valida feature conversational_ai | Alto | INT | Agentes IA / runtime | Medio | Sí | Req. verif. manual |
| AI-004 | create_payment_link del agente no es idempotente: links/cobros duplicados | Alto | DAT | Agentes IA / pagos | Medio | No | Confirmado |
| NOTI-002 / CRON-003 | Recordatorios duplicados: registro anti-duplicado tras el envío | Alto | ARQ/FUN | Recordatorios / cron | Medio | No | Confirmado |
| NOTI-003 | Confirmación por respuesta solo en WhatsApp API; HL/Meta no confirman | Alto | INT | Recordatorios / confirmación | Medio | No | Confirmado |
| RPT-001 | Costos fijos del dashboard no se prorratean ni filtran por fecha | Alto | DAT | Dashboard / costos | Medio | No | Confirmado |
| DB-002 | Migraciones de datos destructivas en CADA boot sin advisory lock | Alto | ARQ | Modelo de datos / boot | Medio | Sí | Confirmado |
| DB-003 | FK payments.contact_id ON DELETE CASCADE: borrar contacto borra pagos | Alto | DAT | Modelo de datos / borrado | Medio | Sí | Confirmado (ajustado) |
| DB-005 | SQLite vs Postgres: parámetros con tipo ambiguo crashean solo en prod | Alto | TEC | Modelo de datos / queries | Medio | No | Confirmado |
| GHL-002b | (ver GHL-002) | — | — | — | — | — | — |
| INST-001 | Instalación fallida deja Postgres y web service huérfanos en Render | Alto | EST | Installer / provisioning | Medio | No | Confirmado |
| INST-004 | Llave de cifrado derivada de JWT_SECRET: rotarlo inutiliza updates/cancelación | Alto | SEG | Installer / cifrado | Medio | Sí | Probable |
| PORTAL-001 | El demo opera sobre conexiones reales de WhatsApp y Meta Ads | Alto | SEG | Installer / demo | Medio | Sí | Confirmado |
| NOTI-004 | Web push se envía a TODAS las suscripciones sin respetar rol/ocultos | Alto | SEG | Notificaciones / push | Alto | No | Confirmado |
| WA-003 | Watchdog QR sin lock entre réplicas: sockets Baileys en bucle de reemplazo | Alto | ARQ | WhatsApp / sesiones QR | Alto | Sí | Confirmado |
| AI-001 / CRON-007 | Doble respuesta/acción del agente conversacional (dedup en memoria) | Alto | ARQ | Agentes IA / inbound | Alto | No | Confirmado |
| APT-004 | Bloqueo de horarios solo con HighLevel; Ristak/Google sin bloqueos | Alto | ARQ | Citas / blocked slots | Alto | Sí | Confirmado |
| META-002 | Campaign Builder nunca crea campañas reales en Meta | Alto | FUN | Meta Ads / campaign builder | Alto | No | Confirmado |
| DB-001 | Sin runner de migraciones versionado: los .sql nunca corren en boot | Alto | ARQ | Modelo de datos / migraciones | Alto | Sí | Confirmado |
| DB-004 | timestamptz nunca se aplica: clientes nuevos con timestamps sin zona | Alto | DAT | Modelo de datos / fechas | Alto | Sí | Req. verif. manual |
| INST-003 | Auto-update masivo de Test en cada push a main sin canary ni rollback | Alto | ARQ | Installer / releases | Alto | Sí | Confirmado |
| AUTH-010 | Recuperación de cuenta inexistente para el usuario final (solo Render Shell) | Alto | PROD | Auth / recuperación | Alto | Sí | Confirmado |

> `GHL-002b` es un marcador vacío que se ignora; el hallazgo real `GHL-002` (sync HL→local nunca borra entidades) tiene su fila propia más abajo en este mismo bloque alto y su ficha completa en la sección de detalle. (Se conserva el orden por esfuerzo.)

### MEDIOS

| ID | Título | Sev | Tipo | Módulo / Flujo | Esfuerzo | ¿Decisión? | Confianza |
|---|---|---|---|---|---|---|---|
| AUTH-004 | JWT_SECRET con fallback estático en no-producción | Medio | SEG | Auth / sesión | Bajo | — | Confirmado |
| AUTH-005 | Política de contraseñas débil (mínimo 6, sin complejidad) | Medio | VAL | Auth / password | Bajo | — | Confirmado |
| AUTH-007 | Credenciales del dueño al portal en claro sin forzar HTTPS | Medio | SEG | Auth / licencia | Bajo | — | Probable |
| AUTH-006 | TOCTOU en /setup: dos requests crean >1 primer usuario | Medio | TEC | Auth / setup | Medio | — | Probable |
| LIC-002 | requireFeature antes de requireAuth: amplificación al license server | Medio | ARQ | Licenciamiento / premium | Bajo | — | Confirmado |
| LIC-005 | Frontend no maneja 403 feature_not_available: fallos silenciosos | Medio | EST | Licenciamiento / premium | Bajo | — | Confirmado |
| LIC-006 | Estado 'blocked' no se cachea: re-verificación en cada request | Medio | DEU | Licenciamiento / premium | Bajo | — | Confirmado |
| LIC-004 | normalizeLicenseFeatures pisa sub-features explícitas | Medio | DAT | Licenciamiento / login | Bajo | — | Probable |
| LIC-007 | cachedState/lastVerifiedEmail singleton: feature contra email equivocado | Medio | ARQ | Licenciamiento / premium | Medio | — | Req. verif. manual |
| LIC-009 | Crons corren sin gate de licencia/feature | Medio | ARQ | Licenciamiento / crons | Medio | — | Req. verif. manual |
| ACL-003 | Cualquier empleado puede crear/borrar filtros de ocultos | Medio | SEG | Multi-tenancy / ocultos | Bajo | Sí | Confirmado |
| ACL-006 | POST/DELETE /api/config sin gate de módulo | Medio | SEG | Multi-tenancy / config | Bajo | — | Confirmado |
| ACL-004 | No existe owner por contacto: todo empleado ve y edita todos | Medio | PROD | Multi-tenancy / contactos | Alto | Sí | Confirmado |
| CNT-003 | El 409 de contacto duplicado no se muestra (toast genérico) | Medio | UX | Contactos / crear | Bajo | — | Confirmado |
| CNT-004 | updateContact no deduplica email: conflicto UNIQUE cae a 500 | Medio | VAL | Contactos / editar | Bajo | — | Confirmado |
| CNT-005 | Dedup por teléfono confunde nacionales de distinto país (MX/US/+1) | Medio | DAT | Contactos / dedup | Medio | Sí | Probable |
| CNT-006 | Contactos sin teléfono se enrolan en automatizaciones/lotes WhatsApp | Medio | EST | Contactos / bulk | Medio | — | Probable |
| CNT-007 | Borrado de contacto es hard delete sin papelera ni protección por LTV | Medio | PROD | Contactos / borrar | Alto | Sí | Confirmado |
| CNT-008 | Sync de custom fields a HighLevel bloquea el guardado local | Medio | INT | Contactos / editar | Medio | — | Confirmado |
| CNT-009 | Custom fields segmentados por owner_user_id 'desaparecen' entre empleados | Medio | ARQ | Contactos / custom fields | Medio | Sí | Probable |
| APT-005 | Estados de cita inconsistentes UI/backend ('rescheduled' sin semántica) | Medio | FUN | Citas / estados | Medio | Sí | Confirmado |
| APT-006 | Cancelar por estado no cancela en HighLevel en el mismo PUT | Medio | INT | Citas / cancelar | Medio | — | Probable |
| APT-009 | Crons de recordatorios sin locking entre instancias | Medio | ARQ | Citas / recordatorios | Medio | — | Req. verif. manual |
| GCAL-004 | Eventos all-day de Google a medianoche UTC: desfase de día | Medio | DAT | Google Calendar / inbound | Bajo | — | Probable |
| GCAL-005 | Desconectar Google no revoca el token ni avisa al Installer | Medio | INT | Google Calendar / desconectar | Medio | — | Confirmado |
| GCAL-006 | Citas de Google entran sin contacto ni recordatorios/automatizaciones | Medio | FUN | Google Calendar / inbound | Medio | — | Probable |
| GCAL-007 | UI no muestra estado de sync por-cita con Google | Medio | UX | Google Calendar / agenda | Medio | — | Req. verif. manual |
| GHL-002 | Sync HL→local nunca borra entidades eliminadas en HighLevel | Alto | DAT | HighLevel / cron | Medio | Sí | Confirmado |
| GHL-004 | Citas de HL no capturan googleEventId: riesgo de duplicación | Medio | INT | HighLevel / citas | Bajo | — | Req. verif. manual |
| GHL-005 | Full sync de HL sin lock global: doble ejecución en réplicas | Medio | ARQ | HighLevel / cron | Medio | Sí | Confirmado (ajustado) |
| GHL-006 | Checkpoint de conversaciones avanza aunque se pierdan mensajes | Medio | EST | HighLevel / conversaciones | Bajo | — | Probable |
| GHL-007 | Rutas privadas de HL solo requireAuth, sin rol/módulo | Medio | SEG | HighLevel / API privada | Medio | Sí | Confirmado |
| GHL-009 | Reconciliación Meta muta meta_config sin aviso en cada cron | Medio | PROD | HighLevel / cron Meta | Medio | Sí | Confirmado |
| GHL-011 | Búsqueda WhatsApp→HL puede emparejar el contacto equivocado | Medio | DAT | HighLevel / matching | Medio | — | Probable |
| GHL-012 | collectPaginatedData corta paginación al ver página sin items nuevos | Medio | TEC | HighLevel / paginación | Bajo | — | Probable |
| META-004 | Auto-detección de versión Graph puede saltar a una no soportada | Medio | INT | Meta Ads / versión | Medio | — | Probable |
| META-005 | Access token de Meta se revela y viaja por query string | Medio | SEG | Meta Ads / dropdowns | Medio | — | Confirmado |
| META-006 | Crons de Meta sin locking entre instancias | Medio | ARQ | Meta Ads / cron | Medio | — | Probable |
| META-007 | getCampaigns recalcula atribución (DB+API HL) en cada request | Medio | DEU | Meta Ads / campañas | Alto | — | Req. verif. manual |
| WA-005 | Inferencia de dirección por defecto 'inbound' guarda salientes como entrantes | Medio | DAT | WhatsApp / historial | Medio | — | Probable |
| WA-006 | Fallback a disco local de media: QR sin HTTPS, API no puede enviar | Medio | EST | WhatsApp / media | Bajo | — | Confirmado |
| WA-007 | Estado 'failed' es terminal y bloquea delivered/read posteriores | Medio | DAT | WhatsApp / estados | Bajo | — | Probable |
| WA-009 | Mensajes API que fallan sin fallback QR no se persisten en el chat | Medio | EST | WhatsApp / envío API | Medio | — | Probable |
| PAY-003 | Suscripción Stripe huérfana cobrando si falla el INSERT local | Medio | ARQ | Pagos Stripe / crear sub | Medio | — | Probable (ajustado) |
| PAY-004 | IdempotencyKey reusada bloquea reintento de cobros fallidos 24h | Medio | TEC | Pagos Stripe / parcialidades | Medio | — | Probable |
| PAY-005 | Webhook Stripe sin dedupe por event.id | Medio | EST | Pagos Stripe / webhook | Bajo | — | Confirmado |
| PAY-006 | SQL probado solo en SQLite truena en Postgres (sistémico) | Medio | DEU | Pagos / queries | Alto | Sí | Confirmado |
| PAY-007 | Registro manual de pago no idempotente: duplicado por reintento de red | Medio | VAL | Pagos / registrar manual | Bajo | — | Probable |
| PAY2-002 | Conekta sin webhook: pagos 'pending' (3DS/OXXO/SPEI) no se reconcilian | Medio | INT | Pagos Conekta / pago público | Alto | Sí | Confirmado |
| PAY2-003 | MercadoPago no dispara el comprobante automático tras el pago | Medio | FUN | Pagos / comprobante | Bajo | — | Confirmado |
| PAY2-004 | Página pública no refresca tras volver del checkout de MercadoPago | Medio | FUN | Pagos / pago público | Medio | — | Confirmado |
| PAY2-005 | Webhook MercadoPago acepta peticiones sin firma cuando no hay secret | Medio | SEG | Pagos MP / webhook | Bajo | Sí | Confirmado |
| PAY2-006 | Facturación Gigstack sin reintentos: factura se pierde si falla el 1er intento | Medio | EST | Pagos / facturación | Medio | Sí | Confirmado |
| PAY2-007 | Recordatorios de pago no se envían para links sin due_date | Medio | FUN | Pagos / recordatorio | Bajo | Sí | Probable |
| AUTO-004 | Inscripción duplicada por carrera (check-then-insert sin constraint) | Medio | DAT | Automatizaciones / enrollment | Medio | — | Probable |
| AUTO-005 | Fallo de un nodo deja la inscripción 'exited' sin reintento | Medio | EST | Automatizaciones / scheduler | Medio | — | Confirmado |
| AUTO-006 | El nodo 'Objetivo' nunca evalúa: siempre pasa por 'cumplido' | Medio | FUN | Automatizaciones / publicar | Medio | — | Probable |
| AUTO-007 | Pausar una automatización no detiene las esperas en curso | Medio | FUN | Automatizaciones / scheduler | Medio | — | Probable |
| AUTO-008 | applyTagAction emite eventos en cada ejecución: re-disparos en cadena | Medio | ARQ | Automatizaciones / triggers | Medio | — | Req. verif. manual |
| AUTO-009 | Endpoint de assets de automatización público (lectura por ID) | Medio | SEG | Automatizaciones / adjuntos | Medio | — | Confirmado |
| AI-003 | Follow-ups y recovery solo en memoria/boot: se pierden sin reintento | Medio | EST | Agentes IA / follow-up | Medio | — | Confirmado |
| AI-005 | El asistente ejecuta acciones reales sin idempotencia | Medio | EST | Agentes IA / asistente app | Alto | Sí | Probable |
| AI-006 | Proveedor no-OpenAI sin key OpenAI: media inentendible sin aviso | Medio | INT | Agentes IA / inbound media | Bajo | — | Probable |
| AI-007 | Re-habilitación silenciosa del runtime: apagar toggle global no detiene agentes | Medio | PROD | Agentes IA / kill switch | Bajo | Sí | Confirmado |
| TRK-002 | Sin dedup de sesiones: session_end y reenvíos inflan métricas | Medio | DAT | Tracking / sesiones | Medio | Sí | Probable |
| TRK-003 | Geolocalización síncrona vía ip-api.com (HTTP, 45 req/min) en /collect | Medio | INT | Tracking / sesiones | Medio | — | Confirmado |
| TRK-005 | Fallback attribution: preview y execute usan timezone distinta | Medio | DAT | Tracking / fallback attr | Bajo | — | Confirmado |
| TRK-006 | Fallback attribution sobrescribe ad_id sin backup ni marca | Medio | DAT | Tracking / fallback attr | Bajo | Sí | Confirmado |
| TRK-007 | Trigger links: contact_id/click_count manipulables por query string | Medio | INT | Tracking / trigger links | Medio | Sí | Confirmado |
| NOTI-005 | DELETE de suscripción/dispositivo push sin verificar propiedad | Medio | SEG | Notificaciones / dispositivos | Bajo | — | Confirmado |
| NOTI-006 | processDueAppointmentReminders carga toda la tabla de sends en memoria | Medio | DEU | Recordatorios / cron | Bajo | — | Confirmado |
| NOTI-007 | Mensaje programado en 'sending' tras crash se reenvía (duplicado) | Medio | EST | Mensajes programados / cron | Medio | — | Probable |
| NOTI-008 | Recordatorios con plantilla no APPROVED sin QR fallan en silencio | Medio | EST | Recordatorios / cron | Medio | — | Probable |
| RPT-003 | Costos con applies_to='profit' se ignoran silenciosamente | Medio | FUN | Dashboard / costos | Bajo | — | Confirmado |
| RPT-004 | getGroupExpression en SQLite ignora timezone real (hardcode -6h) | Medio | DAT | Dashboard / agrupación | Medio | — | Confirmado |
| RPT-005 | Gasto no se reatribuye por scope: ROAS diario mal alineado | Medio | DAT | Dashboard / financial-overview | Medio | — | Probable |
| RPT-006 | Conteo de 'Citas' inconsistente entre funnel y gráfica | Medio | DAT | Dashboard / funnel | Medio | — | Confirmado |
| RPT-007 | Citas/asistencias caen a 0 si falta/expira token de HighLevel | Medio | EST | Dashboard / funnel | Medio | — | Probable |
| RPT-008 | Listas de transacciones/contactos sin paginación ni límite | Medio | DEU | Reportes / listas | Medio | — | Confirmado |
| MOB-004 | logout() no limpia tenant runtime; sin logout descubrible en iPhone nativo | Medio | FUN | App móvil / logout | Medio | — | Confirmado (ajustado) |
| MOB-005 | Registro de push nativo limitado por timeout de 16s | Medio | EST | App móvil / push | Bajo | — | Confirmado |
| MOB-006 | Toggles de notificación en PhoneSettings son globales del tenant | Medio | PROD | App móvil / settings | Medio | Sí | Probable |
| MOB-007 | Fechas y caché móvil usan hora local del dispositivo, no del negocio | Medio | DAT | App móvil / fechas | Medio | — | Probable |
| DB-006 | idx_payments_ghl_invoice no único: invoices de HL pueden duplicarse | Medio | DAT | Modelo de datos / pagos | Bajo | — | Confirmado |
| DB-007 | Fusión de contactos: total_paid/purchases_count con MAX en vez de SUM | Medio | DAT | Modelo de datos / merge | Bajo | — | Confirmado |
| DB-008 | appointment_attendance_signals con PK=contact_id (1 señal por contacto) | Medio | DAT | Modelo de datos / asistencia | Medio | Sí | Probable |
| SEC-006 | API externa expone tabla users como directorio | Medio | SEG | Seguridad / API externa | Bajo | — | Confirmado |
| SEC-008 | Registro dinámico de clientes OAuth abierto sin auth | Medio | SEG | Seguridad / OAuth-MCP | Medio | Sí | Probable |
| SEC-009 | CORS totalmente abierto (cors() sin allowlist) | Medio | SEG | Seguridad / global | Bajo | — | Confirmado |
| SEC-010 | Media pública con Content-Disposition inline (riesgo XSS almacenado) | Medio | SEG | Seguridad / media | Medio | — | Req. verif. manual |
| CRON-002 | Reclamo no atómico en cobros Stripe/Conekta: depende de idempotencia externa | Medio | ARQ | Crons / parcialidades | Medio | — | Confirmado |
| CRON-005 | Cron de planes MercadoPago construido pero nunca arrancado | Medio | FUN | Crons / MercadoPago | Bajo | Sí | Confirmado |
| CRON-006 | verifyAndUpdateWebhooks await en boot bloquea el arranque si HL lento | Medio | EST | Crons / boot | Bajo | — | Probable |
| CRON-009 | Sin leader-election ni advisory locks: depende de 1 instancia Render | Medio | ARQ | Crons / despliegue | Alto | Sí | Confirmado |
| INST-005 | Salud marca 'active' un redeploy que no terminó/falló | Medio | EST | Installer / actualizaciones | Medio | — | Probable |
| INST-006 | Una sola API key estática protege el webhook de deploy (redeploy masivo) | Medio | SEG | Installer / webhook deploy | Medio | Sí | Probable |
| INST-007 | pending_promote global sin expiración: promoción colgada/accidental | Medio | VAL | Installer / promoción | Bajo | — | Confirmado |
| INST-008 | Acceso externo a la base de cada cliente abierto a 0.0.0.0/0 permanente | Medio | SEG | Installer / provisioning | Medio | Sí | Confirmado |
| PORTAL-004 | Brokers de refresh aceptan cualquier refresh_token sin atarlo al cliente | Medio | SEG | Installer / OAuth | Medio | — | Probable |
| PORTAL-005 | app_url se promueve a dominio arbitrario desde una verify sin confirmación | Medio | SEG | Installer / licencia | Medio | Sí | Probable |
| PORTAL-006 | JWT del portal con secreto por defecto fuera de prod; sin revocación admin | Medio | SEG | Installer / admin auth | Medio | — | Confirmado |
| PORTAL-007 | Rate limit en memoria no protege con múltiples instancias | Medio | ARQ | Installer / auth | Medio | — | Probable |

### BAJOS

| ID | Título | Sev | Tipo | Módulo / Flujo | Esfuerzo | ¿Decisión? | Confianza |
|---|---|---|---|---|---|---|---|
| AUTH-008 | verify endpoint sin auth acepta token en el body | Bajo | DEU | Auth / verify | Bajo | — | Confirmado |
| AUTH-009 | requestPortalUserRefresh best-effort: empleados sin login móvil | Bajo | EST | Auth / usuarios | Medio | — | Probable |
| LIC-008 | Features capturadas solo al login: cambios de plan no se reflejan | Bajo | FUN | Licenciamiento / login | Medio | Sí | Confirmado |
| ACL-005 | Filtros de ocultos interpolados como string en SQL | Bajo | TEC | Multi-tenancy / ocultos | Medio | — | Probable |
| CNT-010 | sync-stats hace UPDATE full-table con subconsultas a demanda | Bajo | DEU | Contactos / stats | Medio | — | Confirmado |
| CNT-011 | Bulk delete secuencial sin progreso ni cancelación | Bajo | UX | Contactos / bulk delete | Medio | — | Confirmado |
| CNT-012 | createContact: check-then-insert no atómico | Bajo | TEC | Contactos / crear | Bajo | — | Confirmado |
| APT-007 | createPublicAppointment pasa 'context' ignorado (disponibilidad solo local) | Bajo | DEU | Citas / reserva pública | Bajo | — | Confirmado |
| APT-008 | Estado inicial del modal 'confirmed' ignora autoConfirm | Bajo | UX | Citas / agendar admin | Bajo | Sí | Probable |
| APT-010 | updateContactAppointmentDate no excluye 'noshow' | Bajo | DAT | Citas / no-show | Bajo | — | Confirmado |
| GCAL-008 | Token cache global por proceso; no invalida revocaciones | Bajo | DEU | Google Calendar / token | Bajo | — | Probable |
| GHL-008 | Versión de API inconsistente en export de conversaciones | Bajo | INT | HighLevel / conversaciones | Bajo | — | Req. verif. manual |
| GHL-010 | isHighLevelConnected no valida scopes de calendarios/conversaciones | Bajo | VAL | HighLevel / conexión | Bajo | — | Probable |
| META-008 | updateRecentAds no elimina filas obsoletas del rango reciente | Bajo | DAT | Meta Ads / sync reciente | Bajo | — | Probable |
| META-009 | Estado 'desconectado' no apaga el cron ni lo consulta getMetaConfig | Bajo | ARQ | Meta Ads / desconectar | Bajo | — | Req. verif. manual |
| META-010 | saveAdsToDatabase un INSERT por anuncio sin transacción | Bajo | DEU | Meta Ads / sync | Medio | — | Confirmado |
| WA-008 | Validación de plantilla APPROVED se omite si no está sincronizada | Bajo | VAL | WhatsApp / plantillas | Bajo | — | Confirmado |
| PAY-008 | Cron de parcialidades sin lock en DB | Bajo | ARQ | Pagos Stripe / cron | Medio | — | Probable |
| PAY-009 | createStripePaymentIntent sin idempotencyKey: intents huérfanos | Bajo | TEC | Pagos Stripe / pago público | Bajo | — | Probable |
| PAY2-008 | Tarjeta del cliente se guarda por defecto en pago público Conekta | Bajo | PROD | Pagos Conekta / pago público | Bajo | Sí | Confirmado |
| PAY2-009 | Página /pay expone identidad fiscal del merchant (RFC, razón social) | Bajo | DAT | Pagos / pago público | Bajo | — | Confirmado |
| PAY2-010 | Generación de preferencia MP en parcialidades sin claim atómico | Bajo | ARQ | Pagos MP / cron | Medio | — | Probable |
| PAY2-011 | Migración de limpieza hardcodeada evidencia bug de sync con contactId | Bajo | DEU | Pagos / mantenimiento | Bajo | Sí | Req. verif. manual |
| AUTO-010 | Variables {{...}} desconocidas se renderizan como cadena vacía | Bajo | UX | Automatizaciones / publicar | Medio | — | Probable |
| AI-008 | Trace del agente IA visible para cualquier usuario con módulo ai_agent | Bajo | SEG | Agentes IA / traces | Bajo | — | Probable |
| AI-009 | Debounce/delay en memoria: pendingContactReruns se pierde en reinicio | Bajo | DEU | Agentes IA / inbound | Medio | — | Confirmado |
| TRK-008 | Offset de timezone hardcodeado a -6h en SQLite | Bajo | DEU | Tracking / reportes | Bajo | — | Confirmado |
| TRK-009 | Snippet inyecta visitor_id en la URL (rkvi_id): fuga en referrers | Bajo | PROD | Tracking / identidad | Bajo | Sí | Probable |
| TRK-010 | En no-producción cualquier host no configurado pasa como dashboard | Bajo | ARQ | Tracking / host middleware | Bajo | — | Confirmado |
| NOTI-009 | Llaves VAPID autogeneradas en DB; rotación rompe suscripciones | Bajo | DEU | Notificaciones / web push | Bajo | — | Confirmado |
| NOTI-010 | Sin flush-on-drain para recordatorios/programados al apagar | Bajo | DEU | Notificaciones / drain | Medio | — | Req. verif. manual |
| RPT-009 | Endpoints con placeholders $1/$2 y array posicional fallan en SQLite | Bajo | TEC | Dashboard / queries dev | Bajo | — | Req. verif. manual |
| RPT-010 | Fallback de costos usa IVA 16% si falla la query de costs | Bajo | DEU | Dashboard / costos | Bajo | — | Confirmado |
| MOB-008 | disableMobileDevice borra dispositivos por token sin verificar dueño | Bajo | SEG | App móvil / push | Bajo | — | Confirmado |
| MOB-009 | Secciones premium en PhoneApp muestran ceros en vez de avisar bloqueo | Bajo | UX | App móvil / premium | Medio | Sí | Req. verif. manual |
| DB-009 | appointments sin created_at/updated_at; columnas por ALTER frágiles | Bajo | DEU | Modelo de datos / appointments | Medio | — | Confirmado |
| DB-010 | Sin tabla de auditoría/historial para entidades sensibles | Bajo | EST | Modelo de datos / auditoría | Medio | Sí | Confirmado |
| SEC-011 | Comparación de firma JWT no constante (timing) | Bajo | SEG | Seguridad / sesión | Bajo | — | Confirmado |
| SEC-012 | Filtro de ocultos construye SQL por concatenación de string | Bajo | DEU | Seguridad / contactos | Medio | — | Probable |
| CRON-008 | Crons de sync Meta/HL sin guard de solape | Bajo | DEU | Crons / sync | Bajo | — | Probable |
| INST-009 | El webhook de deploy confía en 'channel'/'branch' del body | Bajo | VAL | Installer / auto-update | Bajo | — | Probable |
| INST-010 | Endpoints de instalación sin rate limiting | Bajo | DEU | Installer / provisioning | Bajo | — | Probable |
| PORTAL-008 | Mensajes de bloqueo de licencia indistinguibles | Bajo | UX | Installer / licencia | Bajo | — | Confirmado |
| PORTAL-009 | Cron de provisioning/sync sin locking entre réplicas | Bajo | ARQ | Installer / sync usuarios | Medio | — | Req. verif. manual |

---

# Fichas detalladas — CRÍTICOS y ALTOS

> Donde el hallazgo está marcado `Req. verif. manual` o `Probable` se indica explícitamente: el código respalda el defecto, pero su materialización depende de runtime/infra (p. ej. >1 instancia Render) o de un comportamiento externo no verificable solo leyendo el repo.

---

## NOTI-001 — Caída/ausencia de OpenAI puede CANCELAR citas confirmadas (CRÍTICO)

**Descripción.** En `processConfirmationWindow`, si `classifyConfirmationResponse` devuelve `null` (sin API key de OpenAI, error de red, JSON inválido, timeout), `result` cae a `'ambiguous'`. Para cualquier resultado distinto de `'confirmed'` se ejecuta el `no_confirm_action` del recordatorio; si el usuario eligió `'cancel_appointment'`, la cita se cancela **aunque el contacto haya respondido "sí, confirmo"**.

**Evidencia.**
- `backend/src/services/appointmentConfirmationService.js:203-235` (`processConfirmationWindow`): `result = classification?.result || 'ambiguous'`; la rama `else` ejecuta `executeNoConfirmAction`.
- `backend/src/services/appointmentConfirmationService.js:296-303` (`executeNoConfirmAction`): action `'cancel_appointment'` setea `appointment_status='cancelled'`.
- `backend/src/agents/appointmentConfirmationAgent.js:74-78,106-128` (`classifyConfirmationResponse`): devuelve `null` sin API key, por error, o por JSON inválido.

**Por qué es problema real.** OpenAI falla de forma intermitente y la API key puede faltar (el agente loguea "Sin API Key"). El UPDATE a `'confirmed'` SOLO ocurre con `result==='confirmed'`, así que una respuesta afirmativa real durante una caída de OpenAI termina cancelada. El comportamiento por defecto ante fallo del clasificador debería ser **no tomar acción destructiva**.

**Cómo reproducir/verificar.** Configurar recordatorio `confirmation` con `ai_enabled=1` y `no_confirm_action='cancel_appointment'`. Quitar/expirar la API key de OpenAI. Que un contacto responda "sí". Al expirar la ventana → `classifyConfirmationResponse=null` → `'ambiguous'` → cita cancelada.

**Impacto.** Pérdida de citas reales; pacientes marcados como cancelados sin haberlo pedido. En contexto médico es destructivo: daño operativo y de confianza.

**Solución recomendada.** Si la clasificación es `null` (fallo del modelo), marcar la ventana como `'error'`/`'human_needed'` y **no** ejecutar acciones destructivas. Separar "sin clasificación" de "clasificado como ambiguo".

**Archivos involucrados.** `appointmentConfirmationService.js`, `appointmentConfirmationAgent.js`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** No (es un bug); conviene confirmar la semántica deseada de `no_confirm_action`.

---

## MOB-001 — CORS del installer bloquea la resolución de tenant en Android nativo (CRÍTICO de producto)

**Descripción.** `capacitor.config.ts` fija `androidScheme:'https'`, por lo que el WebView de Android usa origin `https://localhost`. El installer solo permite en CORS de producción `capacitor://localhost`, `ionic://localhost` y el origin del portal. El `POST /api/mobile/resolve` desde el WebView de Android se rechaza por CORS → no se puede resolver el backend del cliente ni iniciar sesión en el binario Android. iOS usa `capacitor://localhost` y sí pasa.

**Evidencia.**
- `frontend/capacitor.config.ts:10-12` (`server.androidScheme`).
- `../Ristak - Installer/backend/src/server.js:42-58` (`nativeMobileOrigins`/`corsOptions`).
- `frontend/src/services/mobileTenantService.ts:34-43` (`resolveAndStoreMobileTenant`).

**Por qué es problema real.** Sin resolve no hay `baseUrl` ni login: la app Android queda inutilizable en el primer arranque.

**Cómo reproducir/verificar.** Compilar AAB Android (`mobile:android:aab`), abrir contra installer en producción, intentar login con correo → `/api/mobile/resolve` falla por CORS.

**Impacto.** La app Android no puede loguear a ningún usuario en producción.

**Solución recomendada.** Agregar `https://localhost` (y el scheme Android usado) a `nativeMobileOrigins`, o usar `androidScheme`/`hostname` que produzca un origin permitido, o llamar al resolve server-to-server en nativo.

**Archivos involucrados.** `capacitor.config.ts`, installer `server.js`, `mobileTenantService.ts`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** No. **Confianza: Probable** — verificar el header exacto que emite el WebView de Android y que `NODE_ENV=production` esté activo en el installer antes de cerrar como bloqueante absoluto.

---

## SEC-001 — Proxy arbitrario a GoHighLevel: control total con un API token (CRÍTICO)

**Descripción.** `POST /api/external/highlevel/request` acepta `method`+`path` arbitrarios y los ejecuta contra `services.leadconnectorhq.com` usando el token de GoHighLevel de la instalación. Cualquier portador de un API token de Ristak (no admin) puede leer/escribir/eliminar TODO en la cuenta GHL ligada (contactos, conversaciones, calendarios, usuarios, oportunidades).

**Evidencia.**
- `backend/src/routes/external.routes.js:1089-1118` (`proxyHighLevelRequest`): única validación es `allowedMethods` y `normalizeGhlApiPath`.
- `backend/src/routes/external.routes.js:302-308` (`normalizeGhlApiPath`): solo bloquea `..`, `//` y URLs absolutas; **no** restringe recursos.
- Montado en `router.use(requireApiToken)` (`external.routes.js:753`): solo exige un API token válido; sin rol admin ni scope.

**Por qué es problema real.** El API token lo genera cualquier usuario con acceso al módulo `settings_api_access` y no tiene scopes reales (todo es `ristak.read` pero permite escritura). Convierte un token de bajo privilegio en control total de la plataforma externa con los datos de los pacientes/clientes. `DELETE` arbitrario sin confirmación.

**Cómo reproducir/verificar.** Con un API token válido: `POST /api/external/highlevel/request {"method":"GET","path":"/contacts/"}` o un `DELETE` a cualquier recurso GHL.

**Impacto.** Fuga y manipulación masiva de datos privados de clientes en GoHighLevel; capacidad de cobrar/borrar fuera de Ristak.

**Solución recomendada.** Eliminar o restringir el proxy a una allowlist explícita de paths/métodos de solo lectura; exigir rol admin y un scope dedicado; registrar auditoría de cada llamada.

**Archivos involucrados.** `external.routes.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — definir si el proxy genérico debe existir y con qué allowlist.

---

## AUTH-001 / SEC-004 — Sin rate limiting ni lockout (login, OAuth authorize, API externa) (ALTO)

**Descripción.** No existe ningún rate limiter en el backend de la app. `POST /api/auth/login`, `POST /api/oauth/authorize`, `POST /api/oauth/token` y la API externa son ilimitados. Sin contador de intentos fallidos ni lockout. El installer tiene `rateLimit.js`, pero la app no.

**Evidencia.**
- `backend/src/controllers/authController.js:129-241` (`login`): entra directo a `verifyPassword`.
- `backend/src/routes/auth.routes.js:43`: ruta sin rate limit (también `/setup`:34, `/sso`:40).
- `backend/src/server.js:152-159`: solo `cors()` y `express.json`. `grep` de `express-rate-limit` no encuentra nada.

**Por qué es problema real.** El password mínimo es 6 caracteres (AUTH-005), el admin suele usar email conocido, es un CRM con datos de clientes/pagos. Sin throttling, un script revienta cuentas por fuerza bruta y se puede scrapear la API externa.

**Cómo reproducir/verificar.** Lanzar N intentos de login con passwords distintos contra la misma cuenta: ninguno se bloquea ni se retrasa.

**Impacto.** Cuentas comprometibles por fuerza bruta; exposición de datos; abuso de la API externa.

**Solución recomendada.** `express-rate-limit` (o el `rateLimit.js` del installer) por IP+identificador en `/login`, `/sso`, `/setup`, `/oauth/authorize`, `/oauth/token`, `/api/external`, con backoff y lockout temporal tras N fallos.

**Archivos involucrados.** `authController.js`, `auth.routes.js`, `server.js`, routers OAuth/external.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** No.

---

## LIC-003 — allowed:true sin 'features' otorga TODO el plan premium (failure-open) (ALTO)

**Descripción.** `verifyLicenseWithServer` guarda `features = normalizeLicenseFeatures(data.features)`. Si el portal responde `{ allowed:true }` sin `features` (o `features:null`), `normalizeLicenseFeatures` recibe `undefined` y retorna `{ ...DEFAULT_FEATURES }` con TODAS las features en `true`.

**Evidencia.**
- `backend/src/services/licenseService.js:319-331` (`verifyLicenseWithServer`).
- `backend/src/services/licenseService.js:249-254` (`normalizeLicenseFeatures`): `source = {}` si features no es objeto → `{ ...DEFAULT_FEATURES }`.
- `backend/src/services/licenseService.js:21-47` (`DEFAULT_FEATURES`): todas en `true`.

**Por qué es problema real.** Cualquier respuesta válida pero sin `features` (bug del portal, endpoint viejo, payload truncado) abre todo el plan premium en vez de fallar cerrado.

**Cómo reproducir/verificar.** Simular respuesta del portal `{ allowed:true }` sin `features`; el cliente queda con todas las features activas.

**Impacto.** Otorgamiento involuntario de features premium; el modelo de planes deja de ser confiable.

**Solución recomendada.** Si `enforced` y `data.allowed` pero `data.features` ausente/vacío, tratar como features mínimas (solo base) o error de validación. Separar `DEFAULT_FEATURES` (standalone) del default remoto.

**Archivos involucrados.** `licenseService.js`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** No.

---

## GCAL-001 — Cancelar evento en Google hace HARD DELETE de la cita en Ristak (ALTO)

**Descripción.** En `syncGoogleEventsToLocal`, todo evento `cancelled` dispara `deleteLocalAppointmentForCancelledGoogleEvent`, que llama `deleteLocalAppointment(existing.id)` sin `markPendingDelete` → `DELETE FROM appointments WHERE id = ?` (hard delete). Un evento cancelado/borrado en Google elimina la cita en el CRM, incluida una creada en Ristak, con su contacto/notas/trazabilidad.

**Evidencia.**
- `backend/src/services/googleCalendarService.js:514-530, 601-606`. Empareja por `privateProps.ristakAppointmentId` (que ES el id real de la cita, `googleEventToAppointment` línea 497) o `event.id`. Sin `markPendingDelete`, `localCalendarService.js:2910-2926` ejecuta hard delete.

**Por qué es problema real.** Google es secundario pero gana destructivamente sobre el sistema de registro. Una acción accidental en Google borra datos de negocio sin rastro ni papelera.

**Cómo reproducir/verificar.** Cancelar/borrar en Google un evento que tiene cita en Ristak; tras el sync entrante, la cita local desaparece.

**Impacto.** Pérdida silenciosa de citas y su historial; el dueño no sabe por qué desaparecieron.

**Solución recomendada.** En vez de `deleteLocalAppointment`, marcar `appointment_status='cancelled'` y `google_sync_status`; nunca hard-delete por evento remoto.

**Archivos involucrados.** `googleCalendarService.js`, `localCalendarService.js`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** No.

---

## META-001 — CPM y CTR se calculan con reach en vez de impressions (ALTO)

**Descripción.** En `saveAdsToDatabase`, `cpm = (spend/reach)*1000` y `ctr = (clicks/reach)*100`. Como `reach` (usuarios únicos) ≤ impressions, ambas métricas quedan infladas. `META_INSIGHTS_FIELDS` ni incluye `impressions`, así que el dato correcto nunca se trae de Meta.

**Evidencia.**
- `backend/src/services/metaAdsService.js:738-739` (cpm/ctr usan `ad.reach`).
- `backend/src/config/constants.js:106-118` (`META_INSIGHTS_FIELDS`): no incluye `impressions`. La columna `meta_ads` tampoco persiste `impressions`.

**Por qué es problema real.** El usuario toma decisiones de presupuesto con CPM/CTR que no reconcilian con Meta Ads Manager; erosiona la confianza y puede apagar campañas buenas.

**Cómo reproducir/verificar.** Conectar Meta, sincronizar y comparar CPM/CTR en Ristak vs Meta Ads Manager para el mismo ad/día.

**Impacto.** Métricas clave de rendimiento publicitario erróneas en toda la app.

**Solución recomendada.** Agregar `impressions` a `META_INSIGHTS_FIELDS`, calcular con `impressions` y persistirlo en `meta_ads`.

**Archivos involucrados.** `metaAdsService.js`, `constants.js`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** No.

---

## WA-001 — Webhook YCloud público acepta payloads sin firmar cuando no hay webhook_secret (ALTO)

**Descripción.** `verifyYCloudSignature()` devuelve `null` cuando no hay secret, y `processYCloudWhatsAppWebhook` solo rechaza cuando `signatureValid === false`. Si el secret nunca se guardó (YCloud sin permiso para crear webhooks → solo se guarda un warning), TODO payload a `/webhook/whatsapp-api/ycloud` se procesa sin verificación.

**Evidencia.**
- `backend/src/services/whatsappApiService.js:5517-5533` (`if (!secret) return null`).
- `backend/src/services/whatsappApiService.js:5566-5594` (solo bloquea `=== false`).
- `backend/src/services/whatsappApiService.js:3324-3347` (al fallar el webhook, catch solo warning y conexión `enabled='1'`).
- `backend/src/routes/webhooks.routes.js:40` (público sin auth).

**Por qué es problema real.** En cuentas YCloud sin permiso para crear webhooks, el secret nunca existe y el endpoint queda abierto. Un atacante inyecta mensajes entrantes falsos: crea/actualiza contactos, dispara automatizaciones, el agente IA y notificaciones push, y falsea atribución de anuncios.

**Cómo reproducir/verificar.** En una instalación sin `webhook_secret`, enviar un POST sin firma a `/webhook/whatsapp-api/ycloud`: se procesa.

**Impacto.** Inyección de mensajes/contactos/atribución falsos y disparo no autorizado de automatizaciones y agente IA.

**Solución recomendada.** Rechazar (401) cualquier webhook si no hay `webhook_secret`; o exigir secret antes de marcar la conexión activa. Tratar `signatureValid===null` como inválido en producción.

**Archivos involucrados.** `whatsappApiService.js`, `webhooks.routes.js`, `whatsappApiController.js`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** Sí — decidir si una conexión sin secret debe quedar "activa" o forzar reconexión.

---

## PAY-001 — Eliminar una suscripción NO la cancela en Stripe (ALTO)

**Descripción.** `deleteSubscription()` cancela MercadoPago y Conekta antes de marcar `'deleted'`, pero omite Stripe: el `SELECT` ni siquiera trae `stripe_subscription_id`. Una suscripción Stripe activa sin cobros registrados queda `'deleted'` en Ristak mientras Stripe sigue facturando.

**Evidencia.**
- `backend/src/services/subscriptionsService.js:868-888` (`deleteSubscription`): SELECT (L869) trae `id,status,mercadopago_*,conekta_*`; cancela MP (L877) y Conekta (L880) pero nunca Stripe. `cancelStripeRecurringSubscription` está importado (L4) y existe, pero no se usa aquí.

**Por qué es problema real.** El cliente final sigue siendo cobrado mes a mes por una suscripción que el operador cree eliminada. Fuga de dinero del cliente del negocio + chargebacks/soporte.

**Cómo reproducir/verificar.** Crear suscripción Stripe; antes del primer cobro registrado, `deleteSubscription`; verificar en Stripe que sigue `active`.

**Impacto.** Cobros recurrentes fantasma; pérdida de confianza y disputas.

**Solución recomendada.** Incluir `stripe_subscription_id` en el SELECT y, si existe y `status!='cancelled'`, llamar `cancelStripeRecurringSubscription` antes del UPDATE a `'deleted'`.

**Archivos involucrados.** `subscriptionsService.js`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** No.

---

## SEC-003 — Master key de cifrado guardada en plano en la misma DB (ALTO)

**Descripción.** Si `ENCRYPTION_MASTER_KEY` no está en el entorno, `getMasterKey()` genera una clave y la guarda en `app_config.encryption_master_key` en texto plano. Todos los secretos de integraciones (Stripe, Meta, GHL, Google, OpenAI) se cifran con esa misma clave y viven en la misma base.

**Evidencia.**
- `backend/src/utils/encryption.js:50-73` (`getMasterKey`): `INSERT INTO app_config (encryption_master_key)` con la clave en hex plano.

**Por qué es problema real.** El cifrado en reposo deja de proteger el escenario más común (dump/backup de la DB): la llave viaja al lado del ciphertext.

**Cómo reproducir/verificar.** Arrancar sin `ENCRYPTION_MASTER_KEY`; inspeccionar `app_config` y ver la llave maestra en claro.

**Impacto.** Exposición de todas las claves secretas de pago e integraciones si se filtra un backup/dump.

**Solución recomendada.** Exigir `ENCRYPTION_MASTER_KEY` desde el entorno (fallar el arranque en producción si falta) en lugar de auto-generar/persistir en DB; documentar rotación.

**Archivos involucrados.** `encryption.js`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** Sí — manejo de la llave y migración de secretos existentes.

---

## AUTO-003 / CRON-004 — processDueResumes sin claim atómico: doble ejecución (ALTO)

**Descripción.** `processDueResumes` hace `SELECT` de enrollments `waiting` con `resume_at<=now` y los procesa con `runFrom` (envía WhatsApp/email) ANTES de cambiar su estado. No hay `UPDATE ... WHERE status='waiting'` que reclame la fila (a diferencia de `processScheduledContactEnrollments`). El tick tampoco tiene guard `running`.

**Evidencia.**
- `automationEngine.js:3621-3688` (`processDueResumes`: SELECT + `runFrom` directo).
- `automationEngine.js:3582-3588` (contraste con claim atómico).
- `automationEngine.js:3690-3707` (`startAutomationScheduler`: `setInterval(20s)` sin guard por-tick).

**Por qué es problema real.** La rama post-espera es típicamente un envío de WhatsApp o acción sobre el contacto; ejecutarla dos veces duplica mensajes/etiquetas/webhooks. Con réplicas/solape de deploy o ticks solapados (>20s), dos procesos toman el mismo lote.

**Cómo reproducir/verificar.** Dos ticks/instancias procesando el mismo enrollment `waiting` vencido.

**Impacto.** Doble mensaje/acción en flujos con esperas (wait/delay/drip/timeout).

**Solución recomendada.** Reclamar con `UPDATE ... SET status='active' WHERE id=? AND status='waiting'` y procesar solo si `changes>0`. Añadir guard `running` al tick.

**Archivos involucrados.** `automationEngine.js`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** No. (Causa raíz transversal: ver CRON-009.)

---

## PORTAL-002 — setup-token/verify (peek) expone el hash de password del dueño, repetible (ALTO)

**Descripción.** `POST /api/setup-token/verify` llama `peekSetupToken`, que NO consume el token y devuelve `owner_password_hash` (PBKDF2 del dueño) + email + client_id. `findValidToken` solo verifica `installation_id` si se envía. Basta el token (que viaja en la URL de SSO `/sso?token=...` y se reutiliza para el app-login de soporte del admin) para obtener el hash repetidamente (rate limit 30/15min, TTL 24h).

**Evidencia.**
- `setupToken.service.js:53-70` (SELECT incluye `owner_password_hash`; `installation_id` opcional).
- `license.routes.js:517-539` (peek devuelve `password_hash`).
- `admin.routes.js:1158-1159` (token de soporte va en la URL).

**Por qué es problema real.** El token viaja en query string (logs de proxy, historial, referers). Quien lo capture puede extraer el hash para crackeo offline, cuantas veces quiera dentro del TTL.

**Cómo reproducir/verificar.** Capturar un `?token=` de un SSO/setup y llamar `/api/setup-token/verify` repetidamente; cada respuesta trae el hash.

**Impacto.** Fuga del hash de contraseña del dueño → crackeo offline y toma de cuenta.

**Solución recomendada.** No devolver `password_hash` en `/verify` (peek). Entregar el hash solo en `/consume` (un solo uso) y exigir `installation_id` obligatorio en ambos. Mover el token al body/Authorization en vez de la query string.

**Archivos involucrados.** `license.routes.js`, `setupToken.service.js`, `admin.routes.js`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** No.

---

## PORTAL-003 — Token de release móvil reusable + endpoint de credenciales sin rate limit (ALTO)

**Descripción.** `validateMobileReleaseToken` solo actualiza `last_used_at`; nunca lo marca consumido → reutilizable hasta expirar (TTL 120min). `readMobileReleaseCredentials` devuelve en claro `.p8` de App Store Connect, certificado iOS + password, provisioning profile, keystore de Android + passwords y el service account JSON de Google Play. El endpoint `POST /api/webhooks/mobile-release/credentials` no pasa por `rateLimit()`.

**Evidencia.**
- `mobileStoreRelease.service.js:121-156` (solo `last_used_at`), `158-174` (credenciales en claro).
- `webhook.routes.js:569-591` (sin `rateLimit`; ni siquiera lo importa).

**Por qué es problema real.** Si el token se filtra (logs CI, env expuestas, MITM en un runner) cualquiera puede leer TODAS las credenciales de firma durante 120 min, repetidamente, y firmar/publicar apps maliciosas en App Store/Play Store en nombre del editor.

**Cómo reproducir/verificar.** Reutilizar un token de release válido contra `/api/webhooks/mobile-release/credentials`; devuelve las credenciales de nuevo.

**Impacto.** Compromiso de la identidad de publicación móvil (firma Apple/Google) de la marca.

**Solución recomendada.** Token de un solo uso (`consumed_at` en la primera lectura) o 1-2 usos. Añadir `rateLimit` estricto, reducir el TTL y loguear cada lectura con IP.

**Archivos involucrados.** `mobileStoreRelease.service.js`, `webhook.routes.js`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** No.

---

## INST-002 — auto_update_on_push es código muerto: el webhook actualiza todo el canal Test (ALTO)

**Descripción.** El webhook `POST /api/webhooks/deploy`, en cada push a main, llama `triggerChannelUpdate('test')`, que selecciona TODAS las instalaciones `test` active/deploying SIN filtrar por `auto_update_on_push`. La función que respeta el flag (`triggerAdminSelectedAutoUpdates`) no tiene ningún caller. Además el PATCH de canal autopone el flag a `true` para Test.

**Evidencia.**
- `webhook.routes.js:487` (`triggerChannelUpdate('test')`), `update.service.js:100-121` (sin filtro) / `126-152` (función sin caller), migración `011`.

**Por qué es problema real.** El admin cree controlar qué apps Test se auto-actualizan, pero todas se redespliegan en cada push; control de operación ilusorio.

**Cómo reproducir/verificar.** Apagar `auto_update_on_push` en una app Test; hacer push a main; la app se redespliega igual.

**Impacto.** Toggle visible en el panel que no hace lo que dice.

**Solución recomendada.** Si el flag debe gobernar el auto-update, el webhook debe usar `triggerAdminSelectedAutoUpdates` (o filtrar por el flag). Si Test siempre se auto-actualiza por diseño, eliminar el flag/migración.

**Archivos involucrados.** `webhook.routes.js`, `update.service.js`, migración `011`.

**Esfuerzo.** Bajo. **¿Decisión del dueño?** Sí.

---

## SEC-002 — Webhooks de pago/contacto/refund/appointment sin verificación de firma (ALTO)

**Descripción.** `handlePaymentWebhook`, `handleContactWebhook`, `handleRefundWebhook` y `handleAppointmentWebhook` montados en `/webhook` y `/webhooks` no verifican firma ni secreto. Aceptan el body tal cual y crean/actualizan contactos, pagos y citas. Solo Stripe y Meta validan.

**Evidencia.**
- `webhooksController.js:730-755` (`handlePaymentWebhook`): lee `req.body` sin verificar firma.
- `webhooks.routes.js:24-43`: rutas sin middleware de verificación. `rawBody` está disponible (`server.js:155-156`) pero no se usa.

**Por qué es problema real.** Las URLs de webhook son adivinables/filtrables; cualquiera puede inyectar pagos falsos (inflar ingresos), crear contactos basura o disparar automatizaciones/cobros.

**Cómo reproducir/verificar.** `curl -X POST https://<app>/webhook/payment` con un JSON con `transaction_id`/`contact_id` arbitrarios.

**Impacto.** Corrupción de datos financieros y de CRM, métricas falsas, disparo de flujos.

**Solución recomendada.** Exigir un secreto compartido/HMAC por instalación (usar `rawBody`) o un token en header validado contra `app_config`; rechazar 401 si no coincide.

**Archivos involucrados.** `webhooksController.js`, `webhooks.routes.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## GHL-001 — Token de HighLevel en texto plano + endpoint que lo revela (ALTO)

**Descripción.** El Private Integration Token de HL se guarda sin cifrar en `highlevel_config.api_token` y `GET /api/highlevel/config/reveal/api_token` lo devuelve íntegro a cualquier usuario autenticado (la ruta solo exige `requireAuth`, no rol/módulo). A diferencia de `openai_api_key_encrypted`, este token está en claro.

**Evidencia.**
- `highlevelController.js:1155-1180` (`revealToken`): devuelve `config.api_token` sin máscara.
- `highlevel.routes.js:53`: solo `requireAuth`.
- `database.js:1140`: `api_token TEXT` sin cifrar (vs `openai_api_key_encrypted` en 1429).

**Por qué es problema real.** Un empleado de bajo privilegio o una sesión comprometida obtiene control total del CRM externo (datos de todos los clientes, capacidad de cobrar/borrar).

**Cómo reproducir/verificar.** Como cualquier usuario logueado: `GET /api/highlevel/config/reveal/api_token` → token completo.

**Impacto.** Fuga de la credencial maestra del CRM externo.

**Solución recomendada.** Cifrar `api_token` en reposo (como `openai`); restringir `revealToken` a admin vía `userAccessMiddleware`; devolver solo preview salvo acción explícita auditada.

**Archivos involucrados.** `highlevelController.js`, `highlevel.routes.js`, `database.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — quién puede ver el token y política de auditoría.

---

## AUTH-002 — Instructivo público de reset deja credenciales fijas admin/admin123 (ALTO)

**Descripción.** El panel "¿Olvidé mi usuario o contraseña?" en `/login` muestra a cualquier visitante un comando que, ejecutado en el Render Shell, resetea el primer usuario a `admin`/`admin123` (hardcodeado). El comando y las credenciales resultantes están visibles en la UI y en el frontend.

**Evidencia.**
- `frontend/src/pages/Login/Login.tsx:126-132, 280-305`: hardcodea `pbkdf2Sync('admin123',...)` y muestra "Usuario: admin / Contraseña: admin123".

**Por qué es problema real.** Cualquiera que abra `/login` ve el password objetivo. Si alguien con acceso al Render Shell corre el comando, la cuenta queda con password trivial y conocido públicamente. Normaliza un password débil universal.

**Cómo reproducir/verificar.** Abrir `/login`, desplegar el panel de recuperación: el comando y las credenciales son visibles.

**Impacto.** Toma de cuenta del admin con credenciales públicamente conocidas tras un reset.

**Solución recomendada.** El reset debería generar un password aleatorio mostrado una sola vez en el Shell, o forzar cambio de password en el primer login post-reset. No exhibir el comando ni el password objetivo en la UI pública. (Relacionado con AUTH-010.)

**Archivos involucrados.** `Login.tsx`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No (resolver junto con AUTH-010).

---

## AUTH-003 / SEC-007 — JWT 30 días sin revocación; cambiar password no invalida sesiones (ALTO)

**Descripción.** El JWT casero lleva `userId/username/email/role/iat/exp` (30 días) sin `jti` ni `token_version`. `logout()` solo borra `localStorage`. `changePassword` actualiza el hash pero no invalida tokens previos. `requireAuth` re-valida `is_active`/`role` en cada request (mitiga desactivaciones), pero la firma sigue válida 30 días. Solo rotar `JWT_SECRET` revoca, y eso tumba a todos.

**Evidencia.**
- `frontend/src/contexts/AuthContext.tsx:267-272` (`logout`).
- `backend/src/utils/auth.js:94-163` (`generateToken`/`verifyToken`).
- `backend/src/controllers/authController.js:456-463` (`changePassword`).

**Por qué es problema real.** Ante robo de token (XSS, dispositivo compartido, log filtrado) no hay forma de cerrar esa sesión. El cambio de contraseña da falsa sensación de seguridad.

**Cómo reproducir/verificar.** Copiar un JWT válido, cambiar la contraseña del usuario; el JWT copiado sigue funcionando.

**Impacto.** Ventana de 30 días de acceso persistente con un token comprometido.

**Solución recomendada.** Añadir `token_version`/`password_changed_at` en `users`, incluirlo en el payload y compararlo en `requireAuth`; incrementarlo en `changePassword` y en un logout server-side. Opcionalmente reducir TTL + refresh tokens revocables.

**Archivos involucrados.** `auth.js`, `authController.js`, `AuthContext.tsx`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — definir TTL y modelo de refresh.

---

## SEC-005 — getContactById ignora el filtro de contactos ocultos (ALTO)

**Descripción.** El filtro de "contactos ocultos" se aplica en listados (`getContacts`), pero `getContactById` hace `SELECT` directo por id sin filtro. Cualquier usuario autenticado (o un API token vía `/api/external/contacts/:id`) puede recuperar el detalle completo de un contacto oculto si conoce/adivina su ID.

**Evidencia.**
- `contactsController.js:2310-2349` (`getContactById`): `WHERE c.id = ?` sin `buildHiddenContactsCondition`.
- `hiddenContactsFilter.js:9-20` (filtro **global**, no per-user, solo en listados).
- La API externa monta el mismo `getContactById` (`external.routes.js:1163`).

**Por qué es problema real.** El contacto está oculto para todos en listados pero recuperable por ID por cualquier usuario/token. (Matiz: el filtro es global, no per-rol; la fuga es "recuperable por ID" más que "rompe aislamiento entre roles".)

**Cómo reproducir/verificar.** `GET /api/contacts/:id` (o `/api/external/contacts/:id`) con el ID de un contacto que cae bajo un `hidden_contact_filter`.

**Impacto.** Fuga de datos privados de contactos que deberían estar ocultos.

**Solución recomendada.** Aplicar la condición de ocultos en `getContactById`/`getContactJourney` (404 si matchea) y en la API externa. Idealmente hacer el filtro consciente del rol.

**Archivos involucrados.** `contactsController.js`, `hiddenContactsFilter.js`, `external.routes.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

> Consolidación: SEC-005 y ACL-002 son la misma fuga vista por dos auditores; arreglar getById + búsqueda/global/reportes cierra el agujero.

---

## ACL-002 — Contactos ocultos se filtran en búsqueda, búsqueda global, getById y reportes (ALTO)

**Descripción.** El filtro de ocultos se aplica en lista de contactos, dashboard, analytics y `transactionsController`, pero NO en: `searchContacts`, `globalSearch`, `getContactById` y la lista de transacciones de reportes (LEFT JOIN contacts exponiendo nombre/email/teléfono).

**Evidencia.**
- `contactsController.js:2728-2808` (`searchContacts`): `WHERE searchClause` sin ocultos.
- `contactsController.js:2310-2389` (`getContactById`): sin filtro.
- `searchController.js:104-127` (`globalSearch`): sin ocultos.
- `reportsController.js:353-369`: LEFT JOIN expone PII sin filtro.
- Contraste: `contactsController.js:1978-2010` (`getContacts`) sí aplica `buildHiddenContactsCondition`.

**Por qué es problema real.** El admin oculta contactos para que no se vean; reaparecen al buscarlos, abrirlos por ID, usar el buscador global o ver reportes de pagos. Evitable, falsa sensación de privacidad.

**Cómo reproducir/verificar.** Crear filtro de oculto; `GET /api/contacts/search?q=<nombre>`, `/api/search/global?q=<nombre>` y la lista de transacciones de reportes lo devuelven.

**Impacto.** Fuga de PII de contactos ocultos a todos los usuarios de la instalación.

**Solución recomendada.** Aplicar `getHiddenContactFilters()+buildHiddenContactsCondition` en los cuatro caminos faltantes (404 en getById si matchea).

**Archivos involucrados.** `contactsController.js`, `searchController.js`, `reportsController.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## ACL-001 — Módulos sin requireModuleAccess en backend: acceso por API directa (ALTO)

**Descripción.** `requireModuleAccess` se aplica router por router. Routers que el frontend protege con `AccessRoute` solo tienen `requireAuth` en el backend: `tracking` (analytics), `config`, `products`, `attribution`, `contactTags`, `appointmentReminders`, y el chat (`getChatContacts`/`chatEvents` usan `requireModuleAccess('contacts')`, nunca `'chat'`). Un empleado con esos módulos en `none` es bloqueado solo en la UI; por API directa lee/escribe igual.

**Evidencia.**
- `tracking.routes.js:45-86`, `config.routes.js:7,14-29`, `contacts.routes.js:37,41`, `chatEvents.routes.js:8`, `userAccess.js:5-31`.

**Por qué es problema real.** El control de acceso por rol es el feature de seguridad multi-usuario; si la API no lo respeta, el rol es decorativo. Matiz: el gap de `chat` solo es explotable cuando el admin fija explícitamente `chat:'none'` con `contacts:'read'` — exactamente el caso que el control debería respetar.

**Cómo reproducir/verificar.** Login como employee sin `analytics`/`chat`; `GET /api/tracking/visitors` o `GET /api/contacts/chats` responde 200 en vez de 403.

**Impacto.** Escalada horizontal de privilegios dentro del cliente.

**Solución recomendada.** Agregar `requireModuleAccess('<modulo>')` al `router.use` de cada router citado y montar `requireModuleAccess('chat')` en los endpoints de chat en vez de `'contacts'`.

**Archivos involucrados.** routers `tracking`, `config`, `products`, `attribution`, `contactTags`, `appointmentReminders`, `contacts`, `chatEvents`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## MOB-002 — Push de chat exponen contactos ocultos (nombre + mensaje) (ALTO)

**Descripción.** `sendChatMessageNotification` arma el payload con `title`=nombre del contacto y `body`=texto del mensaje y lo envía vía `sendAppNotificationPayload`, cuyo único filtro es `resolvePushNotificationTargetForEvent` (all/admins/explícitos). No se consulta `hidden_contact_filters`.

**Evidencia.**
- `pushNotificationsService.js:1022-1054`, `notificationPreferencesService.js:105-140`, `hiddenContactsFilter.js:9-20`. `grep` confirma cero referencias a `hidden_contact` en los servicios de push.

**Por qué es problema real.** El producto promete ocultar contactos a los empleados; el push los re-expone con datos sensibles en la pantalla de bloqueo.

**Cómo reproducir/verificar.** Crear un `hidden_contact_filter` para un contacto, activar push de chat, hacer que ese contacto envíe un mensaje: llega push con nombre y texto.

**Impacto.** Fuga de datos privados de contactos ocultos al móvil.

**Solución recomendada.** Antes de enviar push de chat, verificar coincidencia con `hidden_contact_filters` y omitir/anonimizar.

**Archivos involucrados.** `pushNotificationsService.js`, `notificationPreferencesService.js`, `hiddenContactsFilter.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — anonimizar vs suprimir.

> Consolidación: NOTI-004 (web push) y MOB-002 (push de chat móvil) son el mismo defecto de la capa push; resolver el filtro de destinatarios cierra ambos.

---

## TRK-001 — /collect acepta sesiones falsas: inyección de tracking y reasignación de identidad (ALTO)

**Descripción.** `POST /collect` es público y solo valida presencia de `visitor_id/session_id/event_name/ts`. No valida origen, host, CORS (`cors()` abierto), firma ni que el par `(visitor_id, contact_id)` sea legítimo. Con `contact_id` en el body dispara `linkVisitorToContact` y `unifyVisitorIds`, que reescribe el `visitor_id` de TODAS las sesiones del contacto al "más viejo".

**Evidencia.**
- `trackingController.js:858-952` (`collectEvent`).
- `trackingService.js:946-1024` (`unifyVisitorIds`): `UPDATE sessions SET visitor_id=canonical WHERE contact_id=?`.
- `server.js:152` (`cors()` abierto). Matiz: **no** valida que `contact_id` exista, por lo que la inyección de sesiones/conversiones falsas no requiere ningún secreto. El cruce de identidades sí requiere un `contact_id` válido (UUIDv4 no enumerable).

**Por qué es problema real.** La integridad de toda la atribución (visitante→contacto→pago) depende de datos que cualquiera en internet puede falsificar sin auth.

**Cómo reproducir/verificar.** `curl -X POST https://<host>/collect` con `visitor_id` propio + `contact_id` existente; las sesiones del contacto adoptan el `visitor_id` del atacante.

**Impacto.** Datos de atribución y revenue por campaña corrompidos; posible cruce de identidades.

**Solución recomendada.** Restringir `/collect` a hosts/orígenes conocidos del tenant; ignorar `contact_id` arbitrario salvo canal confiable; no disparar `unifyVisitorIds` desde un endpoint público sin verificación; firmar el snippet o validar Referer/Origin.

**Archivos involucrados.** `trackingController.js`, `trackingService.js`, `server.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — definir el modelo de confianza del pixel.

---

## TRK-004 — Submit público de Sites sin rate limiting/honeypot/captcha (ALTO)

**Descripción.** `POST /api/sites/public/submit` crea contactos reales, inserta en `public_site_submissions`, dispara automatizaciones y envía eventos a Meta CAPI, sin control anti-abuso. `resolvePublicRequestAccess` solo verifica que el host esté conectado a un dominio público.

**Evidencia.**
- `sitesController.js:762-772`, montado antes de `requireAuth` (`sites.routes.js:50`).
- `sitesService.js:23457-23744` (`createSubmissionFromRequest`).
- `sitesService.js:11333-11360` (`resolvePublicRequestAccess`): solo valida host. `grep` confirma cero rate limiting/captcha/honeypot inbound.

**Por qué es problema real.** Es el formulario público de captación: sin protección, el CRM se llena de spam, se gasta cuota de CAPI y se disparan automatizaciones reales a datos basura.

**Cómo reproducir/verificar.** Repetir `POST /api/sites/public/submit` con responses válidas y `siteId` publicado; creación ilimitada de contactos.

**Impacto.** Spam masivo de contactos, costo en integraciones, automatizaciones con datos falsos.

**Solución recomendada.** Rate limiting por IP+site, honeypot field y/o captcha; throttle de creación de contactos y de envíos CAPI.

**Archivos involucrados.** `sitesController.js`, `sitesService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — elegir mecanismo.

---

## WA-004 — Webhook de atribución WhatsApp público sin firma sobreescribe atribución (ALTO)

**Descripción.** `handleWhatsAppAttributionWebhook` (`/webhook/whatsapp/attribution`) no tiene auth ni verificación de firma. Resuelve el contacto por teléfono y hace `UPDATE contacts SET attribution_ad_id/attribution_ctwa_clid/attribution_ad_name`, pisando valores existentes. Siempre responde 200 (oculta errores).

**Evidencia.**
- `webhooksController.js:1747-1855`, `webhooks.routes.js:33` (público), `webhooksController.js:1828-1831` (UPDATE que pisa).

**Por qué es problema real.** El endpoint es público por diseño (recibe de HighLevel) pero no valida ningún secreto y escribe sobre datos de negocio sensibles. Cualquiera que conozca/adivine un teléfono puede falsear atribución y contaminar reportes de ROI.

**Cómo reproducir/verificar.** POST sin firma a `/webhook/whatsapp/attribution` con el teléfono de un contacto y un `ad_id` arbitrario; su atribución cambia.

**Impacto.** Manipulación de la atribución de anuncios y de los reportes de campañas/ROI.

**Solución recomendada.** Exigir token/secreto compartido o firma; no sobreescribir atribución existente sin lógica de prioridad; devolver error real en vez de 200 silencioso.

**Archivos involucrados.** `webhooksController.js`, `webhooks.routes.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — coordinar el secreto compartido con HighLevel.

---

## PAY-002 — Reembolso parcial Stripe marca el pago como totalmente reembolsado (ALTO)

**Descripción.** El webhook `charge.refunded`/`refund.created` llama `markStripePaymentAsRefunded`, que pone `status='refunded'` completo sin comparar `refund.amount` vs `charge.amount`. Stripe dispara `charge.refunded` también en reembolsos parciales.

**Evidencia.**
- `stripePaymentService.js:2706-2746` (`markStripePaymentAsRefunded`).
- `stripePaymentService.js:2748-2762` (`updatePaymentFromRefundedCharge`/`updatePaymentFromRefund`): mismo helper; router envía `charge.refunded` (L4899) y `refund.created` (L4901).

**Por qué es problema real.** Un reembolso de $100 sobre $1000 hace que el sistema oculte los $1000 completos. Reportes de revenue y stats del contacto quedan mal.

**Cómo reproducir/verificar.** Refund parcial de un PaymentIntent pagado; el pago en Ristak pasa a `'refunded'` (no `'partially_refunded'`).

**Impacto.** Datos financieros incorrectos en transacciones, reportes y stats.

**Solución recomendada.** Comparar `amount_refunded` vs `charge.amount`: si es menor al total, aplicar `'partially_refunded'` (ya soportado en `LEDGER_PAYMENT_STATUSES`) y registrar el monto; solo `'refunded'` cuando es total.

**Archivos involucrados.** `stripePaymentService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## PAY2-001 / CRON-001 — Cobro doble Conekta: sin Idempotency-Key ni claim atómico (ALTO)

**Descripción.** `processDueConektaPaymentPlanCharges` hace `SELECT` de parcialidades `scheduled` y luego `UPDATE` a `processing` en pasos separados (no atómico). `chargeConektaPaymentRowWithSavedSource` → `createOrderForPayment` → `conektaApiRequest('/orders')` SIN header `Idempotency-Key`. El único candado es el flag `running` por-proceso. Dos ejecuciones concurrentes (solape de deploy, trigger manual `saved-card-payments`, o >1 instancia) pueden cobrar la misma parcialidad dos veces.

**Evidencia.**
- `conektaPaymentService.js:1899-2016` (SELECT + UPDATE separados).
- `conektaPaymentService.js:359-394` (sin `Idempotency-Key`; grep = 0).
- `conektaPaymentService.js:1485-1525` (guard solo `if row.status===paid`).
- `conektaPaymentPlans.cron.js:8-30` (candado solo in-process). Contraste Stripe: `stripePaymentService.js:2975` usa idempotencyKey estable.

**Por qué es problema real.** Es dinero real del cliente. Conekta soporta idempotency keys pero el código nunca las usa; cualquier solapamiento genera doble cobro irreversible (requiere reembolso manual).

**Cómo reproducir/verificar.** Dos invocaciones concurrentes de `processDueConektaPaymentPlanCharges` sobre la misma parcialidad (o el cron `startup` durante un deploy con instancia vieja+nueva).

**Impacto.** Doble cargo a tarjeta, disputas/contracargos, reembolsos manuales.

**Solución recomendada.** Claim atómico (`UPDATE ... SET status='processing' WHERE id=? AND status IN ('scheduled')` con `changes>0`) antes de cobrar, y enviar un `Idempotency-Key` estable (derivado de `installment_id`) en el POST `/orders`.

**Archivos involucrados.** `conektaPaymentService.js`, `conektaPaymentPlans.cron.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No. (Causa raíz transversal: CRON-009.)

---

## CNT-001 — Editar teléfono/email fusiona y BORRA otro contacto en silencio (ALTO)

**Descripción.** En `updateContact`, cuando el nuevo teléfono coincide con el de OTRO contacto, `prepareContactPhoneUpsert` ejecuta `mergeContactIds({fromId: matched.id, toId: id})` que termina en `DELETE FROM contacts WHERE id = fromId` (hard delete), sin confirmación ni aviso.

**Evidencia.**
- `contactIdentityService.js:430-449, 339-428` (borra `fromId` en L423).
- `contactsController.js:3237-3239` (`updateContact`: llama sin gate).
- `frontend/src/pages/Contacts/Contacts.tsx:1075-1106` (sin diálogo de merge).

**Por qué es problema real.** Un usuario corrigiendo un teléfono puede destruir otro registro de cliente. Es irreversible (no hay soft delete).

**Cómo reproducir/verificar.** Contacto A con tel X y contacto B sin él. Editar B y poner X. B absorbe a A y A se borra; nadie avisa.

**Impacto.** Pérdida silenciosa de contactos/registros; confusión total.

**Solución recomendada.** Antes de fusionar por edición, requerir confirmación explícita (o devolver 409 con opción de "fusionar") en lugar de fusionar+borrar automáticamente.

**Archivos involucrados.** `contactIdentityService.js`, `contactsController.js`, `Contacts.tsx`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — UX de merge (confirmar vs bloquear).

---

## CNT-002 — La fusión pierde tags, custom_fields, ghl_contact_id y WhatsApp preferido (ALTO)

**Descripción.** `mergeContactIds` copia con COALESCE solo phone, email, nombres, source, visitor_id, attribution_*, total_paid y purchases_count. NO incluye `tags`, `custom_fields`, `ghl_contact_id` ni `preferred_whatsapp_phone_number_id`. Estos son columnas de `contacts` (no tablas de referencia), así que al borrar el origen se pierden.

**Evidencia.**
- `contactIdentityService.js:372-410` (UPDATE no incluye tags/custom_fields). `getContactReferenceTables` (`database.js:393-428`) solo mueve tablas con `contact_id`.

**Por qué es problema real.** En cualquier merge se descartan datos capturados (segmentación por tags, datos médicos/CRM en custom fields).

**Cómo reproducir/verificar.** Fusionar dos contactos donde solo el absorbido tiene tags/custom_fields; tras el merge se pierden.

**Impacto.** Pérdida de etiquetas y campos personalizados; vínculo a HighLevel del absorbido se descarta.

**Solución recomendada.** En el UPDATE del merge, unir tags, mezclar custom_fields (`mergeContactCustomFields`) y conservar `ghl_contact_id`/`preferred_whatsapp_phone_number_id` según prioridad.

**Archivos involucrados.** `contactIdentityService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No (definir prioridad de campos en conflicto).

---

## APT-001 — Admin puede crear doble-booking: createAppointment no valida disponibilidad (ALTO)

**Descripción.** `POST /api/calendars/appointments` crea la cita vía `createLocalAppointment` sin comprobar slots libres, horario, bloqueos ni solapamiento. `getLocalFreeSlots/overlaps` existen pero solo se usan para slots públicos. En un calendario Ristak puro el límite de slot es 1 y el doble-booking pasa siempre, sin advertencia.

**Evidencia.**
- `calendarsController.js:1519-1571` (`createAppointment`).
- `localCalendarService.js:2817-2838` (`createLocalAppointment`: solo `end>start`).
- `localCalendarService.js:2976-3087` (lógica existe, no se invoca al crear desde admin).

**Por qué es problema real.** Una recepcionista puede agendar dos pacientes a la misma hora sin advertencia; el calendario se vuelve poco confiable.

**Cómo reproducir/verificar.** En un calendario Ristak con `appoinmentPerSlot=1`, crear dos citas con el mismo `startTime` vía el modal; ambas se guardan.

**Impacto.** Citas solapadas, sobreventa de horarios, mala experiencia.

**Solución recomendada.** Antes de `createLocalAppointment`, reusar `overlaps`/`getEffectiveSlotAppointmentLimit` para rechazar (409) si el slot ya alcanzó su límite.

**Archivos involucrados.** `calendarsController.js`, `localCalendarService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## APT-003 — Reprogramar una cita no reenvía el recordatorio (ALTO)

**Descripción.** El cron deduplica por `reminder_id|appointment_id` (la llave no incluye `start_time`). Al reprogramar (mismo id, nuevo `start_time`) no se borra ninguna fila, así que si ya existe un `send`, el recordatorio nunca se recalcula para la nueva fecha.

**Evidencia.**
- `appointmentRemindersService.js:577-596` (`alreadyHandled` por `reminder_id|appointment_id`).
- `localCalendarService.js:2891-2908` y `calendarsController.js:1640-1700`: reprograman sin tocar `appointment_reminder_sends`.

**Por qué es problema real.** El cliente reprograma y nunca recibe (o recibe a la hora vieja) el recordatorio, aumentando los no-shows.

**Cómo reproducir/verificar.** Crear cita, dejar que se registre un send, reprogramar a otra fecha futura; el nuevo recordatorio no se programa.

**Impacto.** Recordatorios incorrectos/ausentes tras reprogramar.

**Solución recomendada.** Al detectar cambio de `start_time`, borrar las filas de `appointment_reminder_sends` de esa cita (o incluir `start_time` en la llave de dedup).

**Archivos involucrados.** `appointmentRemindersService.js`, `localCalendarService.js`, `calendarsController.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## GCAL-002 — Sin cron de sync Google→local; citas con error nunca se reintentan (ALTO)

**Descripción.** No existe job de Google Calendar en `backend/src/jobs`. La dirección Google→local solo corre on-demand. Las citas con `google_sync_status='error'` no tienen reintento.

**Evidencia.**
- `backend/src/jobs` no incluye job de Google. `calendarsController.js:1340-1347` (inbound atado a free-slots). `googleCalendarService.js:776-785` (`markGoogleSyncError`: estado error sin reintentador).

**Por qué es problema real.** Una cita movida en Google no aparece hasta un sync manual; una cita Ristak que falló al subir queda desincronizada para siempre. No es sync bidireccional real, es pull manual.

**Cómo reproducir/verificar.** Crear/mover una cita directamente en Google; no aparece en Ristak hasta forzar sync.

**Impacto.** Agenda divergente; recordatorios/disponibilidad sobre datos obsoletos; doble-booking posible.

**Solución recomendada.** Cron periódico (10–15 min) que haga pull incremental con `syncToken` por calendario vinculado y reintente citas con `google_sync_status='error'`. Cuidar locking si hay múltiples instancias.

**Archivos involucrados.** `backend/src/jobs`, `calendarsController.js`, `googleCalendarService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## GCAL-003 — Sync entrante pisa ediciones locales sin comparar date_updated (ALTO)

**Descripción.** `syncGoogleEventsToLocal` llama `upsertLocalAppointment`, cuyo `ON CONFLICT(id) DO UPDATE` fija `start_time/end_time/title/notes` con COALESCE (solo evita nulls) y `date_updated = excluded.date_updated` incondicional. Si el push a Google falló o no corrió, el pull trae el evento viejo y pisa la edición fresca.

**Evidencia.**
- `localCalendarService.js:2752-2807` (ON CONFLICT). `googleCalendarService.js:610-631` (upsert incondicional). La clave de conflicto colisiona con la cita local (`googleEventToAppointment` usa `id = ristakAppointmentId`).

**Por qué es problema real.** En un sistema bidireccional sin reloj de conflicto, el último sync gana ciegamente. El usuario pierde cambios recién hechos.

**Cómo reproducir/verificar.** Editar cita en Ristak, fallar el push a Google, correr pull → la edición local se revierte.

**Impacto.** Reagendamientos/cambios de notas en Ristak se revierten a la versión de Google.

**Solución recomendada.** Comparar `event.updated` vs `date_updated` local y aplicar solo el más reciente; o no pisar campos de citas `source='ristak'` con `google_sync_status!='synced'`.

**Archivos involucrados.** `localCalendarService.js`, `googleCalendarService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## GHL-002 — Sync HL→local nunca borra entidades eliminadas en HighLevel (ALTO)

**Descripción.** `syncHighLevelContacts`, `syncHighLevelAppointments` e `invoicesSyncService` solo hacen upsert. No hay pasada de reconciliación que detecte entidades borradas en HL. Espejos locales quedan zombie. Para invoices solo se marca `'deleted'` si el payload paginado lo incluye (HL suele excluir borrados).

**Evidencia.**
- `highlevelSyncService.js:875-944` (`syncHighLevelContacts`), `1199-1245` (`syncHighLevelAppointments`), `invoicesSyncService.js:1080-1231` (`syncAllInvoices`): solo upsert.

**Por qué es problema real.** El usuario ve contactos/citas/pagos que ya no existen en su CRM real; las métricas (`total_paid`, `purchases_count`, conteos de leads) quedan infladas con datos zombie.

**Cómo reproducir/verificar.** Borrar un contacto/invoice en HL; tras el full sync sigue presente en Ristak.

**Impacto.** Datos divergentes; reportes y estadísticas incorrectos.

**Solución recomendada.** Tras cada full sync, marcar como soft-deleted (o eliminar) las entidades `ghl` cuyo `ghl_id` no apareció en el conjunto recién traído; o suscribir el webhook de delete de HL.

**Archivos involucrados.** `highlevelSyncService.js`, `invoicesSyncService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — soft-delete vs hard-delete del espejo.

---

## GHL-003 — Citas de HL pisan ediciones locales recientes (sin last-write-wins) (ALTO)

**Descripción.** `upsertLocalAppointment` escribe `date_updated = excluded.date_updated` incondicional y actualiza `start_time/end_time/status` sin comparar `dateUpdated` local vs remoto. Además `deleted_at = NULL` revive una cita borrada localmente. El pull horario de HL puede traer una versión más vieja y sobrescribir la edición local.

**Evidencia.**
- `localCalendarService.js:2761-2786` (ON CONFLICT). `highlevelSyncService.js:1212-1224` (upsert con `syncStatus 'synced'`).

**Por qué es problema real.** El cron resuelve siempre a favor de HL aunque HL esté desactualizado, perdiendo cambios del usuario. (Materialización depende del timing de propagación de HL.)

**Cómo reproducir/verificar.** Editar cita en Ristak; correr cron con datos viejos de HL; la edición se revierte.

**Impacto.** Pérdida silenciosa de ediciones de citas (hora, estado, notas).

**Solución recomendada.** Guard last-write-wins: actualizar solo si `excluded.date_updated > appointments.date_updated`; respetar `sync_status='pending'` y no pisarlo.

**Archivos involucrados.** `localCalendarService.js`, `highlevelSyncService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — política de conflicto.

---

## META-003 — El frontend nunca muestra estado/expiración del token de Meta (ALTO)

**Descripción.** El backend (`verifyToken`) calcula `valid/daysUntilExpiry/message`, pero `MetaAdsIntegration.tsx` nunca llama a `/api/meta/verify-token` ni renderiza ese estado. Cuando el token expira/revoca, el cron falla en silencio (`updateRecentAds` solo loguea) y la UI sigue mostrando datos viejos.

**Evidencia.**
- `metaController.js:2218-2266` (`verifyToken`). `MetaAdsIntegration.tsx` (sin fetch a `verify-token`). `metaAdsService.js:1021-1033` (`updateRecentAds`: solo loguea).

**Por qué es problema real.** El usuario no descubre que la integración dejó de sincronizar; ve datos congelados sin CTA para renovar.

**Cómo reproducir/verificar.** Invalidar el token en Meta; la UI de Ajustes → Meta no muestra ningún error.

**Impacto.** Pérdida silenciosa de sincronización; datos percibidos como "la app no jala".

**Solución recomendada.** Consumir `/api/meta/verify-token` en Ajustes y mostrar banner ("token válido / expira en N días / inválido — renueva aquí"); notificar cuando el cron detecte token inválido.

**Archivos involucrados.** `metaController.js`, `MetaAdsIntegration.tsx`, `metaAdsService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## LIC-001 — Módulos premium sin requireFeature: el plan se salta por API directa (ALTO)

**Descripción.** `server.js` aplica `requireFeature` solo a 8 routers. Otros módulos que el frontend trata como features de licencia (payments, sites, analytics, contacts, dashboard, forms, integrations, team_access, developers) se montan sin `requireFeature`; su única protección es `requireModuleAccess` (rol/`access_config`, NO licencia). Un cliente sin `payments` en su plan tiene la UI oculta pero `/api/transactions`, `/api/stripe`, `/api/subscriptions`, `/api/conekta` responden normal.

**Evidencia.**
- `server.js:219-256` (solo 8 mounts con `requireFeature`; `/api/transactions`(238), `/api/sites`(218), `/api/contacts`(236), `/api/dashboard`(234), `/api/attribution`(240), `/api/integrations`(239) sin él).
- `userAccessMiddleware.js:15-32` (solo rol/`access_config`).
- `accessControl.ts:222-247` (el frontend SÍ trata estos como features de licencia).

**Por qué es problema real.** El gating de plan es trivial de saltar con cualquier cliente HTTP autenticado; el negocio cobra por features que se sirven igual. (No es fuga cross-tenant: cada cliente tiene su propia DB.)

**Cómo reproducir/verificar.** Cliente cuyo plan no incluya `payments`: llamar `/api/transactions` directo → responde con datos.

**Impacto.** Pérdida de monetización; features premium fuera del plan contratado.

**Solución recomendada.** Añadir `requireFeature` a los routers de features cobradas, o un mapa central módulo→feature. Confirmar con producto qué es premium vs base.

**Archivos involucrados.** `server.js`, `userAccessMiddleware.js`, `accessControl.ts`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — definir el catálogo premium.

---

## WA-002 — Envío QR se reporta fallido sin ack en 20s, sin persistir (duplicados) (ALTO)

**Descripción.** `finalizeQrSendResponse` exige un `DELIVERY_ACK` dentro de `QR_SEND_ACK_TIMEOUT_MS=20000ms`. Si el destinatario está offline, Baileys ya entregó al servidor (`sendMessage` devolvió `key.id`) pero no llega ack en 20s → error 408. En el fallback, el throw ocurre ANTES de `upsertMessage`, así que el mensaje no se guarda. El usuario ve "falló", reenvía, y el cliente recibe duplicados al reconectar.

**Evidencia.**
- `whatsappQrService.js:780-799` (throw 408), `10` (timeout), `420-423` (`isConfirmedQrSendAck`: requiere delivered/read/played).
- `whatsappApiService.js:7199-7239` (`sendTextViaQrFallback`: upsertMessage solo tras éxito).

**Por qué es problema real.** Es habitual que el destinatario esté offline; WhatsApp entrega luego, pero Ristak ya lo declaró fallido y el operador reenvía.

**Cómo reproducir/verificar.** Enviar por QR a un número con el teléfono apagado; tras 20s → 408 sin persistir; reenviar → duplicado al reconectar.

**Impacto.** Mensajes duplicados al cliente final y percepción de que el QR no funciona.

**Solución recomendada.** Tratar `'sent'` (aceptado por el servidor con `key.id`) como éxito y persistir con status `'sent'`; dejar que los acks posteriores actualicen a delivered/read. No lanzar error solo por falta de ack de entrega.

**Archivos involucrados.** `whatsappQrService.js`, `whatsappApiService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — definir el criterio de "enviado" para QR.

---

## AUTO-002 — Disparadores del editor sin evento (comentarios FB/IG, ad-click, CTWA) (ALTO)

**Descripción.** El editor ofrece `trigger-facebook-comment`, `trigger-instagram-comment`, `trigger-click-to-whatsapp` y `trigger-facebook-ad-click`. `triggerMatches` no tiene case para esos eventos y ningún controlador los emite. Una automatización con esos disparadores nunca se ejecuta.

**Evidencia.**
- `nodeRegistry.tsx:1086,1157,1226,1278`. `automationEngine.js:1089-1198` (`triggerMatches`: sin case; `default return false`). `webhooksController.js`: los callers solo emiten pago/contact/appointment/webhook-received; las referencias a `ctwa` son solo atribución.

**Por qué es problema real.** El usuario elige un disparador legítimo del catálogo y la automatización queda muerta sin aviso.

**Cómo reproducir/verificar.** Crear una automatización con disparador "Comentó en mi anuncio de Facebook"; nunca corre.

**Impacto.** Automatizaciones completas que nunca se ejecutan; leads perdidos.

**Solución recomendada.** Cablear los eventos reales hacia `handleAutomationEvent` con su case en `triggerMatches`, o retirar/marcar como "próximamente" y bloquear su publicación.

**Archivos involucrados.** `nodeRegistry.tsx`, `automationEngine.js`, `webhooksController.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## AUTO-001 — El editor publica nodos que el motor no ejecuta: cortan el flujo (ALTO)

**Descripción.** `executeNode` solo maneja una lista cerrada de tipos. El editor ofrece además `channel-messenger`, `channel-instagram`, `action-update-contact-field`, `action-delete-contact`, `randomizer`, `logic-actions-group`, `ai-step`, `ai-gpt-openai`, `data-*`, `action-appointment-upsert`. Todos caen en `default` (`{skipped:true, handle:'out'}`). Para nodos ramificados (randomizer usa handles `a`/`b`) el motor pide la arista por `out`, no existe, y `runFrom` marca `'completed'`: todo lo posterior nunca corre. `validateFlowForPublish` no lo rechaza.

**Evidencia.**
- `automationEngine.js:2659-2839` (switch + default), `2903-2908` (`runFrom` → `'completed'`).
- `nodeRegistry.tsx:1495-2955` (tipos sin ejecutor), `automationFlowValidation.js:178-295` (no valida ejecutabilidad).

**Por qué es problema real.** Acciones que el cliente cree configuradas (Instagram/Messenger, A/B testing, IA, actualizar/eliminar contacto) nunca se ejecutan; pasos posteriores a un nodo ramificado no soportado se pierden sin error.

**Cómo reproducir/verificar.** Publicar: Disparador → Aleatorizador(50/50) → WhatsApp en cada rama. Inscribir un contacto: el log muestra el aleatorizador como `skipped` y el enrollment `completed` sin enviar WhatsApp.

**Impacto.** Flujos rotos en silencio; expectativa de producto incumplida.

**Solución recomendada.** En `validateFlowForPublish`, rechazar (o marcar `requires_review`) cualquier `node.type` fuera de una allowlist de tipos soportados; o implementar los ejecutores. Como mínimo, para nodos ramificados no soportados, no terminar el flujo.

**Archivos involucrados.** `automationEngine.js`, `nodeRegistry.tsx`, `automationFlowValidation.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No (decidir qué nodos se implementan vs se retiran del editor).

---

## MOB-003 — /phone/login no re-resuelve tenant: correo de otra empresa falla sin explicación (ALTO)

**Descripción.** En `/phone/login`, `handleSubmit` llama `login()` de `AuthContext`, que hace `POST apiUrl('/api/auth/login')` contra la `baseUrl` runtime ya fijada. No re-ejecuta `loginWithPortal`/`resolveAndStoreMobileTenant`. Solo `/phone/tenant` re-resuelve por portal. Con un tenant ya guardado, un correo de otro tenant se autentica contra el backend equivocado y recibe "usuario o contraseña incorrectos".

**Evidencia.**
- `Login.tsx:76-101` (`handleSubmit`: usa `login()` sin re-resolver). `AuthContext.tsx:177-207` (`login`). `mobileTenantService.ts:67-99` (`loginWithPortal`: única ruta que re-resuelve, en `/phone/tenant`).

**Por qué es problema real.** El correo es la fuente de verdad del enrutamiento, pero el login normal asume el tenant cacheado. El gate iOS manda `/login → /phone/login`, no `/phone/tenant`.

**Cómo reproducir/verificar.** Resolver tenant A, cerrar sesión (queda `baseUrl` A), abrir `/phone/login` y escribir credenciales válidas del tenant B: falla con credenciales incorrectas.

**Impacto.** Empleados/dueños de otra instalación no pueden entrar desde un dispositivo que ya tocó otro tenant, salvo que descubran "Cambiar empresa".

**Solución recomendada.** Que el login móvil siempre re-resuelva el tenant por correo (usar `loginWithPortal` en `/phone/login`), o detectar 401 y ofrecer re-resolver automáticamente.

**Archivos involucrados.** `Login.tsx`, `AuthContext.tsx`, `mobileTenantService.ts`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## AI-002 — Runtime del agente conversacional no valida feature conversational_ai (ALTO)

**Descripción.** El gating `requireFeature('conversational_ai')` está solo en el montaje de rutas HTTP (UI de configuración). La ejecución real del responder se dispara desde los servicios de mensajería (WhatsApp/Meta/HighLevel) que importan el runner y llaman `handleInbound*` SIN verificación de feature. Además `ensureConversationalAgentRuntimeEnabledForPublishedAgents` re-habilita el runtime si hay agentes publicados.

**Evidencia.**
- `whatsappApiService.js:4881-4891` (import dinámico sin `requireFeature`). `runner.js:1422-1428, 1739-1749` (solo revisa `config.enabled`). `grep` en `agents/` y `conversationalAgentService.js` no arroja `requireFeature`/`conversational_ai`.

**Por qué es problema real.** Si a un cliente se le quita `conversational_ai` (downgrade, impago), el agente sigue respondiendo a los clientes finales y consumiendo su API key.

**Cómo reproducir/verificar.** Publicar un agente, revocar `conversational_ai`, enviar un mensaje entrante: el agente responde igual.

**Impacto.** Uso de feature premium sin entitlement; gasto de tokens; comportamiento no controlable por licencia.

**Solución recomendada.** Verificar `featureAccess('conversational_ai')` al inicio de `handleInboundConversationalMessage` y de la recovery; si no hay feature, no responder.

**Archivos involucrados.** `runner.js`, `conversationalAgentService.js`, servicios de mensajería.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí. **Confianza: Req. verif. manual** — confirmar que el downgrade no apaga el runtime por otra vía (desactivando `config.enabled` o cortando la API key en provisioning).

---

## AI-004 — create_payment_link del agente no es idempotente: links/cobros duplicados (ALTO)

**Descripción.** El tool `create_payment_link` valida `confirm` y depósito, pero llama `createSinglePaymentLink` sin clave de idempotencia ni verificación de un link reciente equivalente. A diferencia de `book_appointment` (que sí consulta cita existente), no hay guard. Combinado con AI-001 o una re-llamada del modelo dentro del run, se generan dos invoices/links.

**Evidencia.**
- `tools.js:645-704` (sin idempotencia). `paymentFlowService.js:916-964` (`createSinglePaymentLink`: crea invoice nuevo incondicionalmente). `tools.js:474-499` (`bookAppointmentTool`: contraste con guard).

**Por qué es problema real.** El cliente puede recibir dos links por el mismo concepto y, si paga ambos, doble cobro; o invoices duplicados en contabilidad.

**Cómo reproducir/verificar.** Provocar reejecución (race multi-instancia o re-llamada del tool) tras confirmación: `createSinglePaymentLink` se invoca dos veces.

**Impacto.** Cobros/links duplicados al cliente.

**Solución recomendada.** Antes de crear, buscar un invoice/link pendiente reciente del mismo contacto con monto+concepto equivalentes; o pasar una `idempotencyKey` derivada de `contactId+messageId`.

**Archivos involucrados.** `tools.js`, `paymentFlowService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## NOTI-002 / CRON-003 — Recordatorios duplicados: registro anti-duplicado tras el envío (ALTO)

**Descripción.** `processDueAppointmentReminders` carga un `Set alreadyHandled`, envía el WhatsApp y recién entonces hace el INSERT (`recordSend`). El `UNIQUE(reminder_id,appointment_id)` solo evita la fila de log duplicada; el envío ya ocurrió antes del INSERT. Con dos procesos, ambos cargan el mismo Set, ambos envían, y uno falla el INSERT — pero el cliente ya recibió el mensaje dos veces.

**Evidencia.**
- `appointmentRemindersService.js:577-578,596,604-669` (Set en memoria; envío en 618/638; `recordSend` INSERT en 664 tras el envío). `database.js:5038-5052` (UNIQUE protege el log). Contraste: `scheduledChatMessagesService.js:271-284` (`claimScheduledMessage`).

**Por qué es problema real.** Recibir dos veces el mismo recordatorio se ve como spam, daña la calidad del número y consume cuota de plantillas.

**Cómo reproducir/verificar.** Dos procesos contra la misma DB; cita con `sendAt` vencido; ambos crons mandan el WhatsApp antes de insertar.

**Impacto.** Doble mensaje al cliente final.

**Solución recomendada.** Reclamar antes de enviar: `INSERT 'sending' ON CONFLICT DO NOTHING` (o UPDATE condicional) y solo enviar si `changes>0`; marcar `'sent'` después.

**Archivos involucrados.** `appointmentRemindersService.js`, `appointmentReminders.cron.js`, `database.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## NOTI-003 — Confirmación por respuesta solo en WhatsApp API; HL/Meta no confirman (ALTO)

**Descripción.** `handleInboundForConfirmation`/`maybeConfirmAppointmentFromReply` solo se invocan desde el inbound de `whatsappApiService`. Los inbound de HighLevel y Meta social solo disparan `sendChatMessageNotification`. Si el recordatorio salió y el contacto responde por SMS/Messenger/Instagram/WhatsApp-de-GHL, la ventana de confirmación nunca se abre.

**Evidencia.**
- `whatsappApiService.js:4843-4861` (único punto que llama a la lógica). `grep` confirma que HL (528,629,748) y Meta (594) solo notifican.

**Por qué es problema real.** Muchos clientes operan por HighLevel; el mensaje sale por un canal y la respuesta llega por otro. Si el recordatorio tiene `no_confirm_action='cancel_appointment'`, la cita se cancela injustamente (ver NOTI-001).

**Cómo reproducir/verificar.** Enviar confirmación; el contacto responde por un canal sincronizado vía HighLevel; no se crea fila en `appointment_confirmation_windows`.

**Impacto.** Citas confirmadas quedan como no confirmadas; con cancelación automática, se cancelan injustamente.

**Solución recomendada.** Invocar `handleInboundForConfirmation`/`maybeConfirmAppointmentFromReply` también en los handlers inbound de `highlevelConversationsSyncService` y `metaSocialMessagingService` (o centralizar el procesamiento de inbound).

**Archivos involucrados.** `whatsappApiService.js`, `highlevelConversationsSyncService.js`, `metaSocialMessagingService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## RPT-001 — Costos fijos del dashboard no se prorratean ni filtran por fecha (ALTO)

**Descripción.** `computeFinancialSnapshot` itera `SELECT * FROM costs WHERE is_active=1` y para `fixed` suma `cost.value` completo, sin prorrateo ni filtro por fecha. La pantalla de Costos afirma que cada costo es "mensual fijo" y que "en reportes de días o años el valor se prorratea automáticamente". El prorrateo real solo existe para `report_manual_business_expenses`.

**Evidencia.**
- `dashboardController.js:204-227` (`computeFinancialSnapshot`). `Costs.tsx:432-454` (promete prorrateo). `manualBusinessExpensesService.js:158-193` (prorrateo real solo aquí).

**Por qué es problema real.** La ganancia neta es incorrecta para cualquier rango distinto de "exactamente un mes": rango de 1 día resta la renta mensual completa; 1 año resta solo 1 mes. Contradice la UI.

**Cómo reproducir/verificar.** Crear un costo fijo (renta mensual); ver dashboard con rango de 1 día → ganancia neta absurdamente negativa.

**Impacto.** Ganancia neta engañosa; decisiones de negocio sobre datos falsos.

**Solución recomendada.** Prorratear los costos fijos por la longitud del rango (como `manualBusinessExpenses`) o documentar que solo aplican a vista mensual. Unificar ambas lógicas.

**Archivos involucrados.** `dashboardController.js`, `Costs.tsx`, `manualBusinessExpensesService.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No (definir fórmula de prorrateo con producto).

---

## DB-002 — Migraciones de datos destructivas en CADA boot sin advisory lock (ALTO)

**Descripción.** En `initTables` corren incondicionalmente `reconcileCanonicalContactPhones` (borra contactos duplicados y re-apunta FKs), `migrateLegacyContactTagsToCatalog`, `migrateTagIdsToSlugs`, `cleanupReservedSystemContactTags`, `backfillGhlContactIds`, `migrateWhatsAppContactIdsToRistak`. Sin `pg_advisory_lock` ni gating por versión.

**Evidencia.**
- `database.js:5058-5104` (bloque de migraciones), `496-558` (`reconcileCanonicalContactPhones` con UPDATE/DELETE).

**Por qué es problema real.** Si Render escala a 2+ instancias o hay solape old/new en un deploy, dos procesos ejecutan la fusión de contactos en paralelo: lost updates, filas borradas aún referenciadas, o colisión de `UNIQUE(contacts.phone)`. Además full-table scans en cada restart.

**Cómo reproducir/verificar.** Arrancar dos instancias contra la misma BD con contactos que comparten teléfono canónico; observar errores de UNIQUE/foreign.

**Impacto.** Corrupción/pérdida de contactos y referencias; comportamiento no determinista; coste de scans.

**Solución recomendada.** Envolver las migraciones de datos en `pg_advisory_lock` (un proceso a la vez) y/o gatearlas por versión. Idealmente sacarlas del path de arranque del web a un job dedicado.

**Archivos involucrados.** `database.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — junto con DB-001.

---

## DB-003 — FK payments.contact_id ON DELETE CASCADE: borrar contacto borra pagos (ALTO)

**Descripción.** El CREATE de `payments` mantiene `FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE`. `payment_plans` y `subscriptions` usan `ON DELETE SET NULL`. Inconsistencia: borrar un contacto destruye sus pagos pero deja los planes huérfanos.

**Evidencia.**
- `database.js:2241-2268` (FK CASCADE), `2368` (`payment_plans` SET NULL). `deleteContact` (`contactsController.js:3670`) hace `DELETE FROM contacts WHERE id=?` sin re-apuntar payments ni guard. **Matiz (ajustado):** la fusión de duplicados NO pierde pagos — `updateContactReferences` re-apunta `contact_id` al winner antes del DELETE. El riesgo es el **borrado manual**, no el merge.

**Por qué es problema real.** Los pagos son datos financieros/de auditoría. Un borrado manual elimina transacciones reales, alterando KPIs de ingresos.

**Cómo reproducir/verificar.** Crear contacto con pagos pagados, borrarlo; las filas de payments desaparecen (cascade).

**Impacto.** Pérdida irreversible de historial financiero; KPIs de revenue cambian al borrar contactos.

**Solución recomendada.** Cambiar `payments.contact_id` a `ON DELETE SET NULL` (consistente con planes/subscriptions) o impedir el borrado de contactos con pagos. Decidir política de retención financiera.

**Archivos involucrados.** `database.js`, `contactsController.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí — definir retención.

---

## DB-005 — SQLite vs Postgres: parámetros con tipo ambiguo crashean solo en prod (ALTO)

**Descripción.** Patrón recurrente donde un `?` sin ancla de tipo (`? IS NULL OR ...`, `CASE WHEN ? THEN`, `CASE WHEN ?=?`) funciona en SQLite pero Postgres lanza `could not determine data type of parameter $N`. El commit `5fbf9d159` parchó 5 sitios con `CAST(? AS TEXT)`, pero quedan otros (ej. `sitesService.js:10363-10365` `render_domain_verified = CASE WHEN ? THEN 0 ELSE ...` con valor entero 1/0).

**Evidencia.**
- `sitesService.js:10363-10365,10387-10389` (`updateSite`). `paymentFlowService.js:2453-2460` (fix ya aplicado con `CAST(? AS TEXT)`).

**Por qué es problema real.** No se detectan en dev (SQLite) y solo explotan en prod (Postgres) al ejercer la rama (aquí: actualizar un sitio con dominio cambiado). Clase sistémica.

**Cómo reproducir/verificar.** En Postgres, ejecutar `updateSite` cambiando el dominio: `CASE WHEN $N THEN 0` con `$N` entero → error de tipo/boolean.

**Impacto.** Errores 500 en flujos específicos solo en producción, difíciles de reproducir localmente.

**Solución recomendada.** Auditar todos los UPDATE/SELECT con `?` en posiciones tipo-ambiguas; usar CAST explícito y bindear booleanos reales para `CASE WHEN`. Correr la suite contra Postgres en CI (ver PAY-006).

**Archivos involucrados.** `sitesService.js`, `paymentFlowService.js`, y demás queries crudas.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## INST-001 — Instalación fallida deja Postgres y web service huérfanos en Render (ALTO)

**Descripción.** En `runInstallation`, tras crear Postgres y web service sus IDs se guardan, pero si un paso posterior falla, el catch solo hace `updateInstallation(status='failed')` + `logEvent`. Nunca llama `deleteService`/`deletePostgres`. Los recursos quedan creados y cobrando. El botón "Intentar de nuevo" crea una instalación nueva; el chequeo de duplicados solo bloquea estados en progreso, no `failed`.

**Evidencia.**
- `installer.service.js:226-232,293-311,390-395` (catch sin teardown), `162-171` (duplicados no cuentan `failed`). `Install.tsx:237-242` (botón reenvía formulario).

**Por qué es problema real.** Render cobra por Postgres y web services activos; una instalación que falla a media deja recursos vivos que nadie limpia.

**Cómo reproducir/verificar.** Forzar fallo tras crear el web service; la Postgres y el servicio quedan vivos en Render.

**Impacto.** Cobros sorpresa al cliente y basura difícil de rastrear.

**Solución recomendada.** En el catch, si hay `render_database_id`/`render_service_id` y `apiKey`, intentar `deleteService`/`deletePostgres` (best-effort); o al reintentar, limpiar los recursos del intento previo.

**Archivos involucrados.** `installer.service.js`, `Install.tsx`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** No.

---

## INST-004 — Llave de cifrado derivada de JWT_SECRET: rotarlo inutiliza updates/cancelación (ALTO)

**Descripción.** `getMasterSecret` usa `INSTALLER_ENCRYPTION_KEY` si existe; si no, deriva la llave de `'installer-master:'+JWT_SECRET`. Las Render API Keys se cifran con esta llave. Si `JWT_SECRET` cambia, `decryptSecret` falla y se pierde el acceso a la API key de TODAS las instalaciones sin `deploy_hook_url`.

**Evidencia.**
- `crypto.js:39-61` (fallback). `installer.service.js:209-221` (cifra al validar). `update.service.js:42-52` (`decrypt_failed` deja sin update).

**Por qué es problema real.** El secreto del que depende todo el control remoto puede cambiar por una operación rutinaria de infra, sin alerta. (Confianza: probable — depende de que se rote `JWT_SECRET` del portal en runtime.)

**Cómo reproducir/verificar.** Rotar/regenerar `JWT_SECRET` del portal sin `INSTALLER_ENCRYPTION_KEY` fijo; los updates/cancelación dejan de descifrar la API key.

**Impacto.** Pérdida masiva de capacidad de update y cancelación; apps de clientes sin poder actualizarse desde el portal.

**Solución recomendada.** Exigir `INSTALLER_ENCRYPTION_KEY` dedicada y persistente (fallar el arranque o avisar si falta); documentar que rotar `JWT_SECRET` sin migrar secretos rompe el descifrado. Guardar la versión de llave por registro.

**Archivos involucrados.** `crypto.js`, `installer.service.js`, `update.service.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí.

---

## PORTAL-001 — El demo opera sobre conexiones reales de WhatsApp y Meta Ads (ALTO)

**Descripción.** `demo.routes.js` monta endpoints que llaman a los servicios GLOBALES `metaAds.*` y `whatsapp.*` (los mismos del admin), no a un sandbox. Un `demo_user` puede enviar mensajes de WhatsApp reales, crear/borrar plantillas reales, enviar template-messages y conversion-events, y cambiar la selección de Meta Ads de producción.

**Evidencia.**
- `demo.routes.js:333-340` (whatsapp/messages → `whatsapp.sendTextMessage`), `215-226` (meta-ads/select → `metaAds.saveSelection`), `308-331` (templates create/delete). El header dice "acceso aislado" pero solo aísla la auth, no los datos.

**Por qué es problema real.** Cualquier revisor con acceso de demo (creado para Meta App Review/terceros) puede mandar mensajes reales desde el número de WhatsApp Business conectado y alterar la config de anuncios en vivo. No es un sandbox.

**Cómo reproducir/verificar.** Login como `demo_user`; `POST /api/demo/integrations/whatsapp/messages` envía un mensaje real.

**Impacto.** Mensajes WhatsApp reales a terceros, plantillas borradas en Meta, selección de ad account/page/pixel cambiada en producción.

**Solución recomendada.** Aislar el demo: tenant/conexión de prueba dedicada o forzar respuestas mock/read-only en todos los endpoints de escritura (403 en POST/DELETE de WhatsApp/templates/messages/select).

**Archivos involucrados.** `demo.routes.js`, `whatsapp.service.js`, `metaAds.service.js`.

**Esfuerzo.** Medio. **¿Decisión del dueño?** Sí.

---

## NOTI-004 — Web push se envía a TODAS las suscripciones sin respetar rol/ocultos (ALTO)

**Descripción.** En `sendAppNotificationPayload`, cuando no se pasa `userIds`, `getEnabledSubscriptions()` devuelve todas las `push_subscriptions` habilitadas. El payload de chat incluye nombre del contacto y extracto del mensaje. No se consulta `hidden_contact_filters`. Un empleado con acceso restringido recibe el contenido de conversaciones que no debería ver.

**Evidencia.**
- `pushNotificationsService.js:639-648,888-913` y `1022-1054` (`sendChatMessageNotification`).
- `notificationPreferencesService.js:105-140`: resuelve por opt-in (`all`/`admins`/explícitos), nunca por visibilidad de contacto.

**Por qué es problema real.** El modelo de roles restringe qué contactos ve cada empleado, pero ese filtro no se aplica en la capa push; el contenido sensible (posiblemente médico) viaja en la notificación.

**Cómo reproducir/verificar.** Empleado con visibilidad limitada y suscripción push activa; entra un mensaje de un contacto oculto; con `conversations` en `all`/sin matriz, llega push con el texto.

**Impacto.** Fuga de nombre + mensaje entre usuarios de la misma instalación.

**Solución recomendada.** Aplicar el filtro de visibilidad de contactos/roles (hidden-contacts + phone-access) al resolver destinatarios push y no enviar contenido del mensaje a usuarios sin acceso a ese contacto.

**Archivos involucrados.** `pushNotificationsService.js`, `notificationPreferencesService.js`.

**Esfuerzo.** Alto. **¿Decisión del dueño?** No.

---

## WA-003 — Watchdog QR sin lock entre réplicas: sockets Baileys en bucle de reemplazo (ALTO)

**Descripción.** `resumeWhatsAppQrSessions` lee las sesiones QR habilitadas de la DB compartida y abre un socket Baileys por cada una, comprobando solo `liveSessions` (Map en memoria). Con varias réplicas, cada una abre el mismo número con las mismas credenciales → WhatsApp dispara `connectionReplaced` (440), que cae a reconexión con backoff, generando una guerra de reemplazos. El estado del drip anti-bloqueo también es por-proceso.

**Evidencia.**
- `whatsappQrService.js:2081-2117` (solo `liveSessions`), `850-870` (reconecta tras `connectionReplaced`). `whatsappQrWatchdog.cron.js:37-42` (`setInterval` por proceso sin lock). `whatsappQrDripService.js:18-19,109-113` (estado en memoria).

**Por qué es problema real.** El cron arranca dentro del proceso web y Render puede escalar a >1 instancia; no hay lock que garantice un único dueño de la sesión QR. (Materialización depende de >1 réplica.)

**Cómo reproducir/verificar.** Correr 2+ instancias contra la misma sesión QR; observar flapping de conexión.

**Impacto.** Sesión QR inestable, mensajes no enviados o duplicados, mayor riesgo de bloqueo del número.

**Solución recomendada.** Lock distribuido (fila de propietario con TTL en DB) para que solo una instancia mantenga cada sesión QR y ejecute el watchdog; o forzar el módulo QR a una sola instancia. Mover el estado del drip a DB.

**Archivos involucrados.** `whatsappQrService.js`, `whatsappQrWatchdog.cron.js`, `whatsappQrDripService.js`.

**Esfuerzo.** Alto. **¿Decisión del dueño?** Sí — estrategia de single-owner.

---

## AI-001 / CRON-007 — Doble respuesta/acción del agente conversacional (dedup en memoria) (ALTO)

**Descripción.** La protección contra ejecuciones concurrentes del mismo contacto es un `Set` en memoria (`runningContacts`) + un claim no atómico de `last_inbound_message_id` (read-then-write, no compare-and-set). En 2+ instancias/réplicas (o reenvío de webhook duplicado), dos instancias pueden responder/actuar dos veces. El ledger solo audita. La recovery de pendientes al boot amplifica el riesgo en solapes de deploy.

**Evidencia.**
- `runner.js:77-79, 1432-1441, 1479-1486`. `agentExecutionLedgerService.js:85-117` (run nuevo siempre, sin clave por messageId). `runner.js:1739-1797` (recovery).

**Por qué es problema real.** El cliente recibe respuestas duplicadas; peor, `create_payment_link` (AI-004) puede crear 2 links/cobros.

**Cómo reproducir/verificar.** Desplegar con >1 instancia (o reenvío de webhook), enviar un mensaje entrante; ambas instancias disparan `handleInboundConversationalMessage` para el mismo messageId.

**Impacto.** Duplicación de mensajes y acciones de negocio (links de pago, señales a humano).

**Solución recomendada.** Claim atómico compare-and-set en DB (`UPDATE conversational_agent_state SET last_inbound_message_id=? WHERE id=? AND (last_inbound_message_id IS NULL OR last_inbound_message_id<>?)`, proceder solo si `rowCount>0`), o advisory lock por contacto+canal. Añadir idempotencia a `create_payment_link` (AI-004).

**Archivos involucrados.** `runner.js`, `conversationalAgentService.js`.

**Esfuerzo.** Alto. **¿Decisión del dueño?** No.

---

## APT-004 — Bloqueo de horarios solo con HighLevel; Ristak/Google sin bloqueos (ALTO)

**Descripción.** `getBlockedSlots` devuelve `[]` si no hay `locationId+accessToken` de GHL, y `create/update/deleteBlockedSlot` exigen accessToken. No existe almacenamiento ni lógica local de blocked slots. En instalaciones sin GHL, bloquear un horario no tiene efecto y `getLocalFreeSlots` no lee ningún bloqueo.

**Evidencia.**
- `calendarsController.js:1396-1408` (`getBlockedSlots`), `1451-1469` (`createBlockedSlot`). `localCalendarService.js:3017-3087` (`getLocalFreeSlots`: solo descuenta citas). No existe tabla `blocked_slot`.

**Por qué es problema real.** Un negocio sin HighLevel bloquea sus vacaciones/horario de comida y la app sigue ofreciendo y aceptando esos horarios.

**Cómo reproducir/verificar.** En instalación sin GHL, crear un blocked slot (400 por falta de token) o abrir la vista de bloqueos (lista vacía); agendar en ese horario igual.

**Impacto.** Citas en horarios que el usuario creía bloqueados; agenda inválida solo-Ristak.

**Solución recomendada.** Implementar blocked slots locales (tabla propia) que `getLocalFreeSlots` respete como conflicto; usar GHL solo como espejo opcional.

**Archivos involucrados.** `calendarsController.js`, `localCalendarService.js`.

**Esfuerzo.** Alto. **¿Decisión del dueño?** Sí — confirmar que se quiere soportar bloqueos sin GHL.

---

## META-002 — Campaign Builder nunca crea campañas reales en Meta (ALTO)

**Descripción.** `executeMetaCampaignDraft`, tras validar y confirmar, siempre termina en `'mcp_not_connected'` (sin env MCP) o `'adapter_missing'` (con env presentes). No hay ninguna ruta de código que llame a `create_campaign`/`create_ad_set`/`create_ad` reales.

**Evidencia.**
- `metaCampaignBuilderService.js:949-1008` (solo dos salidas de no-ejecución).

**Por qué es problema real.** Es una función de producto expuesta (`/campaign-builder/*`) que promete crear campañas y nunca produce una en Meta.

**Cómo reproducir/verificar.** `POST /api/meta/campaign-builder/drafts` → `/preview` → `/execute` con `confirmation=true`: respuesta `mcp_not_connected`/`adapter_missing`.

**Impacto.** Funcionalidad anunciada inoperante.

**Solución recomendada.** Implementar el adaptador MCP/Graph real, o esconder/marcar la función como "preview-only / beta" en producto y UI hasta que exista ejecución.

**Archivos involucrados.** `metaCampaignBuilderService.js`.

**Esfuerzo.** Alto. **¿Decisión del dueño?** No (decidir implementar vs ocultar).

---

## DB-001 — Sin runner de migraciones versionado: los .sql nunca corren en boot (ALTO)

**Descripción.** `server.js` solo hace `await databaseReady` (= `initTables()`). No existe código que lea `backend/migrations/*.sql` ni una tabla `schema_migrations`. Los `.sql` (`remove_payments_fk`, `convert_to_timestamptz*`, `cleanup_duplicate_payments`) son scripts manuales que dependen de ejecución a mano.

**Evidencia.**
- `server.js:7,296`, `database.js:5408` (`databaseReady = initTables()`). `grep` de `schema_migrations`/`readdir(migrations)` = vacío. El FK CASCADE de payments sigue en el CREATE (prueba de que `remove_payments_fk.sql` nunca se aplicó).

**Por qué es problema real.** Cada cliente tiene su propia BD provisionada por el Installer, que tampoco corre estos `.sql`. Un cambio de esquema que requiera ALTER de tipos jamás llega a producción de forma confiable; el estado real diverge por cliente.

**Cómo reproducir/verificar.** Provisionar un cliente nuevo y verificar con `\d` en Postgres: columnas de fecha `timestamp without time zone` y payments aún con el FK.

**Impacto.** Esquema inconsistente entre clientes; correcciones no se propagan; alto riesgo operativo en cada cambio de modelo.

**Solución recomendada.** Introducir un runner idempotente con tabla `schema_migrations(version, applied_at)` que ejecute en orden los `.sql` pendientes en transacción y registre lo aplicado, invocado tras `initTables`. Mover las migraciones de datos del boot a ese runner con gating por versión.

**Archivos involucrados.** `server.js`, `database.js`, `backend/migrations/*`.

**Esfuerzo.** Alto. **¿Decisión del dueño?** Sí — adoptar herramienta/estrategia de migraciones.

---

## DB-004 — timestamptz nunca se aplica: clientes nuevos con timestamps sin zona (ALTO)

**Descripción.** `database.js` no usa `timestamptz` (0 ocurrencias); el adaptador Postgres reescribe `DATETIME→TIMESTAMP (without time zone)`. La conversión a `timestamptz` vive solo en `convert_to_timestamptz*.sql`, scripts manuales sin runner (DB-001). El Installer no ejecuta SQL de migración del app.

**Evidencia.**
- `database.js:214,230` (`DATETIME→TIMESTAMP`), `convert_to_timestamptz_v2.sql:1-90` (manual).

**Por qué es problema real.** El código de reportes asume timestamps timezone-aware; en clientes provisionados después de la era manual las columnas son timezone-naive, y filtros/agrupaciones por día/mes se desfasan según la zona del servidor vs UTC.

**Cómo reproducir/verificar.** Provisionar cliente nuevo, insertar datos cerca de medianoche, comparar agrupación por día vs un cliente migrado a mano.

**Impacto.** Desfase de horas en métricas por fecha (citas, pagos, leads) en clientes nuevos; inconsistencia entre clientes.

**Solución recomendada.** Definir las columnas de fecha como `TIMESTAMPTZ` en el esquema (o aplicar la conversión vía el runner de DB-001 en cada cliente). Asegurar que el Installer la ejecute al provisionar.

**Archivos involucrados.** `database.js`, `convert_to_timestamptz_v2.sql`.

**Esfuerzo.** Alto. **¿Decisión del dueño?** Sí. **Confianza: Req. verif. manual** — el impacto real depende de si `initTimezone.js` fuerza UTC en proceso y servidor (lo que neutralizaría gran parte del skew) y de cómo agrupan los reportes; verificar antes de priorizar como alto.

---

## INST-003 — Auto-update masivo de Test en cada push sin canary ni rollback (ALTO)

**Descripción.** Cada push a main reportado al webhook redespliega de inmediato TODAS las apps del canal Test. No hay despliegue progresivo, ni health check a nivel de flota, ni rollback. Si la imagen arranca mal, todas las apps Test caen a la vez.

**Evidencia.**
- `update.service.js:100-121` (for secuencial sin gating de salud, sin detener el lote ante fallos). `webhook.routes.js:487-500` (propagación inmediata).

**Por qué es problema real.** Es una flota de instalaciones independientes; un mal push se vuelve incidente multi-cliente sin contención.

**Cómo reproducir/verificar.** Pushear a main una imagen con migración rota/crash al boot; toda la flota Test cae.

**Impacto.** Un commit defectuoso tumba a todos los clientes Test simultáneamente.

**Solución recomendada.** Health check tras el primer subconjunto antes de propagar (o detener el lote si las primeras N no pasan); pin de imagen conocida-buena por canal y botón de rollback que reaplique el `last_deploy` bueno.

**Archivos involucrados.** `update.service.js`, `webhook.routes.js`.

**Esfuerzo.** Alto. **¿Decisión del dueño?** Sí.

---

## AUTH-010 — Recuperación de cuenta inexistente para el usuario final (ALTO de producto)

**Descripción.** No hay flujo "olvidé mi contraseña" por email/portal. El único camino es ejecutar un comando en el Render Shell. Un dueño no técnico que olvide su contraseña queda fuera de su CRM hasta que un técnico intervenga.

**Evidencia.**
- `Login.tsx:252-313` (`recoverySection`: única recuperación). `auth.routes.js:30-79`: no existe endpoint de password reset.

**Por qué es problema real.** Es un producto vendido a clientes finales; el flujo asume acceso a Render y línea de comandos. (Severidad de origen "medio"; elevado en este backlog por impacto de producto y relación con AUTH-002.)

**Cómo reproducir/verificar.** Como dueño no técnico, olvidar la contraseña: no hay forma de recuperarla desde la app.

**Impacto.** Usuarios bloqueados de su propio CRM sin soporte técnico.

**Solución recomendada.** Implementar recuperación real: reset por correo o desde el portal central (que ya es fuente de verdad del password del dueño vía `verifyOwnerCredentialsWithServer`).

**Archivos involucrados.** `Login.tsx`, `auth.routes.js`, `licenseService.js`.

**Esfuerzo.** Alto. **¿Decisión del dueño?** Sí — diseñar el flujo.

---

## Causa raíz transversal — CRON-009 (clasificado medio, relacionado con varios altos)

Aunque CRON-009 está como medio, es la **causa raíz** de varios altos de concurrencia: `PAY2-001/CRON-001`, `NOTI-002/CRON-003`, `AUTO-003/CRON-004`, `AI-001/CRON-007`, `WA-003`, `GHL-005`, `META-006`, `APT-009`, `DB-002`. Todos los crons corren dentro del proceso web; la corrección depende de (a) que Render corra exactamente 1 instancia y (b) claims atómicos donde existen. `render.yaml` no define `numInstances` ni autoescalado; durante el solape de deploy zero-downtime (vieja+nueva vivas hasta 295s) los crons sin claim atómico pueden doble-ejecutar.

**Recomendación de fondo.** Adoptar exclusión entre instancias para crons sensibles (`pg_advisory_lock` por nombre de cron o leader-election) y garantizar claims atómicos + idempotencia de API en TODOS los crons que envían mensajes o cobran. Resolver esto cierra de raíz una familia entera de hallazgos altos. **¿Decisión del dueño?** Sí — definir si se permite escalar >1 instancia y con qué garantías.

---

*Fin del backlog priorizado.*
