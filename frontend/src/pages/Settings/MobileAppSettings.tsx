import React from 'react'
import { CheckCircle2, Copy, ExternalLink, MessageCircle, Smartphone } from 'lucide-react'
import { Button, Card } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { PHONE_APP_HOME_PATH } from '@/utils/phoneAccess'
import styles from './Settings.module.css'

const MOBILE_CHAT_PATH = PHONE_APP_HOME_PATH
const MOBILE_APP_NAME = 'Ristak'
const IOS_APP_STORE_URL = 'https://apps.apple.com/us/app/ristak/id6782473900'
const ANDROID_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.ristak.android'

const mobileInstallSteps = [
  {
    title: 'Abre la tienda de tu dispositivo',
    description: 'En iPhone o iPad usa App Store; en Android usa Google Play.'
  },
  {
    title: 'Instala Ristak',
    description: 'Toca Obtener, Instalar o Actualizar para descargar la app oficial.'
  },
  {
    title: 'Inicia sesión',
    description: 'Entra con el usuario de Ristak asignado al equipo.'
  },
  {
    title: 'Activa notificaciones',
    description: 'Permite notificaciones para recibir mensajes del chat en tiempo real.'
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
      showToast('error', 'No se pudo copiar', 'Copia el texto manualmente e inténtalo de nuevo.')
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
                Instala la app oficial de Ristak en iPhone, iPad o Android; también puedes compartir el acceso web del chat móvil.
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
                <h3 className={styles.sectionTitle}>Descarga la app oficial</h3>
                <p className={styles.sectionDescription}>
                  En iPhone y iPad manda al equipo a App Store; en Android, a Google Play. El enlace web del chat queda como respaldo para abrir conversaciones desde navegador.
                </p>
              </div>
              <div className={styles.mobileGuideNote}>
                <strong>Importante</strong>
                <span>Usa la tienda oficial de cada dispositivo. El enlace interno de Chat se conserva como acceso web/PWA de respaldo.</span>
              </div>
            </div>

            <div className={styles.mobileRoutePanel} aria-label="Enlaces para instalar la aplicación móvil">
              <div className={styles.mobileRouteHeader}>
                <Smartphone size={18} />
                <div>
                  <h3>Enlaces de instalación</h3>
                  <p>Usa App Store en iOS o Google Play en Android; conserva el chat web como respaldo.</p>
                </div>
              </div>

              <div className={styles.mobileRouteField}>
                <label>Google Play Android</label>
                <div className={styles.mobileRouteValueRow}>
                  <code className={styles.mobileRouteValue}>{ANDROID_PLAY_STORE_URL}</code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => copyText(ANDROID_PLAY_STORE_URL, 'Enlace de Google Play')}
                    aria-label="Copiar enlace de Google Play"
                  >
                    <Copy size={16} />
                    Copiar
                  </Button>
                </div>
              </div>

              <div className={styles.mobileRouteField}>
                <label>App Store iOS</label>
                <div className={styles.mobileRouteValueRow}>
                  <code className={styles.mobileRouteValue}>{IOS_APP_STORE_URL}</code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => copyText(IOS_APP_STORE_URL, 'Enlace de App Store')}
                    aria-label="Copiar enlace de App Store"
                  >
                    <Copy size={16} />
                    Copiar
                  </Button>
                </div>
              </div>

              <div className={styles.mobileRouteField}>
                <label>Enlace web de respaldo</label>
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

              <a className={styles.mobilePreviewLink} href={IOS_APP_STORE_URL} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} />
                Abrir en App Store
              </a>
              <a className={styles.mobilePreviewLink} href={ANDROID_PLAY_STORE_URL} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} />
                Abrir en Google Play
              </a>
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <div className={styles.mobileStepsHeader}>
          <div>
            <h3 className={styles.sectionTitle}>Cómo instalarla en tu dispositivo</h3>
            <p className={styles.sectionDescription}>
              Estos son los pasos que puede seguir cualquier persona del equipo desde App Store o Google Play.
            </p>
          </div>
          <div className={styles.mobileStepsIcons} aria-hidden="true">
            <ExternalLink size={18} />
            <CheckCircle2 size={18} />
          </div>
        </div>

        <ol className={styles.mobileStepList}>
          {mobileInstallSteps.map((step, index) => (
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
