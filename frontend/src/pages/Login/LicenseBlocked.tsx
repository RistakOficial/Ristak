import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/common'
import styles from './Login.module.css'

type LicenseBlockedState = {
  message?: string
} | null

/**
 * Pantalla de bloqueo cuando la licencia central está suspendida, vencida o inválida.
 */
export const LicenseBlocked: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const message = (location.state as LicenseBlockedState)?.message
    || 'Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar.'

  const goToLogin = () => {
    try {
      localStorage.removeItem('auth_token')
    } catch {
      // sin acceso a storage, continuar igual
    }
    navigate('/login', { replace: true })
  }

  return (
    <div className={styles.container}>
      <div className={styles.loginBox}>
        <div className={styles.header}>
          <div className={styles.logoContainer}>
            <div className={styles.logo}>
              <ShieldAlert size={32} strokeWidth={1.5} />
            </div>
          </div>
          <h1 className={styles.title}>Licencia no activa</h1>
          <p className={styles.subtitle}>{message}</p>
        </div>

        <Button
          type="button"
          variant="primary"
          fullWidth
          onClick={goToLogin}
          className={styles.submitButton}
        >
          Volver al inicio de sesión
        </Button>

        <div style={{
          marginTop: '1.5rem',
          padding: '1rem',
          background: 'rgba(100, 116, 139, 0.08)',
          borderRadius: '0.75rem',
          fontSize: '0.8125rem',
          color: 'var(--color-text-secondary)',
          textAlign: 'center',
          lineHeight: '1.6'
        }}>
          Si crees que esto es un error, escribe al equipo que te dio acceso a Ristak.
          En cuanto tu suscripción se reactive podrás entrar de nuevo con tu misma cuenta.
        </div>
      </div>
    </div>
  )
}
