import React, { useEffect, useState } from 'react'
import { CheckCircle2, Globe2, RefreshCw } from 'lucide-react'
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
  const { showToast } = useNotification()
  const [domainConfig, setDomainConfig] = useState<SitesDomainConfig>(emptyDomainConfig)
  const [domain, setDomain] = useState('')
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)

  useEffect(() => {
    loadDomain()
  }, [])

  const loadDomain = async () => {
    setLoading(true)
    try {
      const config = await sitesService.getDomain()
      setDomainConfig(config)
      setDomain(config.domain)
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
        showToast('success', 'Dominio verificado y guardado', 'El dominio ya responde con esta app.')
      } else {
        showToast('warning', 'Dominio pendiente', result.verification?.error || result.renderDomainError || 'El dominio todavia no responde con esta app')
      }
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo verificar el dominio')
    } finally {
      setVerifying(false)
    }
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
            <h3>Dominio publico</h3>
            <p>Se guarda cuando el dominio responde al health publico de esta app.</p>
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
      </article>
    </div>
  )
}
