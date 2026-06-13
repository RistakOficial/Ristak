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
  renderDomainError: null
}

const getDomainStatus = (config: SitesDomainConfig) => {
  if (!config.domain) return { label: 'Sin dominio', className: styles.statusMuted }
  if (config.renderDomainVerified) return { label: 'Verificado', className: styles.statusSuccess }
  return { label: 'Pendiente', className: styles.statusWarning }
}

export const Domains: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [domainConfig, setDomainConfig] = useState<SitesDomainConfig>(emptyDomainConfig)
  const [domain, setDomain] = useState('')
  const [savedDomain, setSavedDomain] = useState('')
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    loadDomain()
  }, [])

  const loadDomain = async () => {
    setLoading(true)
    try {
      const config = await sitesService.getDomain()
      setDomainConfig(config)
      setDomain(config.domain)
      setSavedDomain(config.domain)
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

  const verifyDomain = async () => {
    setVerifying(true)
    try {
      const result = await sitesService.verifyDomain(domain)
      setDomainConfig(result)
      setDomain(result.domain)
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
          setSavedDomain('')
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

  if (loading) {
    return <Loading page="settings" />
  }

  const status = getDomainStatus(domainConfig)

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <Globe2 size={20} />
        </div>
        <div>
          <h2>Dominios</h2>
          <p>
            Dominio público general para formularios, sitios y landing pages: las páginas creadas
            se abren con este dominio y su ruta, por ejemplo /form-01 o /site-01.
          </p>
        </div>
        <Button variant="secondary" onClick={loadDomain}>
          <RefreshCw size={16} />
          Refrescar
        </Button>
      </div>

      <article className={styles.domainCard}>
        <div className={styles.domainMeta}>
          <div>
            <h3>Dominio público</h3>
            <p>Se guarda cuando el dominio responde al health público de esta app.</p>
          </div>
          <span className={`${styles.statusPill} ${status.className}`}>{status.label}</span>
        </div>

        <div className={styles.domainControls}>
          <label className={styles.field}>
            <span>Dominio</span>
            <input
              value={domain}
              placeholder="www.doctorramirez.com"
              onChange={(event) => handleDomainChange(event.target.value)}
            />
          </label>
          <Button onClick={verifyDomain} loading={verifying} disabled={!domain.trim()}>
            <CheckCircle2 size={16} />
            Verificar dominio
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
    </div>
  )
}
