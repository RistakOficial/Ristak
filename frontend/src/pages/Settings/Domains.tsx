import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, CheckCircle2, FormInput, Globe2, LayoutTemplate, Monitor, RefreshCw, Star, Trash2 } from 'lucide-react'
import { Badge, Button, Card, CustomSelect, Loading } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { sitesService, type PublicSite, type SitesDomainConfig, type SiteStatus } from '@/services/sitesService'
import styles from './Domains.module.css'

type DomainPanelId = 'public' | 'app'

const emptyDomainConfig: SitesDomainConfig = {
  domain: '',
  renderDomainVerified: false,
  renderDomainCheckedAt: null,
  renderDomainError: null,
  appDomain: '',
  appDomainVerified: false,
  appDomainCheckedAt: null,
  appDomainError: null,
  defaultRoute: null
}

const statusLabelById: Record<SiteStatus, string> = {
  draft: 'Borrador',
  published: 'Publicado',
  archived: 'Archivado'
}

const getDomainStatus = (domain: string, verified: boolean) => {
  if (!domain) return { label: 'Sin dominio', variant: 'neutral' as const }
  if (verified) return { label: 'Verificado', variant: 'success' as const }
  return { label: 'Pendiente', variant: 'warning' as const }
}

const getSiteTypeLabel = (site: PublicSite) => {
  if (site.siteType === 'landing_page') return 'Página'
  if (site.siteType === 'interactive_form') return 'Formulario interactivo'
  return 'Formulario'
}

const getRoutePath = (site: PublicSite) => `/${String(site.slug || '').replace(/^\/+/, '')}`

const getDefaultRouteLabel = (config: SitesDomainConfig) => {
  if (!config.defaultRoute) return 'Sin ruta principal elegida'
  return `${config.defaultRoute.name} · ${config.defaultRoute.path || '/'}`
}

const sortSitesForDomainSelect = (sites: PublicSite[]) => [...sites].sort((a, b) => (
  (a.siteType === b.siteType ? 0 : a.siteType === 'landing_page' ? -1 : 1) ||
  a.name.localeCompare(b.name)
))

export const Domains: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [domainConfig, setDomainConfig] = useState<SitesDomainConfig>(emptyDomainConfig)
  const [sites, setSites] = useState<PublicSite[]>([])
  const [domain, setDomain] = useState('')
  const [appDomain, setAppDomain] = useState('')
  const [savedDomain, setSavedDomain] = useState('')
  const [savedAppDomain, setSavedAppDomain] = useState('')
  const [activePanel, setActivePanel] = useState<DomainPanelId | null>(null)
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [verifyingApp, setVerifyingApp] = useState(false)
  const [savingDefaultRoute, setSavingDefaultRoute] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removingApp, setRemovingApp] = useState(false)

  const sortedSites = useMemo(() => sortSitesForDomainSelect(sites), [sites])
  const landingPages = useMemo(() => sortedSites.filter(site => site.siteType === 'landing_page'), [sortedSites])
  const forms = useMemo(() => sortedSites.filter(site => site.siteType !== 'landing_page'), [sortedSites])
  const publicStatus = getDomainStatus(domainConfig.domain, domainConfig.renderDomainVerified)
  const appStatus = getDomainStatus(domainConfig.appDomain, domainConfig.appDomainVerified)

  useEffect(() => {
    void loadDomain()
  }, [])

  const applyConfig = (config: SitesDomainConfig) => {
    setDomainConfig(config)
    setDomain(config.domain)
    setAppDomain(config.appDomain)
    setSavedDomain(config.domain)
    setSavedAppDomain(config.appDomain)
  }

  const loadDomain = async () => {
    setLoading(true)
    try {
      const [configResult, sitesResult] = await Promise.allSettled([
        sitesService.getDomain(),
        sitesService.listSites()
      ])

      if (configResult.status === 'rejected') {
        throw configResult.reason
      }

      applyConfig(configResult.value)
      if (sitesResult.status === 'fulfilled') {
        setSites(sitesResult.value)
      } else {
        setSites([])
        showToast('warning', 'Lista no disponible', 'No se pudieron cargar páginas y formularios para elegir la ruta principal.')
      }
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
      applyConfig(result)
      if (result.verification?.verified) {
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
      applyConfig(result)
      if (result.appVerification?.verified) {
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

  const updateDefaultRoute = async (siteId: string) => {
    setSavingDefaultRoute(true)
    try {
      const result = await sitesService.setDefaultDomainRoute(siteId)
      applyConfig(result)
      showToast(
        'success',
        siteId ? 'Ruta predeterminada actualizada' : 'Ruta predeterminada limpiada',
        siteId ? 'El dominio principal ya sabe qué página abrir primero.' : 'El dominio volverá a elegir automáticamente una página publicada.'
      )
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar la ruta predeterminada')
    } finally {
      setSavingDefaultRoute(false)
    }
  }

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, panel: DomainPanelId) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setActivePanel(panel)
  }

  const confirmRemoveDomain = () => {
    showConfirm(
      'Eliminar dominio',
      `Se quitará ${savedDomain} de tu cuenta y tus páginas dejarán de abrirse con ese dominio. Puedes volver a conectarlo cuando quieras.`,
      async () => {
        setRemoving(true)
        try {
          const config = await sitesService.removeDomain()
          applyConfig(config)
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
          applyConfig(config)
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
    return <Loading page="settings-list" />
  }

  const renderPanelHeader = (status: { label: string; variant: 'success' | 'warning' | 'neutral' }) => (
    <div className={styles.detailBar}>
      <Button type="button" variant="secondary" size="sm" onClick={() => setActivePanel(null)}>
        <ArrowLeft size={16} />
        Dominios
      </Button>
      <Badge variant={status.variant}>{status.label}</Badge>
    </div>
  )

  const renderDefaultRouteSelect = () => (
    <label className={styles.field}>
      <span>Ruta principal del dominio</span>
      <CustomSelect
        value={domainConfig.defaultRoute?.siteId || ''}
        disabled={savingDefaultRoute || sortedSites.length === 0}
        onChange={(event) => { void updateDefaultRoute(event.target.value) }}
      >
        <option value="">Elegir automáticamente</option>
        {landingPages.length > 0 && (
          <optgroup label="Páginas">
            {landingPages.map(site => (
              <option key={site.id} value={site.id}>
                {site.name} · {getSiteTypeLabel(site)} · {getRoutePath(site)} · {statusLabelById[site.status]}
              </option>
            ))}
          </optgroup>
        )}
        {forms.length > 0 && (
          <optgroup label="Formularios">
            {forms.map(site => (
              <option key={site.id} value={site.id}>
                {site.name} · {getSiteTypeLabel(site)} · {getRoutePath(site)} · {statusLabelById[site.status]}
              </option>
            ))}
          </optgroup>
        )}
      </CustomSelect>
      <small>Esta es la página o formulario que abrirá cuando alguien entre directo al dominio, sin escribir ruta.</small>
    </label>
  )

  const renderPublicPanel = () => (
    <div className={styles.container}>
      {renderPanelHeader(publicStatus)}
      <Card className={styles.detailCard}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionIcon}>
            <Globe2 size={19} />
          </div>
          <div>
            <h2>Dominio para páginas y formularios</h2>
            <p>Conecta el dominio visible para clientes y define qué se abre en la raíz.</p>
          </div>
        </div>

        <div className={styles.fieldGrid}>
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

        <div className={styles.routePanel}>
          <div>
            <span className={styles.routeEyebrow}>
              <Star size={14} fill="currentColor" />
              Página predeterminada
            </span>
            <strong>{getDefaultRouteLabel(domainConfig)}</strong>
            <p>{domainConfig.domain || 'tu dominio'} abrirá esta ruta cuando alguien entre directo.</p>
          </div>
          {renderDefaultRouteSelect()}
        </div>

        {savedDomain && (
          <div className={styles.actions}>
            <Button variant="danger" onClick={confirmRemoveDomain} loading={removing}>
              <Trash2 size={16} />
              Eliminar dominio
            </Button>
          </div>
        )}
      </Card>
    </div>
  )

  const renderAppPanel = () => (
    <div className={styles.container}>
      {renderPanelHeader(appStatus)}
      <Card className={styles.detailCard}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionIcon}>
            <Monitor size={19} />
          </div>
          <div>
            <h2>Dominio para entrar a Ristak</h2>
            <p>Usa un subdominio privado para el dashboard, conexiones OAuth y regreso de integraciones.</p>
          </div>
        </div>

        <div className={styles.exampleStrip}>
          <span>app.clinicaramirez.com</span>
          <span>app.ristak.com</span>
          <span>app.tuclinica.com</span>
        </div>

        <div className={styles.fieldGrid}>
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
      </Card>
    </div>
  )

  if (activePanel === 'public') return renderPublicPanel()
  if (activePanel === 'app') return renderAppPanel()

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <Globe2 size={20} />
        </div>
        <div>
          <h2>Dominios</h2>
          <p>Separa el dominio que ven tus clientes del dominio privado para entrar al dashboard.</p>
        </div>
        <Button variant="secondary" onClick={loadDomain}>
          <RefreshCw size={16} />
          Refrescar
        </Button>
      </div>

      <div className={styles.domainGrid}>
        <Card
          className={styles.domainChoice}
          role="button"
          tabIndex={0}
          onClick={() => setActivePanel('public')}
          onKeyDown={(event) => handlePanelKeyDown(event, 'public')}
        >
          <div className={styles.choiceIcon}>
            <Globe2 size={20} />
          </div>
          <div className={styles.choiceCopy}>
            <div className={styles.choiceTitleRow}>
              <strong>Dominio público</strong>
              <Badge variant={publicStatus.variant}>{publicStatus.label}</Badge>
            </div>
            <p>Sitios web, formularios, campañas y links que comparten tus clientes.</p>
            <span>
              <LayoutTemplate size={14} />
              {domainConfig.domain || 'www.tunegocio.com'}
            </span>
            <span>
              <Star size={14} fill="currentColor" />
              {getDefaultRouteLabel(domainConfig)}
            </span>
          </div>
          <ArrowRight size={18} className={styles.choiceArrow} />
        </Card>

        <Card
          className={styles.domainChoice}
          role="button"
          tabIndex={0}
          onClick={() => setActivePanel('app')}
          onKeyDown={(event) => handlePanelKeyDown(event, 'app')}
        >
          <div className={styles.choiceIcon}>
            <Monitor size={20} />
          </div>
          <div className={styles.choiceCopy}>
            <div className={styles.choiceTitleRow}>
              <strong>Dominio de app</strong>
              <Badge variant={appStatus.variant}>{appStatus.label}</Badge>
            </div>
            <p>Dashboard interno de Ristak y regreso seguro de integraciones conectadas.</p>
            <span>
              <Monitor size={14} />
              {domainConfig.appDomain || 'app.tunegocio.com'}
            </span>
            <span>
              <FormInput size={14} />
              Controla la aplicación del dashboard
            </span>
          </div>
          <ArrowRight size={18} className={styles.choiceArrow} />
        </Card>
      </div>
    </div>
  )
}
