import React from 'react'
import { RefreshCw } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { Button } from '@/components/common'
import {
  getMdpProgramNavigation,
  type MdpProgramNavigation,
  type MdpProgramNavItem
} from '@/services/mdpProgramService'
import { cn } from '@/utils/cn'

function selectItem(items: MdpProgramNavItem[], itemId?: string) {
  if (!items.length) return null
  if (!itemId) return items[0]
  return items.find(item => item.id === itemId) || items[0]
}

function readLegacyItemIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean)
  return parts[0] === 'mdp-program' ? parts[1] : undefined
}

export const MDPProgram: React.FC = () => {
  const location = useLocation()
  const [navigation, setNavigation] = React.useState<MdpProgramNavigation | null>(null)
  const [requestedItemId, setRequestedItemId] = React.useState(readLegacyItemIdFromPath)
  const [launchItem, setLaunchItem] = React.useState<MdpProgramNavItem | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const loadSeqRef = React.useRef(0)

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

  React.useEffect(() => {
    void load(requestedItemId)
  }, [requestedItemId, load])

  React.useEffect(() => {
    const parts = location.pathname.split('/').filter(Boolean)
    setRequestedItemId(parts[0] === 'mdp-program' ? parts[1] : undefined)
  }, [location.pathname])

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
      ) : (
        <iframe
          key={launchItem.launchUrl}
          title={`${programTitle} - ${launchItem.label}`}
          src={launchItem.launchUrl}
          className={cn('h-full min-h-0 w-full border-0 bg-[var(--surface)]')}
          allow="fullscreen; clipboard-read; clipboard-write"
          allowFullScreen
        />
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
