import React from 'react'
import { RefreshCw } from 'lucide-react'
import { useLocation } from 'react-router-dom'
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

interface MdpBridgeThemePayload {
  type: 'ristak:theme'
  source: 'ristak'
  version: 1
  mode: 'light' | 'dark'
  ristakDir: ThemeDir
  mdpPreset: string
}

function selectItem(items: MdpProgramNavItem[], itemId?: string) {
  if (!items.length) return null
  if (!itemId) return items[0]
  return items.find(item => item.id === itemId) || items[0]
}

function readLegacyItemIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean)
  return parts[0] === 'mdp-program' ? parts[1] : undefined
}

function getMdpTargetOrigin(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return '*'
  }
}

function withMdpBridgeThemeParams(url: string, payload: MdpBridgeThemePayload) {
  try {
    const nextUrl = new URL(url)
    nextUrl.searchParams.set('embedded', 'ristak')
    nextUrl.searchParams.set('ristak_theme_mode', payload.mode)
    nextUrl.searchParams.set('ristak_theme_dir', payload.ristakDir)
    nextUrl.searchParams.set('ristak_theme_preset', payload.mdpPreset)
    return nextUrl.toString()
  } catch {
    return url
  }
}

export const MDPProgram: React.FC = () => {
  const location = useLocation()
  const { theme, themeDir } = useTheme()
  const [navigation, setNavigation] = React.useState<MdpProgramNavigation | null>(null)
  const [requestedItemId, setRequestedItemId] = React.useState(readLegacyItemIdFromPath)
  const [launchItem, setLaunchItem] = React.useState<MdpProgramNavItem | null>(null)
  const [iframeSrc, setIframeSrc] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null)
  const loadSeqRef = React.useRef(0)
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

  const postThemeToIframe = React.useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow
    if (!frameWindow || !launchItem?.launchUrl) return

    frameWindow.postMessage(mdpThemePayload, getMdpTargetOrigin(launchItem.launchUrl))
  }, [launchItem?.launchUrl, mdpThemePayload])

  React.useEffect(() => {
    void load(requestedItemId)
  }, [requestedItemId, load])

  React.useEffect(() => {
    const parts = location.pathname.split('/').filter(Boolean)
    setRequestedItemId(parts[0] === 'mdp-program' ? parts[1] : undefined)
  }, [location.pathname])

  React.useEffect(() => {
    if (!launchItem?.launchUrl) {
      setIframeSrc('')
      return
    }

    setIframeSrc(withMdpBridgeThemeParams(launchItem.launchUrl, mdpThemePayload))
  }, [launchItem?.launchUrl])

  React.useEffect(() => {
    postThemeToIframe()
  }, [postThemeToIframe])

  const items = navigation?.items || []
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
          allow="fullscreen; clipboard-read; clipboard-write"
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
