import React, { FormEvent, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { Button, Logo } from '@/components/common'
import { apiUrl } from '@/services/apiBaseUrl'
import styles from './Login.module.css'

type InvitationInfo = {
  email: string
  fullName: string
  role: 'admin' | 'employee'
}

export default function AcceptInvitation() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const [invitation, setInvitation] = useState<InvitationInfo | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loadingInfo, setLoadingInfo] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false

    const loadInvitation = async () => {
      if (!token) {
        setError('El enlace está incompleto. Pide una invitación nueva al administrador.')
        setLoadingInfo(false)
        return
      }
      try {
        const response = await fetch(apiUrl('/api/auth/invitation-info'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || data?.success === false) {
          throw new Error(data?.error || 'La invitación no es válida o ya expiró.')
        }
        if (!cancelled) setInvitation(data.invitation)
      } catch (loadError: any) {
        if (!cancelled) setError(loadError?.message || 'No se pudo validar la invitación.')
      } finally {
        if (!cancelled) setLoadingInfo(false)
      }
    }

    void loadInvitation()
    return () => { cancelled = true }
  }, [token])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.')
      return
    }
    setSubmitting(true)
    try {
      const response = await fetch(apiUrl('/api/auth/accept-invitation'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || 'No se pudo activar el acceso.')
      }
      setDone(true)
      window.setTimeout(() => navigate('/login', { replace: true }), 2200)
    } catch (submitError: any) {
      setError(submitError?.message || 'No se pudo activar el acceso.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.authBrand}>
        <Logo size="md" className={styles.authLogo} />
      </div>
      <div className={styles.loginBox}>
        <div className={styles.header}>
          <h1 className={styles.title}>Activa tu acceso</h1>
          <p className={styles.subtitle}>
            {invitation ? `${invitation.fullName} · ${invitation.email}` : 'Crea tu contraseña personal para entrar a Ristak.'}
          </p>
        </div>

        {loadingInfo ? (
          <p className={styles.subtitle}>Validando invitación…</p>
        ) : done ? (
          <div className={styles.successMessage}>
            Tu acceso quedó activo. Te llevamos al inicio de sesión…
          </div>
        ) : invitation ? (
          <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.inputGroup}>
              <label htmlFor="invitation-password" className={styles.label}>Nueva contraseña</label>
              <div className={styles.inputWrapper}>
                <Lock size={18} className={styles.inputIcon} />
                <input
                  id="invitation-password"
                  type="password"
                  className={styles.input}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Mínimo 10 caracteres"
                  autoComplete="new-password"
                  disabled={submitting}
                />
              </div>
            </div>
            <div className={styles.inputGroup}>
              <label htmlFor="invitation-password-confirm" className={styles.label}>Confirma la contraseña</label>
              <div className={styles.inputWrapper}>
                <Lock size={18} className={styles.inputIcon} />
                <input
                  id="invitation-password-confirm"
                  type="password"
                  className={styles.input}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  autoComplete="new-password"
                  disabled={submitting}
                />
              </div>
            </div>
            <p className={styles.subtitle}>Usa al menos 10 caracteres, con mayúsculas, minúsculas y números.</p>
            {error && <div className={styles.error}>{error}</div>}
            <Button type="submit" loading={submitting} disabled={!password || !confirm} className={styles.submitButton}>
              Activar acceso
            </Button>
          </form>
        ) : (
          <div className={styles.error}>{error || 'La invitación no está disponible.'}</div>
        )}
      </div>
    </div>
  )
}
