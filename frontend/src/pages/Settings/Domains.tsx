import React, { useEffect, useMemo, useRef, useState } from 'react'
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

const normalizeDomainDraft = (value: string) => {
  const withoutProtocol = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '')
  return withoutProtocol.split('/')[0]?.split(':')[0]?.replace(/\.$/, '') || ''
}

const getDomainPair = (value: string) => {
  const domain = normalizeDomainDraft(value)
  const apexDomain = domain.startsWith('www.') ? domain.slice(4) : domain
  return {
    apexDomain,
    wwwDomain: apexDomain ? `www.${apexDomain}` : '',
    preferredDomain: domain
  }
}

const getDomainPairStatus = (domain: PublicSiteDomain) => {
  if (!domain.pairVerificationReady) {
    return domain.renderDomainVerified
      ? { label: 'Revisar www', variant: 'warning' as const }
      : { label: 'Pendiente', variant: 'warning' as const }
  }

  const connected = Number(Boolean(domain.apexDomainVerified)) + Number(Boolean(domain.wwwDomainVerified))
  return connected === 2
    ? { label: '2/2 conectados', variant: 'success' as const }
    : { label: `${connected}/2 conectados`, variant: 'warning' as const }
}

const getDomainHostStatus = (domain: PublicSiteDomain, host: string, verified: boolean | null) => {
  if (verified === true) return { label: 'Conectado', variant: 'success' as const }
  if (verified === false) return { label: 'Pendiente', variant: 'warning' as const }
  if (host === domain.domain && domain.renderDomainVerified) {
    return { label: 'Conectado', variant: 'success' as const }
  }
  return { label: 'Revalidar', variant: 'neutral' as const }
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
  const [canonicalDomainDraft, setCanonicalDomainDraft] = useState('')
  const [routeDraft, setRouteDraft] = useState('')
  const [appDomain, setAppDomain] = useState('')
  const [savedAppDomain, setSavedAppDomain] = useState('')
  const [activePanel, setActivePanel] = useState<DomainPanelId | null>(null)
  const [editingDomain, setEditingDomain] = useState<PublicSiteDomain | null>(null)
  const [domainDialogOpen, setDomainDialogOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingSites, setLoadingSites] = useState(false)
  const [sitesHasMore, setSitesHasMore] = useState(false)
  const [sitesNextCursor, setSitesNextCursor] = useState('')
  const sitesRequestRef = useRef<AbortController | null>(null)
  const sitesSearchTimerRef = useRef<number | null>(null)
  const sitesSelectOpenRef = useRef(false)
  const sitesSearchRef = useRef('')
  const [savingDomain, setSavingDomain] = useState(false)
  const [verifyingDomainId, setVerifyingDomainId] = useState('')
  const [verifyingApp, setVerifyingApp] = useState(false)
  const [removingDomainId, setRemovingDomainId] = useState('')
  const [removingApp, setRemovingApp] = useState(false)

  const sortedSites = useMemo(() => sortSitesForDomainSelect(sites), [sites])
  const landingSites = useMemo(() => sortedSites.filter(site => site.siteType === 'landing_page'), [sortedSites])
  const formSites = useMemo(() => sortedSites.filter(site => site.siteType !== 'landing_page'), [sortedSites])
  const publicDomains = domainConfig.publicDomains || []
  const verifiedPublicDomains = publicDomains.filter(domain => domain.domainPairVerified)
  const publicStatus = publicDomains.length > 0
    ? { label: `${verifiedPublicDomains.length}/${publicDomains.length} parejas listas`, variant: verifiedPublicDomains.length > 0 ? 'success' as const : 'warning' as const }
    : getDomainStatus('', false)
  const appStatus = getDomainStatus(domainConfig.appDomain, domainConfig.appDomainVerified)
  const domainDraftPair = getDomainPair(domainDraft)

  useEffect(() => {
    void loadDomain()
    return () => {
      sitesRequestRef.current?.abort()
      if (sitesSearchTimerRef.current !== null) window.clearTimeout(sitesSearchTimerRef.current)
    }
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
      applyConfig(await sitesService.getDomain())
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo cargar el dominio')
    } finally {
      setLoading(false)
    }
  }

  const mergeSites = (current: PublicSite[], incoming: PublicSite[]) => {
    const byId = new Map(current.map(site => [site.id, site]))
    incoming.forEach(site => byId.set(site.id, site))
    return [...byId.values()]
  }

  const loadDomainSites = async ({
    reset = false,
    search = '',
    selectedIds = []
  }: { reset?: boolean; search?: string; selectedIds?: string[] } = {}) => {
    if (reset) sitesSearchRef.current = search
    sitesRequestRef.current?.abort()
    const controller = new AbortController()
    sitesRequestRef.current = controller
    setLoadingSites(true)
    try {
      const page = await sitesService.listSiteSelectorsPage({
        kind: 'domain',
        limit: 30,
        cursor: reset ? '' : sitesNextCursor,
        search,
        selectedIds,
        signal: controller.signal
      })
      if (controller.signal.aborted) return
      const incoming = [...(page.selectedItems || []), ...page.items]
      setSites(current => mergeSites(reset ? current.filter(site => selectedIds.includes(site.id)) : current, incoming))
      setSitesHasMore(page.hasMore)
      setSitesNextCursor(page.nextCursor || '')
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') {
        showToast('warning', 'Lista no disponible', 'No se pudieron cargar páginas y formularios para elegir la ruta principal.')
      }
    } finally {
      if (sitesRequestRef.current === controller) {
        sitesRequestRef.current = null
        setLoadingSites(false)
      }
    }
  }

  const handleSitesSearch = (search: string) => {
    sitesSearchRef.current = search
    if (sitesSearchTimerRef.current !== null) window.clearTimeout(sitesSearchTimerRef.current)
    if (!sitesSelectOpenRef.current) return
    sitesSearchTimerRef.current = window.setTimeout(() => {
      const selectedId = decodeDomainRouteValue(routeDraft).siteId
      void loadDomainSites({ reset: true, search, selectedIds: selectedId ? [selectedId] : [] })
    }, 250)
  }

  const openAddDomainDialog = () => {
    setEditingDomain(null)
    setDomainDraft('')
    setCanonicalDomainDraft('')
    setRouteDraft('')
    setDomainDialogOpen(true)
    void loadDomainSites({ reset: true })
  }

  const openEditDomainDialog = (domain: PublicSiteDomain) => {
    setEditingDomain(domain)
    setDomainDraft(domain.domain)
    setCanonicalDomainDraft(domain.canonicalDomain || domain.domain)
    setRouteDraft(encodeDomainRouteValue(domain.defaultRoute?.siteId, domain.defaultRoute?.pageId))
    setDomainDialogOpen(true)
    void loadDomainSites({
      reset: true,
      selectedIds: domain.defaultRoute?.siteId ? [domain.defaultRoute.siteId] : []
    })
  }

  const closeDomainDialog = () => {
    if (savingDomain) return
    setDomainDialogOpen(false)
    setEditingDomain(null)
    setDomainDraft('')
    setCanonicalDomainDraft('')
    setRouteDraft('')
  }

  const handleDomainDraftChange = (value: string) => {
    const previousPair = getDomainPair(domainDraft)
    const nextPair = getDomainPair(value)
    setDomainDraft(value)
    setCanonicalDomainDraft(current => {
      const followsPreviousDefault = !current || current === previousPair.preferredDomain
      const stillBelongsToPair = current === nextPair.apexDomain || current === nextPair.wwwDomain
      return followsPreviousDefault || !stillBelongsToPair ? nextPair.preferredDomain : current
    })
  }

  const saveDomainDialog = async () => {
    const route = decodeDomainRouteValue(routeDraft)
    setSavingDomain(true)
    try {
      const result = editingDomain
        ? await sitesService.setPublicDomainDefaultRoute(editingDomain.id, route.siteId, route.pageId, canonicalDomainDraft)
        : await sitesService.createPublicDomain({
            domain: domainDraft,
            canonicalDomain: canonicalDomainDraft,
            siteId: route.siteId,
            pageId: route.pageId
          })

      applyConfig(result)
      if (editingDomain || result.verification?.verified || result.verification?.anyVerified) {
        const pairConnected = result.verification?.verified !== false
        showToast(
          pairConnected ? 'success' : 'warning',
          editingDomain ? 'Dominio actualizado' : pairConnected ? 'Dominio conectado' : 'Dominio agregado con pendiente',
          editingDomain
            ? 'La ruta principal y el dominio oficial quedaron guardados.'
            : pairConnected
              ? 'El dominio raíz y www ya responden con esta app.'
              : result.verification?.error || 'Guardamos la pareja; todavía falta conectar uno de los dos dominios.'
        )
        setDomainDialogOpen(false)
        setEditingDomain(null)
        setDomainDraft('')
        setCanonicalDomainDraft('')
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
        showToast('success', 'Pareja verificada', `${domain.apexDomain || domain.domain} y ${domain.wwwDomain || `www.${domain.domain}`} ya responden con esta app.`)
      } else {
        showToast('warning', 'Pareja incompleta', result.verification?.error || 'Todavía falta conectar uno de los dos dominios.')
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
      subtitle={editingDomain ? editingDomain.domain : 'Ristak comprobará automáticamente la versión raíz y la versión www.'}
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
            onChange={(event) => handleDomainDraftChange(event.target.value)}
          />
          <small>Ristak agregará automáticamente la pareja. Para activarla, asegúrate de que raíz y www apunten a este servicio en Render.</small>
        </label>

        <label className={styles.field}>
          <span>Dominio oficial</span>
          <CustomSelect
            value={canonicalDomainDraft}
            disabled={savingDomain || !domainDraftPair.apexDomain}
            size="large"
            onChange={(event) => setCanonicalDomainDraft(event.target.value)}
          >
            <option value={domainDraftPair.apexDomain}>
              {domainDraftPair.apexDomain ? `${domainDraftPair.apexDomain} · sin www` : 'Escribe un dominio primero'}
            </option>
            {domainDraftPair.wwwDomain && (
              <option value={domainDraftPair.wwwDomain}>{domainDraftPair.wwwDomain} · con www</option>
            )}
          </CustomSelect>
          <small>Esta será la URL que Ristak comparta. La otra versión redirigirá aquí conservando la ruta y los parámetros.</small>
        </label>

        <label className={styles.field}>
          <span>Root del dominio</span>
          <CustomSelect
            value={routeDraft}
            disabled={savingDomain}
            size="large"
            dropdownMinHeight={300}
            onChange={(event) => setRouteDraft(event.target.value)}
            searchable
            searchPlaceholder="Buscar página o formulario…"
            onSearchChange={handleSitesSearch}
            onOpenChange={(open) => {
              sitesSelectOpenRef.current = open
              if (open && !loadingSites) {
                const selectedId = decodeDomainRouteValue(routeDraft).siteId
                void loadDomainSites({ reset: true, selectedIds: selectedId ? [selectedId] : [] })
              }
            }}
            onLoadMore={() => void loadDomainSites({ search: sitesSearchRef.current })}
            hasMore={sitesHasMore}
            loading={loadingSites}
            emptyMessage="No hay páginas ni formularios para esta búsqueda"
          >
            {renderDomainRouteOptions()}
          </CustomSelect>
          <small>Si eliges una página, esa página abre directo en la raíz del dominio. Si lo dejas automático, Ristak usa una página publicada.</small>
        </label>
      </div>

      <div className={styles.dialogFooter}>
        <Button type="button" variant="secondary" onClick={closeDomainDialog} disabled={savingDomain}>
          Cancelar
        </Button>
        <Button type="button" onClick={saveDomainDialog} loading={savingDomain} disabled={!domainDraft.trim() || !canonicalDomainDraft}>
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
          <p>Conecta raíz + www, elige la URL oficial y define qué abre en la raíz.</p>
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
            <p>Agrega un dominio y Ristak registrará también su versión www para publicar con una URL oficial.</p>
          </div>
          <Button onClick={openAddDomainDialog}>
            <Plus size={16} />
            Agregar dominio
          </Button>
        </Card>
      ) : (
        <div className={styles.domainList}>
          {publicDomains.map(domain => {
            const status = getDomainPairStatus(domain)
            const apexDomain = domain.apexDomain || getDomainPair(domain.domain).apexDomain
            const wwwDomain = domain.wwwDomain || getDomainPair(domain.domain).wwwDomain
            const canonicalDomain = domain.canonicalDomain || domain.domain
            const apexStatus = getDomainHostStatus(domain, apexDomain, domain.apexDomainVerified)
            const wwwStatus = getDomainHostStatus(domain, wwwDomain, domain.wwwDomainVerified)
            return (
              <div className={styles.domainRow} key={domain.id}>
                <div className={styles.choiceIcon}>
                  <Globe2 size={20} />
                </div>
                <div className={styles.domainInfo}>
                  <div className={styles.choiceTitleRow}>
                    <strong>{canonicalDomain}</strong>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </div>
                  <span>
                    <Star size={14} fill="currentColor" />
                    Oficial · https://{canonicalDomain}
                  </span>
                  <div className={styles.domainHosts}>
                    <span>
                      {apexDomain}
                      <Badge variant={apexStatus.variant}>{apexStatus.label}</Badge>
                    </span>
                    <span>
                      {wwwDomain}
                      <Badge variant={wwwStatus.variant}>{wwwStatus.label}</Badge>
                    </span>
                  </div>
                  <span>
                    <LayoutTemplate size={14} />
                    Root · {getDefaultRouteLabel(domain.defaultRoute)}
                  </span>
                  {domain.apexDomainError && <p className={styles.errorText}>{apexDomain}: {domain.apexDomainError}</p>}
                  {domain.wwwDomainError && <p className={styles.errorText}>{wwwDomain}: {domain.wwwDomainError}</p>}
                  {!domain.pairVerificationReady && domain.renderDomainError && <p className={styles.errorText}>{domain.renderDomainError}</p>}
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
              {publicDomains.length > 0 ? `${publicDomains.length} pareja${publicDomains.length === 1 ? '' : 's'} raíz + www` : 'tunegocio.com + www'}
            </span>
            <span>
              <Star size={14} fill="currentColor" />
              URL oficial y root independiente
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
