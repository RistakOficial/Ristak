import React, { useMemo, useState, useEffect, FormEvent, useRef } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Lock, Mail } from 'lucide-react'
import { Button, GoogleLoginButton, Logo } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { apiUrl } from '@/services/apiBaseUrl'
import { requestGoogleLoginUrl } from '@/services/googleLoginService'
import { getDetectedAccountLocaleDefaults } from '@/utils/accountLocale'
import { getLoginPathForRoute, getPostAuthRedirectPath, sanitizeAuthRedirectPath, type RedirectLocation } from '@/utils/phoneAccess'
import styles from './Login.module.css'

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

function isValidSetupEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

export const Setup: React.FC = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)

  const { isAuthenticated, login, setupAccount, needsSetup } = useAuth()
  const setupAccountRef = useRef(setupAccount)
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const setupToken = searchParams.get('token') || ''
  const fromLocation = (location.state as SetupLocationState)?.from
  const redirectPath = sanitizeAuthRedirectPath(
    searchParams.get('return_path'),
    getPostAuthRedirectPath(fromLocation)
  )
  const detectedAccountLocale = useMemo(getDetectedAccountLocaleDefaults, [])

  useEffect(() => {
    setupAccountRef.current = setupAccount
  }, [setupAccount])

  const [tokenState, setTokenState] = useState<TokenState>({
    loading: true,
    requiresToken: false,
    valid: false,
    email: '',
    message: ''
  })

  useEffect(() => {
    setError('')
  }, [setupToken])

  // Si la app fue instalada por el portal central, el enlace de un solo uso
  // intenta el acceso automático. Sin enlace, el dueño puede ingresar con las
  // credenciales que ya registró en el Installer.
  useEffect(() => {
    let cancelled = false

    const waitBeforeRetry = (attempt: number) => new Promise<void>(resolve => {
      window.setTimeout(resolve, Math.min(1000 * attempt, 5000))
    })

    const checkToken = async () => {
      let attempt = 0

      while (!cancelled) {
        try {
          const setupRes = await fetch(apiUrl('/api/auth/setup'))
          const setupData = await setupRes.json()
          if (!setupRes.ok) throw new Error(setupData.message || 'No se pudo consultar el estado de la cuenta')
          const requiresToken = !!setupData.requiresToken

          if (!requiresToken) {
            if (!cancelled) setTokenState({ loading: false, requiresToken: false, valid: false, email: '', message: '' })
            return
          }

          if (!setupToken) {
            if (!cancelled) {
              setTokenState({
                loading: false,
                requiresToken: true,
                valid: false,
                email: '',
                message: 'Para crear tu acceso necesitas el enlace de configuración que te dio el instalador. Revisa tu pantalla de instalación o pide uno nuevo al administrador.'
              })
            }
            return
          }

          const infoRes = await fetch(apiUrl(`/api/auth/setup-info?token=${encodeURIComponent(setupToken)}`))
          const infoData = await infoRes.json()

          if (infoRes.ok && infoData.success) {
            if (!cancelled) {
              setEmail(current => current || infoData.email || '')
              setTokenState({ loading: false, requiresToken: true, valid: true, email: infoData.email || '', message: '' })
            }
            return
          }

          if (infoData.code === 'setup_temporarily_unavailable' || infoRes.status >= 500) {
            throw new Error(infoData.message || 'El portal todavía está preparando el acceso')
          }

          if (!cancelled) {
            setTokenState({
              loading: false,
              requiresToken: true,
              valid: false,
              email: '',
              message: infoData.message || 'El enlace de configuración no es válido o ya expiró.'
            })
          }
          return
        } catch {
          attempt += 1
          await waitBeforeRetry(attempt)
        }
      }
    }

    void checkToken()

    return () => {
      cancelled = true
    }
  }, [setupToken])

  const tokenModeReady = !tokenState.loading && tokenState.requiresToken && tokenState.valid

  useEffect(() => {
    if (!tokenModeReady || !needsSetup) return

    let cancelled = false

    const runAutoSetup = async () => {
      let attempt = 0

      while (!cancelled) {
        try {
          await setupAccountRef.current(tokenState.email, '', setupToken, detectedAccountLocale)
          if (!cancelled) window.location.replace(redirectPath)
          return
        } catch (err: any) {
          if (cancelled) return

          if (err.code === 'license_blocked') {
            navigate('/license-blocked', { replace: true, state: { message: err.message } })
            return
          }
          if (err.code === 'setup_already_completed') {
            navigate(getLoginPathForRoute(fromLocation?.pathname || location.pathname), { replace: true })
            return
          }
          if (err.code === 'password_required') {
            setTokenState(current => ({
              ...current,
              valid: false,
              message: 'Tu acceso del Installer todavía no tiene una contraseña lista. Recupera tu contraseña en el Installer y abre un enlace nuevo para entrar.'
            }))
            return
          }
          if (err.code === 'setup_token_invalid' || err.code === 'setup_token_missing') {
            setTokenState(current => ({
              ...current,
              valid: false,
              message: err.message || 'El enlace de configuración no es válido o ya expiró.'
            }))
            return
          }

          attempt += 1
          await new Promise<void>(resolve => {
            window.setTimeout(resolve, Math.min(1000 * attempt, 5000))
          })
        }
      }
    }

    void runAutoSetup()

    return () => {
      cancelled = true
    }
  }, [tokenModeReady, needsSetup, tokenState.email, setupToken, detectedAccountLocale, navigate, redirectPath, fromLocation?.pathname, location.pathname])

  // Si el setup ya terminó, mandar a la pantalla correcta sin pedir los datos otra vez.
  if (!needsSetup) {
    return isAuthenticated
      ? <Navigate to={redirectPath} replace />
      : <Navigate to={getLoginPathForRoute(fromLocation?.pathname || location.pathname)} replace state={location.state} />
  }

  const tokenMode = tokenState.requiresToken && tokenState.valid
  const installerLoginMode = tokenState.requiresToken && !tokenState.valid

  const handleGoogleLogin = async () => {
    setError('')
    setGoogleLoading(true)

    try {
      window.location.href = await requestGoogleLoginUrl(redirectPath)
    } catch (err: any) {
      setGoogleLoading(false)
      setError(err.message || 'No se pudo iniciar sesión con Google')
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    const effectiveEmail = (tokenMode ? tokenState.email : email).trim()

    // Validaciones
    if (!effectiveEmail || !password || (!installerLoginMode && !confirmPassword)) {
      setError(installerLoginMode ? 'Ingresa tu correo y contraseña' : 'Por favor llena todos los campos')
      return
    }

    if (!isValidSetupEmail(effectiveEmail)) {
      setError('Ingresa un correo válido')
      return
    }

    if (!installerLoginMode && password.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres')
      return
    }

    if (!installerLoginMode && password !== confirmPassword) {
      setError('Las contraseñas no coinciden')
      return
    }

    setIsLoading(true)

    try {
      if (installerLoginMode) {
        await login(effectiveEmail, password)
      } else {
        await setupAccount(effectiveEmail, password, tokenMode ? setupToken : undefined, detectedAccountLocale)
      }
      window.location.replace(redirectPath)
    } catch (err: any) {
      if (err.code === 'license_blocked') {
        navigate('/license-blocked', { replace: true, state: { message: err.message } })
        return
      }
      setError(err.message || (installerLoginMode ? 'Correo o contraseña incorrectos' : 'Error al crear usuario'))
    } finally {
      setIsLoading(false)
    }
  }

  if (tokenState.loading || tokenModeReady) {
    return (
      <div className={styles.container}>
        <div className={styles.authBrand}>
          <Logo size="md" className={styles.authLogo} />
        </div>
        <div className={styles.loginBox}>
          <div className={styles.header}>
            <p className={styles.subtitle}>Preparando tu cuenta... Esto toma unos segundos.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.authBrand}>
        <Logo size="md" className={styles.authLogo} />
      </div>
      <div className={styles.loginBox}>
        <div className={styles.header}>
          <p className={styles.subtitle}>
            {installerLoginMode
              ? 'Continúa con Google o usa el correo y la contraseña que creaste en Ristak.'
              : tokenMode
                ? 'Crea tu contraseña para empezar'
                : 'Configura tu acceso'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          {installerLoginMode && (
            <>
              <GoogleLoginButton
                onClick={handleGoogleLogin}
                loading={googleLoading}
                disabled={isLoading}
              />
              <div className={styles.divider}>
                <span>o usa tu contraseña de Ristak</span>
              </div>
            </>
          )}

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
              <label htmlFor="setupEmail" className={styles.label}>
                Correo de login
              </label>
              <div className={styles.inputWrapper}>
                <Mail size={18} className={styles.inputIcon} />
                <input
                  id="setupEmail"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={styles.input}
                  placeholder="tu@correo.com"
                  autoComplete="email"
                  disabled={isLoading || googleLoading}
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
                autoComplete={installerLoginMode ? 'current-password' : 'new-password'}
                disabled={isLoading || googleLoading}
                minLength={installerLoginMode ? undefined : 6}
              />
            </div>
          </div>

          {!installerLoginMode && (
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
                  disabled={isLoading || googleLoading}
                  minLength={6}
                />
              </div>
            </div>
          )}

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
            disabled={googleLoading}
            className={styles.submitButton}
          >
            {installerLoginMode ? 'Ingresar' : 'Crear mi acceso'}
          </Button>
        </form>

        <p className={styles.setupHint}>
          {installerLoginMode
            ? 'La contraseña de este formulario es la que creaste en Ristak, no la contraseña de tu cuenta de Google.'
            : 'Esta es la única vez que crearás tu usuario. Después ingresas con estas credenciales.'}
        </p>
      </div>
    </div>
  )
}
