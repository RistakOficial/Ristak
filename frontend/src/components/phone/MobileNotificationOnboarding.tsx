import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bell, BellRing, MessageCircle } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { Button, Modal } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { mobileAppService } from '@/services/mobileAppService'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import { DEFAULT_CRM_LABELS, formatCrmLabelLower } from '@/utils/crmLabels'
import { getPortableDeviceMode, isPhoneAppPath } from '@/utils/phoneAccess'
import styles from './MobileNotificationOnboarding.module.css'

type PromptStep = 'intro' | 'first_decline' | 'final_decline' | 'system_denied'
type NotificationPromptSurface = 'native_phone' | 'mobile_browser' | 'desktop_browser'

const STORAGE_PREFIX = 'ristak_mobile_message_notifications_prompt_v1'
const SHOW_DELAY_MS = 650
const REGISTRATION_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000
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

function getRegistrationSyncKey(storageKey: string) {
  return `${storageKey}:registration_synced_at`
}

function hasFreshRegistrationSync(storageKey: string) {
  try {
    const raw = window.localStorage.getItem(getRegistrationSyncKey(storageKey))
    const timestamp = Number(raw || 0)
    return Number.isFinite(timestamp) && timestamp > 0 && Date.now() - timestamp < REGISTRATION_SYNC_INTERVAL_MS
  } catch {
    return false
  }
}

function saveRegistrationSync(storageKey: string) {
  try {
    window.localStorage.setItem(getRegistrationSyncKey(storageKey), String(Date.now()))
  } catch {
    // If storage is blocked, the backend token registration still happened.
  }
}

function getBrowserNotificationPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'default'
  return window.Notification.permission
}

function capitalizeFirst(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function getNotificationPromptSurface(): NotificationPromptSurface {
  if (mobileAppService.isNative()) return 'native_phone'
  return getPortableDeviceMode() === 'desktop' ? 'desktop_browser' : 'mobile_browser'
}

function getPromptTargetCopy(surface: NotificationPromptSurface) {
  if (surface === 'desktop_browser') {
    return {
      channel: 'notificaciones del navegador',
      device: 'esta computadora',
      deviceShort: 'la computadora',
      permissionOwner: 'el navegador'
    }
  }

  if (surface === 'mobile_browser') {
    return {
      channel: 'notificaciones del navegador',
      device: 'este celular',
      deviceShort: 'el celular',
      permissionOwner: 'el navegador'
    }
  }

  return {
    channel: 'notificaciones',
    device: 'este celular',
    deviceShort: 'el celular',
    permissionOwner: 'el celular'
  }
}

function getStepCopy(step: PromptStep, surface: NotificationPromptSurface, customerLowerLabel: string, denialReason = '') {
  const target = getPromptTargetCopy(surface)

  if (step === 'first_decline') {
    return {
      icon: AlertTriangle,
      eyebrow: 'Notificaciones apagadas',
      title: 'Sin notificaciones te puedes perder mensajes',
      message: `Si rechazas esto, ${target.permissionOwner} no te va a avisar cuando llegue un WhatsApp nuevo. Tendrás que abrir Ristak para revisar si alguien escribió.`,
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
      message: `Esta es la última pregunta. Si dejas las notificaciones apagadas en ${target.device}, no vas a saber al momento cuando un ${customerLowerLabel} te mande mensaje.`,
      primary: 'Activar notificaciones',
      secondary: 'Sí, no quiero notificaciones',
      warning: true
    }
  }

  if (step === 'system_denied') {
    return {
      icon: AlertTriangle,
      eyebrow: `${capitalizeFirst(target.permissionOwner)} no activó notificaciones`,
      title: 'Todavía no van a llegar notificaciones',
      message: `El permiso no quedó activo. Puedes intentar otra vez o seguir sin notificaciones en ${target.device}.`,
      primary: 'Intentar activar',
      secondary: 'Seguir sin notificaciones',
      reason: denialReason,
      warning: true
    }
  }

  return {
    icon: MessageCircle,
    eyebrow: surface === 'desktop_browser' ? 'Notificaciones del navegador' : 'Mensajes de WhatsApp',
    title: 'Activa las notificaciones',
    message: `Para saber al momento cuando un ${customerLowerLabel} te escribe, Ristak necesita activar ${target.channel} en ${target.device}.`,
    primary: 'Activar',
    secondary: 'Ahora no',
    warning: false
  }
}

export function MobileNotificationOnboarding() {
  const location = useLocation()
  const { isAuthenticated, isLoading, user } = useAuth()
  const { labels } = useLabels()
  const { showToast } = useNotification()
  const customerLowerLabel = formatCrmLabelLower(labels.customer, DEFAULT_CRM_LABELS.customer)
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
    const isPhoneRoute = isPhoneAppPath(location.pathname)
    if (isLoading || !isAuthenticated || !isPhoneRoute) {
      setVisible(false)
      return undefined
    }

    const preparePrompt = async () => {
      const storedDecision = getStoredDecision(storageKey)
      if (storedDecision === 'declined') {
        setVisible(false)
        return
      }

      let permissionAlreadyGranted = false
      if (mobileAppService.isNative()) {
        const nativePermission = await mobileAppService.getPushPermissionStatus()
        if (cancelled) return
        permissionAlreadyGranted = nativePermission === 'granted'
      } else if (getBrowserNotificationPermission() === 'granted') {
        permissionAlreadyGranted = true
      }

      if (permissionAlreadyGranted) {
        if (hasFreshRegistrationSync(storageKey)) {
          saveStoredDecision(storageKey, 'accepted')
          setVisible(false)
          return
        }

        try {
          const result = await pushNotificationsService.subscribeToAppNotifications()
          if (cancelled) return
          if (result.status === 'subscribed') {
            saveStoredDecision(storageKey, 'accepted')
            saveRegistrationSync(storageKey)
            setVisible(false)
            return
          }

          setDenialReason(result.reason)
          setStep('system_denied')
          setVisible(true)
          return
        } catch (error: any) {
          if (cancelled) return
          if (storedDecision === 'accepted') {
            setVisible(false)
            return
          }

          setDenialReason(error?.message || 'No se pudo registrar este celular para notificaciones.')
          setStep('system_denied')
          setVisible(true)
          return
        }
      }

      if (storedDecision === 'accepted') {
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
    const target = getPromptTargetCopy(getNotificationPromptSurface())
    saveStoredDecision(storageKey, 'declined')
    setVisible(false)
    setStep('intro')
    setDenialReason('')
    showToast(
      'warning',
      'Notificaciones apagadas',
      `No recibirás notificaciones de mensajes en ${target.device}. Puedes activarlas después desde ajustes.`
    )
  }

  const handleActivate = async () => {
    setBusy(true)
    try {
      const result = await pushNotificationsService.subscribeToAppNotifications()

      if (result.status === 'subscribed') {
        const target = getPromptTargetCopy(getNotificationPromptSurface())
        saveRegistrationSync(storageKey)
        closeAsAccepted()
        showToast('success', 'Notificaciones activadas', `${capitalizeFirst(target.deviceShort)} ya puede avisarte cuando llegue un mensaje.`)
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

  const surface = getNotificationPromptSurface()
  const copy = getStepCopy(step, surface, customerLowerLabel, denialReason)
  const Icon = copy.icon
  const permission = getBrowserNotificationPermission()
  const target = getPromptTargetCopy(surface)
  const reason = copy.reason || (step === 'system_denied' && permission === 'denied'
    ? `${capitalizeFirst(target.permissionOwner)} bloqueó las notificaciones. Si no aparece el permiso otra vez, actívalas desde los ajustes del sistema.`
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
