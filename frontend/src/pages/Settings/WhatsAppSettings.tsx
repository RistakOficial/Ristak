import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import { Button, Card } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { WhatsAppWebStatus, whatsappWebService } from '@/services/whatsappWebService'
import styles from './WhatsAppSettings.module.css'

type BusinessProfile = {
  businessName?: string
  name?: string
  description?: string
  email?: string
  website?: string | string[]
  category?: string
}

function parseJson<T>(value?: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export const WhatsAppSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [status, setStatus] = useState<WhatsAppWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [manualDisconnected, setManualDisconnected] = useState(false)
  const requestInFlight = useRef(false)

  const session = status?.session
  const isConnected = session?.status === 'connected'
  const businessProfile = useMemo(
    () => parseJson<BusinessProfile>(session?.business_profile_json),
    [session?.business_profile_json]
  )
  const displayName = session?.push_name ||
    businessProfile?.businessName ||
    businessProfile?.name ||
    'WhatsApp Business'
  const profileImage = session?.profile_picture_url
  const showQr = !isConnected && Boolean(session?.qr_image) && !manualDisconnected
  const generatingQr = !isConnected && !showQr && !manualDisconnected

  const loadStatus = async () => {
    const nextStatus = await whatsappWebService.getStatus()
    setStatus(nextStatus)
    return nextStatus
  }

  const startConnection = async () => {
    if (requestInFlight.current || manualDisconnected) return
    requestInFlight.current = true

    try {
      const nextStatus = await whatsappWebService.connect()
      setStatus(nextStatus)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo generar el QR')
    } finally {
      requestInFlight.current = false
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        const nextStatus = await loadStatus()
        if (cancelled) return

        const currentStatus = nextStatus.session?.status
        if (!['connected', 'qr', 'connecting', 'reconnecting'].includes(currentStatus || '')) {
          await startConnection()
        }
      } catch (error) {
        if (!cancelled) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo leer WhatsApp Business')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    bootstrap()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (isConnected || manualDisconnected) return

    const interval = window.setInterval(async () => {
      try {
        const nextStatus = await loadStatus()
        if (nextStatus.session?.status === 'disconnected') {
          await startConnection()
        }
      } catch {
        // El siguiente ciclo reintenta.
      }
    }, 2500)

    return () => window.clearInterval(interval)
  }, [isConnected, manualDisconnected])

  const confirmDisconnect = () => {
    showConfirm(
      'Desconectar WhatsApp Business',
      'Se cerrara la conexion actual. Para volver a conectar, abre esta pagina otra vez y se generara un QR nuevo.',
      async () => {
        setDisconnecting(true)
        setManualDisconnected(true)
        try {
          const nextStatus = await whatsappWebService.disconnect()
          setStatus(nextStatus)
          showToast('success', 'Desconectado', 'WhatsApp Business se desconecto correctamente')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo desconectar')
        } finally {
          setDisconnecting(false)
        }
      },
      'Desconectar',
      'Cancelar'
    )
  }

  const accountDetails = [
    { label: 'Numero', value: session?.phone },
    { label: 'Nombre', value: displayName },
    { label: 'Categoria', value: businessProfile?.category },
    { label: 'Email', value: businessProfile?.email }
  ].filter(item => item.value)

  if (loading) {
    return (
      <Card className={styles.shell}>
        <div className={styles.generatingState}>
          <RefreshCw size={26} className={styles.spin} />
          <span>Generando QR</span>
        </div>
      </Card>
    )
  }

  return (
    <Card className={styles.shell}>
      <div className={styles.header}>
        <span className={styles.logoMark}><SiWhatsapp size={30} /></span>
        <div>
          <p className={styles.eyebrow}>Configuracion</p>
          <h2 className={styles.title}>WhatsApp Business</h2>
        </div>
      </div>

      <div className={styles.stage}>
        {isConnected ? (
          <div className={styles.connectedState}>
            <div className={styles.avatar}>
              {profileImage ? (
                <img src={profileImage} alt="" />
              ) : (
                <SiWhatsapp size={58} />
              )}
              <span className={styles.checkBadge}><CheckCircle size={22} /></span>
            </div>

            <div className={styles.connectedCopy}>
              <span className={styles.connectedLabel}>
                <ShieldCheck size={18} />
                Conectado
              </span>
              <h3>{session?.phone || 'Numero conectado'}</h3>
              <p>{displayName}</p>
            </div>

            {accountDetails.length > 0 && (
              <div className={styles.detailsGrid}>
                {accountDetails.map(item => (
                  <div key={item.label} className={styles.detailItem}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
            )}

            <Button variant="danger" onClick={confirmDisconnect} loading={disconnecting}>
              <Unplug size={17} />
              Desconectar
            </Button>
          </div>
        ) : showQr ? (
          <div className={styles.qrState}>
            <img src={session?.qr_image || ''} alt="Codigo QR para conectar WhatsApp Business" />
            <p>Escanea el codigo desde WhatsApp para conectar la cuenta.</p>
          </div>
        ) : manualDisconnected ? (
          <div className={styles.disconnectedState}>
            <SiWhatsapp size={52} />
            <h3>Desconectado</h3>
          </div>
        ) : (
          <div className={styles.generatingState}>
            <RefreshCw size={34} className={styles.spin} />
            <span>{generatingQr ? 'Generando QR' : 'Preparando conexion'}</span>
          </div>
        )}
      </div>
    </Card>
  )
}
