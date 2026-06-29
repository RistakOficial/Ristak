// Modelo default de Ristak AI y del agente conversacional cuando usan OpenAI.
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini'

// Modelo aprobado para flujos automaticos donde el costo debe ser el minimo.
// Si OpenAI cambia el modelo mas barato, se actualiza aqui y los guardrails lo siguen.
export const CHEAPEST_OPENAI_MODEL = 'gpt-5.4-nano'

// Default historico usado antes de promover Ristak AI a GPT-5.4 mini.
export const LEGACY_DEFAULT_OPENAI_MODEL = 'gpt-5.4-nano'
