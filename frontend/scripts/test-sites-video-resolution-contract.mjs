import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  RSTK_BASE_CSS,
  rescopeSiteCssForCanvas
} from '../../shared/sites/renderContract.js'

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
  'useEffect(() => {\n    const video = videoRef.current\n    if (!video) return\n    const sourceChanged = loadedVideoSourceRef.current !== noTrackSrc',
  'const restoreUserPlaybackQuality = useCallback'
)
assert.match(
  previewPlaybackSource,
  /if \(adaptiveQuality && !previewLoopEnabled && canPlayNativeHls\(video\)\)/,
  'HLS nativo solo debe adelantarse cuando no existe un teaser que necesite la variante ligera'
)
assert.match(
  previewPlaybackSource,
  /startLevel: previewLoopEnabled \? 0 : adaptiveQuality \? -1 : 0[\s\S]*?autoStartLoad: adaptiveQuality \|\| previewLoopEnabled/,
  'el teaser HLS debe arrancar con la variante más ligera y sin esperar la selección de calidad final'
)
assert.match(
  previewPlaybackSource,
  /!adaptiveQuality && !previewLoopEnabled[\s\S]*?hls\.currentLevel = highestLevel[\s\S]*?hls\.startLoad\?\.\(-1\)/,
  'al apagarla debe fijar la variante más alta antes de iniciar la carga'
)
assert.match(
  sitesSource,
  /const restoreUserPlaybackQuality = useCallback[\s\S]*?hls\.nextLevel = -1[\s\S]*?hls\.startLoad\?\.\(videoRef\.current\?\.currentTime \|\| -1\)/,
  'el play real debe devolver HLS al modo inteligente elegido después del teaser ligero'
)

const previewLoopSource = sourceBetween(
  'const stopPreviewLoop = useCallback(() => {',
  'useEffect(() => {\n    const video = videoRef.current\n    if (!video) return\n    const sourceChanged = loadedVideoSourceRef.current !== noTrackSrc'
)
assert.match(
  previewLoopSource,
  /video\.defaultMuted = true[\s\S]*?video\.setAttribute\('muted', ''\)/,
  'el teaser debe declararse silenciado antes de pedir autoplay'
)
assert.match(
  previewLoopSource,
  /video\.readyState < HTMLMediaElement\.HAVE_METADATA/,
  'el teaser debe esperar la duración, pero no un cuadro que nunca llegará con preload de metadata'
)
assert.doesNotMatch(
  previewLoopSource,
  /HAVE_CURRENT_DATA \|\| video\.seeking/,
  'el teaser no debe bloquear su propio seek esperando datos que ese seek todavía no pidió'
)
assert.match(
  previewLoopSource,
  /const enforcePreviewBoundary = useCallback[\s\S]*?video\.currentTime = range\.start/,
  'el teaser debe regresar al inicio del tramo configurado'
)
assert.match(
  previewLoopSource,
  /const retryDelays = \[120, 400, 1200, 3000\]/,
  'los reintentos de autoplay deben ser acotados y escalonados'
)

const previewReadyListenersSource = sourceBetween(
  'useEffect(() => {\n    const video = videoRef.current\n    if (!video || !previewLoopEnabled)',
  'useEffect(() => {\n    const previousKey = previousPreviewRangeSettingsKeyRef.current'
)
assert.match(
  previewReadyListenersSource,
  /const start = \(\) => \{[\s\S]*?startPreviewLoop\(\)[\s\S]*?addEventListener\('loadeddata', start\)[\s\S]*?addEventListener\('seeked', start\)/,
  'la reproducción del teaser debe reanudarse con listeners que no pasen el evento como bandera de reinicio'
)
assert.match(
  sitesSource,
  /<video[\s\S]*?muted=\{startsMuted\}[\s\S]*?autoPlay=\{autoplay\}/,
  'el elemento del canvas debe nacer silenciado cuando el teaser está activo'
)

const previewRangeControlSource = sourceBetween(
  'const VideoPreviewRangeControl: React.FC<{',
  'const VideoSettingsElementPreview: React.FC<{'
)
assert.match(
  sitesSource,
  /const getKnownVideoPreviewDuration[\s\S]*?return null/,
  'una duración desconocida no debe fingirse como un video de 40 segundos'
)
assert.match(
  sitesSource,
  /videoDurationSource: mediaUrl[\s\S]*?videoDurationSeconds:/,
  'la selección del asset debe conservar su duración para abrir la línea completa inmediatamente'
)
assert.doesNotMatch(
  previewRangeControlSource,
  /for \(const index of VIDEO_PREVIEW_FRAME_INDEXES\)/,
  'las miniaturas decorativas no deben recorrer doce posiciones y competir con el teaser'
)
assert.match(
  previewRangeControlSource,
  /const captureFirstFrame = \(\) =>/,
  'la tira visual debe usar una sola muestra ligera'
)
assert.match(
  previewRangeControlSource,
  /Ajuste fino[\s\S]*?Precisión de 0\.25 s/,
  'los videos largos deben tener una escala separada para ajustar el loop con precisión'
)
assert.match(
  previewRangeControlSource,
  /aria-label="Inicio exacto del loop en segundos"[\s\S]*?aria-label="Duración exacta del loop en segundos"[\s\S]*?aria-label="Final exacto del loop en segundos"/,
  'inicio, duración y final deben poder escribirse de forma exacta'
)

assert.match(
  RSTK_BASE_CSS,
  /@media \(hover:hover\) and \(pointer:fine\)\{\.rstk-video-play-dot:hover\{filter:brightness\(\.86\);transform:translateY\(-1px\) scale\(1\.025\)\}\}/,
  'el play central público debe responder de forma sutil al hover de un mouse'
)
assert.match(
  RSTK_BASE_CSS,
  /\.rstk-video-overlay:focus-visible \.rstk-video-play-dot\{[^}]*filter:brightness\(\.86\)[^}]*outline:2px solid currentColor/,
  'el play central debe conservar una respuesta visible al navegar con teclado'
)
assert.match(
  rescopeSiteCssForCanvas(RSTK_BASE_CSS),
  /\.rstkCanvas \.rstk-video-play-dot:hover\{filter:brightness\(\.86\);transform:translateY\(-1px\) scale\(1\.025\)\}/,
  'el editor debe heredar el mismo hover que preview y sitio publicado'
)

console.log('Sites video resolution contract OK')
