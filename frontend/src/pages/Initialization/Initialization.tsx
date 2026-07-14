import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Bot, CalendarDays, Check, EyeOff, RefreshCw, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/common/Badge'
import { Button } from '@/components/common/Button'
import { Card } from '@/components/common/Card'
import { MetaBrandMark } from '@/components/common/MetaBrandMark'
import { Modal } from '@/components/common/Modal'
import { PageContainer } from '@/components/common/PageContainer'
import { PageHeader } from '@/components/common/PageHeader'
import { useInitialization, type InitStepId } from '@/contexts/InitializationContext'
import { useNotification } from '@/contexts/NotificationContext'
import { calendarsService } from '@/services/calendarsService'
import { conversationalAgentService } from '@/services/conversationalAgentService'
import { metaOAuthService } from '@/services/metaOAuthService'
import styles from './Initialization.module.css'

type ConnectionAction = InitStepId | 'refresh' | null
type IconType = React.ComponentType<{ size?: number; className?: string }>

interface ConnectionMeta {
  title: string
  description: string
  buttonLabel: string
  icon: IconType
}

const CONNECTION_META: Record<InitStepId, ConnectionMeta> = {
  meta: {
    title: 'Meta',
    description: 'Autoriza tu portafolio una sola vez para usar Facebook, Instagram y tus cuentas publicitarias.',
    buttonLabel: 'Conectar Meta',
    icon: MetaBrandMark
  },
  'google-calendar': {
    title: 'Google Calendar',
    description: 'Autoriza tu cuenta de Google para sincronizar calendarios, disponibilidad y citas.',
    buttonLabel: 'Conectar Google',
    icon: CalendarDays
  },
  openai: {
    title: 'OpenAI',
    description: 'Pega tu API key. Ristak la valida y la guarda cifrada para activar sus funciones de IA.',
    buttonLabel: 'Conectar OpenAI',
    icon: Bot
  }
}

const META_OAUTH_KEYS = [
  'meta_oauth',
  'meta_oauth_handoff_token',
  'meta_oauth_handoff',
  'meta_oauth_kind',
  'meta_oauth_integration_kind',
  'integration_kind',
  'meta_oauth_message',
  'meta_oauth_error_code'
]

const GOOGLE_OAUTH_KEYS = ['google_handoff_token', 'connected']
const OAUTH_RETURN_KEYS = [...META_OAUTH_KEYS, ...GOOGLE_OAUTH_KEYS]

function readOAuthValue(search: URLSearchParams, fragment: URLSearchParams, key: string) {
  return fragment.get(key) || search.get(key) || ''
}

function cleanOAuthReturn(search: URLSearchParams, fragment: URLSearchParams) {
  OAUTH_RETURN_KEYS.forEach(key => {
    search.delete(key)
    fragment.delete(key)
  })

  return {
    pathname: '/initialization',
    search: search.toString() ? `?${search.toString()}` : '',
    hash: fragment.toString() ? `#${fragment.toString()}` : ''
  }
}

export const Initialization: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { showToast } = useNotification()
  const { loading, steps, isInitialized, setHidden, refresh } = useInitialization()
  const handledReturnsRef = useRef(new Set<string>())

  const [activeAction, setActiveAction] = useState<ConnectionAction>(null)
  const [showOpenAIModal, setShowOpenAIModal] = useState(false)
  const [openAIKey, setOpenAIKey] = useState('')
  const [showHideModal, setShowHideModal] = useState(false)

  const connectedCount = useMemo(() => steps.filter(step => step.done).length, [steps])

  useEffect(() => {
    const search = new URLSearchParams(location.search)
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''))
    const metaResult = readOAuthValue(search, fragment, 'meta_oauth')
    const metaHandoff = readOAuthValue(search, fragment, 'meta_oauth_handoff_token')
      || readOAuthValue(search, fragment, 'meta_oauth_handoff')
    const metaKind = readOAuthValue(search, fragment, 'meta_oauth_kind')
      || readOAuthValue(search, fragment, 'meta_oauth_integration_kind')
      || readOAuthValue(search, fragment, 'integration_kind')
    const metaMessage = readOAuthValue(search, fragment, 'meta_oauth_message')
    const metaErrorCode = readOAuthValue(search, fragment, 'meta_oauth_error_code')
    const googleHandoff = readOAuthValue(search, fragment, 'google_handoff_token')
    const googleConnected = readOAuthValue(search, fragment, 'connected') === '1'

    if (!metaResult && !metaHandoff && !googleHandoff && !googleConnected) return

    navigate(cleanOAuthReturn(search, fragment), { replace: true })

    const finishOAuthReturn = async () => {
      if (metaResult || metaHandoff) {
        const returnKey = `meta:${metaHandoff || metaResult}`
        if (handledReturnsRef.current.has(returnKey)) return
        handledReturnsRef.current.add(returnKey)
        setActiveAction('meta')

        try {
          if (metaResult === 'error' || !metaHandoff || (metaKind && metaKind !== 'legacy')) {
            throw new Error(metaMessage || (metaErrorCode === 'meta_scopes_missing'
              ? 'Meta no concedió todos los permisos. Activa todos los accesos y vuelve a intentarlo.'
              : 'La autorización fue cancelada o Meta no devolvió acceso.'))
          }

          await metaOAuthService.complete({ handoffToken: metaHandoff })
          await refresh()
          showToast('success', 'Meta conectado', 'Tu cuenta quedó autorizada. Puedes elegir activos específicos más adelante cuando los necesites.')
        } catch (error) {
          showToast('error', 'Meta no se conectó', error instanceof Error ? error.message : 'No pudimos guardar la autorización de Meta.')
        } finally {
          setActiveAction(null)
        }
        return
      }

      const returnKey = `google:${googleHandoff || 'missing'}`
      if (handledReturnsRef.current.has(returnKey)) return
      handledReturnsRef.current.add(returnKey)
      setActiveAction('google-calendar')

      try {
        if (!googleHandoff) {
          throw new Error('Google autorizó la cuenta, pero no devolvió el acceso necesario para guardarla.')
        }
        await calendarsService.claimGoogleOAuth(googleHandoff)
        await refresh()
        showToast('success', 'Google Calendar conectado', 'La cuenta quedó lista para sincronizar calendarios y citas.')
      } catch (error) {
        showToast('error', 'Google Calendar no se conectó', error instanceof Error ? error.message : 'No pudimos guardar la autorización de Google.')
      } finally {
        setActiveAction(null)
      }
    }

    void finishOAuthReturn()
  }, [location.hash, location.search, navigate, refresh, showToast])

  const handleRefresh = async () => {
    setActiveAction('refresh')
    try {
      await refresh()
      showToast('success', 'Conexiones comprobadas', 'Los estados ya están actualizados.')
    } catch (error) {
      showToast('error', 'No pudimos comprobar las conexiones', error instanceof Error ? error.message : 'Intenta de nuevo en un momento.')
    } finally {
      setActiveAction(null)
    }
  }

  const handleConnectMeta = async () => {
    setActiveAction('meta')
    try {
      const status = await metaOAuthService.getStatus()
      if (!status.available || status.mode !== 'redirect') {
        throw new Error(status.error || 'La conexión segura con Meta todavía no está disponible.')
      }
      const connection = await metaOAuthService.createConnectUrl('/initialization')
      if (!connection.connectUrl) throw new Error('Meta no devolvió una URL segura de conexión.')
      window.location.assign(connection.connectUrl)
    } catch (error) {
      setActiveAction(null)
      showToast('error', 'No pudimos abrir Meta', error instanceof Error ? error.message : 'Intenta de nuevo en un momento.')
    }
  }

  const handleConnectGoogle = async () => {
    setActiveAction('google-calendar')
    try {
      const connection = await calendarsService.getGoogleConnectUrl('/initialization')
      if (!connection.url) throw new Error('Google no devolvió una URL segura de conexión.')
      window.location.assign(connection.url)
    } catch (error) {
      setActiveAction(null)
      showToast('error', 'No pudimos abrir Google Calendar', error instanceof Error ? error.message : 'Intenta de nuevo en un momento.')
    }
  }

  const handleConnectOpenAI = async (event: React.FormEvent) => {
    event.preventDefault()
    const apiKey = openAIKey.trim()
    if (!apiKey.startsWith('sk-') || apiKey.length < 30) {
      showToast('error', 'API key incompleta', 'Pega la API key completa de OpenAI; debe iniciar con sk-.')
      return
    }

    setActiveAction('openai')
    try {
      await conversationalAgentService.connectAIProvider('openai', apiKey)
      await refresh()
      setOpenAIKey('')
      setShowOpenAIModal(false)
      showToast('success', 'OpenAI conectado', 'La API key fue validada y guardada de forma cifrada.')
    } catch (error) {
      showToast('error', 'OpenAI no se conectó', error instanceof Error ? error.message : 'Revisa la API key e intenta de nuevo.')
    } finally {
      setActiveAction(null)
    }
  }

  const handleConnection = (id: InitStepId) => {
    if (id === 'meta') {
      void handleConnectMeta()
      return
    }
    if (id === 'google-calendar') {
      void handleConnectGoogle()
      return
    }
    setShowOpenAIModal(true)
  }

  const handleConfirmHide = async () => {
    await setHidden(true)
    navigate('/dashboard', { replace: true })
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Inicialización"
        title="Conecta tus cuentas"
        subtitle="Tres conexiones y listo. Todo se autoriza desde aquí, sin brincar a Configuración."
        actions={(
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleRefresh()}
              loading={activeAction === 'refresh'}
              leftIcon={<RefreshCw size={15} />}
            >
              Comprobar
            </Button>
            {isInitialized && (
              <Button size="sm" onClick={() => navigate('/dashboard')} leftIcon={<Check size={15} />}>
                Ir al dashboard
              </Button>
            )}
          </>
        )}
      />

      <div className={styles.content}>
        <div className={styles.progress} aria-label={`${connectedCount} de ${steps.length} cuentas conectadas`}>
          <div className={styles.progressCopy}>
            <span>Progreso</span>
            <strong>{connectedCount} de {steps.length}</strong>
          </div>
          <div className={styles.progressSegments} aria-hidden="true">
            {steps.map(step => (
              <span key={step.id} className={`${styles.progressSegment} ${step.done ? styles.progressSegmentDone : ''}`} />
            ))}
          </div>
        </div>

        <Card padding="none" className={styles.connectionSurface}>
          {steps.map(step => {
            const meta = CONNECTION_META[step.id]
            const Icon = meta.icon
            return (
              <section key={step.id} className={styles.connectionRow} data-connection={step.id}>
                <div className={styles.connectionIcon} aria-hidden="true">
                  {step.done ? <Check size={22} /> : <Icon size={22} />}
                </div>
                <div className={styles.connectionCopy}>
                  <div className={styles.connectionHeading}>
                    <h2>{meta.title}</h2>
                    <Badge variant={step.done ? 'success' : 'neutral'}>
                      {step.done ? 'Conectada' : 'Pendiente'}
                    </Badge>
                  </div>
                  <p>{meta.description}</p>
                </div>
                <div className={styles.connectionAction}>
                  {step.done ? (
                    <span className={styles.connectedText}><Check size={16} /> Lista</span>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleConnection(step.id)}
                      loading={activeAction === step.id}
                      disabled={loading || (activeAction !== null && activeAction !== step.id)}
                    >
                      {meta.buttonLabel}
                    </Button>
                  )}
                </div>
              </section>
            )
          })}
        </Card>

        <div className={styles.securityNote}>
          <ShieldCheck size={18} aria-hidden="true" />
          <p>Meta y Google abren su autorización oficial. Las credenciales que Ristak necesita conservar se guardan cifradas.</p>
        </div>

        <div className={styles.footer}>
          <p>¿Todavía no tienes alguna cuenta? Puedes entrar a Ristak y conectarla después.</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowHideModal(true)}
            leftIcon={<EyeOff size={15} />}
            disabled={loading}
          >
            Hacerlo después
          </Button>
        </div>
      </div>

      <Modal
        isOpen={showOpenAIModal}
        onClose={() => {
          if (activeAction !== 'openai') setShowOpenAIModal(false)
        }}
        type="custom"
        size="sm"
        title="Conectar OpenAI"
        subtitle="La key se valida antes de guardarse y nunca vuelve a mostrarse completa."
        closeOnBackdropClick={activeAction !== 'openai'}
        closeOnEscape={activeAction !== 'openai'}
      >
        <form className={styles.credentialForm} onSubmit={handleConnectOpenAI}>
          <label htmlFor="initialization-openai-key">API key de OpenAI</label>
          <input
            id="initialization-openai-key"
            type="password"
            value={openAIKey}
            onChange={event => setOpenAIKey(event.target.value)}
            placeholder="sk-..."
            autoComplete="off"
            spellCheck={false}
            autoFocus
            disabled={activeAction === 'openai'}
          />
          <p className={styles.credentialHint}>La encuentras en tu cuenta de OpenAI. No la pegues en chats ni documentos.</p>
          <div className={styles.credentialActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowOpenAIModal(false)}
              disabled={activeAction === 'openai'}
            >
              Cancelar
            </Button>
            <Button type="submit" loading={activeAction === 'openai'} disabled={!openAIKey.trim()}>
              Validar y conectar
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={showHideModal}
        onClose={() => setShowHideModal(false)}
        type="confirm"
        title="Ocultar inicialización"
        message="Dejaremos de mostrar esta página al entrar. Las conexiones seguirán disponibles desde sus secciones correspondientes."
        confirmText="Ocultar"
        cancelText="Cancelar"
        typeToConfirm="OCULTAR"
        onConfirm={handleConfirmHide}
      />
    </PageContainer>
  )
}
