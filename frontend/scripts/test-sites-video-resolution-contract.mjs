import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sitesSource = await readFile(
  new URL('../src/pages/Sites/Sites.tsx', import.meta.url),
  'utf8'
)

const sourceBetween = (startMarker, endMarker) => {
  const start = sitesSource.indexOf(startMarker)
  const end = sitesSource.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0, `No se encontró ${startMarker}`)
  assert.ok(end > start, `No se encontró ${endMarker} después de ${startMarker}`)
  return sitesSource.slice(start, end)
}

const resolutionControlSource = sourceBetween(
  '<strong>Resolución inteligente</strong>',
  '<span>Preview de primeros segundos</span>'
)
assert.match(
  resolutionControlSource,
  /Ajusta automáticamente la calidad del video según la conexión para cargar más rápido y reducir pausas\./,
  'la explicación debe describir el beneficio de la resolución inteligente'
)
assert.doesNotMatch(
  resolutionControlSource,
  /Bunny(?:\.net)?/i,
  'el editor no debe exponer el proveedor técnico en la explicación'
)
assert.match(
  resolutionControlSource,
  /checked=\{settings\.videoAdaptiveQuality !== false\}/,
  'la resolución inteligente debe seguir activa por defecto'
)
assert.match(
  resolutionControlSource,
  /onPatchSettings\(\{ videoAdaptiveQuality: checked \}\)[\s\S]*?window\.setTimeout\(onSave, 0\)/,
  'el interruptor debe actualizar y guardar el ajuste'
)

const previewPlaybackSource = sourceBetween(
  'useEffect(() => {\n    const video = videoRef.current\n    if (!video) return\n\n    stopPreviewLoop()',
  'useEffect(() => {\n    const video = videoRef.current\n    if (!video) return\n    stopPreviewLoop()'
)
assert.match(
  previewPlaybackSource,
  /if \(adaptiveQuality && canPlayNativeHls\(video\)\)/,
  'HLS nativo solo debe adelantarse cuando conserva la selección adaptativa'
)
assert.match(
  previewPlaybackSource,
  /startLevel: adaptiveQuality \? -1 : 0[\s\S]*?autoStartLoad: adaptiveQuality/,
  'hls.js debe arrancar automático solo en resolución inteligente'
)
assert.match(
  previewPlaybackSource,
  /hls\.currentLevel = highestLevel[\s\S]*?hls\.startLoad\?\.\(-1\)/,
  'al apagarla debe fijar la variante más alta antes de iniciar la carga'
)

console.log('Sites video resolution contract OK')
