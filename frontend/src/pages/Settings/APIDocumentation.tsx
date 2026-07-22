import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Copy, Database, ExternalLink, KeyRound, Network, RefreshCw, Server, ShieldCheck } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { PageHeader } from '@/components/common'
import { getApiBaseUrl } from '@/services/apiBaseUrl'
import styles from './APIDocumentation.module.css'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

interface OpenApiParameter {
  name: string
  in: string
  required?: boolean
}

interface OpenApiOperation {
  operationId?: string
  summary?: string
  parameters?: OpenApiParameter[]
}

interface OpenApiSpec {
  paths?: Record<string, Partial<Record<typeof HTTP_METHODS[number], OpenApiOperation>>>
}

interface ApiOperation extends OpenApiOperation {
  method: string
  path: string
}

const methodOrder: Record<string, number> = {
  GET: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5
}

export const APIDocumentation: React.FC = () => {
  const { showToast } = useNotification()
  const [spec, setSpec] = useState<OpenApiSpec | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const origin = getApiBaseUrl() || window.location.origin
  const externalApiBaseUrl = `${origin}/api/external`
  const openApiUrl = `${externalApiBaseUrl}/openapi.json`
  const mcpServerUrl = `${origin}/api/mcp`

  const operations = useMemo<ApiOperation[]>(() => {
    if (!spec?.paths) return []

    return Object.entries(spec.paths)
      .flatMap(([path, pathItem]) =>
        HTTP_METHODS.flatMap((method) => {
          const operation = pathItem?.[method]
          return operation ? [{ ...operation, method: method.toUpperCase(), path }] : []
        })
      )
      .sort((a, b) => a.path.localeCompare(b.path) || methodOrder[a.method] - methodOrder[b.method])
  }, [spec])

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast('success', 'Copiado', `${label} copiado al portapapeles`)
    } catch {
      showToast('error', 'Error', `No se pudo copiar ${label}`)
    }
  }

  useEffect(() => {
    let active = true

    const loadSpec = async () => {
      setIsLoading(true)
      setLoadError('')

      try {
        const response = await fetch(openApiUrl)
        const data = await response.json()

        if (!response.ok) throw new Error(data?.error || 'No se pudo cargar OpenAPI')
        if (active) setSpec(data)
      } catch (error: any) {
        if (active) setLoadError(error.message || 'No se pudo cargar la documentación')
      } finally {
        if (active) setIsLoading(false)
      }
    }

    loadSpec()

    return () => {
      active = false
    }
  }, [openApiUrl])

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a href="/settings/developers" className={styles.backLink}>
          <ArrowLeft size={16} />
          Developers
        </a>

        <PageHeader
          eyebrow="Ristak API Docs"
          title="Documentación API"
          subtitle="Conecta sistemas externos o agentes de IA para operar Ristak con herramientas tipadas. Cada acción respeta el plan, los permisos del usuario, los alcances OAuth y la auditoría."
          actions={
            <div className={styles.quickLinks}>
              <DocLink label="REST base" value={externalApiBaseUrl} onCopy={() => copyText(externalApiBaseUrl, 'REST base')} />
              <DocLink label="MCP server" value={mcpServerUrl} onCopy={() => copyText(mcpServerUrl, 'MCP server')} />
              <a className={styles.openApiLink} href={openApiUrl} target="_blank" rel="noreferrer">
                OpenAPI JSON
                <ExternalLink size={15} />
              </a>
            </div>
          }
        />
      </header>

      <section className={styles.layout}>
        <aside className={styles.sidebar}>
          <a href="#auth">Autenticación</a>
          <a href="#data">Base de datos</a>
          <a href="#sync">Integraciones externas</a>
          <a href="#mcp">MCP</a>
          <a href="#mcp-clients">Conectar clientes</a>
          <a href="#mcp-security">Permisos y auditoría</a>
          <a href="#endpoints">Endpoints</a>
        </aside>

        <div className={styles.content}>
          <Section id="auth" icon={<KeyRound size={18} />} title="Autenticación">
            <p>
              REST usa el API token generado en Acceso API. En cada request manda el header:
            </p>
            <CodeBlock
              value="Authorization: Bearer <RISTAK_API_TOKEN>"
              onCopy={() => copyText('Authorization: Bearer <RISTAK_API_TOKEN>', 'header de autenticación')}
            />
            <CodeBlock
              label="Probar credenciales"
              value={`curl -H "Authorization: Bearer <RISTAK_API_TOKEN>" "${externalApiBaseUrl}/me"`}
              onCopy={() => copyText(`curl -H "Authorization: Bearer <RISTAK_API_TOKEN>" "${externalApiBaseUrl}/me"`, 'ejemplo curl')}
            />
          </Section>

          <Section id="data" icon={<Database size={18} />} title="Base de datos">
            <p>
              La API de datos permite explorar tablas, consultar filas y hacer mutaciones. Las tablas sensibles de configuración se bloquean y columnas tipo token, password, secret o hash se redactan.
            </p>
            <EndpointExample method="GET" path="/api/external/data/tables" description="Lista tablas, columnas, columnas redactadas, columnas escribibles y modo de sincronización." />
            <EndpointExample method="GET" path="/api/external/data/{table}" description="Consulta filas con limit, offset, search, orderBy, orderDirection y filtros por columna." />
            <EndpointExample method="POST" path="/api/external/data/{table}" description="Crea una fila con los campos permitidos." />
            <EndpointExample method="PATCH" path="/api/external/data/{table}/{id}" description="Actualiza parcialmente una fila por id o keyColumn." />
            <EndpointExample method="DELETE" path="/api/external/data/{table}/{id}" description="Elimina una fila por id o keyColumn." />
            <CodeBlock
              label="Actualizar una fila"
              value={`curl -X PATCH "${externalApiBaseUrl}/data/contacts/<CONTACT_ID>" \\
  -H "Authorization: Bearer <RISTAK_API_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"full_name":"Nombre Nuevo","email":"nuevo@dominio.com"}'`}
              onCopy={() => copyText(`curl -X PATCH "${externalApiBaseUrl}/data/contacts/<CONTACT_ID>" \\
  -H "Authorization: Bearer <RISTAK_API_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"full_name":"Nombre Nuevo","email":"nuevo@dominio.com"}'`, 'ejemplo de actualización')}
            />
          </Section>

          <Section id="sync" icon={<RefreshCw size={18} />} title="Integraciones externas">
            <p>
              Ristak opera con datos propios. Si una integración como GoHighLevel está conectada, puedes usar endpoints especializados para sincronizar o proxificar recursos externos sin convertirla en requisito de la API principal.
            </p>
            <EndpointExample method="POST" path="/api/external/contacts" description="Crea un contacto autorizado desde la API externa." />
            <EndpointExample method="PUT" path="/api/external/contacts/{id}" description="Reemplaza/actualiza un contacto autorizado." />
            <EndpointExample method="PATCH" path="/api/external/contacts/{id}" description="Actualiza parcialmente un contacto autorizado." />
            <EndpointExample method="DELETE" path="/api/external/contacts/{id}" description="Elimina un contacto autorizado." />
            <EndpointExample method="POST" path="/api/external/highlevel/request" description="Proxy opcional para GoHighLevel cuando la integración está conectada." />
            <CodeBlock
              label="Proxy directo a GoHighLevel"
              value={`curl -X POST "${externalApiBaseUrl}/highlevel/request" \\
  -H "Authorization: Bearer <RISTAK_API_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"method":"PUT","path":"/contacts/<CONTACT_ID>","body":{"name":"Nombre Nuevo"}}'`}
              onCopy={() => copyText(`curl -X POST "${externalApiBaseUrl}/highlevel/request" \\
  -H "Authorization: Bearer <RISTAK_API_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"method":"PUT","path":"/contacts/<CONTACT_ID>","body":{"name":"Nombre Nuevo"}}'`, 'ejemplo GoHighLevel proxy')}
            />
          </Section>

          <Section id="mcp" icon={<Network size={18} />} title="MCP">
            <p>
              El catálogo actual registra 234 herramientas tipadas de negocio. `tools/list` y el estado de Developers muestran únicamente las visibles para el usuario, plan, módulos y alcances que autorizaron la conexión. No entrega acceso SQL libre, secretos, infraestructura ni administración de usuarios, y nunca brinca la lógica del producto.
            </p>
            <CodeBlock
              value={`POST ${mcpServerUrl}
Authorization: Bearer <OAUTH_ACCESS_TOKEN>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`}
              onCopy={() => copyText(`POST ${mcpServerUrl}
Authorization: Bearer <OAUTH_ACCESS_TOKEN>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`, 'ejemplo MCP')}
            />
            <div className={styles.toolGrid}>
              <Tool name="CRM, inbox y chatbot" text="Buscar, crear y actualizar contactos; operar tags y conversaciones; responder por canales conectados y configurar agentes conversacionales." />
              <Tool name="Citas y automatizaciones" text="Consultar calendarios y disponibilidad, crear o cambiar citas y administrar el ciclo de vida de automatizaciones." />
              <Tool name="Pagos y catálogo" text="Operar pagos, links, planes, productos, precios y suscripciones con confirmaciones y moneda de la cuenta." />
              <Tool name="Dashboard, reportes y analítica" text="Consultar resúmenes, métricas, atribución, tracking y resultados operativos o financieros." />
              <Tool name="Campañas y multimedia" text="Consultar y operar campañas permitidas, activos de Meta y la biblioteca multimedia sin exponer credenciales de proveedores." />
              <Tool name="Configuración operativa" text="Administrar tags, campos personalizados, trigger links, costos, plantillas de WhatsApp, preferencias móviles y consultar el estado seguro de integraciones." />
              <Tool name="Sites y HTML" text="Crear, leer y editar Sites, incluyendo archivos HTML importados, vista previa y publicación controlada." />
              <Tool name="Catálogo controlado" text="Cada herramienta usa el servicio de negocio correspondiente; no hay SQL libre, proxies genéricos, acceso a credenciales o ledgers internos, gestión de infraestructura ni administración de usuarios." />
            </div>
          </Section>

          <Section id="mcp-clients" icon={<Network size={18} />} title="Conectar Codex, ChatGPT, Claude u otro cliente">
            <p>
              Usa el mismo endpoint remoto con cualquier cliente compatible con MCP Streamable HTTP. La conexión abre OAuth en Ristak: inicia sesión con tu usuario normal, revisa los alcances y autoriza. MCP no usa el API token de REST/OpenAPI.
            </p>
            <CodeBlock
              label="Codex"
              value={`codex mcp add ristak --url "${mcpServerUrl}"\ncodex mcp login ristak`}
              onCopy={() => copyText(`codex mcp add ristak --url "${mcpServerUrl}"\ncodex mcp login ristak`, 'comandos de Codex')}
            />
            <EndpointExample method="POST" path={mcpServerUrl} description="En un espacio o Work mode de ChatGPT compatible con conectores MCP, agrega el conector remoto y completa OAuth en Ristak. En Claude usa Settings > Connectors > Add custom connector; Claude Code también puede registrar el servidor HTTP desde su configuración o CLI." />
            <p>
              Después de autorizar con tu sesión normal de Ristak, ejecuta `tools/list` para verificar qué herramientas quedaron disponibles. Para leer mensajes entrantes, el cliente consulta el inbox o la conversación; MCP no manda mensajes espontáneos a una sesión cerrada.
            </p>
          </Section>

          <Section id="mcp-security" icon={<ShieldCheck size={18} />} title="Permisos, confirmaciones y auditoría">
            <p>
              Los alcances separan lectura (`ristak.read`), escritura (`ristak.write`), acciones con efecto externo (`ristak.execute`) y operaciones destructivas (`ristak.destructive`). Tener un alcance no basta: el backend también valida la licencia actual y el permiso de módulo del usuario en cada llamada.
            </p>
            <p>
              En Configuración &gt; Developers puedes ver las conexiones OAuth, su último uso y revocar cualquiera. Las escrituras, mensajes, publicaciones, movimientos de dinero y borrados llevan metadatos de riesgo y confirmación; las ejecuciones quedan registradas en la auditoría MCP indicada por el servidor.
            </p>
            <EndpointExample method="GET" path="/api/api-access/mcp/status" description="Estado, transporte, versión, herramientas, dominios, alcances y enlace de auditoría." />
            <EndpointExample method="GET" path="/api/api-access/mcp/connections" description="Lista las conexiones OAuth autorizadas por el usuario actual." />
            <EndpointExample method="GET" path="/api/api-access/mcp/audit" description="Consulta ejecuciones MCP auditadas, con cliente, herramienta, riesgo, resultado y tiempos; los datos sensibles se redactan." />
            <EndpointExample method="DELETE" path="/api/api-access/mcp/connections/{id}" description="Revoca una conexión y corta su acceso inmediatamente." />
          </Section>

          <Section id="endpoints" icon={<Server size={18} />} title="Referencia de endpoints">
            {isLoading && (
              <p role="status" aria-live="polite" aria-label="Cargando schema OpenAPI">
                <RefreshCw size={16} className="animate-spin" aria-hidden="true" />
              </p>
            )}
            {!isLoading && loadError && <p className={styles.error}>{loadError}</p>}
            {!isLoading && !loadError && (
              <div className={styles.endpointList}>
                {operations.map((operation) => (
                  <EndpointRow key={`${operation.method}:${operation.path}`} operation={operation} />
                ))}
              </div>
            )}
          </Section>
        </div>
      </section>
    </main>
  )
}

const Section: React.FC<{ id: string; icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ id, icon, title, children }) => (
  <section id={id} className={styles.section}>
    <div className={styles.sectionHeader}>
      <span>{icon}</span>
      <h2>{title}</h2>
    </div>
    {children}
  </section>
)

const DocLink: React.FC<{ label: string; value: string; onCopy: () => void }> = ({ label, value, onCopy }) => (
  <div className={styles.docLink}>
    <span>{label}</span>
    <code>{value}</code>
    <button type="button" onClick={onCopy} aria-label={`Copiar ${label}`}>
      <Copy size={15} />
    </button>
  </div>
)

const CodeBlock: React.FC<{ label?: string; value: string; onCopy: () => void }> = ({ label, value, onCopy }) => (
  <div className={styles.codeBlock}>
    <div className={styles.codeHeader}>
      <span>{label || 'Ejemplo'}</span>
      <button type="button" onClick={onCopy} aria-label={`Copiar ${label || 'ejemplo'}`}>
        <Copy size={15} />
      </button>
    </div>
    <pre><code>{value}</code></pre>
  </div>
)

const EndpointExample: React.FC<{ method: string; path: string; description: string }> = ({ method, path, description }) => (
  <div className={styles.endpointExample}>
    <Method method={method} />
    <code>{path}</code>
    <span>{description}</span>
  </div>
)

const EndpointRow: React.FC<{ operation: ApiOperation }> = ({ operation }) => (
  <div className={styles.endpointRow}>
    <div className={styles.endpointLine}>
      <Method method={operation.method} />
      <code>{operation.path}</code>
    </div>
    <p>{operation.summary || operation.operationId || 'Endpoint REST'}</p>
    {!!operation.parameters?.length && (
      <div className={styles.paramList}>
        {operation.parameters.map(parameter => (
          <span key={`${operation.method}:${operation.path}:${parameter.in}:${parameter.name}`}>
            {parameter.name} <em>{parameter.in}{parameter.required ? ', req' : ''}</em>
          </span>
        ))}
      </div>
    )}
  </div>
)

const Method: React.FC<{ method: string }> = ({ method }) => (
  <span className={`${styles.method} ${styles[`method${method}`] || ''}`}>{method}</span>
)

const Tool: React.FC<{ name: string; text: string }> = ({ name, text }) => (
  <div className={styles.tool}>
    <code>{name}</code>
    <span>{text}</span>
  </div>
)
