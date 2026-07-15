import React from 'react'
import { RefreshCw } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@/components/common'
import { useTheme, type ThemeDir } from '@/contexts/ThemeContext'
import {
  getMdpProgramNavigation,
  type MdpProgramNavigation,
  type MdpProgramNavItem
} from '@/services/mdpProgramService'
import { cn } from '@/utils/cn'

const RISTAK_TO_MDP_THEME_PRESET: Record<ThemeDir, string> = {
  a: 'nimbus-classic',
  av: 'nimbus-violet',
  ab: 'nimbus-blue',
  am: 'nimbus-graphite',
  c: 'onyx-emerald',
  cb: 'onyx-blue',
  cv: 'onyx-violet',
  ca: 'onyx-amber',
  d: 'brut-red',
  db: 'brut-blue',
  dl: 'brut-lime',
  dm: 'brut-magenta',
  e: 'aurora-violet',
  en: 'aurora-neutral',
  eb: 'aurora-blue',
  em: 'aurora-graphite'
}

const MDP_PROGRAM_IFRAME_ALLOW = [
  'accelerometer',
  'autoplay',
  'camera',
  'clipboard-read',
  'clipboard-write',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'gyroscope',
  'microphone',
  'picture-in-picture',
  'web-share'
].join('; ')

interface MdpBridgeThemePayload {
  type: 'ristak:theme'
  source: 'ristak'
  version: 1
  mode: 'light' | 'dark'
  ristakDir: ThemeDir
  mdpPreset: string
}

interface MdpRouteState {
  itemId?: string
  suffix: string
  search: string
  hash: string
}

const MDP_INTERNAL_URL_BASE = 'https://mdp.local'

function selectItem(items: MdpProgramNavItem[], itemId?: string) {
  if (!items.length) return null
  if (!itemId) return items[0]
  return items.find(item => item.id === itemId) || items[0]
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function readMdpRouteState(pathname: string, search = '', hash = ''): MdpRouteState {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'mdp-program') {
    return { suffix: '', search: '', hash: '' }
  }

  return {
    itemId: parts[1] ? safeDecode(parts[1]) : undefined,
    suffix: parts.length > 2 ? `/${parts.slice(2).join('/')}` : '',
    search,
    hash
  }
}

function getMdpTargetOrigin(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return '*'
  }
}

function parseMessageData(value: unknown) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function normalizePathname(pathname: string) {
  const trimmed = String(pathname || '').replace(/\/+$/, '')
  return trimmed || '/'
}

function normalizeMdpInnerPath(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/api/')) return ''

  try {
    const parsed = new URL(raw, MDP_INTERNAL_URL_BASE)
    if (parsed.origin !== MDP_INTERNAL_URL_BASE) return ''
    const pathname = parsed.pathname || '/'
    if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.startsWith('/api/')) return ''
    return `${pathname}${parsed.search}${parsed.hash}`.slice(0, 800)
  } catch {
    return ''
  }
}

function getMdpItemPath(item: MdpProgramNavItem) {
  const path = normalizeMdpInnerPath(item.path || `/${item.id}`)
  if (!path) return ''
  return normalizePathname(new URL(path, MDP_INTERNAL_URL_BASE).pathname)
}

function getMdpTargetPathForRoute(item: MdpProgramNavItem, route: MdpRouteState) {
  const basePath = getMdpItemPath(item)
  if (!basePath) return ''

  const suffix = route.itemId === item.id ? route.suffix : ''
  const targetPath = `${basePath === '/' ? '' : basePath}${suffix}${route.search}${route.hash}`
  return normalizeMdpInnerPath(targetPath) || basePath
}

function getMdpNavigationPathFromMessage(value: unknown) {
  const data = parseMessageData(value)
  if (!data || typeof data !== 'object') return ''

  const payload = data as Record<string, unknown>
  if (payload.type !== 'ristak:navigation' || payload.source !== 'mdp') return ''

  return normalizeMdpInnerPath(payload.path ?? payload.pathname)
}

function findItemForMdpPath(items: MdpProgramNavItem[], innerPath: string) {
  const cleanPath = normalizeMdpInnerPath(innerPath)
  if (!cleanPath) return null

  const pathname = normalizePathname(new URL(cleanPath, MDP_INTERNAL_URL_BASE).pathname)

  return items
    .map((item) => ({ item, basePath: getMdpItemPath(item) }))
    .filter(({ basePath }) => basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`)))
    .sort((a, b) => b.basePath.length - a.basePath.length)[0]?.item || null
}

function getRistakPathForMdpPath(items: MdpProgramNavItem[], innerPath: string) {
  const item = findItemForMdpPath(items, innerPath)
  const cleanPath = normalizeMdpInnerPath(innerPath)
  if (!item || !cleanPath) return ''

  const parsed = new URL(cleanPath, MDP_INTERNAL_URL_BASE)
  const pathname = normalizePathname(parsed.pathname)
  const basePath = getMdpItemPath(item)
  const suffix = pathname === basePath ? '' : pathname.slice(basePath.length)

  return `/mdp-program/${encodeURIComponent(item.id)}${suffix}${parsed.search}${parsed.hash}`
}

function isExpectedMdpOrigin(eventOrigin: string, launchUrl: string) {
  const targetOrigin = getMdpTargetOrigin(launchUrl)
  return targetOrigin === '*' || eventOrigin === targetOrigin
}

function withMdpBridgeThemeParams(url: string, payload: MdpBridgeThemePayload, targetPath = '') {
  try {
    const nextUrl = new URL(url)
    nextUrl.searchParams.set('embedded', 'ristak')
    nextUrl.searchParams.set('ristak_theme_mode', payload.mode)
    nextUrl.searchParams.set('ristak_theme_dir', payload.ristakDir)
    nextUrl.searchParams.set('ristak_theme_preset', payload.mdpPreset)
    if (targetPath) {
      nextUrl.searchParams.set('to', targetPath)
    }
    return nextUrl.toString()
  } catch {
    return url
  }
}

export const MDPProgram: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { theme, themeDir } = useTheme()
  const [navigation, setNavigation] = React.useState<MdpProgramNavigation | null>(null)
  const [launchItem, setLaunchItem] = React.useState<MdpProgramNavItem | null>(null)
  const [iframeSrc, setIframeSrc] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null)
  const loadSeqRef = React.useRef(0)
  const routeSyncSkipRef = React.useRef('')
  const routeState = React.useMemo(
    () => readMdpRouteState(location.pathname, location.search, location.hash),
    [location.hash, location.pathname, location.search]
  )
  const requestedItemId = routeState.itemId
  const mdpThemePayload = React.useMemo<MdpBridgeThemePayload>(() => ({
    type: 'ristak:theme',
    source: 'ristak',
    version: 1,
    mode: theme,
    ristakDir: themeDir,
    mdpPreset: RISTAK_TO_MDP_THEME_PRESET[themeDir] || RISTAK_TO_MDP_THEME_PRESET.en
  }), [theme, themeDir])

  const load = React.useCallback(async (requestedId?: string) => {
    const loadSeq = loadSeqRef.current + 1
    loadSeqRef.current = loadSeq
    setLoading(true)
    setError('')
    setLaunchItem(null)
    try {
      const nextNavigation = await getMdpProgramNavigation()
      const nextItem = selectItem(nextNavigation.items || [], requestedId)
      if (loadSeq !== loadSeqRef.current) return
      setNavigation(nextNavigation)
      setLaunchItem(nextItem)
    } catch (err) {
      if (loadSeq !== loadSeqRef.current) return
      setError(err instanceof Error ? err.message : 'No se pudo cargar Magnetismo de Pacientes.')
      setNavigation(null)
      setLaunchItem(null)
    } finally {
      if (loadSeq === loadSeqRef.current) setLoading(false)
    }
  }, [])

  const items = navigation?.items || []
  const currentRistakPath = `${location.pathname}${location.search}${location.hash}`

  const postThemeToIframe = React.useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow
    if (!frameWindow || !launchItem?.launchUrl) return

    frameWindow.postMessage(mdpThemePayload, getMdpTargetOrigin(launchItem.launchUrl))
  }, [launchItem?.launchUrl, mdpThemePayload])

  React.useEffect(() => {
    if (navigation) {
      setLaunchItem(selectItem(navigation.items || [], requestedItemId))
      return
    }
    void load(requestedItemId)
  }, [requestedItemId, load, navigation])

  React.useEffect(() => {
    if (!launchItem?.launchUrl) {
      setIframeSrc('')
      return
    }

    if (routeSyncSkipRef.current === currentRistakPath) {
      routeSyncSkipRef.current = ''
      return
    }

    setIframeSrc(withMdpBridgeThemeParams(
      launchItem.launchUrl,
      mdpThemePayload,
      getMdpTargetPathForRoute(launchItem, routeState)
    ))
  }, [currentRistakPath, launchItem?.id, launchItem?.launchUrl, launchItem?.path])

  React.useEffect(() => {
    const handleMdpNavigation = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow || !launchItem?.launchUrl) return
      if (!isExpectedMdpOrigin(event.origin, launchItem.launchUrl)) return

      const innerPath = getMdpNavigationPathFromMessage(event.data)
      if (!innerPath) return

      const nextRistakPath = getRistakPathForMdpPath(items, innerPath)
      if (!nextRistakPath || nextRistakPath === currentRistakPath) return

      routeSyncSkipRef.current = nextRistakPath
      navigate(nextRistakPath, { replace: true })
    }

    window.addEventListener('message', handleMdpNavigation)
    return () => window.removeEventListener('message', handleMdpNavigation)
  }, [currentRistakPath, items, launchItem?.launchUrl, navigate])

  React.useEffect(() => {
    postThemeToIframe()
  }, [postThemeToIframe])

  const activeItem = selectItem(items, requestedItemId)
  const programTitle = navigation?.program?.title || 'Magnetismo de Pacientes'

  return (
    <section
      data-ristak-mdp-program-view
      className="h-[calc(100vh-var(--header-height))] min-h-[calc(100vh-var(--header-height))] overflow-hidden bg-[var(--surface)] text-[var(--color-text-primary)]"
    >
      {loading && !navigation ? (
        <div className="grid h-full place-items-center text-sm text-[var(--text-mute)]">
          Cargando Magnetismo de Pacientes
        </div>
      ) : error ? (
        <MdpProgramState
          title="No se pudo abrir el programa"
          message={error}
          action={<Button variant="secondary" size="sm" onClick={() => void load(requestedItemId)} leftIcon={<RefreshCw size={16} />}>Actualizar</Button>}
        />
      ) : !navigation?.configured ? (
        <MdpProgramState
          title="Magnetismo de Pacientes no está conectado"
          message="Falta configurar la URL y secreto del bridge MDP en esta instalación."
        />
      ) : !activeItem ? (
        <MdpProgramState
          title="Sin secciones disponibles"
          message="MDP no devolvió secciones activas para este usuario."
        />
      ) : !launchItem ? (
        <div className="grid h-full place-items-center text-sm text-[var(--text-mute)]">
          Abriendo {activeItem.label}
        </div>
      ) : iframeSrc ? (
        <iframe
          ref={iframeRef}
          key={launchItem.launchUrl}
          title={`${programTitle} - ${launchItem.label}`}
          src={iframeSrc}
          className={cn('h-full min-h-0 w-full border-0 bg-[var(--surface)]')}
          allow={MDP_PROGRAM_IFRAME_ALLOW}
          allowFullScreen
          onLoad={postThemeToIframe}
        />
      ) : (
        <div className="grid h-full place-items-center text-sm text-[var(--text-mute)]">
          Abriendo {activeItem.label}
        </div>
      )}
    </section>
  )
}

interface MdpProgramStateProps {
  title: string
  message: string
  action?: React.ReactNode
}

const MdpProgramState: React.FC<MdpProgramStateProps> = ({ title, message, action }) => (
  <div className="grid h-full place-items-center p-6">
    <div className="w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
      <p className="m-0 text-sm font-semibold text-[var(--text)]">{title}</p>
      <p className="mt-2 text-sm text-[var(--text-mute)]">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  </div>
)
