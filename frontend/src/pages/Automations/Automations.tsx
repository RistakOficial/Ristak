import React, { Suspense } from 'react'
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { LazyLoadErrorBoundary } from '@/components/common'
import { AutomationLibrary } from './AutomationLibrary'
import { AutomationsHome } from './AutomationsHome'
import editorStyles from './editor/AutomationEditor.module.css'

// El editor (canvas, registro de nodos, composer…) es el grafo más pesado del
// módulo: se carga en su propio chunk para que /automations abra al instante.
const loadAutomationEditor = () => import('./editor/AutomationEditor')
const LazyAutomationEditor = React.lazy(() =>
  loadAutomationEditor().then((module) => ({ default: module.AutomationEditor }))
)

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
  const goBack = () => navigate('/automations')

  return (
    <LazyLoadErrorBoundary
      resetKey={automationId}
      recoveryKey="route:automation-editor"
    >
      <Suspense
        key={automationId}
        fallback={<AutomationEditorLoading currentAutomationId={automationId} onBack={goBack} />}
      >
        <LazyAutomationEditor key={automationId || 'empty'} />
      </Suspense>
    </LazyLoadErrorBoundary>
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
