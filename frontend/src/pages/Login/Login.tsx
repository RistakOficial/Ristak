import React, { useState, FormEvent, useLayoutEffect, useRef } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Terminal, Copy, Check } from 'lucide-react'
import { Button, AppStartupLoader, RistakAppMark } from '@/components/common'
import { PhoneStartupLoader } from '@/components/phone/PhoneStartupLoader'
import { useAuth } from '@/contexts/AuthContext'
import { apiUrl, clearRuntimeApiBaseUrl, getRuntimeApiBaseUrl, getRuntimeTenant, isNativeAppRuntime } from '@/services/apiBaseUrl'
import { mobileAppService } from '@/services/mobileAppService'
import { resolveAndStoreMobileTenant } from '@/services/mobileTenantService'
import { PHONE_APP_HOME_PATH, PHONE_APP_TENANT_PATH, getPostAuthRedirectPath, isPhoneAppPath, type RedirectLocation } from '@/utils/phoneAccess'
import styles from './Login.module.css'

type LoginLocationState = {
  from?: RedirectLocation
} | null

function cleanLoginEmail(value: string) {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
}

function isValidLoginEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

const RENDER_PASSWORD_RESET_COMMAND = `node -e "const crypto = require('crypto'); const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); async function reset() { const result = await pool.query('SELECT id, email FROM users ORDER BY id LIMIT 1'); const user = result.rows[0]; if (!user) throw new Error('No hay usuarios en la base de datos.'); const email = String(user.email || '').trim().toLowerCase(); if (!email) throw new Error('El usuario no tiene correo de login guardado. Actualiza users.email antes de resetear contraseña.'); const newPassword = crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16); const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.pbkdf2Sync(newPassword, salt, 100000, 64, 'sha512').toString('hex'); const passwordHash = salt + ':' + hash; await pool.query('UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [passwordHash, user.id]); process.stdout.write('✅ Contraseña reseteada. Correo: ' + email + ' · Contraseña temporal: ' + newPassword + '\\n'); } reset().catch((error) => { console.error('❌ ' + error.message); process.exitCode = 1; }).finally(() => pool.end());"`

const LoginBrandLogo: React.FC<{ isPhoneLogin: boolean }> = ({ isPhoneLogin }) => (
  <RistakAppMark
    size={isPhoneLogin ? 'xl' : 'lg'}
    className={`${styles.brandMark} ${isPhoneLogin ? styles.phoneBrandMark : ''}`}
    decorative
  />
)

const GoogleGIcon: React.FC = () => (
  <svg className={styles.googleIcon} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.62z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
  </svg>
)

export const Login: React.FC = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [showRecovery, setShowRecovery] = useState(false)
  const [copied, setCopied] = useState(false)
  // (AUTH-010) Recuperación por correo
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [recoverySending, setRecoverySending] = useState(false)
  const [recoverySent, setRecoverySent] = useState(false)

  const { isAuthenticated, isLoading: isAuthLoading, login, needsSetup } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const fromLocation = (location.state as LoginLocationState)?.from
  const isPhoneLogin = isPhoneAppPath(location.pathname)
  const redirectPath = getPostAuthRedirectPath(fromLocation, isPhoneLogin ? PHONE_APP_HOME_PATH : '/dashboard')
  const tenant = isPhoneLogin && isNativeAppRuntime() ? getRuntimeTenant() : null
  const phoneLoginSurfaceRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!isPhoneLogin) return

    const syncShell = () => {
      mobileAppService.syncShellBackgroundFromElement(phoneLoginSurfaceRef.current, 'light')
    }

    syncShell()
    const frame = window.requestAnimationFrame(syncShell)
    return () => window.cancelAnimationFrame(frame)
  }, [isPhoneLogin, showRecovery, tenant?.name])

  if (isAuthLoading) {
    return isPhoneLogin
      ? <PhoneStartupLoader message="Revisando tu acceso" />
      : <AppStartupLoader message="Revisando tu acceso" />
  }

  if (needsSetup) {
    return <Navigate to="/setup" state={{ from: (location.state as LoginLocationState)?.from || location }} replace />
  }

  if (isAuthenticated) {
    return <Navigate to={redirectPath} replace />
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    const loginEmail = cleanLoginEmail(email)

    if (!loginEmail || !password) {
      setError('Por favor ingresa correo y contraseña')
      return
    }

    if (!isValidLoginEmail(loginEmail)) {
      setError('Ingresa un correo válido')
      return
    }

    setIsLoading(true)

    const isMobileRuntime = isPhoneLogin && isNativeAppRuntime()

    try {
      await login(loginEmail, password)
      navigate(redirectPath, { replace: true })
    } catch (err: any) {
      if (err.code === 'license_blocked') {
        navigate('/license-blocked', { replace: true, state: { message: err.message } })
        return
      }

      // (MOB-003) En la app móvil, un fallo de login puede deberse a que el
      // correo pertenece a OTRA empresa y la app sigue apuntando al backend
      // anterior. Re-resolvemos el tenant a partir del correo y, si cambió de
      // backend, reintentamos el login una sola vez contra el correcto.
      if (isMobileRuntime) {
        const previousBaseUrl = getRuntimeApiBaseUrl()
        try {
          await resolveAndStoreMobileTenant(loginEmail)
        } catch (resolveErr: any) {
          // No encontramos una app activa para ese correo: mensaje claro para
          // cambiar de empresa, sin dejar al usuario adivinando.
          setError(resolveErr?.message || 'No encontramos una empresa activa para ese correo. Toca "Cambiar empresa" para entrar a otra.')
          return
        }

        const resolvedBaseUrl = getRuntimeApiBaseUrl()
        if (resolvedBaseUrl && resolvedBaseUrl !== previousBaseUrl) {
          // El correo apunta a otro backend: reintenta el login ahí.
          try {
            await login(loginEmail, password)
            navigate(redirectPath, { replace: true })
            return
          } catch (retryErr: any) {
            if (retryErr.code === 'license_blocked') {
              navigate('/license-blocked', { replace: true, state: { message: retryErr.message } })
              return
            }
            setError(retryErr.message || 'Correo o contraseña incorrectos.')
            return
          }
        }
      }

      setError(err.message || 'Correo o contraseña incorrectos')
    } finally {
      setIsLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setError('')
    setGoogleLoading(true)

    try {
      const response = await fetch(apiUrl('/api/auth/google/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ return_path: redirectPath })
      })
      const data = await response.json().catch(() => ({}))

      if (!response.ok || !data?.success || !data?.url) {
        throw new Error(data?.message || 'No se pudo abrir Google. Inténtalo otra vez.')
      }

      window.location.href = data.url
    } catch (err: any) {
      setGoogleLoading(false)
      setError(err.message || 'No se pudo iniciar sesión con Google')
    }
  }

  const handleCopyCode = () => {
    // (AUTH-002) El comando genera una contraseña ALEATORIA temporal y la imprime,
    // en vez de fijar 'admin123' (credencial conocida que cualquiera veía en esta página).
    navigator.clipboard.writeText(RENDER_PASSWORD_RESET_COMMAND)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleChangeTenant = () => {
    clearRuntimeApiBaseUrl()
    navigate(PHONE_APP_TENANT_PATH, { replace: true })
  }

  // (AUTH-010) Solicitar enlace de recuperación por correo. Anti-enumeración: siempre
  // mostramos el mismo mensaje, exista o no el correo.
  const handleForgotPassword = async (e: FormEvent) => {
    e.preventDefault()
    if (!recoveryEmail.trim() || recoverySending) return
    setRecoverySending(true)
    try {
      await fetch(apiUrl('/api/auth/forgot-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: recoveryEmail.trim() })
      })
    } catch {
      // Ignoramos errores de red a propósito (mismo mensaje genérico).
    } finally {
      setRecoverySending(false)
      setRecoverySent(true)
    }
  }

  return (
    <div className={`${styles.container} ${isPhoneLogin ? styles.phoneContainer : ''}`}>
      <div
        ref={isPhoneLogin ? phoneLoginSurfaceRef : undefined}
        className={`${styles.loginBox} ${isPhoneLogin ? styles.phoneLoginBox : ''}`}
        data-phone-keyboard-theme-surface={isPhoneLogin ? 'true' : undefined}
        data-phone-scrollable={isPhoneLogin ? 'true' : undefined}
      >
        <div className={styles.header}>
          <div className={styles.logoContainer}>
            <LoginBrandLogo isPhoneLogin={isPhoneLogin} />
          </div>
          <h1 className={styles.title}>Ristak</h1>
          <p className={styles.subtitle}>
            {isPhoneLogin
              ? tenant?.name
                ? `Inicia sesión para entrar a ${tenant.name}.`
                : 'Inicia sesión para ver chats, pagos y citas desde el celular.'
              : 'Inicia sesión para gestionar chats, pagos, citas y automatizaciones.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          <button
            type="button"
            onClick={handleGoogleLogin}
            className={styles.googleButton}
            disabled={isLoading || googleLoading}
          >
            <GoogleGIcon />
            <span>{googleLoading ? 'Abriendo Google...' : 'Continuar con Google'}</span>
          </button>

          <div className={styles.divider}>
            <span>o usa tu correo</span>
          </div>

          <div className={styles.inputGroup}>
            <label htmlFor="email" className={styles.label}>
              Correo electrónico
            </label>
            <input
              id="email"
              name="email"
              data-ristak-unstyled
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={styles.input}
              placeholder="tu@correo.com"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              inputMode="email"
              enterKeyHint="next"
              spellCheck={false}
              disabled={isLoading || googleLoading}
            />
          </div>

          <div className={styles.inputGroup}>
            <label htmlFor="password" className={styles.label}>
              Contraseña
            </label>
            <input
              id="password"
              name="password"
              data-ristak-unstyled
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={styles.input}
              placeholder="********"
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              enterKeyHint="go"
              spellCheck={false}
              disabled={isLoading || googleLoading}
            />
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
            disabled={googleLoading}
            className={styles.submitButton}
          >
            Iniciar sesión
          </Button>

          <button
            type="button"
            onClick={() => setShowRecovery(!showRecovery)}
            className={styles.forgotLink}
          >
            ¿Olvidaste tu contraseña?
          </button>

          {isPhoneLogin && isNativeAppRuntime() && (
            <button
              type="button"
              onClick={handleChangeTenant}
              className={styles.forgotLink}
            >
              Cambiar empresa
            </button>
          )}
        </form>

        {showRecovery && (
          <div className={styles.recoverySection}>
            {/* (AUTH-010) Recuperación por correo (primaria) */}
            {recoverySent ? (
              <div className={styles.successMessage}>
                Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña. Revisa tu bandeja de entrada (y spam). El enlace vence en 1 hora.
              </div>
            ) : (
              <form onSubmit={handleForgotPassword}>
                <div className={styles.inputGroup}>
                  <label className={styles.label} htmlFor="recoveryEmail">Recupera tu acceso por correo</label>
                  <input
                    id="recoveryEmail"
                    type="email"
                    className={styles.input}
                    placeholder="tu@correo.com"
                    value={recoveryEmail}
                    onChange={(e) => setRecoveryEmail(e.target.value)}
                    disabled={recoverySending}
                  />
                </div>
                <Button
                  type="submit"
                  loading={recoverySending}
                  disabled={!recoveryEmail.trim()}
                  className={styles.submitButton}
                >
                  Enviar enlace de recuperación
                </Button>
              </form>
            )}

            <div className={styles.recoveryHeader}>
              <Terminal size={20} />
              <h3>Recuperar acceso desde Render</h3>
            </div>

            <div className={styles.recoveryContent}>
              <p className={styles.recoveryIntro}>
                Si olvidaste tus credenciales, puedes resetearlas usando el Shell de Render:
              </p>

              <ol className={styles.recoverySteps}>
                <li>
                  <strong>Ve a tu Dashboard de Render:</strong>
                  <br />
                  <a href="https://dashboard.render.com" target="_blank" rel="noopener noreferrer" className={styles.externalLink}>
                    https://dashboard.render.com
                  </a>
                </li>
                <li>
                  <strong>Selecciona tu servicio backend</strong> (Ristak API)
                </li>
                <li>
                  En el menú lateral izquierdo, haz click en <strong>"Shell"</strong>
                </li>
                <li>
                  Copia y pega este comando en el Shell:
                  <div className={styles.codeBlock}>
                    <code>{RENDER_PASSWORD_RESET_COMMAND}</code>
                    <button
                      onClick={handleCopyCode}
                      className={styles.copyButton}
                      title="Copiar código"
                    >
                      {copied ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                  </div>
                </li>
                <li>
                  Presiona <strong>Enter</strong> y espera a que veas el mensaje (la contraseña es aleatoria y única en cada reseteo):
                  <div className={styles.successMessage}>
                    ✅ Contraseña reseteada. Correo: tu@correo.com · Contraseña temporal: ••••••••
                  </div>
                </li>
                <li>
                  Ahora puedes loguearte con:
                  <div className={styles.credentialsBox}>
                    <p><strong>Correo:</strong> el correo que imprimió el comando</p>
                    <p><strong>Contraseña:</strong> la contraseña temporal que imprimió el comando (cópiala del Shell)</p>
                  </div>
                </li>
              </ol>

              <div className={styles.warningBox}>
                <strong>⚠️ Importante:</strong> Después de resetear, ve a Configuración → Cuenta y cambia tus credenciales por unas seguras.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
