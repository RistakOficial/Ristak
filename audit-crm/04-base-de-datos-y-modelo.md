# 04 — Base de datos y modelo

> Auditoría de producto Ristak — 22 módulos cubiertos. Este documento se enfoca en el **modelo de datos**: esquema, migraciones, índices/restricciones, integridad referencial, cascadas, duplicados, campos que la UI necesita y la DB no tiene, campos muertos, trazabilidad/auditoría, timestamps, zona horaria y multiusuario. Recoge todos los hallazgos de tipo **bug-datos** de todo el corpus, más los hallazgos estructurales del módulo DB.
>
> Convención de honestidad: los hallazgos con `verifyStatus="refutado"` **no** se listan como problemas. El más relevante aquí es **RPT-002** ("Ingresos Netos no resta reembolsos") — refutado en verificación adversarial: el reembolso muta el `status` del pago a `'refunded'` y `SUCCESS_PAYMENT_STATUSES` no lo incluye, así que el dinero ya queda excluido de ingresos; volver a restarlo sería doble deducción. Por eso no aparece como bug.
>
> Donde un hallazgo está marcado `requiere-verificacion-manual` o `verifyStatus="ajustado"`, se indica explícitamente.

---

## 1. Arquitectura del esquema (de un vistazo)

Todo el esquema vive **embebido en código**, en `backend/src/config/database.js` (~5450 líneas), como un único `initTables()` idempotente: `CREATE TABLE IF NOT EXISTS` + decenas de `ALTER TABLE ADD COLUMN` envueltos en `try/catch`. Un adaptador reescribe placeholders (`?` → `$n`) y tipos (`DATETIME` → `TIMESTAMP`, `AUTOINCREMENT` → `SERIAL`) para soportar **SQLite (dev)** y **PostgreSQL (prod en Render)**.

Hechos estructurales que condicionan todo lo demás (todos confirmados, ver DB-001…DB-005):

| Hecho | Evidencia | Consecuencia |
|---|---|---|
| **No existe runner de migraciones versionado.** `server.js:7,296` solo hace `await databaseReady = initTables()`. No hay tabla `schema_migrations` ni código que lea `backend/migrations/*.sql`. | DB-001 (`server.js:7,296`, `database.js:5408`) | Los `.sql` (`remove_payments_fk.sql`, `convert_to_timestamptz*.sql`, `cleanup_duplicate_payments.sql`) son scripts manuales que **nadie ejecuta en boot**; el esquema real diverge por cliente. |
| **Migraciones de DATOS destructivas corren en CADA boot sin lock.** `reconcileCanonicalContactPhones`, `migrateTagIdsToSlugs`, `backfillGhlContactIds`, etc. | DB-002 (`database.js:5058-5104`, `496-558`) | Fusión/borrado de contactos en el arranque; race si hay >1 instancia o solape de deploy. |
| **El aislamiento entre clientes es a nivel infra** (una DB + un Render por cliente), no por columna `tenant_id`. | módulo Multi-tenancy | El aislamiento cross-cliente se confirma sólido; los problemas de "tenant" son **dentro** de una instalación (roles). |

---

## 2. Tablas / modelos principales y relaciones

Entidades centrales y su rol:

- **`contacts`** — núcleo del CRM. Identidad por `email` (UNIQUE) y `phone` (UNIQUE). Denormaliza `total_paid` y `purchases_count`. Atribución en `attribution_ad_id`, `attribution_ctwa_clid`, `attribution_ad_name`, `visitor_id`. Vínculos externos: `ghl_contact_id`, `preferred_whatsapp_phone_number_id`.
- **`contact_phone_numbers`** — identidad multi-teléfono de un contacto.
- **`payments`** — ledger financiero. FK a `contacts` **ON DELETE CASCADE** (ver DB-003). Estados: `pending/paid/failed/void/refunded/deleted`, más `payment_mode` (`test`/`live`).
- **`payment_flows` / `installment_payments` / `payment_plans` / `subscriptions`** — planes y recurrencias. `payment_plans` y `subscriptions` usan FK **ON DELETE SET NULL** (inconsistente con `payments`).
- **`appointments`** — citas. Sin `created_at`/`updated_at` en el `CREATE` base; columnas clave (`ghl_appointment_id`, `google_event_id`, `sync_status`, `deleted_at`) añadidas por `ALTER`. `assigned_user_id` existe pero **no se usa para filtrar visibilidad**.
- **`calendars`** — calendarios Ristak/GHL/Google con `sync_status`, `googleCalendarId`.
- **`appointment_attendance_signals`** — PK = `contact_id` (problema, ver DB-008).
- **`sessions`** — una fila por evento de pixel (sin dedup, ver TRK-002).
- **`users`** — `role` (admin/employee), `access_config` JSON, `is_active`. Sin `password_changed_at`/`token_version` (impacta revocación de sesión).
- **`meta_ads`** — métricas de anuncios; `date` como **TEXT `YYYY-MM-DD`**. No persiste `impressions` (impacta CPM/CTR, ver META-001).
- **`hidden_contact_filters`** — única capa de privacidad fina de contactos; aplicada de forma inconsistente (ver §6).

Relaciones externas (claves de integración que viven como columnas, no FKs): `ghl_contact_id`, `ghl_invoice_id`, `ghl_appointment_id`, `ghl_calendar_id`, `stripe_customer_id`, `stripe_payment_intent_id`, `stripe_subscription_id`, `conekta_*`, `mercadopago_*`, `google_event_id`, `meta_conversion_event_logs`.

---

## 3. Cascadas de borrado, datos huérfanos e integridad referencial

### 3.1 `payments.contact_id` ON DELETE CASCADE — pérdida de historial financiero (DB-003, **alto**, ajustado)

`backend/src/config/database.js:2267` mantiene:

```sql
FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
```

mientras `payment_plans` (`:2368`) y `subscriptions` (`:2426`) usan **ON DELETE SET NULL**. Inconsistencia real.

- `deleteContact` (`contactsController.js:3670`) hace `DELETE FROM contacts WHERE id=?` **sin re-apuntar payments ni guard**, así que un borrado manual de contacto **destruye sus pagos** por cascade. Confirmado.
- **Matiz importante (verificación ajustada):** la afirmación de que la **fusión** de duplicados borra pagos es **inexacta**. `updateContactReferences` (`database.js:458-476`) descubre dinámicamente todas las tablas con columna `contact_id` (incluye `payments`) y **re-apunta** al ganador *antes* del `DELETE` del perdedor. El merge **no** pierde pagos vía cascade. El riesgo real es el **delete manual**, no la fusión.
- La migración `remove_payments_fk.sql` existe con la intención de quitar este FK, pero **nunca se aplicó al esquema canónico** (el FK sigue en el `CREATE`), lo que es prueba directa de DB-001.

> Impacto: borrar un contacto con compras elimina transacciones cobradas → los KPIs de revenue del dashboard cambian. Decisión de producto pendiente: `ON DELETE SET NULL` consistente, o impedir borrado de contactos con pagos.

### 3.2 Borrado de contacto es hard delete sin papelera (CNT-007, **medio**)

`deleteContact` (`contactsController.js:3642-3686`) ejecuta `DELETE FROM contacts` (CASCADE limpia relaciones). No hay `deleted_at` ni advertencia por LTV (`purchases_count>0`). La confirmación es solo escribir una palabra en el frontend. Pérdida permanente e irreversible.

### 3.3 Google → local hace HARD DELETE de citas (GCAL-001, **alto**)

`syncGoogleEventsToLocal` (`googleCalendarService.js:514-530, 601-605`): un evento Google con `status='cancelled'` dispara `deleteLocalAppointment(existing.id)` **sin** `markPendingDelete`, lo que va al `DELETE FROM appointments` (no soft-delete). Cancelar un evento en Google — **incluido uno originado en Ristak** — borra físicamente la cita local con su contacto, notas y trazabilidad. Google (secundario) gana destructivamente sobre el sistema de registro.

### 3.4 `appointment_attendance_signals` PK = `contact_id` (DB-008, **medio**, probable)

`database.js:2609-2616`: PK por `contact_id`, con `appointment_id` como columna no clave. Modela "asistió alguna vez" por contacto, **no asistencia por cita**. Un contacto recurrente con varias citas no puede registrar asistencia por cada una: la segunda señal sobrescribe (o choca por PK). Distorsiona `apptsToAttendanceRate`/`cpaAttendance`. Decidir si se requiere PK `(contact_id, appointment_id)`.

---

## 4. Duplicados potenciales y restricciones de unicidad

### 4.1 `idx_payments_ghl_invoice` NO es único (DB-006, **medio**)

`database.js:3984-3991` crea `CREATE INDEX IF NOT EXISTS idx_payments_ghl_invoice ON payments(ghl_invoice_id)` — **índice normal**, aunque `remove_payments_fk.sql` lo definía `UNIQUE`. Sin restricción sobre `ghl_invoice_id`, dos syncs concurrentes o un reintento pueden insertar el mismo invoice GHL dos veces, **inflando ingresos**. La existencia de un `DELETE` manual de duplicados de "primer pago" (`database.js:3993-4012`) y de `cleanup_duplicate_payments.sql` es evidencia de que **ya ocurrió**.

Fix: índice UNIQUE parcial `WHERE ghl_invoice_id IS NOT NULL AND ghl_invoice_id != ''` + upsert `ON CONFLICT`.

### 4.2 El sync HL→local nunca borra entidades eliminadas (GHL-002, **alto**)

`syncHighLevelContacts`, `syncHighLevelAppointments`, `invoicesSyncService` solo hacen `INSERT … ON CONFLICT DO UPDATE`. **No hay pasada de reconciliación de borrado.** Si un contacto/cita/invoice se elimina en HighLevel, su espejo local permanece para siempre como **dato zombie**, inflando `total_paid`, `purchases_count` y conteos de leads. Para invoices solo se marca `'deleted'` si el listado paginado de HL incluye ese estado, lo cual no está garantizado.

### 4.3 Check-then-insert no atómico (CNT-012 / AUTO-004)

- `createContact` (CNT-012, **bajo**): consulta existencia por email/teléfono y luego inserta. La UNIQUE protege a nivel DB, pero el error cae a un 409 genérico, no al mensaje específico. Bajo concurrencia (webhooks + UI) hay carrera.
- `automation_enrollments` (AUTO-004, **medio**, probable): `enrollMatching`/`enrollContactManually` evitan duplicados con SELECT-luego-INSERT, **sin** UNIQUE sobre `(automation_id, contact_id, status)` (`database.js:4843-4855`). La garantía `preventDuplicateActiveEnrollment` falla bajo ráfagas → contacto inscrito dos veces.

### 4.4 Dedup por teléfono cross-país confunde MX/US (CNT-005, **medio**, probable)

`buildPhoneMatchCandidates` (`phoneUtils.js:69-88`) agrega prefijos `52`/`521`/`1` a números nacionales de 10 dígitos. Dos números con los mismos 10 dígitos pero país distinto (`+1 555-…` y `+52 555-…`) generan candidatos solapados → falso duplicado / merge incorrecto. Combinado con CNT-001 (merge silencioso), puede **borrar un contacto legítimamente distinto**.

---

## 5. La fusión de contactos como punto crítico de integridad

La fusión (`mergeContactIds` en `contactIdentityService.js`) y la reconciliación de boot (`reconcileCanonicalContactPhones` en `database.js`) son los caminos más peligrosos del modelo:

| Hallazgo | Sev | Problema |
|---|---|---|
| **CNT-001** | alto | Editar el teléfono/email de un contacto al de OTRO ejecuta `mergeContactIds` que termina en `DELETE FROM contacts WHERE id = fromId` (`contactIdentityService.js:423`). **Fusiona y borra (hard delete) el otro contacto en silencio**, sin confirmación ni 409. Irreversible. |
| **CNT-002** | alto | El `UPDATE` del merge (`:372-410`) solo copia `phone/email/full_name/first_last/source/visitor_id/attribution_*/total_paid/purchases_count`. **Pierde `tags`, `custom_fields`, `ghl_contact_id` y `preferred_whatsapp_phone_number_id`** del contacto absorbido (son columnas de `contacts`, no tablas de referencia, así que `updateContactReferences` no las mueve). |
| **DB-007** | medio | En la fusión de boot, `total_paid`/`purchases_count` se combinan con `Math.max(...)` (`database.js:551-552`), **no `SUM`**. Si dos contactos tenían 500 y 300, el fusionado muestra 500 mientras la suma real de `payments` es 800. El KPI denormalizado deja de cuadrar con sus transacciones. |
| **GHL-011** | medio (probable) | `findHighLevelContactForLocal` (`highlevelSyncService.js:988-1004`) toma el **primer** candidato HL con id por email o teléfono, sin corroborar un segundo identificador. Dos contactos HL con el mismo teléfono → se liga al `ghl_contact_id` equivocado → `mergeContactIds` mezcla **dos personas distintas** (chats, pagos, citas). |

> Síntesis: el modelo no tiene una operación de merge segura. Combina hard delete, pérdida de campos no movidos, agregados con `MAX` y emparejamientos débiles. En contexto médico/CRM esto mezcla o destruye datos de clientes sin rastro.

---

## 6. Campo `hidden_contact_filters`: privacidad inconsistente y aplicación frágil

`hidden_contact_filters` es la **única** capa de privacidad fina de datos de contacto, pero su aplicación es inconsistente entre queries (evitable) y su gestión está mal restringida:

- **ACL-002 / SEC-005 (alto):** el filtro se aplica en `getContacts`, dashboard, analytics y `transactionsController`, pero **NO** en `searchContacts`, `globalSearch`, `getContactById` ni en la lista de transacciones de reportes. Un contacto "oculto" reaparece al buscarlo, abrirlo por ID/enlace, usar el buscador global o ver reportes de pagos. Evidencia: `contactsController.js:2804` (`WHERE ${searchClause.condition}` sin filtro), `:2387` (getById sin filtro/404), `searchController.js:122-123`, `reportsController.js:357-366`. **Matiz:** el filtro es **global**, no per-user/per-role; el contacto está oculto para todos en listados pero recuperable por ID por cualquier usuario/API token.
- **MOB-002 / NOTI-004 (alto):** los push de chat (`pushNotificationsService.js:1043-1054`) arman el payload con nombre del contacto + texto del mensaje y **no consultan** `hidden_contact_filters`. Un mensaje de un contacto oculto dispara push con datos sensibles a empleados que no deberían verlos.
- **ACL-003 (medio):** `/api/hidden-contacts` solo usa `requireAuth`; cualquier empleado (incluso read-only) puede crear/borrar filtros que afectan a **toda** la instalación.
- **ACL-005 / SEC-012 (bajo):** `buildHiddenContactsCondition` (`hiddenContactsFilter.js:34-55`) interpola `filter.text` directo en el SQL con escape manual de comilla simple (no parametriza, no escapa `%`/`_`). Patrón frágil; riesgo de inyección bajo hoy (input de admin) pero real.

> El "estado oculto" de un contacto **no es persistente**: es derivado de filtros aplicados ad-hoc en cada query, fácil de olvidar — por eso fuga.

---

## 7. Estados / enums por entidad y sus inconsistencias

| Entidad | Estados | Inconsistencia de datos |
|---|---|---|
| `contacts` (estado) | lead / appointment / customer | **Derivado** en `mapContactRowForResponse`, no persistido. Sin columna `owner/assigned`. |
| `appointments` | pending / confirmed / cancelled / showed / noshow / rescheduled / invalid | `'rescheduled'` no tiene semántica en ningún lado y reprogramar **no** lo setea (APT-005). `INACTIVE_APPOINTMENT_STATUSES` no contempla `'rescheduled'`. **APT-010:** `updateContactAppointmentDate` excluye solo `cancelled/canceled/invalid` pero **no `noshow`**, mientras `appointmentsMerge` sí trata `noshow` como inactivo → el contacto muestra como "próxima cita" un no-show. |
| `payments` | pending/paid/failed/void/refunded/deleted + `test`/`live` | **PAY-002 (alto):** un **reembolso parcial** de Stripe (`charge.refunded`) marca el pago como **totalmente reembolsado** (`status='refunded'`) sin comparar `amount_refunded` vs `charge.amount`. `partially_refunded` existe en `LEDGER_PAYMENT_STATUSES` pero el webhook nunca lo aplica. Distorsiona revenue y stats. |
| `meta_ads` | `date` TEXT, métricas | **META-001 (alto):** `cpm`/`ctr` se calculan con `reach` (usuarios únicos) en vez de `impressions`, y `META_INSIGHTS_FIELDS` ni siquiera pide `impressions`. Como `reach ≤ impressions`, CPM/CTR quedan **sistemáticamente inflados** y nunca reconcilian con Meta Ads Manager. |
| `automation_enrollments` | active / waiting / completed / exited | `completed` se usa tanto para fin legítimo como para fin accidental por nodo no soportado (AUTO-001). No hay estado "error reintentable". |
| `subscriptions` | active/…/deleted | **PAY-001 (alto):** `deleteSubscription` marca `'deleted'` local **sin cancelar en Stripe** (el SELECT ni trae `stripe_subscription_id`) → estado local diverge de Stripe `active` (sigue cobrando). |

---

## 8. Sobrescritura de datos por sync (last-write-wins ausente)

Patrón recurrente y peligroso: los upserts de sync pisan ediciones locales recientes porque escriben `date_updated = excluded.date_updated` **incondicionalmente**, sin comparar timestamps.

- **GCAL-003 (alto):** `upsertLocalAppointment ON CONFLICT(id)` (`localCalendarService.js:2759-2782`) fija `start_time/end_time/title/notes/address` con valores de Google (COALESCE solo evita NULL) y `date_updated` incondicional. Si el usuario editó en Ristak y el push a Google falló o no corrió, el siguiente pull trae el evento **viejo** y revierte la edición fresca. Además `deleted_at = NULL` revive una cita borrada localmente.
- **GHL-003 (alto):** el mismo `ON CONFLICT` sin guard `WHERE excluded.date_updated > appointments.date_updated`. El cron horario de HL puede bajar una versión cacheada/no propagada y pisar la edición local. No respeta `sync_status='pending'`.

> Recomendación de modelo: agregar guard last-write-wins comparando `date_updated`, o no pisar campos de citas `source='ristak'` con `google_sync_status!='synced'` / `sync_status='pending'`.

---

## 9. Atribución: sobrescritura sin respaldo ni trazabilidad

- **TRK-006 (medio):** `executeFallbackAttribution` (`attributionFallbackService.js:170-189`) hace `UPDATE contacts SET attribution_ad_id = ?` directamente, por heurística de consenso de URL (≥80%). **No guarda el valor anterior** ni marca `attribution_source='fallback'`. Es irreversible y mezcla atribución dura (gclid/fbclid) con inferida sin poder distinguirlas.
- **TRK-005 (medio):** preview y execute del fallback usan **timezone distinta** (`previewFallbackAttribution` omite la tz de GHL → default UTC), así que el admin aprueba un resultado que la ejecución cambia.
- **WA-004 / TRK-001 (alto):** atribución de contactos sobrescribible desde endpoints públicos sin firma (webhook de atribución WhatsApp y `/collect`). Corrompe `attribution_ad_id`/`ad_name` de cualquier contacto. (Detalle en el documento de seguridad; aquí cuenta como **integridad de datos de negocio**.)

---

## 10. Campos que la UI necesita y la DB no tiene / no respeta

- **`owner` / `assigned` por contacto (ACL-004, medio, decisión-producto):** no existe propietario por contacto a nivel access-user. `owner_user_id` solo es para definiciones de custom fields; `appointments.assigned_user_id` existe (`database.js:2450`) pero **nunca** se usa en un `WHERE assigned_user_id = req.user`. Cualquier empleado con módulo `contacts` ve/edita/exporta **toda** la base. La UI sugiere segmentación que el modelo no soporta.
- **Estado de sync por-cita en la agenda (GCAL-007, medio, requiere-verificacion-manual):** `google_sync_status='error'` se persiste por cita pero no se observa que la vista de agenda lo exponga; el usuario no sabe que una cita no llegó a Google.
- **Custom fields que "desaparecen" entre empleados (CNT-009, medio, probable):** `updateContact`/`bulkUpdateContactCustomFields` crean definiciones con `owner_user_id` del empleado; `listContactCustomFieldDefinitions` sin userId solo trae `owner_user_id IS NULL`. Una definición creada por A no la ve B. Dentro de un solo tenant, los custom fields deberían ser compartidos.

---

## 11. Campos muertos / artefactos / código no aplicado

- `appointments.assigned_user_id`: existe, se mapea desde HL, **no filtra visibilidad** (ACL-004).
- `remove_payments_fk.sql` / `convert_to_timestamptz*.sql` / `cleanup_duplicate_payments.sql`: scripts manuales **nunca ejecutados** por ningún runner (DB-001). El FK de payments y los timestamps naive lo demuestran.
- `cleanup_duplicate_payments.sql` (PAY2-011, bajo, requiere-verificacion-manual): `DELETE FROM payments WHERE contact_id = '<locationId hardcodeado>'` — evidencia de un bug pasado donde el sync usó `locationId` como `contact_id`. Script no idempotente y peligroso; el fix de raíz puede no estar.
- Doble definición de `appointments.google_event_id` (DB-009): aparece como `UNIQUE` de columna en el `CREATE` base y a la vez con un índice parcial, creando ambigüedad `''` vs `NULL` entre SQLite/Postgres.

---

## 12. created_at / updated_at, timestamps y zona horaria (timestamptz)

### 12.1 `appointments` base sin `created_at`/`updated_at` (DB-009, **bajo**)

El `CREATE` base (`database.js:2442-2463`) no incluye `created_at`/`updated_at`; columnas como `ghl_appointment_id`, `source`, `sync_status`, `deleted_at`, `google_*` se agregan por `ALTER` en `try/catch`. Si un `ALTER` falla por una causa no contemplada, la columna falta **silenciosamente** y los queries que la usan rompen.

### 12.2 timestamptz nunca se aplica a clientes nuevos (DB-004, **alto**, requiere-verificacion-manual)

`database.js` no usa `timestamptz` en ningún lado (0 ocurrencias); el adaptador reescribe `DATETIME → TIMESTAMP` (**without time zone**, `:214,230`). La conversión a `timestamptz` vive solo en `convert_to_timestamptz*.sql`, **sin runner** (ver DB-001). El Installer tampoco lo ejecuta al provisionar.

- **Mecánicamente confirmado** el hueco.
- **Impacto requiere verificación manual:** depende de la TZ del proceso (`server.js` importa `./config/initTimezone.js` como primera línea — probablemente fuerza UTC, lo que neutralizaría gran parte del skew) y de si los reportes agrupan en SQL por columna naive o normalizan en app. El propio auditor lo marcó `probable`/`requiere-verificacion-manual`.

### 12.3 Offset de zona horaria hardcodeado `-6h` en SQLite

Atajo recurrente que asume `America/Mexico_City` en la rama SQLite, rompiendo consistencia en cualquier tz ≠ UTC-6:

- **RPT-004 (medio):** `getGroupExpression` (`analyticsService.js:756-772`) usa `tzOffset = '-6 hours'` con un TODO admitido, mientras `resolveDateRange` filtra con la zona IANA real → agrupación desfasada en SQLite/QA.
- **TRK-008 (bajo):** `timestampLocalExpression` y `buildWeekExpression` (`trackingController.js:117-124, 1679-1685`) usan `datetime(col,'-6 hours')` fijo.
- **MOB-007 (medio, probable):** la app móvil calcula rangos y `getTodayKey()` con **hora local del dispositivo**, no la tz de la cuenta; un usuario viajando ve métricas/caché del día equivocado.

### 12.4 Reembolso parcial y mapeo de estado (recordatorio)

No es timestamp pero sí integridad temporal/financiera: ver PAY-002 en §7.

---

## 13. Trazabilidad / auditoría / historial

- **DB-010 (bajo):** **no existe** tabla de auditoría genérica (`audit_log`) que registre quién cambió/borró qué en `contacts`, `payments`, `appointments`. Solo hay logs por integración (`meta_conversion_event_logs`, `whatsapp_api_webhook_events`) y `state_history` JSON dentro de `payment_flows`. Con migraciones automáticas que **borran/fusionan contactos en boot** (DB-002), no se puede reconstruir por qué un contacto desapareció. Complica soporte, cumplimiento y depuración.

Fix mínimo recomendado: `audit_log(entity, entity_id, action, actor, diff_json, created_at)` para las tres entidades sensibles, y registrar ahí las migraciones de datos destructivas.

---

## 14. Multiusuario / owner / aislamiento dentro de la instalación

- Aislamiento **cross-cliente**: sólido (DB por cliente).
- Aislamiento **dentro** del cliente: débil a nivel de datos.
  - Sin owner por contacto (ACL-004).
  - El filtro de ocultos es global, no per-role (§6), y fuga por varios caminos.
  - `users` carece de `password_changed_at`/`token_version`, por lo que cambiar contraseña no invalida sesiones (SEC-007 / AUTH-003) — impacto de **modelo de datos**: faltan columnas para soportar revocación.

---

## 15. Tabla consolidada de riesgos de datos inconsistentes

Hallazgos **bug-datos** y estructurales del modelo, deduplicados (se citan IDs repetidos juntos). Excluye refutados (RPT-002).

| ID(s) | Sev | Riesgo de dato | Evidencia |
|---|---|---|---|
| CNT-001 | alto | Editar teléfono/email fusiona y **hard-delete** otro contacto en silencio | `contactIdentityService.js:423,441-444`; `contactsController.js:3237-3239` |
| CNT-002 | alto | Merge **pierde** tags, custom_fields, ghl_contact_id, WhatsApp preferido | `contactIdentityService.js:372-410` |
| GCAL-001 | alto | Cancelar evento en Google **hard-delete** la cita Ristak (con su historial) | `googleCalendarService.js:514-530,601-605` |
| GCAL-003 / GHL-003 | alto | Sync entrante pisa ediciones locales (sin last-write-wins) | `localCalendarService.js:2759-2782` |
| GHL-002 | alto | HL→local nunca borra entidades eliminadas → **datos zombie** inflan métricas | `highlevelSyncService.js:875-959,1199-1249` |
| META-001 | alto | CPM/CTR calculados con `reach` en vez de `impressions` → métricas infladas | `metaAdsService.js:738-739`; `constants.js:106-118` |
| PAY-002 | alto | Reembolso **parcial** marca el pago como totalmente reembolsado | `stripePaymentService.js:2706-2746` |
| PAY-001 | alto | Borrar suscripción no la cancela en Stripe (estado local diverge) | `subscriptionsService.js:868-888` |
| DB-003 | alto | `payments` FK CASCADE: borrar contacto borra su historial financiero | `database.js:2267` |
| DB-004 | alto* | timestamps `without time zone`; conversión a timestamptz nunca aplicada | `database.js:214,230` (*impacto requiere verif. manual) |
| DB-005 | alto | SQL con parámetros type-ambiguos (`CASE WHEN ?`) truena solo en Postgres prod | `sitesService.js:10363-10365` |
| DB-001 | alto | Sin runner de migraciones: esquema diverge por cliente | `server.js:7,296`; `database.js:5408` |
| DB-002 | alto | Migraciones de datos destructivas en cada boot sin lock (race) | `database.js:5058-5104,496-558` |
| TRK-001 / WA-004 | alto | Atribución/identidad de contacto sobrescribible desde endpoints públicos sin firma | `trackingController.js:858-960`; `webhooksController.js:1810-1832` |
| TRK-004 | alto | Submit público crea contactos ilimitados sin rate limit/captcha | `sitesController.js:762-772` |
| AUTO-004 | medio | Inscripción duplicada (check-then-insert sin UNIQUE) | `automationEngine.js:3355-3361`; `database.js:4843-4855` |
| CNT-005 | medio | Dedup de teléfono confunde MX/US con mismos 10 dígitos | `phoneUtils.js:69-88` |
| CNT-009 | medio | Custom fields segmentados por owner "desaparecen" entre empleados | `contactsController.js:3224-3229` |
| GHL-011 | medio | Emparejamiento WhatsApp→HL liga/fusiona el contacto equivocado | `highlevelSyncService.js:988-1004` |
| GCAL-004 | medio | Eventos all-day de Google a medianoche UTC → desfase de día | `googleCalendarService.js:462-466` |
| DB-006 | medio | `idx_payments_ghl_invoice` no único → invoices GHL duplicados | `database.js:3984-3991` |
| DB-007 | medio | Fusión usa `MAX` en vez de `SUM` para `total_paid`/`purchases_count` | `database.js:551-552` |
| DB-008 | medio | `appointment_attendance_signals` PK=`contact_id` (1 señal por contacto) | `database.js:2609-2616` |
| APT-010 | bajo | `updateContactAppointmentDate` no excluye `noshow` | `localCalendarService.js:2935-2950` |
| TRK-002 | medio | Sin dedup de sesiones; `session_end`/reenvíos inflan page_views | `trackingService.js:371-520` |
| TRK-005 | medio | Fallback attribution: preview vs execute usan tz distinta | `attributionFallbackService.js:211-214,137-140` |
| TRK-006 | medio | Fallback sobrescribe `attribution_ad_id` sin backup ni flag | `attributionFallbackService.js:170-189` |
| WA-005 | medio | Inferencia de dirección por defecto a `inbound` guarda salientes como entrantes | `whatsappApiService.js:3914-3941` |
| WA-007 | medio | `failed` terminal bloquea `delivered`/`read` posteriores | `whatsappApiService.js:316-351` |
| PAY2-011 | bajo* | Migración hardcodeada: pagos mal atribuidos con `locationId` como `contact_id` | `cleanup_duplicate_payments.sql:1-16` (*req. verif. manual) |
| DB-009 | bajo | `appointments` sin `created_at/updated_at`; `google_event_id` doble-definido | `database.js:2442-2463,2527-2552` |
| DB-010 | bajo | Sin `audit_log` para contacts/payments/appointments | `database.js:5058-5104` |
| MOB-007 | medio | Fechas/caché móvil usan hora local del dispositivo, no tz de la cuenta | `PhoneApp.tsx:251-260,714-720` |

\* Impacto/raíz pendiente de verificación manual según la auditoría adversarial.

---

## 16. Conclusión y prioridades de modelo

El modelo de Ristak es funcional pero acumula **deuda estructural concentrada en cuatro frentes**:

1. **Operación de merge insegura** (CNT-001/002, DB-007, GHL-011): hard delete + pérdida de campos + agregados con `MAX` + emparejamiento débil. Es el riesgo de integridad #1 dentro de una instalación.
2. **Sync sin last-write-wins ni reconciliación de borrado** (GCAL-001/003, GHL-002/003): el sistema externo gana destructivamente y deja zombies; las ediciones locales se pierden.
3. **Ausencia de gobierno del esquema** (DB-001/002/004): sin runner de migraciones, sin lock en migraciones de datos de boot, sin timestamptz garantizado. El esquema real diverge por cliente y los `.sql` "de migración" son letra muerta.
4. **Privacidad y multiusuario a nivel de datos** (ACL-002/004, §6, falta de `owner`, falta de `audit_log`): el filtro de ocultos fuga por varios caminos y no hay segmentación por usuario ni trazabilidad de cambios.

Acciones de mayor retorno, en orden: (a) introducir un runner de migraciones con `schema_migrations` y mover las migraciones de datos a él con `pg_advisory_lock`; (b) reescribir `mergeContactIds` para unir tags/custom_fields y `SUM` agregados, y exigir confirmación antes de cualquier borrado de contacto; (c) añadir guard last-write-wins y reconciliación de borrado en los syncs; (d) aplicar el filtro de ocultos en `getContactById`/búsqueda/reportes/push y mover el reembolso parcial a `partially_refunded`.
