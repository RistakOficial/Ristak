import React, { useState, useEffect } from 'react'
import { Facebook, CheckCircle, AlertCircle } from 'lucide-react'
import { Button, Modal } from '@/components/common'
import { campaignsService } from '@/services/campaignsService'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './MetaConnect.module.css'

interface AdAccount {
  id: string
  accountId: string
  name: string
  status: number
  currency: string
  timezone: string
  businessId?: string | null
  businessName?: string | null
}

interface MetaConnectProps {
  onConnected?: () => void
  showLogo?: boolean
}

export const MetaConnect: React.FC<MetaConnectProps> = ({ onConnected, showLogo = true }) => {
  const { showToast } = useNotification()
  const [isConnecting, setIsConnecting] = useState(false)
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [accounts, setAccounts] = useState<AdAccount[]>([])
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null)
  const [oauthToken, setOauthToken] = useState<string | null>(null)
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [savingAccount, setSavingAccount] = useState(false)

  // Escuchar mensajes del popup de OAuth
  useEffect(() => {
    const handleOAuthCallback = async (event: MessageEvent) => {
      // Solo aceptar mensajes del popup de Meta
      if (event.origin !== window.location.origin) return

      const { type, token, error } = event.data

      if (type === 'meta-oauth-success' && token) {
        setOauthToken(token)
        await loadAdAccounts(token)
      } else if (type === 'meta-oauth-error') {
        showToast('error', 'Error de OAuth', error || 'No se pudo conectar con Meta')
        setIsConnecting(false)
      }
    }

    window.addEventListener('message', handleOAuthCallback)
    return () => window.removeEventListener('message', handleOAuthCallback)
  }, [showToast])

  const handleConnect = async () => {
    try {
      setIsConnecting(true)

      // Obtener URL de OAuth desde el backend
      const result = await campaignsService.getOAuthUrl()

      if (!result.success || !result.authUrl) {
        showToast('error', 'Error', result.error || 'No se pudo generar URL de OAuth')
        setIsConnecting(false)
        return
      }

      // Abrir popup de Meta OAuth
      const width = 600
      const height = 700
      const left = window.screenX + (window.outerWidth - width) / 2
      const top = window.screenY + (window.outerHeight - height) / 2

      const popup = window.open(
        result.authUrl,
        'Meta OAuth',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
      )

      if (!popup) {
        showToast('error', 'Popup bloqueado', 'Por favor permite popups para conectar con Meta')
        setIsConnecting(false)
        return
      }

      // Monitorear si el usuario cierra el popup
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed)
          setIsConnecting(false)
        }
      }, 500)

    } catch (error) {
      showToast('error', 'Error', 'No se pudo conectar con Meta')
      setIsConnecting(false)
    }
  }

  const loadAdAccounts = async (token: string) => {
    try {
      setLoadingAccounts(true)
      setShowAccountModal(true)

      const result = await campaignsService.getAdAccounts(token)

      if (!result.success || !result.accounts) {
        showToast('error', 'Error', result.error || 'No se pudieron cargar las cuentas')
        setShowAccountModal(false)
        setIsConnecting(false)
        return
      }

      setAccounts(result.accounts)
      setLoadingAccounts(false)

      if (result.accounts.length === 0) {
        showToast('warning', 'Sin cuentas', 'No se encontraron cuentas de anuncios en tu cuenta de Meta')
        setShowAccountModal(false)
        setIsConnecting(false)
      }

    } catch (error) {
      showToast('error', 'Error', 'No se pudieron cargar las cuentas')
      setShowAccountModal(false)
      setIsConnecting(false)
    }
  }

  const handleSaveAccount = async () => {
    if (!selectedAccount || !oauthToken) return

    const account = accounts.find(a => a.accountId === selectedAccount)
    if (!account) return

    try {
      setSavingAccount(true)

      const result = await campaignsService.saveAdAccount(
        oauthToken,
        account.accountId,
        account.name,
        account.currency,
        account.timezone
      )

      if (!result.success) {
        showToast('error', 'Error', result.error || 'No se pudo guardar la cuenta')
        setSavingAccount(false)
        return
      }

      showToast('success', 'Conectado', `Cuenta "${account.name}" configurada correctamente`)

      setShowAccountModal(false)
      setIsConnecting(false)
      setSavingAccount(false)

      // Notificar al padre que ya está conectado
      if (onConnected) {
        onConnected()
      }

    } catch (error) {
      showToast('error', 'Error', 'No se pudo guardar la configuración')
      setSavingAccount(false)
    }
  }

  return (
    <div className={styles.container}>
      {showLogo && (
        <div className={styles.logoContainer}>
          <div className={styles.logo}>
            <Facebook size={64} color="#0866FF" />
          </div>
          <h2 className={styles.title}>Meta Ads</h2>
          <p className={styles.description}>
            Conecta tu cuenta de anuncios de Facebook para ver tus campañas, métricas y rendimiento.
          </p>
        </div>
      )}

      <Button
        onClick={handleConnect}
        disabled={isConnecting}
        className={styles.connectButton}
      >
        {isConnecting ? (
          <>
            <div className={styles.spinner} />
            Conectando...
          </>
        ) : (
          <>
            <Facebook size={20} />
            Conectar con Meta
          </>
        )}
      </Button>

      {/* Modal de selección de cuenta */}
      <Modal
        isOpen={showAccountModal}
        onClose={() => {
          setShowAccountModal(false)
          setIsConnecting(false)
        }}
        title="Selecciona una cuenta de anuncios"
        size="md"
      >
        {loadingAccounts ? (
          <div className={styles.loading}>
            <div className={styles.spinner} />
            <p>Cargando cuentas de anuncios...</p>
          </div>
        ) : (
          <div className={styles.accountsList}>
            <p className={styles.accountsDescription}>
              Selecciona la cuenta de anuncios que quieres conectar con Ristak:
            </p>

            {accounts.map((account) => (
              <div
                key={account.accountId}
                className={`${styles.accountItem} ${selectedAccount === account.accountId ? styles.selected : ''}`}
                onClick={() => setSelectedAccount(account.accountId)}
              >
                <div className={styles.accountInfo}>
                  <div className={styles.accountName}>{account.name}</div>
                  <div className={styles.accountMeta}>
                    <span>ID: {account.accountId}</span>
                    {account.businessName && <span>• {account.businessName}</span>}
                    <span>• {account.currency}</span>
                    <span className={account.status === 1 ? styles.active : styles.inactive}>
                      {account.status === 1 ? '• Activa' : '• Inactiva'}
                    </span>
                  </div>
                </div>
                {selectedAccount === account.accountId && (
                  <CheckCircle size={20} color="var(--color-primary)" />
                )}
              </div>
            ))}

            <div className={styles.modalActions}>
              <Button
                variant="secondary"
                onClick={() => {
                  setShowAccountModal(false)
                  setIsConnecting(false)
                }}
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSaveAccount}
                disabled={!selectedAccount || savingAccount}
              >
                {savingAccount ? 'Guardando...' : 'Conectar'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
