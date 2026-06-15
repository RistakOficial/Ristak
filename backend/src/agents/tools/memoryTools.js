import { randomBytes } from 'crypto'
import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'

const MEMORY_LIMIT_PER_CATEGORY = 30

/**
 * Memoria persistente por especialidad. Cada agente solo lee y escribe las notas
 * de su propia categoría, para no mezclar contexto entre especialidades.
 */
export async function loadAgentMemories(category, limit = MEMORY_LIMIT_PER_CATEGORY) {
  try {
    return await db.all(
      `SELECT id, content, updated_at FROM ai_agent_memories
       WHERE category = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
      [category, limit]
    )
  } catch {
    return []
  }
}

/**
 * Crea las herramientas de memoria LIGADAS a una categoría concreta. Con el
 * ruteo automático (triage + handoffs) el contexto del run trae la categoría de
 * entrada, no la del agente que terminó atendiendo; por eso cada especialidad
 * recibe sus propias herramientas con la categoría fija.
 */
export function createMemoryTools(categoryId) {
  const category = String(categoryId || 'general')

  const saveMemory = tool({
    name: 'save_memory',
    description: 'Guarda una nota permanente en tu memoria de especialidad (preferencias del usuario, acuerdos, datos del negocio que te pidan recordar). Escribe notas cortas y autocontenidas. No guardes datos sensibles como tarjetas o contraseñas.',
    parameters: z.object({
      content: z.string().min(3).max(600).describe('La nota a recordar, breve y autocontenida')
    }),
    execute: async ({ content }) => {
      const id = `mem_${randomBytes(8).toString('hex')}`
      await db.run(
        `INSERT INTO ai_agent_memories (id, category, content, created_at, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, category, String(content).trim()]
      )

      // Mantén la memoria acotada: borra las notas más viejas si se pasa del límite
      const allIds = await db.all(
        'SELECT id FROM ai_agent_memories WHERE category = ? ORDER BY updated_at DESC',
        [category]
      ).catch(() => [])
      for (const row of allIds.slice(MEMORY_LIMIT_PER_CATEGORY)) {
        await db.run('DELETE FROM ai_agent_memories WHERE id = ?', [row.id])
      }

      return { ok: true, memoryId: id }
    }
  })

  const forgetMemory = tool({
    name: 'forget_memory',
    description: 'Borra una nota de tu memoria de especialidad cuando el usuario te pida olvidarla o cuando ya no sea válida. El ID aparece en la sección "Memoria" de tus instrucciones.',
    parameters: z.object({
      memoryId: z.string().describe('ID de la nota a borrar (ej. mem_ab12cd34)')
    }),
    execute: async ({ memoryId }) => {
      const result = await db.run(
        'DELETE FROM ai_agent_memories WHERE id = ? AND category = ?',
        [memoryId, category]
      )
      if (!result?.changes) {
        return { ok: false, error: 'No encontré esa nota en la memoria de esta especialidad' }
      }
      return { ok: true }
    }
  })

  return [saveMemory, forgetMemory]
}
