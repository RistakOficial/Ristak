import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Copy, Database, ExternalLink, KeyRound, Network, RefreshCw, Server } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './APIDocumentation.module.css'

const API_URL = import.meta.env.VITE_API_URL || ''
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

  const origin = API_URL || window.location.origin
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
        <a href="/settings/api-access" className={styles.backLink}>
          <ArrowLeft size={16} />
          Acceso API
        </a>

        <div className={styles.headerGrid}>
          <div>
            <p className={styles.kicker}>Ristak API Docs</p>
            <h1 className={styles.title}>Documentación API</h1>
            <p className={styles.subtitle}>
              Conecta sistemas externos para leer, crear, actualizar y borrar datos. Ristak actúa como intermediario y espejo de GoHighLevel para los recursos sincronizados.
            </p>
          </div>

          <div className={styles.quickLinks}>
            <DocLink label="REST base" value={externalApiBaseUrl} onCopy={() => copyText(externalApiBaseUrl, 'REST base')} />
            <DocLink label="MCP server" value={mcpServerUrl} onCopy={() => copyText(mcpServerUrl, 'MCP server')} />
            <a className={styles.openApiLink} href={openApiUrl} target="_blank" rel="noreferrer">
              OpenAPI JSON
              <ExternalLink size={15} />
            </a>
          </div>
        </div>
      </header>

      <section className={styles.layout}>
        <aside className={styles.sidebar}>
          <a href="#auth">Autenticación</a>
          <a href="#data">Base de datos</a>
          <a href="#sync">Espejo GoHighLevel</a>
          <a href="#mcp">MCP</a>
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

          <Section id="sync" icon={<RefreshCw size={18} />} title="Espejo GoHighLevel">
            <p>
              Para contactos, Ristak usa escritura directa: primero modifica GoHighLevel y después actualiza la copia local. Si GoHighLevel falla, la mutación falla para evitar que el espejo quede desfasado.
            </p>
            <EndpointExample method="POST" path="/api/external/contacts" description="Crea contacto en GoHighLevel y guarda el espejo local." />
            <EndpointExample method="PUT" path="/api/external/contacts/{id}" description="Reemplaza/actualiza contacto en GoHighLevel y Ristak." />
            <EndpointExample method="PATCH" path="/api/external/contacts/{id}" description="Actualiza parcialmente contacto en GoHighLevel y Ristak." />
            <EndpointExample method="DELETE" path="/api/external/contacts/{id}" description="Elimina contacto en GoHighLevel y Ristak." />
            <EndpointExample method="POST" path="/api/external/highlevel/request" description="Proxy avanzado para cualquier endpoint de GoHighLevel: GET, POST, PUT, PATCH o DELETE." />
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
              El servidor MCP expone herramientas para explorar datos de Ristak y proxificar el MCP oficial de GoHighLevel. La lista exacta se descubre con `tools/list`.
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
              <Tool name="list_data_tables" text="Lista tablas y columnas disponibles." />
              <Tool name="query_data_table" text="Consulta filas con filtros y paginación." />
              <Tool name="ghl_mcp__*" text="Tools oficiales de GoHighLevel prefijadas por Ristak." />
              <Tool name="ghl_mcp_call_tool" text="Fallback para ejecutar cualquier tool MCP de GoHighLevel por nombre." />
            </div>
          </Section>

          <Section id="endpoints" icon={<Server size={18} />} title="Referencia de endpoints">
            {isLoading && <p>Cargando schema OpenAPI...</p>}
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
