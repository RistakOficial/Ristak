import React, { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Facebook,
  Instagram,
  Megaphone,
  Target,
  MessageCircle,
  Code2,
  PlugZap,
  Bot,
  Calendar,
  CheckCircle2,
  ArrowRight,
  ExternalLink,
  RefreshCw,
  EyeOff,
  Rocket,
  Check
} from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Logo } from '@/components/common/Logo'
import { Modal } from '@/components/common/Modal'
import { useInitialization, type InitStepId } from '@/contexts/InitializationContext'
import styles from './Initialization.module.css'

type IconType = React.ComponentType<{ size?: number | string; className?: string }>

interface StepMeta {
  title: string
  description: string
  icon: IconType
  /** Ruta interna a la pantalla de conexión. */
  to?: string
  /** Enlace externo (guía). */
  externalHref?: string
  externalLabel?: string
}

const STEP_META: Record<InitStepId, StepMeta> = {
  'facebook-page': {
    title: 'Conecta tu página de Facebook',
    description: 'Empieza por la página principal del negocio. Es la base para conectar Instagram, anuncios y permisos de Meta.',
    icon: Facebook,
    to: '/settings/meta-ads'
  },
  instagram: {
    title: 'Conecta Instagram',
    description: 'Vincula la cuenta de Instagram que ya vive dentro del mismo negocio y página de Facebook.',
    icon: Instagram,
    to: '/settings/meta-ads'
  },
  'ad-account': {
    title: 'Selecciona tu cuenta publicitaria',
    description: 'Conecta la cuenta publicitaria desde la que Ristak va a leer métricas y administrar campañas.',
    icon: Megaphone,
    to: '/settings/meta-ads'
  },
  pixel: {
    title: 'Conecta el píxel de Facebook',
    description: 'Selecciona el píxel o dataset de Meta para medir visitas, formularios y resultados de campañas.',
    icon: Target,
    to: '/settings/meta-ads'
  },
  whatsapp: {
    title: 'Conecta tu aplicación de WhatsApp Business',
    description: 'Vincula la cuenta o número de WhatsApp Business que usarás para conversaciones y seguimiento.',
    icon: MessageCircle,
    to: '/settings/whatsapp'
  },
  'meta-app': {
    title: 'Crea la cuenta y app en Meta Developers',
    description: 'Crea o entra a Meta Developers y prepara la aplicación que tendrá permisos para Marketing, Instagram y WhatsApp.',
    icon: Code2,
    externalHref: 'https://developers.facebook.com/apps/',
    externalLabel: 'Abrir Meta Developers'
  },
  'meta-connect': {
    title: 'Conecta la app de Meta Developers',
    description: 'Vincula la app de Meta Developers con Ristak para que use tus permisos y activos correctamente.',
    icon: PlugZap,
    to: '/settings/meta-ads'
  },
  'whatsapp-api': {
    title: 'Agrega WhatsApp API a Meta Developers',
    description: 'Dentro de la app de Meta Developers, conecta WhatsApp API para que Ristak pueda operar mensajes oficiales desde esa app.',
    icon: MessageCircle,
    to: '/settings/whatsapp'
  },
  openai: {
    title: 'Conecta OpenAI',
    description: 'Agrega tu clave de OpenAI para activar el agente de inteligencia artificial.',
    icon: Bot,
    to: '/ai-agent/general'
  },
  'google-calendar': {
    title: 'Conecta Google Calendar',
    description: 'Opcional. Sincroniza tu calendario para gestionar citas y disponibilidad.',
    icon: Calendar,
    to: '/settings/calendars/google'
  }
}

const HIDE_CONFIRM_WORD = 'OCULTAR'

export const Initialization: React.FC = () => {
  const navigate = useNavigate()
  const {
    loading,
    steps,
    requiredDone,
    requiredTotal,
    isInitialized,
    setHidden,
    setMetaAppDone,
    refresh
  } = useInitialization()

  const [showHideModal, setShowHideModal] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const pct = useMemo(() => {
    if (requiredTotal === 0) return 0
    return Math.round((requiredDone / requiredTotal) * 100)
  }, [requiredDone, requiredTotal])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  const handleConfirmHide = async () => {
    await setHidden(true)
    navigate('/dashboard', { replace: true })
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden="true" />
        <span className={styles.heroBadge}>
          <Rocket size={14} />
          Inicialización
        </span>
        <h1 className={styles.heroTitle}>Pon en marcha tu</h1>
        <Logo size="lg" className={styles.heroLogo} />
        <p className={styles.heroSubtitle}>
          Conecta tus integraciones en orden para dejar todo listo. A medida que las completes,
          esta página se actualizará sola y desaparecerá del menú cuando termines lo esencial.
        </p>

        <div className={styles.progressWrap}>
          <div className={styles.progressMeta}>
            <span className={styles.progressLabel}>
              {requiredDone} de {requiredTotal} pasos esenciales completados
            </span>
            <span className={styles.progressPct}>{pct}%</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressBar} style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div className={styles.toolbar}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefresh}
            loading={refreshing}
            leftIcon={<RefreshCw size={15} />}
          >
            Volver a comprobar
          </Button>
          {isInitialized && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/dashboard')}
              leftIcon={<Check size={15} />}
            >
              Ir al dashboard
            </Button>
          )}
        </div>
      </div>

      <div className={styles.steps}>
        {steps.map((step, index) => {
          const meta = STEP_META[step.id]
          const Icon = meta.icon
          return (
            <div
              key={step.id}
              className={`${styles.step} ${step.done ? styles.stepDone : ''}`}
              style={{ ['--delay' as string]: `${index * 60}ms` }}
            >
              <div className={`${styles.stepIcon} ${step.done ? styles.stepIconDone : ''}`}>
                {step.done ? <CheckCircle2 size={22} /> : <Icon size={22} />}
              </div>

              <div className={styles.stepBody}>
                <div className={styles.stepTitleRow}>
                  <span className={styles.stepTitle}>{meta.title}</span>
                  {!step.required && step.done && (
                    <span className={`${styles.badge} ${styles.badgeDone}`}>Conectado</span>
                  )}
                  {!step.required && !step.done && (
                    <span className={`${styles.badge} ${styles.badgeOptional}`}>Opcional</span>
                  )}
                </div>
                <p className={styles.stepDesc}>{meta.description}</p>
              </div>

              <div className={styles.stepAction}>
                {step.done ? (
                  <span className={styles.checkDone}>
                    <Check size={16} /> Listo
                  </span>
                ) : step.manual ? (
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {meta.externalHref && (
                      <a href={meta.externalHref} target="_blank" rel="noreferrer">
                        <Button variant="ghost" size="sm" leftIcon={<ExternalLink size={15} />}>
                          {meta.externalLabel || 'Abrir guía'}
                        </Button>
                      </a>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => setMetaAppDone(true)}>
                      Marcar como hecho
                    </Button>
                  </div>
                ) : meta.to ? (
                  <Link to={meta.to} className={styles.linkBtn}>
                    <Button variant="primary" size="sm" leftIcon={<ArrowRight size={15} />}>
                      Conectar
                    </Button>
                  </Link>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <div className={styles.footer}>
        <p className={styles.footerText}>
          ¿No vas a conectar algo por ahora? Puedes ocultar esta página de inicialización.
          Desaparecerá del menú y dejaremos de redirigirte aquí.
        </p>
        <Button
          variant="danger"
          size="sm"
          onClick={() => setShowHideModal(true)}
          leftIcon={<EyeOff size={15} />}
          disabled={loading}
        >
          Ocultar inicialización
        </Button>
      </div>

      <Modal
        isOpen={showHideModal}
        onClose={() => setShowHideModal(false)}
        type="confirm"
        title="Ocultar inicialización"
        message="Esta página dejará de mostrarse en el menú y ya no te redirigiremos aquí al entrar. Podrás seguir conectando integraciones desde Configuración."
        confirmText="Ocultar"
        cancelText="Cancelar"
        typeToConfirm={HIDE_CONFIRM_WORD}
        onConfirm={handleConfirmHide}
      />
    </div>
  )
}
