import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronLeft, ChevronRight, Folder, Search, Workflow } from 'lucide-react'
import { cn } from '@/utils/cn'
import automationsService, {
  AUTOMATION_STATUS_LABELS,
  type AutomationFolder,
  type AutomationStatus,
  type AutomationSummary
} from '@/services/automationsService'
import styles from './AutomationEditor.module.css'

/**
 * Panel izquierdo del editor: permite navegar entre carpetas y
 * automatizaciones sin volver a la página principal. Resalta el flujo
 * actual y muestra su estado.
 */

interface AutomationLeftNavProps {
  currentId: string
}

const STATUS_DOT: Record<AutomationStatus, string> = {
  draft: 'incomplete',
  published: 'ok',
  paused: 'incomplete',
  archived: 'error'
}

export const AutomationLeftNav: React.FC<AutomationLeftNavProps> = ({ currentId }) => {
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [folders, setFolders] = useState<AutomationFolder[]>([])
  const [automations, setAutomations] = useState<AutomationSummary[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    void automationsService
      .getOverview()
      .then((overview) => {
        if (cancelled) return
        setFolders(overview.folders)
        setAutomations(overview.automations)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [currentId])

  const current = automations.find((automation) => automation.id === currentId)
  const currentFolder = current?.folderId
    ? folders.find((folder) => folder.id === current.folderId) || null
    : null

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const inScope = automations.filter((automation) =>
      currentFolder ? automation.folderId === currentFolder.id : !automation.folderId
    )
    const searched = normalized
      ? automations.filter((automation) => automation.name.toLowerCase().includes(normalized))
      : inScope
    return searched.filter((automation) => automation.status !== 'archived' || automation.id === currentId)
  }, [automations, currentFolder, query, currentId])

  if (collapsed) {
    return (
      <div className={cn(styles.leftNav, styles.leftNavCollapsed)} data-automation-interactive="true">
        <button
          type="button"
          className={styles.leftNavToggle}
          title="Expandir navegación"
          onClick={() => setCollapsed(false)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className={styles.leftNav} data-automation-interactive="true">
      <div className={styles.leftNavHeader}>
        <button
          type="button"
          className={styles.leftNavBack}
          onClick={() => navigate(currentFolder ? `/automations?carpeta=${currentFolder.id}` : '/automations')}
        >
          <ArrowLeft size={13} />
          Automatizaciones
        </button>
        <button
          type="button"
          className={styles.leftNavToggle}
          title="Contraer navegación"
          onClick={() => setCollapsed(true)}
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      <div className={styles.leftNavScope}>
        <Folder size={12} />
        {currentFolder ? currentFolder.name : 'Todas (raíz)'}
      </div>

      <div className={styles.leftNavSearch}>
        <Search size={12} />
        <input
          value={query}
          placeholder="Buscar flujo…"
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Buscar automatización"
        />
      </div>

      <div className={styles.leftNavList}>
        {/* Carpetas de la raíz (solo cuando no estamos dentro de una carpeta) */}
        {!currentFolder && !query.trim() && folders.length > 0 && (
          <>
            <div className={styles.leftNavSectionTitle}>Carpetas</div>
            {folders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                className={styles.leftNavItem}
                onClick={() => navigate(`/automations?carpeta=${folder.id}`)}
              >
                <Folder size={13} style={{ color: 'rgb(217, 156, 16)', flexShrink: 0 }} />
                <span className={styles.leftNavItemName}>{folder.name}</span>
              </button>
            ))}
            <div className={styles.leftNavSectionTitle}>Automatizaciones</div>
          </>
        )}

        {visible.length === 0 && <p className={styles.leftNavEmpty}>Sin automatizaciones aquí</p>}

        {visible.map((automation) => {
          const isCurrent = automation.id === currentId
          return (
            <button
              key={automation.id}
              type="button"
              className={cn(styles.leftNavItem, isCurrent && styles.leftNavItemActive)}
              title={`${automation.name} · ${AUTOMATION_STATUS_LABELS[automation.status]}`}
              onClick={() => {
                if (!isCurrent) navigate(`/automations/${automation.id}`)
              }}
            >
              <Workflow size={13} style={{ flexShrink: 0 }} />
              <span className={styles.leftNavItemName}>{automation.name}</span>
              <span
                className={styles.nodeStatusDot}
                data-state={STATUS_DOT[automation.status]}
                title={AUTOMATION_STATUS_LABELS[automation.status]}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
