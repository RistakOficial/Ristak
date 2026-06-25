# Resumen Ejecutivo — Auditoría de Producto del CRM Ristak

> Documento maestro de la auditoría. Cubre **22 módulos** auditados con verificación adversarial de cada hallazgo. Severidades y `verifyStatus` reflejan la revisión real del código; los hallazgos refutados (p. ej. RPT-002 sobre reembolsos) **no** se listan aquí. Todos los `verifyStatus` distintos de `confirmado` se señalan explícitamente.
>
> **Conteo deduplicado:** el corpus crudo repite hallazgos entre módulos (dos auditores ven el mismo defecto). Aquí se consolidan citando ambos IDs — p. ej. "cron sin claim atómico" = AUTO-003 / CRON-004, y "JWT 30 días sin revocación" = AUTH-003 / SEC-007. Cuando este documento dice "el problema X", se refiere a la entrada consolidada, no a cada copia.

---

## 1. Veredicto de salud general

**¿Es operable en producción hoy? Sí, pero con riesgos serios y un par de defectos que pueden causar daño real e irreversible.**

Ristak es un producto ambicioso y, en su mayoría, funcional: el aislamiento entre clientes es sólido a nivel de infraestructura (una DB y un Render por cliente), el cifrado de secretos de integraciones está bien hecho, la verificación de firma de Stripe es correcta, y varios crons (mensajes programados, automatizaciones de pago) usan el patrón de reclamo atómico correcto. **No** es un sistema roto.

Pero la auditoría confirma un patrón sistémico que recorre todo el código: **mucha lógica de fondo (crons, recordatorios, agente IA, sync) corre dentro del proceso web sin locking distribuido, y la idempotencia se resuelve de forma desigual.** Esto, combinado con endpoints públicos sin firma y un caso donde una caída de OpenAI cancela citas reales, deja la operación expuesta a duplicados de cobro/mensaje, fuga de datos privados y pérdida de registros de negocio.

Lo más grave es operacional, no de seguridad pura: **un fallo de un tercero (OpenAI) puede cancelar citas de pacientes que sí confirmaron** (NOTI-001), y **corregir un teléfono puede borrar silenciosa e irreversiblemente otro contacto con todo su historial** (CNT-001).

### Termómetro por módulo

| Módulo | Estado | Lectura |
|---|---|---|
| Autenticación / Sesión / SSO | 🟠 Con riesgos | Sin rate limiting, JWT 30 días irrevocable, reset público a `admin/admin123` |
| Licenciamiento / Feature flags | 🟠 Con riesgos | Plan saltable por API directa; failure-open al otorgar features |
| Multi-tenancy / Roles / Aislamiento | 🟠 Con riesgos | Aislamiento infra sólido; control por módulo evitable por API; ocultos fugan |
| Contactos (CRUD/dedup/merge) | 🔴 Roto | Merge silencioso borra contactos y pierde tags/custom fields |
| Citas y calendarios locales | 🟠 Con riesgos | Doble-booking; recordatorios que no se reenvían al reprogramar |
| Google Calendar (sync) | 🟠 Con riesgos | Cancelar en Google hace HARD DELETE local; sin cron de sync |
| HighLevel (sync) | 🟠 Con riesgos | Token en claro y revelable; nunca borra entidades eliminadas |
| Meta Ads | 🟠 Con riesgos | CPM/CTR mal calculados; Campaign Builder no crea campañas |
| WhatsApp (API/QR) | 🔴 Roto | Webhook sin firma; QR falso-negativo con duplicados; sin lock multi-instancia |
| Pagos Stripe | 🟠 Con riesgos | Borrar suscripción no cancela en Stripe; reembolso parcial → total |
| MercadoPago / Conekta | 🔴 Roto | Doble cobro Conekta sin idempotencia; Conekta sin webhook (pagos colgados) |
| Automatizaciones | 🟠 Con riesgos | Nodos/triggers publicables que nunca corren; doble ejecución de esperas |
| Agentes IA | 🟠 Con riesgos | Doble respuesta/acción multi-instancia; sin kill switch confiable |
| Tracking / Sites / Atribución | 🟠 Con riesgos | `/collect` y submit público sin auth/throttle; atribución manipulable |
| Notificaciones / Recordatorios | 🔴 Roto | Caída de OpenAI cancela citas; push expone contactos ocultos |
| Dashboard / Reportes / Costos | 🟠 Con riesgos | Costos fijos sin prorrateo (contradice la UI); métricas inconsistentes |
| App móvil (Capacitor) | 🟠 Con riesgos | Android no puede loguear (CORS); push fuga contactos ocultos |
| Modelo de datos / Migraciones | 🟠 Con riesgos | Sin runner de migraciones; migraciones destructivas en cada boot |
| Seguridad / Secretos / Privacidad | 🔴 Roto | Proxy GHL arbitrario (crítico); webhooks sin firma; sin rate limiting |
| Installer (provisioning/updates) | 🟠 Con riesgos | Instalación fallida deja recursos cobrando; auto-update sin canary |
| Installer (license/OAuth/demo/móvil) | 🟠 Con riesgos | Demo opera sobre WhatsApp/Meta reales; tokens de firma reutilizables |

**Leyenda:** 🟢 OK · 🟠 Con riesgos (operable, con deuda real que debe atenderse) · 🔴 Roto (hay caminos que producen daño real: pérdida de datos o de dinero).

No hay ningún módulo en verde. Esto no significa que todo esté mal: significa que **cada área tiene al menos un hallazgo confirmado que un cliente real puede pegar** en operación normal.

---

## 2. Riesgos sistémicos (los patrones que se repiten)

Estos no son bugs aislados; son decisiones de arquitectura que reaparecen en módulo tras módulo. Atacarlos de raíz cierra docenas de hallazgos a la vez.

### 2.1. Crons multi-réplica / solape de deploy sin locking distribuido
Todos los crons corren dentro del proceso web (`startRuntimeServices`), con guards en memoria (`running`) que **solo protegen dentro de un proceso**. No hay `pg_advisory_lock` ni leader-election (CRON-009). El modelo se apoya en que Render corra exactamente 1 instancia, pero render.yaml no lo fija y el deploy zero-downtime mantiene la instancia vieja + nueva vivas hasta 295s. En esa ventana se duplican:
- **Cobros Conekta** sin Idempotency-Key → doble cargo real (CRON-001 / PAY2-001, confirmado).
- **Recordatorios de WhatsApp** porque el registro anti-duplicado ocurre después del envío (CRON-003 / NOTI-002, confirmado).
- **Reanudación de esperas de automatización** → doble mensaje/acción (CRON-004 / AUTO-003, confirmado).
- **Sesiones QR de WhatsApp** que se reemplazan en bucle (WA-003, confirmado).
- **Respuestas del agente IA** y `create_payment_link` (AI-001 + AI-004, confirmado el patrón).

*Matiz honesto:* GHL-005 (full sync HL) se ajustó a severidad media porque el modelo es 1 instalación por cliente; el blast radius real de varios de estos es el solape de deploy, no réplicas permanentes — pero el defecto arquitectónico (ausencia de lock) está confirmado en código.

### 2.2. Endpoints públicos sin verificación de firma
Múltiples webhooks/endpoints públicos aceptan payloads sin autenticar, mutando datos de negocio:
- Webhook YCloud sin `webhook_secret` procesa cualquier payload (WA-001).
- Webhook de atribución WhatsApp sobreescribe atribución de cualquier contacto (WA-004).
- Webhooks de pago/contacto/refund/appointment sin firma (SEC-002).
- Webhook MercadoPago acepta sin secret (PAY2-005).
- `/collect` y submit público de Sites sin auth/throttle (TRK-001, TRK-004).

### 2.3. Aislamiento de datos dentro del tenant: el control por rol es decorativo
El aislamiento **entre** clientes es sólido (infra). El problema es **dentro** del cliente: `requireModuleAccess` se aplica router por router y faltan routers (ACL-001), `getContactById` ignora el filtro de contactos ocultos (SEC-005 / ACL-002), el push de chat re-expone contactos ocultos con nombre y texto (NOTI-004 / MOB-002), y las rutas de HighLevel no replican el control de módulo del frontend (GHL-007). El rol que el admin cree haber acotado se salta con DevTools.

### 2.4. Sincronización de integraciones sin reconciliación ni resolución de conflicto
El sync nunca borra entidades eliminadas en HL (GHL-002), pisa ediciones locales sin last-write-wins (GHL-003, GCAL-003), Google cancela citas haciendo HARD DELETE local (GCAL-001), y no hay cron de Google (GCAL-002). Los datos divergen de la realidad y se pierden cambios del usuario.

### 2.5. Manejo de tokens y secretos
JWT de sesión de 30 días sin revocación; cambiar contraseña no invalida sesiones (AUTH-003 / SEC-007). Token de HighLevel guardado en claro y revelable por cualquier usuario autenticado (GHL-001). Master key de cifrado que puede terminar en la misma DB que protege (SEC-003). En el Installer, la llave de cifrado de las Render API Keys se deriva de `JWT_SECRET`: rotarlo inutiliza updates/cancelación de TODAS las instalaciones (INST-004).

### 2.6. Funcionalidad anunciada que no produce resultado
Campaign Builder nunca crea campañas en Meta (META-002). Nodos y triggers del editor de automatizaciones que el motor no ejecuta y publican sin error (AUTO-001, AUTO-002). El flag `auto_update_on_push` del Installer es código muerto (INST-002). El cron de planes MercadoPago existe pero nunca arranca (CRON-005).

---

## 3. TOP 10 problemas más importantes

Priorizados por severidad confirmada × impacto real (dinero, pérdida de datos irreversible, fuga de PII, daño operativo).

| # | ID | Título | Severidad | Módulo | Impacto en una línea |
|---|---|---|---|---|---|
| 1 | NOTI-001 | Caída de OpenAI cancela citas confirmadas (fallback `ambiguous`) | **Crítico** | Recordatorios/Confirmaciones | Un fallo de un tercero cancela citas de pacientes que SÍ confirmaron. |
| 2 | SEC-001 | Proxy arbitrario a GoHighLevel con un solo API token | **Crítico** | Seguridad | Cualquier token de bajo privilegio controla TODA la cuenta GHL (leer/escribir/borrar). |
| 3 | MOB-001 | CORS del Installer bloquea login en Android nativo | **Crítico** | App móvil | La app Android no puede iniciar sesión a nadie en producción (confirmado; materialización depende de runtime). |
| 4 | PAY2-001 / CRON-001 | Doble cobro Conekta: sin Idempotency-Key ni claim atómico | Alto | Pagos MP/Conekta | El cliente final puede ser cobrado dos veces en su tarjeta, irreversible. |
| 5 | PAY2-002 | Conekta sin webhook: pagos 3DS/OXXO/SPEI nunca se reconcilian | Alto | Pagos MP/Conekta | Pagos cobrados que jamás aparecen como pagados; sin comprobante ni factura. |
| 6 | CNT-001 | Editar teléfono/email fusiona y BORRA otro contacto en silencio | Alto | Contactos | Corregir un dato destruye otro registro de cliente con su historial, sin aviso ni papelera. |
| 7 | PAY-001 | Eliminar suscripción NO la cancela en Stripe | Alto | Pagos Stripe | El cliente sigue siendo cobrado mes a mes por una suscripción que el operador cree eliminada. |
| 8 | GCAL-001 | Cancelar evento en Google hace HARD DELETE de la cita en Ristak | Alto | Google Calendar | Una acción en Google borra la cita del CRM con contacto, notas y trazabilidad. |
| 9 | NOTI-004 / MOB-002 | Push de chat expone contactos ocultos (nombre + mensaje) | Alto | Notificaciones / Móvil | Empleados restringidos reciben en su celular nombre y texto de conversaciones que no deben ver. |
| 10 | LIC-001 / LIC-003 | Plan premium saltable por API y failure-open al otorgar features | Alto | Licenciamiento | Se sirven features cobradas sin pagarlas; una respuesta incompleta del portal abre todo el plan. |

**Menciones de honor (alto, fuera del top por blast radius):** WA-001 (webhook YCloud sin firma), WA-004 (atribución manipulable sin firma), TRK-004 (submit público sin throttle → spam ilimitado de contactos + CAPI), SEC-002/SEC-004 (webhooks sin firma + sin rate limiting), AUTH-001 (sin rate limiting en login), GHL-001 (token HL en claro), META-002 (Campaign Builder inoperante), DB-003 (borrar contacto destruye su historial financiero), INST-001 (instalación fallida deja recursos de Render cobrando).

---

## 4. Qué arreglar primero (acciones inmediatas)

Cinco acciones que cortan el mayor daño confirmado con el menor esfuerzo relativo.

1. **Parar la cancelación de citas por fallo de IA (NOTI-001 — esfuerzo bajo, severidad crítica).**
   En `processConfirmationWindow`, cuando `classifyConfirmationResponse` devuelve `null` (sin API key / error / timeout), marcar la ventana como `error`/`human_needed` y **nunca** ejecutar `cancel_appointment`. Separar "sin clasificación" de "clasificado como ambiguo". Es un cambio pequeño que evita destruir citas reales, especialmente en contexto médico.

2. **Cerrar el proxy arbitrario de GoHighLevel (SEC-001 — esfuerzo medio, severidad crítica).**
   Restringir `POST /api/external/highlevel/request` a una allowlist explícita de paths/métodos de solo lectura, exigir rol admin y registrar auditoría. Hoy un API token de bajo privilegio = control total de la cuenta GHL del cliente.

3. **Hacer idempotentes los cobros y los envíos de los crons sensibles (CRON-001/003/004 — esfuerzo medio).**
   Enviar Idempotency-Key estable a Conekta (`ristak:{paymentId}:off-session-charge`, como ya hace Stripe) y convertir las transiciones a `processing`/envío en reclamos atómicos (`UPDATE ... WHERE status='scheduled'` con `changes>0`) **antes** de cobrar/enviar. Replicar el patrón de `claimScheduledMessage` que ya existe. Esto cierra doble cobro, doble recordatorio y doble ejecución de automatizaciones.

4. **Tapar la fuga de contactos ocultos y el control de acceso por API (NOTI-004/MOB-002, SEC-005/ACL-002, ACL-001 — esfuerzo medio).**
   Aplicar el filtro de contactos ocultos en `getContactById`, búsqueda, búsqueda global, reportes y **en el envío de push**; y montar `requireModuleAccess` en los routers que hoy solo tienen `requireAuth` (tracking, config, products, attribution, chat, HighLevel). La privacidad y los roles hoy son decorativos por estos caminos.

5. **Añadir rate limiting y firma a la superficie pública (AUTH-001, SEC-002/SEC-004, WA-001/WA-004, TRK-004, PAY2-005 — esfuerzo bajo-medio).**
   Montar `express-rate-limit` en login/SSO/setup, OAuth y API externa; y exigir secreto/firma (rechazar 401 si falta) en todos los webhooks que mutan datos. Sin esto, login es forzable, los formularios públicos se llenan de spam y cualquiera inyecta pagos/contactos/atribución falsos.

> **Nota de producto sobre CNT-001 y PAY-001:** ambos son daño irreversible (borrado de contacto, cobro fantasma) con `requiresDecision`. Aunque no son "esfuerzo bajo", deben entrar en el primer sprint con una decisión explícita: pedir confirmación antes de fusionar contactos por edición de teléfono, e incluir `stripe_subscription_id` en el borrado de suscripción para cancelar en Stripe.

---

*Auditoría con verificación adversarial. Los hallazgos marcados `requiere-verificacion-manual` (p. ej. AI-002 sobre el gate de feature del agente conversacional, LIC-007, GCAL-007, GHL-004, META-007/009) requieren confirmación en runtime antes de actuar; se reflejan como tales en los documentos por módulo. El hallazgo RPT-002 (reembolsos no restados) fue **refutado** en verificación y no se considera un problema.*
