import { useEffect, useState } from 'react'
import { apiUrl } from '@/services/apiBaseUrl'

// La versión la hornea el workflow de GitHub en la imagen Docker (APP_VERSION)
// y el backend la expone en /api/health. Se cachea a nivel de módulo: solo se
// consulta una vez por sesión.
let cachedVersion: string | null = null
let pending: Promise<string | null> | null = null

async function fetchVersion(): Promise<string | null> {
  try {
    const response = await fetch(apiUrl('/api/health'))
    if (!response.ok) return null
    const data = await response.json()
    const version = typeof data?.version === 'string' ? data.version : null
    // 0.0.0 = sin versión inyectada (desarrollo local): mejor no mostrar nada
    return version && version !== '0.0.0' ? version : null
  } catch {
    return null
  }
}

/**
 * Versión instalada de la app (ej. "v1.0.57") o null si no está disponible
 * (desarrollo local o backend sin APP_VERSION).
 */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(cachedVersion)

  useEffect(() => {
    if (cachedVersion) return
    if (!pending) pending = fetchVersion()
    let alive = true
    pending.then(result => {
      cachedVersion = result
      if (alive && result) setVersion(result)
    })
    return () => { alive = false }
  }, [])

  return version
}
