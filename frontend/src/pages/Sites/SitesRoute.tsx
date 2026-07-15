import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/common/PageContainer'
import { PageHeader } from '@/components/common/PageHeader'
import { TabList } from '@/components/common/TabList'
import {
  sitesService,
  type PublicSite,
  type SitesListPage
} from '@/services/sitesService'
import { formatDateTime } from '@/utils/format'

type SitesWorkspaceModule = typeof import('./Sites')
type WarmLibraryKind = 'landings' | 'forms'

type SitesRouteDescriptor = {
  cacheKey: string
  kind: WarmLibraryKind | null
  siteId: string
  creating: boolean
  sectionLabel: string
}

type SitesRouteWarmData = {
  page?: SitesListPage
  site?: PublicSite
}

type SitesRouteWarmup = {
  descriptor: SitesRouteDescriptor
  critical: Promise<SitesRouteWarmData>
}

let sitesWorkspacePromise: Promise<SitesWorkspaceModule> | null = null
const sitesRouteWarmups = new Map<string, SitesRouteWarmup>()

function safeDecodeRoutePart(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function describeSitesRoute(pathname: string): SitesRouteDescriptor {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const sitesIndex = segments.indexOf('sites')
  const routeSegments = sitesIndex >= 0 ? segments.slice(sitesIndex + 1) : []
  const section = routeSegments[0] || 'landings'
  const kind: WarmLibraryKind | null = section === 'forms'
    ? 'forms'
    : section === 'landings' || !routeSegments[0]
      ? 'landings'
      : null
  const firstDetail = routeSegments[1] || ''
  const creating = firstDetail === 'new' || firstDetail === 'create'
  const siteId = kind && firstDetail && !creating ? safeDecodeRoutePart(firstDetail) : ''
  const sectionLabel = section === 'forms'
    ? 'Formularios'
    : section === 'analytics'
      ? 'Analíticas de Sitios'
      : section === 'domains'
        ? 'Dominios'
        : 'Sitios web'

  return {
    cacheKey: `${kind || section}:${siteId || (creating ? 'new' : 'library')}`,
    kind,
    siteId,
    creating,
    sectionLabel
  }
}

function prewarmSitesRoute(pathname: string): SitesRouteWarmup {
  const descriptor = describeSitesRoute(pathname)
  const existing = sitesRouteWarmups.get(descriptor.cacheKey)
  if (existing) return existing

  // Dominio y carpetas enriquecen la biblioteca. Arrancarlos junto con el
  // chunk pesado hace que Sites los consuma desde el dedupe/cache global, sin
  // convertirlos en una barrera para pintar la ruta.
  if (descriptor.kind) {
    void Promise.allSettled([
      sitesService.getDomain(),
      sitesService.listFolders()
    ])
  }

  const critical = descriptor.siteId
    ? sitesService.getSite(descriptor.siteId).then(site => ({ site }))
    : descriptor.kind && !descriptor.creating
      ? sitesService.listSitesPage({
          limit: 120,
          kind: descriptor.kind,
          search: '',
          folderId: '__root__',
          includeFacets: true
        }).then(page => ({ page }))
      : Promise.resolve({})

  const warmup = { descriptor, critical }
  sitesRouteWarmups.set(descriptor.cacheKey, warmup)

  // Este cache sólo enlaza el shell con el workspace durante la transición.
  // La coherencia de largo plazo pertenece al cache GET autenticado y a las
  // invalidaciones de las mutaciones, no a la ruta.
  window.setTimeout(() => {
    if (sitesRouteWarmups.get(descriptor.cacheKey) === warmup) {
      sitesRouteWarmups.delete(descriptor.cacheKey)
    }
  }, 30_000)

  return warmup
}

/**
 * El editor de Sites es deliberadamente enorme: incluye canvas, IA, media,
 * formularios y analíticas. El menú y esta ruta comparten una sola promesa para
 * descargar/parsear ese workspace una vez, sin congelar otras secciones.
 */
export function prefetchSitesWorkspace() {
  if (!sitesWorkspacePromise) {
    sitesWorkspacePromise = import('./Sites').catch((error) => {
      sitesWorkspacePromise = null
      throw error
    })
  }
  return sitesWorkspacePromise
}

const LazySitesWorkspace = React.lazy(async () => {
  const module = await prefetchSitesWorkspace()
  return { default: module.Sites }
})

const SitesRouteSkeleton: React.FC = () => (
  <div
    className="mt-8 space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5"
    role="status"
    aria-label="Preparando el espacio de trabajo de Sitios"
  >
    {[72, 58, 66, 48].map(width => (
      <div
        key={width}
        className="h-5 animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-2)]"
        style={{ width: `${width}%` }}
      />
    ))}
  </div>
)

const SitesRouteShell: React.FC<{
  warmup: SitesRouteWarmup
  data: SitesRouteWarmData | null
}> = ({ warmup, data }) => {
  const navigate = useNavigate()
  const { descriptor } = warmup
  const activeTab = descriptor.kind || 'landings'
  const title = data?.site?.name || descriptor.sectionLabel
  const libraryItems = data?.page?.items.slice(0, 8) || []

  return (
    <PageContainer size="wide">
      <PageHeader
        eyebrow="Sitios"
        title={title}
        subtitle={descriptor.siteId
          ? 'Abriendo el editor con la información más reciente.'
          : descriptor.creating
            ? 'Preparando el creador.'
            : 'Tus páginas y formularios están disponibles mientras termina de arrancar el editor.'}
      />

      {descriptor.kind && !descriptor.siteId && !descriptor.creating ? (
        <div className="mt-6">
          <TabList
            tabs={[
              { value: 'landings', label: 'Sitios web' },
              { value: 'forms', label: 'Formularios' }
            ]}
            activeTab={activeTab}
            onTabChange={(value) => navigate(`/sites/${value}`)}
          />
        </div>
      ) : null}

      {libraryItems.length > 0 ? (
        <ul className="mt-8 divide-y divide-[var(--border)] border-y border-[var(--border)]" aria-label={descriptor.sectionLabel}>
          {libraryItems.map(site => (
            <li key={site.id}>
              <Link
                to={`/sites/${descriptor.kind}/${encodeURIComponent(site.id)}`}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-2 py-4 text-[var(--text)] transition-colors hover:bg-[var(--surface-2)]"
              >
                <span className="min-w-0 truncate text-sm font-medium">{site.name || site.title || 'Sin nombre'}</span>
                <span className="text-xs text-[var(--text-dim)]">{formatDateTime(site.updatedAt, { includeTime: false })}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <SitesRouteSkeleton />
      )}
    </PageContainer>
  )
}

export const SitesRoute: React.FC = () => {
  const location = useLocation()
  const warmup = useMemo(() => prewarmSitesRoute(location.pathname), [location.pathname])
  const [warmData, setWarmData] = useState<SitesRouteWarmData | null>(null)
  const [workspaceReady, setWorkspaceReady] = useState(false)

  useEffect(() => {
    if (workspaceReady) return
    let active = true
    setWarmData(null)

    void warmup.critical
      .then(data => {
        if (active) setWarmData(data)
      })
      .catch(() => undefined)

    void Promise.all([
      prefetchSitesWorkspace(),
      warmup.critical.catch(() => ({}))
    ]).then(() => {
      if (active) setWorkspaceReady(true)
    }).catch(() => {
      // React.lazy conserva el error real para el error boundary de la app.
      if (active) setWorkspaceReady(true)
    })

    return () => {
      active = false
    }
  }, [warmup, workspaceReady])

  if (!workspaceReady) {
    return <SitesRouteShell warmup={warmup} data={warmData} />
  }

  return (
    <React.Suspense fallback={<SitesRouteShell warmup={warmup} data={warmData} />}>
      <LazySitesWorkspace />
    </React.Suspense>
  )
}
