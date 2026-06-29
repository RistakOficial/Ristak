import React from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button, PageContainer, PageHeader } from '@/components/common'
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

function readItemIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean)
  return parts[0] === 'mdp-program' ? parts[1] : undefined
}

export const MDPProgram: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const [navigation, setNavigation] = React.useState<MdpProgramNavigation | null>(null)
  const [activeId, setActiveId] = React.useState(readItemIdFromPath)
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

      if (nextItem) {
        const nextPath = `/mdp-program/${encodeURIComponent(nextItem.id)}`
        if (window.location.pathname !== nextPath) {
          navigate(nextPath, { replace: true })
        }
      }
    } catch (err) {
      if (loadSeq !== loadSeqRef.current) return
      setError(err instanceof Error ? err.message : 'No se pudo cargar Magnetismo de Pacientes.')
      setNavigation(null)
      setLaunchItem(null)
    } finally {
      if (loadSeq === loadSeqRef.current) setLoading(false)
    }
  }, [navigate])

  React.useEffect(() => {
    void load(activeId)
  }, [activeId, load])

  React.useEffect(() => {
    const parts = location.pathname.split('/').filter(Boolean)
    setActiveId(parts[0] === 'mdp-program' ? parts[1] : undefined)
  }, [location.pathname])

  const items = navigation?.items || []
  const activeItem = selectItem(items, activeId)

  return (
    <PageContainer size="wide" className="pb-8">
      <PageHeader
        eyebrow="Programa privado"
        title={navigation?.program?.title || 'Magnetismo de Pacientes'}
        subtitle="Capacitaciones y recursos del programa dentro de Ristak."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load(activeId)} loading={loading} leftIcon={<RefreshCw size={16} />}>
            Actualizar
          </Button>
        }
      />

      <div className="mt-5 flex min-h-[calc(100vh-12rem)] flex-col gap-3">
        {loading && !navigation ? (
          <div className="grid min-h-[22rem] place-items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text-mute)]">
            Cargando Magnetismo de Pacientes
          </div>
        ) : error ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <p className="m-0 text-sm font-semibold text-[var(--text)]">No se pudo abrir el programa</p>
            <p className="mt-2 text-sm text-[var(--text-mute)]">{error}</p>
          </div>
        ) : !navigation?.configured ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <p className="m-0 text-sm font-semibold text-[var(--text)]">Magnetismo de Pacientes no está conectado</p>
            <p className="mt-2 text-sm text-[var(--text-mute)]">Falta configurar la URL y secreto del bridge MDP en esta instalación.</p>
          </div>
        ) : !activeItem ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <p className="m-0 text-sm font-semibold text-[var(--text)]">Sin secciones disponibles</p>
            <p className="mt-2 text-sm text-[var(--text-mute)]">MDP no devolvió pestañas activas para este usuario.</p>
          </div>
        ) : !launchItem ? (
          <div className="grid min-h-[22rem] place-items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text-mute)]">
            Abriendo {activeItem.label}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {items.map(item => (
                <Button
                  key={item.id}
                  variant={item.id === activeItem.id ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => navigate(`/mdp-program/${encodeURIComponent(item.id)}`)}
                >
                  {item.label}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.open(launchItem.launchUrl, '_blank', 'noopener,noreferrer')}
                leftIcon={<ExternalLink size={16} />}
              >
                Abrir aparte
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              <iframe
                key={launchItem.launchUrl}
                title={`Magnetismo de Pacientes - ${launchItem.label}`}
                src={launchItem.launchUrl}
                className={cn('h-full min-h-[42rem] w-full border-0 bg-[var(--surface)]')}
                allow="fullscreen; clipboard-read; clipboard-write"
              />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  )
}
