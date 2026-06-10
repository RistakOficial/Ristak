import React, { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import styles from './Login.module.css'

const API_URL = import.meta.env.VITE_API_URL || ''

/**
 * Entrada directa desde el portal central: /sso?token=...
 * Canjea el token de un solo uso por una sesión local y entra al dashboard
 * sin pedir contraseña. Si la app aún no tiene usuarios, manda al setup.
 */
export const Sso: React.FC = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [error, setError] = useState('')
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const run = async () => {
      if (!token) {
        setError('Este enlace no es válido.')
        return
      }

      try {
        const response = await fetch(`${API_URL}/api/auth/sso`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        })
        const data = await response.json()

        if (response.ok && data.success && data.token) {
          localStorage.setItem('auth_token', data.token)
          if (data.apiToken) {
            sessionStorage.setItem('ristak_latest_api_token', data.apiToken)
          }
          // Recarga completa para que la app levante la sesión nueva
          window.location.href = '/dashboard'
          return
        }

        if (data.code === 'needs_setup') {
          // La app todavía no tiene usuarios: el mismo token sirve para el setup
          navigate(`/setup?token=${encodeURIComponent(token)}`, { replace: true })
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
  }, [token, navigate])

  return (
    <div className={styles.container}>
      <div className={styles.loginBox}>
        <div className={styles.header}>
          <h1 className={styles.title}>Ristak</h1>
          <p className={styles.subtitle}>
            {error || 'Entrando a tu cuenta...'}
          </p>
        </div>
        {error && (
          <p style={{ textAlign: 'center', fontSize: '0.875rem' }}>
            <Link to="/login">Iniciar sesión con mi correo y contraseña</Link>
          </p>
        )}
      </div>
    </div>
  )
}
