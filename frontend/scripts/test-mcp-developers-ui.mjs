import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const [settingsSource, mcpPanelSource, documentationSource, settingsStyles, externalAccessDocs] = await Promise.all([
  readFile(`${root}/src/pages/Settings/APIAccessSettings.tsx`, 'utf8'),
  readFile(`${root}/src/pages/Settings/McpAccessPanel.tsx`, 'utf8'),
  readFile(`${root}/src/pages/Settings/APIDocumentation.tsx`, 'utf8'),
  readFile(`${root}/src/pages/Settings/Settings.module.css`, 'utf8'),
  readFile(`${root}/../docs/EXTERNAL_API_ACCESS.md`, 'utf8')
])

assert.match(settingsSource, /useState<DeveloperSection>\('mcp'\)/)
assert.match(settingsSource, /<McpAccessPanel/)
assert.match(settingsSource, /<SegmentTabs/)
assert.match(settingsSource, /timezone,/)

assert.match(mcpPanelSource, /api-access\/mcp\/status/)
assert.match(mcpPanelSource, /api-access\/mcp\/connections/)
assert.match(mcpPanelSource, /safeSameOriginUrl/)
assert.match(mcpPanelSource, /Auditoría MCP/)
assert.match(mcpPanelSource, /typeToConfirm: 'REVOCAR'/)
assert.match(mcpPanelSource, /<SegmentTabs/)
assert.match(mcpPanelSource, /<Table/)
assert.match(mcpPanelSource, /timezone,/)
assert.match(mcpPanelSource, /Codex, ChatGPT, Claude/)
assert.match(mcpPanelSource, /Herramientas visibles/)
assert.match(mcpPanelSource, /No incluyen secretos, infraestructura ni administración de usuarios/)
assert.match(mcpPanelSource, /codex mcp login ristak/)
assert.match(mcpPanelSource, /Work mode de ChatGPT que admita plugins o conectores MCP/)
assert.match(mcpPanelSource, /Settings > Connectors > Add custom connector/)
assert.match(mcpPanelSource, /La autorización usa tu sesión normal de Ristak/)
assert.doesNotMatch(mcpPanelSource, /API token/i)
assert.equal((mcpPanelSource.match(/label: 'Claude'/g) || []).length, 1)

for (const domainLabel of [
  'Contactos y CRM',
  'Mensajes e inbox',
  'Chatbot y agentes IA',
  'Citas y calendarios',
  'Pagos, productos y suscripciones',
  'Automatizaciones',
  'Dashboard y resumen',
  'Reportes',
  'Analítica y tracking',
  'Campañas y Meta Ads',
  'Biblioteca multimedia',
  'Tags, campos y trigger links',
  'Costos del negocio',
  'WhatsApp y plantillas',
  'Preferencias móviles',
  'Estado de integraciones',
  'Sites y código HTML'
]) {
  assert.ok(mcpPanelSource.includes(domainLabel), `Falta el label humano MCP: ${domainLabel}`)
}

assert.match(documentationSource, /ristak\.read/)
assert.match(documentationSource, /ristak\.write/)
assert.match(documentationSource, /ristak\.execute/)
assert.match(documentationSource, /ristak\.destructive/)
assert.match(documentationSource, /codex mcp add ristak/)
assert.match(documentationSource, /codex mcp login ristak/)
assert.match(documentationSource, /api-access\/mcp\/audit/)
assert.match(documentationSource, /MCP no manda mensajes espontáneos/)
assert.match(documentationSource, /MCP no usa el API token de REST\/OpenAPI/)
assert.match(documentationSource, /234 herramientas tipadas/)
assert.match(documentationSource, /productos, precios y suscripciones/)
assert.match(documentationSource, /preferencias móviles/)

assert.match(externalAccessDocs, /## MCP setup/)
assert.match(externalAccessDocs, /normal web session/)
assert.match(externalAccessDocs, /No REST\/OpenAPI token is generated, copied or stored/)
assert.match(externalAccessDocs, /234 typed/)

const mcpStylesStart = settingsStyles.indexOf('.mcpStatusBar')
const mcpStylesEnd = settingsStyles.indexOf('.developerInfoField', mcpStylesStart)
const mcpStyles = settingsStyles.slice(mcpStylesStart, mcpStylesEnd)
assert.ok(mcpStyles.length > 0, 'Debe existir el bloque visual MCP')
assert.doesNotMatch(mcpStyles, /#[0-9a-f]{3,8}\b/i)
assert.doesNotMatch(mcpStyles, /rgba?\(/i)
assert.doesNotMatch(`${settingsSource}\n${mcpPanelSource}`, /<input[^>]+type=["']number["']/i)

console.log('MCP Developers UI contract: OK')
