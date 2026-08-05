# External API Access

Ristak exposes token-protected endpoints under `/api/external` for authorized external systems.

This document covers the customer-facing external API and MCP exposed by an
installed Ristak app. Internal support access for agents lives in Ristak
Installer; use `docs/support-mcp-operations.md` when Raul asks to inspect a
customer account, logs, chats, database rows, or production errors.

OAuth de proveedores externos no pertenece a esta API. La conexion de Meta usa
Facebook Login for Business, handoff de Installer y broker de webhooks descritos
en [`META_OAUTH.md`](./META_OAUTH.md). Sus rutas `/api/meta/oauth/*` son internas
de la interfaz de Ristak y no autentican clientes MCP ni integraciones de terceros.

## Identity model

- `App ID` identifies this Ristak instance and is safe to share with integration partners.
- `API token` is the secret credential and must be handled like a password.
- Each authenticated Ristak user can have one active API token.
- Creating, rotating, revoking and using API tokens requires the `developers`
  feature (`settings_api_access` in legacy permission names).
- Tokens are opaque secrets generated with `crypto.randomBytes(32)`.
- The database stores only the SHA-256 hash, prefix, last four characters, creation time, last-used time, and revocation time.
- Rotation immediately invalidates the previous token.
- Revocation clears the stored hash and disables external access for that user.
- MCP does not use the REST/OpenAPI token. Clients connect through OAuth 2.1,
  authorize with the user's normal authenticated Ristak session, receive scoped
  access/refresh credentials and appear as a revocable connection under
  `Configuración > Developers`.
- An OAuth connection inherits the current user identity. It never becomes a
  system administrator and never preserves access after the user, permission or
  license loses that capability.

## REST/OpenAPI setup

1. Go to `Configuración > Developers`.
2. Copy the `App ID`.
3. Generate or rotate the API token and copy it immediately.
4. Send requests with:

   ```http
   Authorization: Bearer ristak_live_...
   ```

5. Use the schema URL if the external client supports OpenAPI:

   ```text
   https://YOUR_RENDER_DOMAIN/api/external/openapi.json
   ```

## MCP setup

1. While logged into Ristak, open `Configuración > Developers > Conectar con MCP`.
2. Use this remote server URL:

   ```text
   https://YOUR_RENDER_DOMAIN/api/mcp
   ```

   MCP clients use the built-in OAuth discovery endpoints. Ristak's authorization
   screen uses the normal web session and asks the user to consent to the
   requested scopes. No REST/OpenAPI token is generated, copied or stored.

   Codex registers the remote server and starts OAuth with:

   ```sh
   codex mcp add ristak --url "https://YOUR_RENDER_DOMAIN/api/mcp"
   codex mcp login ristak
   ```

   For ChatGPT, use a space or Work mode that supports MCP plugins/connectors.
   For Claude, use `Settings > Connectors > Add custom connector`; Claude Code
   can register the same Streamable HTTP endpoint through its configuration or
   CLI. In every case, log into Ristak when OAuth opens, review the scopes and
   approve or deny the connection.

## MCP control plane

`/api/mcp` is the customer-facing remote MCP server. It uses Streamable HTTP and
OAuth 2.1 with PKCE. Codex, ChatGPT, Claude and any compatible remote client use
the same server URL; `tools/list` returns the exact tools available to the user
who authorized that connection.

The MCP is a typed control plane over Ristak's business services, not a generic
route proxy and not unrestricted SQL. The current registry contains 373 typed
tools before authorization filtering. `GET /api/api-access/mcp/status` and
`tools/list` report only the subset visible to the current user, plan, modules
and granted scopes. It also removes tools whose provider is not connected in
this Ristak installation; `tools/call` repeats that connection check so a stale
catalog cannot bypass it. The registry covers these operational domains:

- contacts, CRM search, tags, custom fields and trigger links;
- inbox, conversations, outbound messages and conversational chatbot operation;
- calendars, availability, appointments and automations;
- payments, payment links/plans, products, prices and subscriptions;
- dashboard summaries, reports, analytics, attribution and web tracking;
- campaigns, ads, ad sets, performance, spend, attribution, pixels, pages,
  social profiles and other Meta assets already supported by the account,
  visible only when the corresponding Meta connection exists. The MCP may read
  and refresh/synchronize this data, but it deliberately omits campaign-draft
  creation and preview tools so an AI cannot create or modify campaigns in Meta;
- media library assets, folders, storage usage, signed local-file uploads to
  Bunny.net, signed replacements, temporary ZIP downloads and permitted
  lifecycle actions;
- business costs, WhatsApp templates, mobile preferences and safe integration
  status;
- Sites lifecycle, imported HTML files, preview and controlled publication.

Ristak Installer also has a private support delegation endpoint at
`POST /api/internal/customer-operations/mcp`. It is not a customer-facing MCP
URL and does not accept OAuth or normal user sessions. It only accepts a short
HMAC request signed with the installation identity, timestamp, one-time nonce
and installation ID. Installer uses it to run the same typed registry when an
authorized Ristak operator must help a named managed customer without installing
an MCP client inside that account.

The expanded operational set includes contact journeys and bulk field updates,
persistent WhatsApp/template and automation batches with list/get/pause/resume/
reschedule/cancel/delete lifecycle, multimedia WhatsApp sends,
read-state and channel preferences, payment subscriptions, complete operational
payment coverage and transfer-proof decisions, appointment reminders, Google
Calendar synchronization, automation
folders/catalogs/tests, Site submissions/video analytics, Media folders/assets,
tracking configuration and sessions, account settings, notification preferences
and selected user administration. User creation is passwordless from the
administrator's point of view: `settings_user_invite` sends a 48-hour activation
link directly through the account's connected email, the recipient creates the
password, and the MCP never receives the link, token or password. Pending
invitations can be listed or revoked.

Every advertised tool has an explicit output schema, OAuth security declaration
and read/destructive/open-world/idempotency annotations. `mcp_search_capabilities`
provides deterministic discovery by intent, domain, access and risk so clients do
not need to load or guess the entire catalog. Its ranking normalizes common
Spanish/English action and entity terms, ignores filler words and prioritizes
matches in the tool name; phrases such as `crear un contacto`, `crear un
calendario`, `crear una plantilla de mensaje` and `agendar una cita` therefore
select the corresponding mutation before loosely related tools.

### Payment tools

The `payments` domain contains 61 typed tools and mirrors the supported
operational payment matrix rather than exposing provider routes generically:

- payment automation settings can be read and partially updated for reminders,
  receipts and failed-payment notices. These tools expose only safe automation
  fields; checkout configuration, fiscal identity, Gigstack tokens and other
  secrets stay outside the MCP;
- offline plans create the complete local installment schedule without a
  gateway. Due installments are picked up by the durable payment-automation job,
  sent through the channels configured in Payment Settings and remain pending
  until an operator records the received payment;
- new gateway plans are available for Stripe, Conekta and Rebill. The legacy
  `payments_create_plan` name remains only as a compatibility entry for HighLevel
  invoice schedules; new clients should choose the provider-specific tool;
- one-time hosted payment links are available for Stripe, Conekta, Mercado Pago,
  Rebill and CLIP;
- saved methods can be listed for Stripe, Conekta and Rebill, Stripe methods can
  be refreshed, and an existing saved card/source can be charged through the
  provider's canonical idempotent controller;
- HighLevel invoice creation, send, manual payment reconciliation, single-invoice
  sync and Text2Pay are available when HighLevel is connected;
- transaction statistics, summaries, facets, HighLevel invoice sync, safe
  deletion, local/manual registration, send, refund, void and transfer-proof
  decisions use the same protected services as the product UI;
- products, prices and recurring subscriptions continue through their existing
  typed tools.

Mercado Pago is deliberately not advertised for new installment plans because
that backend capability is disabled; it remains available for one-time links and
subscriptions. CLIP supports one-time links, not plans. Configuration secrets,
webhooks and public checkout actions that accept card tokens are not MCP tools.
Provider connection and credential setup still use
`integrations_connection_handoff`; ordinary payment-automation preferences use
`payments_get_automation_settings` and
`payments_update_automation_settings`.

Every provider-specific tool declares the exact local connection prerequisite,
commercial feature and OAuth scope. Payment mutations require an
`idempotencyKey`; calendar dates are interpreted in the business timezone and
providers resolve the account currency through the canonical backend services.
Capability search understands Spanish and English payment concepts including
`pago`, `cobro`, `plan`, `parcialidad`, `offline`, `recordatorio`, `enlace`,
`tarjeta`, `transferencia`, `comprobante`, `reembolso` and `suscripción`.

Payment metadata edits cannot change payment status. Recording a payment uses
`ristak.execute`; refunds, voids and payment-plan cancellation/deletion use
`ristak.destructive` so a write-only client cannot cross those boundaries.

New product actions must enter the MCP through the same registry with an input
schema, output contract, module/feature gate, OAuth scope, risk annotation and
auditable executor. "Exponer todo" never means bypassing controllers, writing
directly into protected ledgers, leaking secrets, managing infrastructure,
transporting passwords or bypassing the authenticated user-administration rules.

### Scopes and execution rules

- `ristak.read`: reads and searches.
- `ristak.write`: creates or updates Ristak-owned data.
- `ristak.execute`: causes an external or irreversible side effect such as
  sending a message, publishing a Site or registering a payment action.
- `ristak.destructive`: deletes, revokes, refunds, cancels or performs another
  destructive operation.

The granted scope is necessary but not sufficient. On every `tools/list` and
`tools/call`, backend re-checks all of these:

1. active OAuth token and current active user;
2. `developers` plus the commercial feature for the resource;
3. the user's module access (`read`, `write` or `admin` as required);
4. the OAuth scope declared by the tool;
5. the required provider connection, when the tool depends on one.

OAuth consent is the human authorization boundary. Once the user grants the
requested scopes to a client, that client calls permitted tools directly without
a second approval screen, `confirm` flag or action ticket. Ristak still performs
all checks above on every call, and write tools require an `idempotencyKey` so a
network retry cannot repeat the action. Expanding scopes, reconnecting after a
revocation or authorizing another client still requires the normal OAuth consent
flow.

Business dates are interpreted with the account timezone and new monetary
records use `account_currency` when the caller does not provide a valid explicit
currency. An MCP client must not infer either value from its own computer.

### Building HTML Sites from Codex, ChatGPT or Claude

Custom HTML and the native block editor are deliberately separate authoring
modes. An agent building a bespoke landing must not approximate that layout with
dozens of native blocks. If the client has a website-building skill or local
authoring workflow, it should use that capability to create the complete source
and use the Ristak MCP only for validation, persistence, preview and controlled
publication.

The preferred low-latency code-first lifecycle is:

1. `sites_create_html_draft` creates a code-first draft and runs the complete
   validation itself. It requires a complete
   HTML document and rejects scripts, inline `on*` handlers and `javascript:`
   URLs because Ristak removes them for security. The page must solve its design
   with HTML, CSS and supported declarative Ristak elements.
2. `sites_open_html_live_preview` creates a signed one-hour preview URL. Open it
   once; it polls a lightweight revision every 750 ms and reloads itself after a
   saved edit. It has no tracking, real submissions, bookings or payments.
3. `sites_patch_html_draft` is the normal iteration path. It sends only exact
   `search`/`replacement` fragments, applies them sequentially to the latest
   HTML and requires the declared occurrence count to match. `expectedRevision`
   is optional for this patch tool; the server still reads a current revision
   and rechecks it inside the imported-Site mutation lock before writing.
4. `sites_get_code` is needed when entering an existing Site or when an exact
   patch no longer matches. Send a specific `path` to read only that file; do not
   fetch the full source after every successful patch.
5. `sites_replace_html_draft` remains the whole-document route for large
   rewrites. It requires `expectedRevision` because it can overwrite every part
   of the selected file.
6. `sites_validate_html` remains available as an optional no-write preflight;
   calling it immediately before `sites_create_html_draft` is redundant because
   create runs the same authoring checks.
7. `sites_preview_html` still returns the inert HTML directly for MCP clients
   that need source instead of the auto-refreshing browser view.
8. `sites_publish` remains a separate `ristak.execute` action and executes
   directly when that scope has already been granted.

`sites_create_draft` and the block tools are for the native Ristak visual editor,
native forms and native components. `sites_update_code` remains available for
multi-file or already-published code changes, but it is intentionally
high-impact, requires `ristak.execute`, an `idempotencyKey` and revision checks
because a published Site can change immediately.

HTML creation and mutation responses are compact and typed: they return the Site
identity, editor mode, revision, file inventory without source duplication,
detected-form summary, quality report, sanitizer report and the recommended next
tools. MCP mutations request the compact backend response and do not hydrate
blocks or submissions that the authoring client will discard. The initial create
response never echoes the full source back multiple times.

The live-preview URL is a short-lived bearer link signed with Ristak's internal
database-backed context key. Its public response uses `no-store`,
`Referrer-Policy: no-referrer` and `noindex`; altering or expiring the token fails
closed. The URL must not be logged or copied into durable documentation.

### Receiving messages

An agent can list the inbox, inspect a contact conversation and answer through
the channels connected in Ristak. Ristak also stores a durable, per-OAuth-grant
event inbox for chat and payment changes. `mcp_events_list` returns only events
created after that grant was authorized, still permitted by the user's current
module access and license, with an opaque cursor. Once processed,
`mcp_events_acknowledge` marks them handled only for that grant and is idempotent.

MCP does not initiate an unsolicited request into a closed
Codex/ChatGPT/Claude session. A client that needs continuous reception must poll
`mcp_events_list` from its own runtime, or use Ristak automations/webhooks for an
event-driven flow. This closes event loss between sessions without pretending a
closed chat can be awakened.

### Retention and control-plane cleanup

The system maintenance job runs at startup and every six hours under a
distributed lock. It expires user invitations, deletes expired idempotency
records and 30-day MCP business events, retains terminal invitations for 90 days
and audit records for 180 days. During rolling upgrades it also expires and
removes historical action-approval rows created by older versions; current MCP
tools never create new ones. Event, acknowledgement, invitation, historical
approval and OAuth control tables are blocked from generic REST/MCP table
queries; only their dedicated internal routes may access them.

### Uploading a local file to Bunny.net

`media_prepare_bunny_upload` uses `ristak.execute` and an `idempotencyKey`.
The MCP request carries only the file name, MIME, exact byte count, SHA-256,
optional Media folder and visibility; it never carries Base64 or the Bunny API
key. This avoids the MCP JSON limit and lets Codex, ChatGPT, Claude or another
local client stream large files from the computer.

The returned contract contains `uploadUrl`, `method=POST`, `fileField=file` and
the temporary `X-Ristak-Media-Upload-Ticket` header. The client sends one
multipart file with those values. For example, after the MCP client has placed
the returned values in local shell variables:

```bash
curl --fail-with-body --request POST "$UPLOAD_URL" \
  --header "X-Ristak-Media-Upload-Ticket: $UPLOAD_TICKET" \
  --form "file=@$FILE_PATH;type=$FILE_MIME"
```

The ticket expires after 10 minutes, is single-purpose and is not placed in the
URL. Before multipart parsing, Ristak re-checks the active user, OAuth grant,
Developers access, Media write access and the current plan. After receiving the
temporary file it verifies exact size, declared MIME and SHA-256, then uses the
same quota, MIME detection, folder isolation, idempotency and Bunny Storage
pipeline as the Media library. Replaying the same authorized bytes is safe;
changing bytes or destination under the same upload identity is a conflict.

The MCP idempotency ledger stores only an `ephemeral` marker for this tool, not
the temporary header. If a client loses the response or lets it expire, it must
request a new pass with a new `idempotencyKey`. Revoking or changing the OAuth
connection invalidates a still-pending pass.

`media_prepare_bunny_replace` uses the same signed multipart transport but binds
the pass to one existing `assetId` and the exact replacement bytes. The upload
route invokes the canonical Media replacement operation instead of creating a
second asset. `media_prepare_archive_download` accepts up to 50 asset IDs and
returns a signed, 10-minute download URL; that route re-checks the user, active
OAuth grant, Developers, Media access and current license before streaming the
canonical ZIP archive. Neither flow returns Bunny credentials or embeds file
bytes in MCP JSON.

### Integration handoffs and continuity

Connection-dependent tools are visible only when their local provider is ready:
WhatsApp, Email, HighLevel, Google Calendar, payments, Meta social and Meta Ads
are evaluated independently. `integrations_connection_handoff` returns either a
Ristak settings URL or the normal Google OAuth start URL; it never returns or
accepts provider secrets. Supported disconnects reuse the canonical integration
controllers and require administrator access plus `ristak.destructive`.

`mcp_runtime_continuity` reports which jobs, published automations and provider
workers continue inside Ristak after the AI client closes. The MCP server cannot
wake a closed Codex, ChatGPT or Claude conversation; persistent behavior must
live in Ristak automations/jobs or in an external runtime that polls or receives
webhooks.

### Connections and audit

`Configuración > Developers > Conectar con MCP` shows server health, effective
domains/tool count, setup instructions, OAuth connections and last use. Revoking
a connection invalidates its refresh/access path immediately without affecting
the user's separate REST/OpenAPI token.

The status response publishes the account's audit URL. MCP calls record the
authenticated user, client, tool, risk level, result and timing; payloads are
redacted so credentials, authorization headers, passwords, tokens and protected
secrets do not enter the audit trail.

## License gates

The external API and MCP are backend-gated. Hiding buttons in the UI is not the
security boundary.

- `/api/external` requires a valid API token and the `developers` feature.
- Individual endpoints also require the feature of the resource being accessed:
  `payments` for transactions/payment tables, `payment_plans` for installment
  plans, `subscriptions` for subscription resources, `reports` for reports,
  `campaigns`/`meta_ads` for Meta data, `appointments`/`google_calendar` for
  calendars and appointments, `sites` for Sites/tracking/form tables,
  `contacts` for CRM contact data and `integrations` for HighLevel proxy calls.
- `/api/mcp` requires OAuth access plus `developers`. The tools list is filtered
  by plan, current user permissions and granted scopes; execution re-checks the
  same gates. MCP does not expose generic table writes; `/api/external/data`
  remains a separate REST surface with its own allowlists and feature checks.
- `/api/internal/customer-operations/mcp` is the narrow support exception to the
  `developers` surface gate. It does not unlock Developers for the customer and
  does not bypass the feature or user permission of any business tool. It only
  removes `settings_api_access` from MCP control tools so Installer can discover
  the valid catalog; contacts still require `contacts`, appointments require
  `appointments`, Sites require `sites`, and so on.
- A token minted before a downgrade does not bypass the current plan; feature
  checks run on every request.

## Available endpoints

### Credential management

- `GET /api/api-access`
- `POST /api/api-access/token/rotate`
- `DELETE /api/api-access/token`
- `GET /api/api-access/mcp/status`
- `GET /api/api-access/mcp/connections`
- `GET /api/api-access/mcp/audit`
- `DELETE /api/api-access/mcp/connections/{id}`

### MCP and OAuth

- `POST /api/mcp`
- `GET /api/mcp`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /api/oauth/register`
- `GET /api/oauth/authorize`
- `POST /api/oauth/authorize`
- `POST /api/oauth/token`

### Installer support delegation

- `POST /api/internal/customer-operations/mcp` — HMAC only; not public OAuth.

### External data API

- `GET /api/external/me`
- `GET /api/external/dashboard/metrics`
- `GET /api/external/dashboard/funnel`
- `GET /api/external/dashboard/traffic-sources`
- `GET /api/external/reports/summary`
- `GET /api/external/reports/metrics`
- `GET /api/external/reports/contacts`
- `GET /api/external/reports/payments`
- `GET /api/external/reports/campaigns`
- `GET /api/external/reports/contacts/list`
- `GET /api/external/reports/transactions`
- `GET /api/external/contacts`
- `GET /api/external/contacts/search`
- `GET /api/external/contacts/{id}`
- `GET /api/external/contacts/{id}/conversation`
- `GET /api/external/contacts/{id}/journey`
- `GET /api/external/transactions`
- `GET /api/external/transactions/stats`
- `GET /api/external/transactions/summary`
- `GET /api/external/transactions/{id}`
- `POST /api/external/conversational-agent/goals/{goalId}/complete`

### Confirmacion de metas conversacionales

Cuando un agente manda un enlace externo, Ristak agrega el `goalId` usando el
parametro configurado y mantiene la meta pendiente. La pagina externa no recibe
ningun token de callback y abrir el enlace no cuenta como cita ni pago.

Una integracion autorizada confirma el resultado con:

```http
POST /api/external/conversational-agent/goals/{goalId}/complete
Authorization: Bearer <API token de Ristak>
Idempotency-Key: <ID estable del evento externo>
Content-Type: application/json
```

El body requiere `externalSource`, `externalObjectId` y un `status` exitoso.
En esta ruta autenticada esos nombres canonicos deben venir en el nivel superior;
aliases de webhooks legacy o valores duplicados conflictivos se rechazan.
`externalSource` identifica de forma estable al proveedor y tipo de evidencia,
por ejemplo `highlevel:appointment` o `stripe:payment`; no debe cambiar entre
reintentos. Tambien debe mandar
las referencias configuradas que apliquen: `calendarId`, `productId`, `priceId`,
`amount` y `currency`. Ristak compara esos valores contra la configuracion real
del agente antes de completar la meta. Los IDs son opacos y se comparan de forma
exacta, incluyendo mayusculas y minusculas.

Reintentar el mismo evento con el mismo `Idempotency-Key` y los mismos datos
devuelve exito sin repetir efectos. Otra llave o evidencia distinta recibe
conflicto. La misma combinacion `externalSource` + `externalObjectId` no puede
confirmar dos metas, aunque se usen llaves distintas o lleguen en paralelo. El
claim de evidencia y la transicion de la meta se guardan en una sola transaccion.
La tombstone independiente conserva tanto la evidencia como el
`Idempotency-Key` aunque despues se borren el contacto o la meta. Si la
actualizacion principal se confirma pero una accion interna se interrumpe, cada
efecto conserva su propio checkpoint y se recupera por retry, al arrancar y en el
sweep periodico. Asignacion y extras usan un plan inmutable con hash capturado al
aceptar la confirmacion; editar el agente despues no cambia un recovery. Las
notificaciones push usan politica `at-most-once`: si el
proceso cae despues de entregar al proveedor pero antes de guardar su ACK, se
marcan como resultado desconocido y no se reenvian para evitar duplicados. La
ruta requiere `developers` y `conversational_ai`.

Durante el despliegue, las filas legacy completadas con estado de efectos nulo
se consideran ya ejecutadas. Solo `pending`, `failed` o un lease `processing`
vencido entran al recovery; así una instancia vieja no provoca efectos dobles
durante un rollout con solapamiento. La instalacion atomica del backfill y del
trigger de base bloquea tambien una completion del binario legacy que intente
entrar sin claim durante ese overlap.

`conversational_agent_goal_links` y
`conversational_agent_goal_evidence_claims` son ledgers internos y no se exponen
mediante el CRUD generico, MCP ni las herramientas SQL del agente. Las
integraciones deben usar exclusivamente el endpoint dedicado de confirmacion.
Las demas tablas `conversational_agent_*`
pueden consultarse con la licencia correspondiente, pero el CRUD generico no
puede escribirlas: estado, eventos, metricas y aprendizaje solo cambian mediante
los servicios y endpoints dedicados.

## Render notes

- Keep HTTPS enabled.
- Set a strong `JWT_SECRET`; the web session still uses JWT.
- Never put generated API tokens in logs, build env vars, docs, screenshots, or GitHub issues.
- If a token leaks, rotate it from `Configuración > Acceso API`.
