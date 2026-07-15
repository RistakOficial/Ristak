export type DesktopChatConversationRequestMode = 'foreground' | 'background'

type ActiveConversationRequest = {
  contactId: string
  mode: DesktopChatConversationRequestMode
  controller: AbortController
  promise: Promise<void>
}

type ConversationRequestExecutor = (signal: AbortSignal) => Promise<void>

/**
 * Conserva un solo transporte de conversación activo para Chat Desktop.
 *
 * Una reconciliación en segundo plano reutiliza cualquier carga del mismo
 * contacto. Una carga visible sólo reemplaza a una reconciliación silenciosa,
 * porque necesita inicializar sus estados de pantalla.
 */
export function createDesktopChatConversationRequestCoordinator() {
  let activeRequest: ActiveConversationRequest | null = null
  let scheduledAbortRevision = 0

  const cancelScheduledAbort = () => {
    scheduledAbortRevision += 1
  }

  const abortActiveRequest = (contactId?: string) => {
    cancelScheduledAbort()
    if (!activeRequest) return
    if (contactId && activeRequest.contactId !== contactId) return

    const request = activeRequest
    activeRequest = null
    request.controller.abort()
  }

  const scheduleAbort = (contactId?: string) => {
    const revision = scheduledAbortRevision + 1
    scheduledAbortRevision = revision

    queueMicrotask(() => {
      if (scheduledAbortRevision !== revision) return
      if (!activeRequest) return
      if (contactId && activeRequest.contactId !== contactId) return

      const request = activeRequest
      activeRequest = null
      request.controller.abort()
    })
  }

  const run = (
    contactId: string,
    mode: DesktopChatConversationRequestMode,
    execute: ConversationRequestExecutor
  ): Promise<void> => {
    cancelScheduledAbort()

    const canReuseActiveRequest = Boolean(
      activeRequest &&
      activeRequest.contactId === contactId &&
      !activeRequest.controller.signal.aborted &&
      (activeRequest.mode === 'foreground' || mode === 'background')
    )
    if (canReuseActiveRequest && activeRequest) return activeRequest.promise

    if (activeRequest) {
      const request = activeRequest
      activeRequest = null
      request.controller.abort()
    }

    const controller = new AbortController()
    const request: ActiveConversationRequest = {
      contactId,
      mode,
      controller,
      promise: Promise.resolve()
    }
    activeRequest = request

    let execution: Promise<void>
    try {
      execution = execute(controller.signal)
    } catch (error) {
      execution = Promise.reject(error)
    }

    request.promise = execution.finally(() => {
      if (activeRequest === request) activeRequest = null
    })
    return request.promise
  }

  return {
    run,
    abort: abortActiveRequest,
    scheduleAbort
  }
}
