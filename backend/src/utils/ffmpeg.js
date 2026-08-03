import ffmpegStatic from 'ffmpeg-static'

/**
 * Devuelve el binario de FFmpeg disponible para cualquier punto de entrada del
 * backend. El override operativo sigue teniendo prioridad, pero los servicios y
 * workers no dependen de que server.js haya mutado process.env antes de usarlos.
 */
export function resolveFfmpegBinary() {
  return String(process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg').trim() || 'ffmpeg'
}
