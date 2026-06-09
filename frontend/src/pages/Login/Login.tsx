import React, { useState, FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Lock, User, Terminal, Copy, Check } from 'lucide-react'
import { Button } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import styles from './Login.module.css'

type RedirectLocation = {
  pathname?: string
  search?: string
  hash?: string
}

type LoginLocationState = {
  from?: RedirectLocation
} | null

function getRedirectPath(from?: RedirectLocation) {
  const pathname = from?.pathname

  if (!pathname?.startsWith('/') || pathname === '/login' || pathname === '/setup') {
    return '/dashboard'
  }

  return `${pathname}${from.search || ''}${from.hash || ''}`
}

export const Login: React.FC = () => {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [showRecovery, setShowRecovery] = useState(false)
  const [copied, setCopied] = useState(false)

  const { login } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const redirectPath = getRedirectPath((location.state as LoginLocationState)?.from)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (!username || !password) {
      setError('Por favor ingresa usuario y contraseña')
      return
    }

    setIsLoading(true)

    try {
      await login(username, password)
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

  const handleCopyCode = () => {
    const code = `node -e "const crypto = require('crypto'); const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); async function reset() { const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.pbkdf2Sync('admin123', salt, 100000, 64, 'sha512').toString('hex'); const passwordHash = salt + ':' + hash; await pool.query('UPDATE users SET username = \$1, password_hash = \$2, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)', ['admin', passwordHash]); process.stdout.write('✅ Credenciales reseteadas: admin / admin123\\n'); await pool.end(); } reset();"`

    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={styles.container}>
      <div className={styles.loginBox}>
        <div className={styles.header}>
          <div className={styles.logoContainer}>
            <div className={styles.logo}>
              <Lock size={32} strokeWidth={1.5} />
            </div>
          </div>
          <h1 className={styles.title}>Ristak</h1>
          <p className={styles.subtitle}>Ingresa a tu cuenta</p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
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
                placeholder="admin"
                autoComplete="username"
                disabled={isLoading}
              />
            </div>
          </div>

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
                autoComplete="current-password"
                disabled={isLoading}
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
