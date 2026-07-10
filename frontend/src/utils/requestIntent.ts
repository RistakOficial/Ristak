export interface StableRequestIntent {
  signature: string
  clientRequestId: string
}

function normalizeRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeRequestValue)
  if (!value || typeof value !== 'object') return value

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) result[key] = normalizeRequestValue(item)
      return result
    }, {})
}

export function getRequestPayloadSignature(payload: unknown): string {
  return JSON.stringify(normalizeRequestValue(payload))
}

export function createClientRequestId(scope: string): string {
  const cleanScope = String(scope || 'request')
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 48) || 'request'

  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${cleanScope}:${crypto.randomUUID()}`
  }

  return `${cleanScope}:${Date.now()}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`
}

export function resolveStableRequestIntent(
  current: StableRequestIntent | null,
  scope: string,
  payload: unknown
): StableRequestIntent {
  const signature = getRequestPayloadSignature(payload)
  if (current?.signature === signature) return current

  return {
    signature,
    clientRequestId: createClientRequestId(scope)
  }
}
