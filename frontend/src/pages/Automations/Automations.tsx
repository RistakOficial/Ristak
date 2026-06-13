import React, { Suspense, useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/common'
import { AutomationsHome } from './AutomationsHome'
import styles from './Automations.module.css'

// El editor (canvas, registro de nodos, composer…) es el grafo más pesado del
// módulo: se carga en su propio chunk para que /automations abra al instante.
const AutomationEditor = React.lazy(() =>
  import('./editor/AutomationEditor').then((module) => ({ default: module.AutomationEditor }))
)

const editorPreload = () => import('./editor/AutomationEditor')
const AUTOMATION_EDITOR_RELOAD_KEY = 'ristak:automation-editor-chunk-reload'
const AUTOMATION_EDITOR_RELOAD_WINDOW_MS = 10_000

function isDynamicImportFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')

  return [
    'Failed to fetch dynamically imported module',
    'Importing a module script failed',
    'error loading dynamically imported module',
    'Expected a JavaScript-or-Wasm module script',
    'Loading chunk'
  ].some((needle) => message.includes(needle))
}

function getEditorReloadKey() {
  if (typeof window === 'undefined') return AUTOMATION_EDITOR_RELOAD_KEY
  return `${AUTOMATION_EDITOR_RELOAD_KEY}:${window.location.pathname}`
}

type AutomationEditorBoundaryProps = {
  children: React.ReactNode
}

type AutomationEditorBoundaryState = {
  error: Error | null
  isDynamicImportError: boolean
  reloading: boolean
}

class AutomationEditorBoundary extends React.Component<
  AutomationEditorBoundaryProps,
  AutomationEditorBoundaryState
> {
  state: AutomationEditorBoundaryState = {
    error: null,
    isDynamicImportError: false,
    reloading: false
  }

  static getDerivedStateFromError(error: Error): AutomationEditorBoundaryState {
    return { error, isDynamicImportError: isDynamicImportFailure(error), reloading: false }
  }

  componentDidCatch(error: Error) {
    if (!isDynamicImportFailure(error) || typeof window === 'undefined') return

    const reloadKey = getEditorReloadKey()

    try {
      const lastReloadedAt = Number(window.sessionStorage.getItem(reloadKey) || 0)

      if (Date.now() - lastReloadedAt > AUTOMATION_EDITOR_RELOAD_WINDOW_MS) {
        window.sessionStorage.setItem(reloadKey, String(Date.now()))
        this.setState({ reloading: true })
        window.setTimeout(() => window.location.reload(), 50)
      }
    } catch {
      this.setState({ reloading: true })
      window.setTimeout(() => window.location.reload(), 50)
    }
  }

  handleRetry = () => {
    if (typeof window === 'undefined') return

    try {
      window.sessionStorage.removeItem(getEditorReloadKey())
    } catch {
      // La recarga manual sigue funcionando aunque sessionStorage no esté disponible.
    }

    window.location.reload()
  }

  render() {
    const { error, isDynamicImportError, reloading } = this.state

    if (!error) return this.props.children

    if (reloading) {
      return (
        <div className={styles.editorLoadingState} role="status" aria-live="polite">
          <Loader2 size={16} className="animate-spin" />
          <span>Actualizando editor...</span>
        </div>
      )
    }

    return (
      <div className={styles.editorRecoveryState} role="alert">
        <div className={styles.editorRecoveryIcon} aria-hidden="true">
          <AlertTriangle size={18} />
        </div>
        <div className={styles.editorRecoveryCopy}>
          <h2>{isDynamicImportError ? 'No se pudo abrir esta automatización' : 'Algo falló al abrir el editor'}</h2>
          <p>
            {isDynamicImportError
              ? 'El navegador intentó usar una versión anterior del editor. Actualiza la página para cargar la versión más reciente.'
              : 'Actualiza la página para intentar abrir el editor otra vez.'}
          </p>
        </div>
        <div className={styles.editorRecoveryActions}>
          <Button variant="primary" size="sm" leftIcon={<RefreshCw size={15} />} onClick={this.handleRetry}>
            Actualizar
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<ArrowLeft size={15} />}
            onClick={() => {
              window.location.href = '/automations'
            }}
          >
            Volver
          </Button>
        </div>
      </div>
    )
  }
}

export const Automations: React.FC = () => {
  // Precarga el chunk del editor en segundo plano: al entrar a una
  // automatización ya está listo (sin espera perceptible)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void editorPreload().catch(() => undefined)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <Routes>
      <Route index element={<AutomationsHome />} />
      <Route
        path=":automationId"
        element={
          <AutomationEditorBoundary>
            <Suspense
              fallback={
                <div className={styles.editorLoadingState} role="status" aria-live="polite">
                  <Loader2 size={15} className="animate-spin" />
                </div>
              }
            >
              <AutomationEditor />
            </Suspense>
          </AutomationEditorBoundary>
        }
      />
      <Route path="*" element={<Navigate to="/automations" replace />} />
    </Routes>
  )
}
