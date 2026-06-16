import React from 'react'
import { ArrowRight, Building2, Loader2, RefreshCw } from 'lucide-react'
import { Logo } from '@/components/common'
import { clearRuntimeApiBaseUrl, getRuntimeTenant } from '@/services/apiBaseUrl'
import { resolveAndStoreMobileTenant } from '@/services/mobileTenantService'
import styles from './MobileTenantSetup.module.css'

export const MobileTenantSetup: React.FC = () => {
  const [identifier, setIdentifier] = React.useState('')
  const [error, setError] = React.useState('')
  const [isResolving, setIsResolving] = React.useState(false)
  const [tenant, setTenant] = React.useState(getRuntimeTenant)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setIsResolving(true)

    try {
      await resolveAndStoreMobileTenant(identifier)
      window.location.replace('/phone/login')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo abrir tu app.')
      setIsResolving(false)
    }
  }

  const handleChangeTenant = () => {
    clearRuntimeApiBaseUrl()
    setTenant(null)
    setIdentifier('')
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
        ) : (
          <>
            <div className={styles.copy}>
              <p className={styles.eyebrow}>Conectar empresa</p>
              <h1 id="mobile-tenant-title" className={styles.title}>Abre tu Ristak</h1>
              <p className={styles.subtitle}>Usa el correo de tu cuenta, el nombre de tu empresa o tu código de invitación.</p>
            </div>

            <form className={styles.form} onSubmit={handleSubmit}>
              <label className={styles.label} htmlFor="mobile-tenant-identifier">
                Empresa o correo
              </label>
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
                disabled={isResolving}
              />
              {error && <p className={styles.error}>{error}</p>}
              <button type="submit" className={styles.primaryButton} disabled={isResolving}>
                {isResolving ? <Loader2 className={styles.spinner} size={18} /> : <ArrowRight size={18} />}
                <span>{isResolving ? 'Buscando' : 'Continuar'}</span>
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  )
}
