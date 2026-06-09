import React, { useState, useEffect, FormEvent } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Lock, Mail, User, UserPlus } from 'lucide-react'
import { Button } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { getLoginPathForRoute, getPostAuthRedirectPath, type RedirectLocation } from '@/utils/phoneAccess'
import styles from './Login.module.css'

const API_URL = import.meta.env.VITE_API_URL || ''

type SetupLocationState = {
  from?: RedirectLocation
} | null

type TokenState = {
  loading: boolean
  requiresToken: boolean
  valid: boolean
  email: string
  message: string
}

export const Setup: React.FC = () => {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const { isAuthenticated, setupAccount, needsSetup } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const setupToken = searchParams.get('token') || ''
  const fromLocation = (location.state as SetupLocationState)?.from
  const redirectPath = getPostAuthRedirectPath(fromLocation)

  const [tokenState, setTokenState] = useState<TokenState>({
    loading: true,
    requiresToken: false,
    valid: false,
    email: '',
    message: ''
  })

  // Si la app fue instalada por el portal central, el setup requiere el enlace
  // con token de un solo uso y el email del dueño viene precargado.
  useEffect(() => {
    const checkToken = async () => {
      try {
        const setupRes = await fetch(`${API_URL}/api/auth/setup`)
        const setupData = await setupRes.json()
        const requiresToken = !!setupData.requiresToken

        if (!requiresToken) {
          setTokenState({ loading: false, requiresToken: false, valid: false, email: '', message: '' })
          return
        }

        if (!setupToken) {
          setTokenState({
            loading: false,
            requiresToken: true,
            valid: false,
            email: '',
            message: 'Para crear tu acceso necesitas el enlace de configuración que te dio el instalador. Revisa tu pantalla de instalación o pide uno nuevo al administrador.'
          })
          return
        }

        const infoRes = await fetch(`${API_URL}/api/auth/setup-info?token=${encodeURIComponent(setupToken)}`)
        const infoData = await infoRes.json()

        if (infoRes.ok && infoData.success) {
          setTokenState({ loading: false, requiresToken: true, valid: true, email: infoData.email || '', message: '' })
        } else {
          setTokenState({
            loading: false,
            requiresToken: true,
            valid: false,
            email: '',
            message: infoData.message || 'El enlace de configuración no es válido o ya expiró.'
          })
        }
      } catch {
        setTokenState({
          loading: false,
          requiresToken: false,
          valid: false,
          email: '',
          message: ''
        })
      }
    }

    checkToken()
  }, [setupToken])

  // Si el setup ya terminó, mandar a la pantalla correcta sin pedir los datos otra vez.
  if (!needsSetup) {
    return isAuthenticated
      ? <Navigate to={redirectPath} replace />
      : <Navigate to={getLoginPathForRoute(fromLocation?.pathname || location.pathname)} replace state={location.state} />
  }

  const tokenMode = tokenState.requiresToken && tokenState.valid

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    const effectiveUsername = tokenMode ? tokenState.email : username

    // Validaciones
    if (!effectiveUsername || !password || !confirmPassword) {
      setError('Por favor llena todos los campos')
      return
    }

    if (!tokenMode && username.length < 3) {
      setError('El usuario debe tener al menos 3 caracteres')
      return
    }

    if (password.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres')
      return
    }

    if (password !== confirmPassword) {
      setError('Las contraseñas no coinciden')
      return
    }

    setIsLoading(true)

    try {
      await setupAccount(effectiveUsername, password, tokenMode ? setupToken : undefined)
      navigate(redirectPath, { replace: true })
    } catch (err: any) {
      if (err.code === 'license_blocked') {
        navigate('/license-blocked', { replace: true, state: { message: err.message } })
        return
      }
      setError(err.message || 'Error al crear usuario')
    } finally {
      setIsLoading(false)
    }
  }

  if (tokenState.loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loginBox}>
          <div className={styles.header}>
            <h1 className={styles.title}>Ristak</h1>
            <p className={styles.subtitle}>Preparando tu configuración...</p>
          </div>
        </div>
      </div>
    )
  }

  // Instalación gestionada sin enlace válido: no se puede crear el acceso.
  if (tokenState.requiresToken && !tokenState.valid) {
    return (
      <div className={styles.container}>
        <div className={styles.loginBox}>
          <div className={styles.header}>
            <div className={styles.logoContainer}>
              <div className={styles.logo}>
                <UserPlus size={32} strokeWidth={1.5} />
              </div>
            </div>
            <h1 className={styles.title}>Ristak</h1>
            <p className={styles.subtitle}>{tokenState.message}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.loginBox}>
        <div className={styles.header}>
          <div className={styles.logoContainer}>
            <div className={styles.logo}>
              <UserPlus size={32} strokeWidth={1.5} />
            </div>
          </div>
          <h1 className={styles.title}>Ristak</h1>
          <p className={styles.subtitle}>
            {tokenMode ? 'Crea tu contraseña para empezar' : 'Configura tu acceso'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          {tokenMode ? (
            <div className={styles.inputGroup}>
              <label htmlFor="email" className={styles.label}>
                Tu cuenta
              </label>
              <div className={styles.inputWrapper}>
                <Mail size={18} className={styles.inputIcon} />
                <input
                  id="email"
                  type="email"
                  value={tokenState.email}
                  className={styles.input}
                  disabled
                  readOnly
                />
              </div>
            </div>
          ) : (
            <div className={styles.inputGroup}>
              <label htmlFor="username" className={styles.label}>
                Usuario
              </label>
              <div className={styles.inputWrapper}>
                <User size={18} className={styles.inputIcon} />
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={styles.input}
                  placeholder="ej. raul"
                  autoComplete="username"
                  disabled={isLoading}
                  minLength={3}
                />
              </div>
            </div>
          )}

          <div className={styles.inputGroup}>
            <label htmlFor="password" className={styles.label}>
              Contraseña
            </label>
            <div className={styles.inputWrapper}>
              <Lock size={18} className={styles.inputIcon} />
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={styles.input}
                placeholder="••••••••"
                autoComplete="new-password"
                disabled={isLoading}
                minLength={6}
              />
            </div>
          </div>

          <div className={styles.inputGroup}>
            <label htmlFor="confirmPassword" className={styles.label}>
              Confirmar contraseña
            </label>
            <div className={styles.inputWrapper}>
              <Lock size={18} className={styles.inputIcon} />
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={styles.input}
                placeholder="••••••••"
                autoComplete="new-password"
                disabled={isLoading}
                minLength={6}
              />
            </div>
          </div>

          {error && (
            <div className={styles.error}>
              {error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            fullWidth
            loading={isLoading}
            className={styles.submitButton}
          >
            Crear mi acceso
          </Button>
        </form>

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
          ✨ Esta es la única vez que crearás tu usuario. Después ingresas con estas credenciales.
        </div>
      </div>
    </div>
  )
}
