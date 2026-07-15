import React, { Suspense, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/common'
import { AutomationLibrary } from './AutomationLibrary'
import { AutomationsHome } from './AutomationsHome'
import styles from './Automations.module.css'
import editorStyles from './editor/AutomationEditor.module.css'

// El editor (canvas, registro de nodos, composer…) es el grafo más pesado del
// módulo: se carga en su propio chunk para que /automations abra al instante.
const loadAutomationEditor = () => import('./editor/AutomationEditor')
const createAutomationEditor = () =>
  React.lazy(() => loadAutomationEditor().then((module) => ({ default: module.AutomationEditor })))

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

type AutomationEditorBoundaryProps = {
  children: React.ReactNode
  currentAutomationId?: string
  onBack: () => void
  onRetry: () => void
}

type AutomationEditorBoundaryState = {
  error: Error | null
  isDynamicImportError: boolean
}

class AutomationEditorBoundary extends React.Component<
  AutomationEditorBoundaryProps,
  AutomationEditorBoundaryState
> {
  state: AutomationEditorBoundaryState = {
    error: null,
    isDynamicImportError: false
  }

  static getDerivedStateFromError(error: Error): AutomationEditorBoundaryState {
    return { error, isDynamicImportError: isDynamicImportFailure(error) }
  }

  componentDidUpdate(prevProps: AutomationEditorBoundaryProps) {
    if (prevProps.currentAutomationId !== this.props.currentAutomationId && this.state.error) {
      this.setState({ error: null, isDynamicImportError: false })
    }
  }

  handleRetry = () => {
    this.setState({ error: null, isDynamicImportError: false })
    this.props.onRetry()
  }

  render() {
    const { error, isDynamicImportError } = this.state

    if (!error) return this.props.children

    return (
      <div className={editorStyles.editorShell}>
        <div className={editorStyles.editorMain}>
          <AutomationLibrary currentAutomationId={this.props.currentAutomationId} />
          <div className={styles.editorRecoveryState} role="alert">
            <div className={styles.editorRecoveryIcon} aria-hidden="true">
              <AlertTriangle size={18} />
            </div>
            <div className={styles.editorRecoveryCopy}>
              <h2>{isDynamicImportError ? 'No se pudo abrir esta automatización' : 'Algo falló al abrir el editor'}</h2>
              <p>
                {isDynamicImportError
                  ? 'El editor no terminó de cargar. Intenta de nuevo sin recargar toda la app.'
                  : 'Intenta abrir el editor otra vez sin salir de Automatizaciones.'}
              </p>
            </div>
            <div className={styles.editorRecoveryActions}>
              <Button variant="primary" size="sm" leftIcon={<RefreshCw size={15} />} onClick={this.handleRetry}>
                Reintentar
              </Button>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<ArrowLeft size={15} />}
                onClick={this.props.onBack}
              >
                Volver
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}

const AutomationEditorLoading: React.FC<{
  currentAutomationId?: string
  onBack: () => void
}> = ({ currentAutomationId, onBack }) => (
  <div className={editorStyles.editorShell}>
    <header className={editorStyles.toolbar}>
      <button
        type="button"
        className={editorStyles.toolbarBack}
        title="Volver a Automatizaciones"
        onClick={onBack}
      >
        <ArrowLeft size={15} />
      </button>
      <span className={editorStyles.saveIndicator} role="status" aria-live="polite">
        <Loader2 size={12} className="animate-spin" />
        Cargando automatización...
      </span>
    </header>
    <div className={editorStyles.editorMain}>
      <AutomationLibrary currentAutomationId={currentAutomationId} />
      <div className={editorStyles.editorLoading} role="status" aria-live="polite">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
      </div>
    </div>
  </div>
)

const AutomationEditorRoute: React.FC = () => {
  const { automationId = '' } = useParams()
  const navigate = useNavigate()
  const [retryKey, setRetryKey] = useState(0)
  const LazyAutomationEditor = useMemo(createAutomationEditor, [retryKey])
  const goBack = () => navigate('/automations')

  return (
    <AutomationEditorBoundary
      currentAutomationId={automationId}
      onBack={goBack}
      onRetry={() => setRetryKey((current) => current + 1)}
    >
      <Suspense
        key={`${automationId}:${retryKey}`}
        fallback={<AutomationEditorLoading currentAutomationId={automationId} onBack={goBack} />}
      >
        <LazyAutomationEditor key={automationId || 'empty'} />
      </Suspense>
    </AutomationEditorBoundary>
  )
}

export const Automations: React.FC = () => {
  return (
    <Routes>
      <Route index element={<AutomationsHome />} />
      <Route path=":automationId" element={<AutomationEditorRoute />} />
      <Route path="*" element={<Navigate to="/automations" replace />} />
    </Routes>
  )
}
