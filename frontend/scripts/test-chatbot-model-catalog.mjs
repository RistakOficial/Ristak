import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function compile(relativePath, replacements = {}) {
  let source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  for (const [from, to] of Object.entries(replacements)) source = source.replace(from, to)
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  return 'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
}
const modelsUrl = await compile('../src/constants/aiModels.ts')
const providersUrl = await compile('../src/constants/conversationalAIProviders.ts', { "'./aiModels'": JSON.stringify(modelsUrl) })
const models = await import(modelsUrl)
const providers = await import(providersUrl)
const discovered = 'gpt-7-future'
assert.equal(models.getKnownAIModel(discovered), discovered)
assert.equal(providers.getKnownConversationalModel('openai', discovered), discovered)
assert.equal(providers.getConversationalModelLabel('openai', discovered), discovered)
assert.equal(models.getKnownAIModel(''), models.DEFAULT_AI_MODEL)
assert.equal(models.getKnownAIModel('<invalid>'), models.DEFAULT_AI_MODEL)
const catalog = { models: ['gpt-6-astra', discovered], refreshedAt: 10 }
const groups = providers.getAvailableConversationalModelGroups('openai', catalog, discovered)
assert.deepEqual(groups.flatMap(group => group.options.map(option => option.value)), catalog.models)
assert.equal(groups[0].options[0].label, 'GPT-6 Astra')
const missingSelection = providers.getAvailableConversationalModelGroups('openai', catalog, 'gpt-5.6-luna')
assert.equal(missingSelection[0].label, 'Modelo guardado')
assert.equal(missingSelection[0].options[0].value, 'gpt-5.6-luna')
const fallback = providers.getAvailableConversationalModelGroups('openai', null, discovered)
assert.equal(fallback[0].options[0].value, discovered)
assert.ok(fallback.some(group => group.options.some(option => option.value === 'gpt-6-astra')))
assert.equal(providers.getAvailableConversationalModelGroups('gemini', catalog, 'gemini-3.5-flash'), providers.getConversationalAIProviderOption('gemini').modelGroups)
console.log('Chatbot model catalog checks passed.')
