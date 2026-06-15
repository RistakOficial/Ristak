import React, { useState, FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Terminal, Copy, Check } from 'lucide-react'
import { Button, Logo } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { PHONE_APP_HOME_PATH, getPostAuthRedirectPath, type RedirectLocation } from '@/utils/phoneAccess'
import styles from './Login.module.css'

type LoginLocationState = {
  from?: RedirectLocation
} | null

const API_URL = import.meta.env.VITE_API_URL || ''

function cleanLoginIdentifier(value: string) {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
}

const LoginBrandLogo: React.FC<{ isPhoneLogin: boolean }> = ({ isPhoneLogin }) => (
  <Logo
    size="2xl"
    variant={isPhoneLogin ? 'black' : 'auto'}
    className={`${styles.brandLogo} ${isPhoneLogin ? styles.phoneBrandLogo : ''}`}
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
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [showRecovery, setShowRecovery] = useState(false)
  const [copied, setCopied] = useState(false)

  const { isAuthenticated, isLoading: isAuthLoading, login, needsSetup } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const fromLocation = (location.state as LoginLocationState)?.from
  const isPhoneLogin = location.pathname.startsWith('/phone')
  const redirectPath = getPostAuthRedirectPath(fromLocation, isPhoneLogin ? PHONE_APP_HOME_PATH : '/dashboard')

  if (isAuthLoading) {
    return (
      <div className={`${styles.container} ${isPhoneLogin ? styles.phoneContainer : ''}`}>
        <div className={`${styles.loginBox} ${isPhoneLogin ? styles.phoneLoginBox : ''}`}>
          <div className={styles.header}>
            <div className={styles.logoContainer}>
              <LoginBrandLogo isPhoneLogin={isPhoneLogin} />
            </div>
            <h1 className={`${styles.title} ${styles.visuallyHidden}`}>Ristak</h1>
            <p className={styles.subtitle}>Revisando tu acceso...</p>
          </div>
        </div>
      </div>
    )
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

    const loginIdentifier = cleanLoginIdentifier(username)

    if (!loginIdentifier || !password) {
      setError('Por favor ingresa usuario y contraseña')
      return
    }

    setIsLoading(true)

    try {
      await login(loginIdentifier, password)
      navigate(redirectPath, { replace: true })
    } catch (err: any) {
      if (err.code === 'license_blocked') {
        navigate('/license-blocked', { replace: true, state: { message: err.message } })
        return
      }
      setError(err.message || 'Usuario o contraseña incorrectos')
    } finally {
      setIsLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setError('')
    setGoogleLoading(true)

    try {
      const response = await fetch(`${API_URL}/api/auth/google/start`, {
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
    const code = `node -e "const crypto = require('crypto'); const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); async function reset() { const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.pbkdf2Sync('admin123', salt, 100000, 64, 'sha512').toString('hex'); const passwordHash = salt + ':' + hash; await pool.query('UPDATE users SET username = \$1, password_hash = \$2, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)', ['admin', passwordHash]); process.stdout.write('✅ Credenciales reseteadas: admin / admin123\\n'); await pool.end(); } reset();"`

    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`${styles.container} ${isPhoneLogin ? styles.phoneContainer : ''}`}>
      <div className={`${styles.loginBox} ${isPhoneLogin ? styles.phoneLoginBox : ''}`}>
        <div className={styles.header}>
          <div className={styles.logoContainer}>
            <LoginBrandLogo isPhoneLogin={isPhoneLogin} />
          </div>
          <h1 className={`${styles.title} ${styles.visuallyHidden}`}>Ristak</h1>
          <p className={styles.subtitle}>
            {isPhoneLogin ? 'Entra para ver tus chats, pagos y citas desde el celular.' : 'Ingresa a tu cuenta'}
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
            <label htmlFor="username" className={styles.label}>
              Email o usuario
            </label>
            <input
              id="username"
              name="username"
              data-ristak-unstyled
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={styles.input}
              placeholder="tu@correo.com"
              autoComplete="username"
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
            ¿Olvidé mi usuario o contraseña?
          </button>
        </form>

        {showRecovery && (
          <div className={styles.recoverySection}>
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
                    <code>
                      node -e "const crypto = require('crypto'); const &#123; Pool &#125; = require('pg'); const pool = new Pool(&#123; connectionString: process.env.DATABASE_URL, ssl: &#123; rejectUnauthorized: false &#125; &#125;); async function reset() &#123; const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.pbkdf2Sync('admin123', salt, 100000, 64, 'sha512').toString('hex'); const passwordHash = salt + ':' + hash; await pool.query('UPDATE users SET username = $1, password_hash = $2, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)', ['admin', passwordHash]); process.stdout.write('✅ Credenciales reseteadas: admin / admin123\n'); await pool.end(); &#125; reset();"
                    </code>
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
                  Presiona <strong>Enter</strong> y espera a que veas el mensaje:
                  <div className={styles.successMessage}>
                    ✅ Credenciales reseteadas: admin / admin123
                  </div>
                </li>
                <li>
                  Ahora puedes loguearte con:
                  <div className={styles.credentialsBox}>
                    <p><strong>Usuario:</strong> admin</p>
                    <p><strong>Contraseña:</strong> admin123</p>
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
