# External API Access

Ristak exposes token-protected endpoints under `/api/external` for authorized external systems.

This document covers the customer-facing external API and MCP exposed by an
installed Ristak app. Internal support access for agents lives in Ristak
Installer; use `docs/support-mcp-operations.md` when Raul asks to inspect a
customer account, logs, chats, database rows, or production errors.

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

## Setup

1. Go to `Configuración > Acceso API`.
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

6. Use this MCP server URL if the external client expects MCP instead of OpenAPI:

   ```text
   https://YOUR_RENDER_DOMAIN/api/mcp
   ```

   MCP clients that require OAuth should use the built-in OAuth discovery endpoints. The authorization screen asks for a Ristak API token and exchanges it for OAuth access credentials.

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
  by plan, and tool execution re-checks the same feature gates. Generic table
  tools apply the same table-to-feature mapping as `/api/external/data/:table`.
- A token minted before a downgrade does not bypass the current plan; feature
  checks run on every request.

## Available endpoints

### Credential management

- `GET /api/api-access`
- `POST /api/api-access/token/rotate`
- `DELETE /api/api-access/token`

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
