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
route proxy and not unrestricted SQL. The current registry contains 234 typed
tools before authorization filtering. `GET /api/api-access/mcp/status` and
`tools/list` report only the subset visible to the current user, plan, modules
and granted scopes. The registry covers these operational domains:

- contacts, CRM search, tags, custom fields and trigger links;
- inbox, conversations, outbound messages and conversational chatbot operation;
- calendars, availability, appointments and automations;
- payments, payment links/plans, products, prices and subscriptions;
- dashboard summaries, reports, analytics, attribution and web tracking;
- campaigns, Meta assets and campaign-builder operations already supported by
  the account;
- media library assets, folders, storage usage and permitted lifecycle actions;
- business costs, WhatsApp templates, mobile preferences and safe integration
  status;
- Sites lifecycle, imported HTML files, preview and controlled publication.

Payment metadata edits cannot change payment status. Recording a payment uses
`ristak.execute`; refunds, voids and payment-plan cancellation/deletion use
`ristak.destructive` so a write-only client cannot cross those boundaries.

New product actions must enter the MCP through the same registry with an input
schema, output contract, module/feature gate, OAuth scope, risk annotation and
auditable executor. "Exponer todo" never means bypassing controllers, writing
directly into protected ledgers, leaking secrets, managing infrastructure or
administering users.

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
5. explicit confirmation for high-impact writes, external effects and
   destructive actions.

Business dates are interpreted with the account timezone and new monetary
records use `account_currency` when the caller does not provide a valid explicit
currency. An MCP client must not infer either value from its own computer.

### Receiving messages

An agent can list the inbox, inspect a contact conversation and answer through
the channels connected in Ristak. MCP does not initiate an unsolicited request
into a closed Codex/ChatGPT/Claude session. A client that needs continuous
reception must poll/read the inbox from its own runtime or use Ristak
automations/webhooks for an event-driven flow.

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
