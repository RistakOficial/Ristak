# 07 — Testing Recomendado

> Auditoría de producto del CRM **Ristak**. Este documento define qué se debe probar, cómo, y con qué prioridad, partiendo de los hallazgos confirmados del corpus de auditoría y de los `testGaps` declarados por cada módulo. No se incluyen como bugs los hallazgos refutados en verificación adversarial (el único refutado del corpus final es **RPT-002**: los "ingresos netos" ya excluyen pagos `refunded`, así que restar reembolsos otra vez sería doble deducción).

---

## 1. Estado actual de las pruebas

**Resumen honesto: prácticamente no hay cobertura automatizada.**

La única pista de testing en todo el corpus es la mención de `backend/test/licenseService.test.mjs`. No aparece ningún otro archivo de test, ninguna suite de integración, ningún job de CI que ejecute pruebas, y ninguna referencia a un runner (Jest/Vitest/Mocha) montado sobre los flujos críticos del negocio.

Esto no es un detalle menor. La auditoría documenta una clase de bug **sistémica y recurrente** que solo existe porque no se prueba contra el entorno real:

- **PAY-006 / DB-005 (confirmados):** El commit `5fbf9d159` parchó varios `could not determine data type of parameter` en queries de pagos que **funcionaban en SQLite local pero crasheaban en Postgres de producción**. El propio mensaje de commit dice que es "el mismo enfoque que el fix de $41 del calendario", revelando que el patrón ya se había roto antes. El desarrollo/QA corre sobre SQLite; producción corre Postgres. **Hay queries con tipos ambiguos que solo explotan en prod y nadie las atrapa antes.** Ejemplo aún sin parchear citado en el corpus: `sitesService.js:10363-10365` (`CASE WHEN ? THEN 0 ...`).

- **DB-001 (confirmado):** No existe runner de migraciones versionado. Los `.sql` en `backend/migrations/` (`convert_to_timestamptz.sql`, `remove_payments_fk.sql`, `cleanup_duplicate_payments.sql`) **nunca se ejecutan en boot**; son scripts manuales. El esquema real diverge entre clientes y eso no se valida en ningún test.

| Aspecto | Estado actual |
|---|---|
| Tests unitarios | Solo `licenseService.test.mjs` (1 archivo) |
| Tests de integración | Ninguno detectado |
| Tests E2E | Ninguno detectado |
| CI con tests contra Postgres | Ninguno (corre SQLite, oculta bugs de prod) |
| Pruebas de concurrencia / multi-instancia | Ninguna (origen de AI-001, CRON-001/003/004, GHL-005, etc.) |
| QA de seguridad / webhooks sin firma | Ninguna (SEC-001/002, WA-001/004, PAY2-005) |

**Conclusión:** la confiabilidad del producto hoy depende de revisión manual y de que producción "no toque la rama rota". Dado que se cobra dinero real (Stripe/Conekta/MercadoPago), se agendan citas médicas y se manejan datos de pacientes, la ausencia de pruebas es el riesgo transversal más grave de toda la auditoría.

---

## 2. Propuesta de estrategia de pruebas

La propuesta se organiza por tipo. La regla de oro, derivada directamente de PAY-006/DB-005, encabeza todo:

> **Toda prueba de backend que toque la base de datos DEBE correr contra PostgreSQL real en CI, no solo SQLite.** SQLite es para desarrollo; Postgres es producción. Mientras la suite corra solo en SQLite, seguirá pasando con bugs que truenan en prod.

### 2.1 Unitarios

Funciones puras y lógica de cálculo, sin red ni DB. Alto valor, bajo costo.

- **Normalización de licencia:** `normalizeLicenseFeatures` (LIC-003, LIC-004): `{allowed:true}` sin `features` NO debe activar todas (failure-open confirmado); `{reports:true, advanced_reports:false}` debe preservar `advanced_reports=false`.
- **Cálculo financiero:** `computeFinancialSnapshot` (RPT-001, RPT-003, RPT-010): prorrateo de costos fijos por rango, manejo de `applies_to='profit'`, fallback de error sin IVA hardcodeado del 16%. **Regresión de reembolsos (RPT-002, refutado):** verificar que un pago `refunded` salga del bucket de ingresos exitosos y NO se reste dos veces (los ingresos ya lo excluyen porque el reembolso muta el status a `refunded`).
- **Métricas Meta:** CPM/CTR con `impressions` real (META-001): `reach=0` no divide por cero; CPM = `(spend/impressions)*1000`.
- **Teléfonos:** `buildPhoneMatchCandidates` (CNT-005): `+1` y `+52` con los mismos 10 dígitos NO deben colisionar.
- **Estados de entrega WhatsApp:** `pickBestMessageDeliveryStatus` (WA-007): `failed` transitorio seguido de `delivered` con timestamp posterior.
- **Inferencia de dirección:** `inferMessageDirection` (WA-005): sin hints cargados no debe defaultear a `inbound`.
- **Renderizado de plantillas:** `renderTemplate` (AUTO-010): token desconocido detectable, no silenciosamente vacío.

### 2.2 Integración (backend + DB Postgres real)

Controllers/services con base de datos real, mocks solo para APIs externas (Stripe/GHL/Meta/WhatsApp). Aquí vive la mayor parte del valor.

- **Queries Postgres con parámetros ambiguos (PAY-006/DB-005):** ejercer todas las ramas con `CASE WHEN ?`, `? IS NULL`, `COALESCE(?...)` contra Postgres. Esta es la prioridad #1 de integración.
- **Idempotencia / claim atómico de crons** (CRON-001/002/003/004, PAY-008, PAY2-001): dos invocaciones concurrentes de la misma función no deben cobrar/enviar dos veces.
- **Webhooks de pago:** firma, dedupe por `event.id`, reembolso parcial vs total (PAY-002, PAY-005, PAY2-005).
- **Merge de contactos:** preservación de tags/custom_fields/ghl_id, sin borrado silencioso (CNT-001, CNT-002, DB-007).
- **Filtro de contactos ocultos** aplicado en TODOS los caminos de lectura (ACL-002, SEC-005).

### 2.3 End-to-end (E2E)

Navegador real contra el stack completo (frontend + backend + DB). Pocos, caros, reservados a los flujos de dinero y de primer arranque.

- Cliente paga un link público `/pay/:id` con tarjeta (Stripe/MP/Conekta) y la página refleja `paid`.
- Agendar cita desde el admin → aparece en la agenda → recordatorio programado.
- Reserva pública por URL → contacto creado → conversión disparada.
- Primer arranque móvil: tenant → login → push onboarding.

### 2.4 QA manual (checklist humano)

Lo que es caro automatizar pero barato verificar a mano cada release:

- Probar las **4 familias de tema (Aurora/Onyx/Brut/Nimbus) × claro/oscuro**, en especial Onyx (regla dura del design system).
- Recorrer cada pantalla premium con un plan que NO incluya la feature: debe avisar "no incluido en tu plan", no mostrar ceros ni romperse (LIC-005, MOB-009).
- Verificar mensajes de error reales al usuario (CNT-003, CNT-004, PORTAL-008).

### 2.5 Regresión

Por cada bug confirmado que se corrija, un test que falle ANTES del fix y pase DESPUÉS. Particularmente:

- NOTI-001 (crítico): fallo de OpenAI no debe cancelar citas confirmadas.
- SEC-001 (crítico): proxy GHL restringido.
- MOB-001 (crítico): resolución de tenant en Android.
- Toda la familia de dobles cobros/dobles mensajes por concurrencia.

### 2.6 Integraciones externas

Contra sandboxes oficiales donde existan (Stripe test mode, Meta test events, Conekta test keys); contra mocks/stubs grabados donde no (GHL, YCloud, Google Calendar). Probar específicamente:

- Token expirado/revocado: el cron no debe crashear el proceso, debe degradar y avisar (META-003, RPT-007, GHL-010).
- Proveedor caído a mitad de operación: rollback/compensación (PAY-003).
- Webhook sin firma o sin secret configurado: debe rechazar, no procesar (WA-001, SEC-002, PAY2-005).

### 2.7 Permisos (autorización)

El control de acceso por rol/módulo es solo de UI en varios routers; la API queda abierta. Probar como **employee restringido llamando la API directo**:

- Cada router sin `requireModuleAccess` debe responder 403, no 200 (ACL-001, ACL-006, GHL-007).
- `getContactById` y la API externa deben respetar contactos ocultos (SEC-005, ACL-002).
- API externa no debe exponer `users` ni permitir el proxy GHL arbitrario (SEC-001, SEC-006).
- Empleado no-admin: 403 en `POST/DELETE /api/hidden-contacts` (ACL-003).
- Demo del Installer no debe enviar WhatsApp real ni mutar Meta (PORTAL-001).

### 2.8 Errores (resiliencia y feedback)

- Fallo de proveedor a media operación: no perder datos, no dejar acción huérfana (CNT-008, AUTO-005, PAY-003).
- Mensajes/recordatorios fallidos deben quedar visibles y reintentar (WA-009, NOTI-008, GCAL-002).
- Listas grandes no deben tumbar el proceso de 512MB (RPT-008, CNT-010).

### 2.9 Móvil / responsivo

- Android nativo: resolución de tenant contra CORS del installer (MOB-001, crítico).
- `/phone/login` con correo de otro tenant (MOB-003).
- Push nativo con token lento >16s (MOB-005).
- Zona horaria del dispositivo distinta a la del negocio (MOB-007).
- Push de chat de contacto oculto en pantalla de bloqueo (MOB-002, NOTI-004).

---

## 3. Casos de prueba concretos por flujo crítico

> Convención: cada caso es numerado y autocontenido. **HP** = happy path. Los demás cubren los escenarios pedidos (sin integración conectada, token expirado, datos inválidos, zona horaria distinta, edición/cancelación con propagación externa, duplicados, refresco de página, persistencia de IDs externos). Cada caso referencia el hallazgo o `testGap` que lo motiva.

### 3.1 Crear cita con Google Calendar

Hallazgos base: APT-001, APT-002, APT-003, APT-004, APT-005, GCAL-001, GCAL-002, GCAL-003, GCAL-004, GCAL-005, GCAL-006.

1. **(HP)** Crear cita desde el admin en un calendario vinculado a Google → se guarda local, se hace POST a Google y **se persiste `google_event_id`** en la fila de la cita.
2. **(Sin integración)** Calendario solo-Ristak (sin Google ni GHL): crear cita funciona; bloquear un horario tiene efecto real (hoy **APT-004**: los blocked slots dependen 100% de GHL y la lista sale vacía sin avisar).
3. **(Doble-booking admin)** Calendario con `appoinmentPerSlot=1`: crear dos citas en el mismo `startTime` desde el modal → la segunda debe rechazarse con 409 (hoy **APT-001**: ambas se guardan).
4. **(Concurrencia pública — TOCTOU)** Dos `POST /public/:slug/appointments` simultáneos al mismo slot → solo uno tiene éxito, el otro 409 (**APT-002**).
5. **(Datos inválidos)** `endTime <= startTime`, slot en el pasado, slug inexistente → rechazo con mensaje claro.
6. **(Zona horaria distinta)** Agendar desde un navegador en zona distinta a la de la cuenta cerca de medianoche → la cita queda en la fecha/hora elegida por el usuario, no desplazada (regresión del commit reciente `e630312c0`). Repetir en create, edit y reserva pública.
7. **(Edición/reprogramar + propagación)** Editar la hora de una cita → PATCH del evento en Google con la nueva hora **y** se reprograma el recordatorio (hoy **APT-003**: el recordatorio nunca se reenvía para la nueva fecha; **GCAL-003**: el pull entrante no debe pisar la edición local).
8. **(Cancelar + propagación)** Marcar estado `cancelled` vía PUT → se cancela en Google **y en GHL** (hoy **APT-006**: GHL puede quedar viva).
9. **(Cancelación remota destructiva)** Cancelar/borrar el evento EN Google → la cita Ristak debe marcarse `cancelled`, **NO hard-delete** (hoy **GCAL-001**: borrado silencioso con pérdida de contacto/notas).
10. **(Conflicto bidireccional)** Editar la cita en Ristak, fallar el push a Google, correr el pull → la edición local más reciente debe sobrevivir (`event.updated` vs `date_updated`) (**GCAL-003**).
11. **(Reintento de error)** Cita con `google_sync_status='error'` → debe reintentarse automáticamente (hoy **GCAL-002**: no hay cron, estado terminal).
12. **(Evento all-day)** Importar evento all-day de Google en cuenta UTC-6 → debe caer en el día correcto, no el anterior (**GCAL-004**).
13. **(Import sin contacto)** Cita creada directamente en Google → definir y verificar comportamiento: ¿se liga/crea contacto?, ¿dispara recordatorio? (hoy **GCAL-006**: entra huérfana sin triggers).
14. **(Desconexión)** Desconectar Google en la app → debe revocar token / avisar al Installer y limpiar `googleCalendarId` de los calendars locales (hoy **GCAL-005**: solo borra config local).
15. **(Refresco de página)** Tras crear/editar, recargar la agenda → la cita persiste con su estado y `google_event_id` correctos.

### 3.2 Login + licencia

Hallazgos base: AUTH-001, AUTH-002, AUTH-003, AUTH-004, AUTH-005, AUTH-006, AUTH-010, LIC-003, LIC-005, LIC-008, LIC-009, SEC-004, SEC-007.

1. **(HP)** Login con usuario/email/teléfono + contraseña correcta y licencia activa → 200, JWT en localStorage, entra a `/dashboard`.
2. **(Fuerza bruta)** N intentos fallidos seguidos contra `/login`, `/sso`, `/setup` → debe bloquear/retrasar (hoy **AUTH-001/SEC-004**: sin rate limiting, ilimitado).
3. **(Sin integración / portal caído)** License enforced y portal central caído: política `strict` sin cache vigente → bloquea; política `grace` dentro de `graceHours` → permite con último allowed (testGaps Licencia).
4. **(Token / licencia incompleta — failure-open)** Portal responde `{allowed:true}` SIN campo `features` → NO debe activar todo el plan premium (hoy **LIC-003**: otorga todas las features).
5. **(Downgrade parcial)** Portal envía `{reports:true, advanced_reports:false}` → el cliente NO accede a `/api/reports` (hoy **LIC-004**: el padre pisa la sub-feature).
6. **(Usuario inactivo)** Login de `is_active=0` → rechazado; desactivar a un empleado corta su acceso en el **siguiente request** (requireAuth re-lee la DB).
7. **(JWT robado / cambio de password)** Cambiar la contraseña NO debe dejar válido un JWT previo robado; logout debe invalidar server-side (hoy **AUTH-003/SEC-007**: el JWT vive 30 días sin revocación).
8. **(Secreto por defecto)** Instancia sin `NODE_ENV=production` → no debe firmar JWTs con `ristak-default-secret-change-me`; un token forjado con ese secreto debe rechazarse (**AUTH-004**).
9. **(Política de contraseña)** `setup`/`changePassword` con `123456` o con `new == current` → debe rechazarse (hoy **AUTH-005**: solo exige length>=6).
10. **(Setup concurrente — TOCTOU)** Dos `POST /setup` concurrentes con token válido → solo se crea UN primer usuario (**AUTH-006**).
11. **(SSO reuso)** Token de SSO ya usado en otra pestaña → segundo intento falla; camino `needs_setup` no debe dejar el token reutilizable (testGaps SSO).
12. **(return_path malicioso)** `/sso` con `return_path` tipo `//evil` o `/api/...` → debe sanearse.
13. **(Cambio de plan en sesión)** Cliente hace upgrade durante la sesión → la UI refleja la nueva feature sin re-login (hoy **LIC-008**: solo se captura al login; `/api/license/status` está muerto).
14. **(Feature gating en backend)** Llamar directo `/api/transactions`, `/api/stripe`, `/api/sites` con un plan que NO incluye esa feature → debe 403 (hoy **LIC-001**: responden 200, bypass de monetización).
15. **(403 feature en frontend)** Recibir `feature_not_available` → la app muestra "no incluida en tu plan", no un error genérico (**LIC-005**).
16. **(Recuperación de cuenta)** Verificar el flujo de "olvidé mi contraseña" para un dueño no técnico (hoy **AUTH-010**: solo existe el comando de Render Shell, y **AUTH-002** expone `admin/admin123`).
17. **(Crons bajo licencia suspendida)** Con licencia bloqueada, verificar si los crons premium (Meta sync, automatizaciones) siguen corriendo (hoy **LIC-009**: el gating solo cubre rutas HTTP, no el runtime de fondo).

### 3.3 Cobro Stripe + webhook

Hallazgos base: PAY-001, PAY-002, PAY-003, PAY-004, PAY-005, PAY-006, PAY-007, PAY-008, PAY-009.

1. **(HP)** Cliente paga `/pay/:id` con tarjeta → PaymentIntent → webhook firmado `payment_intent.succeeded` → pago pasa a `paid`, stats del contacto actualizados, **`stripe_payment_intent_id` persistido**.
2. **(Firma inválida)** Webhook con firma incorrecta → 400/401, no se procesa.
3. **(Webhook duplicado / refresco)** Reenviar el mismo `event.id` dos veces → no se reprocesa ni se hace segunda llamada a Stripe para guardar tarjeta (hoy **PAY-005**: sin dedupe por evento).
4. **(Reembolso parcial)** `charge.refunded` con monto parcial → estado `partially_refunded` y monto reembolsado registrado, NO `refunded` total (hoy **PAY-002**: marca todo como reembolsado, infla pérdidas).
5. **(Reembolso total)** `charge.refunded` por el total → `refunded`.
6. **(Clicks concurrentes / refresco de página)** Abrir el link en dos pestañas e iniciar el intent dos veces → no deben quedar PaymentIntents huérfanos confirmables; solo uno ligado (hoy **PAY-009**: sin `idempotencyKey`).
7. **(Pago manual duplicado por reintento de red)** Dos `POST /api/transactions` con los mismos datos (sin id) → no deben crearse dos filas (hoy **PAY-007**: id nuevo en cada request, sin dedupe).
8. **(Parcialidades — reintento dentro de 24h)** Cobro off_session que falló transitoriamente → reintento del cron debe hacer un cobro real, no devolver el error cacheado de Stripe (hoy **PAY-004**: `idempotencyKey` fija bloquea el reintento ~24h).
9. **(Parcialidades — concurrencia)** Dos réplicas/ticks corriendo el cron sobre la misma parcialidad vencida → no debe cobrar dos veces (claim atómico) (**PAY-008**, **CRON-002**).
10. **(Suscripción — eliminar con propagación)** Eliminar una suscripción Stripe sin cobros registrados → debe cancelarse EN Stripe antes de marcar `deleted` local; verificar que `stripe_subscription_id` se incluye en el SELECT (hoy **PAY-001**: sigue facturando al cliente).
11. **(Suscripción — fallo de INSERT local)** Forzar fallo del INSERT tras crear la suscripción en Stripe → debe cancelarse/compensar en Stripe (hoy **PAY-003**: queda huérfana cobrando).
12. **(Persistencia de IDs externos)** Tras cada operación, verificar que `stripe_customer_id`, `stripe_payment_intent_id` y `stripe_subscription_id` quedan guardados y consistentes.
13. **(Postgres real)** Ejecutar planes/parcialidades/suscripciones contra Postgres → ningún `could not determine data type of parameter` (**PAY-006**).

### 3.4 Automatización con WhatsApp

Hallazgos base: AUTO-001, AUTO-002, AUTO-003, AUTO-004, AUTO-005, AUTO-006, AUTO-007, WA-001, WA-002, WA-008, WA-009, CNT-006.

1. **(HP)** Disparador (mensaje entrante / pago / etiqueta) → inscribe contacto → nodo WhatsApp envía plantilla aprobada → contacto recibe el mensaje.
2. **(Nodo no soportado lineal)** Publicar flujo con un nodo que el motor no ejecuta (ej. `action-update-contact-field`) → debe rechazarse al publicar o no romper el flujo en silencio (**AUTO-001**).
3. **(Nodo ramificado no soportado)** Flujo `Disparador → Aleatorizador(50/50) → WhatsApp en cada rama` → inscribir un contacto: NO debe quedar `completed` sin enviar nada (hoy **AUTO-001**: el motor pide handle `out` que no existe y corta todo).
4. **(Disparador sin evento)** Automatización con `trigger-facebook-comment` / `trigger-instagram-comment` / `trigger-click-to-whatsapp` / `trigger-facebook-ad-click` → debe ejecutarse o ser rechazada al publicar (hoy **AUTO-002**: queda muerta sin aviso).
5. **(Sin integración conectada)** WhatsApp API no conectado → el envío del nodo falla de forma controlada y visible, no silenciosa.
6. **(Webhook sin firma)** Inyectar un mensaje entrante falso a `/webhook/whatsapp-api/ycloud` sin firma cuando no hay `webhook_secret` → debe rechazarse 401, no disparar automatizaciones/IA/contactos (hoy **WA-001**).
7. **(Token expirado / plantilla no aprobada)** Plantilla no `APPROVED` enviada por nombre sin snapshot local → no debe asumir que es válida (**WA-008**); plantilla `PENDING` sin QR fallback → el usuario debe ver el motivo del fallo (**NOTI-008**).
8. **(Datos inválidos)** Contacto sin teléfono enrolado en flujo de WhatsApp → advertir/contar antes de enviar, no fallar item por item en silencio (**CNT-006**).
9. **(Variable mal escrita)** Mensaje con `{{nombre_contacto}}` en vez de `{{first_name}}` → el editor avisa antes de publicar; no se envía "Hola ," vacío (**AUTO-010**).
10. **(Concurrencia — reanudación de esperas)** Dos ticks/instancias procesando el mismo enrollment `waiting` vencido → no debe duplicar el envío (claim atómico) (hoy **AUTO-003**/**CRON-004**).
11. **(Inscripción duplicada por carrera)** Dos eventos casi simultáneos del mismo contacto → no debe crear dos enrollments activos (**AUTO-004**).
12. **(Envío QR con destinatario offline)** `sendMessage` devuelve `key.id` pero no llega ack en 20s → NO debe reportar fallo ni perder el mensaje; reenvío no debe duplicar (hoy **WA-002**).
13. **(Mensaje saliente fallido)** Envío API que falla sin fallback QR → debe persistirse como `failed` y aparecer en el chat con opción de reintento (hoy **WA-009**: desaparece).
14. **(Fallo transitorio a media secuencia)** WhatsApp/email lanza error temporal en un nodo → el enrollment debe poder reintentar, no quedar `exited` definitivo (**AUTO-005**).
15. **(Pausar/reanudar)** Pausar una automatización con contactos en espera por duración y republicar → los contactos deben continuar, no quedar `exited` perdidos (hoy **AUTO-007**).
16. **(Objetivo)** Contacto que cumple la meta (ej. ya pagó) → debe salir del flujo o tomar la rama "cumplido"; quien no cumple va por "no cumplido" (hoy **AUTO-006**: siempre toma "cumplido").
17. **(Refresco de página)** Recargar el editor tras publicar → el flujo persiste con sus nodos y estado `published`.

### 3.5 Sync HighLevel

Hallazgos base: GHL-001, GHL-002, GHL-003, GHL-005, GHL-006, GHL-007, GHL-009, GHL-011, GHL-012, GHL-010, GHL-004, GHL-008.

1. **(HP)** Guardar `locationId` + Private Integration Token válido → valida con `GET /locations/:id`, arranca sync, importa contactos/citas/invoices/conversaciones.
2. **(Token en texto plano / fuga)** Verificar que `api_token` se cifra en reposo y que `GET /config/reveal/api_token` NO lo devuelve a un empleado sin rol admin (hoy **GHL-001**: en claro y accesible a cualquier sesión).
3. **(Permisos de API)** Empleado restringido llamando `reveal token`, `record-payment`, `text2pay` directo → debe 403 (hoy **GHL-007**: solo `requireAuth`).
4. **(Sin integración / token con scopes parciales)** Token que pasa `/locations/:id` pero sin scope de calendarios/conversaciones → debe avisar qué módulos no funcionarán, no fingir "conexión exitosa" (**GHL-010**).
5. **(Borrado en HL)** Contacto / invoice / cita borrados en HighLevel → tras full sync deben marcarse/eliminarse local; el invoice borrado no debe seguir contando en `total_paid` (hoy **GHL-002**: solo upsert, nunca borra).
6. **(Conflicto de edición — propagación)** Editar una cita en Ristak y correr el cron con datos viejos de HL → la edición local más reciente debe sobrevivir; `sync_status='pending'` no debe ser pisado (hoy **GHL-003**: pisa sin last-write-wins).
7. **(Concurrencia / multi-instancia)** Dos `syncHighLevelData` concurrentes → no deben duplicar contactos ni corromper merges; un lock debe impedir la segunda ejecución (hoy **GHL-005**: sin lock global).
8. **(Checkpoint de conversaciones)** Si N mensajes fallan al guardar, el checkpoint no debe avanzar más allá del primero fallido; el siguiente run los recupera (hoy **GHL-006**: avanza siempre, pierde mensajes).
9. **(Emparejamiento WhatsApp→HL)** Dos contactos HL con el mismo teléfono → no deben fusionar al contacto WhatsApp equivocado; match solo por teléfono parcial debe rechazarse (hoy **GHL-011**).
10. **(Paginación)** Una página con un item repetido en el borde → no debe cortar el resto de la importación si hay `nextToken`/`hasMore` (hoy **GHL-012**: corte prematuro).
11. **(Acoplamiento Meta)** Verificar que el sync de HL NO mute silenciosamente la config de Meta Ads en cada cron (hoy **GHL-009**: `reconcileMeta` sobrescribe `meta_config`).
12. **(Persistencia de IDs externos)** Tras el sync, verificar `ghl_contact_id`, `ghl_invoice_id`, `ghl_appointment_id`, y que las citas Google→HL capturen `googleEventId` para no duplicar (hoy **GHL-004**: no se captura).
13. **(Postgres real)** Correr el sync completo contra Postgres → sin errores de tipo de parámetro.

### 3.6 Atribución pixel

Hallazgos base: TRK-001, TRK-002, TRK-004, TRK-005, TRK-006, TRK-007, TRK-009, WA-004.

1. **(HP)** Visitante carga página con pixel → `POST /collect` crea sesión con UTMs/click IDs/geo; al detectar `_ud` se liga al contacto y se unifican los `visitor_id`.
2. **(Identidad falsificada — seguridad)** `POST /collect` con `contact_id` de una víctima y un `visitor_id` propio → NO debe reescribir la identidad del contacto ni reasignar sus sesiones (hoy **TRK-001**: contamina atribución y cruza identidades; endpoint público sin firma/origen).
3. **(Atribución pública sin firma)** `POST /webhook/whatsapp/attribution` sin secreto/firma → debe rechazarse; no debe pisar `attribution_ad_id` existente sin prioridad (hoy **WA-004**).
4. **(Datos inválidos)** payload sin `data`, `event_name` desconocido, `ts` en el futuro/pasado → manejo robusto.
5. **(Dedup de sesiones / refresco)** Reenvío idéntico por keepalive/`beforeunload` (mismo `session_id`+`event_name`) → no debe inflar page_views; `session_end` no debe contarse como visita (hoy **TRK-002**).
6. **(Spam de formularios)** 100 submits/seg a `/api/sites/public/submit` desde una IP → deben limitarse (rate limit/honeypot/captcha); submit a sitio no publicado → 404 (hoy **TRK-004**: sin throttle, crea contactos ilimitados + gasta CAPI).
7. **(Fallback attribution — preview vs execute)** Contacto creado a las 23:30 hora local cerca del borde de día → preview y execute deben coincidir (hoy **TRK-005**: preview omite la zona de GHL); no debe sobrescribir atribución dura (gclid/fbclid) existente.
8. **(Reatribución irreversible)** `executeFallbackAttribution` debe guardar el `attribution_ad_id` original y marcar la fuente como `fallback` para poder auditar/revertir (hoy **TRK-006**).
9. **(Trigger links)** GET por link-scanner/prefetch (HEAD, user-agent bot) → no debe inflar `click_count` ni disparar automatización; `contact_id` inexistente en query no debe propagarse (hoy **TRK-007**).
10. **(Zona horaria distinta)** Cuenta con zona != UTC-6 en SQLite → agrupaciones de visitantes por periodo deben coincidir con el filtro de rango (hoy **TRK-009**/**RPT-004**: offset `-6h` hardcodeado en SQLite).
11. **(Unificación concurrente)** Dos `/collect` simultáneos para el mismo contacto → race en `unifyVisitorIds` sin corromper identidades.

### 3.7 Bulk de contactos

Hallazgos base: CNT-001, CNT-002, CNT-003, CNT-004, CNT-005, CNT-006, CNT-011, CNT-012, DB-003, DB-007.

1. **(HP)** Acción masiva (plantilla WhatsApp / automatización) sobre N contactos seleccionados → se crea el lote, se procesa con drip, progreso visible.
2. **(Merge silencioso — editar teléfono)** Editar el teléfono de B al de A → NO debe borrar A en silencio; debe pedir confirmación o devolver 409 con opción de fusionar (hoy **CNT-001**: hard-delete del otro contacto sin aviso).
3. **(Merge — preservación de datos)** Fusionar contactos donde el absorbido tiene tags/custom_fields/`ghl_contact_id`/WhatsApp preferido → no deben perderse (hoy **CNT-002**); `total_paid`/`purchases_count` deben quedar como la SUMA real de payments, no el MAX (hoy **DB-007**).
4. **(Dedup cross-país)** Crear `+1 555-123-4567` y luego `+52 555-123-4567` → NO deben tratarse como el mismo contacto; `521` (WhatsApp MX) vs `52` canónico SÍ matchean (**CNT-005**).
5. **(Duplicado al crear)** Crear contacto con email/teléfono ya existente → 409, y el frontend muestra el mensaje real del backend ("ya existe con ese correo/teléfono"), no un toast genérico (hoy **CNT-003**).
6. **(Duplicado al editar email)** Editar el email de un contacto al de otro (UNIQUE) → 409 amigable, no 500 genérico (hoy **CNT-004**).
7. **(Carrera de creación)** Dos `POST /contacts` concurrentes con el mismo email/teléfono → la UNIQUE protege y se devuelve 409 con mensaje claro, no genérico (**CNT-012**).
8. **(Contactos sin teléfono en lote WhatsApp)** Seleccionar contactos sin teléfono para un lote de plantilla → conteo/aviso previo antes de mandar (**CNT-006**).
9. **(Idempotencia de lote bajo réplicas)** Con varias instancias procesando el cron del lote → un item no se envía dos veces; pausar a mitad detiene pendientes; reanudar continúa sin reenviar completados.
10. **(Bulk delete — UX y datos)** Borrar decenas de contactos → progreso incremental y cancelable (hoy **CNT-011**: secuencial sin feedback); y verificar que el borrado **no destruye el historial financiero** del contacto (hoy **DB-003**: `payments.contact_id` es `ON DELETE CASCADE`).
11. **(Refresco de página)** Recargar a mitad de un lote → el estado del lote (scheduled/processing/completed/error) persiste y refleja el avance real.
12. **(Persistencia de IDs externos)** Tras crear/editar/fusionar, verificar que `ghl_contact_id` y `visitor_id` quedan consistentes y no se duplican filas por `ghl_invoice_id` (**DB-006**).

---

## 4. Cierre

La prioridad de implementación debe seguir el riesgo confirmado:

1. **Crítico, ya:** NOTI-001 (cancelar citas por fallo de OpenAI), SEC-001 (proxy GHL), MOB-001 (Android sin login). Tests de regresión inmediatos.
2. **Dinero / concurrencia:** toda la familia de dobles cobros/dobles mensajes (CRON-001/003/004, PAY-001/002/003, PAY2-001, AI-001/AI-004). Requieren tests de integración concurrentes contra Postgres.
3. **Infraestructura de pruebas:** montar CI con **Postgres real** (cierra PAY-006/DB-005) y un runner de migraciones versionado (DB-001) antes de seguir agregando features.
4. **Seguridad/permisos:** suite de "employee restringido pega la API directo" (ACL-001/002/006, GHL-007, SEC-005) y webhooks sin firma (SEC-002, WA-001/004, PAY2-005).

Sin estas pruebas, cada deploy es una apuesta. Con ellas, la clase de bug "pasa en local, truena en prod" deja de ser invisible.
