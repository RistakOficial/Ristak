import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bell, BellRing, MessageCircle } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { Button, Modal } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import { mobileAppService } from '@/services/mobileAppService'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import styles from './MobileNotificationOnboarding.module.css'

type PromptStep = 'intro' | 'first_decline' | 'final_decline' | 'system_denied'

const STORAGE_PREFIX = 'ristak_mobile_message_notifications_prompt_v1'
const SHOW_DELAY_MS = 650

function getStoredDecision(storageKey: string) {
  try {
    return window.localStorage.getItem(storageKey)
  } catch {
    return null
  }
}

function saveStoredDecision(storageKey: string, value: 'accepted' | 'declined') {
  try {
    window.localStorage.setItem(storageKey, value)
  } catch {
    // If storage is blocked, the permission state still controls the real behavior.
  }
}

function getBrowserNotificationPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'default'
  return window.Notification.permission
}

function getStepCopy(step: PromptStep, denialReason = '') {
  if (step === 'first_decline') {
    return {
      icon: AlertTriangle,
      eyebrow: 'Notificaciones apagadas',
      title: 'Sin notificaciones te puedes perder mensajes',
      message: 'Si rechazas esto, el celular no te va a notificar cuando llegue un WhatsApp nuevo. Tendrás que abrir la app para revisar si alguien escribió.',
      primary: 'Mejor activar',
      secondary: 'Seguir sin notificaciones',
      warning: true
    }
  }

  if (step === 'final_decline') {
    return {
      icon: Bell,
      eyebrow: 'Última confirmación',
      title: '¿Seguro que no quieres notificaciones?',
      message: 'Esta es la última pregunta. Si dejas las notificaciones apagadas, no vas a saber al momento cuando un cliente te mande mensaje.',
      primary: 'Activar notificaciones',
      secondary: 'Sí, no quiero notificaciones',
      warning: true
    }
  }

  if (step === 'system_denied') {
    return {
      icon: AlertTriangle,
      eyebrow: 'El celular no activó notificaciones',
      title: 'Todavía no van a llegar notificaciones',
      message: 'El permiso no quedó activo. Puedes intentar otra vez o seguir sin notificaciones en este celular.',
      primary: 'Intentar activar',
      secondary: 'Seguir sin notificaciones',
      reason: denialReason,
      warning: true
    }
  }

  return {
    icon: MessageCircle,
    eyebrow: 'Mensajes de WhatsApp',
    title: 'Activa las notificaciones',
    message: 'Para saber al momento cuando un cliente te escribe, es súper importante activar las notificaciones de mensajes en este celular.',
    primary: 'Activar',
    secondary: 'Ahora no',
    warning: false
  }
}

export function MobileNotificationOnboarding() {
  const location = useLocation()
  const { isAuthenticated, isLoading, user } = useAuth()
  const { showToast } = useNotification()
  const [visible, setVisible] = useState(false)
  const [step, setStep] = useState<PromptStep>('intro')
  const [busy, setBusy] = useState(false)
  const [denialReason, setDenialReason] = useState('')

  const storageKey = useMemo(() => (
    user?.id ? `${STORAGE_PREFIX}:${user.id}` : STORAGE_PREFIX
  ), [user?.id])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    let cancelled = false
    const isPhoneRoute = location.pathname.startsWith('/phone')
    if (isLoading || !isAuthenticated || !isPhoneRoute) {
      setVisible(false)
      return undefined
    }

    const preparePrompt = async () => {
      if (mobileAppService.isNative()) {
        const nativePermission = await mobileAppService.getPushPermissionStatus()
        if (cancelled) return
        if (nativePermission === 'granted') {
          saveStoredDecision(storageKey, 'accepted')
          setVisible(false)
          return
        }
      } else if (getBrowserNotificationPermission() === 'granted') {
        saveStoredDecision(storageKey, 'accepted')
        setVisible(false)
        return
      }

      const storedDecision = getStoredDecision(storageKey)
      if (storedDecision === 'accepted' || storedDecision === 'declined') {
        return
      }

      const timer = window.setTimeout(() => {
        if (cancelled) return
        setStep('intro')
        setDenialReason('')
        setVisible(true)
      }, SHOW_DELAY_MS)

      cleanupTimer = () => window.clearTimeout(timer)
    }

    let cleanupTimer: () => void = () => undefined
    void preparePrompt()

    return () => {
      cancelled = true
      cleanupTimer()
    }
  }, [isAuthenticated, isLoading, location.pathname, storageKey])

  const closeAsAccepted = () => {
    saveStoredDecision(storageKey, 'accepted')
    setVisible(false)
    setStep('intro')
    setDenialReason('')
  }

  const closeAsDeclined = () => {
    saveStoredDecision(storageKey, 'declined')
    setVisible(false)
    setStep('intro')
    setDenialReason('')
    showToast(
      'warning',
      'Notificaciones apagadas',
      'No recibirás notificaciones de mensajes en este celular. Puedes activarlas después desde ajustes.'
    )
  }

  const handleActivate = async () => {
    setBusy(true)
    try {
      const result = await pushNotificationsService.subscribeToAppNotifications()

      if (result.status === 'subscribed') {
        closeAsAccepted()
        showToast('success', 'Notificaciones activadas', 'Este celular ya puede notificarte cuando llegue un mensaje.')
        return
      }

      setDenialReason(result.reason)
      setStep('system_denied')
    } catch (error: any) {
      setDenialReason(error?.message || 'No se pudo pedir el permiso de notificaciones.')
      setStep('system_denied')
    } finally {
      setBusy(false)
    }
  }

  const handleDecline = () => {
    if (step === 'intro') {
      setStep('first_decline')
      return
    }

    if (step === 'first_decline') {
      setStep('final_decline')
      return
    }

    closeAsDeclined()
  }

  const handleClose = () => {
    if (busy) return
    handleDecline()
  }

  const copy = getStepCopy(step, denialReason)
  const Icon = copy.icon
  const permission = getBrowserNotificationPermission()
  const reason = copy.reason || (step === 'system_denied' && permission === 'denied'
    ? 'El celular bloqueó las notificaciones. Si no aparece el permiso otra vez, actívalas desde los ajustes del sistema.'
    : '')

  return (
    <Modal
      isOpen={visible}
      onClose={handleClose}
      title=""
      type="custom"
      className={styles.panel}
      backdropClassName={styles.backdrop}
      contentClassName={styles.content}
      showCloseButton={false}
    >
      <span className={`${styles.iconShell} ${copy.warning ? styles.iconShellWarning : ''}`}>
        <Icon size={28} />
      </span>

      <div className={styles.copy}>
        <p className={styles.eyebrow}>{copy.eyebrow}</p>
        <h2 className={styles.title}>{copy.title}</h2>
        <p className={styles.message}>{copy.message}</p>
      </div>

      {reason && (
        <p className={styles.reason}>{reason}</p>
      )}

      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          size="large"
          onClick={handleDecline}
          disabled={busy}
        >
          {copy.secondary}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="large"
          onClick={handleActivate}
          loading={busy}
        >
          <BellRing size={18} />
          {copy.primary}
        </Button>
      </div>
    </Modal>
  )
}
