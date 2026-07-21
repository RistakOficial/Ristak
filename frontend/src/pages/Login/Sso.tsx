import React, { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Logo } from '@/components/common'
import { apiUrl } from '@/services/apiBaseUrl'
import { syncAuthScopedCachePrincipal } from '@/services/authPrincipalCache'
import { getLoginPathForRoute, isPhoneAppPath, sanitizeAuthRedirectPath } from '@/utils/phoneAccess'
import styles from './Login.module.css'

/**
 * Entrada directa desde el portal central: /sso?token=...
 * Canjea el token de un solo uso por una sesión local y entra al dashboard
 * sin pedir contraseña. Si la app aún no tiene usuarios, el backend crea al
 * usuario desde la identidad verificada por el portal central, tanto en una
 * instalación gestionada como en una instalación standalone con broker.
 */
export const Sso: React.FC = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const googleHandoffToken = searchParams.get('google_handoff_token') || ''
  const googleError = searchParams.get('google_error_message') || ''
  const redirectPath = sanitizeAuthRedirectPath(searchParams.get('return_path'), '/dashboard')
  const isPhoneReturn = isPhoneAppPath(redirectPath)
  const [error, setError] = useState('')
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const run = async () => {
      if (!token && !googleHandoffToken) {
        setError(googleError || 'Este enlace no es válido.')
        return
      }

      try {
        const response = await fetch(apiUrl('/api/auth/sso'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(googleHandoffToken
            ? { google_handoff_token: googleHandoffToken }
            : { token })
        })
        const data = await response.json()

        if (response.ok && data.success && data.token) {
          localStorage.setItem('auth_token', data.token)
          syncAuthScopedCachePrincipal(data.token)
          if (data.apiToken) {
            sessionStorage.setItem('ristak_latest_api_token', data.apiToken)
          }
          // Recarga completa para que la app levante la sesión nueva
          window.location.href = redirectPath
          return
        }

        if (data.code === 'needs_setup') {
          // Compatibilidad con versiones anteriores del backend.
          const setupParams = new URLSearchParams({
            token,
            return_path: redirectPath
          })
          navigate(`/setup?${setupParams.toString()}`, { replace: true })
          return
        }

        if (data.code === 'license_blocked') {
          navigate('/license-blocked', { replace: true, state: { message: data.message } })
          return
        }

        setError(data.message || 'El enlace de acceso no es válido o ya fue usado.')
      } catch {
        setError('No se pudo conectar. Intenta de nuevo o inicia sesión con tu contraseña.')
      }
    }

    run()
  }, [token, googleHandoffToken, googleError, navigate, redirectPath])

  return (
    <div className={`${styles.container} ${isPhoneReturn ? styles.phoneContainer : ''}`}>
      {!isPhoneReturn && (
        <div className={styles.authBrand}>
          <Logo size="md" className={styles.authLogo} />
        </div>
      )}
      <div className={`${styles.loginBox} ${isPhoneReturn ? styles.phoneLoginBox : ''}`}>
        <div className={styles.header}>
          {isPhoneReturn && (
            <div className={styles.logoContainer}>
              <Logo
                size="xl"
                variant="black"
                className={styles.authLogo}
              />
            </div>
          )}
          <p className={styles.subtitle}>
            {error || 'Entrando a tu cuenta...'}
          </p>
        </div>
        {error && (
          <p style={{ textAlign: 'center', fontSize: '0.875rem' }}>
            <Link to={getLoginPathForRoute(redirectPath)}>Iniciar sesión con mi correo y contraseña</Link>
          </p>
        )}
      </div>
    </div>
  )
}
