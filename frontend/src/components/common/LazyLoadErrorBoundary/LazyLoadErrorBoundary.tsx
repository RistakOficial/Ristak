import React from 'react'
import { Button } from '../Button/Button'

export interface LazyLoadErrorBoundaryProps {
  children: React.ReactNode
  resetKey?: string
}

interface LazyLoadErrorBoundaryState {
  error: Error | null
}

/**
 * Evita que un chunk fallido desmonte toda la aplicación. Cambiar de módulo
 * limpia el error; reintentar el mismo chunk requiere recargar porque el mapa de
 * módulos del navegador conserva imports dinámicos rechazados.
 */
export class LazyLoadErrorBoundary extends React.Component<
  LazyLoadErrorBoundaryProps,
  LazyLoadErrorBoundaryState
> {
  state: LazyLoadErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): LazyLoadErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('No se pudo abrir el módulo solicitado:', error)
  }

  componentDidUpdate(previousProps: LazyLoadErrorBoundaryProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div
        className="flex min-h-[240px] items-center justify-center p-6"
        role="alert"
        data-error-message={import.meta.env.DEV ? this.state.error.message : undefined}
      >
        <div className="max-w-md text-center">
          <h2 className="text-lg font-semibold text-[var(--text)]">No pudimos abrir este módulo</h2>
          <p className="mt-2 text-sm text-[var(--text-mute)]">
            Puede haber una versión nueva de Ristak o un corte momentáneo de red.
          </p>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Recargar Ristak
          </Button>
        </div>
      </div>
    )
  }
}
