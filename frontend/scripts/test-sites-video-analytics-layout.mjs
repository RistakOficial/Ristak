import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sitesStyles = await readFile(
  new URL('../src/pages/Sites/Sites.module.css', import.meta.url),
  'utf8'
)

assert.match(
  sitesStyles,
  /\.sitesAnalyticsDetailList\s*\{[^}]*min-width:\s*0;/,
  'la lista analítica debe poder encogerse dentro del panel'
)
assert.match(
  sitesStyles,
  /\.sitesAnalyticsDetailList strong\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;[^}]*text-align:\s*right;/,
  'los valores largos deben permanecer dentro de su columna sin empujar el panel'
)
assert.match(
  sitesStyles,
  /\.videoAnalyticsSection > \.sitesAnalyticsDetailList\s*\{[^}]*padding:\s*0 14px 2px;/,
  'la lectura de retención debe conservar espacio interior a ambos lados'
)
assert.match(
  sitesStyles,
  /\.videoAnalyticsSection > \.sitesAnalyticsDetailEmpty\s*\{[^}]*margin:\s*12px 14px 14px;[^}]*padding:\s*12px;/,
  'la explicación de retención debe quedar separada del borde del panel'
)

console.log('Sites video analytics layout contract OK')
