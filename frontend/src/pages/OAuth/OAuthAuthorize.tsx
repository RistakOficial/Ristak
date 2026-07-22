import React from 'react'
import { AlertTriangle, ArrowUpRight, Check, Eye, Pencil, ShieldCheck, Trash2, Zap } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AppStartupLoader, Badge, Button, Card, Logo } from '@/components/common'
import apiClient, { type ApiRequestError } from '@/services/apiClient'
import styles from './OAuthAuthorize.module.css'

const AUTHORIZATION_PARAMETER_NAMES = ['request_id'] as const

type ScopeDetail = {
  value: string
  label: string
  description: string
}

type AuthorizationContext = {
  clientId: string
  clientName: string
  clientUri: string | null
  redirectHost: string
  scopes: ScopeDetail[]
}

type ContextResponse = {
  success: true
  authorization: AuthorizationContext
}

type ConsentResponse = {
  success: true
  redirectUrl: string
}

const SCOPE_ICONS: Record<string, React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
  'ristak.read': Eye,
  'ristak.write': Pencil,
  'ristak.execute': Zap,
  'ristak.destructive': Trash2
}

function authorizationParameters(search: string) {
  const source = new URLSearchParams(search)
  return Object.fromEntries(
    AUTHORIZATION_PARAMETER_NAMES.map(name => [name, source.get(name) || ''])
  )
}

function errorMessage(error: unknown) {
  const requestError = error as ApiRequestError
  const body = requestError?.body as { message?: unknown; error_description?: unknown; error?: unknown } | undefined
  return String(
    body?.message
      || body?.error_description
      || body?.error
      || requestError?.message
      || 'No pudimos validar esta solicitud OAuth.'
  )
}

function errorRedirect(error: unknown) {
  const body = (error as ApiRequestError)?.body as { redirectUrl?: unknown } | undefined
  return typeof body?.redirectUrl === 'string' ? body.redirectUrl : ''
}

function navigateToValidatedRedirect(value: string) {
  const target = new URL(value)
  const loopbackHttp = target.protocol === 'http:' && (
    target.hostname === 'localhost'
    || target.hostname.endsWith('.localhost')
    || target.hostname.startsWith('127.')
    || target.hostname === '[::1]'
  )
  if (target.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('El cliente devolvió una dirección de regreso no permitida.')
  }
  window.location.assign(target.toString())
}

export const OAuthAuthorize: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const requestParameters = React.useMemo(
    () => authorizationParameters(location.search),
    [location.search]
  )
  const [authorization, setAuthorization] = React.useState<AuthorizationContext | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [submitting, setSubmitting] = React.useState<'approve' | 'deny' | null>(null)
  const [error, setError] = React.useState('')
  const [returnUrl, setReturnUrl] = React.useState('')

  React.useEffect(() => {
    let active = true
    const query = new URLSearchParams(requestParameters).toString()

    setLoading(true)
    setError('')
    setReturnUrl('')
    setAuthorization(null)

    apiClient.get<ContextResponse>(`/api/oauth/authorize/context?${query}`, {
      suppressFeatureNotAvailableToast: true
    })
      .then(response => {
        if (!active) return
        setAuthorization(response.authorization)
      })
      .catch(cause => {
        if (!active) return
        setError(errorMessage(cause))
        setReturnUrl(errorRedirect(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [requestParameters])

  const submitDecision = async (decision: 'approve' | 'deny') => {
    if (submitting) return
    setSubmitting(decision)
    setError('')

    try {
      const response = await apiClient.post<ConsentResponse>('/api/oauth/authorize/consent', {
        ...requestParameters,
        decision
      }, {
        suppressFeatureNotAvailableToast: true
      })
      navigateToValidatedRedirect(response.redirectUrl)
    } catch (cause) {
      const redirectUrl = errorRedirect(cause)
      if (redirectUrl) {
        try {
          navigateToValidatedRedirect(redirectUrl)
          return
        } catch (redirectError) {
          setError(errorMessage(redirectError))
        }
      } else {
        setError(errorMessage(cause))
      }
      setSubmitting(null)
    }
  }

  if (loading) {
    return <AppStartupLoader message="Validando conexión segura" />
  }

  if (!authorization) {
    return (
      <main className={styles.page}>
        <Logo size="md" className={styles.logo} />
        <Card className={styles.card} padding="lg">
          <div className={styles.errorIcon} aria-hidden="true">
            <AlertTriangle size={24} />
          </div>
          <div className={styles.centeredCopy}>
            <Badge variant="error">Conexión detenida</Badge>
            <h1>No se puede autorizar esta conexión</h1>
            <p>{error}</p>
          </div>
          <div className={styles.singleAction}>
            {returnUrl ? (
              <Button
                variant="secondary"
                fullWidth
                onClick={() => navigateToValidatedRedirect(returnUrl)}
                leftIcon={<ArrowUpRight size={16} />}
              >
                Volver al cliente
              </Button>
            ) : (
              <Button variant="secondary" fullWidth onClick={() => navigate('/dashboard', { replace: true })}>
                Volver a Ristak
              </Button>
            )}
          </div>
        </Card>
      </main>
    )
  }

  const destructiveRequested = authorization.scopes.some(scope => scope.value === 'ristak.destructive')

  return (
    <main className={styles.page}>
      <Logo size="md" className={styles.logo} />
      <Card className={styles.card} padding="lg">
        <div className={styles.headerIcon} aria-hidden="true">
          <ShieldCheck size={25} />
        </div>
        <header className={styles.header}>
          <Badge variant="info">Conexión OAuth segura</Badge>
          <h1>Autorizar a {authorization.clientName}</h1>
          <p>Esta herramienta quiere conectarse a tu cuenta de Ristak.</p>
        </header>

        <section className={styles.clientSummary} aria-label="Cliente que solicita acceso">
          <div>
            <span>Cliente</span>
            <strong>{authorization.clientName}</strong>
          </div>
          <div>
            <span>Al terminar regresarás a</span>
            <code>{authorization.redirectHost}</code>
          </div>
        </section>

        <section className={styles.permissions} aria-labelledby="oauth-permissions-title">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="oauth-permissions-title">Permisos solicitados</h2>
              <p>Se autorizarán exactamente estos permisos, ni uno más.</p>
            </div>
            <Badge variant="neutral">{authorization.scopes.length}</Badge>
          </div>

          <ul className={styles.scopeList}>
            {authorization.scopes.map(scope => {
              const ScopeIcon = SCOPE_ICONS[scope.value] || Check
              return (
                <li key={scope.value}>
                  <span className={styles.scopeIcon} aria-hidden="true">
                    <ScopeIcon size={18} />
                  </span>
                  <span className={styles.scopeCopy}>
                    <strong>{scope.label}</strong>
                    <span>{scope.description}</span>
                  </span>
                  <code>{scope.value}</code>
                </li>
              )
            })}
          </ul>
        </section>

        {destructiveRequested && (
          <div className={styles.warning} role="note">
            <AlertTriangle size={18} aria-hidden="true" />
            <p><strong>Incluye acciones delicadas.</strong> La herramienta podrá eliminar o revertir datos solamente cuando tú se lo pidas y si tu usuario ya tiene ese permiso.</p>
          </div>
        )}

        {error && (
          <div className={styles.errorMessage} role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className={styles.actions}>
          <Button
            variant="secondary"
            fullWidth
            loading={submitting === 'deny'}
            disabled={Boolean(submitting)}
            onClick={() => void submitDecision('deny')}
          >
            Cancelar
          </Button>
          <Button
            variant="primary"
            fullWidth
            loading={submitting === 'approve'}
            disabled={Boolean(submitting)}
            onClick={() => void submitDecision('approve')}
            leftIcon={<ShieldCheck size={17} />}
          >
            Autorizar conexión
          </Button>
        </div>

        <p className={styles.footerNote}>
          La herramienta sólo podrá usar los módulos que tu usuario ya tiene permitidos. Puedes revocar esta conexión cuando quieras desde Configuración → Developers.
        </p>
      </Card>
    </main>
  )
}

export default OAuthAuthorize
