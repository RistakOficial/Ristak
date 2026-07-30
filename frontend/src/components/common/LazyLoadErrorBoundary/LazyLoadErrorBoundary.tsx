import React from 'react'
import { Button } from '../Button/Button'
import { Loading } from '../Loading/Loading'
import {
  claimRouteLoadRecovery,
  isDynamicImportFailure,
  releaseRouteLoadRecovery,
  type RouteLoadRecoveryClaim,
  type RouteLoadRecoveryStorage
} from '@/utils/routeLoadRecovery'

export interface LazyLoadErrorBoundaryProps {
  children: React.ReactNode
  resetKey?: string
  recoveryKey?: string
}

interface LazyLoadErrorBoundaryState {
  error: Error | null
  isDynamicImportError: boolean
  recoveryStatus: 'idle' | 'preparing' | 'waiting-online' | 'reloading' | 'blocked'
}

const AUTOMATIC_RELOAD_DELAY_MS = 120
let activeAutomaticRecoveryOwner: LazyLoadErrorBoundary | null = null

function getSessionStorage(): RouteLoadRecoveryStorage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function getBuildFingerprint() {
  try {
    const entryScript = document.querySelector<HTMLScriptElement>(
      'script[type="module"][src*="/assets/"]'
    ) ?? document.querySelector<HTMLScriptElement>('script[type="module"][src]')

    return entryScript?.src || 'unversioned'
  } catch {
    return 'unversioned'
  }
}

/**
 * Evita que un chunk fallido desmonte toda la aplicación. Los imports dinámicos
 * rechazados no se pueden reintentar de forma fiable en el mismo documento, así
 * que la zona de contenido muestra su loader y obtiene una sola vez el build
 * vigente. Los errores normales de render nunca disparan esta recuperación.
 */
export class LazyLoadErrorBoundary extends React.Component<
  LazyLoadErrorBoundaryProps,
  LazyLoadErrorBoundaryState
> {
  state: LazyLoadErrorBoundaryState = {
    error: null,
    isDynamicImportError: false,
    recoveryStatus: 'idle'
  }

  static getDerivedStateFromError(error: Error): LazyLoadErrorBoundaryState {
    const isDynamicImportError = isDynamicImportFailure(error)
    return {
      error,
      isDynamicImportError,
      recoveryStatus: isDynamicImportError ? 'preparing' : 'blocked'
    }
  }

  private reloadTimer: number | null = null
  private onlineListener: (() => void) | null = null
  private recoveryClaim: RouteLoadRecoveryClaim | null = null
  private recoveryStorage: RouteLoadRecoveryStorage | null = null
  private recoveryStarted = false
  private reloadStarted = false

  componentDidCatch(error: Error) {
    console.error('No se pudo abrir el módulo solicitado:', error)
    this.beginAutomaticRecovery(error)
  }

  componentDidUpdate(previousProps: LazyLoadErrorBoundaryProps) {
    const recoveryScopeChanged = (
      previousProps.resetKey !== this.props.resetKey ||
      previousProps.recoveryKey !== this.props.recoveryKey
    )

    if (this.state.error && recoveryScopeChanged) {
      this.cleanupRecovery(true)
      this.setState({
        error: null,
        isDynamicImportError: false,
        recoveryStatus: 'idle'
      })
    }
  }

  componentWillUnmount() {
    this.cleanupRecovery(true)
  }

  private beginAutomaticRecovery(error: Error) {
    if (
      this.recoveryStarted ||
      import.meta.env.DEV ||
      !this.props.recoveryKey ||
      !isDynamicImportFailure(error)
    ) {
      if (this.state.isDynamicImportError && this.state.recoveryStatus !== 'blocked') {
        this.setState({ recoveryStatus: 'blocked' })
      }
      return
    }

    this.recoveryStarted = true

    if (navigator.onLine === false) {
      this.setState({ recoveryStatus: 'waiting-online' })
      this.onlineListener = () => {
        this.removeOnlineListener()
        this.scheduleAutomaticReload()
      }
      window.addEventListener('online', this.onlineListener, { once: true })
      return
    }

    this.scheduleAutomaticReload()
  }

  private scheduleAutomaticReload() {
    if (!this.state.error || this.reloadTimer !== null || this.reloadStarted) return

    if (activeAutomaticRecoveryOwner && activeAutomaticRecoveryOwner !== this) {
      this.setState({ recoveryStatus: 'blocked' })
      return
    }

    const storage = getSessionStorage()
    if (!storage) {
      this.setState({ recoveryStatus: 'blocked' })
      return
    }

    const claim = claimRouteLoadRecovery({
      storage,
      recoveryKey: this.props.recoveryKey || '',
      buildFingerprint: getBuildFingerprint()
    })

    if (!claim) {
      this.setState({ recoveryStatus: 'blocked' })
      return
    }

    activeAutomaticRecoveryOwner = this
    this.recoveryClaim = claim
    this.recoveryStorage = storage
    this.setState({ recoveryStatus: 'reloading' })
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null
      this.reloadStarted = true
      window.location.reload()
    }, AUTOMATIC_RELOAD_DELAY_MS)
  }

  private removeOnlineListener() {
    if (!this.onlineListener) return
    window.removeEventListener('online', this.onlineListener)
    this.onlineListener = null
  }

  private cleanupRecovery(releaseClaim: boolean) {
    if (this.reloadTimer !== null) {
      window.clearTimeout(this.reloadTimer)
      this.reloadTimer = null
    }
    this.removeOnlineListener()

    if (
      releaseClaim &&
      !this.reloadStarted &&
      this.recoveryClaim &&
      this.recoveryStorage
    ) {
      releaseRouteLoadRecovery(this.recoveryStorage, this.recoveryClaim)
    }

    if (activeAutomaticRecoveryOwner === this && !this.reloadStarted) {
      activeAutomaticRecoveryOwner = null
    }

    this.recoveryClaim = null
    this.recoveryStorage = null
    this.recoveryStarted = false
  }

  render() {
    if (!this.state.error) return this.props.children

    if (
      this.state.isDynamicImportError &&
      this.state.recoveryStatus !== 'blocked'
    ) {
      return (
        <Loading
          message={
            this.state.recoveryStatus === 'waiting-online'
              ? 'Esperando conexión para abrir esta página...'
              : 'Actualizando esta página...'
          }
          size="md"
        />
      )
    }

    return (
      <div
        className="flex min-h-[240px] items-center justify-center p-6"
        role="alert"
        data-error-message={import.meta.env.DEV ? this.state.error.message : undefined}
      >
        <div className="max-w-md text-center">
          <h2 className="text-lg font-semibold text-[var(--text)]">No pudimos abrir esta página</h2>
          <p className="mt-2 text-sm text-[var(--text-mute)]">
            {this.state.isDynamicImportError
              ? 'La página no terminó de descargarse. Puedes intentarlo otra vez o abrir otra sección desde el menú.'
              : 'Ocurrió un error inesperado. Puedes intentarlo otra vez o abrir otra sección desde el menú.'}
          </p>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Intentar de nuevo
          </Button>
        </div>
      </div>
    )
  }
}
