import React from 'react'
import { Loading } from '@/components/common'

type SitesWorkspaceModule = typeof import('./Sites')

let sitesWorkspacePromise: Promise<SitesWorkspaceModule> | null = null

/**
 * El editor de Sites es deliberadamente enorme: incluye canvas, IA, media,
 * formularios y analíticas. Esta promesa compartida descarga y parsea el
 * workspace una sola vez sin meterlo en el bundle inicial del CRM.
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

/**
 * La transición no intenta imitar la biblioteca ni el editor. Mostrar una
 * segunda estructura de página antes del workspace real produce un flash que
 * parece una versión vieja y además duplica navegación visible.
 */
export const SitesRoute: React.FC = () => (
  <React.Suspense fallback={<Loading page="sites" message="Abriendo Sitios..." />}>
    <LazySitesWorkspace />
  </React.Suspense>
)
