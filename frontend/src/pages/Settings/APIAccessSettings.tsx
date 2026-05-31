import React, { useEffect, useState } from 'react'
import { ArrowRight, BookOpen, Copy, KeyRound, RefreshCw, Trash2 } from 'lucide-react'
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

export const APIAccessSettings: React.FC = () => {
  const { user } = useAuth()
  const { showToast } = useNotification()
  const [appId, setAppId] = useState('')
  const [apiTokenMetadata, setApiTokenMetadata] = useState<ApiTokenMetadata | null>(null)
  const [newApiToken, setNewApiToken] = useState(() => sessionStorage.getItem('ristak_latest_api_token') || '')
  const [isLoadingApiToken, setIsLoadingApiToken] = useState(false)
  const [isRotatingApiToken, setIsRotatingApiToken] = useState(false)
  const [isRevokingApiToken, setIsRevokingApiToken] = useState(false)

  const origin = API_URL || window.location.origin
  const externalApiBaseUrl = `${origin}/api/external`
  const mcpServerUrl = `${origin}/api/mcp`

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

  const handleRotateApiToken = async () => {
    if (apiTokenMetadata?.hasToken && !window.confirm('Esto invalida el token actual. ¿Generar uno nuevo?')) {
      return
    }

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

  const handleRevokeApiToken = async () => {
    if (!apiTokenMetadata?.hasToken) return
    if (!window.confirm('Esto desactiva el acceso externo con este token. ¿Revocarlo?')) {
      return
    }

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

  return (
    <div className={styles.settingsContent}>
      <div className={styles.settingsSection}>
        <h2 className={styles.sectionTitle}>Acceso API</h2>
        <p className={styles.sectionDescription}>
          Configura credenciales para sistemas externos
        </p>

        <Card variant="glass" padding="lg" style={{ marginTop: '1.5rem' }}>
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
        </Card>
      </div>
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
    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
      <input
        type="text"
        value={value}
        readOnly
        style={{
          width: '100%',
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
