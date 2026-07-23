import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, BookOpen, CheckCircle2, Copy, Network, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import { Button, SegmentTabs, Table } from '@/components/common'
import type { Column, SegmentTab } from '@/components/common'
import { Badge } from '@/components/common/Badge'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { apiUrl } from '@/services/apiBaseUrl'
import { formatDateTime } from '@/utils/format'
import styles from './Settings.module.css'

type McpClientKey = 'codex' | 'chatgpt' | 'claude' | 'other'
type McpBadgeVariant = 'success' | 'error' | 'warning' | 'neutral'

export interface McpHeaderStatus {
  label: string
  variant: McpBadgeVariant
  ready: boolean
}

interface McpAccessPanelProps {
  enabled: boolean
  origin: string
  serverUrl: string
  onCopy: (value: string, label: string) => Promise<void>
  onOpenDocumentation: () => void
  onStatusChange: (status: McpHeaderStatus) => void
}

interface McpDomain {
  key: string
  label: string
  toolCount: number | null
}

interface McpStatus {
  available: boolean
  enabled: boolean
  ready: boolean
  serverUrl: string
  protocolVersion: string
  transport: string
  toolCount: number | null
  domains: McpDomain[]
  scopes: string[]
  auditUrl: string
}

interface McpConnection {
  id: string
  clientId: string
  clientName: string
  scopes: string[]
  status: string
  createdAt: string | null
  lastUsedAt: string | null
  expiresAt: string | null
}

interface McpAuditEvent {
  id: string
  toolName: string
  clientName: string
  risk: string
  status: string
  createdAt: string | null
  durationMs: number | null
}

interface McpClientSetup {
  key: McpClientKey
  label: string
  valueLabel: string
  value: string
  secondaryValueLabel?: string
  secondaryValue?: string
  steps: string[]
}

type JsonRecord = Record<string, unknown>

const MCP_FALLBACK_DOMAINS: McpDomain[] = [
  { key: 'contacts', label: 'Contactos y CRM', toolCount: null },
  { key: 'chat', label: 'Mensajes e inbox', toolCount: null },
  { key: 'ai_agent', label: 'Chatbot y agentes IA', toolCount: null },
  { key: 'appointments', label: 'Citas y calendarios', toolCount: null },
  { key: 'payments', label: 'Pagos, productos y suscripciones', toolCount: null },
  { key: 'automations', label: 'Automatizaciones', toolCount: null },
  { key: 'dashboard', label: 'Dashboard y resumen', toolCount: null },
  { key: 'reports', label: 'Reportes', toolCount: null },
  { key: 'analytics', label: 'Analítica y tracking', toolCount: null },
  { key: 'campaigns', label: 'Campañas y Meta Ads', toolCount: null },
  { key: 'settings_media', label: 'Biblioteca multimedia', toolCount: null },
  { key: 'settings_custom_fields', label: 'Tags, campos y trigger links', toolCount: null },
  { key: 'settings_costs', label: 'Costos del negocio', toolCount: null },
  { key: 'settings_whatsapp', label: 'WhatsApp y plantillas', toolCount: null },
  { key: 'settings_mobile', label: 'Preferencias móviles', toolCount: null },
  { key: 'settings_integrations', label: 'Estado de integraciones', toolCount: null },
  { key: 'sites', label: 'Sites y código HTML', toolCount: null }
]

const MCP_DOMAIN_LABELS: Record<string, string> = Object.fromEntries(
  MCP_FALLBACK_DOMAINS.map(domain => [domain.key, domain.label])
)

const asRecord = (value: unknown): JsonRecord | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
)

const asString = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

const asNullableDate = (value: unknown): string | null => {
  const text = asString(value)
  return text || null
}

const asStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map(asString).filter(Boolean)
  }

  const text = asString(value)
  return text ? text.split(/[\s,]+/).map(item => item.trim()).filter(Boolean) : []
}

const asOptionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeMcpDomains = (value: unknown, countsValue?: unknown): McpDomain[] => {
  if (!Array.isArray(value)) return []
  const counts = asRecord(countsValue) || {}

  return value.flatMap((item, index) => {
    if (typeof item === 'string' && item.trim()) {
      const key = item.trim()
      return [{
        key,
        label: MCP_DOMAIN_LABELS[key] || key.replace(/_/g, ' '),
        toolCount: asOptionalNumber(counts[key])
      }]
    }

    const record = asRecord(item)
    if (!record) return []

    const key = asString(record.key) || asString(record.id) || asString(record.module) || `domain-${index}`
    const label = asString(record.label) || asString(record.name) || asString(record.title) || MCP_DOMAIN_LABELS[key] || key.replace(/_/g, ' ')
    return [{
      key,
      label,
      toolCount: asOptionalNumber(record.toolCount ?? record.tool_count ?? record.count ?? counts[key])
    }]
  })
}

const normalizeMcpStatus = (value: unknown, fallbackServerUrl: string): McpStatus => {
  const root = asRecord(value) || {}
  const source = asRecord(root.mcp) || asRecord(root.status) || root
  const state = asString(source.status).toLowerCase()
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : state !== 'disabled'
  const ready = typeof source.ready === 'boolean'
    ? source.ready
    : state
      ? ['ready', 'active', 'ok', 'healthy'].includes(state)
      : enabled

  return {
    available: root.success !== false,
    enabled,
    ready,
    serverUrl: asString(source.serverUrl ?? source.server_url ?? source.url) || fallbackServerUrl,
    protocolVersion: asString(source.protocolVersion ?? source.protocol_version) || '2025-06-18',
    transport: asString(source.transport) || 'Streamable HTTP',
    toolCount: asOptionalNumber(source.toolCount ?? source.tool_count ?? source.toolsCount ?? source.tools_count),
    domains: normalizeMcpDomains(source.domains ?? source.capabilities, source.toolsByDomain ?? source.tools_by_domain),
    scopes: asStringList(source.scopes ?? source.scopes_supported),
    auditUrl: asString(source.auditUrl ?? source.audit_url)
  }
}

const normalizeMcpConnections = (value: unknown): McpConnection[] => {
  const root = asRecord(value) || {}
  const nestedMcp = asRecord(root.mcp)
  const source: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray(root.connections)
      ? root.connections
      : Array.isArray(nestedMcp?.connections)
        ? nestedMcp.connections
        : []

  return source.flatMap((item, index) => {
    const record = asRecord(item)
    if (!record) return []

    const id = asString(record.id ?? record.connectionId ?? record.connection_id ?? record.refreshTokenId)
    if (!id) return []

    const clientId = asString(record.clientId ?? record.client_id)
    const clientName = asString(record.clientName ?? record.client_name ?? record.name)
      || clientId
      || `Conexión ${index + 1}`

    return [{
      id,
      clientId,
      clientName,
      scopes: asStringList(record.scopes ?? record.scope),
      status: asString(record.status) || (record.revokedAt || record.revoked_at ? 'revoked' : 'active'),
      createdAt: asNullableDate(record.createdAt ?? record.created_at),
      lastUsedAt: asNullableDate(record.lastUsedAt ?? record.last_used_at),
      expiresAt: asNullableDate(record.expiresAt ?? record.expires_at)
    }]
  })
}

const normalizeMcpAuditEvents = (value: unknown): McpAuditEvent[] => {
  const root = asRecord(value) || {}
  const source: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray(root.events)
      ? root.events
      : Array.isArray(root.entries)
        ? root.entries
        : Array.isArray(root.items)
          ? root.items
          : Array.isArray(root.audit)
            ? root.audit
            : []

  return source.flatMap((item, index) => {
    const record = asRecord(item)
    if (!record) return []

    const createdAt = asNullableDate(record.createdAt ?? record.created_at ?? record.startedAt ?? record.started_at ?? record.at)
    const toolName = asString(record.toolName ?? record.tool_name ?? record.tool ?? record.action) || 'Herramienta MCP'
    const clientName = asString(record.clientName ?? record.client_name ?? record.clientId ?? record.client_id) || 'Cliente MCP'
    const id = asString(record.id ?? record.eventId ?? record.event_id)
      || `${toolName}:${createdAt || index}:${index}`
    const status = typeof record.success === 'boolean'
      ? record.success ? 'success' : 'failed'
      : asString(record.status ?? record.outcome ?? record.result) || 'unknown'
    const startedAt = asNullableDate(record.startedAt ?? record.started_at)
    const completedAt = asNullableDate(record.completedAt ?? record.completed_at)
    const explicitDuration = asOptionalNumber(record.durationMs ?? record.duration_ms)
    const calculatedDuration = startedAt && completedAt
      ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
      : Number.NaN

    return [{
      id,
      toolName,
      clientName,
      risk: asString(record.risk ?? record.riskLevel ?? record.risk_level ?? record.scope ?? record.requiredScope ?? record.required_scope) || '—',
      status,
      createdAt,
      durationMs: explicitDuration ?? (Number.isFinite(calculatedDuration) && calculatedDuration >= 0 ? calculatedDuration : null)
    }]
  })
}

const safeSameOriginUrl = (value: string, origin: string): string => {
  if (!value) return ''

  try {
    const resolved = new URL(value, origin)
    const expectedOrigin = new URL(origin).origin
    return ['http:', 'https:'].includes(resolved.protocol) && resolved.origin === expectedOrigin
      ? resolved.toString()
      : ''
  } catch {
    return ''
  }
}

const authHeaders = () => {
  const token = localStorage.getItem('auth_token')
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

const formatTransportLabel = (value: string | undefined): string => {
  const normalized = asString(value).toLowerCase().replace(/_/g, '-')
  return normalized === 'streamable-http' ? 'Streamable HTTP' : asString(value) || 'Streamable HTTP'
}

export const McpAccessPanel: React.FC<McpAccessPanelProps> = ({
  enabled,
  origin,
  serverUrl,
  onCopy,
  onOpenDocumentation,
  onStatusChange
}) => {
  const { showToast, showConfirm } = useNotification()
  const { timezone } = useTimezone()
  const [activeClient, setActiveClient] = useState<McpClientKey>('codex')
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [revokingConnectionId, setRevokingConnectionId] = useState('')
  const [auditEvents, setAuditEvents] = useState<McpAuditEvent[]>([])
  const [isAuditOpen, setIsAuditOpen] = useState(false)
  const [isLoadingAudit, setIsLoadingAudit] = useState(false)
  const [auditError, setAuditError] = useState('')

  const auditUrl = safeSameOriginUrl(status?.auditUrl || '', origin)
  const domains = status?.domains.length ? status.domains : MCP_FALLBACK_DOMAINS
  const activeConnectionCount = connections.filter(connection => connection.status.toLowerCase() !== 'revoked').length
  const statusLabel = !enabled || isLoading
    ? 'Revisando'
    : status?.ready
      ? 'MCP listo'
      : status?.available && !status.enabled
        ? 'MCP desactivado'
        : status?.available
          ? 'Requiere configuración'
          : 'Estado no disponible'
  const statusVariant: McpBadgeVariant = !enabled
    ? 'neutral'
    : status?.ready
      ? 'success'
      : status?.available && !status.enabled
        ? 'error'
        : status?.available
          ? 'warning'
          : 'neutral'

  useEffect(() => {
    onStatusChange({ label: statusLabel, variant: statusVariant, ready: Boolean(status?.ready) })
  }, [onStatusChange, status?.ready, statusLabel, statusVariant])

  const formatDate = useCallback((value: string | null) => formatDateTime(value, {
    fallback: 'Nunca',
    timezone,
    intlOptions: {
      dateStyle: 'medium',
      timeStyle: 'short'
    }
  }), [timezone])

  const clientSetups = useMemo<McpClientSetup[]>(() => [
    {
      key: 'codex',
      label: 'Codex',
      valueLabel: 'Comando para registrar el servidor',
      value: `codex mcp add ristak --url "${status?.serverUrl || serverUrl}"`,
      secondaryValueLabel: 'Comando para iniciar sesión',
      secondaryValue: 'codex mcp login ristak',
      steps: [
        'Ejecuta el primer comando para registrar el servidor remoto de Ristak.',
        'Ejecuta codex mcp login ristak. Codex abrirá la autorización segura de Ristak en el navegador.',
        'Inicia sesión en Ristak si hace falta, revisa los permisos solicitados y autoriza la conexión. Después pide a Codex que liste las herramientas disponibles.'
      ]
    },
    {
      key: 'chatgpt',
      label: 'ChatGPT',
      valueLabel: 'URL del conector MCP',
      value: status?.serverUrl || serverUrl,
      steps: [
        'En un espacio o Work mode de ChatGPT que admita plugins o conectores MCP, abre la configuración de conectores.',
        'Pega esta URL y completa el flujo OAuth en la página segura de Ristak.',
        'Autoriza sólo los alcances que necesites; las acciones críticas pedirán confirmación.'
      ]
    },
    {
      key: 'claude',
      label: 'Claude',
      valueLabel: 'URL del servidor remoto',
      value: status?.serverUrl || serverUrl,
      steps: [
        'En Claude, abre Settings > Connectors > Add custom connector y pega esta URL.',
        'Completa la autorización OAuth en Ristak y verifica las herramientas disponibles.',
        'Si usas Claude Code, agrega el servidor remoto HTTP desde su configuración o CLI y completa el mismo flujo OAuth.'
      ]
    },
    {
      key: 'other',
      label: 'Otra',
      valueLabel: 'Endpoint Streamable HTTP',
      value: status?.serverUrl || serverUrl,
      steps: [
        'Configura un cliente compatible con MCP remoto y Streamable HTTP.',
        'Usa discovery OAuth 2.1 con PKCE y completa la autorización con tu sesión normal de Ristak.',
        'Descubre herramientas con tools/list y respeta los alcances y confirmaciones de cada acción.'
      ]
    }
  ], [serverUrl, status?.serverUrl])

  const clientTabs = useMemo<SegmentTab[]>(() => clientSetups.map(client => ({
    id: client.key,
    label: client.label
  })), [clientSetups])
  const selectedClient = clientSetups.find(client => client.key === activeClient) || clientSetups[0]

  const loadAccess = useCallback(async (refresh = false) => {
    if (!enabled) return
    if (refresh) setIsRefreshing(true)
    else setIsLoading(true)
    setLoadError('')

    try {
      const [statusResponse, connectionsResponse] = await Promise.all([
        fetch(apiUrl('/api/api-access/mcp/status'), { headers: authHeaders() }),
        fetch(apiUrl('/api/api-access/mcp/connections'), { headers: authHeaders() })
      ])
      const statusData = await statusResponse.json().catch(() => ({}))
      const connectionsData = await connectionsResponse.json().catch(() => ({}))

      if (!statusResponse.ok || asRecord(statusData)?.success === false) {
        throw new Error(
          asString(asRecord(statusData)?.message)
          || asString(asRecord(statusData)?.error)
          || 'No se pudo consultar el estado del servidor MCP'
        )
      }

      setStatus(normalizeMcpStatus(statusData, serverUrl))
      setConnections(
        connectionsResponse.ok && asRecord(connectionsData)?.success !== false
          ? normalizeMcpConnections(connectionsData)
          : normalizeMcpConnections(statusData)
      )
    } catch (error: unknown) {
      setStatus({
        available: false,
        enabled: true,
        ready: false,
        serverUrl,
        protocolVersion: '2025-06-18',
        transport: 'Streamable HTTP',
        toolCount: null,
        domains: [],
        scopes: [],
        auditUrl: ''
      })
      setLoadError(error instanceof Error ? error.message : 'No se pudo consultar el estado del servidor MCP')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [enabled, serverUrl])

  useEffect(() => {
    void loadAccess()
  }, [loadAccess])

  const loadAudit = useCallback(async () => {
    if (!auditUrl) return
    setIsLoadingAudit(true)
    setAuditError('')

    try {
      const url = new URL(auditUrl)
      if (!url.searchParams.has('limit')) url.searchParams.set('limit', '50')
      const response = await fetch(url.toString(), { headers: authHeaders() })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || asRecord(data)?.success === false) {
        throw new Error(
          asString(asRecord(data)?.message)
          || asString(asRecord(data)?.error)
          || 'No se pudo cargar la auditoría MCP'
        )
      }
      setAuditEvents(normalizeMcpAuditEvents(data))
    } catch (error: unknown) {
      setAuditError(error instanceof Error ? error.message : 'No se pudo cargar la auditoría MCP')
    } finally {
      setIsLoadingAudit(false)
    }
  }, [auditUrl])

  const toggleAudit = () => {
    if (isAuditOpen) {
      setIsAuditOpen(false)
      return
    }

    setIsAuditOpen(true)
    void loadAudit()
  }

  const revokeConnection = useCallback(async (connection: McpConnection): Promise<boolean> => {
    setRevokingConnectionId(connection.id)
    try {
      const response = await fetch(apiUrl(`/api/api-access/mcp/connections/${encodeURIComponent(connection.id)}`), {
        method: 'DELETE',
        headers: authHeaders()
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || asRecord(data)?.success === false) {
        throw new Error(
          asString(asRecord(data)?.message)
          || asString(asRecord(data)?.error)
          || 'No se pudo revocar la conexión MCP'
        )
      }

      setConnections(current => current.filter(item => item.id !== connection.id))
      showToast('success', 'Conexión revocada', `${connection.clientName} ya no puede entrar a Ristak`)
      return true
    } catch (error: unknown) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo revocar la conexión MCP')
      return false
    } finally {
      setRevokingConnectionId('')
    }
  }, [showToast])

  const confirmRevokeConnection = useCallback((connection: McpConnection) => {
    showConfirm(
      `Revocar conexión de ${connection.clientName}`,
      'Se cerrará esta autorización OAuth y la herramienta dejará de leer o cambiar datos de Ristak. Esta acción no se puede deshacer.',
      () => revokeConnection(connection),
      'Revocar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'REVOCAR' }
    )
  }, [revokeConnection, showConfirm])

  const connectionColumns = useMemo<Column<McpConnection>[]>(() => [
    {
      key: 'clientName',
      header: 'Herramienta',
      fixed: true,
      render: (_value, connection) => (
        <div className={styles.mcpConnectionClient}>
          <span>{connection.clientName}</span>
          {connection.clientId && <small>{connection.clientId}</small>}
        </div>
      )
    },
    {
      key: 'scopes',
      header: 'Alcances',
      render: (_value, connection) => (
        <div className={styles.mcpScopeList}>
          {(connection.scopes.length ? connection.scopes : ['Sin detalle']).map(scope => (
            <Badge key={`${connection.id}:${scope}`} variant="neutral">{scope}</Badge>
          ))}
        </div>
      )
    },
    {
      key: 'lastUsedAt',
      header: 'Último uso',
      sortValue: (_value, connection) => connection.lastUsedAt || connection.createdAt || '',
      render: (_value, connection) => formatDate(connection.lastUsedAt || connection.createdAt)
    },
    {
      key: 'status',
      header: 'Estado',
      render: (_value, connection) => {
        const active = !['revoked', 'expired', 'inactive'].includes(connection.status.toLowerCase())
        return <Badge variant={active ? 'success' : 'neutral'}>{active ? 'Activa' : 'Inactiva'}</Badge>
      }
    },
    {
      key: 'actions',
      header: '',
      searchable: false,
      fixed: true,
      render: (_value, connection) => (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`Revocar conexión de ${connection.clientName}`}
          title={`Revocar conexión de ${connection.clientName}`}
          loading={revokingConnectionId === connection.id}
          disabled={Boolean(revokingConnectionId)}
          onClick={() => confirmRevokeConnection(connection)}
        >
          <Unplug size={16} />
        </Button>
      )
    }
  ], [confirmRevokeConnection, formatDate, revokingConnectionId])

  const auditColumns = useMemo<Column<McpAuditEvent>[]>(() => [
    {
      key: 'toolName',
      header: 'Herramienta',
      fixed: true,
      render: (_value, event) => (
        <div className={styles.mcpConnectionClient}>
          <span>{event.toolName}</span>
          <small>{event.risk}</small>
        </div>
      )
    },
    {
      key: 'clientName',
      header: 'Cliente'
    },
    {
      key: 'createdAt',
      header: 'Ejecución',
      sortValue: (_value, event) => event.createdAt || '',
      render: (_value, event) => formatDate(event.createdAt)
    },
    {
      key: 'durationMs',
      header: 'Duración',
      render: (_value, event) => event.durationMs === null ? '—' : `${event.durationMs} ms`
    },
    {
      key: 'status',
      header: 'Resultado',
      render: (_value, event) => {
        const normalized = event.status.toLowerCase()
        const succeeded = ['success', 'succeeded', 'ok', 'completed'].includes(normalized)
        const failed = ['error', 'failed', 'denied', 'forbidden'].includes(normalized)
        return (
          <Badge variant={succeeded ? 'success' : failed ? 'error' : 'neutral'}>
            {succeeded ? 'Correcto' : failed ? 'Falló' : event.status}
          </Badge>
        )
      }
    }
  ], [formatDate])

  if (!selectedClient) return null

  return (
    <>
      <div className={styles.developerSectionHeading}>
        <h3 className={styles.accountSectionTitle}>
          <Network size={16} />
          Conecta Codex, ChatGPT, Claude o cualquier cliente MCP
        </h3>
        <p className={styles.accountSectionDescription}>
          Un solo servidor remoto para operar Ristak con herramientas tipadas, permisos por usuario y confirmaciones para acciones críticas.
        </p>
      </div>

      <div className={styles.mcpStatusBar} aria-label="Estado del servidor MCP">
        <div className={styles.mcpStatusItem}>
          <span>Servidor</span>
          <Badge variant={statusVariant}>{statusLabel}</Badge>
        </div>
        <div className={styles.mcpStatusItem}>
          <span>Herramientas visibles</span>
          <strong>{status?.toolCount ?? 'Según permisos'}</strong>
        </div>
        <div className={styles.mcpStatusItem}>
          <span>Conexiones</span>
          <strong>{isLoading ? '—' : activeConnectionCount}</strong>
        </div>
        <div className={styles.mcpStatusItem}>
          <span>Transporte</span>
          <strong>{formatTransportLabel(status?.transport)}</strong>
        </div>
      </div>

      {loadError && (
        <p className={styles.mcpStatusMessage} role="status">
          El endpoint sigue siendo copiable, pero no pudimos leer su estado en vivo: {loadError}
        </p>
      )}

      <ReadonlyMcpField
        label="Servidor MCP remoto"
        value={status?.serverUrl || serverUrl}
        onCopy={() => onCopy(status?.serverUrl || serverUrl, 'servidor MCP')}
      />

      <div className={styles.developerActions}>
        <Button
          variant="secondary"
          onClick={() => void loadAccess(true)}
          loading={isRefreshing}
          disabled={isLoading || isRefreshing}
        >
          <RefreshCw size={17} />
          Actualizar estado
        </Button>
        <Button variant="ghost" onClick={onOpenDocumentation}>
          <BookOpen size={17} />
          Ver documentación
        </Button>
      </div>

      <div className={styles.mcpAccessNote}>
        <ShieldCheck size={20} />
        <div>
          <h4>Tus permisos siguen mandando</h4>
          <p>
            Cada herramienta vuelve a revisar el plan, los permisos del usuario y el alcance OAuth. Leer, escribir, ejecutar acciones externas o borrar son permisos distintos.
          </p>
        </div>
      </div>

      <div className={styles.mcpSubsection}>
        <div className={styles.mcpSubsectionHeader}>
          <div>
            <h3>Áreas visibles para ti</h3>
            <p>El conteo y la lista se filtran por tu usuario, plan, módulos y alcances. No incluyen secretos, infraestructura ni administración de usuarios.</p>
          </div>
          {status?.protocolVersion && <Badge variant="neutral">MCP {status.protocolVersion}</Badge>}
        </div>
        <ul className={styles.mcpCapabilityList} aria-label="Áreas disponibles mediante MCP">
          {domains.map(domain => (
            <li key={domain.key} className={styles.mcpCapabilityItem}>
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>{domain.label}</span>
              <strong className={styles.mcpCapabilityCount}>
                {domain.toolCount ?? '—'}
              </strong>
            </li>
          ))}
        </ul>
        {status?.scopes.length ? (
          <p className={styles.mcpMutedText}>Alcances soportados: {status.scopes.join(' · ')}</p>
        ) : null}
      </div>

      <div className={styles.mcpSubsection}>
        <div className={styles.mcpSubsectionHeader}>
          <div>
            <h3>Conectar una herramienta</h3>
            <p>Elige el cliente y completa la autorización sin guardar tokens en archivos.</p>
          </div>
        </div>
        <SegmentTabs
          tabs={clientTabs}
          value={activeClient}
          onChange={(value) => setActiveClient(value as McpClientKey)}
          aria-label="Herramienta MCP"
        />
        <div className={styles.mcpClientSetup} role="tabpanel">
          <ReadonlyMcpField
            label={selectedClient.valueLabel}
            value={selectedClient.value}
            onCopy={() => onCopy(selectedClient.value, selectedClient.valueLabel)}
          />
          {selectedClient.secondaryValue && selectedClient.secondaryValueLabel && (
            <ReadonlyMcpField
              label={selectedClient.secondaryValueLabel}
              value={selectedClient.secondaryValue}
              onCopy={() => onCopy(selectedClient.secondaryValue || '', selectedClient.secondaryValueLabel || 'comando')}
            />
          )}
          <ol className={styles.mcpStepList}>
            {selectedClient.steps.map((step, index) => (
              <li key={`${selectedClient.key}:${index}`}>
                <span>{index + 1}</span>
                <p>{step}</p>
              </li>
            ))}
          </ol>
          <p className={styles.mcpMutedText}>
            La autorización usa tu sesión normal de Ristak. Inicia sesión, revisa los alcances y acepta; no necesitas generar ni copiar credenciales API para MCP.
          </p>
        </div>
      </div>

      <div className={styles.mcpSubsection}>
        <div className={styles.mcpSubsectionHeader}>
          <div>
            <h3>Conexiones autorizadas</h3>
            <p>Revoca cualquier cliente que ya no deba entrar. El acceso se corta de inmediato.</p>
          </div>
          {auditUrl && (
            <Button variant="secondary" size="sm" onClick={toggleAudit}>
              <Activity size={16} />
              {isAuditOpen ? 'Ocultar auditoría' : 'Ver auditoría'}
            </Button>
          )}
        </div>
        <Table
          columns={connectionColumns}
          data={connections}
          keyExtractor={(connection) => connection.id}
          emptyMessage={isLoading ? 'Cargando conexiones…' : 'Aún no hay herramientas MCP autorizadas.'}
          loading={isLoading}
          searchable={false}
          paginated={false}
          showColumnEditor={false}
        />
        {!auditUrl && (
          <p className={styles.mcpMutedText}>
            El último uso queda visible por conexión; las ejecuciones también se registran en la auditoría del servidor.
          </p>
        )}
      </div>

      {isAuditOpen && auditUrl && (
        <div className={styles.mcpSubsection}>
          <div className={styles.mcpSubsectionHeader}>
            <div>
              <h3>Auditoría MCP</h3>
              <p>Últimas ejecuciones con herramienta, cliente, nivel de riesgo, duración y resultado. Los secretos se muestran redactados.</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadAudit()}
              loading={isLoadingAudit}
              disabled={isLoadingAudit}
            >
              <RefreshCw size={16} />
              Actualizar
            </Button>
          </div>
          {auditError && <p className={styles.mcpStatusMessage}>{auditError}</p>}
          <Table
            columns={auditColumns}
            data={auditEvents}
            keyExtractor={(event) => event.id}
            emptyMessage={isLoadingAudit ? 'Cargando auditoría…' : 'Todavía no hay ejecuciones MCP registradas.'}
            loading={isLoadingAudit}
            searchable={false}
            paginated={false}
            showColumnEditor={false}
          />
        </div>
      )}
    </>
  )
}

interface ReadonlyMcpFieldProps {
  label: string
  value: string
  onCopy: () => void
}

const ReadonlyMcpField: React.FC<ReadonlyMcpFieldProps> = ({ label, value, onCopy }) => (
  <div className={styles.developerReadonlyField}>
    <label>{label}</label>
    <div>
      <input type="text" value={value} readOnly />
      <Button variant="secondary" onClick={onCopy} className={styles.developerCopyButton}>
        <Copy size={16} />
        Copiar
      </Button>
    </div>
  </div>
)
