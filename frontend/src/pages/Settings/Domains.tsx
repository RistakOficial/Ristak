import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, CheckCircle2, FormInput, Globe2, LayoutTemplate, Monitor, Pencil, Plus, RefreshCw, Star, Trash2 } from 'lucide-react'
import { Badge, Button, Card, CustomSelect, Loading, Modal } from '@/components/common'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { sitesService, type PublicSite, type PublicSiteDomain, type SitesDomainConfig, type SiteStatus } from '@/services/sitesService'
import { DEFAULT_CRM_LABELS, formatCrmLabelLower } from '@/utils/crmLabels'
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
  defaultRoute: null,
  publicDomains: []
}

const statusLabelById: Record<SiteStatus, string> = {
  draft: 'Borrador',
  published: 'Publicado',
  archived: 'Archivado'
}

const ROUTE_VALUE_SEPARATOR = '::'

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

const getDefaultRouteLabel = (route: SitesDomainConfig['defaultRoute']) => {
  if (!route) return 'Elegir automáticamente'
  return `${route.name} · ${route.pageTitle || route.path || '/'}`
}

const sortSitesForDomainSelect = (sites: PublicSite[]) => [...sites].sort((a, b) => (
  (a.siteType === b.siteType ? 0 : a.siteType === 'landing_page' ? -1 : 1) ||
  a.name.localeCompare(b.name)
))

const getLandingPages = (site: PublicSite) => (
  Array.isArray(site.theme?.pages)
    ? [...site.theme.pages].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    : []
)

const encodeDomainRouteValue = (siteId?: string | null, pageId?: string | null) => (
  siteId ? `${siteId}${pageId ? `${ROUTE_VALUE_SEPARATOR}${pageId}` : ''}` : ''
)

const decodeDomainRouteValue = (value: string) => {
  const [siteId = '', pageId = ''] = value.split(ROUTE_VALUE_SEPARATOR)
  return { siteId, pageId }
}

export const Domains: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const { labels } = useLabels()
  const customersLowerLabel = formatCrmLabelLower(labels.customers, DEFAULT_CRM_LABELS.customers)
  const [domainConfig, setDomainConfig] = useState<SitesDomainConfig>(emptyDomainConfig)
  const [sites, setSites] = useState<PublicSite[]>([])
  const [domainDraft, setDomainDraft] = useState('')
  const [routeDraft, setRouteDraft] = useState('')
  const [appDomain, setAppDomain] = useState('')
  const [savedAppDomain, setSavedAppDomain] = useState('')
  const [activePanel, setActivePanel] = useState<DomainPanelId | null>(null)
  const [editingDomain, setEditingDomain] = useState<PublicSiteDomain | null>(null)
  const [domainDialogOpen, setDomainDialogOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [savingDomain, setSavingDomain] = useState(false)
  const [verifyingDomainId, setVerifyingDomainId] = useState('')
  const [verifyingApp, setVerifyingApp] = useState(false)
  const [removingDomainId, setRemovingDomainId] = useState('')
  const [removingApp, setRemovingApp] = useState(false)

  const sortedSites = useMemo(() => sortSitesForDomainSelect(sites), [sites])
  const landingSites = useMemo(() => sortedSites.filter(site => site.siteType === 'landing_page'), [sortedSites])
  const formSites = useMemo(() => sortedSites.filter(site => site.siteType !== 'landing_page'), [sortedSites])
  const publicDomains = domainConfig.publicDomains || []
  const verifiedPublicDomains = publicDomains.filter(domain => domain.renderDomainVerified)
  const publicStatus = publicDomains.length > 0
    ? { label: `${verifiedPublicDomains.length}/${publicDomains.length} verificados`, variant: verifiedPublicDomains.length > 0 ? 'success' as const : 'warning' as const }
    : getDomainStatus('', false)
  const appStatus = getDomainStatus(domainConfig.appDomain, domainConfig.appDomainVerified)

  useEffect(() => {
    void loadDomain()
  }, [])

  const applyConfig = (config: SitesDomainConfig) => {
    setDomainConfig({
      ...config,
      publicDomains: config.publicDomains || []
    })
    setAppDomain(config.appDomain)
    setSavedAppDomain(config.appDomain)
  }

  const loadDomain = async () => {
    setLoading(true)
    try {
      const [configResult, sitesResult] = await Promise.allSettled([
        sitesService.getDomain(),
        sitesService.listAllSiteSelectors({ kind: 'domain' })
      ])

      if (configResult.status === 'rejected') {
        throw configResult.reason
      }

      applyConfig(configResult.value)
      if (sitesResult.status === 'fulfilled') {
        setSites(sitesResult.value.items)
        if (sitesResult.value.truncated) {
          showToast('warning', 'Demasiados sitios', 'Se muestran los 2,000 sitios más recientes. Usa el módulo de Sitios para administrar el resto.')
        }
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

  const openAddDomainDialog = () => {
    setEditingDomain(null)
    setDomainDraft('')
    setRouteDraft('')
    setDomainDialogOpen(true)
  }

  const openEditDomainDialog = (domain: PublicSiteDomain) => {
    setEditingDomain(domain)
    setDomainDraft(domain.domain)
    setRouteDraft(encodeDomainRouteValue(domain.defaultRoute?.siteId, domain.defaultRoute?.pageId))
    setDomainDialogOpen(true)
  }

  const closeDomainDialog = () => {
    if (savingDomain) return
    setDomainDialogOpen(false)
    setEditingDomain(null)
    setDomainDraft('')
    setRouteDraft('')
  }

  const saveDomainDialog = async () => {
    const route = decodeDomainRouteValue(routeDraft)
    setSavingDomain(true)
    try {
      const result = editingDomain
        ? await sitesService.setPublicDomainDefaultRoute(editingDomain.id, route.siteId, route.pageId)
        : await sitesService.createPublicDomain({ domain: domainDraft, siteId: route.siteId, pageId: route.pageId })

      applyConfig(result)
      if (editingDomain || result.verification?.verified) {
        showToast(
          'success',
          editingDomain ? 'Dominio actualizado' : 'Dominio conectado',
          editingDomain ? 'La ruta principal quedó guardada.' : 'El dominio ya responde con esta app.'
        )
        setDomainDialogOpen(false)
        setEditingDomain(null)
        setDomainDraft('')
        setRouteDraft('')
        return
      }

      showToast('warning', 'Dominio pendiente', result.verification?.error || result.renderDomainError || 'El dominio todavía no responde con esta app.')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo guardar el dominio')
    } finally {
      setSavingDomain(false)
    }
  }

  const verifyPublicDomain = async (domain: PublicSiteDomain) => {
    setVerifyingDomainId(domain.id)
    try {
      const result = await sitesService.verifyPublicDomain(domain.id)
      applyConfig(result)
      if (result.verification?.verified) {
        showToast('success', 'Dominio verificado', `${domain.domain} ya responde con esta app.`)
      } else {
        showToast('warning', 'Dominio pendiente', result.verification?.error || 'El dominio todavía no responde con esta app.')
      }
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo verificar el dominio')
    } finally {
      setVerifyingDomainId('')
    }
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

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, panel: DomainPanelId) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setActivePanel(panel)
  }

  const confirmRemovePublicDomain = (domain: PublicSiteDomain) => {
    showConfirm(
      'Eliminar dominio',
      `Se quitará ${domain.domain} de tu cuenta y tus páginas dejarán de abrirse con ese dominio. Esta acción no se puede deshacer.`,
      async () => {
        setRemovingDomainId(domain.id)
        try {
          const config = await sitesService.removePublicDomain(domain.id)
          applyConfig(config)
          showToast('success', 'Dominio eliminado', 'Tus páginas ya no usan ese dominio.')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo eliminar el dominio')
        } finally {
          setRemovingDomainId('')
        }
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const confirmRemoveAppDomain = () => {
    showConfirm(
      'Eliminar dominio de app',
      `Se quitará ${savedAppDomain} del CRM y el dashboard dejará de abrirse con ese dominio. Esta acción no se puede deshacer.`,
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
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
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

  const renderDomainRouteOptions = () => (
    <>
      <option value="">Elegir automáticamente</option>
      {landingSites.length > 0 && (
        <optgroup label="Páginas">
          {landingSites.map(site => (
            <React.Fragment key={site.id}>
              <option value={encodeDomainRouteValue(site.id)}>
                {site.name} · {getSiteTypeLabel(site)} · {getRoutePath(site)} · {statusLabelById[site.status]}
              </option>
              {getLandingPages(site).map(page => (
                <option key={`${site.id}:${page.id}`} value={encodeDomainRouteValue(site.id, page.id)}>
                  {site.name} · {page.title || 'Página sin nombre'} · /{page.slug || page.id} · {statusLabelById[site.status]}
                </option>
              ))}
            </React.Fragment>
          ))}
        </optgroup>
      )}
      {formSites.length > 0 && (
        <optgroup label="Formularios">
          {formSites.map(site => (
            <option key={site.id} value={encodeDomainRouteValue(site.id)}>
              {site.name} · {getSiteTypeLabel(site)} · {getRoutePath(site)} · {statusLabelById[site.status]}
            </option>
          ))}
        </optgroup>
      )}
    </>
  )

  const renderDomainDialog = () => (
    <Modal
      isOpen={domainDialogOpen}
      onClose={closeDomainDialog}
      title={editingDomain ? 'Configurar dominio' : 'Agregar dominio'}
      subtitle={editingDomain ? editingDomain.domain : 'Valida que Render ya lo esté apuntando a esta app.'}
      size="lg"
      closeOnBackdropClick={!savingDomain}
      closeOnEscape={!savingDomain}
    >
      <div className={styles.dialogBody}>
        <label className={styles.field}>
          <span>Dominio público</span>
          <input
            value={domainDraft}
            placeholder="www.tuclinica.com"
            disabled={Boolean(editingDomain) || savingDomain}
            onChange={(event) => setDomainDraft(event.target.value)}
          />
          <small>Primero agrega este dominio como Custom Domain del web service en Render; Ristak lo guarda sólo cuando detecta esta instalación.</small>
        </label>

        <label className={styles.field}>
          <span>Root del dominio</span>
          <CustomSelect
            value={routeDraft}
            disabled={savingDomain || sortedSites.length === 0}
            size="large"
            dropdownMinHeight={300}
            onChange={(event) => setRouteDraft(event.target.value)}
          >
            {sortedSites.length > 0 ? renderDomainRouteOptions() : <option value="">No hay páginas ni formularios</option>}
          </CustomSelect>
          <small>Si eliges una página, esa página abre directo en la raíz del dominio. Si lo dejas automático, Ristak usa una página publicada.</small>
        </label>
      </div>

      <div className={styles.dialogFooter}>
        <Button type="button" variant="secondary" onClick={closeDomainDialog} disabled={savingDomain}>
          Cancelar
        </Button>
        <Button type="button" onClick={saveDomainDialog} loading={savingDomain} disabled={!editingDomain && !domainDraft.trim()}>
          <CheckCircle2 size={16} />
          {editingDomain ? 'Guardar cambios' : 'Validar y guardar'}
        </Button>
      </div>
    </Modal>
  )

  const renderPublicPanel = () => (
    <div className={styles.container}>
      {renderPanelHeader(publicStatus)}

      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <Globe2 size={20} />
        </div>
        <div>
          <h2>Dominios para páginas y formularios</h2>
          <p>Agrega dominios públicos verificados y define qué abre cada uno en la raíz.</p>
        </div>
        <Button onClick={openAddDomainDialog}>
          <Plus size={16} />
          Agregar dominio
        </Button>
      </div>

      {publicDomains.length === 0 ? (
        <Card className={styles.emptyState}>
          <div className={styles.choiceIcon}>
            <Globe2 size={20} />
          </div>
          <div>
            <h3>No hay dominios conectados</h3>
            <p>Agrega un dominio que ya esté dado de alta en Render para publicar tus páginas con URL propia.</p>
          </div>
          <Button onClick={openAddDomainDialog}>
            <Plus size={16} />
            Agregar dominio
          </Button>
        </Card>
      ) : (
        <div className={styles.domainList}>
          {publicDomains.map(domain => {
            const status = getDomainStatus(domain.domain, domain.renderDomainVerified)
            return (
              <div className={styles.domainRow} key={domain.id}>
                <div className={styles.choiceIcon}>
                  <Globe2 size={20} />
                </div>
                <div className={styles.domainInfo}>
                  <div className={styles.choiceTitleRow}>
                    <strong>{domain.domain}</strong>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </div>
                  <span>
                    <Star size={14} fill="currentColor" />
                    {getDefaultRouteLabel(domain.defaultRoute)}
                  </span>
                  {domain.renderDomainError && <p className={styles.errorText}>{domain.renderDomainError}</p>}
                </div>
                <div className={styles.rowActions}>
                  <Button variant="secondary" size="sm" onClick={() => openEditDomainDialog(domain)}>
                    <Pencil size={15} />
                    Configurar
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void verifyPublicDomain(domain)} loading={verifyingDomainId === domain.id}>
                    <RefreshCw size={15} />
                    Revalidar
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => confirmRemovePublicDomain(domain)} loading={removingDomainId === domain.id}>
                    <Trash2 size={15} />
                    Eliminar
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {renderDomainDialog()}
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
          <p>Separa los dominios que ven tus {customersLowerLabel} del dominio privado para entrar al dashboard.</p>
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
              <strong>Dominios públicos</strong>
              <Badge variant={publicStatus.variant}>{publicStatus.label}</Badge>
            </div>
            <p>Sitios web, formularios, campañas y links que comparten tus {customersLowerLabel}.</p>
            <span>
              <LayoutTemplate size={14} />
              {publicDomains.length > 0 ? `${publicDomains.length} dominio${publicDomains.length === 1 ? '' : 's'} configurado${publicDomains.length === 1 ? '' : 's'}` : 'www.tunegocio.com'}
            </span>
            <span>
              <Star size={14} fill="currentColor" />
              Root independiente por dominio
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
