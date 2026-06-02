import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Database, MessageCircle, QrCode, RefreshCw, Unplug, Users, Wifi } from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import { Button, Card } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  WhatsAppWebMessage,
  WhatsAppWebStatus,
  whatsappWebService
} from '@/services/whatsappWebService'
import styles from './WhatsAppSettings.module.css'

export const WhatsAppSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [status, setStatus] = useState<WhatsAppWebStatus | null>(null)
  const [messages, setMessages] = useState<WhatsAppWebMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const session = status?.session
  const stats = status?.stats
  const isConnected = session?.status === 'connected'
  const isWaitingQr = session?.status === 'qr'
  const isBusy = session?.status === 'connecting' || session?.status === 'reconnecting'

  const statusMeta = useMemo(() => {
    if (isConnected) {
      return {
        label: 'Conectado',
        detail: session?.phone || 'WhatsApp enlazado',
        className: styles.statusConnected
      }
    }

    if (isWaitingQr) {
      return {
        label: 'Escanea el QR',
        detail: 'WhatsApp Web esta esperando el celular',
        className: styles.statusQr
      }
    }

    if (isBusy) {
      return {
        label: session?.status === 'reconnecting' ? 'Reconectando' : 'Generando QR',
        detail: 'Preparando sesion Baileys',
        className: styles.statusBusy
      }
    }

    return {
      label: 'Desconectado',
      detail: 'Genera un QR para enlazar el numero',
      className: styles.statusDisconnected
    }
  }, [isBusy, isConnected, isWaitingQr, session?.phone, session?.status])

  const loadStatus = async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setRefreshing(true)
    try {
      const [nextStatus, nextMessages] = await Promise.all([
        whatsappWebService.getStatus(),
        whatsappWebService.getMessages(10)
      ])
      setStatus(nextStatus)
      setMessages(nextMessages)
    } catch (error) {
      if (!options.silent) {
        showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo leer WhatsApp Web')
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadStatus({ silent: true })
  }, [])

  useEffect(() => {
    if (!session || isConnected) return
    if (!['connecting', 'qr', 'reconnecting'].includes(session.status)) return

    const interval = window.setInterval(() => {
      loadStatus({ silent: true })
    }, 2500)

    return () => window.clearInterval(interval)
  }, [isConnected, session?.status])

  const handleConnect = async () => {
    setConnecting(true)
    try {
      const nextStatus = await whatsappWebService.connect()
      setStatus(nextStatus)
      showToast('info', 'QR en proceso', 'Escanea el codigo con WhatsApp cuando aparezca')
      await loadStatus({ silent: true })
    } catch (error) {
      showToast('error', 'No se pudo iniciar', error instanceof Error ? error.message : 'Error iniciando WhatsApp Web')
    } finally {
      setConnecting(false)
    }
  }

  const confirmDisconnect = () => {
    showConfirm(
      'Desconectar WhatsApp',
      'Se cerrara la sesion de WhatsApp Web y el usuario tendra que escanear otro QR para conectar de nuevo.',
      async () => {
        setDisconnecting(true)
        try {
          const nextStatus = await whatsappWebService.disconnect()
          setStatus(nextStatus)
          setMessages([])
          showToast('success', 'Desconectado', 'La sesion de WhatsApp Web se cerro correctamente')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo desconectar WhatsApp')
        } finally {
          setDisconnecting(false)
        }
      },
      'Desconectar',
      'Cancelar'
    )
  }

  if (loading) {
    return (
      <Card className={styles.loadingCard}>
        <RefreshCw size={18} className={styles.spin} />
        Cargando WhatsApp Web
      </Card>
    )
  }

  return (
    <div className={styles.container}>
      <Card className={styles.heroCard}>
        <div className={styles.heroHeader}>
          <div className={styles.heroTitleGroup}>
            <span className={styles.logoMark}><SiWhatsapp size={28} /></span>
            <div>
              <p className={styles.eyebrow}>WhatsApp Web</p>
              <h2 className={styles.title}>Conector Baileys</h2>
              <p className={styles.subtitle}>
                Recibe mensajes entrantes, crea contactos locales y guarda el JSON crudo para rastrear atribucion.
              </p>
            </div>
          </div>
          <span className={statusMeta.className}>
            <Wifi size={15} />
            <span>{statusMeta.label}</span>
          </span>
        </div>

        <div className={styles.connectionGrid}>
          <section className={styles.qrPanel}>
            <div className={styles.panelHeader}>
              <div>
                <h3>Conexion del numero</h3>
                <p>{statusMeta.detail}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => loadStatus()} loading={refreshing}>
                <RefreshCw size={15} />
                Actualizar
              </Button>
            </div>

            <div className={styles.qrStage}>
              {isConnected ? (
                <div className={styles.connectedState}>
                  <SiWhatsapp size={56} />
                  <strong>{session?.phone || 'Numero conectado'}</strong>
                  <span>{session?.push_name || session?.jid || 'Sesion activa'}</span>
                </div>
              ) : session?.qr_image ? (
                <div className={styles.qrBox}>
                  <img src={session.qr_image} alt="Codigo QR para conectar WhatsApp Web" />
                  <p>Abre WhatsApp en el celular, entra a Dispositivos vinculados y escanea este codigo.</p>
                </div>
              ) : (
                <div className={styles.emptyQr}>
                  <QrCode size={58} />
                  <strong>Sin QR activo</strong>
                  <span>Genera un codigo para conectar el telefono.</span>
                </div>
              )}
            </div>

            <div className={styles.actions}>
              {!isConnected && (
                <Button onClick={handleConnect} loading={connecting || isBusy} fullWidth>
                  <QrCode size={17} />
                  Generar QR
                </Button>
              )}
              {isConnected && (
                <Button variant="danger" onClick={confirmDisconnect} loading={disconnecting} fullWidth>
                  <Unplug size={17} />
                  Desconectar
                </Button>
              )}
            </div>

            {session?.last_error && (
              <div className={styles.errorBox}>
                <AlertTriangle size={16} />
                <span>{session.last_error}</span>
              </div>
            )}
          </section>

          <aside className={styles.sidePanel}>
            <div className={styles.statCard}>
              <Users size={18} />
              <div>
                <strong>{stats?.contacts || 0}</strong>
                <span>Contactos Web</span>
              </div>
            </div>
            <div className={styles.statCard}>
              <MessageCircle size={18} />
              <div>
                <strong>{stats?.messages || 0}</strong>
                <span>Mensajes</span>
              </div>
            </div>
            <div className={styles.statCard}>
              <Database size={18} />
              <div>
                <strong>{stats?.attribution || 0}</strong>
                <span>Atribucion detectada</span>
              </div>
            </div>
          </aside>
        </div>
      </Card>

      <Card className={styles.messagesCard}>
        <div className={styles.sectionHeader}>
          <div>
            <h3>Ultimos mensajes recibidos</h3>
            <p>Se guardan en tablas `whatsapp_web_*`, separadas de WhatsApp API oficial.</p>
          </div>
        </div>

        {messages.length === 0 ? (
          <div className={styles.emptyMessages}>
            <MessageCircle size={26} />
            <span>Aun no hay mensajes recibidos por Baileys.</span>
          </div>
        ) : (
          <div className={styles.messageList}>
            {messages.map(message => (
              <article key={message.id} className={styles.messageItem}>
                <div className={styles.messageTop}>
                  <strong>{message.push_name || message.phone || 'Contacto WhatsApp'}</strong>
                  <span>{message.created_at ? new Date(message.created_at).toLocaleString() : ''}</span>
                </div>
                <p>{message.message_text || message.message_type || 'Mensaje sin texto'}</p>
                {(message.detected_ctwa_clid || message.detected_source_id) && (
                  <div className={styles.attrLine}>
                    {message.detected_source_id && <span>Ad: {message.detected_source_id}</span>}
                    {message.detected_ctwa_clid && <span>CTWA: {message.detected_ctwa_clid}</span>}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
