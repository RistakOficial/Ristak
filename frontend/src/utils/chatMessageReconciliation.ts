type ReconciliableAttachment = {
  dataUrl?: string
  url?: string
}

export type ReconciliableChatMessage = {
  id: string
  optimisticId?: string
  serverMessageId?: string
  providerMessageId?: string
  text?: string
  date?: string
  attachment?: ReconciliableAttachment
}

function cleanId(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Extrae las dos identidades que devuelve cualquier ruta de envío. La UI nunca
 * debe reemplazar su `id` optimista con ellas: se guardan aparte para reconciliar
 * el eco del servidor sin desmontar el globo que ya está en pantalla.
 */
export function getChatSendResponseIds(value: unknown) {
  const response = asRecord(value)
  const nested = asRecord(response.data)
  return {
    serverMessageId: cleanId(response.localMessageId) || cleanId(nested.localMessageId),
    providerMessageId: cleanId(response.wamid) ||
      cleanId(response.remoteMessageId) ||
      cleanId(response.id) ||
      cleanId(nested.wamid) ||
      cleanId(nested.remoteMessageId) ||
      cleanId(nested.id)
  }
}

/**
 * Fusiona la copia autoritativa del servidor dentro del mensaje ya pintado.
 * Conserva id, fecha y preview local para que React mantenga el mismo nodo y la
 * imagen no vuelva a descargarse mientras status/URL/ACK se actualizan detrás.
 */
export function reconcileServerMessageIntoOptimistic<T extends ReconciliableChatMessage>(
  serverMessage: T,
  optimisticMessage: T
): T {
  const localAttachment = optimisticMessage.attachment
  const serverAttachment = serverMessage.attachment
  const attachment = localAttachment || serverAttachment
    ? {
        ...localAttachment,
        ...serverAttachment,
        ...(localAttachment?.dataUrl ? { dataUrl: localAttachment.dataUrl } : {})
      }
    : undefined

  return {
    ...optimisticMessage,
    ...serverMessage,
    id: optimisticMessage.id,
    optimisticId: optimisticMessage.optimisticId || optimisticMessage.id,
    serverMessageId: serverMessage.serverMessageId || optimisticMessage.serverMessageId || serverMessage.id,
    providerMessageId: serverMessage.providerMessageId || optimisticMessage.providerMessageId,
    date: optimisticMessage.date || serverMessage.date,
    text: serverMessage.text || optimisticMessage.text,
    ...(attachment ? { attachment } : {})
  } as T
}
