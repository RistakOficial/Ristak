# Enrutamiento y operacion MCP entre Ristak e Installer

Este documento es el contrato operativo para que los agentes distingan entre
operar Ristak y dar soporte interno. Aplica aunque el agente este parado en este
repo (`Ristak`) o en `Ristak - Installer`.

El usuario puede decir "MSP" cuando se refiere a "MCP". Ese error de nombre no
elige el servidor: la intencion de la solicitud decide si corresponde el MCP
funcional de Ristak o el MCP de soporte del Installer.

Si la solicitud es **subir la app a App Store o Play Store**, no uses este flujo
de soporte. Lee [`MOBILE_STORE_RELEASES.md`](./MOBILE_STORE_RELEASES.md) y usa el
MCP `ristak-mobile-stores` del Installer.

## Regla de decision

| Si Raul pide... | Usa primero... | Para que |
| --- | --- | --- |
| "Crea un contacto", "manda este mensaje", "agenda una cita", "crea/publica una pagina" o cualquier accion normal de producto | MCP funcional `ristak` (`/api/mcp`, herramientas `mcp__ristak__*`) | Ejecutar la funcion con la cuenta, permisos, licencia, scopes y confirmaciones del usuario autenticado |
| "Investiga este cliente", "por que fallo el backend", "revisa el chat o la IA", "mira logs/health/deploy/DB" sobre una instalacion real | MCP de soporte `ristak-render-support` (`mcp__ristak_render_support__*`) | Encontrar la instalacion correcta y reunir evidencia real, read-only, antes de diagnosticar |
| "Implementa/cambia/refactoriza esta funcion" sin reportar un incidente real | Repo correspondiente en rama o worktree limpio | Cambiar y validar codigo; soporte no es un navegador de codigo |

No intercambies los carriles:

- El MCP funcional **opera el producto**. No sirve para leer Render, logs internos,
  secretos, infraestructura o la base del cliente como soporte.
- El MCP de soporte **investiga instalaciones**. No debe crear contactos, mandar
  mensajes, agendar citas, publicar Sites ni mutar datos de negocio.
- El repo **contiene la implementacion**. Cuando soporte confirma un bug de
  producto, el arreglo se hace aqui; cuando confirma un problema de provisioning,
  licencias, Render o soporte, el arreglo se hace en `Ristak - Installer`.

Si una solicitud mezcla operacion y diagnostico, separa y anuncia las fases. Por
ejemplo: intenta la accion con `ristak`; si falla inesperadamente, conserva el
error y usa `ristak-render-support` para investigar sin repetir escrituras. Si
despues hace falta corregir codigo, cambia el repo correcto en un espacio limpio.

Si el MCP esperado no esta conectado, autorizado o no expone la herramienta
necesaria, dilo claramente. No sustituyas en silencio el MCP funcional por SQL de
soporte ni el soporte por una suposicion basada solo en el checkout local.

## Fuente de verdad

- El control plane es `Ristak - Installer`.
- Este repo contiene el producto instalado en cada cuenta.
- El MCP externo de una app instalada vive en `/api/mcp` y es para integraciones
  y operaciones funcionales autorizadas del cliente. No es la herramienta de
  soporte interno.
- El MCP de soporte interno vive en Installer y usa:
  - la base central del Installer para encontrar instalaciones;
  - `installations.render_api_key_enc` para descifrar en memoria la Render API
    Key del cliente;
  - Render API para leer servicio, logs, deploys, env vars redactadas y conexion
    externa de Postgres;
  - consultas read-only a la base del cliente.

## Regla cuando Raul reporta un problema de un cliente

Antes de asumir que el bug esta en el codigo local:

1. Identifica al cliente con el MCP/CLI de soporte del Installer.
2. Confirma la instalacion activa correcta por `client_name`, `client_email`,
   `app_name`, `app_url`, `render_service_id` y `render_database_id`.
3. Lee evidencia real: health, logs recientes, schema/tablas relevantes y filas
   read-only de la DB del cliente.
4. Si la evidencia apunta a bug de producto, cambia este repo en una rama o
   worktree limpio.
5. Si la evidencia apunta a provisioning, licencias, Render, stores moviles o
   soporte MCP, cambia `Ristak - Installer`.

No brinques directo a Render MCP generico si el soporte del Installer esta
disponible. El Installer ya conoce la llave correcta del cliente y evita pelear
con workspaces equivocados.

## Arranque rapido desde este repo

Llama el CLI del Installer con ruta absoluta:

```bash
npm --prefix "/Users/raulgomez/Desktop/Ristak - Installer/backend" run render:support -- check
npm --prefix "/Users/raulgomez/Desktop/Ristak - Installer/backend" run render:support -- find "cliente o correo"
```

En esta Mac puede existir un archivo local de entorno para soporte:

```bash
set -a
source "$HOME/.ristak-secrets/installer/render-support-mcp.env"
set +a
```

Ese archivo no se commitea ni se imprime. Si no existe o falta una credencial
necesaria, detente y pide acceso; no inventes valores.

## Herramientas MCP internas

Cuando el cliente MCP tenga conectado `ristak-render-support`, usa estas
herramientas:

- `ristak_support_check`: valida que el MCP lea la base central del Installer.
- `ristak_find_clients`: busca instalaciones por nombre, correo, URL o Render ID.
- `ristak_support_snapshot`: servicio Render, Postgres, deploys, env vars
  redactadas y logs recientes.
- `ristak_recent_logs`: logs recientes del web service del cliente.
- `ristak_health_check`: GET al health endpoint publico de la app instalada.
- `ristak_database_schema`: tablas y columnas de la DB del cliente.
- `ristak_database_query`: SQL `SELECT`/`WITH` read-only con limite y redaccion.

CLI equivalente desde este repo:

```bash
npm --prefix "/Users/raulgomez/Desktop/Ristak - Installer/backend" run render:support -- summary "cliente" --limit=100
npm --prefix "/Users/raulgomez/Desktop/Ristak - Installer/backend" run render:support -- logs "cliente" --limit=100
npm --prefix "/Users/raulgomez/Desktop/Ristak - Installer/backend" run render:support -- health "cliente"
npm --prefix "/Users/raulgomez/Desktop/Ristak - Installer/backend" run render:support -- schema "cliente" --table=messages
npm --prefix "/Users/raulgomez/Desktop/Ristak - Installer/backend" run render:support -- query "cliente" -- "SELECT id FROM users LIMIT 10"
```

## Consultas frecuentes de soporte

Ultimas conversaciones de un cliente:

```sql
WITH all_messages AS (
  SELECT 'whatsapp_api' AS source_table, 'whatsapp' AS channel, id, contact_id,
         direction, message_type, message_text,
         COALESCE(message_timestamp, created_at) AS message_at, created_at
  FROM whatsapp_api_messages
  UNION ALL
  SELECT 'meta_social' AS source_table, platform AS channel, id, contact_id,
         direction, message_type, message_text,
         COALESCE(message_timestamp, created_at) AS message_at, created_at
  FROM meta_social_messages
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY contact_id ORDER BY message_at DESC, created_at DESC
  ) AS rn
  FROM all_messages
  WHERE contact_id IS NOT NULL
)
SELECT contact_id, channel, source_table, direction, message_type,
       LEFT(message_text, 240) AS message_text, message_at
FROM ranked
WHERE rn = 1
ORDER BY message_at DESC
LIMIT 20;
```

Estado de IA conversacional:

```sql
SELECT contact_id, status, signal, signal_reason, signal_summary,
       last_inbound_message_id, last_answered_inbound_message_id,
       last_reply_at, updated_at
FROM conversational_agent_state
ORDER BY updated_at DESC
LIMIT 50;
```

Eventos recientes de IA:

```sql
SELECT contact_id, event_type, LEFT(detail_json, 500) AS detail_json, created_at
FROM conversational_agent_events
ORDER BY created_at DESC
LIMIT 50;
```

## Guardrails

- No imprimir API Keys, `DATABASE_URL`, passwords, tokens ni valores de env.
- Las queries de soporte son read-only. No uses `UPDATE`, `DELETE`, `INSERT`,
  `ALTER`, `DROP` ni multiples statements.
- No edites datos vivos de un cliente desde soporte salvo que exista una
  herramienta auditada para esa accion y Raul la autorice.
- Si hay varias coincidencias de cliente, pide o usa un dato mas preciso. No
  asumas por nombre cuando hay varios Marcos, clinicas o negocios parecidos.
- Si encuentras un bug de codigo en este repo, arreglalo aqui; si encuentras un
  bug de acceso/Installer/provisioning, arreglalo en `Ristak - Installer`.
