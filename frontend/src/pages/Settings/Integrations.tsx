import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Card } from '@/components/common'
import {
  Zap,
  CheckCircle,
  XCircle
} from 'lucide-react'
import styles from './Integrations.module.css'

interface IntegrationCard {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  status: 'connected' | 'not_connected'
  path: string
}

const integrations: IntegrationCard[] = [
  {
    id: 'highlevel',
    name: 'GoHighLevel',
    description: 'Sincroniza contactos, transacciones y oportunidades con tu cuenta de HighLevel',
    icon: <Zap size={24} />,
    status: 'not_connected',
    path: '/settings/integrations/highlevel'
  }
]

export const Integrations: React.FC = () => {
  const navigate = useNavigate()
  const [integrationsState, setIntegrationsState] = React.useState(integrations)

  React.useEffect(() => {
    checkIntegrationStatus()
  }, [])

  const checkIntegrationStatus = async () => {
    try {
      const response = await fetch('/api/integrations/status')
      if (response.ok) {
        const data = await response.json()
        setIntegrationsState(prev => prev.map(integration => {
          if (integration.id === 'highlevel') {
            return {
              ...integration,
              status: data.highlevel?.connected ? 'connected' : 'not_connected'
            }
          }
          return integration
        }))
      }
    } catch (error) {
      // Silent error
    }
  }

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        <div className={styles.pageHeader}>
          <h2 className={styles.pageTitle}>Integraciones</h2>
          <p className={styles.pageSubtitle}>
            Conecta tus plataformas favoritas para centralizar todos tus datos
          </p>
        </div>

      <div className={styles.integrationsGrid}>
        {integrationsState.map(integration => (
          <div
            key={integration.id}
            className={styles.integrationCard}
            onClick={() => navigate(integration.path)}
          >
            <div className={styles.cardContent}>
              <div className={`${styles.iconWrapper} ${styles[`icon${integration.id.charAt(0).toUpperCase() + integration.id.slice(1)}`]}`}>
                {integration.icon}
              </div>

              <div className={styles.cardInfo}>
                <h3 className={styles.cardTitle}>{integration.name}</h3>
                <p className={styles.cardDescription}>{integration.description}</p>
                <div className={`${styles.cardStatus} ${integration.status === 'connected' ? styles.statusConnected : styles.statusDisconnected}`}>
                  {integration.status === 'connected' ? (
                    <>
                      <CheckCircle size={12} />
                      Conectado
                    </>
                  ) : (
                    <>
                      <XCircle size={12} />
                      No configurado
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

        <div className={styles.comingSoon}>
          <h3>¿Necesitas más integraciones?</h3>
          <p>Contáctanos para solicitar nuevas plataformas</p>
        </div>
      </Card>
    </div>
  )
}
