import React, { useEffect, useState } from 'react'
import { ArrowRight, BookOpen, CheckCircle, ChevronDown, Copy, KeyRound, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { Button, Card } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './Settings.module.css'

const API_URL = import.meta.env.VITE_API_URL || ''

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

export const APIAccessSettings: React.FC = () => {
  const { user } = useAuth()
  const { showToast, showConfirm } = useNotification()
  const [appId, setAppId] = useState('')
  const [apiTokenMetadata, setApiTokenMetadata] = useState<ApiTokenMetadata | null>(null)
  const [newApiToken, setNewApiToken] = useState(() => sessionStorage.getItem('ristak_latest_api_token') || '')
  const [isLoadingApiToken, setIsLoadingApiToken] = useState(false)
  const [isRotatingApiToken, setIsRotatingApiToken] = useState(false)
  const [isRevokingApiToken, setIsRevokingApiToken] = useState(false)
  const [areWebhooksOpen, setAreWebhooksOpen] = useState(false)

  const origin = (API_URL || window.location.origin).replace(/\/+$/, '')
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

  const authHeaders = () => {
    const token = localStorage.getItem('auth_token')
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  }

  const formatDate = (value: string | null) => {
    if (!value) return 'Nunca'
    return new Date(value).toLocaleString('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  }

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
      const response = await fetch(`${API_URL}/api/api-access`, {
        headers: authHeaders()
      })
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
    loadApiToken()
  }, [user])

  const rotateApiToken = async () => {
    setIsRotatingApiToken(true)

    try {
      const response = await fetch(`${API_URL}/api/api-access/token/rotate`, {
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
        'Esto invalida el token actual. ¿Generar uno nuevo?',
        () => {
          void rotateApiToken()
        },
        'Generar token',
        'Cancelar'
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
      const response = await fetch(`${API_URL}/api/api-access/token`, {
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

  const handleRevokeApiToken = async () => {
    if (!apiTokenMetadata?.hasToken) return

    showConfirm(
      'Revocar API token',
      'Esto desactiva el acceso externo con este token. ¿Revocarlo?',
      () => {
        void revokeApiToken()
      },
      'Revocar',
      'Cancelar'
    )
  }

  return (
    <div className={styles.settingsContent}>
      <Card>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeaderLeft}>
            <div className={styles.iconBox}>
              <KeyRound size={22} />
            </div>
            <div>
              <h2 className={styles.panelTitle}>Acceso API</h2>
              <p className={styles.panelDescription}>
                Configura credenciales para sistemas externos
              </p>
            </div>
          </div>
          <div className={styles.panelHeaderActions}>
            <div className={apiTokenMetadata?.hasToken ? styles.statusConnected : styles.statusDisconnected}>
              {apiTokenMetadata?.hasToken ? <CheckCircle size={15} /> : <XCircle size={15} />}
              {apiTokenMetadata?.hasToken ? 'Token activo' : 'Sin token'}
            </div>
          </div>
        </div>

        <div className={styles.panelSection}>
          <div style={{ marginBottom: '1.25rem' }}>
            <h3 style={{
              fontSize: '1rem',
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              margin: '0 0 0.5rem 0',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <KeyRound size={18} />
              Credenciales externas
            </h3>
            <p style={{
              fontSize: '0.875rem',
              color: 'var(--color-text-tertiary)',
              margin: 0
            }}>
              ID público de la app y token secreto revocable
            </p>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '0.75rem',
            marginBottom: '1rem'
          }}>
            <InfoField label="App ID" value={isLoadingApiToken ? 'Cargando...' : appId || 'Sin ID'} onCopy={() => copyText(appId, 'App ID')} />
            <InfoField label="Token activo" value={isLoadingApiToken ? 'Cargando...' : apiTokenMetadata?.preview || 'Sin token'} />
            <InfoField label="Creado" value={formatDate(apiTokenMetadata?.createdAt || null)} />
            <InfoField label="Último uso" value={formatDate(apiTokenMetadata?.lastUsedAt || null)} />
          </div>

          <div style={{ display: 'grid', gap: '1rem', marginBottom: '1rem' }}>
            <ReadonlyField label="Endpoint base" value={externalApiBaseUrl} onCopy={() => copyText(externalApiBaseUrl, 'endpoint base')} />
            <ReadonlyField label="MCP server" value={mcpServerUrl} onCopy={() => copyText(mcpServerUrl, 'MCP server')} />
          </div>

          {newApiToken && (
            <div style={{ marginBottom: '1rem' }}>
              <ReadonlyField label="Nuevo API token" value={newApiToken} onCopy={handleCopyApiToken} />
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
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

          <div style={{
            marginTop: '1.5rem',
            paddingTop: '1.5rem',
            borderTop: '1px solid rgba(148, 163, 184, 0.16)'
          }}>
            <button
              type="button"
              onClick={() => setAreWebhooksOpen((current) => !current)}
              aria-expanded={areWebhooksOpen}
              aria-controls="api-webhooks-panel"
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem',
                padding: '0.875rem 0',
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left'
              }}>
              <span style={{ display: 'grid', gap: '0.25rem', minWidth: 0 }}>
                <span style={{
                  color: 'var(--color-text-primary)',
                  fontSize: '1rem',
                  fontWeight: 600
                }}>
                  Webhooks
                </span>
                <span style={{
                  color: 'var(--color-text-tertiary)',
                  fontSize: '0.875rem',
                  lineHeight: 1.45
                }}>
                  URLs POST listas para recibir eventos externos.
                </span>
              </span>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                color: 'var(--color-text-secondary)',
                fontSize: '0.8125rem',
                fontWeight: 600,
                whiteSpace: 'nowrap'
              }}>
                {webhookEndpoints.length} URLs
                <ChevronDown
                  size={18}
                  style={{
                    transition: 'transform 160ms ease',
                    transform: areWebhooksOpen ? 'rotate(180deg)' : 'rotate(0deg)'
                  }}
                />
              </span>
            </button>

            {areWebhooksOpen && (
              <div id="api-webhooks-panel" style={{ paddingTop: '0.25rem' }}>
                <p style={{
                  fontSize: '0.875rem',
                  color: 'var(--color-text-tertiary)',
                  margin: '0 0 1rem 0',
                  maxWidth: '48rem'
                }}>
                  Copia la URL del evento y pégala en el sistema que lo va a mandar. Cuando ese sistema haga POST, Ristak recibirá la información.
                </p>

                <div style={{ display: 'grid', gap: '0.875rem' }}>
                  {webhookEndpoints.map((endpoint) => {
                    const url = `${origin}${endpoint.path}`

                    return (
                      <div
                        key={endpoint.path}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))',
                          gap: '1rem',
                          alignItems: 'center',
                          padding: '0.875rem 0',
                          borderBottom: '1px solid rgba(148, 163, 184, 0.12)'
                        }}
                      >
                        <div>
                          <p style={{
                            margin: '0 0 0.25rem 0',
                            color: 'var(--color-text-primary)',
                            fontSize: '0.925rem',
                            fontWeight: 600
                          }}>
                            {endpoint.label}
                          </p>
                          <p style={{
                            margin: 0,
                            color: 'var(--color-text-tertiary)',
                            fontSize: '0.78rem',
                            lineHeight: 1.45
                          }}>
                            {endpoint.description}
                          </p>
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
              </div>
            )}
          </div>

          <a
            href="/api-docs"
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
              marginTop: '1.25rem',
              padding: '0.875rem 1rem',
              borderRadius: '0.75rem',
              border: '1px solid rgba(148, 163, 184, 0.18)',
              background: 'rgba(148, 163, 184, 0.06)',
              color: 'var(--color-text-primary)',
              textDecoration: 'none'
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
              <BookOpen size={18} style={{ flexShrink: 0, color: 'var(--color-primary)' }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600 }}>
                  Documentación API
                </span>
                <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-text-tertiary)', marginTop: '0.125rem' }}>
                  Endpoints, autenticación y conexión MCP
                </span>
              </span>
            </span>
            <ArrowRight size={18} style={{ flexShrink: 0 }} />
          </a>
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

const InfoField: React.FC<FieldProps> = ({ label, value, onCopy }) => (
  <div style={{
    padding: '0.75rem 1rem',
    background: 'rgba(148, 163, 184, 0.08)',
    borderRadius: '0.75rem',
    border: '1px solid rgba(148, 163, 184, 0.15)'
  }}>
    <p style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', margin: '0 0 0.25rem 0' }}>
      {label}
    </p>
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <p style={{ fontSize: '0.875rem', color: 'var(--color-text-primary)', margin: 0, wordBreak: 'break-all', flex: 1 }}>
        {value}
      </p>
      {onCopy && value && !value.startsWith('Cargando') && (
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copiar ${label}`}
          style={{
            border: 0,
            background: 'transparent',
            color: 'var(--color-text-secondary)',
            cursor: 'pointer',
            padding: '0.25rem',
            lineHeight: 0
          }}
        >
          <Copy size={16} />
        </button>
      )}
    </div>
  </div>
)

const ReadonlyField: React.FC<FieldProps> = ({ label, value, onCopy }) => (
  <div>
    <label style={{
      display: 'block',
      fontSize: '0.875rem',
      fontWeight: 500,
      color: 'var(--color-text-secondary)',
      marginBottom: '0.5rem'
    }}>
      {label}
    </label>
    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', minWidth: 0 }}>
      <input
        type="text"
        value={value}
        readOnly
        style={{
          width: '100%',
          minWidth: 0,
          height: '2.75rem',
          padding: '0 1rem',
          background: 'rgba(148, 163, 184, 0.06)',
          border: '1px solid rgba(148, 163, 184, 0.18)',
          borderRadius: '0.75rem',
          color: 'var(--color-text-primary)',
          fontSize: '0.875rem'
        }}
      />
      {onCopy && (
        <Button variant="secondary" onClick={onCopy} style={{ flexShrink: 0 }}>
          <Copy size={18} />
          Copiar
        </Button>
      )}
    </div>
  </div>
)
