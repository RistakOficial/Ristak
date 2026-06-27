import React from 'react'
import { CheckCircle2, Copy, ExternalLink, Home, MessageCircle, Share2, Smartphone } from 'lucide-react'
import { Button, Card } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { PHONE_APP_HOME_PATH } from '@/utils/phoneAccess'
import styles from './Settings.module.css'

const MOBILE_CHAT_PATH = PHONE_APP_HOME_PATH
const MOBILE_APP_NAME = 'Ristak'

const safariSteps = [
  {
    title: 'Abre Safari',
    description: 'En el iPhone o iPad, abre Safari y pega el enlace completo del chat.'
  },
  {
    title: 'Inicia sesión',
    description: 'Entra con el usuario de Ristak. Si ya había sesión abierta, pasará directo al chat.'
  },
  {
    title: 'Toca Compartir',
    description: 'Usa el botón de compartir de Safari para abrir las opciones del navegador.'
  },
  {
    title: 'Agrega al inicio',
    description: 'Elige “Agregar a pantalla de inicio”, deja el nombre Ristak y toca Agregar.'
  }
]

export const MobileAppSettings: React.FC = () => {
  const { showToast } = useNotification()
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://tu-dominio.com'
  const mobileChatUrl = `${origin}${MOBILE_CHAT_PATH}`

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast('success', 'Copiado', `${label} copiado`)
    } catch {
      showToast('error', 'No se pudo copiar', 'Copia el texto manualmente e inténtalo en Safari.')
    }
  }

  return (
    <div className={styles.settingsContent}>
      <Card>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeaderLeft}>
            <div className={styles.iconBox}>
              <Smartphone size={22} />
            </div>
            <div>
              <h2 className={styles.panelTitle}>Aplicación móvil</h2>
              <p className={styles.panelDescription}>
                Instala el chat de conversaciones desde Safari para abrirlo como app en el celular.
              </p>
            </div>
          </div>
          <div className={styles.panelHeaderActions}>
            <div className={styles.statusConnected}>
              <CheckCircle2 size={15} />
              Chat móvil listo
            </div>
          </div>
        </div>

        <div className={styles.panelSection}>
          <div className={styles.mobileGuideGrid}>
            <div className={styles.mobileGuideSummary}>
              <div className={styles.mobileGuideHeroIcon}>
                <MessageCircle size={32} />
              </div>
              <div>
                <h3 className={styles.sectionTitle}>Acceso disponible: conversaciones</h3>
                <p className={styles.sectionDescription}>
                  Por ahora comparte solamente el enlace del chat. Ese acceso abre la vista móvil de WhatsApp para buscar conversaciones y responder desde el celular.
                </p>
              </div>
              <div className={styles.mobileGuideNote}>
                <strong>Importante</strong>
                <span>No compartas otras rutas móviles todavía. La ruta correcta para el equipo es la de Chat.</span>
              </div>
            </div>

            <div className={styles.mobileRoutePanel} aria-label="Enlaces para instalar la aplicación móvil">
              <div className={styles.mobileRouteHeader}>
                <Smartphone size={18} />
                <div>
                  <h3>Ruta para Safari</h3>
                  <p>Copia esto y pégalo en Safari desde el celular.</p>
                </div>
              </div>

              <div className={styles.mobileRouteField}>
                <label>Enlace completo</label>
                <div className={styles.mobileRouteValueRow}>
                  <code className={styles.mobileRouteValue}>{mobileChatUrl}</code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => copyText(mobileChatUrl, 'Enlace completo')}
                    aria-label="Copiar enlace completo"
                  >
                    <Copy size={16} />
                    Copiar
                  </Button>
                </div>
              </div>

              <div className={styles.mobileRouteField}>
                <label>Ruta interna</label>
                <div className={styles.mobileRouteValueRow}>
                  <code className={styles.mobileRouteValue}>{MOBILE_CHAT_PATH}</code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => copyText(MOBILE_CHAT_PATH, 'Ruta interna')}
                    aria-label="Copiar ruta interna"
                  >
                    <Copy size={16} />
                    Copiar
                  </Button>
                </div>
              </div>

              <div className={styles.mobileRouteField}>
                <label>Nombre recomendado</label>
                <div className={styles.mobileRouteValueRow}>
                  <code className={styles.mobileRouteValue}>{MOBILE_APP_NAME}</code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => copyText(MOBILE_APP_NAME, 'Nombre recomendado')}
                    aria-label="Copiar nombre recomendado"
                  >
                    <Copy size={16} />
                    Copiar
                  </Button>
                </div>
              </div>

              <a className={styles.mobilePreviewLink} href={MOBILE_CHAT_PATH} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} />
                Abrir enlace del chat
              </a>
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <div className={styles.mobileStepsHeader}>
          <div>
            <h3 className={styles.sectionTitle}>Cómo instalarla desde Safari</h3>
            <p className={styles.sectionDescription}>
              Estos son los pasos que puede seguir cualquier persona del equipo en su iPhone o iPad.
            </p>
          </div>
          <div className={styles.mobileStepsIcons} aria-hidden="true">
            <Share2 size={18} />
            <Home size={18} />
          </div>
        </div>

        <ol className={styles.mobileStepList}>
          {safariSteps.map((step, index) => (
            <li className={styles.mobileStepItem} key={step.title}>
              <span className={styles.mobileStepNumber}>{index + 1}</span>
              <div>
                <h4>{step.title}</h4>
                <p>{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  )
}
