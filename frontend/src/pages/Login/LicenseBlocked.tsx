import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button, Logo } from '@/components/common'
import { syncAuthScopedCachePrincipal } from '@/services/authPrincipalCache'
import {
  clearRememberedLicenseBlock,
  readRememberedLicenseBlock,
  type LicenseBlockState
} from '@/services/licenseBlockState'
import styles from './Login.module.css'

/**
 * Pantalla de bloqueo cuando la licencia central está suspendida, vencida o inválida.
 */
export const LicenseBlocked: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const routeState = (location.state as LicenseBlockState | null) || null
  const rememberedState = readRememberedLicenseBlock()
  const state = routeState || rememberedState
  const trialExpired = state?.reason === 'trial_expired'
  const title = trialExpired ? 'Tu periodo gratis terminó' : 'Licencia no activa'
  const message = state?.message
    || 'Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar.'
  const paymentUrl = state?.paymentUrl || rememberedState?.paymentUrl

  const clearSession = () => {
    try {
      localStorage.removeItem('auth_token')
      syncAuthScopedCachePrincipal(null)
    } catch {
      // sin acceso a storage, continuar igual
    }
  }

  const goToPayment = () => {
    if (!paymentUrl) return
    clearSession()
    window.location.assign(paymentUrl)
  }

  const goToLogin = () => {
    clearSession()
    clearRememberedLicenseBlock()
    navigate('/login', { replace: true })
  }

  return (
    <div className={styles.container}>
      <div className={styles.authBrand}>
        <Logo size="md" className={styles.authLogo} />
      </div>
      <div className={styles.loginBox}>
        <div className={styles.header}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>{message}</p>
        </div>

        <div className={styles.form}>
          {paymentUrl && (
            <Button
              type="button"
              variant="primary"
              fullWidth
              onClick={goToPayment}
              className={styles.submitButton}
            >
              Continuar con el pago
            </Button>
          )}
          <Button
            type="button"
            variant={paymentUrl ? 'secondary' : 'primary'}
            fullWidth
            onClick={goToLogin}
            className={styles.submitButton}
          >
            Volver al inicio de sesión
          </Button>
        </div>

        <div className={styles.setupHint}>
          Si crees que esto es un error, escribe al equipo que te dio acceso a Ristak.
          En cuanto tu suscripción se reactive podrás entrar de nuevo con tu misma cuenta.
        </div>
      </div>
    </div>
  )
}
