/**
 * Adaptador para invocar controllers de Express desde herramientas del agente IA.
 *
 * Las herramientas reutilizan los controllers existentes (contactos, citas, pagos,
 * costos) en lugar de duplicar su lógica: así el agente dispara las mismas
 * validaciones, automatizaciones, sincronizaciones con HighLevel/Google y
 * notificaciones que la UI.
 */

export async function invokeController(handler, { body = {}, params = {}, query = {}, user = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      body,
      params,
      query,
      user,
      headers: {},
      is: () => false
    }

    let statusCode = 200
    let settled = false

    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve({ statusCode, payload })
    }

    const res = {
      status(code) {
        statusCode = code
        return this
      },
      set() {
        return this
      },
      json(payload) {
        finish(payload)
      },
      send(payload) {
        finish(payload)
      }
    }

    Promise.resolve(handler(req, res)).catch((error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

/**
 * Convierte la respuesta de un controller en un resultado compacto para el modelo.
 * Si el controller respondió con error, lo devuelve como { ok: false, error } en
 * lugar de lanzar, para que el agente pueda corregir y reintentar.
 */
export function toToolResult({ statusCode, payload }, pickData = (data) => data) {
  if (payload && payload.success === false) {
    return { ok: false, statusCode, error: payload.error || 'Operación rechazada' }
  }

  const data = payload?.data !== undefined ? payload.data : payload
  return { ok: true, statusCode, data: pickData(data) }
}
