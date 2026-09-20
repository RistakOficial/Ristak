import fetch from 'node-fetch'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import { safeMetaGraphTransportError } from '../utils/metaGraphSecurity.js'

const META_GRAPH_BATCH_SIZE = 50

// GET /?ids=... se retira en todas las versiones el 27 de octubre de 2026.
// El batch soportado devuelve cada resultado en la posición de su solicitud.
export async function fetchMetaObjectsById(objectIds, fields, accessToken, appSecretProof = '') {
  const uniqueIds = [...new Set(objectIds.map(id => String(id ?? '').trim()).filter(Boolean))]
  const objectsById = new Map()

  for (let offset = 0; offset < uniqueIds.length; offset += META_GRAPH_BATCH_SIZE) {
    const chunk = uniqueIds.slice(offset, offset + META_GRAPH_BATCH_SIZE)
    const params = new URLSearchParams({ fields })
    if (appSecretProof) params.set('appsecret_proof', appSecretProof)
    const body = new URLSearchParams({
      access_token: accessToken,
      include_headers: 'false',
      batch: JSON.stringify(chunk.map(id => ({
        method: 'GET',
        relative_url: `${encodeURIComponent(id)}?${params.toString()}`
      })))
    })
    if (appSecretProof) body.set('appsecret_proof', appSecretProof)

    try {
      const response = await fetch(API_URLS.META_GRAPH, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(30_000)
      })
      const data = await response.json()
      if (!response.ok || !Array.isArray(data)) {
        const message = data?.error?.message || `Respuesta de lote inválida (HTTP ${response.status}).`
        logger.warn(`No se pudo consultar el lote de Meta: ${safeMetaGraphTransportError({ message })}`)
        continue
      }

      chunk.forEach((id, index) => {
        const result = data[index]
        try {
          const object = typeof result?.body === 'string' ? JSON.parse(result.body) : null
          if (!result || result.code < 200 || result.code >= 300 || !Number.isInteger(result.code) ||
              !object || typeof object !== 'object' || Array.isArray(object) || object.error ||
              String(object.id) !== id) {
            const message = object?.error?.message || 'Respuesta de objeto incompleta o inválida.'
            logger.warn(`No se pudo leer un objeto del lote de Meta: ${safeMetaGraphTransportError({ message })}`)
            return
          }
          objectsById.set(id, object)
        } catch {
          // Un JSON inválido o una operación fallida no descarta el resto del lote.
          logger.warn('Meta devolvió un objeto con JSON inválido en el lote.')
        }
      })
    } catch (error) {
      logger.warn(`Error consultando el lote de Meta: ${safeMetaGraphTransportError(error)}`)
    }
  }

  return objectsById
}
