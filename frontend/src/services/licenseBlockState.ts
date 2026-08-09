export type LicenseBlockState = {
  message?: string
  reason?: string
  paymentUrl?: string
}

type LicenseBlockPayload = LicenseBlockState & {
  payment_url?: string | null
}

const LICENSE_BLOCK_STORAGE_KEY = 'ristak_license_block_state'

function safePaymentUrl(value?: string | null) {
  const clean = String(value || '').trim()
  if (!clean || typeof window === 'undefined') return undefined

  try {
    const url = new URL(clean)
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    return url.protocol === 'https:' || localHttp ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export function rememberLicenseBlock(payload: LicenseBlockPayload = {}): LicenseBlockState {
  const state = {
    message: String(payload.message || '').trim() || undefined,
    reason: String(payload.reason || '').trim() || undefined,
    paymentUrl: safePaymentUrl(payload.paymentUrl || payload.payment_url)
  }

  try {
    window.sessionStorage.setItem(LICENSE_BLOCK_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // La navegación conserva state cuando sessionStorage no está disponible.
  }

  return state
}

export function readRememberedLicenseBlock(): LicenseBlockState | null {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(LICENSE_BLOCK_STORAGE_KEY) || 'null')
    if (!stored || typeof stored !== 'object') return null
    return {
      message: String(stored.message || '').trim() || undefined,
      reason: String(stored.reason || '').trim() || undefined,
      paymentUrl: safePaymentUrl(stored.paymentUrl)
    }
  } catch {
    return null
  }
}

export function clearRememberedLicenseBlock() {
  try {
    window.sessionStorage.removeItem(LICENSE_BLOCK_STORAGE_KEY)
  } catch {
    // Sin acceso a storage, no hay nada más que limpiar.
  }
}
