# Plan de arreglo por fases — Auditoría CRM Ristak

Este documento deriva un plan ejecutable a partir del backlog confirmado de la auditoría (22 módulos auditados). Está organizado por fases de prioridad: primero lo que sangra dinero, datos o seguridad; al final la deuda y las mejoras futuras.

## Nota sobre conteo y deduplicación

La auditoría cubrió **22 módulos**. El corpus crudo contiene hallazgos que se repiten entre módulos porque dos auditores distintos vieron el mismo defecto desde su propio ángulo. En este plan esos duplicados se **consolidan en una sola entrada** citando ambos IDs. Los duplicados estructurales detectados y unificados son:

| Defecto consolidado | IDs que lo describen | Tema |
|---|---|---|
| Cron sin claim atómico / doble ejecución | **AUTO-003 / CRON-004** | Reanudación de esperas de automatización |
| Cobro doble Conekta sin idempotency key | **PAY2-001 / CRON-001 / CRON-002** | Parcialidades Conekta |
| Recordatorios de cita doble envío | **APT-009 / NOTI-002 / CRON-003** | Claim previo al envío de WhatsApp |
| Agente conversacional doble respuesta/acción | **AI-001 / CRON-007** | Dedup en memoria + claim no atómico |
| JWT 30 días sin revocación | **AUTH-003 / SEC-007** | Sesión sin invalidación |
| JWT_SECRET fallback estático fuera de prod | **AUTH-004 / SEC-006(parcial) / PORTAL-006** | Secreto por defecto y revocación |
| Sin rate limiting en login/API | **AUTH-001 / SEC-004 / AUTH-008** | Fuerza bruta y amplificación |
| Push expone contactos ocultos | **NOTI-004 / MOB-002** | Filtro hidden-contacts en push |
| DELETE de suscripción/dispositivo push sin verificar dueño | **NOTI-005 / MOB-008** | Scoping por user_id |
| getContactById ignora ocultos | **ACL-002(parcial) / SEC-005** | Filtro de ocultos por ID |
| Sin runner de migraciones / FK CASCADE | **DB-001 / DB-003 / DB-004 / DB-006** | Esquema y migraciones |
| Reembolso parcial marca refunded total | **PAY-002** (RPT-002 fue **refutado**) | Estado de pago |

> **Refutados (NO se incluyen como problemas):** **RPT-002** quedó refutado en verificación adversarial — los ingresos ya excluyen pagos con status `refunded` porque el reembolso muta el status del pago; restarlo de nuevo provocaría doble deducción. No aparece en ninguna fase.

**Conteo deduplicado honesto:** del corpus crudo (~160 entradas con IDs) quedan, tras quitar el refutado y consolidar duplicados, **~140 hallazgos accionables únicos**. Los que están marcados `verifyStatus="requiere-verificacion-manual"` se señalan explícitamente en cada fase con `[VERIFICAR]`.

---

## Fase 1 — Críticos: seguridad, pérdida/fuga de datos, cobros, flujos rotos

**Objetivo:** detener lo que causa daño irreversible o inmediato: dinero cobrado de más/de menos, datos borrados sin rastro, credenciales maestras expuestas, flujos de negocio que no producen ningún resultado. Nada aquí es opcional ni "decisión de producto" pura — son fallas de correctitud.

### Hallazgos incluidos

**Seguridad crítica (toma de control / fuga maestra)**
- **SEC-001** (`critico`) — Proxy arbitrario a GoHighLevel: cualquier API token toma control total de la cuenta GHL (incl. DELETE).
- **NOTI-001** (`critico`) — Caída de OpenAI cancela citas confirmadas (`result || 'ambiguous'` ejecuta `cancel_appointment`). Contexto médico, destructivo.
- **MOB-001** (`critico`) `[VERIFICAR runtime]` — CORS del Installer bloquea resolución de tenant en Android nativo: la app Android no puede loguear a nadie.
- **SEC-002** (`alto`) — Webhooks `/webhook/payment|contact|refund|appointment` sin verificación de firma: inyección de pagos/contactos falsos.
- **SEC-003** (`alto`) — Master key de cifrado autogenerada y guardada en plano en la misma DB que protege.
- **GHL-001** (`alto`) — Token HighLevel en texto plano + endpoint `/config/reveal/api_token` lo devuelve íntegro a cualquier usuario autenticado.
- **WA-001** (`alto`) — Webhook YCloud acepta payloads sin firmar cuando no hay `webhook_secret`.
- **WA-004** (`alto`) — Webhook de atribución WhatsApp público sin firma: sobreescribe atribución de cualquier contacto.
- **TRK-001** (`alto`) — `/collect` acepta sesiones falsas: contamina atribución/revenue y puede cruzar identidades.
- **TRK-004** (`alto`) — Submit público de Sites sin rate limiting/honeypot/captcha: spam ilimitado de contactos + CAPI + automatizaciones.
- **PORTAL-001** (`alto`) — Demo opera sobre conexiones reales de WhatsApp/Meta de producción (envía mensajes reales, borra plantillas).
- **PORTAL-002** (`alto`) — `setup-token/verify` (peek) expone el hash de contraseña del dueño de forma repetible.
- **PORTAL-003** (`alto`) — Token de release móvil reutilizable 120 min sin rate limit: fuga de credenciales de firma iOS/Android.

**Pérdida/fuga de datos**
- **CNT-001** (`alto`) — Editar teléfono/email fusiona y BORRA otro contacto en silencio (hard delete, irreversible).
- **CNT-002** (`alto`) — La fusión pierde tags, custom_fields, ghl_contact_id y WhatsApp preferido.
- **GCAL-001** (`alto`) — Cancelar un evento en Google hace HARD DELETE de la cita en Ristak (incluidas las creadas en Ristak).
- **GHL-002** (`alto`) — El sync HL→local nunca borra entidades eliminadas: datos zombie inflan métricas.
- **GHL-003** (`alto`) — Citas de HL pisan ediciones locales recientes (sin last-write-wins).
- **GCAL-003** (`alto`) — Sync entrante de Google sobrescribe ediciones locales sin resolver conflicto.
- **DB-003** (`alto`) — FK `payments.contact_id` ON DELETE CASCADE: borrar un contacto destruye su historial de pagos.

**Cobros / dinero**
- **PAY-001** (`alto`) — Eliminar una suscripción NO la cancela en Stripe: sigue cobrando al cliente.
- **PAY-002** (`alto`) — Reembolso parcial en Stripe marca el pago como totalmente reembolsado.
- **PAY2-001 / CRON-001 / CRON-002** (`alto`) — Cobro doble de parcialidades Conekta: sin Idempotency-Key ni claim atómico.
- **PAY2-002** (`alto`) — Conekta sin webhook: pagos `pending` (3DS/OXXO/SPEI) nunca se reconcilian.
- **META-001** (`alto`) — CPM/CTR calculados con `reach` en vez de impresiones: métricas infladas en toda la app.

**Flujos rotos (funciones que no producen resultado)**
- **AUTO-001** (`alto`) — El editor permite publicar nodos que el motor no ejecuta: se omiten en silencio y cortan el flujo.
- **AUTO-002** (`alto`) — Disparadores ofrecidos en el editor que nunca reciben evento (comentarios FB/IG, ad-click, click-to-WhatsApp).
- **META-002** (`alto`) — Campaign Builder nunca crea campañas reales en Meta.
- **APT-001** (`alto`) — El admin puede crear doble-booking: `createAppointment` no valida disponibilidad ni solapamiento.
- **APT-002** (`alto`) — Reserva pública: carrera TOCTOU permite doble reserva del mismo slot.
- **APT-003** (`alto`) — Reprogramar una cita no reenvía el recordatorio para el nuevo horario.
- **APT-004** (`alto`) — Bloqueo de horarios solo funciona con HighLevel; calendarios Ristak/Google quedan sin bloqueos.

**Doble respuesta/acción del agente IA (amplifica cobros)**
- **AI-001 / CRON-007** (`alto`) — Doble respuesta/acción del agente conversacional: dedup solo en memoria + claim no atómico.
- **AI-004** (`alto`) — `create_payment_link` del agente no es idempotente: links/cobros duplicados.

### Orden recomendado y dependencias

1. **Bloque secretos/proxy primero (independientes, esfuerzo bajo-medio):** SEC-001, GHL-001, SEC-003, PORTAL-002, PORTAL-003. Cierran exposiciones de credenciales que amplifican todo lo demás.
2. **Bloque webhooks sin firma (comparten patrón "exigir secreto/HMAC"):** SEC-002, WA-001, WA-004, PAY2-005 (este último puede subirse de Fase 2 para hacerse junto). Se hacen en una sola pasada de middleware de verificación.
3. **NOTI-001 antes que cualquier mejora de confirmación:** es un cambio de una línea de lógica (`null` ≠ `ambiguous`) y evita cancelar citas reales. Sin dependencias.
4. **Bloque cobros Stripe/Conekta:** PAY-001 → PAY-002 → PAY2-001/CRON-001. PAY2-001 **depende** del patrón de claim atómico que también usan CRON-002/CRON-003/CRON-004 (Fase 4 lo generaliza, pero aquí se aplica puntualmente a Conekta). PAY2-002 (webhook Conekta) es independiente.
5. **Bloque pérdida de datos por merge:** CNT-001 → CNT-002 (CNT-002 corrige el merge que CNT-001 hace condicional). DB-003 conviene antes o junto, porque cambia la política de borrado/cascade que CNT-001 ejerce.
6. **Bloque sync destructivo:** GCAL-001 (no hard-delete por evento remoto) y GHL-002 (reconciliación de borrados) son opuestos pero relacionados: definir primero la **política de borrado remoto** evita re-trabajo. GHL-003/GCAL-003 (last-write-wins) comparten el mismo `upsertLocalAppointment` — se arreglan en el mismo archivo, una sola vez.
7. **Bloque calendario:** APT-001 y APT-002 comparten `overlaps/getEffectiveSlotAppointmentLimit`; hacerse juntos. APT-004 (blocked slots locales) **habilita** que APT-001/APT-002 respeten bloqueos — orden: APT-004 → APT-001 → APT-002. APT-003 (reprogramar recordatorio) es independiente.
8. **Bloque automatizaciones/agente:** AUTO-001 y AUTO-002 comparten `validateFlowForPublish` (allowlist de nodos/triggers ejecutables). AI-004 (idempotencia de pago) **depende** de la barrera de AI-001/CRON-007; aplicar el claim atómico primero.
9. **META-001/META-002** independientes; META-001 es esfuerzo bajo (agregar `impressions` y recalcular).
10. **MOB-001** `[VERIFICAR]` independiente; confirmar header real del WebView Android antes de tocar la allowlist CORS del Installer.

### Criterio de "hecho" (Fase 1)

- Ningún endpoint público (webhooks, `/collect`, submit de Sites, proxy GHL, reveal de tokens) acepta tráfico sin firma/secreto/allowlist o sin rol adecuado. Test de "payload sin firma → 401".
- Ningún reembolso parcial marca `refunded` total; existe estado `partially_refunded` aplicado y probado.
- Eliminar una suscripción cancela en Stripe; un cobro de parcialidad Conekta concurrente **no** crea dos órdenes (test con dos ejecuciones simultáneas).
- Editar un teléfono que coincide con otro contacto **no** borra silenciosamente: pide confirmación o devuelve 409. El merge preserva tags/custom_fields.
- Cancelar/borrar un evento en Google **no** hace hard-delete en Ristak. El pull no revierte ediciones locales más recientes.
- `createAppointment` y la reserva pública rechazan (409) cuando el slot está lleno; los bloqueos locales se respetan sin GHL.
- Reprogramar una cita reprograma su recordatorio.
- Publicar un flujo con un nodo/trigger no ejecutable se rechaza o marca `requires_review`; el motor no termina un flujo en `completed` por handle inexistente.
- CPM/CTR reconcilian con Meta Ads Manager (usan impresiones).
- El agente conversacional responde una sola vez ante el mismo `messageId`; `create_payment_link` no crea dos links.
- NOTI-001: un fallo del clasificador deja la ventana en `error`/`human_needed`, nunca cancela.

### Esfuerzo agregado estimado (Fase 1)

Mezcla de esfuerzos `bajo`/`medio`/`alto`. Predominan `medio`. Hay varios `alto` reales: APT-002 (lock/índice único por slot), APT-004 (tabla de blocked slots locales), GHL-002 (reconciliación de borrados), AUTO-002/META-002 (cablear o esconder features), AI-001 (claim atómico distribuido). **Estimación agregada: la fase más cara del plan**, en el orden de varias semanas-persona. Es la prioridad absoluta: aquí está casi todo el riesgo financiero, de datos y de seguridad.

---

## Fase 2 — Estabilidad funcional: integraciones, sincronización, estados

**Objetivo:** que las integraciones y los ciclos de vida de las entidades sean confiables y consistentes una vez cerrado el sangrado crítico. Aquí viven los desincronizados, los estados a medio implementar y las features premium sin gate.

### Hallazgos incluidos

**Gating de licencia y features (monetización + control)**
- **LIC-001** (`alto`) — Módulos premium sin `requireFeature` en backend: el plan se salta por API directa.
- **LIC-003** (`alto`) — Respuesta `allowed:true` sin `features` otorga TODO el plan (failure-open).
- **AI-002** (`alto`) `[VERIFICAR]` — Runtime del agente conversacional no valida `conversational_ai`: sigue respondiendo tras downgrade.
- **GHL-007** (`medio`) — Rutas privadas de HighLevel solo exigen `requireAuth`, sin rol/módulo (incl. reveal token, text2pay, record-payment).
- **ACL-001** (`alto`) — Módulos del frontend sin `requireModuleAccess` en backend (chat, analytics, products, attribution, etc.).
- **ACL-006** (`medio`) — `POST/DELETE /api/config` sin gate de módulo.
- **LIC-004** (`medio`) — `normalizeLicenseFeatures` pisa flags de sub-feature explícitas (downgrade parcial ignorado).
- **LIC-002** (`medio`) — `requireFeature` corre antes de `requireAuth`: amplificación al license server sin auth.
- **LIC-009** (`medio`) `[VERIFICAR]` — Crons corren sin gate de licencia/feature.

**Sincronización e integridad de integraciones**
- **PAY-003** (`medio`) `[VERIFICAR]` — Suscripción Stripe huérfana si falla el INSERT local (sin compensación).
- **PAY-005** (`medio`) — Webhook Stripe sin dedupe a nivel de `event.id`.
- **PAY2-003** (`medio`) — MercadoPago no dispara el comprobante automático tras el pago.
- **PAY2-004** (`medio`) — Retorno del checkout MP no refresca la página (mismatch `?mercadopago=return`).
- **PAY2-005** (`medio`) — Webhook MercadoPago acepta peticiones sin firma cuando no hay secret. *(Candidato a subir a Fase 1 con el bloque de webhooks.)*
- **PAY2-006** (`medio`) — Facturación Gigstack sin reintentos: factura fiscal se pierde si el primer intento falla.
- **PAY2-007** (`medio`) — Recordatorios de pago no salen para links sin `due_date`.
- **GHL-009** (`medio`) — Reconciliación Meta muta credenciales locales en cada cron sin consentimiento.
- **GHL-006** (`medio`) — Checkpoint de conversaciones avanza aunque se pierdan mensajes.
- **GHL-011** (`medio`) `[VERIFICAR]` — Emparejamiento WhatsApp→HL puede ligar al contacto equivocado y fusionar personas distintas.
- **GHL-012** (`medio`) `[VERIFICAR]` — `collectPaginatedData` corta paginación al ver una página de duplicados.
- **GHL-004** (`medio`) `[VERIFICAR]` — Citas de HL no capturan `googleEventId` (riesgo de duplicación con Google).
- **GCAL-002** (`alto`) — Sin cron de sync Google: solo on-demand, errores nunca se reintentan. *(Frontera con Fase 1; depende de definir locking, ver Fase 4.)*
- **GCAL-005** (`medio`) — Desconectar Google no revoca el token ni avisa al Installer.
- **GCAL-006** (`medio`) `[VERIFICAR]` — Citas importadas de Google entran sin contacto ni recordatorios.
- **META-003** (`alto`) — El frontend nunca muestra estado/expiración del token de Meta (sync muere en silencio).
- **META-005** (`medio`) — Access token de Meta revelado y enviado por query string.
- **META-004** (`medio`) `[VERIFICAR]` — Auto-detección de versión Graph API puede saltar a una versión no probada.
- **CNT-008** (`medio`) — Sync de custom fields a HighLevel bloquea el guardado local (502 antes de persistir).

**Estados y ciclo de vida**
- **APT-005** (`medio`) — Estados de cita inconsistentes (`rescheduled` sin semántica; reprogramar no cambia estado).
- **APT-006** (`medio`) `[VERIFICAR]` — Cancelar por estado a `cancelled` no cancela en HighLevel.
- **APT-010** (`bajo`) — `updateContactAppointmentDate` no excluye `noshow`.
- **NOTI-003** (`alto`) — Confirmación de cita solo funciona vía WhatsApp API; respuestas por HL/Meta no confirman.
- **WA-005** (`medio`) `[VERIFICAR]` — Inferencia de dirección por defecto a `inbound` guarda salientes como entrantes.
- **WA-007** (`medio`) `[VERIFICAR]` — Estado `failed` terminal bloquea `delivered/read` posteriores.
- **WA-009** (`medio`) `[VERIFICAR]` — Mensajes API que fallan sin fallback QR no se persisten en el chat.
- **WA-002** (`alto`) — Envío QR se reporta fallido si no hay ack en 20s, sin persistir → duplicados.
- **CNT-004** (`medio`) — `updateContact` no deduplica email; conflicto UNIQUE cae a 500 genérico.
- **CNT-005** (`medio`) `[VERIFICAR]` — Dedup por teléfono confunde números nacionales de distinto país (MX/US/+1).
- **CNT-009** (`medio`) `[VERIFICAR]` — Definiciones de custom fields segmentadas por `owner_user_id` "desaparecen" entre empleados.
- **GHL-010** (`medio`) `[VERIFICAR]` — `isHighLevelConnected` no valida scopes parciales del token.

### Orden recomendado y dependencias

1. **Gating primero como capa transversal:** introducir un **mapa central módulo→feature** y aplicar `requireFeature` + `requireModuleAccess` de forma consistente cierra LIC-001, ACL-001, ACL-006, GHL-007 en una sola pasada coherente. LIC-002 (orden de middleware) **debe** resolverse aquí porque mover `requireFeature` tras `requireAuth` es prerequisito para hacer el gating per-usuario correcto. LIC-003/LIC-004 (failure-open / sub-features) tocan `normalizeLicenseFeatures`; hacerse juntos.
2. **AI-002 y LIC-009** dependen de tener el gating de feature legible desde el runtime (no solo HTTP). Hacerse después del paso 1. Ambos `[VERIFICAR]` cómo el Installer expone el flag.
3. **Bloque pagos/integración:** PAY2-005 conviene haberse hecho en Fase 1 (webhooks). PAY-005 (dedupe `event.id`) **habilita** robustez para PAY2-003/PAY2-006 (reintentos idempotentes). PAY2-004 (mismatch return) es independiente y barato.
4. **Bloque confirmación de cita:** NOTI-003 (centralizar inbound de confirmación) **depende** de APT-005 (definir el ciclo de vida real de estados) para no cablear estados a medias. APT-006/APT-010 son del mismo ciclo de vida.
5. **Bloque WhatsApp estados:** WA-002 (persistir como `sent`), WA-007 (timestamp del ack), WA-009 (persistir fallidos) comparten `upsertMessage`/prioridad de estados; hacerse juntos. WA-005 (dirección) es del mismo flujo de procesamiento inbound.
6. **Bloque sync HL/Google:** GHL-006, GHL-011, GHL-012, GHL-004, GHL-009 tocan el mismo servicio de sync; agruparlos por archivo. GCAL-002 (cron Google) **depende** de la decisión de locking de Fase 4 — puede iniciarse aquí su diseño y completarse cuando el locking exista.
7. **META-003/META-005/META-004** independientes entre sí.

### Criterio de "hecho" (Fase 2)

- Llamar directo a un módulo premium fuera del plan devuelve 403 `feature_not_available` (frontend lo maneja, ver Fase 3); un `allowed:true` sin `features` **no** abre todo; un downgrade parcial preserva la sub-feature apagada.
- El agente conversacional deja de responder al revocar `conversational_ai` (`[VERIFICAR]` el camino de revocación).
- Un comprobante de pago sale igual por MercadoPago que por Conekta; volver del checkout MP refresca y muestra `paid`.
- Una factura Gigstack fallida se reintenta; un webhook Stripe duplicado se corta por `event.id`.
- La confirmación de cita funciona aunque la respuesta llegue por HL/Meta; `rescheduled` tiene semántica definida y documentada.
- Mensajes WhatsApp con destinatario offline se guardan como `sent`, no se reenvían como duplicado; un `failed` transitorio no bloquea un `delivered` posterior.
- La UI de Meta muestra estado/expiración del token; el sync no muere en silencio.
- Citas/datos eliminados en HL se reflejan local (cierra el lado de lectura de GHL-002 de Fase 1).

### Esfuerzo agregado estimado (Fase 2)

Mayoría `medio`, varios `bajo`, un puñado `alto` (gating transversal, NOTI-003, GCAL-002, GHL-011). **Estimación agregada: alta**, comparable a Fase 1 pero con menos riesgo destructivo. Muchos ítems se colapsan en pasadas compartidas (gating, `upsertMessage`, servicio de sync), lo que reduce el costo real si se respeta el agrupamiento.

---

## Fase 3 — UX y operación

**Objetivo:** que el usuario entienda qué pasa, no pierda trabajo por feedback opaco y no opere a ciegas. Bugs reales pero de experiencia/operación, no de correctitud de datos.

### Hallazgos incluidos

- **AUTH-002** (`alto`) — Instructivo público de reset con credenciales fijas `admin/admin123` a la vista en `/login`. *(Seguridad de bajo esfuerzo; podría adelantarse a Fase 1 en la práctica.)*
- **AUTH-010** (`medio`) — Sin recuperación de cuenta real para usuario final (solo Render Shell).
- **AUTH-005** (`medio`) — Política de contraseñas débil (mínimo 6, sin complejidad).
- **LIC-005** (`medio`) — Frontend no maneja 403 `feature_not_available`: fallos silenciosos. *(Depende de Fase 2 para que el backend emita ese code consistentemente.)*
- **LIC-008** (`bajo`) — Features capturadas solo al login: cambios de plan no se reflejan en sesión activa.
- **CNT-003** (`medio`) — El 409 de duplicado no se muestra (toast genérico).
- **CNT-006** (`medio`) `[VERIFICAR]` — Contactos sin teléfono enrolados en lotes WhatsApp sin aviso previo.
- **CNT-011** (`bajo`) — Bulk delete secuencial sin progreso ni cancelación.
- **CNT-007** (`medio`) — Borrado de contacto es hard delete sin papelera ni protección por LTV.
- **APT-008** (`bajo`) `[VERIFICAR]` — Estado inicial del modal es `confirmed` ignorando `autoConfirm`.
- **GCAL-007** (`medio`) `[VERIFICAR]` — La UI no muestra estado de sync por-cita con Google.
- **GHL-001 (lado UI)** ya cubierto en Fase 1.
- **NOTI-008** (`medio`) `[VERIFICAR]` — Recordatorios con plantilla no APPROVED fallan en silencio (sin feedback en UI).
- **WA-006** (`medio`) — Fallback a disco local de media deja media perdida tras deploy y envíos rotos.
- **WA-008** (`bajo`) — Validación de plantilla APPROVED se omite si no está sincronizada localmente.
- **MOB-003** (`alto`) — `/phone/login` no re-resuelve tenant: correo de otra empresa falla sin explicación.
- **MOB-004** (`medio`, ajustado) — Sin logout descubrible en el shell de chat de iPhone nativo.
- **MOB-005** (`medio`) — Registro de push nativo limitado por timeout de 16s (falsos negativos).
- **MOB-006** (`medio`) — Toggles de notificación globales del tenant disfrazados de "este celular".
- **MOB-007** (`medio`) `[VERIFICAR]` — Fechas/caché móvil usan hora local del dispositivo, no la del negocio.
- **MOB-009** (`bajo`) `[VERIFICAR]` — Secciones premium muestran ceros en vez de avisar feature bloqueada.
- **RPT-007** (`medio`) `[VERIFICAR]` — Citas/asistencias caen a 0 en silencio si falta/expira el token de HL.
- **RPT-006** (`medio`) — Conteo de "Citas" inconsistente entre funnel y gráfica.
- **RPT-005** (`medio`) `[VERIFICAR]` — Gasto no reatribuido por scope: ROAS diario mal alineado.
- **PORTAL-008** (`bajo`) — Mensajes de bloqueo de licencia indistinguibles dificultan el diagnóstico.
- **INST-005** (`medio`) `[VERIFICAR]` — Health marca `active` un redeploy aún no terminado/fallido.
- **INST-007** (`medio`) — `pending_promote` global sin TTL ni feedback de "promoción colgada".
- **PAY2-009** (`bajo`) — La página `/pay` expone identidad fiscal del merchant (RFC, razón social).

### Orden recomendado y dependencias

1. **AUTH-002 primero** (un cambio de UI/comando, esfuerzo bajo, riesgo de seguridad real). Luego AUTH-005/AUTH-010 (recuperación real depende de decisión de producto sobre el portal como fuente de verdad).
2. **LIC-005 depende de Fase 2** (que el backend emita `feature_not_available` consistente). LIC-008 sobre el mismo `LicenseContext`/polling.
3. **Bloque contactos:** CNT-003 (mostrar 409) y CNT-006 (aviso de sin teléfono) son baratos y mejoran la percepción de los flujos de Fase 1. CNT-007 (soft delete) **se relaciona con DB-003** de Fase 1: definir política de borrado una sola vez.
4. **Bloque móvil:** MOB-003 (re-resolver tenant) es el de mayor impacto de UX; MOB-004/MOB-006/MOB-007 son del mismo entorno PhoneApp/PhoneSettings.
5. **Bloque reportes:** RPT-006/RPT-005/RPT-007 tocan dashboardController y la consistencia de definiciones; agruparse.
6. **Bloque Installer/operación:** INST-005, INST-007, PORTAL-008 mejoran la operación del portal; independientes entre sí.

### Criterio de "hecho" (Fase 3)

- `/login` no muestra ningún comando ni credenciales objetivo; existe (o está documentada) una recuperación real para el usuario final.
- Un 403 de feature premium muestra "No incluida en tu plan", no un error genérico; un cambio de plan se refleja sin re-login.
- Errores de duplicado/teléfono faltante se muestran con el mensaje real; el borrado de contacto avisa/protege por LTV.
- El login móvil re-resuelve el tenant por correo; hay logout descubrible en el iPhone nativo; las fechas usan la zona del negocio.
- Funnel y gráficas muestran números consistentes; un token HL caído se distingue de "cero datos".
- Recordatorios/citas que fallan exponen el motivo en la UI; el panel del Installer refleja el estado real del deploy y de las promociones.

### Esfuerzo agregado estimado (Fase 3)

Mayoría `bajo`/`medio`. **Estimación agregada: media.** Alto retorno percibido por el usuario con poco código; varios ítems son cambios de UI o de mensajes de error.

---

## Fase 4 — Automatización, concurrencia, idempotencia y testing

**Objetivo:** convertir las protecciones "accidentales" (flag en memoria, idempotencia delegada a proveedor externo, suposición de 1 instancia) en garantías por diseño, y blindar con tests las regresiones que hoy solo explotan en producción. Esta fase **paga la deuda que hace frágiles a las Fases 1–2**.

### Hallazgos incluidos

**Concurrencia y locking (el patrón sistémico)**
- **CRON-009** (`medio`) — Sin leader-election ni advisory locks: el modelo depende de que Render mantenga 1 instancia. **Hallazgo paraguas de esta fase.**
- **AUTO-003 / CRON-004** (`alto`) — `processDueResumes` sin reclamo atómico: doble ejecución de la rama reanudada.
- **APT-009 / NOTI-002 / CRON-003** (`alto`) — Recordatorios de cita: claim anti-duplicado ocurre DESPUÉS del envío.
- **CRON-002** (`medio`) — Reclamo no atómico en cobros Stripe/Conekta (depende de idempotencia externa).
- **PAY-008** (`bajo`) — Cron de parcialidades Stripe sin lock en DB.
- **PAY2-010** (`bajo`) `[VERIFICAR]` — Preferencias MP en parcialidades sin claim atómico.
- **AUTO-004** (`medio`) `[VERIFICAR]` — Inscripción duplicada por carrera (check-then-insert sin constraint).
- **GHL-005** (`medio`, ajustado) — Full sync HL sin lock global.
- **META-006** (`medio`) `[VERIFICAR]` — Crons de Meta sin locking entre instancias.
- **WA-003** (`alto`) — Watchdog QR sin lock: múltiples instancias abren el mismo socket y se reemplazan en bucle.
- **GCAL-008** (`bajo`) `[VERIFICAR]` — Token cache global no distingue revocaciones.
- **PORTAL-007** (`medio`) `[VERIFICAR]` — Rate limit en memoria no protege con múltiples instancias.
- **PORTAL-009** (`bajo`) `[VERIFICAR]` — Sync de usuarios del Installer sin locking entre réplicas.
- **CNT-012** (`bajo`) — `createContact` check-then-insert no atómico.
- **AUTH-006** (`medio`) — TOCTOU en `/setup` (dos requests pueden crear más de un primer usuario).

**Automatización incompleta / reintentos**
- **CRON-005** (`medio`) — Cron de planes MercadoPago construido pero nunca arrancado.
- **CRON-006** (`medio`) `[VERIFICAR]` — `verifyAndUpdateWebhooks` bloquea el boot si HL está lento.
- **GCAL-002** (`alto`) — Cron de sync Google + reintento de errores (necesita el locking de esta fase).
- **AUTO-005** (`medio`) — Fallo de nodo deja inscripción `exited` sin reintento.
- **AUTO-007** (`medio`) `[VERIFICAR]` — Pausar una automatización descarta esperas en curso (`exited`).
- **AUTO-006** (`medio`) `[VERIFICAR]` — Nodo `logic-goal` siempre pasa por "cumplido".
- **AI-003** (`medio`) — Follow-ups/recuperación solo en memoria/boot: sin cron de respaldo.
- **AI-005** (`medio`) `[VERIFICAR]` — Asistente de la app sin idempotencia: reintento humano duplica acciones.
- **AI-009** (`bajo`) — Ráfagas durante delay se pierden si el proceso cae.
- **NOTI-007** (`medio`) `[VERIFICAR]` — Mensaje programado en `sending` tras crash se reenvía.
- **NOTI-010** (`bajo`) `[VERIFICAR]` — Sin flush-on-drain de recordatorios/programados al apagar.
- **CONT/Bulk** — CNT-010 (`bajo`) sync-stats full-table síncrono sin throttle.

**Testing y portabilidad SQL (deuda que oculta bugs solo-en-prod)**
- **DB-005** (`alto`) — Parámetros con tipo ambiguo crashean solo en Postgres (clase sistémica).
- **PAY-006** (`medio`) — SQL probado solo en SQLite truena en Postgres prod (mismo patrón, lado pagos).
- **RPT-009** (`bajo`) `[VERIFICAR]` — Placeholders `$1/$2` + array posicional fallan en SQLite (dev).
- **DB-001** (`alto`) — Sin runner de migraciones versionado.
- **DB-002** (`alto`) — Migraciones de datos destructivas en CADA boot sin advisory lock.

### Orden recomendado y dependencias

1. **CRON-009 define la estrategia de exclusión** (advisory lock por nombre de cron / leader-election). **Es prerequisito de casi todo lo demás de esta fase.** Decidir e implementar el mecanismo una vez.
2. **DB-001 antes que DB-002:** sin runner de migraciones no se pueden gatear las migraciones de datos del boot. DB-002 mueve las migraciones destructivas detrás de advisory lock + versión. Estos dos **habilitan** también DB-003/DB-004/DB-006 de Fase 1 (FK, timestamptz, índice único) que solo se propagan de forma confiable con un runner.
3. **Claims atómicos sobre la base del paso 1:** AUTO-003/CRON-004, APT-009/NOTI-002/CRON-003, CRON-002, PAY-008, AUTO-004, CNT-012, AUTH-006 comparten el patrón `UPDATE ... WHERE status=... AND changes>0` (ya existe en `claimScheduledMessage`/`claimDispatch`). Replicar ese patrón es mecánico una vez decidido.
4. **WA-003 (watchdog QR)** depende del lock de ownership por sesión (CRON-009). GHL-005/META-006/PORTAL-007/PORTAL-009 son del mismo paraguas de locking.
5. **GCAL-002 y CRON-005** (crons faltantes/bloqueantes) se completan una vez que el locking existe. CRON-006 (boot bloqueante) es independiente y barato.
6. **Reintentos:** AUTO-005, AUTO-007, AI-003, AI-005, NOTI-007 introducen estados reintentables; AI-003 (cron de recovery) **comparte infraestructura** con AUTO-005/NOTI-007.
7. **CI contra Postgres:** DB-005/PAY-006/RPT-009 — el entregable clave es un **job de CI que corre la suite contra Postgres real**, que es la única forma de cazar la clase "could not determine data type" antes de prod.

### Criterio de "hecho" (Fase 4)

- Existe un mecanismo de exclusión entre instancias (advisory lock o líder) y los crons sensibles lo usan; escalar a >1 instancia ya no rompe idempotencia (test con dos procesos contra la misma DB).
- Recordatorios, esperas de automatización, cobros y agente reclaman la fila **antes** de actuar; doble ejecución no produce doble mensaje/cobro.
- Existe un runner de migraciones versionado con `schema_migrations`; las migraciones de datos del boot corren una sola vez, bajo lock, con gating por versión.
- El cron de planes MercadoPago arranca; el sync de Google reintenta errores; el boot no se bloquea por HL lento.
- Fallos transitorios dejan estados reintentables, no terminales; los follow-ups sobreviven a reinicios.
- Hay un job de CI que ejecuta la suite contra Postgres y falla ante parámetros de tipo ambiguo.

### Esfuerzo agregado estimado (Fase 4)

`alto` agregado. El mecanismo de locking (CRON-009) y el runner de migraciones (DB-001/DB-002) son inversiones de arquitectura caras, pero **una vez hechas, casi todos los demás ítems de esta fase se vuelven baratos** (replicar un patrón ya existente). El job de CI Postgres es alto retorno y previene regresiones futuras de las Fases 1–2.

---

## Fase 5 — Mejoras futuras y deuda técnica

**Objetivo:** robustez, trazabilidad, rendimiento y decisiones de producto que no bloquean la operación pero elevan la calidad a "producto premium". Aquí van los `bajo`, los `decision-producto`, y los endurecimientos defensivos.

### Hallazgos incluidos

**Seguridad/endurecimiento defensivo**
- **AUTH-007** (`medio`) `[VERIFICAR]` — Credenciales del dueño al portal sin forzar HTTPS.
- **SEC-008** (`medio`) `[VERIFICAR]` — Registro dinámico de clientes OAuth sin auth.
- **SEC-009** (`medio`) — CORS totalmente abierto (sin allowlist).
- **SEC-010** (`medio`) `[VERIFICAR]` — Media servida inline (riesgo XSS almacenado si se permite SVG/HTML).
- **SEC-011** (`bajo`) — Comparación de firma JWT no constante (timing).
- **SEC-012 / ACL-005** (`bajo`) — Filtro de contactos ocultos por concatenación de string (escape manual).
- **AUTH-009** (`bajo`) `[VERIFICAR]` — `requestPortalUserRefresh` best-effort: empleados sin login móvil tras fallo transitorio.
- **AUTO-009** (`medio`) — Endpoint de assets de automatización público por ID sin firma/expiración.
- **AI-008** (`bajo`) `[VERIFICAR]` — Trace IA visible por `traceId` para cualquier usuario con módulo `ai_agent`.
- **AUTO-008** (`medio`) `[VERIFICAR]` — `applyTagAction` puede disparar cascadas entre automatizaciones sin tope global.
- **INST-006** (`medio`) `[VERIFICAR]` — Una sola API key estática protege el webhook de deploy.
- **INST-008** (`medio`) — Postgres de cada cliente abierta a `0.0.0.0/0` de forma permanente.
- **INST-009** (`bajo`) `[VERIFICAR]` — Webhook de deploy confía en `channel/branch` del body.
- **INST-010** (`bajo`) `[VERIFICAR]` — Endpoints de instalación sin rate limiting.
- **PORTAL-004** (`medio`) `[VERIFICAR]` — Brokers de refresh aceptan cualquier refresh_token sin atarlo al cliente.
- **PORTAL-005** (`medio`) `[VERIFICAR]` — `app_url` promovible a dominio arbitrario desde un verify.
- **SEC-006** (`medio`) — API externa expone tabla `users` como directorio.

**Decisiones de producto**
- **ACL-003** (`medio`) — Filtros de contactos ocultos editables por cualquier empleado.
- **ACL-004** (`medio`) — No existe "owner" por contacto: todo empleado ve toda la base.
- **PAY2-008** (`bajo`) — Tarjeta del cliente se guarda por default en pago público Conekta sin opt-in.
- **TRK-006** (`medio`) — Fallback attribution sobreescribe `ad_id` sin guardar el valor previo ni marca.
- **TRK-007** (`medio`) — Trigger links: `contact_id`/`click_count` manipulables por query string.
- **TRK-009** (`bajo`) `[VERIFICAR]` — Snippet inyecta `rkvi_id` en la URL (fuga por referrer/compartido).
- **DB-008** (`medio`) `[VERIFICAR]` — `appointment_attendance_signals` con PK = `contact_id` (una sola señal por contacto).
- **DB-010** (`bajo`) — Sin tabla de auditoría/historial para entidades sensibles.
- **INST-002 / INST-003** (`alto`) — `auto_update_on_push` código muerto; auto-update masivo de Test sin canary/rollback. *(Operación del Installer; alto impacto pero acotado a la flota Test — decisión de producto sobre el modelo de release.)*
- **INST-001** (`alto`) — Instalación fallida deja Postgres/web service huérfanos en Render. *(Coste real; podría adelantarse si el costo de huérfanos es significativo.)*
- **INST-004** (`alto`) `[VERIFICAR]` — Llave de cifrado derivada de `JWT_SECRET`: rotarlo inutiliza updates/cancelación. *(Endurecimiento de infra; alto si se rota `JWT_SECRET`.)*

**Rendimiento y deuda técnica**
- **CNT-010** (`bajo`) — `sync-stats` full-table síncrono (ya listado en Fase 4 por throttling).
- **DB-007** (`medio`) — Fusión usa `MAX` en vez de `SUM` para `total_paid`/`purchases_count`.
- **DB-009** (`bajo`) — Tabla `appointments` sin `created_at/updated_at`; columnas por ALTER frágiles.
- **TRK-002** (`medio`) `[VERIFICAR]` — Sin deduplicación de sesiones: infla page_views.
- **TRK-003** (`medio`) — Geolocalización síncrona vía ip-api.com en el camino caliente de `/collect`.
- **TRK-005** (`medio`) — Fallback attribution preview ≠ execute (timezone distinta).
- **TRK-008** (`bajo`) — Offset de timezone hardcodeado a -6h en SQLite.
- **TRK-010** (`bajo`) — En no-producción cualquier host pasa como dashboard.
- **RPT-001** (`alto`) — Costos fijos del dashboard no se prorratean ni filtran por fecha (contradice la UI). *(Dato financiero engañoso; candidato a subir a Fase 1/2 si el dashboard se usa para decisiones.)*
- **RPT-003** (`medio`) — Costos con `applies_to='profit'` se ignoran.
- **RPT-004** (`medio`) — `getGroupExpression` SQLite ignora timezone real (-6h).
- **RPT-008** (`medio`) — Listas de transacciones/contactos sin paginación.
- **RPT-010** (`bajo`) — Fallback de costos usa IVA 16% hardcodeado si falla la query.
- **META-007** (`medio`) `[VERIFICAR]` — `getCampaigns` recalcula atribución (DB+API HL) en cada request.
- **META-008** (`bajo`) `[VERIFICAR]` — `updateRecentAds` no elimina filas obsoletas (solo upsert).
- **META-009** (`bajo`) `[VERIFICAR]` — Estado "desconectado" no apaga el cron ni lo consulta `getMetaConfig`.
- **META-010** (`bajo`) — `saveAdsToDatabase` un INSERT por anuncio sin transacción/batch.
- **PAY-004** (`medio`) `[VERIFICAR]` — Idempotency key reusada bloquea reintentos de cobro 24h.
- **PAY-007** (`medio`) `[VERIFICAR]` — Registro manual de pago no idempotente (duplicado por reintento de red).
- **PAY-009** (`bajo`) `[VERIFICAR]` — `createStripePaymentIntent` sin idempotencyKey crea intents huérfanos.
- **PAY2-011** (`bajo`) `[VERIFICAR]` — Migración manual de pagos duplicados hardcodeada (evidencia de bug de raíz).
- **GHL-008** (`bajo`) `[VERIFICAR]` — Versión de API inconsistente en export de conversaciones.
- **AUTO-010** (`bajo`) `[VERIFICAR]` — Variables `{{...}}` desconocidas se renderizan vacías sin aviso.
- **AI-006** (`medio`) `[VERIFICAR]` — Proveedor no-OpenAI sin key OpenAI: media inentendible sin aviso.
- **AI-007** (`medio`) — Re-habilitación silenciosa del runtime: el toggle global no detiene agentes publicados (kill switch).
- **NOTI-006** (`medio`) — `processDueAppointmentReminders` carga toda la tabla de sends en memoria por tick.
- **NOTI-009** (`bajo`) — Llaves VAPID autogeneradas y persistidas; rotación rompe suscripciones.

### Notas de priorización dentro de Fase 5

Algunos `alto` aterrizaron aquí por ser **decisiones de producto o de infra**, no fallas de correctitud cotidiana: **RPT-001** (costos engañosos), **INST-001/INST-002/INST-003/INST-004** (operación del Installer). Recomendación: revisarlos con producto/operaciones al inicio de Fase 5 y **promover a Fase 2** los que afecten decisiones de negocio reales (RPT-001 si el dashboard guía gasto; INST-001 si los huérfanos de Render cuestan dinero).

### Criterio de "hecho" (Fase 5)

- CORS con allowlist; media no-imagen servida como `attachment`/sandbox; firmas comparadas en tiempo constante; filtros SQL parametrizados.
- Existe `audit_log` para contacts/payments/appointments; la fusión usa `SUM`; el snippet no expone identidad por la URL.
- El dashboard prorratea costos fijos y respeta `applies_to='profit'`; las listas paginan.
- Decisiones de producto resueltas y documentadas: owner por contacto, kill switch del agente, modelo de auto-update con canary/rollback, opt-in de guardado de tarjeta.
- Geo y page_views no degradan/inflan el endpoint de tracking.

### Esfuerzo agregado estimado (Fase 5)

Agregado `medio-alto` por volumen (es la fase con más ítems), pero la mayoría son `bajo`/`medio` aislados. Puede ejecutarse de forma incremental y en paralelo con operación normal, salvo las decisiones de producto que requieren alineación previa.

---

## Recomendación de secuencia global (máximo impacto / mínimo riesgo)

El orden **no** es estrictamente "Fase 1 entera, luego Fase 2…". Para máximo impacto con mínimo riesgo de re-trabajo, se intercalan algunos cimientos de fases posteriores que **habilitan** fixes anteriores:

1. **Sprint 0 — cimientos baratos que desbloquean todo (días):**
   - Mecanismo de exclusión entre instancias (CRON-009) + runner de migraciones (DB-001). Son prerequisito de muchísimos fixes de Fase 1 y 4. Hacerlos primero evita parchar dos veces.
   - Cierres de seguridad de esfuerzo bajo y riesgo alto que no dependen de nada: AUTH-002, SEC-001, GHL-001, SEC-003, PORTAL-002, PORTAL-003, NOTI-001.

2. **Sprint 1 — detener el sangrado de dinero y datos (Fase 1 núcleo):**
   - Cobros: PAY-001, PAY-002, PAY2-001 (ya con el patrón de claim del Sprint 0), PAY2-002.
   - Datos: CNT-001→CNT-002, DB-003, GCAL-001, GHL-002, GHL-003/GCAL-003.
   - Webhooks sin firma en una sola pasada: SEC-002, WA-001, WA-004, PAY2-005, MercadoPago.

3. **Sprint 2 — flujos rotos y calendario (Fase 1 resto):**
   - APT-004→APT-001→APT-002→APT-003.
   - AUTO-001/AUTO-002 (allowlist de nodos/triggers), META-001, META-002.
   - AI-001 (con el claim del Sprint 0) + AI-004.

4. **Sprint 3 — gating y estabilidad de integraciones (Fase 2):**
   - Mapa central de features (LIC-001/ACL-001/GHL-007/LIC-002/LIC-003/LIC-004) en una pasada.
   - Confirmación multicanal (NOTI-003 con APT-005), estados WhatsApp (WA-002/WA-007/WA-009), Meta token (META-003).

5. **Sprint 4 — concurrencia/idempotencia y CI (Fase 4):**
   - Replicar claims atómicos en todos los crons (APT-009/NOTI-002/CRON-003, AUTO-003/CRON-004, CRON-002), DB-002 bajo lock, crons faltantes (CRON-005), CI contra Postgres (DB-005/PAY-006).

6. **Sprint 5+ — UX/operación y deuda (Fases 3 y 5):**
   - Feedback de errores, recuperación de cuenta, móvil (MOB-003/004/006), reportes consistentes, y la lista larga de endurecimiento defensivo y decisiones de producto, de forma incremental.

**Principio rector:** primero los **cimientos compartidos** (locking + migraciones), porque sin ellos varios fixes críticos serían parches frágiles; luego **dinero y datos irreversibles**; después **monetización/estados**; al final **experiencia y deuda**. Los ítems `[VERIFICAR]` (`requiere-verificacion-manual`) deben confirmarse en código/runtime antes de invertir esfuerzo, especialmente los que dependen del comportamiento del Installer o de que Render corra >1 instancia.
