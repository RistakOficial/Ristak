// Modelo default de Ristak AI y del agente conversacional cuando usan OpenAI.
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna'

// Modelo aprobado para flujos automaticos donde el costo debe ser el minimo.
// Si OpenAI cambia el modelo mas barato, se actualiza aqui y los guardrails lo siguen.
export const CHEAPEST_OPENAI_MODEL = 'gpt-5.6-luna'

// Default historico usado antes de promover Ristak AI a GPT-5.6 Luna.
// Los usuarios que sigan en este modelo se promueven solos al DEFAULT actual.
export const LEGACY_DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini'
