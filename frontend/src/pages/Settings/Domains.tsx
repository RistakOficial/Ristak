import React, { useEffect, useState } from 'react'
import { CheckCircle2, Globe2, Pencil } from 'lucide-react'
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

const normalizeDomainForComparison = (value: string) => {
  const rawValue = value.trim()
  if (!rawValue) return ''

  const withoutProtocol = rawValue.replace(/^https?:\/\//i, '')
  const withoutPath = withoutProtocol.split('/')[0]
  const withoutUser = withoutPath.split('@').pop() || withoutPath

  if (withoutUser.startsWith('[')) {
    return withoutUser.replace(/^\[|\].*$/g, '').toLowerCase()
  }

  return withoutUser.split(':')[0].replace(/\.$/, '').toLowerCase()
}

const getDomainStatus = (config: SitesDomainConfig, isChangingDomain: boolean) => {
  if (isChangingDomain) return { label: 'Cambio pendiente', className: styles.statusWarning }
  if (!config.domain) return { label: 'Sin dominio', className: styles.statusMuted }
  if (config.renderDomainVerified) return { label: 'Verificado', className: styles.statusSuccess }
  return { label: 'Pendiente', className: styles.statusWarning }
}

export const Domains: React.FC = () => {
  const { showToast } = useNotification()
  const [domainConfig, setDomainConfig] = useState<SitesDomainConfig>(emptyDomainConfig)
  const [domain, setDomain] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
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
      setDraftError(config.renderDomainError)
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo cargar el dominio')
    } finally {
      setLoading(false)
    }
  }

  const handleDomainChange = (value: string) => {
    setDomain(value)
    setDraftError(null)
  }

  const verifyDomain = async () => {
    setVerifying(true)
    try {
      const savedDomain = domainConfig.domain
      const requestedDomain = domain.trim()
      const requestedNormalizedDomain = normalizeDomainForComparison(requestedDomain)
      const isTryingDifferentSavedDomain = Boolean(savedDomain && requestedNormalizedDomain !== savedDomain)
      const result = await sitesService.verifyDomain(requestedDomain)

      if (!result.verification?.verified && isTryingDifferentSavedDomain) {
        setDraftError(result.verification?.error || result.renderDomainError || 'El dominio nuevo todavia no responde con esta app')
      } else {
        setDomainConfig(result)
        setDomain(result.domain)
        setDraftError(result.renderDomainError)
      }

      if (result.verification?.verified) {
        const changedDomain = Boolean(savedDomain && result.domain !== savedDomain)
        showToast(
          'success',
          changedDomain ? 'Dominio cambiado' : 'Dominio verificado y guardado',
          changedDomain ? 'El nuevo dominio ya quedo activo para tus formularios y landing pages.' : 'El dominio ya responde con esta app.'
        )
      } else {
        showToast(
          'warning',
          isTryingDifferentSavedDomain ? 'Cambio pendiente' : 'Dominio pendiente',
          result.verification?.error || result.renderDomainError || 'El dominio todavia no responde con esta app'
        )
      }
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo verificar el dominio')
    } finally {
      setVerifying(false)
    }
  }

  if (loading) {
    return <Loading variant="spinner" message="Cargando dominio..." />
  }

  const normalizedDraftDomain = normalizeDomainForComparison(domain)
  const hasSavedDomain = Boolean(domainConfig.domain)
  const isChangingDomain = Boolean(hasSavedDomain && normalizedDraftDomain && normalizedDraftDomain !== domainConfig.domain)
  const status = getDomainStatus(domainConfig, isChangingDomain)
  const actionLabel = isChangingDomain ? 'Cambiar dominio' : hasSavedDomain ? 'Verificar dominio' : 'Guardar dominio'
  const visibleError = isChangingDomain ? draftError : domainConfig.renderDomainError
  const domainHelpText = hasSavedDomain
    ? domainConfig.renderDomainVerified
      ? 'Este dominio esta activo. Si necesitas reemplazarlo, escribe el nuevo y guardalo.'
      : 'Este dominio esta guardado, pero aun falta que responda con esta app.'
    : 'Escribe el dominio que quieres usar para publicar formularios y landing pages.'

  return (
    <div className={styles.container}>
      <article className={styles.domainCard}>
        <div className={styles.header}>
          <div className={styles.headerIcon}>
            <Globe2 size={26} />
          </div>
          <div>
            <h2>Dominios</h2>
            <p>Configura o cambia el dominio publico general para formularios, sitios y landing pages.</p>
          </div>
        </div>

        <div className={styles.domainMeta}>
          <div>
            <h3>Dominio publico</h3>
            <p>{domainHelpText}</p>
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
            {isChangingDomain && (
              <span className={styles.helperText}>
                El dominio actual sigue siendo {domainConfig.domain} hasta que el nuevo quede verificado.
              </span>
            )}
          </label>
          <Button onClick={verifyDomain} loading={verifying} disabled={!domain.trim()}>
            {isChangingDomain ? <Pencil size={16} /> : <CheckCircle2 size={16} />}
            {actionLabel}
          </Button>
        </div>

        {visibleError && (
          <p className={styles.errorText}>{visibleError}</p>
        )}
      </article>
    </div>
  )
}
