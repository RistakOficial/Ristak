import React, { useState, FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { Button, Logo } from '@/components/common'
import { apiUrl } from '@/services/apiBaseUrl'
import styles from './Login.module.css'

// (AUTH-010) Página a la que aterriza el enlace de recuperación del correo.
// Lee ?token, pide una nueva contraseña y la confirma contra /api/auth/reset-password.
export default function ResetPassword() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (!token) { setError('El enlace es inválido o está incompleto.'); return }
    if (password !== confirm) { setError('Las contraseñas no coinciden.'); return }
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/auth/reset-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.success === false) {
        setError(data?.error || 'No se pudo restablecer la contraseña.')
        return
      }
      setDone(true)
      setTimeout(() => navigate('/login', { replace: true }), 2500)
    } catch {
      setError('No se pudo conectar. Intenta de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.authBrand}>
        <Logo size="md" className={styles.authLogo} />
      </div>
      <div className={styles.loginBox}>
        <div className={styles.header}>
          <p className={styles.subtitle}>Restablece tu contraseña</p>
        </div>

        {done ? (
          <div className={styles.successMessage}>
            Tu contraseña se actualizó. Te llevamos al inicio de sesión…
          </div>
        ) : !token ? (
          <div className={styles.error}>
            El enlace es inválido o está incompleto. Solicita uno nuevo desde la pantalla de inicio de sesión.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.inputGroup}>
              <label htmlFor="newPassword" className={styles.label}>Nueva contraseña</label>
              <div className={styles.inputWrapper}>
                <Lock size={18} className={styles.inputIcon} />
                <input
                  id="newPassword"
                  type="password"
                  className={styles.input}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 10 caracteres"
                  autoComplete="new-password"
                  disabled={loading}
                />
              </div>
            </div>
            <div className={styles.inputGroup}>
              <label htmlFor="confirmPassword" className={styles.label}>Confirma la contraseña</label>
              <div className={styles.inputWrapper}>
                <Lock size={18} className={styles.inputIcon} />
                <input
                  id="confirmPassword"
                  type="password"
                  className={styles.input}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  disabled={loading}
                />
              </div>
            </div>
            {error && <div className={styles.error}>{error}</div>}
            <Button type="submit" loading={loading} disabled={!password || !confirm} className={styles.submitButton}>
              Cambiar contraseña
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
