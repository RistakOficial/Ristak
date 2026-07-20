import { apiUrl } from './apiBaseUrl'

export async function requestGoogleLoginUrl(returnPath: string) {
  const response = await fetch(apiUrl('/api/auth/google/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ return_path: returnPath })
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok || !data?.success || !data?.url) {
    throw new Error(data?.message || 'No se pudo abrir Google. Inténtalo otra vez.')
  }

  return String(data.url)
}
