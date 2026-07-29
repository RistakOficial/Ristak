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
const backendSitesSource = await readFile(
  new URL('../../backend/src/services/sitesService.js', import.meta.url),
  'utf8'
)
assert.match(
  sitesSource,
  /const HLS_PLAYER_SCRIPT_URL = '\/api\/sites\/public\/video-engine\/hls-1\.6\.16\.min\.js'/,
  'el editor debe cargar el motor HLS fijado y servido por Ristak'
)
assert.doesNotMatch(
  sitesSource,
  /cdn\.jsdelivr\.net|unpkg\.com/,
  'el editor no debe depender de un CDN JavaScript ajeno para reproducir HLS'
)

const sourceBetween = (startMarker, endMarker, source = sitesSource) => {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0, `No se encontró ${startMarker}`)
  assert.ok(end > start, `No se encontró ${endMarker} después de ${startMarker}`)
  return source.slice(start, end)
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
  'useEffect(() => {\n    const video = videoRef.current\n    if (!video) return\n    const eligible = playerRenderable && (autoplay || sourceNearViewport || hasStartedPlaybackRef.current)',
  'const restoreUserPlaybackQuality = useCallback'
)
assert.match(
  sitesSource,
  /const \[playerRenderable, setPlayerRenderable\] = useState\(false\)[\s\S]*?new ResizeObserver\(syncRenderable\)/,
  'el canvas debe observar si el reproductor tiene tamaño real antes de adjuntar video'
)
assert.match(
  previewPlaybackSource,
  /if \(!eligible\) \{[\s\S]*?video\.pause\(\)[\s\S]*?video\.removeAttribute\('src'\)[\s\S]*?video\.load\(\)/,
  'el canvas debe suspender y liberar la fuente del reproductor oculto'
)
assert.match(
  sitesSource,
  /src=\{[\s\S]*?!playerRenderable[\s\S]*?!hasStartedPlayback[\s\S]*?noTrackSrc/,
  'el video del canvas no debe recibir MP4 mientras su variante responsive está oculta'
)
assert.match(
  previewPlaybackSource,
  /if \(adaptiveQuality && !previewLoopEnabled && canPlayNativeHls\(video\)\)/,
  'HLS nativo solo debe adelantarse cuando no existe un teaser que necesite la variante ligera'
)
assert.match(
  previewPlaybackSource,
  /startLevel: 0[\s\S]*?autoStartLoad: true[\s\S]*?capLevelToPlayerSize: true/,
  'todo arranque HLS debe comenzar ligero y limitarse al tamaño real del reproductor'
)
assert.match(
  previewPlaybackSource,
  /!adaptiveQuality && !previewLoopEnabled[\s\S]*?hls\.currentLevel = highestLevel[\s\S]*?hls\.startLoad\(-1\)/,
  'al apagarla debe fijar la variante más alta antes de iniciar la carga'
)
assert.match(
  previewPlaybackSource,
  /networkRecoveryAttempts < 2[\s\S]*?mediaRecoveryAttempts < 2[\s\S]*?hls\.recoverMediaError\(\)/,
  'el editor debe intentar recuperar red y decodificación antes de abandonar HLS'
)
assert.match(
  sitesSource,
  /const restoreUserPlaybackQuality = useCallback[\s\S]*?hls\.nextLevel = -1[\s\S]*?hls\.startLoad\?\.\(videoRef\.current\?\.currentTime \|\| -1\)/,
  'el play real debe devolver HLS al modo inteligente elegido después del teaser ligero'
)

const publicVideoMarkupSource = sourceBetween(
  'const videoSourceAttrs = [',
  'return `\n    <div class="${classes}"',
  backendSitesSource
)
assert.doesNotMatch(
  publicVideoMarkupSource,
  /(?:^|\n)\s*`src="/,
  'preview y publicado no deben adjuntar MP4 antes de confirmar que la variante responsive es visible'
)
const customVideoMarkupSource = sourceBetween(
  'function renderImportedCustomVideoMedia(',
  'function renderImportedCustomVideoSlot(',
  backendSitesSource
)
assert.doesNotMatch(
  customVideoMarkupSource,
  /\.\.\.\(delivery\?\.src[\s\S]*?\{ src: delivery\.src \}/,
  'el reproductor HTML personalizado tampoco debe adjuntar MP4 antes de validar su variante responsive'
)
const publicVideoRuntimeSource = sourceBetween(
  'function buildVideoPlayerRuntimeScript() {',
  'const IMPORTED_VIDEO_GATE_LOCKED_ATTR_NAMES = [',
  backendSitesSource
)
assert.match(
  publicVideoRuntimeSource,
  /const isHostRenderable = \(\) => \{[\s\S]*?rect\.width > 0[\s\S]*?style\.display !== 'none'/,
  'el runtime público debe exigir tamaño real y visibilidad de layout'
)
assert.match(
  publicVideoRuntimeSource,
  /const syncSourceEligibility = \(\) => \{[\s\S]*?suspendInactiveSource\(!renderable\)[\s\S]*?activateVideoSource\(\)/,
  'el runtime público debe activar sólo la variante elegible y suspender la oculta'
)
assert.match(
  publicVideoRuntimeSource,
  /new IntersectionObserver[\s\S]*?rootMargin: '600px 0px'[\s\S]*?new ResizeObserver\(syncSourceEligibility\)/,
  'el runtime público debe combinar cercanía al viewport con cambios responsive de tamaño'
)
assert.match(
  publicVideoRuntimeSource,
  /const releaseSource = preserveTime => \{[\s\S]*?activeHls\.destroy\(\)[\s\S]*?video\.removeAttribute\('src'\)[\s\S]*?video\.load\(\)/,
  'el runtime público debe liberar MP4/HLS oculto en vez de dejarlo consumiendo datos'
)

const previewLoopSource = sourceBetween(
  'const stopPreviewLoop = useCallback(() => {',
  'useLayoutEffect(() => {\n    const player = playerRef.current\n    if (!player) {'
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
  /<video[\s\S]*?muted=\{startsMuted\}[\s\S]*?autoPlay=\{autoplay && playerRenderable\}/,
  'el elemento del canvas debe nacer silenciado y sólo usar autoplay cuando su variante es visible'
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
