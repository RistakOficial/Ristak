import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sitesSource = await readFile(
  new URL('../src/pages/Sites/Sites.tsx', import.meta.url),
  'utf8'
)
const serviceSource = await readFile(
  new URL('../src/services/sitesService.ts', import.meta.url),
  'utf8'
)

const between = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0, `No se encontró ${startMarker}`)
  assert.ok(end > start, `No se encontró ${endMarker} después de ${startMarker}`)
  return source.slice(start, end)
}

const uploadSettings = between(
  sitesSource,
  'const withUploadedVideoSettings =',
  'const getVideoOrientationPatch ='
)
assert.match(uploadSettings, /mediaAssetId:\s*asset\.id/)

const mediaControl = between(
  sitesSource,
  'const MediaUploadControl:',
  'const VideoPreviewRangeControl:'
)
assert.match(mediaControl, /'Reemplazar video'/)
assert.match(mediaControl, /title="¿Qué hacemos con las métricas\?"/)
assert.match(mediaControl, /id:\s*'preserve'/)
assert.match(mediaControl, /id:\s*'reset'/)
assert.match(mediaControl, /sitesService\.replaceVideo/)
assert.match(mediaControl, /replacementMediaAssetId:\s*asset\.id/)
assert.match(mediaControl, /metricsMode/)

const videoInspector = between(
  sitesSource,
  "if (block.blockType === 'image' || block.blockType === 'video')",
  "if (block.blockType === 'calendar_embed')"
)
assert.match(videoInspector, /videoReplacement=\{mediaKind === 'video'/)
assert.match(videoInspector, /siteId:\s*site\.id,\s*blockId:\s*block\.id/)

assert.match(
  serviceSource,
  /\/sites\/\$\{siteId\}\/blocks\/\$\{blockId\}\/replace-video/
)
assert.match(serviceSource, /export type SiteVideoMetricsMode = 'preserve' \| 'reset'/)

console.log('Sites video replacement contract OK')
