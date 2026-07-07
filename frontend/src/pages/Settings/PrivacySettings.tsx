import React from 'react'
import { CheckCheck, EyeOff, ShieldCheck } from 'lucide-react'
import { Card, PageHeader, Switch } from '@/components/common'
import { useAppConfig } from '@/hooks/useAppConfig'
import styles from './Settings.module.css'

const CHAT_SEND_READ_RECEIPTS_CONFIG_KEY = 'chat_send_read_receipts_enabled'

const privacyChannels = ['WhatsApp API', 'WhatsApp QR', 'Messenger', 'Instagram']

export const PrivacySettings: React.FC = () => {
  const [sendReadReceipts, setSendReadReceipts, syncingReadReceipts] = useAppConfig<boolean>(
    CHAT_SEND_READ_RECEIPTS_CONFIG_KEY,
    true
  )

  const handleReadReceiptsChange = (enabled: boolean) => {
    void setSendReadReceipts(enabled)
  }

  return (
    <div className={styles.settingsContent}>
      <PageHeader
        eyebrow="Configuración"
        title="Privacidad"
        subtitle="Controla qué señales de lectura manda Ristak cuando abres o marcas leído un chat."
      />

      <Card className={styles.settingsSection}>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeaderLeft}>
            <div className={styles.iconBox}>
              <ShieldCheck size={20} />
            </div>
            <div>
              <h2>Vistos de chat</h2>
              <p>Este ajuste vive en la configuración de la app y se mantiene aunque cierres sesión.</p>
            </div>
          </div>
        </div>

        <div className={styles.privacyToggleCard}>
          <div className={styles.privacyToggleIcon} aria-hidden="true">
            <CheckCheck size={22} />
          </div>
          <div className={styles.privacyToggleText}>
            <strong>Marcar mensajes de chat como leídos o vistos</strong>
            <span>
              Cuando está activo, Ristak intenta enviar el visto real al proveedor al abrir o marcar leído un chat.
            </span>
          </div>
          <Switch
            checked={sendReadReceipts}
            onChange={handleReadReceiptsChange}
            disabled={syncingReadReceipts}
            aria-label="Marcar mensajes de chat como leídos o vistos"
          />
        </div>

        <div className={styles.privacyChannelList} aria-label="Canales afectados">
          {privacyChannels.map((channel) => (
            <span className={styles.privacyChannelPill} key={channel}>{channel}</span>
          ))}
        </div>

        <div className={styles.privacyNote}>
          <EyeOff size={18} aria-hidden="true" />
          <p>
            Si lo apagas, Ristak limpia el contador interno de no leídos, pero no manda doble check,
            mark seen ni acuse externo al cliente. Correo queda fuera porque no funciona como chat.
          </p>
        </div>
      </Card>
    </div>
  )
}
