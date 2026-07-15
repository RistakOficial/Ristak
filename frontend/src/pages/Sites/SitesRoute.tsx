import React, { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/common/PageContainer'
import { PageHeader } from '@/components/common/PageHeader'
import { TabList } from '@/components/common/TabList'

type SitesWorkspaceModule = typeof import('./Sites')
type WarmLibraryKind = 'landings' | 'forms'

type SitesRouteDescriptor = {
  cacheKey: string
  kind: WarmLibraryKind | null
  siteId: string
  creating: boolean
  sectionLabel: string
}

type SitesRouteWarmup = {
  descriptor: SitesRouteDescriptor
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

  // El shell sólo prepara el chunk. Los datos pertenecen al workspace y se
  // solicitan una sola vez al montarlo; así una API lenta no bloquea toda la
  // ruta ni se duplica por depender de un cache GET global.
  const warmup = { descriptor }
  sitesRouteWarmups.set(descriptor.cacheKey, warmup)

  // Este cache sólo enlaza el shell con el workspace durante la transición.
  // Los datos pertenecen a los snapshots acotados de sitesService y a sus
  // invalidaciones; la ruta no conserva Responses ni cuerpos de API.
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
}> = ({ warmup }) => {
  const navigate = useNavigate()
  const { descriptor } = warmup
  const activeTab = descriptor.kind || 'landings'
  const title = descriptor.sectionLabel

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

      <SitesRouteSkeleton />
    </PageContainer>
  )
}

export const SitesRoute: React.FC = () => {
  const location = useLocation()
  const warmup = useMemo(() => prewarmSitesRoute(location.pathname), [location.pathname])
  const [workspaceReady, setWorkspaceReady] = useState(false)

  useEffect(() => {
    if (workspaceReady) return
    let active = true

    void prefetchSitesWorkspace().then(() => {
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
    return <SitesRouteShell warmup={warmup} />
  }

  return (
    <React.Suspense fallback={<SitesRouteShell warmup={warmup} />}>
      <LazySitesWorkspace />
    </React.Suspense>
  )
}
