import React, { useEffect, useState } from 'react'
import { CheckCircle2, Globe2, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Loading } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { sitesService, type SitesDomainConfig } from '@/services/sitesService'
import styles from './Domains.module.css'

const emptyDomainConfig: SitesDomainConfig = {
  domain: '',
  renderDomainVerified: false,
  renderDomainCheckedAt: null,
  renderDomainError: null,
  appDomain: '',
  appDomainVerified: false,
  appDomainCheckedAt: null,
  appDomainError: null
}

const getDomainStatus = (domain: string, verified: boolean) => {
  if (!domain) return { label: 'Sin dominio', className: styles.statusMuted }
  if (verified) return { label: 'Verificado', className: styles.statusSuccess }
  return { label: 'Pendiente', className: styles.statusWarning }
}

export const Domains: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [domainConfig, setDomainConfig] = useState<SitesDomainConfig>(emptyDomainConfig)
  const [domain, setDomain] = useState('')
  const [appDomain, setAppDomain] = useState('')
  const [savedDomain, setSavedDomain] = useState('')
  const [savedAppDomain, setSavedAppDomain] = useState('')
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [verifyingApp, setVerifyingApp] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removingApp, setRemovingApp] = useState(false)

  useEffect(() => {
    loadDomain()
  }, [])

  const loadDomain = async () => {
    setLoading(true)
    try {
      const config = await sitesService.getDomain()
      setDomainConfig(config)
      setDomain(config.domain)
      setAppDomain(config.appDomain)
      setSavedDomain(config.domain)
      setSavedAppDomain(config.appDomain)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo cargar el dominio')
    } finally {
      setLoading(false)
    }
  }

  const handleDomainChange = (value: string) => {
    setDomain(value)
    setDomainConfig(current => ({
      ...current,
      domain: value,
      renderDomainVerified: false,
      renderDomainError: null
    }))
  }

  const handleAppDomainChange = (value: string) => {
    setAppDomain(value)
    setDomainConfig(current => ({
      ...current,
      appDomain: value,
      appDomainVerified: false,
      appDomainError: null
    }))
  }

  const verifyDomain = async () => {
    setVerifying(true)
    try {
      const result = await sitesService.verifyDomain(domain)
      setDomainConfig(result)
      setDomain(result.domain)
      setAppDomain(result.appDomain)
      if (result.verification?.verified) {
        setSavedDomain(result.domain)
        showToast('success', 'Dominio verificado y guardado', 'El dominio ya responde con esta app.')
      } else {
        showToast('warning', 'Dominio pendiente', result.verification?.error || result.renderDomainError || 'El dominio todavía no responde con esta app')
      }
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo verificar el dominio')
    } finally {
      setVerifying(false)
    }
  }

  const verifyAppDomain = async () => {
    setVerifyingApp(true)
    try {
      const result = await sitesService.verifyAppDomain(appDomain)
      setDomainConfig(result)
      setDomain(result.domain)
      setAppDomain(result.appDomain)
      if (result.appVerification?.verified) {
        setSavedAppDomain(result.appDomain)
        showToast('success', 'Dominio de app verificado', 'Ese dominio ya abre el CRM.')
      } else {
        showToast('warning', 'Dominio de app pendiente', result.appVerification?.error || result.appDomainError || 'El dominio de app todavía no responde con esta app')
      }
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo verificar el dominio de app')
    } finally {
      setVerifyingApp(false)
    }
  }

  const confirmRemoveDomain = () => {
    showConfirm(
      'Eliminar dominio',
      `Se quitará ${savedDomain} de tu cuenta y tus páginas dejarán de abrirse con ese dominio. Puedes volver a conectarlo cuando quieras.`,
      async () => {
        setRemoving(true)
        try {
          const config = await sitesService.removeDomain()
          setDomainConfig(config)
          setDomain('')
          setAppDomain(config.appDomain)
          setSavedDomain('')
          setSavedAppDomain(config.appDomain)
          showToast('success', 'Dominio eliminado', 'Tu cuenta ya no usa ese dominio')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo eliminar el dominio')
        } finally {
          setRemoving(false)
        }
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const confirmRemoveAppDomain = () => {
    showConfirm(
      'Eliminar dominio de app',
      `Se quitará ${savedAppDomain} del CRM. Puedes volver a conectarlo cuando quieras.`,
      async () => {
        setRemovingApp(true)
        try {
          const config = await sitesService.removeAppDomain()
          setDomainConfig(config)
          setDomain(config.domain)
          setAppDomain('')
          setSavedDomain(config.domain)
          setSavedAppDomain('')
          showToast('success', 'Dominio de app eliminado', 'El CRM ya no usa ese dominio')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo eliminar el dominio de app')
        } finally {
          setRemovingApp(false)
        }
      },
      'Eliminar',
      'Cancelar'
    )
  }

  if (loading) {
    return <Loading page="settings" />
  }

  const publicStatus = getDomainStatus(domainConfig.domain, domainConfig.renderDomainVerified)
  const appStatus = getDomainStatus(domainConfig.appDomain, domainConfig.appDomainVerified)

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <Globe2 size={20} />
        </div>
        <div>
          <h2>Dominios</h2>
          <p>
            Configura dos categorías distintas: una para páginas públicas y otra para entrar al CRM.
            Así tus clientes ven tus formularios en un dominio público y tu equipo entra a la app desde un dominio tipo app.
          </p>
        </div>
        <Button variant="secondary" onClick={loadDomain}>
          <RefreshCw size={16} />
          Refrescar
        </Button>
      </div>

      <div className={styles.domainList}>
        <article className={styles.domainCard}>
          <div className={styles.domainMeta}>
            <div>
              <span className={styles.categoryLabel}>Categoría 1 · Sitios públicos</span>
              <h3>Dominio para páginas, formularios y campañas</h3>
              <p>
                Es la dirección que ven tus clientes cuando abren una landing, un formulario,
                una página de campaña o un link público creado en Ristak.
              </p>
            </div>
            <span className={`${styles.statusPill} ${publicStatus.className}`}>{publicStatus.label}</span>
          </div>

          <div className={styles.copyExamples}>
            <strong>Ejemplos para no confundirse</strong>
            <p><span>www.clinicaramirez.com</span> abre tus páginas públicas.</p>
            <p><span>agenda.clinicaramirez.com</span> puede usarse para campañas o formularios.</p>
            <p><span>app.clinicaramirez.com</span> no va aquí; ese va en la categoría de app.</p>
          </div>

          <div className={styles.domainControls}>
            <label className={styles.field}>
              <span>Dominio público del negocio</span>
              <input
                value={domain}
                placeholder="www.tuclinica.com"
                onChange={(event) => handleDomainChange(event.target.value)}
              />
            </label>
            <Button onClick={verifyDomain} loading={verifying} disabled={!domain.trim()}>
              <CheckCircle2 size={16} />
              Verificar público
            </Button>
          </div>

          {domainConfig.renderDomainError && (
            <p className={styles.errorText}>{domainConfig.renderDomainError}</p>
          )}

          {savedDomain && (
            <div className={styles.actions}>
              <Button variant="danger" onClick={confirmRemoveDomain} loading={removing}>
                <Trash2 size={16} />
                Eliminar dominio
              </Button>
            </div>
          )}
        </article>

        <article className={styles.domainCard}>
          <div className={styles.domainMeta}>
            <div>
              <span className={styles.categoryLabel}>Categoría 2 · App / CRM</span>
              <h3>Dominio para entrar a Ristak</h3>
              <p>
                Es la dirección privada de la app. Aquí entra tu equipo al CRM y aquí deben regresar
                conexiones como Google o Meta después de autorizar.
              </p>
            </div>
            <span className={`${styles.statusPill} ${appStatus.className}`}>{appStatus.label}</span>
          </div>

          <div className={styles.copyExamples}>
            <strong>Ejemplos para no confundirse</strong>
            <p><span>app.clinicaramirez.com</span> abre el CRM y recibe regresos de Google o Meta.</p>
            <p><span>app.ristak.com</span> es un ejemplo válido porque empieza con app.</p>
            <p><span>crm.clinicaramirez.com</span> no va aquí; el subdominio debe empezar con app.</p>
          </div>

          <div className={styles.domainControls}>
            <label className={styles.field}>
              <span>Dominio privado de la app</span>
              <input
                value={appDomain}
                placeholder="app.tuclinica.com"
                onChange={(event) => handleAppDomainChange(event.target.value)}
              />
            </label>
            <Button onClick={verifyAppDomain} loading={verifyingApp} disabled={!appDomain.trim()}>
              <CheckCircle2 size={16} />
              Verificar app
            </Button>
          </div>

          {domainConfig.appDomainError && (
            <p className={styles.errorText}>{domainConfig.appDomainError}</p>
          )}

          {savedAppDomain && (
            <div className={styles.actions}>
              <Button variant="danger" onClick={confirmRemoveAppDomain} loading={removingApp}>
                <Trash2 size={16} />
                Eliminar dominio
              </Button>
            </div>
          )}
        </article>
      </div>
    </div>
  )
}
