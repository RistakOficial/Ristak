import React, { useState, FormEvent, useLayoutEffect, useRef } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Terminal, Copy, Check } from 'lucide-react'
import { Button, AppStartupLoader, GoogleLoginButton, Logo } from '@/components/common'
import { PhoneStartupLoader } from '@/components/phone/PhoneStartupLoader'
import { useAuth } from '@/contexts/AuthContext'
import { apiUrl, clearRuntimeApiBaseUrl, getRuntimeApiBaseUrl, getRuntimeTenant, isNativeAppRuntime } from '@/services/apiBaseUrl'
import { mobileAppService } from '@/services/mobileAppService'
import { requestGoogleLoginUrl } from '@/services/googleLoginService'
import { resolveAndStoreMobileTenant } from '@/services/mobileTenantService'
import { PHONE_APP_HOME_PATH, PHONE_APP_TENANT_PATH, getPostAuthRedirectPath, isPhoneAppPath, type RedirectLocation } from '@/utils/phoneAccess'
import { prefetchRouteModule } from '@/routing/routeModules'
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
  <Logo
    size={isPhoneLogin ? 'xl' : 'md'}
    variant={isPhoneLogin ? 'black' : 'auto'}
    className={styles.authLogo}
  />
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
    void prefetchRouteModule(redirectPath).catch(() => undefined)

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
      window.location.href = await requestGoogleLoginUrl(redirectPath)
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
      {!isPhoneLogin && (
        <div className={styles.authBrand}>
          <LoginBrandLogo isPhoneLogin={false} />
        </div>
      )}
      <div
        ref={isPhoneLogin ? phoneLoginSurfaceRef : undefined}
        className={`${styles.loginBox} ${isPhoneLogin ? styles.phoneLoginBox : ''}`}
        data-phone-keyboard-theme-surface={isPhoneLogin ? 'true' : undefined}
        data-phone-scrollable={isPhoneLogin ? 'true' : undefined}
      >
        <div className={styles.header}>
          {isPhoneLogin && (
            <div className={styles.logoContainer}>
              <LoginBrandLogo isPhoneLogin={isPhoneLogin} />
            </div>
          )}
          <p className={styles.subtitle}>
            {isPhoneLogin
              ? tenant?.name
                ? `Inicia sesión para entrar a ${tenant.name}.`
                : 'Inicia sesión para ver chats, pagos y citas desde el celular.'
              : 'Inicia sesión para gestionar chats, pagos, citas y automatizaciones.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          <GoogleLoginButton
            onClick={handleGoogleLogin}
            loading={googleLoading}
            disabled={isLoading}
            className={styles.googleButton}
          />

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
