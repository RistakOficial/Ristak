import React, { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  CheckCircle,
  Copy,
  ExternalLink,
  FileText,
  KeyRound,
  Network,
  RefreshCw,
  ServerCog,
  Trash2,
  Webhook
} from 'lucide-react'
import { Button, Card, SegmentTabs } from '@/components/common'
import type { SegmentTab } from '@/components/common'
import { Badge } from '@/components/common/Badge'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { apiUrl, getApiBaseUrl } from '@/services/apiBaseUrl'
import { formatDateTime } from '@/utils/format'
import { McpAccessPanel } from './McpAccessPanel'
import type { McpHeaderStatus } from './McpAccessPanel'
import styles from './Settings.module.css'

interface ApiTokenMetadata {
  hasToken: boolean
  preview: string | null
  createdAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

interface WebhookEndpoint {
  label: string
  description: string
  path: string
}

type DeveloperSection = 'mcp' | 'credentials' | 'webhooks' | 'docs' | 'logs'

const INITIAL_MCP_STATUS: McpHeaderStatus = {
  label: 'Revisando',
  variant: 'neutral',
  ready: false
}

export const APIAccessSettings: React.FC = () => {
  const { user } = useAuth()
  const { showToast, showConfirm } = useNotification()
  const { timezone } = useTimezone()
  const [appId, setAppId] = useState('')
  const [apiTokenMetadata, setApiTokenMetadata] = useState<ApiTokenMetadata | null>(null)
  const [newApiToken, setNewApiToken] = useState(() => sessionStorage.getItem('ristak_latest_api_token') || '')
  const [isLoadingApiToken, setIsLoadingApiToken] = useState(false)
  const [isRotatingApiToken, setIsRotatingApiToken] = useState(false)
  const [isRevokingApiToken, setIsRevokingApiToken] = useState(false)
  const [activeSection, setActiveSection] = useState<DeveloperSection>('mcp')
  const [mcpHeaderStatus, setMcpHeaderStatus] = useState<McpHeaderStatus>(INITIAL_MCP_STATUS)

  const origin = (getApiBaseUrl() || window.location.origin).replace(/\/+$/, '')
  const externalApiBaseUrl = `${origin}/api/external`
  const mcpServerUrl = `${origin}/api/mcp`
  const webhookEndpoints: WebhookEndpoint[] = [
    {
      label: 'Contactos',
      description: 'Recibe datos del contacto, incluyendo campos personalizados cuando el sistema los mande.',
      path: '/webhook/contact'
    },
    {
      label: 'Citas',
      description: 'Recibe citas nuevas o actualizadas con estados como confirmed, cancelled, showed o noshow.',
      path: '/webhook/appointment'
    },
    {
      label: 'Citas asistidas',
      description: 'Úsala cuando el sistema mande un evento separado para marcar que la persona sí asistió.',
      path: '/webhook/appointment/showed'
    },
    {
      label: 'Pagos',
      description: 'Recibe pagos con estados como paid, succeeded, refunded, partial o pending.',
      path: '/webhook/payment'
    },
    {
      label: 'Plan de pagos',
      description: 'Recibe cambios de planes programados: activo, pausado, cancelado, completado o fallido.',
      path: '/webhook/payment-plan'
    },
    {
      label: 'Reembolsos',
      description: 'Recibe reembolsos y marca el pago relacionado como reembolsado.',
      path: '/webhook/refund'
    }
  ]

  const developerSectionTabs = useMemo<SegmentTab[]>(() => [
    { id: 'mcp', label: 'Conectar con MCP', icon: <Network size={18} /> },
    { id: 'credentials', label: 'Credenciales API', icon: <KeyRound size={18} /> },
    { id: 'webhooks', label: 'Webhooks', icon: <Webhook size={18} /> },
    { id: 'docs', label: 'Documentación', icon: <BookOpen size={18} /> },
    { id: 'logs', label: 'Logs de la app', icon: <ServerCog size={18} /> }
  ], [])

  const authHeaders = () => {
    const token = localStorage.getItem('auth_token')
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  }

  const formatDate = (value: string | null) => formatDateTime(value, {
    fallback: 'Nunca',
    timezone,
    intlOptions: {
      dateStyle: 'medium',
      timeStyle: 'short'
    }
  })

  const copyText = async (value: string, label: string) => {
    if (!value) return

    try {
      await navigator.clipboard.writeText(value)
      showToast('success', 'Copiado', `${label} copiado al portapapeles`)
    } catch {
      showToast('error', 'Error', `No se pudo copiar ${label}`)
    }
  }

  const loadApiToken = async () => {
    setIsLoadingApiToken(true)
    try {
      const response = await fetch(apiUrl('/api/api-access'), { headers: authHeaders() })
      const data = await response.json()
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'No se pudo cargar el acceso API')
      }
      setAppId(data.appId || '')
      setApiTokenMetadata(data.apiToken)
    } catch (error: any) {
      showToast('error', 'Error', error.message || 'No se pudo cargar el acceso API')
    } finally {
      setIsLoadingApiToken(false)
    }
  }

  useEffect(() => {
    if (!user) return
    void loadApiToken()
  }, [user])

  const rotateApiToken = async () => {
    setIsRotatingApiToken(true)
    try {
      const response = await fetch(apiUrl('/api/api-access/token/rotate'), {
        method: 'POST',
        headers: authHeaders()
      })
      const data = await response.json()
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'No se pudo generar el API token')
      }

      setAppId(data.appId || appId)
      setNewApiToken(data.apiToken)
      setApiTokenMetadata(data.apiTokenMetadata)
      showToast('success', 'API token listo', 'Cópialo ahora: no se vuelve a mostrar completo')
    } catch (error: any) {
      showToast('error', 'Error', error.message || 'No se pudo generar el API token')
    } finally {
      setIsRotatingApiToken(false)
    }
  }

  const handleRotateApiToken = async () => {
    if (apiTokenMetadata?.hasToken) {
      showConfirm(
        'Generar nuevo API token',
        'Se invalidará el token actual y cualquier sistema externo conectado con él dejará de funcionar hasta usar el nuevo. Esta acción no se puede deshacer.',
        () => {
          void rotateApiToken()
        },
        'Generar token',
        'Cancelar',
        undefined,
        { typeToConfirm: 'GENERAR' }
      )
      return
    }

    await rotateApiToken()
  }

  const handleCopyApiToken = async () => {
    if (!newApiToken) return

    try {
      await navigator.clipboard.writeText(newApiToken)
      sessionStorage.removeItem('ristak_latest_api_token')
      showToast('success', 'Copiado', 'API token copiado al portapapeles')
    } catch {
      showToast('error', 'Error', 'No se pudo copiar el API token')
    }
  }

  const revokeApiToken = async () => {
    setIsRevokingApiToken(true)
    try {
      const response = await fetch(apiUrl('/api/api-access/token'), {
        method: 'DELETE',
        headers: authHeaders()
      })
      const data = await response.json()
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'No se pudo revocar el API token')
      }

      setAppId(data.appId || appId)
      setNewApiToken('')
      setApiTokenMetadata(data.apiToken)
      showToast('success', 'API token revocado', 'El acceso externo quedó desactivado')
    } catch (error: any) {
      showToast('error', 'Error', error.message || 'No se pudo revocar el API token')
    } finally {
      setIsRevokingApiToken(false)
    }
  }

  const handleRevokeApiToken = () => {
    if (!apiTokenMetadata?.hasToken) return

    showConfirm(
      'Revocar API token',
      'Se desactivará el acceso externo con este token y cualquier sistema conectado con él dejará de funcionar. Esta acción no se puede deshacer.',
      () => {
        void revokeApiToken()
      },
      'Revocar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'REVOCAR' }
    )
  }

  return (
    <div className={styles.settingsContent}>
      <Card>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeaderLeft}>
            <div className={styles.iconBox}>
              <FileText size={22} />
            </div>
            <div>
              <h2 className={styles.panelTitle}>Developers</h2>
              <p className={styles.panelDescription}>
                Conecta agentes de IA y sistemas externos sin brincar permisos, licencias ni auditoría.
              </p>
            </div>
          </div>
          <div className={styles.panelHeaderActions}>
            <Badge variant={mcpHeaderStatus.variant}>
              {mcpHeaderStatus.ready ? <CheckCircle size={15} /> : <Network size={15} />}
              {mcpHeaderStatus.label}
            </Badge>
          </div>
        </div>

        <div className={styles.panelSection}>
          <SegmentTabs
            tabs={developerSectionTabs}
            value={activeSection}
            onChange={(value) => setActiveSection(value as DeveloperSection)}
            aria-label="Secciones de Developers"
          />

          <div className={styles.developerPanel}>
            {activeSection === 'mcp' && (
              <McpAccessPanel
                enabled={Boolean(user)}
                origin={origin}
                serverUrl={mcpServerUrl}
                onCopy={copyText}
                onOpenDocumentation={() => setActiveSection('docs')}
                onStatusChange={setMcpHeaderStatus}
              />
            )}

            {activeSection === 'credentials' && (
              <>
                <SectionHeading
                  icon={<KeyRound size={16} />}
                  title="Credenciales REST/OpenAPI"
                  description="ID público de la app y token secreto revocable para integraciones REST. MCP usa la sesión normal de Ristak."
                />

                <div className={styles.developerInfoGrid}>
                  <InfoField label="App ID" value={isLoadingApiToken ? '' : appId || 'Sin ID'} onCopy={() => copyText(appId, 'App ID')} />
                  <InfoField label="Token activo" value={isLoadingApiToken ? '' : apiTokenMetadata?.preview || 'Sin token'} />
                  <InfoField label="Creado" value={formatDate(apiTokenMetadata?.createdAt || null)} />
                  <InfoField label="Último uso" value={formatDate(apiTokenMetadata?.lastUsedAt || null)} />
                </div>

                <div className={styles.developerFieldStack}>
                  <ReadonlyField label="Endpoint base" value={externalApiBaseUrl} onCopy={() => copyText(externalApiBaseUrl, 'endpoint base')} />
                </div>

                {newApiToken && (
                  <div className={styles.developerTokenBox}>
                    <ReadonlyField label="Nuevo API token" value={newApiToken} onCopy={handleCopyApiToken} />
                  </div>
                )}

                <div className={styles.developerActions}>
                  <Button
                    variant="primary"
                    onClick={handleRotateApiToken}
                    loading={isRotatingApiToken}
                    disabled={isRotatingApiToken || isRevokingApiToken}
                  >
                    <RefreshCw size={18} />
                    {apiTokenMetadata?.hasToken ? 'Rotar token' : 'Generar token'}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={handleRevokeApiToken}
                    loading={isRevokingApiToken}
                    disabled={!apiTokenMetadata?.hasToken || isRotatingApiToken || isRevokingApiToken}
                  >
                    <Trash2 size={18} />
                    Revocar
                  </Button>
                </div>
              </>
            )}

            {activeSection === 'webhooks' && (
              <>
                <SectionHeading
                  icon={<Webhook size={16} />}
                  title="Webhooks"
                  description="URLs POST listas para recibir eventos externos."
                />

                <div className={styles.webhookEndpointList}>
                  {webhookEndpoints.map((endpoint) => {
                    const url = `${origin}${endpoint.path}`
                    return (
                      <div key={endpoint.path} className={styles.webhookEndpointRow}>
                        <div>
                          <p className={styles.webhookEndpointTitle}>{endpoint.label}</p>
                          <p className={styles.webhookEndpointDescription}>{endpoint.description}</p>
                        </div>
                        <ReadonlyField
                          label={`URL POST para ${endpoint.label}`}
                          value={url}
                          onCopy={() => copyText(url, `webhook de ${endpoint.label}`)}
                        />
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {activeSection === 'docs' && (
              <>
                <SectionHeading
                  icon={<BookOpen size={16} />}
                  title="Documentación"
                  description="Referencia de endpoints, autenticación y conexión MCP."
                />

                <div className={styles.developerDocsGrid}>
                  <ReadonlyField label="Endpoint base" value={externalApiBaseUrl} onCopy={() => copyText(externalApiBaseUrl, 'endpoint base')} />
                  <ReadonlyField label="MCP server" value={mcpServerUrl} onCopy={() => copyText(mcpServerUrl, 'MCP server')} />
                </div>

                <a className={styles.developerDocLink} href="/api-docs" target="_blank" rel="noreferrer">
                  <span>
                    <BookOpen size={18} />
                    Abrir documentación API
                  </span>
                  <ExternalLink size={16} />
                </a>
              </>
            )}

            {activeSection === 'logs' && (
              <>
                <SectionHeading
                  icon={<ServerCog size={16} />}
                  title="Logs de la app"
                  description="Registros de sistema para revisar errores, caídas o comportamientos raros."
                />

                <div className={styles.developerLogsBox}>
                  <div className={styles.developerLogsIcon}>
                    <ServerCog size={22} />
                  </div>
                  <div>
                    <h3>Revisión desde soporte</h3>
                    <p>
                      Cuando algo falle, el equipo de Ristak puede abrir el cliente en Ristak Installer y ver sus logs del sistema sin pedirle acceso a Render.
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

interface FieldProps {
  label: string
  value: string
  onCopy?: () => void
}

interface SectionHeadingProps {
  icon: React.ReactNode
  title: string
  description: string
}

const SectionHeading: React.FC<SectionHeadingProps> = ({ icon, title, description }) => (
  <div className={styles.developerSectionHeading}>
    <h3 className={styles.accountSectionTitle}>
      {icon}
      {title}
    </h3>
    <p className={styles.accountSectionDescription}>{description}</p>
  </div>
)

const InfoField: React.FC<FieldProps> = ({ label, value, onCopy }) => (
  <div className={styles.developerInfoField}>
    <p>{label}</p>
    <div>
      <strong>{value}</strong>
      {onCopy && value && (
        <button type="button" onClick={onCopy} aria-label={`Copiar ${label}`}>
          <Copy size={16} />
        </button>
      )}
    </div>
  </div>
)

const ReadonlyField: React.FC<FieldProps> = ({ label, value, onCopy }) => (
  <div className={styles.developerReadonlyField}>
    <label>{label}</label>
    <div>
      <input type="text" value={value} readOnly />
      {onCopy && (
        <Button variant="secondary" onClick={onCopy} className={styles.developerCopyButton}>
          <Copy size={18} />
          Copiar
        </Button>
      )}
    </div>
  </div>
)
