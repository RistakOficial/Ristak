import React from 'react'
import { Loader2 } from 'lucide-react'
import { Logo } from '@/components/common'
import { loginWithPortal } from '@/services/mobileTenantService'
import styles from './MobileTenantSetup.module.css'

export const MobileTenantSetup: React.FC = () => {
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  // Login único: correo + contraseña. El portal resuelve el backend del
  // cliente y la app entra directo, sin una segunda pantalla.
  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setIsSubmitting(true)

    try {
      await loginWithPortal(email, password)
      window.location.replace('/phone/chat')
    } catch (err) {
      if ((err as { code?: string })?.code === 'license_blocked') {
        window.location.replace('/license-blocked')
        return
      }
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión.')
      setIsSubmitting(false)
    }
  }

  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-labelledby="mobile-login-title">
        <div className={styles.header}>
          <Logo size="xl" variant="black" className={styles.logo} />
          <h1 id="mobile-login-title" className={styles.formTitle}>Iniciar sesión</h1>
        </div>

        <form className={styles.form} onSubmit={handleLogin}>
          <label className={styles.label} htmlFor="mobile-login-email">Correo</label>
          <input
            id="mobile-login-email"
            className={styles.input}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="tu@correo.com"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            inputMode="email"
            disabled={isSubmitting}
          />

          <label className={styles.label} htmlFor="mobile-login-password">Contraseña</label>
          <input
            id="mobile-login-password"
            className={styles.input}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="********"
            autoComplete="current-password"
            disabled={isSubmitting}
          />

          {error && <p className={styles.error}>{error}</p>}

          <button type="submit" className={styles.primaryButton} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className={styles.spinner} size={18} />}
            <span>{isSubmitting ? 'Entrando' : 'Iniciar sesión'}</span>
          </button>
        </form>
      </section>
    </main>
  )
}
