import React from 'react'
import { ArrowRight, Building2, Loader2, RefreshCw } from 'lucide-react'
import { Logo } from '@/components/common'
import { clearRuntimeApiBaseUrl, getRuntimeTenant } from '@/services/apiBaseUrl'
import { loginWithPortal, resolveAndStoreMobileTenant } from '@/services/mobileTenantService'
import styles from './MobileTenantSetup.module.css'

type Mode = 'portal' | 'staff'

export const MobileTenantSetup: React.FC = () => {
  const [mode, setMode] = React.useState<Mode>('portal')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [identifier, setIdentifier] = React.useState('')
  const [error, setError] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [tenant, setTenant] = React.useState(getRuntimeTenant)

  // Login único (igual que www.ristak.com/login): correo + contraseña del
  // dueño → el portal resuelve su backend y nos da un token → la app entra
  // directo sin segunda pantalla.
  const handlePortalLogin = async (event: React.FormEvent) => {
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

  // Respaldo para staff/sub-usuarios: resuelven su empresa y luego entran con
  // el login propio de su backend.
  const handleStaffResolve = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setIsSubmitting(true)

    try {
      await resolveAndStoreMobileTenant(identifier)
      window.location.replace('/phone/login')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo abrir tu app.')
      setIsSubmitting(false)
    }
  }

  const handleChangeTenant = () => {
    clearRuntimeApiBaseUrl()
    setTenant(null)
    setIdentifier('')
    setError('')
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setError('')
  }

  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-labelledby="mobile-tenant-title">
        <div className={styles.brand}>
          <Logo size="xl" variant="black" className={styles.logo} />
          <span className={styles.badge}>iPhone</span>
        </div>

        {tenant ? (
          <div className={styles.currentTenant}>
            <div className={styles.tenantIcon}>
              <Building2 size={22} />
            </div>
            <div>
              <p className={styles.eyebrow}>Empresa seleccionada</p>
              <h1 id="mobile-tenant-title" className={styles.title}>{tenant.name || tenant.email || 'Ristak'}</h1>
              <p className={styles.url}>{tenant.appUrl}</p>
            </div>
            <div className={styles.actions}>
              <button type="button" className={styles.primaryButton} onClick={() => window.location.replace('/phone/login')}>
                <span>Entrar</span>
                <ArrowRight size={18} />
              </button>
              <button type="button" className={styles.secondaryButton} onClick={handleChangeTenant}>
                <RefreshCw size={16} />
                <span>Cambiar</span>
              </button>
            </div>
          </div>
        ) : mode === 'portal' ? (
          <>
            <div className={styles.copy}>
              <p className={styles.eyebrow}>Iniciar sesión</p>
              <h1 id="mobile-tenant-title" className={styles.title}>Abre tu Ristak</h1>
              <p className={styles.subtitle}>Entra con el correo y la contraseña de tu cuenta.</p>
            </div>

            <form className={styles.form} onSubmit={handlePortalLogin}>
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
                {isSubmitting ? <Loader2 className={styles.spinner} size={18} /> : <ArrowRight size={18} />}
                <span>{isSubmitting ? 'Entrando' : 'Iniciar sesión'}</span>
              </button>
            </form>

            <button type="button" className={styles.linkButton} onClick={() => switchMode('staff')}>
              ¿Eres parte del equipo? Entrar con tu empresa
            </button>
          </>
        ) : (
          <>
            <div className={styles.copy}>
              <p className={styles.eyebrow}>Conectar empresa</p>
              <h1 id="mobile-tenant-title" className={styles.title}>Abre tu Ristak</h1>
              <p className={styles.subtitle}>Usa el correo de tu cuenta, el nombre de tu empresa o tu código de invitación.</p>
            </div>

            <form className={styles.form} onSubmit={handleStaffResolve}>
              <label className={styles.label} htmlFor="mobile-tenant-identifier">Empresa o correo</label>
              <input
                id="mobile-tenant-identifier"
                className={styles.input}
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="cliente@empresa.com"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="email"
                inputMode="email"
                disabled={isSubmitting}
              />

              {error && <p className={styles.error}>{error}</p>}

              <button type="submit" className={styles.primaryButton} disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className={styles.spinner} size={18} /> : <ArrowRight size={18} />}
                <span>{isSubmitting ? 'Buscando' : 'Continuar'}</span>
              </button>
            </form>

            <button type="button" className={styles.linkButton} onClick={() => switchMode('portal')}>
              Volver a iniciar sesión con correo y contraseña
            </button>
          </>
        )}
      </section>
    </main>
  )
}
